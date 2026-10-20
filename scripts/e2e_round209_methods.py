#!/usr/bin/env python3
"""ROUND209 e2e — named method-form calls on the live app.

  a.get(index=...), ln.set_x1(x=...) and m.put(key=..., value=...) must match
  their positional twins bar-for-bar on live data. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8991, 8829
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

SRC = ('//@version=5\nindicator("TST209", overlay=true)\n'
       'a = array.from(close, open, high, low)\n'
       'array.sort(id=a, order=order.descending)\n'
       'v1 = a.get(index=0)\n'
       'v2 = a.get(0)\n'
       'l = line.new(bar_index, high, bar_index + 1, low)\n'
       'l.set_x1(x=bar_index + 3)\n'
       'x1 = l.get_x1()\n'
       'm = map.new<string, float>()\n'
       'm.put(key="k", value=close)\n'
       'mv = m.get(key="k")\n'
       'plot(v1, title="m1")\n'
       'plot(v2, title="m2")\n'
       'plot(x1, title="x1")\n'
       'plot(mv, title="mv")\n')

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
            r = page.evaluate(READ_JS, {'name': 'TST209', 'src': SRC})
            print('    engine:', r.get('status'), str(r.get('errors'))[:120])
            check('engine ok', r['status'] == 'ok', r.get('errors'))
            v = r.get('vals') or {}
            m1, m2 = v.get('m1') or [], v.get('m2') or []
            n = min(len(m1), len(m2))
            bad = sum(1 for i in range(n) if (m1[i] is None) != (m2[i] is None) or (m1[i] is not None and abs(m1[i] - m2[i]) > 1e-9))
            check('method named == positional (%d bars)' % n, n > 100 and bad == 0, bad)
            x1 = v.get('x1') or []
            check('line setter applied live', len(x1) > 100 and all(x is not None for x in x1[-50:]), len(x1))
            mv = v.get('mv') or []
            check('map named round-trips live', len(mv) > 100 and any(x is not None for x in mv), len(mv))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND209: %d failed' % len(FAILS) if FAILS else 'ROUND209: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
