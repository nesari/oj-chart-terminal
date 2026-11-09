#!/usr/bin/env python3
"""ROUND183 e2e — Trades analysis tabs (Distribution/Streaks/Time)."""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8986, 8814
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

SRC = ('//@version=5\nstrategy("TST183", overlay=true, initial_capital=100000)\n'
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
            page.evaluate(ADD_JS, {'name': 'TST183', 'src': SRC})
            page.click('#std-toggle-btn')
            page.wait_for_selector('#strat-dock:not(.hidden)', timeout=10000)
            page.wait_for_selector('#tst-analysis .tst-toggle', timeout=10000)
            secs = page.text_content('#tst-analysis') or ''
            check('section title', 'Trades analysis' in secs, secs[:100])
            tabs = page.query_selector_all('#tst-analysis .tst-tg')
            check('three tabs', len(tabs) == 3, len(tabs))
            check('distribution cards', 'Expectancy' in secs and 'Largest profit' in secs, secs[:200])
            check('returns histogram', 'Returns distribution' in secs, secs[:200])
            check('histogram bars', len(page.query_selector_all('#tst-analysis rect.tst-hbar-w, #tst-analysis rect.tst-hbar-l')) > 3)
            check('donut total', 'Total trades' in secs, secs[-200:])
            check('donut legend', 'Winners' in secs and 'Losers' in secs, secs[-200:])
            page.click('#tst-analysis .tst-tg:nth-child(2)')
            page.wait_for_timeout(300)
            s2 = page.text_content('#tst-analysis') or ''
            check('streak cards', 'Longest win streak' in s2 and 'Current streak' in s2, s2[:200])
            check('streak chart', 'Streaks in order' in s2, s2[:200])
            page.click('#tst-analysis .tst-tg:nth-child(3)')
            page.wait_for_timeout(300)
            s3 = page.text_content('#tst-analysis') or ''
            check('weekday rows', 'Mon' in s3 and 'Fri' in s3, s3[:200])
            check('weekday bars', len(page.query_selector_all('#tst-analysis .tst-wrow')) == 7)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND183: %d failed' % len(FAILS) if FAILS else 'ROUND183: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
