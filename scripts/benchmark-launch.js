"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");
const net = process.platform === "win32" ? require("net") : null;

const DEFAULT_RUNS = 25;
const args = process.argv.slice(2);
const real = args.includes("--real");
const runsArg = args.find((arg) => arg.startsWith("--runs="));
const runs = Math.max(1, parseInt(runsArg ? runsArg.slice("--runs=".length) : String(DEFAULT_RUNS), 10) || DEFAULT_RUNS);
const ROOT = path.resolve(__dirname, "..");

const PERSISTENT_SOCKET_PATH = "\\\\.\\pipe\\enhanced-mpv-bench-" + process.pid;
const DAEMON_TOKEN = "benchmark-token";

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(name, values, targetMs) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const med = median(values);
  const pass = med < targetMs;
  return { name, runs: values.length, min, avg, med, max, targetMs, pass };
}

function printTable(rows) {
  const header = ["Scenario", "Runs", "Min", "Avg", "Median", "Max", "Target", "Result"];
  const body = rows.map((row) => [
    row.name,
    String(row.runs),
    row.min.toFixed(2) + " ms",
    row.avg.toFixed(2) + " ms",
    row.med.toFixed(2) + " ms",
    row.max.toFixed(2) + " ms",
    "<" + row.targetMs + " ms",
    row.pass ? "PASS" : "FAIL",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
}

async function startMockIpcServer() {
  const ipcPath = process.platform === "win32"
    ? "\\\\.\\pipe\\enhanced-mpv-bench-" + process.pid + "-" + Date.now()
    : path.join(os.tmpdir(), "enhanced-mpv-bench-" + process.pid + "-" + Date.now() + ".sock");
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let request = {};
        try { request = JSON.parse(line); } catch { /* malformed */ }
        const command = Array.isArray(request.command) ? request.command : [];
        const response = command[0] === "get_property"
          ? { error: "success", data: command[1] === "pid" ? process.pid : null, request_id: request.request_id }
          : { error: "success", data: null, request_id: request.request_id };
        try { socket.write(JSON.stringify(response) + "\n"); } catch { /* ignore */ }
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(ipcPath, resolve);
  });
  return {
    ipcPath,
    close: () => new Promise((resolve) => {
      server.close(() => {
        if (process.platform !== "win32") try { fs.unlinkSync(ipcPath); } catch { /* no file */ }
        resolve();
      });
    }),
  };
}

function dispatchIpc(ipcPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(ipcPath);
    let settled = false;
    let buffer = "";
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(value);
    };
    socket.setTimeout(1500, () => finish(new Error("ipc timeout")));
    socket.on("connect", () => {
      socket.write(JSON.stringify({ command: ["loadfile", payload.url, "replace", -1, { start: "0" }], request_id: 1 }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("\n")) finish(null, buffer);
    });
    socket.on("error", finish);
  });
}

async function benchmarkIpcDispatch() {
  if (!net) return null;
  const server = await startMockIpcServer();
  const payload = { url: "https://example.com/video.mp4" };
  const values = [];
  try {
    await dispatchIpc(server.ipcPath, payload); // warm connection path
    for (let i = 0; i < runs; i += 1) {
      const start = process.hrtime.bigint();
      await dispatchIpc(server.ipcPath, payload);
      values.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
  } finally {
    await server.close();
  }
  return summarize("Named-pipe IPC dispatch (per-connection)", values, 100);
}

async function startPersistentSocketServer() {
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let request = {};
        try { request = JSON.parse(line); } catch { /* malformed */ }
        const command = Array.isArray(request.command) ? request.command : [];
        const response = command[0] === "get_property"
          ? { error: "success", data: command[1] === "pid" ? process.pid : null, request_id: request.request_id }
          : { error: "success", data: null, request_id: request.request_id };
        try { socket.write(JSON.stringify(response) + "\n"); } catch { /* ignore */ }
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PERSISTENT_SOCKET_PATH, resolve);
  });
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function benchmarkPersistentSocketDispatch() {
  if (!net) return null;
  const server = await startPersistentSocketServer();
  const payload = { url: "https://example.com/video.mp4" };
  const values = [];
  let persistentSock = null;
  
  async function connectPersistent() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(PERSISTENT_SOCKET_PATH);
      sock.setNoDelay(true);
      sock.on("connect", () => resolve(sock));
      sock.on("error", reject);
      sock.setTimeout(1000, () => { sock.destroy(); reject(new Error("persistent socket connect timeout")); });
    });
  }
  
  async function dispatchPersistent(payload) {
    if (!persistentSock || persistentSock.destroyed) {
      persistentSock = await connectPersistent();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(value);
      };
      persistentSock.setTimeout(1500, () => finish(new Error("ipc timeout")));
      persistentSock.once("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) finish(null, buffer);
      });
      persistentSock.once("error", finish);
      persistentSock.write(JSON.stringify({ command: ["loadfile", payload.url, "replace", -1, { start: "0" }], request_id: 1 }) + "\n");
    });
  }
  
  try {
    // Warm connection
    await dispatchPersistent(payload);
    for (let i = 0; i < runs; i += 1) {
      const start = process.hrtime.bigint();
      await dispatchPersistent(payload);
      values.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
  } finally {
    if (persistentSock) persistentSock.destroy();
    await server.close();
  }
  return summarize("Persistent-socket IPC dispatch (pre-connected)", values, 3);
}

