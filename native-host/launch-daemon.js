"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");
const { configDir, ensureDir } = require("./config");
const { appendLaunchLog, resolveMpvBin } = require("./mpv-launcher");
const { prefetchStreamSegments, getPrefetchCacheStats } = require("./stream-relay");
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
  const payload = JSON.stringify(event);

  // Broadcast to all WebSocket clients
  for (const [, client] of wsClients) {
    if (client.alive && client.socket && client.socket.writable) {
      sendWsFrame(client.socket, payload);
    }
  }

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

function startPreload(candidate, tabId, startTime) {
  preloadStartTime = Date.now();

  updatePipelineState({
    stage: PipelineStage.PREWARMING,
    candidate,
    tabId,
    startTime,
    frameReady: false,
    prewarmMs: 0,
  });

  // Trigger RAM Segment Ring prefetch
  void prefetchStreamSegments(candidate.url, candidate.videoHeaders || {}).catch(() => {});
}

function markFrameReady() {
  if (!pipelineState.frameReady) {
    const prewarmMs = Date.now() - preloadStartTime;
    updatePipelineState({
      frameReady: true,
      prewarmMs,
      stage: PipelineStage.SHADOW_READY,
    });
    appendLaunchLog(`[${new Date().toISOString()}] Pipeline: SHADOW_READY achieved in ${prewarmMs}ms`);
  }
}

function canZeroWaitLaunch(candidateId, tabId) {
  return pipelineState.frameReady &&
         pipelineState.candidate &&
         pipelineState.candidate.id === candidateId &&
         pipelineState.tabId === tabId &&
         pipelineState.stage === PipelineStage.SHADOW_READY;
}

async function executeZeroWaitLaunch(startTime) {
  const launchStart = Date.now();
  
  await connectPersistentSocket();
  if (!persistentSocket || persistentSocket.destroyed || !persistentSocket.writable) {
    return false;
  }

  const flushCommands = [
    ["seek", startTime && startTime > 0 ? startTime : 0, "absolute+exact"],
    ["set_property", "pause", false],
    ["set_property", "force-window", "yes"],
    ["script-message", "enhanced-mpv-focus"],
  ];

  const flushed = flushIpcCommands(flushCommands);
  if (flushed) {
    const launchMs = Date.now() - launchStart;
    updatePipelineState({
      stage: PipelineStage.LAUNCHING,
      launchMs,
    });
    // Quick transition to PLAYING after launch
    setTimeout(() => {
      if (pipelineState.stage === PipelineStage.LAUNCHING) {
        setPipelineStage(PipelineStage.PLAYING);
      }
    }, 50);
    appendLaunchLog(`[${new Date().toISOString()}] Zero-Wait HOT PATH: launch in ${launchMs}ms`);
    return true;
  }
  return false;
}

async function executeColdLaunch(candidate, startTime, title) {
  const launchStart = Date.now();
  
  await ensureStandbyMpv();
  await connectPersistentSocket();
  if (!persistentSocket || persistentSocket.destroyed || !persistentSocket.writable) {
    return false;
  }

  updatePipelineState({
    stage: PipelineStage.LAUNCHING,
    candidate,
  });

  const opts = {
    start: startTime && startTime > 0 ? String(startTime) : "none",
    "demuxer-lavf-analyzeduration": "0.15",
    "demuxer-lavf-probesize": "65536",
    cache: "yes",
    "demuxer-readahead-secs": "5",
    "hls-bitrate": "max",
  };

  const ipcCommands = [
    ["set_property", "force-window", "yes"],
    ["script-message", "enhanced-mpv-focus"],
    ["script-message", "enhanced-mpv-loading", title || candidate.title || "Enhanced MPV"],
    ["loadfile", candidate.url, "replace", -1, opts],
  ];

  const flushed = flushIpcCommands(ipcCommands);
  if (flushed) {
    const launchMs = Date.now() - launchStart;
    updatePipelineState({ launchMs });
    appendLaunchLog(`[${new Date().toISOString()}] Cold launch dispatched in ${launchMs}ms`);
    return true;
  }
  return false;
}

