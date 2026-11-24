# Screen Notes native shell: refined top-right always-on-top panel, capture
# bubble (thinking / done), tray icon and capture overlays.
# Runs as a STA WinForms message loop; talks to the Node core over the local JSON API.
param(
  [int]$Port = 17860,
  [string]$IconPath = '',
  [switch]$Smoke,
  [string]$PreviewPath = '',
  [float]$PreviewScale = 1.0
)

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'caption-layout.ps1')
. (Join-Path $PSScriptRoot 'mini-icons.ps1')
. (Join-Path $PSScriptRoot 'desktop-layout.ps1')
# HttpClient is used for the non-blocking capture_process call so the WinForms
# message pump keeps running (the three dots must actually animate for 2-3 s).
$script:httpPumpAvailable = $true
try { Add-Type -AssemblyName System.Net.Http -ErrorAction Stop }
catch { $script:httpPumpAvailable = $false }

$nativeCode = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SNNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll", EntryPoint = "GetClassLongW")] public static extern int GetClassLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint = "SetClassLongW")] public static extern int SetClassLong(IntPtr hWnd, int nIndex, int dwNewLong);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;
  // CS_DROPSHADOW gives both frameless windows a soft system shadow.
  public static void EnableShadow(IntPtr h) {
    int style = GetClassLong(h, -26);
    SetClassLong(h, -26, style | 0x00020000);
  }
  public static List<IntPtr> FindByTitle(string needle) {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@
Add-Type -TypeDefinition $nativeCode -Language CSharp
try { $null=[SNNative]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch { $null=[SNNative]::SetProcessDPIAware() }

$script:base = "http://127.0.0.1:$Port"
$script:vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$script:scope = 'full'
$script:auto = $false
$script:busy = $false
$script:captureBusy = $false
$script:alwaysOnTop = $true
$script:hidden = New-Object System.Collections.ArrayList
$script:overlay = $null
$script:selection = $null
$script:points = New-Object System.Collections.ArrayList
$script:smokeOk = $false
$script:pollFailures = 0

# ---------------- palette & type ----------------
# One restrained accent colour, generous white space, hairline borders.
$script:white      = [System.Drawing.Color]::White
$script:ink        = [System.Drawing.Color]::FromArgb(28, 36, 49)
$script:accent     = [System.Drawing.Color]::FromArgb(58, 109, 240)
$script:accentDeep = [System.Drawing.Color]::FromArgb(45, 92, 214)
$script:accentSoft = [System.Drawing.Color]::FromArgb(238, 243, 255)
$script:soft       = [System.Drawing.Color]::FromArgb(245, 247, 250)
$script:hover      = [System.Drawing.Color]::FromArgb(233, 238, 247)
$script:pressed    = [System.Drawing.Color]::FromArgb(223, 230, 243)
$script:line       = [System.Drawing.Color]::FromArgb(231, 235, 241)
$script:muted      = [System.Drawing.Color]::FromArgb(138, 147, 162)
$script:faint      = [System.Drawing.Color]::FromArgb(182, 189, 200)
$script:fontBtn    = [System.Drawing.Font]::new('Microsoft YaHei', 9)
$script:fontBtnSm  = [System.Drawing.Font]::new('Microsoft YaHei', 8)
$script:fontName   = [System.Drawing.Font]::new('Microsoft YaHei', 11, [System.Drawing.FontStyle]::Bold)
$script:fontLogo   = [System.Drawing.Font]::new('Microsoft YaHei', 9, [System.Drawing.FontStyle]::Bold)
$script:fontTag    = [System.Drawing.Font]::new('Microsoft YaHei', 7.5)
$script:fontBTitle = [System.Drawing.Font]::new('Microsoft YaHei', 10.5, [System.Drawing.FontStyle]::Bold)
$script:fontBBody  = [System.Drawing.Font]::new('Microsoft YaHei', 8.5)

# bubble state
$script:bubbleMode = 'none'      # none | processing | done | error
$script:bubbleTitle = ''
$script:bubbleSummary = ''
$script:dotPhase = 0
$script:closeHover = $false
$script:bubblePrepared = $false
# UI state: hover is tracked explicitly so a 500 ms poll can never leave a
# button showing a stale pressed / hover colour.
$script:hoverBtn = $null
$script:lastPinOn = $null
$script:lastStateText = ''
$script:lastAutoSeq = 0
$script:lastAutoSignature = ''

# caption bar state (subtitle overlay). The bar shows the live transcript of an
# active caption session: light-grey translucent background with white text,
# size / colour / background all adjustable from the settings drawer.
$script:captionActive = $false
$script:captionDisplayText = '字幕中…'
$script:captionLastId = 0
$script:captionSessionId = 0
$script:captionStyle = @{ font_size = 28; font_color = '#FFFFFF'; background = $true; bg_color = '#3C3C3C'; opacity = 75; visible = $true }
$script:captionFont = [System.Drawing.Font]::new('Microsoft YaHei', 28, [System.Drawing.FontStyle]::Bold)
$script:captionFg = [System.Drawing.Color]::White
$script:captionBg = [System.Drawing.Color]::FromArgb(192, 60, 60, 60)
$script:captionDragging = $false
$script:captionDragOffset = [System.Drawing.Point]::Empty

function Write-Json($obj) {
  # The parent Node process may be gone; a broken stdout pipe must never
  # abort an event handler (that would leave an orphan panel on the desktop).
  try {
    $json = $obj | ConvertTo-Json -Compress -Depth 8
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  } catch { }
}

function Invoke-Api([string]$cmd, $payload = @{}) {
  $json = $payload | ConvertTo-Json -Compress -Depth 8
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $r = Invoke-RestMethod -Uri "$($script:base)/api/$cmd" -Method Post -Body $bytes `
    -ContentType 'application/json; charset=utf-8' -TimeoutSec 90
  if ($r.error) { throw ([string]$r.error) }
  return $r.data
}

# Same JSON API, but the UI thread keeps pumping messages while the request is
# in flight. Without this, a synchronous Invoke-RestMethod would freeze the
# bubble's three-dot animation for the whole 2-3 s OCR/model/save step.
function Invoke-ApiPump([string]$cmd, $payload = @{}, [bool]$heartbeat = $true) {
  if (-not $script:httpPumpAvailable) { return Invoke-Api $cmd $payload }
  $json = $payload | ConvertTo-Json -Compress -Depth 8
  $content = [System.Net.Http.StringContent]::new($json, [System.Text.Encoding]::UTF8, 'application/json')
  $client = [System.Net.Http.HttpClient]::new()
  $client.Timeout = [TimeSpan]::FromSeconds(90)
  # HttpClient captures SynchronizationContext.Current and posts every
  # continuation back to it. On a WinForms UI thread that means PostAsync /
  # ReadAsStringAsync can never finish while we pump with DoEvents, and a
  # blocking .Result deadlocks outright. Detach the context for the whole call
  # so the continuations run on the thread pool; DoEvents still drives the
  # bubble's Win32 timer messages.
  $savedCtx = [System.Threading.SynchronizationContext]::Current
  [System.Threading.SynchronizationContext]::SetSynchronizationContext($null)
  try {
    $task = $client.PostAsync("$($script:base)/api/$cmd", $content)
    $pumpTicks = 0
    while (-not $task.IsCompleted) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 24
      $pumpTicks++
      # Heartbeat proves the pump (and therefore the dots) really kept moving.
      # Kept deliberately sparse so stdout writes do not stall the animation.
      if ($heartbeat -and ($pumpTicks % 10) -eq 0) {
        Write-Json @{ event = 'bubble-tick'; phase = [int]$script:dotPhase }
      }
    }
    $resp = $task.GetAwaiter().GetResult()
    $readTask = $resp.Content.ReadAsStringAsync()
    while (-not $readTask.IsCompleted) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 24
      $pumpTicks++
      if ($heartbeat -and ($pumpTicks % 10) -eq 0) {
        Write-Json @{ event = 'bubble-tick'; phase = [int]$script:dotPhase }
      }
    }
    $body = $readTask.GetAwaiter().GetResult()
    if (-not $resp.IsSuccessStatusCode) { throw "HTTP $([int]$resp.StatusCode): $body" }
    $r = $body | ConvertFrom-Json
    if ($r.error) { throw ([string]$r.error) }
    return $r.data
  } finally {
    [System.Threading.SynchronizationContext]::SetSynchronizationContext($savedCtx)
    $client.Dispose()
    $content.Dispose()
  }
}

function New-RoundPath([int]$w, [int]$h, [int]$r) {
  $p = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = $r * 2
  $p.AddArc(0, 0, $d, $d, 180, 90)
  $p.AddArc($w - $d, 0, $d, $d, 270, 90)
  $p.AddArc($w - $d, $h - $d, $d, $d, 0, 90)
  $p.AddArc(0, $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# Rounded rectangle with a small triangle pointing up at $tipX (the speech tail).
function New-BubblePath([int]$w, [int]$h, [int]$r, [int]$tipX, [int]$tipH) {
  $p = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $d = $r * 2
  $p.AddArc(0, $tipH, $d, $d, 180, 90)
  $p.AddLine($r, $tipH, ($tipX - 9), $tipH)
  $p.AddLine(($tipX - 9), $tipH, $tipX, 0)
  $p.AddLine($tipX, 0, ($tipX + 9), $tipH)
  $p.AddLine(($tipX + 9), $tipH, ($w - $r), $tipH)
  $p.AddArc(($w - $d), $tipH, $d, $d, 270, 90)
  $p.AddArc(($w - $d), ($h - $d), $d, $d, 0, 90)
  $p.AddArc(0, ($h - $d), $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Set-RoundRegion($ctrl, [int]$w, [int]$h, [int]$r) {
  $p = New-RoundPath $w $h $r
  $old = $ctrl.Region
  $ctrl.Region = [System.Drawing.Region]::new($p)
  $p.Dispose()
  if ($old) { try { $old.Dispose() } catch { } }
}

function Set-ExcludeFromCapture([IntPtr]$hwnd) {
  if ($hwnd -eq [IntPtr]::Zero) { return }
  try { $null = [SNNative]::SetWindowDisplayAffinity($hwnd, [SNNative]::WDA_EXCLUDEFROMCAPTURE) } catch { }
}

# Owner-drawn panels must be double buffered, otherwise every timer tick
# repaints the whole surface and the three-dot animation visibly flickers.
function Enable-DoubleBuffer($ctrl) {
  try {
    $flags = [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic
    $p = [System.Windows.Forms.Control].GetProperty('DoubleBuffered', $flags)
    if ($p) { $p.SetValue($ctrl, $true, $null) }
  } catch { }
}

# Only assign when the value actually changed. A 500 ms poll otherwise forces
# every button to repaint twice a second, which is what made hover / checked
# colours look wrong and ate CPU for nothing.
function Set-BtnStyle($b, $bg, $fg, [string]$text) {
  if ($null -eq $b) { return }
  try {
    if ($b.BackColor.ToArgb() -ne $bg.ToArgb()) { $b.BackColor = $bg }
    if ($b.ForeColor.ToArgb() -ne $fg.ToArgb()) { $b.ForeColor = $fg }
    if ($b.Text -cne $text) { $b.Text = $text }
  } catch { }
}

# The done bubble grows with the summary instead of cutting the text at a fixed
# character count. 26 CJK glyphs fit in one line at 360 px.
function Get-BubbleHeight([string]$text) {
  $flags = [System.Windows.Forms.TextFormatFlags]::WordBreak -bor [System.Windows.Forms.TextFormatFlags]::NoPadding
  $measured = [System.Windows.Forms.TextRenderer]::MeasureText($text, $script:fontBBody, [System.Drawing.Size]::new(280, 1000), $flags)
  return [int][Math]::Min(620, [Math]::Max(108, $measured.Height + 84))
}

function Enable-Shadow($form) {
  try { [SNNative]::EnableShadow($form.Handle) } catch { }
}

function Hide-Self {
  # Both our own windows disappear for the instant of the shutter only.
  try { if ($script:bubble -and $script:bubble.Visible) { $script:bubble.Hide() } } catch { }
  try { if ($script:mini -and $script:mini.Visible) { $script:mini.Hide() } } catch { }
  $script:hidden.Clear()
  # The main notes window (Edge --app) has this exact title; hide it too.
  try {
    foreach ($h in [SNNative]::FindByTitle('屏幕笔记 · 笔记库')) {
      if ($h -ne $script:mini.Handle) {
        $null = [SNNative]::ShowWindow($h, 0)
        $null = $script:hidden.Add($h)
      }
    }
  } catch { }
}

function Show-Self {
  foreach ($h in $script:hidden) {
    try { $null = [SNNative]::ShowWindow($h, 5) } catch { }
  }
  $script:hidden.Clear()
  try { if ($script:mini -and -not $script:mini.Visible) { $script:mini.Show() } } catch { }
  # The bubble is NOT restored here: its visibility is driven explicitly by
  # Show-BubbleProcessing / Show-BubbleDone / Hide-Bubble.
}

function Open-Main {
  try {
    $wins = [SNNative]::FindByTitle('屏幕笔记 · 笔记库')
    foreach ($h in $wins) {
      if ($h -ne $script:mini.Handle) {
        $null = [SNNative]::ShowWindow($h, 9)
        $null = [SNNative]::SetForegroundWindow($h)
        return
      }
    }
  } catch { }
  $url = "$($script:base)/?view=main"
  $pf86 = ${env:ProgramFiles(x86)}
  $pf = $env:ProgramFiles
  $candidates = @()
  if ($pf86) { $candidates += (Join-Path $pf86 'Microsoft\Edge\Application\msedge.exe') }
  if ($pf) { $candidates += (Join-Path $pf 'Microsoft\Edge\Application\msedge.exe') }
  $edge = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($edge) {
    Start-Process -FilePath $edge -ArgumentList "--app=$url", '--window-size=1280,840' | Out-Null
  } else {
    Start-Process $url | Out-Null
  }
}

function Apply-TopMost {
  try { $script:mini.TopMost = [bool]$script:alwaysOnTop } catch { }
  try { $script:bubble.TopMost = [bool]$script:alwaysOnTop } catch { }
  try { $script:caption.TopMost = $true } catch { }
}

# ---------------- speech bubble ----------------
function Position-Bubble {
  try {
    $area = [System.Windows.Forms.Screen]::FromControl($script:mini).WorkingArea
    $x = [Math]::Max($area.Left, [Math]::Min($script:mini.Left + 6, $area.Right - $script:bubble.Width))
    $y = $script:mini.Bottom + 9
    if ($y + $script:bubble.Height -gt $area.Bottom) { $y = [Math]::Max($area.Top, $script:mini.Top - $script:bubble.Height - 9) }
    $script:bubble.Location = [System.Drawing.Point]::new($x, $y)
  } catch { }
}

function Apply-BubbleShape([int]$w, [int]$h) {
  $b = $script:bubble
  $b.Size = [System.Drawing.Size]::new($w, $h)
  Position-Bubble
  $tipX = if ($script:bubbleMode -eq 'processing') { 30 } else { 34 }
  $p = New-BubblePath $w $h 13 $tipX 9
  $old = $b.Region
  $b.Region = [System.Drawing.Region]::new($p)
  $p.Dispose()
  if ($old) { try { $old.Dispose() } catch { } }
}

function Prepare-Bubble {
  if ($script:bubblePrepared) { return }
  $script:bubblePrepared = $true
  Set-ExcludeFromCapture $script:bubble.Handle
  Enable-Shadow $script:bubble
}

function Show-BubbleProcessing {
  if ($script:collectBtn) { $script:collectBtn.Visible = $false }
  if ($script:feedbackBtn) { $script:feedbackBtn.Visible = $false }
  $script:bubbleMode = 'processing'
  $script:bubbleTitle = ''
  $script:bubbleSummary = ''
  $script:dotPhase = 0
  $script:closeHover = $false
  Apply-BubbleShape 176 56
  if (-not $script:bubble.Visible) { $script:bubble.Show() }
  Prepare-Bubble
  $script:bubble.Invalidate()
  $script:dotTimer.Start()
  Write-Json @{ event = 'bubble-processing'; visible = $script:bubble.Visible; animated = $true }
}

function Show-BubbleDone([string]$title, [string]$summary, [string]$kind = 'note', [string]$inspireId = '') {
  if ($script:feedbackBtn) { $script:feedbackBtn.Visible = ($kind -eq 'companion') }
  $script:bubbleKind = $kind
  $script:bubbleInspireId = $inspireId
  if ($script:collectBtn) { $script:collectBtn.Visible = ($kind -eq 'companion' -and $inspireId -ne ''); $script:collectBtn.Enabled = $true; $script:collectBtn.Text = '收藏这条灵感' }
  $script:dotTimer.Stop()
  $t = [string]$title
  $s = [string]$summary
  # No hard character cut any more: the bubble grows to fit the whole summary.
  $script:bubbleMode = 'done'
  $script:bubbleTitle = $t
  $script:bubbleSummary = $s
  $script:closeHover = $false
  $h = Get-BubbleHeight $s
  if ($kind -eq 'companion') { $h += 34 }
  Apply-BubbleShape 320 $h
  if ($script:feedbackBtn) { $script:feedbackBtn.Location = [System.Drawing.Point]::new(18,($h - 36)) }
  if ($script:collectBtn) { $script:collectBtn.Location = [System.Drawing.Point]::new(186, ($h - 36)) }
  if (-not $script:bubble.Visible) { $script:bubble.Show() }
  Prepare-Bubble
  $script:bubble.Invalidate()
  Write-Json @{ event = 'bubble-done'; title = $t; summary_chars = $s.Length; bubble_height = $h; close_button = $true; visible = $script:bubble.Visible }
}

function Show-BubbleError([string]$message) {
  $script:dotTimer.Stop()
  $m = [string]$message
  if ($script:collectBtn) { $script:collectBtn.Visible = $false }
  if ($script:feedbackBtn) { $script:feedbackBtn.Visible = $false }
  $script:bubbleKind = 'error'
  $script:bubbleMode = 'error'
  $script:bubbleTitle = '这次没能完成，可重试'
  $script:bubbleSummary = $m
  $script:closeHover = $false
  $h = Get-BubbleHeight $m
  Apply-BubbleShape 320 $h
  if (-not $script:bubble.Visible) { $script:bubble.Show() }
  Prepare-Bubble
  $script:bubble.Invalidate()
  Write-Json @{ event = 'bubble-error'; message = $m; close_button = $true }
}

function Hide-Bubble([bool]$emit = $true) {
  $script:dotTimer.Stop()
  try { if ($script:bubble.Visible) { $script:bubble.Hide() } } catch { }
  $script:bubbleMode = 'none'
  if ($emit) { Write-Json @{ event = 'bubble-closed'; visible = $false } }
}

function Select-ReadingRegion {
  try {
    $script:vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $script:selection = $null
    Hide-Self
    Show-Overlay 'rect'
    if ($null -ne $script:selection) {
      $null = Invoke-Api 'set_reading_region' @{rect=$script:selection.rect}
      Set-StateText '关注区域已更新'
      Write-Json @{event='reading-region-selected';rect=$script:selection.rect}
    }
  } catch { Show-BubbleError $_.Exception.Message }
  finally { try { $null = Invoke-Api 'cancel_reading_region' @{} } catch { }; Show-Self }
}

function Highlight-ReadingRegion($rect) {
  Hide-Self
  $f = $null
  try {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $f = [System.Windows.Forms.Form]::new()
  $f.Text = '屏幕笔记 · 关注区域'; $f.FormBorderStyle = 'None'; $f.StartPosition = 'Manual'; $f.ShowInTaskbar = $false; $f.TopMost = $true
  $f.BackColor = [System.Drawing.Color]::Magenta; $f.TransparencyKey = [System.Drawing.Color]::Magenta
  $f.SetBounds(($bounds.Left+[int]$rect.x),($bounds.Top+[int]$rect.y),[int]$rect.w,[int]$rect.h)
  $f.Add_Paint({ param($sender,$e) $pen=[System.Drawing.Pen]::new([System.Drawing.Color]::RoyalBlue,4); $e.Graphics.DrawRectangle($pen,2,2,($sender.Width-5),($sender.Height-5));$pen.Dispose() })
  $f.Show(); Set-ExcludeFromCapture $f.Handle
  $until=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+1200
  while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $until) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 16 }
  Write-Json @{event='reading-region-highlighted'}
  } finally { if ($f) { $f.Close();$f.Dispose() }; Show-Self }
}

function Repair-WindowPositions {
  foreach ($f in @($script:mini,$script:caption)) {
    if ($null -eq $f -or $f.IsDisposed) { continue }
    $area=[System.Windows.Forms.Screen]::FromControl($f).WorkingArea
    $visible=Get-VisibleWindowBounds $f.Bounds $area
    if ($f.Bounds -ne $visible) { $f.Bounds=$visible }
  }
  Position-Bubble
}

function Start-Capture([string]$forcedScope = '') {
  # Own guard: shell_poll refreshes $script:busy every 400 ms, so it must not be
  # used to decide whether a capture is already running on this side.
  if ($script:captureBusy) { return }
  $useScope = if ($forcedScope) { $forcedScope } else { $script:scope }
  $script:vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $script:selection = $null
  $script:points.Clear()
  if ($useScope -eq 'full') {
    $script:selection = @{ scope = 'full'; rect = @{ x = 0; y = 0; w = $script:vs.Width; h = $script:vs.Height } }
  } else {
    Show-Overlay $useScope
    if ($null -eq $script:selection) { return }
  }
  $script:captureBusy = $true
  Update-Mini
  try {
    # ---- Phase 1: hide our own windows ONLY for the instant of the grab ----
    Hide-Self
    Start-Sleep -Milliseconds 220
    $grab = Invoke-Api 'capture_grab' $script:selection

    # ---- Phase 2: bring the panel back BEFORE OCR / model / save run ----
    # The image already lives in the helper process's memory, so showing the
    # window again cannot contaminate the capture. A small "thinking" bubble
    # appears below the panel while the local model works.
    Show-Self
    Set-StateText '整理中'
    $script:mini.Refresh()
    [System.Windows.Forms.Application]::DoEvents()
    Write-Json @{ event = 'panel-visible-during-processing'; visible = $script:mini.Visible; scope = $useScope; frame = $grab.snap.frame }
    Show-BubbleProcessing

    # Async-pumped request keeps the dot animation alive during the 2-3 s.
    $note = Invoke-ApiPump 'capture_process' @{ snap = $grab.snap }
    Show-BubbleDone ([string]$note.title) ([string]$note.summary)
    Write-Json @{ event = 'captured'; id = $note.id; scope = $useScope; title = $note.title }
  } catch {
    Show-BubbleError ([string]$_.Exception.Message)
    Write-Json @{ event = 'capture-error'; error = $_.Exception.Message }
  } finally {
    Show-Self
    $script:captureBusy = $false
    Update-Mini
  }
}

function Show-Overlay([string]$mode) {
  $form = [System.Windows.Forms.Form]::new()
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.Bounds = $script:vs
  $form.TopMost = $true
  $form.ShowInTaskbar = $false
  $form.BackColor = [System.Drawing.Color]::FromArgb(18, 20, 24)
  $form.Opacity = 0.46
  $form.Cursor = [System.Windows.Forms.Cursors]::Cross
  $form.Text = 'Screen Notes Capture'
  $script:overlay = $form
  $script:overlayMode = $mode
  $script:dragStart = $null
  $script:dragEnd = $null
  $script:currentRect = [System.Drawing.Rectangle]::Empty

  $tip = if ($mode -eq 'window') { '移动鼠标选择窗口 · 单击确认 · Esc 取消' }
    elseif ($mode -eq 'free') { '按住左键自由圈选 · 松开完成 · Esc 取消' }
    else { '拖动选择矩形区域 · Esc 取消' }
  $form.Add_Paint({
    param($s, $e)
    try {
      $g = $e.Graphics
      $font = [System.Drawing.Font]::new('Microsoft YaHei', 11)
      $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(235, 238, 244))
      $g.DrawString($tip, $font, $brush, 24, 20)
      $brush.Dispose(); $font.Dispose()
      if (-not $script:currentRect.IsEmpty -and $script:overlayMode -ne 'free') {
        $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 255, 255), 1.5)
        $g.DrawRectangle($pen, $script:currentRect.X, $script:currentRect.Y, $script:currentRect.Width, $script:currentRect.Height)
        $pen.Dispose()
      }
    } catch { }
  })

  $form.Add_KeyDown({
    param($s, $e)
    if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
      $script:selection = $null
      $form.Close()
    }
  })

  $form.Add_MouseDown({
    param($s, $e)
    if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
    if ($script:overlayMode -eq 'window') {
      if (-not $script:currentRect.IsEmpty) {
        $script:selection = @{ scope = 'window'; rect = @{ x = $script:currentRect.X; y = $script:currentRect.Y; w = $script:currentRect.Width; h = $script:currentRect.Height } }
        $form.Close()
      }
      return
    }
    $script:dragStart = [System.Drawing.Point]::new($e.X, $e.Y)
    $script:dragEnd = $script:dragStart
    if ($script:overlayMode -eq 'free') {
      $script:points.Clear()
      $null = $script:points.Add(@{ x = $e.X; y = $e.Y })
    }
  })

  $form.Add_MouseMove({
    param($s, $e)
    try {
      if ($script:overlayMode -eq 'window') {
        $pt = [SNNative+POINT]::new()
        $pt.X = $script:vs.Left + $e.X
        $pt.Y = $script:vs.Top + $e.Y
        $h = [SNNative]::WindowFromPoint($pt)
        if ($h -ne [IntPtr]::Zero) {
          $root = [SNNative]::GetAncestor($h, 2)
          if ($root -eq [IntPtr]::Zero) { $root = $h }
          $wr = [SNNative+RECT]::new()
          if ([SNNative]::GetWindowRect($root, [ref]$wr)) {
            $x = $wr.Left - $script:vs.Left
            $y = $wr.Top - $script:vs.Top
            $w = $wr.Right - $wr.Left
            $hh = $wr.Bottom - $wr.Top
            if ($w -gt 4 -and $hh -gt 4) { $script:currentRect = [System.Drawing.Rectangle]::new($x, $y, $w, $hh) }
          }
        }
      } elseif ($script:dragStart) {
        $script:dragEnd = [System.Drawing.Point]::new($e.X, $e.Y)
        if ($script:overlayMode -eq 'free') { $null = $script:points.Add(@{ x = $e.X; y = $e.Y }) }
        $x = [Math]::Min($script:dragStart.X, $script:dragEnd.X)
        $y = [Math]::Min($script:dragStart.Y, $script:dragEnd.Y)
        $w = [Math]::Abs($script:dragEnd.X - $script:dragStart.X)
        $hh = [Math]::Abs($script:dragEnd.Y - $script:dragStart.Y)
        $script:currentRect = [System.Drawing.Rectangle]::new($x, $y, $w, $hh)
      }
      Update-OverlayRegion
    } catch { }
  })

  $form.Add_MouseUp({
    param($s, $e)
    if ($script:overlayMode -eq 'window') { return }
    if (-not $script:dragStart) { return }
    if ($script:currentRect.Width -lt 8 -or $script:currentRect.Height -lt 8) { return }
    if ($script:overlayMode -eq 'free' -and $script:points.Count -ge 3) {
      $script:selection = @{
        scope = 'free'
        rect = @{ x = $script:currentRect.X; y = $script:currentRect.Y; w = $script:currentRect.Width; h = $script:currentRect.Height }
        points = @($script:points.ToArray())
      }
    } else {
      $script:selection = @{
        scope = 'rect'
        rect = @{ x = $script:currentRect.X; y = $script:currentRect.Y; w = $script:currentRect.Width; h = $script:currentRect.Height }
      }
    }
    $form.Close()
  })

  $form.Show()
  $form.Activate()
  Update-OverlayRegion
  while ($form.Visible) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 16 }
  $form.Dispose()
  $script:overlay = $null
}

function Update-OverlayRegion {
  if ($null -eq $script:overlay -or -not $script:overlay.Visible) { return }
  $full = [System.Drawing.Region]::new($script:overlay.ClientRectangle)
  try {
    if ($script:overlayMode -eq 'free' -and $script:points.Count -ge 3) {
      $ptArray = [System.Drawing.Point[]]::new($script:points.Count)
      for ($i = 0; $i -lt $script:points.Count; $i++) {
        $ptArray[$i] = [System.Drawing.Point]::new([int]$script:points[$i].x, [int]$script:points[$i].y)
      }
      $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
      $path.AddPolygon($ptArray)
      $full.Exclude($path)
      $path.Dispose()
    } elseif (-not $script:currentRect.IsEmpty -and $script:currentRect.Width -gt 2 -and $script:currentRect.Height -gt 2) {
      $full.Exclude($script:currentRect)
    }
  } catch { }
  $prev = $script:overlay.Region
  $script:overlay.Region = $full
  if ($prev) { try { $prev.Dispose() } catch { } }
  $script:overlay.Invalidate()
}

# ---------------- mini panel (compact upper half only) ----------------
$script:mini = [System.Windows.Forms.Form]::new()
$mini = $script:mini
$mini.Text = '屏幕笔记 · 悬浮窗'
$mini.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$mini.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$mini.Size = [System.Drawing.Size]::new(348, 82)
$mini.BackColor = $script:white
$mini.TopMost = $true
$mini.ShowInTaskbar = $true
$mini.ShowIcon = $false
$mini.MaximizeBox = $false
$mini.MinimizeBox = $false
$mini.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$mini.Location = [System.Drawing.Point]::new(($wa.Right - $mini.Width - 20), ($wa.Top + 20))

function New-MiniButton([string]$text, [int]$x, [int]$y, [int]$w, [int]$h) {
  $b = [System.Windows.Forms.Button]::new()
  $b.Text = $text
  $b.Location = [System.Drawing.Point]::new($x, $y)
  $b.Size = [System.Drawing.Size]::new($w, $h)
  $b.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $b.FlatAppearance.BorderSize = 0
  # Hover is driven by our own state, not by FlatAppearance: the framework's
  # hover colour used to survive a poll repaint and show the wrong state.
  $b.BackColor = $script:soft
  $b.ForeColor = $script:ink
  $b.Font = $script:fontBtn
  $b.Cursor = [System.Windows.Forms.Cursors]::Hand
  $b.UseVisualStyleBackColor = $false
  $b.TabStop = $false
  $b.Add_MouseEnter({ param($s, $e) $script:hoverBtn = $s; Update-Mini })
  $b.Add_MouseLeave({ param($s, $e) if ($script:hoverBtn -eq $s) { $script:hoverBtn = $null }; Update-Mini })
  $script:mini.Controls.Add($b)
  Set-RoundRegion $b $w $h 9
  return $b
}

# Row 1: icon-only logo (painted below) + compact controls.
$script:autoBtn = New-MiniButton '陪伴 ○' 82 12 48 30
$script:autoBtn.Font = $script:fontBtnSm
$script:autoBtn.Add_Click({
  try {
    $st = Invoke-Api 'set_auto_mode' @{ enabled = (-not $script:auto) }
    $script:auto = [bool]$st.auto_enabled
    if ($script:auto) { Show-BubbleDone '我在这儿，陪你看看' '页面变化后，我会概括重点，分享一点理解。感兴趣时再收藏，也可以点“聊聊这页”让我马上看看。' 'companion' }
    Update-Mini
  } catch { Write-Json @{ event = 'error'; message = $_.Exception.Message } }
})

function Stop-CaptionAndReview {
  if ($script:captionStopping) { return }
  $script:captionStopping = $true
  $script:captionBtn.Enabled = $false
  try {
    Set-StateText '正在收尾…'
    $r = Invoke-ApiPump 'stop_caption' @{} $false
    $script:captionActive = $false
    Update-Mini
    $review = Invoke-Api 'get_caption_session' @{ session_id = $r.session_id }
    $script:saveSessionId = [int]$r.session_id
    $script:saveSections = @(Invoke-Api 'list_section_rows')
    $script:saveDialog = [System.Windows.Forms.Form]::new()
    $d = $script:saveDialog
    $d.Text = '字幕已停止 · 保存到哪里'
    $d.Size = [System.Drawing.Size]::new(460, 304)
    $d.StartPosition = 'CenterScreen'
    $d.FormBorderStyle = 'FixedDialog'
    $d.MaximizeBox = $false
    $d.MinimizeBox = $false
    $d.TopMost = $true
    $d.Font = $script:fontBtn
    $label = [System.Windows.Forms.Label]::new()
    $label.Text = "已识别 $(@($review.transcripts).Count) 段字幕。选择保存分区，或回看后勾选片段。"
    $label.Location = [System.Drawing.Point]::new(20, 18)
    $label.Size = [System.Drawing.Size]::new(410, 48)
    $d.Controls.Add($label)
    if (@($review.issues).Count -gt 0) { $label.Text += "`n有 $(@($review.issues).Count) 段识别失败。请点回看重试；直接保存需确认缺失。" }
    $script:saveIssues=@($review.issues)
    $script:saveSectionBox = [System.Windows.Forms.ComboBox]::new()
    $box = $script:saveSectionBox
    $box.DropDownStyle = 'DropDownList'
    $box.Location = [System.Drawing.Point]::new(20, 74)
    $box.Size = [System.Drawing.Size]::new(410, 28)
    foreach ($sec in $script:saveSections) { $null = $box.Items.Add([string]$sec.name) }
    if ($box.Items.Count -gt 0) { $box.SelectedIndex = 0 }
    $d.Controls.Add($box)
    $save = [System.Windows.Forms.Button]::new()
    $save.Text = '保存全场'
    $save.Location = [System.Drawing.Point]::new(20, 122)
    $save.Size = [System.Drawing.Size]::new(125, 34)
    $save.Enabled = (@($review.transcripts).Count -gt 0)
    $save.Add_Click({
      $this.Enabled = $false
      try {
        $secId = $null
        if ($script:saveSectionBox.SelectedIndex -ge 0) { $secId = $script:saveSections[$script:saveSectionBox.SelectedIndex].id }
        $allow=$false
        if ($script:saveIssues.Count -gt 0) { $answer=[System.Windows.Forms.MessageBox]::Show('有部分音频未识别。仍然保存已经识别的内容吗？若要重试，请选择否并点回看。','确认保存不完整转录','YesNo','Warning');if($answer -ne 'Yes') { $this.Enabled=$true;return };$allow=$true }
        $null = Invoke-ApiPump 'caption_save_scope' @{ session_id = $script:saveSessionId; strategy = 'full'; section_id = $secId; polish = $true;allow_incomplete=$allow } $false
        $script:saveDialog.Close()
        $where = Invoke-Api 'get_settings' @{}
        $sectionName = if ($script:saveSectionBox.SelectedIndex -ge 0) { [string]$script:saveSections[$script:saveSectionBox.SelectedIndex].name } else { '收集箱' }
        Show-BubbleDone '字幕已保存' ("分区：$sectionName`n数据位置：$($where.data_dir)`n可在笔记详情中打开保存位置。")
        Write-Json @{ event = 'caption-saved'; session_id = $script:saveSessionId; section_id = $secId }
      } catch { $null = [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '保存失败，请重试'); $this.Enabled = $true }
    })
    $d.Controls.Add($save)
    $reviewBtn = [System.Windows.Forms.Button]::new()
    $reviewBtn.Text = '回看 / 选择片段'
    $reviewBtn.Location = [System.Drawing.Point]::new(155, 122)
    $reviewBtn.Size = [System.Drawing.Size]::new(140, 34)
    $reviewBtn.Add_Click({
      $null = Invoke-Api 'request_caption_review' @{ session_id = $script:saveSessionId }
      Open-Main
      $script:saveDialog.Close()
    })
    $d.Controls.Add($reviewBtn)
    $later = [System.Windows.Forms.Button]::new()
    $later.Text = '稍后处理'
    $later.Location = [System.Drawing.Point]::new(305, 122)
    $later.Size = [System.Drawing.Size]::new(125, 34)
    $later.Add_Click({ $script:saveDialog.Close() })
    $d.Controls.Add($later)
    $discard = [System.Windows.Forms.Button]::new()
    $discard.Text = '不保存并丢弃'
    $discard.Location = [System.Drawing.Point]::new(20, 166)
    $discard.Size = [System.Drawing.Size]::new(125, 32)
    $discard.Add_Click({
      $answer = [System.Windows.Forms.MessageBox]::Show('确定丢弃这场字幕吗？', '丢弃字幕', 'YesNo', 'Question')
      if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
        try {
          $null = Invoke-Api 'caption_save_scope' @{ session_id = $script:saveSessionId; strategy = 'discard' }
          $script:saveDialog.Close()
        } catch { $null = [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '丢弃失败') }
      }
    })
    $d.Controls.Add($discard)
    $hint = [System.Windows.Forms.Label]::new()
    $hint.Text = '关闭此窗口会保留字幕，可在主页面“草稿与字幕”中恢复。'
    $hint.Location = [System.Drawing.Point]::new(20, 214)
    $hint.Size = [System.Drawing.Size]::new(410, 40)
    $d.Controls.Add($hint)
    Write-Json @{ event = 'caption-save-prompt'; session_id = $script:saveSessionId; section_count = $script:saveSections.Count }
    $null = $d.ShowDialog()
    $d.Dispose()
  } catch {
    $null = [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '字幕操作失败')
    Write-Json @{ event = 'caption-error'; message = $_.Exception.Message }
  } finally { $script:captionStopping = $false; $script:captionBtn.Enabled = $true }
}

