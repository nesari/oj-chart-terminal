#!/usr/bin/env python3
"""ROUND180 e2e — redesigned Performance chart + full trade-list pager."""
import http.server, functools, os, re, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8980, 8808
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

SRC = ('//@version=5\nstrategy("TST180", overlay=true, initial_capital=10000)\n'
       'if bar_index % 2 == 0\n'
       '    strategy.entry("L", strategy.long)\n'
       'if bar_index % 2 == 1\n'
       '    strategy.close("X")\n'
       'plot(strategy.position_size, title="p")\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const rep = A.PineUI.strategyReport(pane, inst.id);
  return { instId: inst.id, n: rep ? rep.trades.length : -1,
    pos: rep && rep.posBar ? rep.posBar.length : -1 };
}"""

def first_nums(page, sel, count):
    rows = page.query_selector_all(sel)
    out = []
    for r in rows[:count]:
        t = r.text_content() or ''
        m = re.match(r'\s*(\d+)', t)
        out.append(int(m.group(1)) if m else -1)
    return out

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
            r = page.evaluate(ADD_JS, {'name': 'TST180', 'src': SRC})
            check('100+ trades generated', isinstance(r['n'], int) and r['n'] > 100, r['n'])
            check('position strip in report', isinstance(r['pos'], int) and r['pos'] > 10, r['pos'])
            total = r['n']
            page.click('#std-toggle-btn')
            page.wait_for_selector('#strat-dock:not(.hidden)', timeout=10000)
            page.wait_for_selector('#tst-perf svg.tst-svg', timeout=10000)
            chips = page.query_selector_all('#tst-perf button.tst-chip')
            check('four toggle chips', len(chips) == 4, len(chips))
            check('position strip painted', page.query_selector('#tst-perf rect.tst-p-long, #tst-perf rect.tst-p-flat') is not None)
            check('zero line drawn', page.query_selector('#tst-perf line.tst-zero') is not None)
            check('time axis ticks (day+time mix)', len(page.query_selector_all('#tst-perf text.tst-axt')) >= 4)
            # toggle Buy&hold off -> its polyline disappears, toggle back
            page.click('#tst-perf button.tst-chip:nth-child(2)')
            page.wait_for_timeout(300)
            check('BH toggle hides series', page.query_selector('#tst-perf polyline.tst-bh') is None)
            page.click('#tst-perf button.tst-chip:nth-child(2)')
            page.wait_for_timeout(300)
            check('BH toggle restores series', page.query_selector('#tst-perf polyline.tst-bh') is not None)
            # hover tooltip
            page.hover('#tst-perf svg.tst-svg')
            page.wait_for_timeout(400)
            tip = page.text_content('#tst-perf .tst-tip:not(.hidden)') or ''
            check('hover tooltip with PnL', 'PnL' in tip, tip[:120])
            capline = page.text_content('#tst-perf .tst-capline') or ''
            check('caption is relative (Cumulative)', 'Cumulative' in capline, capline[:100])
            # pager: full list, newest first, continuous numbering
            page.click('#sd-tabs .sd-tab[data-sdtab="trades"]')
            page.wait_for_selector('#sd-trades:not(.hidden)', timeout=10000)
            info = page.text_content('#tst-trades .tst-pageinfo') or ''
            check('pager counts all trades', str(total) + ' trades' in info, info[:80])
            p1 = page.query_selector_all('#tst-trades .tst-trow')
            check('page 1 holds 100 rows', len(p1) == 100, len(p1))
            n1 = first_nums(page, '#tst-trades .tst-trow', 1)[0]
            check('page 1 starts at newest (#%d)' % total, n1 == total, n1)
            page.click('#tst-trades .tst-pager button:nth-child(3)')
            page.wait_for_timeout(400)
            info2 = page.text_content('#tst-trades .tst-pageinfo') or ''
            check('pager moves to page 2', info2.strip().startswith('Page 2 of'), info2[:80])
            n2 = first_nums(page, '#tst-trades .tst-trow', 1)[0]
            check('numbering continuous across pages', n2 == n1 - 100, (n1, n2))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND180: %d failed' % len(FAILS) if FAILS else 'ROUND180: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
