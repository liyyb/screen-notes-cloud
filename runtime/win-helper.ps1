# Windows system layer for Screen Notes.
# Two modes:
#   screen : long-lived JSON-lines worker over stdin/stdout (capture, OCR, foreground)
#   hotkey : global hotkey listener, emits {"event":"hotkey"} lines
# All screen data stays in memory; no screenshot is written to disk.
param(
  [Parameter(Mandatory = $true)][ValidateSet('screen', 'hotkey')][string]$Mode,
  [string]$Shortcut = 'Ctrl+Alt+N'
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
[Console]::InputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$nativeCode = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SNWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [DllImport("user32.dll")] public static extern sbyte GetMessage(out SNMSG lpMsg, IntPtr hWnd, uint min, uint max);
  [DllImport("user32.dll")] public static extern bool TranslateMessage(ref SNMSG lpMsg);
  [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref SNMSG lpMsg);
  [StructLayout(LayoutKind.Sequential)]
  public struct SNMSG {
    public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam;
    public uint time; public int pt_x; public int pt_y;
  }
}
'@
Add-Type -TypeDefinition $nativeCode -Language CSharp
try { $null = [SNWin]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch { $null = [SNWin]::SetProcessDPIAware() }

function Write-Json($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 8
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

function Get-Foreground {
  $hwnd = [SNWin]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  $null = [SNWin]::GetWindowTextW($hwnd, $sb, 512)
  $title = $sb.ToString()
  $procId = [uint32]0
  $null = [SNWin]::GetWindowThreadProcessId($hwnd, [ref]$procId)
  $processName = ''
  $hProc = [SNWin]::OpenProcess(0x1000, $false, $procId)
  if ($hProc -ne [IntPtr]::Zero) {
    $sb2 = New-Object System.Text.StringBuilder 1024
    $sz = [uint32]1024
    if ([SNWin]::QueryFullProcessImageNameW($hProc, 0, $sb2, [ref]$sz)) {
      $processName = [System.IO.Path]::GetFileName($sb2.ToString())
    }
    $null = [SNWin]::CloseHandle($hProc)
  }
  $wr = [SNWin+RECT]::new()
  $null = [SNWin]::GetWindowRect($hwnd, [ref]$wr)
  return @{ hwnd = $hwnd.ToInt64(); pid = $procId; process = $processName; title = $title; bounds = @{ x=$wr.Left; y=$wr.Top; w=($wr.Right-$wr.Left); h=($wr.Bottom-$wr.Top) } }
}

function Get-Frame {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()

  $small = New-Object System.Drawing.Bitmap 48, 27
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, 48, 27)
  $g2.Dispose()
  $sb = New-Object System.Text.StringBuilder
  for ($y = 0; $y -lt 27; $y++) {
    for ($x = 0; $x -lt 48; $x++) {
      $c = $small.GetPixel($x, $y)
      $lum = [int](($c.R * 299 + $c.G * 587 + $c.B * 114) / 1000)
      $null = $sb.Append($lum.ToString('X2'))
    }
  }
  $fp = $sb.ToString()
  $small.Dispose()
  return @{ bytes = $bytes; fp = $fp; w = $bounds.Width; h = $bounds.Height; bmp = $bmp }
}

# Capture a clipped region (rect / window bounds / free-form polygon).
# Coordinates are relative to the virtual-screen bitmap; free-form areas keep only
# the pixels inside the polygon and paint everything else white for cleaner OCR.
function Get-ClippedFrame($rect, $points) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $full = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $g = [System.Drawing.Graphics]::FromImage($full)
  $g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $full.Size)
  $g.Dispose()
  if ($null -eq $rect) { $full.Dispose(); throw 'missing capture rect' }

  $x = [Math]::Max(0, [Math]::Min([int]$rect.x, $bounds.Width - 1))
  $y = [Math]::Max(0, [Math]::Min([int]$rect.y, $bounds.Height - 1))
  $w = [Math]::Min([int]$rect.w, $bounds.Width - $x)
  $h = [Math]::Min([int]$rect.h, $bounds.Height - $y)
  if ($w -lt 8 -or $h -lt 8) { $full.Dispose(); throw 'capture region too small' }

  $clip = [System.Drawing.Rectangle]::new($x, $y, $w, $h)
  $crop = $full.Clone($clip, $full.PixelFormat)
  $full.Dispose()

  $ptList = @($points)
  if ($null -ne $points -and $ptList.Count -ge 3) {
    $out = New-Object System.Drawing.Bitmap($w, $h)
    $og = [System.Drawing.Graphics]::FromImage($out)
    $og.Clear([System.Drawing.Color]::White)
    $arr = [System.Drawing.Point[]]::new($ptList.Count)
    for ($i = 0; $i -lt $ptList.Count; $i++) {
      $arr[$i] = [System.Drawing.Point]::new(([int]$ptList[$i].x - $x), ([int]$ptList[$i].y - $y))
    }
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddPolygon($arr)
    $og.Clip = [System.Drawing.Region]::new($path)
    $og.DrawImage($crop, 0, 0)
    $og.Dispose(); $path.Dispose(); $crop.Dispose()
    $crop = $out
  }

  $ms = New-Object System.IO.MemoryStream
  $crop.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()

  $small = New-Object System.Drawing.Bitmap 48, 27
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($crop, 0, 0, 48, 27)
  $g2.Dispose()
  $sb = New-Object System.Text.StringBuilder
  for ($yy = 0; $yy -lt 27; $yy++) {
    for ($xx = 0; $xx -lt 48; $xx++) {
      $c = $small.GetPixel($xx, $yy)
      $lum = [int](($c.R * 299 + $c.G * 587 + $c.B * 114) / 1000)
      $null = $sb.Append($lum.ToString('X2'))
    }
  }
  $fp = $sb.ToString()
  $small.Dispose()
  return @{ bytes = $bytes; fp = $fp; w = $w; h = $h; bmp = $crop }
}

