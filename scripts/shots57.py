#!/usr/bin/env python3
"""ROUND57 screenshots — popup with the full server list (dark + light)."""
import os, re, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
os.chdir(ROOT)
OUT = os.path.join(ROOT, 'shots57-verify')
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
    page.wait_for_timeout(800)

    # 1) dark: popup open with the full measured list
    page.click('#srv-btn')
    page.wait_for_selector('body > .popup .srv-row', timeout=10000)
    page.wait_for_timeout(2800)
    page.screenshot(path=os.path.join(OUT, 'r57-popup-dark.png'))

    # 2) light theme, list re-scanned
    page.evaluate("window.__app && __app.Theme.apply('light')")
    page.wait_for_timeout(300)
    page.locator('body > .popup .srv-rescan').click()
    page.wait_for_timeout(2800)
    page.screenshot(path=os.path.join(OUT, 'r57-popup-light.png'))

    # 3) bottom bar context (popup anchored above the button, next to tz)
    page.evaluate("window.__app && __app.Theme.apply('dark')")
    page.keyboard.press('Escape')
    page.wait_for_timeout(400)
    page.click('#srv-btn')
    page.wait_for_selector('body > .popup .srv-row', timeout=10000)
    page.wait_for_timeout(2800)
    page.screenshot(path=os.path.join(OUT, 'r57-bottombar.png'), clip={'x': 640, 'y': 560, 'width': 860, 'height': 340})

    browser.close()
prov.terminate()
print('shots done:', sorted(os.listdir(OUT)))
