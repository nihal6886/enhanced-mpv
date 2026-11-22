# Enhanced MPV installer - Windows
# Runs from a checkout (.\scripts\install.ps1) or piped straight from the web
# (irm .../scripts/install.ps1 | iex). When piped there is no local checkout, so
# the source archive is fetched to a temp folder first.
# 
# Extension ID is locked to the public key in browser-extension/manifest.json.
# Override with -ExtensionId only for development / unpacked builds.
param(
  [switch]$Uninstall,
  [string]$ExtensionId = $(if ($env:ENHANCED_MPV_EXTENSION_ID) { $env:ENHANCED_MPV_EXTENSION_ID } else { "oaholhjabdiapfijakeojjjoideniecl" }),
  [switch]$SkipDeps,
  [switch]$WithFfmpeg,
  [switch]$Yes,
  [switch]$Force,
  [switch]$DevTools,
  [string]$Repo = $(if ($env:ENHANCED_MPV_REPO) { $env:ENHANCED_MPV_REPO } else { "nihal6886/enhanced-mpv" }),
  [string]$Branch = $(if ($env:ENHANCED_MPV_BRANCH) { $env:ENHANCED_MPV_BRANCH } else { "main" })
)

$ErrorActionPreference = "Stop"
# The progress bar makes Invoke-WebRequest many times slower; disabling it lets
# the ModernZ and helper-script downloads run at full speed.
$ProgressPreference = "SilentlyContinue"
# Force TLS 1.2 so downloads work on machines whose default is SSL3/TLS1.0.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Download a URL to a file with up to 3 attempts and a 2-second backoff, so
# slow routes to githubusercontent never abort the installer.
function Download-FileWithRetry($Url, $Dest) {
  $lastErr = $null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 90 -Uri $Url -OutFile $Dest | Out-Null
      return $true
    } catch {
      $lastErr = $_
      if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
    }
  }
  Write-Warning "Download failed after 3 retries: $Url ($($lastErr.Exception.Message))"
  return $false
}

# Resolve the repo root, allowing for both script-file and iex execution.
$Root = $null
$ScriptFile = $MyInvocation.MyCommand.Path
$candidates = @(
  $(if ($ScriptFile) { Split-Path -Parent (Split-Path -Parent $ScriptFile) }),
  $(if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot })
)
foreach ($c in $candidates) {
  if ($c -and (Test-Path (Join-Path $c "native-host\index.js"))) { $Root = (Resolve-Path $c).Path; break }
}
if (-not $Root) {
  Write-Host "No local checkout found - downloading $Repo ($Branch)..."
  $zip = Join-Path $env:TEMP ("enhanced-mpv-" + [guid]::NewGuid().ToString() + ".zip")
  $src = Join-Path $env:TEMP ("enhanced-mpv-src-" + [guid]::NewGuid().ToString())
  $url = "https://codeload.github.com/$Repo/zip/refs/heads/$Branch"
  if (-not (Download-FileWithRetry $url $zip)) {
    throw "Could not bootstrap the Enhanced MPV source from $url"
  }
  New-Item -ItemType Directory -Force -Path $src | Out-Null
  Expand-Archive -Path $zip -DestinationPath $src -Force
  $Root = (Get-ChildItem $src -Directory | Select-Object -First 1).FullName
  if (-not (Test-Path (Join-Path $Root "native-host\index.js"))) {
    throw "Could not bootstrap the Enhanced MPV source from $url"
  }
}

