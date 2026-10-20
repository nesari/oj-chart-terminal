#!/usr/bin/env python3
"""SHOT — capture strat dock overview + export button for visual review."""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8981, 8809
OUT = r'C:\Users\amirh\AppData\Local\Temp\opencode'

def wait_port(port, timeout=25):
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

SRC = ('//@version=5\nstrategy("SHOT", overlay=true, initial_capital=100000)\n'
       'fast = ta.sma(close, 14)\nslow = ta.sma(close, 28)\n'
       'if ta.crossover(fast, slow)\n    strategy.entry("Long", strategy.long)\n'
       'if ta.crossunder(fast, slow)\n    strategy.entry("Short", strategy.short)\n'
       'plot(strategy.position_size, title="p")\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  return { instId: inst.id };
}"""

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('nope'); prov.terminate(); return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1560, 'height': 950})
            errs = []
            page.on('pageerror', lambda e: errs.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 300", timeout=25000)
            page.evaluate(ADD_JS, {'name': 'SHOT', 'src': SRC})
            page.click('#std-toggle-btn')
            page.wait_for_selector('#strat-dock:not(.hidden)', timeout=10000)
            page.wait_for_selector('#tst-perf svg.tst-svg', timeout=10000)
            page.click('#sd-expand')
            page.wait_for_timeout(600)
            page.screenshot(path=os.path.join(OUT, 'oj_overview.png'))
            # hover mid-chart for tooltip
            box = page.query_selector('#tst-perf svg.tst-svg').bounding_box()
            page.mouse.move(box['x'] + box['width'] * 0.45, box['y'] + box['height'] * 0.5)
            page.wait_for_timeout(500)
            page.screenshot(path=os.path.join(OUT, 'oj_hover.png'))
            # trades tab + export button closeup
            page.click('#sd-tabs .sd-tab[data-sdtab="trades"]')
            page.wait_for_timeout(400)
            page.screenshot(path=os.path.join(OUT, 'oj_trades.png'))
            print('saved', errs[:2] if errs else 'no errors')
            browser.close()
    finally:
        prov.terminate()
    return 0

if __name__ == '__main__':
    sys.exit(main())
