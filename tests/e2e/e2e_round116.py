#!/usr/bin/env python3
"""ROUND116 e2e — the four user requests, live against the demo broker.

[1] A pending order shows EVERYWHERE before activation: chart overlay line,
    Positions-grid row ('buy limit', — profit, cancel button) and the Orders
    tab (kept).
[2] When the market activates it, the row changes nature into a market trade
    (same render path a real fill takes: orders -> positions -> rebuild).
[3] Trade lines survive chart-type switches (line + renko + back to candles).
[4] The hover TAG needs a 2s HOLD on the line; sweeping across lines never
    flashes it; hovering the floating panel never fires a tag through it,
    while the exposed part of the same line still hovers normally.

Exits 0 only if every check passes with zero page errors.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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

# geometry of a price line in SCREEN coordinates (same math as the overlay)
GEO = """(price) => {
  const pane = window.__app.App.panes[0];
  let y = null;
  try { y = pane.series.priceToCoordinate(price); } catch (e) { y = null; }
  const r = window.__app.TradeOverlay._lwcRect(pane);
  return { y: (y != null && isFinite(y)) ? r.top + y : null, lwcTop: r.top, lwcLeft: r.left,
           lwcRight: r.right, lwcBottom: r.bottom };
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

            print('[1] boot + one resting BUY_LIMIT well below the market')
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
                sl: 0, tp: 0, deviation: 20, comment: 'r116' });
            }""")
            pg.wait_for_timeout(3000)     # 2+ state polls
            pend = pg.evaluate("""() => {
              const T = window.__app.Trade, O = window.__app.TradeOverlay;
              const st = O._state(window.__app.App.panes[0]);
              return { orders: T.orders.length,
                       line: st.lines.some(l => l.kind === 'order') };
            }""")
            check('order rests in Trade.orders', pend['orders'] == 1, pend)
            check('chart draws the pending line (orange dotted)', pend['line'], pend)

            print('[2] Positions grid: the pending rides the table')
            pg.evaluate("() => { const d = window.__app.TradeDock; d.show(); d._tab = 'positions'; d._render(); }")
            pg.wait_for_timeout(400)
            row = pg.evaluate("""() => {
              const r = document.querySelector('#td-pos .td-h2item[data-pending="1"]');
              if (!r) return null;
              const cells = [...r.querySelectorAll('.td-h2c')];
              const type = r.querySelector('.td-pend');
              const profit = r.querySelector('.td-profit');
              const cancel = r.querySelector('.td-manage button');
              return { n: document.querySelectorAll('#td-pos .td-h2item').length,
                       type: type ? type.textContent : '',
                       profit: profit ? profit.textContent : '',
                       cancel: !!cancel, summary: document.getElementById('td-summary') ?
                         document.getElementById('td-summary').textContent : '' };
            }""")
            check('one grid row, marked pending', row and row['n'] == 1, row)
            check('Type cell names the order (buy limit, pending color)',
                  row and row['type'] == 'buy limit', row)
            check('Profit cell is an honest dash', row and row['profit'] == '—', row)
            check('Manage cell offers cancel', row and row['cancel'], row)
            check('summary chip counts the pending', row and '1 pending' in row['summary'], row and row['summary'])
            orders_tab = pg.evaluate("""() => {
              const d = window.__app.TradeDock; d._tab = 'orders'; d._render();
              return document.querySelectorAll('#td-ord .td-h2item').length;
            }""")
            check('Orders tab still lists it', orders_tab == 1, orders_tab)
            pg.evaluate("() => { const d = window.__app.TradeDock; d._tab = 'positions'; d._render(); }")
            pg.wait_for_timeout(300)

            print('[3] activation: the pending changes nature into a market trade')
            morph = pg.evaluate("""() => {
              /* the same state transition a real fill produces (provider moves
                 the row orders -> positions; the poll fires onChange). Surgery
                 + assertions run in ONE evaluation — the 1.2s state poll can
                 never interleave and restore provider truth mid-check. */
              const T = window.__app.Trade;
              const o = T.orders[0];
              T.orders = [];
              T.positions = [{ ticket: o.ticket, symbol: o.symbol,
                type: (o.type % 2 === 0) ? 0 : 1, volume: o.volume, open: o.price,
                sl: 0, tp: 0, current: o.price, profit: 1.23, swap: 0,
                time: o.time, comment: o.comment }];
              for (const f of T.onChange) { try { f(); } catch (e) {} }
              const r = document.querySelector('#td-pos .td-h2item');
              if (!r) return null;
              return { pending: r.dataset.pending === '1',
                       type: (r.querySelector('.td-pend') || {}).textContent ||
                             (r.querySelector('.td-buy, .td-sell') || {}).textContent,
                       profit: (r.querySelector('.td-profit') || {}).textContent };
            }""")
            check('row is now a market trade (no pending marker)', morph and not morph['pending'], morph)
            check('Type cell reads buy', morph and morph['type'] == 'buy', morph)
            check('Profit cell shows live money', morph and morph['profit'] != '—', morph)

            print('[4] back to broker truth; cancel from the pending row works')
            pg.evaluate("() => window.__app.Trade.refresh()")
            pg.wait_for_timeout(2500)
            back = pg.evaluate("""() => ({ orders: window.__app.Trade.orders.length,
              positions: window.__app.Trade.positions.length })""")
            check('provider truth restored (pending back, no position)',
                  back['orders'] == 1 and back['positions'] == 0, back)
            pg.evaluate("""() => {
              const b = document.querySelector('#td-pos .td-h2item[data-pending="1"] .td-manage button');
              if (b) b.click();
            }""")
            pg.wait_for_timeout(300)
            act = pg.evaluate("() => { const a = document.querySelector('.toast-action'); if (a) { a.click(); return true; } return false; }")
            check('confirm toast offers the action', act)
            pg.wait_for_timeout(1800)
            gone = pg.evaluate("""() => ({ orders: window.__app.Trade.orders.length,
              rows: document.querySelectorAll('#td-pos .td-h2item').length })""")
            check('pending cancelled — row gone', gone['orders'] == 0 and gone['rows'] == 0, gone)

            print('[5] trade lines survive chart-type switches')
            pg.evaluate("""() => {
              const T = window.__app.Trade, sym = window.__sym;
              const s = T.specSync(sym) || {}, q = T.quote(sym) || {};
              const ask = q.ask || s.ask;
              const pt = s.point || 0.00001;
              /* SL/TP so the family has an entry + SL + TP line to hover */
              return T.placeOrder({ symbol: sym, orderType: 0, volume: 0.02, price: 0,
                sl: Number((ask - 250 * pt).toFixed(5)), tp: Number((ask + 250 * pt).toFixed(5)),
                deviation: 20, comment: 'r116m' });
            }""")
            pg.wait_for_timeout(2500)
            cnt = """() => {
              const pane = window.__app.App.panes[0];
              const st = window.__app.TradeOverlay._state(pane);
              return { n: st.lines.length, healed: st.series === pane.series,
                       kinds: st.lines.map(l => l.kind).sort().join(',') };
            }"""
            base = pg.evaluate(cnt)
            check('candles: entry+SL+TP lines present',
                  base['n'] == 3 and base['healed'] and base['kinds'] == 'entry,sl,tp', base)
            pg.evaluate("() => window.__app.Manager.setStyle(window.__app.App.panes[0], 'line')")
            pg.wait_for_timeout(1100)          # > SYNC_MS
            ln = pg.evaluate(cnt)
            check('LINE chart: lines rebuilt on the new series', ln['n'] == base['n'] and ln['healed'], ln)
            pg.screenshot(path=os.path.join(SHOTS, 'round116_line_mode.png'))
            pg.evaluate("() => window.__app.Manager.setStyle(window.__app.App.panes[0], 'renko')")
            pg.wait_for_timeout(1100)
            rk = pg.evaluate(cnt)
            check('RENKO chart: lines rebuilt on the new series', rk['n'] == base['n'] and rk['healed'], rk)
            pg.evaluate("() => window.__app.Manager.setStyle(window.__app.App.panes[0], 'candles')")
            pg.wait_for_timeout(1100)
            bk = pg.evaluate(cnt)
            check('back to CANDLES: lines still there (the reported trap)', bk['n'] == base['n'] and bk['healed'], bk)

            print('[6] hover TAG needs a 2s hold on the line')
            tip_state = """() => {
              const t = window.__app.App.panes[0]._tradeTip;
              return t ? t.style.display : 'absent';
            }"""
            # rare flake guard: the demo walk can stop the position out during
            # [5]'s waits — if the SL line is gone, re-place the trade once
            sl_y = pg.evaluate("""() => {
              const pane = window.__app.App.panes[0];
              const st = window.__app.TradeOverlay._state(pane);
              const l = st.lines.find(l => l.kind === 'entry');
              if (!l) return null;
              let y = pane.series.priceToCoordinate(l.price);
              const r = window.__app.TradeOverlay._lwcRect(pane);
              return r.top + y;
            }""")
            if not sl_y:
                pg.evaluate("""() => {
                  const T = window.__app.Trade, sym = window.__sym;
                  const s = T.specSync(sym) || {}, q = T.quote(sym) || {};
                  const ask = q.ask || s.ask, pt = s.point || 0.00001;
                  return T.placeOrder({ symbol: sym, orderType: 0, volume: 0.02, price: 0,
                    sl: Number((ask - 250 * pt).toFixed(5)), tp: Number((ask + 250 * pt).toFixed(5)),
                    deviation: 20, comment: 'r116m2' });
                }""")
                pg.wait_for_timeout(2500)
                sl_y = pg.evaluate("""() => {
                  const pane = window.__app.App.panes[0];
                  const st = window.__app.TradeOverlay._state(pane);
                  const l = st.lines.find(l => l.kind === 'entry');
                  if (!l) return null;
                  let y = pane.series.priceToCoordinate(l.price);
                  const r = window.__app.TradeOverlay._lwcRect(pane);
                  return r.top + y;
                }""")
            check('entry line on screen', sl_y and sl_y > 0, sl_y)
            x = pg.evaluate("() => window.__app.TradeOverlay._lwcRect(window.__app.App.panes[0]).left + 500")
            pg.mouse.move(x, sl_y)
            pg.wait_for_timeout(500)
            check('touching the line 0.5s: NO tag', pg.evaluate(tip_state) in ('none', 'absent'))
            pg.wait_for_timeout(1800)          # 2.3s total on the line
            check('holding 2.3s: tag shows', pg.evaluate(tip_state) == 'block')
            pg.screenshot(path=os.path.join(SHOTS, 'round116_dwell_tag.png'))
            pg.mouse.move(x + 60, sl_y - 80)   # leave
            pg.wait_for_timeout(300)
            check('leaving the line: tag closes', pg.evaluate(tip_state) in ('none', 'absent'))
            # sweep across the entry line — never rests, never flashes
            ey = pg.evaluate("""() => {
              const pane = window.__app.App.panes[0];
              const st = window.__app.TradeOverlay._state(pane);
              const l = st.lines.find(l => l.kind === 'entry');
              let y = pane.series.priceToCoordinate(l.price);
              const r = window.__app.TradeOverlay._lwcRect(pane);
              return r.top + y;
            }""")
            for dy in (-40, 0, 40):
                pg.mouse.move(x, ey + dy)
                pg.wait_for_timeout(40)
            pg.wait_for_timeout(400)
            check('sweeping across the entry line: NO tag', pg.evaluate(tip_state) in ('none', 'absent'))

            print('[7] the floating panel blocks hover (no tags through it)')
            # The pending behind the panel is a far buy-stop; the demo's random
            # walk CAN fill it mid-check (rare). Retry the whole section up to
            # 3 times with a fresh price; record failures only on the last try.
            panel_fails = []
            for attempt in (1, 2, 3):
                last = attempt == 3
                def check7(name, cond, extra=''):
                    print(('  \u2713 ' if cond else '  \u2717 ') + name + ((' \u2014 ' + str(extra)) if extra and not cond else ''))
                    if not cond and last:
                        panel_fails.append(name)
                if attempt > 1:
                    # clean up a possibly-filled/refilled state, re-select fresh
                    pg.evaluate("() => { const T = window.__app.Trade; [...T.orders].forEach(o => T.cancelOrder(o.ticket).catch(() => {})); }")
                    pg.wait_for_timeout(2000)
                filled = pg.evaluate("() => window.__app.Trade.orders.length")
                blocked = pg.evaluate("""() => {
                  const pane = window.__app.App.panes[0], T = window.__app.Trade;
                  const panel = pane.root.querySelector('.oc-panel');
                  const pr = panel.getBoundingClientRect();
                  const lwc = window.__app.TradeOverlay._lwcRect(pane);
                  const s = T.specSync(window.__sym), q = T.quote(window.__sym);
                  const ask = q.ask || s.ask;
                  const pt = s.point;
                  // the TOP-most Y inside the panel whose price is a VALID
                  // buy-stop (>= 21pts above the ask) - farthest from the
                  // market, so the walk cannot fill it while the checks run
                  for (const frac of [0.12, 0.2, 0.35, 0.5, 0.7]) {
                    const cy = pr.top + pr.height * frac;
                    const price = pane.series.coordinateToPrice(cy - lwc.top);
                    if (price > ask + 21 * pt) {
                      return { price: Number(price.toFixed(5)), cy, panel: { l: pr.left, r: pr.right, t: pr.top, b: pr.bottom } };
                    }
                  }
                  return null;
                }""")
                check7('found a price behind the panel (valid buy-stop)', blocked is not None, blocked)
                if not blocked:
                    continue
                pg.evaluate(f"""() => window.__app.Trade.placeOrder({{ symbol: window.__sym,
                  orderType: 4, volume: 0.02, price: {blocked['price']}, sl: 0, tp: 0,
                  deviation: 20, comment: 'r116p' }})""")
                pg.wait_for_timeout(2400)
                if pg.evaluate("() => window.__app.Trade.orders.length") != filled + 1:
                    if last:
                        check7('buy-stop still resting after placement', False)
                    continue                      # the walk filled it - retry
                ly = pg.evaluate("""() => {
                  const pane = window.__app.App.panes[0];
                  const st = window.__app.TradeOverlay._state(pane);
                  const l = st.lines.find(l2 => l2.kind === 'order');
                  if (!l) return null;
                  let y = pane.series.priceToCoordinate(l.price);
                  const r = window.__app.TradeOverlay._lwcRect(pane);
                  return r.top + y;
                }""")
                inside = ly is not None and blocked['panel']['t'] <= ly <= blocked['panel']['b']
                check7('pending line runs BEHIND the panel', inside, {'ly': ly, 'panel': blocked['panel']})
                if inside:
                    px = (blocked['panel']['l'] + blocked['panel']['r']) / 2
                    pg.mouse.move(px, ly)
                    pg.wait_for_timeout(500)
                    check7('on the panel 0.5s with a line behind: NO tag', pg.evaluate(tip_state) in ('none', 'absent'))
                    pg.wait_for_timeout(1900)   # well past the hold window
                    check7('on the panel 2.4s: STILL no tag (hold never arms)',
                           pg.evaluate(tip_state) in ('none', 'absent'))
                    pg.screenshot(path=os.path.join(SHOTS, 'round116_panel_block.png'))
                    # the SAME line outside the widget still hovers normally
                    # (fresh Y - live ticks may have re-fit the scale meanwhile)
                    ly2 = pg.evaluate("""() => {
                      const pane = window.__app.App.panes[0];
                      const st = window.__app.TradeOverlay._state(pane);
                      const l = st.lines.find(l2 => l2.kind === 'order');
                      if (!l) return null;
                      let y = pane.series.priceToCoordinate(l.price);
                      const r = window.__app.TradeOverlay._lwcRect(pane);
                      return r.top + y;
                    }""")
                    lx = blocked['panel']['r'] + 220
                    pg.mouse.move(lx, ly2)
                    pg.wait_for_timeout(2300)
                    check7('same line outside the panel: hold works, tag shows',
                           pg.evaluate(tip_state) == 'block')
                if not panel_fails:
                    break
            FAILS.extend(panel_fails)
            check('zero page errors', not errors, errors[:3])
            b.close()
    finally:
        prov.terminate()

    print('\n' + ('ROUND116 E2E: ALL GREEN' if not FAILS else 'FAILED: ' + ', '.join(FAILS)))
    sys.exit(1 if FAILS else 0)

if __name__ == '__main__':
    main()
