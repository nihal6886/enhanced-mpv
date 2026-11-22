"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function crc32(buf) {
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

// Dark rounded square + neon green play triangle.
// Sizes include 16, 32, 48, 256 for crisp Windows/taskbar/icon rendering.
const NEON_GREEN_BRIGHT = [74, 222, 128];   // #4ADE80
const NEON_GREEN_DEEP = [34, 197, 94];      // #22C55E
const TILE = [21, 24, 30];                  // #15181E dark rounded square background

function inRoundedSquare(nx, ny) {
  const h = 0.46;
  const r = 0.2;
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  if (ax > h || ay > h) return false;
  const cx = h - r;
  const cy = h - r;
  if (ax <= cx || ay <= cy) return true;
  const dx = ax - cx;
  const dy = ay - cy;
  return dx * dx + dy * dy <= r * r;
}

function inPlay(nx, ny) {
  const left = -0.14;
  const apex = 0.24;
  const half = 0.23;
  if (nx < left || nx > apex) return false;
  const t = (nx - left) / (apex - left);
  return Math.abs(ny) <= half * (1 - t);
}

function sampleColor(nx, ny) {
  if (!inRoundedSquare(nx, ny)) return null;
  if (inPlay(nx, ny)) {
    const t = (ny + 0.5);
    const mix = Math.max(0, Math.min(1, t));
    return [
      Math.round(NEON_GREEN_BRIGHT[0] * (1 - mix) + NEON_GREEN_DEEP[0] * mix),
      Math.round(NEON_GREEN_BRIGHT[1] * (1 - mix) + NEON_GREEN_DEEP[1] * mix),
      Math.round(NEON_GREEN_BRIGHT[2] * (1 - mix) + NEON_GREEN_DEEP[2] * mix),
    ];
  }
  return TILE;
}

// 3x3 supersampling keeps the emblem crisp and smoothly antialiased at every
// size, from the 16px taskbar glyph up to the 256px installer icon.
function makePng(size) {
  const SS = 3;
  const raw = [];
  for (let y = 0; y < size; y++) {
    raw.push(0);
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = (x + (sx + 0.5) / SS) / size - 0.5;
          const ny = (y + (sy + 0.5) / SS) / size - 0.5;
          const c = sampleColor(nx, ny);
          if (c) {
            r += c[0] * 255;
            g += c[1] * 255;
            b += c[2] * 255;
            a += 255;
          }
        }
      }
      const n = SS * SS;
      if (a > 0) {
        raw.push(Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / n));
      } else {
        raw.push(0, 0, 0, 0);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.from(raw))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Multi-resolution Windows icon. Each entry carries PNG-compressed pixel data,
// which Windows Vista and later read natively at every directory size.
function makeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  const images = [];
  let offset = 6 + dir.length;
  entries.forEach((entry, i) => {
    const b = i * 16;
    const dim = entry.size >= 256 ? 0 : entry.size;
    dir.writeUInt8(dim, b);
    dir.writeUInt8(dim, b + 1);
    dir.writeUInt8(0, b + 2);
    dir.writeUInt8(0, b + 3);
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(entry.data.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += entry.data.length;
    images.push(entry.data);
  });
  return Buffer.concat([header, dir, ...images]);
}

// Inno Setup wizard bitmaps: dark studio (#0D1117) + neon green (#4ADE80)
const DARK_STUDIO = [13, 17, 23];       // #0D1117
const NEON_GREEN = [74, 222, 128];      // #4ADE80

function makeBmp(width, height, drawFn) {
  // 24-bit BMP, bottom-up, no compression
  const rowSize = Math.floor((width * 3 + 3) / 4) * 4;
  const pixelData = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const row = height - 1 - y; // BMP is bottom-up
    for (let x = 0; x < width; x++) {
      const color = drawFn(x, y, width, height);
      const idx = row * rowSize + x * 3;
      pixelData[idx] = color[2];     // B
      pixelData[idx + 1] = color[1]; // G
      pixelData[idx + 2] = color[0]; // R
    }
  }
  const fileHeader = Buffer.alloc(14);
  fileHeader.writeUInt16LE(0x4D42, 0); // "BM"
  fileHeader.writeUInt32LE(14 + 40 + pixelData.length, 2); // file size
  fileHeader.writeUInt32LE(0, 6); // reserved
  fileHeader.writeUInt32LE(14 + 40, 10); // offset to pixel data
  const infoHeader = Buffer.alloc(40);
  infoHeader.writeUInt32LE(40, 0); // header size
  infoHeader.writeInt32LE(width, 4);
  infoHeader.writeInt32LE(height, 8);
  infoHeader.writeUInt16LE(1, 12); // planes
  infoHeader.writeUInt16LE(24, 14); // bits per pixel
  infoHeader.writeUInt32LE(0, 16); // no compression
  infoHeader.writeUInt32LE(pixelData.length, 20); // image size
  infoHeader.writeInt32LE(2835, 24); // XPelsPerMeter (72 DPI)
  infoHeader.writeInt32LE(2835, 28); // YPelsPerMeter
  infoHeader.writeUInt32LE(0, 32); // colors used
  infoHeader.writeUInt32LE(0, 36); // important colors
  return Buffer.concat([fileHeader, infoHeader, pixelData]);
}

function drawWizardBanner(x, y, w, h) {
  // 55x164: left sidebar with vertical neon green accent line
  if (x < 4) return NEON_GREEN; // thin left accent bar
  return DARK_STUDIO;
}

function drawWizardSmall(x, y, w, h) {
  // 499x314: main wizard image with dark background, neon green title area
  if (y < 60) return DARK_STUDIO; // top title area
  if (y === 60) return NEON_GREEN; // separator line
  return DARK_STUDIO;
}

function main() {
  const iconsDir = path.join(__dirname, "..", "browser-extension", "icons");
  fs.mkdirSync(iconsDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    fs.writeFileSync(path.join(iconsDir, "icon" + size + ".png"), makePng(size));
  }

  const assetsDir = path.join(__dirname, "..", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const entries = sizes.map((size) => ({ size, data: makePng(size) }));
  fs.writeFileSync(path.join(assetsDir, "enhanced-mpv.ico"), makeIco(entries));
  console.log("Generated enhanced-mpv.ico with sizes: " + sizes.join(", "));

  // Inno Setup wizard bitmaps
  const banner = makeBmp(55, 164, drawWizardBanner);
  fs.writeFileSync(path.join(assetsDir, "wizard-banner.bmp"), banner);
  console.log("Generated wizard-banner.bmp (55x164)");

  const small = makeBmp(499, 314, drawWizardSmall);
  fs.writeFileSync(path.join(assetsDir, "wizard-small.bmp"), small);
  console.log("Generated wizard-small.bmp (499x314)");
}

main();
