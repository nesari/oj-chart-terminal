#!/usr/bin/env python3
"""ROUND230 e2e — vendor-feed stubs + currency conversion, live.

  Identity paths run ok (currency_rate USD/USD = 1, convert_to_account = x);
  dividends/footprint/quandl surface loud feed-specific runtime errors.
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8971, 8850
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

SRC_OK = ('//@version=6\nindicator("TST230A", overlay=true)\n'
          'r = request.currency_rate("USD", "USD")\n'
          'plot(r)\n')

SRC_STRAT = ('//@version=6\nstrategy("TST230B", overlay=true)\n'
             'a = strategy.convert_to_account(100)\n'
             'plot(a)\n')

SRC_DIV = ('//@version=6\nindicator("TST230C", overlay=true)\n'
           'd = request.dividends("NASDAQ:AAPL")\n'
           'plot(d)\n')

SRC_FP = ('//@version=6\nindicator("TST230D", overlay=true)\n'
          'fp = request.footprint(5)\n'
          'plot(1)\n')

SRC_Q = ('//@version=6\nindicator("TST230E", overlay=true)\n'
         'q = request.quandl("CFTC/SB_FO_ALL")\n'
         'plot(q)\n')

READ_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  for (let i = 0; i < 60; i++) {
    const s0 = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
    if (s0 && s0.status !== 'loading') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { instId: inst.id, status: st ? st.status : 'no-st', errors: (st && st.errors) || [] };
  try {
    const keys = st.rt.out.plotsOrder;
    out.first = keys.length ? st.rt.out.plots.get(keys[0]).values.slice(-1)[0] : null;
  } catch (e) { out.probeErr = String(e); }
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
            a = page.evaluate(READ_JS, {'name': 'TST230A', 'src': SRC_OK})
            print('    ident:', a.get('status'), a.get('first'), a.get('probeErr', ''))
            check('currency identity ok live', a['status'] == 'ok' and a.get('first') == 1, a)
            b = page.evaluate(READ_JS, {'name': 'TST230B', 'src': SRC_STRAT})
            print('    convert:', b.get('status'), b.get('first'))
            check('convert identity ok live', b['status'] == 'ok', b)
            c = page.evaluate(READ_JS, {'name': 'TST230C', 'src': SRC_DIV})
            print('    dividends:', c.get('status'), c.get('errors'))
            check('dividends loud live', c['status'] == 'error' and any('dividends' in str(e) for e in c.get('errors', [])), c)
            d = page.evaluate(READ_JS, {'name': 'TST230D', 'src': SRC_FP})
            print('    footprint:', d.get('status'), d.get('errors'))
            check('footprint loud live', d['status'] == 'error' and any('footprint' in str(e) for e in d.get('errors', [])), d)
            e = page.evaluate(READ_JS, {'name': 'TST230E', 'src': SRC_Q})
            print('    quandl:', e.get('status'), e.get('errors'))
            check('quandl deprecated live', e['status'] == 'error' and any('deprecated' in str(e) for e in e.get('errors', [])), e)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND230: %d failed' % len(FAILS) if FAILS else 'ROUND230: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
