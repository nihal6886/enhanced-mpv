"use strict";

(() => {
if (window.__empvExtractorInstalled) return;
window.__empvExtractorInstalled = true;

const YT_INITIAL_PLAYER_RESPONSE = "ytInitialPlayerResponse";
const YOUTUBEI_PLAYER_PATTERN = /youtubei\/v1\/player/;
const HLS_MASTER_PATTERN = /#EXT-X-STREAM-INF/;
const DASH_MPD_PATTERN = /<MPD|<Representation/;

let extractionInFlight = false;
let lastExtractedData = null;
let lastExtractionTime = 0;
const EXTRACTION_DEBOUNCE_MS = 50;

function extractStreamingData(playerResponse) {
  if (!playerResponse || !playerResponse.streamingData) return null;
  const formats = [
    ...(playerResponse.streamingData.adaptiveFormats || []),
    ...(playerResponse.streamingData.formats || []),
  ];
  if (!formats.length) return null;

  const streams = formats
    .filter((f) => f.url || (f.signatureCipher && f.s) || (f.cipher && f.s))
    .map((f) => {
      let url = f.url;
      if (!url && (f.signatureCipher || f.cipher)) {
        try {
          const cipher = f.signatureCipher || f.cipher;
          const params = new URLSearchParams(cipher);
          url = decodeURIComponent(params.get("url") || "");
          const sig = params.get("s") || params.get("sig");
          if (sig && url) url += "&sig=" + encodeURIComponent(sig);
        } catch {
          url = "";
        }
      }
      if (!url) return null;

      const quality = f.qualityLabel || f.quality || "";
      const heightMatch = quality.match(/(\d+)p/i);
      const height = heightMatch ? parseInt(heightMatch[1], 10) : 0;
      const bitrate = parseInt(f.bitrate || f.averageBitrate || "0", 10) || 0;
      const mimeType = f.mimeType || "";
      const codecsMatch = mimeType.match(/codecs="([^"]+)"/i);
      const codecs = codecsMatch ? codecsMatch[1] : "";
      const hasAudio = mimeType.includes("audio") || f.audioQuality;
      const contentLength = f.contentLength ? parseInt(f.contentLength, 10) : 0;
      const approxDuration = f.approxDurationMs ? parseInt(f.approxDurationMs, 10) : 0;

      return {
        id: generateId(),
        url,
        height,
        width: f.width || 0,
        bitrate,
        codecs,
        mimeType,
        qualityLabel: quality,
        hasAudio,
        contentLength,
        approxDuration,
        isVideoOnly: !hasAudio && mimeType.includes("video"),
        isAudioOnly: hasAudio && !mimeType.includes("video"),
        itag: f.itag,
        projectionType: f.projectionType || "RECTANGULAR",
        fps: f.fps || 0,
      };
    })
    .filter(Boolean);

  if (!streams.length) return null;

  const videoStreams = streams.filter((s) => !s.isAudioOnly);
  const audioStreams = streams.filter((s) => s.isAudioOnly);

  videoStreams.sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);
  audioStreams.sort((a, b) => b.bitrate - a.bitrate);

  // The visible page title is stable and safe to present; never use a CDN URL as a title.
  const title = String(document.title || "").trim();

  return {
    title,
    videoId: playerResponse.videoDetails?.videoId || "",
    videoStreams,
    audioStreams,
    extractedAt: Date.now(),
  };
}

function generateId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function tryExtractFromYtInitialData() {
  if (window[YT_INITIAL_PLAYER_RESPONSE]) {
    const data = window[YT_INITIAL_PLAYER_RESPONSE];
    if (data && data.streamingData) return extractStreamingData(data);
  }
  return null;
}

function tryExtractFromPlayer() {
  try {
    const player = window.movie_player || document.getElementById("movie_player");
    if (player && typeof player.getPlayerResponse === "function") {
      const response = player.getPlayerResponse();
      if (response && response.streamingData) return extractStreamingData(response);
    }
  } catch {
    // player not ready or cross-origin
  }
  return null;
}

function tryExtractFromYtcfg() {
  try {
    if (window.ytcfg && window.ytcfg.data_) {
      const data = window.ytcfg.data_;
      if (data.PLAYER_RESPONSE) return extractStreamingData(data.PLAYER_RESPONSE);
    }
  } catch {
    // ytcfg not available
  }
  return null;
}

