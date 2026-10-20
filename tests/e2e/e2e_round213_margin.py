#!/usr/bin/env python3
"""ROUND213 e2e — margin requirements live.

  An over-margined entry never opens (engine ok, flat); an affordable
  leveraged entry works with marginCalls 0 in the report and '0' in the
  tester Margin Calls row; the Properties dialog carries 12 rows incl. the
  two margin rows, and setting margin_long applies end-to-end. Zero errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8996, 8834
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

SRC_BIG = ('//@version=5\nstrategy("TST213B", overlay=true, initial_capital=10000, margin_long=100)\n'
           'if bar_index == 4000\n    strategy.entry("L", strategy.long, qty=1000000)\n'
           'plot(strategy.position_size, title="p")\n')

SRC_OK = ('//@version=5\nstrategy("TST213G", overlay=true, initial_capital=10000, margin_long=50)\n'
          'if bar_index == 4000\n    strategy.entry("L", strategy.long, qty=10)\n'
          'plot(strategy.position_size, title="p")\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const rep = A.PineUI.strategyReport(pane, inst.id);
  return { instId: inst.id,
    qty: rep && rep.position ? rep.position.qty : null,
    mc: rep ? rep.marginCalls : null,
    ml: rep ? rep.marginLong : null };
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
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 4100", timeout=25000)
            rb = page.evaluate(ADD_JS, {'name': 'TST213B', 'src': SRC_BIG})
            rg = page.evaluate(ADD_JS, {'name': 'TST213G', 'src': SRC_OK})
            print('    big:', rb)
            print('    good:', rg)
            check('over-margined entry flat', rb['qty'] == 0, rb)
            check('affordable leveraged entry opens', rg['qty'] == 10, rg)
            check('report marginCalls 0, marginLong 50', rg['mc'] == 0 and rg['ml'] == 50, rg)
            # tester dock: Margin Calls row shows 0
            page.click('#std-toggle-btn')
            page.wait_for_selector('#strat-dock:not(.hidden)', timeout=10000)
            page.wait_for_timeout(800)
            mrow = page.text_content('.tst-prow[data-pk="margin"]') or ''
            check('tester Margin Calls row 0', 'Margin Calls' in mrow and '0' in mrow, mrow[:80])
            # dialog: 12 rows, margin rows present; set margin_long=1 applies
            page.click(f'.ind-row[data-pine="{rg["instId"]}"] .ind-btns .ind-btn:nth-child(2)')
            page.wait_for_selector('.pine-tab[data-tab="props"]', timeout=10000)
            page.click('.pine-tab[data-tab="props"]')
            page.wait_for_timeout(400)
            labels = page.eval_on_selector_all('.pine-props .pine-inp', 'els => els.map(e => e.textContent.trim().slice(0, 18))')
            print('    rows:', len(labels), labels)
            check('12 property rows', len(labels) == 12, len(labels))
            check('margin rows present', any('Margin long' in (l or '') for l in labels) and any('Margin short' in (l or '') for l in labels), labels)
            page.locator('.pine-props label', has_text='Margin long').locator('input').fill('1')
            page.wait_for_timeout(200)
            page.click('.ist-ok')
            page.wait_for_timeout(4500)
            rep2 = page.evaluate("""(id) => {
              const A = window.__app;
              return A.PineUI.strategyReport(A.App.panes[0], id);
            }""", rg['instId'])
            check('dialog margin_long=1 applied', rep2 and rep2.get('marginLong') == 1, rep2 and rep2.get('marginLong'))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND213: %d failed' % len(FAILS) if FAILS else 'ROUND213: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