# --- WinRT OCR ---
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation.UniversalApiContract, ContentType = WindowsRuntime]

$script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
if ($null -eq $script:asTask) { throw 'WinRT AsTask bridge unavailable' }

function Await-Op($op, $resultType) {
  $method = $script:asTask.MakeGenericMethod($resultType)
  $task = $method.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  return $task.Result
}

function Invoke-Ocr([byte[]]$bytes) {
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $writer = New-Object Windows.Storage.Streams.DataWriter -ArgumentList $stream
  $writer.WriteBytes($bytes)
  $null = Await-Op ($writer.StoreAsync()) ([uint32])
  $null = $stream.Seek(0)
  $decoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $langTag = 'zh-Hans-CN'
  $language = [Windows.Globalization.Language]::new('zh-Hans-CN')
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  if ($null -eq $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -ne $engine) { $langTag = $engine.RecognizerLanguage.LanguageTag }
  }
  if ($null -eq $engine) { throw 'Windows OCR language pack missing (zh-Hans-CN)' }
  $ocr = Await-Op ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  $layout = @()
  foreach ($line in $ocr.Lines) {
    $lines += $line.Text
    $words = @()
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      $words += @{ text = $word.Text; x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height }
    }
    $layout += @{ text = $line.Text; words = $words }
  }
  $text = ($lines -join "`n")
  if ([string]::IsNullOrWhiteSpace($text)) { $text = $ocr.Text }
  $writer.Dispose()
  $stream.Dispose()
  return @{ text = $text; language = $langTag; lines = $lines.Count; layout = $layout; width = $bitmap.PixelWidth; height = $bitmap.PixelHeight }
}

function New-TestImage {
  $bmp = New-Object System.Drawing.Bitmap 1000, 180
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)
  $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('5bGP5bmV56yU6K6w56a757q/T0NS5rWL6K+VIDIwMjYg6Ieq5Yqo6K6w5b2V6aqM5pS2'))
  $font = New-Object System.Drawing.Font('Microsoft YaHei', 30)
  $g.DrawString($text, $font, [System.Drawing.Brushes]::Black, 20, 50)
  $g.Dispose()
  $font.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  $bmp.Dispose()
  Write-Output -NoEnumerate $bytes
}

if ($Mode -eq 'hotkey') {
  $mods = [uint32]0
  if ($Shortcut -match 'Ctrl')  { $mods = $mods -bor 2 }
  if ($Shortcut -match 'Alt')   { $mods = $mods -bor 1 }
  if ($Shortcut -match 'Shift') { $mods = $mods -bor 4 }
  if ($Shortcut -match 'Win')   { $mods = $mods -bor 8 }
  $key = (($Shortcut -split '\+') | Select-Object -Last 1).Trim().ToUpperInvariant()
  $vk = 0
  if ($key.Length -eq 1) { $vk = [int][char]$key }
  elseif ($key -match '^F(\d{1,2})$') { $vk = 111 + [int]$Matches[1] }
  else {
    $map = @{ 'SPACE' = 32; 'ENTER' = 13; 'TAB' = 9; 'ESC' = 27; 'INSERT' = 45; 'HOME' = 36; 'END' = 35; 'PGUP' = 33; 'PGDN' = 34 }
    if ($map.ContainsKey($key)) { $vk = $map[$key] }
  }
  if ($vk -eq 0) { Write-Json @{ event = 'error'; message = "unsupported hotkey: $Shortcut" }; exit 1 }
  $ok = [SNWin]::RegisterHotKey([IntPtr]::Zero, 1, $mods, [uint32]$vk)
  if (-not $ok) { Write-Json @{ event = 'error'; message = 'RegisterHotKey failed (shortcut already in use?)' }; exit 1 }
  Write-Json @{ event = 'ready'; shortcut = $Shortcut; vk = $vk; modifiers = $mods }
  $msg = [SNWin+SNMSG]::new()
  while ($true) {
    $r = [int][SNWin]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0)
    if ($r -le 0) { break }
    if ($msg.message -eq 0x0312) { Write-Json @{ event = 'hotkey'; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } }
    $null = [SNWin]::TranslateMessage([ref]$msg)
    $null = [SNWin]::DispatchMessage([ref]$msg)
  }
  $null = [SNWin]::UnregisterHotKey([IntPtr]::Zero, 1)
  exit 0
}

