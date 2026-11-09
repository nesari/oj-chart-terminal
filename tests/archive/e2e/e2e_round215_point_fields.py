#!/usr/bin/env python3
"""ROUND215 e2e — chart.point field reads/writes on the live app.

  p.price must equal close bar-for-bar, a written price must round-trip
  through a line.new consumer, and the `var chart.point` decl must run.
  Zero page errors. Adaptive (parity-based, live-anchored demo history).
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8954, 8835
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

SRC = ('//@version=6\nindicator("TST215", overlay=true)\n'
       'var chart.point openPoint = chart.point.now(open)\n'
       'closePoint = chart.point.now(close)\n'
       'vRead = closePoint.price\n'
       'closePoint.price := 12345.678\n'
       'vWrote = closePoint.price\n'
       'l = line.new(openPoint, closePoint)\n'
       'vY2 = l.get_y2(l)\n'
       'plot(vRead, title="read")\n'
       'plot(close, title="close")\n'
       'plot(vWrote, title="wrote")\n'
       'plot(vY2, title="y2")\n'
       'plot(openPoint.price, title="open0")\n')

READ_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { instId: inst.id, status: st ? st.status : 'no-st', errors: (st && st.errors) || [], vals: {} };
  if (st && st.rt && st.rt.out) {
    for (const key of st.rt.out.plotsOrder) {
      const p = st.rt.out.plots.get(key);
      out.vals[p.title] = p.values.map((v) => (v == null || (typeof v === 'object' && v.__pineNA) ? null : v));
    }
  }
  A.PineUI.remove(pane, inst.id);
  return out;
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
            r = page.evaluate(READ_JS, {'name': 'TST215', 'src': SRC})
            print('    engine:', r.get('status'), str(r.get('errors'))[:120])
            check('engine ok', r['status'] == 'ok', r.get('errors'))
            v = r.get('vals') or {}
            read, close = v.get('read') or [], v.get('close') or []
            n = min(len(read), len(close))
            bad = sum(1 for i in range(n) if read[i] is None or close[i] is None or abs(read[i] - close[i]) > 1e-9)
            check('p.price == close live (%d bars)' % n, n > 100 and bad == 0, bad)
            wrote = v.get('wrote') or []
            tail = wrote[-50:] if len(wrote) >= 50 else wrote
            check('written price round-trips live', len(tail) > 0 and all(x is not None and abs(x - 12345.678) < 1e-6 for x in tail), len(tail))
            y2 = v.get('y2') or []
            tail2 = y2[-50:] if len(y2) >= 50 else y2
            check('line consumer sees written price', len(tail2) > 0 and all(x is not None and abs(x - 12345.678) < 1e-6 for x in tail2), len(tail2))
            op = v.get('open0') or []
            check('var chart.point decl reads live', len(op) > 100 and all(x is not None for x in op[-50:]), len(op))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND215: %d failed' % len(FAILS) if FAILS else 'ROUND215: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
