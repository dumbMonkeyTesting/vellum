Add-Type -AssemblyName System.Drawing

$bg = [System.Drawing.Color]::FromArgb(255, 20, 14, 12)
$copper = [System.Drawing.Color]::FromArgb(255, 226, 91, 58)
$copper2 = [System.Drawing.Color]::FromArgb(255, 243, 179, 154)
$cream = [System.Drawing.Color]::FromArgb(255, 246, 238, 230)
$muted = [System.Drawing.Color]::FromArgb(255, 203, 181, 166)
$regular = [System.Drawing.FontStyle]::Regular
$pixel = [System.Drawing.GraphicsUnit]::Pixel

function New-Canvas($w, $h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear($bg)
  return @{ bmp = $bmp; g = $g }
}

function Draw-Grid($g, $w, $h, $step) {
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(28, 243, 179, 154), 1)
  for ($x = 0; $x -le $w; $x += $step) { $g.DrawLine($pen, $x, 0, $x, $h) }
  for ($y = 0; $y -le $h; $y += $step) { $g.DrawLine($pen, 0, $y, $w, $y) }
  $pen.Dispose()
}

function Draw-Glow($g, $cx, $cy, $rx, $ry) {
  $rect = New-Object System.Drawing.RectangleF ($cx - $rx), ($cy - $ry), ($rx * 2), ($ry * 2)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse($rect)
  $brush = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
  $brush.CenterColor = [System.Drawing.Color]::FromArgb(84, 226, 91, 58)
  $brush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 226, 91, 58))
  $g.FillEllipse($brush, $rect)
  $brush.Dispose()
  $path.Dispose()
}

function Draw-Mark($g, $x, $y, $size) {
  $scale = $size / 40.0
  $outer = @(
    @(20, 2.2), @(37.4, 14.6), @(31.6, 37.4), @(8.4, 37.4), @(2.6, 14.6)
  )
  $inner = @(
    @(26.2, 11.4), @(35.6, 19.2), @(31.6, 33.2), @(18.4, 33.2), @(15.2, 19.2)
  )
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.FillMode = [System.Drawing.Drawing2D.FillMode]::Alternate
  foreach ($ring in @($outer, $inner)) {
    $pts = New-Object System.Drawing.PointF[] 5
    for ($i = 0; $i -lt 5; $i++) {
      $px = [single]($x + $ring[$i][0] * $scale)
      $py = [single]($y + $ring[$i][1] * $scale)
      $pts[$i] = New-Object System.Drawing.PointF $px, $py
    }
    $path.AddPolygon($pts)
  }
  $brush = New-Object System.Drawing.SolidBrush $copper
  $g.FillPath($brush, $path)
  $brush.Dispose()
  $path.Dispose()
}

$serifName = "Palatino Linotype"
if (-not [System.Drawing.FontFamily]::Families.Name.Contains($serifName)) { $serifName = "Georgia" }
$serif = New-Object System.Drawing.FontFamily $serifName
$sans = New-Object System.Drawing.FontFamily "Segoe UI"

$banner = New-Canvas 1500 500
Draw-Grid $banner.g 1500 500 48
Draw-Glow $banner.g 430 250 300 240
Draw-Mark $banner.g 210 118 264

$name = New-Object System.Drawing.Font($serif, 108, $regular, $pixel)
$tagFont = New-Object System.Drawing.Font($serif, 34, $regular, $pixel)
$metaFont = New-Object System.Drawing.Font($sans, 18, $regular, $pixel)
$creamBrush = New-Object System.Drawing.SolidBrush $cream
$mutedBrush = New-Object System.Drawing.SolidBrush $muted
$copperBrush = New-Object System.Drawing.SolidBrush $copper
$format = [System.Drawing.StringFormat]::GenericTypographic.Clone()
$format.FormatFlags = $format.FormatFlags -bor [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces -bor [System.Drawing.StringFormatFlags]::NoClip
$textX = 548

$banner.g.DrawString("VELLUM", $name, $creamBrush, $textX, 132, $format)
$banner.g.FillRectangle($copperBrush, $textX, 268, 156, 3)
$banner.g.DrawString("Less guessing. More evidence.", $tagFont, $creamBrush, $textX, 286, $format)
$metaX = $textX
foreach ($part in @("READ-ONLY", "ON-CHAIN", "NOTHING TO SIGN")) {
  if ($metaX -gt $textX) {
    $banner.g.FillEllipse($copperBrush, ($metaX + 2), 352, 7, 7)
    $metaX += 22
  }
  $banner.g.DrawString($part, $metaFont, $mutedBrush, $metaX, 344, $format)
  $metaX += [int]$banner.g.MeasureString($part, $metaFont, 1000, $format).Width + 14
}

$banner.g.Dispose()
$banner.bmp.Save("$PSScriptRoot\vellum-x-banner.png", [System.Drawing.Imaging.ImageFormat]::Png)
$banner.bmp.Dispose()

$avatar = New-Canvas 400 400
Draw-Grid $avatar.g 400 400 28
Draw-Glow $avatar.g 200 198 160 160
Draw-Mark $avatar.g 78 70 244
$avatar.g.Dispose()
$avatar.bmp.Save("$PSScriptRoot\vellum-x-avatar.png", [System.Drawing.Imaging.ImageFormat]::Png)
$avatar.bmp.Dispose()

Write-Output "rendered $serifName"
