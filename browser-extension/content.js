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

const HOOK_REQ = "__empv_media_req";
const HOOK_RES = "__empv_media_res";
let hookSeq = 0;

// Async request to the MAIN-world media hook (media-hook.js).
// Returns a Promise that resolves with the reply or null on timeout/absence.
function hookRequest(op, extra) {
  return new Promise((resolve) => {
    const id = "c" + (++hookSeq) + "-" + Date.now();
    let settled = false;
    const onRes = (event) => {
      try {
        const data = JSON.parse(String(event.detail || "{}"));
        if (data && data.id === id) {
          settled = true;
          document.removeEventListener(HOOK_RES, onRes);
          resolve(data);
        }
      } catch {
        // ignore foreign events
      }
    };
    document.addEventListener(HOOK_RES, onRes);
    try {
      document.dispatchEvent(new CustomEvent(HOOK_REQ, { detail: JSON.stringify({ id, op, ...(extra || {}) }) }));
    } catch {
      // ignore
    }
    // Timeout fallback: MAIN-world hook may be absent (e.g. older Firefox)
    setTimeout(() => {
      if (!settled) {
        settled = true;
        document.removeEventListener(HOOK_RES, onRes);
        resolve(null);
      }
    }, 100);
  });
}

// Every <video> in the document and in open shadow roots (closed roots are
// covered by the MAIN-world hook).
function deepVideos(root, out) {
  const list = out || [];
  const scope = root || document;
  try {
    for (const el of scope.querySelectorAll("*")) {
      if (el instanceof HTMLVideoElement) list.push(el);
      if (el.shadowRoot) deepVideos(el.shadowRoot, list);
    }
  } catch {
    // ignore inaccessible roots
  }
  return list;
}

function elementArea(el) {
  try {
    const r = el.getBoundingClientRect();
    return Math.max(0, r.width) * Math.max(0, r.height);
  } catch {
    return 0;
  }
}

function finiteOrZero(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

// Merge DOM-visible videos with hook-registered media so closed Shadow DOM
// players are reported with their true playback position.
async function videoState() {
  const videos = deepVideos().map((el, index) => {
    let src = "";
    try { src = el.currentSrc || el.src || ""; } catch { src = ""; }
    return {
      index,
      src,
      currentTime: finiteOrZero(el.currentTime),
      duration: finiteOrZero(el.duration),
      paused: Boolean(el.paused),
      ended: Boolean(el.ended),
      readyState: el.readyState || 0,
      area: elementArea(el),
    };
  });
  const hook = await hookRequest("state");
  const hooked = (hook && Array.isArray(hook.media) ? hook.media : []).filter((m) => m.isVideo !== false);
  for (const m of hooked) {
    const dup = videos.find((v) => v.hookId == null && v.src === m.src &&
      Math.abs(v.currentTime - m.currentTime) < 1);
    if (dup) {
      dup.hookId = m.hookId;
      continue;
    }
    videos.push({
      index: -1,
      hookId: m.hookId,
      src: m.src,
      currentTime: finiteOrZero(m.currentTime),
      duration: finiteOrZero(m.duration),
      paused: Boolean(m.paused),
      ended: Boolean(m.ended),
      readyState: m.readyState || 0,
      area: finiteOrZero(m.area),
    });
  }
  return videos;
}

async function pauseAllMedia() {
  await hookRequest("pause");
  for (const v of deepVideos()) {
    try { v.pause(); } catch { /* ignore */ }
  }
}

// Resume only from a real mid-playback position: > 3 s in, a finite duration
// over 15 s, and at least 10 s before the end.
function isResumable(v) {
  return Number.isFinite(v.currentTime) && Number.isFinite(v.duration) &&
    v.currentTime > 3 && v.duration > 15 && v.currentTime < v.duration - 10;
}

function bestVideo(videos) {
  const ranked = videos
    .filter((v) => !v.ended && v.duration > 0)
    .sort((a, b) =>
      (b.area > 0) - (a.area > 0) ||
      (!b.paused) - (!a.paused) ||
      b.area - a.area ||
      b.readyState - a.readyState ||
      b.duration - a.duration);
  return ranked[0] || null;
}

async function collect() {
  const videos = (await videoState()).map((v) => {
    // Skip hidden videos, ads, invalid/zero duration, or already-ended videos
    if (!(v.area > 0)) return null;
    if (v.ended || !(v.duration > 0)) return null;
    return {
      src: v.src,
      paused: v.paused,
      duration: v.duration,
      currentTime: v.currentTime,
    };
  }).filter((v) => v && v.src && !v.src.startsWith("blob:"));
  // Ad overlays are still excluded when the DOM can see them.
  for (const el of document.querySelectorAll(".ad-showing video, .ad-interrupting video")) {
    const src = el.currentSrc || el.src || "";
    const i = videos.findIndex((v) => v.src === src);
    if (i >= 0) videos.splice(i, 1);
  }

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

async function post() {
  try {
    chrome.runtime.sendMessage(await collect());
  } catch {
    // extension reloaded
  }
}

post();
const obs = new MutationObserver(() => post());
obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srclang"] });
setInterval(post, 4000);

chrome.runtime.onMessage.addListener(async (msg, _sender, sendResponse) => {
  if (msg.type === "pauseVideos") {
    pauseAllMedia().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "getVideoState") {
    videoState().then(videos => sendResponse({ videos: videos.filter((v) => v.src || v.hookId != null) }));
    return true;
  }
  if (msg.type === "scan") {
    sendResponse(await collect());
    return true;
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
    const data = await collect();
    const url = (data.videos[0] && data.videos[0].src) || location.href;
    const best = bestVideo(await videoState());
    await pauseAllMedia();
    const handoff = { type: "pauseAndHandoff", url };
    if (best && isResumable(best)) {
      handoff.startTime = best.currentTime;
      handoff.duration = best.duration;
      handoff.startTimeSource = "autoIntercept";
    }
    chrome.runtime.sendMessage(handoff);
  } catch {
    // storage unavailable
  }
})();
