#!/usr/bin/env python3
"""ROUND202 e2e — ticker.heikinashi on the live app.

  request.security(haTicker, period, close) must equal a hand-rolled HA
  close series (var recursion) bar-for-bar, and the daily HA must move
  stepwise. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8995, 8823
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

SRC = ('//@version=5\nindicator("TST202", overlay=false)\n'
       'hat = ticker.heikinashi(syminfo.tickerid)\n'
       'hac = request.security(hat, "", close)\n'
       'hao = request.security(hat, "", open)\n'
       'plot(hac, title="hac")\n'
       'plot(hao, title="hao")\n'
       'var float mo = na\n'
       'var float mc = na\n'
       'mc := (open + high + low + close) / 4\n'
       'mo := na(mo) ? (open + close) / 2 : (mo[1] + mc[1]) / 2\n'
       'plot(mc, title="refc")\n'
       'plot(mo, title="refo")\n'
       'had = request.security(hat, "D", close)\n'
       'plot(had, title="hadd")\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { instId: inst.id, status: st ? st.status : 'no-st',
    errors: (st && st.errors) || [], vals: {} };
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
            r = page.evaluate(ADD_JS, {'name': 'TST202', 'src': SRC})
            print('    engine:', r.get('status'), str(r.get('errors'))[:120])
            check('engine ok', r['status'] == 'ok', r.get('errors'))
            v = r.get('vals') or {}
            hac, refc = v.get('hac') or [], v.get('refc') or []
            hao, refo = v.get('hao') or [], v.get('refo') or []
            try:
                n = min(len(hac), len(refc))
                bad = sum(1 for i in range(n) if abs(hac[i] - refc[i]) > 1e-9)
                check('haClose == hand-rolled (%d bars)' % n, n > 50 and bad == 0, bad)
                m = min(len(hao), len(refo))
                bad2 = sum(1 for i in range(m) if abs(hao[i] - refo[i]) > 1e-9)
                check('haOpen == hand-rolled (%d bars)' % m, m > 50 and bad2 == 0, bad2)
            except TypeError:
                check('HA series numeric', False, (len(hac), len(refc)))
            hadd = v.get('hadd') or []
            try:
                steps = sum(1 for i in range(1, len(hadd)) if abs(hadd[i] - hadd[i - 1]) > 1e-12)
                check('daily HA stepwise constant within days', len(hadd) > 50 and steps < len(hadd) / 3, (steps, len(hadd)))
                check('daily HA differs from intraday', any(abs(a - b) > 1e-9 for a, b in zip(hadd, hac)), 'identical?!')
            except TypeError:
                check('daily HA present', False, len(hadd))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND202: %d failed' % len(FAILS) if FAILS else 'ROUND202: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