// ============================================================================
// WebSocket server state
// ============================================================================

const wsClients = new Map(); // clientId -> { socket, tabId, lastPing, alive }
let wsClientIdCounter = 0;
const MPV_OBSERVED_PROPS = [
  "time-pos", "pause", "width", "height", 
  "demuxer-cache-duration", "media-title", "path", "duration"
];

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

function connectPersistentSocket() {
  if (socketConnecting || (persistentSocket && persistentSocket.writable && !persistentSocket.destroyed)) {
    return Promise.resolve(persistentSocket);
  }
  socketConnecting = true;
  return new Promise((resolve, reject) => {
    const sock = net.connect(IPC_PIPE_PATH);
    sock.setNoDelay(true);
    sock.on("connect", () => {
      socketConnecting = false;
      persistentSocket = sock;
      if (socketReconnectTimer) {
        clearTimeout(socketReconnectTimer);
        socketReconnectTimer = null;
      }
      appendLaunchLog("[" + new Date().toISOString() + "] persistent IPC socket connected");
      subscribeToMpvProperties();
      resolve(sock);
    });
    sock.on("error", (err) => {
      socketConnecting = false;
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT" || err.code === "EPIPE") {
        scheduleSocketReconnect();
        resolve(null);
      } else {
        reject(err);
      }
    });
    sock.on("close", () => {
      if (persistentSocket === sock) {
        persistentSocket = null;
        scheduleSocketReconnect();
      }
    });
    sock.on("data", handleMpvIpcResponse);
    sock.setTimeout(1000, () => {
      sock.destroy();
      socketConnecting = false;
      scheduleSocketReconnect();
      resolve(null);
    });
  });
}

function scheduleSocketReconnect() {
  if (socketReconnectTimer) return;
  socketReconnectTimer = setTimeout(() => {
    socketReconnectTimer = null;
    connectPersistentSocket().catch(() => {});
  }, 500);
}

function flushIpcCommands(commands) {
  const sock = persistentSocket;
  if (!sock || sock.destroyed || !sock.writable) return false;
  try {
    for (const cmd of commands) {
      sock.write(JSON.stringify(cmd) + "\n");
    }
    return true;
  } catch {
    return false;
  }
}

function subscribeToMpvProperties() {
  if (!persistentSocket || persistentSocket.destroyed || !persistentSocket.writable) return;
  for (const prop of MPV_OBSERVED_PROPS) {
    const cmd = ["observe_property", 1000 + MPV_OBSERVED_PROPS.indexOf(prop), prop];
    persistentSocket.write(JSON.stringify(cmd) + "\n");
  }
}

function handleMpvIpcResponse(data) {
  try {
    const lines = data.toString().trim().split("\n");
    for (const line of lines) {
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.event === "property-change" && msg.name) {
        // Update pipeline state with mpv telemetry
        if (msg.name === "video-out-params" && msg.data && typeof msg.data === "object") {
          const width = msg.data.w || msg.data.width || 0;
          const height = msg.data.h || msg.data.height || 0;
          if (width > 0 && height > 0) {
            markFrameReady();
          }
        }
        // Broadcast to WS clients
        broadcastPlayerTelemetry(msg.name, msg.data);
      }
    }
  } catch {
    // Ignore parse errors
  }
}

function broadcastPlayerTelemetry(propName, value) {
  const stateUpdate = { type: "player:state", state: { [propName]: value, timestamp: Date.now() } };
  const payload = JSON.stringify(stateUpdate);
  for (const [, client] of wsClients) {
    if (client.alive && client.socket && client.socket.writable) {
      sendWsFrame(client.socket, payload);
    }
  }
}

// ============================================================================
// WebSocket frame handling (RFC 6455)
// ============================================================================

const WS_OPCODE_TEXT = 0x1;
const WS_OPCODE_CLOSE = 0x8;
const WS_OPCODE_PING = 0x9;
const WS_OPCODE_PONG = 0xA;