# Caption mode toggle: start / stop voice-to-text (loopback audio + ASR) and
# the on-screen subtitle bar. State is refreshed from caption_status on every
# poll, so the button label mirrors the backend session.
$script:captionBtn = New-MiniButton '字幕' 136 12 52 30
$script:captionBtn.Font = $script:fontBtnSm
$script:captionBtn.Add_Click({
  try {
    if ($script:captionActive) {
      Stop-CaptionAndReview
    } else {
      $r = Invoke-Api 'start_caption' @{ provider = 'OpenAiCompatibleASR';  }
      $script:captionActive = $true
      Update-Mini
      Write-Json @{ event = 'caption-started'; session_id = $r.session_id; audio_ok = $r.audio_ok; asr_ready = $r.asr_ready }
    }
  } catch { Write-Json @{ event = 'caption-error'; message = $_.Exception.Message } }
})

# Pin toggle: an owner-drawn pushpin instead of a CheckBox. The CheckBox's own
# checked rendering used to fight with the colours set on every poll, which is
# why the button sometimes showed the wrong state.
$script:pinBtn = New-MiniButton '' 46 12 30 30
$script:pinBtn.Add_Paint({
  param($s, $e)
  try {
    $g = $e.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $on = $script:alwaysOnTop
    $c = if ($on) { $script:accent } else { $script:muted }
    if (-not $on) {
      $g.TranslateTransform(15, 15)
      $g.RotateTransform(-38)
      $g.TranslateTransform(-15, -15)
    }
    $pen = [System.Drawing.Pen]::new($c, 1.7)
    $g.DrawRectangle($pen, 9, 7, 12, 6)
    $g.DrawLine($pen, 12, 13, 18, 13)
    $g.DrawLine($pen, 17, 13, 15, 19)
    $g.DrawLine($pen, 15, 19, 15, 24)
    $pen.Dispose()
    if (-not $on) { $g.ResetTransform() }
  } catch { }
})
$script:pinBtn.Add_Click({
  $script:alwaysOnTop = -not $script:alwaysOnTop
  Apply-TopMost
  Update-Mini
  $script:pinBtn.Invalidate()
  try { $null = Invoke-Api 'set_always_on_top' @{ enabled = $script:alwaysOnTop } } catch { }
  Write-Json @{ event = 'topmost'; enabled = $script:alwaysOnTop }
})