$HostName = "com.enhanced.mpv.host"
$MpvDir = Join-Path $env:APPDATA "mpv"
$UserCfg = Join-Path $env:USERPROFILE ".enhanced-mpv"
$BackupDir = Join-Path $UserCfg "backups"
$LaunchLog = Join-Path $UserCfg "last-launch.log"
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
# UTF-8 without BOM keeps mpv/ModernZ config and Native Messaging JSON clean.
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Test-Cmd($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# Native vanilla mpv is required; mpv.net is intentionally excluded.
function Resolve-Mpv {
  # Prioritize the stamped EnhancedMPV build with our custom icon.
  $enhancedMpv = Join-Path $env:LOCALAPPDATA "Programs\EnhancedMPV\enhanced-mpv.exe"
  if (Test-Path $enhancedMpv) { return $enhancedMpv }
  
  foreach ($name in @("mpv.exe", "mpv.com", "mpv")) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c -and $c.CommandType -eq "Application" -and
        [System.IO.Path]::GetFileNameWithoutExtension($c.Source) -ieq "mpv" -and
        $c.Source -notmatch "(?i)[\\/]mpv\.net[\\/]") {
      return $c.Source
    }
  }
  $guesses = @(
    (Join-Path $env:LOCALAPPDATA "Programs\mpv\mpv.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\mpv\mpv.com"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\mpv.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\mpv.com"),
    "C:\Program Files\mpv\mpv.exe",
    "C:\Program Files (x86)\mpv\mpv.exe",
    "C:\mpv\mpv.exe",
    "C:\mpv\mpv.com"
  )
  foreach ($p in $guesses) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  $packages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  foreach ($package in @(Get-ChildItem $packages -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "(?i)^shinchiro\.mpv_" })) {
    foreach ($exe in @("mpv.exe", "mpv.com")) {
      $candidate = Get-ChildItem $package.FullName -Filter $exe -File -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($candidate) { return $candidate.FullName }
    }
  }
  return $null
}

# Pin the exact resolved mpv binary into thumbfast.conf and force network=no so
# local files get instant hover previews while remote .m3u8 / YouTube streams
# never spawn a background mpv subprocess ("cannot create mpv subprocess").
function Set-ThumbfastPath($Dir, $Bin) {
  $conf = Join-Path $Dir "script-opts\thumbfast.conf"
  if (-not (Test-Path $conf)) { return }
  $value = if ($Bin) { $Bin } else { "" }
  $lines = Get-Content $conf | ForEach-Object {
    if ($_ -match '^\s*mpv_path=') { "mpv_path=$value" }
    elseif ($_ -match '^\s*network=') { "network=no" }
    else { $_ }
  }
  [System.IO.File]::WriteAllLines($conf, [string[]]$lines, $Utf8NoBom)
  Write-Host "thumbfast: mpv_path=$value (network=no) in $conf"
}

# Create (or refresh) the Start Menu shortcut with the custom Enhanced MPV icon
# so the player can also be launched straight from Windows Search.
function New-StartMenuShortcut($Bin, $Icon) {
  if (-not $Bin) { return }
  $programs = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
  New-Item -ItemType Directory -Force -Path $programs | Out-Null
  $linkPath = Join-Path $programs "Enhanced MPV.lnk"
  try {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($linkPath)
    $lnk.TargetPath = $Bin
    $lnk.WorkingDirectory = Split-Path -Parent $Bin
    if ($Icon -and (Test-Path $Icon)) { $lnk.IconLocation = "$Icon,0" }
    $lnk.Description = "Enhanced MPV"
    $lnk.Save()
    Write-Host "Start Menu shortcut: $linkPath"
  } catch {
    Write-Warning "Could not create the Start Menu shortcut: $($_.Exception.Message)"
  }
}

# Native OS Yes/No confirmation. Fails closed to "No" when no dialog is possible.
function Confirm-Native($message, $title = "Enhanced MPV") {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $r = [System.Windows.Forms.MessageBox]::Show($message, $title,
      [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Warning)
    return ($r -eq [System.Windows.Forms.DialogResult]::Yes)
  } catch {
    if ([Console]::IsInputRedirected) { return $false }
    $answer = Read-Host "$title - $message [y/N]"
    return ($answer -match '^(?i)y(es)?$')
  }
}

function Refresh-Path {
  # winget/MSI installs update the registry PATH, not the live session - reload it.
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ";"
}

