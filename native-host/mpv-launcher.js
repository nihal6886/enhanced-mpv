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
const { startRelay, startMasterRelay } = require("./stream-relay");

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
  
  const env = process.env.MPV_PATH;
  if (env && fs.existsSync(env) && isNativeMpv(env)) {
    cachedMpvBin = env;
    return cachedMpvBin;
  }
  
  const found = [which("mpv"), which("mpv.exe"), which("mpv.com")]
    .find((candidate) => candidate && isNativeMpv(candidate));
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
      path.join(local, "Programs", "mpv", "mpv.com"),
      path.join(local, "Microsoft", "WinGet", "Links", "mpv.exe"),
      path.join(local, "Microsoft", "WinGet", "Links", "mpv.com"),
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
  return /^mpv(?:\.exe|\.com)?$/i.test(path.basename(value))
    && !/(^|[\\/])mpv\.net([\\/]|$)/i.test(value);
}

function buildArgs(payload, subFiles, _mpvBin) {
  const cfg = readConfig();
  const args = [];
  // --force-window=immediate MUST be the very first flag for instant window creation
  args.push("--force-window=immediate");
  args.push("--no-terminal");
  args.push("--input-ipc-server=" + ipcPath());
  const title = sanitizeTitle(payload.title || "");
  if (title) args.push("--force-media-title=" + title);
  const headers = headerFields(payload);
  const url = payload.url;
  const audioUrl = payload.audioUrl;
  const isDirectStream = /\.(m3u8|mpd|mp4|mkv|webm)(?:$|[?#])/i.test(url);
  const isRelayUrl = /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\/(index\.m3u8|master\.m3u8)/i.test(url);
  const isMasterRelay = payload.isMasterRelay === true;
  
  // Also check if audio URL (for --external-file) is a relay URL
  const relayedAudioUrl = payload.relayedAudioUrl;
  const audioIsRelayUrl = relayedAudioUrl && /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\/(index\.m3u8|master\.m3u8)/i.test(relayedAudioUrl);
  
  if (headers.length) {
    args.push("--http-header-fields=" + joinHeaderFields(headers));
    // Also pass headers via --demuxer-lavf-o for HLS/DASH segment requests (.ts, .m4s, etc.)
    // so every segment carries valid Referer/Origin/User-Agent for hotlink-protected CDNs.
    // Only for direct stream/manifest URLs; yt-dlp page URLs manage their own headers.
    if (isDirectStream || isRelayUrl) {
      // Format as valid HTTP headers: "Header: Value\r\nHeader: Value\r\n"
      // Escape backslashes and commas for mpv's key-value option parser.
      const lavfHeaders = headers.map(h => {
        const idx = h.indexOf(":");
        if (idx > 0) {
          const key = h.slice(0, idx).trim();
          const value = h.slice(idx + 1).trim();
          return key + ": " + value.replace(/\\/g, "\\\\").replace(/,/g, "\\,");
        }
        return h.replace(/\\/g, "\\\\").replace(/,/g, "\\,");
      }).join("\\r\\n") + "\\r\\n";
      args.push("--demuxer-lavf-o=headers=" + lavfHeaders);
    }
  }
  // A separate audio track is paired: mpv needs the relayed audio URL as an
  // external file, the first audio track selected, and ffmpeg allowed to read
  // every extension so the audio .m3u8/.aac/.m4a is never skipped.
  const hasSeparateAudio = Boolean(audioUrl && !isMasterRelay);
  // Allow all extensions for relayed HLS streams (local/proxied .m3u8) so ffmpeg never blocks audio playlists
  // Applies to the main URL, relayed audio URL, and any paired external audio file.
  if (isRelayUrl || audioIsRelayUrl || hasSeparateAudio) {
    const lavfOpts = "allowed_extensions=ALL";
    const existingLavfIdx = args.findIndex(a => a.startsWith("--demuxer-lavf-o="));
    if (existingLavfIdx >= 0) {
      args[existingLavfIdx] += "," + lavfOpts;
    } else {
      args.push("--demuxer-lavf-o=" + lavfOpts);
    }
  }
  const profile = payload.profile || payload.mpvProfile;
  if (profile && /^[a-zA-Z0-9._-]+$/.test(profile)) {
    args.push("--profile=" + profile);
  }
  if (ytdlSupported(url)) {
    // Let yt-dlp resolve the page: cap resolution, pull English auto-captions, and
    // match sidecar subtitles loosely so YouTube opens fast with subs ready.
    // Reliable format: bestvideo + bestaudio (no container restriction) + no-playlist,
    // no-check-certificates, write-auto-subs, sub-langs=en.*
    args.push("--ytdl-format=" + resolveYtdlFormat(payload, cfg));
    args.push("--ytdl-raw-options=no-playlist=,no-check-certificates=,write-auto-subs=,sub-langs=en.*");
    args.push("--sub-auto=fuzzy");
  } else if (isDirectStream || isRelayUrl) {
    // Direct manifest/media URLs or relay URLs: skip yt-dlp entirely
    args.push("--ytdl=no");
    // For direct streams with separate audio, use --external-file (more reliable than --audio-file for HLS)
    // and --aid=1 to select the first audio track. Prefer the relayed audio URL when
    // auth headers forced a local relay; otherwise pass the audio URL directly.
    if (hasSeparateAudio) {
      const audioHeaders = payload.audioHeaders || {};
      const needsRelay = audioHeaders.cookie || audioHeaders.referer || audioHeaders.origin || audioHeaders.userAgent;
      const externalAudio = (needsRelay && relayedAudioUrl) ? relayedAudioUrl : audioUrl;
      args.push("--external-file=" + externalAudio);
      args.push("--aid=1");
    }
  }
  for (const f of subFiles) {
    if (isSafeLocalPath(f)) args.push("--sub-file=" + f);
  }
  if (subFiles.length > 0) args.push("--sid=1");
  const start = Number(payload.startTime);
  // Only pass --start if startTime > 3s, duration > 15s, and startTime < (duration - 10s)
  const duration = Number(payload.duration);
  if (Number.isFinite(start) && start > 3 && Number.isFinite(duration) && duration > 15 && start < (duration - 10)) {
    args.push("--start=+" + String(start));
  }
  // Keep the media URL last so mpv parses it as the input, not as an option value.
  if (url) args.push(url);
  return args;
}

function ipcCandidates() {
  const primary = ipcPath();
  const homeSock = path.join(os.homedir(), ".enhanced-mpv", "mpv-socket");
  const extra = process.platform === "win32"
    ? ["\\\\.\\pipe\\enhanced-mpv-socket", "\\\\.\\pipe\\enhanced-mpv", homeSock]
    : [homeSock, "/tmp/enhanced-mpv.sock"];
  return [...new Set([primary, ...extra])];
}

function sendIpc(command, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = process.platform === "win32"
      ? net.connect(target)
      : net.connect({ path: target });
    const payload = JSON.stringify({ command }) + "\n";
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("ipc timeout"));
    }, timeoutMs || 500);
    sock.on("connect", () => sock.write(payload));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.includes("\n")) {
        clearTimeout(timer);
        sock.end();
        try {
          resolve(JSON.parse(buf.split("\n")[0]));
        } catch (e) {
          reject(e);
        }
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function sendScriptMessage(message, target, timeoutMs) {
  return sendIpc(["script-message", message], target, timeoutMs || 80);
}

async function killStaleMpv() {
  if (process.platform !== "win32") return;
  try {
    const { spawnSync } = require("child_process");
    // Kill any enhanced-mpv.exe or mpv.exe processes owned by this user
    spawnSync("taskkill", ["/F", "/IM", "enhanced-mpv.exe", "/T"], { windowsHide: true, timeout: 2000 });
    spawnSync("taskkill", ["/F", "/IM", "mpv.exe", "/T"], { windowsHide: true, timeout: 2000 });
  } catch {
    // best effort
  }
}

let liveIpc = null;

async function ipcAlive() {
  const targets = ipcCandidates();
  const checks = targets.map(async (target) => {
    const r = await sendIpc(["get_property", "mpv-version"], target, 150);
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
    // No active mpv IPC endpoint; spawning can proceed immediately.
  }
  liveIpc = null;
  return false;
}

function classifyError(stderr) {
  const s = String(stderr || "").toLowerCase();
  if (s.includes("drm") || s.includes("widevine") || s.includes("403")) return "DRM";
  if (s.includes("401") || s.includes("expired") || s.includes("403")) return "EXPIRED";
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

function spawnMpv(mpvBin, args, spawnStartMs) {
  ensureDir(configDir());
  const child = spawn(mpvBin, args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: false, // MUST be false for instant foreground window
    shell: false,
    env: {
      ...process.env,
      HOME: os.homedir(),
    },
  });
  const spawnMs = Date.now() - spawnStartMs;
  appendLaunchLog("[" + new Date().toISOString() + "] spawn_ms=" + spawnMs + " " +
    JSON.stringify(publicCommand(mpvBin, args)));
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
  });
  child.unref();
  return child;
}

