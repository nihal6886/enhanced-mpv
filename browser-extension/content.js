"use strict";

const RESOURCE_RE = /\.(m3u8|mpd|vtt|srt)(?:$|[?#])/i;
const MANIFEST_RE = /\.(m3u8|mpd)(?:$|[?#])/i;

function isManifestUrl(url) {
  return MANIFEST_RE.test(url);
}

function scrapePerformanceResources() {
  const resources = [];
  try {
    const entries = performance.getEntriesByType("resource");
    for (const entry of entries) {
      if (entry.name && RESOURCE_RE.test(entry.name)) {
        resources.push({
          url: entry.name,
          type: isManifestUrl(entry.name) ? "manifest" : "subtitle",
          initiatorType: entry.initiatorType || "unknown",
          startTime: entry.startTime,
          duration: entry.duration,
          transferSize: entry.transferSize,
        });
      }
    }
  } catch {
    // performance API may be restricted in cross-origin frames
  }
  return resources;
}

function scrapeFrames() {
  const frames = [];
  try {
    const allFrames = [...document.querySelectorAll("iframe")];
    for (const frame of allFrames) {
      try {
        const frameDoc = frame.contentDocument || frame.contentWindow?.document;
        if (frameDoc) {
          const videos = [...frameDoc.querySelectorAll("video")].map((el) => ({
            src: el.currentSrc || el.src || "",
            paused: el.paused,
            duration: el.duration || 0,
            currentTime: el.currentTime || 0,
          })).filter(v => v.src);
          
          const tracks = [...frameDoc.querySelectorAll("track")].map((el) => ({
            src: el.src,
            srclang: el.srclang || "",
            label: el.label || "",
            kind: el.kind || "subtitles",
          })).filter(t => t.src);

          const frameResources = [];
          try {
            const perf = frame.contentWindow?.performance;
            if (perf) {
              const entries = perf.getEntriesByType("resource");
              for (const entry of entries) {
                if (entry.name && RESOURCE_RE.test(entry.name)) {
                  frameResources.push({
                    url: entry.name,
                    type: isManifestUrl(entry.name) ? "manifest" : "subtitle",
                    initiatorType: entry.initiatorType || "unknown",
                    startTime: entry.startTime,
                    duration: entry.duration,
                    transferSize: entry.transferSize,
                  });
                }
              }
            }
          } catch {
            // cross-origin frame, can't access performance
          }

          if (videos.length > 0 || tracks.length > 0 || frameResources.length > 0) {
            frames.push({
              frameId: frame.id || frame.name || `frame-${Math.random().toString(36).slice(2)}`,
              src: frame.src,
              videos,
              tracks,
              resources: frameResources,
            });
          }
        }
      } catch {
        // cross-origin iframe, skip
      }
    }
  } catch {
    // ignore
  }
  return frames;
}

function collect() {
  const videos = [...document.querySelectorAll("video")].map((el) => {
    // Skip hidden videos, YouTube ads, invalid/zero duration, or already-ended videos
    if (el.offsetWidth === 0 || el.offsetHeight === 0) return null;
    if (el.closest(".ad-showing, .ad-interrupting")) return null;
    if (el.ended === true) return null;
    if (el.duration <= 0) return null;
    return {
      src: el.currentSrc || el.src || (el.querySelector("source") && el.querySelector("source").src) || "",
      paused: el.paused,
      duration: el.duration || 0,
      currentTime: el.currentTime || 0,
    };
  }).filter((v) => v && v.src);

  const tracks = [...document.querySelectorAll("track")].map((el) => ({
    src: el.src,
    srclang: el.srclang || el.getAttribute("srclang") || "",
    label: el.label || "",
    kind: el.kind || "subtitles",
  })).filter((t) => t.src);

  // Page Performance Resource Scraper: scan performance.getEntriesByType('resource')
  // across the page and accessible frames on page load, on video play, and whenever popup opens
  const pageResources = scrapePerformanceResources();
  const frameData = scrapeFrames();

  return {
    type: "tracks",
    page: { title: document.title, url: location.href, referer: document.referrer, userAgent: navigator.userAgent },
    videos,
    tracks,
    pageResources,
    frames: frameData,
  };
}

function post() {
  try {
    chrome.runtime.sendMessage(collect());
  } catch {
    // extension reloaded
  }
}

post();
const obs = new MutationObserver(() => post());
obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srclang"] });
setInterval(post, 4000);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "pauseVideos") {
    for (const v of document.querySelectorAll("video")) {
      try { v.pause(); } catch { /* ignore */ }
    }
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "getVideoState") {
    const videos = [...document.querySelectorAll("video")].map((el, index) => {
      let src = "";
      try { src = el.currentSrc || el.src || ""; } catch { src = ""; }
      return {
        index,
        src,
        currentTime: el.currentTime || 0,
        duration: el.duration || 0,
        paused: el.paused,
      };
    }).filter(v => v.src);
    sendResponse({ videos });
    return;
  }
  if (msg.type === "scan") {
    sendResponse(collect());
  }
});

(async function autoIntercept() {
  try {
    const cfg = (await chrome.storage.sync.get(["autoIntercept", "autoInterceptDomains"]));
    if (!cfg.autoIntercept) return;
    const host = location.hostname;
    const list = cfg.autoInterceptDomains || [];
    const match = list.length === 0 || list.some((d) => host === d || host.endsWith("." + d));
    if (!match) return;
    const data = collect();
    const url = (data.videos[0] && data.videos[0].src) || location.href;
    for (const v of document.querySelectorAll("video")) {
      try { v.pause(); } catch { /* ignore */ }
    }
    chrome.runtime.sendMessage({ type: "pauseAndHandoff", url });
  } catch {
    // storage unavailable
  }
})();