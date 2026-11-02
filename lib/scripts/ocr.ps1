# Offline OCR bridge for dsh-screenshot.
#
# Windows has no OCR API reachable from plain Node, but Windows.Media.Ocr is
# available through the WinRT projection that ships with PowerShell 5.1. This
# script is deliberately ASCII-only: PowerShell 5.1 reads BOM-less files as
# ANSI, so any non-ASCII literal here would be corrupted. All real text travels
# through files (the image in, UTF-8 JSON out), never through the console.
param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [int]$Scale = 1
)

$ErrorActionPreference = 'Stop'
# JSON must be BOM-free: a leading BOM is not valid JSON for JSON.parse.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type -AssemblyName System.Drawing
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]

  # WinRT exposes only IAsyncOperation; adapt it to a Task and wait on it.
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

  function Await($operation, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

  # Small selections are upscaled before recognition: screen text is often
  # 12-14 px, where the engine starts confusing l/I and losing CJK strokes.
  if ($Scale -gt 1) {
    $source = [System.Drawing.Image]::FromFile($ImagePath)
    $scaledPath = $ImagePath + '.scaled.png'
    $width = [int]($source.Width * $Scale)
    $height = [int]($source.Height * $Scale)
    if ($width -le [Windows.Media.Ocr.OcrEngine]::MaxImageDimension -and $height -le [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) {
      $scaled = New-Object System.Drawing.Bitmap($width, $height)
      $graphics = [System.Drawing.Graphics]::FromImage($scaled)
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($source, 0, 0, $width, $height)
      $graphics.Dispose()
      $scaled.Save($scaledPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $scaled.Dispose()
      $source.Dispose()
      $ImagePath = $scaledPath
    } else {
      $source.Dispose()
    }
  }

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) {
    $languages = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
    if ($null -ne $languages -and $languages.Count -gt 0) {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($languages[0])
    }
  }
  if ($null -eq $engine) {
    $failure = [ordered]@{ ok = $false; error = 'no-ocr-language' ; lines = @() }
    [System.IO.File]::WriteAllText($OutputPath, ($failure | ConvertTo-Json -Depth 3), $utf8NoBom)
    exit 0
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync(0)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $software = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($software)) ([Windows.Media.Ocr.OcrResult])
  $software.Dispose()
  $stream.Dispose()

  $lines = @($result.Lines | ForEach-Object { $_.Text })
  $payload = [ordered]@{
    ok = $true
    language = $engine.RecognizerLanguage.LanguageTag
    scale = $Scale
    lines = $lines
    text = ($lines -join "`n")
  }
  [System.IO.File]::WriteAllText($OutputPath, ($payload | ConvertTo-Json -Depth 4), $utf8NoBom)
  Write-Output 'ok'
} catch {
  $payload = [ordered]@{
    ok = $false
    error = ($_.Exception.Message)
    lines = @()
  }
  try {
    [System.IO.File]::WriteAllText($OutputPath, ($payload | ConvertTo-Json -Depth 3), $utf8NoBom)
  } catch {
    Write-Output ('ocr failed: ' + $_.Exception.Message)
  }
  exit 0
}
