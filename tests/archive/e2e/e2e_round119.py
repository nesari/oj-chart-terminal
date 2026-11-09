#!/usr/bin/env python3
"""ROUND119 e2e — the four user requests, live against the demo broker.

[1] The Orders tab renders as the SAME MT5 grid (header, sortable, grid rows,
    live Current cell, Total bar with the volume sum under its own column),
    right-click column menu included.
[2] The dock is renamed "Tool Box" (header title + icon + bottom-bar toggle).
[3] With the Tool Box open, the right-panel Trading tab scrolls INSIDE itself
    and nothing paints under the dock (z-layering + functional reachability).
[4] The Alerts panel: card rows (chip + price + switch) and the segmented
    Repeat control persist the same cfg keys.

Exits 0 only if every check passes with zero page errors.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8908, 8777
FAILS = []
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

SHOTS = os.path.join(ROOT, 'docs', 'shots-legacy')
os.makedirs(SHOTS, exist_ok=True)

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

            print('[1] boot + place one BUY_LIMIT below the market')
            pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            pg.wait_for_selector('#login-connect', timeout=15000)
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_selector('#charts-grid canvas', timeout=20000)
            pg.wait_for_timeout(2000)
            pg.evaluate("""() => {
              const App = window.__app.App, T = window.__app.Trade;
              const sym = App.panes[0].symbol;
              const s = T.specSync(sym) || {}, q = T.quote(sym) || {};
              const px = Number((((q.bid || s.bid) || 1) - 150 * (s.point || 0.00001)).toFixed(5));
              window.__sym = sym;
              return T.placeOrder({ symbol: sym, orderType: 2, volume: 0.02, price: px,
                sl: 0, tp: 0, deviation: 20, comment: 'r119' });
            }""")
            pg.wait_for_timeout(3000)

            print('[2] the dock is the "Tool Box"')
            names = pg.evaluate("""() => ({
              title: document.querySelector('#td-title') ? document.querySelector('#td-title').textContent : '',
              icSvg: !!document.querySelector('#td-ic svg'),
              toggleTitle: (document.getElementById('td-toggle-btn') || {}).title || '',
              toggleSvg: !!(document.getElementById('td-toggle-btn') && document.getElementById('td-toggle-btn').querySelector('svg')),
            })""")
            check('header title reads "Tool Box"', names['title'] == 'Tool Box', names)
            check('header carries the toolbox icon', names['icSvg'])
            check('bottom-bar toggle renamed + iconed',
                  'Tool Box' in names['toggleTitle'] and names['toggleSvg'], names)
            pg.evaluate("() => window.__app.TradeDock.show()")
            pg.screenshot(path=os.path.join(SHOTS, 'round119_toolbox_header.png'))

            print('[3] the Orders tab is the MT5 grid')
            pg.evaluate("() => { const d = window.__app.TradeDock; d._tab = 'orders'; d._render(); }")
            pg.wait_for_timeout(400)
            g = pg.evaluate("""() => {
              const host = document.getElementById('td-ord');
              const head = host.querySelector('.td-h2head');
              const row = host.querySelector('.td-h2item[data-ticket]');
              const total = host.querySelector('.td-h2total');
              const volHead = head ? [...head.querySelectorAll('.td-h2c')].findIndex(c => c.textContent === 'Volume') : -1;
              let volSum = null;
              if (total && volHead >= 0) {
                const c = total.querySelector('[style*="grid-column: ' + (volHead + 1) + '"], [style*="grid-column:' + (volHead + 1) + '"]');
                volSum = c ? c.textContent : null;
              }
              return {
                grid: !!host.querySelector('.td-hgrid'),
                heads: head ? head.querySelectorAll('[data-sort]').length : 0,
                rowType: row && row.querySelector('.td-buy, .td-sell') ? row.querySelector('.td-buy, .td-sell').textContent : '',
                typeCls: row && row.querySelector('.td-buy, .td-sell') ? row.querySelector('.td-buy, .td-sell').className : '',
                rowCls: row ? row.className : '',
                cur: row ? !!row.querySelector('.td-cur') : false,
                total: total ? total.textContent : '',
                volSum,
                exp: row ? (row.textContent.includes('GTC')) : false,
              };
            }""")
            check('grid skeleton (td-hgrid + sticky header)', g['grid'] and g['heads'] >= 8, g)
            check('row Type cell names the order (buy limit, side color)',
                  g['rowType'] == 'buy limit' and 'td-buy' in g['typeCls'], g)
            check('live Current cell present', g['cur'])
            check('Expiry cell shows GTC fallback', g['exp'])
            check('Total bar rolls up count + volume', 'Total · 1 pending' in (g['total'] or ''), g['total'])
            check('volume sum sits under the Volume track', g['volSum'] == '0.02', g)
            pg.screenshot(path=os.path.join(SHOTS, 'round119_orders_grid.png'))

            print('[4] orders column menu (right-click, stays open, re-renders)')
            pg.evaluate("""() => {
              const host = document.getElementById('td-ord');
              const r = host.getBoundingClientRect();
              host.dispatchEvent(new MouseEvent('contextmenu',
                { bubbles: true, cancelable: true, clientX: r.left + 120, clientY: r.top + 30 }));
            }""")
            pg.wait_for_timeout(250)
            menu1 = pg.evaluate("""() => {
              const m = document.querySelector('.td-hmenu');
              return { open: m && m.style.display !== 'none', target: m ? m.dataset.target : '',
                       items: m ? m.querySelectorAll('.td-hmenu-item').length : 0 };
            }""")
            check('menu opens on the orders grid with ORD_COLS',
                  menu1['open'] and menu1['target'] == 'ord' and menu1['items'] >= 11, menu1)
            pg.evaluate("() => { const it = [...document.querySelectorAll('.td-hmenu .td-hmenu-item')].find(i => i.dataset.col === 'comment'); it.click(); }")
            pg.wait_for_timeout(250)
            menu2 = pg.evaluate("""() => {
              const m = document.querySelector('.td-hmenu');
              const head = document.querySelector('#td-ord .td-h2head');
              return { stillOpen: m && m.style.display !== 'none',
                       commentGone: head ? !head.textContent.includes('Comment') : false };
            }""")
            check('toggle re-renders the grid, menu stays open',
                  menu2['stillOpen'] and menu2['commentGone'], menu2)
            pg.keyboard.press('Escape')
            # re-show comment for the record + close via outside press
            pg.evaluate("""() => {
              const m = document.querySelector('.td-hmenu');
              if (m && m.style.display !== 'none') {
                const it = [...m.querySelectorAll('.td-hmenu-item')].find(i => i.dataset.col === 'comment');
                if (it) it.click();
              }
            }""")
            pg.wait_for_timeout(200)
            pg.mouse.click(600, 300)

            print('[5] right panel vs Tool Box: nothing slides under the dock')
            pg.click('#right-tabs .rt-btn[data-tab="trade"]')
            pg.wait_for_timeout(500)
            lay = pg.evaluate("""() => {
              const rp = document.getElementById('right-panel');
              const tab = document.getElementById('tab-trade');
              const live = document.getElementById('tr-live') || document.getElementById('tr-demo');
              const dock = document.getElementById('trade-dock');
              live.scrollTop = live.scrollHeight;   // scroll to the very bottom
              const last = live.getBoundingClientRect();
              const dk = dock.getBoundingClientRect();
              const cs = getComputedStyle(rp), ct = getComputedStyle(tab), cl = getComputedStyle(live);
              return { z: cs.zIndex, pos: cs.position, tabOverflow: ct.overflow,
                       liveOverflowY: cl.overflowY,
                       contained: last.bottom <= dk.top + 1.5,
                       scrollable: live.scrollHeight >= live.clientHeight };
            }""")
            check('#right-panel layered above the dock (z 35, relative)',
                  lay['z'] == '35' and lay['pos'] == 'relative', lay)
            check('.rtab clips its own edge (overflow hidden)', lay['tabOverflow'] == 'hidden', lay)
            check('Trading tab body scrolls internally (overflow-y auto)',
                  lay['liveOverflowY'] == 'auto', lay)
            check('scrolled-to-bottom content ends above the dock top',
                  lay['contained'] and lay['scrollable'], lay)
            pg.screenshot(path=os.path.join(SHOTS, 'round119_no_underlap.png'))

            print('[6] the Alerts panel: card rows + segmented Repeat')
            pg.click('#right-tabs .rt-btn[data-tab="alerts"]')
            pg.wait_for_timeout(400)
            pg.evaluate("""() => {
              const sym = window.__sym;
              const T = window.__app.Trade;
              const s = T.specSync(sym) || {}, q = T.quote(sym) || {};
              const px = Number((((q.bid || s.bid) || 1) + 60 * (s.point || 0.00001)).toFixed(5));
              window.__app.Alerts.create(sym, 'Greater Than', px);
            }""")
            pg.wait_for_timeout(400)
            # ROUND130+: the sound block is a collapsed accordion by default —
            # expand it before probing the segmented Repeat control.
            pg.evaluate("""() => {
              if (!document.getElementById('alert-loop-seg')) {
                const h = document.querySelector('#alert-sound-settings .al-head');
                if (h) h.click();
              }
            }""")
            pg.wait_for_timeout(600)
            al = pg.evaluate("""() => {
              const row = document.querySelector('#alert-list .alert-row');
              const seg = document.getElementById('alert-loop-seg');
              return {
                armed: !!(row && row.classList.contains('armed')),
                sw: !!(row && row.querySelector('.a-switch.on')),
                chip: row && row.querySelector('.a-chip') ? row.querySelector('.a-chip').textContent : '',
                price: row && row.querySelector('.a-price') ? row.querySelector('.a-price').textContent : '',
                card: !!document.getElementById('alert-sound-settings'),
                segBtns: seg ? seg.querySelectorAll('button').length : 0,
              };
            }""")
            check('alert row is an armed card with a switch', al['armed'] and al['sw'], al)
            check('condition chip + price cells filled', al['chip'] == 'Greater Than' and al['price'], al)
            check('sound settings card + segmented Repeat (5 options)',
                  al['card'] and al['segBtns'] == 5, al)
            pg.evaluate("""() => {
              const b = document.querySelector('#alert-loop-seg button[data-v="inf"]');
              b.click();
            }""")
            pg.wait_for_timeout(200)
            rep = pg.evaluate("""() => {
              const b = document.querySelector('#alert-loop-seg button[data-v="inf"]');
              return { on: b.classList.contains('on'), cfg: window.__app.Alerts.cfg.loop };
            }""")
            check('∞ Loop pill persists the same cfg.loop key', rep['on'] and rep['cfg'] == 'inf', rep)
            # toggle the alert off and back on via the switch
            tog = pg.evaluate("""() => {
              const sw = document.querySelector('#alert-list .alert-row .a-switch');
              sw.click();
              const row = document.querySelector('#alert-list .alert-row');
              const off = { armed: row.classList.contains('armed'), swOn: !!row.querySelector('.a-switch.on') };
              return off;
            }""")
            check('switch disables the alert (card loses armed)', not tog['armed'] and not tog['swOn'], tog)
            pg.screenshot(path=os.path.join(SHOTS, 'round119_alerts.png'))

            check('zero page errors through the whole run', not errors, errors[:3])
            b.close()
    finally:
        prov.terminate()
    print('\nROUND119 e2e: ' + ('ALL GREEN' if not FAILS else '%d FAILED' % len(FAILS)))
    sys.exit(1 if FAILS else 0)

if __name__ == '__main__':
    main()
