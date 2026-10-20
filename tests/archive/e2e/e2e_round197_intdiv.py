#!/usr/bin/env python3
"""ROUND197 e2e — legacy int-div on the live app (v5 truncates, v6 floats)."""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8990, 8818
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

V5_SRC = ('//@version=5\nindicator("TST197a", overlay=false)\n'
          'n = 7\n'
          'plot(n / 2, title="lit")\n'
          'plot(bar_index / 2, title="bi")\n'
          'plot(close / 2, title="fl")\n')

V6_SRC = ('//@version=6\nindicator("TST197b", overlay=false)\n'
          'n = 7\n'
          'plot(n / 2, title="lit")\n'
          'plot(bar_index / 2, title="bi")\n'
          'plot(close / 2, title="fl")\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { instId: inst.id, status: st ? st.status : 'no-st',
    errors: (st && st.errors) || [], vals: {}, idx: -1 };
  if (st && st.rt && st.rt.out) {
    const bars = pane.bars;
    for (let i = bars.length - 2; i >= Math.max(0, bars.length - 12); i--) {
      if (bars[i].open !== bars[i].close) { out.idx = i; break; }
    }
    if (out.idx >= 0) {
      for (const key of st.rt.out.plotsOrder) {
        const p = st.rt.out.plots.get(key);
        out.vals[p.title] = p.values[out.idx];
      }
      out.close = bars[out.idx].close;
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
            a = page.evaluate(ADD_JS, {'name': 'TST197a', 'src': V5_SRC})
            b = page.evaluate(ADD_JS, {'name': 'TST197b', 'src': V6_SRC})
            print('    v5:', a.get('status'), str(a.get('errors'))[:120])
            print('    v6:', b.get('status'), str(b.get('errors'))[:120])
            check('v5 engine ok', a['status'] == 'ok', a.get('errors'))
            check('v6 engine ok', b['status'] == 'ok', b.get('errors'))
            va, vb = a.get('vals') or {}, b.get('vals') or {}
            check('v5 7/2 == 3', va.get('lit') == 3, va.get('lit'))
            check('v6 7/2 == 3.5', vb.get('lit') == 3.5, vb.get('lit'))
            try:
                import math as _m
                check('v5 bar_index truncated', va['bi'] == _m.trunc(a['idx'] / 2), (va.get('bi'), a.get('idx')))
                check('v6 bar_index float', abs(vb['bi'] - b['idx'] / 2) < 1e-9, (vb.get('bi'), b.get('idx')))
            except TypeError:
                check('bar_index numeric both', False, (va.get('bi'), vb.get('bi')))
            try:
                check('v5 close/2 exact', abs(va['fl'] - a['close'] / 2) < 1e-9, (va.get('fl'), a.get('close')))
                check('v6 close/2 exact', abs(vb['fl'] - b['close'] / 2) < 1e-9, (vb.get('fl'), b.get('close')))
            except TypeError:
                check('close/2 numeric both', False, (va.get('fl'), vb.get('fl')))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND197: %d failed' % len(FAILS) if FAILS else 'ROUND197: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
