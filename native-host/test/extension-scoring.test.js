"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Load the real background service worker in a sandbox with stubbed chrome APIs
// so the pure scoring/pairing helpers can be exercised without a browser.
function loadBackground() {
  const file = path.join(__dirname, "..", "..", "browser-extension", "background.js");
  const code = fs.readFileSync(file, "utf8");
  const noop = () => {};
  const listener = { addListener: noop };
  let badgeText = "";
  const chrome = {
    runtime: { onMessage: listener, onInstalled: listener, id: "test-extension" },
    webRequest: {
      onBeforeRequest: listener,
      onBeforeSendHeaders: listener,
      onHeadersReceived: listener,
    },
    contextMenus: { onClicked: listener, removeAll: noop, create: noop },
    tabs: {
      onRemoved: listener,
      onUpdated: listener,
      query: async () => [],
      get: async () => null,
      sendMessage: async () => null,
    },
    action: {
      setBadgeBackgroundColor: noop,
      setBadgeTextColor: noop,
      setBadgeText: (opts) => { badgeText = (opts && opts.text) || ""; },
    },
    storage: {
      session: { get: async () => ({}), set: async () => {} },
      local: { get: async () => ({}), set: async () => {} },
      sync: { get: async () => ({}) },
    },
    cookies: { getAll: async () => [] },
    notifications: { create: async () => {} },
    scripting: { executeScript: async () => [] },
  };
  const sandbox = {
    chrome,
    navigator: { userAgent: "test" },
    URL,
    fetch: async () => ({ ok: false }),
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.globalThis = sandbox;
  sandbox.__getBadgeText = () => badgeText;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "background.js" });
  return sandbox;
}

const bg = loadBackground();
const VIDEO_PROXY = "https://hls.shegu.net/m3u8_proxy/video/8700/index.m3u8";
const AUDIO_PROXY = "https://hls.shegu.net/m3u8_proxy/audio/8700/index.m3u8";

describe("extension stream scoring: m3u8_proxy audio pairing", () => {
  it("classifies proxy audio as hls-audio-only (not a master manifest)", () => {
    const r = bg.scoreStreamCandidate(AUDIO_PROXY, {}, 1, [], [], null);
    assert.equal(r.kind, "hls-audio-only");
  });

  it("classifies proxy video as hls-video-only (not a master manifest)", () => {
    const r = bg.scoreStreamCandidate(VIDEO_PROXY, {}, 1, [], [], null);
    assert.equal(r.kind, "hls-video-only");
  });

  it("ranks a verified master manifest above a proxy-video entry", () => {
    const proxy = bg.scoreStreamCandidate(VIDEO_PROXY, {}, 1, [], [], null);
    const master = bg.scoreStreamCandidate("https://cdn.example.com/master.m3u8", {}, 1, [], [], null);
    assert.equal(master.kind, "hls-master");
    assert.ok(master.score > proxy.score,
      `master manifest (${master.score}) should outrank proxy video (${proxy.score})`);
  });

  it("auto-pairs proxy audio as audioUrl on the proxy video", () => {
    const audioStreams = [{ url: AUDIO_PROXY, kind: "hls-audio-only", score: 100, frameId: null }];
    const r = bg.scoreStreamCandidate(VIDEO_PROXY, {}, 1, [], audioStreams, null);
    assert.equal(r.kind, "hls-video-only");
    assert.equal(r.audioUrl, AUDIO_PROXY);
  });

  it("derives the deterministic audio sibling from a proxy video URL", () => {
    assert.equal(
      bg.siblingAudioUrl(VIDEO_PROXY),
      "https://hls.shegu.net/m3u8_proxy/audio/8700/index.m3u8"
    );
    assert.equal(bg.siblingAudioUrl("https://cdn.example.com/video.m3u8"), null);
  });

  it("recognises the audio path variants the site may use", () => {
    for (const url of [
      AUDIO_PROXY,
      "https://hls.shegu.net/m3u8_proxy/audio_1080/8700/index.m3u8",
      "https://cdn.example.com/audio/index.m3u8",
      "https://cdn.example.com/stream_mp4a.m3u8",
      "https://cdn.example.com/stream?type=audio",
    ]) {
      assert.equal(bg.isAudioPlaylistUrl(url), true, `${url} should be audio`);
    }
    assert.equal(bg.isAudioPlaylistUrl(VIDEO_PROXY), false);
  });

  it("excludes audio-only entries from the displayed video list", () => {
    assert.equal(bg.isDisplayVideo({ kind: "hls-audio-only", url: AUDIO_PROXY }), false);
    assert.equal(bg.isDisplayVideo({ kind: "hls-video-only", url: VIDEO_PROXY }), true);
    assert.equal(bg.isDisplayVideo({ kind: "junk", url: "https://ads.example/x.m3u8" }), false);
  });

  it("still classifies a real generic master as hls-master", () => {
    const r = bg.scoreStreamCandidate("https://cdn.example.com/master.m3u8", {}, 1, [], [], null);
    assert.equal(r.kind, "hls-master");
  });
});

describe("extension addVideo: audio storage and badge count", () => {
  it("stores audio-only in audioStreams (not videos) and pairs it", async () => {
    const tabId = 42;
    bg.addVideo(tabId, AUDIO_PROXY, {});
    let state = bg.getState(tabId);
    assert.equal(state.videos.length, 0, "audio-only must not appear in the video list");
    assert.equal(state.audioStreams.length, 1);

    bg.addVideo(tabId, VIDEO_PROXY, {});
    state = bg.getState(tabId);
    assert.equal(state.videos.length, 1);
    assert.equal(state.videos[0].kind, "hls-video-only");
    assert.equal(state.videos[0].audioUrl, AUDIO_PROXY);

    await new Promise((r) => setTimeout(r, 0));
    assert.equal(bg.__getBadgeText(), "1", "badge should count only the video, not the audio");
  });
});
describe("extension stream scoring: root-level candidate master manifests", () => {
  const ROOT = "https://hls.shegu.net/40097260.m3u8";

  it("scores a root-level /<id>.m3u8 as a 3500-base hls-master candidate", () => {
    const r = bg.scoreStreamCandidate(ROOT, {}, 1, [], [], null);
    assert.equal(r.kind, "hls-master");
    assert.ok(r.score >= 3500);
  });

  it("ranks the root manifest #1 above proxy video immediately on interception", () => {
    const tabId = 4242;
    bg.addVideo(tabId, AUDIO_PROXY, {});
    bg.addVideo(tabId, VIDEO_PROXY, {});
    bg.addVideo(tabId, ROOT, {});
    assert.equal(bg.getState(tabId).videos[0].url, ROOT);
  });

  it("does not treat nested /video/ or /audio/ playlists as root candidates", () => {
    assert.equal(bg.isRootManifestCandidate("https://cdn.example.com/video/123.m3u8"), false);
    assert.equal(bg.isRootManifestCandidate("https://cdn.example.com/a/b/123.m3u8"), false);
    assert.equal(bg.isRootManifestCandidate(ROOT), true);
  });

  it("demotes a root candidate whose body is a media playlist", () => {
    const tabId = 4343;
    bg.addVideo(tabId, VIDEO_PROXY, {});
    bg.addVideo(tabId, ROOT, {});
    assert.equal(bg.demoteRootManifestCandidate(tabId, ROOT), true);
    const entry = bg.getState(tabId).videos.find((v) => v.url === ROOT);
    assert.equal(entry.kind, "hls-video-only");
    assert.equal(bg.getState(tabId).videos[0].url, VIDEO_PROXY);
  });
});
