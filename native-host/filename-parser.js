"use strict";

const TAGS = [
  "1080p", "720p", "480p", "2160p", "4k", "8k", "4320p",
  "x264", "x265", "h264", "h265", "hevc", "av1", "xvid", "divx",
  "web-dl", "webdl", "webrip", "bluray", "blu-ray", "bdrip", "brrip",
  "dvdrip", "hdtv", "hdcam", "hdrip", "remux", "hybrid",
  "amzn", "nf", "dsnp", "atvp", "hmax", "hulu",
  "ddp5.1", "ddp2.0", "dd5.1", "aac2.0", "atmos", "truehd", "dts", "opus",
  "hdr10", "hdr", "dv", "dovi", "sdr", "10bit", "8bit", "hi10p",
  "proper", "repack", "internal", "limited", "extended", "unrated",
  "multi", "subs", "dubbed", "rarbg", "yify", "yts", "evo", "ntb",
  "web", "pdtv", "sdtv", "cam", "dvdscr",
];

function parseFilename(input) {
  let s = String(input || "");
  s = s.replace(/\\/g, "/");
  s = s.split("/").pop() || s;
  s = s.replace(/\.[a-z0-9]{2,5}$/i, "");
  const yearMatch = s.match(/(?:^|[.\s_([-])((?:19|20)\d{2})(?:$|[.\s_)\]-])/);
  const year = yearMatch ? yearMatch[1] : null;
  s = s.replace(/[._[\]()]/g, " ");
  const lower = s.toLowerCase();
  let cleaned = lower;
  for (const tag of TAGS) {
    cleaned = cleaned.replace(new RegExp("\\b" + tag.replace(".", "\\.") + "\\b", "gi"), " ");
  }
  cleaned = cleaned.replace(/\bs\d{1,2}\s*e\d{1,3}\b.*$/i, " ");
  cleaned = cleaned.replace(/\b(19|20)\d{2}\b/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  const title = cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
  return { title: title || "Unknown", year, raw: input };
}

module.exports = { parseFilename, TAGS };