$script:captionBrush = New-MiniButton '' 194 12 28 30
$script:captionBrush.AccessibleName = '调整字幕字体大小和颜色'
$script:captionBrush.ForeColor = $script:muted
$script:captionBrush.Add_Paint({
  param($s, $e)
  Draw-CaptionBrushIcon $e.Graphics $s.ClientRectangle $s.ForeColor ($script:pressedMini -eq $s)
})
$script:captionBrush.Add_MouseDown({ param($s,$e) if ($e.Button -eq 'Left') { $script:pressedMini = $s; Update-Mini; $s.Invalidate() } })
$script:captionBrush.Add_MouseUp({ param($s,$e) $script:pressedMini = $null; Update-Mini; $s.Invalidate() })
$script:captionBrush.Add_Click({ Open-CaptionStyle })
$script:miniTips = [System.Windows.Forms.ToolTip]::new()
$script:miniTips.SetToolTip($script:captionBrush, '字幕样式 · 字号、文字颜色和背景')

$script:expandBtn = New-MiniButton '⤢' 228 12 28 30
$script:expandBtn.Font = $script:fontBtn
$script:expandBtn.Add_Click({ Open-Main })

$script:recordBtn = New-MiniButton '● 记录' 262 11 74 32
$script:recordBtn.BackColor = $script:accent
$script:recordBtn.ForeColor = $script:white
$script:recordBtn.Font = [System.Drawing.Font]::new('Microsoft YaHei', 9.5, [System.Drawing.FontStyle]::Bold)
$script:recordBtn.Add_Click({ Start-Capture })

