"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const https = require("https");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const { convertSubtitle } = require("./vtt-converter");
const { readConfig, ipcPath, tempSubDir, ensureDir, configDir } = require("./config");
const {
  isSafeUrl,
  isSafeLocalPath,
  sanitizeTitle,
  headerFields,
  ytdlSupported,
  joinHeaderFields,
} = require("./sanitizer");
const { startRelay, startMasterRelay, fetchWithHeaders } = require("./stream-relay");

let relayInProcess = false;

const RELAY_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\/(?:[a-z]+\/)?(index\.m3u8|master\.m3u8)/i;

const TEMP_SUB_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Cached mpv binary path - resolved once at startup, never re-probed on hot path
let cachedMpvBin = null;

function which(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  const line = (r.stdout || "").split(/\r?\n/).find(Boolean);
  return line || null;
}

function cleanStaleTempSubs() {
  const dir = tempSubDir();
  try {
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (st.isFile() && now - st.mtimeMs > TEMP_SUB_MAX_AGE_MS) fs.unlinkSync(full);
      } catch {
        // skip unreadable entry
      }
    }
  } catch {
    // best effort - never block playback on cleanup
  }
}

// Resolve mpv binary path ONCE at startup, cache in memory
function resolveMpvBin() {
  if (cachedMpvBin && fs.existsSync(cachedMpvBin)) return cachedMpvBin;
  
  const preferred = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || "", "Programs", "EnhancedMPV", "enhanced-mpv.exe")
    : "";
  if (preferred && fs.existsSync(preferred) && isNativeMpv(preferred)) {
    cachedMpvBin = preferred;
    return cachedMpvBin;
  }

  const env = process.env.MPV_PATH;
  if (env && fs.existsSync(env) && isNativeMpv(env)) {
    cachedMpvBin = env;
    return cachedMpvBin;
  }

  const found = [
    which("enhanced-mpv.exe"), which("enhanced-mpv"), which("mpv.exe"), which("mpv"),
  ]
    .find((candidate) => candidate && isNativeMpv(candidate) && !/\.com$/i.test(candidate));
  if (found) {
    cachedMpvBin = found;
    return cachedMpvBin;
  }
  
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const guesses = [
      path.join(local, "Programs", "EnhancedMPV", "enhanced-mpv.exe"),
      path.join(local, "Programs", "mpv", "mpv.exe"),
      path.join(local, "Programs", "mpv", "enhanced-mpv.exe"),
      path.join(local, "Microsoft", "WinGet", "Links", "mpv.exe"),
      path.join(local, "Microsoft", "WinGet", "Links", "enhanced-mpv.exe"),
      path.join(pf, "mpv", "mpv.exe"),
      path.join(pf86, "mpv", "mpv.exe"),
      "C:\\mpv\\mpv.exe",
      "C:\\mpv\\mpv.com",
    ];
    for (const p of guesses) {
      if (p && fs.existsSync(p)) {
        cachedMpvBin = p;
        return cachedMpvBin;
      }
    }
  }
  
  const guesses = ["/usr/bin/mpv", "/usr/local/bin/mpv", "/opt/homebrew/bin/mpv"];
  const foundUnix = guesses.find((p) => fs.existsSync(p));
  if (foundUnix) {
    cachedMpvBin = foundUnix;
    return cachedMpvBin;
  }
  
  return null;
}

function downloadBuffer(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!isSafeUrl(url)) {
      reject(new Error("unsafe subtitle url"));
      return;
    }
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { headers: headers || {}, timeout: timeoutMs || 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch {
          reject(new Error("unsafe redirect target"));
          return;
        }
        if (!isSafeUrl(next)) {
          reject(new Error("unsafe redirect target"));
          return;
        }
        downloadBuffer(next, headers, timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error("download failed: " + res.statusCode));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
  });
}

function langFromSub(sub, index) {
  const lang = String(sub.language || sub.lang || "und")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .slice(0, 8) || "und";
  return lang || ("trk" + index);
}

async function materializeSubtitles(payload) {
  const subs = Array.isArray(payload.subtitles) ? payload.subtitles : [];
  const dir = tempSubDir();
  ensureDir(dir);
  const headers = {};
  const fields = headerFields(payload);
  for (const f of fields) {
    const idx = f.indexOf(":");
    if (idx > 0) headers[f.slice(0, idx).trim()] = f.slice(idx + 1).trim();
  }
  const downloaded = await Promise.all(subs.map(async (sub, i) => {
    if (!sub || !sub.url || !isSafeUrl(sub.url)) return null;
    try {
      const buf = await downloadBuffer(sub.url, headers, 10000);
      const text = buf.toString("utf8");
      const converted = convertSubtitle(text, sub.url);
      const lang = langFromSub(sub, i);
      const dest = path.join(dir, "web-" + crypto.randomUUID() + "." + lang + ".srt");
      const resolved = path.resolve(dest);
      if (!resolved.startsWith(path.resolve(dir) + path.sep)) return null;
      fs.writeFileSync(resolved, converted, "utf8");
      return resolved;
    } catch {
      // skip failed subtitle
    }
    return null;
  }));
  return downloaded.filter(Boolean);
}

function resolveYtdlFormat(payload, cfg) {
  const raw = String(payload.ytdlFormat || cfg.ytdlFormat || "").trim();
  if (raw && raw !== "best" && raw !== "bestvideo*+bestaudio/best") {
    const clean = raw.replace(/[^\w*+./<>=?[\]-]/g, "");
    if (clean) return clean;
  }
  const q = String(payload.quality || cfg.videoQuality || "").trim().toLowerCase();
  const height = /^(2160|4k|uhd)$/.test(q) ? "2160"
    : /^(1440|2k|qhd)$/.test(q) ? "1440"
      : /^(1080|fhd|fullhd)$/.test(q) ? "1080"
        : /^(720|hd)$/.test(q) ? "720"
          : /^\d{3,4}$/.test(q) ? q
            : "2160";
  // Reliable format: bestvideo + bestaudio without container restriction to avoid
  // audio-only or broken streams on newer YouTube videos.
  // Prefer non-AV1 codecs for hardware decode compatibility.
  return "bestvideo[height<=" + height + "][vcodec!*=av01]+bestaudio/bestvideo[height<=1080]+bestaudio/best";
}

function isNativeMpv(bin) {
  const value = String(bin || "");
  // Split on both separators so Windows paths are recognised on every host OS.
  const base = value.split(/[\\/]/).pop();
  return /^(?:enhanced-)?mpv(?:\.exe|\.com)?$/i.test(base)
    && !/(^|[\\/])mpv\.net([\\/]|$)/i.test(value);
}

// Resume only from a real mid-playback position: > 3 s in, a finite duration
// over 15 s, and at least 10 s before the end. Returns whole seconds or 0.
function resumeStart(startTime, duration) {
  const s = Number(startTime);
  const d = Number(duration);
  if (!Number.isFinite(s) || !Number.isFinite(d)) return 0;
  if (s > 3 && d > 15 && s < d - 10) return Math.floor(s);
  return 0;
}

