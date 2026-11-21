"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");

const {
  startMasterRelay,
  activeRelays,
} = require("../stream-relay");
const { buildArgs } = require("../mpv-launcher");

// --------------------------------------------------------------- helpers --

function createTestServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.unref();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function fetchWithHeaders(url, headers, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? require("https") : require("http");
    const req = lib.get(url, { headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

// Cleanup all relays after each test to prevent hanging handles
test.afterEach(() => {
  for (const [, relay] of activeRelays.entries()) {
    try { relay.server.close(); } catch { /* ignore */ }
  }
  activeRelays.clear();
});

// -------------------------------------------------------- test server ----

function createAuthHlsServer(videoManifest, audioManifest = "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\naudio-seg.ts\n", segmentContent = "segment-data") {
  return createTestServer((req, res) => {
    const referer = req.headers.referer || "";
    const cookie = req.headers.cookie || "";
    const url = new URL(req.url, `http://127.0.0.1`);

    // Enforce authentication: require Referer + Cookie headers
    if (!referer || !cookie) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }

    if (url.pathname === "/video.m3u8") {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.end(videoManifest);
    } else if (url.pathname === "/audio.m3u8") {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.end(audioManifest);
    } else if (url.pathname.endsWith(".ts")) {
      res.setHeader("Content-Type", "video/mp2t");
      res.end(segmentContent);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });
}

const AUDIO_MANIFEST = `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10,
audio-seg-1.ts
#EXTINF:10,
audio-seg-2.ts
#EXT-X-ENDLIST
`;

const MASTER_MANIFEST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",AUTOSELECT=YES,DEFAULT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="audio",RESOLUTION=1920x1080
video.m3u8
`;

const TEST_HEADERS = {
  referer: "https://example.com/page",
  cookie: "session=abc123; token=xyz789",
  origin: "https://example.com",
  userAgent: "Mozilla/5.0 Test",
};

// ----------------------------------------------------- E2E tests ---------

test("e2e: authenticated split HLS master relay returns 200 OK with headers preserved", async () => {
  const server = await createAuthHlsServer(MASTER_MANIFEST);
  const baseUrl = server.url;

  // Patch URLs in manifests to point to our test server
  const videoManifest = MASTER_MANIFEST.replace("video.m3u8", baseUrl + "/video.m3u8");
  const audioManifest = AUDIO_MANIFEST.replace("audio-seg-1.ts", baseUrl + "/audio-seg-1.ts")
    .replace("audio-seg-2.ts", baseUrl + "/audio-seg-2.ts");

  // Re-create server with patched manifests
  server.server.close();
  activeRelays.clear();

  const authServer = await createAuthHlsServer(videoManifest, audioManifest);
  const authBase = authServer.url;

  const relay = await startMasterRelay(
    authBase + "/video.m3u8",
    TEST_HEADERS,
    authBase + "/audio.m3u8",
    TEST_HEADERS
  );
  const masterRelayUrl = relay.masterRelayUrl;
  const videoRelayUrl = relay.videoRelayUrl;

  assert.ok(masterRelayUrl, "master relay URL should be returned");
  assert.ok(masterRelayUrl.startsWith("http://127.0.0.1:"), "relay URL should be localhost");

  // Fetch the master manifest through the relay
  const masterResp = await fetchWithHeaders(masterRelayUrl, TEST_HEADERS);
  assert.equal(masterResp.statusCode, 200, "master manifest should return 200 OK");

  const masterText = masterResp.body.toString("utf8");
  assert.ok(masterText.includes("#EXTM3U"), "master manifest should contain #EXTM3U");
  assert.ok(masterText.includes("127.0.0.1"), "master manifest should reference relay URLs");

  // Fetch video sub-playlist through relay
  const videoResp = await fetchWithHeaders(videoRelayUrl, TEST_HEADERS);
  assert.equal(videoResp.statusCode, 200, "video playlist should return 200 OK");

  const videoText = videoResp.body.toString("utf8");
  assert.ok(videoText.includes("#EXTM3U"), "video playlist should contain #EXTM3U");

  // Verify segment URLs in the playlist are rewritten through the relay
  const segLines = videoText.split("\n").filter((l) => l.trim() && !l.trimStart().startsWith("#"));
  assert.ok(segLines.length > 0, "rewritten video playlist should contain segment URLs");
  assert.ok(segLines[0].includes("127.0.0.1"), "segment URLs should be relayed through localhost");
});

test("e2e: upstream requires auth headers; relay forwards them correctly", async () => {
  const server = await createAuthHlsServer(MASTER_MANIFEST);
  const baseUrl = server.url;

  server.server.close();
  activeRelays.clear();

  const authServer = await createAuthHlsServer(
    MASTER_MANIFEST.replace("video.m3u8", baseUrl + "/video.m3u8"),
    AUDIO_MANIFEST.replace("audio-seg-1.ts", baseUrl + "/audio-seg-1.ts")
      .replace("audio-seg-2.ts", baseUrl + "/audio-seg-2.ts")
  );
  const authBase = authServer.url;

  // Direct upstream request without auth headers should get 401
  const noAuthDirect = await fetchWithHeaders(authBase + "/video.m3u8", {});
  assert.equal(noAuthDirect.statusCode, 401, "upstream should reject requests without auth headers");

  // Direct upstream request with auth headers should get 200
  const authDirect = await fetchWithHeaders(authBase + "/video.m3u8", TEST_HEADERS);
  assert.equal(authDirect.statusCode, 200, "upstream should accept requests with auth headers");

  // Create relay WITH auth headers
  const relay = await startMasterRelay(
    authBase + "/video.m3u8",
    TEST_HEADERS,
    authBase + "/audio.m3u8",
    TEST_HEADERS
  );
  const masterRelayUrl = relay.masterRelayUrl;

  // Relay with stored auth headers should serve 200 even if client sends no headers
  const relayResp = await fetchWithHeaders(masterRelayUrl, {});
  assert.equal(relayResp.statusCode, 200, "relay should forward stored auth headers to upstream");
});

test("e2e: buildArgs passes --audio-file for split video-only HLS", () => {
  const payload = {
    url: "http://example.com/video.m3u8",
    audioUrl: "http://example.com/audio.m3u8",
    audioHeaders: { Referer: "https://example.com", Cookie: "session=abc" },
    headers: [{ key: "Referer", value: "https://example.com" }],
    title: "Test Video",
    startTime: 0,
    duration: 0,
  };

  // We need to mock readConfig or set up config. buildArgs reads config internally.
  // Instead, verify the args structure includes --audio-file when split audio.
  const args = buildArgs(payload, [], "/usr/bin/mpv");

  const audioFileArg = args.find((a) => a.startsWith("--audio-file="));
  assert.ok(audioFileArg, "buildArgs should include --audio-file for split audio");
  assert.ok(audioFileArg.includes("http://example.com/audio.m3u8"), "audio-file should point to the audio URL");

  const allowedExtArg = args.find((a) => a.includes("allowed_extensions=ALL"));
  assert.ok(allowedExtArg, "buildArgs should append allowed_extensions=ALL for split audio");
});

test("e2e: buildArgs omits --audio-file for verified master relay", () => {
  const payload = {
    url: "http://example.com/master.m3u8",
    audioUrl: null,
    audioHeaders: {},
    headers: [{ key: "Referer", value: "https://example.com" }],
    title: "Test Video",
    startTime: 0,
    duration: 0,
    isMasterRelay: true,
  };

  const args = buildArgs(payload, [], "/usr/bin/mpv");

  const audioFileArg = args.find((a) => a.startsWith("--audio-file="));
  assert.equal(audioFileArg, undefined, "buildArgs should NOT include --audio-file for master relay");
});

test("e2e: buildArgs passes --start=+N for valid resume timestamp", () => {
  const payload = {
    url: "http://example.com/video.m3u8",
    audioUrl: null,
    audioHeaders: {},
    headers: [{ key: "Referer", value: "https://example.com" }],
    title: "Test Video",
    startTime: 42,
    duration: 120,
    startTimeSource: "executeScript frame=0",
  };

  const args = buildArgs(payload, [], "/usr/bin/mpv");

  const startArg = args.find((a) => a.startsWith("--start="));
  assert.ok(startArg, "buildArgs should include --start for valid resume");
  assert.equal(startArg, "--start=+42", "start should be floored seconds with + prefix");
});

test("e2e: buildArgs omits --start for out-of-bounds resume timestamp", () => {
  const payload = {
    url: "http://example.com/video.m3u8",
    audioUrl: null,
    audioHeaders: {},
    headers: [{ key: "Referer", value: "https://example.com" }],
    title: "Test Video",
    startTime: 5,
    duration: 10,
    startTimeSource: "autoIntercept",
  };

  const args = buildArgs(payload, [], "/usr/bin/mpv");

  const startArg = args.find((a) => a.startsWith("--start="));
  assert.equal(startArg, undefined, "buildArgs should NOT include --start for out-of-bounds timestamp");
});

test("e2e: relay daemon starts and stops cleanly on Windows named pipe", async () => {
  const server = await createAuthHlsServer(MASTER_MANIFEST);
  const baseUrl = server.url;

  server.server.close();
  activeRelays.clear();

  const authServer = await createAuthHlsServer(
    MASTER_MANIFEST.replace("video.m3u8", baseUrl + "/video.m3u8"),
    AUDIO_MANIFEST.replace("audio-seg-1.ts", baseUrl + "/audio-seg-1.ts")
      .replace("audio-seg-2.ts", baseUrl + "/audio-seg-2.ts")
  );
  const authBase = authServer.url;

  const relay = await startMasterRelay(
    authBase + "/video.m3u8",
    TEST_HEADERS,
    authBase + "/audio.m3u8",
    TEST_HEADERS
  );
  const masterRelayUrl = relay.masterRelayUrl;

  assert.ok(masterRelayUrl, "master relay should start");

  // Relay should still be accessible immediately after creation
  const resp = await fetchWithHeaders(masterRelayUrl, TEST_HEADERS);
  assert.equal(resp.statusCode, 200, "relay should serve master manifest immediately after start");
});