function sendWsFrame(socket, payload) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  try {
    const data = Buffer.from(payload, "utf8");
    const frame = Buffer.alloc(2 + data.length);
    frame[0] = 0x80 | WS_OPCODE_TEXT;
    frame[1] = data.length < 126 ? data.length : (data.length < 65536 ? 126 : 127);
    let offset = 2;
    if (data.length >= 126 && data.length < 65536) {
      frame.writeUInt16BE(data.length, 2);
      offset = 4;
    } else if (data.length >= 65536) {
      frame.writeUInt32BE(0, 2);
      frame.writeUInt32BE(data.length, 6);
      offset = 10;
    }
    data.copy(frame, offset);
    socket.write(frame);
    return true;
  } catch {
    return false;
  }
}

function sendWsClose(socket, code = 1000) {
  if (!socket || socket.destroyed) return;
  try {
    const frame = Buffer.alloc(4);
    frame[0] = 0x80 | WS_OPCODE_CLOSE;
    frame[1] = 2;
    frame.writeUInt16BE(code, 2);
    socket.write(frame);
    socket.end();
  } catch { /* ignore */ }
}

function parseWsFrames(buffer, clients, clientId) {
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 2) break;
    const opcode = buffer[offset] & 0x0F;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let payloadLen = buffer[offset + 1] & 0x7F;
    let headerLen = 2;
    
    if (payloadLen === 126) {
      if (buffer.length - offset < 4) break;
      payloadLen = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (buffer.length - offset < 10) break;
      payloadLen = buffer.readUInt32BE(offset + 6);
      headerLen = 10;
    }
    
    if (buffer.length - offset < headerLen + (masked ? 4 : 0) + payloadLen) break;
    
    let maskOffset = headerLen;
    if (masked) {
      const mask = buffer.slice(maskOffset, maskOffset + 4);
      maskOffset += 4;
      const payload = buffer.slice(maskOffset, maskOffset + payloadLen);
      const unmasked = Buffer.alloc(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        unmasked[i] = payload[i] ^ mask[i % 4];
      }
      handleWsMessage(clients.get(clientId), unmasked.toString("utf8"), opcode);
    } else {
      const payload = buffer.slice(maskOffset, maskOffset + payloadLen);
      handleWsMessage(clients.get(clientId), payload.toString("utf8"), opcode);
    }
    
    offset += headerLen + (masked ? 4 : 0) + payloadLen;
  }
  return buffer.slice(offset);
}

function handleWsMessage(client, message, opcode) {
  if (opcode === WS_OPCODE_CLOSE) {
    client.alive = false;
    return;
  }
  if (opcode === WS_OPCODE_PING) {
    const frame = Buffer.alloc(2);
    frame[0] = 0x80 | WS_OPCODE_PONG;
    frame[1] = 0;
    client.socket.write(frame);
    return;
  }
  if (opcode === WS_OPCODE_PONG) {
    client.lastPing = Date.now();
    return;
  }
  if (opcode !== WS_OPCODE_TEXT) return;
  
  try {
    const msg = JSON.parse(message);
    handleWsClientMessage(client, msg);
  } catch {
    // Ignore invalid JSON
  }
}

function handleWsClientMessage(client, msg) {
  switch (msg.type) {
    case "extension:register":
      client.tabId = msg.tabId;
      client.role = "extension";
      appendLaunchLog("[" + new Date().toISOString() + "] WS client registered: tabId=" + msg.tabId);
      // Send current pipeline state
      sendWsFrame(client.socket, JSON.stringify(createPipelineStateEvent(pipelineState, "daemon")));
      break;
    case "extension:heartbeat":
      client.lastPing = Date.now();
      break;
    case "extension:candidates-update":
      // Update pipeline state with new candidates
      if (msg.candidates && msg.candidates.length) {
        updatePipelineState({
          candidates: msg.candidates,
          qualities: msg.qualities || [],
          tabId: msg.tabId,
        });
        
        // If we're in SNIFFING/PROBING and have a verified top candidate, advance
        if (pipelineState.stage === PipelineStage.SNIFFING || pipelineState.stage === PipelineStage.PROBING) {
          const topCandidate = msg.candidates[0];
          if (topCandidate && topCandidate.verified) {
            setPipelineStage(PipelineStage.PROBING, { candidate: topCandidate, tabId: msg.tabId });
            // Trigger preload for verified candidate
            startPreload(topCandidate, msg.tabId, 0);
          }
        }
      }
      // Forward to mpv via IPC for menu updates
      updateMpvSources(msg.tabId, msg.candidates, msg.qualities);
      cacheCandidatesForTab(msg.tabId, msg.candidates, msg.qualities);
      break;
    case "extension:play":
      handlePlayRequest(msg);
      break;
    case "extension:seek":
      sendSeekCommand(msg.timePos);
      break;
    case "extension:pause":
      sendPauseCommand(msg.paused);
      break;
    case "extension:switch-quality":
      switchMpvQuality(msg.index);
      break;
    case "pipeline:getState":
      sendWsFrame(client.socket, JSON.stringify(createPipelineStateEvent(pipelineState, "daemon")));
      break;
  }
}

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

