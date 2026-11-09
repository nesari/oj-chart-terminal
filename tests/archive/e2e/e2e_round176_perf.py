#!/usr/bin/env python3
"""ROUND176 e2e — tester Performance chart (equity vs buy&hold) on live app."""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8976, 8804
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

SRC = ('//@version=5\nstrategy("TST176", overlay=true, initial_capital=10000)\n'
       'if bar_index == 100\n'
       '    strategy.entry("L", strategy.long)\n'
       'if bar_index == 200\n'
       '    strategy.close("X")\n'
       'plot(strategy.position_size, title="p")\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const rep = A.PineUI.strategyReport(pane, inst.id);
  return { instId: inst.id, hasPerf: !!(rep && rep.perf),
    eqN: rep && rep.perf && rep.perf.equity ? rep.perf.equity.length : -1,
    bhN: rep && rep.perf && rep.perf.buyHold ? rep.perf.buyHold.length : -1,
    cap: rep && rep.perf ? rep.perf.capital : null };
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
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 300", timeout=25000)
            r = page.evaluate(ADD_JS, {'name': 'TST176', 'src': SRC})
            check('report carries perf', r['hasPerf'], r)
            check('equity series non-trivial', isinstance(r['eqN'], int) and r['eqN'] > 10, r['eqN'])
            check('buy&hold series present', isinstance(r['bhN'], int) and r['bhN'] > 10, r['bhN'])
            check('perf capital 10000', r['cap'] == 10000, r['cap'])
            page.click('#std-toggle-btn')
            page.wait_for_selector('#strat-dock:not(.hidden)', timeout=10000)
            page.wait_for_selector('#tst-perf svg.tst-svg', timeout=10000)
            check('perf svg rendered', True)
            eq_pts = page.get_attribute('#tst-perf polyline.tst-eq', 'points') or ''
            bh_pts = page.get_attribute('#tst-perf polyline.tst-bh', 'points') or ''
            check('equity polyline has points', len(eq_pts.split()) > 10, len(eq_pts.split()))
            check('buy&hold polyline has points', len(bh_pts.split()) > 10, len(bh_pts.split()))
            capline = page.text_content('#tst-perf .tst-capline') or ''
            check('caption shows Cumulative', 'Cumulative' in capline, capline[:100])
            check('caption shows Buy&hold', 'Buy&hold' in capline, capline[:100])
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND176: %d failed' % len(FAILS) if FAILS else 'ROUND176: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