function Install-Winget($id, $name) {
  if ($name -eq "mpv") {
    if (Resolve-Mpv) { return }
    $candidateIds = @("mpv.mpv", "zhongfly.mpv")
  } else {
    if (Test-Cmd $name) { return }
    $candidateIds = @($id)
  }
  if (Test-Cmd "winget") {
    $ok = $false
    foreach ($candidateId in $candidateIds) {
      Write-Host "Installing $candidateId via winget..."
      winget install -e --id $candidateId --accept-package-agreements --accept-source-agreements 2>$null
      if ($LASTEXITCODE -eq 0) { $ok = $true; break }
    }
    if (-not $ok -and $name -eq "mpv") {
      Write-Warning "winget failed for mpv; trying direct GitHub download..."
      Install-MpvDirect
    } elseif (-not $ok) {
      Write-Warning "winget failed to install $name."
    }
  } else {
    if ($name -eq "mpv") {
      Write-Host "winget not found; trying direct GitHub download for mpv..."
      Install-MpvDirect
    } else {
      Write-Host "Install $name manually (winget not found)."
    }
  }
}

function Install-MpvDirect {
  $MpvDir = Join-Path $env:LOCALAPPDATA "Programs\mpv"
  New-Item -ItemType Directory -Force -Path $MpvDir | Out-Null
  $tmp = Join-Path $env:TEMP ("empv-mpv-" + [guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $api = Join-Path $tmp "release.json"
    if (-not (Download-FileWithRetry "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest" $api)) {
      Write-Warning "Could not fetch shinchiro/mpv-winbuild-cmake release metadata."
      return
    }
    $json = Get-Content $api -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue
    if (-not $json -or -not $json.assets) {
      Write-Warning "No release assets found for shinchiro/mpv-winbuild-cmake."
      return
    }
    $asset = $json.assets | Where-Object { $_.name -match "mpv-x86_64" -and ($_.name -like "*.zip" -or $_.name -like "*.7z") } | Select-Object -First 1
    if (-not $asset) {
      Write-Warning "No mpv-x86_64 .zip/.7z asset found in shinchiro/mpv-winbuild-cmake."
      return
    }
    $pkg = Join-Path $tmp ("mpv-pkg" + [System.IO.Path]::GetExtension($asset.name))
    if (-not (Download-FileWithRetry $asset.browser_download_url $pkg)) {
      Write-Warning "Direct mpv download failed."
      return
    }
    if ($pkg -like "*.zip") {
      Expand-Archive -Path $pkg -DestinationPath (Join-Path $tmp "out") -Force
      $outDir = Join-Path $tmp "out"
      $srcRoot = if (Test-Path (Join-Path $outDir "mpv.exe")) { $outDir }
      elseif ($mpvSub = Get-ChildItem $outDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName "mpv.exe") } | Select-Object -First 1) { $mpvSub.FullName }
      else { $outDir }
      Copy-Item -Path (Join-Path $srcRoot "*") -Destination $MpvDir -Recurse -Force
    } else {
      $seven = Get-Command "7z" -ErrorAction SilentlyContinue
      if (-not $seven) {
        Write-Host "7z not on PATH; trying to install 7zip.7zip via winget..."
        winget install -e --id 7zip.7zip --accept-package-agreements --accept-source-agreements 2>$null | Out-Null
        $seven = Get-Command "7z" -ErrorAction SilentlyContinue
        if (-not $seven) {
          foreach ($cand in @(
            "${env:ProgramFiles}\7-Zip\7z.exe",
            "${env:ProgramFiles(x86)}\7-Zip\7z.exe",
            "C:\Program Files\7-Zip\7z.exe",
            "C:\Program Files (x86)\7-Zip\7z.exe"
          )) {
            if (Test-Path $cand) { $seven = Get-Item $cand; break }
          }
        }
      }
      if (-not $seven) {
        Write-Host "7z still not available; downloading 7za.exe standalone..."
        $7zaUrl = "https://www.7-zip.org/a/7za2409.zip"
        $7zaZip = Join-Path $tmp "7za.zip"
        if (-not (Download-FileWithRetry $7zaUrl $7zaZip)) {
          Write-Warning "Could not download 7za standalone; cannot extract .7z."
          return
        }
        Expand-Archive -Path $7zaZip -DestinationPath (Join-Path $tmp "7za") -Force
        $7zaExe = Get-ChildItem (Join-Path $tmp "7za") -Filter "7za.exe" -Recurse | Select-Object -First 1
        if (-not $7zaExe) {
          Write-Warning "7za.exe not found in standalone package; cannot extract .7z."
          return
        }
        & $7zaExe.FullName x $pkg -o"$(Join-Path $tmp "out")" -y | Out-Null
      } else {
        & $seven x $pkg -o"$(Join-Path $tmp "out")" -y | Out-Null
      }
      $outDir = Join-Path $tmp "out"
      $srcRoot = if (Test-Path (Join-Path $outDir "mpv.exe")) { $outDir }
      elseif ($mpvSub = Get-ChildItem $outDir -Directory | Where-Object { Test-Path (Join-Path $_.FullName "mpv.exe") } | Select-Object -First 1) { $mpvSub.FullName }
      else { $outDir }
      Copy-Item -Path (Join-Path $srcRoot "*") -Destination $MpvDir -Recurse -Force
    }
    Refresh-Path
    Write-Host "Installed mpv directly to $MpvDir"
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Backup-File($path) {
  if (-not (Test-Path $path)) { return }
  $destDir = Join-Path $BackupDir $Stamp
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  Copy-Item $path -Destination (Join-Path $destDir (Split-Path $path -Leaf)) -Force
}

function Download-Zip($url, $dest) {
  $tmp = Join-Path $env:TEMP ("empv-" + [guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp "a.zip"
  if (-not (Download-FileWithRetry $url $zip)) {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    return
  }
  Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp "out") -Force
  $inner = Get-ChildItem (Join-Path $tmp "out") | Select-Object -First 1
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  if ($inner -and $inner.PSIsContainer) {
    Copy-Item -Path (Join-Path $inner.FullName "*") -Destination $dest -Recurse -Force
  } else {
    Copy-Item -Path (Join-Path $tmp "out\*") -Destination $dest -Recurse -Force
  }
  Remove-Item $tmp -Recurse -Force
}

function Register-NativeHost($jsonPath) {
  $keys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKCU:\Software\BraveSoftware\Brave\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"
  )
  foreach ($k in $keys) {
    New-Item -Path $k -Force | Out-Null
    Set-ItemProperty -Path $k -Name "(default)" -Value $jsonPath
    Write-Host "Registry: $k"
  }
}

function Unregister-NativeHost {
  $keys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKCU:\Software\BraveSoftware\Brave\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"
  )
  foreach ($k in $keys) {
    if (Test-Path $k) { Remove-Item $k -Recurse -Force }
  }
}

