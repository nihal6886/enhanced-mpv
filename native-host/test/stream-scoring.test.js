"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { scoreStreamCandidate, isYtdlPage } = require("../stream-scoring");

describe("scoreStreamCandidate - Edge Stream Scoring & Audio-Pairing", () => {
  const emptyHeaders = {};

  describe("YouTube / yt-dlp canonical page URLs", () => {
    it("scores YouTube watch page +2000 (ytdlp kind)", () => {
      const result = scoreStreamCandidate("https://www.youtube.com/watch?v=dQw4w9WgXcQ", emptyHeaders, 1, []);
      assert.equal(result.kind, "ytdlp");
      assert.equal(result.score, 2000);
      assert.equal(result.audioUrl, null);
    });

    it("scores youtu.be short URL +2000 (ytdlp kind)", () => {
      const result = scoreStreamCandidate("https://youtu.be/dQw4w9WgXcQ", emptyHeaders, 1, []);
      assert.equal(result.kind, "ytdlp");
      assert.equal(result.score, 2000);
    });

    it("scores other yt-dlp platforms (vimeo, twitch, etc.) +2000", () => {
      const urls = [
        "https://vimeo.com/123456789",
        "https://twitch.tv/channel",
        "https://www.reddit.com/r/videos/comments/abc123/",
        "https://x.com/user/status/123",
        "https://www.bilibili.com/video/BV123",
      ];
      for (const url of urls) {
        const result = scoreStreamCandidate(url, emptyHeaders, 1, []);
        assert.equal(result.kind, "ytdlp", `${url} should be ytdlp`);
        assert.equal(result.score, 2000, `${url} should score 2000`);
      }
    });

    it("rejects raw googlevideo.com chunk URLs (segment host)", () => {
      const result = scoreStreamCandidate("https://googlevideo.com/videoplayback?itag=137", emptyHeaders, 1, []);
      assert.equal(result.kind, "segment");
      assert.equal(result.score, -Infinity);
    });
  });

  describe("HLS Master Manifests", () => {
    it("scores master.m3u8 as hls-master with base +1500", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/master.m3u8", emptyHeaders, 1, []);
      assert.equal(result.kind, "hls-master");
      assert.ok(result.score >= 1500);
    });

    it("scores index.m3u8 as hls-master", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/index.m3u8", emptyHeaders, 1, []);
      assert.equal(result.kind, "hls-master");
    });

    it("adds resolution weight for 4K/2160p", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/master_2160p.m3u8", emptyHeaders, 1, []);
      assert.ok(result.score >= 1900); // 1500 + 400
    });

    it("adds resolution weight for 1080p", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/master_1080p.m3u8", emptyHeaders, 1, []);
      assert.ok(result.score >= 1800); // 1500 + 300
    });

    it("adds resolution weight for 720p", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/master_720p.m3u8", emptyHeaders, 1, []);
      assert.ok(result.score >= 1700); // 1500 + 200
    });

    it("adds direct CDN bonus for non-proxy hosts", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/master.m3u8", emptyHeaders, 1, []);
      assert.ok(result.score >= 1600); // 1500 + 100
    });

    it("does NOT add direct CDN bonus for proxy/googlevideo hosts", () => {
      const result = scoreStreamCandidate("https://proxy.example.com/master.m3u8", emptyHeaders, 1, []);
      assert.ok(result.score < 1600); // no +100 bonus
    });

    it("adds bandwidth hint from URL (capped at 500)", () => {
      // 500000000 bps = 500 Mbps, capped at 500
      const result = scoreStreamCandidate("https://cdn.example.com/master.m3u8?bandwidth=500000000", emptyHeaders, 1, []);
      assert.ok(result.score >= 2000); // 1500 + 100 + 500 (capped)
    });
  });

  describe("Split Audio-Only Sub-Playlists", () => {
    it("classifies /audio/ URL as hls-audio-only", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/audio/stream.m3u8", emptyHeaders, 1, []);
      assert.equal(result.kind, "hls-audio-only");
      assert.ok(result.score >= 100);
    });

    it("classifies audio_only URL as hls-audio-only", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/stream_audio_only.m3u8", emptyHeaders, 1, []);
      assert.equal(result.kind, "hls-audio-only");
    });

    it("classifies mp4a/aac/channels URL as hls-audio-only", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/stream_mp4a.m3u8", emptyHeaders, 1, []);
      assert.equal(result.kind, "hls-audio-only");
    });

    it("classifies TYPE=AUDIO URL as hls-audio-only", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/stream?type=audio", emptyHeaders, 1, []);
      assert.equal(result.kind, "hls-audio-only");
    });
  });

  describe("Video-Only Sub-Playlists (HLS)", () => {
    it("classifies .m3u8 (non-master) as hls-video-only with base +500", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/video_1080p.m3u8", emptyHeaders, 1, []);
      assert.equal(result.kind, "hls-video-only");
      assert.ok(result.score >= 500);
    });

    it("adds resolution weight for 4K", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/video_2160p.m3u8", emptyHeaders, 1, []);
      assert.ok(result.score >= 900); // 500 + 400
    });

    it("adds resolution weight for 1080p", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/video_1080p.m3u8", emptyHeaders, 1, []);
      assert.ok(result.score >= 800); // 500 + 300
    });

    it("adds direct CDN bonus", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/video.m3u8", emptyHeaders, 1, []);
      assert.ok(result.score >= 600); // 500 + 100
    });

    it("auto-pairs with highest-bitrate audio sub-playlist on same tab", () => {
      const allVideos = [
        { url: "https://cdn.example.com/audio_high.m3u8", kind: "hls-audio-only", score: 100 },
        { url: "https://cdn.example.com/audio_low.m3u8", kind: "hls-audio-only", score: 50 },
      ];
      const result = scoreStreamCandidate("https://cdn.example.com/video.m3u8", emptyHeaders, 1, allVideos);
      assert.equal(result.audioUrl, "https://cdn.example.com/audio_high.m3u8");
      assert.ok(result.score >= 700); // 500 + 200 (audio pairing bonus)
    });

    it("does not pair audio if no audio candidates exist", () => {
      const allVideos = [
        { url: "https://cdn.example.com/video2.m3u8", kind: "hls-video-only", score: 500 },
      ];
      const result = scoreStreamCandidate("https://cdn.example.com/video.m3u8", emptyHeaders, 1, allVideos);
      assert.equal(result.audioUrl, null);
    });
  });

  describe("DASH MPD", () => {
    it("scores .mpd as dash with base +1200", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/manifest.mpd", emptyHeaders, 1, []);
      assert.equal(result.kind, "dash");
      assert.ok(result.score >= 1200);
    });

    it("adds resolution weight", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/manifest_1080p.mpd", emptyHeaders, 1, []);
      assert.ok(result.score >= 1500); // 1200 + 300
    });
  });

  describe("Progressive Direct Media", () => {
    it("scores .mp4 as progressive with base +800", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/video.mp4", emptyHeaders, 1, []);
      assert.equal(result.kind, "progressive");
      assert.ok(result.score >= 800);
    });

    it("scores .mkv as progressive", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/video.mkv", emptyHeaders, 1, []);
      assert.equal(result.kind, "progressive");
    });

    it("scores .webm as progressive", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/video.webm", emptyHeaders, 1, []);
      assert.equal(result.kind, "progressive");
    });

    it("adds resolution weight", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/video_1080p.mp4", emptyHeaders, 1, []);
      assert.ok(result.score >= 1100); // 800 + 300
    });
  });

  describe("Junk / Segment rejection", () => {
    it("rejects ad URLs", () => {
      const result = scoreStreamCandidate("https://doubleclick.net/ad.mp4", emptyHeaders, 1, []);
      assert.equal(result.kind, "junk");
      assert.equal(result.score, -Infinity);
    });

    it("rejects pixel/tracking URLs", () => {
      const result = scoreStreamCandidate("https://analytics.example.com/pixel.gif", emptyHeaders, 1, []);
      assert.equal(result.kind, "junk");
      assert.equal(result.score, -Infinity);
    });

    it("rejects googlevideo.com non-m3u8 URLs", () => {
      const result = scoreStreamCandidate("https://googlevideo.com/videoplayback?itag=137", emptyHeaders, 1, []);
      assert.equal(result.kind, "segment");
      assert.equal(result.score, -Infinity);
    });

    it("rejects .ts segment URLs (non-m3u8)", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/segment1.ts", emptyHeaders, 1, []);
      assert.equal(result.kind, "segment");
      assert.equal(result.score, -Infinity);
    });

    it("rejects .m4s chunk URLs", () => {
      const result = scoreStreamCandidate("https://cdn.example.com/chunk.m4s", emptyHeaders, 1, []);
      assert.equal(result.kind, "chunk");
      assert.equal(result.score, -Infinity);
    });
  });

  describe("isYtdlPage helper", () => {
    it("returns true for youtube.com", () => {
      assert.equal(isYtdlPage("https://www.youtube.com/watch?v=abc"), true);
    });

    it("returns true for youtu.be", () => {
      assert.equal(isYtdlPage("https://youtu.be/abc"), true);
    });

    it("returns true for subdomains of yt-dlp hosts", () => {
      assert.equal(isYtdlPage("https://m.youtube.com/watch?v=abc"), true);
      assert.equal(isYtdlPage("https://music.youtube.com/watch?v=abc"), true);
    });

    it("returns false for non-yt-dlp hosts", () => {
      assert.equal(isYtdlPage("https://example.com/video.mp4"), false);
    });
  });
});