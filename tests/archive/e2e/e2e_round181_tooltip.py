#!/usr/bin/env python3
"""ROUND181 e2e — trade-aware tooltip (excursions + click-to-chart)."""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8982, 8810
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

SRC = ('//@version=5\nstrategy("TST181", overlay=true, initial_capital=100000)\n'
       'fast = ta.sma(close, 14)\nslow = ta.sma(close, 28)\n'
       'if ta.crossover(fast, slow)\n    strategy.entry("Long", strategy.long)\n'
       'if ta.crossunder(fast, slow)\n    strategy.entry("Short", strategy.short)\n'
       'plot(strategy.position_size, title="p")\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const rep = A.PineUI.strategyReport(pane, inst.id);
  const t0 = rep && rep.trades.length ? rep.trades[0] : null;
  return { instId: inst.id, n: rep ? rep.trades.length : -1,
    mfe: t0 && typeof t0.mfe === 'number', mae: t0 && typeof t0.mae === 'number' };
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
            r = page.evaluate(ADD_JS, {'name': 'TST181', 'src': SRC})
            check('trades generated', isinstance(r['n'], int) and r['n'] > 2, r['n'])
            check('report carries mfe', r['mfe'] is True, r)
            check('report carries mae', r['mae'] is True, r)
            page.click('#std-toggle-btn')
            page.wait_for_selector('#strat-dock:not(.hidden)', timeout=10000)
            page.wait_for_selector('#tst-perf svg.tst-svg', timeout=10000)
            page.query_selector('#tst-perf svg.tst-svg').scroll_into_view_if_needed()
            page.wait_for_timeout(300)
            box = page.query_selector('#tst-perf svg.tst-svg').bounding_box()
            page.mouse.move(box['x'] + box['width'] * 0.35, box['y'] + box['height'] * 0.45)
            page.wait_for_timeout(500)
            tip = page.text_content('#tst-perf .tst-tip:not(.hidden)') or ''
            check('tooltip names the trade', 'Trade ' in tip, tip[:140])
            check('tooltip cumulative PnL', 'Cumulative PnL' in tip, tip[:140])
            check('tooltip favorable excursion', 'Favorable excursion' in tip, tip[:200])
            check('tooltip adverse excursion', 'Adverse excursion' in tip, tip[:200])
            check('tooltip TV date', tip.count(',') >= 3, tip[:200])
            check('tooltip click hint', 'Click to show on chart' in tip, tip[:200])
            page.click('#tst-perf .tst-tip:not(.hidden)')
            page.wait_for_timeout(800)
            body_txt = page.text_content('body') or ''
            check('click jumps the chart (toast)', 'Go to Date' in body_txt, body_txt[-200:])
            h = page.evaluate("() => { const r = document.querySelector('#tst-perf rect.tst-p-long, #tst-perf rect.tst-p-short, #tst-perf rect.tst-p-flat'); return r ? r.getAttribute('height') : null; }")
            check('position strip is thin (3px)', h == '3', h)
            check('time ticks present', len(page.query_selector_all('#tst-perf text.tst-axt')) >= 4)
            page.click('#sd-tabs .sd-tab[data-sdtab="trades"]')
            page.wait_for_selector('#sd-trades:not(.hidden)', timeout=10000)
            bb = page.query_selector('.tst-csv').bounding_box()
            check('export button visible', bb and bb['height'] >= 18 and bb['width'] >= 18, bb)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND181: %d failed' % len(FAILS) if FAILS else 'ROUND181: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
