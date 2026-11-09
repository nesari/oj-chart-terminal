#!/usr/bin/env python3
"""ROUND225 e2e — strategy parity live: exit pairs, label default, alertcondition gate.

  v6 strategy (entry + exit profit=0/limit=far) exits at the entry price
  (first-trigger); a v6 label without textcolor paints WHITE text (canvas
  probe via the live adapter); alertcondition in a strategy lands in error
  status + the Diagnostics log. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8967, 8846
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

SRC_PAIR = ('//@version=6\nstrategy("TST225P", overlay=true)\n'
            'if bar_index == 0\n    strategy.entry("L", strategy.long)\n'
            'if bar_index == 0\n    strategy.exit("X", from_entry="L", profit=0, limit=close + 100)\n')
SRC_LBL = ('//@version=6\nindicator("TST225L", overlay=true)\n'
           'l = label.new(bar_index, high, "X")\nplot(close)\n')
SRC_AC = ('//@version=6\nstrategy("TST225A")\n'
          'if bar_index > 0\n    strategy.entry("L", strategy.long)\n'
          'alertcondition(close > open, title="X", message="m")\n')

READ_JS = """async ({pair, lbl, ac}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const out = {};
  async function add(name, src) {
    const rec = A.PineScriptsStore.create(name, src);
    const inst = A.PineUI.add(pane, rec.id);
    await A.PineUI.rebuild(pane, inst);
    for (let i = 0; i < 40; i++) {
      const s0 = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
      if (s0 && s0.status !== 'loading') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return inst;
  }
  const i1 = await add('TST225P', pair);
  const s1 = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === i1.id);
  out.pairStatus = s1 ? s1.status : 'no-st';
  try {
    const rep = A.PineUI.strategyReport(pane, i1.id);
    const t0 = rep && rep.trades && rep.trades[0];
    out.entryPx = t0 ? t0.entryPrice : null;
    out.exitPx = t0 ? t0.exitPrice : null;
  } catch (e) { out.repErr = String(e); }
  const i2 = await add('TST225L', lbl);
  const s2 = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === i2.id);
  out.lblStatus = s2 ? s2.status : 'no-st';
  try {
    const ad = s2.adapter;
    const cv = document.createElement('canvas');
    const W = Math.floor(pane.host.clientWidth) || 1400, H = 600;
    cv.width = W; cv.height = H;
    const ox = cv.getContext('2d');
    const n = pane.bars.length;
    const lx = ad._xOf(ad._objMs({ xloc: 'bar_index' }, n - 1));
    const ly = ad._yOf(pane.bars[n - 1].close);
    ox.translate(-lx + 60, -ly + 30);
    ad._paintLabel(ox, { x: n - 1, y: pane.bars[n - 1].close, text: 'X', style: 'label_down', size: 'normal' });
    const d = ox.getImageData(0, 0, 120, 60).data;
    let bright = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 10) continue;
      if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) bright++;
      else if (d[i] < 55 && d[i + 1] < 55 && d[i + 2] < 55) dark++;
    }
    out.bright = bright; out.dark = dark;
  } catch (e) { out.lblErr = String(e); }
  const i3 = await add('TST225A', ac);
  const s3 = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === i3.id);
  out.acStatus = s3 ? s3.status : 'no-st';
  out.acLogs = A.Log.entries({ search: 'cannot be used in strategy' }).map((e) => e.msg);
  A.PineUI.remove(pane, i1.id);
  A.PineUI.remove(pane, i2.id);
  A.PineUI.remove(pane, i3.id);
  return out;
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
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100", timeout=25000)
            r = page.evaluate(READ_JS, {'pair': SRC_PAIR, 'lbl': SRC_LBL, 'ac': SRC_AC})
            print('    pair:', r.get('pairStatus'), r.get('entryPx'), '->', r.get('exitPx'), 'label:', r.get('lblStatus'), 'bright=%s dark=%s' % (r.get('bright'), r.get('dark')), 'ac:', r.get('acStatus'))
            check('pair strategy ok', r['pairStatus'] == 'ok', r.get('repErr'))
            epx, xpx = r.get('entryPx'), r.get('exitPx')
            check('exit at entry price (first-trigger)', isinstance(epx, (int, float)) and epx == xpx, (epx, xpx))
            check('label ok', r.get('lblStatus') == 'ok', r.get('lblErr'))
            check('v6 label default text white', (r.get('bright') or 0) > 0 and (r.get('bright') or 0) > (r.get('dark') or 0), (r.get('bright'), r.get('dark')))
            check('alertcondition strategy errors', r.get('acStatus') == 'error', r)
            check('gate message in Diagnostics log', len(r.get('acLogs') or []) > 0, r.get('acLogs'))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND225: %d failed' % len(FAILS) if FAILS else 'ROUND225: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
