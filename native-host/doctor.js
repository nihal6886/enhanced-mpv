"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { findMpv, isNativeMpv, ipcAlive, ipcPath } = require("./mpv-launcher");
const { configDir, configPath, readConfig } = require("./config");

function which(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  return (r.stdout || "").split(/\r?\n/).find(Boolean) || null;
}

function mpvConfigDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "mpv");
  }
  if (process.platform === "darwin") {
    const xdg = path.join(os.homedir(), ".config", "mpv");
    const mac = path.join(os.homedir(), ".mpv");
    if (fs.existsSync(path.join(xdg, "mpv.conf"))) return xdg;
    if (fs.existsSync(mac)) return xdg;
    return xdg;
  }
  return path.join(os.homedir(), ".config", "mpv");
}

function hostName() {
  return "com.enhanced.mpv.host";
}

function nativeManifestCandidates() {
  const name = hostName() + ".json";
  const home = os.homedir();
  if (process.platform === "win32") {
    return [
      "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + hostName(),
      "HKCU\\Software\\Chromium\\NativeMessagingHosts\\" + hostName(),
      "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\" + hostName(),
      "HKCU\\Software\\BraveSoftware\\Brave\\NativeMessagingHosts\\" + hostName(),
      "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\" + hostName(),
    ];
  }
  if (process.platform === "darwin") {
    return [
      path.join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts", name),
      path.join(home, "Library/Application Support/Chromium/NativeMessagingHosts", name),
      path.join(home, "Library/Application Support/Microsoft Edge/NativeMessagingHosts", name),
      path.join(home, "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts", name),
      path.join(home, "Library/Application Support/Mozilla/NativeMessagingHosts", name),
    ];
  }
  return [
    path.join(home, ".config/google-chrome/NativeMessagingHosts", name),
    path.join(home, ".config/chromium/NativeMessagingHosts", name),
    path.join(home, ".config/microsoft-edge/NativeMessagingHosts", name),
    path.join(home, ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts", name),
    path.join(home, ".mozilla/native-messaging-hosts", name),
  ];
}

// The doctor report is meant to be copy-pasted into a bug report, so strip
// credential material from the config it echoes.
function redactConfig(cfg) {
  const safe = { ...cfg };
  if (safe.opensubtitles && typeof safe.opensubtitles === "object") {
    safe.opensubtitles = {
      ...safe.opensubtitles,
      apiKey: safe.opensubtitles.apiKey ? "***" : "",
      password: safe.opensubtitles.password ? "***" : "",
    };
  }
  return safe;
}

function checkRegistry(key) {
  const r = spawnSync("reg", ["query", key], { encoding: "utf8", windowsHide: true });
  return r.status === 0;
}

// Pull mpv_path / network out of script-opts/thumbfast.conf so a broken
// thumbnail subprocess (blank path) is visible in the report.
function readThumbfast(cfgDir) {
  const conf = path.join(cfgDir, "script-opts", "thumbfast.conf");
  const out = { path: conf, exists: fs.existsSync(conf), mpvPath: "", network: "" };
  if (!out.exists) return out;
  try {
    for (const line of fs.readFileSync(conf, "utf8").split(/\r?\n/)) {
      const mpv = /^\s*mpv_path\s*=\s*(.*)$/.exec(line);
      if (mpv) out.mpvPath = mpv[1].trim();
      const net = /^\s*network\s*=\s*(.*)$/.exec(line);
      if (net) out.network = net[1].trim();
    }
  } catch {
    // unreadable conf - report what we have
  }
  return out;
}

function collectReport() {
  const mpv = findMpv();
  const node = process.execPath;
  const ytdl = which("yt-dlp") || which("youtube-dl");
  const ffmpeg = which("ffmpeg");
  const ffsubsync = which("ffsubsync");
  const alass = which("alass");
  const curl = which("curl");
  const iconv = which("iconv");
  const cfgDir = mpvConfigDir();
  const modernzScript = path.join(cfgDir, "scripts", "modernz.lua");
  const modernzConfig = path.join(cfgDir, "script-opts", "modernz.conf");
  const modernzIcons = path.join(cfgDir, "fonts", "modernz-icons.ttf");
  const modernz = fs.existsSync(modernzScript)
    && fs.existsSync(modernzConfig)
    && fs.existsSync(modernzIcons);
  const thumb = fs.existsSync(path.join(cfgDir, "scripts", "thumbfast.lua"));
  const thumbfastConf = readThumbfast(cfgDir);
  const iconPath = path.join(cfgDir, "enhanced-mpv.ico");
  const customIcon = fs.existsSync(iconPath);
  const subsel = fs.existsSync(path.join(cfgDir, "scripts", "sub-select.lua"));
  const smart = fs.existsSync(path.join(cfgDir, "scripts", "smart-sub-manager.lua"));
  const ipc = ipcPath();
  let ipcWritable = true;
  try {
    fs.mkdirSync(path.dirname(ipc.replace("\\\\.\\pipe\\", "C:\\")), { recursive: true });
  } catch {
    ipcWritable = process.platform === "win32";
  }
  const manifests = nativeManifestCandidates().map((entry) => {
    if (process.platform === "win32" && entry.startsWith("HK")) {
      return { path: entry, ok: checkRegistry(entry) };
    }
    return { path: entry, ok: fs.existsSync(entry) };
  });
  const report = {
    ok: Boolean(mpv && isNativeMpv(mpv) && node && modernz),
    error: !mpv ? "Native mpv.exe/mpv.com was not found"
      : (!isNativeMpv(mpv) ? "Resolved player is not native mpv"
        : (!modernz ? "ModernZ Lua/config/icon font are not installed" : null)),
    code: !mpv ? "MPV_NOT_FOUND" : (!modernz ? "MODERNZ_NOT_INSTALLED" : "OK"),
    command: [],
    mpv,
    node,
    nodeVersion: process.version,
    "yt-dlp": ytdl,
    ffmpeg,
    ffsubsync,
    alass,
    curl,
    iconv,
    mpvConfigDir: cfgDir,
    modernz,
    modernzScript,
    modernzConfig,
    modernzIcons,
    thumbfast: thumb,
    thumbfastConf,
    customIcon,
    iconPath,
    subSelect: subsel,
    smartSubManager: smart,
    ipcPath: ipc,
    ipcWritable,
    configPath: configPath(),
    config: redactConfig(readConfig()),
    configDir: configDir(),
    manifests,
    platform: process.platform,
    arch: process.arch,
    homedir: os.homedir(),
  };
  return report;
}

async function main() {
  const report = collectReport();
  let ipc = false;
  try {
    ipc = await ipcAlive();
  } catch {
    ipc = false;
  }
  report.ipcAlive = ipc;
  const lines = [
    "Enhanced MPV doctor",
    "===================",
    "platform:     " + report.platform + "/" + report.arch,
    "mpv:          " + (report.mpv || "MISSING"),
    "node:         " + report.node + " " + report.nodeVersion,
    "yt-dlp:       " + (report["yt-dlp"] || "missing (needed for YouTube/Vimeo)"),
    "ffmpeg:       " + (report.ffmpeg || "missing"),
    "curl:         " + (report.curl || "missing"),
    "iconv:        " + (report.iconv || "missing (encoding repair disabled)"),
    "ffsubsync:    " + (report.ffsubsync || "missing"),
    "alass:        " + (report.alass || "missing"),
    "mpv config:   " + report.mpvConfigDir,
    "ModernZ:      " + (report.modernz ? "ok" : "NOT INSTALLED (run scripts/install.ps1)"),
    "ModernZ Lua:  " + report.modernzScript,
    "ModernZ cfg:  " + report.modernzConfig,
    "ModernZ font: " + report.modernzIcons,
    "thumbfast:    " + (report.thumbfast ? "ok" : "NOT INSTALLED"),
    "thumbfast cfg: " + (report.thumbfastConf.exists
      ? "mpv_path=" + (report.thumbfastConf.mpvPath || "(blank - fix in installer)")
        + " network=" + (report.thumbfastConf.network || "(default)")
      : " missing"),
    "player icon:  " + (report.customIcon ? report.iconPath : "NOT INSTALLED (enhanced-mpv.ico)"),
    "sub-select:   " + (report.subSelect ? "ok" : "NOT INSTALLED"),
    "smart-sub:    " + (report.smartSubManager ? "ok" : "NOT INSTALLED"),
    "ipc:          " + report.ipcPath + (report.ipcAlive ? " (live)" : " (idle until mpv starts)")
      + (report.ipcWritable ? "" : " [not writable]"),
    "user config:  " + report.configPath,
    "native messaging registration:",
  ];
  for (const m of report.manifests) {
    lines.push("  " + (m.ok ? "[ok] " : "[  ] ") + m.path);
  }
  lines.push(report.ok
    ? "\nHealth check passed (native mpv and ModernZ installed)."
    : "\nHealth check FAILED (install native mpv and ModernZ, then rerun).");
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { collectReport, mpvConfigDir, nativeManifestCandidates, hostName };
