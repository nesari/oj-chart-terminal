#!/usr/bin/env python3
"""ROUND117 e2e — pendings set by the USER are visible in the ACTIVE account
everywhere. The ROUND116 e2e placed pendings via Trade.placeOrder (the live
wire only) and missed the user's actual flow; this one drives the REAL path:

[L] LIVE regression (the ROUND116 chain, now through the route facade):
    a pending placed via TradeRoute.sendOrder rides the Positions grid, the
    chart overlay draws it, cancelling FROM THE GRID removes it.
[D] DEMO mode (the user's Replay-Trading flow — the round's actual bug):
    · a pending set through the SAME sendOrder path (→ ReplayTrade engine)
      appears in the Positions grid ('buy limit', honest — profit, cancel
      button) — before this round the grid ignored demo orders entirely;
    · the DEMO overlay draws the dotted pending line on the chart;
    · the account bar flips to the demo account ('demo' chip);
    · the Orders tab lists the demo pending;
    · when the market activates it, the row morphs into a market trade
      (data-pending gone, buy/sell type, live profit) — engine changed()
      → route → dock re-render;
    · cancelling the second demo pending from the grid row removes it;
    · the demo lines survive chart-type switches (line + renko + back to
      candles) — the series self-heal this round gave the demo overlay.

Exits 0 only if every check passes with zero page errors.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8907, 8777
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

DOCK_POS = """() => {
  const d = window.__app.TradeDock;
  d.show(); d._tab = 'positions'; d._render();
  const rows = [...document.querySelectorAll('#td-pos .td-h2item')];
  const pend = rows.find(r => r.dataset.pending === '1');
  const mkt  = rows.find(r => r.dataset.pending !== '1');
  const pick = (r, sel) => { const c = r && r.querySelector(sel); return c ? c.textContent.trim() : null; };
  return {
    n: rows.length,
    pendType: pick(pend, '.td-pend'),
    pendProfit: pick(pend, '.td-profit'),
    pendCancel: pend ? !!pend.querySelector('.td-manage button') : false,
    pendVol: pend ? pick(pend, '.td-h2c:nth-child(5)') : null,
    mktType: mkt ? pick(mkt, '.td-buy, .td-sell') : null,
    mktProfit: mkt ? pick(mkt, '.td-profit') : null,
    summary: (document.getElementById('td-summary') || {}).textContent || '',
    badge: [...document.querySelectorAll('.td-tab')].map(b => b.textContent).join('|'),
  };
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

            print('[1] boot (LIVE mode) + one resting BUY_LIMIT through the route facade')
            pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            pg.wait_for_selector('#login-connect', timeout=15000)
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_selector('#charts-grid canvas', timeout=20000)
            pg.wait_for_timeout(2000)
            live = pg.evaluate("""() => {
              const R = window.__app.TradeRoute, T = window.__app.Trade;
              if (R.isDemo()) R.set('live', true);
              const sym = window.__app.App.panes[0].symbol;
              const s = T.specSync(sym) || {}, q = T.quote(sym) || {};
              const px = Number((((q.bid || s.bid) || 1) - 150 * (s.point || 0.00001)).toFixed(5));
              window.__sym = sym;
              return R.sendOrder({ symbol: sym, orderType: 2, volume: 0.02, price: px,
                sl: 0, tp: 0, pend: true, deviation: 20, comment: 'r117' });
            }""")
            pg.wait_for_timeout(3000)     # 2+ state polls
            check('LIVE: route.sendOrder placed the pending (retcode 10009)',
                  live and live.get('retcode') == 10009, live)
            row = pg.evaluate(DOCK_POS)
            check('LIVE: pending rides the Positions grid', row['n'] == 1 and row['pendType'] == 'buy limit', row)
            live_line = pg.evaluate("""() => {
              const O = window.__app.TradeOverlay;
              const st = O._state(window.__app.App.panes[0]);
              return { n: st.lines.filter(l => l.kind === 'order').length,
                       healed: st.series === window.__app.App.panes[0].series };
            }""")
            check('LIVE: chart overlay draws the pending line', live_line['n'] == 1 and live_line['healed'], live_line)
            check('LIVE: summary chip counts the pending', '1 pending' in row['summary'], row['summary'])
            check('LIVE: account bar shows the live account', pg.evaluate(
                """() => (document.querySelector('#td-status') || {}).textContent === 'live' """))
            pg.screenshot(path=os.path.join(SHOTS, 'round117_live_pending.png'))

            print('[2] LIVE: cancel from the grid row removes it')
            pg.evaluate("""() => {
              const btn = document.querySelector('#td-pos .td-h2item[data-pending="1"] .td-manage button');
              btn.click();                                   // arms the inline confirm toast
              const act = document.querySelector('#toasts .toast .toast-action');
              if (act) act.click();                          // 'Cancel order'
            }""")
            pg.wait_for_timeout(2500)     # refresh cycle swaps the row out
            after = pg.evaluate(DOCK_POS)
            check('LIVE: grid row gone after the grid-row cancel', after['n'] == 0, after)

            print('[3] switch to DEMO mode — the user\u2019s Replay-Trading flow')
            pg.evaluate("() => window.__app.TradeRoute.set('demo', true)")
            pg.wait_for_timeout(600)
            demo_acc = pg.evaluate("""() => {
              const R = window.__app.TradeRoute;
              const bar = (document.querySelector('#td-status') || {}).textContent;
              return { demo: R.isDemo(), orders: R.orders().length, bar };
            }""")
            check('DEMO: mode is on, route.orders() = engine rows (empty at start)',
                  demo_acc['demo'] and demo_acc['orders'] == 0, demo_acc)
            check('DEMO: account bar shows the demo account', demo_acc['bar'] == 'demo', demo_acc)

            print('[4] DEMO: set a pending through the SAME sendOrder path the Set button uses')
            placed = pg.evaluate("""() => {
              const R = window.__app.TradeRoute, T = window.__app.Trade;
              const sym = window.__sym;
              const s = T.specSync(sym) || {}, q = T.quote(sym) || {};
              const px = Number((((q.bid || s.bid) || 1) - 200 * (s.point || 0.00001)).toFixed(5));
              return R.sendOrder({ symbol: sym, orderType: 2, volume: 0.02, price: px,
                sl: 0, tp: 0, pend: true, deviation: 20, comment: '' });
            }""")
            pg.wait_for_timeout(800)
            check('DEMO: sendOrder → demo engine accepted the pending', placed and placed.get('ok'), placed)
            row = pg.evaluate(DOCK_POS)
            check('DEMO: pending sits in the Positions grid (the round\u2019s core bug)',
                  row['n'] == 1 and row['pendType'] == 'buy limit', row)
            check('DEMO: Profit cell is an honest —', row['pendProfit'] == '—', row)
            check('DEMO: Manage cell offers cancel', row['pendCancel'], row)
            check('DEMO: summary chip counts the pending', '1 pending' in row['summary'], row['summary'])
            dline = pg.evaluate("""() => {
              const RT = window.__app.ReplayTrade;
              const st = RT._map.get(window.__app.App.panes[0]);
              if (!st) return { n: -1, healed: false };
              return { n: st.lines.filter(l => l.kind === 'order').length,
                       healed: st.series === window.__app.App.panes[0].series };
            }""")
            check('DEMO: the demo overlay draws the dotted pending line',
                  dline['n'] == 1 and dline['healed'], dline)
            pg.evaluate("() => { const d = window.__app.TradeDock; d._tab = 'orders'; d._render(); }")
            pg.wait_for_timeout(300)
            ord_tab = pg.evaluate("() => document.querySelectorAll('#td-ord .td-h2item').length")
            check('DEMO: Orders tab lists the demo pending', ord_tab == 1, ord_tab)
            pg.evaluate("() => { const d = window.__app.TradeDock; d._tab = 'positions'; d._render(); }")
            pg.screenshot(path=os.path.join(SHOTS, 'round117_demo_pending.png'))

            print('[5] DEMO: chart-type switch — demo lines must survive (the silent second bug)')
            for style, label in (('line', 'LINE'), ('renko', 'RENKO'), ('candles', 'CANDLE')):
                pg.evaluate(f"""() => window.__app.Manager.setStyle(window.__app.App.panes[0], '{style}')""")
                pg.wait_for_timeout(1500)               # > SYNC_MS (700): the self-heal runs
                st_line = pg.evaluate("""() => {
                  const RT = window.__app.ReplayTrade;
                  const st = RT._map.get(window.__app.App.panes[0]);
                  return { n: st ? st.lines.filter(l => l.kind === 'order').length : -1,
                           healed: st ? st.series === window.__app.App.panes[0].series : false };
                }""")
                check(f'DEMO {label}: demo pending line rebuilt on the new series',
                      st_line['n'] == 1 and st_line['healed'], st_line)

            print('[6] DEMO: cancel the pending from its grid row (route.cancel)')
            pg.evaluate("""() => {
              const btn = document.querySelector('#td-pos .td-h2item[data-pending="1"] .td-manage button');
              btn.click();
              const act = document.querySelector('#toasts .toast .toast-action');
              if (act) act.click();                          // 'Cancel order'
            }""")
            pg.wait_for_timeout(700)
            row = pg.evaluate(DOCK_POS)
            check('DEMO: grid row gone after the grid-row cancel', row['n'] == 0, row)

            print('[7] DEMO: activation — the pending changes nature into a market trade')
            # a buy limit parked a hair below the market: the live walk triggers it fast
            pg.evaluate("""() => {
              const R = window.__app.TradeRoute, T = window.__app.Trade;
              const sym = window.__sym;
              const s = T.specSync(sym) || {}, q = T.quote(sym) || {};
              const px = Number((((q.bid || s.bid) || 1) - 3 * (s.point || 0.00001)).toFixed(5));
              return R.sendOrder({ symbol: sym, orderType: 2, volume: 0.02, price: px,
                sl: 0, tp: 0, pend: true, deviation: 20, comment: '' });
            }""")
            activated = False
            row = None
            for _ in range(60):                          # up to ~24s of random walk
                pg.wait_for_timeout(400)
                row = pg.evaluate(DOCK_POS)
                if row['n'] == 1 and row['pendType'] is None and row['mktType'] == 'buy':
                    activated = True
                    break
                if row['n'] == 1 and row['pendType'] is not None:   # not yet triggered — nudge closer
                    pg.evaluate("""() => {
                      const R = window.__app.TradeRoute, T = window.__app.Trade, RT = window.__app.ReplayTrade;
                      const o = RT.orders()[0];
                      if (!o) return;
                      const s = T.specSync(o.symbol) || {}, q = T.quote(o.symbol) || {};
                      const bid = q.bid || s.bid;
                      R.modifyOrder(o.ticket, Number((bid - 2 * (s.point || 0.00001)).toFixed(5)), o.sl, o.tp);
                    }""")
            check('DEMO: activated pending morphed into a market row (same slot)',
                  activated, row)
            check('DEMO: the market row shows a live profit (not —)',
                  activated and row['mktProfit'] not in (None, '—'), row.get('mktProfit'))
            check('DEMO: summary chip dropped the pending count',
                  activated and 'pending' not in (row['summary'] or ''), row['summary'])
            morph_line = pg.evaluate("""() => {
              const RT = window.__app.ReplayTrade;
              const st = RT._map.get(window.__app.App.panes[0]);
              return { orders: st ? st.lines.filter(l => l.kind === 'order').length : -1,
                       entries: st ? st.lines.filter(l => l.kind === 'entry').length : -1 };
            }""")
            check('DEMO: chart morph matches — order line gone, entry line drawn',
                  morph_line['orders'] == 0 and morph_line['entries'] == 1, morph_line)
            pg.screenshot(path=os.path.join(SHOTS, 'round117_demo_activated.png'))

            print('[8] DEMO: close the position from its grid row (route.close)')
            pg.evaluate("""() => {
              const btn = [...document.querySelectorAll('#td-pos .td-h2item .td-manage button')]
                .find(b => b.title === 'Close position');
              if (!btn) return;
              btn.click();
              const act = document.querySelector('#toasts .toast .toast-action');
              if (act) act.click();                          // 'Close'
            }""")
            pg.wait_for_timeout(700)
            row = pg.evaluate(DOCK_POS)
            check('DEMO: close from the row empties the grid', row['n'] == 0, row)

            check('zero page errors through the whole run', not errors, errors[:3])
            b.close()
    finally:
        prov.terminate()

    print('\nROUND117 e2e: ' + ('ALL GREEN' if not FAILS else str(len(FAILS)) + ' FAILED'))
    sys.exit(1 if FAILS else 0)

if __name__ == '__main__':
    main()
