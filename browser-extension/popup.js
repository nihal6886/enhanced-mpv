"use strict";

function $(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "\u0026")
    .replace(/</g, "\u003C")
    .replace(/>/g, "\u003E")
    .replace(/"/g, "\u0022");
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.hostname + x.pathname.slice(0, 48);
  } catch {
    return String(u).slice(0, 64);
  }
}

// Clear stream quality badges (4K / 1080p / HLS / YT-DLP) derived from the URL.
// Adds AUDIO+VIDEO badge for verified master manifests with audio, or video-only with paired audio.
// Adds VIDEO ONLY ⚠ warning for video-only sub-playlists without paired audio.
function qualityBadges(it) {
  const u = String(it.url || "").toLowerCase();
  const badges = [];
  if (it.primary || it.type === "ytdlp") badges.push({ text: "YT-DLP", class: "" });
  if (/2160|4k|uhd/.test(u)) badges.push({ text: "4K", class: "" });
  else if (/1080|fhd/.test(u)) badges.push({ text: "1080p", class: "" });
  else if (/720/.test(u)) badges.push({ text: "720p", class: "" });
  if (/\.m3u8/.test(u)) badges.push({ text: "HLS", class: "" });
  else if (/\.mpd/.test(u)) badges.push({ text: "DASH", class: "" });
  else if (/\.(mp4|mkv|webm)/.test(u)) badges.push({ text: "FILE", class: "" });
  if (badges.length === 0 && it.type) badges.push({ text: String(it.type).toUpperCase(), class: "" });

  // AUDIO+VIDEO badge for verified master manifests with audio track
  if (it.isVerifiedMaster === true || (it.verified === true && it.kind === "hls-master")) {
    const manifestInfo = it.manifestInfo || {};
    if (manifestInfo.hasAudio === true) {
      badges.push({ text: "AUDIO+VIDEO", class: "audio-video" });
    }
  }
  // AUDIO+VIDEO badge for video-only that successfully paired with audio
  else if (it.kind === "hls-video-only" && it.audioUrl) {
    badges.push({ text: "AUDIO+VIDEO", class: "audio-video" });
  }
  // VIDEO ONLY warning for video-only sub-playlists without paired audio
  else if (it.kind === "hls-video-only" && !it.audioUrl) {
    badges.push({ text: "VIDEO ONLY ⚠", class: "video-only" });
  }

  return badges.slice(0, 3).map((b) => '<span class="quality-tag ' + escapeHtml(b.class) + '">' + escapeHtml(b.text) + "</span>").join("");
}

const COPY_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">'
  + '<rect x="5" y="5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/>'
  + '<path d="M3.5 10.5V3.5a1 1 0 0 1 1-1h7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

function renderList(el, items, empty) {
  if (!items || items.length === 0) {
    el.textContent = empty;
    el.classList.add("muted");
    return;
  }
  el.classList.remove("muted");
  el.innerHTML = items.map((it, i) => {
    const tag = it.label || it.language || "";
    const text = it.primary && it.label ? it.label : shortUrl(it.url);
    return '<div class="stream-row' + (it.primary ? " primary" : "") + '">'
      + '<input type="radio" name="stream" value="' + i + '"' + (i === 0 ? " checked" : "") + " />"
      + '<span class="stream-text" title="' + escapeHtml(it.url) + '">' + escapeHtml(text) + "</span>"
      + (it.primary && tag ? '<span class="muted small">' + escapeHtml(tag) + "</span>" : "")
      + '<span class="quality">' + qualityBadges(it) + "</span>"
      + '<button type="button" class="copy-url" data-url="' + escapeHtml(it.url) + '"'
      + ' title="Copy stream URL" aria-label="Copy stream URL">' + COPY_ICON + "</button>"
      + "</div>";
  }).join("");
}

