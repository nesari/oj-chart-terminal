#!/usr/bin/env python3
"""ROUND244 e2e — Elliott anchors + price ratios + Ratios toggle, live.

  Geometry (DrawTools against a stub canvas, identity pixels):
  - elliott_i draws all 6 wave labels (0..5 — label 5 never appeared before)
  - leg ratios are price retracements (0.50/2.00), not pixel hypots (1.00)
  Flow (real mouse clicks): 5 clicks create nothing, the 6th completes.
  Settings: the style dialog for an Elliott drawing carries a Ratios toggle.
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8924, 8864
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

def check(name, cond, extra=''):
    print(('  ok ' if cond else '  FAIL ') + name + ((' - ' + str(extra)) if (not cond and extra != '') else ''))
    if not cond:
        FAILS.append(name)

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

GEO_JS = """() => {
  const T = window.__app.DrawTools;
  const texts = [];
  const ctx = { beginPath(){}, stroke(){}, save(){}, restore(){}, closePath(){},
    setLineDash(){}, moveTo(){}, lineTo(){},
    fillText(t){ texts.push(String(t)); } };
  const V = { ctx, xOf: (t) => t, yOf: (p) => p, w: 800, h: 600, pw: 800, ph: 600 };
  const prices = [10, 20, 15, 25, 20, 30];
  const pts = prices.map((p, i) => ({ t: i * 100, p }));
  T.elliott_i.draw(V, { points: pts, opts: { color: '#fff', width: 2, showRatio: true } }, false);
  return { texts };
}"""

FLOW_JS = """() => {
  const A = window.__app;
  const r = document.querySelector('.pane-root').getBoundingClientRect();
  const sym = A.App.activePane.symbol;
  const before = A.App.drawings.list(sym).length;
  A.App.tool = 'elliott_i';
  return { x: r.left, y: r.top, w: r.width, h: r.height, before, sym };
}"""

COUNT_JS = """() => {
  const A = window.__app;
  return A.App.drawings.list(A.App.activePane.symbol).length;
}"""

SCHEMA_JS = """() => {
  const A = window.__app;
  const sym = A.App.activePane.symbol;
  const list = A.App.drawings.list(sym);
  const d = list[list.length - 1];
  const pane = A.App.activePane;
  A.DrawSettings.open(pane, d);
  const dlg = document.querySelector('.dialog');
  const txt = dlg ? dlg.textContent : '';
  const has = txt.indexOf('Ratios') >= 0;
  const x = dlg ? dlg.querySelector('.dlg-x') : null;
  if (x) x.click();
  return { has, type: d.type };
}"""

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up'); prov.terminate(); return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1560, 'height': 900})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100", timeout=25000)
            page.wait_for_function("() => window.__app.DrawTools && window.__app.DrawTools.elliott_i", timeout=15000)
            g = page.evaluate(GEO_JS)
            print('    texts:', g.get('texts'))
            tx = g.get('texts', [])
            check('all 6 wave labels drawn', all(s in tx for s in ['0', '1', '2', '3', '4', '5']), tx)
            check('price ratios 0.50/2.00', '0.50' in tx and '2.00' in tx, tx)
            check('no pixel-hypot 1.00', '1.00' not in tx, tx)
            f = page.evaluate(FLOW_JS)
            y = f['y'] + f['h'] * 0.35
            for i in range(5):
                page.mouse.click(f['x'] + f['w'] * (0.25 + 0.1 * i), y)
                page.wait_for_timeout(200)
            check('5 clicks: not yet created', page.evaluate(COUNT_JS) == f['before'], f['before'])
            page.mouse.click(f['x'] + f['w'] * 0.75, y)
            page.wait_for_timeout(300)
            check('6th click completes impulse', page.evaluate(COUNT_JS) == f['before'] + 1, f['before'])
            s = page.evaluate(SCHEMA_JS)
            print('    schema:', s)
            check('style dialog has Ratios toggle', s.get('has') is True and s.get('type') == 'elliott_i', s)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND244: %d failed' % len(FAILS) if FAILS else 'ROUND244: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
