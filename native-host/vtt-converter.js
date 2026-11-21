"use strict";

function pad(n, w) {
  return String(n).padStart(w, "0");
}

function toSrtTime(raw) {
  const cleaned = String(raw).trim().replace(",", ".");
  const m = cleaned.match(/(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!m) {
    const sec = Number(cleaned);
    if (!Number.isFinite(sec)) return "00:00:00,000";
    const h = Math.floor(sec / 3600);
    const mm = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec - Math.floor(sec)) * 1000);
    return `${pad(h, 2)}:${pad(mm, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
  }
  const h = Number(m[1] || 0);
  const mm = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number((m[4] || "0").padEnd(3, "0").slice(0, 3));
  return `${pad(h, 2)}:${pad(mm, 2)}:${pad(s, 2)},${pad(ms, 3)}`;
}

function entityCode(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function stripTags(text) {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => entityCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => entityCode(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function cueText(block) {
  const lines = block.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return "";
  let i = 0;
  // NOTE / STYLE / REGION blocks carry metadata, not on-screen dialogue.
  if (/^\s*(NOTE|STYLE|REGION)\b/i.test(lines[0])) return "";
  if (!lines[0].includes("-->") && lines[1] && lines[1].includes("-->")) i = 1;
  if (!lines[i] || !lines[i].includes("-->")) return "";
  const timing = lines[i];
  const [startRaw, endPart] = timing.split("-->").map((s) => s.trim());
  // Drop any cue settings after the end timestamp (align:start position:0% ...).
  const endRaw = (endPart || "").split(/\s+/)[0];
  const payload = lines.slice(i + 1).join("\n");
  const text = stripTags(payload);
  if (!text) return "";
  return { start: toSrtTime(startRaw), end: toSrtTime(endRaw), text };
}

function vttToSrt(input) {
  let body = String(input || "").replace(/^\uFEFF/, "");
  body = body.replace(/^WEBVTT[^\n]*\n/, "");
  const blocks = body.split(/\r?\n(?:\r?\n)+/);
  const cues = [];
  for (const block of blocks) {
    const cue = cueText(block.trim());
    if (cue) cues.push(cue);
  }
  return cues
    .map((c, idx) => `${idx + 1}\n${c.start} --> ${c.end}\n${c.text}\n`)
    .join("\n");
}

function looksLikeVtt(text, url) {
  if (url && /\.vtt(\?|$)/i.test(url)) return true;
  const head = String(text || "").slice(0, 80);
  return /^WEBVTT/i.test(head) || /^WEBVTT/m.test(String(text || "").slice(0, 200));
}

function ttmlToSrt(input) {
  const src = String(input || "");
  const cues = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(src))) {
    const attrs = m[1];
    const begin = /begin="([^"]+)"/i.exec(attrs);
    const end = /end="([^"]+)"/i.exec(attrs);
    if (!begin || !end) continue;
    const text = stripTags(m[2]);
    if (!text) continue;
    cues.push({
      start: ttmlTime(begin[1]),
      end: ttmlTime(end[1]),
      text,
    });
  }
  return cues
    .map((c, idx) => `${idx + 1}\n${c.start} --> ${c.end}\n${c.text}\n`)
    .join("\n");
}

function ttmlTime(raw) {
  if (/^\d+:\d+:\d+/.test(raw)) return toSrtTime(raw.replace(".", ","));
  const h = /([0-9.]+)h/.exec(raw);
  const m = /([0-9.]+)m/.exec(raw);
  const s = /([0-9.]+)s/.exec(raw);
  const ms = /([0-9.]+)ms/.exec(raw);
  let sec = 0;
  if (h) sec += Number(h[1]) * 3600;
  if (m) sec += Number(m[1]) * 60;
  if (s) sec += Number(s[1]);
  if (ms) sec += Number(ms[1]) / 1000;
  return toSrtTime(String(sec));
}

function convertSubtitle(text, url) {
  const lower = (url || "").toLowerCase();
  if (lower.includes(".dfxp") || lower.includes("ttml") || /<tt[\s>]/i.test(text)) {
    return ttmlToSrt(text);
  }
  if (looksLikeVtt(text, url) || lower.includes(".vtt")) {
    return vttToSrt(text);
  }
  return String(text || "");
}

module.exports = {
  vttToSrt,
  ttmlToSrt,
  convertSubtitle,
  toSrtTime,
  stripTags,
  looksLikeVtt,
};
