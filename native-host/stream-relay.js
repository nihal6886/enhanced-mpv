"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const crypto = require("crypto");
const { isSafeUrl } = require("./sanitizer");

const RELAY_TIMEOUT_MS = 30000;
const MAX_RELAYS = 10;
const TOKEN_BYTES = 16;

const activeRelays = new Map();

// Shared keep-alive connection pools so video and audio .ts chunks reuse TCP
// connections instead of serializing on TLS handshakes (head-of-line blocking).
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8, keepAliveMsecs: 10000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8, keepAliveMsecs: 10000 });
function relayAgent(url) {
  return url.startsWith("https:") ? httpsAgent : httpAgent;
}

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("hex");
}

function parseM3U8(content, baseUrl) {
  const lines = content.split("\n");
  const segments = [];
  let bandwidth = 0;
  let variantUrl = null;
  let isMaster = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      isMaster = true;
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      if (bwMatch) bandwidth = parseInt(bwMatch[1], 10);
      const nextLine = lines[i + 1]?.trim();
      if (nextLine && !nextLine.startsWith("#")) {
        try {
          variantUrl = new URL(nextLine, baseUrl).toString();
        } catch {
          variantUrl = null;
        }
      }
    } else if (line.startsWith("#EXTINF:")) {
      const nextLine = lines[i + 1]?.trim();
      if (nextLine && !nextLine.startsWith("#")) {
        try {
          segments.push(new URL(nextLine, baseUrl).toString());
        } catch {
          // skip invalid segment URL
        }
      }
    }
  }

  return { isMaster, bandwidth, variantUrl, segments, baseUrl };
}

async function fetchWithHeaders(url, headers, timeoutMs = RELAY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!isSafeUrl(url)) {
      reject(new Error("unsafe URL"));
      return;
    }
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { headers, timeout: timeoutMs, agent: relayAgent(url) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let next;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch {
          reject(new Error("unsafe redirect"));
          return;
        }
        if (!isSafeUrl(next)) {
          reject(new Error("unsafe redirect"));
          return;
        }
        fetchWithHeaders(next, headers, timeoutMs).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
  });
}

async function resolveManifest(url, headers) {
  const response = await fetchWithHeaders(url, headers);
  if (response.statusCode !== 200 && response.statusCode !== 206) {
    throw new Error(`Manifest fetch failed: ${response.statusCode}`);
  }
  const text = response.body.toString("utf8");
  const parsed = parseM3U8(text, url);

  if (parsed.isMaster && parsed.variantUrl) {
    // Recursively resolve the variant
    return resolveManifest(parsed.variantUrl, headers);
  }

  return {
    url: parsed.baseUrl,
    segments: parsed.segments,
    headers: response.headers,
  };
}

