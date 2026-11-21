"use strict";

const path = require("path");

// Only plain web URLs ever reach mpv, yt-dlp, or the subtitle downloader.
// Everything else — local file:, script/data:/blob: schemes, magnet:/rtmp:/
// rtsp: custom handlers, and flag-like values — is rejected outright to block
// SSRF, local-file disclosure, and argument injection.
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function stripNul(s) {
  return String(s || "").replace(/\0/g, "");
}

function isSafeUrl(raw) {
  const value = stripNul(raw).trim();
  if (!value || value.length > 8000) return false;
  if (value.startsWith("-")) return false;
  if (/[\r\n]/.test(value)) return false;
  if (value.startsWith("\\\\")) return false;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol.toLowerCase())) return false;
  if (parsed.username && /[;&|`$<>]/.test(parsed.username)) return false;
  return true;
}

function isSafeLocalPath(raw) {
  const value = stripNul(raw).trim();
  if (!value || /[\r\n\0]/.test(value)) return false;
  if (value.startsWith("-")) return false;
  const normalized = path.normalize(value);
  if (normalized.includes("\0")) return false;
  return true;
}

function sanitizeHeaderValue(value) {
  return stripNul(value).replace(/[\r\n]/g, "").slice(0, 4000);
}

function sanitizeTitle(title) {
  return stripNul(title).replace(/[\r\n]/g, " ").slice(0, 300);
}

function headerFields(payload) {
  const parts = [];
  const ua = sanitizeHeaderValue(payload.userAgent || payload.user_agent);
  const referer = sanitizeHeaderValue(payload.referer);
  const cookies = sanitizeHeaderValue(payload.cookies);
  const extra = payload.headers && typeof payload.headers === "object" ? payload.headers : {};

  if (ua) parts.push("User-Agent: " + ua);
  if (referer) parts.push("Referer: " + referer);
  if (cookies) parts.push("Cookie: " + cookies);
  for (const [k, v] of Object.entries(extra)) {
    const key = String(k).replace(/[^\w-]/g, "");
    if (!key) continue;
    if (/^(host|connection|content-length)$/i.test(key)) continue;
    parts.push(key + ": " + sanitizeHeaderValue(v));
  }
  return parts;
}

// Hosts where handing the canonical page URL to mpv + yt-dlp is the right move.
// Keep this list in sync with YTDL_HOSTS in browser-extension/background.js.
const YTDL_HOSTS = [
  "youtube.com",
  "youtu.be",
  "instagram.com",
  "tiktok.com",
  "vimeo.com",
  "twitch.tv",
  "reddit.com",
  "x.com",
  "twitter.com",
  "dailymotion.com",
  "bilibili.com",
  "soundcloud.com",
  "niconico.jp",
  "nicovideo.jp",
];

function ytdlSupported(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return YTDL_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

// --http-header-fields is a comma-separated list, so a comma inside a header
// value (Cookie, Date, Accept, ...) must be escaped with a backslash or mpv
// splits the header into malformed fragments. Backslashes are escaped too.
function escapeHeaderField(field) {
  return String(field).replace(/\\/g, "\\\\").replace(/,/g, "\\,");
}

function joinHeaderFields(parts) {
  return (Array.isArray(parts) ? parts : []).map(escapeHeaderField).join(",");
}

function mpvArgv(mpvBin, args) {
  const out = [mpvBin];
  for (const a of args) {
    if (typeof a !== "string") continue;
    if (a.includes("\0")) continue;
    out.push(a);
  }
  return out;
}

module.exports = {
  isSafeUrl,
  isSafeLocalPath,
  sanitizeHeaderValue,
  sanitizeTitle,
  headerFields,
  ytdlSupported,
  escapeHeaderField,
  joinHeaderFields,
  mpvArgv,
  stripNul,
};
