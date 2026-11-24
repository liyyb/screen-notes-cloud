# Native small-control icon, kept in the same 1.6 px stroke family as the pin.
function Draw-CaptionBrushIcon($Graphics, $Bounds, $Color, [bool]$Pressed = $false) {
  $state = $Graphics.Save()
  $pen = [System.Drawing.Pen]::new($Color, 1.6)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $handle = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $tip = [System.Drawing.Drawing2D.GraphicsPath]::new()
  try {
    $Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $dx = [float](($Bounds.Width - 28) / 2)
    $dy = [float](($Bounds.Height - 28) / 2)
    if ($Pressed) { $dy += 0.6 }
    $Graphics.TranslateTransform($dx, $dy)
    # A single clean nib silhouette avoids the linked-ring appearance at 16 px.
    $handle.AddLine([float]7,[float]17,[float]17,[float]7)
    $handle.AddLine([float]17,[float]7,[float]20,[float]10)
    $handle.AddLine([float]20,[float]10,[float]10,[float]20)
    $handle.AddLine([float]10,[float]20,[float]6,[float]21)
    $handle.CloseFigure()
    $Graphics.DrawPath($pen, $handle)
    $Graphics.DrawLine($pen,[float]7,[float]17,[float]10,[float]20)
    $tip.AddLine([float]17,[float]7,[float]18.5,[float]5.5)
    $tip.AddLine([float]18.5,[float]5.5,[float]21.5,[float]8.5)
    $tip.AddLine([float]21.5,[float]8.5,[float]20,[float]10)
    $Graphics.DrawPath($pen, $tip)
  } finally {
    $handle.Dispose(); $tip.Dispose(); $pen.Dispose(); $Graphics.Restore($state)
  }
}