if ($Uninstall) {
  Unregister-NativeHost
  $copied = @("window-icon.lua", "enhanced-mpv.lua", "smart-sub-manager.lua", "loading-screen.lua", "player-menus.lua") |
    ForEach-Object { Join-Path $MpvDir "scripts\$_" }
  foreach ($f in $copied) { if (Test-Path $f) { Remove-Item $f -Force } }
  $latest = Get-ChildItem $BackupDir -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($latest) {
    Copy-Item (Join-Path $latest.FullName "*") $MpvDir -Force -ErrorAction SilentlyContinue
    Write-Host "Restored backup $($latest.FullName)"
  }
  Write-Host "Uninstalled native host registration."
  exit 0
}

New-Item -ItemType Directory -Force -Path $MpvDir, (Join-Path $MpvDir "scripts"), (Join-Path $MpvDir "script-opts"), $UserCfg, $BackupDir | Out-Null

# Delete any stale last-launch.log so cookies/headers from prior runs are never retained.
if (Test-Path $LaunchLog) { Remove-Item $LaunchLog -Force -ErrorAction SilentlyContinue }

if (-not $SkipDeps) {
  # Native mpv bundles FFmpeg internally; only mpv, Node.js and yt-dlp are
  # mandatory for regular playback.
  if (-not (Resolve-Mpv)) {
    Install-Winget "mpv.mpv" "mpv"
    Refresh-Path
  }
  Install-Winget "OpenJS.NodeJS.LTS" "node"
  Install-Winget "yt-dlp.yt-dlp" "yt-dlp"
  # Optional: only needed for download/merge/remux features, not for playing.
  if ($WithFfmpeg) {
    Install-Winget "Gyan.FFmpeg.Essentials" "ffmpeg"
    Refresh-Path
  }
}

