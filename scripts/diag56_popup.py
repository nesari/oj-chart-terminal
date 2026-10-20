#!/usr/bin/env python3
import os, re, subprocess, sys, time
ROOT = '/home/z/my-project/work/mt5-round56'
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
os.chdir(ROOT)
from playwright.sync_api import sync_playwright
from e2e_helper_round32 import open_app

subprocess.run(['pkill', '-f', 'provider/demo.py'], capture_output=True); time.sleep(0.8)
prov = subprocess.Popen([sys.executable, 'provider/demo.py'], stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL, cwd=ROOT, start_new_session=True)
time.sleep(2.2)
with sync_playwright() as pw:
    browser, page = open_app(pw)
    page.locator('#srv-btn').click()
    page.wait_for_timeout(2800)
    html = page.evaluate("document.querySelector('body > .popup') ? document.querySelector('body > .popup').outerHTML : 'NO POPUP'")
    html = re.sub(r'<svg.*?</svg>', '<SVG/>', html, flags=re.S)
    print(html[:2400])
    print('--- currentServer:', page.evaluate("window.__app && __app.App && __app.App.currentAcc"))
    print('--- dc:', page.evaluate("localStorage.getItem('mt5_dc_demo')"))
    browser.close()
