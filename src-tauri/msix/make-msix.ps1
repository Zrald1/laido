# Build + sign a Microsoft Store / sideload MSIX package for Laido.
# Usage:  powershell -File make-msix.ps1 [-Version 0.0.5.0] [-Thumbprint <sha1>]
param(
  [string]$Version    = "0.0.5.0",
  # cert whose CN equals the manifest Publisher (Partner Center identity)
  [string]$Thumbprint = "0D21BEC2A6177E590904D0E4E7203E9DF0735284",
  [string]$AppExe     = "$PSScriptRoot\..\target\release\laido.exe",
  [string]$Icons      = "$PSScriptRoot\..\icons",
  [string]$OutDir     = "$PSScriptRoot\..\target\release\bundle\msix"
)
$ErrorActionPreference = "Stop"

$makeappx = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter makeappx.exe |
            Where-Object { $_.FullName -like "*\x64\*" } | Sort-Object FullName -Descending |
            Select-Object -First 1 -ExpandProperty FullName
$signtool = $makeappx -replace "makeappx\.exe$", "signtool.exe"
if (-not $makeappx -or -not (Test-Path $signtool)) { throw "Windows SDK tools not found" }

$layout = "$PSScriptRoot\..\target\msix-layout"
if (Test-Path $layout) { Remove-Item $layout -Recurse -Force }
New-Item -ItemType Directory -Force "$layout\Assets" | Out-Null
New-Item -ItemType Directory -Force $OutDir | Out-Null

Copy-Item $AppExe "$layout\laido.exe"
# third-party notices ship inside the package (Apache-2.0/MIT redistribution terms)
Copy-Item "$PSScriptRoot\..\..\THIRD_PARTY_LICENSES.md" "$layout\THIRD_PARTY_LICENSES.md"
foreach ($a in "StoreLogo.png","Square44x44Logo.png","Square150x150Logo.png",
               "Square310x310Logo.png","Wide310x150Logo.png") {
  Copy-Item "$Icons\$a" "$layout\Assets\$a"
}
(Get-Content "$PSScriptRoot\AppxManifest.xml") -replace '0\.0\.0\.0', $Version |
  Set-Content "$layout\AppxManifest.xml" -Encoding UTF8

$out = "$OutDir\Laido_$Version.msix"
& $makeappx pack /d $layout /p $out /o /v
if ($LASTEXITCODE) { throw "makeappx failed ($LASTEXITCODE)" }
& $signtool sign /fd sha256 /td sha256 /tr http://timestamp.digicert.com /sha1 $Thumbprint $out
if ($LASTEXITCODE) { throw "signtool failed ($LASTEXITCODE)" }
Write-Output "`nMSIX: $out"