$script:inspireBtn = New-MiniButton '聊聊这页' 188 50 84 24
$script:inspireBtn.Font = $script:fontBtnSm
$script:inspireBtn.Add_Click({
  if ($script:inspireBusy) { return }
  $script:inspireBusy = $true
  $script:inspireBtn.Enabled = $false
  try {
    Show-BubbleProcessing
    $r = Invoke-ApiPump 'auto_inspire' @{} $false
    if ($r.skipped) { Show-BubbleDone '这页暂时没看清' ([string]$r.reason) 'companion' }
    else { $script:lastAutoSignature = (([string]$r.title) + '|' + ([string]$r.summary)) -replace '\s+', ''; Show-BubbleDone ([string]$r.title) ([string]$r.summary) 'companion' ([string]$r.id) }
  } catch { Show-BubbleError $_.Exception.Message }
  finally { $script:inspireBusy = $false; $script:inspireBtn.Enabled = $true }
})

# Row 2: segmented capture-scope control + compact status text.
$scopeNames = @{ full = '全屏'; rect = '矩形选区' }
$script:scopeBtns = @{}
$sx = 14
foreach ($key in @('full', 'rect')) {
  $b = New-MiniButton $scopeNames[$key] $sx 50 78 24
  $b.Font = $script:fontBtnSm
  $script:scopeBtns[$key] = $b
  $b.Add_Click({
    param($s, $e)
    $picked = $null
    foreach ($k in $script:scopeBtns.Keys) { if ($script:scopeBtns[$k] -eq $s) { $picked = $k } }
    if (-not $picked) { return }
    try {
      $null = Invoke-Api 'set_capture_scope' @{ scope = $picked }
      $script:scope = $picked
      Update-Mini
    } catch { Write-Json @{ event = 'error'; message = $_.Exception.Message } }
  })
  $sx += 84
}

$script:stateLabel = [System.Windows.Forms.Label]::new()
$script:stateLabel.Location = [System.Drawing.Point]::new(278, 50)
$script:stateLabel.Size = [System.Drawing.Size]::new(58, 24)
$script:stateLabel.Font = $script:fontBtnSm
$script:stateLabel.ForeColor = $script:muted
$script:stateLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleRight
$mini.Controls.Add($script:stateLabel)

