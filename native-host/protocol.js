"use strict";

const MAX_MESSAGE = 1024 * 1024;

function encodeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  if (json.length > MAX_MESSAGE) {
    throw new Error("native message too large");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

function createFramer(onMessage, onError) {
  let buf = Buffer.alloc(0);
  let expected = null;

  function push(chunk) {
    if (!chunk || chunk.length === 0) return;
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (expected === null) {
        if (buf.length < 4) return;
        expected = buf.readUInt32LE(0);
        buf = buf.subarray(4);
        if (expected === 0 || expected > MAX_MESSAGE) {
          const err = new Error("invalid native message length: " + expected);
          expected = null;
          buf = Buffer.alloc(0);
          if (onError) onError(err);
          return;
        }
      }
      if (buf.length < expected) return;
      const body = buf.subarray(0, expected);
      buf = buf.subarray(expected);
      expected = null;
      try {
        onMessage(JSON.parse(body.toString("utf8")));
      } catch (err) {
        if (onError) onError(err);
      }
    }
  }

  return { push, MAX_MESSAGE };
}

async function readExact(stream, n) {
  const chunks = [];
  let got = 0;
  while (got < n) {
    const chunk = stream.read(n - got);
    if (chunk) {
      chunks.push(chunk);
      got += chunk.length;
      continue;
    }
    await new Promise((resolve, reject) => {
      const onReadable = () => {
        cleanup();
        resolve();
      };
      const onEnd = () => {
        cleanup();
        reject(new Error("stdin closed"));
      };
      const onErr = (e) => {
        cleanup();
        reject(e);
      };
      const cleanup = () => {
        stream.off("readable", onReadable);
        stream.off("end", onEnd);
        stream.off("error", onErr);
      };
      stream.once("readable", onReadable);
      stream.once("end", onEnd);
      stream.once("error", onErr);
    });
  }
  return Buffer.concat(chunks, n);
}

module.exports = { encodeMessage, createFramer, readExact, MAX_MESSAGE };
