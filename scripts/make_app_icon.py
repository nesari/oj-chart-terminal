#!/usr/bin/env python3
"""ROUND127 — build assets/app.ico (multi-size Windows icon) from the user's
existing logo artwork (src/renderer/assets/logo.png, the gold OJ tile).

Why: the taskbar icon fix needs a proper multi-resolution .ico — the window
icon used to be a single 282x267 (non-square) PNG, which several Windows
builds refuse to map onto the small taskbar sizes and then fall back to the
electron.exe default logo. This script is a ONE-TIME build step; the .ico it
emits is committed with the app. It never touches the artwork itself — only
pads it to a square (transparent) and derives the standard sizes:
16 20 24 32 40 48 64 96 128 256.
"""
from PIL import Image
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src', 'renderer', 'assets', 'logo.png')
DST = os.path.join(ROOT, 'assets', 'app.ico')
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]

def main():
    im = Image.open(SRC).convert('RGBA')
    # crop to the artwork's opaque bounding box, then pad to a square with
    # fully transparent margins (rounded-corner tiles stay untouched)
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    side = max(im.size)
    sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    master = sq.resize((256, 256), Image.LANCZOS)  # one clean master per size
    os.makedirs(os.path.dirname(DST), exist_ok=True)
    master.save(DST, format='ICO', sizes=[(s, s) for s in SIZES])
    out = Image.open(DST)
    print('app.ico written:', DST)
    print('frame size:', out.size, 'embedded sizes:', sorted(SIZES))

if __name__ == '__main__':
    main()
