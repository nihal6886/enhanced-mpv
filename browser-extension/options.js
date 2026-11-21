"use strict";

function $(id) { return document.getElementById(id); }

function csv(s) {
  return String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function native(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage("com.enhanced.mpv.host", payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "no response" });
    });
  });
}

function fill(cfg) {
  $("ytdlFormat").value = cfg.ytdlFormat || cfg.videoQuality || "";
  $("queueMode").value = cfg.queueMode || "replace";
  $("profile").value = cfg.profile || "";
  $("clipboardWatch").checked = Boolean(cfg.clipboardWatch);
  $("keepWarm").checked = Boolean(cfg.keepWarm);
  $("autoIntercept").checked = Boolean(cfg.autoIntercept);
  $("autoInterceptDomains").value = (cfg.autoInterceptDomains || []).join(", ");
  $("preferredSubtitleLanguages").value = (cfg.preferredSubtitleLanguages || []).join(", ");
  $("nativeAudioLanguages").value = (cfg.nativeAudioLanguages || []).join(", ");
  $("apiKey").value = (cfg.opensubtitles && cfg.opensubtitles.apiKey) || "";
  $("osUser").value = (cfg.opensubtitles && cfg.opensubtitles.username) || "";
  $("osPass").value = (cfg.opensubtitles && cfg.opensubtitles.password) || "";
  $("profiles").value = JSON.stringify(cfg.profiles || [], null, 2);
}

async function load() {
  $("status").textContent = "Loading ~/.enhanced-mpv/config.json …";
  const res = await native({ action: "getConfig" });
  if (!res.ok) {
    $("status").textContent = "Native host unavailable: " + (res.error || "unknown error");
    return;
  }
  fill(res.config || {});
  $("status").textContent = "Loaded.";
  const ext = await chrome.storage.sync.get(["autoIntercept", "autoInterceptDomains"]);
  if (typeof ext.autoIntercept === "boolean") $("autoIntercept").checked = ext.autoIntercept;
  if (Array.isArray(ext.autoInterceptDomains)) {
    $("autoInterceptDomains").value = ext.autoInterceptDomains.join(", ");
  }
}

async function save() {
  let profiles = [];
  try {
    profiles = JSON.parse($("profiles").value || "[]");
  } catch {
    $("status").textContent = "Profiles JSON is invalid.";
    return;
  }
  const config = {
    ytdlFormat: $("ytdlFormat").value.trim(),
    videoQuality: $("ytdlFormat").value.trim() || "best",
    queueMode: $("queueMode").value,
    profile: $("profile").value.trim(),
    clipboardWatch: $("clipboardWatch").checked,
    keepWarm: $("keepWarm").checked,
    autoIntercept: $("autoIntercept").checked,
    autoInterceptDomains: csv($("autoInterceptDomains").value),
    preferredSubtitleLanguages: csv($("preferredSubtitleLanguages").value),
    nativeAudioLanguages: csv($("nativeAudioLanguages").value),
    opensubtitles: {
      apiKey: $("apiKey").value.trim(),
      username: $("osUser").value.trim(),
      password: $("osPass").value,
    },
    profiles,
  };
  const res = await native({ action: "setConfig", config });
  await chrome.storage.sync.set({
    autoIntercept: config.autoIntercept,
    autoInterceptDomains: config.autoInterceptDomains,
    extension: { videoQuality: config.videoQuality, profile: config.profile },
  });
  $("status").textContent = res.ok ? "Saved to ~/.enhanced-mpv/config.json" : ("Save failed: " + (res.error || ""));
}

$("save").addEventListener("click", save);
$("reload").addEventListener("click", load);
$("doctor").addEventListener("click", async () => {
  $("doctorOut").textContent = "Running…";
  const res = await native({ action: "doctor" });
  $("doctorOut").textContent = JSON.stringify(res, null, 2);
});

load();
