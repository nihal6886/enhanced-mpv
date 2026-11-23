// Startup error logging - wrap in try/catch to log any startup failures
try {
  require("./config"); // Ensure config module loads first for logging
} catch (err) {
  const fs = require("fs");
  const path = require("path");
  try {
    const logPath = path.join(process.env.USERPROFILE || "", ".enhanced-mpv", "last-launch.log");
    const msg = "[" + new Date().toISOString() + "] STARTUP FAILED: " + String((err && err.stack) || err) + "\n";
    fs.appendFileSync(logPath, msg, "utf8");
  } catch {
    // Ignore logging failures
  }
}

"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");
const { configDir, ensureDir } = require("./config");
const { appendLaunchLog, resolveMpvBin, fastDispatch } = require("./mpv-launcher");
const { prefetchStreamSegments, getPrefetchCacheStats } = require("./stream-relay");
const { headerFields, joinHeaderFields, sanitizeTitle } = require("./sanitizer");
const {
  PipelineStage,
  canTransition,
  createInitialPipelineState,
  createPipelineStateEvent,
} = require("./pipeline-state");

let starting = null;
let activeServer = null;

const IPC_PIPE_PATH = "\\\\.\\pipe\\enhanced-mpv-socket";

let persistentSocket = null;
let socketReconnectTimer = null;
let socketConnecting = false;
const prewarmedStreams = new Map();
let standbyMpvProcess = null;
let isRestarting = false;

let ipcReadBuffer = "";
let ipcRequestSeq = 500000;
const pendingIpcRequests = new Map();
let lastVideoWidth = 0;
let lastVideoHeight = 0;
let coreIdle = true;

// Global error handlers to prevent process exit
process.on("uncaughtException", (err) => {
  appendLaunchLog("[" + new Date().toISOString() + "] UNCAUGHT EXCEPTION: " + String((err && err.stack) || err));
});

process.on("unhandledRejection", (reason) => {
  appendLaunchLog("[" + new Date().toISOString() + "] UNHANDLED REJECTION: " + String(reason));
});

// ============================================================================
// UNIFIED PIPELINE STATE MACHINE - Single Source of Truth
// ============================================================================

let pipelineState = createInitialPipelineState();
const pipelineStateListeners = new Set(); // WS clients + internal listeners

function setPipelineStage(newStage, extra = {}) {
  if (!canTransition(pipelineState.stage, newStage)) {
    appendLaunchLog(`[${new Date().toISOString()}] Invalid transition: ${pipelineState.stage} -> ${newStage}`);
    return false;
  }

  const prevStage = pipelineState.stage;
  pipelineState = {
    ...pipelineState,
    ...extra,
    stage: newStage,
    updatedAt: Date.now(),
  };

  appendLaunchLog(`[${new Date().toISOString()}] PipelineState: ${prevStage} -> ${newStage}${extra.candidate ? ` (${extra.candidate.id})` : ""}`);
  emitPipelineState();
  return true;
}

function updatePipelineState(updates) {
  pipelineState = {
    ...pipelineState,
    ...updates,
    updatedAt: Date.now(),
  };
  emitPipelineState();
}

function getPipelineState() {
  return { ...pipelineState };
}

function registerPipelineListener(listener) {
  pipelineStateListeners.add(listener);
  // Immediately send current state
  listener(createPipelineStateEvent(pipelineState, "daemon"));
  return () => pipelineStateListeners.delete(listener);
}

function emitPipelineState() {
  const stats = getPrefetchCacheStats();
  const stateWithStats = {
    ...pipelineState,
    relayStats: stats,
  };
  const event = createPipelineStateEvent(stateWithStats, "daemon");

  // Notify internal listeners
  for (const listener of pipelineStateListeners) {
    try {
      listener(event);
    } catch {
      // Ignore listener errors
    }
  }
}

// ============================================================================
// ZERO-WAIT SHADOW PRE-LOAD STATE (integrated into PipelineState)
// ============================================================================

let preloadStartTime = 0;

