"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildArgs, isNativeMpv, resolveYtdlFormat, publicCommand, redactStderr } = require("../mpv-launcher");

describe("yt-dlp format resolution for page streams", () => {
  const baseCfg = { ytdlFormat: "bestvideo*+bestaudio/best", videoQuality: "best" };

  it("defaults to 2160p format without container restriction and no AV1", () => {
    assert.equal(
      resolveYtdlFormat({}, baseCfg),
      "bestvideo[height<=2160][vcodec!*=av01]+bestaudio/bestvideo[height<=1080]+bestaudio/best"
    );
  });

  it("maps quality preferences to a height cap without container restriction", () => {
    assert.equal(resolveYtdlFormat({ quality: "4k" }, baseCfg), "bestvideo[height<=2160][vcodec!*=av01]+bestaudio/bestvideo[height<=1080]+bestaudio/best");
    assert.equal(resolveYtdlFormat({ quality: "1440" }, baseCfg), "bestvideo[height<=1440][vcodec!*=av01]+bestaudio/bestvideo[height<=1080]+bestaudio/best");
    assert.equal(resolveYtdlFormat({ quality: "720" }, baseCfg), "bestvideo[height<=720][vcodec!*=av01]+bestaudio/bestvideo[height<=1080]+bestaudio/best");
  });

  it("honors an explicit yt-dlp format without shell-unsafe characters", () => {
    assert.equal(
      resolveYtdlFormat({ ytdlFormat: "bestvideo[height<=1440]+bestaudio/best" }, baseCfg),
      "bestvideo[height<=1440]+bestaudio/best"
    );
    // Semicolons and quotes are stripped by the sanitiser.
    assert.equal(resolveYtdlFormat({ ytdlFormat: "best; rm -rf /" }, baseCfg), "bestrm-rf/");
  });
});

describe("native mpv stream launch arguments", () => {
  it("prefers native mpv binaries and rejects mpv.net", () => {
    assert.equal(isNativeMpv("C:\\Program Files\\mpv\\mpv.exe"), true);
    assert.equal(isNativeMpv("C:\\Program Files\\mpv\\mpv.com"), true);
    assert.equal(isNativeMpv("C:\\Program Files\\mpv.net\\mpvnet.exe"), false);
    assert.equal(isNativeMpv("C:\\Program Files\\mpv.net\\mpv.exe"), false);
  });

  it("passes headers, subtitles, start time, and the URL as the final argument", () => {
    const subtitle = require("node:path").resolve("episode.en.srt");
    const url = "https://media.example.test/episode.m3u8";
    const args = buildArgs({
      url,
      title: "Episode 1",
      userAgent: "Enhanced MPV",
      referer: "https://provider.example.test/",
      cookies: "session=secret; locale=en",
      startTime: 42.5,
      duration: 300,  // Provide duration so startTime passes clamping
    }, [subtitle], "C:\\Program Files\\mpv\\mpv.exe");

    assert.equal(args.at(-1), url);
    assert.ok(args.includes("--start=+42.5"));
    assert.ok(args.includes("--sub-file=" + subtitle));
    assert.ok(args.some((arg) => arg.startsWith("--http-header-fields=")));
    assert.ok(args.find((arg) => arg.startsWith("--http-header-fields=")).includes("Cookie: session=secret; locale=en"));
  });

  it("uses valid Header: Value\\r\\n syntax for --demuxer-lavf-o on direct .m3u8 streams", () => {
    const url = "https://cdn.example.test/stream.m3u8";
    const args = buildArgs({
      url,
      userAgent: "Enhanced MPV/1.0",
      referer: "https://provider.example.test/",
      cookies: "session=abc123",
    }, [], "C:\\Program Files\\mpv\\mpv.exe");

    const lavfArg = args.find((arg) => arg.startsWith("--demuxer-lavf-o=headers="));
    assert.ok(lavfArg, "--demuxer-lavf-o=headers= should be present for direct .m3u8 streams");
    // Should use Header: Value\r\n format, not Header=Value|Header=Value
    assert.ok(lavfArg.includes("User-Agent: Enhanced MPV/1.0\\r\\n"), "User-Agent should use Header: Value format with \\r\\n");
    assert.ok(lavfArg.includes("Referer: https://provider.example.test/\\r\\n"), "Referer should use Header: Value format with \\r\\n");
    assert.ok(lavfArg.includes("Cookie: session=abc123\\r\\n"), "Cookie should use Header: Value format with \\r\\n");
    // Should end with \r\n
    assert.ok(lavfArg.endsWith("\\r\\n"), "Headers should end with \\r\\n");
    // Should NOT contain the old malformed format
    assert.ok(!lavfArg.includes("User-Agent=Enhanced MPV/1.0|"), "Should not use old Header=Value| format");
  });

  it("omits --demuxer-lavf-o for YouTube page URLs (yt-dlp manages its own headers)", () => {
    const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const args = buildArgs({
      url,
      userAgent: "Enhanced MPV/1.0",
      referer: "https://www.youtube.com/",
      cookies: "SESSION=secret",
    }, [], "C:\\Program Files\\mpv\\mpv.exe");

    const lavfArg = args.find((arg) => arg.startsWith("--demuxer-lavf-o=headers="));
    assert.equal(lavfArg, undefined, "--demuxer-lavf-o should be omitted for YouTube URLs");
    // --http-header-fields should still be present for yt-dlp
    const hdrArg = args.find((arg) => arg.startsWith("--http-header-fields="));
    assert.ok(hdrArg, "--http-header-fields should be present for YouTube URLs");
    // Verify android_vr is NOT in ytdl-raw-options
    const ytdlRaw = args.find((arg) => arg.startsWith("--ytdl-raw-options="));
    assert.ok(ytdlRaw, "--ytdl-raw-options should be present");
    assert.ok(!ytdlRaw.includes("android_vr"), "android_vr should not be in ytdl-raw-options");
  });

  it("omits --demuxer-lavf-o for other yt-dlp supported page URLs", () => {
    const urls = [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://vimeo.com/123456789",
      "https://twitch.tv/channel",
      "https://www.reddit.com/r/videos/comments/abc123/",
    ];
    for (const url of urls) {
      const args = buildArgs({
        url,
        userAgent: "Enhanced MPV/1.0",
        referer: "https://example.com/",
      }, [], "C:\\Program Files\\mpv\\mpv.exe");
      const lavfArg = args.find((arg) => arg.startsWith("--demuxer-lavf-o=headers="));
      assert.equal(lavfArg, undefined, `demuxer-lavf-o should be omitted for ${url}`);
      // Verify android_vr is NOT in ytdl-raw-options for any yt-dlp URL
      const ytdlRaw = args.find((arg) => arg.startsWith("--ytdl-raw-options="));
      assert.ok(ytdlRaw, `--ytdl-raw-options should be present for ${url}`);
      assert.ok(!ytdlRaw.includes("android_vr"), `android_vr should not be in ytdl-raw-options for ${url}`);
    }
  });
});

