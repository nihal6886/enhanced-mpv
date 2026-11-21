"use strict";

// MAIN-world media registry (document_start, every frame). Records every
// HTMLMediaElement the page plays — including players inside closed Shadow
// DOMs that querySelectorAll can never reach — so the isolated content script
// and popup can read { currentTime, duration, paused } and pause the real
// player. Content scripts talk to it over a synchronous DOM CustomEvent
// channel carrying JSON strings (objects do not cross JS worlds).
(() => {
  const FLAG = "__enhancedMpvMediaHook";
  if (window[FLAG]) return;
  try {
    Object.defineProperty(window, FLAG, { value: true });
  } catch {
    return;
  }

  const REQ = "__empv_media_req";
  const RES = "__empv_media_res";
  const MEDIA_EVENTS = ["play", "playing", "timeupdate", "loadedmetadata", "durationchange"];
  const seen = new WeakSet();
  const refs = [];
  const ids = new WeakMap();
  const lastActive = new WeakMap();
  let nextId = 1;

  const canWeakRef = typeof WeakRef === "function";

  function register(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    lastActive.set(el, Date.now());
    if (seen.has(el)) return;
    seen.add(el);
    ids.set(el, nextId++);
    refs.push(canWeakRef ? new WeakRef(el) : { deref: () => el });
  }

  function onMediaEvent(event) {
    register(event.target);
  }

  function listen(root) {
    for (const type of MEDIA_EVENTS) {
      try { root.addEventListener(type, onMediaEvent, true); } catch { /* ignore */ }
    }
  }

  listen(document);

  const proto = HTMLMediaElement.prototype;
  const nativePlay = proto.play;
  proto.play = function play(...args) {
    register(this);
    return nativePlay.apply(this, args);
  };

  // Media events are not composed, so they never leave a (closed) shadow
  // root. Listen inside every shadow root as it is created.
  const nativeAttachShadow = Element.prototype.attachShadow;
  if (typeof nativeAttachShadow === "function") {
    Element.prototype.attachShadow = function attachShadow(...args) {
      const root = nativeAttachShadow.apply(this, args);
      listen(root);
      return root;
    };
  }

  function live() {
    const out = [];
    for (let i = refs.length - 1; i >= 0; i--) {
      const el = refs[i].deref();
      if (!el || !el.isConnected) {
        if (!el) refs.splice(i, 1);
        continue;
      }
      out.push(el);
    }
    return out;
  }

  function describe(el) {
    let area = 0;
    try {
      const r = el.getBoundingClientRect();
      area = Math.max(0, r.width) * Math.max(0, r.height);
    } catch {
      area = 0;
    }
    let src = "";
    try { src = el.currentSrc || el.src || ""; } catch { src = ""; }
    const duration = Number(el.duration);
    return {
      hookId: ids.get(el),
      src,
      currentTime: Number(el.currentTime) || 0,
      duration: Number.isFinite(duration) ? duration : 0,
      paused: Boolean(el.paused),
      ended: Boolean(el.ended),
      readyState: Number(el.readyState) || 0,
      isVideo: el instanceof HTMLVideoElement,
      area,
      lastActive: lastActive.get(el) || 0,
    };
  }

  function respond(payload) {
    document.dispatchEvent(new CustomEvent(RES, { detail: JSON.stringify(payload) }));
  }

  document.addEventListener(REQ, (event) => {
    let req;
    try { req = JSON.parse(String(event.detail || "{}")); } catch { return; }
    const media = live();
    if (req.op === "state") {
      respond({ id: req.id, media: media.map(describe) });
      return;
    }
    if (req.op === "pause") {
      let paused = 0;
      for (const el of media) {
        if (req.hookId != null && ids.get(el) !== req.hookId) continue;
        try { el.pause(); paused++; } catch { /* ignore */ }
      }
      respond({ id: req.id, paused });
    }
  });
})();
