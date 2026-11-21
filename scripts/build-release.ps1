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
  [switch]$SkipExtension,
  [switch]$SkipLua
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Dist = Join-Path $Root "dist"
$Stage = Join-Path $Root "installer\staging"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$ModernZLuaUrl = "https://github.com/Samillion/ModernZ/releases/latest/download/modernz.lua"
$ModernZFontUrl = "https://github.com/Samillion/ModernZ/releases/latest/download/modernz-icons.ttf"
$ThumbfastUrl = "https://github.com/po5/thumbfast/archive/refs/heads/master.zip"
$SubSelectUrl = "https://github.com/CogentRedTester/mpv-sub-select/archive/refs/heads/master.zip"

function Write-Step($Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Ensure-Dir($Path) { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
function Reset-Dir($Path) { if (Test-Path $Path) { Remove-Item $Path -Recurse -Force }; Ensure-Dir $Path }

function Download-File($Url, $Destination) {
  Ensure-Dir (Split-Path -Parent $Destination)
  $tmp = "$Destination.part"
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 -Uri $Url -OutFile $tmp
    Move-Item -Force $tmp $Destination
    return $true
  } catch {
    Write-Warning "Download failed: $Url ($($_.Exception.Message))"
    if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    return $false
  }
}

function Expand-ZipTo($Zip, $Destination) {
  Reset-Dir $Destination
  Expand-Archive -Path $Zip -DestinationPath $Destination -Force
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

# 1. Browser extension --------------------------------------------------------
if (-not $SkipExtension) {
  Write-Step "Packaging browser extension"
  & node (Join-Path $Root "scripts\package-extension.js")
  if ($LASTEXITCODE -ne 0) { throw "package-extension.js failed" }
}

Ensure-Dir (Join-Path $Stage "extension")
Copy-Item (Join-Path $Root "browser-extension\*") (Join-Path $Stage "extension") -Recurse -Force

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

# 3. mpv-config + lightweight Lua UI scripts ----------------------------------
Write-Step "Staging mpv-config"
$MpvStage = Join-Path $Stage "mpv-config"
Reset-Dir $MpvStage
Copy-Item (Join-Path $Root "mpv-config\*") $MpvStage -Recurse -Force
$MpvScripts = Join-Path $MpvStage "scripts"
Ensure-Dir $MpvScripts
foreach ($legacy in @(
    (Join-Path $MpvStage "mpvnet.conf"),
    (Join-Path $MpvStage "script-opts\uosc.conf")
  )) {
  if (Test-Path $legacy) { Remove-Item $legacy -Force }
}

# 3b. Player icon -------------------------------------------------------------
# Staged twice: at staging\assets for SetupIconFile and inside the mpv config
# tree so it deploys to {app}\mpv\enhanced-mpv.ico as the installed player icon.
Write-Step "Staging player icon"
Ensure-Dir (Join-Path $Stage "assets")
Copy-Item (Join-Path $Root "assets\enhanced-mpv.ico") (Join-Path $Stage "assets") -Force
Copy-Item (Join-Path $Root "assets\enhanced-mpv.ico") (Join-Path $MpvStage "enhanced-mpv.ico") -Force

if (-not $SkipLua) {
  Write-Step "Bundling ModernZ / thumbfast / mpv-sub-select offline"
  $tmp = Join-Path $env:TEMP ("empv-build-" + [guid]::NewGuid().ToString("N"))
  Ensure-Dir $tmp
  try {
    # ModernZ assets are version-tracked upstream as individual release files.
    $modernZFonts = Join-Path $MpvStage "fonts"
    Ensure-Dir $modernZFonts
    if (-not (Download-File $ModernZLuaUrl (Join-Path $MpvScripts "modernz.lua"))) {
      throw "Could not download the latest ModernZ Lua release."
    }
    if (-not (Download-File $ModernZFontUrl (Join-Path $modernZFonts "modernz-icons.ttf"))) {
      throw "Could not download the ModernZ icon font."
    }

    # thumbfast
    $thZip = Join-Path $tmp "thumbfast.zip"
    $thOut = Join-Path $tmp "thumbfast"
    if (Download-File $ThumbfastUrl $thZip) {
      Expand-ZipTo $thZip $thOut
      $lua = Get-ChildItem $thOut -Recurse -Filter "thumbfast.lua" -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($lua) { Copy-Item $lua.FullName (Join-Path $MpvScripts "thumbfast.lua") -Force }
    }

    # mpv-sub-select
    $ssZip = Join-Path $tmp "subselect.zip"
    $ssOut = Join-Path $tmp "subselect"
    if (Download-File $SubSelectUrl $ssZip) {
      Expand-ZipTo $ssZip $ssOut
      $lua = Get-ChildItem $ssOut -Recurse -Filter "sub-select.lua" -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $lua) {
        $lua = Get-ChildItem $ssOut -Recurse -Filter "*.lua" -ErrorAction SilentlyContinue |
          Where-Object { $_.Directory.Name -notlike "*scripts*" } | Select-Object -First 1
      }
      if ($lua) { Copy-Item $lua.FullName (Join-Path $MpvScripts "sub-select.lua") -Force }
    }
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# 4. Onboarding page + Native Messaging templates -----------------------------
Write-Step "Staging onboarding page and Native Messaging templates"
Ensure-Dir (Join-Path $Stage "onboarding")
Copy-Item (Join-Path $Root "installer\onboarding\*") (Join-Path $Stage "onboarding") -Recurse -Force
Ensure-Dir (Join-Path $Stage "manifests")
Copy-Item (Join-Path $Root "native-host\manifests\*") (Join-Path $Stage "manifests") -Force

# 5. Stable extension id ------------------------------------------------------
$extId = Get-ExtensionId
if ($extId) {
  Write-Host "Extension id: $extId"
  [System.IO.File]::WriteAllText((Join-Path $Stage "extension-id.txt"), $extId, $Utf8NoBom)
} else {
  Write-Warning "browser-extension\manifest.json has no 'key'; extension id will be random."
}

# 6. Report -------------------------------------------------------------------
Write-Step "Artifacts in dist\"
Get-ChildItem $Dist -File | ForEach-Object { "{0,10:N0}  {1}" -f $_.Length, $_.Name }
$hostSize = if (Test-Path $HostExe) { (Get-Item $HostExe).Length } else { 0 }
if ($hostSize -gt 20MB) {
  Write-Warning "The compiled host is $([math]::Round($hostSize / 1MB, 1)) MB; Setup.exe may exceed the 20 MB budget."
}
Write-Host ""
Write-Host "Next: iscc /DExtId=`"$extId`" installer\setup.iss"