describe("command redaction for logging", () => {
  it("redacts --http-header-fields in publicCommand", () => {
    const cmd = publicCommand("mpv.exe", [
      "--http-header-fields=User-Agent: UA, Referer: https://example.com",
      "--demuxer-lavf-o=headers=User-Agent: UA\\r\\nReferer: https://example.com\\r\\n",
      "https://example.com/video.m3u8",
    ]);
    assert.equal(cmd[1], "--http-header-fields=<redacted>");
    assert.equal(cmd[2], "--demuxer-lavf-o=headers=<redacted>");
    assert.equal(cmd[3], "https://example.com/video.m3u8");
  });

  it("redacts --demuxer-lavf-o headers in redactStderr", () => {
    const stderr = "mpv: --demuxer-lavf-o=headers=User-Agent: UA\\r\\nCookie: secret\\r\\n";
    const redacted = redactStderr(stderr);
    assert.ok(redacted.includes("--demuxer-lavf-o=headers=<redacted>"));
    assert.ok(!redacted.includes("Cookie: secret"));
  });

  it("redacts sensitive headers in stderr output", () => {
    const stderr = "Setting Cookie: session=abc123; locale=en\nSetting Referer: https://example.com/";
    const redacted = redactStderr(stderr);
    assert.ok(redacted.includes("Cookie: <redacted>"));
    assert.ok(redacted.includes("Referer: <redacted>"));
    assert.ok(!redacted.includes("session=abc123"));
    assert.ok(!redacted.includes("example.com"));
  });
});

describe("paired external audio for video-only streams", () => {
  it("passes --external-file, --aid=1, and allowed_extensions=ALL for a direct audio URL", () => {
    const args = buildArgs({
      url: "https://cdn.example.test/video/index.m3u8",
      audioUrl: "https://cdn.example.test/audio/index.m3u8",
      userAgent: "Enhanced MPV/1.0",
    }, [], "C:\\Program Files\\mpv\\mpv.exe");

    assert.ok(args.includes("--external-file=https://cdn.example.test/audio/index.m3u8"));
    assert.ok(args.includes("--aid=1"));
    const lavf = args.find((arg) => arg.startsWith("--demuxer-lavf-o="));
    assert.ok(lavf && lavf.includes("allowed_extensions=ALL"),
      "allowed_extensions=ALL should be present when a separate audio file is paired");
  });

  it("prefers the relayed audio URL when auth headers force a local relay", () => {
    const args = buildArgs({
      url: "https://cdn.example.test/video/index.m3u8",
      audioUrl: "https://cdn.example.test/audio/index.m3u8",
      audioHeaders: { cookie: "session=abc" },
      relayedAudioUrl: "http://127.0.0.1:8765/ab12cd34/index.m3u8",
      userAgent: "Enhanced MPV/1.0",
      cookies: "session=abc",
    }, [], "C:\\Program Files\\mpv\\mpv.exe");

    assert.ok(args.includes("--external-file=http://127.0.0.1:8765/ab12cd34/index.m3u8"));
    assert.ok(args.includes("--aid=1"));
  });

  it("omits --external-file and --aid=1 when a master relay already embeds audio", () => {
    const args = buildArgs({
      url: "http://127.0.0.1:8765/ab12cd34/master.m3u8",
      isMasterRelay: true,
      audioUrl: "https://cdn.example.test/audio/index.m3u8",
    }, [], "C:\\Program Files\\mpv\\mpv.exe");

    assert.equal(args.find((arg) => arg.startsWith("--external-file=")), undefined);
    assert.ok(!args.includes("--aid=1"));
  });
});
