#!/usr/bin/env python3
"""ROUND194 e2e — Performance Summary table (TV All/Long/Short)."""
import http.server, functools, os, re, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8987, 8815
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

SRC = ('//@version=5\nstrategy("TST194", overlay=true, initial_capital=100000)\n'
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

READ_JS = """() => {
  const rows = {};
  document.querySelectorAll('#tst-perfsum .tst-prow[data-pk]').forEach((r) => {
    rows[r.dataset.pk] = [...r.querySelectorAll('.tst-pv')].map((c) => c.textContent);
  });
  const key = {};
  document.querySelectorAll('#tst-summary .tst-stat').forEach((s) => {
    const k = s.querySelector('.tst-k'), v = s.querySelector('.tst-v');
    if (k && v) key[k.textContent] = v.textContent;
  });
  const head = [...document.querySelectorAll('#tst-perfsum .tst-prow.tst-ph .tst-pv')].map((c) => c.textContent);
  const pager = ((document.querySelector('#tst-trades .tst-pageinfo') || {}).textContent) || '';
  return { rows, key, head, pager };
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
            page.evaluate(ADD_JS, {'name': 'TST194', 'src': SRC})
            page.click('#std-toggle-btn')
            page.wait_for_selector('#strat-dock:not(.hidden)', timeout=10000)
            page.wait_for_selector('#tst-perfsum .tst-prow[data-pk="net"]', timeout=10000)
            d = page.evaluate(READ_JS)
            rows, key, head, pager = d['rows'], d['key'], d['head'], d['pager']
            check('section present', 'net' in rows, list(rows)[:5])
            check('header All/Long/Short', head == ['All', 'Long', 'Short'], head)
            check('27 rows', len(rows) == 27, len(rows))
            check('net row has money+pct', '%' in (rows.get('net', [''])[0] or ''), rows.get('net'))
            check('net All == key-stats Total P&L', (rows.get('net', [''])[0] or '') == (key.get('Total P&L') or ''), (rows.get('net'), key.get('Total P&L')))
            ca = rows.get('closed', [])
            try:
                nall, nlong, nshort = int(ca[0]), int(ca[1]), int(ca[2])
                check('closed All == Long + Short', nall == nlong + nshort, ca)
                check('trades exist', nall > 0, ca)
            except (ValueError, IndexError):
                check('closed counts parse', False, ca)
            m = re.search(r'(\d+)\s+trades', pager)
            check('closed All == pager count', bool(m) and int(m.group(1)) == nall, (pager, ca))
            check('gross rows', 'grossp' in rows and 'grossl' in rows)
            check('drawdown row', 'drawdown' in rows and len(rows.get('drawdown', [])) == 3)
            check('profit factor row', rows.get('pf', [''])[0] not in ('', None), rows.get('pf'))
            check('percent profitable', '%' in (rows.get('winpct', [''])[0] or ''), rows.get('winpct'))
            check('avg bars rows', 'bars' in rows and 'barsw' in rows and 'barsl' in rows)
            check('margin calls zero', (rows.get('margin', [''])[0] or '') == '0', rows.get('margin'))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND194: %d failed' % len(FAILS) if FAILS else 'ROUND194: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
