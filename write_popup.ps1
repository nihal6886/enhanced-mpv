$content = @"
`"use strict`";

function `$`(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s == null ? `""` : s)
    .replace(/&/g, `&`)
    .replace(/</g, `<`)
    .replace(/>/g, `>`)
    .replace(/"/g, `"`);
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
function qualityBadges(it) {
  const u = String(it.url || `""`).toLowerCase();
  const badges = [];
  if (it.primary || it.type === `"ytdlp"`) badges.push(`"YT-DLP"`);
  if (/2160|4k|uhd/.test(u)) badges.push(`"4K"`);
  else if (/1080|fhd/.test(u)) badges.push(`"1080p"`);
  else if (/720/.test(u)) badges.push(`"720p"`);
  if (/\.m3u8/.test(u)) badges.push(`"HLS"`);
  else if (/\.mpd/.test(u)) badges.push(`"DASH"`);
  else if (/\.(mp4|mkv|webm)/.test(u)) badges.push(`"FILE"`);
  if (badges.length === 0 && it.type) badges.push(String(it.type).toUpperCase());
  return badges.slice(0, 3).map((b) => '<span class="quality-tag">' + escapeHtml(b) + "</span>").join(`""`);
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
    const tag = it.label || it.language || `""`;
    const text = it.primary && it.label ? it.label : shortUrl(it.url);
    return '<div class="stream-row' + (it.primary ? " primary" : "") + '">'
      + '<input type="radio" name="stream" value="' + i + '"' + (i === 0 ? " checked" : "") + " />"
      + '<span class="stream-text" title="' + escapeHtml(it.url) + '">' + escapeHtml(text) + "</span>"
      + (it.primary && tag ? '<span class="muted small">' + escapeHtml(tag) + "</span>" : "")
      + '<span class="quality">' + qualityBadges(it) + "</span>"
      + '<button type="button" class="copy-url" data-url="' + escapeHtml(it.url) + '"'
      + ' title="Copy stream URL" aria-label="Copy stream URL">' + COPY_ICON + "</button>"
      + "</div>";
  }).join(`""`);
}

function bindList(el) {
  el.addEventListener("click", async (e) => {
    const copy = e.target.closest(".copy-url");
    if (copy) {
      e.preventDefault();
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(copy.getAttribute("data-url") || `""`);
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
    `$`("errorBox").hidden = true;
    return;
  }
  `$`("errorBox").hidden = false;
  const why = result.code === `"DRM"`
    ? `"This stream looks DRM-protected or the token was rejected. Enhanced MPV cannot decrypt Widevine/PlayReady."`
    : result.code === `"EXPIRED"`
      ? `"The media URL or cookie expired. Refresh the page and launch again."`
      : result.code === `"MPV_NOT_FOUND"`
        ? `"mpv is not installed or not on PATH. Run the installer script."`
        : (result.error || `"mpv failed to open the stream."`);
  `$`("errorText").textContent = why;
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

// Confirm native host reachability and whether this extension id is registered.
async function refreshLinkStatus() {
  const dot = `$`("linkDot");
  const btn = `$`("linkExtension");
  const text = `$`("linkText");
  const res = await chrome.runtime.sendMessage({ type: `"native"`, payload: { action: `"getConfig"` } });
  const linked = Boolean(res && res.ok && res.config && res.config.extensionId === chrome.runtime.id);
  dot.classList.toggle("connected", linked);
  dot.classList.toggle("offline", !linked);
  btn.hidden = linked;
  text.textContent = linked ? `"Connected"` : (res && res.ok ? `"Not linked"` : `"Host offline"`);
  return linked;
}

async function load() {
  const tab = await activeTab();
  if (!tab) return;
  `$`("pageTitle").textContent = tab.title || tab.url || `""`;
  const state = await chrome.runtime.sendMessage({ type: `"getState"`, tabId: tab.id });
  const videos = (state && state.videos) || [];
  const subs = (state && state.subs) || [];
  renderList(`$`("videos"), videos, `"None yet. Play the page video once."`);
  renderList(`$`("subs"), subs, `"None captured."`);
  `$`("count").textContent = String(videos.length + subs.length);
  const sync = await chrome.storage.sync.get(["autoIntercept", "autoPlay"]);
  `$`("autoIntercept").checked = Boolean(sync.autoIntercept);
  `$`("autoPlay").checked = sync.autoPlay !== false;
  await refreshLinkStatus();
  const last = (await chrome.storage.local.get("lastLaunch")).lastLaunch;
  if (last && last.result) showError(last.result);
}

// Pre-warm mpv and relay on DOMContentLoaded for zero-latency launch
document.addEventListener("DOMContentLoaded", () => {
  chrome.runtime.sendMessage({ type: `"native"`, payload: { action: `"prewarm"` } });
});

load();

async function selectedUrl() {
  const tab = await activeTab();
  const state = await chrome.runtime.sendMessage({ type: `"getState"`, tabId: tab.id });
  const radio = document.querySelector('input[name="stream"]:checked');
  const idx = radio ? Number(radio.value) : 0;
  if (state && state.videos && state.videos[idx]) return state.videos[idx].url;
  return tab.url;
}

async function pauseBrowserVideos(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: `"pauseVideos"` });
  } catch {
    // content script not present on this page
  }
}

async function go(action, explicitUrl) {
  `$`("play").disabled = true;
  const tab = await activeTab();
  const url = explicitUrl || await selectedUrl();
  const out = await chrome.runtime.sendMessage({ type: `"launch"`, url, action });
  // Pause the browser's <video> so audio never plays twice alongside mpv.
  if (tab && `$`("autoPlay").checked) await pauseBrowserVideos(tab.id);
  `$`("play").disabled = false;
  showError(out && out.result);
}

`$`("play").addEventListener("click", () => go(`"play"`));
`$`("queue").addEventListener("click", () => go(`"queue"`));
`$`("fallback").addEventListener("click", async () => {
  const tab = await activeTab();
  if (tab && tab.url) await go(`"play"`, tab.url);
});
`$`("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
`$`("autoIntercept").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ autoIntercept: e.target.checked });
});
`$`("autoPlay").addEventListener("change", async (e) => {
  await chrome.storage.sync.set({ autoPlay: e.target.checked });
});
`$`("copyCmd").addEventListener("click", async () => {
  const last = await chrome.runtime.sendMessage({ type: `"copyCommand"` });
  const cmd = last && last.result && last.result.command
    ? last.result.command.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")
    : `""`;
  if (!cmd) return;
  await navigator.clipboard.writeText(cmd);
  `$`("copyCmd").textContent = `"Copied"`;
  setTimeout(() => { `$`("copyCmd").textContent = `"Copy mpv CLI command"`; }, 1500);
});

`$`("linkExtension").addEventListener("click", async () => {
  const btn = `$`("linkExtension");
  const text = `$`("linkText");
  btn.disabled = true;
  text.textContent = `"Linking..."`;
  const res = await chrome.runtime.sendMessage({ type: `"linkExtension"` });
  if (res && res.ok) {
    text.textContent = `"Linked to native host"`;
  } else {
    text.textContent = `"Native host not reachable yet"`;
    showError(res || { ok: false, error: `"Run the installer first"`, code: `"HOST_ERROR"` });
  }
  btn.disabled = false;
  await refreshLinkStatus();
});

bindList(`$`("videos"));
bindList(`$`("subs"));
"@

$content | Set-Content -Path 'C:\Users\User\port_001\browser-extension\popup.js' -Encoding UTF8