function authHeaderObject(audioHeaders) {
  const h = audioHeaders || {};
  const out = {};
  const pick = (...keys) => {
    for (const key of keys) {
      if (h[key]) return h[key];
      const match = Object.keys(h).find((name) => name.toLowerCase() === key.toLowerCase());
      if (match && h[match]) return h[match];
    }
    return "";
  };
  const referer = pick("referer");
  const origin = pick("origin");
  const userAgent = pick("userAgent", "user-agent");
  const cookie = pick("cookie");
  if (referer) out.Referer = referer;
  if (origin) out.Origin = origin;
  if (userAgent) out["User-Agent"] = userAgent;
  if (cookie) out.Cookie = cookie;
  return out;
}

const FAST_START_OPTIONS = {
  "demuxer-lavf-analyzeduration": "0.5",
  "demuxer-lavf-probesize": "262144",
  "cache": "yes",
  "cache-secs": "15",
  "demuxer-readahead-secs": "5",
  "hls-bitrate": "max",
  "cache-pause-initial": "no",
  "initial-audio-sync": "no",
};

function buildArgs(payload, subFiles, _mpvBin) {
  const cfg = readConfig();
  const args = [];
  // --force-window=immediate MUST be the very first flag for instant window creation
  args.push("--force-window=immediate");
  args.push("--no-terminal");
  args.push("--input-ipc-server=" + ipcPath());
  for (const [key, value] of Object.entries(FAST_START_OPTIONS)) {
    args.push("--" + key + "=" + value);
  }
  const title = sanitizeTitle(payload.title || "");
  if (title) args.push("--force-media-title=" + title);
  const headers = headerFields(payload);
  const url = payload.url;
  const audioUrl = payload.audioUrl;
  const isDirectStream = /\.(m3u8|mpd|mp4|mkv|webm)(?:$|[?#])/i.test(url);
  const isRelayUrl = RELAY_URL_RE.test(url);
  const isMasterRelay = payload.isMasterRelay === true;
  const relayedAudioUrl = payload.relayedAudioUrl;
  const audioIsRelayUrl = Boolean(relayedAudioUrl && RELAY_URL_RE.test(relayedAudioUrl));

  // mpv forwards --http-header-fields to libavformat itself (real CRLF
  // separators) for the manifest and every HLS/DASH segment, so the headers
  // are not duplicated into --demuxer-lavf-o.
  if (headers.length) args.push("--http-header-fields=" + joinHeaderFields(headers));

  // A separate audio track is paired: ffmpeg must be allowed to read every
  // extension so the audio .m3u8/.aac/.m4a is never skipped. -append keeps the
  // reconnect/persistent options from mpv.conf instead of replacing the list.
  const hasSeparateAudio = Boolean(audioUrl && !isMasterRelay);
  if (isRelayUrl || audioIsRelayUrl || hasSeparateAudio) {
    args.push("--demuxer-lavf-o-append=allowed_extensions=ALL");
  }
  const profile = payload.profile || payload.mpvProfile;
  if (profile && /^[a-zA-Z0-9._-]+$/.test(profile)) {
    args.push("--profile=" + profile);
  }
  if (ytdlSupported(url)) {
    // Let yt-dlp resolve the page: cap resolution, pull English auto-captions, and
    // match sidecar subtitles loosely so YouTube opens fast with subs ready.
    args.push("--ytdl-format=" + resolveYtdlFormat(payload, cfg));
    args.push("--ytdl-raw-options=no-playlist=,no-check-certificates=,write-auto-subs=,sub-langs=en.*");
    args.push("--sub-auto=fuzzy");
  } else if (isDirectStream || isRelayUrl) {
    // Direct manifest/media URLs or relay URLs: skip yt-dlp entirely
    args.push("--ytdl=no");
    // Video-only stream + separate audio: mpv prefers external tracks during
    // auto-selection, so --audio-file is picked without forcing --aid.
    if (hasSeparateAudio) {
      const needsRelay = Object.keys(authHeaderObject(payload.audioHeaders)).length > 0;
      const externalAudio = (needsRelay && relayedAudioUrl) ? relayedAudioUrl : audioUrl;
      args.push("--audio-file=" + externalAudio);
    }
  }
  for (const f of subFiles) {
    if (isSafeLocalPath(f)) args.push("--sub-file=" + f);
  }
  // No --sid: track IDs number embedded tracks first, so a fixed ID would pick
  // an embedded subtitle; mpv's auto-selection prefers external sub files.
  // The browser position is authoritative: never let watch-later resume
  // (save-position-on-quit) override it.
  args.push("--resume-playback=no");
  const start = resumeStart(payload.startTime, payload.duration);
  if (start > 0) args.push("--start=+" + String(start));
  // Keep the media URL last so mpv parses it as the input, not as an option value.
  if (url) args.push(url);
  return args;
}

function ipcCandidates() {
  const primary = ipcPath();
  const homeSock = path.join(os.homedir(), ".enhanced-mpv", "mpv-socket");
  // On Windows, the named pipe \\.\pipe\enhanced-mpv-socket is the primary IPC
  // endpoint used by mpv-launcher. Check it FIRST before Unix socket paths.
  const extra = process.platform === "win32"
    ? ["\\\\.\\pipe\\enhanced-mpv-socket", "\\\\.\\pipe\\enhanced-mpv", homeSock]
    : [homeSock, "/tmp/enhanced-mpv.sock"];
  return [...new Set([primary, ...extra])];
}

function connectIpc(target) {
  return process.platform === "win32" ? net.connect(target) : net.connect({ path: target });
}

let ipcRequestSeq = 0;

// Send one JSON IPC command and resolve with its reply. mpv broadcasts events
// to every client, so the reply is matched by request_id instead of taking
// whatever line arrives first.
function sendIpc(command, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const requestId = 1000 + (++ipcRequestSeq % 1000000);
    const sock = connectIpc(target);
    let buf = "";
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.end();
      sock.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => done(new Error("ipc timeout")), timeoutMs || 500);
    sock.on("connect", () => sock.write(JSON.stringify({ command, request_id: requestId }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message && message.request_id === requestId) {
          done(null, message);
          return;
        }
      }
    });
    sock.on("error", (err) => done(err));
  });
}

async function sendScriptMessage(message, target, timeoutMs, ...args) {
  return sendIpc(["script-message", message, ...args], target, timeoutMs || 300);
}

function pidFilePath() {
  return path.join(configDir(), "mpv.pid");
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

// Guard against PID reuse: only treat a recorded PID as ours when the process
// image is still an mpv binary.
function processLooksLikeMpv(pid) {
  try {
    if (process.platform === "linux") {
      const cmd = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\0")[0] || "";
      return isNativeMpv(cmd);
    }
    if (process.platform === "win32") {
      const r = spawnSync("tasklist", ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 2000 });
      const name = ((r.stdout || "").match(/^"([^"]+)"/m) || [])[1] || "";
      return isNativeMpv(name);
    }
    const r = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8", timeout: 2000 });
    return isNativeMpv((r.stdout || "").trim());
  } catch {
    return false;
  }
}

