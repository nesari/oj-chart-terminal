#!/usr/bin/env python3
"""ROUND114 — visual smoke: screenshots of the Positions grid, the column
menu open on it, and the History grid (dynamic width)."""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = '/home/z/my-project/mt5-terminal'
PORT_HTTP = 8902
OUT = '/home/z/my-project/scripts/shots'

def wait_port(port, timeout=15):
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
try:
    assert wait_port(PORT_HTTP) and wait_port(8777)
    os.makedirs(OUT, exist_ok=True)
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
        pg = b.new_page(viewport={'width': 1600, 'height': 900})
        pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
        pg.wait_for_selector('#login-connect', timeout=15000)
        pg.click('#login-connect')
        pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
        pg.wait_for_selector('#charts-grid canvas', timeout=20000)
        pg.wait_for_timeout(1500)
        pg.evaluate("""() => {
          const App = window.__app.App;
          return window.__app.Trade.placeOrder({
            symbol: App.panes[0].symbol, orderType: 0, volume: 0.02,
            price: 0, deviation: 20, comment: 'r114' });
        }""")
        time.sleep(3)
        pg.evaluate("""() => {
          const d = window.__app.TradeDock;
          d.show(); d._tab = 'positions'; d._render();
        }""")
        time.sleep(1.2)
        pg.screenshot(path=os.path.join(OUT, 'round114_positions_grid.png'))
        pg.evaluate("""() => {
          document.querySelector('#td-pos .td-h2item')
            .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 700, clientY: 620 }));
        }""")
        time.sleep(0.6)
        pg.screenshot(path=os.path.join(OUT, 'round114_positions_menu.png'))
        pg.evaluate("() => window.__app.TradeDock._closeHistMenu()")
        pg.evaluate("""() => { const d = window.__app.TradeDock; d._tab = 'history'; d._render(); }""")
        time.sleep(1.5)
        pg.screenshot(path=os.path.join(OUT, 'round114_history_grid.png'))
        b.close()
        print('shots saved to', OUT)
finally:
    prov.terminate()