function bindList(el) {
  el.addEventListener("click", async (e) => {
    const copy = e.target.closest(".copy-url");
    if (copy) {
      e.preventDefault();
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(copy.getAttribute("data-url") || "");
        copy.classList.add("copied");
        setTimeout(() => copy.classList.remove("copied"), 1200);
      } catch {
        // clipboard unavailable
      }
      return;
    }
    const row = e.target.closest(".stream-row");
    const radio = row && row.querySelector('input[name="stream"]');
    if (radio) radio.checked = true;
  });
}

function showError(result) {
  if (!result || result.ok) {
    $("errorBox").hidden = true;
    return;
  }
  $("errorBox").hidden = false;
  const why = result.code === "DRM"
    ? "This stream looks DRM-protected or the token was rejected. Enhanced MPV cannot decrypt Widevine/PlayReady."
    : result.code === "EXPIRED"
      ? "The media URL or cookie expired. Refresh the page and launch again."
      : result.code === "MPV_NOT_FOUND"
        ? "mpv is not installed or not on PATH. Run the installer script."
        : (result.error || "mpv failed to open the stream.");
  $("errorText").textContent = why;
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

// Confirm native host reachability and whether this extension id is registered.
async function refreshLinkStatus() {
  const dot = $("linkDot");
  const btn = $("linkExtension");
  const text = $("linkText");
  const res = await chrome.runtime.sendMessage({ type: "native", payload: { action: "getConfig" } });
  const linked = Boolean(res && res.ok && res.config && res.config.extensionId === chrome.runtime.id);
  dot.classList.toggle("connected", linked);
  dot.classList.toggle("offline", !linked);
  btn.hidden = linked;
  text.textContent = linked ? "Connected" : (res && res.ok ? "Not linked" : "Host offline");
  return linked;
}

// A proxy video (m3u8_proxy/video/...) without paired audio should trigger an
// all-frame audio scan when the popup opens.
function needsAudioScan(state) {
  if (!state || !Array.isArray(state.videos)) return false;
  return state.videos.some(v => /m3u8_proxy\/video\//i.test(v.url || "") && v.kind === "hls-video-only" && !v.audioUrl);
}

async function load() {
  const tab = await activeTab();
  if (!tab) return;
  $("pageTitle").textContent = tab.title || tab.url || "";
  let state = await chrome.runtime.sendMessage({ type: "getState", tabId: tab.id });
  // If a proxy video has no audio yet, scan all frames and pair the sibling audio.
  if (needsAudioScan(state)) {
    const rescanned = await chrome.runtime.sendMessage({ type: "scanAudio", tabId: tab.id, pageUrl: tab.url });
    if (rescanned) state = rescanned;
  }
  const videos = (state && state.videos) || [];
  const subs = (state && state.subs) || [];
  renderList($("videos"), videos, "None yet. Play the page video once.");
  renderList($("subs"), subs, "None captured.");
  $("count").textContent = String(videos.length + subs.length);
  const sync = await chrome.storage.sync.get(["autoIntercept", "autoPlay"]);
  $("autoIntercept").checked = Boolean(sync.autoIntercept);
  $("autoPlay").checked = sync.autoPlay !== false;
  await refreshLinkStatus();
  const last = (await chrome.storage.local.get("lastLaunch")).lastLaunch;
  if (last && last.result) showError(last.result);
}

// Pre-warm mpv and relay on DOMContentLoaded for zero-latency launch
document.addEventListener("DOMContentLoaded", () => {
  chrome.runtime.sendMessage({ type: "native", payload: { action: "prewarm" } });
});

load();

async function selectedUrl() {
  const tab = await activeTab();
  const state = await chrome.runtime.sendMessage({ type: "getState", tabId: tab.id });
  const radio = document.querySelector("input[name=stream]:checked");
  const idx = radio ? Number(radio.value) : 0;
  if (state && state.videos && state.videos[idx]) return state.videos[idx].url;
  return tab.url;
}

async function pauseBrowserVideos(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "pauseVideos" });
  } catch {
    // content script not present on this page
  }
}