function readPidFile() {
  try {
    const pid = parseInt(fs.readFileSync(pidFilePath(), "utf8").trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function forceKill(pid) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true, timeout: 3000 });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isProcessAlive(pid);
}

// Cleanly end the running Enhanced MPV instance before a fresh spawn: ask it
// to quit over IPC, then force-kill only the exact process we launched (from
// IPC `pid` or the pid file). Unrelated mpv windows are never touched.
async function terminateMpv(target) {
  const pids = new Set();
  if (target) {
    try {
      const r = await sendIpc(["get_property", "pid"], target, 300);
      if (r && r.error === "success" && Number.isInteger(r.data)) pids.add(r.data);
    } catch {
      // unresponsive IPC; fall back to the pid file
    }
    try {
      await sendIpc(["quit"], target, 300);
    } catch {
      // ignore
    }
  }
  const recorded = readPidFile();
  if (recorded && processLooksLikeMpv(recorded)) pids.add(recorded);
  for (const pid of pids) {
    if (await waitForExit(pid, 1500)) continue;
    appendLaunchLog("[" + new Date().toISOString() + "] mpv pid " + pid + " unresponsive; terminating");
    forceKill(pid);
    await waitForExit(pid, 1500);
  }
  try { fs.unlinkSync(pidFilePath()); } catch { /* none */ }
  if (process.platform !== "win32") {
    try { fs.unlinkSync(ipcPath()); } catch { /* none */ }
  }
}

let liveIpc = null;

async function ipcAlive() {
  const targets = ipcCandidates();
  // Retry up to 3 times with 50ms delay to handle race where mpv is starting
  // but IPC socket isn't ready yet.
  for (let attempt = 0; attempt < 3; attempt++) {
    const checks = targets.map(async (target) => {
      const r = await sendIpc(["get_property", "mpv-version"], target, 300);
      if (r && (r.error === "success" || r.data)) return { target, r };
      throw new Error("mpv IPC unavailable");
    });
    try {
      const result = await Promise.any(checks);
      if (result && result.target) {
        liveIpc = result.target;
        return true;
      }
    } catch {
      // No active mpv IPC endpoint; retry or proceed.
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  liveIpc = null;
  return false;
}

function classifyError(stderr) {
  const s = String(stderr || "").toLowerCase();
  if (s.includes("drm") || s.includes("widevine")) return "DRM";
  if (s.includes("401") || s.includes("403") || s.includes("expired")) return "EXPIRED";
  if (s.includes("unable to open") || s.includes("failed to recognize")) return "BAD_URL";
  return "LAUNCH_FAILED";
}

function launchLogPath() {
  return path.join(configDir(), "last-launch.log");
}

const LAUNCH_LOG_MAX_BYTES = 256 * 1024;

function appendLaunchLog(text) {
  try {
    ensureDir(configDir());
    const p = launchLogPath();
    try {
      if (fs.statSync(p).size > LAUNCH_LOG_MAX_BYTES) fs.writeFileSync(p, "", "utf8");
    } catch {
      // no existing log yet
    }
    fs.appendFileSync(p, text + "\n", "utf8");
  } catch {
    // never block playback on logging
  }
}

function publicCommand(mpvBin, args) {
  return [mpvBin].concat(args.map((a) => {
    if (typeof a !== "string") return a;
    const lower = a.toLowerCase();
    if (lower.startsWith("--http-header-fields=")) {
      return "--http-header-fields=<redacted>";
    }
    if (lower.startsWith("--demuxer-lavf-o=headers=")) {
      return a.replace(/=headers=.*/, "=headers=<redacted>");
    }
    return a;
  }));
}

function redactStderr(text) {
  return String(text)
    .replace(/((?:cookie|authorization|proxy-authorization|referer|user-agent)\s*:\s*)[^\r\n]*/gi, "$1<redacted>")
    .replace(/((?:cookie|authorization|proxy-authorization|referer|user-agent)\s*=\s*)[^,\r\n]*/gi, "$1<redacted>")
    .replace(/--demuxer-lavf-o=headers=[^\s]*/gi, "--demuxer-lavf-o=headers=<redacted>");
}

function spawnMpv(mpvBin, args, spawnStartMs, options = {}) {
  ensureDir(configDir());
  const logFile = path.join(configDir(), "mpv-runtime.log");
  const mpvArgs = [...args, "--log-file=" + logFile];
  const started = spawnStartMs || Date.now();
  if (process.platform === "win32" && options.visible === true) {
    // Native Messaging processes can be placed in the browser's Job Object.
    // Start-Process creates the player as a separate user process so it stays
    // alive after the short-lived host exits, with a visible normal window.
    const psQuote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
    const winQuote = (value) => {
      const s = String(value);
      if (!/[\s"]/.test(s)) return s;
      return '"' + s.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1") + '"';
    };
    const visibleArgs = mpvArgs.filter((arg) => !arg.startsWith("--force-window=") && !arg.startsWith("--window-minimized="));
    visibleArgs.unshift("--window-minimized=no", "--force-window=yes");
    const argumentLine = visibleArgs.map(winQuote).join(" ");
    const script = "$p=Start-Process -FilePath " + psQuote(mpvBin) + " -ArgumentList " + psQuote(argumentLine) +
      " -PassThru -WindowStyle Normal; [Console]::Out.WriteLine($p.Id)";
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 10000,
    });
    if (result.error || result.status !== 0) {
      throw result.error || new Error(String(result.stderr || "Start-Process failed").trim());
    }
    const pid = Number(String(result.stdout || "").trim().split(/\r?\n/).pop());
    if (pid) {
      try { fs.writeFileSync(pidFilePath(), String(pid), "utf8"); } catch { /* best effort */ }
    }
    appendLaunchLog("[" + new Date().toISOString() + "] detached mpv spawned pid=" + (pid || "unknown"));
    appendLaunchLog("[" + new Date().toISOString() + "] spawn_ms=" + (Date.now() - started) + " " +
      JSON.stringify(publicCommand(mpvBin, visibleArgs)));
    return;
  }
  const child = spawn(mpvBin, mpvArgs, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: false, // MUST be false for instant foreground window
    shell: false,
    env: {
      ...process.env,
      HOME: os.homedir(),
    },
  });
  if (child.pid) {
    try { fs.writeFileSync(pidFilePath(), String(child.pid), "utf8"); } catch { /* best effort */ }
  }
  const spawnMs = Date.now() - started;
  appendLaunchLog("[" + new Date().toISOString() + "] spawn_ms=" + spawnMs + " " +
    JSON.stringify(publicCommand(mpvBin, mpvArgs)));
  let stderrBuffer = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk;
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || "";
    for (const line of lines) {
      if (line) appendLaunchLog("[" + new Date().toISOString() + "] stderr: " + redactStderr(line.slice(0, 4000)));
    }
  });
  const stderrUnrefTimer = setTimeout(() => child.stderr.unref(), 5000);
  stderrUnrefTimer.unref();
  child.on("error", (err) => {
    appendLaunchLog("[" + new Date().toISOString() + "] spawn error: " +
      String((err && err.message) || err));
  });
  child.on("close", (code, signal) => {
    clearTimeout(stderrUnrefTimer);
    if (stderrBuffer) {
      appendLaunchLog("[" + new Date().toISOString() + "] stderr: " + redactStderr(stderrBuffer.slice(0, 4000)));
    }
    appendLaunchLog("[" + new Date().toISOString() + "] process exit code=" +
      String(code) + " signal=" + String(signal || ""));
    if (readPidFile() === child.pid) {
      try { fs.unlinkSync(pidFilePath()); } catch { /* none */ }
    }
  });
  child.unref();
  return child;
}