Refresh-Path
$MpvBin = Resolve-Mpv
# Fallback: direct check at the known install location (Install-MpvDirect uses this path)
if (-not $MpvBin) {
  $directMpv = Join-Path $env:LOCALAPPDATA "Programs\mpv\mpv.exe"
  if (Test-Path $directMpv) { $MpvBin = $directMpv }
  else {
    $directMpvCom = Join-Path $env:LOCALAPPDATA "Programs\mpv\mpv.com"
    if (Test-Path $directMpvCom) { $MpvBin = $directMpvCom }
  }
}
if ($MpvBin) {
  Write-Host "Found mpv: $MpvBin"
} else {
  Write-Warning "Native mpv.exe/mpv.com was not found. Install mpv.mpv via winget or rerun the installer."
}
if (-not (Test-Cmd "node")) { throw "Node.js is required." }
if ($WithFfmpeg -and -not (Test-Cmd "ffmpeg")) {
  Write-Warning "ffmpeg is still missing after installing Gyan.FFmpeg.Essentials."
}

Write-Host "Generating browser-extension icons..."
node (Join-Path $Root "scripts\generate-icons.js")

# Skip ModernZ release downloads when both assets are already installed. Pass
# -Force to refresh the script and its icon font.
$ModernZLua = Join-Path $MpvDir "scripts\modernz.lua"
$ModernZFont = Join-Path $MpvDir "fonts\modernz-icons.ttf"
$ModernZScriptDir = Split-Path -Parent $ModernZLua
$ModernZFontDir = Split-Path -Parent $ModernZFont
New-Item -ItemType Directory -Force -Path $ModernZScriptDir, $ModernZFontDir | Out-Null
if ($Force -or -not (Test-Path $ModernZLua) -or -not (Test-Path $ModernZFont)) {
  Write-Host "Installing the latest ModernZ release..."
  $modernZUrls = @(
    @{ lua = "https://github.com/Samillion/ModernZ/releases/latest/download/modernz.lua";
       font = "https://github.com/Samillion/ModernZ/releases/latest/download/modernz-icons.ttf" },
    @{ lua = "https://github.com/Samillion/ModernZ/releases/download/v0.3.3/modernz.lua";
       font = "https://github.com/Samillion/ModernZ/releases/download/v0.3.3/modernz-icons.ttf" }
  )
  $modernZOk = $false
  foreach ($urls in $modernZUrls) {
    $luaOk = Download-FileWithRetry $urls.lua $ModernZLua
    $fontOk = Download-FileWithRetry $urls.font $ModernZFont
    if ($luaOk -and $fontOk) { $modernZOk = $true; break }
    Write-Warning "ModernZ download from $($urls.lua) failed; trying next source."
  }
  if (-not $modernZOk) {
    Write-Warning "ModernZ could not be downloaded from any source."
  }
} else {
  Write-Host "ModernZ is already installed - skipping release downloads (-Force to refresh)."
}

$ThumbfastLua = Join-Path $MpvDir "scripts\thumbfast.lua"
if ($Force -or -not (Test-Path $ThumbfastLua)) {
  Write-Host "Downloading thumbfast..."
  Download-Zip "https://github.com/po5/thumbfast/archive/refs/heads/master.zip" (Join-Path $MpvDir "scripts\thumbfast-src")
  Copy-Item (Join-Path $MpvDir "scripts\thumbfast-src\thumbfast.lua") (Join-Path $MpvDir "scripts\thumbfast.lua") -Force
  Remove-Item (Join-Path $MpvDir "scripts\thumbfast-src") -Recurse -Force
}

$SubSelectLua = Join-Path $MpvDir "scripts\sub-select.lua"
if ($Force -or -not (Test-Path $SubSelectLua)) {
  Write-Host "Downloading mpv-sub-select..."
  Download-Zip "https://github.com/CogentRedTester/mpv-sub-select/archive/refs/heads/master.zip" (Join-Path $MpvDir "scripts\sub-select-src")
  Get-ChildItem (Join-Path $MpvDir "scripts\sub-select-src") -Filter "*.lua" -Recurse | Select-Object -First 1 | ForEach-Object {
    Copy-Item $_.FullName (Join-Path $MpvDir "scripts\sub-select.lua") -Force
  }
  Remove-Item (Join-Path $MpvDir "scripts\sub-select-src") -Recurse -Force
}

