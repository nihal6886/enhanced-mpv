"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const { encodeMessage, createFramer } = require("./protocol");
const { fastDispatch, findMpv, attachAudio, ipcAlive, spawnMpv, appendLaunchLog, setRelayInProcess } = require("./mpv-launcher");
const { ensureLaunchDaemon, readDaemonEndpoint } = require("./launch-daemon");
const relay = require("./stream-relay");
const { readConfig, writeConfig, configDir, ensureDir, ipcPath } = require("./config");
const { isSafeUrl } = require("./sanitizer");
const { parseFilename } = require("./filename-parser");
const { convertSubtitle } = require("./vtt-converter");

const HOST_NAME = "com.enhanced.mpv.host";
const CHROME_REG_KEYS = [
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME,
  "HKCU\\Software\\Chromium\\NativeMessagingHosts\\" + HOST_NAME,
  "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\" + HOST_NAME,
  "HKCU\\Software\\BraveSoftware\\Brave\\NativeMessagingHosts\\" + HOST_NAME,
];

function writeOut(obj) {
  const buf = encodeMessage(obj);
  fs.writeSync(1, buf);
}

function requestDaemon(endpoint, pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = payload == null ? null : Buffer.from(JSON.stringify(payload), "utf8");
    const req = http.request({
      host: "127.0.0.1", port: endpoint.port, path: pathname,
      method: body ? "POST" : "GET", timeout: 1200,
      headers: {
        ...(body ? { "content-type": "application/json", "content-length": body.length } : {}),
        "x-enhanced-mpv-token": endpoint.token,
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch { /* malformed response */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(parsed.error || "daemon status " + res.statusCode));
        } else resolve(parsed);
      });
    });
    req.on("timeout", () => req.destroy(new Error("daemon request timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function dispatchThroughLiveDaemon(msg) {
  const endpoint = readDaemonEndpoint();
  if (!endpoint || !Number.isInteger(endpoint.port) || !endpoint.token) return null;
  try {
    await requestDaemon(endpoint, "/health");
  } catch { return null; }
  try {
    return await requestDaemon(endpoint, "/dispatch", msg);
  } catch (err) {
    return { ok: false, error: String(err.message || err), code: "DAEMON_DISPATCH_FAILED", command: [] };
  }
}

// Where a Native Messaging manifest for Chromium may live: next to the compiled
// host, in the legacy install.ps1 folder, or inside the source checkout.
function manifestCandidates() {
  const dirs = [
    path.join(path.dirname(process.execPath), "manifests"),
    path.join(configDir(), "native-messaging"),
    path.join(__dirname, "manifests"),
  ];
  const files = [];
  for (const dir of dirs) {
    files.push(path.join(dir, HOST_NAME + ".chrome.json"));
    files.push(path.join(dir, "chrome.json"));
  }
  return files;
}

function registryManifestPaths() {
  if (process.platform !== "win32") return [];
  const out = [];
  for (const key of CHROME_REG_KEYS) {
    const r = spawnSync("reg", ["query", key, "/ve"], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0 || !r.stdout) continue;
    const m = /REG_SZ\s+(\S.*?)\s*$/m.exec(r.stdout);
    if (m && m[1]) out.push(m[1].trim());
  }
  return out;
}

function readManifest(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function manifestHasOrigin(file, origin) {
  const data = readManifest(file);
  return Boolean(data && Array.isArray(data.allowed_origins) && data.allowed_origins.includes(origin));
}

function linkOneManifest(file, origin) {
  const data = readManifest(file);
  if (!data) return false;
  if (!Array.isArray(data.allowed_origins)) data.allowed_origins = [];
  if (data.allowed_origins.includes(origin)) return true;
  data.allowed_origins.push(origin);
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// Native OS Yes/No dialog. Fails closed: if the platform helper is missing, the
// session is non-interactive, or anything errors, we return false and leave the
// Native Messaging manifest untouched.
function confirmWithOS(message, title) {
  try {
    if (process.platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "$r=[System.Windows.Forms.MessageBox]::Show(" + psQuote(message) + "," + psQuote(title) +
          ",[System.Windows.Forms.MessageBoxButtons]::YesNo,[System.Windows.Forms.MessageBoxIcon]::Warning);",
        "if($r -eq [System.Windows.Forms.DialogResult]::Yes){exit 0}else{exit 1}",
      ].join(" ");
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: true, timeout: 120000 });
      return r.status === 0;
    }
    if (process.platform === "darwin") {
      const script = "display dialog " + JSON.stringify(message) + " with title " + JSON.stringify(title) +
        ' buttons {"Cancel", "Link"} default button "Link" cancel button "Cancel"';
      const r = spawnSync("osascript", ["-e", script], { timeout: 120000 });
      return r.status === 0;
    }
    const zenity = spawnSync("zenity", ["--title", title, "--question", "--text", message, "--ok-label=Link", "--cancel-label=Cancel"], { timeout: 120000 });
    if (zenity.error || zenity.status === null) {
      const kdialog = spawnSync("kdialog", ["--title", title, "--warningyesno", message, "--yes-label", "Link", "--no-label", "Cancel"], { timeout: 120000 });
      return kdialog.status === 0;
    }
    return zenity.status === 0;
  } catch {
    return false;
  }
}

// Idempotently write "chrome-extension://<id>/" into every discovered Chromium
// Native Messaging manifest so the user never has to paste their extension id.
// The id is validated strictly and the user must confirm through a native OS
// prompt before any manifest is modified.
function registerId(extensionId) {
  const id = String(extensionId || "")
    .trim()
    .replace(/^chrome-extension:\/\//, "")
    .replace(/\/$/, "");
  if (!/^[a-p]{32}$/.test(id)) {
    return { ok: false, error: "invalid extension id", code: "BAD_ID", command: [] };
  }
  const origin = "chrome-extension://" + id + "/";
  const targets = [...new Set([...registryManifestPaths(), ...manifestCandidates()])];
  const existing = targets.filter((file) => fs.existsSync(file));

  // Already linked everywhere: nothing to modify, so skip the prompt entirely.
  if (existing.length > 0 && existing.every((file) => manifestHasOrigin(file, origin))) {
    try {
      writeConfig({ extensionId: id });
    } catch {
      // non-fatal
    }
    return { ok: true, error: null, code: "OK", extensionId: id, updated: existing, command: [] };
  }

  const ok = confirmWithOS(
    "Link this browser extension to Enhanced MPV?\n\n" +
      "Extension ID: " + id + "\n\n" +
      "This adds \"" + origin + "\" to the Native Messaging manifest so the " +
      "extension can launch mpv. Only continue if you started this yourself.",
    "Enhanced MPV — Register browser extension"
  );
  if (!ok) {
    return { ok: false, error: "registration declined", code: "DECLINED", extensionId: id, updated: [], command: [] };
  }

  const updated = [];
  for (const file of targets) {
    if (linkOneManifest(file, origin)) updated.push(file);
  }
  try {
    writeConfig({ extensionId: id });
  } catch {
    // non-fatal: linking still succeeded where it could
  }
  return {
    ok: updated.length > 0,
    error: updated.length ? null : "no native messaging manifest found",
    code: updated.length ? "OK" : "NO_MANIFEST",
    extensionId: id,
    updated,
    command: [],
  };
}

async function handle(msg) {
  if (!msg || typeof msg !== "object") {
    return { ok: false, error: "invalid payload", code: "BAD_URL", command: [] };
  }
  const action = msg.action || "play";
  switch (action) {
    case "getConfig": {
      const config = readConfig();
      const endpoint = readDaemonEndpoint();
      if (endpoint && endpoint.port && endpoint.token) {
        config.daemonPort = endpoint.port;
        config.daemonToken = endpoint.token;
      }
      return { ok: true, error: null, code: "OK", config, command: [] };
    }
    case "setConfig":
      return { ok: true, error: null, code: "OK", config: writeConfig(msg.config || {}), command: [] };
    case "parseFilename":
      return { ok: true, error: null, code: "OK", parsed: parseFilename(msg.filename || msg.url), command: [] };
    case "convertVtt":
      return { ok: true, error: null, code: "OK", srt: convertSubtitle(msg.text || "", msg.url || ""), command: [] };
    case "doctor":
      return require("./doctor").collectReport();
    case "register_id":
      return registerId(msg.extensionId);
    case "queue":
      return (await dispatchThroughLiveDaemon({ ...msg, action: "queue" })) || fastDispatch(msg, "queue");
    case "play":
    case "playNow":
      return (await dispatchThroughLiveDaemon({ ...msg, action: "play" })) || fastDispatch(msg, "replace");
    case "attachAudio":
      return attachAudio(msg);
    case "prewarm": {
      const warmed = await prewarmMpv();
      const endpoint = process.env.ENHANCED_MPV_DAEMON === "1"
        ? readDaemonEndpoint()
        : await ensureLaunchDaemon(2500);
      if (endpoint && endpoint.port && endpoint.token) {
        return { ok: true, port: endpoint.port, token: endpoint.token, daemon: endpoint };
      }
      // If prewarm succeeded but no endpoint yet, still include endpoint info if available
      const daemonInfo = endpoint || readDaemonEndpoint();
      return { ok: true, error: null, code: "OK", ...warmed, ...(daemonInfo ? { port: daemonInfo.port, token: daemonInfo.token, daemon: daemonInfo } : {}) };
    }
    case "ping": {
      const endpoint = process.env.ENHANCED_MPV_DAEMON === "1"
        ? readDaemonEndpoint()
        : await ensureLaunchDaemon(2500);
      if (endpoint && endpoint.port && endpoint.token) {
        return { ok: true, port: endpoint.port, token: endpoint.token, daemon: endpoint };
      }
      return { ok: false, error: "daemon not ready", code: "DAEMON_NOT_READY" };
    }
    case "startRelay": {
      // Start localhost HLS relay for protected streams
      const { url, headers } = msg;
      if (!url || !headers) {
        return { ok: false, error: "missing url or headers", code: "BAD_URL", command: [] };
      }
      try {
        const relayUrl = await relay.startRelay(url, headers);
        return { ok: true, error: null, code: "OK", relayUrl, command: [] };
      } catch (err) {
        return { ok: false, error: err.message, code: "RELAY_FAILED", command: [] };
      }
    }
    case "copyCommand": {
      const result = (await dispatchThroughLiveDaemon({ ...msg, action: "play" })) || await fastDispatch({ ...msg, action: "play" }, "replace");
      return result;
    }
    default:
      if (msg.url) {
        const mode = action === "queue" ? "queue" : "replace";
        const routed = await dispatchThroughLiveDaemon({ ...msg, action: mode === "queue" ? "queue" : "play" });
        return routed || fastDispatch(msg, mode);
      }
      return { ok: false, error: "unknown action", code: "BAD_URL", command: [] };
  }
}

async function prewarmMpv() {
  const mpvBin = findMpv();
  if (!mpvBin) {
    return { ok: false, error: "mpv was not found on PATH", code: "MPV_NOT_FOUND", command: [] };
  }
  const cfg = readConfig();
  if (!cfg.keepWarm) {
    return { ok: true, error: null, code: "OK", warmed: false, command: [] };
  }
  if (await ipcAlive()) {
    const endpoint = readDaemonEndpoint();
    return { ok: true, error: null, code: "OK", warmed: true, command: [], ...(endpoint ? { port: endpoint.port, token: endpoint.token, daemon: endpoint } : {}) };
  }
  const warmArgs = [
    "--idle=yes",
    "--force-window=no",
    "--input-ipc-server=" + ipcPath(),
    "--demuxer-lavf-analyzeduration=0.5",
    "--demuxer-lavf-probesize=262144",
    "--cache=yes",
    "--cache-secs=15",
    "--demuxer-readahead-secs=5",
    "--hls-bitrate=max",
  ];
  if (cfg.profile) warmArgs.push("--profile=" + cfg.profile);
  spawnMpv(mpvBin, warmArgs);
  return { ok: true, error: null, code: "OK", warmed: true, command: [] };
}

function relayLog(message) {
  appendLaunchLog("[" + new Date().toISOString() + "] " + message);
}

function runRelayDaemonConfig() {
  const configArgIndex = process.argv.indexOf("--relay-config");
  const configPath = configArgIndex >= 0 ? process.argv[configArgIndex + 1] : null;
  const resultPathArgIndex = process.argv.indexOf("--relay-result");
  const resultPathFromArg = resultPathArgIndex >= 0 ? process.argv[resultPathArgIndex + 1] : null;
  const writeResult = (payload, resultPath) => {
    if (!resultPath) return;
    try {
      fs.writeFileSync(resultPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    } catch (err) {
      relayLog("relay result write failed: " + String((err && err.message) || err));
    }
  };
  let request = null;
  try {
    request = configPath ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null;
  } catch (err) {
    const message = String((err && err.message) || err);
    relayLog("relay config parse failed: " + message);
    writeResult({ ok: false, error: message }, resultPathFromArg);
    process.exit(1);
    return;
  }
  const resultPath = (request && request.resultPath) || resultPathFromArg;
  const fail = (err) => {
    const message = String((err && err.message) || err);
    relayLog("relay daemon failed: " + message);
    writeResult({ ok: false, error: message }, resultPath);
    process.exit(1);
  };
  try {
    const run = request && request.kind === "master"
      ? relay.startMasterRelay(request.videoUrl, request.videoHeaders || {}, request.audioUrl, request.audioHeaders || {})
        .then((result) => ({ ok: true, masterRelayUrl: result.masterRelayUrl }))
      : relay.startRelay(request.url, request.headers || {})
        .then((relayUrl) => ({ ok: true, relayUrl }));
    run.then((payload) => {
      for (const entry of relay.activeRelays.values()) {
        if (entry.server) entry.server.ref();
      }
      writeResult(payload, resultPath);
      const keepAlive = setInterval(() => {
        relay.cleanupOldRelays();
        if (relay.activeRelays.size === 0) {
          clearInterval(keepAlive);
          process.exit(0);
        }
      }, 30000);
      const shutdown = () => { clearInterval(keepAlive); process.exit(0); };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      process.stdin.resume();
      process.stdin.on("end", shutdown);
      process.stdin.on("close", shutdown);
    }).catch(fail);
  } catch (err) {
    fail(err);
  }
}

function startClipboardWatch() {
  const { spawn } = require("child_process");
  let last = "";
  const tick = () => {
    const cfg = readConfig();
    if (!cfg.clipboardWatch) return;
    let child;
    if (process.platform === "win32") {
      child = spawn("powershell", ["-NoProfile", "-Command", "try { Get-Clipboard -Raw } catch { }"], { windowsHide: true });
    } else if (process.platform === "darwin") {
      child = spawn("pbpaste");
    } else {
      child = spawn("xclip", ["-selection", "clipboard", "-o"]);
    }
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.on("close", () => {
      const clip = out.trim();
      if (!clip || clip === last) return;
      last = clip;
      if (isSafeUrl(clip)) {
        const flag = path.join(configDir(), "clipboard-prompt.json");
        ensureDir(configDir());
        fs.writeFileSync(flag, JSON.stringify({ url: clip, ts: Date.now() }), "utf8");
      }
    });
  };
  setInterval(tick, 2500);
}

function main() {
  if (process.argv.includes("--relay-config") || process.argv.includes("--relay-daemon")) {
    runRelayDaemonConfig();
    return;
  }
  if (process.argv.includes("--launch-daemon")) {
    ensureDir(configDir());
    setRelayInProcess(true);
    const { startLaunchDaemon } = require("./launch-daemon");
    startLaunchDaemon().catch((err) => {
      appendLaunchLog("[" + new Date().toISOString() + "] launch daemon failed: " + String((err && err.message) || err));
      process.exit(1);
    });
    return;
  }
  ensureDir(configDir());
  if (process.argv.includes("--clipboard-watch")) {
    startClipboardWatch();
  }

  process.stdin.on("error", () => process.exit(1));
  const framer = createFramer(async (msg) => {
    try {
      const result = await handle(msg);
      writeOut(result);
    } catch (err) {
      writeOut({
        ok: false,
        error: String(err.message || err),
        code: "LAUNCH_FAILED",
        command: findMpv() ? [findMpv()] : [],
      });
    }
  }, (err) => {
    writeOut({ ok: false, error: String(err.message || err), code: "BAD_URL", command: [] });
  });

  process.stdin.on("data", (chunk) => framer.push(chunk));
  process.stdin.on("end", () => process.exit(0));
}

if (require.main === module) {
  main();
}

module.exports = { handle, writeOut, registerId, prewarmMpv, dispatchThroughLiveDaemon };