// Per-file options passed through `loadfile ... <options>` so a reused window
// plays the new stream with its own headers, title, yt-dlp settings, paired
// audio, and subtitles. mpv restores them when the file ends, and the
// defaults below override anything the window was originally spawned with
// (e.g. --ytdl=no or --audio-file from a previous direct-stream launch).
const PER_FILE_OPTIONS = new Set([
  "http-header-fields",
  "force-media-title",
  "ytdl",
  "ytdl-format",
  "ytdl-raw-options",
  "sub-auto",
  "sid",
  "resume-playback",
  "demuxer-lavf-analyzeduration",
  "demuxer-lavf-probesize",
  "cache",
  "cache-secs",
  "demuxer-readahead-secs",
  "hls-bitrate",
  "cache-pause-initial",
  "initial-audio-sync",
]);

function loadfilePlan(args) {
  const options = {
    ytdl: "yes",
    "http-header-fields": "",
    "force-media-title": "",
    sid: "auto",
    "resume-playback": "no",
    ...FAST_START_OPTIONS,
  };
  let profile = null;
  let lavfAppend = null;
  const audioFiles = [];
  const subFiles = [];
  for (const a of args.slice(0, -1)) {
    const m = /^--([a-z0-9-]+)=(.*)$/is.exec(a);
    if (!m) continue;
    const [, key, value] = m;
    if (PER_FILE_OPTIONS.has(key)) options[key] = value;
    else if (key === "audio-file") audioFiles.push(value);
    else if (key === "sub-file") subFiles.push(value);
    else if (key === "profile") profile = value;
    else if (key === "demuxer-lavf-o-append") lavfAppend = value;
  }
  // -append takes one item verbatim, so URLs containing ':' survive (the
  // plain list options split on the platform path separator).
  if (audioFiles.length) options["audio-files-append"] = audioFiles[0];
  if (subFiles.length) options["sub-files-append"] = subFiles[0];
  return { options, audioFiles, subFiles, profile, lavfAppend };
}

// Replace (or append to) the playlist of a running mpv over IPC:
 //   loadfile <url> <mode> -1 { start, headers, audio, subs, ... }
 // then unpause (keep-open-pause leaves the old file paused at EOF). Every
 // track travels with the playlist entry, so queued items keep theirs too.
 // Rejects when mpv refuses the command (e.g. mpv < 0.38 without the index
 // argument) so the caller can fall back to a clean respawn.
async function loadFileIpc(url, mode, startTime, target, extra) {
    const opts = extra || {};
    const options = { ...(opts.options || {}) };
    // Popup/content.js already validate resume positions (>3s, >15s duration, <duration-10s).
    // Only apply resumeStart filter for context-menu / auto-intercept launches that bypass popup.
    const start = (opts.startTimeSource && opts.startTimeSource !== "none") ? Math.floor(startTime) : resumeStart(startTime, opts.duration);
    // Always explicit: an unset start would inherit a CLI --start from the
    // original spawn or let watch-later resume override the browser position.
    options.start = start > 0 ? String(start) : "none";

    // 1. Open window immediately: force-window=yes, focus, loading screen BEFORE loadfile
    //    Guaranteed IPC execution order with JSON reply verification
    await sendIpc(["set_property", "force-window", "yes"], target, 300);
    await sendIpc(["set_property", "pause", false], target, 300);
    await sendIpc(["set_property", "window-minimized", false], target, 300);

    // 2. Fire the loading-screen splash AND focus message (60 fps ASS overlay) while ytdl_hook resolves
    await sendScriptMessage("enhanced-mpv-focus", target, 300);
    await sendScriptMessage("enhanced-mpv-loading", target, 300, sanitizeTitle(opts.title || ""));

    // 3. Load the file with per-file options. Log exact IPC command and response.
    const loadfileCmd = ["loadfile", url, mode, -1, options];
    appendLaunchLog("[" + new Date().toISOString() + "] loadFileIpc loadfile cmd: " + JSON.stringify(loadfileCmd));
    let r = await sendIpc(loadfileCmd, target, 3000);
    appendLaunchLog("[" + new Date().toISOString() + "] loadFileIpc loadfile resp: " + JSON.stringify(r));
    if (!r || r.error !== "success") {
      const errMsg = String(r && r.error);
      appendLaunchLog("[" + new Date().toISOString() + "] loadfile with index failed: " + errMsg);
      if (errMsg.includes("invalid parameter")) {
        appendLaunchLog("[" + new Date().toISOString() + "] retrying loadfile without index (older mpv)");
        const loadfileCmdNoIdx = ["loadfile", url, mode, options];
        appendLaunchLog("[" + new Date().toISOString() + "] loadfile cmd (no idx): " + JSON.stringify(loadfileCmdNoIdx));
        r = await sendIpc(loadfileCmdNoIdx, target, 3000);
        appendLaunchLog("[" + new Date().toISOString() + "] loadfile resp (no idx): " + JSON.stringify(r));
        if (!r || r.error !== "success") {
          throw new Error("ipc loadfile rejected (no index): " + String(r && r.error));
        }
      } else {
        throw new Error("ipc loadfile rejected: " + errMsg);
      }
    }
    if (mode !== "append" && mode !== "append-play") {
      await sendIpc(["set_property", "pause", false], target, 500).catch(() => {});
    }
    return true;
  }