$mini.Add_Paint({
  param($s, $e)
  try {
    $g = $e.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

    # Icon-only logo: a screen frame with two lines of notes. No lettering,
    # no app name, no subtitle - the tile itself is the brand mark.
    $lp = New-RoundPath 24 24 7
    $scale = if ($script:miniScale) { $script:miniScale } else { 1.0 }
    $g.ScaleTransform($scale,$scale)
    $g.TranslateTransform(14, 14)
    $ab = [System.Drawing.SolidBrush]::new($script:accent)
    $g.FillPath($ab, $lp)
    $ab.Dispose()
    $g.ResetTransform()
    $g.ScaleTransform($scale,$scale)
    $lp.Dispose()
    $wp = [System.Drawing.Pen]::new($script:white, 1.4)
    $g.DrawRectangle($wp, 19, 19, 14, 14)
    $g.DrawLine($wp, 22, 24, 30, 24)
    $g.DrawLine($wp, 22, 28, 28, 28)
    $wp.Dispose()

    $g.ResetTransform()
    # hairline rounded border
    $bp = New-RoundPath ($s.ClientRectangle.Width - 1) ($s.ClientRectangle.Height - 1) 14
    $pen = [System.Drawing.Pen]::new($script:line, 1)
    $g.DrawPath($pen, $bp)
    $pen.Dispose(); $bp.Dispose()
  } catch { }
})

$mini.Add_MouseDown({
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $script:dragOffset = [System.Drawing.Point]::new($e.X, $e.Y)
    $script:dragging = $true
  }
})
$mini.Add_MouseMove({
  param($s, $e)
  if ($script:dragging) {
    $p = [System.Windows.Forms.Control]::MousePosition
    $mini.Location = [System.Drawing.Point]::new(($p.X - $script:dragOffset.X), ($p.Y - $script:dragOffset.Y))
  }
})
$mini.Add_MouseUp({ $script:dragging = $false })
$mini.Add_DoubleClick({ Open-Main })
$mini.Add_LocationChanged({ Position-Bubble })

function Set-StateText([string]$msg) {
  # The status slot is deliberately tiny. Map the long backend messages to a
  # short word and only touch the Label when it actually changed.
  if ($script:lastStateText -ceq $msg) { return }
  $script:lastStateText = $msg
  $short = '就绪'
  if ($msg -match '整理|OCR|总结|截屏|保存中|processing') { $short = '处理中' }
  elseif ($msg -match '已保存|已合并|自检完成') { $short = '已记录' }
  elseif ($msg -match '无变化|降频|跳过|待机') { $short = '待机' }
  elseif ($msg -match '陪伴已开启|有一点想法') { $short = '陪伴中' }
  elseif ($msg -match '自己的收藏库') { $short = '暂候' }
  elseif ($msg -match '陪伴已暂停') { $short = '已暂停' }
  elseif ($msg -match '错误|失败|error') { $short = '异常' }
  if ($script:stateLabel.Text -cne $short) { $script:stateLabel.Text = $short }
}

function Update-Mini {
  try {
    $hoverAuto = ($script:hoverBtn -eq $script:autoBtn)
    $hoverPin = ($script:hoverBtn -eq $script:pinBtn)
    $hoverExpand = ($script:hoverBtn -eq $script:expandBtn)
    $hoverRec = ($script:hoverBtn -eq $script:recordBtn)
    $hoverCaption = ($script:hoverBtn -eq $script:captionBtn)

    $aBg = $script:soft
    if ($script:auto) { $aBg = $script:accentSoft }
    if ($hoverAuto) { $aBg = $script:hover }
    $aFg = if ($script:auto) { $script:accent } else { $script:muted }
    $aTx = if ($script:auto) { '陪伴 ●' } else { '陪伴 ○' }
    Set-BtnStyle $script:autoBtn $aBg $aFg $aTx

    $cBg = $script:soft
    if ($script:captionActive) { $cBg = $script:accentSoft }
    if ($hoverCaption) { $cBg = $script:hover }
    $cFg = if ($script:captionActive) { $script:accent } else { $script:muted }
    $cTx = if ($script:captionActive) { '字幕中' } else { '字幕' }
    Set-BtnStyle $script:captionBtn $cBg $cFg $cTx

    $pBg = if ($script:alwaysOnTop) { $script:accentSoft } else { $script:soft }
    if ($hoverPin) { $pBg = $script:hover }
    Set-BtnStyle $script:pinBtn $pBg $script:muted ''
    if ($script:lastPinOn -ne $script:alwaysOnTop) {
      $script:lastPinOn = $script:alwaysOnTop
      $script:pinBtn.Invalidate()
    }

    $brushActive = $script:styleDialog -and -not $script:styleDialog.IsDisposed -and $script:styleDialog.Visible
    $brushHover = ($script:hoverBtn -eq $script:captionBrush)
    $brushPressed = ($script:pressedMini -eq $script:captionBrush)
    $brushBg = if ($brushActive -or $brushPressed) { $script:accentSoft } elseif ($brushHover) { $script:hover } else { $script:soft }
    $brushFg = if ($brushActive -or $brushHover -or $brushPressed) { $script:accent } else { $script:muted }
    Set-BtnStyle $script:captionBrush $brushBg $brushFg ''

    $eBg = if ($hoverExpand) { $script:hover } else { $script:soft }
    Set-BtnStyle $script:expandBtn $eBg $script:ink '⤢'

    foreach ($k in $script:scopeBtns.Keys) {
      $b = $script:scopeBtns[$k]
      $hovered = ($script:hoverBtn -eq $b)
      $bg = $script:soft
      $fg = $script:muted
      if ($k -eq $script:scope) { $bg = $script:accent; $fg = $script:white }
      if ($hovered) { $bg = if ($k -eq $script:scope) { $script:accentDeep } else { $script:hover } }
      Set-BtnStyle $b $bg $fg ([string]$scopeNames[$k])
    }

    $isBusy = ($script:captureBusy -or $script:busy)
    $wantEnabled = -not $isBusy
    if ($script:recordBtn.Enabled -ne $wantEnabled) { $script:recordBtn.Enabled = $wantEnabled }
    $rBg = $script:accent
    $rFg = $script:white
    $rTx = '● 记录'
    if ($isBusy) { $rBg = $script:hover; $rFg = $script:muted; $rTx = '…' }
    elseif ($hoverRec) { $rBg = $script:accentDeep }
    Set-BtnStyle $script:recordBtn $rBg $rFg $rTx
  } catch { }
}

# ---------------- speech bubble window ----------------
$script:bubble = [System.Windows.Forms.Form]::new()
$bubble = $script:bubble
$bubble.Text = '屏幕笔记 · 提示'
$bubble.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$bubble.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$bubble.Size = [System.Drawing.Size]::new(176, 56)
$bubble.BackColor = $script:white
$bubble.TopMost = $true
$bubble.ShowInTaskbar = $false
$bubble.ShowIcon = $false
$bubble.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
Enable-DoubleBuffer $bubble
Position-Bubble

$script:collectBtn = [System.Windows.Forms.Button]::new()
$script:collectBtn.Text = '收藏这条灵感'
$script:collectBtn.AccessibleName = '收藏这条灵感到收集箱'
$script:collectBtn.Size = [System.Drawing.Size]::new(116, 26)
$script:collectBtn.FlatStyle = 'Flat'
$script:collectBtn.BackColor = $script:accentSoft
$script:collectBtn.ForeColor = $script:accent
$script:collectBtn.Visible = $false
$script:collectBtn.Add_Click({
  $this.Enabled = $false
  try { $null = Invoke-Api 'collect_inspire' @{ id = $script:bubbleInspireId }; $this.Text = '已收藏到收集箱' }
  catch { $this.Enabled = $true; Show-BubbleError $_.Exception.Message }
})
$bubble.Controls.Add($script:collectBtn)

$script:feedbackBtn = [System.Windows.Forms.Button]::new()
$script:feedbackBtn.Text = '更多'
$script:feedbackBtn.AccessibleName = '陪伴反馈与关注区域'
$script:feedbackBtn.Size = [System.Drawing.Size]::new(64,26)
$script:feedbackBtn.FlatStyle = 'Flat'; $script:feedbackBtn.BackColor = $script:accentSoft; $script:feedbackBtn.ForeColor = $script:accent
$script:feedbackBtn.Visible = $false
$script:feedbackMenu = [System.Windows.Forms.ContextMenuStrip]::new()
$expand = $script:feedbackMenu.Items.Add('展开讲讲')
$expand.Add_Click({ try { $r = Invoke-ApiPump 'companion_expand' @{id=$script:bubbleInspireId} $false; if (-not $r.skipped) { Show-BubbleDone $r.title $r.summary 'companion' $r.id } } catch { Show-BubbleError $_.Exception.Message } })
$less = $script:feedbackMenu.Items.Add('这个话题少说')
$less.Add_Click({ try { $null = Invoke-Api 'companion_feedback' @{action='less'}; Close-Bubble } catch { Show-BubbleError $_.Exception.Message } })
$quiet = $script:feedbackMenu.Items.Add('安静十分钟')
$quiet.Add_Click({ try { $null = Invoke-Api 'companion_feedback' @{action='quiet'}; Close-Bubble } catch { Show-BubbleError $_.Exception.Message } })
$resume = $script:feedbackMenu.Items.Add('恢复分享')
$resume.Add_Click({ try { $null = Invoke-Api 'companion_feedback' @{action='resume'}; Close-Bubble } catch { Show-BubbleError $_.Exception.Message } })
$look = $script:feedbackMenu.Items.Add('正在看哪里')
$look.Add_Click({ try { $null = Invoke-Api 'show_reading_region' @{} } catch { Show-BubbleError $_.Exception.Message } })
$correct = $script:feedbackMenu.Items.Add('看错区域了')
$correct.Add_Click({ try { $null = Invoke-Api 'request_reading_region' @{} } catch { Show-BubbleError $_.Exception.Message } })
$script:feedbackBtn.Add_Click({ $script:feedbackMenu.Show($script:feedbackBtn, [System.Drawing.Point]::new(0,26)) })
$bubble.Controls.Add($script:feedbackBtn)

