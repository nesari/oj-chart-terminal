#!/usr/bin/env python3
"""ROUND175 e2e — Strategy Tester upgrades on the live app.

  Covers the user-visible half of round 175 through the real UI:
  STRATEGY badge in the legend, Properties tab in the settings dialog
  (capital 100k + 100% of equity sizing via real inputs + Ok), tester
  header (range + capital), TV-style summary (Total P&L / Profitable /
  Profit factor) and the Return column. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8975, 8803
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

SRC = ('//@version=5\nstrategy("TST175", overlay=true, initial_capital=10000, default_qty_value=1)\n'
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
            r = page.evaluate(ADD_JS, {'name': 'TST175', 'src': SRC})
            inst_id = r['instId']
            # 1. STRATEGY badge in the legend row
            page.wait_for_selector('.pine-strat-tag', timeout=10000)
            tag = page.text_content('.ind-row .pine-strat-tag') or ''
            check('legend STRATEGY badge', 'STRATEGY' in tag, tag[:60])
            # 2. open settings via the row gear, Properties tab must exist
            page.click(f'.ind-row[data-pine="{inst_id}"] .ind-btns .ind-btn:nth-child(2)')
            page.wait_for_selector('.pine-tab[data-tab="props"]', timeout=10000)
            check('Properties tab present', True)
            page.click('.pine-tab[data-tab="props"]')
            page.wait_for_timeout(300)
            rows = page.query_selector_all('.pine-props .pine-inp')
            check('12 property rows (10 + ROUND213 margins)', len(rows) == 12, len(rows))
            if len(rows) == 12:
                rows[0].query_selector('input').fill('100000')
                rows[2].query_selector('input').fill('100')
                rows[3].query_selector('select').select_option('percent')
                page.wait_for_timeout(200)
            page.click('.ist-ok')
            page.wait_for_timeout(4500)
            rep = page.evaluate("""(id) => {
              const A = window.__app; const pane = A.App.panes[0];
              const rep = A.PineUI.strategyReport(pane, id);
              return rep ? { cap: rep.initialCapital, cur: rep.currency,
                qty: rep.trades.length ? rep.trades[0].qty : null,
                n: rep.trades.length, bars: rep.barCount } : null;
            }""", inst_id)
            check('props applied: capital 100k', rep and rep['cap'] == 100000, rep)
            check('props applied: TV-scale qty', rep and isinstance(rep['qty'], (int, float)) and rep['qty'] > 100, rep)
            # 3. tester panel: header + summary + Return column
            page.click('#std-toggle-btn')
            page.wait_for_selector('#strat-dock:not(.hidden)', timeout=10000)
            page.wait_for_timeout(800)
            head = page.text_content('#tst-head') or ''
            check('header shows capital', '100' in head and 'USD' in head, head[:120])
            check('header shows bar count', 'bars' in head, head[:120])
            summ = page.text_content('#tst-summary') or ''
            check('summary shows Total P&L', 'Total P&L' in summ, summ[:160])
            check('summary shows Profitable', 'Profitable' in summ, summ[:160])
            check('summary shows Profit factor', 'Profit factor' in summ, summ[:160])
            thead = page.text_content('#tst-trades .tst-thead') or ''
            check('Return column', 'Return' in thead, thead[:120])
            trows = page.query_selector_all('#tst-trades .tst-trow')
            check('one trade row', len(trows) == 1, len(trows))
            if trows:
                check('row is Long', 'Long' in (trows[0].text_content() or ''), (trows[0].text_content() or '')[:120])
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND175: %d failed' % len(FAILS) if FAILS else 'ROUND175: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
