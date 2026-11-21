"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const { URL } = require("url");
const {
  startMasterRelay,
  startRelay,
  stopRelay,
  parseM3U8,
  rewriteManifestUrls,
  activeRelays,
} = require("../stream-relay");

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

function createM3U8Server(videoManifest, audioManifest = "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\naudio-seg.ts\n", segmentContent = "segment-data") {
  return createTestServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1`);
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

async function waitForRelayReady(masterRelayUrl) {
  const maxAttempts = 20;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(masterRelayUrl);
      if (response.ok) return;
    } catch {
      // wait and retry
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Master relay did not become ready");
}

// Cleanup all relays after each test to prevent hanging handles
test.afterEach(() => {
  for (const [, relay] of activeRelays.entries()) {
    try {
      relay.server.close();
    } catch {
      // ignore
    }
  }
  activeRelays.clear();
});

test("parseM3U8 correctly identifies master vs media playlists", () => {
  const masterM3U8 = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8000000
video-1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4000000
video-720p.m3u8`;

  const mediaM3U8 = `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10,
segment1.ts
#EXTINF:10,
segment2.ts`;

  const masterParsed = parseM3U8(masterM3U8, "http://example.com/master.m3u8");
  const mediaParsed = parseM3U8(mediaM3U8, "http://example.com/media.m3u8");

  assert.strictEqual(masterParsed.isMaster, true);
  assert.ok(masterParsed.variantUrl);
  assert.strictEqual(mediaParsed.isMaster, false);
  assert.strictEqual(mediaParsed.segments.length, 2);
});

test("startMasterRelay synthesizes master manifest with video and audio", async () => {
  const { server: videoServer, url: videoBase } = await createM3U8Server(
    `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10,
seg1.ts
#EXTINF:10,
seg2.ts`
  );
  const { server: audioServer, url: audioBase } = await createM3U8Server(
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\naudio-seg.ts\n",
    `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10,
audio1.ts
#EXTINF:10,
audio2.ts`
  );

  const videoUrl = videoBase + "/video.m3u8";
  const audioUrl = audioBase + "/audio.m3u8";

  const videoHeaders = { Referer: "http://example.com/", Origin: "http://example.com" };
  const audioHeaders = { Referer: "http://example.com/", Origin: "http://example.com" };

  const result = await startMasterRelay(videoUrl, videoHeaders, audioUrl, audioHeaders);

  // Verify result structure
  assert.ok(result.masterRelayUrl);
  assert.ok(result.masterRelayUrl.includes("/master.m3u8"));
  assert.ok(result.videoRelayUrl);
  assert.ok(result.audioRelayUrl);

  // Fetch the synthesized master manifest
  await waitForRelayReady(result.masterRelayUrl);
  const response = await fetch(result.masterRelayUrl);
  const masterManifest = await response.text();

  // Verify master manifest structure
  assert.ok(masterManifest.includes("#EXTM3U"));
  assert.ok(masterManifest.includes("#EXT-X-VERSION:3"));
  assert.ok(masterManifest.includes('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",DEFAULT=YES,AUTOSELECT=YES'));
  assert.ok(masterManifest.includes(`URI="${result.audioRelayUrl}"`));
  assert.ok(masterManifest.includes("#EXT-X-STREAM-INF:BANDWIDTH=8000000,AUDIO=\"audio\""));
  assert.ok(masterManifest.includes(result.videoRelayUrl));

  // Cleanup
  stopRelay(result.token);
  videoServer.close();
  audioServer.close();
});

test("startMasterRelay video and audio sub-relays serve rewritten manifests", async () => {
  const { server: videoServer, url: videoBase } = await createM3U8Server(
    `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10,
seg1.ts
#EXTINF:10,
seg2.ts`
  );
  const { server: audioServer, url: audioBase } = await createM3U8Server(
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\naudio-seg.ts\n",
    `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10,
audio1.ts
#EXTINF:10,
audio2.ts`
  );

  const videoUrl = videoBase + "/video.m3u8";
  const audioUrl = audioBase + "/audio.m3u8";

  const videoHeaders = { Referer: "http://example.com/" };
  const audioHeaders = { Referer: "http://example.com/" };

  const result = await startMasterRelay(videoUrl, videoHeaders, audioUrl, audioHeaders);

  await waitForRelayReady(result.masterRelayUrl);
  await waitForRelayReady(result.videoRelayUrl);
  await waitForRelayReady(result.audioRelayUrl);

  // Fetch video sub-relay manifest
  const videoResponse = await fetch(result.videoRelayUrl);
  const videoManifest = await videoResponse.text();
  assert.ok(videoManifest.includes("#EXTM3U"));
  // Segments should be rewritten to point through the relay (includes token path)
  assert.ok(videoManifest.includes("/video/"));
  assert.ok(videoManifest.includes("seg1.ts"));

  // Fetch audio sub-relay manifest
  const audioResponse = await fetch(result.audioRelayUrl);
  const audioManifest = await audioResponse.text();
  assert.ok(audioManifest.includes("#EXTM3U"));
  assert.ok(audioManifest.includes("/audio/"));
  assert.ok(audioManifest.includes("audio1.ts"));

  // Cleanup
  stopRelay(result.token);
  videoServer.close();
  audioServer.close();
});

