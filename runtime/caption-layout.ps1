# Shared GDI measurement used by the live subtitle bar and its render checks.
function Get-CaptionLayout([string]$Text, [int]$FontSize, [int]$ScreenWidth, [int]$ScreenHeight, [switch]$LatestOnly, [switch]$SingleLine, [int]$MinWidth = 160) {
  $width = [int][Math]::Max(120, [Math]::Min(1040, $ScreenWidth - 32))
  $maxHeight = [int][Math]::Max(60, [Math]::Min(300, $ScreenHeight * 0.32))
  $bitmap = [System.Drawing.Bitmap]::new(1, 1)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $font = $null
  $sf = [System.Drawing.StringFormat]::new()
  $sf.Trimming = [System.Drawing.StringTrimming]::None
  $sf.FormatFlags = [System.Drawing.StringFormatFlags]::LineLimit
  try {
    $size = [Math]::Max(12, [Math]::Min(72, $FontSize))
    do {
      if ($font) { $font.Dispose() }
      $font = [System.Drawing.Font]::new('Microsoft YaHei', $size, [System.Drawing.FontStyle]::Bold)
      if ($font.GetHeight($g) -le ($maxHeight - 28) -or $size -le 12) { break }
      $size -= 1
    } while ($true)
    # Long cues may modestly reduce the preferred size before paging; short cues retain it.
    $minimum = [Math]::Min($size, [Math]::Max(18, [Math]::Min(32, [Math]::Floor($size * 0.8))))
    while (-not $SingleLine -and $size -gt $minimum -and $Text -and $g.MeasureString($Text, $font, ($width - 36), $sf).Height -gt ($maxHeight - 28)) {
      $font.Dispose(); $size -= 1
      $font = [System.Drawing.Font]::new('Microsoft YaHei', $size, [System.Drawing.FontStyle]::Bold)
    }
    $natural = $g.MeasureString($(if ($Text) { $Text } else { '字幕中…' }), $font).Width
    if ($SingleLine) {
      $lineHeight = $g.MeasureString('字幕', $font, ($width - 36), $sf).Height
      $maxHeight = [int][Math]::Ceiling($lineHeight + 28)
    }
    $width = [int][Math]::Min($width, [Math]::Max($MinWidth, [Math]::Ceiling($natural) + 36))
    $pages = [System.Collections.Generic.List[object]]::new()
    $remaining = $Text
    if (-not $remaining) { $remaining = '字幕中…' }
    while ($remaining.Length -gt 0) {
      $starts = [System.Globalization.StringInfo]::ParseCombiningCharacters($remaining)
      $lo = 1; $hi = $starts.Length; $fit = 1
      while ($lo -le $hi) {
        $mid = [int][Math]::Floor(($lo + $hi) / 2)
        $end = if ($mid -eq $starts.Length) { $remaining.Length } else { $starts[$mid] }
        $candidate = if ($LatestOnly) { $remaining.Substring($starts[$starts.Length - $mid]) } else { $remaining.Substring(0, $end) }
        $measured = $g.MeasureString($candidate, $font, ($width - 36), $sf)
        if ($measured.Height -le ($maxHeight - 28)) { $fit = $mid; $lo = $mid + 1 } else { $hi = $mid - 1 }
      }
      $count = if ($fit -eq $starts.Length) { $remaining.Length } else { $starts[$fit] }
      $pageText = $remaining.Substring(0, $count)
      if ($LatestOnly) {
        $pageText = $remaining.Substring($starts[$starts.Length - $fit])
        $count = $remaining.Length
      } elseif ($count -lt $remaining.Length) {
        $breaks = [regex]::Matches($pageText, '[，。！？；、,.!?;:\s]')
        if ($breaks.Count -gt 0 -and $breaks[$breaks.Count - 1].Index -ge $count * 0.65) {
          $count = $breaks[$breaks.Count - 1].Index + 1
          $pageText = $remaining.Substring(0, $count)
        }
      }
      $measured = $g.MeasureString($pageText, $font, ($width - 36), $sf)
      $height = [int][Math]::Min($maxHeight, [Math]::Max(60, [Math]::Ceiling($measured.Height) + 28))
      $pages.Add([pscustomobject]@{ text = $pageText; height = $height })
      $remaining = $remaining.Substring($count)
    }
    return [pscustomobject]@{ width = $width; font_size = $size; pages = $pages.ToArray() }
  } finally {
    if ($font) { $font.Dispose() }
    $sf.Dispose(); $g.Dispose(); $bitmap.Dispose()
  }
}