$bubble.Add_Paint({
  param($s, $e)
  try {
    $g = $e.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $w = $s.Width
    $h = $s.Height
    $mode = $script:bubbleMode
    $tipX = if ($mode -eq 'processing') { 30 } else { 34 }

    # rounded body + upward tail, drawn 1 px inside the Region
    $bp = New-BubblePath ($w - 1) ($h - 1) 13 $tipX 9
    $pen = [System.Drawing.Pen]::new($script:line, 1)
    $g.DrawPath($pen, $bp)
    $pen.Dispose(); $bp.Dispose()

    if ($mode -eq 'processing') {
      $xs = @(30, 46, 62)
      $cy = [int]($h / 2) + 4
      for ($i = 0; $i -lt 3; $i++) {
        $active = ($i -eq $script:dotPhase)
        $alpha = if ($active) { 255 } else { 105 }
        $lift = if ($active) { 5 } else { 0 }
        $c = [System.Drawing.Color]::FromArgb([int]$alpha, [int]$script:accent.R, [int]$script:accent.G, [int]$script:accent.B)
        $br = [System.Drawing.SolidBrush]::new($c)
        $g.FillEllipse($br, ($xs[$i] - 4), ($cy - 4 - $lift), 8, 8)
        $br.Dispose()
      }
      $mb = [System.Drawing.SolidBrush]::new($script:muted)
      $g.DrawString('正在整理截图…', $script:fontBBody, $mb, [System.Drawing.RectangleF]::new(80, 18, 90, 24))
      $mb.Dispose()
    } elseif ($mode -eq 'done' -or $mode -eq 'error') {
      $tag = if ($mode -eq 'error') { '暂时没看清 · 可重试' } elseif ($script:bubbleKind -eq 'companion') { '陪你看看 · 灵感未自动保存' } else { '已记录 · 仅本地' }
      $tb = [System.Drawing.SolidBrush]::new($script:faint)
      $g.DrawString($tag, $script:fontTag, $tb, [System.Drawing.RectangleF]::new(18, 15, 220, 14))
      $tb.Dispose()

      $sf = [System.Drawing.StringFormat]::new()
      $sf.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
      $sf.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
      $ib = [System.Drawing.SolidBrush]::new($script:ink)
      $g.DrawString([string]$script:bubbleTitle, $script:fontBTitle, $ib, [System.Drawing.RectangleF]::new(18, 33, ($w - 52), 20), $sf)
      $ib.Dispose(); $sf.Dispose()

      $sf2 = [System.Drawing.StringFormat]::new()
      $sf2.Trimming = [System.Drawing.StringTrimming]::EllipsisWord
      $mb = [System.Drawing.SolidBrush]::new($script:muted)
      $g.DrawString([string]$script:bubbleSummary, $script:fontBBody, $mb, [System.Drawing.RectangleF]::new(18, 56, ($w - 40), ($h - $(if ($script:bubbleKind -eq 'companion') { 100 } else { 66 }))), $sf2)
      $mb.Dispose(); $sf2.Dispose()

      # small round close button, top-right
      $cx = $w - 26
      $cy = 24
      $bg = if ($script:closeHover) { $script:accentSoft } else { $script:soft }
      $br = [System.Drawing.SolidBrush]::new($bg)
      $g.FillEllipse($br, ($cx - 9), ($cy - 9), 18, 18)
      $br.Dispose()
      $pc = [System.Drawing.Pen]::new($script:muted, 1.3)
      $g.DrawLine($pc, ($cx - 3), ($cy - 3), ($cx + 3), ($cy + 3))
      $g.DrawLine($pc, ($cx + 3), ($cy - 3), ($cx - 3), ($cy + 3))
      $pc.Dispose()
    }
  } catch { }
})

$bubble.Add_MouseDown({
  param($s, $e)
  if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  if ($script:bubbleMode -ne 'done' -and $script:bubbleMode -ne 'error') { return }
  $w = $s.Width
  if ($e.X -ge ($w - 38) -and $e.X -le ($w - 12) -and $e.Y -ge 10 -and $e.Y -le 38) {
    Hide-Bubble $true
  }
})
$bubble.Add_MouseMove({
  param($s, $e)
  $hover = $false
  if ($script:bubbleMode -eq 'done' -or $script:bubbleMode -eq 'error') {
    $w = $s.Width
    $hover = ($e.X -ge ($w - 38) -and $e.X -le ($w - 12) -and $e.Y -ge 10 -and $e.Y -le 38)
  }
  if ($hover -ne $script:closeHover) {
    $script:closeHover = $hover
    $s.Cursor = if ($hover) { [System.Windows.Forms.Cursors]::Hand } else { [System.Windows.Forms.Cursors]::Default }
    $s.Invalidate()
  }
})
$bubble.Add_MouseLeave({
  if ($script:closeHover) {
    $script:closeHover = $false
    $script:bubble.Cursor = [System.Windows.Forms.Cursors]::Default
    $script:bubble.Invalidate()
  }
})

# Three-dot "thinking" animation. Double buffering removes the flicker that
# used to come from repainting the owner-drawn bubble on every tick. The pump
# must sleep ~24 ms between DoEvents calls: a shorter sleep starves WM_TIMER
# and the dots freeze even though the HTTP pump is still running.
$script:dotTimer = [System.Windows.Forms.Timer]::new()
$script:dotTimer.Interval = 130
$script:dotTimer.Add_Tick({
  try {
    $script:dotPhase = ($script:dotPhase + 1) % 3
    if ($script:bubbleMode -eq 'processing' -and $script:bubble.Visible) {
      $script:bubble.Invalidate()
    }
  } catch {
    Write-Json @{ event = 'dot-tick-error'; message = $_.Exception.Message }
  }
})

# ---------------- caption bar (subtitle overlay) ----------------
# A frameless, always-on-top strip at the bottom of the primary screen that
# shows the live transcript of an active caption session. Unlike the mini panel
# and bubble (which belong to the screenshot workflow), the caption bar is
# purely display + drag; it has no buttons of its own and disappears when no
# caption session is running (or when visible=false in the style settings).
$script:caption = [System.Windows.Forms.Form]::new()
$caption = $script:caption
$caption.Text = '屏幕笔记 · 字幕'
$caption.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$caption.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$caption.Size = [System.Drawing.Size]::new(720, 96)
$caption.BackColor = [System.Drawing.Color]::FromArgb(60, 60, 60)
$caption.TopMost = $true
$caption.ShowInTaskbar = $false
$caption.ShowIcon = $false
$caption.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$caption.Opacity = 0.75
$waCap = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$caption.Location = [System.Drawing.Point]::new([int]($waCap.Left + ($waCap.Width - 720) / 2), [int]($waCap.Bottom - 110))
Enable-DoubleBuffer $caption
Set-ExcludeFromCapture $caption.Handle

$caption.Add_Paint({
  param($s, $e)
  try {
    $g = $e.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $w = $s.Width
    $h = $s.Height

    # Background: light-grey rounded strip, or fully transparent when background=false.
    if ($script:captionStyle.background) {
      $bp = New-RoundPath ($w - 1) ($h - 1) 14
      $bb = [System.Drawing.SolidBrush]::new($script:captionBg)
      $g.FillPath($bb, $bp)
      $bb.Dispose(); $bp.Dispose()
    }

    # Word wrap uses exactly the same width/font as Get-CaptionLayout.
    $sf = [System.Drawing.StringFormat]::new()
    $sf.Trimming = [System.Drawing.StringTrimming]::None
    $sf.FormatFlags = [System.Drawing.StringFormatFlags]::LineLimit
    $tb = [System.Drawing.SolidBrush]::new($script:captionFg)
    $g.DrawString($script:captionDisplayText, $script:captionFont, $tb, [System.Drawing.RectangleF]::new(18, 12, ($w - 36), ($h - 24)), $sf)
    $tb.Dispose(); $sf.Dispose()
    if ($script:captionPaintSeq -ne $script:captionLastId) {
      $script:captionPaintSeq = $script:captionLastId
      $paintAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      if ($script:captionReceivedAt -and $script:captionHasText -and $script:captionReportedSession -ne $script:captionSessionId) {
        $script:captionReportedSession = $script:captionSessionId
        $script:captionPaintReport = @{ session_id=$script:captionSessionId; at=$paintAt }
      }
      Write-Json @{event='caption-painted';seq=$script:captionLastId;received_at=$script:captionReceivedAt;paint_at=$paintAt}
    }
  } catch { }
})

$caption.Add_MouseDown({
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $script:captionDragOffset = [System.Drawing.Point]::new($e.X, $e.Y)
    $script:captionDragging = $true
  }
})
$caption.Add_MouseMove({
  param($s, $e)
  if ($script:captionDragging) {
    $p = [System.Windows.Forms.Control]::MousePosition
    $caption.Location = [System.Drawing.Point]::new(($p.X - $script:captionDragOffset.X), ($p.Y - $script:captionDragOffset.Y))
  }
})
$caption.Add_MouseUp({ $script:captionDragging = $false; Repair-WindowPositions })

