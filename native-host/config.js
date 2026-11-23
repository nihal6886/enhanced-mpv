"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function configDir() {
  if (process.env.ENHANCED_MPV_CONFIG_DIR) {
    return process.env.ENHANCED_MPV_CONFIG_DIR;
  }
  return path.join(os.homedir(), ".enhanced-mpv");
}

function configPath() {
  return path.join(configDir(), "config.json");
}

const DEFAULTS = {
  preferredSubtitleLanguages: ["eng", "spa"],
  nativeAudioLanguages: ["eng", "en"],
  opensubtitles: { apiKey: "", username: "", password: "" },
  videoQuality: "best",
  queueMode: "replace",
  autoIntercept: false,
  autoInterceptDomains: [],
  clipboardWatch: false,
  ytdlFormat: "bestvideo*+bestaudio/best",
  keepWarm: true,
  profiles: [
    { name: "Anime Upscale", mpvProfile: "anime-upscale" },
    { name: "Battery Saver", mpvProfile: "battery-saver" },
    { name: "Cinema HDR", mpvProfile: "cinema-hdr" },
  ],
};

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Ignore permissions/sandbox directory creation errors
  }
}

function readConfig() {
  ensureDir(configDir());
  const p = configPath();
  try {
    if (!fs.existsSync(p)) {
      try {
        fs.writeFileSync(p, JSON.stringify(DEFAULTS, null, 2), "utf8");
      } catch {
        // Ignore write failures in read-only/sandboxed environments
      }
      return { ...DEFAULTS };
    }
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return { ...DEFAULTS, ...parsed, opensubtitles: { ...DEFAULTS.opensubtitles, ...(parsed.opensubtitles || {}) } };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeConfig(next) {
  ensureDir(configDir());
  const merged = { ...readConfig(), ...next };
  if (next && next.opensubtitles) {
    merged.opensubtitles = { ...readConfig().opensubtitles, ...next.opensubtitles };
  }
  fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

function ipcPath() {
  if (process.env.ENHANCED_MPV_IPC_PATH) {
    return process.env.ENHANCED_MPV_IPC_PATH;
  }
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\enhanced-mpv-socket";
  }
  return path.join(configDir(), "mpv-socket");
}

function tempSubDir() {
  return path.join(os.tmpdir(), "enhanced-mpv-subs");
}

module.exports = {
  DEFAULTS,
  configDir,
  configPath,
  readConfig,
  writeConfig,
  ipcPath,
  tempSubDir,
  ensureDir,
};