// Injected into every frame (allFrames: true): report every <video> (light
// DOM, open shadow roots, and closed shadow roots via the MAIN-world media
// hook) with currentTime/duration/area/readyState so the popup can recover the
// playback position from iframe and Shadow DOM players. Must stay
// self-contained: executeScript serializes only this function.
async function collectPlaybackFrame() {
  const finite = (n) => { const v = Number(n); return Number.isFinite(v) ? v : 0; };
  const deep = (root, out) => {
    try {
      for (const el of root.querySelectorAll("*")) {
        if (el instanceof HTMLVideoElement) out.push(el);
        if (el.shadowRoot) deep(el.shadowRoot, out);
      }
    } catch { /* ignore */ }
    return out;
  };
  let videos = [];
  try {
    videos = deep(document, []).map((v, index) => {
      const rect = v.getBoundingClientRect();
      let src = "";
      try { src = v.currentSrc || v.src || ""; } catch { src = ""; }
      return {
        index,
        src,
        currentTime: finite(v.currentTime),
        duration: finite(v.duration),
        area: Math.max(0, rect.width || 0) * Math.max(0, rect.height || 0),
        readyState: Number(v.readyState) || 0,
        paused: Boolean(v.paused),
        ended: Boolean(v.ended),
      };
    });
  } catch {
    // ignore inaccessible frames
  }
  try {
    const id = "p" + Date.now() + Math.random();
    const reply = await new Promise((resolve) => {
      const onRes = (e) => {
        try { const d = JSON.parse(String(e.detail || "{}")); if (d.id === id) resolve(d); } catch { /* ignore */ }
      };
      document.addEventListener("__empv_media_res", onRes);
      document.dispatchEvent(new CustomEvent("__empv_media_req", { detail: JSON.stringify({ id, op: "state" }) }));
      // Timeout fallback
      setTimeout(() => {
        document.removeEventListener("__empv_media_res", onRes);
        resolve(null);
      }, 100);
    });
    for (const m of (reply && reply.media) || []) {
      if (m.isVideo === false) continue;
      const dup = videos.find((v) => v.hookId == null && v.src === m.src && Math.abs(v.currentTime - m.currentTime) < 1);
      if (dup) { dup.hookId = m.hookId; continue; }
      videos.push({
        index: -1,
        hookId: m.hookId,
        src: m.src || "",
        currentTime: finite(m.currentTime),
        duration: finite(m.duration),
        area: finite(m.area),
        readyState: Number(m.readyState) || 0,
        paused: Boolean(m.paused),
        ended: Boolean(m.ended),
      });
    }
  } catch {
    // media hook unavailable
  }
  let frameUrl = "";
  try { frameUrl = (typeof location !== "undefined" && location.href) || ""; } catch { frameUrl = ""; }
  return { frameUrl, videos };
}

// Injected into a single frame: pause the exact media element the popup
// selected (through the MAIN-world hook for closed Shadow DOM players).
async function pausePlaybackFrame(target) {
  let done = false;
  if (target.hookId != null) {
    try {
      const id = "p" + Date.now() + Math.random();
      const reply = await new Promise((resolve) => {
        const onRes = (e) => {
          try { const d = JSON.parse(String(e.detail || "{}")); if (d.id === id) resolve(d); } catch { /* ignore */ }
        };
        document.addEventListener("__empv_media_res", onRes);
        document.dispatchEvent(new CustomEvent("__empv_media_req", {
          detail: JSON.stringify({ id, op: "pause", hookId: target.hookId }),
        }));
        setTimeout(() => {
          document.removeEventListener("__empv_media_res", onRes);
          resolve(null);
        }, 100);
      });
      done = Boolean(reply && reply.paused > 0);
    } catch {
      // media hook unavailable
    }
  }
  try {
    const deep = (root, out) => {
      try {
        for (const el of root.querySelectorAll("*")) {
          if (el instanceof HTMLVideoElement) out.push(el);
          if (el.shadowRoot) deep(el.shadowRoot, out);
        }
      } catch { /* ignore */ }
      return out;
    };
    const nodes = deep(document, []);
    let chosen = null;
    let bestDiff = Infinity;
    for (const el of nodes) {
      let src = "";
      try { src = el.currentSrc || el.src || ""; } catch { src = ""; }
      if (src !== target.src) continue;
      const diff = Math.abs((Number(el.currentTime) || 0) - target.currentTime);
      if (diff < bestDiff) {
        bestDiff = diff;
        chosen = el;
      }
    }
    if ((!chosen || bestDiff >= 3) && target.index >= 0) chosen = nodes[target.index];
    if (chosen) {
      try { chosen.pause(); } catch { /* ignore */ }
      done = true;
    }
  } catch {
    // ignore
  }
  return done;
}

