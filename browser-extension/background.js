"use strict";

const HOST = "com.enhanced.mpv.host";
const DAEMON_ENDPOINT_KEY = "empv_daemon_endpoint";
const DAEMON_TIMEOUT_MS = 1200;
const VIDEO_RE = /\.(m3u8|mpd|mp4|mkv|webm)(?:$|[?#])/i;
const AUDIO_RE = /\.(aac|m4a)(?:$|[?#])/i;
const SUB_RE = /\.(vtt|srt|ass|ssa|dfxp|ttml)(?:$|[?#])/i;
const CHUNK_RE = /\.(ts|m4s|cmfv|cmfa)(?:$|[?#])/i;
const AD_RE = /(doubleclick|googlesyndication|adservice|adsystem|pagead|prebid|ads\d*\.|\/ads\/|analytics|tracking|pixel)/i;
const PIXEL_RE = /(1x1|pixel|spacer|transparent\.gif)/i;
const SEGMENT_HOST_RE = /(googlevideo\.com|\.m4s$|\.ts$)/i;
const AUDIO_PLAYLIST_RE = /(?:^|\/)audio(?:[_\-.]|\/|$)|audio_only|audio-only|mp4a|aac|channels=|type=audio/i;
const PROXY_VIDEO_RE = /m3u8_proxy\/video\//i;
const PROXY_AUDIO_RE = /m3u8_proxy\/audio(?:\/|$)/i;
const PROXY_PATTERNS = [/\/proxy\//i, /m3u8_proxy/i, /cors-anywhere/i, /\.proxy\./i, /\/proxy\./i];

// Simple UUID generator that works in both browser and Node.js test environments
function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: RFC4122 v4 UUID using Math.random
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Polyfill for chrome.alarms (Node.js test environment compatibility)
if (typeof chrome === "undefined") {
  globalThis.chrome = { alarms: {}, runtime: {}, storage: { local: {}, session: {}, sync: {} }, tabs: {}, scripting: {}, cookies: {}, webRequest: {}, contextMenus: {}, action: {}, notifications: {} };
}
if (typeof chrome.alarms === "undefined") {
  chrome.alarms = {
    create: (_name, _opts) => {},
    clear: (_name) => {},
    onAlarm: { addListener: (_fn) => {} }
  };
}

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

const SCORE_YTDLP = 11000;
const SCORE_MUXED_MASTER = 7000;
const SCORE_HLS_MASTER = 5000;
const SCORE_DASH_MPD = 1200;
const SCORE_PROGRESSIVE = 800;
const LIVE_SIGNAL_SCORE = 4000;
const PROXY_PENALTY = -2000;

const PAGE_STREAM_LABEL = "Page Stream via yt-dlp (Best Video + Audio + Captions)";

const tabState = new Map();
const manifestResolution = new Map();
const preResolveInFlight = new Map();
const liveTraffic = new Map();
const liveBoostTimers = new Map();
const chunkManifestMap = new Map();

const MAX_STREAMS_PER_TAB = 15;
const MANIFEST_PROBE_TIMEOUT_MS = 2500;
const LIVE_TRAFFIC_TTL_MS = 15000;

function liveTrafficKey(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname.replace(/\/[^/]*$/, "");
  } catch {
    return "";
  }
}

function manifestPrefixKey(url) {
  try {
    const u = new URL(url);
    const base = u.pathname.replace(/\/[^/]*$/, "");
    return u.host + base;
  } catch {
    return "";
  }
}

function notifyLiveSegment(tabId, url) {
  if (tabId == null || tabId < 0) return;
  const key = liveTrafficKey(url);
  if (!key) return;
  let map = liveTraffic.get(tabId);
  if (!map) {
    map = new Map();
    liveTraffic.set(tabId, map);
  }
  const now = Date.now();
  map.set(key, now);
  for (const [k, ts] of map) {
    if (now - ts > LIVE_TRAFFIC_TTL_MS) map.delete(k);
  }
  const mKey = manifestPrefixKey(url);
  if (mKey) {
    const cm = chunkManifestMap.get(tabId);
    if (!cm) {
      chunkManifestMap.set(tabId, new Map());
    }
    chunkManifestMap.get(tabId).set(key, { manifestKey: mKey, time: now });
  }
  if (!liveBoostTimers.has(tabId)) {
    liveBoostTimers.set(tabId, setTimeout(() => {
      liveBoostTimers.delete(tabId);
      boostLiveScores(tabId);
    }, 100));
  }
}

function boostLiveScores(tabId) {
  const state = tabState.get(tabId);
  if (!state) return;
  let changed = false;
  for (const video of state.videos) {
    if (!video.liveBoosted && hasLiveTraffic(tabId, video.url)) {
      video.liveBoosted = true;
      video.score = (video.score || 0) + LIVE_SIGNAL_SCORE;
      changed = true;
    }
  }
  if (changed) {
    state.videos.sort((a, b) => b.score - a.score);
    persist(tabId);
  }
}

function hasLiveTraffic(tabId, url) {
  if (tabId == null || tabId < 0) return false;
  const map = liveTraffic.get(tabId);
  if (!map || !map.size) return false;
  const key = liveTrafficKey(url);
  if (!key) return false;
  const now = Date.now();
  let pathStem = "";
  try {
    const u = new URL(url);
    pathStem = u.host + u.pathname.replace(/\.m3u8?$/i, "");
  } catch {
    void 0;
  }
  for (const [liveKey, ts] of map) {
    if (now - ts > LIVE_TRAFFIC_TTL_MS) continue;
    if (liveKey === key) return true;
    if (pathStem && (liveKey.startsWith(pathStem + "/") || liveKey === pathStem)) return true;
    const originLen = liveKey.indexOf("/");
    if (originLen > 0 && liveKey.startsWith(key + "/")) return true;
  }
  return false;
}

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

let lastWarmRequest = 0;
let warmInFlight = null;

function scheduleWarmLaunch() {
  const now = Date.now();
  if (warmInFlight || now - lastWarmRequest < 60000) return;
  lastWarmRequest = now;
  warmInFlight = prewarmNative()
    .catch(() => null)
    .finally(() => { warmInFlight = null; });
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

function parseM3U8Attributes(value) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = re.exec(String(value || "")))) {
    attrs[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return attrs;
}

function parseManifestInfo(text, baseUrl) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  let isMaster = false;
  let hasAudio = false;
  let isMuxed = false;
  let bestBandwidth = 0;
  let bestVariant = null;
  let bestVariantCodecs = "";
  let bestWidth = 0;
  let bestHeight = 0;
  let audioVariantUrl = null;
  let audioBandwidth = 0;
  let audioCodecs = "";
  let pendingAttrs = null;
  const variants = [];
  const renditions = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      isMaster = true;
      pendingAttrs = parseM3U8Attributes(line.slice("#EXT-X-STREAM-INF:".length));
      const audioAttr = pendingAttrs.AUDIO;
      if (audioAttr) {
        isMuxed = true;
      }
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseM3U8Attributes(line.slice("#EXT-X-MEDIA:".length));
      if (String(attrs.TYPE).toUpperCase() === "AUDIO") {
        hasAudio = true;
        const bw = parseInt(attrs.BANDWIDTH || "0", 10) || 0;
        if (attrs.URI) {
          try {
            const url = new URL(attrs.URI, baseUrl).toString();
            renditions.push({
              url,
              name: attrs.NAME || "Default",
              language: attrs.LANGUAGE || "",
              default: attrs.DEFAULT === "YES",
              bandwidth: bw,
              codecs: attrs.CODECS || "",
            });
            if (bw >= audioBandwidth) {
              audioVariantUrl = url;
              audioBandwidth = bw;
              audioCodecs = attrs.CODECS || "";
            }
          } catch {
            void 0;
          }
        }
      }
    } else if (line && !line.startsWith("#") && pendingAttrs) {
      try {
        const url = new URL(line, baseUrl).toString();
        const resMatch = /^(\d+)x(\d+)$/.exec(pendingAttrs.RESOLUTION || "") || [];
        const width = parseInt(resMatch[1] || "0", 10) || 0;
        const height = parseInt(resMatch[2] || "0", 10) || 0;
        const bandwidth = parseInt(pendingAttrs.BANDWIDTH || "0", 10) || 0;
        const codecs = pendingAttrs.CODECS || "";
        const variant = {
          url,
          bandwidth,
          width,
          height,
          resolution: width && height ? `${width}x${height}` : "",
          codecs,
          audio: pendingAttrs.AUDIO || "",
          frameRate: Number(pendingAttrs["FRAME-RATE"] || 0) || 0,
          label: height ? `${height}p` : bandwidth ? `${Math.round(bandwidth / 1000)}k` : "Auto",
        };
        variants.push(variant);
        if (bandwidth > bestBandwidth) {
          bestVariant = url;
          bestBandwidth = bandwidth;
          bestVariantCodecs = codecs;
          bestWidth = width;
          bestHeight = height;
        }
      } catch {
        void 0;
      }
      pendingAttrs = null;
    }
  }

  variants.sort((a, b) => (b.bandwidth - a.bandwidth) || (b.height - a.height));
  return {
    isMaster,
    hasAudio,
    isMuxed,
    bestBandwidth,
    bestVariant,
    bestVariantCodecs,
    bestWidth,
    bestHeight,
    audioVariantUrl,
    audioBandwidth,
    audioCodecs,
    variants,
    renditions,
  };
}

function isAudioPlaylistUrl(url) {
  return AUDIO_PLAYLIST_RE.test(url.toLowerCase());
}

function isProxyUrl(url) {
  return PROXY_PATTERNS.some(re => re.test(url));
}

const audioProbeDone = new Set();
const audioRecoveryInFlight = new Map();
const HOT_ATTACH_WINDOW_MS = 15000;
const hotAttached = new Set();

function isVideoOnlyVideo(v) {
  if (!v || !/\.m3u8(?:$|[?#])/i.test(v.url || "")) return false;
  if (isAudioPlaylistUrl(v.url)) return false;
  const info = v.manifestInfo || {};
  if (info.isMaster) return false;
  if (info.hasAudio) return false;
  return v.kind === "hls-video-only" || PROXY_VIDEO_RE.test(v.url);
}

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
  pairAllVideoOnly(tabId);
  maybeHotAttachAudio(tabId);
  persist(tabId);
  scheduleWarmLaunch();
}

function inferQualityLabel(url) {
  const value = String(url || "");
  if (/(2160|4k|uhd)/i.test(value)) return "2160p";
  if (/(1440|2k|qhd)/i.test(value)) return "1440p";
  if (/(1080|fhd)/i.test(value)) return "1080p";
  if (/(720|hd)/i.test(value)) return "720p";
  if (/(480|sd)/i.test(value)) return "480p";
  return "";
}

function getStreamType(url) {
  if (!url) return "UNKNOWN";
  const u = url.toLowerCase();
  if (u.includes("ytdlp") || u.includes("youtube.com") || u.includes("youtu.be") || u.includes("googlevideo.com")) return "YTDLP";
  if (u.includes(".m3u8") || u.includes(".m3u")) return "HLS";
  if (u.includes(".mpd")) return "DASH";
  if (u.includes(".mp4") || u.includes(".mkv") || u.includes(".webm")) return "DIRECT";
  if (u.includes("127.0.0.1") || u.includes("localhost")) return "RELAY";
  return "OTHER";
}

function buildQualityTiers(video, info) {
  if (!video) return [];
  const headers = video.headers || {};
  const baseUrl = video.playUrl || video.url;
  if (!baseUrl) return [];
  const variants = (info && info.variants) || [];
  const audioInfo = (info && info.renditions && info.renditions.find((r) => r.url)) || null;
  const fallbackAudio = video.kind === "hls-video-only" ? (video.audioUrl || null) : null;
  const fallbackAudioHeaders = video.audioHeaders || headers;
  const out = [{
    label: "Auto (Best)",
    url: baseUrl,
    width: Number(info && info.bestWidth) || 0,
    height: Number(info && info.bestHeight) || 0,
    bandwidth: Number(info && info.bestBandwidth) || 0,
    codecs: (info && info.bestVariantCodecs) || "",
    headers,
    audioUrl: audioInfo ? audioInfo.url : fallbackAudio,
    audioHeaders: audioInfo ? { ...headers, ...(audioInfo.headers || {}) } : fallbackAudioHeaders,
  }];
  const seen = new Set(["auto"]);
  for (const variant of variants) {
    const key = `${variant.height || 0}:${variant.bandwidth || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label: variant.label || inferQualityLabel(variant.url) || "Auto",
      url: variant.url,
      masterUrl: baseUrl,
      width: variant.width || 0,
      height: variant.height || 0,
      bandwidth: variant.bandwidth || 0,
      codecs: variant.codecs || "",
      audio: variant.audio || "",
      headers,
      audioUrl: audioInfo ? audioInfo.url : fallbackAudio,
      audioHeaders: audioInfo ? { ...headers, ...(audioInfo.headers || {}) } : fallbackAudioHeaders,
    });
  }
  if (out.length === 1) {
    out[0].label = inferQualityLabel(baseUrl) || "Auto (Best)";
  }
  return out;
}

function schedulePreResolve(tabId, url, headers) {
  if (tabId == null || tabId < 0 || !/\.m3u8(?:$|[?#])/i.test(url) || isAudioPlaylistUrl(url)) return;
  const state = getState(tabId);
  const entry = state.videos.find((v) => v.url.split("?")[0] === url.split("?")[0]);
  if (entry && entry.preResolvedAt && Date.now() - entry.preResolvedAt < 60000) return;
  const key = tabId + "|" + url;
  if (preResolveInFlight.has(key) || manifestResolution.has(key)) return;
  const promise = (async () => {
    const text = await fetchManifestText(url, headers, 3000);
    if (!text || !text.includes("#EXTM3U")) return;
    const info = parseManifestInfo(text, url);
    const currentState = getState(tabId);
    const idx = currentState.videos.findIndex((v) => v.url.split("?")[0] === url.split("?")[0]);
    if (idx < 0) return;
    const video = currentState.videos[idx];
    const next = {
      ...video,
      manifestInfo: info,
      qualities: buildQualityTiers({ ...video, manifestInfo: info }, info),
      preResolvedAt: Date.now(),
    };
    if (info.isMaster && info.hasAudio) {
      next.kind = "hls-master";
      next.isVerifiedMaster = true;
      next.isMuxedMaster = info.isMuxed;
      let baseScore = SCORE_HLS_MASTER;
      if (info.isMuxed) baseScore = SCORE_MUXED_MASTER;
      if (isProxyUrl(url)) baseScore += PROXY_PENALTY;
      next.score = Math.max(next.score || 0, baseScore);
      if (!next.liveBoosted && hasLiveTraffic(tabId, url)) {
        next.liveBoosted = true;
        next.score += LIVE_SIGNAL_SCORE;
      }
    }
    currentState.videos[idx] = next;
    currentState.videos.sort((a, b) => b.score - a.score);
    persist(tabId);
  })().catch(() => {
    void 0;
  }).finally(() => {
    preResolveInFlight.delete(key);
  });
  preResolveInFlight.set(key, promise);
}

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
          void 0;
        }
        return out;
      },
    }).catch(() => null);
    if (results) {
      for (const r of results) {
        if (!r || r.error) continue;
        for (const name of (r.result || [])) {
          if (!name) continue;
          allUrls.add(name);
          allUrls.add(name.split("?")[0]);
          if (isAudioPlaylistUrl(name) || PROXY_AUDIO_RE.test(name) || /\.(aac|m4a)(?:$|[?#])/i.test(name)) {
            addAudioStream(tabId, name, { frameId: r.frameId });
          }
        }
      }
    }
  } catch {
    void 0;
  }
  return allUrls;
}

function siblingAudioUrl(videoUrl) {
  if (!videoUrl || !PROXY_VIDEO_RE.test(videoUrl)) return null;
  const sib = videoUrl.replace(/(\/m3u8_proxy\/)video\//i, "$1audio/");
  return sib === videoUrl ? null : sib;
}

async function recoverAudioForVideo(tabId, videoUrl, headers) {
  const allUrls = await harvestFrameAudioResources(tabId);
  const sib = siblingAudioUrl(videoUrl);
  if (sib) {
    const clean = sib.split("?")[0];
    const present = allUrls.has(sib) || allUrls.has(clean);
    const hasAudio = (getState(tabId).audioStreams || []).length > 0;
    if (present || !hasAudio) addAudioStream(tabId, sib, { frameId: null, headers });
  }
  rekindleAudioPairing(tabId, videoUrl);
}

function pairAllVideoOnly(tabId) {
  if (tabId == null || tabId < 0) return;
  const state = getState(tabId);
  for (const v of state.videos) {
    if ((v.kind === "hls-video-only" || PROXY_VIDEO_RE.test(v.url)) && !v.playUrl) {
      rekindleAudioPairing(tabId, v.url);
    }
  }
}

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
    void 0;
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
      isMuxedMaster: manifestInfo.isMuxed,
      relayReady: true,
      manifestInfo,
      audioUrl: null,
      score: Math.max(state.videos[idx].score || 0, manifestInfo.isMuxed ? SCORE_MUXED_MASTER : SCORE_HLS_MASTER),
    headers: { ...(state.videos[idx].headers || {}), ...(headers || {}) },
  };
  state.videos.sort((a, b) => b.score - a.score);
  persist(tabId);
  
  const video = state.videos[idx];
  void prewarmStream(videoUrl, headers, video.audioUrl || null, video.audioHeaders || null, state.page.title || "", {
    candidateId: video.id || videoUrl,
    tabId,
    startTime: video.currentTime || 0,
    verified: video.verified === true,
  });
  
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
            addAudioStream(tabId, sib, { frameId: null, headers });
          } else {
            await probeAndPromoteParentMaster(tabId, url, headers);
          }
        }
      }
      rekindleAudioPairing(tabId, url);
      const video = state.videos.find(v => v.url.split("?")[0] === url.split("?")[0]);
      if (video && video.audioUrl) {
        void prewarmStream(video.url, video.headers || {}, video.audioUrl, video.audioHeaders || {}, state.page.title || "", {
          candidateId: video.id || video.url,
          tabId,
          startTime: video.currentTime || 0,
          verified: video.verified === true,
        });
      }
    } catch {
      void 0;
    } finally {
      audioRecoveryInFlight.delete(key);
    }
  })();
  audioRecoveryInFlight.set(key, promise);
  return promise;
}

function audioGraphScore(videoUrl, audioUrl) {
  try {
    const v = new URL(videoUrl);
    const a = new URL(audioUrl);
    if (v.host !== a.host) return 0;
    let score = 40;
    const vParts = v.pathname.split("/").filter(Boolean);
    const aParts = a.pathname.split("/").filter(Boolean);
    if (vParts[0] && vParts[0] === aParts[0]) score += 80;
    const vStem = v.pathname.replace(/\.m3u8?$/i, "").replace(/\/[^/]*$/, "");
    const aStem = a.pathname.replace(/\.m3u8?$/i, "").replace(/\/[^/]*$/, "");
    if (vStem && aStem && (vStem === aStem || vStem.startsWith(aStem + "/") || aStem.startsWith(vStem + "/"))) {
      score += 120;
    }
    return score;
  } catch {
    return 0;
  }
}

function scoreVideoOnly(url, u, frameId, allVideos, audioStreams, baseScore) {
  let score = baseScore;

  if (/(2160|4k|uhd)/i.test(u)) score += 400;
  else if (/(1440|2k|qhd)/i.test(u)) score += 300;
  else if (/(1080|fhd)/i.test(u)) score += 300;
  else if (/(720|hd)/i.test(u)) score += 200;

  if (!/(proxy|relay|googlevideo|manifest\.googlevideo)/i.test(u)) score += 100;

  const bw = /bandwidth[=_](\d+)/i.exec(url);
  if (bw) score += Math.min(Number(bw[1]) / 1e6, 300);

  const audioPool = [
    ...allVideos.filter(v => v.kind === "hls-audio-only" || isAudioPlaylistUrl(v.url)),
    ...audioStreams,
  ];
  const audioCandidates = audioPool
    .filter(v => !(frameId && v.frameId && v.frameId !== frameId))
    .map((a) => ({
      ...a,
      pairScore: (a.score || 0) + audioGraphScore(url, a.url) + (frameId && a.frameId === frameId ? 100 : 0),
    }))
    .sort((a, b) => b.pairScore - a.pairScore);

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

  if (isAudioPlaylistUrl(u) || PROXY_AUDIO_RE.test(u)) {
    return { score: 100, kind: "hls-audio-only", audioUrl: null, manifestInfo: null, frameId: frameId };
  }

  const liveBonus = hasLiveTraffic(tabId, url) ? LIVE_SIGNAL_SCORE : 0;

  if (PROXY_VIDEO_RE.test(u)) {
    const r = scoreVideoOnly(url, u, frameId, allVideos, audioStreams, SCORE_HLS_MASTER + PROXY_PENALTY);
    return { score: r.score + liveBonus, kind: r.kind, audioUrl: r.audioUrl, manifestInfo: null, frameId: frameId };
  }

  if (/\.m3u8/i.test(u)) {
    const r = scoreVideoOnly(url, u, frameId, allVideos, audioStreams, 500);
    return { score: r.score + liveBonus, kind: r.kind, audioUrl: r.audioUrl, manifestInfo: null, frameId: frameId };
  }

  if (/\.mpd/i.test(u)) {
    kind = "dash";
    score += SCORE_DASH_MPD;

    if (/(2160|4k|uhd)/i.test(u)) score += 400;
    else if (/(1440|2k|qhd)/i.test(u)) score += 300;
    else if (/(1080|fhd)/i.test(u)) score += 300;
    else if (/(720|hd)/i.test(u)) score += 200;
    return { score, kind, audioUrl: null, manifestInfo: null, frameId: null };
  }

  if (/\.(mp4|mkv|webm)(?:$|[?#])/i.test(u)) {
    kind = "progressive";
    score += SCORE_PROGRESSIVE;

    if (/(2160|4k|uhd)/i.test(u)) score += 400;
    else if (/(1440|2k|qhd)/i.test(u)) score += 300
    else if (/(1080|fhd)/i.test(u)) score += 300;
    else if (/(720|hd)/i.test(u)) score += 200;
    return { score, kind, audioUrl: null, manifestInfo: null, frameId: null };
  }

  return { score, kind, audioUrl, manifestInfo, frameId };
}

const livenessCache = new Map();
const LIVENESS_PROBE_TIMEOUT_MS = 1500;

async function probeLivenessParallel(urls) {
  const results = new Map();
  const promises = urls.map(async (url) => {
    if (livenessCache.has(url)) return { url, ...livenessCache.get(url) };
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), LIVENESS_PROBE_TIMEOUT_MS);
      const res = await fetch(url, {
        method: "HEAD",
        credentials: "include",
        signal: controller.signal,
        headers: { "Accept": "*/*" },
      });
      clearTimeout(timeout);
      const ct = res.headers.get("content-type") || "";
      const isHtml = ct.includes("text/html");
      let verified = false;
      let mediaSig = false;
      if (res.ok && !isHtml) {
        // Try GET first 2KB for media signatures
        try {
          const getRes = await fetch(url, {
            method: "GET",
            credentials: "include",
            headers: { "Range": "bytes=0-2047" },
            signal: AbortSignal.timeout(LIVENESS_PROBE_TIMEOUT_MS),
          });
          const buf = await getRes.arrayBuffer();
          const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
          mediaSig = text.includes("#EXTM3U") || text.includes("#EXT-X-STREAM-INF") || 
                     text.includes("#EXTINF") || text.includes("<MPD") || 
                     new Uint8Array(buf)[0] === 0x00 && new Uint8Array(buf)[4] === 0x66 && new Uint8Array(buf)[5] === 0x74 && new Uint8Array(buf)[6] === 0x79 && new Uint8Array(buf)[7] === 0x70; // ftyp
          verified = getRes.ok && mediaSig;
        } catch {
          verified = res.ok && !isHtml;
        }
      }
      const result = { status: res.status, verified, mediaSig, isHtml };
      livenessCache.set(url, result);
      if (livenessCache.size > 200) livenessCache.clear(); // simple LRU
      return { url, ...result };
    } catch (e) {
      const result = { status: 0, verified: false, error: String(e) };
      livenessCache.set(url, result);
      return { url, ...result };
    }
  });
  const settled = await Promise.allSettled(promises);
  for (const r of settled) {
    if (r.status === "fulfilled") results.set(r.value.url, r.value);
  }
  return results;
}

async function enhanceScoresWithLiveness(candidates, _tabId) {
  const urls = candidates
    .filter(c => c && c.url && (c.kind === "hls-master" || c.kind === "hls-video-only" || c.kind === "dash" || c.kind === "progressive" || c.url.includes(".m3u8") || c.url.includes(".mpd") || c.url.includes(".mp4") || c.url.includes(".mkv") || c.url.includes(".webm")))
    .map(c => c.url);
  if (!urls.length) return candidates;
  
  const livenessResults = await probeLivenessParallel(urls);
  
  return candidates.map(c => {
    const liveness = livenessResults.get(c.url);
    if (!liveness) return c;
    
    let newScore = c.score;
    let newVerified = c.verified;
    
    if (liveness.status === 403 || liveness.status === 404) {
      newScore -= 10000; // disqualify
    } else if (liveness.verified) {
      newScore += 5000; // boost verified streams
      newVerified = true;
    } else if (liveness.mediaSig) {
      newScore += 2000; // media signature found
    }
    
    // Penalize proxy wrappers when direct stream exists
    if (c.url.includes("/m3u8_proxy/") && candidates.some(other => other.url.includes(c.url.replace("/m3u8_proxy/", "/")) && other.verified)) {
      newScore -= 2500;
    }
    
    return { ...c, score: newScore, verified: newVerified, liveness: { status: liveness.status, verified: liveness.verified, mediaSig: liveness.mediaSig } };
  });
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
    for (const v of state.videos) {
      if ((v.kind === "hls-video-only" || PROXY_VIDEO_RE.test(v.url)) && !v.audioUrl && !v.playUrl) {
        rekindleAudioPairing(tabId, v.url);
      }
    }
    maybeHotAttachAudio(tabId);
    persist(tabId);
    scheduleWarmLaunch();
    return;
  }

  const videoItem = {
    id: generateId(),
    url,
    streamType: getStreamType(url),
    type: (url.match(VIDEO_RE) || [, "stream"])[1].toLowerCase(),
    kind,
    score,
    audioUrl,
    verified: false,
    time: Date.now(),
    headers,
    frameId,
    liveBoosted: hasLiveTraffic(tabId, url),
  };
  if (extra && Number.isFinite(Number(extra.currentTime))) videoItem.currentTime = Number(extra.currentTime);
  if (extra && Number.isFinite(Number(extra.duration))) videoItem.duration = Number(extra.duration);
  upsert(state.videos, videoItem, (v) => v.url.split("?")[0]);
  state.videos.sort((a, b) => b.score - a.score);

  persist(tabId);
  scheduleWarmLaunch();
  schedulePreResolve(tabId, url, headers);

  // Non-blocking liveness probe to enhance scores
  void (async () => {
    try {
      const enhanced = await enhanceScoresWithLiveness(state.videos, tabId);
      if (enhanced && enhanced.length) {
        state.videos = enhanced;
        state.videos.sort((a, b) => b.score - a.score);
        persist(tabId);
      }
    } catch {
      // ignore liveness probe errors
    }
  })();

  if (kind === "hls-master" || kind === "hls-video-only" || PROXY_VIDEO_RE.test(url)) {
    void prewarmStream(url, headers, audioUrl, null, state.page.title || "", {
      candidateId: videoItem.id || url,
      tabId,
      startTime: extra?.currentTime || 0,
      verified: videoItem.verified === true,
    });
  }

  if (kind === "hls-video-only" && !audioUrl) {
    void ensureAudioRecovery(tabId, url, headers, frameId);
  }
}

function demoteRootManifestCandidate(tabId, url) {
  const state = getState(tabId);
  const idx = state.videos.findIndex(v => v.url.split("?")[0] === url.split("?")[0]);
  if (idx < 0) return false;
  const v = state.videos[idx];
  if (v.kind !== "hls-master" || v.playUrl) return false;
  const r = scoreVideoOnly(v.url, v.url.toLowerCase(), v.frameId, state.videos, state.audioStreams, 500);
  state.videos[idx] = { ...v, kind: r.kind, score: r.score, audioUrl: r.audioUrl, isVerifiedMaster: false, isMuxedMaster: false };
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
        try {
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
        } catch {
          return { url: targetUrl, verified: false, headers: targetHeaders, manifestInfo };
        }
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

      return { url, verified: false, headers: targetHeaders, manifestInfo };
    }
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
    if (CHUNK_RE.test(url) || /\.ts(?:$|[?#])/i.test(url)) notifyLiveSegment(details.tabId, url);
    if (VIDEO_RE.test(url)) addVideo(details.tabId, url, details);
    if (AUDIO_RE.test(url)) addAudioStream(details.tabId, url, details);
    if (SUB_RE.test(url)) addSub(details.tabId, url, details);
  },
  { urls: ["<all_urls>"] }
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
                url: isMaster ? state.videos[videoIdx].url : result.url,
                ...(isMaster ? {
                  kind: "hls-master",
                  isVerifiedMaster: true,
                  isMuxedMaster: result.manifestInfo.isMuxed,
                  audioUrl: null,
                  score: Math.max(state.videos[videoIdx].score || 0, result.manifestInfo.isMuxed ? SCORE_MUXED_MASTER : SCORE_HLS_MASTER),
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
          if (info && !info.isMaster) demoteRootManifestCandidate(details.tabId, url);
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
    if (msg.type === "player:seek") {
      sendWsMessage({ type: "extension:seek", timePos: msg.timePos });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "player:pause") {
      sendWsMessage({ type: "extension:pause", paused: msg.paused });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "player:switch-quality") {
      sendWsMessage({ type: "extension:switch-quality", index: msg.index });
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "bridge:getStatus") {
      // Return current WebSocket bridge status
      const wsConnected = wsConnection && wsConnection.readyState === WebSocket.OPEN;
      const candidateCount = 0; // Could track from cached candidates
      sendResponse({ connected: wsConnected, candidateCount });
      return;
    }
    if (msg.type === "native") {
      const payload = msg.payload || { action: "getConfig" };
      if (payload.action === "prewarm") {
        sendResponse(await prewarmNative());
        return;
      }
      if (payload.action === "play" || payload.action === "queue") {
        const endpoint = await getDaemonEndpoint();
        const daemonResult = await daemonSend(payload, endpoint);
        if (daemonResult) {
          sendResponse(daemonResult);
          return;
        }
      }
      const nativeResult = await nativeSend(payload);
      if (nativeResult && nativeResult.endpoint) await setDaemonEndpoint(nativeResult.endpoint);
      sendResponse(nativeResult);
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
    if (msg.type === "extractedStreams") {
      const state = getState(tabId);
      const data = msg.data;
      if (data && data.videoStreams) {
        state.page.title = data.title || state.page.title;
        for (const stream of data.videoStreams) {
          const headers = {
            referer: state.page.url,
            origin: new URL(state.page.url).origin,
            userAgent: navigator.userAgent,
            cookie: state.cookies,
          };
          addVideo(tabId, stream.url, {
            type: "youtube-extracted",
            frameId: null,
            headers,
            currentTime: 0,
            duration: stream.approxDuration / 1000,
          });
          const videoIdx = state.videos.findIndex(v => v.url.split("?")[0] === stream.url.split("?")[0]);
          if (videoIdx >= 0) {
            state.videos[videoIdx] = {
              ...state.videos[videoIdx],
              height: stream.height,
              width: stream.width,
              bitrate: stream.bitrate,
              codecs: stream.codecs,
              qualityLabel: stream.qualityLabel,
              isVideoOnly: stream.isVideoOnly,
              itag: stream.itag,
              fps: stream.fps,
            };
          }
        }
        if (data.audioStreams && data.audioStreams.length) {
          for (const audio of data.audioStreams) {
            const headers = {
              referer: state.page.url,
              origin: new URL(state.page.url).origin,
              userAgent: navigator.userAgent,
              cookie: state.cookies,
            };
            addAudioStream(tabId, audio.url, { headers, frameId: null });
          }
        }
        state.videos.sort((a, b) => b.score - a.score);
        persist(tabId);
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "manifestUrl") {
      const state = getState(tabId);
      const url = msg.url;
      const playerType = msg.playerType || "unknown";
      if (url && (url.includes(".m3u8") || url.includes(".mpd"))) {
        const headers = {
          referer: state.page.url,
          origin: new URL(state.page.url).origin,
          userAgent: navigator.userAgent,
          cookie: state.cookies,
        };
        addVideo(tabId, url, {
          type: "manifest-hook",
          frameId: null,
          headers,
          playerType,
        });
        persist(tabId);
      }
      sendResponse({ ok: true });
      return;
    }
    // Manual instant launch from hover pill - TAKEOVER_PAUSE
    if (msg.type === "TAKEOVER_PAUSE") {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab && tab.id) {
        // Find the video in state matching the URL
        const state = getState(tab.id);
        const video = state.videos.find(v => v.url.split("?")[0] === (msg.videoUrl || "").split("?")[0]);
        const startTime = msg.currentTime || (video ? video.currentTime : 0);
        const duration = msg.duration || (video ? video.duration : 0);
        const out = await launch(tab, msg.videoUrl || video?.url || tab.url, "play", {
          startTime,
          duration,
          startTimeSource: "hoverPill",
        });
        sendResponse(out);
        return;
      }
      sendResponse({ ok: false, error: "no active tab" });
      return;
    }
  })();
  return true;
});

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

function httpHeaderObject(headers) {
  const source = headers || {};
  const out = {};
  if (source.referer) out.Referer = source.referer;
  if (source.origin) out.Origin = source.origin;
  if (source.userAgent) out["User-Agent"] = source.userAgent;
  if (source.cookie) out.Cookie = source.cookie;
  for (const [key, value] of Object.entries(source)) {
    if (/^(referer|origin|useragent|cookie)$/i.test(key)) continue;
    if (!value || typeof value !== "string") continue;
    if (!/^[a-zA-Z0-9-]+$/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

async function getDomainCookies(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => c.name + "=" + c.value).join("; ");
  } catch {
    return "";
  }
}

function bestAudioForVideo(state, video) {
  const frameId = video && video.frameId;
  const pool = [
    ...(state.audioStreams || []),
    ...(state.videos || []).filter((v) => v.kind === "hls-audio-only" || isAudioPlaylistUrl(v.url)),
  ];
  const ordered = pool
    .filter((a) => !(frameId && a.frameId && a.frameId !== frameId))
    .map((a) => ({ ...a, pairScore: (a.score || 0) + (video ? audioGraphScore(video.url, a.url) : 0) }))
    .sort((a, b) => b.pairScore - a.pairScore);
  return ordered[0] || null;
}

function candidateFromVideo(state, video, titleFallback) {
  if (!video || !video.url) return null;
  const headers = video.headers || {};
  const info = video.manifestInfo || null;
  const needsSeparateAudio = video.kind !== "hls-master" &&
    (video.kind === "hls-video-only" || isVideoOnlyVideo(video));
  const bestAudio = needsSeparateAudio && !video.audioUrl ? bestAudioForVideo(state, video) : null;
  const audio = needsSeparateAudio ? (video.audioUrl || (bestAudio && bestAudio.url) || null) : null;
  const audioHeaders = audio ? httpHeaderObject((bestAudio && bestAudio.headers) || headers) : null;
  const height = Number(info && info.bestHeight) || 0;
  const width = Number(info && info.bestWidth) || 0;
  const bandwidth = Number(info && info.bestBandwidth) || 0;
  const label = height
    ? `${height}p`
    : (inferQualityLabel(video.url) || (() => { try { return new URL(video.url).hostname; } catch { return "Source"; } })());
  return {
    id: video.id || generateId(),
    url: video.playUrl || video.url,
    streamType: video.streamType || getStreamType(video.url),
    audioUrl: audio,
    audioHeaders: audioHeaders || {},
    headers: httpHeaderObject(headers),
    referer: headers.referer || "",
    userAgent: headers.userAgent || "",
    cookies: headers.cookie || "",
    title: video.title || titleFallback || "",
    label,
    quality: label,
    kind: video.kind || "",
    width,
    height,
    bandwidth,
    codecs: (info && info.bestVariantCodecs) || "",
    score: video.score || 0,
    verified: video.verified || false,
    qualities: buildQualityTiers(video, info),
  };
}

function rankedCandidates(state, selectedVideo, titleFallback) {
  if (!selectedVideo) return [];
  const selectedKey = selectedVideo.url.split("?")[0];
  const ordered = [
    selectedVideo,
    ...(state.videos || []).filter((v) => isDisplayVideo(v) && v.url.split("?")[0] !== selectedKey),
  ];
  return ordered.slice(0, 8).map((v) => candidateFromVideo(state, v, titleFallback)).filter(Boolean);
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
  const selected = extra?.forcePageUrl === true ? pageUrl : (url || (state.videos[0] && state.videos[0].url) || pageUrl);
  const cfg = (await chrome.storage.sync.get("extension")).extension || {};
  let selectedVideo = state.videos.find(v => v.url.split("?")[0] === selected.split("?")[0]);

  if (selectedVideo && isVideoOnlyVideo(selectedVideo) && !selectedVideo.audioUrl) {
    const bestAudio = bestAudioForVideo(state, selectedVideo);
    if (bestAudio) {
      selectedVideo = { ...selectedVideo, audioUrl: bestAudio.url, audioHeaders: bestAudio.headers || {} };
    } else {
      const tabId = tab ? tab.id : -1;
      void ensureAudioRecovery(tabId, selectedVideo.url, selectedVideo.headers || {}, selectedVideo.frameId);
    }
  }

  const requestHeaders = selectedVideo?.headers || {};
  const headers = { ...requestHeaders };
  const hasExtraStart = extra && extra.startTime != null && Number.isFinite(Number(extra.startTime));
  const rawStart = hasExtraStart ? Number(extra.startTime) : Number(selectedVideo?.currentTime);
  const rawDuration = hasExtraStart ? Number(extra.duration) : Number(selectedVideo?.duration);
  const startTime = hasExtraStart ? Math.floor(rawStart) : resumeStartTime(rawStart, rawDuration);
  const duration = Number.isFinite(rawDuration) ? rawDuration : 0;
  
  const manifestInfo = selectedVideo?.manifestInfo || null;
  const isVerifiedMaster = selectedVideo?.verified === true && selectedVideo?.kind === "hls-master";
  const masterHasAudio = manifestInfo?.hasAudio === true;
  
  const playUrl = selectedVideo?.playUrl || selected;

  let audioUrl = selectedVideo?.audioUrl || null;
  let audioHeaders = null;
  
  const needsSeparateAudio = Boolean(selectedVideo) &&
    selectedVideo.kind !== "hls-master" && !(isVerifiedMaster && masterHasAudio) &&
    (selectedVideo.kind === "hls-video-only" || isVideoOnlyVideo(selectedVideo));
  if (!needsSeparateAudio) {
    audioUrl = null;
  } else if (!audioUrl) {
    const videoFrameId = selectedVideo?.frameId || null;
    const audioPool = [
      ...(state.audioStreams || []),
      ...(state.videos || []).filter(v => v.kind === "hls-audio-only" || isAudioPlaylistUrl(v.url))
    ];
    const sameFrameAudio = audioPool
      .filter(a => videoFrameId && a.frameId && a.frameId === videoFrameId)
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    const otherAudio = audioPool
      .filter(a => !(videoFrameId && a.frameId && a.frameId === videoFrameId))
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    const orderedAudio = [...sameFrameAudio, ...otherAudio];
    
    if (orderedAudio.length > 0) {
      const bestAudio = orderedAudio[0];
      audioUrl = bestAudio.url;
      audioHeaders = { ...(selectedVideo?.headers || {}), ...(bestAudio.headers || {}) };
    }
  } else if (audioUrl) {
    const audioVideo = state.videos.find(v => v.url.split("?")[0] === audioUrl.split("?")[0])
      || (state.audioStreams || []).find(v => v.url.split("?")[0] === audioUrl.split("?")[0]);
    audioHeaders = { ...(selectedVideo?.headers || {}), ...((audioVideo && audioVideo.headers) || {}) };
  }

  const title = (tab && tab.title) || state.page.title || "";
  const candidates = rankedCandidates(state, selectedVideo, title);
  const qualities = selectedVideo ? buildQualityTiers(selectedVideo, manifestInfo) : [];

  // Merge per-domain cookies onto every candidate and its paired audio track
  const domainCookies = await getDomainCookies(pageUrl);
  const enrichedCandidates = candidates.map(c => ({
    ...c,
    cookies: c.cookies || domainCookies,
    headers: { ...httpHeaderObject(c.headers || {}), Cookie: c.cookies || domainCookies },
    audioHeaders: c.audioHeaders ? { ...c.audioHeaders, Cookie: c.audioHeaders.Cookie || domainCookies } : { Cookie: domainCookies },
  }));

  return {
    action: extra && extra.action ? extra.action : "play",
    url: playUrl,
    title,
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
    candidates: enrichedCandidates,
    qualities,
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

async function getDaemonEndpoint() {
  try {
    const stored = await chrome.storage.local.get([DAEMON_ENDPOINT_KEY]);
    const endpoint = stored[DAEMON_ENDPOINT_KEY];
    if (endpoint && Number.isInteger(endpoint.port) && endpoint.port > 0 && typeof endpoint.token === "string") {
      return endpoint;
    }
  } catch { /* storage unavailable */ }
  return null;
}

async function setDaemonEndpoint(endpoint) {
  if (!endpoint || !Number.isInteger(endpoint.port) || typeof endpoint.token !== "string") return;
  try {
    await chrome.storage.local.set({ [DAEMON_ENDPOINT_KEY]: endpoint });
  } catch { /* storage unavailable */ }
}

async function clearDaemonEndpoint() {
  try {
    await chrome.storage.local.remove(DAEMON_ENDPOINT_KEY);
  } catch { /* storage unavailable */ }
  try {
    await chrome.storage.session.remove(DAEMON_ENDPOINT_KEY);
  } catch { /* storage unavailable */ }
}

async function daemonSend(payload, endpoint) {
  if (!endpoint) return null;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller && controller.abort(), DAEMON_TIMEOUT_MS);
  try {
    const response = await fetch("http://127.0.0.1:" + endpoint.port + "/dispatch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-enhanced-mpv-token": endpoint.token,
      },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined,
    });
    if (response.status === 401 || response.status === 403) {
      await clearDaemonEndpoint();
      return null;
    }
    if (!response.ok) throw new Error("daemon status " + response.status);
    return await response.json();
  } catch {
    await clearDaemonEndpoint();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================================
// WebSocket Bridge for Real-Time Bidirectional Communication
// ============================================================================

let wsConnection = null;
let wsReconnectTimer = null;
let wsReconnectAttempts = 0;
let wsHeartbeatAlarm = null;
let wsReconnectInProgress = false; // Guard to prevent concurrent reconnect attempts
const WS_MAX_RECONNECT_ATTEMPTS = 10;
const WS_BASE_RECONNECT_DELAY_MS = 1000;
const WS_MAX_RECONNECT_DELAY_MS = 30000;

// PipelineState from daemon (single source of truth)
let cachedPipelineState = null;

function bgLog(msg) {
  try { console.log("[" + new Date().toISOString() + "] " + msg); } catch { /* ignore */ }
}

function connectWebSocket() {
  if (wsConnection && (wsConnection.readyState === WebSocket.OPEN || wsConnection.readyState === WebSocket.CONNECTING)) {
    return;
  }
  
  // Always prewarm/spawn daemon first to get a verified fresh endpoint
  prewarmNative().then((result) => {
    if (!result || !result.endpoint || !result.endpoint.port) {
      bgLog("WS: prewarmNative failed, scheduling reconnect");
      scheduleWsReconnect();
      return;
    }
    
    const endpoint = result.endpoint;
    const url = "ws://127.0.0.1:" + endpoint.port + "/ws";
    
    try {
      wsConnection = new WebSocket(url);
      wsConnection.binaryType = "arraybuffer";
      
      wsConnection.onopen = () => {
        bgLog("WS bridge connected");
        wsReconnectAttempts = 0;
        
        // Register all active tabs
        for (const [tabId, state] of tabState) {
          if (state.videos && state.videos.length > 0) {
            sendWsMessage({
              type: "extension:register",
              tabId: tabId
            });
            // Send current candidates for this tab
            const candidates = state.videos
              .filter(v => isDisplayVideo(v))
              .map(v => candidateFromVideo(state, v, state.page.title))
              .filter(Boolean);
            const qualities = state.videos[0] ? buildQualityTiers(state.videos[0], state.videos[0].manifestInfo) : [];
            sendWsMessage({
              type: "extension:candidates-update",
              tabId: tabId,
              candidates,
              qualities
            });
          }
        }
        
        // Request current pipeline state
        sendWsMessage({ type: "pipeline:getState" });
        
        // Start heartbeat alarm
        if (!wsHeartbeatAlarm) {
          chrome.alarms.create("empv-ws-heartbeat", { periodInMinutes: 0.25 }); // 15 seconds
          wsHeartbeatAlarm = true;
        }
      };
      
      wsConnection.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleWsMessage(msg);
        } catch (err) {
          bgLog("WS parse error: " + err.message);
        }
      };
      
      wsConnection.onclose = (event) => {
        // Handle code 1006 (abnormal closure) - daemon likely restarted on new port
        const isAbnormalClosure = event.code === 1006;
        if (isAbnormalClosure) {
          bgLog("WS bridge abnormal closure (1006), clearing stale daemon endpoint");
          clearDaemonEndpoint().then(() => {
            // Spawn/discover active daemon via Native Messaging - await completion
            prewarmNative().then((result) => {
              if (result && result.endpoint && result.endpoint.port) {
                bgLog("WS: prewarmNative succeeded after 1006, new port=" + result.endpoint.port);
              } else {
                bgLog("WS: prewarmNative failed after 1006");
              }
            }).catch(() => {
              bgLog("WS: prewarmNative error after 1006");
            });
          });
        }
        bgLog("WS bridge closed: " + event.code + " " + event.reason);
        wsConnection = null;
        cachedPipelineState = null;
        if (wsHeartbeatAlarm) {
          chrome.alarms.clear("empv-ws-heartbeat");
          wsHeartbeatAlarm = null;
        }
        // Debounced reconnect - only schedule if not already scheduled
        scheduleWsReconnect();
      };
      
      wsConnection.onerror = (err) => {
        // Suppress noisy console.error during normal backoff reconnects
        // Only log if we're not already reconnecting
        if (!wsReconnectTimer && wsReconnectAttempts === 0) {
          bgLog("WS bridge error: " + (err && err.message));
        }
      };
    } catch (err) {
      bgLog("WS connection failed: " + err.message);
      scheduleWsReconnect();
    }
  }).catch((err) => {
    bgLog("WS prewarm failed: " + err.message);
    scheduleWsReconnect();
  });
}

function scheduleWsReconnect() {
  if (wsReconnectTimer || wsReconnectInProgress) return;
  wsReconnectInProgress = true;
  const delay = Math.min(
    WS_BASE_RECONNECT_DELAY_MS * Math.pow(2, wsReconnectAttempts) + Math.random() * 1000,
    WS_MAX_RECONNECT_DELAY_MS
  );
  wsReconnectAttempts = Math.min(wsReconnectAttempts + 1, WS_MAX_RECONNECT_ATTEMPTS);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    wsReconnectInProgress = false;
    connectWebSocket();
  }, delay);
}

function sendWsMessage(msg) {
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    try {
      wsConnection.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      bgLog("WS send error: " + err.message);
    }
  }
  return false;
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case "player:state":
      // Forward player telemetry to popup and any listeners
      if (msg.state) {
        broadcastPlayerTelemetry(msg.state);
      }
      break;
    case "pipeline:state":
      // Daemon's unified PipelineState - single source of truth
      if (msg.payload) {
        cachedPipelineState = msg.payload;
        // Broadcast to popup and content scripts
        broadcastPipelineState(msg.payload);
      }
      break;
    case "sniffer:candidates-updated":
      // Legacy - now handled via pipeline:state
      break;
    case "bridge:status":
      broadcastBridgeStatus(msg.status);
      break;
  }
}

function broadcastPlayerTelemetry(state) {
  // Store latest telemetry for popup to read
  chrome.storage.session.set({ "playerTelemetry": { ...state, timestamp: Date.now() } }).catch(() => {});
  // Notify popup if open
  chrome.runtime.sendMessage({ type: "player:telemetry", state }).catch(() => {});
}

function broadcastPipelineState(pipelineState) {
  // Store for popup to read
  chrome.storage.session.set({ "pipelineState": { ...pipelineState, timestamp: Date.now() } }).catch(() => {});
  // Notify popup if open
  chrome.runtime.sendMessage({ type: "pipeline:state", payload: pipelineState }).catch(() => {});
  
  // Send shadowReady to content scripts for hover pill
  if (pipelineState.tabId != null) {
    const ready = pipelineState.stage === "SHADOW_READY";
    chrome.tabs.sendMessage(pipelineState.tabId, { type: "shadowReady", ready }).catch(() => {});
    
    const state = getState(pipelineState.tabId);
    if (pipelineState.candidate) {
      // Ensure candidate is in our local videos list
      const existing = state.videos.find(v => v.url.split("?")[0] === pipelineState.candidate.url.split("?")[0]);
      if (!existing && pipelineState.candidate.url) {
        addVideo(pipelineState.tabId, pipelineState.candidate.url, {
          type: "pipeline",
          headers: pipelineState.candidate.headers || {},
          currentTime: pipelineState.startTime || 0,
        });
      }
    }
  }
}

function broadcastBridgeStatus(status) {
  chrome.storage.session.set({ "bridgeStatus": { status, timestamp: Date.now() } }).catch(() => {});
  chrome.runtime.sendMessage({ type: "bridge:status", status }).catch(() => {});
}

function sendHeartbeat() {
  sendWsMessage({ type: "extension:heartbeat", timestamp: Date.now() });
}

// Listen for heartbeat alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "empv-ws-heartbeat") {
    sendHeartbeat();
  }
});

// Push candidate updates to daemon via WebSocket - drives PipelineState transitions
function pushCandidatesUpdate(tabId, candidates, qualities) {
  if (!candidates || !candidates.length) return;
  
  const topCandidate = candidates[0];
  const isVerified = topCandidate.verified === true;
  
  sendWsMessage({
    type: "extension:candidates-update",
    tabId,
    candidates,
    qualities
  });
  
  // If we have a verified top candidate and pipeline is in early stage, trigger prewarm
  if (isVerified && cachedPipelineState) {
    const stage = cachedPipelineState.stage;
    if (stage === "SNIFFING" || stage === "PROBING" || stage === "IDLE") {
      sendWsMessage({
        type: "extension:candidates-update",
        tabId,
        candidates,
        qualities,
        // Signal daemon to advance pipeline
        _triggerPrewarm: true,
        _candidateId: topCandidate.id,
        _verified: true,
      });
    }
  }
}

// Persist tab state to storage and push updates via WebSocket
async function persist(tabId) {
  const state = getState(tabId);
  try {
    await chrome.storage.session.set({ ["tab:" + tabId]: state });
  } catch {
    await chrome.storage.local.set({ ["tab:" + tabId]: state });
  }
  updateBadge(tabId);
  
  // Push candidate updates to daemon via WebSocket
  const candidates = state.videos
    .filter(v => isDisplayVideo(v))
    .map(v => candidateFromVideo(state, v, state.page.title))
    .filter(Boolean);
  const qualities = state.videos[0] ? buildQualityTiers(state.videos[0], state.videos[0].manifestInfo) : [];
  
  pushCandidatesUpdate(tabId, candidates, qualities);
}

// Initialize WebSocket connection on startup
chrome.runtime.onStartup.addListener(() => {
  void prewarmNative().catch(() => {});
  // Delay WS connection slightly to ensure daemon is ready
  setTimeout(connectWebSocket, 1000);
});

chrome.runtime.onInstalled.addListener(() => {
  void prewarmNative().catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "play-now",
      title: "Play Now in Enhanced MPV",
      contexts: ["link", "video", "audio", "page", "selection"],
    }, () => { void chrome.runtime.lastError; });
    chrome.contextMenus.create({
      id: "queue",
      title: "Queue in MPV",
      contexts: ["link", "video", "audio", "page", "selection"],
    }, () => { void chrome.runtime.lastError; });
    chrome.contextMenus.create({
      id: "play-link",
      title: "Play Link in Enhanced MPV",
      contexts: ["link", "video", "audio"],
    }, () => { void chrome.runtime.lastError; });
  });
  // Connect WS after install
  setTimeout(connectWebSocket, 1000);
});

// Also connect when background script loads (for development)
setTimeout(connectWebSocket, 1000);

async function prewarmNative() {
  const result = await nativeSend({ action: "prewarm" });
  if (result && result.endpoint) await setDaemonEndpoint(result.endpoint);
  return result;
}

async function prewarmStream(videoUrl, videoHeaders, audioUrl, audioHeaders, title, extra = {}) {
  const endpoint = await getDaemonEndpoint();
  if (!endpoint) return { ok: false, error: "no daemon endpoint" };
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller && controller.abort(), 1000);
  try {
    const response = await fetch("http://127.0.0.1:" + endpoint.port + "/prewarm-stream", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-enhanced-mpv-token": endpoint.token,
      },
      body: JSON.stringify({ 
        videoUrl, 
        videoHeaders: videoHeaders || {}, 
        audioUrl: audioUrl || null, 
        audioHeaders: audioHeaders || {}, 
        title: title || "",
        candidateId: extra.candidateId || videoUrl,
        tabId: extra.tabId || 0,
        startTime: extra.startTime || 0,
        verified: extra.verified || false,
      }),
      signal: controller ? controller.signal : undefined,
    });
    if (response.status === 401 || response.status === 403) {
      await clearDaemonEndpoint();
      return { ok: false, error: "unauthorized" };
    }
    if (!response.ok) throw new Error("prewarm-stream status " + response.status);
    return await response.json();
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function registerId() {
  const res = await nativeSend({ action: "register_id", extensionId: chrome.runtime.id });
  if (res && res.endpoint) await setDaemonEndpoint(res.endpoint);
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
  let result = null;
  
  // Try WebSocket first for faster response
  if (payload.action === "play" || payload.action === "queue") {
    const wsSent = sendWsMessage({
      type: "extension:play",
      url: payload.url,
      title: payload.title,
      referer: payload.referer,
      userAgent: payload.userAgent,
      cookies: payload.cookies,
      headers: payload.headers,
      audioUrl: payload.audioUrl,
      audioHeaders: payload.audioHeaders,
      startTime: payload.startTime,
      candidates: payload.candidates,
      qualities: payload.qualities
    });
    
    if (wsSent) {
      // WebSocket sent, wait a bit for response or fall back
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    const endpoint = await getDaemonEndpoint();
    result = await daemonSend(payload, endpoint);
  }
  if (!result) {
    result = await nativeSend(payload);
    if (result && result.endpoint) await setDaemonEndpoint(result.endpoint);
  }
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
  liveTraffic.delete(tabId);
  chunkManifestMap.delete(tabId);
  const timer = liveBoostTimers.get(tabId);
  if (timer) clearTimeout(timer);
  liveBoostTimers.delete(tabId);
  manifestResolution.forEach((_, key) => {
    if (key.startsWith(tabId + "|")) manifestResolution.delete(key);
  });
  preResolveInFlight.forEach((_, key) => {
    if (key.startsWith(tabId + "|")) preResolveInFlight.delete(key);
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

chrome.runtime.onStartup.addListener(() => {
  void prewarmNative().catch(() => {});
});

chrome.storage.sync.get("extension", (data) => {
  void data;
});