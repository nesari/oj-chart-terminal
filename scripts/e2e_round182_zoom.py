#!/usr/bin/env python3
"""ROUND182 e2e — chart extras: 4 toggles, excursions, zoom, day ticks."""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8984, 8812
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

SRC = ('//@version=5\nstrategy("TST182", overlay=true, initial_capital=100000)\n'
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
  return { instId: inst.id };
}"""

def zw(page):
    return page.get_attribute('#tst-perf svg.tst-svg', 'data-zw') or ''

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
            page.evaluate(ADD_JS, {'name': 'TST182', 'src': SRC})
            page.click('#std-toggle-btn')
            page.wait_for_selector('#strat-dock:not(.hidden)', timeout=10000)
            page.wait_for_selector('#tst-perf svg.tst-svg', timeout=10000)
            chips = page.query_selector_all('#tst-perf button.tst-chip')
            check('four legend toggles', len(chips) == 4, len(chips))
            names = page.text_content('#tst-perf .tst-legend') or ''
            check('excursions row', 'Trades excursions' in names, names[:120])
            check('run-ups row', 'Run-ups and drawdowns' in names, names[:160])
            check('excursion spikes drawn', len(page.query_selector_all('#tst-perf line.tst-exc-f')) > 5)
            check('no runup lines by default', page.query_selector('#tst-perf polyline.tst-ru') is None)
            page.click('#tst-perf button.tst-chip:nth-child(4)')
            page.wait_for_timeout(300)
            check('runup toggle draws lines', page.query_selector('#tst-perf polyline.tst-ru') is not None)
            check('drawdown toggle draws lines', page.query_selector('#tst-perf polyline.tst-dd') is not None)
            page.click('#tst-perf button.tst-chip:nth-child(4)')
            page.wait_for_timeout(300)
            # time axis mixes day dates and intraday times
            ticks = [(t.text_content() or '') for t in page.query_selector_all('#tst-perf text.tst-axt')]
            has_date = any(any(m in t for m in ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')) for t in ticks)
            has_time = any(':' in t for t in ticks)
            check('day-date ticks', has_date, ticks)
            check('intraday time ticks', has_time, ticks)
            # wheel zoom narrows the window, dblclick resets
            check('full window at start', zw(page) == '0,1', zw(page))
            svg = page.query_selector('#tst-perf svg.tst-svg')
            svg.scroll_into_view_if_needed()
            page.wait_for_timeout(300)
            bb = svg.bounding_box()
            page.mouse.move(bb['x'] + bb['width'] * 0.4, bb['y'] + bb['height'] * 0.4)
            page.mouse.wheel(0, -480)
            page.wait_for_timeout(400)
            z1 = zw(page)
            check('wheel zooms in', z1 != '0,1' and z1 != '', z1)
            page.mouse.dblclick(bb['x'] + bb['width'] * 0.4, bb['y'] + bb['height'] * 0.4)
            page.wait_for_timeout(400)
            check('dblclick resets zoom', zw(page) == '0,1', zw(page))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND182: %d failed' % len(FAILS) if FAILS else 'ROUND182: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