async function startPreload(candidate, tabId, startTime) {
  preloadStartTime = Date.now();
  lastVideoWidth = 0;
  lastVideoHeight = 0;
  coreIdle = true;

  updatePipelineState({
    stage: PipelineStage.PREWARMING,
    candidate,
    tabId,
    startTime,
    frameReady: false,
    prewarmMs: 0,
  });

  // Trigger RAM Segment Ring prefetch
  void prefetchStreamSegments(candidate.url, candidate.videoHeaders || candidate.headers || {}).catch(() => {});

  try {
    await ensureStandbyMpv();
    await connectPersistentSocket();
    const opts = {
      pause: "yes",
      start: startTime && startTime > 0 ? "+" + Math.floor(startTime) : "none",
      "demuxer-lavf-analyzeduration": "0.5",
      "demuxer-lavf-probesize": "262144",
      cache: "yes",
      "cache-secs": "15",
      "demuxer-readahead-secs": "5",
      "hls-bitrate": "max",
    };
    const headerOption = buildHeaderOption(candidate);
    if (headerOption) opts["http-header-fields"] = headerOption;
    const reply = await sendPersistentIpc(["loadfile", candidate.url, "replace", -1, opts], 1200);
    appendLaunchLog(
      "[" + new Date().toISOString() + "] preload loadfile " +
      (reply && reply.error === "success" ? "ok" : "no-ack") + " " + candidate.url
    );
  } catch (err) {
    appendLaunchLog("[" + new Date().toISOString() + "] preload failed: " + String((err && err.message) || err));
  }
}

function markFrameReady() {
  if (pipelineState.frameReady) return;
  const prewarmMs = preloadStartTime ? Date.now() - preloadStartTime : 0;
  const earlyStage =
    pipelineState.stage === PipelineStage.SNIFFING ||
    pipelineState.stage === PipelineStage.PROBING ||
    pipelineState.stage === PipelineStage.PREWARMING;
  updatePipelineState({
    frameReady: true,
    prewarmMs: prewarmMs || pipelineState.prewarmMs || 0,
    ...(earlyStage ? { stage: PipelineStage.SHADOW_READY } : {}),
  });
  appendLaunchLog(`[${new Date().toISOString()}] Pipeline: frame ready in ${prewarmMs}ms`);
}

function canZeroWaitLaunch(candidateId, tabId) {
  return pipelineState.frameReady &&
         pipelineState.candidate &&
         pipelineState.candidate.id === candidateId &&
         pipelineState.tabId === tabId &&
         !pipelineState.candidate.audioUrl &&
         pipelineState.stage === PipelineStage.SHADOW_READY;
}

async function executeZeroWaitLaunch(startTime, title) {
  const launchStart = Date.now();

  await connectPersistentSocket();
  if (!persistentSocket || persistentSocket.destroyed || !persistentSocket.writable) {
    return false;
  }

  const commands = [
    ["set_property", "window-minimized", "no"],
    ["set_property", "ontop", true],
    ["script-message", "enhanced-mpv-loading", title || "Enhanced MPV"],
    ["script-message", "enhanced-mpv-focus"],
    ["seek", startTime && startTime > 0 ? startTime : 0, "absolute+exact"],
    ["set_property", "pause", false],
  ];

  for (const cmd of commands) {
    const reply = await sendPersistentIpc(cmd, 300);
    if (!reply || reply.error !== "success") {
      appendLaunchLog("[" + new Date().toISOString() + "] hot path IPC failed on " + cmd[0]);
      return false;
    }
  }

  setTimeout(() => {
    void sendPersistentIpc(["set_property", "ontop", false], 150).catch(() => {});
  }, 500);

  const launchMs = Date.now() - launchStart;
  updatePipelineState({
    stage: PipelineStage.LAUNCHING,
    launchMs,
  });
  setTimeout(() => {
    if (pipelineState.stage === PipelineStage.LAUNCHING) {
      setPipelineStage(PipelineStage.PLAYING);
    }
  }, 50);
  appendLaunchLog(`[${new Date().toISOString()}] Zero-Wait HOT PATH: launch in ${launchMs}ms`);
  return true;
}