async function replaceViaIpc(payload, args, target, wantQueue) {
  const plan = loadfilePlan(args);
  if (plan.profile) await sendIpc(["apply-profile", plan.profile], target, 500).catch(() => {});
  if (plan.lavfAppend) {
    await sendIpc(["change-list", "demuxer-lavf-o", "append", plan.lavfAppend], target, 500).catch(() => {});
  }
  // Drop external tracks a CLI spawn added globally so they never attach to
  // the next video (loaded tracks of the current file are unaffected).
  await sendIpc(["change-list", "audio-files", "clr", ""], target, 500).catch(() => {});
  await sendIpc(["change-list", "sub-files", "clr", ""], target, 500).catch(() => {});
  await loadFileIpc(payload.url, wantQueue ? "append-play" : "replace", payload.startTime, target, {
    duration: payload.duration,
    startTimeSource: payload.startTimeSource,
    title: payload.title,
    options: plan.options,
  });
  if (wantQueue) return;
  await Promise.allSettled([
    sendScriptMessage("bring-to-front", target),
  ]);
  // Portable raise for X11/Wayland/macOS (window-icon.lua only raises on
  // Windows): a brief ontop toggle makes the window manager restack it.
  try {
    const ontop = await sendIpc(["get_property", "ontop"], target, 300);
    if (ontop && ontop.error === "success" && ontop.data === false) {
      await sendIpc(["set_property", "ontop", true], target, 300);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await sendIpc(["set_property", "ontop", false], target, 300);
    }
  } catch {
    // best effort
  }
}

