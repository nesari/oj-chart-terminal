#!/usr/bin/env python3
"""ROUND179 e2e — strategy bottom dock: tabs, sticky toolbar, expand."""
import http.server, functools, os, socket, subprocess, sys, threading, time
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8979, 8807
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

SRC = ('//@version=5\nstrategy("TST179", overlay=true, initial_capital=10000)\n'
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
  return { instId: inst.id };
}"""

REP_JS = """(id) => {
  const A = window.__app; const pane = A.App.panes[0];
  const rep = A.PineUI.strategyReport(pane, id);
  return rep ? { exit: rep.trades.length ? rep.trades[0].exitTime : null,
    cap: rep.initialCapital } : null;
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
            r = page.evaluate(ADD_JS, {'name': 'TST179', 'src': SRC})
            inst_id = r['instId']
            # open via the bottom-toolbar toggle
            page.click('#std-toggle-btn')
            page.wait_for_selector('#strat-dock:not(.hidden)', timeout=10000)
            check('dock opens', True)
            tabs = page.query_selector_all('#sd-tabs .sd-tab')
            check('two tabs', len(tabs) == 2, len(tabs))
            check('overview default', page.query_selector('#sd-overview:not(.hidden)') is not None)
            summ = page.text_content('#tst-summary') or ''
            check('overview shows Key stats', 'Key stats' in summ and 'Total P&L' in summ, summ[:100])
            # trades tab
            page.click('#sd-tabs .sd-tab[data-sdtab="trades"]')
            page.wait_for_timeout(300)
            check('trades tab shows table', page.query_selector('#sd-trades:not(.hidden)') is not None)
            rows = page.query_selector_all('#tst-trades .tst-trow')
            check('one trade row', len(rows) == 1, len(rows))
            check('overview hidden on trades tab', page.query_selector('#sd-overview:not(.hidden)') is None)
            page.click('#sd-tabs .sd-tab[data-sdtab="overview"]')
            page.wait_for_timeout(300)
            # toolbar: custom range AFTER the only trade -> empty, then back
            rep = page.evaluate(REP_JS, inst_id)
            check('one closed trade', rep and rep['exit'], rep)
            after = (datetime.fromtimestamp(rep['exit'], tz=timezone.utc) + timedelta(days=1)).strftime('%Y-%m-%d')
            page.select_option('#sd-range', 'custom')
            page.fill('#sd-from', after)
            page.fill('#sd-to', '')
            page.click('#sd-apply')
            page.wait_for_timeout(800)
            page.click('#sd-tabs .sd-tab[data-sdtab="trades"]')
            page.wait_for_timeout(300)
            empty_txt = page.text_content('#tst-trades') or ''
            check('custom range filters the trade out', 'No closed trades yet' in empty_txt, empty_txt[:100])
            page.click('#sd-tabs .sd-tab[data-sdtab="overview"]')
            page.select_option('#sd-range', 'available')
            page.click('#sd-apply')
            page.wait_for_timeout(800)
            rows2 = page.query_selector_all('#tst-trades .tst-trow')
            check('available range restores the trade', len(rows2) == 1, len(rows2))
            # toolbar: capital edit rebuilds
            page.fill('#sd-cap', '50000')
            page.click('#sd-apply')
            page.wait_for_timeout(5000)
            head = page.text_content('#tst-head') or ''
            check('capital edit applied (50K)', '50K' in head, head[:120])
            # expand / restore
            page.click('#sd-expand')
            page.wait_for_timeout(300)
            cls = page.get_attribute('#strat-dock', 'class') or ''
            check('expand fullscreen', 'sd-full' in cls, cls)
            page.click('#sd-expand')
            page.wait_for_timeout(300)
            cls2 = page.get_attribute('#strat-dock', 'class') or ''
            check('restore from fullscreen', 'sd-full' not in cls2, cls2)
            # rail icon toggles the dock too
            page.click('#right-tabs .rt-btn[data-tab="tester"]')
            page.wait_for_timeout(400)
            check('rail icon closes dock', page.query_selector('#strat-dock:not(.hidden)') is None)
            page.click('#right-tabs .rt-btn[data-tab="tester"]')
            page.wait_for_selector('#strat-dock:not(.hidden)', timeout=10000)
            check('rail icon reopens dock', True)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND179: %d failed' % len(FAILS) if FAILS else 'ROUND179: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
