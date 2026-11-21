#!/usr/bin/env bash
# Enhanced MPV installer — Linux and macOS
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST_NAME="com.enhanced.mpv.host"
EXT_ID="${ENHANCED_MPV_EXTENSION_ID:-}"
UNINSTALL=0
SKIP_DEPS=0

usage() {
  cat <<'EOF'
Usage: install.sh [--uninstall] [--extension-id ID] [--skip-deps]

  --extension-id   Unpacked Chrome/Chromium/Brave/Edge extension ID
  --uninstall      Remove manifests, copied scripts, restore backups
  --skip-deps      Do not invoke brew/apt/dnf/pacman
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) UNINSTALL=1; shift ;;
    --extension-id) EXT_ID="$2"; shift 2 ;;
    --skip-deps) SKIP_DEPS=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown flag: $1"; usage; exit 1 ;;
  esac
done

OS="$(uname -s)"
HOME_DIR="${HOME}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME_DIR/.config}"
MPV_DIR="$CONFIG_HOME/mpv"
USER_CFG="$HOME_DIR/.enhanced-mpv"
BACKUP_DIR="$USER_CFG/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

have() { command -v "$1" >/dev/null 2>&1; }

install_pkg() {
  local pkg="$1"
  if have brew; then brew install "$pkg" || true
  elif have apt-get; then sudo apt-get update && sudo apt-get install -y "$pkg"
  elif have dnf; then sudo dnf install -y "$pkg"
  elif have pacman; then sudo pacman -S --noconfirm "$pkg"
  else
    echo "Install $pkg manually, then re-run this script."
  fi
}