foreach ($f in @("mpv.conf", "input.conf")) {
  Backup-File (Join-Path $MpvDir $f)
  Copy-Item (Join-Path $Root "mpv-config\$f") (Join-Path $MpvDir $f) -Force
}
foreach ($f in @("window-icon.lua", "enhanced-mpv.lua", "smart-sub-manager.lua", "loading-screen.lua", "player-menus.lua", "dev-tools.lua", "stream-controller.lua")) {
  Copy-Item (Join-Path $Root "mpv-config\scripts\$f") (Join-Path $MpvDir "scripts\$f") -Force
}
Get-ChildItem (Join-Path $Root "mpv-config\script-opts") -File |
  Where-Object { $_.Name -ne "uosc.conf" } |
  ForEach-Object { Copy-Item $_.FullName (Join-Path $MpvDir "script-opts") -Force }

# Custom player icon used by window-icon.lua and the Start Menu shortcut.
$MpvIco = Join-Path $MpvDir "enhanced-mpv.ico"
Copy-Item (Join-Path $Root "assets\enhanced-mpv.ico") $MpvIco -Force

# Also copy to local mpv dir for window-icon.lua
$LocalMpvDir = Join-Path $env:LOCALAPPDATA "Programs\mpv"
New-Item -ItemType Directory -Force -Path $LocalMpvDir | Out-Null
$LocalMpvIco = Join-Path $LocalMpvDir "enhanced-mpv.ico"
Copy-Item (Join-Path $Root "assets\enhanced-mpv.ico") $LocalMpvIco -Force
Write-Host "Copied enhanced-mpv.ico to $LocalMpvDir"

# Create EnhancedMPV folder and copy mpv.exe there as enhanced-mpv.exe, then stamp the icon.
function Stamp-EnhancedMpvIcon {
  param(
    [string]$SourceMpvExe
  )
  $EnhancedMpvDir = Join-Path $env:LOCALAPPDATA "Programs\EnhancedMPV"
  New-Item -ItemType Directory -Force -Path $EnhancedMpvDir | Out-Null
  $EnhancedMpvExe = Join-Path $EnhancedMpvDir "enhanced-mpv.exe"

  # Determine source binary: prefer upstream mpv.exe when -Force (re-stamp), else use resolved $MpvBin
  if (-not $SourceMpvExe) {
    if ($Force) {
      # Prefer the upstream mpv.exe from the standard install location
      $upstream = Join-Path $env:LOCALAPPDATA "Programs\mpv\mpv.exe"
      if (Test-Path $upstream) { $SourceMpvExe = $upstream }
      else {
        $upstreamCom = Join-Path $env:LOCALAPPDATA "Programs\mpv\mpv.com"
        if (Test-Path $upstreamCom) { $SourceMpvExe = $upstreamCom }
      }
    }
    # Fall back to resolved $MpvBin
    if (-not $SourceMpvExe) { $SourceMpvExe = $MpvBin }
  }

  if ($SourceMpvExe -and (Test-Path $SourceMpvExe)) {
    # Only copy if source and destination are different (avoid self-copy)
    if ($SourceMpvExe -ne $EnhancedMpvExe) {
      Copy-Item $SourceMpvExe $EnhancedMpvExe -Force
      Write-Host "Copied mpv to $EnhancedMpvExe"
    } else {
      Write-Host "Source and destination are the same; skipping copy."
    }
    # Download rcedit-x64.exe from electron/rcedit releases if not cached.
    $rceditCache = Join-Path $env:LOCALAPPDATA "EnhancedMPV\rcedit-x64.exe"
    if (-not (Test-Path $rceditCache)) {
      $rceditUrl = "https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe"
      $rceditTmp = Join-Path $env:TEMP "rcedit-x64.exe"
      Write-Host "Downloading rcedit..."
      if (Download-FileWithRetry $rceditUrl $rceditTmp) {
        New-Item -ItemType Directory -Force -Path (Split-Path $rceditCache) | Out-Null
        Move-Item $rceditTmp $rceditCache -Force
      } else {
        Write-Warning "Could not download rcedit; icon stamping skipped."
        return
      }
    }
    $rcedit = if (Test-Path $rceditCache) { $rceditCache } else { return }
    $iconPath = Join-Path $Root "assets\enhanced-mpv.ico"
    if (Test-Path $iconPath) {
      Write-Host "Stamping Enhanced MPV icon into $EnhancedMpvExe..."
      & $rcedit $EnhancedMpvExe --set-icon $iconPath
      if ($LASTEXITCODE -eq 0) {
        Write-Host "Icon stamped successfully on enhanced-mpv.exe."
        # Also stamp the local mpv.exe so window-icon.lua finds it directly
        $localMpvExe = Join-Path $env:LOCALAPPDATA "Programs\mpv\mpv.exe"
        if (Test-Path $localMpvExe) {
          Write-Host "Stamping Enhanced MPV icon into $localMpvExe..."
          & $rcedit $localMpvExe --set-icon $iconPath
          if ($LASTEXITCODE -eq 0) {
            Write-Host "Icon stamped successfully on local mpv.exe."
          } else {
            Write-Warning "rcedit failed (exit code $LASTEXITCODE) on local mpv.exe; icon may not be applied."
          }
        }
        # Refresh Windows icon cache so the neon green play icon appears immediately
        # in the window titlebar and taskbar.
        $ie4uinit = "C:\Windows\System32\ie4uinit.exe"
        if (Test-Path $ie4uinit) {
          Write-Host "Refreshing Windows icon cache..."
          & $ie4uinit -show
        }
      } else {
        Write-Warning "rcedit failed (exit code $LASTEXITCODE) on enhanced-mpv.exe; icon may not be applied."
      }
    }
  }
}
# When -Force is passed, re-stamp by preferring the upstream mpv.exe
Stamp-EnhancedMpvIcon

