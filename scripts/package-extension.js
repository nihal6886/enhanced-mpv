"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const ext = path.join(root, "browser-extension");
const dist = path.join(root, "dist");

function zipDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  if (process.platform === "win32") {
    // Compress-Archive only accepts the .zip extension, so build a temp .zip
    // and then move it to the requested name (e.g. .xpi for Firefox).
    const target = dest.toLowerCase().endsWith(".zip") ? dest : dest.replace(/\.[^.]+$/, ".zip");
    if (target !== dest && fs.existsSync(target)) fs.unlinkSync(target);
    const ps = `Compress-Archive -Path '${src.replace(/'/g, "''")}\\*' -DestinationPath '${target.replace(/'/g, "''")}' -Force`;
    const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("Compress-Archive failed");
    if (target !== dest) fs.renameSync(target, dest);
    return;
  }
  execFileSync("zip", ["-r", dest, "."], { cwd: src, stdio: "inherit" });
}

function copyManifest(kind) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
  if (kind === "firefox") {
    delete manifest.key; // Chrome-only stable-id hint; gecko id is used instead
    manifest.background = { scripts: ["background.js"] };
    manifest.browser_specific_settings = {
      gecko: {
        id: "enhanced-mpv@enhanced-mpv.local",
        strict_min_version: "128.0",
      },
    };
  }
  return manifest;
}

function stage(kind) {
  const dir = path.join(dist, "stage-" + kind);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(ext, dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(copyManifest(kind), null, 2));
  return dir;
}

function main() {
  require("./generate-icons");
  fs.mkdirSync(dist, { recursive: true });
  const chromeDir = stage("chrome");
  const ffDir = stage("firefox");
  zipDir(chromeDir, path.join(dist, "enhanced-mpv-extension.zip"));
  zipDir(ffDir, path.join(dist, "enhanced-mpv-firefox.xpi"));
  console.log("Wrote dist/enhanced-mpv-extension.zip and dist/enhanced-mpv-firefox.xpi");
}

main();
