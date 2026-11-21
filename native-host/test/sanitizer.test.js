"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  isSafeUrl,
  isSafeLocalPath,
  headerFields,
  ytdlSupported,
  escapeHeaderField,
  joinHeaderFields,
  mpvArgv,
} = require("../sanitizer");

describe("argument escaping and URL sanitization", () => {
  it("allows http(s) media URLs", () => {
    assert.equal(isSafeUrl("https://cdn.example/master.m3u8"), true);
    assert.equal(isSafeUrl("http://127.0.0.1:8096/Items/1/Download"), true);
  });

  it("rejects javascript, file, and flag-like values", () => {
    assert.equal(isSafeUrl("javascript:alert(1)"), false);
    assert.equal(isSafeUrl("file:///etc/passwd"), false);
    assert.equal(isSafeUrl("--script=evil.lua"), false);
    assert.equal(isSafeUrl("https://example.com/%0a-o"), true);
  });

  it("rejects newlines in URLs", () => {
    assert.equal(isSafeUrl("https://example.com/a\nrm -rf /"), false);
  });

  it("rejects every non-http(s) protocol outright", () => {
    const rejected = [
      "ytdl://youtube.com/watch?v=1",
      "magnet:?xt=urn:btih:abcdef",
      "rtmp://live.example/app",
      "rtsp://cam.example/stream",
      "ftp://files.example/movie.mkv",
      "data:text/html,<script>alert(1)</script>",
      "blob:https://example.com/abc",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "\\\\srv\\share\\movie.mkv",
      "not a url at all",
    ];
    for (const u of rejected) {
      assert.equal(isSafeUrl(u), false, "should reject: " + u);
    }
  });

  it("builds header fields without CR/LF injection", () => {
    const fields = headerFields({
      userAgent: "Mozilla/5.0",
      referer: "https://play.example/\r\nX-Injected: 1",
      cookies: "sid=abc",
      headers: { Authorization: "Bearer tok\n" },
    });
    assert.ok(fields.some((f) => f.startsWith("User-Agent:")));
    assert.ok(fields.every((f) => !f.includes("\n") && !f.includes("\r")));
  });

  it("never uses a shell string for mpv argv", () => {
    const argv = mpvArgv("/usr/bin/mpv", ["--no-terminal", "https://ex.com/a.mp4; rm -rf /"]);
    assert.equal(argv[0], "/usr/bin/mpv");
    assert.equal(argv.includes("https://ex.com/a.mp4; rm -rf /"), true);
    assert.equal(argv.join(" ").includes("sh -c"), false);
  });

  it("detects YouTube/Vimeo for yt-dlp flags", () => {
    assert.equal(ytdlSupported("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
    assert.equal(ytdlSupported("https://vimeo.com/123"), true);
    assert.equal(ytdlSupported("https://cdn.example/master.m3u8"), false);
  });

  it("routes every supported video platform to yt-dlp", () => {
    const pages = [
      "https://youtube.com/watch?v=abc",
      "https://youtu.be/abc",
      "https://m.youtube.com/watch?v=abc",
      "https://www.vimeo.com/123",
      "https://twitch.tv/somechannel",
      "https://reddit.com/r/x/comments/1",
      "https://x.com/user/status/1",
      "https://twitter.com/user/status/1",
      "https://dailymotion.com/video/x1",
      "https://bilibili.com/video/BV1",
    ];
    for (const u of pages) {
      assert.equal(ytdlSupported(u), true, "should route to yt-dlp: " + u);
    }
    const passthrough = [
      "https://cdn.example/master.m3u8",
      "https://jellyfin.example/Videos/1/stream.mp4",
      "https://notyoutube.com.evil.test/watch",
    ];
    for (const u of passthrough) {
      assert.equal(ytdlSupported(u), false, "should NOT route to yt-dlp: " + u);
    }
  });

  it("escapes commas and backslashes in --http-header-fields", () => {
    assert.equal(escapeHeaderField("Cookie: a=1, b=2"), "Cookie: a=1\\, b=2");
    assert.equal(escapeHeaderField("C:\\path"), "C:\\\\path");
    const joined = joinHeaderFields(["Referer: https://x/y?a=1,2", "Origin: https://x"]);
    assert.equal(joined, "Referer: https://x/y?a=1\\,2,Origin: https://x");
    // Splitting on the unescaped separators yields exactly the original fields.
    assert.deepEqual(joined.split(/(?<!\\),/), ["Referer: https://x/y?a=1\\,2", "Origin: https://x"]);
    assert.equal(joinHeaderFields([]), "");
    assert.equal(joinHeaderFields(null), "");
  });

  it("rejects empty local paths", () => {
    assert.equal(isSafeLocalPath(""), false);
    assert.equal(isSafeLocalPath("-evil"), false);
    assert.equal(isSafeLocalPath("C:\\Videos\\show.mkv"), true);
  });
});