# Pin the resolved mpv binary into thumbfast and disable remote thumbnails so
# local files get instant previews while remote streams never spawn a subprocess.
Set-ThumbfastPath $MpvDir $MpvBin

# Ensure ytdl_hook.conf points to yt-dlp.exe so ytdl_hook finds it immediately.
function Set-YtdlHookPath($Dir, $Bin) {
  $hookDir = Join-Path $Dir "script-opts"
  New-Item -ItemType Directory -Force -Path $hookDir | Out-Null
  $hookFile = Join-Path $hookDir "ytdl_hook.conf"
  $ytDlpExe = Get-Command yt-dlp -ErrorAction SilentlyContinue
  if (-not $ytDlpExe) {
    $ytDlpExe = Get-Command "yt-dlp.exe" -ErrorAction SilentlyContinue
  }
  if ($ytDlpExe) {
    $ytDlpPath = $ytDlpExe.Source
    [System.IO.File]::WriteAllText($hookFile, "ytdl_path=$ytDlpPath", $Utf8NoBom)
    Write-Host "ytdl_hook: ytdl_path=$ytDlpPath in $hookFile"
  } else {
    Write-Warning "yt-dlp not found on PATH; ytdl_hook.conf not created."
  }
}
Set-YtdlHookPath $MpvDir $MpvBin

# Windows IPC uses a named pipe (not a Unix socket); rewrite the copied mpv.conf.
$MpvConf = Join-Path $MpvDir "mpv.conf"
if (Test-Path $MpvConf) {
  $patched = Get-Content $MpvConf | ForEach-Object {
    if ($_ -match '^\s*input-ipc-server=') { 'input-ipc-server=\\.\pipe\enhanced-mpv-socket' } else { $_ }
  }
  # Apply dev-diag profile if -DevTools switch was passed
  if ($DevTools) {
    $patched += @("", "[dev-diag]")
    Write-Host "DevTools mode enabled: applied [dev-diag] profile (verbose demux/ffmpeg/ytdl logging)"
  }
  [System.IO.File]::WriteAllLines($MpvConf, [string[]]$patched, $Utf8NoBom)
}

# Start Menu shortcut so Enhanced MPV can be launched straight from Windows Search.
New-StartMenuShortcut $MpvBin $MpvIco