function parseHLSManifest(text, baseUrl) {
  const lines = text.split("\n");
  const variants = [];
  let pendingAttrs = null;
  let isMaster = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      isMaster = true;
      pendingAttrs = parseM3U8Attributes(line.slice("#EXT-X-STREAM-INF:".length));
    } else if (line && !line.startsWith("#") && pendingAttrs) {
      try {
        const url = new URL(line, baseUrl).toString();
        const resMatch = /^(\d+)x(\d+)$/.exec(pendingAttrs.RESOLUTION || "") || [];
        const width = parseInt(resMatch[1] || "0", 10) || 0;
        const height = parseInt(resMatch[2] || "0", 10) || 0;
        const bandwidth = parseInt(pendingAttrs.BANDWIDTH || "0", 10) || 0;
        const codecs = pendingAttrs.CODECS || "";
        variants.push({
          url,
          bandwidth,
          width,
          height,
          codecs,
          audio: pendingAttrs.AUDIO || "",
        });
      } catch { /* ignore */ }
      pendingAttrs = null;
    }
  }
  return { isMaster, variants };
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

function parseDASHManifest(text, baseUrl) {
  const representations = [];
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, "application/xml");
    const reps = doc.querySelectorAll("Representation");
    for (const rep of reps) {
      const baseUrlEl = rep.querySelector("BaseURL");
      if (baseUrlEl && baseUrlEl.textContent) {
        try {
          const url = new URL(baseUrlEl.textContent.trim(), baseUrl).toString();
          const bandwidth = parseInt(rep.getAttribute("bandwidth") || "0", 10) || 0;
          const width = parseInt(rep.getAttribute("width") || "0", 10) || 0;
          const height = parseInt(rep.getAttribute("height") || "0", 10) || 0;
          const codecs = rep.getAttribute("codecs") || "";
          const mimeType = rep.getAttribute("mimeType") || "";
          representations.push({ url, bandwidth, width, height, codecs, mimeType });
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return representations;
}

function extractAndForward() {
  const now = Date.now();
  if (now - lastExtractionTime < EXTRACTION_DEBOUNCE_MS) return;
  if (extractionInFlight) return;
  extractionInFlight = true;
  lastExtractionTime = now;

  const extracted = tryExtractFromYtInitialData() || tryExtractFromPlayer() || tryExtractFromYtcfg();

  if (extracted) {
    const json = JSON.stringify(extracted);
    if (json !== lastExtractedData) {
      lastExtractedData = json;
      forwardToIsolatedWorld(extracted);
    }
  }

  extractionInFlight = false;
}

function forwardToIsolatedWorld(data) {
  try {
    window.postMessage(
      {
        type: "EMPV_STREAM_EXTRACTED",
        source: "content-extractor",
        data,
      },
      "*"
    );
  } catch {
    // cross-origin or messaging disabled
  }
}

function forwardManifest(manifest) {
  try {
    window.postMessage(
      {
        type: "EMPV_MANIFEST_URL",
        source: "content-extractor",
        ...manifest,
      },
      "*"
    );
  } catch { /* ignore */ }
}

function hookFetch() {
  const originalFetch = window.fetch;
  window.fetch = async function (input, _init) {
    const url = typeof input === "string" ? input : input?.url;
    if (url && YOUTUBEI_PLAYER_PATTERN.test(url)) {
      const response = await originalFetch.apply(this, arguments);
      const cloned = response.clone();
      try {
        const json = await cloned.json();
        if (json && json.streamingData) {
          const extracted = extractStreamingData(json);
          if (extracted) forwardToIsolatedWorld(extracted);
        }
      } catch { /* not JSON or parse failed */ }
      return response;
    }
    if (url && (url.includes(".m3u8") || url.includes(".mpd"))) {
      const response = await originalFetch.apply(this, arguments);
      const cloned = response.clone();
      try {
        const text = await cloned.text();
        if (HLS_MASTER_PATTERN.test(text)) {
          const { isMaster, variants } = parseHLSManifest(text, url);
          if (isMaster) forwardManifest({ url, type: "hls-master", variants, timestamp: Date.now() });
        } else if (DASH_MPD_PATTERN.test(text)) {
          const reps = parseDASHManifest(text, url);
          if (reps.length) forwardManifest({ url, type: "dash-mpd", representations: reps, timestamp: Date.now() });
        }
      } catch { /* ignore */ }
      return response;
    }
    return originalFetch.apply(this, arguments);
  };
}

function hookXHR() {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._empvUrl = url;
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      if (!this._empvUrl) return;
      const url = this._empvUrl;
      if (YOUTUBEI_PLAYER_PATTERN.test(url)) {
        try {
          const json = JSON.parse(this.responseText);
          if (json && json.streamingData) {
            const extracted = extractStreamingData(json);
            if (extracted) forwardToIsolatedWorld(extracted);
          }
        } catch { /* ignore parse errors */ }
      } else if (url.includes(".m3u8") || url.includes(".mpd")) {
        try {
          const text = this.responseText;
          if (HLS_MASTER_PATTERN.test(text)) {
            const { isMaster, variants } = parseHLSManifest(text, url);
            if (isMaster) forwardManifest({ url, type: "hls-master", variants, timestamp: Date.now() });
          } else if (DASH_MPD_PATTERN.test(text)) {
            const reps = parseDASHManifest(text, url);
            if (reps.length) forwardManifest({ url, type: "dash-mpd", representations: reps, timestamp: Date.now() });
          }
        } catch { /* ignore */ }
      }
    });
    return originalSend.apply(this, arguments);
  };
}

