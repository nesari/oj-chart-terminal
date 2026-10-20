#!/usr/bin/env python3
"""ROUND59 screenshots — multi-chart crosshair sync fixed: synced line+pill on
chart B while hovering chart A (dark body hover, dark axis hover, light)."""
import os, re, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
os.chdir(ROOT)
OUT = os.path.join(ROOT, 'shots59-verify')
os.makedirs(OUT, exist_ok=True)

subprocess.run(['pkill', '-f', 'provider/demo.py'], capture_output=True)
time.sleep(0.8)
prov = subprocess.Popen([sys.executable, 'provider/demo.py'],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        cwd=ROOT, start_new_session=True)
time.sleep(2.2)

from playwright.sync_api import sync_playwright
from e2e_helper_round32 import BASE, poll

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1500, 'height': 900})
    page.goto(BASE)
    page.evaluate("try { localStorage.clear(); } catch (e) {}")
    page.reload()
    page.wait_for_selector('#login-screen', timeout=10000)
    page.click('#card-demo')
    page.click('#login-connect')
    page.wait_for_selector('#app:not(.hidden)', timeout=20000)
    poll(page, "window.__app ? window.__app.App.panes.length : 0", 20000, lambda v: v >= 1)
    poll(page, "(window.__app.App.panes[0].bars || []).length", 30000, lambda v: v > 100)
    page.evaluate("window.__app.Manager.setLayout('2v', false)")
    page.wait_for_timeout(2500)
    poll(page, "window.__app.App.panes.length", 20000, lambda v: v == 2)
    poll(page, "(window.__app.App.panes[1].bars || []).length", 30000, lambda v: v > 100)
    page.wait_for_timeout(600)
    page.evaluate("window.__app.App.sync.crosshair = true")
    # mismatched charts like real usage
    page.evaluate("window.__app.Manager.setSymbol(window.__app.App.panes[1], 'XAUUSD')")
    page.wait_for_timeout(1500)
    page.evaluate("window.__app.Manager.setTf(window.__app.App.panes[1], 'M5')")
    page.wait_for_timeout(2200)

    ga = page.evaluate("""() => { const cv = window.__app.App.panes[0].engine.canvas.getBoundingClientRect();
      return { x: cv.x, y: cv.y, w: cv.width, h: cv.height }; }""")
    cy = ga['y'] + ga['h'] * 0.42

    # 1) dark: hover chart A body -> synced vertical + pill visible on chart B
    page.mouse.move(ga['x'] + ga['w'] * 0.55, cy, steps=4)
    page.wait_for_timeout(400)
    page.screenshot(path=os.path.join(OUT, 'round59_sync_body_dark.png'))

    # 2) dark: hover chart A time axis -> synced visuals still on chart B
    page.mouse.move(ga['x'] + ga['w'] * 0.6, ga['y'] + ga['h'] - 10, steps=4)
    page.wait_for_timeout(400)
    page.screenshot(path=os.path.join(OUT, 'round59_sync_axis_dark.png'))

    # 3) light theme, body hover
    page.evaluate("window.__app && __app.Theme.apply('light')")
    page.mouse.move(ga['x'] + ga['w'] * 0.45, cy, steps=4)
    page.wait_for_timeout(500)
    page.screenshot(path=os.path.join(OUT, 'round59_sync_body_light.png'))
    page.evaluate("window.__app && __app.Theme.apply('dark')")

    browser.close()

print('shots done ->', OUT)
for f in sorted(os.listdir(OUT)):
    print(' ', f, os.path.getsize(os.path.join(OUT, f)))
