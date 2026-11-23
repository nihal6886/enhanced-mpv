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
    assert.ok(args.includes("--start=+42"), "resume start is floored to whole seconds");
    assert.ok(args.includes("--sub-file=" + subtitle));
    assert.ok(args.some((arg) => arg.startsWith("--http-header-fields=")));
    assert.ok(args.find((arg) => arg.startsWith("--http-header-fields=")).includes("Cookie: session=secret; locale=en"));
  });

  it("never duplicates headers into --demuxer-lavf-o (mpv forwards --http-header-fields to lavf)", () => {
    const url = "https://cdn.example.test/stream.m3u8";
    const args = buildArgs({
      url,
      userAgent: "Enhanced MPV/1.0",
      referer: "https://provider.example.test/",
      cookies: "session=abc123",
    }, [], "C:\\Program Files\\mpv\\mpv.exe");

    assert.equal(args.find((arg) => /^--demuxer-lavf-o(?:-append)?=headers=/.test(arg)), undefined);
    assert.equal(args.find((arg) => arg.startsWith("--demuxer-lavf-o=")), undefined,
      "the mpv.conf demuxer-lavf-o list must not be replaced");
    const hdr = args.find((arg) => arg.startsWith("--http-header-fields="));
    assert.ok(hdr.includes("User-Agent: Enhanced MPV/1.0"));
    assert.ok(hdr.includes("Cookie: session=abc123"));
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
  it("passes --audio-file and appends allowed_extensions=ALL for a direct audio URL", () => {
    const args = buildArgs({
      url: "https://cdn.example.test/video/index.m3u8",
      audioUrl: "https://cdn.example.test/audio/index.m3u8",
      userAgent: "Enhanced MPV/1.0",
    }, [], "C:\\Program Files\\mpv\\mpv.exe");

    assert.ok(args.includes("--audio-file=https://cdn.example.test/audio/index.m3u8"));
    assert.ok(!args.includes("--aid=1"), "mpv auto-selects the external audio track");
    assert.ok(args.includes("--demuxer-lavf-o-append=allowed_extensions=ALL"),
      "allowed_extensions=ALL should be appended when a separate audio file is paired");
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

    assert.ok(args.includes("--audio-file=http://127.0.0.1:8765/ab12cd34/index.m3u8"));
  });

  it("omits --audio-file when a master relay already embeds audio", () => {
    const args = buildArgs({
      url: "http://127.0.0.1:8765/ab12cd34/master.m3u8",
      isMasterRelay: true,
      audioUrl: "https://cdn.example.test/audio/index.m3u8",
    }, [], "C:\\Program Files\\mpv\\mpv.exe");

    assert.equal(args.find((arg) => arg.startsWith("--audio-file=")), undefined);
  });
});

describe("resume bounds and single-instance IPC replacement", () => {
  const { resumeStart, loadfilePlan } = require("../mpv-launcher");

  it("only resumes when start > 3, duration > 15, and start < duration - 10", () => {
    assert.equal(resumeStart(42.9, 300), 42);
    assert.equal(resumeStart(3, 300), 0);
    assert.equal(resumeStart(30, 15), 0);
    assert.equal(resumeStart(295, 300), 0);
    assert.equal(resumeStart(60, 0), 0);
    assert.equal(resumeStart(60, Infinity), 0);
    assert.equal(resumeStart(NaN, 300), 0);
  });

  it("omits --start for out-of-bounds resume points", () => {
    const args = buildArgs({ url: "https://cdn.example.test/a.mp4", startTime: 2, duration: 300 }, [], "mpv");
    assert.equal(args.find((a) => a.startsWith("--start=")), undefined);
  });

  it("accepts the branded enhanced-mpv binary", () => {
    assert.equal(isNativeMpv("C:\\Users\\me\\AppData\\Local\\Programs\\EnhancedMPV\\enhanced-mpv.exe"), true);
    assert.equal(isNativeMpv("/usr/bin/mpv"), true);
  });

  it("maps launch args to per-file loadfile options and hot-attach follow-ups", () => {
    const args = buildArgs({
      url: "https://cdn.example.test/video/index.m3u8",
      audioUrl: "https://cdn.example.test/audio/index.m3u8",
      title: "Clip",
      referer: "https://site.example.test/",
    }, [], "mpv");
    const plan = loadfilePlan(args);
    assert.equal(plan.options["force-media-title"], "Clip");
    assert.equal(plan.options.ytdl, "no");
    assert.ok(plan.options["http-header-fields"].includes("Referer: https://site.example.test/"));
    assert.deepEqual(plan.audioFiles, ["https://cdn.example.test/audio/index.m3u8"]);
    assert.equal(plan.options["audio-files-append"], "https://cdn.example.test/audio/index.m3u8");
    assert.equal(plan.options["resume-playback"], "no");
    assert.equal(plan.lavfAppend, "allowed_extensions=ALL");
    assert.equal(plan.options["input-ipc-server"], undefined);
  });

  it("resets spawn-time options for a reused window (yt-dlp after a direct stream)", () => {
    const plan = loadfilePlan(buildArgs({ url: "https://www.youtube.com/watch?v=abc" }, [], "mpv"));
    assert.equal(plan.options.ytdl, "yes");
    assert.equal(plan.options["http-header-fields"], "");
    assert.equal(plan.options["audio-files-append"], undefined);
    assert.equal(plan.options.sid, "auto");
  });
});

const { after } = require("node:test");
after(() => {
  setTimeout(() => process.exit(0), 50).unref();
});