test("startMasterRelay sub-relays proxy segments correctly", async () => {
  const { server: videoServer, url: videoBase } = await createM3U8Server(
    `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10,
seg1.ts
#EXTINF:10,
seg2.ts`,
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\naudio-seg.ts\n",
    "video-segment-data"
  );
  const { server: audioServer, url: audioBase } = await createM3U8Server(
    `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10,
audio1.ts
#EXTINF:10,
audio2.ts`,
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\naudio-seg.ts\n",
    "audio-segment-data"
  );

  const videoUrl = videoBase + "/video.m3u8";
  const audioUrl = audioBase + "/audio.m3u8";

  const result = await startMasterRelay(videoUrl, {}, audioUrl, {});

  await waitForRelayReady(result.masterRelayUrl);

  // Fetch video sub-relay manifest to get segment URLs
  const videoResponse = await fetch(result.videoRelayUrl);
  const videoManifest = await videoResponse.text();

  // Extract first segment URL from manifest
  const segmentLine = videoManifest.split("\n").find((l) => l.includes("seg1.ts"));
  assert.ok(segmentLine);

  // The segment URL should be a relay URL
  const segmentUrlMatch = segmentLine.match(/https?:\/\/[^\s]+/);
  assert.ok(segmentUrlMatch);
  const segmentRelayUrl = segmentUrlMatch[0];

  // Fetch the segment through the relay
  const segmentResponse = await fetch(segmentRelayUrl);
  const segmentData = await segmentResponse.text();
  assert.strictEqual(segmentData, "video-segment-data");

  // Cleanup
  stopRelay(result.token);
  videoServer.close();
  audioServer.close();
});

test("stopRelay cleans up master relay and sub-relays", async () => {
  const { server: videoServer, url: videoBase } = await createM3U8Server(
    `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10,
seg1.ts`
  );
  const { server: audioServer, url: audioBase } = await createM3U8Server(
    `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10,
audio1.ts`,
    "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\naudio-seg.ts\n"
  );

  const videoUrl = videoBase + "/video.m3u8";
  const audioUrl = audioBase + "/audio.m3u8";

  const result = await startMasterRelay(videoUrl, {}, audioUrl, {});

  // Verify relays are active - keys include -video and -audio suffixes
  // URL format: http://127.0.0.1:PORT/TOKEN/video/index.m3u8
  const videoRelayToken = result.videoRelayUrl.match(/\/([a-f0-9]+)\/video\/index\.m3u8/)[1] + "-video";
  const audioRelayToken = result.audioRelayUrl.match(/\/([a-f0-9]+)\/audio\/index\.m3u8/)[1] + "-audio";
  assert.ok(activeRelays.has(result.token));
  assert.ok(activeRelays.has(videoRelayToken));
  assert.ok(activeRelays.has(audioRelayToken));

  // Stop master relay
  stopRelay(result.token);

  // Verify all relays are cleaned up
  assert.strictEqual(activeRelays.has(result.token), false);
  assert.strictEqual(activeRelays.has(videoRelayToken), false);
  assert.strictEqual(activeRelays.has(audioRelayToken), false);

  videoServer.close();
  audioServer.close();
});

test("startRelay (single) still works for non-split streams", async () => {
  const { server, url: base } = await createM3U8Server(
    `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10,
seg1.ts
#EXTINF:10,
seg2.ts`
  );

  const manifestUrl = base + "/video.m3u8";
  const relayUrl = await startRelay(manifestUrl, { Referer: "http://example.com/" });

  assert.ok(relayUrl.includes("/index.m3u8"));

  // Fetch the relay manifest
  const response = await fetch(relayUrl);
  const manifest = await response.text();
  assert.ok(manifest.includes("#EXTM3U"));
  assert.ok(manifest.includes("seg1.ts"));

  // Extract token from relay URL and stop
  const tokenMatch = relayUrl.match(/\/([a-f0-9]+)\/index\.m3u8/);
  if (tokenMatch) {
    stopRelay(tokenMatch[1]);
  }

  server.close();
});

test("master manifest has correct bandwidth and audio group references", async () => {
  const { server: videoServer, url: videoBase } = await createM3U8Server(
    `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10,
seg1.ts`
  );
  const { server: audioServer, url: audioBase } = await createM3U8Server(
    `#EXTM3U
#EXT-X-VERSION:3
#EXTINF:10,
audio1.ts`
  );

  const result = await startMasterRelay(videoBase + "/video.m3u8", {}, audioBase + "/audio.m3u8", {});

  await waitForRelayReady(result.masterRelayUrl);
  const response = await fetch(result.masterRelayUrl);
  const masterManifest = await response.text();

  // Verify bandwidth is present
  assert.ok(masterManifest.includes("BANDWIDTH=8000000"));

  // Verify audio group reference matches
  assert.ok(masterManifest.includes('AUDIO="audio"'));
  assert.ok(masterManifest.includes('GROUP-ID="audio"'));

  // Verify the structure matches the spec exactly
  const lines = masterManifest.split("\n").filter((l) => l.trim());
  assert.strictEqual(lines[0], "#EXTM3U");
  assert.strictEqual(lines[1], "#EXT-X-VERSION:3");
  assert.ok(lines[2].startsWith('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio"'));
  assert.ok(lines[3].startsWith("#EXT-X-STREAM-INF:BANDWIDTH=8000000,AUDIO=\"audio\""));
  assert.strictEqual(lines[4], result.videoRelayUrl);

  stopRelay(result.token);
  videoServer.close();
  audioServer.close();
});