// Wait until mpv has a file loaded (optionally a specific path) before
// attaching extra tracks; `audio-add`/`sub-add` fail while still loading.
async function waitForLoadedFile(target, expectedPath, attempts) {
  for (let i = 0; i < (attempts || 40); i++) {
    try {
      const idle = await sendIpc(["get_property", "idle-active"], target, 300);
      if (idle && idle.error === "success" && idle.data === false) {
        if (!expectedPath) return true;
        const p = await sendIpc(["get_property", "path"], target, 300);
        if (p && p.error === "success" && p.data === expectedPath) return true;
      }
    } catch {
      // IPC may still be starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function attachSubtitlesWhenReady(files, target) {
  if (!files.length) return;
  if (!(await waitForLoadedFile(target, null, 20))) {
    appendLaunchLog("[" + new Date().toISOString() + "] subtitle attach skipped: mpv IPC did not become ready");
    return;
  }
  for (const file of files) {
    try { await sendIpc(["sub-add", file, "select"], target); } catch { /* skip */ }
  }
}

function setRelayInProcess(value) {
  relayInProcess = Boolean(value);
}

function relayDaemonCommand(configPath) {
  const isNode = !process.pkg && /^node(?:\.exe)?$/i.test(path.basename(process.execPath));
  const args = ["--relay-config", configPath];
  if (isNode) args.unshift(path.join(__dirname, "index.js"));
  return { bin: process.execPath, args };
}

function startRelayDaemon(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    ensureDir(configDir());
    const id = crypto.randomBytes(8).toString("hex");
    const configPath = path.join(os.tmpdir(), "enhanced-mpv-relay-" + id + ".json");
    const resultPath = path.join(os.tmpdir(), "enhanced-mpv-relay-" + id + ".result.json");
    const cleanup = () => {
      for (const p of [configPath, resultPath]) {
        try { fs.unlinkSync(p); } catch { /* no file */ }
      }
    };
    let child;
    let timer = null;
    let poller = null;
    let settled = false;
    const readResult = () => {
      try {
        return JSON.parse(fs.readFileSync(resultPath, "utf8"));
      } catch {
        return null;
      }
    };
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      cleanup();
      if (err) {
        const message = String((err && err.message) || err);
        appendLaunchLog("[" + new Date().toISOString() + "] relay daemon error: " + message);
        try { child.kill(); } catch { /* already gone */ }
        reject(err);
      } else {
        try { child.unref(); } catch { /* ignore */ }
        resolve(value);
      }
    };
    const check = () => {
      const reply = readResult();
      if (!reply) return;
      if (reply.ok) finish(null, reply);
      else finish(new Error(reply.error || "relay daemon failed"));
    };
    try {
      fs.writeFileSync(configPath, JSON.stringify({ ...request, resultPath }), { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      cleanup();
      reject(err);
      return;
    }
    try {
      const command = relayDaemonCommand(configPath);
      child = spawn(command.bin, command.args, { detached: true, stdio: "ignore", windowsHide: true });
    } catch (err) {
      cleanup();
      reject(err);
      return;
    }
    child.on("error", (err) => finish(err));
    child.on("exit", (code) => {
      setTimeout(() => {
        if (settled) return;
        if (readResult()) check();
        else finish(new Error("relay daemon exited with code " + code));
      }, 50);
    });
    poller = setInterval(check, 20);
    timer = setTimeout(() => finish(new Error("relay daemon timeout")), timeoutMs || 5000);
  });
}

async function relaySingle(url, headers) {
  try {
    if (relayInProcess) return await startRelay(url, headers);
    const reply = await startRelayDaemon({ kind: "single", url, headers });
    return reply.relayUrl;
  } catch (err) {
    const message = String((err && err.message) || err);
    appendLaunchLog("[" + new Date().toISOString() + "] relay failed: " + message);
    if (relayInProcess) throw err;
    return startRelay(url, headers);
  }
}

async function relayMaster(videoUrl, videoHeaders, audioUrl, audioHeaders) {
  try {
    if (relayInProcess) {
      const result = await startMasterRelay(videoUrl, videoHeaders, audioUrl, audioHeaders);
      return result.masterRelayUrl;
    }
    const reply = await startRelayDaemon({ kind: "master", videoUrl, videoHeaders, audioUrl, audioHeaders });
    return reply.masterRelayUrl;
  } catch (err) {
    const message = String((err && err.message) || err);
    appendLaunchLog("[" + new Date().toISOString() + "] master relay failed: " + message);
    throw err;
  }
}

function headerObject(fields) {
  const out = {};
  for (const h of fields) {
    const idx = h.indexOf(":");
    if (idx > 0) out[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  return out;
}

async function prepareLaunch(payload, localSubFiles, mpvBin, mode) {
  const url = payload && payload.url;
  const cfg = readConfig();
  const queueHint = mode || (payload && payload.action) || cfg.queueMode || "replace";
  const wantQueue = queueHint === "queue";
  const audioUrl = payload.audioUrl && isSafeUrl(payload.audioUrl) ? payload.audioUrl : null;
  const audioAuth = authHeaderObject(payload.audioHeaders);
  const videoHeaders = headerFields(payload);
  const videoIsHls = /\.m3u8(?:$|[?#])/i.test(url);
  const audioIsHls = Boolean(audioUrl && /\.m3u8(?:$|[?#])/i.test(audioUrl));
  const needsVideoRelay = videoIsHls && videoHeaders.some((h) => /^(Cookie|Referer|Origin|User-Agent):/i.test(h));
  const needsAudioRelay = audioIsHls && Object.keys(audioAuth).length > 0;
  const launchPayload = { ...payload, audioUrl };

  appendLaunchLog("[" + new Date().toISOString() + "] play mode=" + (wantQueue ? "queue" : "replace") +
    " startTime=" + resumeStart(payload.startTime, payload.duration) +
    " duration=" + (Number.isFinite(Number(payload.duration)) ? Number(payload.duration) : 0) +
    " source=" + String(payload.startTimeSource || "none").slice(0, 200) +
    " url=" + String(url).replace(/[?&](?:sign|token|KEY\d+)=[^&]*/g, "<redacted>") +
    " audioUrl=" + String(audioUrl || "").replace(/[?&](?:sign|token|KEY\d+)=[^&]*/g, "<redacted>"));

  if (videoIsHls && audioIsHls && (needsVideoRelay || needsAudioRelay)) {
    try {
      const masterRelayUrl = await relayMaster(url, headerObject(videoHeaders), audioUrl, audioAuth);
      launchPayload.url = masterRelayUrl;
      launchPayload.isMasterRelay = true;
      appendLaunchLog("[" + new Date().toISOString() + "] started master relay: " + masterRelayUrl);
    } catch (err) {
      const detail = String((err && err.message) || err);
      appendLaunchLog("[" + new Date().toISOString() + "] Failed to start authenticated relay for split HLS stream: " + detail);
      return { failure: { ok: false, error: "Failed to start authenticated relay for split HLS stream: " + detail, code: "RELAY_FAILED", command: [] } };
    }
  } else if (needsAudioRelay) {
    try {
      launchPayload.relayedAudioUrl = await relaySingle(audioUrl, audioAuth);
      appendLaunchLog("[" + new Date().toISOString() + "] started audio relay: " + launchPayload.relayedAudioUrl);
    } catch (err) {
      appendLaunchLog("[" + new Date().toISOString() + "] audio relay failed, using direct: " + String(err));
      launchPayload.relayedAudioUrl = audioUrl;
    }
  }

  const args = buildArgs(launchPayload, localSubFiles, mpvBin);
  return { launchPayload, args, command: publicCommand(mpvBin, args), wantQueue };
}

async function play(payload, mode) {
  const url = payload && payload.url;
  if (!isSafeUrl(url) && !(url && isSafeLocalPath(url) && !String(url).includes("://"))) {
    return { ok: false, error: "Rejected URL", code: "BAD_URL", command: [] };
  }
  const mpvBin = resolveMpvBin();
  if (!mpvBin) {
    return { ok: false, error: "mpv was not found on PATH", code: "MPV_NOT_FOUND", command: [] };
  }
  setTimeout(cleanStaleTempSubs, 0);
  const subtitleFilesPromise = materializeSubtitles(payload).catch((err) => {
    appendLaunchLog("[" + new Date().toISOString() + "] subtitle download failed: " +
      String((err && err.message) || err));
    return [];
  });
  const localSubFiles = Array.isArray(payload.subtitleFiles)
    ? payload.subtitleFiles.filter(isSafeLocalPath)
    : [];
  const prepared = await prepareLaunch(payload, localSubFiles, mpvBin, mode);
  if (prepared.failure) return prepared.failure;
  const { launchPayload, args, command, wantQueue } = prepared;
  ensureDir(configDir());

  if (await ipcAlive()) {
    const target = liveIpc || ipcPath();
    try {
      await replaceViaIpc(launchPayload, args, target, wantQueue);
      appendLaunchLog("[" + new Date().toISOString() + "] IPC " + (wantQueue ? "append-play" : "replace") + " ok");
      void subtitleFilesPromise.then((files) => attachSubtitlesWhenReady(files, target));
      publishSources(payload, launchPayload.url, target);
      if (!wantQueue) {
        const fallbacks = (Array.isArray(payload.candidates) ? payload.candidates : [])
          .filter((c) => c && streamKey(c.url) !== streamKey(payload.url))
          .slice(0, 2);
        void monitorAndFailover(payload, launchPayload.url, target, fallbacks, mode, 0);
      }
      return { ok: true, error: null, code: "OK", command, queued: wantQueue, reused: true, playUrl: launchPayload.url };
    } catch (err) {
      appendLaunchLog("[" + new Date().toISOString() + "] IPC replace failed, respawning: " +
        String((err && err.message) || err));
      await terminateMpv(target);
    }
  } else {
    await terminateMpv(null);
  }

  try {
    spawnMpv(mpvBin, args, Date.now(), { visible: true });
    void subtitleFilesPromise.then((files) => attachSubtitlesWhenReady(files, ipcPath())).catch((err) => {
      appendLaunchLog("[" + new Date().toISOString() + "] subtitle attach failed: " +
        String((err && err.message) || err));
    });
    const target = ipcPath();
    publishSources(payload, launchPayload.url, target);
    if (!wantQueue) {
      const fallbacks = (Array.isArray(payload.candidates) ? payload.candidates : [])
        .filter((c) => c && streamKey(c.url) !== streamKey(payload.url))
        .slice(0, 2);
      void monitorAndFailover(payload, launchPayload.url, target, fallbacks, mode, 0);
    }
    return { ok: true, error: null, code: "OK", command, queued: false, playUrl: launchPayload.url };
  } catch (err) {
    appendLaunchLog("[" + new Date().toISOString() + "] launch error: " +
      String((err && err.message) || err));
    return {
      ok: false,
      error: String(err.message || err),
      code: classifyError(err.message),
      command,
    };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function streamKey(value) {
  try {
    const u = new URL(value);
    return u.origin + u.pathname;
  } catch {
    return String(value || "");
  }
}

function trimmedCandidate(c) {
  if (!c || typeof c !== "object" || !isSafeUrl(c.url)) return null;
  const out = {
    url: c.url,
    audioUrl: c.audioUrl && isSafeUrl(c.audioUrl) ? c.audioUrl : null,
    audioHeaders: c.audioHeaders && typeof c.audioHeaders === "object" ? c.audioHeaders : {},
    headers: c.headers && typeof c.headers === "object" ? c.headers : {},
    title: sanitizeTitle(c.title || ""),
    label: String(c.label || "").slice(0, 80),
    quality: String(c.quality || "").slice(0, 40),
    kind: String(c.kind || "").slice(0, 40),
    width: Number(c.width) || 0,
    height: Number(c.height) || 0,
    bandwidth: Number(c.bandwidth) || 0,
    codecs: String(c.codecs || "").slice(0, 120),
    score: Number(c.score) || 0,
    qualities: Array.isArray(c.qualities) ? c.qualities.map(trimmedQuality).filter(Boolean).slice(0, 12) : [],
  };
  if (c.referer) out.referer = String(c.referer).slice(0, 2048);
  if (c.userAgent) out.userAgent = String(c.userAgent).slice(0, 512);
  if (c.cookies) out.cookies = String(c.cookies).slice(0, 8192);
  return out;
}

function trimmedQuality(q) {
  if (!q || typeof q !== "object" || !isSafeUrl(q.url)) return null;
  return {
    url: q.url,
    label: String(q.label || "").slice(0, 80),
    height: Number(q.height) || 0,
    width: Number(q.width) || 0,
    bandwidth: Number(q.bandwidth) || 0,
    codecs: String(q.codecs || "").slice(0, 120),
    audio: String(q.audio || "").slice(0, 40),
    audioUrl: q.audioUrl && isSafeUrl(q.audioUrl) ? q.audioUrl : null,
    audioHeaders: q.audioHeaders && typeof q.audioHeaders === "object" ? q.audioHeaders : {},
    headers: q.headers && typeof q.headers === "object" ? q.headers : {},
  };
}

function sourcePayload(payload, playUrl) {
  return {
    title: sanitizeTitle(payload.title || ""),
    currentUrl: payload.url || "",
    currentPlayUrl: playUrl || payload.url || "",
    candidates: (Array.isArray(payload.candidates) ? payload.candidates : []).map(trimmedCandidate).filter(Boolean),
    qualities: (Array.isArray(payload.qualities) ? payload.qualities : []).map(trimmedQuality).filter(Boolean),
    updatedAt: Date.now(),
  };
}

function publishSources(payload, playUrl, target) {
  const data = sourcePayload(payload, playUrl);
  try {
    ensureDir(configDir());
    fs.writeFileSync(path.join(configDir(), "sources.json"), JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  } catch {
    // best effort - menu can still receive the IPC message
  }
  const json = JSON.stringify(data);
  let attempt = 0;
  const send = () => {
    sendIpc(["script-message", "enhanced-mpv-sources", json], target, 500)
      .then((reply) => {
        if ((!reply || reply.error !== "success") && attempt++ < 8) setTimeout(send, 300);
      })
      .catch(() => {
        if (attempt++ < 8) setTimeout(send, 300);
      });
  };
  void send();
}

function applyCandidate(payload, candidate) {
  const c = trimmedCandidate(candidate);
  if (!c) return payload;
  const candidates = (Array.isArray(payload.candidates) ? payload.candidates : [])
    .filter((item) => item && streamKey(item.url) !== streamKey(c.url));
  return {
    ...payload,
    ...c,
    headers: { ...(payload.headers || {}), ...(c.headers || {}) },
    audioHeaders: c.audioHeaders && Object.keys(c.audioHeaders).length ? c.audioHeaders : payload.audioHeaders,
    candidates: [c, ...candidates].slice(0, 8),
    qualities: Array.isArray(candidate.qualities) && candidate.qualities.length
      ? candidate.qualities
      : payload.qualities,
  };
}

async function probeCandidate(candidate, timeoutMs) {
  if (!candidate || !isSafeUrl(candidate.url)) return { terminal: true, status: 0 };
  try {
    const res = await fetchWithHeaders(candidate.url, candidate.headers || {}, timeoutMs || 3000);
    return { terminal: [401, 403, 404, 410].includes(res.statusCode), status: res.statusCode };
  } catch {
    return { terminal: false, status: 0 };
  }
}

async function videoParamsReady(target, playUrl) {
  const [params, idle, currentPath] = await Promise.all([
    sendIpc(["get_property", "video-out-params"], target, 250).catch(() => null),
    sendIpc(["get_property", "idle-active"], target, 250).catch(() => null),
    sendIpc(["get_property", "path"], target, 250).catch(() => null),
  ]);
  if (currentPath && currentPath.error === "success" && currentPath.data) {
    const current = String(currentPath.data);
    if (playUrl && current !== playUrl && !current.startsWith(playUrl.replace(/[^/]+$/, ""))) return null;
  }
  if (params && params.error === "success" && params.data && typeof params.data === "object") return true;
  if (idle && idle.error === "success" && idle.data === true) return false;
  return null;
}

async function monitorAndFailover(payload, playUrl, target, fallbacks, mode, depth) {
  if (!fallbacks.length || depth >= 3) return;
  const deadline = Date.now() + 1500;
  const probe = probeCandidate(fallbacks[0], 2000);
  while (Date.now() < deadline) {
    await delay(100);
    const ready = await videoParamsReady(target, playUrl);
    if (ready === true) return;
    const currentPath = await sendIpc(["get_property", "path"], target, 250).catch(() => null);
    if (currentPath && currentPath.error === "success" && currentPath.data) {
      const current = String(currentPath.data);
      if (current !== playUrl && !current.startsWith(playUrl.replace(/[^/]+$/, ""))) return;
    }
    if (ready === false) break;
  }
  const probed = await probe;
  const next = fallbacks[0];
  appendLaunchLog("[" + new Date().toISOString() + "] failover trigger: no video-out-params for " +
    playUrl + " probe=" + probed.status + " next=" + streamKey(next.url));
  const nextPayload = applyCandidate({ ...payload, _failoverDepth: depth + 1 }, next);
  const result = await fastDispatch(nextPayload, mode);
  if (result.ok) {
    appendLaunchLog("[" + new Date().toISOString() + "] failover candidate accepted: " + streamKey(next.url));
  }
}

async function fastDispatch(payload, mode) {
  const incoming = Array.isArray(payload && payload.candidates) ? payload.candidates : [];
  const top = incoming[0] && trimmedCandidate(incoming[0]);
  if (top && streamKey(top.url) !== streamKey(payload.url) && !payload._candidateHopped) {
    return fastDispatch({ ...applyCandidate(payload, top), _candidateHopped: true }, mode);
  }

  const url = payload && payload.url;
  if (!isSafeUrl(url) && !(url && isSafeLocalPath(url) && !String(url).includes("://"))) {
    return { ok: false, error: "Rejected URL", code: "BAD_URL", command: [] };
  }
  const mpvBin = resolveMpvBin();
  if (!mpvBin) {
    return { ok: false, error: "mpv was not found on PATH", code: "MPV_NOT_FOUND", command: [] };
  }
  const startedAt = Date.now();
  try {
    const prepared = await prepareLaunch(payload, [], mpvBin, mode);
    if (prepared.failure) return prepared.failure;
    const { launchPayload, args, command, wantQueue } = prepared;
    if (!(await ipcAlive())) {
      appendLaunchLog("[" + new Date().toISOString() + "] fast dispatch: no live IPC, using full launch");
      return play(payload, mode);
    }
    const target = liveIpc || ipcPath();
    const plan = loadfilePlan(args);
    if (plan.profile) void sendIpc(["apply-profile", plan.profile], target, 300).catch(() => {});
    if (plan.lavfAppend) void sendIpc(["change-list", "demuxer-lavf-o", "append", plan.lavfAppend], target, 300).catch(() => {});
    void sendIpc(["change-list", "audio-files", "clr", ""], target, 300).catch(() => {});
    void sendIpc(["change-list", "sub-files", "clr", ""], target, 300).catch(() => {});
    const options = { ...(plan.options || {}) };
    const start = (payload.startTimeSource && payload.startTimeSource !== "none")
      ? Math.floor(payload.startTime)
      : resumeStart(payload.startTime, payload.duration);
    options.start = start > 0 ? String(start) : "none";
    const dispatchedAt = Date.now();

    // 1. Open window immediately: force-window=yes, focus, loading screen BEFORE loadfile
    //    Guaranteed IPC execution order with JSON reply verification
    await sendIpc(["set_property", "force-window", "yes"], target, 300);
    await sendIpc(["set_property", "pause", false], target, 300);
    await sendIpc(["set_property", "window-minimized", false], target, 300);

    // 2. Fire the loading-screen splash AND focus message (60 fps ASS overlay) while ytdl_hook resolves
    await sendScriptMessage("enhanced-mpv-focus", target, 300);
    await sendScriptMessage("enhanced-mpv-loading", target, 300);

    // 3. Load the file with per-file options. Log exact IPC command and response.
    const loadfileCmd = ["loadfile", launchPayload.url, wantQueue ? "append-play" : "replace", -1, options];
    appendLaunchLog("[" + new Date().toISOString() + "] fast_dispatch loadfile cmd: " + JSON.stringify(loadfileCmd));
    let r = await sendIpc(loadfileCmd, target, 1200);
    appendLaunchLog("[" + new Date().toISOString() + "] fast_dispatch loadfile resp: " + JSON.stringify(r));
    if (!r || r.error !== "success") {
      const errMsg = String(r && r.error);
      appendLaunchLog("[" + new Date().toISOString() + "] fast_dispatch loadfile with index failed: " + errMsg);
      if (errMsg.includes("invalid parameter")) {
        appendLaunchLog("[" + new Date().toISOString() + "] fast_dispatch retrying loadfile without index (older mpv)");
        const loadfileCmdNoIdx = ["loadfile", launchPayload.url, wantQueue ? "append-play" : "replace", options];
        appendLaunchLog("[" + new Date().toISOString() + "] fast_dispatch loadfile cmd (no idx): " + JSON.stringify(loadfileCmdNoIdx));
        r = await sendIpc(loadfileCmdNoIdx, target, 1200);
        appendLaunchLog("[" + new Date().toISOString() + "] fast_dispatch loadfile resp (no idx): " + JSON.stringify(r));
        if (!r || r.error !== "success") {
          throw new Error("ipc loadfile rejected (no index): " + String(r && r.error));
        }
      } else {
        throw new Error("ipc loadfile rejected: " + errMsg);
      }
    }
    const dispatchMs = Date.now() - dispatchedAt;
    void materializeSubtitles(payload)
      .then((files) => attachSubtitlesWhenReady(files, target))
      .catch((err) => {
        appendLaunchLog("[" + new Date().toISOString() + "] subtitle attach failed: " +
          String((err && err.message) || err));
      });
    const totalMs = Date.now() - startedAt;
    appendLaunchLog("[" + new Date().toISOString() + "] fast_ipc_dispatch_ms=" + dispatchMs + " total_ms=" + totalMs);
    publishSources(payload, launchPayload.url, target);
    if (!wantQueue) {
      const fallbacks = (Array.isArray(payload.candidates) ? payload.candidates : [])
        .filter((c) => c && streamKey(c.url) !== streamKey(payload.url))
        .slice(0, 2);
      void monitorAndFailover(payload, launchPayload.url, target, fallbacks, mode, Number(payload._failoverDepth) || 0);
    }
    return {
      ok: true,
      error: null,
      code: "OK",
      command,
      queued: wantQueue,
      reused: true,
      fast: true,
      dispatchMs,
      totalMs,
      playUrl: launchPayload.url,
    };
  } catch (err) {
    appendLaunchLog("[" + new Date().toISOString() + "] fast dispatch failed: " +
      String((err && err.message) || err) + "; using full launch");
    return play(payload, mode);
  }
}

// Hot-attach a separately captured audio track to the running mpv window
// without restarting playback. The attach runs in its own host process, so it
// first waits until mpv is actually playing the video it belongs to; that way
// a late attach never lands on the previous video. Falls back to a fresh
// launch with --audio-file when no mpv is live.
async function attachAudio(payload) {
  const audioUrl = payload && payload.audioUrl;
  if (!audioUrl || !isSafeUrl(audioUrl)) {
    return { ok: false, error: "Rejected URL", code: "BAD_URL", command: [] };
  }
  const mpvBin = resolveMpvBin();
  if (!mpvBin) {
    return { ok: false, error: "mpv was not found on PATH", code: "MPV_NOT_FOUND", command: [] };
  }
  const audioAuth = authHeaderObject(payload.audioHeaders);
  if (await ipcAlive()) {
    const target = liveIpc || ipcPath();
    const videoUrl = payload.url && isSafeUrl(payload.url) ? payload.url : null;
    if (!(await waitForLoadedFile(target, videoUrl, 50))) {
      appendLaunchLog("[" + new Date().toISOString() + "] attachAudio skipped: target video is not playing");
      return { ok: false, error: "target video is not playing", code: "NOT_PLAYING", command: [] };
    }
    let relayedAudioUrl = audioUrl;
    if (Object.keys(audioAuth).length > 0) {
      try {
        relayedAudioUrl = await relaySingle(audioUrl, audioAuth);
        appendLaunchLog("[" + new Date().toISOString() + "] attachAudio relay: " + relayedAudioUrl);
      } catch (err) {
        appendLaunchLog("[" + new Date().toISOString() + "] attachAudio relay failed, using direct: " + String(err));
      }
    }
    try {
      await sendIpc(["change-list", "demuxer-lavf-o", "append", "allowed_extensions=ALL"], target, 500).catch(() => {});
      const r = await sendIpc(["audio-add", relayedAudioUrl, "select"], target, 5000);
      if (r && r.error && r.error !== "success") throw new Error(String(r.error));
      appendLaunchLog("[" + new Date().toISOString() + "] IPC audio-add ok");
      return { ok: true, error: null, code: "OK", command: [] };
    } catch (err) {
      appendLaunchLog("[" + new Date().toISOString() + "] IPC audio-add failed: " + String((err && err.message) || err));
      return { ok: false, error: "audio-add failed", code: "LAUNCH_FAILED", command: [] };
    }
  }
  if (!payload.url) return { ok: false, error: "no video to pair", code: "BAD_URL", command: [] };
  return play(payload, "replace");
}

module.exports = {
  play,
  fastDispatch,
  appendLaunchLog,
  setRelayInProcess,
  startRelayDaemon,
  relayMaster,
  findMpv: resolveMpvBin,
  resolveMpvBin,
  buildArgs,
  isNativeMpv,
  resumeStart,
  resolveYtdlFormat,
  cleanStaleTempSubs,
  launchLogPath,
  sendIpc,
  loadFileIpc,
  loadfilePlan,
  ipcAlive,
  ipcPath,
  get liveIpc() { return liveIpc; },
  attachAudio,
  classifyError,
  publicCommand,
  redactStderr,
  sendScriptMessage,
  spawnMpv,
  startRelay,
  terminateMpv,
  killStaleMpv: terminateMpv,
};
