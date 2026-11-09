#!/usr/bin/env python3
"""ROUND177 e2e — Profits breakdown (by signal/side) + CSV export, live app."""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8977, 8805
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

SRC = ('//@version=5\nstrategy("TST177", overlay=true, initial_capital=10000)\n'
       'if bar_index == 100\n'
       '    strategy.entry("SigA", strategy.long)\n'
       'if bar_index == 150\n'
       '    strategy.entry("SigB", strategy.short)\n'
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
            ctx = browser.new_context(viewport={'width': 1560, 'height': 900}, accept_downloads=True)
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 300", timeout=25000)
            page.evaluate(ADD_JS, {'name': 'TST177', 'src': SRC})
            page.click('#std-toggle-btn')
            page.wait_for_selector('#strat-dock:not(.hidden)', timeout=10000)
            page.wait_for_selector('#tst-groups .tst-grow', timeout=10000)
            grows = page.query_selector_all('#tst-groups .tst-grow')
            check('two signal rows', len(grows) == 2, len(grows))
            txt = page.text_content('#tst-groups') or ''
            check('SigA row', 'SigA' in txt, txt[:160])
            check('SigB row', 'SigB' in txt, txt[:160])
            bars = page.query_selector_all('#tst-groups svg rect')
            check('group bars drawn', len(bars) == 2, len(bars))
            page.click('#tst-groups .tst-tg:nth-child(2)')
            page.wait_for_timeout(300)
            txt2 = page.text_content('#tst-groups') or ''
            check('By side shows Long', 'Long' in txt2, txt2[:160])
            check('By side shows Short', 'Short' in txt2, txt2[:160])
            page.click('#sd-tabs .sd-tab[data-sdtab="trades"]')
            page.wait_for_selector('#sd-trades:not(.hidden)', timeout=10000)
            with page.expect_download(timeout=10000) as dl_info:
                page.click('.tst-csv')
            dl = dl_info.value
            path = dl.path()
            with open(path, 'r', encoding='utf-8') as f:
                body = f.read()
            check('csv filename', (dl.suggested_filename or '').endswith('-trades.csv'), dl.suggested_filename)
            check('csv header', body.split('\n')[0].startswith('Trade,Side,Qty,'), body.split('\n')[0][:40])
            check('csv has 2 trade rows', len([l for l in body.strip().split('\n')]) == 3, body[:200])
            check('csv SigA/Long direction mix', 'Long' in body and 'Short' in body, body[:200])
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND177: %d failed' % len(FAILS) if FAILS else 'ROUND177: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
