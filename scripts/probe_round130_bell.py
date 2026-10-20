#!/usr/bin/env python3
"""Probe: why is #tn-bell 'not visible' to Playwright after collapse?"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = '/home/z/my-project/work'
PORT_HTTP, PORT_WS = 8939, 8777

def wait_port(port, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with socket.create_connection(('127.0.0.1', port), 0.4):
                return True
        except OSError:
            time.sleep(0.2)
    return False

def serve_http():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, 'src'))
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT_HTTP), handler).serve_forever()

threading.Thread(target=serve_http, daemon=True).start()
prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
wait_port(PORT_HTTP); wait_port(PORT_WS)

from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width': 1500, 'height': 880})
    page.goto('http://127.0.0.1:8939/renderer/index.html')
    page.wait_for_timeout(900)
    page.click('#login-connect')
    page.wait_for_selector('#app:not(.hidden)', timeout=20000)
    page.wait_for_timeout(900)
    page.evaluate("() => window.__app.RightPanel.showTab('alerts')")
    page.wait_for_timeout(300)

    for state in ['initial', 'after-expand', 'after-collapse']:
        if state == 'after-expand':
            page.evaluate("() => document.querySelector('#trade-notify-log .al-head').click()")
            page.wait_for_timeout(250)
        if state == 'after-collapse':
            page.evaluate("() => document.querySelector('#trade-notify-log .al-head').click()")
            page.wait_for_timeout(250)
        info = page.evaluate("""
        () => {
          const b = document.querySelector('#tn-bell');
          if (!b) return { found: false };
          const r = b.getBoundingClientRect();
          const cs = getComputedStyle(b);
          const tab = document.querySelector('#tab-alerts');
          return {
            found: true,
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
            display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
            tabHidden: tab.classList.contains('hidden'),
            inViewport: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight,
            parentChain: (() => { let el = b, out = []; while (el && el !== document.body) {
              const s = getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden') out.push(el.className || el.id); el = el.parentElement; } return out; })(),
          };
        }""")
        print(state, '->', info)
        # playwright's own opinion
        try:
            vis = page.locator('#tn-bell').is_visible()
            print('   playwright is_visible:', vis)
        except Exception as e:
            print('   playwright error:', e)

browser.close()
prov.terminate()