function hookMediaElementSrc() {
  const proto = HTMLMediaElement.prototype;
  const srcDescriptor = Object.getOwnPropertyDescriptor(proto, "src");
  if (srcDescriptor && srcDescriptor.set) {
    const originalSet = srcDescriptor.set;
    Object.defineProperty(proto, "src", {
      set(value) {
        if (value && (value.includes(".m3u8") || value.includes(".mpd"))) {
          forwardManifest({ url: value, type: "media-src", timestamp: Date.now() });
        }
        originalSet.call(this, value);
      },
      get: srcDescriptor.get,
      configurable: true,
      enumerable: true,
    });
  }
}

function hookMediaSource() {
  if (!window.MediaSource) return;
  const proto = MediaSource.prototype;
  const originalAddSourceBuffer = proto.addSourceBuffer;
  proto.addSourceBuffer = function (mimeType) {
    if (mimeType && (mimeType.includes("mp4") || mimeType.includes("webm") || mimeType.includes("mpeg"))) {
      forwardManifest({ mimeType, type: "mediasource", timestamp: Date.now() });
    }
    return originalAddSourceBuffer.apply(this, arguments);
  };
}

function hookHlsShaka() {
  if (window.Hls && window.Hls.prototype && window.Hls.prototype.loadSource) {
    const originalLoadSource = window.Hls.prototype.loadSource;
    window.Hls.prototype.loadSource = function (url) {
      if (url && (url.includes(".m3u8") || url.includes(".mpd"))) {
        forwardManifest({ url, playerType: "hls.js", timestamp: Date.now() });
      }
      return originalLoadSource.apply(this, arguments);
    };
  }

  if (window.shaka && window.shaka.Player && window.shaka.Player.prototype.load) {
    const originalLoad = window.shaka.Player.prototype.load;
    window.shaka.Player.prototype.load = function (url) {
      if (url && (url.includes(".m3u8") || url.includes(".mpd"))) {
        forwardManifest({ url, playerType: "shaka", timestamp: Date.now() });
      }
      return originalLoad.apply(this, arguments);
    };
  }
}

function hookYoutubePlayerApi() {
  if (window.onYouTubeIframeAPIReady) {
    const originalReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () {
      originalReady.apply(this, arguments);
      setTimeout(extractAndForward, 100);
    };
  } else {
    window.onYouTubeIframeAPIReady = function () {
      setTimeout(extractAndForward, 100);
    };
  }
}

function schedulePeriodicExtraction() {
  setInterval(() => {
    if (window.location.hostname.includes("youtube.com") || window.location.hostname.includes("youtu.be")) {
      extractAndForward();
    }
  }, 2000);
}

function init() {
  hookFetch();
  hookXHR();
  hookMediaElementSrc();
  hookMediaSource();
  hookHlsShaka();
  hookYoutubePlayerApi();
  schedulePeriodicExtraction();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", extractAndForward);
  } else {
    extractAndForward();
  }

  window.addEventListener("yt-navigate-finish", extractAndForward);
  window.addEventListener("spfnavigate", extractAndForward);

  const observer = new MutationObserver(() => {
    extractAndForward();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
}

try {
  init();
} catch (e) {
  console.warn("[Enhanced MPV] content-extractor initialization failed:", e);
}
})();
