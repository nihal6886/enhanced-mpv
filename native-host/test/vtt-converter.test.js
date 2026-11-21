"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { vttToSrt, ttmlToSrt, convertSubtitle, toSrtTime, stripTags } = require("../vtt-converter");

describe("VTT to SRT", () => {
  it("converts timestamps and strips tags", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<c.white>Hello <b>world</b></c>

00:00:05.500 --> 00:00:06.000 align:start
Second cue
`;
    const srt = vttToSrt(vtt);
    assert.match(srt, /1\n00:00:01,000 --> 00:00:04,000\nHello world/);
    assert.match(srt, /2\n00:00:05,500 --> 00:00:06,000\nSecond cue/);
    assert.doesNotMatch(srt, /<b>/);
    assert.doesNotMatch(srt, /WEBVTT/);
  });

  it("skips NOTE/STYLE blocks", () => {
    const vtt = `WEBVTT

NOTE this is a comment

STYLE
::cue { color: red }

00:00:00.000 --> 00:00:01.000
Hi
`;
    const srt = vttToSrt(vtt);
    assert.match(srt, /Hi/);
    assert.doesNotMatch(srt, /NOTE/);
    assert.doesNotMatch(srt, /::cue/);
  });

  it("drops REGION blocks and cue positioning settings", () => {
    const vtt = `WEBVTT

REGION
id:top width:40%

00:00:01.000 --> 00:00:02.000 align:start position:0%
Clean line
`;
    const srt = vttToSrt(vtt);
    assert.match(srt, /Clean line/);
    assert.doesNotMatch(srt, /REGION/);
    assert.doesNotMatch(srt, /align:start/);
    assert.doesNotMatch(srt, /position:0%/);
  });

  it("decodes numeric and named HTML entities in cue text", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
Tom &amp; Jerry &#39;quoted&#39; &#x2192; arrow &lt;tag&gt;
`;
    const srt = vttToSrt(vtt);
    assert.match(srt, /Tom & Jerry/);
    assert.match(srt, /'quoted'/);
    assert.match(srt, /→ arrow <tag>/);
    assert.doesNotMatch(srt, /&amp;/);
    assert.doesNotMatch(srt, /&#39;/);
    assert.doesNotMatch(srt, /&#x2192;/);
  });

  it("converts TTML paragraphs", () => {
    const xml = `<tt><body><div>
      <p begin="00:00:01.000" end="00:00:02.000">One</p>
      <p begin="1.5s" end="2s">Two</p>
    </div></body></tt>`;
    const srt = ttmlToSrt(xml);
    assert.match(srt, /One/);
    assert.match(srt, /Two/);
  });

  it("routes by URL in convertSubtitle", () => {
    const srt = convertSubtitle("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nX\n", "https://cdn.example/a.vtt");
    assert.match(srt, /00:00:00,000/);
  });

  it("maps cue times", () => {
    assert.equal(toSrtTime("1:02:03.4"), "01:02:03,400");
    assert.equal(stripTags("a<br/>b"), "a\nb");
  });
});
