"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { encodeMessage, createFramer, MAX_MESSAGE } = require("../protocol");

describe("native messaging framing", () => {
  it("round-trips JSON with a 4-byte little-endian prefix", () => {
    const payload = { action: "play", url: "https://example.com/a.m3u8" };
    const buf = encodeMessage(payload);
    assert.equal(buf.readUInt32LE(0), buf.length - 4);
    assert.deepEqual(JSON.parse(buf.subarray(4).toString("utf8")), payload);
  });

  it("reassembles split chunks", () => {
    const messages = [];
    const framer = createFramer((m) => messages.push(m), (e) => { throw e; });
    const encoded = encodeMessage({ ok: true, n: 42 });
    framer.push(encoded.subarray(0, 3));
    assert.equal(messages.length, 0);
    framer.push(encoded.subarray(3, 8));
    framer.push(encoded.subarray(8));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].n, 42);
  });

  it("handles two messages in one chunk", () => {
    const messages = [];
    const framer = createFramer((m) => messages.push(m));
    const a = encodeMessage({ a: 1 });
    const b = encodeMessage({ b: 2 });
    framer.push(Buffer.concat([a, b]));
    assert.deepEqual(messages, [{ a: 1 }, { b: 2 }]);
  });

  it("rejects oversized length prefixes", () => {
    const errors = [];
    const framer = createFramer(() => {}, (e) => errors.push(e));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_MESSAGE + 8, 0);
    framer.push(header);
    assert.equal(errors.length, 1);
  });
});
