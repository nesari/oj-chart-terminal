#!/usr/bin/env python3
"""ROUND184 e2e — chart trade markers (toggle + removal) and range backfill."""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8988, 8816
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

SRC = ('//@version=5\nstrategy("TST184", overlay=true, initial_capital=10000)\n'
       'if bar_index == 100\n    strategy.entry("L", strategy.long)\n'
       'if bar_index == 200\n    strategy.close("X")\n'
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

# ROUND184b: paint-level pin - wrap series.setMarkers and record what the
# funnel actually delivers to Lightweight Charts.
SPY_JS = """() => {
  const pane = window.__app.App.panes[0];
  window.__painted = [];
  const orig = pane.series.setMarkers.bind(pane.series);
  pane.series.setMarkers = (m) => {
    window.__painted.push(((m || []).map((x) => x.text).join(',')));
    return orig(m);
  };
  return true;
}"""

MARKS_JS = """() => {
  const A = window.__app; const pane = A.App.panes[0];
  const m = A.PineUI.strategyMarkers ? A.PineUI.strategyMarkers(pane) : null;
  return m ? m.map((x) => x.text + '@' + x.time) : null;
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
            r = page.evaluate(ADD_JS, {'name': 'TST184', 'src': SRC})
            inst_id = r['instId']
            page.evaluate(SPY_JS)
            page.evaluate("""(id) => { const A = window.__app; const p = A.App.panes[0];
              const it = (p.pineScripts || []).find((x) => String(x.id) === String(id));
              return A.PineUI.rebuild(p, it); }""", inst_id)
            page.wait_for_timeout(5000)
            painted = page.evaluate('() => window.__painted || []')
            check('funnel paints Buy+Exit on the series', any(('Buy' in (c or '') and 'Exit' in (c or '')) for c in painted), painted[-3:])
            page.click('#std-toggle-btn')
            page.wait_for_selector('#strat-dock:not(.hidden)', timeout=10000)
            page.wait_for_timeout(1000)
            m = page.evaluate(MARKS_JS)
            check('Buy+Exit markers on chart', isinstance(m, list) and len(m) == 2, m)
            check('entry flag is Buy', isinstance(m, list) and len(m) == 2 and m[0].startswith('Buy@'), m)
            check('toggle checked by default', page.is_checked('#sd-marks'))
            page.click('#sd-marks')
            page.wait_for_timeout(400)
            m2 = page.evaluate(MARKS_JS)
            check('toggle hides markers', m2 == [], m2)
            page.click('#sd-marks')
            page.wait_for_timeout(400)
            m3 = page.evaluate(MARKS_JS)
            check('toggle restores markers', isinstance(m3, list) and len(m3) == 2, m3)
            # removal cleans markers
            page.evaluate("""(id) => { const A = window.__app; A.PineUI.remove(A.App.panes[0], id); }""", inst_id)
            page.wait_for_timeout(600)
            m4 = page.evaluate(MARKS_JS)
            check('removal drops markers', m4 == [], m4)
            # backfill: ask a custom range starting 60 days before the head
            page.evaluate(ADD_JS, {'name': 'TST184B', 'src': SRC})
            page.wait_for_timeout(1000)
            before = page.evaluate("() => { const p = window.__app.App.panes[0]; return { head: p.bars[0].time, n: p.bars.length, done: !!p._olderDone }; }")
            old_from = page.evaluate("() => { const p = window.__app.App.panes[0]; const d = new Date((p.bars[0].time - 60*86400) * 1000); return d.toISOString().slice(0, 10); }")
            page.select_option('#sd-range', 'custom')
            page.fill('#sd-from', old_from)
            page.fill('#sd-to', '')
            page.click('#sd-apply')
            page.wait_for_timeout(12000)
            after = page.evaluate("() => { const p = window.__app.App.panes[0]; return { head: p.bars[0].time, n: p.bars.length, done: !!p._olderDone }; }")
            check('backfill walked left or ran dry', after['head'] < before['head'] or after['done'] is True, (before, after))
            summ = page.text_content('#tst-summary') or ''
            check('report alive after backfill', 'Total P&L' in summ, summ[:100])
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND184: %d failed' % len(FAILS) if FAILS else 'ROUND184: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