async function verifySegment(url, headers) {
  return new Promise((resolve) => {
    if (!isSafeUrl(url)) {
      resolve(false);
      return;
    }
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.request(url, { method: "HEAD", headers, timeout: 5000, agent: relayAgent(url) }, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 206);
    });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function verifyFirstSegment(segments, headers) {
  for (const seg of segments) {
    const ok = await verifySegment(seg, headers);
    if (ok) return seg;
  }
  return null;
}

// Fetch many segments with a bounded concurrency cap so parallel video and
// audio .ts chunks arrive without head-of-line blocking on shared relays.
async function fetchSegmentsConcurrently(urls, headers, options = {}) {
  const concurrency = Math.max(1, Number(options.concurrency || 8));
  const results = new Array(urls.length);
  let idx = 0;
  let running = 0;
  let done = 0;
  return new Promise((resolve) => {
    const schedule = () => {
      while (running < concurrency && idx < urls.length) {
        const i = idx++;
        running++;
        fetchWithHeaders(urls[i], headers).then(
          (res) => { results[i] = { ok: true, res }; },
          (err) => { results[i] = { ok: false, err }; }
        ).finally(() => {
          running--;
          done++;
          if (done >= urls.length) resolve(results);
          else schedule();
        });
      }
    };
    schedule();
  });
}

const PLAYLIST_CT_RE = /mpegurl|x-mpegurl|vnd\.apple\.mpegurl/i;
const RELAY_IDLE_MS = 10 * 60 * 1000;
const MAX_REDIRECTS = 5;

function isRelayedUri(uri) {
  return /^https?:\/\/127\.0\.0\.1:\d+\//.test(uri);
}

function rewriteManifestUrls(text, base, manifestBaseUrl) {
  // CRLF playlists would otherwise never match the line-anchored patterns.
  text = String(text).replace(/\r\n?/g, "\n");
  // URI lines (segments, variant playlists): absolute or relative, resolved
  // against the playlist URL and routed through the relay.
  text = text.replace(/^([^#\s][^\s]*)$/gm, (match) => {
    if (isRelayedUri(match)) return match;
    if (!/^https?:\/\//i.test(match) && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(match)) return match; // data:, skd:, etc.
    try {
      const absoluteUrl = new URL(match, manifestBaseUrl).toString();
      return base + encodeURIComponent(absoluteUrl);
    } catch {
      return match;
    }
  });

  // Rewrite quoted URI="..." attributes inside #EXT-X-MEDIA (audio/subtitle
  // renditions), #EXT-X-KEY (AES-128 decryption keys), #EXT-X-MAP (fMP4 init
  // segments), and I-frame playlists so every rendition/key/init segment
  // resolves against the playlist base URL and carries the tab's session
  // headers. Non-HTTP key schemes (skd:, data:) and already-relayed URIs are
  // left untouched.
  text = text.replace(/(URI=")([^"]+)(")/g, (match, prefix, uri, suffix) => {
    if (isRelayedUri(uri)) return match;
    if (!/^https?:\/\//i.test(uri) && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)) return match;
    try {
      const absoluteUrl = new URL(uri, manifestBaseUrl).toString();
      return prefix + base + encodeURIComponent(absoluteUrl) + suffix;
    } catch {
      return match;
    }
  });

  return text;
}

// Open an upstream response (following safe redirects) without buffering, so
// large segments stream straight to mpv and Range requests keep working.
function openUpstream(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (!isSafeUrl(url)) {
      reject(new Error("unsafe URL"));
      return;
    }
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, { headers, timeout: RELAY_TIMEOUT_MS, agent: relayAgent(url) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(new Error("too many redirects"));
          return;
        }
        let next;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch {
          reject(new Error("unsafe redirect"));
          return;
        }
        openUpstream(next, headers, redirects + 1).then(resolve, reject);
        return;
      }
      resolve({ res, finalUrl: url });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
  });
}