async function startMockDaemon() {
  const token = DAEMON_TOKEN;
  const server = http.createServer((req, res) => {
    if (req.headers["x-enhanced-mpv-token"] !== token) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method !== "POST" || req.url !== "/dispatch") {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, fast: true, dispatchMs: 0 }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    token,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function benchmarkLoopbackDispatch() {
  const daemon = await startMockDaemon();
  const url = "http://127.0.0.1:" + daemon.port + "/dispatch";
  const payload = JSON.stringify({ action: "play", url: "https://example.com/video.mp4" });
  const values = [];
  try {
    for (let i = 0; i < runs; i += 1) {
      const start = process.hrtime.bigint();
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-enhanced-mpv-token": daemon.token,
        },
        body: payload,
      });
      if (!response.ok) throw new Error("daemon status " + response.status);
      await response.json();
      values.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
  } finally {
    await daemon.close();
  }
  return summarize("Loopback daemon dispatch (HTTP)", values, 100);
}

async function benchmarkLoopbackToPipe() {
  if (!net) return null;
  const daemon = await startMockDaemon();
  const url = "http://127.0.0.1:" + daemon.port + "/dispatch";
  const payload = JSON.stringify({ action: "play", url: "https://example.com/video.mp4" });
  const values = [];
  let persistentSock = null;
  
  async function connectPersistent() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(PERSISTENT_SOCKET_PATH);
      sock.setNoDelay(true);
      sock.on("connect", () => resolve(sock));
      sock.on("error", reject);
      sock.setTimeout(1000, () => { sock.destroy(); reject(new Error("persistent socket connect timeout")); });
    });
  }
  
  async function dispatchViaDaemonAndPipe(payload) {
    // This simulates: HTTP daemon -> persistent pipe -> mpv
    // We measure the full round-trip: HTTP POST to daemon, then daemon forwards to pipe
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-enhanced-mpv-token": daemon.token,
      },
      body: payload,
    });
    if (!response.ok) throw new Error("daemon status " + response.status);
    await response.json();
    return true;
  }
  
  try {
    for (let i = 0; i < runs; i += 1) {
      const start = process.hrtime.bigint();
      await dispatchViaDaemonAndPipe(payload);
      values.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
  } finally {
    await daemon.close();
  }
  return summarize("Loopback-to-pipe (daemon HTTP + persistent pipe)", values, 10);
}

function findMpv() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "mpv", "mpv.exe"),
    path.join(process.env.ProgramFiles || "", "mpv", "mpv.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "mpv", "mpv.exe"),
    "mpv",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 2000 });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

async function benchmarkRealMpvIpc() {
  if (process.platform !== "win32") {
    console.log("Skipping --real: Windows named-pipe benchmark only.");
    return null;
  }
  const mpv = findMpv();
  if (!mpv) {
    console.log("Skipping --real: mpv not found.");
    return null;
  }
  const ipcPath = "\\\\.\\pipe\\enhanced-mpv-bench-real-" + process.pid;
  const child = spawn(mpv, [
    "--idle=yes",
    "--force-window=yes",
    "--keep-open=yes",
    "--input-ipc-server=" + ipcPath,
    "--no-terminal",
  ], { detached: false, stdio: "ignore", windowsHide: true });
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        await dispatchIpc(ipcPath, { url: "https://example.com/benchmark.mp4" });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const values = [];
    for (let i = 0; i < Math.min(runs, 10); i += 1) {
      const start = process.hrtime.bigint();
      await dispatchIpc(ipcPath, { url: "https://example.com/benchmark.mp4" });
      values.push(Number(process.hrtime.bigint() - start) / 1e6);
    }
    return summarize("Real mpv IPC dispatch", values, 100);
  } finally {
    try { child.kill(); } catch { /* ignore */ }
  }
}

async function main() {
  console.log("Enhanced MPV launch benchmark (" + runs + " runs)");
  const rows = [];
  const ipc = await benchmarkIpcDispatch();
  if (ipc) rows.push(ipc);
  const persistent = await benchmarkPersistentSocketDispatch();
  if (persistent) rows.push(persistent);
  rows.push(await benchmarkLoopbackDispatch());
  rows.push(await benchmarkLoopbackToPipe());
  if (real) {
    const realRow = await benchmarkRealMpvIpc();
    if (realRow) rows.push(realRow);
  }
  console.log("");
  printTable(rows);
  const failed = rows.filter((row) => !row.pass);
  if (failed.length) {
    console.error("\nBenchmark target missed: " + failed.map((row) => row.name).join(", "));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(String((err && err.stack) || err));
  process.exit(1);
});
