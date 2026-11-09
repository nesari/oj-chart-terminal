#!/usr/bin/env python3
"""ROUND178 e2e — tester visual-polish pass (pills, chart furniture, export)."""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8978, 8806
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

SRC = ('//@version=5\nstrategy("TST178", overlay=true, initial_capital=10000)\n'
       'if bar_index == 100\n'
       '    strategy.entry("SigA", strategy.long)\n'
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
            page.evaluate(ADD_JS, {'name': 'TST178', 'src': SRC})
            page.click('#std-toggle-btn')
            page.wait_for_selector('#strat-dock:not(.hidden)', timeout=10000)
            page.wait_for_selector('#tst-perf svg.tst-svg', timeout=10000)
            pills = page.query_selector_all('#tst-head .tst-pill')
            check('toolbar pills (>=2)', len(pills) >= 2, len(pills))
            check('range pill carries calendar glyph', page.query_selector('#tst-head .tst-pill svg') is not None)
            head_txt = page.text_content('#tst-head') or ''
            check('pills keep capital text', 'USD' in head_txt, head_txt[:100])
            summ = page.text_content('#tst-summary') or ''
            check('Key stats title', 'Key stats' in summ, summ[:80])
            check('Total P&L still shown', 'Total P&L' in summ, summ[:120])
            grids = page.query_selector_all('#tst-perf line.tst-grid')
            check('chart gridlines (5)', len(grids) == 5, len(grids))
            axes = page.query_selector_all('#tst-perf text.tst-ax')
            check('axis labels max/0/min (3)', len(axes) == 3, len(axes))
            check('export button has glyph', page.query_selector('.tst-csv svg') is not None)
            csv_title = page.get_attribute('.tst-csv', 'title') or ''
            check('export tooltip says Export positions', csv_title == 'Export positions', csv_title[:40])
            check('long side styled', page.query_selector('#tst-trades .tst-long') is not None)
            check('toggle segmented', page.query_selector('#tst-groups .tst-tg.on') is not None)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND178: %d failed' % len(FAILS) if FAILS else 'ROUND178: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
