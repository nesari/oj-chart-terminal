#!/usr/bin/env python3
"""Probe 2: reproduce the exact e2e sequence and inspect #tn-bell state."""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = '/home/z/my-project/work'
PORT_HTTP, PORT_WS = 8941, 8777

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
    page.goto('http://127.0.0.1:8941/renderer/index.html')
    page.wait_for_timeout(900)
    page.click('#login-connect')
    page.wait_for_selector('#app:not(.hidden)', timeout=20000)
    page.wait_for_timeout(900)
    page.evaluate("() => window.__app.RightPanel.showTab('alerts')")
    page.wait_for_timeout(300)

    # exact e2e sequence up to the failing click
    page.evaluate("() => document.querySelector('#trade-alert-settings .al-head').click()")  # ta card open
    page.wait_for_timeout(200)
    page.evaluate("""async () => {
      const A = window.__app; const sym = A.App.panes[0].symbol;
      await A.TradeRoute.sendOrder({ symbol: sym, orderType: 0, volume: 0.10, price: 0, sl: 0, tp: 0, deviation: 20, comment: 'p2a' });
    }""")
    page.wait_for_timeout(2600)
    page.evaluate("() => document.querySelector('#tn-enabled').click()")  # capture on -> auto-expand
    page.wait_for_timeout(300)
    page.evaluate("""async () => {
      const A = window.__app; const sym = A.App.panes[0].symbol;
      await A.TradeRoute.sendOrder({ symbol: sym, orderType: 0, volume: 0.05, price: 0, sl: 0, tp: 0, deviation: 20, comment: 'p2b' });
    }""")
    page.wait_for_timeout(2600)
    page.evaluate("() => document.querySelector('#trade-notify-log .al-head').click()")  # collapse
    page.wait_for_timeout(200)
    t2 = page.evaluate("() => window.__app.Trade.positions.map((p) => p.ticket).pop()")
    page.evaluate("(t) => window.__app.TradeRoute.close(t)", t2)
    page.wait_for_timeout(2600)

    info = page.evaluate("""
    () => {
      const b = document.querySelector('#tn-bell');
      const r = b.getBoundingClientRect();
      const stack = document.querySelector('#al-stack').getBoundingClientRect();
      const stackCs = getComputedStyle(document.querySelector('#al-stack'));
      const tab = document.querySelector('#tab-alerts');
      const tabR = tab.getBoundingClientRect();
      // walk up: who clips or hides?
      const chain = [];
      let el = b;
      while (el && el !== document.documentElement) {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.overflow === 'hidden' || s.overflowY === 'hidden')
          chain.push({ cls: (el.className || el.id || '').toString().slice(0, 40), disp: s.display, ov: s.overflow, h: el.getBoundingClientRect().height });
        el = el.parentElement;
      }
      return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, stack: { h: stack.height, oy: stackCs.overflowY }, tabH: tabR.height,
               dw: document.documentElement.clientHeight, chain };
    }""")
    print('INFO:', info)
    print('is_visible:', page.locator('#tn-bell').is_visible())
    try:
        page.click('#tn-bell', timeout=5000)
        print('REAL CLICK OK, list now open:', page.evaluate("() => !!document.querySelector('#tn-list')"))
    except Exception as e:
        print('REAL CLICK FAILED:', str(e)[:300])

browser.close()
prov.terminate()
