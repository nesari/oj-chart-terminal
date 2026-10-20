#!/usr/bin/env python3
"""ROUND51 diag: what happens mid-pan-drag — engine mode, pill states, hit element."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from e2e_helper_round32 import open_app
from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    errors = []
    browser, page = open_app(pw)
    page.on('pageerror', lambda e: errors.append('PAGEERROR: ' + str(e)))
    page.on('console', lambda m: errors.append('CONSOLE-ERR: ' + m.text) if m.type == 'error' else None)
    page.wait_for_timeout(500)
    page.evaluate("window.__app.Theme.apply('dark')")
    page.wait_for_timeout(200)
    bb = page.evaluate("""() => { const r = document.querySelector('.pane-overlay').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; }""")
    cx, cy = int(bb['x'] + bb['w'] * 0.45), int(bb['y'] + bb['h'] * 0.4)
    print('bb =', bb, 'click at', cx, cy)

    page.evaluate("window.__app.UI.activateTool('cross')")
    page.wait_for_timeout(200)
    page.mouse.move(cx, cy, steps=6)
    page.wait_for_timeout(300)

    el = page.evaluate(f"() => document.elementFromPoint({cx}, {cy})?.className || 'none'")
    print('elementFromPoint:', el)

    page.mouse.down()
    page.mouse.move(cx - 140, cy, steps=8)
    page.wait_for_timeout(150)
    st = page.evaluate("""() => { const p = window.__app.App.panes[0]; const e = p.engine;
      const d = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).display : 'missing'; };
      return { mode: e.mode, pan: !!e.pan, cross: JSON.stringify(e._cross), mouse: JSON.stringify(e.mouse),
               tax: d('.tax-live'), pax: d('.pax-add'), paxl: d('.pax-live'),
               axis: e._axisRegion ? e._axisRegion(e.mouse.x, e.mouse.y) : 'n/a' }; }""")
    print('mid-drag:', st)
    page.mouse.up()
    print('errors:', errors[:5])
    browser.close()