# A direct, local style editor next to the subtitle, with a preview and persisted Apply.
function Open-CaptionStyle {
  if ($script:styleDialog -and -not $script:styleDialog.IsDisposed) { $script:styleDialog.Activate(); return }
  $script:styleDialog = [System.Windows.Forms.Form]::new()
  $d = $script:styleDialog
  $d.Text = '字幕样式'
  $d.Size = [System.Drawing.Size]::new(410, 470)
  $d.FormBorderStyle = 'FixedDialog'; $d.MaximizeBox = $false; $d.MinimizeBox = $false
  $d.StartPosition = 'CenterScreen'; $d.TopMost = $true; $d.Font = $script:fontBtn
  $script:styleDraft = @{} + $script:captionStyle
  $preset = [System.Windows.Forms.ComboBox]::new(); $preset.DropDownStyle='DropDownList';$preset.SetBounds(20,334,350,28)
  $null=$preset.Items.AddRange(@('选择字幕预设','默认样式','高对比','大字'));$preset.SelectedIndex=0
  $preset.Add_SelectedIndexChanged({
    if ($this.SelectedIndex -lt 1) { return }
    $name=@('','default','contrast','large')[$this.SelectedIndex]
    try { $updated=Invoke-Api 'caption_style_preset' @{name=$name};Apply-CaptionStyle $updated;Show-CaptionCue $script:captionDisplayText;$script:styleDialog.Close() } catch { $null=[System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'样式失败') }
  });$d.Controls.Add($preset)
  $source=[System.Windows.Forms.ComboBox]::new();$source.DropDownStyle='DropDownList';$source.SetBounds(20,376,350,28)
  $null=$source.Items.AddRange(@('字幕音源：电脑播放声音','字幕音源：默认麦克风'))
  $cfg=Invoke-Api 'get_settings' @{};$source.SelectedIndex=if($cfg.audio_source -eq 'microphone'){1}else{0}
  $source.Add_SelectedIndexChanged({ try { $value=if($this.SelectedIndex -eq 1){'microphone'}else{'loopback'};$null=Invoke-Api 'update_settings' @{settings=@{audio_source=$value}};Set-StateText '音源下次开始字幕时生效' } catch { $null=[System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'保存音源失败') } });$d.Controls.Add($source)
  $fontLabel = [System.Windows.Forms.Label]::new(); $fontLabel.Text = '字体大小'; $fontLabel.SetBounds(20,20,110,24); $d.Controls.Add($fontLabel)
  $script:styleFontSize = [System.Windows.Forms.NumericUpDown]::new()
  $script:styleFontSize.SetBounds(140,18,95,28); $script:styleFontSize.Minimum = 12; $script:styleFontSize.Maximum = 72
  $script:styleFontSize.Value = $script:captionStyle.font_size; $d.Controls.Add($script:styleFontSize)
  $script:stylePreview = [System.Windows.Forms.Label]::new()
  $script:stylePreview.Text = '字幕'; $script:stylePreview.TextAlign = 'MiddleCenter'; $script:stylePreview.SetBounds(20,190,350,90)
  $script:stylePreview.BackColor = Convert-HexColor $script:styleDraft.bg_color ([System.Drawing.Color]::DarkSlateGray)
  $script:stylePreview.ForeColor = Convert-HexColor $script:styleDraft.font_color ([System.Drawing.Color]::White)
  $script:stylePreview.Font = [System.Drawing.Font]::new('Microsoft YaHei', $script:styleDraft.font_size, [System.Drawing.FontStyle]::Bold)
  $d.Controls.Add($script:stylePreview)
  $script:styleFontSize.Add_ValueChanged({
    $oldFont = $script:stylePreview.Font
    $script:stylePreview.Font = [System.Drawing.Font]::new('Microsoft YaHei', [float]$script:styleFontSize.Value, [System.Drawing.FontStyle]::Bold)
    $oldFont.Dispose()
  })
  $fg = [System.Windows.Forms.Button]::new(); $fg.Text = '文字颜色'; $fg.SetBounds(20,60,160,32)
  $fg.Add_Click({
    $c = [System.Windows.Forms.ColorDialog]::new(); $c.FullOpen = $true; $c.Color = $script:stylePreview.ForeColor
    if ($c.ShowDialog() -eq 'OK') { $script:styleDraft.font_color = '#' + $c.Color.R.ToString('X2') + $c.Color.G.ToString('X2') + $c.Color.B.ToString('X2'); $script:stylePreview.ForeColor = $c.Color }
    $c.Dispose()
  }); $d.Controls.Add($fg)
  $bg = [System.Windows.Forms.Button]::new(); $bg.Text = '背景颜色'; $bg.SetBounds(210,60,160,32)
  $bg.Add_Click({
    $c = [System.Windows.Forms.ColorDialog]::new(); $c.FullOpen = $true; $c.Color = $script:stylePreview.BackColor
    if ($c.ShowDialog() -eq 'OK') { $script:styleDraft.bg_color = '#' + $c.Color.R.ToString('X2') + $c.Color.G.ToString('X2') + $c.Color.B.ToString('X2'); $script:stylePreview.BackColor = $c.Color }
    $c.Dispose()
  }); $d.Controls.Add($bg)
  $script:styleBackground = [System.Windows.Forms.CheckBox]::new(); $script:styleBackground.Text = '显示字幕背景'; $script:styleBackground.SetBounds(20,106,180,28); $script:styleBackground.Checked = $script:styleDraft.background; $d.Controls.Add($script:styleBackground)
  $alphaLabel = [System.Windows.Forms.Label]::new(); $alphaLabel.Text = '不透明度（%）'; $alphaLabel.SetBounds(20,150,120,24); $d.Controls.Add($alphaLabel)
  $script:styleOpacity = [System.Windows.Forms.NumericUpDown]::new(); $script:styleOpacity.SetBounds(140,146,95,28); $script:styleOpacity.Minimum = 20; $script:styleOpacity.Maximum = 100; $script:styleOpacity.Value = $script:styleDraft.opacity; $d.Controls.Add($script:styleOpacity)
  $apply = [System.Windows.Forms.Button]::new(); $apply.Text = '应用并保存'; $apply.SetBounds(210,290,160,32)
  $apply.Add_Click({
    try {
      $script:styleDraft.font_size = [int]$script:styleFontSize.Value
      $script:styleDraft.background = $script:styleBackground.Checked
      $script:styleDraft.opacity = [int]$script:styleOpacity.Value
      $updated = Invoke-Api 'set_caption_style' @{ style = $script:styleDraft }
      Apply-CaptionStyle $updated; Show-CaptionCue $script:captionDisplayText
      $script:styleDialog.Close()
    } catch { $null = [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, '保存样式失败') }
  }); $d.Controls.Add($apply)
  $cancel = [System.Windows.Forms.Button]::new(); $cancel.Text = '取消'; $cancel.SetBounds(20,290,100,32); $cancel.Add_Click({ $script:styleDialog.Close() }); $d.Controls.Add($cancel)
  $null = $d.ShowDialog(); $script:stylePreview.Font.Dispose(); $d.Dispose()
}

$caption.ContextMenuStrip = [System.Windows.Forms.ContextMenuStrip]::new()
$historyItem=$caption.ContextMenuStrip.Items.Add('回看完整转录')
$historyItem.Add_Click({ try { if ($script:captionSessionId) { $null=Invoke-Api 'request_caption_review' @{session_id=$script:captionSessionId};Open-Main } } catch { Show-BubbleError $_.Exception.Message } })

# Parse a hex colour like '#RRGGBB' into a System.Drawing.Color.
function Convert-HexColor([string]$hex, $fallback) {
  if (-not $hex) { return $fallback }
  $h = $hex.TrimStart('#')
  if ($h.Length -ne 6) { return $fallback }
  try {
    return [System.Drawing.Color]::FromArgb(255,
      [int]::Parse($h.Substring(0, 2), [System.Globalization.NumberStyles]::HexNumber),
      [int]::Parse($h.Substring(2, 2), [System.Globalization.NumberStyles]::HexNumber),
      [int]::Parse($h.Substring(4, 2), [System.Globalization.NumberStyles]::HexNumber))
  } catch { return $fallback }
}

function Apply-CaptionStyle($style) {
  if (-not $style) { return }
  $styleKey = $style | ConvertTo-Json -Compress
  if ($styleKey -eq $script:captionStyleKey) { return }
  $script:captionStyleKey = $styleKey
  $script:captionStyle = @{
    font_size  = [int]$(if ($null -ne $style.font_size) { $style.font_size } else { $script:captionStyle.font_size })
    font_color = [string]$(if ($null -ne $style.font_color) { $style.font_color } else { $script:captionStyle.font_color })
    background = [bool]$(if ($null -ne $style.background) { $style.background } else { $script:captionStyle.background })
    bg_color   = [string]$(if ($null -ne $style.bg_color) { $style.bg_color } else { $script:captionStyle.bg_color })
    opacity    = [int]$(if ($null -ne $style.opacity) { $style.opacity } else { $script:captionStyle.opacity })
    visible    = [bool]$(if ($null -ne $style.visible) { $style.visible } else { $script:captionStyle.visible })
  }
  # Rebuild the caption font (size is user-adjustable).
  try {
    if ($script:captionFont) { $script:captionFont.Dispose() }
    $script:captionFont = [System.Drawing.Font]::new('Microsoft YaHei', [float]$script:captionStyle.font_size, [System.Drawing.FontStyle]::Bold)
  } catch { }
  $script:captionFg = Convert-HexColor $script:captionStyle.font_color ([System.Drawing.Color]::White)
  # Background colour + opacity: bar BackColor is opaque, so we paint the
  # rounded rect ourselves with the alpha from opacity (0-100 -> 0-255).
  $base = Convert-HexColor $script:captionStyle.bg_color ([System.Drawing.Color]::FromArgb(60, 60, 60))
  $a = [int]([Math]::Min(255, [Math]::Max(0, $script:captionStyle.opacity)) * 2.55)
  $script:captionBg = $base
  $script:caption.BackColor = [System.Drawing.Color]::Magenta
  $script:caption.TransparencyKey = [System.Drawing.Color]::Magenta
  $script:caption.Opacity = if ($script:captionStyle.background) { [double]$script:captionStyle.opacity / 100.0 } else { 1.0 }
  $script:caption.Invalidate()
}

function Show-CaptionCue([string]$text, [string]$previous, [switch]$HoldSize) {
  $area = [System.Windows.Forms.Screen]::FromControl($script:caption).WorkingArea
  $minWidth = if ($HoldSize) { $script:caption.Width } else { 160 }
  if ($previous) {
    $prior = Get-CaptionLayout $previous $script:captionStyle.font_size $area.Width $area.Height -LatestOnly -SingleLine
    $minWidth = [Math]::Max($minWidth, $prior.width)
  }
  $layout = Get-CaptionLayout $text $script:captionStyle.font_size $area.Width $area.Height -LatestOnly -SingleLine:([bool]$previous) -MinWidth $minWidth
  # Live display follows the newest page. Complete text remains in transcript history.
  $page = $layout.pages[$layout.pages.Length - 1]
  $script:captionDisplayText = [string]$page.text
  $height = $page.height
  if ($previous) {
    $script:captionDisplayText = $prior.pages[0].text + "`n" + $script:captionDisplayText
    $height += $prior.pages[0].height - 24
  }
  if ($script:captionFont.Size -ne $layout.font_size) {
    $script:captionFont.Dispose()
    $script:captionFont = [System.Drawing.Font]::new('Microsoft YaHei', $layout.font_size, [System.Drawing.FontStyle]::Bold)
  }
  if ($HoldSize) { $height = [Math]::Max($height, $script:caption.Height) }
  $bottom = [Math]::Min($script:caption.Bottom, $area.Bottom - 14)
  $center = $script:caption.Left + $script:caption.Width / 2
  $script:caption.Size = [System.Drawing.Size]::new($layout.width, $height)
  $x = [int][Math]::Max($area.Left + 8, [Math]::Min($center - $layout.width / 2, $area.Right - $layout.width - 8))
  $y = [int][Math]::Max($area.Top + 8, $bottom - $height)
  $script:caption.Location = [System.Drawing.Point]::new($x, $y)
  $script:caption.Invalidate()
  Write-Json @{ event = 'caption-layout'; width = $layout.width; height = $height; chars = $script:captionDisplayText.Length; previous_line = [bool]$previous; pending_pages = 0 }
}

