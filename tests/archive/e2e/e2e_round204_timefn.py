#!/usr/bin/env python3
"""ROUND204 e2e — time() session filter + param history on the live app.

  A killzone script boxes every NY-session open (edge via time()[1]);
  engine ok, session boxes exist in the store, midnight edges ND. Also a
  param-edge script matches its inlined twin exactly. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8997, 8825
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

SRC = ('//@version=5\nindicator("TST204", overlay=true)\n'
       't = time(timeframe.period, "0930-1600", "America/New_York")\n'
       'if not na(t) and na(t[1])\n'
       '    box.new(bar_index, high, bar_index + 5, low, bgcolor=color.new(color.orange, 80))\n'
       'plot(close, title="p")\n')

EDGE_SRC = ('//@version=5\nindicator("TST204e", overlay=false)\n'
            'edge(bool x) => x and not x[1]\n'
            'v = close > open\n'
            'plot(edge(v) ? 1 : 0, title="pe")\n'
            'plot(v and not v[1] ? 1 : 0, title="ge")\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { instId: inst.id, status: st ? st.status : 'no-st',
    errors: (st && st.errors) || [], boxes: st ? st.boxes : -1, vals: {} };
  if (st && st.rt && st.rt.out) {
    for (const key of st.rt.out.plotsOrder) {
      const p = st.rt.out.plots.get(key);
      out.vals[p.title] = p.values.filter((v) => v != null);
    }
  }
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
            r = page.evaluate(ADD_JS, {'name': 'TST204', 'src': SRC})
            print('    engine:', r.get('status'), 'boxes:', r.get('boxes'), str(r.get('errors'))[:100])
            check('engine ok', r['status'] == 'ok', r.get('errors'))
            check('session boxes drawn', (r.get('boxes') or 0) >= 1, r.get('boxes'))
            e = page.evaluate(ADD_JS, {'name': 'TST204e', 'src': EDGE_SRC})
            check('edge engine ok', e['status'] == 'ok', e.get('errors'))
            v = e.get('vals') or {}
            pe, ge = v.get('pe') or [], v.get('ge') or []
            try:
                n = min(len(pe), len(ge))
                bad = sum(1 for i in range(n) if pe[i] != ge[i])
                check('param edge == inlined (%d bars)' % n, n > 50 and bad == 0, bad)
            except TypeError:
                check('edge series present', False, (len(pe), len(ge)))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND204: %d failed' % len(FAILS) if FAILS else 'ROUND204: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
