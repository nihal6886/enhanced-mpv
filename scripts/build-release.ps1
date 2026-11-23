#Requires -Version 5.1
<#
.SYNOPSIS
  Enhanced MPV - Windows release build pipeline.

.DESCRIPTION
  Produces every artifact the Smart Web Installer needs:

    dist\enhanced-mpv-host.exe        native messaging host (pkg, node22-win-x64)
    dist\enhanced-mpv-extension.zip   unpacked Chromium extension (manifest.json at root)
    dist\enhanced-mpv-firefox.xpi     Firefox add-on (manifest.json at root)
    installer\staging\...             offline payload tree consumed by installer\setup.iss

  mpv and yt-dlp binaries are deliberately NOT bundled: the installer fetches
  them on demand so EnhancedMPV-Setup.exe stays small.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
#>
param(
  [string]$PkgTarget = "node22-win-x64",
  [string]$PkgPackage = "@yao-pkg/pkg",
  [switch]$SkipPkg,
  [switch]$SkipExtension
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Dist = Join-Path $Root "dist"
$Stage = Join-Path $Root "installer\staging"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step($Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Ensure-Dir($Path) { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
function Reset-Dir($Path) { if (Test-Path $Path) { Remove-Item $Path -Recurse -Force }; Ensure-Dir $Path }
function Copy-Tree($Source, $Destination, [string[]]$ExcludeNames = @()) {
  if (-not (Test-Path $Source -PathType Container)) { throw "Required source tree missing: $Source" }
  Ensure-Dir $Destination
  Get-ChildItem -LiteralPath $Source -Force | Where-Object { $_.Name -notin $ExcludeNames } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force }
}

# Chrome derives an unpacked extension's id from the SHA-256 of the DER(SPKI)
# public key in manifest.json's "key": the first 16 bytes mapped nibble -> a-p.
function Get-ExtensionId {
  $manifestPath = Join-Path $Root "browser-extension\manifest.json"
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  if (-not $manifest.key) { return $null }
  $der = [Convert]::FromBase64String($manifest.key)
  $sha = [System.Security.Cryptography.SHA256]::Create().ComputeHash($der)
  $alphabet = "abcdefghijklmnop"
  $sb = New-Object System.Text.StringBuilder
  for ($i = 0; $i -lt 16; $i++) {
    [void]$sb.Append($alphabet[($sha[$i] -shr 4)])
    [void]$sb.Append($alphabet[($sha[$i] -band 15)])
  }
  return $sb.ToString()
}

# --- prerequisites -----------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (Test-Path "C:\Program Files\nodejs") { $env:Path = "C:\Program Files\nodejs;" + $env:Path }
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required on PATH." }

Write-Step "Resetting dist\ and installer\staging\"
Reset-Dir $Dist
Reset-Dir $Stage

Write-Step "Generating release icons and wizard artwork"
& node (Join-Path $Root "scripts\generate-icons.js")
if ($LASTEXITCODE -ne 0) { throw "generate-icons.js failed" }

# 1. Browser extension --------------------------------------------------------
if (-not $SkipExtension) {
  Write-Step "Packaging browser extension"
  & node (Join-Path $Root "scripts\package-extension.js")
  if ($LASTEXITCODE -ne 0) { throw "package-extension.js failed" }
}

Copy-Tree (Join-Path $Root "browser-extension") (Join-Path $Stage "browser-extension")

Ensure-Dir (Join-Path $Stage "firefox")
$FirefoxXpi = Join-Path $Dist "enhanced-mpv-firefox.xpi"
if (Test-Path $FirefoxXpi) {
  Copy-Item $FirefoxXpi (Join-Path $Stage "firefox") -Force
} else {
  Write-Warning "dist\enhanced-mpv-firefox.xpi missing; run without -SkipExtension."
}

# 2. Native messaging host ----------------------------------------------------
if (-not $SkipPkg) {
  Write-Step "Compiling native host ($PkgTarget) with $PkgPackage"
  $out = Join-Path $Dist "enhanced-mpv-host.exe"
  $entry = Join-Path $Root "native-host\index.js"
  & npx --yes $PkgPackage $entry --targets $PkgTarget --compress GZip --output $out
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $out)) { throw "pkg compilation failed" }
}

Ensure-Dir (Join-Path $Stage "host")
$HostExe = Join-Path $Dist "enhanced-mpv-host.exe"
if (Test-Path $HostExe) {
  Copy-Item $HostExe (Join-Path $Stage "host") -Force
} else {
  throw "dist\enhanced-mpv-host.exe not found; run without -SkipPkg."
}

# 3. Complete mpv-config / dark-studio UI stack -------------------------------
Write-Step "Staging mpv-config"
$MpvStage = Join-Path $Stage "mpv-config"
Reset-Dir $MpvStage
Copy-Item (Join-Path $Root "mpv-config\*") $MpvStage -Recurse -Force
$MpvScripts = Join-Path $MpvStage "scripts"
Ensure-Dir $MpvScripts

