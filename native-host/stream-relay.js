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

function rewriteManifestUrls(text, base, manifestBaseUrl) {
  // Rewrite both absolute URLs (http://...) and relative URLs
  // First, handle absolute URLs
  text = text.replace(/^(https?:\/\/[^\s]+)$/gm, (match) => {
    return base + encodeURIComponent(match);
  });
  // Then handle relative URLs (non-comment, non-empty lines that don't start with http)
  text = text.replace(/^([^#\s][^\s]*)$/gm, (match) => {
    // Skip if already an absolute URL (already handled above)
    if (/^https?:\/\//.test(match)) return match;
    // Skip if it's a data URI or other special scheme
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(match)) return match;
    // Resolve relative URL against manifest base URL
    try {
      const absoluteUrl = new URL(match, manifestBaseUrl).toString();
      return base + encodeURIComponent(absoluteUrl);
    } catch {
      return match; // If resolution fails, leave as-is
    }
  });

  // Rewrite quoted URI="..." attributes inside #EXT-X-MEDIA (audio/subtitle
  // renditions), #EXT-X-KEY (AES-128 decryption keys), and #EXT-X-MAP
  // (fMP4 init segments) so every rendition/key/init segment resolves against
  // the playlist base URL and routes through the authenticated relay with the
  // tab's session headers/cookies. Skip URIs already routed through this relay.
  text = text.replace(/(URI=")([^"]+)(")/g, (match, prefix, uri, suffix) => {
    if (/^https?:\/\/127\.0\.0\.1:\d+\//.test(uri)) return match; // already relayed
    try {
      const absoluteUrl = new URL(uri, manifestBaseUrl).toString();
      return prefix + base + encodeURIComponent(absoluteUrl) + suffix;
    } catch {
      return match; // leave unparseable URIs untouched
    }
  });

  return text;
}

function createRelayServer(manifestUrl, headers, token) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, `http://127.0.0.1`);
      const pathParts = reqUrl.pathname.split("/").filter(Boolean);

      // Verify token
      if (pathParts[0] !== token) {
        res.writeHead(403);
        res.end("Invalid token");
        return;
      }

      const resource = pathParts.slice(1).join("/");

      if (resource === "index.m3u8" || resource === "") {
        try {
          const response = await fetchWithHeaders(manifestUrl, headers);
          if (response.statusCode !== 200 && response.statusCode !== 206) {
            res.writeHead(502);
            res.end("Manifest fetch failed");
            return;
          }
          let text = response.body.toString("utf8");

          // Rewrite segment URLs to point through this relay
          const base = `http://127.0.0.1:${server.address().port}/${token}/`;
          text = rewriteManifestUrls(text, base, manifestUrl);

          res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.writeHead(200);
          res.end(text);
        } catch (err) {
          res.writeHead(502);
          res.end("Manifest fetch error: " + err.message);
        }
        return;
      }

      // Segment request - proxy the segment
      try {
        const segmentUrl = decodeURIComponent(resource);
        if (!isSafeUrl(segmentUrl)) {
          res.writeHead(400);
          res.end("Invalid segment URL");
          return;
        }
        const response = await fetchWithHeaders(segmentUrl, headers);
        if (response.statusCode !== 200 && response.statusCode !== 206) {
          res.writeHead(502);
          res.end("Segment fetch failed");
          return;
        }
        res.setHeader("Content-Type", response.headers["content-type"] || "video/mp2t");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.writeHead(response.statusCode);
        res.end(response.body);
      } catch (err) {
        res.writeHead(502);
        res.end("Segment fetch error: " + err.message);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const relayUrl = `http://127.0.0.1:${port}/${token}/index.m3u8`;
      activeRelays.set(token, { server, manifestUrl, headers, createdAt: Date.now() });
      server.unref();
      resolve({ relayUrl, port, token });
    });

    server.on("error", reject);

    // Cleanup old relays periodically
    setTimeout(() => cleanupOldRelays(), 60000);
  });
}

