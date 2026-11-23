"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const crypto = require("crypto");
const { isSafeUrl } = require("./sanitizer");

const RELAY_TIMEOUT_MS = 3000;
const MAX_RELAYS = 10;
const TOKEN_BYTES = 16;

// RAM Segment Ring - LRU Prefetch Cache
const PREFETCH_CACHE_MAX_BYTES = 32 * 1024 * 1024; // 32 MiB
const PREFETCH_CACHE_TTL_MS = 60 * 1000; // 60 seconds
const PREFETCH_MAX_SEGMENTS = 2; // Segments #0 and #1

const prefetchCache = new Map(); // key -> { data: Buffer, timestamp: number, size: number }
let prefetchCacheSize = 0;
const prefetchInFlight = new Set();

function prefetchCacheKey(videoUrl, audioUrl) {
  return videoUrl + "|" + (audioUrl || "");
}

function resourceCacheKey(url) {
  return "resource:" + url;
}

function evictPrefetchCache(targetBytes) {
  const entries = [...prefetchCache.entries()];
  entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
  for (const [key, entry] of entries) {
    if (prefetchCacheSize <= targetBytes) break;
    prefetchCacheSize -= entry.size;
    prefetchCache.delete(key);
  }
}

function addToPrefetchCache(key, data) {
  const size = data.length;
  if (size > PREFETCH_CACHE_MAX_BYTES) return;
  const previous = prefetchCache.get(key);
  if (previous) {
    prefetchCacheSize -= previous.size;
    prefetchCache.delete(key);
  }
  while (prefetchCacheSize + size > PREFETCH_CACHE_MAX_BYTES) {
    evictPrefetchCache(prefetchCacheSize - size);
  }
  prefetchCache.set(key, { data, timestamp: Date.now(), size });
  prefetchCacheSize += size;
}

function getFromPrefetchCache(key) {
  const entry = prefetchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > PREFETCH_CACHE_TTL_MS) {
    prefetchCacheSize -= entry.size;
    prefetchCache.delete(key);
    return null;
  }
  entry.timestamp = Date.now(); // LRU touch
  return entry.data;
}

function cleanupPrefetchCache() {
  const now = Date.now();
  for (const [key, entry] of prefetchCache.entries()) {
    if (now - entry.timestamp > PREFETCH_CACHE_TTL_MS) {
      prefetchCacheSize -= entry.size;
      prefetchCache.delete(key);
    }
  }
}

// Periodic cache cleanup
setInterval(cleanupPrefetchCache, 30000);

// Fetch and cache master playlist, variant playlist, init segment, and first 2 segments
async function prefetchStreamSegments(masterUrl, headers) {
  const cacheKey = prefetchCacheKey(masterUrl, null);
  if (prefetchInFlight.has(cacheKey)) return;
  if (getFromPrefetchCache(cacheKey)) return; // Already cached

  prefetchInFlight.add(cacheKey);
  try {
    // 1. Fetch master playlist
    const masterRes = await fetchWithHeaders(masterUrl, headers, 5000);
    if (masterRes.statusCode !== 200 && masterRes.statusCode !== 206) return;
    const masterText = masterRes.body.toString("utf8");
    const masterParsed = parseM3U8(masterText, masterUrl);

    addToPrefetchCache(resourceCacheKey(masterUrl), masterRes.body);

    // Pick the highest ranked variant, or use the supplied playlist directly.
    const variantUrl = masterParsed.isMaster && masterParsed.variants.length
      ? masterParsed.variants[0].url
      : masterUrl;

    // 2. Fetch variant playlist and keep each resource independently addressable.
    const variantRes = variantUrl === masterUrl
      ? masterRes
      : await fetchWithHeaders(variantUrl, headers, 5000);
    if (variantRes.statusCode !== 200 && variantRes.statusCode !== 206) return;
    addToPrefetchCache(resourceCacheKey(variantUrl), variantRes.body);
    const variantText = variantRes.body.toString("utf8");
    parseM3U8(variantText, variantUrl); // Parse to validate structure

    // 3. Find EXT-X-MAP (init segment) and first 2 media segments
    const lines = variantText.split("\n");
    let initSegmentUrl = null;
    const segmentUrls = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("#EXT-X-MAP:")) {
        const attrs = parseAttributes(line.slice("#EXT-X-MAP:".length));
        if (attrs.URI) {
          try {
            initSegmentUrl = new URL(attrs.URI, variantUrl).toString();
          } catch { /* ignore */ }
        }
      } else if (line.startsWith("#EXTINF:")) {
        const nextLine = lines[i + 1]?.trim();
        if (nextLine && !nextLine.startsWith("#") && segmentUrls.length < PREFETCH_MAX_SEGMENTS) {
          try {
            segmentUrls.push(new URL(nextLine, variantUrl).toString());
          } catch { /* ignore */ }
        }
      }
    }

    // 4. Fetch init segment + first 2 segments in parallel
    const urlsToFetch = [];
    if (initSegmentUrl) urlsToFetch.push(initSegmentUrl);
    urlsToFetch.push(...segmentUrls);

    if (urlsToFetch.length === 0) return;

    // 5. Publish each completed chunk as soon as it arrives. mpv can consume
    //    the init segment / first media chunk while later prefetches continue.
    await fetchSegmentsConcurrently(urlsToFetch, headers, {
      concurrency: 3,
      onResult: (result, index) => {
        if (result.ok) addToPrefetchCache(resourceCacheKey(urlsToFetch[index]), result.res.body);
      },
    });
  } catch {
    // Silently ignore prefetch failures
  } finally {
    prefetchInFlight.delete(cacheKey);
  }
}

