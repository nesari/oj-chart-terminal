#!/usr/bin/env python3
"""ROUND111 repro — the full "Trade" panel (money management + draft orders +
open positions), on the REAL app with the demo broker.

User ask: "میخوام یک بخش مدیریت سرمایه به همین بخشی که الان اصلاحش کردی اضافه
کنم" — Risk (Lot/$/%), Buy/Sell arming three live dashed lines (entry locked
to the market, draggable SL/TP with live $+points), Set/Cancel, Pend.Buy/
Pend.Sell with a draggable entry, and a collapsible Open Positions section
(% / $ units, close half, risk-free, close).

Boots the demo broker + the real renderer in headless chromium and proves:
  [1] the panel structure matches the mock-up (title · Risk row · %$Lot ·
      Buy/Sell/Set · Pend.Buy/Pend.Sell/Cancel · Open Positions header)
  [2] BUY arms a draft: THREE dashed price lines on the chart + status strip
  [3] the market entry is LOCKED to the live ask (follows ticks)
  [4] the SL line DRAGS on the chart (draft.sl follows the drop point)
  [5] the Risk $ mode sizes the volume from the SL distance (live status)
  [6] Lot mode: Set (through the CONFIRM SET gate) opens a REAL position with
      the exact lot + the draft's SL/TP; the draft lines then disappear
  [7] Open Positions: the row appears, the %/$ unit toggle re-leads the P/L
  [8] risk-free (shield): the SL jumps to the entry (break-even)
  [9] close half (½): the volume halves; close (×): the position is gone
 [10] Pend.Buy with the entry dragged above the market → Set opens a REAL
      BUY STOP pending order; Cancel kills a draft without sending anything
 [11] Esc cancels the armed draft; the collapse arrow folds the list
 [12] the draft is per-pane (multi-chart isolation)
 [13] light + dark themes dress the new panel; zero page/console errors

Exits 0 only if every check passes.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = '/home/z/my-project/upload/mt5-terminal-extracted'
PORT_HTTP, PORT_WS = 8916, 8777  # 8777 = the demo provider's fixed WS port
FAILS = []

def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if (not cond and extra != '') else ''))
    if not cond:
        FAILS.append(name)

def wait_port(port, timeout=20):
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

def dbg(pg, i=0):
    return pg.evaluate(f"() => window.__app.OneClick._dbg(window.__app.App.panes[{i}])")

def sl_screen_y(pg, i=0, which='sl'):
    """screen-space Y of a draft line (the round-100 origin rule: the LWC el)"""
    expr = 'st.draft.%s' % which
    return pg.evaluate(f"""() => {{
      const p = window.__app.App.panes[{i}];
      const st = window.__app.OneClick._dbg(p);
      const el = p.mainWrap.querySelector(':scope > .tv-lightweight-charts') || p.mainWrap;
      const r = el.getBoundingClientRect();
      const y = p.series.priceToCoordinate({expr});
      return {{ x: r.left + r.width / 2, y: r.top + y }};
    }}""")

def drag(pg, x0, y0, x1, y1, steps=8):
    pg.mouse.move(x0, y0)
    pg.mouse.down()
    for k in range(1, steps + 1):
        pg.mouse.move(x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps)
    pg.mouse.up()
    pg.wait_for_timeout(220)

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        assert wait_port(PORT_HTTP) and wait_port(PORT_WS), 'provider/http did not come up'
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            b = pw.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            pg = b.new_page(viewport={'width': 1600, 'height': 900})
            errors = []
            pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
            pg.on('console', lambda m: errors.append('console-error: ' + m.text) if m.type == 'error' else None)

            print('[boot] demo broker + renderer')
            pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_selector('.pane-root .oc-panel', timeout=10000)
            sym = pg.evaluate("() => window.__app.App.panes[0].symbol")
            pg.wait_for_function(f"() => !!window.__app.Trade.specSync('{sym}')", timeout=10000)
            pg.wait_for_timeout(900)
            P = '.pane-root '

            print('[1] the panel structure matches the mock-up')
            check('title row reads Trade + the live symbol',
                  pg.eval_on_selector(P + '.oc-title', 'el => el.textContent.includes("Trade")') and
                  pg.eval_on_selector(P + '.oc-tsym', 'el => el.textContent') == sym)
            check('the Risk field is an editable input',
                  pg.eval_on_selector(P + '.oc-rin', 'el => el.tagName') == 'INPUT')
            modes = pg.evaluate(f"""() => Array.from(document.querySelectorAll('{P}.oc-modeb')).map(b => b.dataset.m)""")
            check('the three risk modes are % $ Lot (in the mock-up order)',
                  modes == ['pct', 'money', 'lot'], modes)
            check('the Lot mode starts active (oc-on)',
                  pg.evaluate(f"() => document.querySelector('{P}.oc-modeb[data-m=lot]').classList.contains('oc-on')"))
            for sel, name in [('.oc-buy', 'Buy'), ('.oc-sell', 'Sell'), ('.oc-set', 'Set'),
                              ('.oc-pendbuy', 'Pend. Buy'), ('.oc-pendsell', 'Pend. Sell'), ('.oc-cancel', 'Cancel')]:
                if not pg.eval_on_selector(P + sel, 'el => el.textContent.trim().startsWith("%s")' % name):
                    check(f'button {name} present', False)
                    break
            else:
                check('Buy / Sell / Set / Pend. Buy / Pend. Sell / Cancel all present', True)
            check('the Open Positions header exists with % / $ + collapse',
                  pg.evaluate(f"() => {{ const h = document.querySelector('{P}.oc-poshead'); return h && h.textContent.includes('Open Positions') && !!h.querySelector('.oc-unitb[data-u=pct]') && !!h.querySelector('.oc-unitb[data-u=usd]') && !!h.querySelector('.oc-coll'); }}"))
            check('the empty list reads No open positions',
                  pg.eval_on_selector(P + '.oc-poslist', 'el => el.textContent.trim()') == 'No open positions')

            print('[2] BUY arms the draft — three dashed lines + status strip')
            pg.click(P + '.oc-buy')
            pg.wait_for_timeout(300)
            d = dbg(pg)
            check('the draft is a market BUY', d['draft'] and not d['draft']['pend'] and d['draft']['side'] == 0, d['draft'])
            check('all THREE lines exist (entry + SL + TP)',
                  d['draft'] and all(d['draft']['lines'][k] for k in ('e', 's', 't')), d['draft'] and d['draft']['lines'])
            check('the Buy button carries the armed look (oc-armed)',
                  pg.evaluate(f"() => document.querySelector('{P}.oc-buy').classList.contains('oc-armed')"))
            check('the status strip is visible with the resolved volume',
                  pg.evaluate(f"() => {{ const s = document.querySelector('{P}.oc-status'); return !s.classList.contains('oc-hidden') && /Vol [0-9]/.test(s.textContent); }}"),
                  pg.eval_on_selector(P + '.oc-status', 'el => el.textContent'))
            check('the status strip shows the SL/TP dollars',
                  'SL -$' in pg.eval_on_selector(P + '.oc-status', 'el => el.textContent') and
                  'TP +$' in pg.eval_on_selector(P + '.oc-status', 'el => el.textContent'))

            print('[3] the market entry is LOCKED to the live ask')
            ask0 = pg.evaluate(f"() => window.__app.Trade.quote('{sym}').ask")
            near0 = abs(d['draft']['entry'] - ask0) < 10 * (pg.evaluate(f"() => window.__app.Trade.specSync('{sym}').point") or 1e-5) + 1e-9
            check('entry == the live ask at arm time', near0, (d['draft']['entry'], ask0))
            pg.wait_for_timeout(700)
            d = dbg(pg)
            ask1 = pg.evaluate(f"() => window.__app.Trade.quote('{sym}').ask")
            check('the entry still rides the ask after ticks (locked)',
                  abs(d['draft']['entry'] - ask1) < 5e-9 or ask1 == ask0,
                  (d['draft']['entry'], ask1))

            print('[4] the SL line DRAGS on the chart')
            sl_before = dbg(pg)['draft']['sl']
            pos = sl_screen_y(pg, 0, 'sl')
            drag(pg, pos['x'], pos['y'], pos['x'], pos['y'] + 70)
            d = dbg(pg)
            check('the draft.sl moved DOWN with the drag',
                  d['draft'] and d['draft']['sl'] < sl_before, (sl_before, d['draft'] and d['draft']['sl']))
            check('the SL stayed on the loss side (below the entry)',
                  d['draft']['sl'] < d['draft']['entry'])

            print('[5] the Risk $ mode sizes the volume from the SL distance')
            pg.click(P + '.oc-modeb[data-m=money]')
            pg.wait_for_timeout(150)
            pg.click(P + '.oc-rin')
            pg.fill(P + '.oc-rin', '25')
            pg.keyboard.press('Enter')
            pg.wait_for_timeout(300)
            d = dbg(pg)
            check('the mode switched to $ (money)', d['mode'] == 'money')
            check('the $ value 25 persisted per-mode', abs(d['vals']['money'] - 25) < 1e-9, d['vals'])
            expect = pg.evaluate(f"""() => {{
              const p = window.__app.App.panes[0]; const st = window.__app.OneClick._dbg(p);
              const dist = Math.abs(st.draft.entry - st.draft.sl);
              const v = window.__app.Trade.lotForRisk('{sym}', 25, dist);
              const c = window.__app.Trade.clampVolume('{sym}', v);
              const txt = document.querySelector('{P}.oc-status').textContent;
              return {{ vol: c, txt }};
            }}""")
            vol_txt = pg.evaluate(f"""() => {{
              const s = window.__app.Trade.specSync('{sym}');
              const dbg0 = window.__app.OneClick._dbg(window.__app.App.panes[0]).draft;
              const dist = Math.abs(dbg0.entry - dbg0.sl);
              const c = window.__app.Trade.clampVolume('{sym}', window.__app.Trade.lotForRisk('{sym}', 25, dist));
              const dp = (s && s.vol_step > 0 && s.vol_step < 0.01) ? 3 : 2;
              return c.toFixed(dp);
            }}""")
            check('the status strip resolves the $ risk into the exact lot',
                  ('Vol ' + vol_txt) in expect['txt'], (expect['txt'], vol_txt))

            print('[6] Lot mode 0.05 → CONFIRM SET → a REAL position with the draft SL/TP')
            pg.click(P + '.oc-modeb[data-m=lot]')
            pg.wait_for_timeout(150)
            pg.click(P + '.oc-rin')
            pg.fill(P + '.oc-rin', '0.05')
            pg.keyboard.press('Enter')
            pg.wait_for_timeout(250)
            n0 = pg.evaluate("() => window.__app.Trade.positions.length")
            d = dbg(pg)
            sl_exp, tp_exp = d['draft']['sl'], d['draft']['tp']
            pg.click(P + '.oc-set')
            pg.wait_for_timeout(200)
            d = dbg(pg)
            check('the confirm-lock gates Set (armed, nothing sent yet)',
                  d['setArmed'] and pg.evaluate("() => window.__app.Trade.positions.length") == n0)
            check('the Set button reads CONFIRM SET',
                  pg.eval_on_selector(P + '.oc-set', 'el => el.textContent.includes("CONFIRM SET")'))
            pg.click(P + '.oc-set')
            try:
                pg.wait_for_function(f"() => window.__app.Trade.positions.length > {n0}", timeout=9000)
                ok = True
            except Exception:
                ok = False
            check('the position opened on the second click', ok)
            if ok:
                p = pg.evaluate("() => window.__app.Trade.positions[window.__app.Trade.positions.length - 1]")
                check('the volume is the Risk lot 0.05', abs(p['volume'] - 0.05) < 1e-9, p['volume'])
                ptol = (pg.evaluate(f"() => window.__app.Trade.specSync('{sym}').point") or 1e-5) * 3
                check('the position SL matches the drafted SL', abs(p['sl'] - sl_exp) < ptol, (p['sl'], sl_exp))
                check('the position TP matches the drafted TP', abs(p['tp'] - tp_exp) < ptol, (p['tp'], tp_exp))
            pg.wait_for_timeout(400)
            d = dbg(pg)
            check('the draft cleared after success (the real overlay lines take over)',
                  d['draft'] is None)

            print('[7] Open Positions — the row + the % / $ unit toggle')
            check('a row exists for the opened position',
                  pg.evaluate(f"() => !!document.querySelector('{P}.oc-pos-row[data-ticket]')"))
            row_sym = pg.eval_on_selector(P + '.oc-pos-row .oc-pos-name b', 'el => el.textContent')
            check('the row names the symbol', row_sym == sym, row_sym)
            check('the row shows the percent P/L by default (% leads)',
                  pg.evaluate(f"() => {{ const u = document.querySelector('{P}.oc-unitb[data-u=pct]'); return u.classList.contains('oc-on') && /%/.test(document.querySelector('{P}.oc-pos-pl').textContent); }}"))
            pg.click(P + '.oc-unitb[data-u=usd]')
            pg.wait_for_timeout(250)
            check('the $ toggle re-leads the row (dollar first)',
                  pg.evaluate(f"() => {{ const u = document.querySelector('{P}.oc-unitb[data-u=usd]'); return u.classList.contains('oc-on') && /\\$/.test(document.querySelector('{P}.oc-pos-pl b').textContent); }}"))
            pg.click(P + '.oc-unitb[data-u=pct]')

            print('[8] risk-free — the SL jumps to the entry (break-even)')
            ticket = pg.evaluate("() => window.__app.Trade.positions[0].ticket")
            # MT5 parity (the demo broker enforces it too): an SL at/above the
            # live bid is rejected for a BUY — wait for a favourable tick so
            # the break-even move is a legal one
            try:
                pg.wait_for_function(f"() => {{ const s = window.__app.Trade.specSync('{sym}'); const q = window.__app.Trade.quote('{sym}'); const p = window.__app.Trade.positions[0]; return s && q && p && q.bid > p.open + (s.stops_level + 2) * s.point; }}", timeout=25000)
                favorable = True
            except Exception:
                favorable = False
            check('a favourable tick arrived (break-even is a legal stop)', favorable,
                  pg.evaluate(f"() => {{ const q = window.__app.Trade.quote('{sym}'); const p = window.__app.Trade.positions[0]; return q && p && [p.open, q.bid]; }}"))
            pg.click(P + '.oc-pos-row .oc-rf')
            try:
                pg.wait_for_function(f"() => {{ const p = window.__app.Trade.positions.find(x => x.ticket === {ticket}); return p && p.sl > 0 && Math.abs(p.sl - p.open) < 1e-9; }}", timeout=9000)
                ok = True
            except Exception:
                ok = False
            check('the SL now sits at the open price', ok,
                  pg.evaluate(f"() => {{ const p = window.__app.Trade.positions.find(x => x.ticket === {ticket}); return p && [p.open, p.sl]; }}"))

            print('[9] close half (½) then close (×)')
            vol0 = pg.evaluate("() => window.__app.Trade.positions[0].volume")
            pg.click(P + '.oc-pos-row .oc-half')
            try:
                pg.wait_for_function(f"() => window.__app.Trade.positions.length === 0 || Math.abs(window.__app.Trade.positions[0].volume - {vol0} / 2) < 0.011", timeout=9000)
                ok = True
            except Exception:
                ok = False
            check('the volume halved (0.05 → 0.02 left of the 0.03 half)',
                  ok, pg.evaluate("() => window.__app.Trade.positions.map(p => p.volume)"))
            pg.click(P + '.oc-pos-row .oc-x')
            try:
                pg.wait_for_function("() => window.__app.Trade.positions.length === 0", timeout=9000)
                ok = True
            except Exception:
                ok = False
            check('the position is fully closed', ok)

            print('[10] Pend.Buy with the entry dragged above the market → BUY STOP')
            orders0 = pg.evaluate("() => window.__app.Trade.orders.length")
            pg.click(P + '.oc-pendbuy')
            pg.wait_for_timeout(300)
            d = dbg(pg)
            check('the draft is a pending BUY', d['draft'] and d['draft']['pend'] and d['draft']['side'] == 0)
            pos = sl_screen_y(pg, 0, 'entry')
            drag(pg, pos['x'], pos['y'], pos['x'], pos['y'] - 90)
            d = dbg(pg)
            status_txt = pg.eval_on_selector(P + '.oc-status', 'el => el.textContent')
            check('the entry dragged above the ask becomes a BUY STOP in the status',
                  'Buy Stop' in status_txt, status_txt)
            entry_exp = d['draft']['entry']
            pg.click(P + '.oc-set')     # arm (confirm-lock)
            pg.wait_for_timeout(150)
            pg.click(P + '.oc-set')     # send
            try:
                pg.wait_for_function(f"() => window.__app.Trade.orders.length > {orders0}", timeout=9000)
                ok = True
            except Exception:
                ok = False
            check('the pending order was placed', ok)
            if ok:
                o = pg.evaluate("() => window.__app.Trade.orders[window.__app.Trade.orders.length - 1]")
                check('the order type is BUY STOP (4)', o['type'] == 4, o['type'])
                ptol = (pg.evaluate(f"() => window.__app.Trade.specSync('{sym}').point") or 1e-5) * 3
                check('the order price matches the dragged entry', abs(o['price'] - entry_exp) < ptol, (o['price'], entry_exp))
                check('the order carries the draft SL/TP', o['sl'] > 0 and o['tp'] > 0, (o['sl'], o['tp']))
                pg.evaluate(f"() => window.__app.Trade.cancelOrder(window.__app.Trade.orders[window.__app.Trade.orders.length - 1].ticket)")
                pg.wait_for_timeout(600)

            print('[11] Cancel kills a draft without sending; Esc too; the list folds')
            n_pos = pg.evaluate("() => window.__app.Trade.positions.length")
            n_ord = pg.evaluate("() => window.__app.Trade.orders.length")
            pg.click(P + '.oc-sell')
            pg.wait_for_timeout(250)
            check('the SELL draft is armed', dbg(pg)['draft'] is not None)
            pg.click(P + '.oc-cancel')
            pg.wait_for_timeout(200)
            check('Cancel clears the draft + hides the status strip',
                  dbg(pg)['draft'] is None and
                  pg.evaluate(f"() => document.querySelector('{P}.oc-status').classList.contains('oc-hidden')"))
            check('Cancel sent NOTHING', pg.evaluate("() => window.__app.Trade.positions.length") == n_pos and
                  pg.evaluate("() => window.__app.Trade.orders.length") == n_ord)
            pg.click(P + '.oc-buy')
            pg.wait_for_timeout(250)
            pg.keyboard.press('Escape')
            pg.wait_for_timeout(200)
            check('Esc cancels the armed draft too', dbg(pg)['draft'] is None)
            pg.click(P + '.oc-coll')
            pg.wait_for_timeout(200)
            check('the collapse arrow folds the list',
                  pg.evaluate(f"() => document.querySelector('{P}.oc-poslist').classList.contains('oc-hidden')"))
            pg.click(P + '.oc-coll')
            pg.wait_for_timeout(150)

            print('[12] the draft is per-pane (multi-chart isolation)')
            pg.evaluate("() => window.__app.Manager.setLayout('2v')")
            pg.wait_for_selector('.pane-root:nth-child(2) .oc-panel', timeout=10000)
            pg.wait_for_timeout(900)
            pg.click('.pane-root:nth-child(1) .oc-buy')
            pg.wait_for_timeout(300)
            d1, d2 = dbg(pg, 0), dbg(pg, 1)
            check('pane 1 armed, pane 2 untouched', d1['draft'] is not None and d2['draft'] is None)
            pg.keyboard.press('Escape')
            pg.wait_for_timeout(200)

            print('[13] themes + page health')
            def bg(sel):
                return pg.eval_on_selector(sel, 'el => getComputedStyle(el).backgroundColor')
            step_dark = bg('.pane-root:nth-child(1) .oc-step')
            status_dark = bg('.pane-root:nth-child(1) .oc-status')
            pg.evaluate("() => window.__app.Theme.apply('light')")
            pg.wait_for_timeout(350)
            step_light = bg('.pane-root:nth-child(1) .oc-step')
            status_light = bg('.pane-root:nth-child(1) .oc-status')
            check(f'the risk stepper flips in light mode ({step_dark} → {step_light})', step_dark != step_light)
            check(f'the status strip flips in light mode ({status_dark} → {status_light})', status_dark != status_light)
            pg.screenshot(path=os.path.join(ROOT, 'scripts', 'round111_light.png'),
                          clip={'x': 0, 'y': 0, 'width': 800, 'height': 500})
            pg.evaluate("() => window.__app.Theme.apply('dark')")
            pg.wait_for_timeout(300)
            check('the panel returns to the dark token', bg('.pane-root:nth-child(1) .oc-step') == step_dark)
            pg.screenshot(path=os.path.join(ROOT, 'scripts', 'round111_dark.png'),
                          clip={'x': 0, 'y': 0, 'width': 800, 'height': 500})

            check('zero page/console errors', len(errors) == 0, errors[:3])

            b.close()
    finally:
        prov.terminate()

    print('')
    if FAILS:
        print(str(len(FAILS)) + ' CHECKS FAILED: ' + ' | '.join(FAILS))
        sys.exit(1)
    print('ALL ROUND111 REPRO CHECKS PASSED')

if __name__ == '__main__':
    main()