function Update-Caption {
  try {
    $st = Invoke-Api 'caption_live' @{}
    if (-not $st) { return }
    if ($script:captionPaintReport) {
      $report = $script:captionPaintReport
      $script:captionPaintReport = $null
      $null = Invoke-Api 'caption_painted' $report
    }
    $active = [bool]($st.active -or $st.starting)
    $oldStyle = $script:captionStyleKey
    if ($null -ne $st.style) { Apply-CaptionStyle $st.style }
    $newSession = ($script:captionSessionId -ne $st.session_id)
    if ($newSession) { $script:captionSessionId=$st.session_id; $script:captionLastId=-1; $script:captionPaintSeq=-1 }
    $script:captionActive=[bool]$st.active -and -not $st.starting
    $script:captionTimer.Interval = if ($active) { 90 } else { 240 }
    $wantVisible=$active -and $script:captionStyle.visible
    if ($wantVisible -and -not $caption.Visible) { $caption.Show();Set-ExcludeFromCapture $caption.Handle;Enable-Shadow $caption }
    elseif (-not $wantVisible -and $caption.Visible) { $caption.Hide() }
    $mode = if ($st.stopping) { 'stopping' } elseif ($st.starting) { 'starting' } elseif ($st.waiting_for_sound) { 'silent' } else { 'listening' }
    if ($active -and ($newSession -or [long]$st.event_seq -ne $script:captionLastId -or $oldStyle -ne $script:captionStyleKey -or $script:captionMode -ne $mode)) {
      $script:captionMode = $mode
      $script:captionLastId=[long]$st.event_seq;$script:captionReceivedAt=$st.received_at
      $script:captionHasText = [bool]$st.display_text -and -not $st.stopping
      $text = if ($st.stopping) { '正在收尾…' } elseif ($script:captionHasText) { [string]$st.display_text } elseif ($st.starting) { '正在准备识别…' } elseif ($st.waiting_for_sound) { '未检测到声音，请检查音源' } else { '正在听…' }
      $previous = if ($st.current -and $st.recent -and -not $st.stopping) { [string]($st.recent | Select-Object -Last 1).text } else { '' }
      if ($text -cne $script:captionLiveText -or $previous -cne $script:captionPreviousText -or $oldStyle -ne $script:captionStyleKey -or $newSession) {
        $script:captionLiveText = $text
        $script:captionPreviousText = $previous
        Show-CaptionCue $text $previous -HoldSize:(-not $newSession -and $oldStyle -eq $script:captionStyleKey)
        $script:captionShrinkAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 550
      }
      Write-Json @{event='caption-live';seq=$st.event_seq;session_id=$st.session_id;received_at=$st.received_at;paint_at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
    } elseif ($active -and $script:captionShrinkAt -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $script:captionShrinkAt) {
      $script:captionShrinkAt = 0
      Show-CaptionCue $script:captionLiveText $script:captionPreviousText
    }
  } catch { Write-Json @{event='caption-layout-error';message=$_.Exception.Message} }
}

# ---------------- tray ----------------
$script:tray = [System.Windows.Forms.NotifyIcon]::new()
$iconFile = if ($IconPath -and (Test-Path $IconPath)) { $IconPath } else { (Join-Path $PSScriptRoot 'icon.ico') }
if (Test-Path $iconFile) {
  try { $script:tray.Icon = [System.Drawing.Icon]::new($iconFile) } catch { $script:tray.Icon = [System.Drawing.SystemIcons]::Application }
} else {
  $script:tray.Icon = [System.Drawing.SystemIcons]::Application
}
$script:tray.Text = '屏幕笔记 · 双击打开主页面'
$script:tray.Visible = $true
$script:tray.Add_DoubleClick({ Open-Main })

$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$miOpen = [System.Windows.Forms.ToolStripMenuItem]::new('打开主页面')
$miOpen.Add_Click({ Open-Main })
$null = $menu.Items.Add($miOpen)
$miCapture = [System.Windows.Forms.ToolStripMenuItem]::new('立即记录')
$miCapture.Add_Click({ Start-Capture })
$null = $menu.Items.Add($miCapture)
$miMini = [System.Windows.Forms.ToolStripMenuItem]::new('显示 / 隐藏悬浮窗')
$miMini.Add_Click({
  if ($mini.Visible) { $mini.Hide(); Hide-Bubble $false }
  else { $mini.Show(); Set-ExcludeFromCapture $mini.Handle }
})
$null = $menu.Items.Add($miMini)
# 字幕模式：启动系统声音回环 + ASR，屏幕底部显示实时字幕条。
$miCaption = [System.Windows.Forms.ToolStripMenuItem]::new('开始字幕（语音转文字）')
$miCaption.Add_Click({
  try {
    $r = Invoke-Api 'start_caption' @{ provider = 'OpenAiCompatibleASR';  }
    Write-Json @{ event = 'caption-started'; session_id = $r.session_id; audio_ok = $r.audio_ok; asr_ready = $r.asr_ready }
  } catch { Write-Json @{ event = 'caption-error'; message = $_.Exception.Message } }
})
$null = $menu.Items.Add($miCaption)
$miCaptionStop = [System.Windows.Forms.ToolStripMenuItem]::new('停止字幕')
$miCaptionStop.Add_Click({
  Stop-CaptionAndReview
})
$null = $menu.Items.Add($miCaptionStop)
$miStyle = [System.Windows.Forms.ToolStripMenuItem]::new('字幕字号与颜色…')
$miStyle.Add_Click({ Open-CaptionStyle })
$null = $menu.Items.Add($miStyle)
$null = $menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
$miQuit = [System.Windows.Forms.ToolStripMenuItem]::new('退出屏幕笔记')
$miQuit.Add_Click({ if ($script:captionActive) { Stop-CaptionAndReview }; $script:ctx.ExitThread() })
$null = $menu.Items.Add($miQuit)
$script:tray.ContextMenuStrip = $menu

# ---------------- polling ----------------
# Keep the poll synchronous and short: nesting a second message pump inside the
# capture_process pump deadlocks HttpClient's continuations. The dots stay
# smooth thanks to double buffering + partial invalidation instead.
$script:timer = [System.Windows.Forms.Timer]::new()
$script:timer.Interval = 500
$script:pollBusy = $false
$script:timer.Add_Tick({
  if ($script:pollBusy) { return }
  $script:pollBusy = $true
  try {
    $res = Invoke-Api 'shell_poll'
    $script:pollFailures = 0
    if ($res) {
      if ($null -ne $res.state) {
        $st = $res.state
        $script:scope = [string]$st.scope
        $script:auto = [bool]$st.auto_enabled
        $script:busy = [bool]$st.busy
        Set-StateText ([string]$st.message)
        if ($null -ne $st.always_on_top) {
          $want = [bool]$st.always_on_top
          if ($want -ne $script:alwaysOnTop) {
            $script:alwaysOnTop = $want
            Apply-TopMost
          }
        }
        Update-Mini
      }
      if ($res.commands -or $res.state.companion) {
        $batchNote = $res.state.companion
        $batchProc = $false
        foreach ($c in @($res.commands)) {
          if ($c.type -eq 'capture') { Start-Capture ([string]$c.scope) }
          elseif ($c.type -eq 'pick_reading_region') { Select-ReadingRegion }
          elseif ($c.type -eq 'highlight_reading_region') { Highlight-ReadingRegion $c.rect }
          elseif ($c.type -eq 'open_main') { Open-Main }
          elseif ($c.type -eq 'auto_processing') { $batchProc = $true }
          elseif ($c.type -eq 'auto_note') { $batchNote = $c }
        }
        # Auto captures run entirely on the Node side, so they need the same
        # bubble as manual ones. Same-page skips emit nothing at all, and a
        # seq guard prevents the bubble from re-showing the same note.
        if (-not $script:captureBusy) {
          if ($batchNote) {
            if ([int]$batchNote.seq -gt $script:lastAutoSeq) {
              $script:lastAutoSeq = [int]$batchNote.seq
              $signature = (([string]$batchNote.title) + '|' + ([string]$batchNote.summary)) -replace '\s+', ''
              if ($signature -cne $script:lastAutoSignature) {
                $script:lastAutoSignature = $signature
                Show-BubbleDone ([string]$batchNote.title) ([string]$batchNote.summary) 'companion' ([string]$batchNote.id)
                Write-Json @{ event = 'auto-bubble'; seq = $script:lastAutoSeq }
              }
            }
          }
        }
      }
      # Caption bar: poll the caption session (cheap, no DB read) and refresh
      # the subtitle overlay. This is independent of the mini-panel state.
      try { Set-MiniDisplayScale ([SNNative]::GetDpiForWindow($mini.Handle)/96.0) } catch { }
      $displayKey = ([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $_.Bounds.ToString() + $_.WorkingArea.ToString() }) -join ';'
      if ($displayKey -ne $script:lastDisplayKey) { $script:lastDisplayKey=$displayKey; $script:vs=[System.Windows.Forms.SystemInformation]::VirtualScreen; Repair-WindowPositions; if ($script:captionActive) { Show-CaptionCue $script:captionLiveText $script:captionPreviousText } }
      $script:smokeOk = $true
    }
  } catch {
    $script:pollFailures++
    Write-Json @{ event = 'poll-error'; message = $_.Exception.Message }
    # If the core is gone, do not leave an orphan floating panel on the desktop.
    if ($script:pollFailures -ge 8 -and $script:ctx) { $script:ctx.ExitThread() }
  } finally {
    $script:pollBusy = $false
  }
})

$script:captionTimer = [System.Windows.Forms.Timer]::new()
$script:captionTimer.Interval = 240
$script:captionTimer.Add_Tick({
  if ($script:captionPollBusy) { return }
  $script:captionPollBusy=$true
  try { Update-Caption } finally { $script:captionPollBusy=$false }
})

# Render the real native controls for visual QA without starting timers or calling APIs.
if ($PreviewPath) {
  Set-MiniDisplayScale $PreviewScale
  $script:auto = $true
  $script:captionActive = $true
  Update-Mini
  Set-RoundRegion $mini $mini.Width $mini.Height 14
  $mini.Show()
  [System.Windows.Forms.Application]::DoEvents()
  $mini.Refresh()
  $bitmap = [System.Drawing.Bitmap]::new($mini.Width, $mini.Height)
  $mini.DrawToBitmap($bitmap, [System.Drawing.Rectangle]::new(0,0,$mini.Width,$mini.Height))
  $bitmap.Save($PreviewPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose(); $script:tray.Dispose(); $mini.Dispose(); $bubble.Dispose(); $caption.Dispose()
  Write-Json @{ event = 'preview-saved'; path = $PreviewPath }
  exit 0
}

# Restore the persisted "always on top" preference. The panel deliberately
# starts EMPTY: no digest of a previous capture is shown until a new one runs.
try {
  $initState = Invoke-Api 'get_shell_state'
  if ($null -ne $initState.always_on_top) { $script:alwaysOnTop = [bool]$initState.always_on_top }
} catch { }
Apply-TopMost
Update-Mini
try { Set-MiniDisplayScale ([SNNative]::GetDpiForWindow($mini.Handle)/96.0) } catch { Set-MiniDisplayScale 1.0 }

Set-RoundRegion $mini $mini.Width $mini.Height 14
Enable-DoubleBuffer $mini
$mini.Show()
Set-ExcludeFromCapture $mini.Handle
Enable-Shadow $mini
$script:ctx = [System.Windows.Forms.ApplicationContext]::new()
$script:ctx.MainForm = $mini

if ($Smoke) {
  $smokeTimer = [System.Windows.Forms.Timer]::new()
  $smokeTimer.Interval = 1600
  $smokeTimer.Add_Tick({
    $smokeTimer.Stop()
    Write-Json @{ event = 'smoke'; ok = $script:smokeOk; port = $Port; mini_visible = $mini.Visible }
    $script:ctx.ExitThread()
  })
  $smokeTimer.Start()
}

$script:timer.Start()
$script:captionTimer.Start()
Write-Json @{ event = 'shell-ready'; topmost = $script:alwaysOnTop; scope = $script:scope; brief_hidden = $true; bubble_enabled = $true; http_pump = $script:httpPumpAvailable; auto_bubble = $true; icon_only_logo = $true; pin_icon = $true; compact = $true; panel_size = "$($mini.Width)x$($mini.Height)"; double_buffered = $true; caption_button = $true; caption_bar = $true; style_brush = $true; companion_mode = $true; feedback_items = $script:feedbackMenu.Items.Count; reading_region = $true }
[System.Windows.Forms.Application]::Run($script:ctx)
$script:timer.Stop()
$script:captionTimer.Stop()
$script:captionTimer.Dispose()
$script:dotTimer.Stop()
$script:tray.Visible = $false
$script:tray.Dispose()
$script:bubble.Dispose()
try { $script:caption.Dispose() } catch { }
try { if ($script:captionFont) { $script:captionFont.Dispose() } } catch { }
$mini.Dispose()
Write-Json @{ event = 'shell-exit' }
