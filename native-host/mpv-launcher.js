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
  if (h.referer) out.Referer = h.referer;
  if (h.origin) out.Origin = h.origin;
  if (h.userAgent) out["User-Agent"] = h.userAgent;
  if (h.cookie) out.Cookie = h.cookie;
  return out;
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

async function sendScriptMessage(message, target, timeoutMs) {
  return sendIpc(["script-message", message], target, timeoutMs || 300);
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
    // No active mpv IPC endpoint; spawning can proceed immediately.
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

function spawnMpv(mpvBin, args, spawnStartMs) {
  ensureDir(configDir());
  const started = spawnStartMs || Date.now();
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
  if (child.pid) {
    try { fs.writeFileSync(pidFilePath(), String(child.pid), "utf8"); } catch { /* best effort */ }
  }
  const spawnMs = Date.now() - started;
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
]);

function loadfilePlan(args) {
  const options = {
    ytdl: "yes",
    "http-header-fields": "",
    "force-media-title": "",
    sid: "auto",
    "resume-playback": "no",
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
  const start = resumeStart(startTime, opts.duration);
  // Always explicit: an unset start would inherit a CLI --start from the
  // original spawn or let watch-later resume override the browser position.
  options.start = start > 0 ? String(start) : "none";
  const r = await sendIpc(["loadfile", url, mode, -1, options], target, 3000);
  if (!r || r.error !== "success") {
    throw new Error("ipc loadfile rejected: " + String(r && r.error));
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
    options: plan.options,
  });
  if (wantQueue) return;
  await Promise.allSettled([
    sendIpc(["set_property", "force-window", "yes"], target, 300),
    sendIpc(["set_property", "window-minimized", false], target, 300),
    sendIpc(["set_property", "pause", false], target, 300),
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

function relayDaemonCommand() {
  const isNode = /^node(?:\.exe)?$/i.test(path.basename(process.execPath));
  return isNode
    ? { bin: process.execPath, args: [path.join(__dirname, "index.js"), "--relay-daemon"] }
    : { bin: process.execPath, args: ["--relay-daemon"] };
}

// Browsers terminate a one-shot native-messaging host right after it replies,
// which would take an in-process relay (and mpv's stream) down with it. Run
// the relay in a detached helper that exits on its own once mpv stops using
// it; fall back to an in-process relay if the helper cannot start.
function startRelayDaemon(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const { bin, args } = relayDaemonCommand();
    let child;
    try {
      child = spawn(bin, args, { detached: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let out = "";
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* ignore */ }
      try { child.stdout.destroy(); } catch { /* ignore */ }
      child.unref();
      if (err) {
        try { child.kill(); } catch { /* ignore */ }
        reject(err);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => done(new Error("relay daemon timeout")), timeoutMs || 5000);
    child.on("error", (err) => done(err));
    child.on("exit", () => done(new Error("relay daemon exited")));
    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
      const nl = out.indexOf("\n");
      if (nl < 0) return;
      try {
        const reply = JSON.parse(out.slice(0, nl));
        if (reply && reply.ok) done(null, reply);
        else done(new Error((reply && reply.error) || "relay daemon failed"));
      } catch (err) {
        done(err);
      }
    });
    child.stdin.write(JSON.stringify(request) + "\n");
  });
}

async function relaySingle(url, headers) {
  try {
    const reply = await startRelayDaemon({ kind: "single", url, headers });
    return reply.relayUrl;
  } catch (err) {
    appendLaunchLog("[" + new Date().toISOString() + "] relay daemon unavailable, using in-process relay: " + String(err.message || err));
    return startRelay(url, headers);
  }
}

async function relayMaster(videoUrl, videoHeaders, audioUrl, audioHeaders) {
  try {
    const reply = await startRelayDaemon({ kind: "master", videoUrl, videoHeaders, audioUrl, audioHeaders });
    return reply.masterRelayUrl;
  } catch (err) {
    appendLaunchLog("[" + new Date().toISOString() + "] relay daemon unavailable, using in-process relay: " + String(err.message || err));
    const r = await startMasterRelay(videoUrl, videoHeaders, audioUrl, audioHeaders);
    return r.masterRelayUrl;
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

async function play(payload, mode) {
  const url = payload && payload.url;
  if (!isSafeUrl(url) && !(url && isSafeLocalPath(url) && !String(url).includes("://"))) {
    return { ok: false, error: "Rejected URL", code: "BAD_URL", command: [] };
  }
  const mpvBin = resolveMpvBin();
  if (!mpvBin) {
    return { ok: false, error: "mpv was not found on PATH", code: "MPV_NOT_FOUND", command: [] };
  }
  const cfg = readConfig();
  const wantQueue = (mode || payload.action || cfg.queueMode || "replace") === "queue";
  setTimeout(cleanStaleTempSubs, 0);
  const subtitleFilesPromise = materializeSubtitles(payload).catch((err) => {
    appendLaunchLog("[" + new Date().toISOString() + "] subtitle download failed: " +
      String((err && err.message) || err));
    return [];
  });
  const localSubFiles = Array.isArray(payload.subtitleFiles)
    ? payload.subtitleFiles.filter(isSafeLocalPath)
    : [];

  appendLaunchLog("[" + new Date().toISOString() + "] play mode=" + (wantQueue ? "queue" : "replace") +
    " startTime=" + resumeStart(payload.startTime, payload.duration) +
    " duration=" + (Number.isFinite(Number(payload.duration)) ? Number(payload.duration) : 0) +
    " source=" + String(payload.startTimeSource || "none").slice(0, 200));

  // Split HLS video + audio behind auth: relay both through localhost so every
  // playlist, key, init segment, and media segment carries the tab's headers.
  const audioUrl = payload.audioUrl && isSafeUrl(payload.audioUrl) ? payload.audioUrl : null;
  const audioAuth = authHeaderObject(payload.audioHeaders);
  const videoHeaders = headerFields(payload);
  const videoIsHls = /\.m3u8(?:$|[?#])/i.test(url);
  const audioIsHls = Boolean(audioUrl && /\.m3u8(?:$|[?#])/i.test(audioUrl));
  const needsVideoRelay = videoIsHls && videoHeaders.some((h) => /^(Cookie|Referer|Origin|User-Agent):/i.test(h));
  const needsAudioRelay = audioIsHls && Object.keys(audioAuth).length > 0;
  const launchPayload = { ...payload, audioUrl };

  if (videoIsHls && audioIsHls && (needsVideoRelay || needsAudioRelay)) {
    try {
      const masterRelayUrl = await relayMaster(url, headerObject(videoHeaders), audioUrl, audioAuth);
      appendLaunchLog("[" + new Date().toISOString() + "] started master relay: " + masterRelayUrl);
      launchPayload.url = masterRelayUrl;
      launchPayload.isMasterRelay = true;
    } catch (err) {
      appendLaunchLog("[" + new Date().toISOString() + "] master relay failed, falling back: " + String(err));
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
  const command = publicCommand(mpvBin, args);
  ensureDir(configDir());

  // Single instance: a live window always takes the new video via IPC
  // (loadfile replace + unpause + bring-to-front). If it does not answer
  // correctly it is terminated so the fresh spawn never leaves the previous
  // video frozen on screen.
  if (await ipcAlive()) {
    const target = liveIpc || ipcPath();
    try {
      await replaceViaIpc(launchPayload, args, target, wantQueue);
      appendLaunchLog("[" + new Date().toISOString() + "] IPC " + (wantQueue ? "append-play" : "replace") + " ok");
      void subtitleFilesPromise.then((files) => attachSubtitlesWhenReady(files, target));
      return { ok: true, error: null, code: "OK", command, queued: wantQueue, reused: true };
    } catch (err) {
      appendLaunchLog("[" + new Date().toISOString() + "] IPC replace failed, respawning: " +
        String((err && err.message) || err));
      await terminateMpv(target);
    }
  } else {
    // No IPC answer: any recorded instance is hung (or already gone).
    await terminateMpv(null);
  }

  try {
    spawnMpv(mpvBin, args, Date.now());
    void subtitleFilesPromise.then((files) => attachSubtitlesWhenReady(files, ipcPath())).catch((err) => {
      appendLaunchLog("[" + new Date().toISOString() + "] subtitle attach failed: " +
        String((err && err.message) || err));
    });
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
  findMpv: resolveMpvBin,
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