async function loadFileIpc(url, mode, startTime, target) {
  return new Promise((resolve, reject) => {
    const sock = process.platform === "win32" ? net.connect(target) : net.connect({ path: target });
    const hasStart = Number.isFinite(startTime) && startTime > 0;
    let input = "";
    let loadAck = false;
    let fileLoaded = false;
    let seekSent = false;
    let resultSent = false;
    let timeout = setTimeout(() => {
      if (loadAck) {
        appendLaunchLog("[" + new Date().toISOString() + "] IPC file-loaded event timed out; stream remains open");
        sock.end();
        return;
      }
      sock.destroy();
      if (!resultSent) {
        resultSent = true;
        reject(new Error("ipc loadfile timeout"));
      }
    }, 3000);
    const finish = (err) => {
      clearTimeout(timeout);
      sock.end();
      if (!resultSent) {
        resultSent = true;
        if (err) reject(err);
        else resolve(true);
      } else if (err) {
        appendLaunchLog("[" + new Date().toISOString() + "] IPC follow-up failed: " + String(err.message || err));
      }
    };
    const maybeSeek = () => {
      if (!hasStart || !loadAck || !fileLoaded || seekSent) return;
      seekSent = true;
      sock.write(JSON.stringify({
        command: ["seek", startTime, "absolute+exact"],
        request_id: 2,
      }) + "\n");
    };
    sock.on("connect", () => {
      sock.write(JSON.stringify({
        command: ["loadfile", url, mode],
        request_id: 1,
      }) + "\n");
    });
    sock.on("data", (chunk) => {
      input += chunk.toString("utf8");
      const lines = input.split("\n");
      input = lines.pop() || "";
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.event === "file-loaded") {
          fileLoaded = true;
          maybeSeek();
        } else if (message.request_id === 1) {
          if (message.error !== "success") {
            finish(new Error("ipc loadfile rejected: " + String(message.error)));
            return;
          }
          loadAck = true;
          if (!resultSent) {
            resultSent = true;
            resolve(true);
          }
          if (!hasStart) {
            finish();
          } else {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
              if (!seekSent) {
                appendLaunchLog("[" + new Date().toISOString() + "] IPC file-loaded event timed out; start seek skipped");
                sock.end();
              }
            }, 5000);
            maybeSeek();
          }
        } else if (message.request_id === 2) {
          if (message.error !== "success") appendLaunchLog("[" + new Date().toISOString() + "] IPC seek failed: " + String(message.error));
          finish();
        }
      }
    });
    sock.on("error", (err) => finish(err));
  });
}