if (-not (Test-Path (Join-Path $UserCfg "config.json"))) {
  Copy-Item (Join-Path $Root "native-host\default-config.json") (Join-Path $UserCfg "config.json")
}

# Strictly validate the Chromium extension ID (32 chars, each a-p) before it is
# ever written into a Native Messaging manifest.
$IdPattern = '^[a-p]{32}$'
if ($ExtensionId) {
  $ExtensionId = $ExtensionId.Trim().ToLower()
  if ($ExtensionId -notmatch $IdPattern) {
    throw "Invalid extension ID '$ExtensionId'. Expected 32 characters, each in a-p."
  }
} elseif (-not [Console]::IsInputRedirected) {
  Write-Host ""
  Write-Host "Enter your unpacked Chromium extension ID (chrome://extensions), or press Enter to skip."
  $answer = (Read-Host "Extension ID").Trim().ToLower()
  if ($answer) {
    if ($answer -notmatch $IdPattern) {
      throw "Invalid extension ID '$answer'. Expected 32 characters, each in a-p."
    }
    $ExtensionId = $answer
  }
}

$NmDir = Join-Path $UserCfg "native-messaging"
New-Item -ItemType Directory -Force -Path $NmDir | Out-Null

# Windows Chrome/Edge cannot execute a .js host directly: generate a .bat wrapper
# that launches node.exe with the absolute path to the host entry point.
$NodeExe = (Get-Command node).Source
$IndexJs = Join-Path $Root "native-host\index.js"
$HostBat = Join-Path $NmDir "enhanced-mpv-host.bat"
$BatBody = "@echo off`r`n`"$NodeExe`" `"$IndexJs`" %*`r`n"
[System.IO.File]::WriteAllText($HostBat, $BatBody, $Utf8NoBom)

$HostEsc = $HostBat.Replace("\", "\\")

# Firefox host - uses a fixed gecko id, so no extension id is involved.
$FfTemplate = Get-Content (Join-Path $Root "native-host\manifests\firefox.json") -Raw
$FfJson = $FfTemplate.Replace("HOST_PATH", $HostEsc)
$FfManifest = Join-Path $NmDir "$HostName.firefox.json"
[System.IO.File]::WriteAllText($FfManifest, $FfJson, $Utf8NoBom)
New-Item -Path "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName" -Name "(default)" -Value $FfManifest

# Chromium host - only written after the user confirms via a native OS prompt.
if ($ExtensionId) {
  $confirmed = $false
  if ($Yes) {
    $confirmed = $true
  } else {
    $confirmed = Confirm-Native ("Link browser extension '$ExtensionId' to Enhanced MPV?`n`n" +
      "This writes chrome-extension://$ExtensionId/ into the Native Messaging " +
      "manifest so the extension can launch mpv.")
  }
  if ($confirmed) {
    $ChromeTemplate = Get-Content (Join-Path $Root "native-host\manifests\chrome.json") -Raw
    $ChromeJson = $ChromeTemplate.Replace("HOST_PATH", $HostEsc).Replace("EXTENSION_ID", $ExtensionId)
    $ChromeManifest = Join-Path $NmDir "$HostName.chrome.json"
    [System.IO.File]::WriteAllText($ChromeManifest, $ChromeJson, $Utf8NoBom)
    Register-NativeHost $ChromeManifest
    Write-Host "Linked Chromium extension $ExtensionId."
  } else {
    Write-Host "Declined - skipped Chromium host registration."
  }
} else {
  Write-Host "No Chromium extension ID supplied - skipped Chromium host registration."
  Write-Host "Load the unpacked extension, then re-run with -ExtensionId <id>."
}

Write-Host ""
Write-Host "Done."
Write-Host "1. Edge/Chrome: edge://extensions or chrome://extensions -> Load unpacked -> $Root\browser-extension"
Write-Host "2. Re-run with -ExtensionId YOUR_ID to register the Chromium host (skipped if no id was given)."
Write-Host "3. Health check: node `"$Root\native-host\doctor.js`""
Write-Host "4. Re-run the installer anytime with: powershell -ExecutionPolicy Bypass -File `"$Root\scripts\install.ps1`""