// Collect playback state from the top frame AND every iframe in the tab.
async function collectPlaybackFrames(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: collectPlaybackFrame,
    });
    return Array.isArray(results) ? results : [];
  } catch {
    return [];
  }
}

function frameHost(url) {
  try { return new URL(url).host; } catch { return ""; }
}

// Resume only from a real mid-playback position: > 3 s in, a finite duration
// over 15 s, and at least 10 s before the end (same bounds as the host).
function isResumable(v) {
  return Number.isFinite(v.currentTime) && Number.isFinite(v.duration) &&
    v.currentTime > 3 && v.duration > 15 && v.currentTime < v.duration - 10;
}

// Pick the true visible player: visible first, then playing, then largest
// area, highest readyState, longest duration. With resumableOnly=false, fall
// back to the best long video (to pause it).
function pickBestPlayback(results, resumableOnly = true) {
  const candidates = [];
  for (const r of results) {
    if (!r || r.error || !r.result) continue;
    const frame = r.result;
    for (const v of (frame.videos || [])) {
      if (v.ended || !(v.duration > 15)) continue;
      if (resumableOnly && !isResumable(v)) continue;
      candidates.push({ ...v, frameId: r.frameId, frameUrl: frame.frameUrl });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) =>
    ((b.area || 0) > 0) - ((a.area || 0) > 0) ||
    (!b.paused) - (!a.paused) ||
    (b.area || 0) - (a.area || 0) ||
    (b.readyState || 0) - (a.readyState || 0) ||
    b.duration - a.duration);
  return candidates[0];
}

// Fallback: ask content.js (GET_VIDEO_STATE / "getVideoState") in every frame
// individually; a tab-wide sendMessage only returns the first frame's reply,
// which is usually the top frame with no player.
async function videoStateAcrossFrames(tabId, frameIds) {
  const ids = [...new Set(frameIds.filter((id) => Number.isInteger(id)))];
  const asks = ids.length
    ? ids.map((frameId) => chrome.tabs.sendMessage(tabId, { type: "getVideoState" }, { frameId })
      .then((state) => ({ frameId, result: { frameUrl: "", videos: (state && state.videos) || [] } })))
    : [chrome.tabs.sendMessage(tabId, { type: "getVideoState" })
      .then((state) => ({ frameId: 0, result: { frameUrl: "", videos: (state && state.videos) || [] } }))];
  const settled = await Promise.allSettled(asks);
  return settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
}

// Pause the selected video inside its own frame so the browser stops decoding.
async function pausePlaybackInFrame(tabId, best) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [best.frameId] },
      func: pausePlaybackFrame,
      args: [{ src: best.src, currentTime: best.currentTime, index: best.index, hookId: best.hookId }],
    });
  } catch {
    // frame may have navigated away
  }
}