// Serve prefetched data from cache if available
function serveFromPrefetchCache(key, res) {
  const data = getFromPrefetchCache(key);
  if (!data) return false;

  const url = key.startsWith("resource:") ? key.slice("resource:".length) : "";
  const contentType = /\.m3u8(?:$|[?#])/i.test(url) ? "application/vnd.apple.mpegurl"
    : /\.mpd(?:$|[?#])/i.test(url) ? "application/dash+xml"
      : /\.mp4(?:$|[?#])/i.test(url) ? "video/mp4" : "video/mp2t";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(200);
  res.end(data);
  return true;
}

function upstreamHeaders(headers) {
  return {
    ...(headers || {}),
    "Accept": "*/*",
    "Accept-Encoding": "identity",
  };
}

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

function parseAttributes(value) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = re.exec(String(value || "")))) {
    attrs[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return attrs;
}

function variantInfo(attrs, url) {
  const resolution = /^(\d+)x(\d+)$/.exec(attrs.RESOLUTION || "") || [];
  const bandwidth = parseInt(attrs.BANDWIDTH || "0", 10) || 0;
  const width = parseInt(resolution[1] || "0", 10) || 0;
  const height = parseInt(resolution[2] || "0", 10) || 0;
  return {
    url,
    bandwidth,
    width,
    height,
    resolution: width && height ? `${width}x${height}` : "",
    codecs: attrs.CODECS || "",
    audio: attrs.AUDIO || "",
    frameRate: Number(attrs["FRAME-RATE"] || 0) || 0,
    label: height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)}k` : "Auto",
  };
}

function parseM3U8(content, baseUrl) {
  const lines = String(content || "").replace(/\r\n?/g, "\n").split("\n");
  const segments = [];
  const variants = [];
  const renditions = [];
  let bandwidth = 0;
  let variantUrl = null;
  let isMaster = false;
  let pendingAttrs = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
      if (attrs.URI) {
        try {
          renditions.push({ ...attrs, url: new URL(attrs.URI, baseUrl).toString() });
        } catch {
          // skip invalid rendition URL
        }
      }
    } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
      isMaster = true;
      pendingAttrs = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      if (bwMatch) bandwidth = parseInt(bwMatch[1], 10);
    } else if (line && !line.startsWith("#") && pendingAttrs) {
      try {
        const url = new URL(line, baseUrl).toString();
        const variant = variantInfo(pendingAttrs, url);
        variants.push(variant);
        if (!variantUrl || variant.bandwidth >= bandwidth) {
          variantUrl = url;
          bandwidth = variant.bandwidth || bandwidth;
        }
      } catch {
        // skip invalid variant URL
      }
      pendingAttrs = null;
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

  variants.sort((a, b) => (b.bandwidth - a.bandwidth) || (b.height - a.height));

  return { isMaster, bandwidth, variantUrl, variants, renditions, segments, baseUrl };
}

async function fetchWithHeaders(url, headers, timeoutMs = RELAY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!isSafeUrl(url)) {
      reject(new Error("unsafe URL"));
      return;
    }
    const lib = url.startsWith("https:") ? https : http;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = lib.get(url, { headers: upstreamHeaders(headers), timeout: timeoutMs, agent: relayAgent(url) }, (res) => {
      res.setTimeout(timeoutMs, () => {
        res.destroy();
        fail(new Error("upstream response timeout"));
      });
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try {
          next = new URL(res.headers.location, url).toString();
        } catch {
          fail(new Error("unsafe redirect"));
          return;
        }
        if (!isSafeUrl(next)) {
          fail(new Error("unsafe redirect"));
          return;
        }
        fetchWithHeaders(next, headers, timeoutMs).then(resolve, fail);
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", fail);
    });
    req.on("timeout", () => {
      req.destroy();
      fail(new Error("timeout"));
    });
    req.on("error", fail);
  });
}

// Resolve a possibly nested master playlist down to the highest-bandwidth media
// variant. Without this a synthesized master can point at another master and
// mpv may start audio while never opening a video media playlist (black screen).
async function resolveMediaVariant(url, headers, depth = 0) {
  if (depth > 3) return { url, parsed: null };
  const response = await fetchWithHeaders(url, headers);
  if (response.statusCode !== 200 && response.statusCode !== 206) {
    throw new Error(`Manifest fetch failed: ${response.statusCode}`);
  }
  const parsed = parseM3U8(response.body.toString("utf8"), url);
  if (parsed.isMaster && parsed.variantUrl) {
    return resolveMediaVariant(parsed.variantUrl, headers, depth + 1);
  }
  return { url, parsed, headers: response.headers };
}

async function resolveAudioMedia(url, headers, depth = 0) {
  if (depth > 3) return { url, parsed: null };
  const response = await fetchWithHeaders(url, headers);
  if (response.statusCode !== 200 && response.statusCode !== 206) {
    throw new Error(`Manifest fetch failed: ${response.statusCode}`);
  }
  const parsed = parseM3U8(response.body.toString("utf8"), url);
  if (parsed.isMaster) {
    const rendition = parsed.renditions.find((r) => String(r.TYPE).toUpperCase() === "AUDIO" && r.URI);
    if (rendition) return resolveAudioMedia(rendition.url, headers, depth + 1);
    const audioVariant = parsed.variants.find((v) => /mp4a|aac|ac-3|ec-3/i.test(v.codecs)) || parsed.variants[0];
    if (audioVariant) return resolveAudioMedia(audioVariant.url, headers, depth + 1);
  }
  return { url, parsed, headers: response.headers };
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
          (res) => {
            results[i] = { ok: true, res };
            if (typeof options.onResult === "function") options.onResult(results[i], i);
          },
          (err) => {
            results[i] = { ok: false, err };
            if (typeof options.onResult === "function") options.onResult(results[i], i);
          }
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
  // segments), #EXT-X-I-FRAME-STREAM-INF (iframe playlists), and
  // #EXT-X-SESSION-KEY (session keys) so every rendition/key/init segment/iframe
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
    const req = lib.get(url, { headers: upstreamHeaders(headers), timeout: RELAY_TIMEOUT_MS, agent: relayAgent(url) }, (res) => {
      res.setTimeout(RELAY_TIMEOUT_MS, () => res.destroy(new Error("upstream response timeout")));
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
async function relayResource(req, res, resourceUrl, headers, base, masterUrl) {
  // Check prefetch cache first for instant serving of init segment + first 2 segments
  if (masterUrl) {
    const cacheKey = resourceCacheKey(masterUrl);
    if (serveFromPrefetchCache(cacheKey, res)) {
      return;
    }
  }

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
await relayResource(req, res, resourceUrl, headers, base, manifestUrl);
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

async function startMasterRelay(videoUrl, videoHeaders, audioUrl, audioHeaders, meta = {}) {
  const masterToken = generateToken();
  const videoToken = generateToken();
  const audioToken = generateToken();

  // A proxy may expose a master playlist under a media-playlist-looking URL.
  // Resolve it to a real video variant before relaying so mpv cannot end up
  // with audio-only playback from a nested master.
  let videoMediaUrl = videoUrl;
  let videoMeta = {};
  try {
    const resolved = await resolveMediaVariant(videoUrl, videoHeaders);
    if (resolved.url && resolved.url !== videoUrl) videoMediaUrl = resolved.url;
    if (resolved.parsed && resolved.parsed.variants && resolved.parsed.variants.length) {
      videoMeta = { ...resolved.parsed.variants[0] };
    }
  } catch {
    // Fall back to the supplied URL; the sub-relay will report a clear 502 if
    // the upstream is truly unavailable.
    videoMeta = {};
  }

  let audioMediaUrl = audioUrl;
  try {
    const resolvedAudio = await resolveAudioMedia(audioUrl, audioHeaders);
    if (resolvedAudio.url) audioMediaUrl = resolvedAudio.url;
  } catch {
    // Keep the original audio URL; keep-alive/streaming errors surface later.
  }

  const videoSub = await createSubRelay(videoMediaUrl, videoHeaders, videoToken, "video");
  let audioSub;
  try {
    audioSub = await createSubRelay(audioMediaUrl, audioHeaders, audioToken, "audio");
  } catch (err) {
    stopRelay(videoSub.token);
    throw err;
  }
  const { relayUrl: videoRelayUrl, port: videoPort } = videoSub;
  const { relayUrl: audioRelayUrl, port: audioPort } = audioSub;

  // Create master relay that serves the synthesized master manifest
  return new Promise((resolve, reject) => {
    const entry = {
      videoUrl: videoMediaUrl,
      videoHeaders,
      audioUrl: audioMediaUrl,
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
        const info = { ...meta, ...videoMeta };
        const bandwidth = Math.max(1, Number(info.bandwidth) || 8000000);
        const width = Number(info.width) || 0;
        const height = Number(info.height) || 0;
        const resolution = width && height ? `,RESOLUTION=${width}x${height}` : "";
        const codecs = info.codecs ? `,CODECS="${String(info.codecs).replace(/"/g, "")}"` : "";
        const frameRate = Number(info.frameRate) > 0 ? `,FRAME-RATE=${Number(info.frameRate).toFixed(3)}` : "";
        const audioCodecs = info.audioCodecs ? `,CODECS="${String(info.audioCodecs).replace(/"/g, "")}"` : "";
        const masterManifest = [
          "#EXTM3U",
          "#EXT-X-VERSION:4",
          "#EXT-X-INDEPENDENT-SEGMENTS",
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",DEFAULT=YES,AUTOSELECT=YES${audioCodecs},URI="${audioRelayUrl}"`,
          `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${resolution}${codecs}${frameRate},AUDIO="audio"`,
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
        try { if (typeof videoSubRelay.server.closeAllConnections === "function") videoSubRelay.server.closeAllConnections(); } catch { /* unsupported */ }
        videoSubRelay.server.close();
        activeRelays.delete(videoSubKey);
      }
    }
    if (relay.audioToken) {
      const audioSubKey = relay.audioToken + "-audio";
      const audioSubRelay = activeRelays.get(audioSubKey);
      if (audioSubRelay) {
        try { if (typeof audioSubRelay.server.closeAllConnections === "function") audioSubRelay.server.closeAllConnections(); } catch { /* unsupported */ }
        audioSubRelay.server.close();
        activeRelays.delete(audioSubKey);
      }
    }
    try { if (typeof relay.server.closeAllConnections === "function") relay.server.closeAllConnections(); } catch { /* unsupported */ }
    relay.server.close();
    activeRelays.delete(token);
  }
}

function getRelayInfo(token) {
  return activeRelays.get(token);
}

// Get cache statistics for PipelineState
function getPrefetchCacheStats() {
  let totalBytes = 0;
  let segmentCount = 0;
  for (const entry of prefetchCache.values()) {
    totalBytes += entry.size;
    segmentCount++;
  }
  return {
    bytesPrefetched: totalBytes,
    segmentsCached: segmentCount,
    cacheHitRate: 0, // Would need hit/miss tracking
    maxBytes: PREFETCH_CACHE_MAX_BYTES,
    ttlMs: PREFETCH_CACHE_TTL_MS,
  };
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
  prefetchStreamSegments,
  prefetchCache,
  getFromPrefetchCache,
  getPrefetchCacheStats,
};
