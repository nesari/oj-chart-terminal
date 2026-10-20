#!/usr/bin/env python3
"""ROUND50 diag — why does arrowcur's pair die after approach+dwell?"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from e2e_helper_round32 import open_app  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

with sync_playwright() as pw:
    browser, page = open_app(pw)
    page.wait_for_timeout(500)
    bb = page.evaluate("""() => { const r = document.querySelector('.pane-overlay').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; }""")
    cx, cy = bb['x'] + bb['w'] * 0.45, bb['y'] + bb['h'] * 0.4

    def state(tag):
        s = page.evaluate("""() => { const p = window.__app.App.panes[0]; const e = p.engine;
          const r = p.paxAdd.getBoundingClientRect();
          return { disp: p.paxAdd.style.display, cross: e._cross, mouse: e.mouse, mode: e.mode,
                   lastY: e._paxLastY, frozen: p._paxFrozen, btn: { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width } }; }""")
        print(tag, s)
        return s

    page.evaluate("window.__app.UI.activateTool('arrowcur')")
    page.wait_for_timeout(150)
    page.mouse.move(cx - 80, cy - 60); page.wait_for_timeout(60)
    page.mouse.move(cx, cy); page.wait_for_timeout(250)
    b = state('after-hover:')['btn']
    # stepped approach in small increments, logging state every ~8 steps
    steps = 30
    for i in range(1, steps + 1):
        x = cx + (b['x'] - cx) * i / steps
        y = cy + (b['y'] - cy) * i / steps
        page.mouse.move(x, y)
        if i % 8 == 0 or i == steps:
            page.wait_for_timeout(120)
            state(f'step{i}:')
    page.wait_for_timeout(1500)
    state('after-dwell:')
    browser.close()