test("rewriteManifestUrls routes quoted URI= attributes through the relay", () => {
  const base = "http://127.0.0.1:9876/abcdef/";
  const manifestBaseUrl = "https://example.com/stream/playlist.m3u8";

  const text = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="subs_en.vtt"
#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/keys/key.key"
#EXT-X-MAP:URI="init.mp4"
#EXT-X-STREAM-INF:BANDWIDTH=8000000
video.m3u8`;

  const out = rewriteManifestUrls(text, base, manifestBaseUrl);

  // EXT-X-MEDIA audio rendition routed through relay
  assert.ok(out.includes('URI="http://127.0.0.1:9876/abcdef/' + encodeURIComponent("https://example.com/stream/audio.m3u8") + '"'));
  // EXT-X-MEDIA subtitle rendition routed through relay
  assert.ok(out.includes('URI="http://127.0.0.1:9876/abcdef/' + encodeURIComponent("https://example.com/stream/subs_en.vtt") + '"'));
  // EXT-X-KEY absolute URI resolved against base and routed through relay
  assert.ok(out.includes('URI="http://127.0.0.1:9876/abcdef/' + encodeURIComponent("https://example.com/keys/key.key") + '"'));
  // EXT-X-MAP relative init segment resolved against base and routed through relay
  assert.ok(out.includes('URI="http://127.0.0.1:9876/abcdef/' + encodeURIComponent("https://example.com/stream/init.mp4") + '"'));
});

test("rewriteManifestUrls does not double-rewrite already-relayed URIs", () => {
  const base = "http://127.0.0.1:9876/abcdef/";
  const manifestBaseUrl = "https://example.com/stream/playlist.m3u8";

  const already = `http://127.0.0.1:9876/abcdef/${encodeURIComponent("https://example.com/stream/audio.m3u8")}`;
  const text = `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",URI="${already}"`;

  const out = rewriteManifestUrls(text, base, manifestBaseUrl);
  assert.strictEqual(out, text);
});
test("rewriteManifestUrls handles CRLF playlists and keeps non-HTTP key URIs", () => {
  const text = "#EXTM3U\r\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://key-id\"\r\n#EXT-X-MAP:URI=\"init.mp4\"\r\n#EXTINF:4,\r\nseg1.m4s\r\n";
  const base = "http://127.0.0.1:1/tok/";
  const out = rewriteManifestUrls(text, base, "https://cdn.example.com/v/index.m3u8");
  assert.ok(!out.includes("\r"));
  assert.ok(out.includes(base + encodeURIComponent("https://cdn.example.com/v/seg1.m4s")));
  assert.ok(out.includes('URI="' + base + encodeURIComponent("https://cdn.example.com/v/init.mp4") + '"'));
  assert.ok(out.includes('URI="skd://key-id"'));
});

test("startRelay rewrites nested variant playlists so their segments use the relay", async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, referer: req.headers.referer });
    if (req.url === "/master.m3u8") {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.end("#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"audio/a.m3u8\"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO=\"a\"\nvideo/v.m3u8\n");
    } else if (req.url === "/video/v.m3u8") {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.end("#EXTM3U\n#EXTINF:4,\nseg1.ts\n");
    } else if (req.url === "/video/seg1.ts") {
      res.setHeader("Content-Type", "video/mp2t");
      res.end("SEGMENT");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + upstream.address().port;
  try {
    const relayUrl = await startRelay(origin + "/master.m3u8", { Referer: "https://site.example/" });
    const master = await (await fetch(relayUrl)).text();
    const variantLine = master.split("\n").find((l) => l.startsWith("http://127.0.0.1") && l.includes("v.m3u8"));
    assert.ok(variantLine, "variant playlist routed through relay");
    assert.ok(/URI="http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\/[^"]*audio%2Fa\.m3u8"/.test(master), "audio rendition routed through relay");
    const variant = await (await fetch(variantLine)).text();
    const segLine = variant.split("\n").find((l) => l.startsWith("http://127.0.0.1"));
    assert.ok(segLine, "nested playlist segments routed through relay");
    const seg = await (await fetch(segLine)).text();
    assert.strictEqual(seg, "SEGMENT");
    assert.ok(seen.every((s) => s.referer === "https://site.example/"), "every upstream request carries the tab headers");
  } finally {
    upstream.close();
  }
});
