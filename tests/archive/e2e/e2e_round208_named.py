#!/usr/bin/env python3
"""ROUND208 e2e — named arguments on the live app.

  request.security(..., timeframe="D", expression=...) must equal the
  positional H1/D bucket values, and ta.sma(source=..., length=...) must equal
  the positional sma bar-for-bar. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8990, 8828
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

SRC = ('//@version=5\nindicator("TST208", overlay=false)\n'
       'a = request.security(syminfo.tickerid, "60", close)\n'
       'b = request.security(syminfo.tickerid, timeframe="60", expression=close)\n'
       'plot(a, title="pos")\n'
       'plot(b, title="nmd")\n'
       's1 = ta.sma(close, 14)\n'
       's2 = ta.sma(source=close, length=14)\n'
       'plot(s1, title="sma1")\n'
       'plot(s2, title="sma2")\n')

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
            r = page.evaluate(READ_JS, {'name': 'TST208', 'src': SRC})
            print('    engine:', r.get('status'), str(r.get('errors'))[:120])
            check('engine ok', r['status'] == 'ok', r.get('errors'))
            v = r.get('vals') or {}
            pos, nmd = v.get('pos') or [], v.get('nmd') or []
            n = min(len(pos), len(nmd))
            bad = sum(1 for i in range(n) if (pos[i] is None) != (nmd[i] is None) or (pos[i] is not None and abs(pos[i] - nmd[i]) > 1e-9))
            check('named security == positional (%d bars)' % n, n > 100 and bad == 0, bad)
            s1, s2 = v.get('sma1') or [], v.get('sma2') or []
            m = min(len(s1), len(s2))
            bad2 = sum(1 for i in range(m) if (s1[i] is None) != (s2[i] is None) or (s1[i] is not None and abs(s1[i] - s2[i]) > 1e-9))
            check('named ta.sma == positional (%d bars)' % m, m > 100 and bad2 == 0, bad2)
            check('named values non-trivial', any(x is not None and abs(x) > 0 for x in nmd), len(nmd))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND208: %d failed' % len(FAILS) if FAILS else 'ROUND208: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
