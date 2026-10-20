#!/usr/bin/env python3
"""ROUND125 — visual verification screenshots (login bar + strip controls)."""
import time, threading, http.server, functools, os, socket, sys
ROOT = '/home/z/my-project/upload/mt5-app'
PORT = 8926
os.makedirs('/home/z/my-project/scripts/shots', exist_ok=True)

def wait_port(port, timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with socket.create_connection(('127.0.0.1', port), 0.4):
                return True
        except OSError:
            time.sleep(0.2)
    return False

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, 'src'))
http.server.ThreadingHTTPServer.allow_reuse_address = True
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
assert wait_port(PORT)

from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={'width': 1600, 'height': 900})
    page.goto(f'http://127.0.0.1:{PORT}/renderer/index.html?mode=demo')
    page.wait_for_timeout(2000)
    # 1) login screen with the integrated titlebar (hover the close button)
    page.hover('#login-titlebar .wc-close')
    page.wait_for_timeout(200)
    page.screenshot(path='/home/z/my-project/scripts/shots/r125_login.png', clip={'x': 1100, 'y': 0, 'width': 500, 'height': 300})
    # 2) post-login app: strip with tabs + controls (hover max)
    page.evaluate("document.getElementById('login-screen').classList.add('hidden');document.getElementById('app').classList.remove('hidden');")
    page.wait_for_timeout(600)
    page.hover('#win-controls .wc-max')
    page.wait_for_timeout(200)
    page.screenshot(path='/home/z/my-project/scripts/shots/r125_app.png', clip={'x': 0, 'y': 0, 'width': 1600, 'height': 120})
    b.close()
print('shots saved')