function handlePlayRequest(msg) {
  const { handle } = require("./index");
  handle({
    action: "play",
    url: msg.url,
    title: msg.title,
    referer: msg.referer,
    userAgent: msg.userAgent,
    cookies: msg.cookies,
    headers: msg.headers,
    audioUrl: msg.audioUrl,
    audioHeaders: msg.audioHeaders,
    startTime: msg.startTime,
    candidates: msg.candidates,
    qualities: msg.qualities
  }).catch(err => logError("WS play request failed: " + err.message));
}

function sendSeekCommand(timePos) {
  flushIpcCommands([["seek", timePos, "absolute"]]);
  updatePipelineState({ lastSeekTime: timePos });
}

function sendPauseCommand(paused) {
  flushIpcCommands([["set_property", "pause", paused]]);
  updatePipelineState({ paused });
}

function switchMpvQuality(index) {
  flushIpcCommands([["script-message", "stream-controller-switch", String(index)]]);
}

// Heartbeat interval for WS clients
setInterval(() => {
  const now = Date.now();
  for (const [clientId, client] of wsClients) {
    if (!client.alive || !client.socket || client.socket.destroyed) {
      wsClients.delete(clientId);
      continue;
    }
    const frame = Buffer.alloc(2);
    frame[0] = 0x80 | WS_OPCODE_PING;
    frame[1] = 0;
    try {
      client.socket.write(frame);
    } catch {
      client.alive = false;
      wsClients.delete(clientId);
    }
    if (client.lastPing && now - client.lastPing > 30000) {
      client.alive = false;
      wsClients.delete(clientId);
    }
  }
}, 10000);

