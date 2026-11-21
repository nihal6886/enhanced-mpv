"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { encodeMessage, createFramer } = require("./protocol");
const { play, findMpv, attachAudio, ipcAlive, spawnMpv } = require("./mpv-launcher");
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
    case "getConfig":
      return { ok: true, error: null, code: "OK", config: readConfig(), command: [] };
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
      return play(msg, "queue");
    case "play":
    case "playNow":
      return play(msg, "replace");
    case "attachAudio":
      return attachAudio(msg);
    case "prewarm":
      // Pre-warm: spawn mpv with --idle=yes so it's ready for instant launch
      return prewarmMpv();
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
      const result = await play({ ...msg, action: "play" }, "replace");
      return result;
    }
    default:
      if (msg.url) return play(msg, action === "queue" ? "queue" : "replace");
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
    return { ok: true, error: null, code: "OK", warmed: true, command: [] };
  }
  const warmArgs = ["--idle=yes", "--force-window=no", "--input-ipc-server=" + ipcPath()];
  if (cfg.profile) warmArgs.push("--profile=" + cfg.profile);
  spawnMpv(mpvBin, warmArgs);
  return { ok: true, error: null, code: "OK", warmed: true, command: [] };
}

// Detached relay helper (spawned by mpv-launcher): read one JSON request from
// stdin, start the relay, print its URL, and keep serving until every relay
// has been idle long enough to be cleaned up.
function runRelayDaemon() {
  let input = "";
  let started = false;
  const reply = (obj) => {
    try { process.stdout.write(JSON.stringify(obj) + "\n"); } catch { /* parent gone */ }
  };
  process.stdout.on("error", () => {});
  process.stdin.on("error", () => {});
  process.stdin.on("data", async (chunk) => {
    if (started) return;
    input += chunk.toString("utf8");
    const nl = input.indexOf("\n");
    if (nl < 0) return;
    started = true;
    try {
      const req = JSON.parse(input.slice(0, nl));
      let out;
      if (req.kind === "master") {
        const r = await relay.startMasterRelay(req.videoUrl, req.videoHeaders || {}, req.audioUrl, req.audioHeaders || {});
        out = { ok: true, masterRelayUrl: r.masterRelayUrl };
      } else {
        out = { ok: true, relayUrl: await relay.startRelay(req.url, req.headers || {}) };
      }
      for (const entry of relay.activeRelays.values()) {
        if (entry.server) entry.server.ref();
      }
      reply(out);
    } catch (err) {
      reply({ ok: false, error: String((err && err.message) || err) });
      process.exit(1);
    }
  });
  setInterval(() => {
    relay.cleanupOldRelays();
    if (started && relay.activeRelays.size === 0) process.exit(0);
  }, 30000);
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
  if (process.argv.includes("--relay-daemon")) {
    runRelayDaemon();
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

module.exports = { handle, writeOut, registerId, prewarmMpv };
