#!/usr/bin/env python3
"""ROUND206 e2e — strategy currency + timeframe.change reach the live app.

  A GBP strategy: engine ok, the tester header carries the GBP currency, and
  a TF-switch flag script runs clean. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8998, 8826
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

SRC_CUR = ('//@version=5\nstrategy("TST206C", overlay=true, currency=currency.GBP)\n'
           'if ta.crossover(ta.sma(close, 10), ta.sma(close, 30))\n'
           '    strategy.entry("L", strategy.long)\n'
           'plot(strategy.account_currency, title="cur")\n')

SRC_CHG = ('//@version=5\nindicator("TST206T", overlay=true)\n'
           'tf = input.timeframe("D", "TF")\n'
           'nt = timeframe.change(tf)\n'
           'plot(nt ? 1 : 0, title="nt")\n')

READ_JS = """async ({cur, chg}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const out = {};
  const rc = A.PineScriptsStore.create('TST206C', cur);
  const ic = A.PineUI.add(pane, rc.id);
  await A.PineUI.rebuild(pane, ic);
  await new Promise((r) => setTimeout(r, 3500));
  const sc = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === ic.id);
  out.cur = { status: sc ? sc.status : 'no-st', errors: (sc && sc.errors) || [] };
  const dock = document.querySelector('#strat-dock') || document.body;
  out.curHeader = (dock.textContent || '').slice(0, 2000);
  const rg = A.PineScriptsStore.create('TST206T', chg);
  const ig = A.PineUI.add(pane, rg.id);
  await A.PineUI.rebuild(pane, ig);
  await new Promise((r) => setTimeout(r, 2500));
  const sg = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === ig.id);
  out.chg = { status: sg ? sg.status : 'no-st', errors: (sg && sg.errors) || [] };
  A.PineUI.remove(pane, ic.id);
  A.PineUI.remove(pane, ig.id);
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
            r = page.evaluate(READ_JS, {'cur': SRC_CUR, 'chg': SRC_CHG})
            print('    cur:', r['cur'].get('status'), str(r['cur'].get('errors'))[:120])
            print('    chg:', r['chg'].get('status'), str(r['chg'].get('errors'))[:120])
            check('GBP strategy engine ok', r['cur']['status'] == 'ok', r['cur'].get('errors'))
            check('tester header shows GBP', 'GBP' in str(r.get('curHeader')), str(r.get('curHeader'))[:200])
            check('timeframe.change script ok', r['chg']['status'] == 'ok', r['chg'].get('errors'))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND206: %d failed' % len(FAILS) if FAILS else 'ROUND206: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
