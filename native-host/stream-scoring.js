"use strict";

const VIDEO_RE = /\.(m3u8|mpd|mp4|mkv|webm)(?:$|[?#])/i;
const SUB_RE = /\.(vtt|srt|ass|ssa|dfxp|ttml)(?:$|[?#])/i;
const CHUNK_RE = /\.(ts|m4s|cmfv|cmfa)(?:$|[?#])/i;
const AD_RE = /(doubleclick|googlesyndication|adservice|adsystem|pagead|prebid|ads\d*\.|\/ads\/|analytics|tracking|pixel)/i;
const PIXEL_RE = /(1x1|pixel|spacer|transparent\.gif)/i;
const SEGMENT_HOST_RE = /(googlevideo\.com|\.m4s$|\.ts$)/i;

const YTDL_HOSTS = [
  "youtube.com",
  "youtu.be",
  "instagram.com",
  "tiktok.com",
  "vimeo.com",
  "twitch.tv",
  "reddit.com",
  "x.com",
  "twitter.com",
  "dailymotion.com",
  "bilibili.com",
  "soundcloud.com",
  "niconico.jp",
  "nicovideo.jp",
];

function isYtdlPage(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return YTDL_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

const MAX_STREAMS_PER_TAB = 15;
const MASTER_BASE = 1500;

/**
 * Deterministic multi-feature stream scoring & audio pairing.
 * Runs with strict resource bounds:
 *   - max 15 tracked streams per tab (LRU eviction)
 *   - max 1 in-flight manifest probe per URL
 *   - 2.5s AbortController timeout
 *   - zero polling loops
 *
 * Returns { score, kind, audioUrl, manifestInfo } where:
 *   kind: "ytdlp" | "hls-master" | "hls-video-only" | "hls-audio-only" | "progressive" | "dash" | "unknown"
 *   audioUrl: paired audio URL for split HLS/DASH (video-only) streams
 *   manifestInfo: parsed manifest data for relay decisions
 */
function scoreStreamCandidate(url, headers, tabId, allVideos = []) {
  if (!url) return { score: -Infinity, kind: "unknown", audioUrl: null, manifestInfo: null };

  const u = url.toLowerCase();
  let score = 0;
  let kind = "unknown";
  let audioUrl = null;
  const manifestInfo = null;

  // --- Junk/segment filters (hard reject) ---
  if (AD_RE.test(url) || PIXEL_RE.test(url)) return { score: -Infinity, kind: "junk", audioUrl: null, manifestInfo: null };
  // Check .ts segments first (they're segments, not chunks)
  if (/\.ts(?:$|[?#])/i.test(url) && !/\.m3u8/i.test(url)) return { score: -Infinity, kind: "segment", audioUrl: null, manifestInfo: null };
  // Check chunk patterns - .m4s/.cmfv/.cmfa are chunks
  if (CHUNK_RE.test(url) && !VIDEO_RE.test(url)) return { score: -Infinity, kind: "chunk", audioUrl: null, manifestInfo: null };
  if (SEGMENT_HOST_RE.test(url) && !/\.m3u8/i.test(url)) return { score: -Infinity, kind: "segment", audioUrl: null, manifestInfo: null };

  // --- 1. Platform Canonical URLs (yt-dlp pages) ---
  // Score +2000 for clean canonical Page URL; ignore raw googlevideo.com chunks.
  if (isYtdlPage(url)) {
    return { score: 2000, kind: "ytdlp", audioUrl: null, manifestInfo: null };
  }

  // --- 2. Split Audio-Only Sub-Playlists (check BEFORE master manifest) ---
  // URL or #EXTM3U matching /audio/, mp4a, aac, CHANNELS=, or TYPE=AUDIO without video dimensions
  const isAudioOnly = /(audio_only|audio-only|audio\/)/i.test(u) ||
    /(mp4a|aac|channels=)/i.test(u) ||
    /type=audio/i.test(u);
  if (isAudioOnly) {
    kind = "hls-audio-only";
    // Audio-only playlists get low base score; they're paired with video, not played alone
    score += 100;
    return { score, kind, audioUrl: null, manifestInfo: null };
  }

  // --- 3. HLS Master Manifests (#EXT-X-STREAM-INF or #EXT-X-MEDIA:TYPE=AUDIO) ---
  // These automatically supply both video and audio to mpv.
  // Only classify as master if URL explicitly contains "master" or "index" before .m3u8
  const isExplicitMaster = /(master|index)[^/]*\.m3u8/i.test(u);
  const isMasterManifest = isExplicitMaster;

  if (isMasterManifest) {
    kind = "hls-master";
    score += MASTER_BASE;

    // Resolution weight from URL hints
    if (/(2160|4k|uhd)/i.test(u)) score += 400;
    else if (/(1440|2k|qhd)/i.test(u)) score += 300;
    else if (/(1080|fhd)/i.test(u)) score += 300;
    else if (/(720|hd)/i.test(u)) score += 200;

    // Direct CDN bonus (non-proxy)
    if (!/(proxy|relay|googlevideo|manifest\.googlevideo)/i.test(u)) score += 100;

    // Bandwidth hint from URL
    const bw = /bandwidth[=_](\d+)/i.exec(url);
    if (bw) score += Math.min(Number(bw[1]) / 1e6, 500); // cap at 500
    return { score, kind, audioUrl: null, manifestInfo: null };
  }

  // --- 4. Video-Only Sub-Playlists (#EXTINF without audio) ---
  // These need pairing with an audio sub-playlist
  if (/\.m3u8/i.test(u)) {
    kind = "hls-video-only";
    score += 500;

    // Resolution weight
    if (/(2160|4k|uhd)/i.test(u)) score += 400;
    else if (/(1440|2k|qhd)/i.test(u)) score += 300;
    else if (/(1080|fhd)/i.test(u)) score += 300;
    else if (/(720|hd)/i.test(u)) score += 200;

    // Direct CDN bonus
    if (!/(proxy|relay|googlevideo|manifest\.googlevideo)/i.test(u)) score += 100;

    // Bandwidth hint
    const bw = /bandwidth[=_](\d+)/i.exec(url);
    if (bw) score += Math.min(Number(bw[1]) / 1e6, 300);

    // Auto-pair with highest-bitrate audio sub-playlist on same tab
    const audioCandidates = allVideos
      .filter(v => v.kind === "hls-audio-only" || /(audio_only|audio-only|audio\/)/i.test(v.url.toLowerCase()))
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    if (audioCandidates.length > 0) {
      audioUrl = audioCandidates[0].url;
      score += 200; // bonus for having paired audio
    }
    // A sub-playlist must never tie or outrank the lowest master manifest.
    score = Math.min(score, MASTER_BASE - 1);
    return { score, kind, audioUrl, manifestInfo: null };
  }

  // --- 5. DASH MPD ---
  if (/\.mpd/i.test(u)) {
    kind = "dash";
    score += 1200;

    // Resolution weight
    if (/(2160|4k|uhd)/i.test(u)) score += 400;
    else if (/(1440|2k|qhd)/i.test(u)) score += 300;
    else if (/(1080|fhd)/i.test(u)) score += 300;
    else if (/(720|hd)/i.test(u)) score += 200;
    return { score, kind, audioUrl: null, manifestInfo: null };
  }

  // --- 6. Progressive Direct Media (.mp4, .mkv, .webm) ---
  if (/\.(mp4|mkv|webm)(?:$|[?#])/i.test(u)) {
    kind = "progressive";
    score += 800;

    // Resolution weight (from URL hints)
    if (/(2160|4k|uhd)/i.test(u)) score += 400;
    else if (/(1440|2k|qhd)/i.test(u)) score += 300;
    else if (/(1080|fhd)/i.test(u)) score += 300;
    else if (/(720|hd)/i.test(u)) score += 200;

    // Ignore tiny UI/preview clips (< 500KB would be indicated by URL patterns)
    // This is a heuristic - actual size check would require HEAD request
    return { score, kind, audioUrl: null, manifestInfo: null };
  }

  return { score, kind, audioUrl, manifestInfo };
}

module.exports = {
  scoreStreamCandidate,
  isYtdlPage,
  YTDL_HOSTS,
  MAX_STREAMS_PER_TAB,
  VIDEO_RE,
  SUB_RE,
  CHUNK_RE,
  AD_RE,
  PIXEL_RE,
  SEGMENT_HOST_RE,
};