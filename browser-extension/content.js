"use strict";

(() => {
if (globalThis.__empvContentInstalled) return;
globalThis.__empvContentInstalled = true;

const RESOURCE_RE = /\.(m3u8|mpd|vtt|srt)(?:$|[?#])/i;
const MANIFEST_RE = /\.(m3u8|mpd)(?:$|[?#])/i;

function safeRuntimeSendMessage(message) {
  try {
    const pending = chrome.runtime.sendMessage(message);
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
    return pending;
  } catch {
    return Promise.resolve(undefined);
  }
}

const MIN_VIDEO_WIDTH = 320;
const MIN_VIDEO_HEIGHT = 180;
const HOVER_PILL_ID = "__empv_hover_pill";
const HOVER_PILL_STYLES = `
  position: fixed;
  z-index: 2147483647;
  pointer-events: auto;
  background: linear-gradient(180deg, #0D1117 0%, #161B22 100%);
  border: 1px solid #4ADE80;
  border-radius: 6px;
  padding: 6px 10px;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", system-ui, sans-serif;
  font-size: 11px;
  font-weight: 600;
  color: #4ADE80;
  box-shadow: 0 4px 16px rgba(0,0,0,0.6), 0 0 0 1px rgba(74,222,128,0.2);
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity 120ms ease, transform 120ms ease;
  white-space: nowrap;
`;
const HOVER_PILL_HOVER_STYLES = `
  opacity: 1;
  transform: translateY(0);
`;
const HOVER_PILL_READY_STYLES = `
  background: linear-gradient(180deg, #0D1117 0%, #161B22 100%);
  border-color: #4ADE80;
  color: #4ADE80;
`;

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
    await safeRuntimeSendMessage(await collect());
  } catch {
    // extension reloaded
  }
}

// ============================================================================
// Shadow-DOM Hover Pill for Manual Instant Launch
// ============================================================================

let hoverPill = null;
let hoverPillVideo = null;
let hoverPillHideTimer = null;
let hoverPillText = null;
let hoverPillSub = null;
let shadowReady = false;

function createHoverPill() {
  if (hoverPill) return hoverPill;

  const host = document.createElement("div");
  host.id = HOVER_PILL_ID;
  host.setAttribute("role", "button");
  host.setAttribute("tabindex", "0");
  host.setAttribute("title", "Open this video in Enhanced MPV");

  // Closed Shadow DOM keeps page CSS out. All styling lives in :host so the
  // .visible / .ready class toggles actually apply.
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host {
      ${HOVER_PILL_STYLES}
    }
    :host(.visible) {
      ${HOVER_PILL_HOVER_STYLES}
    }
    :host(.ready) {
      ${HOVER_PILL_READY_STYLES}
    }
    .pill-icon { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; opacity: 0.9; }
    .pill-text { font-weight: 700; letter-spacing: 0.04em; }
    .pill-sub { font-size: 10px; font-weight: 400; opacity: 0.8; }
  `;
  shadow.appendChild(style);

  const icon = document.createElement("span");
  icon.className = "pill-icon";
  icon.textContent = "MPV";
  const text = document.createElement("span");
  text.className = "pill-text";
  text.textContent = shadowReady ? "SHADOW READY" : "OPEN IN MPV";
  const sub = document.createElement("span");
  sub.className = "pill-sub";
  sub.textContent = shadowReady ? "Click for instant Frame 1" : "Click to launch";

  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:6px;";
  row.append(icon, text, sub);
  shadow.appendChild(row);

  // Click handler - sends TAKEOVER_PAUSE to background and launches.
  host.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    handlePillClick();
  });
  host.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handlePillClick();
    }
  });

  document.body.appendChild(host);
  hoverPill = host;
  hoverPillText = text;
  hoverPillSub = sub;
  return host;
}

function updateHoverPillPosition(video) {
  if (!hoverPill || !video) return;
  const rect = video.getBoundingClientRect();
  const scrollX = window.scrollX || window.pageXOffset;
  const scrollY = window.scrollY || window.pageYOffset;
  
  // Position at top-right of video
  hoverPill.style.left = (rect.right + scrollX - hoverPill.offsetWidth - 8) + "px";
  hoverPill.style.top = (rect.top + scrollY + 8) + "px";
}

function showHoverPill(video) {
  if (!hoverPill) createHoverPill();
  hoverPillVideo = video;
  updateHoverPillPosition(video);
  
  // Add visible class for animation
  requestAnimationFrame(() => {
    hoverPill.classList.add("visible");
  });
  
  if (shadowReady) {
    hoverPill.classList.add("ready");
  }
  
  // Auto-hide after 3 seconds of no mouse movement over video
  clearTimeout(hoverPillHideTimer);
  hoverPillHideTimer = setTimeout(() => {
    hideHoverPill();
  }, 3000);
}

function hideHoverPill() {
  if (!hoverPill) return;
  hoverPill.classList.remove("visible");
  hoverPillVideo = null;
  clearTimeout(hoverPillHideTimer);
}

function handlePillClick() {
  if (!hoverPillVideo) return;
  
  // Immediately pause and mute the browser video to release bandwidth
  const video = hoverPillVideo;
  video.pause();
  video.muted = true;
  
  // Send TAKEOVER_PAUSE to background for instant launch
  safeRuntimeSendMessage({
    type: "TAKEOVER_PAUSE",
    videoUrl: video.currentSrc || video.src,
    currentTime: video.currentTime,
    duration: video.duration,
  });
  
  hideHoverPill();
}

function updateShadowReady(ready) {
  shadowReady = ready;
  if (!hoverPill) return;
  if (ready) {
    hoverPill.classList.add("ready");
    if (hoverPillText) hoverPillText.textContent = "SHADOW READY";
    if (hoverPillSub) hoverPillSub.textContent = "Click for instant Frame 1";
  } else {
    hoverPill.classList.remove("ready");
    if (hoverPillText) hoverPillText.textContent = "OPEN IN MPV";
    if (hoverPillSub) hoverPillSub.textContent = "Click to launch";
  }
}

// Track mouse over video elements for hover pill
let currentHoverVideo = null;

function attachVideoHoverListeners() {
  const videos = document.querySelectorAll("video");
  videos.forEach(video => {
    if (video.dataset.empvHoverAttached) return;

    video.dataset.empvHoverAttached = "true";

    video.addEventListener("mouseenter", () => {
      if (video.videoWidth < MIN_VIDEO_WIDTH || video.videoHeight < MIN_VIDEO_HEIGHT) return;
      currentHoverVideo = video;
      clearTimeout(hoverPillHideTimer);
      showHoverPill(video);
    });
    
    video.addEventListener("mousemove", () => {
      if (currentHoverVideo === video) {
        clearTimeout(hoverPillHideTimer);
        updateHoverPillPosition(video);
        hoverPillHideTimer = setTimeout(() => {
          hideHoverPill();
        }, 3000);
      }
    });
    
    video.addEventListener("mouseleave", () => {
      if (currentHoverVideo === video) {
        currentHoverVideo = null;
        hoverPillHideTimer = setTimeout(() => {
          hideHoverPill();
        }, 500);
      }
    });
  });
}

// Observe new video elements
const videoObserver = new MutationObserver(() => {
  attachVideoHoverListeners();
});
videoObserver.observe(document.documentElement, { childList: true, subtree: true });

// Initial attach
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", attachVideoHoverListeners);
} else {
  attachVideoHoverListeners();
}

// Listen for shadow ready updates from background
chrome.runtime.onMessage.addListener((msg, _sender) => {
  if (msg.type === "shadowReady") {
    updateShadowReady(msg.ready);
  }
});

// Handle TAKEOVER_PAUSE - immediately pause and mute all videos
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "TAKEOVER_PAUSE") {
    for (const v of deepVideos()) {
      try {
        v.pause();
        v.muted = true;
      } catch { /* ignore */ }
    }
    // Also notify MAIN-world hook
    document.dispatchEvent(new CustomEvent("__empv_media_req", {
      detail: JSON.stringify({ id: "takeover-" + Date.now(), op: "pauseAll" })
    }));
    sendResponse({ ok: true });
    return true;
  }
});

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
    await post();
    sendResponse({ ok: true });
    return true;
  }
});

window.addEventListener("message", async (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "content-extractor") return;

  if (data.type === "EMPV_STREAM_EXTRACTED" && data.data) {
    safeRuntimeSendMessage({
      type: "extractedStreams",
      data: data.data,
    });
  } else if (data.type === "EMPV_MANIFEST_URL" && data.url) {
    safeRuntimeSendMessage({
      type: "manifestUrl",
      url: data.url,
      playerType: data.playerType,
      timestamp: data.timestamp,
    });
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
    await safeRuntimeSendMessage(handoff);
  } catch {
    // storage unavailable
  }
})();
})();