function cleanupOldRelays() {
  const now = Date.now();
  for (const [token, relay] of activeRelays.entries()) {
    if (now - relay.createdAt > RELAY_TIMEOUT_MS) {
      relay.server.close();
      activeRelays.delete(token);
    }
  }
  if (activeRelays.size > MAX_RELAYS) {
    // Close oldest
    const oldest = [...activeRelays.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    oldest[1].server.close();
    activeRelays.delete(oldest[0]);
  }
}

async function createSubRelay(manifestUrl, headers, token, subPath) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, `http://127.0.0.1`);
      const pathParts = reqUrl.pathname.split("/").filter(Boolean);

      // Verify token
      if (pathParts[0] !== token) {
        res.writeHead(403);
        res.end("Invalid token");
        return;
      }

      // Remove subPath prefix from resource if present
      let resource = pathParts.slice(1).join("/");
      if (resource.startsWith(subPath + "/")) {
        resource = resource.slice(subPath.length + 1);
      }

      if (resource === "index.m3u8" || resource === "") {
        try {
          const response = await fetchWithHeaders(manifestUrl, headers);
          if (response.statusCode !== 200 && response.statusCode !== 206) {
            res.writeHead(502);
            res.end("Manifest fetch failed");
            return;
          }
          let text = response.body.toString("utf8");

          // Rewrite segment URLs to point through this relay
          const base = `http://127.0.0.1:${server.address().port}/${token}/${subPath}/`;
          text = rewriteManifestUrls(text, base, manifestUrl);

          res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.writeHead(200);
          res.end(text);
        } catch (err) {
          res.writeHead(502);
          res.end("Manifest fetch error: " + err.message);
        }
        return;
      }

      // Segment request - proxy the segment
      try {
        const segmentUrl = decodeURIComponent(resource);
        if (!isSafeUrl(segmentUrl)) {
          res.writeHead(400);
          res.end("Invalid segment URL");
          return;
        }
        const response = await fetchWithHeaders(segmentUrl, headers);
        if (response.statusCode !== 200 && response.statusCode !== 206) {
          res.writeHead(502);
          res.end("Segment fetch failed");
          return;
        }
        res.setHeader("Content-Type", response.headers["content-type"] || "video/mp2t");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.writeHead(response.statusCode);
        res.end(response.body);
      } catch (err) {
        res.writeHead(502);
        res.end("Segment fetch error: " + err.message);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const relayUrl = `http://127.0.0.1:${port}/${token}/${subPath}/index.m3u8`;
      activeRelays.set(token + "-" + subPath, { server, manifestUrl, headers, createdAt: Date.now() });
      server.unref();
      resolve({ relayUrl, port, token: token + "-" + subPath });
    });

    server.on("error", reject);
    setTimeout(() => cleanupOldRelays(), 60000);
  });
}

async function startMasterRelay(videoUrl, videoHeaders, audioUrl, audioHeaders) {
  const masterToken = generateToken();
  const videoToken = generateToken();
  const audioToken = generateToken();

  // Start video sub-relay
  const { relayUrl: videoRelayUrl, port: videoPort } = await createSubRelay(videoUrl, videoHeaders, videoToken, "video");

  // Start audio sub-relay
  const { relayUrl: audioRelayUrl, port: audioPort } = await createSubRelay(audioUrl, audioHeaders, audioToken, "audio");

  // Create master relay that serves the synthesized master manifest
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, `http://127.0.0.1`);
      const pathParts = reqUrl.pathname.split("/").filter(Boolean);

      // Verify master token
      if (pathParts[0] !== masterToken) {
        res.writeHead(403);
        res.end("Invalid token");
        return;
      }

      const resource = pathParts.slice(1).join("/");

      if (resource === "master.m3u8" || resource === "") {
        // Synthesize master manifest
        const masterManifest = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",DEFAULT=YES,AUTOSELECT=YES,URI="${audioRelayUrl}"
#EXT-X-STREAM-INF:BANDWIDTH=8000000,AUDIO="audio"
${videoRelayUrl}`;

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.writeHead(200);
        res.end(masterManifest);
        return;
      }

      // Other resources not handled by master relay
      res.writeHead(404);
      res.end("Not found");
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const masterRelayUrl = `http://127.0.0.1:${port}/${masterToken}/master.m3u8`;
      activeRelays.set(masterToken, { 
        server, 
        videoUrl, 
        videoHeaders, 
        audioUrl, 
        audioHeaders,
        videoToken,
        audioToken,
        videoPort,
        audioPort,
        createdAt: Date.now() 
      });
      server.unref();
      resolve({ masterRelayUrl, port, token: masterToken, videoRelayUrl, audioRelayUrl });
    });

    server.on("error", reject);
    setTimeout(() => cleanupOldRelays(), 60000);
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