ensure_bins() {
  [[ "$SKIP_DEPS" = 1 ]] && return 0
  local missing=()
  have mpv || missing+=(mpv)
  have node || missing+=(node)
  have ffmpeg || missing+=(ffmpeg)
  have yt-dlp || missing+=(yt-dlp)
  have curl || missing+=(curl)
  have unzip || missing+=(unzip)
  have iconv || missing+=(libc-bin)
  if [[ ${#missing[@]} -eq 0 ]]; then
    echo "Dependencies OK: mpv node ffmpeg yt-dlp curl"
    return 0
  fi
  echo "Missing: ${missing[*]}"
  if have brew; then
    brew install mpv node ffmpeg yt-dlp curl unzip || true
  elif have apt-get; then
    sudo apt-get update
    sudo apt-get install -y mpv nodejs npm ffmpeg yt-dlp curl unzip libc-bin zenity || true
  elif have dnf; then
    sudo dnf install -y mpv nodejs ffmpeg yt-dlp curl unzip zenity || true
  elif have pacman; then
    sudo pacman -S --noconfirm mpv nodejs ffmpeg yt-dlp curl unzip zenity || true
  else
    echo "No supported package manager. Install: ${missing[*]}"
    exit 1
  fi
}

backup_file() {
  local src="$1"
  [[ -e "$src" ]] || return 0
  mkdir -p "$BACKUP_DIR/$STAMP"
  cp -a "$src" "$BACKUP_DIR/$STAMP/$(basename "$src")"
}

download_zip() {
  local url="$1"
  local dest="$2"
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL "$url" -o "$tmp/a.zip"
  unzip -qo "$tmp/a.zip" -d "$tmp/out"
  mkdir -p "$dest"
  # flatten a single top-level folder
  local inner
  inner="$(find "$tmp/out" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [[ -n "$inner" ]] && [[ "$(find "$tmp/out" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ]]; then
    cp -a "$inner"/. "$dest"/
  else
    cp -a "$tmp/out"/. "$dest"/
  fi
  rm -rf "$tmp"
}

install_third_party() {
  mkdir -p "$MPV_DIR/scripts" "$MPV_DIR/script-opts" "$MPV_DIR/fonts"
  local modernz="$MPV_DIR/scripts/modernz.lua"
  local modernz_font="$MPV_DIR/fonts/modernz-icons.ttf"
  if [[ ! -f "$modernz" ]]; then
    echo "Downloading the latest ModernZ release..."
    curl -fsSL --max-time 15 \
      "https://github.com/Samillion/ModernZ/releases/latest/download/modernz.lua" -o "$modernz"
  fi
  if [[ ! -f "$modernz_font" ]]; then
    curl -fsSL --max-time 15 \
      "https://github.com/Samillion/ModernZ/releases/latest/download/modernz-icons.ttf" -o "$modernz_font"
  fi

  if [[ ! -f "$MPV_DIR/scripts/thumbfast.lua" ]]; then
    local thumb_tmp
    thumb_tmp="$(mktemp -d)"
    download_zip "https://github.com/po5/thumbfast/archive/refs/heads/master.zip" "$thumb_tmp/src"
    cp -f "$thumb_tmp/src/thumbfast.lua" "$MPV_DIR/scripts/thumbfast.lua"
    rm -rf "$thumb_tmp"
  fi

  if [[ ! -f "$MPV_DIR/scripts/sub-select.lua" ]]; then
    local sub_tmp
    sub_tmp="$(mktemp -d)"
    download_zip "https://github.com/CogentRedTester/mpv-sub-select/archive/refs/heads/master.zip" "$sub_tmp/src"
    cp -f "$sub_tmp/src/sub-select.lua" "$MPV_DIR/scripts/sub-select.lua" 2>/dev/null \
      || cp -f "$sub_tmp/src/"*.lua "$MPV_DIR/scripts/sub-select.lua"
    rm -rf "$sub_tmp"
  fi
}

copy_our_config() {
  mkdir -p "$MPV_DIR/scripts" "$MPV_DIR/script-opts"
  for f in mpv.conf input.conf; do
    backup_file "$MPV_DIR/$f"
    cp -f "$ROOT/mpv-config/$f" "$MPV_DIR/$f"
  done
  for f in window-icon.lua enhanced-mpv.lua smart-sub-manager.lua loading-screen.lua player-menus.lua; do
    cp -f "$ROOT/mpv-config/scripts/$f" "$MPV_DIR/scripts/$f"
  done
  for f in "$ROOT"/mpv-config/script-opts/*; do
    [[ "$(basename "$f")" == "uosc.conf" ]] || cp -f "$f" "$MPV_DIR/script-opts/"
  done
}

pin_thumbfast() {
  local mpv_bin conf tmp
  mpv_bin="$(command -v mpv || true)"
  conf="$MPV_DIR/script-opts/thumbfast.conf"
  [[ -n "$mpv_bin" && -f "$conf" ]] || return 0
  tmp="$conf.tmp.$$"
  awk -v mpv="$mpv_bin" '
    /^mpv_path=/ { print "mpv_path=" mpv; next }
    /^network=/ { print "network=no"; next }
    { print }
  ' "$conf" > "$tmp"
  mv "$tmp" "$conf"
}

write_user_config() {
  mkdir -p "$USER_CFG"
  if [[ ! -f "$USER_CFG/config.json" ]]; then
    cp "$ROOT/native-host/default-config.json" "$USER_CFG/config.json"
  fi
}

chrome_manifest_dirs() {
  if [[ "$OS" == "Darwin" ]]; then
    echo "$HOME_DIR/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    echo "$HOME_DIR/Library/Application Support/Chromium/NativeMessagingHosts"
    echo "$HOME_DIR/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
    echo "$HOME_DIR/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    echo "$HOME_DIR/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    echo "$HOME_DIR/Library/Application Support/Vivaldi/NativeMessagingHosts"
  else
    echo "$CONFIG_HOME/google-chrome/NativeMessagingHosts"
    echo "$CONFIG_HOME/google-chrome-unstable/NativeMessagingHosts"
    echo "$CONFIG_HOME/chromium/NativeMessagingHosts"
    echo "$CONFIG_HOME/microsoft-edge/NativeMessagingHosts"
    echo "$CONFIG_HOME/microsoft-edge-dev/NativeMessagingHosts"
    echo "$CONFIG_HOME/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    echo "$CONFIG_HOME/vivaldi/NativeMessagingHosts"
  fi
}

firefox_manifest_dir() {
  if [[ "$OS" == "Darwin" ]]; then
    echo "$HOME_DIR/Library/Application Support/Mozilla/NativeMessagingHosts"
  else
    echo "$HOME_DIR/.mozilla/native-messaging-hosts"
  fi
}

install_host() {
  chmod +x "$ROOT/native-host/host.sh" "$ROOT/native-host/index.js" || true
  local host_path="$ROOT/native-host/host.sh"
  if [[ -z "$EXT_ID" ]]; then
    echo
    echo "Enter your unpacked Chromium extension ID"
    echo "(chrome://extensions → Enhanced MPV → ID). Leave blank to fill later."
    printf "Extension ID: "
    read -r EXT_ID || true
  fi
  [[ -z "$EXT_ID" ]] && EXT_ID="oaholhjabdiapfijakeojjjoideniecl"
  local chrome_json
  chrome_json="$(sed -e "s|HOST_PATH|$host_path|g" -e "s|EXTENSION_ID|$EXT_ID|g" "$ROOT/native-host/manifests/chrome.json")"
  local ff_json
  ff_json="$(sed -e "s|HOST_PATH|$host_path|g" "$ROOT/native-host/manifests/firefox.json")"
  while IFS= read -r dir; do
    mkdir -p "$dir"
    printf '%s\n' "$chrome_json" > "$dir/$HOST_NAME.json"
    echo "Registered Chromium host: $dir/$HOST_NAME.json"
  done < <(chrome_manifest_dirs)
  local ff
  ff="$(firefox_manifest_dir)"
  mkdir -p "$ff"
  printf '%s\n' "$ff_json" > "$ff/$HOST_NAME.json"
  echo "Registered Firefox host: $ff/$HOST_NAME.json"
}

uninstall() {
  echo "Uninstalling Enhanced MPV host registration and copied scripts…"
  while IFS= read -r dir; do
    rm -f "$dir/$HOST_NAME.json"
  done < <(chrome_manifest_dirs)
  rm -f "$(firefox_manifest_dir)/$HOST_NAME.json"
  rm -f "$MPV_DIR/scripts/smart-sub-manager.lua" "$MPV_DIR/scripts/enhanced-mpv.lua"
  local latest
  latest="$(ls -1dt "$BACKUP_DIR"/* 2>/dev/null | head -n 1 || true)"
  if [[ -n "$latest" ]]; then
    cp -a "$latest/." "$MPV_DIR/" 2>/dev/null || true
    echo "Restored backup from $latest"
  fi
  echo "Left third-party ModernZ/thumbfast files and $USER_CFG in place."
}

main() {
  mkdir -p "$MPV_DIR" "$USER_CFG" "$BACKUP_DIR"
  if [[ "$UNINSTALL" = 1 ]]; then
    uninstall
    exit 0
  fi
  ensure_bins
  have mpv && have node || { echo "mpv and node are required."; exit 1; }
  echo "Generating browser-extension icons…"
  node "$ROOT/scripts/generate-icons.js"
  install_third_party
  copy_our_config
  pin_thumbfast
  write_user_config
  install_host
  echo
  echo "Done."
  echo "1. Chrome: chrome://extensions → Developer mode → Load unpacked → $ROOT/browser-extension"
  echo "2. If you entered a placeholder ID, re-run: $0 --extension-id YOUR_ID"
  echo "3. Health check: node \"$ROOT/native-host/doctor.js\""
  echo "4. Play a local file: mpv /path/to/video.mkv"
}

main
