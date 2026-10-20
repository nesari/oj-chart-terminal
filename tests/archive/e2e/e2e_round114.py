#!/usr/bin/env python3
"""ROUND114 e2e — the four user requests, live against the demo broker.

[1] The dock Positions tab renders as the MT5 grid (same columns as History
    + the Manage column), with the sticky Total bar.
[2] Right-click INSIDE the Positions section opens the column menu; toggling
    an item re-renders the grid and KEEPS the menu open; a press outside
    closes it (same behavior as History).
[3] Dynamic width split: the visible columns fill the FULL dock width (no
    dead space) and the fill survives a column toggle (redistributed).
[4] The pinned + minimized trade panel restores on a clean pill press
    (the reported bug: clicking the pill did nothing).

Exits 0 only if every check passes with zero page errors.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8901, 8777   # provider_common hard-wires WS 8777
FAILS = []
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


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

            print('[1] boot + open one demo position')
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
                price: 0, deviation: 20, comment: 'r114',
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

            print('[2] Positions tab = MT5 grid')
            pg.evaluate("() => { window.__app.TradeDock.show(); window.__app.TradeDock._tab = 'positions'; window.__app.TradeDock._render(); }")
            pg.wait_for_timeout(400)
            rows = pg.evaluate("() => document.querySelectorAll('#td-pos .td-h2item').length")
            check('one grid row for the position', rows == 1, rows)
            shape = pg.evaluate("""() => {
              const head = document.querySelector('#td-pos .td-h2head');
              const row = document.querySelector('#td-pos .td-h2item');
              return {
                headCols: head ? head.querySelectorAll('.td-h2c').length : 0,
                rowCols: row ? row.querySelectorAll('.td-h2c').length : 0,
                tpl: head ? head.style.gridTemplateColumns : '',
                total: (document.querySelector('#td-pos .td-h2total') || {}).textContent || '',
              };
            }""")
            check('header + row carry 15 columns (all POS_COLS visible)',
                  shape['headCols'] == 15 and shape['rowCols'] == 15, shape)
            check('tracks are minmax(px, fr) — dynamic split',
                  'minmax(' in shape['tpl'] and 'fr)' in shape['tpl'], shape['tpl'][:60])
            check('sticky Total bar with the rollup', 'Total · 1' in shape['total'], shape['total'][:60])

            print('[3] dynamic width — no dead space, survives a toggle')
            fill = pg.evaluate("""() => {
              const row = document.querySelector('#td-pos .td-h2item');
              const sc = document.getElementById('td-scroller');
              return { rowW: row.getBoundingClientRect().width, scW: sc.clientWidth };
            }""")
            check('row spans the full scroller width (no empty gutter)',
                  fill['rowW'] >= fill['scW'] - 3, fill)
            pg.evaluate("""() => {
              const row = document.querySelector('#td-pos .td-h2item');
              row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
            }""")
            pg.wait_for_timeout(200)
            menu_open = pg.evaluate("() => { const m = document.querySelector('.td-hmenu'); return m && m.style.display !== 'none'; }")
            check('right-click on Positions opens the column menu', menu_open)
            items0 = pg.evaluate("() => document.querySelectorAll('.td-hmenu-item').length")
            check('menu lists all 15 position columns', items0 == 15, items0)
            # hide Comment + Value -> grid must re-render narrower but STILL full-width
            pg.evaluate("() => { [...document.querySelectorAll('.td-hmenu-item')].find(i => i.dataset.col === 'comment').click(); }")
            pg.wait_for_timeout(150)
            menu_still = pg.evaluate("() => document.querySelector('.td-hmenu').style.display !== 'none'")
            check('menu STAYS open after a toggle', menu_still)
            pg.evaluate("() => { [...document.querySelectorAll('.td-hmenu-item')].find(i => i.dataset.col === 'value').click(); }")
            pg.wait_for_timeout(250)
            after = pg.evaluate("""() => {
              const head = document.querySelector('#td-pos .td-h2head');
              const row = document.querySelector('#td-pos .td-h2item');
              const sc = document.getElementById('td-scroller');
              return { cols: head.querySelectorAll('.td-h2c').length,
                       rowW: row.getBoundingClientRect().width, scW: sc.clientWidth,
                       tracks: (head.style.gridTemplateColumns.match(/minmax\(/g) || []).length };
            }""")
            check('grid re-rendered with 13 columns', after['cols'] == 13, after)
            check('tracks re-derived (13 fr tracks after the toggle)', after['tracks'] == 13, after['tracks'])
            check('re-render STILL fills the full width (dynamic re-split)',
                  after['rowW'] >= after['scW'] - 3, after)
            pg.evaluate("() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))")
            pg.wait_for_timeout(150)
            menu_closed = pg.evaluate("() => document.querySelector('.td-hmenu').style.display === 'none'")
            check('a press outside the menu closes it', menu_closed)
            # restore the two columns for the state cleanliness
            pg.evaluate("""() => {
              const d = window.__app.TradeDock;
              d._posHidden.delete('comment'); d._posHidden.delete('value');
              d._posSave(); d._renderPositions();
            }""")

            print('[4] pinned + minimized pill still opens (the reported bug)')
            pg.evaluate("""() => {
              const oc = window.__app.OneClick;
              oc._setPin(true);      // the state that killed the pill before
              oc._setMin(true);
            }""")
            pg.wait_for_timeout(200)
            pre = pg.evaluate("""() => {
              const oc = window.__app.OneClick;
              const st = oc._st(window.__app.App.panes[0]);
              return { pillVisible: !st.pill.classList.contains('oc-hidden'),
                       panelHidden: st.panel.classList.contains('oc-hidden') };
            }""")
            check('minimized: pill visible, panel hidden', pre['pillVisible'] and pre['panelHidden'], pre)
            pg.evaluate("""() => {
              const oc = window.__app.OneClick;
              const st = oc._st(window.__app.App.panes[0]);
              st.pill.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            }""")
            pg.wait_for_timeout(200)
            post = pg.evaluate("""() => {
              const oc = window.__app.OneClick;
              const st = oc._st(window.__app.App.panes[0]);
              return { panelVisible: !st.panel.classList.contains('oc-hidden'),
                       pillHidden: st.pill.classList.contains('oc-hidden'),
                       stillPinned: oc._pin };
            }""")
            check('PINNED clean pill press restores the panel (bug fixed)',
                  post['panelVisible'] and post['pillHidden'], post)
            check('pin state untouched by the restore', post['stillPinned'])
            # the frozen press must not move/persist a bogus position
            pos_ok = pg.evaluate("""() => {
              const oc = window.__app.OneClick;
              const saved = oc._pos;
              return !saved || (isFinite(saved.fx) && isFinite(saved.fy));
            }""")
            check('frozen press never persisted a bogus position', pos_ok)
            # and the unpinned clean press still restores (old path kept)
            pg.evaluate("""() => {
              const oc = window.__app.OneClick;
              oc._setPin(false); oc._setMin(true);
              const st = oc._st(window.__app.App.panes[0]);
              st.pill.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            }""")
            pg.wait_for_timeout(150)
            unp = pg.evaluate("() => { const st = window.__app.OneClick._st(window.__app.App.panes[0]); return !st.panel.classList.contains('oc-hidden'); }")
            check('unpinned clean pill press still restores (old path kept)', unp)

            check('zero page errors', not errors, errors[:3])
            b.close()
    finally:
        prov.terminate()

    print('\n' + ('ROUND114 E2E: ALL GREEN' if not FAILS else 'FAILED: ' + ', '.join(FAILS)))
    sys.exit(1 if FAILS else 0)

if __name__ == '__main__':
    main()
