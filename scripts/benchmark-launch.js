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
  return summarize("Named-pipe IPC dispatch", values, 100);
}

async function startMockDaemon() {
  const token = "benchmark-token";
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
  return summarize("Loopback daemon dispatch", values, 100);
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
  rows.push(await benchmarkLoopbackDispatch());
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