async function attachSubtitlesWhenReady(files, target) {
  if (!files.length) return;
  // Fire-and-forget subtitle attachment - don't block stream launch
  setImmediate(async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const state = await sendIpc(["get_property", "idle-active"], target, 300);
        if (state && state.error === "success" && state.data === false) {
          for (const file of files) await sendIpc(["sub-add", file, "select"], target);
          return;
        }
      } catch {
        // IPC may still be starting; retry briefly without delaying stream launch.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    appendLaunchLog("[" + new Date().toISOString() + "] subtitle attach skipped: mpv IPC did not become ready");
  });
}

async function play(payload, mode) {
  const url = payload && payload.url;
  if (!isSafeUrl(url) && !(url && isSafeLocalPath(url) && !String(url).includes("://"))) {
    return { ok: false, error: "Rejected URL", code: "BAD_URL", command: [] };
  }
  // Use cached mpv binary - NO fs.existsSync, NO DNS, NO pipe probes on hot path
  const mpvBin = resolveMpvBin();
  if (!mpvBin) {
    return { ok: false, error: "mpv was not found on PATH", code: "MPV_NOT_FOUND", command: [] };
  }
  const cfg = readConfig();
  const keepWarm = cfg.keepWarm === true;
  const queuePref = mode || payload.action || cfg.queueMode || "replace";
  const wantQueue = queuePref === "queue";
  setTimeout(cleanStaleTempSubs, 0);
  const subtitleFilesPromise = materializeSubtitles(payload).catch((err) => {
    appendLaunchLog("[" + new Date().toISOString() + "] subtitle download failed: " +
      String((err && err.message) || err));
    return [];
  });
  const localSubFiles = Array.isArray(payload.subtitleFiles)
    ? payload.subtitleFiles.filter(isSafeLocalPath)
    : [];

  // Every new (non-queue) launch terminates any running enhanced-mpv instance,
  // whether startTime is 0 or a resume point, so the previous video is never
  // left paused on screen and the fresh spawn honors --start=+<seconds>.
  const startResume = Number(payload.startTime);
  const isReplace = (mode || payload.action || "replace") !== "queue";
  appendLaunchLog("[" + new Date().toISOString() + "] play mode=" + (isReplace ? "replace" : "queue") +
    " startTime=" + (Number.isFinite(startResume) ? startResume : 0) +
    " duration=" + (Number.isFinite(Number(payload.duration)) ? Number(payload.duration) : 0) +
    " source=" + String(payload.startTimeSource || "none").slice(0, 200));
  if (isReplace) {
    await killStaleMpv();
  }

  // Handle audio relay for split HLS/DASH streams with auth headers
  let masterRelayUrl = null;
  const audioUrl = payload.audioUrl;
  const audioHeaders = payload.audioHeaders || {};
  const videoUrl = payload.url;
  const videoHeaders = headerFields(payload);
  const videoIsHls = /\.(m3u8)(?:$|[?#])/i.test(videoUrl);
  const audioIsHls = audioUrl && /\.(m3u8)(?:$|[?#])/i.test(audioUrl);
  const needsVideoRelay = videoIsHls && (videoHeaders.some(h => h.startsWith("Cookie:") || h.startsWith("Referer:") || h.startsWith("Origin:") || h.startsWith("User-Agent:")));
  const needsAudioRelay = audioIsHls && (audioHeaders.cookie || audioHeaders.referer || audioHeaders.origin || audioHeaders.userAgent);

  // If both video and audio are HLS and need auth, use master relay with synthesized manifest
  if (videoIsHls && audioIsHls && (needsVideoRelay || needsAudioRelay)) {
    try {
      const relayVideoHeaders = {};
      const relayAudioHeaders = {};
      // Add video headers
      for (const h of videoHeaders) {
        const idx = h.indexOf(":");
        if (idx > 0) {
          const key = h.slice(0, idx).trim();
          const value = h.slice(idx + 1).trim();
          relayVideoHeaders[key] = value;
        }
      }
      // Add audio headers
      if (audioHeaders.referer) relayAudioHeaders.Referer = audioHeaders.referer;
      if (audioHeaders.origin) relayAudioHeaders.Origin = audioHeaders.origin;
      if (audioHeaders.userAgent) relayAudioHeaders["User-Agent"] = audioHeaders.userAgent;
      if (audioHeaders.cookie) relayAudioHeaders.Cookie = audioHeaders.cookie;

      const masterResult = await startMasterRelay(videoUrl, relayVideoHeaders, audioUrl, relayAudioHeaders);
      masterRelayUrl = masterResult.masterRelayUrl;
      appendLaunchLog("[" + new Date().toISOString() + "] started master relay: " + masterRelayUrl);
    } catch (err) {
      appendLaunchLog("[" + new Date().toISOString() + "] master relay failed, falling back: " + String(err));
      masterRelayUrl = null;
    }
  } else if (needsAudioRelay) {
    // Legacy: only audio needs relay (non-HLS video or audio-only relay)
    try {
      const relayHeaders = {};
      if (audioHeaders.referer) relayHeaders.Referer = audioHeaders.referer;
      if (audioHeaders.origin) relayHeaders.Origin = audioHeaders.origin;
      if (audioHeaders.userAgent) relayHeaders["User-Agent"] = audioHeaders.userAgent;
      if (audioHeaders.cookie) relayHeaders.Cookie = audioHeaders.cookie;
      const relayedAudioUrl = await startRelay(audioUrl, relayHeaders);
      appendLaunchLog("[" + new Date().toISOString() + "] started audio relay: " + relayedAudioUrl);
      // Store relayed audio URL on payload for buildArgs
      payload.relayedAudioUrl = relayedAudioUrl;
    } catch (err) {
      appendLaunchLog("[" + new Date().toISOString() + "] audio relay failed, using direct: " + String(err));
      payload.relayedAudioUrl = audioUrl;
    }
  }

  // If master relay was created, use it as the main URL and disable yt-dlp
  if (masterRelayUrl) {
    payload.url = masterRelayUrl;
    payload.isMasterRelay = true;
  }
  const args = buildArgs(payload, localSubFiles, mpvBin);
  const command = publicCommand(mpvBin, args);

  // Warm reuse via loadfile cannot attach a separate --external-file audio track,
  // so only reuse an idle mpv when audio is embedded (master relay) or absent.
  const warmEligible = keepWarm && !(payload.audioUrl && !payload.isMasterRelay);

  ensureDir(configDir());

  // Warm standby: if keepWarm is enabled and an idle mpv is already running,
  // reuse it via IPC (loadfile + force-window=yes) for < 20 ms startup.
  if (warmEligible && await ipcAlive()) {
    try {
      const t = liveIpc || ipcPath();
      const start = Number(payload.startTime);
      // Replace current playback or append to playlist
      await loadFileIpc(payload.url, wantQueue ? "append-play" : "replace", start, t);
      // Bring window to front and set title
      sendScriptMessage("bring-to-front", t).catch(() => {});
      sendIpc(["set_property", "force-window", "yes"], t).catch(() => {});
      sendIpc(["set_property", "window-minimized", false], t).catch(() => {});
      if (payload.title) {
        sendIpc(["set_property", "force-media-title", sanitizeTitle(payload.title)], t).catch(() => {});
      }
      // Attach subtitles asynchronously
      void subtitleFilesPromise.then((files) => attachSubtitlesWhenReady(files, t));
      return { ok: true, error: null, code: "OK", command, queued: wantQueue, warm: true };
    } catch (err) {
      appendLaunchLog("[" + new Date().toISOString() + "] warm ipc loadfile failed: " +
        String((err && err.message) || err));
      // Kill stale mpv and fall through to fresh spawn
      await killStaleMpv();
    }
  }

  // If keepWarm is enabled but no warm mpv is running, spawn one with --idle=once
  // and --force-window=immediate so it opens a fresh, focused foreground window immediately.
  if (warmEligible) {
    const warmArgs = ["--idle=once", "--force-window=immediate", "--input-ipc-server=" + ipcPath()];
    if (cfg.profile) warmArgs.push("--profile=" + cfg.profile);
    const spawnStart = Date.now();
    appendLaunchLog("[" + new Date().toISOString() + "] spawning warm mpv " +
      JSON.stringify(publicCommand(mpvBin, warmArgs)));
    spawnMpv(mpvBin, warmArgs, spawnStart);
    // Wait briefly for the IPC socket to become available
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 30));
      if (await ipcAlive()) break;
    }
    if (await ipcAlive()) {
      try {
        const t = liveIpc || ipcPath();
        const start = Number(payload.startTime);
        await loadFileIpc(payload.url, wantQueue ? "append-play" : "replace", start, t);
        // Bring window to front and set title
        sendScriptMessage("bring-to-front", t).catch(() => {});
        sendIpc(["set_property", "force-window", "yes"], t).catch(() => {});
        sendIpc(["set_property", "window-minimized", false], t).catch(() => {});
        if (payload.title) {
          sendIpc(["set_property", "force-media-title", sanitizeTitle(payload.title)], t).catch(() => {});
        }
        void subtitleFilesPromise.then((files) => attachSubtitlesWhenReady(files, t));
        return { ok: true, error: null, code: "OK", command, queued: wantQueue, warm: true };
      } catch (err) {
        appendLaunchLog("[" + new Date().toISOString() + "] warm ipc loadfile failed: " +
          String((err && err.message) || err));
        // Kill stale mpv and fall through to regular spawn
        await killStaleMpv();
      }
    }
  }

  try {
    const spawnStart = Date.now();
    appendLaunchLog("[" + new Date().toISOString() + "] spawning " +
      JSON.stringify(publicCommand(mpvBin, args)));
    const child = spawnMpv(mpvBin, args, spawnStart);
    void subtitleFilesPromise.then((files) => {
      const target = ipcPath();
      return attachSubtitlesWhenReady(files, target);
    }).catch((err) => {
      appendLaunchLog("[" + new Date().toISOString() + "] subtitle attach failed: " +
        String((err && err.message) || err));
    });
    void child;
    return { ok: true, error: null, code: "OK", command, queued: false };
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

// Hot-attach a separately captured audio track to a running mpv window without
// restarting playback: relay the audio through localhost when it carries auth
// headers, then send `audio-add <url> select` over the live IPC socket.
// Falls back to a fresh spawn with --external-file when no mpv is live.
async function attachAudio(payload) {
  const audioUrl = payload && payload.audioUrl;
  if (!audioUrl || !isSafeUrl(audioUrl)) {
    return { ok: false, error: "Rejected URL", code: "BAD_URL", command: [] };
  }
  const mpvBin = resolveMpvBin();
  if (!mpvBin) {
    return { ok: false, error: "mpv was not found on PATH", code: "MPV_NOT_FOUND", command: [] };
  }
  const audioHeaders = payload.audioHeaders || {};
  const needsRelay = Boolean(
    audioHeaders.cookie || audioHeaders.referer || audioHeaders.origin || audioHeaders.userAgent
  );
  let relayedAudioUrl = audioUrl;
  if (needsRelay) {
    try {
      const relayHeaders = {};
      if (audioHeaders.referer) relayHeaders.Referer = audioHeaders.referer;
      if (audioHeaders.origin) relayHeaders.Origin = audioHeaders.origin;
      if (audioHeaders.userAgent) relayHeaders["User-Agent"] = audioHeaders.userAgent;
      if (audioHeaders.cookie) relayHeaders.Cookie = audioHeaders.cookie;
      relayedAudioUrl = await startRelay(audioUrl, relayHeaders);
      appendLaunchLog("[" + new Date().toISOString() + "] attachAudio relay: " + relayedAudioUrl);
    } catch (err) {
      appendLaunchLog("[" + new Date().toISOString() + "] attachAudio relay failed, using direct: " + String(err));
      relayedAudioUrl = audioUrl;
    }
  }
  if (await ipcAlive()) {
    const target = liveIpc || ipcPath();
    try {
      await sendIpc(["audio-add", relayedAudioUrl, "select"], target, 1500);
      appendLaunchLog("[" + new Date().toISOString() + "] IPC audio-add " + relayedAudioUrl);
      return { ok: true, error: null, code: "OK", command: [] };
    } catch (err) {
      appendLaunchLog("[" + new Date().toISOString() + "] IPC audio-add failed: " + String((err && err.message) || err));
    }
  }
  return play({ ...payload, audioUrl: relayedAudioUrl }, payload.action || "play");
}

module.exports = {
  play,
  findMpv: resolveMpvBin,
  buildArgs,
  isNativeMpv,
  resolveYtdlFormat,
  cleanStaleTempSubs,
  launchLogPath,
  sendIpc,
  loadFileIpc,
  ipcAlive,
  ipcPath,
  liveIpc,
  attachAudio,
  classifyError,
  publicCommand,
  redactStderr,
  sendScriptMessage,
  killStaleMpv,
};