# 3b. Player icon -------------------------------------------------------------
# Staged twice: at staging\assets for SetupIconFile and inside the mpv config
# tree so it deploys to {app}\mpv\enhanced-mpv.ico as the installed player icon.
Write-Step "Staging player icon"
Ensure-Dir (Join-Path $Stage "assets")
Copy-Item (Join-Path $Root "assets\enhanced-mpv.ico") (Join-Path $Stage "assets") -Force
Copy-Item (Join-Path $Root "assets\enhanced-mpv.ico") (Join-Path $MpvStage "enhanced-mpv.ico") -Force

foreach ($required in @(
    "mpv.conf", "input.conf", "script-opts\modernz.conf", "script-opts\thumbfast.conf",
    "fonts\modernz-icons.ttf", "scripts\window-icon.lua", "scripts\loading-screen.lua",
    "scripts\player-menus.lua", "scripts\stream-controller.lua", "scripts\dev-tools.lua",
    "scripts\modernz.lua", "scripts\thumbfast.lua", "scripts\sub-select.lua"
  )) {
  $path = Join-Path $MpvStage $required
  if (-not (Test-Path $path -PathType Leaf)) { throw "Required mpv UI asset missing from repository: $path" }
}

Copy-Tree (Join-Path $Root "native-host") (Join-Path $Stage "native-host") @("extension-key.pem")
Copy-Tree (Join-Path $Root "scripts") (Join-Path $Stage "scripts") @("extension-key.pem")
Copy-Tree (Join-Path $Root "installer\onboarding") (Join-Path $Stage "installer\onboarding")
Copy-Tree (Join-Path $Root "assets") (Join-Path $Stage "assets")
foreach ($asset in @("enhanced-mpv.ico", "wizard-banner.bmp", "wizard-small.bmp")) {
  if (-not (Test-Path (Join-Path $Stage "assets\$asset") -PathType Leaf)) {
    throw "Required installer artwork is missing: $asset"
  }
}
# 4. Onboarding page + Native Messaging templates -----------------------------
Write-Step "Staging onboarding page and Native Messaging templates"
Ensure-Dir (Join-Path $Stage "onboarding")
Copy-Item (Join-Path $Root "installer\onboarding\*") (Join-Path $Stage "onboarding") -Recurse -Force
Ensure-Dir (Join-Path $Stage "manifests")
Copy-Item (Join-Path $Root "native-host\manifests\*") (Join-Path $Stage "manifests") -Force
foreach ($temporary in @("stage-chrome", "stage-firefox")) {
  $temporaryPath = Join-Path $Dist $temporary
  if (Test-Path $temporaryPath) { Remove-Item $temporaryPath -Recurse -Force }
}

# 5. Stable extension id ------------------------------------------------------
$extId = Get-ExtensionId
if ($extId) {
  Write-Host "Extension id: $extId"
  [System.IO.File]::WriteAllText((Join-Path $Stage "extension-id.txt"), $extId, $Utf8NoBom)
} else {
  Write-Warning "browser-extension\manifest.json has no 'key'; extension id will be random."
}

# 6. Report -------------------------------------------------------------------
 $isccCommand = Get-Command iscc.exe -ErrorAction SilentlyContinue
if (-not $isccCommand) {
  $isccPaths = @(
    (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
    (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
  )
  $isccCommand = $isccPaths | Where-Object { Test-Path $_ -PathType Leaf } | Select-Object -First 1
}
if ($isccCommand) {
  Write-Step "Compiling installer\setup.iss"
  $iscc = if ($isccCommand -is [string]) { $isccCommand } else { $isccCommand.Source }
  & $iscc "/DExtId=$extId" (Join-Path $Root "installer\setup.iss")
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $Dist "EnhancedMPV-Setup.exe"))) {
    throw "Inno Setup compilation failed."
  }
} else {
  Write-Warning "Inno Setup is not installed; EnhancedMPV-Setup.exe was not compiled."
}

$sumLines = Get-ChildItem $Dist -File -Recurse | Where-Object { $_.Name -ne "SHA256SUMS.txt" } |
  Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($Dist.TrimEnd('\').Length + 1).Replace("\", "/")
    "{0} *{1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
  }
[System.IO.File]::WriteAllLines((Join-Path $Dist "SHA256SUMS.txt"), [string[]]$sumLines, $Utf8NoBom)

Write-Step "Artifacts in dist\"
Get-ChildItem $Dist -File | ForEach-Object { "{0,10:N0}  {1}" -f $_.Length, $_.Name }
$hostSize = if (Test-Path $HostExe) { (Get-Item $HostExe).Length } else { 0 }
if ($hostSize -gt 20MB) {
  Write-Warning "The compiled host is $([math]::Round($hostSize / 1MB, 1)) MB; Setup.exe may exceed the 20 MB budget."
}
Write-Host ""
Write-Host "Next: iscc /DExtId=`"$extId`" installer\setup.iss"