async function executeColdLaunch(candidate, startTime, title) {
  const launchStart = Date.now();

  await ensureStandbyMpv();
  await connectPersistentSocket();
  updatePipelineState({
    stage: PipelineStage.LAUNCHING,
    candidate,
  });

  const opts = {
    start: startTime && startTime > 0 ? String(startTime) : "none",
    "demuxer-lavf-analyzeduration": "0.5",
    "demuxer-lavf-probesize": "262144",
    cache: "yes",
    "cache-secs": "15",
    "demuxer-readahead-secs": "5",
    "hls-bitrate": "max",
    "cache-pause-initial": "no",
    "initial-audio-sync": "no",
  };
  const headerOption = buildHeaderOption(candidate);
  if (headerOption) opts["http-header-fields"] = headerOption;

  // A standby process is useful only when mpv has created its native window.
  // Give the IPC pipe 200 ms to report the HWND before taking the visible
  // launcher fallback path.
  let windowReady = false;
  const windowDeadline = Date.now() + 200;
  while (Date.now() < windowDeadline) {
    const windowReply = await sendPersistentIpc(["get_property", "window-id"], 60).catch(() => null);
    if (windowReply && windowReply.error === "success" && Number(windowReply.data) !== 0) {
      windowReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }

  const ipcCommands = [
    ["set_property", "force-window", "yes"],
    ["set_property", "window-minimized", "no"],
    ["set_property", "ontop", true],
    ["script-message", "enhanced-mpv-loading", title || candidate.title || "Enhanced MPV"],
    ["script-message", "enhanced-mpv-focus"],
    ["loadfile", candidate.url, "replace", -1, opts],
  ];

  let acked = windowReady;
  if (!windowReady) {
    appendLaunchLog("[" + new Date().toISOString() + "] standby window-id unavailable within 200ms");
  }
  for (const cmd of ipcCommands) {
    const reply = await sendPersistentIpc(cmd, cmd[0] === "loadfile" ? 1200 : 250);
    if (!reply || reply.error !== "success") {
      acked = false;
      appendLaunchLog("[" + new Date().toISOString() + "] cold launch IPC failed on " + cmd[0]);
      break;
    }
  }

  if (acked) {
    setTimeout(() => {
      void sendPersistentIpc(["set_property", "ontop", false], 150).catch(() => {});
    }, 500);
    const launchMs = Date.now() - launchStart;
    updatePipelineState({ launchMs });
    appendLaunchLog(`[${new Date().toISOString()}] Cold launch dispatched in ${launchMs}ms`);
    return true;
  }

  // Fallback: spawn / reuse a visible enhanced-mpv.exe through the launcher,
  // which opens the window with --force-window=immediate even when the
  // daemon's persistent socket is stale.
  appendLaunchLog("[" + new Date().toISOString() + "] cold launch falling back to visible spawn");
  const fallback = await fastDispatch({
    url: candidate.url,
    title: candidate.title || title || "Enhanced MPV",
    headers: candidate.videoHeaders || candidate.headers || {},
    audioUrl: candidate.audioUrl,
    audioHeaders: candidate.audioHeaders,
    startTime: startTime || 0,
    candidates: [candidate],
    qualities: pipelineState.qualities || [],
    action: "play",
  }, "replace");
  const launchMs = Date.now() - launchStart;
  updatePipelineState({ launchMs });
  return Boolean(fallback && fallback.ok);
}

// ============================================================================
// IPC observed properties
// ============================================================================

const MPV_OBSERVED_PROPS = [
  "time-pos", "pause", "width", "height",
  "demuxer-cache-duration", "media-title", "path", "duration",
  "video-out-params", "core-idle",
];

function buildHeaderOption(candidate) {
  const parts = headerFields({ headers: candidate.videoHeaders || candidate.headers || {} });
  return parts.length ? joinHeaderFields(parts) : "";
}

// ============================================================================
// Daemon endpoint management
// ============================================================================

function endpointPath() {
  return path.join(configDir(), "daemon.json");
}

function readDaemonEndpoint() {
  try {
    const raw = JSON.parse(fs.readFileSync(endpointPath(), "utf8"));
    if (!raw || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) return null;
    if (typeof raw.token !== "string" || raw.token.length < 16) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeDaemonEndpoint(endpoint) {
  ensureDir(configDir());
  try {
    for (const entry of fs.readdirSync(configDir())) {
      if (/^daemon\.json\..*\.tmp$/.test(entry)) {
        try { fs.unlinkSync(path.join(configDir(), entry)); } catch { /* ignore */ }
      }
    }
  } catch {
    // Directory may not exist yet; ensureDir above handles that.
  }
  const target = endpointPath();
  const tmp = target + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(endpoint), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, target);
}

function clearDaemonEndpoint() {
  const endpoint = readDaemonEndpoint();
  if (endpoint && endpoint.pid !== process.pid) return;
  try { fs.unlinkSync(endpointPath()); } catch { /* no file */ }
}

function tokenMatches(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function logError(message) {
  appendLaunchLog("[" + new Date().toISOString() + "] launch daemon: " + message);
}

// ============================================================================
// Persistent IPC Socket
// ============================================================================

function resetIpcState() {
  ipcReadBuffer = "";
  for (const entry of pendingIpcRequests.values()) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(null);
  }
  pendingIpcRequests.clear();
}

function connectPersistentSocket() {
  if (socketConnecting || (persistentSocket && persistentSocket.writable && !persistentSocket.destroyed)) {
    return Promise.resolve(persistentSocket);
  }
  socketConnecting = true;
  return new Promise((resolve) => {
    let settled = false;
    let connectGuard = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (connectGuard) clearTimeout(connectGuard);
      resolve(value);
    };
    let sock;
    try {
      sock = net.connect(IPC_PIPE_PATH);
    } catch (err) {
      socketConnecting = false;
      appendLaunchLog("[" + new Date().toISOString() + "] persistent IPC connect threw: " + String(err));
      scheduleSocketReconnect();
      finish(null);
      return;
    }
    sock.setNoDelay(true);
    connectGuard = setTimeout(() => {
      if (persistentSocket !== sock) {
        socketConnecting = false;
        try { sock.destroy(); } catch { /* ignore */ }
        scheduleSocketReconnect();
        finish(null);
      }
    }, 1500);
    sock.on("connect", () => {
      socketConnecting = false;
      persistentSocket = sock;
      resetIpcState();
      if (socketReconnectTimer) {
        clearTimeout(socketReconnectTimer);
        socketReconnectTimer = null;
      }
      appendLaunchLog("[" + new Date().toISOString() + "] persistent IPC socket connected");
      subscribeToMpvProperties();
      finish(sock);
    });
    sock.on("error", (err) => {
      socketConnecting = false;
      if (persistentSocket === sock) persistentSocket = null;
      appendLaunchLog("[" + new Date().toISOString() + "] persistent IPC socket error: " +
        String((err && (err.code || err.message)) || err));
      scheduleSocketReconnect();
      finish(null);
    });
    sock.on("close", () => {
      if (persistentSocket === sock) {
        persistentSocket = null;
        resetIpcState();
        scheduleSocketReconnect();
      }
    });
    sock.on("data", handleMpvIpcResponse);
    // No idle timeout: the socket must stay open so observe_property
    // subscriptions survive between launches.
  });
}

function scheduleSocketReconnect() {
  if (socketReconnectTimer) return;
  socketReconnectTimer = setTimeout(() => {
    socketReconnectTimer = null;
    connectPersistentSocket().catch(() => {});
  }, 750);
}

function flushIpcCommands(commands) {
  const sock = persistentSocket;
  if (!sock || sock.destroyed || !sock.writable) return false;
  try {
    for (const cmd of commands) {
      // mpv IPC requires every command to be wrapped in a {"command": [...]}
      // envelope. A bare JSON array is parsed as an event and ignored.
      sock.write(JSON.stringify({ command: cmd }) + "\n");
    }
    return true;
  } catch {
    return false;
  }
}

function sendPersistentIpc(command, timeoutMs) {
  const sock = persistentSocket;
  if (!sock || sock.destroyed || !sock.writable) return Promise.resolve(null);
  return new Promise((resolve) => {
    const requestId = 1000 + (++ipcRequestSeq % 1000000);
    const entry = {
      timer: null,
      resolve: (value) => {
        if (entry.timer) clearTimeout(entry.timer);
        pendingIpcRequests.delete(requestId);
        resolve(value);
      },
    };
    entry.timer = setTimeout(() => entry.resolve(null), Math.max(50, timeoutMs || 250));
    pendingIpcRequests.set(requestId, entry);
    try {
      sock.write(JSON.stringify({ command, request_id: requestId }) + "\n");
    } catch {
      entry.resolve(null);
    }
  });
}

function subscribeToMpvProperties() {
  const sock = persistentSocket;
  if (!sock || sock.destroyed || !sock.writable) return;
  MPV_OBSERVED_PROPS.forEach((prop, index) => {
    try {
      sock.write(JSON.stringify({ command: ["observe_property", 1000 + index, prop] }) + "\n");
    } catch {
      // Ignore individual subscription failures.
    }
  });
}

function maybeMarkFrameReady() {
  if (lastVideoWidth > 0 && lastVideoHeight > 0 && coreIdle !== true) {
    markFrameReady();
  }
}

function handleMpvIpcResponse(data) {
  ipcReadBuffer += data.toString("utf8");
  let newlineIndex;
  while ((newlineIndex = ipcReadBuffer.indexOf("\n")) >= 0) {
    const line = ipcReadBuffer.slice(0, newlineIndex).trim();
    ipcReadBuffer = ipcReadBuffer.slice(newlineIndex + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.request_id != null && pendingIpcRequests.has(msg.request_id)) {
      const entry = pendingIpcRequests.get(msg.request_id);
      pendingIpcRequests.delete(msg.request_id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(msg);
      continue;
    }
    if (msg.event !== "property-change" || !msg.name) continue;
    if (msg.name === "video-out-params" && msg.data && typeof msg.data === "object") {
      lastVideoWidth = Number(msg.data.w || msg.data.width || 0) || 0;
      lastVideoHeight = Number(msg.data.h || msg.data.height || 0) || 0;
      maybeMarkFrameReady();
    } else if (msg.name === "core-idle") {
      coreIdle = msg.data === true;
      maybeMarkFrameReady();
    }
  }
}

// ============================================================================
// IPC Command Helpers (no WebSocket)
// ============================================================================

function updateMpvSources(tabId, candidates, qualities) {
  const payload = {
    type: "enhanced-mpv-sources",
    candidates,
    qualities,
    tabId,
    timestamp: Date.now()
  };
  flushIpcCommands([["script-message", "enhanced-mpv-sources", JSON.stringify(payload)]]);
}

function cacheCandidatesForTab(tabId, candidates, qualities) {
  if (!global.cachedCandidatesByTab) global.cachedCandidatesByTab = new Map();
  global.cachedCandidatesByTab.set(tabId, { candidates, qualities, updatedAt: Date.now() });
}

function isHealthy(endpoint) {
  return new Promise((resolve) => {
    const request = http.get({
      host: "127.0.0.1",
      port: endpoint.port,
      path: "/health",
    }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(500, () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

// ============================================================================
// Standby MPV Management
// ============================================================================

async function spawnStandbyMpv() {
  const mpvBin = resolveMpvBin();
  if (!mpvBin) {
    appendLaunchLog("[" + new Date().toISOString() + "] cannot spawn standby: mpv not found");
    return null;
  }
  if (standbyMpvProcess && !standbyMpvProcess.killed) {
    return standbyMpvProcess;
  }
  const args = [
    "--idle=yes",
    "--force-window=yes",
    "--window-minimized=yes",
    "--no-terminal",
    "--input-ipc-server=" + IPC_PIPE_PATH,
    "--demuxer-lavf-analyzeduration=0.5",
    "--demuxer-lavf-probesize=262144",
    "--cache=yes",
    "--cache-secs=15",
    "--demuxer-readahead-secs=5",
    "--hls-bitrate=max",
    "--log-file=" + path.join(configDir(), "mpv-runtime.log"),
  ];
  ensureDir(configDir());
  const child = spawn(mpvBin, args, {
    detached: false,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      HOME: process.env.USERPROFILE || process.env.HOME || "",
    },
  });
  standbyMpvProcess = child;
  appendLaunchLog("[" + new Date().toISOString() + "] standby mpv spawned pid=" + child.pid);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    appendLaunchLog("[" + new Date().toISOString() + "] standby stderr: " + chunk.slice(0, 2000));
  });
  child.on("exit", (code, signal) => {
    appendLaunchLog("[" + new Date().toISOString() + "] standby mpv exited code=" + code + " signal=" + signal);
    standbyMpvProcess = null;
    // Pipeline returns to IDLE when mpv exits
    if (pipelineState.stage === PipelineStage.PLAYING || pipelineState.stage === PipelineStage.LAUNCHING) {
      setPipelineStage(PipelineStage.IDLE, { candidate: null, frameReady: false });
    }
    if (!isRestarting) {
      setTimeout(() => spawnStandbyMpv(), 100);
    }
  });
  child.on("error", (err) => {
    appendLaunchLog("[" + new Date().toISOString() + "] standby mpv error: " + err.message);
    standbyMpvProcess = null;
    if (!isRestarting) {
      setTimeout(() => spawnStandbyMpv(), 100);
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  await connectPersistentSocket().catch(() => {});
  return child;
}

async function ensureStandbyMpv() {
  if (!standbyMpvProcess || standbyMpvProcess.killed) {
    await spawnStandbyMpv();
  }
}

function killStandbyMpv() {
  isRestarting = true;
  if (standbyMpvProcess && !standbyMpvProcess.killed) {
    try { standbyMpvProcess.kill("SIGKILL"); } catch { /* ignore */ }
  }
  standbyMpvProcess = null;
  isRestarting = false;
}

// ============================================================================
// Launch payload normalization / dispatch
// ============================================================================

function normalizePlayPayload(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const headers = input.headers && typeof input.headers === "object" ? input.headers : {};
  const videoHeaders = input.videoHeaders && typeof input.videoHeaders === "object" ? input.videoHeaders : {};
  const mergedHeaders = { ...headers, ...videoHeaders };
  const startTime = Number(input.startTime ?? input.timePos ?? input.currentTime ?? 0) || 0;
  return {
    ...input,
    url: input.url || input.pageUrl || input.videoUrl || input.src || "",
    title: sanitizeTitle(input.title || input.pageTitle || ""),
    headers: mergedHeaders,
    videoHeaders: mergedHeaders,
    audioUrl: input.audioUrl || null,
    audioHeaders: input.audioHeaders || {},
    startTime,
    duration: Number(input.duration ?? 0) || 0,
    action: input.action || "play",
    candidates: Array.isArray(input.candidates) ? input.candidates : [],
    qualities: Array.isArray(input.qualities) ? input.qualities : [],
  };
}

async function dispatchPlay(rawPayload) {
  const payload = normalizePlayPayload(rawPayload);
  if (!payload.url) {
    return { status: 400, body: { ok: false, error: "url required", code: "BAD_REQUEST" } };
  }

  if (payload.action === "queue") {
    const queued = await fastDispatch(payload, "queue");
    return { status: 200, body: queued };
  }

  const prewarmed = prewarmedStreams.get(payload.url);
  if (prewarmed) {
    payload.videoHeaders = { ...prewarmed.videoHeaders, ...payload.videoHeaders };
    payload.headers = { ...payload.videoHeaders };
    if (!payload.audioUrl && prewarmed.audioUrl) payload.audioUrl = prewarmed.audioUrl;
    if ((!payload.audioHeaders || !Object.keys(payload.audioHeaders).length) && prewarmed.audioHeaders) {
      payload.audioHeaders = prewarmed.audioHeaders;
    }
    if (!payload.title && prewarmed.title) payload.title = prewarmed.title;
    prewarmedStreams.delete(payload.url);
  }

  const candidateId = payload.candidateId || payload.url;
  const tabId = payload.tabId || 0;
  const startTime = payload.startTime || 0;

  if (canZeroWaitLaunch(candidateId, tabId)) {
    const zeroWaitOk = await executeZeroWaitLaunch(startTime, payload.title || pipelineState.candidate.title);
    if (zeroWaitOk) {
      appendLaunchLog("[" + new Date().toISOString() + "] Zero-Wait HOT PATH launch for " + payload.url);
      return {
        status: 200,
        body: {
          ok: true,
          fast: true,
          zeroWait: true,
          persistentSocket: true,
          pipelineStage: PipelineStage.PLAYING,
        },
      };
    }
  }

  const candidate = {
    id: candidateId,
    url: payload.url,
    title: payload.title || "Enhanced MPV",
    audioUrl: payload.audioUrl,
    audioHeaders: payload.audioHeaders,
    videoHeaders: payload.videoHeaders,
  };

  const coldOk = await executeColdLaunch(candidate, startTime, payload.title);
  if (coldOk) {
    return {
      status: 200,
      body: {
        ok: true,
        fast: true,
        persistentSocket: true,
        pipelineStage: pipelineState.stage,
      },
    };
  }

  const result = await fastDispatch(payload, "replace");
  return { status: 200, body: result };
}

// ============================================================================
// HTTP Server (stateless loopback HTTP)
// ============================================================================

const FIXED_DAEMON_PORT = 0;

async function startLaunchDaemon(options) {
  if (activeServer) return activeServer;
  const opts = options || {};
  const token = crypto.randomBytes(24).toString("hex");
  process.env.ENHANCED_MPV_DAEMON = "1";

  // Use ephemeral port (0 = OS-assigned)
  const preferredPort = opts.fixedPort === false ? 0 : FIXED_DAEMON_PORT;

  const server = http.createServer((req, res) => {
    // Allow /health without token for health checks
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        pid: process.pid,
        pipelineStage: pipelineState.stage,
      }));
      return;
    }

    // Authenticated /state endpoint - returns full PipelineState
    if (req.method === "GET" && req.url === "/state") {
      if (!tokenMatches(req.headers["x-enhanced-mpv-token"], token)) {
        res.writeHead(401);
        res.end();
        return;
      }
      const stats = getPrefetchCacheStats();
      const stateWithStats = {
        ...pipelineState,
        relayStats: stats,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        payload: stateWithStats,
        source: "daemon",
        timestamp: Date.now(),
      }));
      return;
    }

    if (!tokenMatches(req.headers["x-enhanced-mpv-token"], token)) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method === "POST" && req.url === "/prewarm-stream") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString("utf8");
        if (body.length > 1024 * 1024) req.destroy();
      });
      req.on("end", async () => {
        try {
          const { videoUrl, videoHeaders, audioUrl, audioHeaders, title, candidateId, tabId, startTime, verified } = JSON.parse(body);
          if (!videoUrl) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "videoUrl required", code: "BAD_REQUEST" }));
            return;
          }
          const key = videoUrl;
          if (!prewarmedStreams.has(key)) {
            prewarmedStreams.set(key, {
              videoUrl,
              videoHeaders: videoHeaders || {},
              audioUrl: audioUrl || null,
              audioHeaders: audioHeaders || {},
              title: title || "",
              registeredAt: Date.now(),
            });
            appendLaunchLog("[" + new Date().toISOString() + "] prewarmed stream: " + videoUrl);
          }

          // Trigger RAM Segment Ring prefetch
          void prefetchStreamSegments(videoUrl, videoHeaders || {}).catch(() => {});

          // If verified candidate, start preload pipeline
          if (verified && candidateId && tabId) {
            await ensureStandbyMpv();
            const candidate = {
              id: candidateId,
              url: videoUrl,
              title: title || "",
              audioUrl,
              audioHeaders,
              videoHeaders: videoHeaders || {},
            };
            // Transition to SNIFFING -> PROBING -> PREWARMING
            setPipelineStage(PipelineStage.SNIFFING, { tabId, candidate });
            setPipelineStage(PipelineStage.PROBING, { candidate });
            startPreload(candidate, tabId, startTime || 0);
          } else {
            ensureStandbyMpv().catch(() => {});
            if (pipelineState.stage === PipelineStage.IDLE) {
              setPipelineStage(PipelineStage.SNIFFING, { tabId });
            }
          }

          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, prewarmed: true, pipelineStage: pipelineState.stage }));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err), code: "PREWARM_FAILED" }));
        }
      });
      return;
    }
    if (req.method === "POST" && req.url === "/dispatch") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString("utf8");
        if (body.length > 1024 * 1024) req.destroy();
      });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          const { handle } = require("./index");

          if (payload.action === "play" || payload.action === "queue") {
            const out = await dispatchPlay(payload);
            res.writeHead(out.status, { "content-type": "application/json" });
            res.end(JSON.stringify(out.body));
            return;
          }

          // Handle other dispatch types (seek, pause, switch-quality, candidates-update)
          if (payload.type === "extension:seek") {
            flushIpcCommands([["seek", payload.timePos, "absolute"]]);
            updatePipelineState({ lastSeekTime: payload.timePos });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (payload.type === "extension:pause") {
            flushIpcCommands([["set_property", "pause", payload.paused]]);
            updatePipelineState({ paused: payload.paused });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (payload.type === "extension:switch-quality") {
            flushIpcCommands([["script-message", "stream-controller-switch", String(payload.index)]]);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          if (payload.type === "extension:candidates-update") {
            if (payload.candidates && payload.candidates.length) {
              updatePipelineState({
                candidates: payload.candidates,
                qualities: payload.qualities || [],
                tabId: payload.tabId,
              });

              // If we're in SNIFFING/PROBING and have a verified top candidate, advance
              if (pipelineState.stage === PipelineStage.SNIFFING || pipelineState.stage === PipelineStage.PROBING) {
                const topCandidate = payload.candidates[0];
                if (topCandidate && topCandidate.verified) {
                  setPipelineStage(PipelineStage.PROBING, { candidate: topCandidate, tabId: payload.tabId });
                  // Trigger preload for verified candidate
                  startPreload(topCandidate, payload.tabId, 0);
                }
              }
            }
            // Forward to mpv via IPC for menu updates
            updateMpvSources(payload.tabId, payload.candidates, payload.qualities);
            cacheCandidatesForTab(payload.tabId, payload.candidates, payload.qualities);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          const result = await handle(payload);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result === undefined ? { ok: true } : result));
        } catch (err) {
          const message = String((err && err.message) || err);
          logError("dispatch failed: " + message);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: message, code: "DAEMON_DISPATCH_FAILED" }));
        }
      });
      return;
    }
    if (req.method === "POST" && req.url === "/play") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString("utf8");
        if (body.length > 1024 * 1024) req.destroy();
      });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          payload.action = "play";
          const out = await dispatchPlay(payload);
          res.writeHead(out.status, { "content-type": "application/json" });
          res.end(JSON.stringify(out.body));
        } catch (err) {
          const message = String((err && err.message) || err);
          logError("play failed: " + message);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: message, code: "DAEMON_PLAY_FAILED" }));
        }
      });
      return;
    }
    if (req.method === "GET" && req.url === "/pipeline-state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(pipelineState));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on("clientError", (err, socket) => {
    try { socket.end(); } catch { /* socket gone */ }
  });

  await new Promise((resolve, reject) => {
    server.once("error", (err) => {
      // If fixed port fails, try ephemeral
      if (preferredPort !== 0 && err.code === "EADDRINUSE") {
        appendLaunchLog("[" + new Date().toISOString() + "] Fixed port " + preferredPort + " in use, falling back to ephemeral");
        server.listen(0, "127.0.0.1", resolve);
      } else {
        reject(err);
      }
    });
    server.listen(preferredPort, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  const endpoint = { port, token, pid: process.pid, startedAt: Date.now() };
  writeDaemonEndpoint(endpoint);

  await ensureStandbyMpv();

  const close = () => new Promise((resolve) => {
    clearDaemonEndpoint();
    killStandbyMpv();
    if (persistentSocket) {
      persistentSocket.destroy();
      persistentSocket = null;
    }
    if (socketReconnectTimer) {
      clearTimeout(socketReconnectTimer);
      socketReconnectTimer = null;
    }
    server.close(() => {
      activeServer = null;
      resolve();
    });
  });

activeServer = { server, port, token, endpoint, close };
  return activeServer;
}

async function ensureLaunchDaemon(timeoutMs) {
  // Check cached endpoint from daemon.json
  const cached = readDaemonEndpoint();
  if (cached && await isHealthy(cached)) return cached;

  if (starting) return starting;
  starting = (async () => {
    const current = readDaemonEndpoint();
    if (current && await isHealthy(current)) return current;
    try {
      const isNode = !process.pkg && /^node(?:\.exe)?$/i.test(path.basename(process.execPath));
      const daemonScriptPath = path.join(__dirname, "index.js");
      const args = isNode
        ? [daemonScriptPath, "--launch-daemon"]
        : ["--launch-daemon"];

      let child;
      if (process.platform === "win32") {
        // On Windows, spawn detached from Job Object using reliable Node spawn
        // This prevents Brave's Native Messaging Job Object from killing the daemon
        const nodeExe = process.execPath;
        child = spawn(nodeExe, args, {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          cwd: __dirname,
        });
      } else {
        child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
      }

      child.on("error", (err) => logError("spawn failed: " + String((err && err.message) || err)));
      child.unref();
    } catch (err) {
      logError("spawn failed: " + String((err && err.message) || err));
      return null;
    }
    const deadline = Date.now() + (timeoutMs || 3000);
    while (Date.now() < deadline) {
      const endpoint = readDaemonEndpoint();
      if (endpoint && await isHealthy(endpoint)) return endpoint;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Timeout - delete stale daemon.json so dead ports are never returned
    clearDaemonEndpoint();
    logError("daemon did not become ready");
    return null;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

module.exports = {
  startLaunchDaemon,
  ensureLaunchDaemon,
  readDaemonEndpoint,
  isHealthy,
  connectPersistentSocket,
  flushIpcCommands,
  sendPersistentIpc,
  subscribeToMpvProperties,
  normalizePlayPayload,
  dispatchPlay,
  prewarmedStreams,
  IPC_PIPE_PATH,
  spawnStandbyMpv,
  ensureStandbyMpv,
  killStandbyMpv,
  pipelineState,
  getPipelineState,
  setPipelineStage,
  updatePipelineState,
  registerPipelineListener,
  PipelineStage,
  canZeroWaitLaunch,
  executeZeroWaitLaunch,
  executeColdLaunch,
  startPreload,
  markFrameReady,
};