function looksLikePlaylist(url, contentType) {
  if (PLAYLIST_CT_RE.test(contentType || "")) return true;
  try {
    return /\.m3u8?$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function sendPlaylist(res, text) {
  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(200);
  res.end(text);
}

// Fetch a playlist with the tab's headers and rewrite every URI through `base`.
async function relayPlaylist(res, playlistUrl, headers, base) {
  const { res: upstream, finalUrl } = await openUpstream(playlistUrl, headers);
  if (upstream.statusCode !== 200 && upstream.statusCode !== 206) {
    upstream.resume();
    res.writeHead(502);
    res.end("Manifest fetch failed");
    return;
  }
  const body = await readBody(upstream);
  sendPlaylist(res, rewriteManifestUrls(body.toString("utf8"), base, finalUrl));
}

// Proxy one resource. Nested playlists (variant / rendition playlists reached
// from a master) are rewritten too, so their segments, keys, and init
// segments also go through the authenticated relay.
async function relayResource(req, res, resourceUrl, headers, base) {
  const upstreamHeaders = { ...headers };
  if (req.headers.range) upstreamHeaders.Range = req.headers.range;
  const { res: upstream, finalUrl } = await openUpstream(resourceUrl, upstreamHeaders);
  if (upstream.statusCode !== 200 && upstream.statusCode !== 206) {
    upstream.resume();
    res.writeHead(502);
    res.end("Segment fetch failed");
    return;
  }
  const contentType = upstream.headers["content-type"] || "";
  if (looksLikePlaylist(finalUrl, contentType)) {
    const body = await readBody(upstream);
    const text = body.toString("utf8");
    if (text.trimStart().startsWith("#EXTM3U")) {
      sendPlaylist(res, rewriteManifestUrls(text, base, finalUrl));
      return;
    }
    res.setHeader("Content-Type", contentType || "application/octet-stream");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.writeHead(upstream.statusCode);
    res.end(body);
    return;
  }
  res.setHeader("Content-Type", contentType || "video/mp2t");
  res.setHeader("Access-Control-Allow-Origin", "*");
  for (const h of ["content-length", "content-range", "accept-ranges"]) {
    if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
  }
  res.writeHead(upstream.statusCode);
  upstream.pipe(res);
  res.on("close", () => upstream.destroy());
}

// One localhost relay server per playlist. `key` is the activeRelays entry,
// `prefix` the URL path below the token (e.g. "video" for sub-relays).
function createPlaylistRelay(manifestUrl, headers, token, prefix, key) {
  return new Promise((resolve, reject) => {
    const entry = { manifestUrl, headers, createdAt: Date.now(), lastAccess: Date.now() };
    const server = http.createServer(async (req, res) => {
      entry.lastAccess = Date.now();
      if (entry.owner) entry.owner.lastAccess = entry.lastAccess;
      const reqUrl = new URL(req.url, "http://127.0.0.1");
      const pathParts = reqUrl.pathname.split("/").filter(Boolean);
      if (pathParts[0] !== token) {
        res.writeHead(403);
        res.end("Invalid token");
        return;
      }
      let resource = pathParts.slice(1).join("/");
      if (prefix && resource.startsWith(prefix + "/")) resource = resource.slice(prefix.length + 1);
      else if (prefix && resource === prefix) resource = "";
      const base = `http://127.0.0.1:${server.address().port}/${token}/${prefix ? prefix + "/" : ""}`;
      try {
        if (resource === "index.m3u8" || resource === "") {
          await relayPlaylist(res, manifestUrl, headers, base);
          return;
        }
        const resourceUrl = decodeURIComponent(resource);
        if (!isSafeUrl(resourceUrl)) {
          res.writeHead(400);
          res.end("Invalid segment URL");
          return;
        }
        await relayResource(req, res, resourceUrl, headers, base);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(502);
          res.end("Relay fetch error: " + err.message);
        } else {
          res.destroy();
        }
      }
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const relayUrl = `http://127.0.0.1:${port}/${token}/${prefix ? prefix + "/" : ""}index.m3u8`;
      entry.server = server;
      activeRelays.set(key, entry);
      server.unref();
      scheduleCleanup();
      resolve({ relayUrl, port, token: key });
    });
  });
}

function createRelayServer(manifestUrl, headers, token) {
  return createPlaylistRelay(manifestUrl, headers, token, "", token);
}

function createSubRelay(manifestUrl, headers, token, subPath) {
  return createPlaylistRelay(manifestUrl, headers, token, subPath, token + "-" + subPath);
}

let cleanupTimer = null;
function scheduleCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanupOldRelays, 60000);
  cleanupTimer.unref();
}

// Close relays that mpv has not touched for RELAY_IDLE_MS (a playing stream
// keeps requesting segments/playlists, so active playback is never cut), then
// cap the number of live relays by evicting the least recently used.
function cleanupOldRelays() {
  const now = Date.now();
  const lastSeen = (relay) => relay.lastAccess || relay.createdAt;
  for (const [token, relay] of [...activeRelays.entries()]) {
    if (relay.isSubRelay) continue;
    if (now - lastSeen(relay) > RELAY_IDLE_MS) stopRelay(token);
  }
  const owners = [...activeRelays.entries()].filter(([, r]) => !r.isSubRelay);
  while (owners.length > MAX_RELAYS) {
    owners.sort((a, b) => lastSeen(a[1]) - lastSeen(b[1]));
    stopRelay(owners.shift()[0]);
  }
}

