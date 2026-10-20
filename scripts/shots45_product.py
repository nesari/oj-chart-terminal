#!/usr/bin/env python3
"""Clean product screenshots for the round45 download page."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_helper_round32 as H
from playwright.sync_api import sync_playwright

OUT = '/home/z/my-project/work/shots45-verify'
os.makedirs(OUT, exist_ok=True)

with sync_playwright() as pw:
    browser, page = H.open_app(pw)
    page.wait_for_timeout(600)
    # dark: active TF pill + flyout open
    page.evaluate("() => document.querySelector('#left-toolbar .lt-btn[data-group=\"lines\"]').click()")
    page.wait_for_selector('.lt-flyout', timeout=5000)
    page.wait_for_timeout(400)
    page.screenshot(path=os.path.join(OUT, 'product-dark.png'))
    # light: same state
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(400)
    page.screenshot(path=os.path.join(OUT, 'product-light.png'))
    browser.close()
print('done')
