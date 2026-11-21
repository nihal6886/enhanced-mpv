"use strict";

const HOST = "com.enhanced.mpv.host";
const VIDEO_RE = /\.(m3u8|mpd|mp4|mkv|webm)(?:$|[?#])/i;
const AUDIO_RE = /\.(aac|m4a)(?:$|[?#])/i;
const SUB_RE = /\.(vtt|srt|ass|ssa|dfxp|ttml)(?:$|[?#])/i;
const CHUNK_RE = /\.(ts|m4s|cmfv|cmfa)(?:$|[?#])/i;
const AD_RE = /(doubleclick|googlesyndication|adservice|adsystem|pagead|prebid|ads\d*\.|\/ads\/|analytics|tracking|pixel)/i;
const PIXEL_RE = /(1x1|pixel|spacer|transparent\.gif)/i;
const SEGMENT_HOST_RE = /(googlevideo\.com|\.m4s$|\.ts$)/i;
const MASTER_MANIFEST_RE = /master\.m3u8|index\.m3u8/i;
// Audio path segments: /audio/, /audio_ (e.g. audio_1080), /audio-, /audio. plus
// codec/query hints. Checked BEFORE master so ".../audio/.../index.m3u8" is audio.
const AUDIO_PLAYLIST_RE = /(?:^|\/)audio(?:[_\-.]|\/|$)|audio_only|audio-only|mp4a|aac|channels=|type=audio/i;
// Deterministic HLS proxy paths used by hls.shegu.net and similar sites.
const PROXY_VIDEO_RE = /m3u8_proxy\/video\//i;
const PROXY_AUDIO_RE = /m3u8_proxy\/audio(?:\/|$)/i;

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

// Score tiers: canonical yt-dlp pages > verified/candidate HLS master
// playlists > deterministic proxy video sub-playlists > everything else. The
// gaps exceed every per-stream bonus so a tier can never be overtaken.
const SCORE_YTDLP = 9000;
const SCORE_HLS_MASTER = 5000;
const SCORE_PROXY_VIDEO = 2800;

const PAGE_STREAM_LABEL = "Page Stream via yt-dlp (Best Video + Audio + Captions)";

const tabState = new Map();
const manifestResolution = new Map();

const MAX_STREAMS_PER_TAB = 15;
const MANIFEST_PROBE_TIMEOUT_MS = 2500;

function emptyState() {
  return {
    videos: [],
    audioStreams: [],
    subs: [],
    page: { title: "", url: "" },
    cookies: "",
    requestHeaders: new Map(),
    frameResources: new Map(),
    pageResources: [],
  };
}

function getState(tabId) {
  if (!tabState.has(tabId)) tabState.set(tabId, emptyState());
  return tabState.get(tabId);
}

function pageStreamItem(url) {
  if (!isYtdlPage(url)) return null;
  return {
    url,
    type: "ytdlp",
    label: PAGE_STREAM_LABEL,
    score: Number.MAX_SAFE_INTEGER,
    primary: true,
    time: Date.now(),
  };
}

// Audio-only, junk, and segment entries are not selectable video streams.
function isDisplayVideo(v) {
  if (!v) return false;
  if (v.kind === "hls-audio-only" || v.kind === "junk" || v.kind === "segment" || v.kind === "chunk") return false;
  if (isAudioPlaylistUrl(v.url)) return false;
  return true;
}

function viewState(tabId, pageUrl) {
  const state = getState(tabId);
  const item = pageStreamItem(pageUrl || state.page.url);
  const base = item
    ? state.videos.filter((v) => v.url.split("?")[0] !== item.url.split("?")[0])
    : state.videos;
  const videos = base.filter(isDisplayVideo);
  return {
    videos: item ? [item, ...videos] : videos,
    subs: state.subs,
    page: state.page,
  };
}

async function persist(tabId) {
  const state = getState(tabId);
  try {
    await chrome.storage.session.set({ ["tab:" + tabId]: state });
  } catch {
    await chrome.storage.local.set({ ["tab:" + tabId]: state });
  }
  updateBadge(tabId);
}

function parseManifestInfo(text, baseUrl) {
  const lines = text.split("\n");
  let isMaster = false;
  let hasAudio = false;
  let bestBandwidth = 0;
  let bestVariant = null;
  let bestVariantCodecs = "";
  let audioVariantUrl = null;
  let audioBandwidth = 0;
  let audioCodecs = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      isMaster = true;
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      const codecMatch = line.match(/CODECS="([^"]+)"/);
      const codecs = codecMatch ? codecMatch[1] : "";
      const nextLine = lines[i + 1]?.trim();
      if (nextLine && !nextLine.startsWith("#") && bw > bestBandwidth) {
        try {
          bestVariant = new URL(nextLine, baseUrl).toString();
          bestBandwidth = bw;
          bestVariantCodecs = codecs;
        } catch {
          void 0;
        }
      }
    } else if (line.startsWith("#EXT-X-MEDIA:") && line.includes("TYPE=AUDIO")) {
      hasAudio = true;
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
      const codecMatch = line.match(/CODECS="([^"]+)"/);
      const codecs = codecMatch ? codecMatch[1] : "";
      const uriMatch = line.match(/URI="([^"]+)"/);
      if (uriMatch && bw > audioBandwidth) {
        try {
          audioVariantUrl = new URL(uriMatch[1], baseUrl).toString();
          audioBandwidth = bw;
          audioCodecs = codecs;
        } catch {
          void 0;
        }
      }
    }
  }

  return {
    isMaster,
    hasAudio,
    bestBandwidth,
    bestVariant,
    bestVariantCodecs,
    audioVariantUrl,
    audioBandwidth,
    audioCodecs,
  };
}

function isMasterManifestUrl(url) {
  return MASTER_MANIFEST_RE.test(url.toLowerCase());
}

function isAudioPlaylistUrl(url) {
  return AUDIO_PLAYLIST_RE.test(url.toLowerCase());
}

// Root-level ".../<id>.m3u8" (e.g. hls.shegu.net/40097260.m3u8) with no
// /video/ or /audio/ path segment: treat as a candidate master manifest until
// its body proves it is a media playlist.
function isRootManifestCandidate(url) {
  let pathname;
  try { pathname = new URL(url).pathname; } catch { return false; }
  if (!/\.m3u8$/i.test(pathname)) return false;
  if (/\/(?:video|audio)\//i.test(pathname)) return false;
  return pathname.split("/").filter(Boolean).length === 1;
}

const audioProbeDone = new Set();
const audioRecoveryInFlight = new Map();
const HOT_ATTACH_WINDOW_MS = 15000;
// tabId "|" videoUrlKey — one live hot-attach per video-only stream per tab.
const hotAttached = new Set();

// An .m3u8 that is not a known master/audio playlist is treated as video-only.
function isVideoOnlyVideo(v) {
  if (!v || !/\.m3u8(?:$|[?#])/i.test(v.url || "")) return false;
  if (isAudioPlaylistUrl(v.url)) return false;
  const info = v.manifestInfo || {};
  if (info.isMaster) return false;
  if (info.hasAudio) return false;
  return true;
}

// Register a captured audio playlist/segment so it can be paired with video.
function addAudioStream(tabId, url, extra) {
  if (!url || tabId == null || tabId < 0) return;
  const state = getState(tabId);
  if (isJunkVideo(url, extra)) return;
  const headers = (extra && extra.headers) || state.requestHeaders.get(url) || {};
  const frameId = (extra && extra.frameId) || null;
  upsert(state.audioStreams, {
    url,
    type: "audio",
    kind: "hls-audio-only",
    score: 100,
    time: Date.now(),
    headers,
    frameId,
  }, (a) => a.url.split("?")[0]);
  state.audioStreams.sort((a, b) => (b.score || 0) - (a.score || 0));
  // A newly captured audio track (.m3u8 / .aac / .m4a, before, after, or with
  // a different path ID from the video) pairs with every video-only /
  // proxy-video entry on this tab, and hot-attaches to a recently launched one.
  pairAllVideoOnly(tabId);
  maybeHotAttachAudio(tabId);
  persist(tabId);
}

// Query every frame's performance entries for audio playlists that loaded before
// the service worker woke up, then register them for pairing. Returns the set of
// all .m3u8/.aac/.m4a resource URLs seen (with and without query string).
async function harvestFrameAudioResources(tabId) {
  const allUrls = new Set();
  if (tabId == null || tabId < 0) return allUrls;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const out = [];
        try {
          const entries = performance.getEntriesByType("resource");
          for (const e of entries) {
            const name = e && e.name ? e.name : "";
            if (/\.(m3u8|aac|m4a)(?:$|[?#])/i.test(name)) out.push(name);
          }
        } catch {
          // performance unavailable in this frame
        }
        return out;
      },
    });
    for (const r of results) {
      if (!r || r.error) continue;
      for (const name of (r.result || [])) {
        if (!name) continue;
        allUrls.add(name);
        allUrls.add(name.split("?")[0]);
        // Only audio playlists/segments are harvested; video playlists are
        // already captured via webRequest and re-adding them could recurse.
        if (isAudioPlaylistUrl(name) || PROXY_AUDIO_RE.test(name) || /\.(aac|m4a)(?:$|[?#])/i.test(name)) {
          addAudioStream(tabId, name, { frameId: r.frameId });
        }
      }
    }
  } catch {
    // scripting/host permission unavailable
  }
  return allUrls;
}

// Deterministic proxy sibling: .../m3u8_proxy/video/<rest> -> .../m3u8_proxy/audio/<rest>
function siblingAudioUrl(videoUrl) {
  if (!videoUrl || !PROXY_VIDEO_RE.test(videoUrl)) return null;
  const sib = videoUrl.replace(/(\/m3u8_proxy\/)video\//i, "$1audio/");
  return sib === videoUrl ? null : sib;
}

// Popup-open recovery: scan every frame for audio, add the deterministic proxy
// sibling, then pair it with the video.
async function recoverAudioForVideo(tabId, videoUrl, headers) {
  const allUrls = await harvestFrameAudioResources(tabId);
  const sib = siblingAudioUrl(videoUrl);
  if (sib) {
    const clean = sib.split("?")[0];
    const present = allUrls.has(sib) || allUrls.has(clean);
    const hasAudio = (getState(tabId).audioStreams || []).length > 0;
    // Add the sibling when the page referenced it, or when nothing else is captured.
    if (present || !hasAudio) addAudioStream(tabId, sib, { frameId: null, headers });
  }
  rekindleAudioPairing(tabId, videoUrl);
}

// Re-score every video-only / proxy-video entry on the tab so the
// highest-bitrate captured audio is attached to all of them, regardless of
// whether the audio arrived before, after, or with a different path ID.
function pairAllVideoOnly(tabId) {
  if (tabId == null || tabId < 0) return;
  const state = getState(tabId);
  for (const v of state.videos) {
    if ((v.kind === "hls-video-only" || PROXY_VIDEO_RE.test(v.url)) && !v.playUrl) {
      rekindleAudioPairing(tabId, v.url);
    }
  }
}

// Live hot-attach: audio turned up within 15 s of a video-only launch on
// this tab → forward attachAudio to the native host so the running mpv
// window hot-loads the track without restarting playback.
function maybeHotAttachAudio(tabId) {
  if (tabId == null || tabId < 0) return;
  const state = getState(tabId);
  const launched = state.lastLaunch;
  if (!launched || Date.now() - launched.time > HOT_ATTACH_WINDOW_MS) return;
  const video = state.videos.find((v) => {
    const key = v.url.split("?")[0];
    return (
      key === launched.url.split("?")[0] &&
      (v.kind === "hls-video-only" || PROXY_VIDEO_RE.test(v.url)) &&
      !v.audioUrl &&
      !v.playUrl
    );
  });
  if (!video) return;
  const key = tabId + "|" + video.url.split("?")[0];
  if (hotAttached.has(key)) return;
  const bestAudio = (state.audioStreams || [])
    .filter((a) => !PROXY_VIDEO_RE.test(a.url))
    .sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  if (!bestAudio) return;
  hotAttached.add(key);
  nativeSend({
    action: "attachAudio",
    audioUrl: bestAudio.url,
    audioHeaders: bestAudio.headers || {},
    url: video.url,
    tabId,
  });
  rekindleAudioPairing(tabId, video.url);
}

// Re-run scoring for a video-only stream so a newly captured audio track pairs.
function rekindleAudioPairing(tabId, url) {
  if (tabId == null || tabId < 0) return;
  const state = getState(tabId);
  const idx = state.videos.findIndex(v => v.url.split("?")[0] === url.split("?")[0]);
  if (idx < 0) return;
  const v = state.videos[idx];
  if (v.playUrl || v.kind === "hls-master") return;
  const { score, kind, audioUrl } = scoreStreamCandidate(v.url, v.headers, tabId, state.videos, state.audioStreams, v.frameId);
  state.videos[idx] = { ...v, score, kind, audioUrl };
  state.videos.sort((a, b) => b.score - a.score);
  persist(tabId);
}

// Generate candidate parent/master manifest URLs for a video-only sub-playlist.
function parentMasterCandidates(videoUrl) {
  const candidates = new Set();
  try {
    const u = new URL(videoUrl);
    for (const name of ["master.m3u8", "index.m3u8"]) {
      try { candidates.add(new URL("../" + name, u).toString()); } catch { void 0; }
    }
    const parts = u.pathname.split("/").filter(Boolean);
    for (let cut = 1; cut <= 3; cut++) {
      const keep = Math.max(1, parts.length - 1 - cut);
      const basePath = "/" + parts.slice(0, keep).join("/") + "/";
      for (const name of ["index.m3u8", "master.m3u8"]) {
        try { candidates.add(new URL(u.origin + basePath + name).toString()); } catch { void 0; }
      }
    }
  } catch {
    // invalid URL
  }
  candidates.delete(videoUrl);
  return [...candidates];
}

function manifestFetchHeaders(headers) {
  const h = { "User-Agent": (headers && headers.userAgent) || navigator.userAgent };
  if (headers && headers.referer) h.Referer = headers.referer;
  if (headers && headers.origin) h.Origin = headers.origin;
  return h;
}

async function fetchManifestText(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || MANIFEST_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: manifestFetchHeaders(headers),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeMasterManifest(text) {
  if (!text || text.indexOf("#EXTM3U") === -1) return false;
  return /#EXT-X-MEDIA:[^\n]*TYPE=AUDIO/i.test(text) || text.indexOf("#EXT-X-STREAM-INF") !== -1;
}

function promoteToMaster(tabId, videoUrl, masterUrl, text, headers) {
  // Never replace a deterministic proxy video with a probed parent master.
  if (PROXY_VIDEO_RE.test(videoUrl)) return false;
  const state = getState(tabId);
  const idx = state.videos.findIndex(v => v.url.split("?")[0] === videoUrl.split("?")[0]);
  if (idx < 0) return false;
  const manifestInfo = parseManifestInfo(text, masterUrl);
    state.videos[idx] = {
      ...state.videos[idx],
      url: videoUrl,
      playUrl: masterUrl,
      kind: "hls-master",
      verified: true,
      isVerifiedMaster: true,
      relayReady: true,
      manifestInfo,
      audioUrl: null,
      score: Math.max(state.videos[idx].score || 0, SCORE_HLS_MASTER),
    headers: { ...(state.videos[idx].headers || {}), ...(headers || {}) },
  };
  state.videos.sort((a, b) => b.score - a.score);
  persist(tabId);
  return true;
}

async function probeAndPromoteParentMaster(tabId, url, headers) {
  if (tabId == null || tabId < 0) return false;
  const candidates = parentMasterCandidates(url).slice(0, 5);
  if (!candidates.length) return false;
  const probes = candidates.map(async (cand) => {
    const text = await fetchManifestText(cand, headers);
    if (text && looksLikeMasterManifest(text)) return { cand, text };
    return null;
  });
  const settled = await Promise.allSettled(probes);
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) {
      return promoteToMaster(tabId, url, r.value.cand, r.value.text, headers);
    }
  }
  return false;
}

// Recover audio for a video-only sub-playlist: harvest frame resources, then
// probe for a parent master manifest that carries audio. Returns the in-flight
// promise so launch can await a recovery already started by webRequest.
function ensureAudioRecovery(tabId, url, headers, frameId) {
  if (tabId == null || tabId < 0) return Promise.resolve();
  const key = tabId + "|" + url;
  const existing = audioRecoveryInFlight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    try {
      void frameId;
      const state = getState(tabId);
      if ((state.audioStreams || []).length === 0 && !audioProbeDone.has(key)) {
        audioProbeDone.add(key);
        await harvestFrameAudioResources(tabId);
        if ((getState(tabId).audioStreams || []).length === 0) {
          const sib = siblingAudioUrl(url);
          if (sib) {
            // Deterministic proxy path: pair the sibling audio directly.
            addAudioStream(tabId, sib, { frameId: null, headers });
          } else {
            await probeAndPromoteParentMaster(tabId, url, headers);
          }
        }
      }
      rekindleAudioPairing(tabId, url);
    } catch {
      // best effort audio recovery
    } finally {
      audioRecoveryInFlight.delete(key);
    }
  })();
  audioRecoveryInFlight.set(key, promise);
  return promise;
}

/**
 * Deterministic multi-feature stream scoring & audio pairing with strict master-manifest priority.
 * Resource bounds:
 *   - max 15 tracked streams per tab (LRU eviction)
 *   - max 1 in-flight manifest probe per URL
 *   - 2.5s AbortController timeout
 *   - zero polling loops
 */

// Score a video-only .m3u8 and pair the best available audio track.
function scoreVideoOnly(url, u, frameId, allVideos, audioStreams, baseScore) {
  let score = baseScore;

  if (/(2160|4k|uhd)/i.test(u)) score += 400;
  else if (/(1440|2k|qhd)/i.test(u)) score += 300;
  else if (/(1080|fhd)/i.test(u)) score += 300;
  else if (/(720|hd)/i.test(u)) score += 200;

  if (!/(proxy|relay|googlevideo|manifest\.googlevideo)/i.test(u)) score += 100;

  const bw = /bandwidth[=_](\d+)/i.exec(url);
  if (bw) score += Math.min(Number(bw[1]) / 1e6, 300);

  // Pair the best audio: same frameId first, then any audio captured in the tab.
  const audioPool = [
    ...allVideos.filter(v => v.kind === "hls-audio-only" || isAudioPlaylistUrl(v.url)),
    ...audioStreams,
  ];
  const audioCandidates = audioPool
    .filter(v => !(frameId && v.frameId && v.frameId !== frameId))
    .sort((a, b) => (b.score || 0) - (a.score || 0));

  let audioUrl = null;
  if (audioCandidates.length > 0) {
    audioUrl = audioCandidates[0].url;
    score += 300;
  } else {
    score -= 100;
  }
  return { score, kind: "hls-video-only", audioUrl };
}

function scoreStreamCandidate(url, headers, tabId, allVideos = [], audioStreams = [], frameId = null) {
  if (!url) return { score: -Infinity, kind: "unknown", audioUrl: null, manifestInfo: null, frameId: null };

  const u = url.toLowerCase();
  let score = 0;
  let kind = "unknown";
  const audioUrl = null;
  const manifestInfo = null;

  if (AD_RE.test(url) || PIXEL_RE.test(url)) return { score: -Infinity, kind: "junk", audioUrl: null, manifestInfo: null, frameId: null };
  if (SEGMENT_HOST_RE.test(url) && !/\.m3u8/i.test(url)) return { score: -Infinity, kind: "segment", audioUrl: null, manifestInfo: null, frameId: null };
  if (CHUNK_RE.test(url) && !VIDEO_RE.test(url)) return { score: -Infinity, kind: "chunk", audioUrl: null, manifestInfo: null, frameId: null };
  if (/\.ts(?:$|[?#])/i.test(url) && !/\.m3u8/i.test(url)) return { score: -Infinity, kind: "segment", audioUrl: null, manifestInfo: null, frameId: null };

  if (isYtdlPage(url)) {
    return { score: SCORE_YTDLP, kind: "ytdlp", audioUrl: null, manifestInfo: null, frameId: null };
  }

  // Audio-only FIRST (before master): proxy audio ".../m3u8_proxy/audio/.../index.m3u8"
  // must classify as audio, not master, so it lands in audioStreams and pairs.
  if (isAudioPlaylistUrl(u) || PROXY_AUDIO_RE.test(u)) {
    return { score: 100, kind: "hls-audio-only", audioUrl: null, manifestInfo: null, frameId: frameId };
  }

  // Deterministic proxy video (.../m3u8_proxy/video/...): keep it the primary
  // video stream (never replace it with a short stub) and pair the sibling audio.
  if (PROXY_VIDEO_RE.test(u)) {
    const r = scoreVideoOnly(url, u, frameId, allVideos, audioStreams, SCORE_PROXY_VIDEO);
    return { score: r.score, kind: r.kind, audioUrl: r.audioUrl, manifestInfo: null, frameId: frameId };
  }

  // STRICT MASTER-MANIFEST PRIORITY: the master tier base is above the
  // highest possible proxy-video score (base + resolution + CDN + bandwidth +
  // audio pairing), so a sub-playlist never outranks its master.
  if (isMasterManifestUrl(u) || isRootManifestCandidate(url)) {
    kind = "hls-master";
    score += SCORE_HLS_MASTER;

    if (/(2160|4k|uhd)/i.test(u)) score += 400;
    else if (/(1440|2k|qhd)/i.test(u)) score += 300;
    else if (/(1080|fhd)/i.test(u)) score += 300;
    else if (/(720|hd)/i.test(u)) score += 200;

    if (!/(proxy|relay|googlevideo|manifest\.googlevideo)/i.test(u)) score += 100;

    const bw = /bandwidth[=_](\d+)/i.exec(url);
    if (bw) score += Math.min(Number(bw[1]) / 1e6, 500);

    return { score, kind, audioUrl: null, manifestInfo: null, frameId: frameId };
  }

  // Video-Only Sub-Playlists - need pairing
  if (/\.m3u8/i.test(u)) {
    const r = scoreVideoOnly(url, u, frameId, allVideos, audioStreams, 500);
    return { score: r.score, kind: r.kind, audioUrl: r.audioUrl, manifestInfo: null, frameId: frameId };
  }

  // DASH MPD
  if (/\.mpd/i.test(u)) {
    kind = "dash";
    score += 1200;

    if (/(2160|4k|uhd)/i.test(u)) score += 400;
    else if (/(1440|2k|qhd)/i.test(u)) score += 300;
    else if (/(1080|fhd)/i.test(u)) score += 300;
    else if (/(720|hd)/i.test(u)) score += 200;
    return { score, kind, audioUrl: null, manifestInfo: null, frameId: null };
  }

  // Progressive Direct Media
  if (/\.(mp4|mkv|webm)(?:$|[?#])/i.test(u)) {
    kind = "progressive";
    score += 800;

    if (/(2160|4k|uhd)/i.test(u)) score += 400;
    else if (/(1440|2k|qhd)/i.test(u)) score += 300;
    else if (/(1080|fhd)/i.test(u)) score += 300;
    else if (/(720|hd)/i.test(u)) score += 200;
    return { score, kind, audioUrl: null, manifestInfo: null, frameId: null };
  }

  return { score, kind, audioUrl, manifestInfo, frameId };
}

function isJunkVideo(url, details) {
  if (!url) return true;
  if (AD_RE.test(url) || PIXEL_RE.test(url)) return true;
  if (SEGMENT_HOST_RE.test(url) && !/\.m3u8/i.test(url)) return true;
  if (CHUNK_RE.test(url) && !VIDEO_RE.test(url)) return true;
  if (/\.ts(?:$|[?#])/i.test(url) && !/\.m3u8/i.test(url)) return true;
  if (details && details.type === "image") return true;
  if (details && details.type === "ping") return true;
  return false;
}

function upsert(list, item, keyFn) {
  const key = keyFn(item);
  const idx = list.findIndex((x) => keyFn(x) === key);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...item };
    return;
  }
  if (list.length >= MAX_STREAMS_PER_TAB) {
    list.shift();
  }
  list.push(item);
}

function addVideo(tabId, url, extra) {
  if (!VIDEO_RE.test(url) && !/\.m3u8|\.mpd/i.test(url)) return;
  if (isJunkVideo(url, extra)) return;
  const state = getState(tabId);
  const requestHeaders = state.requestHeaders.get(url) || {};
  const headers = { ...requestHeaders, ...(extra?.headers || {}) };
  const frameId = extra?.frameId || null;

  const { score, kind, audioUrl } = scoreStreamCandidate(url, headers, tabId, state.videos, state.audioStreams, frameId);

  // Audio-only playlists live in audioStreams, never in the video list, so the
  // badge/popup show only real video streams and audio pairs cleanly.
  if (kind === "hls-audio-only") {
    upsert(state.audioStreams, {
      url,
      type: "audio",
      kind,
      score,
      time: Date.now(),
      headers,
      frameId,
    }, (a) => a.url.split("?")[0]);
    state.audioStreams.sort((a, b) => b.score - a.score);
    // A newly captured audio track may complete any previously video-only /
    // proxy-video stream on this tab.
    for (const v of state.videos) {
      if ((v.kind === "hls-video-only" || PROXY_VIDEO_RE.test(v.url)) && !v.audioUrl && !v.playUrl) {
        rekindleAudioPairing(tabId, v.url);
      }
    }
    maybeHotAttachAudio(tabId);
    persist(tabId);
    return;
  }

  const videoItem = {
    url,
    type: (url.match(VIDEO_RE) || [, "stream"])[1].toLowerCase(),
    kind,
    score,
    audioUrl,
    time: Date.now(),
    headers,
    frameId,
  };
  // Persist playback position reported by content.js so resume works even when
  // the popup cannot inject (e.g. context-menu launches).
  if (extra && Number.isFinite(Number(extra.currentTime))) videoItem.currentTime = Number(extra.currentTime);
  if (extra && Number.isFinite(Number(extra.duration))) videoItem.duration = Number(extra.duration);
  upsert(state.videos, videoItem, (v) => v.url.split("?")[0]);
  state.videos.sort((a, b) => b.score - a.score);

  persist(tabId);

  // A video-only sub-playlist with no audio yet: recover audio from frames or a
  // parent master manifest so mpv receives both video and audio.
  if (kind === "hls-video-only" && !audioUrl) {
    void ensureAudioRecovery(tabId, url, headers, frameId);
  }
}

function demoteRootManifestCandidate(tabId, url) {
  if (!isRootManifestCandidate(url) || isMasterManifestUrl(url)) return false;
  const state = getState(tabId);
  const idx = state.videos.findIndex(v => v.url.split("?")[0] === url.split("?")[0]);
  if (idx < 0) return false;
  const v = state.videos[idx];
  if (v.kind !== "hls-master" || v.playUrl) return false;
  const r = scoreVideoOnly(v.url, v.url.toLowerCase(), v.frameId, state.videos, state.audioStreams, 500);
  state.videos[idx] = { ...v, kind: r.kind, score: r.score, audioUrl: r.audioUrl, isVerifiedMaster: false };
  state.videos.sort((a, b) => b.score - a.score);
  persist(tabId);
  return true;
}

async function resolveAndVerifyM3U8(tabId, url, headers) {
  const key = tabId + "|" + url;
  if (manifestResolution.has(key)) {
    return manifestResolution.get(key);
  }

  const promise = (async () => {
    const targetHeaders = { ...headers };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MANIFEST_PROBE_TIMEOUT_MS);

      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          "Referer": headers.referer || "",
          "Origin": headers.origin || "",
          "User-Agent": headers.userAgent || navigator.userAgent,
          "Cookie": headers.cookie || "",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Manifest fetch failed: ${response.status}`);
      }

      const text = await response.text();
      const manifestInfo = parseManifestInfo(text, url);
      const isMaster = manifestInfo.isMaster;
      const bestVariant = manifestInfo.bestVariant;
      const lines = text.split("\n");

      const targetUrl = isMaster && bestVariant ? bestVariant : url;

      if (isMaster && bestVariant) {
        const varResponse = await fetch(bestVariant, {
          method: "GET",
          credentials: "include",
          headers: {
            "Referer": headers.referer || "",
            "Origin": headers.origin || "",
            "User-Agent": headers.userAgent || navigator.userAgent,
            "Cookie": headers.cookie || "",
          },
          signal: AbortSignal.timeout(MANIFEST_PROBE_TIMEOUT_MS),
        });
        if (!varResponse.ok) {
          throw new Error(`Variant fetch failed: ${varResponse.status}`);
        }
        const varText = await varResponse.text();
        const varLines = varText.split("\n");

        for (let i = 0; i < varLines.length; i++) {
          const line = varLines[i].trim();
          if (line.startsWith("#EXTINF:")) {
            const nextLine = varLines[i + 1]?.trim();
            if (nextLine && !nextLine.startsWith("#")) {
              try {
                const segmentUrl = new URL(nextLine, bestVariant).toString();
                const headResponse = await fetch(segmentUrl, {
                  method: "HEAD",
                  credentials: "include",
                  headers: {
                    "Referer": headers.referer || "",
                    "Origin": headers.origin || "",
                    "User-Agent": headers.userAgent || navigator.userAgent,
                    "Cookie": headers.cookie || "",
                  },
                  signal: AbortSignal.timeout(MANIFEST_PROBE_TIMEOUT_MS),
                });
                if (headResponse.ok || headResponse.status === 206) {
                  return { url: targetUrl, verified: true, headers: targetHeaders, manifestInfo };
                }
} catch {
                  void 0;
                }
            }
          }
        }
        return { url: targetUrl, verified: false, headers: targetHeaders, manifestInfo };
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("#EXTINF:")) {
          const nextLine = lines[i + 1]?.trim();
          if (nextLine && !nextLine.startsWith("#")) {
            try {
              const segmentUrl = new URL(nextLine, url).toString();
              const headResponse = await fetch(segmentUrl, {
                method: "HEAD",
                credentials: "include",
                headers: {
                  "Referer": headers.referer || "",
                  "Origin": headers.origin || "",
                  "User-Agent": headers.userAgent || navigator.userAgent,
                  "Cookie": headers.cookie || "",
                },
                signal: AbortSignal.timeout(MANIFEST_PROBE_TIMEOUT_MS),
              });
              if (headResponse.ok || headResponse.status === 206) {
                return { url, verified: true, headers: targetHeaders, manifestInfo };
              }
            } catch {
              void 0;
            }
          }
        }
      }

      return { url, verified: false, headers: targetHeaders, manifestInfo };
    } catch (err) {
      return { url, verified: false, headers: targetHeaders, error: String(err), manifestInfo: null };
    }
  })();

  manifestResolution.set(key, promise);
  try {
    return await promise;
  } finally {
    manifestResolution.delete(key);
  }
}

function guessLang(url, headers) {
  try {
    const u = new URL(url);
    const q = u.searchParams.get("lang") || u.searchParams.get("language") || u.searchParams.get("hl");
    if (q) return q;
    const path = /(?:[/._-])([a-z]{2}(?:-[A-Z]{2})?)(?:[/._-]|\.vtt|\.srt|\.ass)/.exec(u.pathname);
    if (path) return path[1];
  } catch {
    void 0;
  }
  if (headers) {
    const c = headers["content-language"] || headers["Content-Language"];
    if (c) return c;
  }
  return "und";
}

function addSub(tabId, url, extra) {
  if (!SUB_RE.test(url) && !/ttml|dfxp/i.test(url)) return;
  if (AD_RE.test(url)) return;
  const state = getState(tabId);
  upsert(state.subs, {
    url,
    language: extra && extra.language ? extra.language : guessLang(url, extra && extra.headers),
    label: (extra && extra.label) || "",
    kind: ((url.match(SUB_RE) || [, "vtt"])[1] || "vtt").toLowerCase(),
  }, (s) => s.url.split("?")[0]);
  persist(tabId);
}

function updateBadge(tabId) {
  const state = getState(tabId);
  const n = state.videos.filter(isDisplayVideo).length + state.subs.length;
  const text = n > 0 ? String(n) : "";
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#1faa59" });
  chrome.action.setBadgeTextColor && chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" });
  chrome.action.setBadgeText({ tabId, text });
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;
    if (VIDEO_RE.test(url)) addVideo(details.tabId, url, details);
    if (AUDIO_RE.test(url)) addAudioStream(details.tabId, url, details);
    if (SUB_RE.test(url)) addSub(details.tabId, url, details);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const state = getState(details.tabId);
    const cookieHeader = details.requestHeaders?.find((h) => h.name.toLowerCase() === "cookie");
    const refererHeader = details.requestHeaders?.find((h) => h.name.toLowerCase() === "referer");
    const originHeader = details.requestHeaders?.find((h) => h.name.toLowerCase() === "origin");
    const uaHeader = details.requestHeaders?.find((h) => h.name.toLowerCase() === "user-agent");
    if (cookieHeader) {
      state.cookies = cookieHeader.value;
      persist(details.tabId);
    }
    const requestHeaders = {};
    if (refererHeader) requestHeaders.referer = refererHeader.value;
    else if (details.initiator) requestHeaders.referer = details.initiator;
    else if (details.documentUrl) requestHeaders.referer = details.documentUrl;
    if (originHeader) requestHeaders.origin = originHeader.value;
    if (uaHeader) requestHeaders.userAgent = uaHeader.value;
    if (cookieHeader) requestHeaders.cookie = cookieHeader.value;
    if (Object.keys(requestHeaders).length > 0) {
      state.requestHeaders.set(details.url, requestHeaders);
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const headers = {};
    for (const h of details.responseHeaders || []) {
      if (h.name && h.value) headers[h.name.toLowerCase()] = h.value;
    }
    const ct = headers["content-type"] || "";
    const url = details.url;
    if (/mpegurl|dash\+xml|application\/vnd\.apple\.mpegurl/i.test(ct) || VIDEO_RE.test(url)) {
      addVideo(details.tabId, url, details);
      if (/\.m3u8/i.test(url) && details.tabId > 0) {
        const state = getState(details.tabId);
        const requestHeaders = state.requestHeaders.get(url) || {};
        const pageUrl = state.page.url || url;
        const origin = requestHeaders.origin || (() => { try { return new URL(pageUrl).origin; } catch { return ""; } })();
        resolveAndVerifyM3U8(details.tabId, url, {
          referer: requestHeaders.referer || pageUrl,
          origin,
          userAgent: requestHeaders.userAgent || navigator.userAgent,
          cookie: requestHeaders.cookie || state.cookies,
        }).then((result) => {
          if (result && result.verified) {
            const videoIdx = state.videos.findIndex(v => v.url.split("?")[0] === url.split("?")[0]);
            if (videoIdx >= 0) {
              const isMaster = !!(result.manifestInfo && result.manifestInfo.isMaster);
              state.videos[videoIdx] = {
                ...state.videos[videoIdx],
                // Keep the master URL as the entry (mpv picks variants itself).
                url: isMaster ? state.videos[videoIdx].url : result.url,
                ...(isMaster ? {
                  kind: "hls-master",
                  isVerifiedMaster: true,
                  audioUrl: null,
                  score: Math.max(state.videos[videoIdx].score || 0, SCORE_HLS_MASTER),
                } : {}),
                verified: true,
                relayReady: true,
                manifestInfo: result.manifestInfo,
                headers: { ...state.videos[videoIdx].headers, ...result.headers },
              };
              state.videos.sort((a, b) => b.score - a.score);
              persist(details.tabId);
            }
          }
          const info = result && result.manifestInfo;
          // A root-level candidate master whose body is a media playlist (no
          // #EXT-X-STREAM-INF) is demoted back to a video-only sub-playlist.
          if (info && !info.isMaster) demoteRootManifestCandidate(details.tabId, url);
          // Content-detected video-only sub-playlist: no audio track in the
          // manifest itself, so recover audio from frames or a parent master.
          if (info && !info.isMaster && !info.hasAudio) {
            const entry = state.videos.find(v => v.url.split("?")[0] === url.split("?")[0]);
            if ((state.audioStreams || []).length === 0) {
              void ensureAudioRecovery(details.tabId, url, (entry && entry.headers) || {}, entry && entry.frameId);
            } else if (entry && !entry.audioUrl) {
              rekindleAudioPairing(details.tabId, url);
            }
          }
        }).catch(() => {
        });
      }
    }
    if (/text\/vtt|application\/ttml|subtitle/i.test(ct) || SUB_RE.test(url)) {
      addSub(details.tabId, url, { headers });
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : msg.tabId;
  (async () => {
    if (msg.type === "tracks") {
      const state = getState(tabId);
      if (msg.page) {
        state.page = {
          title: msg.page.title || state.page.title,
          url: msg.page.url || state.page.url,
        };
      }
      for (const t of msg.tracks || []) {
        addSub(tabId, t.src, { language: t.srclang, label: t.label });
      }
      for (const v of msg.videos || []) {
        if (v.src) addVideo(tabId, v.src, { type: "media", frameId: v.frameId, currentTime: v.currentTime, duration: v.duration });
      }
      // Handle pageResources from content.js performance scraper
      if (msg.pageResources && Array.isArray(msg.pageResources)) {
        state.pageResources = msg.pageResources;
        for (const res of msg.pageResources) {
          if (res.type === "manifest") {
            addVideo(tabId, res.url, { type: "performance", frameId: null });
          } else if (res.type === "subtitle") {
            addSub(tabId, res.url, {});
          }
        }
      }
      // Handle frame resources from content.js
      if (msg.frames && Array.isArray(msg.frames)) {
        for (const frame of msg.frames) {
          const frameId = frame.frameId;
          if (frame.resources && Array.isArray(frame.resources)) {
            state.frameResources.set(frameId, frame.resources);
            for (const res of frame.resources) {
              if (res.type === "manifest") {
                addVideo(tabId, res.url, { type: "frame-performance", frameId });
              } else if (res.type === "subtitle") {
                addSub(tabId, res.url, {});
              }
            }
          }
          if (frame.videos && Array.isArray(frame.videos)) {
            for (const v of frame.videos) {
              if (v.src) addVideo(tabId, v.src, { type: "frame-video", frameId, currentTime: v.currentTime, duration: v.duration });
            }
          }
          if (frame.tracks && Array.isArray(frame.tracks)) {
            for (const t of frame.tracks) {
              addSub(tabId, t.src, { language: t.srclang, label: t.label });
            }
          }
        }
      }
      persist(tabId);
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "getState") {
      const id = msg.tabId || tabId;
      let pageUrl = getState(id).page.url;
      try {
        const t = await chrome.tabs.get(id);
        if (t && t.url) pageUrl = t.url;
      } catch {
        void 0;
      }
      sendResponse(viewState(id, pageUrl));
      return;
    }
    if (msg.type === "scanAudio") {
      // Popup opened: scan every frame for audio and pair the proxy sibling.
      const id = (msg && msg.tabId != null) ? msg.tabId : tabId;
      const state = getState(id);
      const video = state.videos.find(v => PROXY_VIDEO_RE.test(v.url) && isDisplayVideo(v))
        || state.videos.find(isDisplayVideo);
      if (video) {
        await recoverAudioForVideo(id, video.url, video.headers || {});
      } else {
        await harvestFrameAudioResources(id);
      }
      const pageUrl = (msg && msg.pageUrl) || state.page.url;
      sendResponse(viewState(id, pageUrl));
      return;
    }
    if (msg.type === "launch") {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      const out = await launch(tab, msg.url, msg.action || "play", msg);
      sendResponse(out);
      return;
    }
    if (msg.type === "native") {
      sendResponse(await nativeSend(msg.payload || { action: "getConfig" }));
      return;
    }
    if (msg.type === "linkExtension") {
      sendResponse(await registerId());
      return;
    }
    if (msg.type === "pauseAndHandoff") {
      const tabs = sender.tab ? [sender.tab] : await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      const out = await launch(tab, msg.url, "play", msg);
      sendResponse(out);
      return;
    }
    if (msg.type === "copyCommand") {
      const last = (await chrome.storage.local.get("lastLaunch")).lastLaunch;
      sendResponse(last || null);
      return;
    }
  })();
  return true;
});

// Resume only from a real mid-playback position: > 3 s in, a finite duration
// over 15 s, and at least 10 s before the end. Returns whole seconds or 0.
function resumeStartTime(startTime, duration) {
  const s = Number(startTime);
  const d = Number(duration);
  if (!Number.isFinite(s) || !Number.isFinite(d)) return 0;
  if (s > 3 && d > 15 && s < d - 10) return Math.floor(s);
  return 0;
}

function pickUrl(info, tab) {
  return (info && (info.srcUrl || info.linkUrl || info.selectionText))
    || (tab && tab.url)
    || "";
}

async function buildPayload(tab, url, extra) {
  const state = tab ? getState(tab.id) : emptyState();
  const pageUrl = (tab && tab.url) || url;
  let cookies = state.cookies || "";
  if (!cookies) {
    try {
      const list = await chrome.cookies.getAll({ url: pageUrl });
      cookies = list.map((c) => c.name + "=" + c.value).join("; ");
    } catch {
      cookies = "";
    }
  }
  const selected = url || (state.videos[0] && state.videos[0].url) || pageUrl;
  const cfg = (await chrome.storage.sync.get("extension")).extension || {};
  let selectedVideo = state.videos.find(v => v.url.split("?")[0] === selected.split("?")[0]);

  // Launching a video-only sub-playlist with no audio yet: recover audio from
  // frame performance entries or a parent master manifest before handing off.
  if (selectedVideo && isVideoOnlyVideo(selectedVideo) && !selectedVideo.audioUrl) {
    const tabId = tab ? tab.id : -1;
    await ensureAudioRecovery(tabId, selectedVideo.url, selectedVideo.headers || {}, selectedVideo.frameId);
    selectedVideo = state.videos.find(v => v.url.split("?")[0] === selected.split("?")[0]);
  }

  const requestHeaders = selectedVideo?.headers || {};
  const headers = { ...requestHeaders };
  // The popup recovers playback position from every frame (iframe / Shadow
  // DOM players) and passes it through; otherwise fall back to the position
  // content.js last reported for this stream.
  const hasExtraStart = extra && extra.startTime != null && Number.isFinite(Number(extra.startTime));
  const rawStart = hasExtraStart ? Number(extra.startTime) : Number(selectedVideo?.currentTime);
  const rawDuration = hasExtraStart ? Number(extra.duration) : Number(selectedVideo?.duration);
  const startTime = resumeStartTime(rawStart, rawDuration);
  const duration = Number.isFinite(rawDuration) ? rawDuration : 0;
  
  // Include manifestInfo for verified master manifests
  const manifestInfo = selectedVideo?.manifestInfo || null;
  const isVerifiedMaster = selectedVideo?.verified === true && selectedVideo?.kind === "hls-master";
  const masterHasAudio = manifestInfo?.hasAudio === true;
  
  // Use the promoted master URL when the sub-playlist was upgraded to a master.
  const playUrl = selectedVideo?.playUrl || selected;

  // Determine audioUrl: use paired audio from selectedVideo, or find best available audio
  // if not a verified master manifest with audio track
  let audioUrl = selectedVideo?.audioUrl || null;
  let audioHeaders = null;
  
  // Only a split video-only HLS sub-playlist needs an external audio track.
  // Masters (muxed or with #EXT-X-MEDIA audio), yt-dlp pages, DASH, and
  // progressive files already carry audio and must never get a stray track.
  const needsSeparateAudio = Boolean(selectedVideo) &&
    selectedVideo.kind !== "hls-master" && !(isVerifiedMaster && masterHasAudio) &&
    (selectedVideo.kind === "hls-video-only" || isVideoOnlyVideo(selectedVideo));
  if (!needsSeparateAudio) {
    audioUrl = null;
  } else if (!audioUrl) {
    // Prefer audioStreams (explicitly captured audio playlists), then fallback to hls-audio-only from videos
    const audioPool = [
      ...(state.audioStreams || []),
      ...(state.videos || []).filter(v => v.kind === "hls-audio-only" || isAudioPlaylistUrl(v.url))
    ].sort((a, b) => (b.score || 0) - (a.score || 0));
    
    if (audioPool.length > 0) {
      const bestAudio = audioPool[0];
      audioUrl = bestAudio.url;
      if (bestAudio.headers) {
        audioHeaders = { ...bestAudio.headers };
      }
    }
  } else if (audioUrl) {
    const audioVideo = state.videos.find(v => v.url.split("?")[0] === audioUrl.split("?")[0])
      || (state.audioStreams || []).find(v => v.url.split("?")[0] === audioUrl.split("?")[0]);
    if (audioVideo?.headers) {
      audioHeaders = { ...audioVideo.headers };
    }
  }

  return {
    action: extra && extra.action ? extra.action : "play",
    url: playUrl,
    title: (tab && tab.title) || state.page.title || "",
    referer: requestHeaders.referer || pageUrl,
    userAgent: requestHeaders.userAgent || (extra && extra.userAgent) || navigator.userAgent,
    cookies: requestHeaders.cookie || cookies,
    headers,
    subtitles: state.subs,
    quality: cfg.videoQuality || "best",
    profile: cfg.profile || "",
    startTime,
    duration,
    startTimeSource: (extra && extra.startTimeSource) || "",
    audioUrl,
    audioHeaders,
    manifestInfo,
    isVerifiedMaster,
  };
}

function nativeSend(payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(HOST, payload, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            error: chrome.runtime.lastError.message,
            code: "HOST_ERROR",
            command: [],
          });
          return;
        }
        resolve(response || { ok: false, error: "empty host response", code: "HOST_ERROR", command: [] });
      });
    } catch (err) {
      resolve({ ok: false, error: String(err.message || err), code: "HOST_ERROR", command: [] });
    }
  });
}

async function registerId() {
  const res = await nativeSend({ action: "register_id", extensionId: chrome.runtime.id });
  try {
    await chrome.storage.local.set({ linkStatus: { ...res, id: chrome.runtime.id, at: Date.now() } });
  } catch {
    void 0;
  }
  return res;
}

function redactPayload(payload) {
  const rest = { ...payload };
  const headerNames = Object.keys(payload.headers || {});
  delete rest.cookies;
  delete rest.headers;
  return { ...rest, cookies: "", headers: {}, headerNames };
}

async function launch(tab, url, action, extra) {
  const payload = await buildPayload(tab, url, {
    action,
    startTime: extra && extra.startTime,
    duration: extra && extra.duration,
    startTimeSource: extra && extra.startTimeSource,
    userAgent: extra && extra.userAgent,
  });
  const state = tab ? getState(tab.id) : null;
  if (state) state.lastLaunch = { time: Date.now(), url: payload.url };
  const result = await nativeSend(payload);
  await chrome.storage.local.set({ lastLaunch: { payload: redactPayload(payload), result, at: Date.now() } });
  if (!result.ok) {
    const msg = result.error || "Playback failed";
    try {
      await chrome.notifications.create("empv-fail", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Enhanced MPV",
        message: msg + (result.code === "DRM" ? " (DRM-protected or token expired)" : ""),
      });
    } catch {
      void 0;
    }
  }
  return { payload, result };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = pickUrl(info, tab);
  const action = info.menuItemId === "queue" ? "queue" : "play";
  await launch(tab, url, action);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  manifestResolution.forEach((_, key) => {
    if (key.startsWith(tabId + "|")) manifestResolution.delete(key);
  });
  audioProbeDone.forEach((key) => {
    if (key.startsWith(tabId + "|")) audioProbeDone.delete(key);
  });
  audioRecoveryInFlight.forEach((_, key) => {
    if (key.startsWith(tabId + "|")) audioRecoveryInFlight.delete(key);
  });
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading" && change.url) {
    tabState.set(tabId, emptyState());
    persist(tabId);
  }
  if (change.title) {
    const s = getState(tabId);
    s.page.title = change.title;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "play-now",
      title: "Play Now in Enhanced MPV",
      contexts: ["link", "video", "audio", "page", "selection"],
    });
    chrome.contextMenus.create({
      id: "queue",
      title: "Queue in MPV",
      contexts: ["link", "video", "audio", "page", "selection"],
    });
    chrome.contextMenus.create({
      id: "play-link",
      title: "Play Link in Enhanced MPV",
      contexts: ["link", "video", "audio"],
    });
  });
  registerId();
});

chrome.storage.sync.get("extension", (data) => {
  void data;
});