function isHealthy(endpoint) {
  return new Promise((resolve) => {
    const request = http.get({
      host: "127.0.0.1",
      port: endpoint.port,
      path: "/health",
      headers: { "x-enhanced-mpv-token": endpoint.token },
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
    "--force-window=no",
    "--input-ipc-server=" + IPC_PIPE_PATH,
    "--demuxer-lavf-analyzeduration=0.5",
    "--demuxer-lavf-probesize=500000",
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
// HTTP Server + WebSocket Upgrade
// ============================================================================

async function startLaunchDaemon(options) {
  if (activeServer) return activeServer;
  const opts = options || {};
  const token = crypto.randomBytes(24).toString("hex");
  process.env.ENHANCED_MPV_DAEMON = "1";
  
  const server = http.createServer((req, res) => {
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === "websocket") {
      handleWebSocketUpgrade(req, res, server);
      return;
    }
    
    if (!tokenMatches(req.headers["x-enhanced-mpv-token"], token)) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ 
        ok: true, 
        pid: process.pid, 
        wsClients: wsClients.size,
        pipelineStage: pipelineState.stage,
      }));
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
            const prewarmed = prewarmedStreams.get(payload.url);
            if (prewarmed) {
              payload.videoHeaders = { ...prewarmed.videoHeaders, ...(payload.videoHeaders || {}) };
              if (!payload.audioUrl && prewarmed.audioUrl) payload.audioUrl = prewarmed.audioUrl;
              if (!payload.audioHeaders && prewarmed.audioHeaders) payload.audioHeaders = prewarmed.audioHeaders;
              if (!payload.title && prewarmed.title) payload.title = prewarmed.title;
              prewarmedStreams.delete(payload.url);
            }
            
            const candidateId = payload.candidateId || payload.url;
            const tabId = payload.tabId || 0;
            const startTime = payload.startTime || 0;
            
            // Check for Zero-Wait hot path
            if (canZeroWaitLaunch(candidateId, tabId)) {
              await ensureStandbyMpv();
              const zeroWaitOk = await executeZeroWaitLaunch(startTime);
              if (zeroWaitOk) {
                setImmediate(() => appendLaunchLog("[" + new Date().toISOString() + "] Zero-Wait HOT PATH launch for " + payload.url));
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, fast: true, zeroWait: true, persistentSocket: true, pipelineStage: PipelineStage.PLAYING }));
                return;
              }
            }
            
            // Cold launch path
            await ensureStandbyMpv();
            const candidate = { 
              id: candidateId, 
              url: payload.url, 
              title: payload.title || "Enhanced MPV",
              audioUrl: payload.audioUrl,
              audioHeaders: payload.audioHeaders,
              videoHeaders: payload.headers,
            };
            
            const coldOk = await executeColdLaunch(candidate, startTime, payload.title);
            if (coldOk) {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: true, fast: true, persistentSocket: true, pipelineStage: PipelineStage.LAUNCHING }));
              return;
            }
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
    if (req.method === "GET" && req.url === "/pipeline-state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(pipelineState));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  
  server.on("upgrade", (req, socket, head) => {
    handleWebSocketUpgrade(req, socket, head);
  });
  
  server.on("clientError", (err, socket) => {
    try { socket.end(); } catch { /* socket gone */ }
  });
  
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port || 0, "127.0.0.1", resolve);
  });
  
  const port = server.address().port;
  const endpoint = { port, token, pid: process.pid, startedAt: Date.now() };
  writeDaemonEndpoint(endpoint);
  
  await ensureStandbyMpv();
  
  const close = () => new Promise((resolve) => {
    clearDaemonEndpoint();
    killStandbyMpv();
    for (const [, client] of wsClients) {
      sendWsClose(client.socket);
    }
    wsClients.clear();
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

function handleWebSocketUpgrade(req, socket, _head) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  
  const acceptKey = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  
  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Accept: " + acceptKey,
    "",
    ""
  ].join("\r\n");
  
  socket.write(headers);
  
  const clientId = ++wsClientIdCounter;
  const client = {
    id: clientId,
    socket,
    tabId: null,
    role: null,
    lastPing: Date.now(),
    alive: true,
    buffer: Buffer.alloc(0)
  };
  wsClients.set(clientId, client);
  
  socket.on("data", (data) => {
    client.buffer = Buffer.concat([client.buffer, data]);
    client.buffer = parseWsFrames(client.buffer, wsClients, clientId);
  });
  
  socket.on("close", () => {
    client.alive = false;
    wsClients.delete(clientId);
    appendLaunchLog("[" + new Date().toISOString() + "] WS client disconnected: " + clientId);
  });
  
  socket.on("error", (_err) => {
    client.alive = false;
    wsClients.delete(clientId);
  });
  
  appendLaunchLog("[" + new Date().toISOString() + "] WS client connected: " + clientId);
}

async function ensureLaunchDaemon(timeoutMs) {
  const cached = readDaemonEndpoint();
  if (cached && await isHealthy(cached)) return cached;
  if (starting) return starting;
  starting = (async () => {
    const current = readDaemonEndpoint();
    if (current && await isHealthy(current)) return current;
    try {
      const isNode = !process.pkg && /^node(?:\.exe)?$/i.test(path.basename(process.execPath));
      const args = isNode
        ? [path.join(__dirname, "index.js"), "--launch-daemon"]
        : ["--launch-daemon"];
      const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true });
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
  prewarmedStreams,
  IPC_PIPE_PATH,
  spawnStandbyMpv,
  ensureStandbyMpv,
  killStandbyMpv,
  wsClients,
  broadcastPlayerTelemetry,
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