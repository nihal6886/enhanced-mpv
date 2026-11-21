"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseFilename } = require("../filename-parser");

describe("filename metadata parsing", () => {
  it("strips torrent tags and keeps title/year", () => {
    const r = parseFilename("The.Matrix.1999.1080p.BluRay.x265.DDP5.1.mkv");
    assert.match(r.title, /matrix/i);
    assert.equal(r.year, "1999");
    assert.doesNotMatch(r.title, /1080/i);
    assert.doesNotMatch(r.title, /x265/i);
  });

  it("handles WEB-DL and streaming names", () => {
    const r = parseFilename("Show.Name.S01E03.1080p.WEB-DL.DDP5.1.H.264.mkv");
    assert.match(r.title, /show name/i);
    assert.doesNotMatch(r.title, /web/i);
  });

  it("accepts a bare title", () => {
    const r = parseFilename("interview.mp4");
    assert.match(r.title, /interview/i);
  });
});
