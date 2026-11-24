# Pure geometry used by the live shell and tests; coordinates may be negative.
function Get-VisibleWindowBounds($rect, $area) {
  $w = [Math]::Min($rect.Width, $area.Width)
  $h = [Math]::Min($rect.Height, $area.Height)
  $x = [Math]::Max($area.Left, [Math]::Min($rect.Left, $area.Right - $w))
  $y = [Math]::Max($area.Top, [Math]::Min($rect.Top, $area.Bottom - $h))
  return [System.Drawing.Rectangle]::new([int]$x,[int]$y,[int]$w,[int]$h)
}

function Set-MiniDisplayScale([float]$factor) {
  $factor = [Math]::Max(1.0, [Math]::Min(3.0, $factor))
  if (-not $script:mini -or $script:miniScale -eq $factor) { return }
  if (-not $script:miniControlBounds) {
    $script:miniControlBounds = @{}
    foreach ($control in $script:mini.Controls) { $script:miniControlBounds[$control] = $control.Bounds }
  }
  $script:mini.SuspendLayout()
  $script:miniScale = $factor
  $script:mini.Size = [System.Drawing.Size]::new([int](348*$factor),[int](82*$factor))
  foreach ($control in $script:mini.Controls) {
    $r = $script:miniControlBounds[$control]
    $control.SetBounds([int]($r.X*$factor),[int]($r.Y*$factor),[int]($r.Width*$factor),[int]($r.Height*$factor))
    if ($control -is [System.Windows.Forms.Button]) { Set-RoundRegion $control $control.Width $control.Height ([int](9*$factor)) }
  }
  Set-RoundRegion $script:mini $script:mini.Width $script:mini.Height ([int](14*$factor))
  $script:mini.ResumeLayout(); $script:mini.Invalidate()
}
