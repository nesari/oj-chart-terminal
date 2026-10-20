#!/usr/bin/env python3
"""ROUND212 e2e — process_orders_on_close live: declaration + dialog override.

  Plain vs flag strategies (bar_index-anchored signals): the flag entry sits
  one bar earlier at that bar's close. Ticking the new Properties checkbox on
  the plain script moves its entry to the flag bar (dialog override path).
  Also dumps dialog diagnostics (row labels, closed state). Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8994, 8832
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

def SRC(flag):
    decl = ', process_orders_on_close=true' if flag else ''
    return ('//@version=5\nstrategy("TST212%s", overlay=true%s)\n'
            'sig = bar_index == 4700\n'
            'out = bar_index == 4800\n'
            'if sig\n    strategy.entry("L", strategy.long)\n'
            'if out\n    strategy.close("L")\n'
            'plot(strategy.closedtrades > 0 ? 1 : 0, title="done")\n') % ('F' if flag else 'P', decl)

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const rep = A.PineUI.strategyReport(pane, inst.id);
  const bars = pane.bars;
  const t = rep && rep.trades && rep.trades[0];
  let okflag = null;
  if (t) {
    const eb = bars[t.entryBar], xb = bars[t.exitBar];
    okflag = { entryBar: t.entryBar, exitBar: t.exitBar,
      entryPrice: t.entryPrice, exitPrice: t.exitPrice,
      matchEntry: !!eb && (t.entryPrice === eb.open || t.entryPrice === eb.close),
      matchExit: !!xb && (t.exitPrice === xb.open || t.exitPrice === xb.close) };
  }
  return { instId: inst.id, okflag, n: (rep && rep.trades && rep.trades.length) || 0 };
}"""

DIAG_JS = """(id) => {
  const rows = [...document.querySelectorAll('.pine-props .pine-inp')];
  return {
    n: rows.length,
    labels: rows.map((r) => (r.textContent || '').trim().slice(0, 28)),
    dialogOpen: !!document.querySelector('.ist-dlg:not(.hidden)'),
  };
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
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 400", timeout=25000)
            rp = page.evaluate(ADD_JS, {'name': 'TST212P', 'src': SRC(False)})
            rf = page.evaluate(ADD_JS, {'name': 'TST212F', 'src': SRC(True)})
            print('    plain:', rp['okflag'])
            print('    flag:', rf['okflag'])
            check('both scripts one closed trade', rp['n'] == 1 and rf['n'] == 1, (rp['n'], rf['n']))
            if rp['okflag'] and rf['okflag']:
                check('flag entry one bar earlier', rf['okflag']['entryBar'] == rp['okflag']['entryBar'] - 1,
                      (rf['okflag']['entryBar'], rp['okflag']['entryBar']))
                check('flag exit one bar earlier', rf['okflag']['exitBar'] == rp['okflag']['exitBar'] - 1,
                      (rf['okflag']['exitBar'], rp['okflag']['exitBar']))
                check('entry prices hit bar OHLC', rp['okflag']['matchEntry'] and rf['okflag']['matchEntry'],
                      (rp['okflag'], rf['okflag']))
            # dialog: open plain script settings, tick the new checkbox, Ok
            inst_id = rp["instId"]
            page.click(f'.ind-row[data-pine="{inst_id}"] .ind-btns .ind-btn:nth-child(2)')
            page.wait_for_selector('.pine-tab[data-tab="props"]', timeout=10000)
            page.click('.pine-tab[data-tab="props"]')
            page.wait_for_timeout(400)
            dg = page.evaluate(DIAG_JS, rp['instId'])
            print('    dialog rows:', dg['n'], dg['labels'])
            check('checkbox row present', any('Process orders' in (l or '') for l in dg['labels']), dg['labels'])
            page.locator('.pine-props label', has_text='Process orders on close').locator('input').check()
            page.wait_for_timeout(200)
            page.click('.ist-ok')
            page.wait_for_timeout(4500)
            dg2 = page.evaluate(DIAG_JS, rp['instId'])
            rep2 = page.evaluate("""(id) => {
              const A = window.__app; const pane = A.App.panes[0];
              const rep = A.PineUI.strategyReport(pane, id);
              const t = rep && rep.trades && rep.trades[0];
              return t ? { entryBar: t.entryBar, exitBar: t.exitBar } : null;
            }""", rp['instId'])
            print('    after dialog:', rep2, 'dialogOpen:', dg2['dialogOpen'])
            check('dialog closed on Ok', dg2['dialogOpen'] is False, dg2['dialogOpen'])
            check('dialog override moves entry to flag bar',
                  rep2 and rf['okflag'] and rep2['entryBar'] == rf['okflag']['entryBar'], (rep2, rf['okflag']))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND212: %d failed' % len(FAILS) if FAILS else 'ROUND212: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
