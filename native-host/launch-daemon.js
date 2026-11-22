"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { configDir, ensureDir } = require("./config");
const { appendLaunchLog } = require("./mpv-launcher");

let starting = null;
let activeServer = null;

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

async function startLaunchDaemon(options) {
  if (activeServer) return activeServer;
  const opts = options || {};
  const token = crypto.randomBytes(24).toString("hex");
  process.env.ENHANCED_MPV_DAEMON = "1";
  const server = http.createServer((req, res) => {
    if (!tokenMatches(req.headers["x-enhanced-mpv-token"], token)) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
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
    res.writeHead(404);
    res.end();
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
  const close = () => new Promise((resolve) => {
    clearDaemonEndpoint();
    server.close(() => {
      activeServer = null;
      resolve();
    });
  });
  activeServer = { server, port, token, endpoint, close };
  return activeServer;
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
};
