#!/usr/bin/env node
/**
 * F1.5 (roadmap) — build assets/icon-1024.png (square, 1024x1024) from the
 * app artwork src/renderer/assets/logo.png.
 *
 * Why: electron-builder needs a >= 512x512 square icon for the macOS (.icns)
 * and Linux (png set) targets; the existing logo.png is 282x267 (non-square)
 * so both targets warning-fail. This is a ONE-TIME build step; the PNG it
 * emits is committed with the app. The artwork itself is never modified:
 * we crop to the opaque bounding box, pad to a square with transparent
 * margins (matching scripts/make_app_icon.py for the Windows .ico) and
 * upscale to 1024x1024.
 *
 * Runs under Electron because it uses nativeImage for pixel access + PNG
 * encoding (no image library is installed in the repo):
 *   node_modules/electron/dist/electron.exe scripts/make_icon_1024.js
 */
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const ROOT = path.dirname(__dirname);
const SRC = path.join(ROOT, 'src', 'renderer', 'assets', 'logo.png');
const DST = path.join(ROOT, 'assets', 'icon-1024.png');
const SIDE = 1024;

function bbox(bmp, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bmp[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w, h };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function main() {
  const img = nativeImage.createFromPath(SRC);
  const { width: w, height: h } = img.getSize();
  if (!w || !h) throw new Error('cannot read ' + SRC);
  const src = img.toBitmap(); // BGRA
  const b = bbox(src, w, h);
  const side = Math.max(b.w, b.h);
  const square = Buffer.alloc(side * side * 4, 0); // transparent
  const ox = (side - b.w) >> 1;
  const oy = (side - b.h) >> 1;
  for (let y = 0; y < b.h; y++) {
    const from = ((b.y + y) * w + b.x) * 4;
    const to = ((oy + y) * side + ox) * 4;
    src.copy(square, to, from, from + b.w * 4);
  }
  const master = nativeImage.createFromBitmap(square, { width: side, height: side });
  const out = master.resize({ width: SIDE, height: SIDE, quality: 'best' });
  const png = out.toPNG();
  if (!png || !png.length) throw new Error('empty PNG');
  fs.mkdirSync(path.dirname(DST), { recursive: true });
  fs.writeFileSync(DST, png);
  console.log('icon-1024.png written:', DST);
  console.log('source:', w + 'x' + h, 'opaque bbox:', b.w + 'x' + b.h, 'output:', out.getSize().width + 'x' + out.getSize().height);
}

app.whenReady().then(() => {
  try { main(); app.exit(0); } catch (e) { console.error('FAILED:', e && e.message || e); app.exit(1); }
});
