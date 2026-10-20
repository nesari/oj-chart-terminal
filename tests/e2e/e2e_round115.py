#!/usr/bin/env python3
"""ROUND115 e2e — the Total bar aligns with its columns, live on the demo broker.

User report: the total profit/loss in the Total bar did not sit exactly under
the Profit column (History + Positions). The fix pins every total cell to its
own explicit grid track. This e2e measures REAL DOM rects:

  [1] Positions: every total-bar sum sits under its own header (drift < 2px),
      and the profit total is under PROFIT — not at the far right edge.
  [2] The alignment survives a column toggle (dynamic re-derivation).
  [3] History (after closing the trade): Commission/Fee/Swap/Profit sums all
      under their own headers, profit total under PROFIT.

Exits 0 only if every check passes with zero page errors.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8903, 8777   # provider_common hard-wires WS 8777
FAILS = []
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

SHOTS = os.path.join(ROOT, 'docs', 'shots-legacy')

def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if extra and not cond else ''))
    if not cond:
        FAILS.append(name)

def wait_port(port, timeout=15):
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

# measures every pinned (explicit-track) total cell against the header cell
# on the SAME grid track -> right-edge drift in px (both are right-aligned)
MEASURE = """(sel) => {
  const sec = document.querySelector(sel);
  const head = sec.querySelector('.td-h2head');
  const tot  = sec.querySelector('.td-h2total');
  if (!head || !tot) return null;
  const heads = [...head.querySelectorAll('.td-h2c')];
  const out = [];
  for (const cell of tot.querySelectorAll('.td-h2c')) {
    const gt = cell.style.gridColumn;
    if (!/^\\d+$/.test(gt)) continue;            // the spanning rollup
    const i = parseInt(gt, 10) - 1;
    const h = heads[i];
    if (!h) { out.push({ i, head: null, drift: 999 }); continue; }
    const cr = cell.getBoundingClientRect(), hr = h.getBoundingClientRect();
    out.push({ i, head: h.textContent.trim(), val: cell.textContent.trim(),
               drift: Math.round((cr.right - hr.right) * 100) / 100 });
  }
  return out;
}"""

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        assert wait_port(PORT_HTTP) and wait_port(PORT_WS)
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            try:
                b = pw.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                b = pw.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            pg = b.new_page(viewport={'width': 1600, 'height': 900})
            errors = []
            pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
            pg.on('console', lambda m: errors.append('console-error: ' + m.text) if m.type == 'error' else None)

            print('[1] boot + open + close one demo trade')
            pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            pg.wait_for_selector('#login-connect', timeout=15000)
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_selector('#charts-grid canvas', timeout=20000)
            pg.wait_for_timeout(1500)
            pg.evaluate("""() => {
              const App = window.__app.App;
              return window.__app.Trade.placeOrder({
                symbol: App.panes[0].symbol, orderType: 0, volume: 0.02,
                price: 0, deviation: 20, comment: 'r115',
              });
            }""")
            deadline = time.time() + 20
            n = 0
            while time.time() < deadline:
                n = pg.evaluate("() => window.__app.Trade.positions.length")
                if n:
                    break
                time.sleep(0.6)
            check('demo position opened', n == 1, n)

            print('[2] Positions: profit total sits exactly under PROFIT')
            pg.evaluate("() => { const d = window.__app.TradeDock; d.show(); d._tab = 'positions'; d._render(); }")
            pg.wait_for_timeout(400)
            rows = pg.evaluate("() => document.querySelectorAll('#td-pos .td-h2item').length")
            check('grid row rendered', rows == 1, rows)
            m = pg.evaluate(MEASURE, '#td-pos')
            check('total cells measured (rollup excluded)', m and len(m) >= 3, m)
            check('every total cell drifts < 2px from its header',
                  all(abs(c['drift']) < 2 for c in m), m)
            prof = [c for c in m if c['head'] == 'Profit']
            check('a profit total EXISTS and is under the Profit header',
                  len(prof) == 1 and abs(prof[0]['drift']) < 2, prof)
            check('profit total is NOT at the far right edge (old bug)',
                  prof and prof[0]['i'] < len(m) + 2, prof)
            pg.screenshot(path=os.path.join(SHOTS, 'round115_positions_total.png'))

            print('[3] alignment survives a column toggle (dynamic re-derivation)')
            pg.evaluate("""() => {
              const d = window.__app.TradeDock;
              d._posHidden.add('comment'); d._posSave(); d._renderPositions();
            }""")
            pg.wait_for_timeout(300)
            m2 = pg.evaluate(MEASURE, '#td-pos')
            check('after hiding Comment: every total cell still under its header',
                  all(abs(c['drift']) < 2 for c in m2), m2)
            prof2 = [c for c in m2 if c['head'] == 'Profit']
            check('profit total re-pinned under Profit for the new visible set',
                  len(prof2) == 1 and abs(prof2[0]['drift']) < 2, prof2)
            pg.evaluate("""() => {
              const d = window.__app.TradeDock;
              d._posHidden.delete('comment'); d._posSave(); d._renderPositions();
            }""")

            print('[4] History: money sums under their own columns')
            pg.evaluate("""() => {
              const T = window.__app.Trade, d = window.__app.TradeDock;
              return T.closePosition(T.positions[0].ticket, 0);
            }""")
            deadline = time.time() + 20
            closed = False
            while time.time() < deadline:
                closed = pg.evaluate("() => window.__app.Trade.positions.length === 0")
                if closed:
                    break
                time.sleep(0.6)
            check('position closed', closed)
            pg.evaluate("""() => {
              const d = window.__app.TradeDock;
              d._deals = null; d._tab = 'history'; d._render();
            }""")
            deadline = time.time() + 20
            hrows = 0
            while time.time() < deadline:
                hrows = pg.evaluate("() => document.querySelectorAll('#td-hist .td-h2item').length")
                if hrows:
                    break
                time.sleep(0.6)
            check('closed trade visible in History', hrows == 1, hrows)
            mh = pg.evaluate(MEASURE, '#td-hist')
            check('History money sums all drift < 2px from their headers',
                  all(abs(c['drift']) < 2 for c in mh), mh)
            hprof = [c for c in mh if c['head'] == 'Profit']
            check('History profit total exactly under Profit',
                  len(hprof) == 1 and abs(hprof[0]['drift']) < 2, hprof)
            hdrs = [c['head'] for c in mh]
            check('Commission/Fee/Swap sums present under their columns',
                  'Commission' in hdrs and 'Fee' in hdrs and 'Swap' in hdrs, hdrs)
            pg.screenshot(path=os.path.join(SHOTS, 'round115_history_total.png'))

            check('zero page errors', not errors, errors[:3])
            b.close()
    finally:
        prov.terminate()

    print('\n' + ('ROUND115 E2E: ALL GREEN' if not FAILS else 'FAILED: ' + ', '.join(FAILS)))
    sys.exit(1 if FAILS else 0)

if __name__ == '__main__':
    main()