# ---- screen worker: JSON lines over stdin/stdout ----
$script:frame = $null
$script:frameId = 0
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8NoBom)
Write-Json @{ ok = $true; event = 'ready'; mode = 'screen' }
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  try {
    $req = $line | ConvertFrom-Json
    $cmd = [string]$req.cmd
    switch ($cmd) {
      'ping' { Write-Json @{ ok = $true; pong = $true; pid = $PID } }
      'foreground' { $r = Get-Foreground; $r.ok = $true; Write-Json $r }
      'snap' {
        $f = Get-Frame
        $script:frame = $f
        $script:frameId++
        $fg = Get-Foreground
        Write-Json @{ ok = $true; frame = $script:frameId; fingerprint = $f.fp; width = $f.w; height = $f.h; foreground = $fg }
      }
      'snapRegion' {
        $f = Get-ClippedFrame $req.rect $req.points
        $script:frame = $f
        $script:frameId++
        $fg = Get-Foreground
        Write-Json @{ ok = $true; frame = $script:frameId; fingerprint = $f.fp; width = $f.w; height = $f.h; scope = [string]$req.scope; foreground = $fg }
      }
      'ocr' {
        if ($null -eq $script:frame) { Write-Json @{ ok = $false; error = 'no captured frame; call snap first' }; break }
        $r = Invoke-Ocr $script:frame.bytes
        $r.ok = $true
        $r.frame = $script:frameId
        Write-Json $r
      }
      'ocrRegion' {
        if ($null -eq $script:frame) { throw 'no captured frame' }
        $inputStream = [System.IO.MemoryStream]::new($script:frame.bytes, $false)
        $original = [System.Drawing.Bitmap]::new($inputStream)
        $x = [Math]::Max(0, [int]$req.rect.x); $y = [Math]::Max(0, [int]$req.rect.y)
        $w = [Math]::Min([int]$req.rect.w, $original.Width - $x); $h = [Math]::Min([int]$req.rect.h, $original.Height - $y)
        if ($w -lt 8 -or $h -lt 8) { $original.Dispose(); $inputStream.Dispose(); throw 'invalid OCR region' }
        $crop = $original.Clone([System.Drawing.Rectangle]::new($x,$y,$w,$h), $original.PixelFormat)
        $scale = [Math]::Min(2.0, 3800.0 / [Math]::Max($w,$h))
        $large = [System.Drawing.Bitmap]::new([int]($w*$scale), [int]($h*$scale))
        $g = [System.Drawing.Graphics]::FromImage($large)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.DrawImage($crop,0,0,$large.Width,$large.Height); $g.Dispose()
        $out = [System.IO.MemoryStream]::new(); $large.Save($out,[System.Drawing.Imaging.ImageFormat]::Png)
        try { $r = Invoke-Ocr $out.ToArray(); $r.ok = $true; Write-Json $r }
        finally { $out.Dispose(); $large.Dispose(); $crop.Dispose(); $original.Dispose(); $inputStream.Dispose() }
      }
      'shot' {
        if ($null -eq $script:frame) { Write-Json @{ ok = $false; error = 'no captured frame' }; break }
        Write-Json @{ ok = $true; png = [Convert]::ToBase64String($script:frame.bytes) }
      }
      'ocrtest' {
        $bytes = New-TestImage
        $r = Invoke-Ocr $bytes
        $r.ok = $true
        $r.kind = 'synthetic'
        Write-Json $r
      }
      'ocrfile' {
        $file = [string]$req.path
        if (-not (Test-Path $file)) { Write-Json @{ ok = $false; error = "file not found: $file" }; break }
        $bytes = [System.IO.File]::ReadAllBytes($file)
        $script:frame = @{ bytes = $bytes; fp = ''; w = 0; h = 0; bmp = $null }
        $r = Invoke-Ocr $bytes
        $r.ok = $true
        $r.kind = 'file'
        Write-Json $r
      }
      'pickfolder' {
        # Folder picker dialog; returns selected absolute path (empty if cancelled).
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = 'Choose a folder to store this section notes'
        $init = [string]$req.initial
        if ($init -ne '' -and (Test-Path $init)) { $dlg.SelectedPath = $init }
        $dlg.ShowNewFolderButton = $true
        $result = $dlg.ShowDialog()
        if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
          Write-Json @{ ok = $true; path = $dlg.SelectedPath }
        } else {
          Write-Json @{ ok = $true; path = [string]::Empty; cancelled = $true }
        }
      }
      'clear' {
        if ($null -ne $script:frame -and $null -ne $script:frame.bmp) { $script:frame.bmp.Dispose() }
        $script:frame = $null
        [GC]::Collect()
        Write-Json @{ ok = $true; cleared = $true }
      }
      default { Write-Json @{ ok = $false; error = "unknown command: $cmd" } }
    }
  } catch {
    Write-Json @{ ok = $false; error = $_.Exception.Message }
  }
}
