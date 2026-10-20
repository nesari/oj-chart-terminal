#!/usr/bin/env python3
"""ROUND192 e2e — Bar Magnifier declaration + dialog opt-in, live app."""
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

SRC = ('//@version=5\nstrategy("TST192", overlay=true, use_bar_magnifier=true)\n'
       'if bar_index == 100\n    strategy.entry("L", strategy.long)\n'
       'if bar_index == 200\n    strategy.close("X")\n'
       'plot(strategy.position_size, title="p")\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const rep = A.PineUI.strategyReport ? A.PineUI.strategyReport(pane, inst.id) : null;
  return { instId: inst.id, status: st ? st.status : 'no-st',
    mag: st && st.rt && st.rt.meta && st.rt.meta.strategy ? st.rt.meta.strategy.use_bar_magnifier : 'nometa',
    ntrades: rep && rep.trades ? rep.trades.length : -1 };
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
            r = page.evaluate(ADD_JS, {'name': 'TST192', 'src': SRC})
            check('magnifier strategy ok', r['status'] == 'ok', r)
            check('declaration flag parsed', r['mag'] is True, r['mag'])
            check('trade closed (either fill path)', r['ntrades'] == 1, r['ntrades'])
            page.click(f'.ind-row[data-pine="{r["instId"]}"] .ind-btns .ind-btn:nth-child(2)')
            page.wait_for_selector('.pine-tab[data-tab="props"]', timeout=10000)
            page.click('.pine-tab[data-tab="props"]')
            page.wait_for_timeout(300)
            prows = page.text_content('.pine-props') or ''
            check('Properties has magnifier row', 'Use bar magnifier' in prows, prows[:300])
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND192: %d failed' % len(FAILS) if FAILS else 'ROUND192: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