async function startMasterRelay(videoUrl, videoHeaders, audioUrl, audioHeaders) {
  const masterToken = generateToken();
  const videoToken = generateToken();
  const audioToken = generateToken();

  const videoSub = await createSubRelay(videoUrl, videoHeaders, videoToken, "video");
  let audioSub;
  try {
    audioSub = await createSubRelay(audioUrl, audioHeaders, audioToken, "audio");
  } catch (err) {
    stopRelay(videoSub.token);
    throw err;
  }
  const { relayUrl: videoRelayUrl, port: videoPort } = videoSub;
  const { relayUrl: audioRelayUrl, port: audioPort } = audioSub;

  // Create master relay that serves the synthesized master manifest
  return new Promise((resolve, reject) => {
    const entry = {
      videoUrl,
      videoHeaders,
      audioUrl,
      audioHeaders,
      videoToken,
      audioToken,
      videoPort,
      audioPort,
      createdAt: Date.now(),
      lastAccess: Date.now(),
    };
    // Segment traffic on either sub-relay keeps the whole pair alive.
    for (const key of [videoSub.token, audioSub.token]) {
      const sub = activeRelays.get(key);
      if (sub) {
        sub.isSubRelay = true;
        sub.owner = entry;
      }
    }
    const server = http.createServer((req, res) => {
      entry.lastAccess = Date.now();
      const reqUrl = new URL(req.url, "http://127.0.0.1");
      const pathParts = reqUrl.pathname.split("/").filter(Boolean);

      if (pathParts[0] !== masterToken) {
        res.writeHead(403);
        res.end("Invalid token");
        return;
      }

      const resource = pathParts.slice(1).join("/");
      if (resource === "master.m3u8" || resource === "") {
        const masterManifest = [
          "#EXTM3U",
          "#EXT-X-VERSION:3",
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",DEFAULT=YES,AUTOSELECT=YES,URI="${audioRelayUrl}"`,
          `#EXT-X-STREAM-INF:BANDWIDTH=8000000,AUDIO="audio"`,
          videoRelayUrl,
          "",
        ].join("\n");
        sendPlaylist(res, masterManifest);
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    server.on("error", (err) => {
      stopRelay(videoSub.token);
      stopRelay(audioSub.token);
      reject(err);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const masterRelayUrl = `http://127.0.0.1:${port}/${masterToken}/master.m3u8`;
      entry.server = server;
      activeRelays.set(masterToken, entry);
      server.unref();
      scheduleCleanup();
      resolve({ masterRelayUrl, port, token: masterToken, videoRelayUrl, audioRelayUrl });
    });
  });
}

async function startRelay(manifestUrl, headers) {
  const token = generateToken();
  const { relayUrl } = await createRelayServer(manifestUrl, headers, token);
  return relayUrl;
}

function stopRelay(token) {
  const relay = activeRelays.get(token);
  if (relay) {
    // If this is a master relay, also close sub-relays
    if (relay.videoToken) {
      const videoSubKey = relay.videoToken + "-video";
      const videoSubRelay = activeRelays.get(videoSubKey);
      if (videoSubRelay) {
        videoSubRelay.server.close();
        activeRelays.delete(videoSubKey);
      }
    }
    if (relay.audioToken) {
      const audioSubKey = relay.audioToken + "-audio";
      const audioSubRelay = activeRelays.get(audioSubKey);
      if (audioSubRelay) {
        audioSubRelay.server.close();
        activeRelays.delete(audioSubKey);
      }
    }
    relay.server.close();
    activeRelays.delete(token);
  }
}

function getRelayInfo(token) {
  return activeRelays.get(token);
}

module.exports = {
  startRelay,
  startMasterRelay,
  stopRelay,
  getRelayInfo,
  resolveManifest,
  verifyFirstSegment,
  fetchSegmentsConcurrently,
  parseM3U8,
  fetchWithHeaders,
  cleanupOldRelays,
  rewriteManifestUrls,
  activeRelays,
};