async function go(action, explicitUrl) {
  const progressEl = $("launchProgress");
  const primaryActions = document.querySelector(".primary-actions");
  
  // Show progress indicator immediately (< 16ms)
  if (primaryActions) primaryActions.style.display = "none";
  if (progressEl) {
    progressEl.hidden = false;
    // Reset all steps
    progressEl.querySelectorAll(".progress-step").forEach(step => {
      step.classList.remove("active", "done");
    });
  }

  // Step 1: Pausing browser player
  setStep(progressEl, 1, "active");
  const tab = await activeTab();
  let startTime;
  let duration;
  let startTimeSource = "none";
  if (tab && tab.id != null) {
    // Recover playback position from every frame (works for iframe players like
    // febbox.com / ShowBox / CineSrc where the top frame reports currentTime 0).
    const results = await collectPlaybackFrames(tab.id);
    let best = pickBestPlayback(results);
    let via = "executeScript";
    if (!best) {
      const states = await videoStateAcrossFrames(tab.id, results.map((r) => r && r.frameId));
      best = pickBestPlayback(states);
      via = "getVideoState";
    }
    if (best) {
      startTime = best.currentTime;
      duration = best.duration;
      startTimeSource = via + " frame=" + best.frameId + (best.frameUrl ? " host=" + frameHost(best.frameUrl) : "");
    }
    const toPause = best || pickBestPlayback(results, false);
    if (toPause && (toPause.src || toPause.hookId != null)) {
      await pausePlaybackInFrame(tab.id, toPause);
    } else if (toPause) {
      try { await chrome.tabs.sendMessage(tab.id, { type: "pauseVideos" }, { frameId: toPause.frameId }); } catch { /* no content script */ }
    } else if ($("autoPlay").checked) {
      await pauseBrowserVideos(tab.id);
    }
  }

  // Step 2: Handing off to native host
  setStep(progressEl, 1, "done");
  setStep(progressEl, 2, "active");
  
  const url = explicitUrl || await selectedUrl();
  const out = await chrome.runtime.sendMessage({
    type: "launch",
    url,
    action,
    startTime,
    duration,
    startTimeSource,
  });
  
  // Step 3: Opening Enhanced MPV
  setStep(progressEl, 2, "done");
  setStep(progressEl, 3, "active");
  
  // Brief delay to show completion, then close
  await new Promise(r => setTimeout(r, 200));
  setStep(progressEl, 3, "done");
  
  // Hide progress and restore buttons
  await new Promise(r => setTimeout(r, 100));
  if (progressEl) progressEl.hidden = true;
  if (primaryActions) primaryActions.style.display = "";
  
  $("play").disabled = false;
  showError(out && out.result);
}

function setStep(container, stepNum, state) {
  if (!container) return;
  const step = container.querySelector(`.progress-step[data-step="${stepNum}"]`);
  if (step) {
    step.classList.remove("active", "done");
    step.classList.add(state);
  }
}

$("play").addEventListener("click", () => go("play"));
$("queue").addEventListener("click", () => go("queue"));
$("fallback").addEventListener("click", async () => {
  const tab = await activeTab();
  if (tab && tab.url) await go("play", tab.url);
});
$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("autoIntercept").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ autoIntercept: e.target.checked });
});
$("autoPlay").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ autoPlay: e.target.checked });
});
$("copyCmd").addEventListener("click", async () => {
  const last = await chrome.runtime.sendMessage({ type: "copyCommand" });
  const cmd = last && last.result && last.result.command
    ? last.result.command.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")
    : "";
  if (!cmd) return;
  await navigator.clipboard.writeText(cmd);
  $("copyCmd").textContent = "Copied";
  setTimeout(() => { $("copyCmd").textContent = "Copy mpv CLI command"; }, 1500);
});

$("linkExtension").addEventListener("click", async () => {
  const btn = $("linkExtension");
  const text = $("linkText");
  btn.disabled = true;
  text.textContent = "Linking...";
  const res = await chrome.runtime.sendMessage({ type: "linkExtension" });
  if (res && res.ok) {
    text.textContent = "Linked to native host";
  } else {
    text.textContent = "Native host not reachable yet";
    showError(res || { ok: false, error: "Run the installer first", code: "HOST_ERROR" });
  }
  btn.disabled = false;
  await refreshLinkStatus();
});

bindList($("videos"));
bindList($("subs"));
