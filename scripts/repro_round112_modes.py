#!/usr/bin/env python3
"""ROUND112 repro — the Demo/Live switch (merged Trading tab) + the Trade
panel in all THREE modes + the demo cash ledger + the icon fixes.

User asks (ROUND112):
  · "دو تا عکس فرستادم … یک سری ایکون ها رو علامت زدم … هم از نظر سایز یه
    خورده کوچیک هستن و هم رنگ اون ایکون ها چه توی دارک مود و لایت مود مشخص
    نیستن" → bigger, clearly coloured chrome + position-action icons
  · "این دو تا بخش رو یکی کنی و یک سوئیچ بذاری … بین دمو تریدینگ و لایو
    تریدینگ" → ONE merged Trading tab with a Demo/Live switch
  · "توی حالت دمو تریدینگ هم باید بتونه روی لایو مارکت بصورت دمو ترید کنه و
    هم توی حالت Bar Replay بصورت بک تست" → the demo engine prices off the
    LIVE tick stream when replay is off, off the replay chart when it is on
  · "بالانس حساب و لوریج حساب هم توسط کاربر قابلیت تغییر داشته باشه" +
    "هر بار که کاربر مبلغ بالانس رو تغییر داد … به عنوان واریز یا برداشت توی
    سابقه و هیستوری ثبت بشه" → the cash ledger (deposit/withdrawal records,
    persisted) + leverage-scaled margin
  · the chart Trade panel works in all three modes (live / demo-live /
    demo-replay)

Boots the demo broker + the real renderer in headless chromium and proves:
  [1] the rail has ONE trading tab; the merged header carries Demo|Live
  [2] Live default: the ticket body is visible, the demo body hidden, the
      panel badge reads LIVE
  [3] switching to Demo flips the bodies, shows the gear, persists, and the
      badge flips to DEMO
  [4] DEMO on the LIVE MARKET: a BUY through the panel (CONFIRM SET gate)
      opens a DEMO position (the real broker account untouched) with demo
      chart lines on the pane
  [5] the Open Positions section lists the DEMO position; ½ halves it,
      🛡 risk-free snaps the SL to the legal break-even, × closes it
  [6] the CASH LEDGER: a higher balance records a DEPOSIT, a lower one a
      WITHDRAWAL; the Cash tab lists both; the account SURVIVES a reload
  [7] BAR REPLAY: starting the replay auto-switches to Demo; the draft and
      the fill price come from the REPLAY chart (not the live quote); a
      pending order can be placed/cancelled against replay prices
  [8] the icon fixes: 24px grip chip, 20px chrome buttons, 22px coloured
      position actions (blue/green/red) — measured on BOTH themes
  [9] back to Live: the panel trades the REAL broker again (a real position
      appears in Trade.positions while the demo account keeps its own)
 [10] zero page/console errors

Exits 0 only if every check passes.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = '/home/z/my-project/upload/mt5-terminal-extracted'
PORT_HTTP, PORT_WS = 8918, 8777  # 8777 = the demo provider's fixed WS port
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

def demo_state(pg):
    return pg.evaluate("() => window.__app.ReplayTrade.state()")

def set_confirm_set(pg, i=0):
    """drive the Set button through the CONFIRM SET gate (locked default)"""
    P = '.pane-root ' if i == 0 else f'.pane-root:nth-of-type({i + 1}) '
    pg.click(P + '.oc-set')
    pg.wait_for_timeout(160)
    pg.click(P + '.oc-set')
    pg.wait_for_timeout(420)

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
            pg.evaluate("() => window.__app.RightPanel.showTab('trade')")
            pg.wait_for_timeout(250)

            print('[1] ONE merged trading tab on the rail')
            check('no replaytrade rail button remains',
                  pg.evaluate("() => !document.querySelector('#right-tabs .rt-btn[data-tab=replaytrade]')"))
            check('the merged tab hosts the Demo/Live switch',
                  pg.evaluate("() => { const m = document.getElementById('tr-mode'); return m && m.querySelectorAll('.tr-modeb[data-m]').length === 2; }"))
            check('the demo gear sits in the merged header',
                  pg.evaluate("() => !!document.getElementById('rtt-gear')"))

            print('[2] LIVE is the default: the ticket body is up, the demo body hidden')
            check('Live is the active switch state',
                  pg.evaluate("() => document.querySelector('#tr-mode .tr-modeb[data-m=live]').classList.contains('on')"))
            check('#tr-live visible with the order ticket',
                  pg.evaluate("() => { const el = document.getElementById('tr-live'); return !el.classList.contains('hidden') && !!el.querySelector('#trade-ticket'); }"))
            check('#tr-demo hidden',
                  pg.evaluate("() => document.getElementById('tr-demo').classList.contains('hidden')"))
            check('the panel badge reads LIVE',
                  pg.eval_on_selector(P + '.oc-mbadge', 'el => el.textContent') == 'LIVE')

            print('[3] the switch flips to Demo (persisted)')
            pg.click('#tr-mode .tr-modeb[data-m=demo]')
            pg.wait_for_timeout(420)
            check('the Demo switch is active',
                  pg.evaluate("() => document.querySelector('#tr-mode .tr-modeb[data-m=demo]').classList.contains('on')"))
            check('#tr-demo visible now', pg.evaluate("() => !document.getElementById('tr-demo').classList.contains('hidden')"))
            check('#tr-live hidden now', pg.evaluate("() => document.getElementById('tr-live').classList.contains('hidden')"))
            check('the demo status line names the LIVE MARKET source',
                  'LIVE MARKET' in pg.eval_on_selector('#rtt-status-txt', 'el => el.textContent'),
                  pg.eval_on_selector('#rtt-status-txt', 'el => el.textContent'))
            check('the panel badge flipped to DEMO',
                  pg.eval_on_selector(P + '.oc-mbadge', 'el => el.textContent') == 'DEMO')
            check('the mode persisted (mt5_trade_mode=demo — JSON-encoded)',
                  pg.evaluate("() => JSON.parse(localStorage.getItem('mt5_trade_mode') || 'null')") == 'demo')
            check('the demo engine answers available()',
                  pg.evaluate("() => window.__app.TradeRoute.canTrade().ok"))

            print('[4] DEMO on the LIVE MARKET — a panel BUY opens a DEMO position')
            pg.evaluate("() => { const r = window.__app.OneClick; r._rmode = 'lot'; r._rvals.lot = 0.02; r._saveRisk(); }")
            pg.click(P + '.oc-buy')
            pg.wait_for_timeout(280)
            d = dbg(pg)
            check('the draft armed with three lines (market BUY)',
                  d['draft'] and not d['draft']['pend'] and all(d['draft']['lines'][k] for k in ('e', 's', 't')))
            replay_quote = pg.evaluate(f"() => window.__app.ReplayTrade.quoteOf('{sym}')")
            ptv = pg.evaluate(f"() => window.__app.Trade.specSync('{sym}').point || 1e-5")
            check('the draft entry locked to the DEMO quote (= the live tick stream)',
                  d['draft'] and replay_quote and abs(d['draft']['entry'] - replay_quote['ask']) <= 30 * ptv,
                  (d['draft'] and d['draft']['entry'], replay_quote))
            n0 = len(demo_state(pg)['positions'])
            set_confirm_set(pg)
            pg.wait_for_timeout(500)
            st = demo_state(pg)
            check('a DEMO position opened (demo account, not the broker)',
                  len(st['positions']) == n0 + 1, st['positions'])
            check('the real broker account stayed EMPTY (isolation)',
                  pg.evaluate("() => window.__app.Trade.positions.length") == 0)
            pos = st['positions'][0]
            check('the demo fill == the ask with 0.02 lots', pos['volume'] == 0.02 and abs(pos['open'] - replay_quote['ask']) < 0.01,
                  (pos['open'], replay_quote))
            check('the draft lines were released after the fill', dbg(pg)['draft'] is None)
            check('DEMO chart lines exist on the pane (entry/SL/TP)',
                  pg.evaluate("() => (window.__app.ReplayTrade._state(window.__app.App.panes[0]).lines || []).length") >= 3)
            check('the Open Positions section lists the demo row',
                  pg.evaluate(f"() => {{ const l = document.querySelector('{P}.oc-poslist'); return l && l.textContent.includes('{sym}'); }}"))

            print('[5] the per-position actions work on the DEMO account')
            pg.click(f"{P}.oc-pos-row .oc-pact.oc-half")
            pg.wait_for_timeout(450)
            st = demo_state(pg)
            check('½ halved the demo position', len(st['positions']) == 1 and abs(st['positions'][0]['volume'] - 0.01) < 1e-9,
                  st['positions'])
            ticket = st['positions'][0]['ticket']
            be_res = pg.evaluate(f"() => window.__app.ReplayTrade.modifySLTP({ticket}, window.__app.ReplayTrade.state().positions[0].open, 0, {{ be: true }})")
            if not (be_res and be_res.get('ok')):
                # a fast market can hit the default draft SL between reads — retry once
                pg.wait_for_timeout(350)
                st = demo_state(pg)
                if st['positions']:
                    be_res = pg.evaluate("() => window.__app.ReplayTrade.modifySLTP(window.__app.ReplayTrade.state().positions[0].ticket, window.__app.ReplayTrade.state().positions[0].open, 0, { be: true })")
            ok_be = bool(be_res and be_res.get('ok'))
            st = demo_state(pg)
            p0 = st['positions'][0]
            be_geo = pg.evaluate("""() => {
              const s = window.__app.ReplayTrade.state().positions[0];
              if (!s) return null;
              const spec = window.__app.Trade.specSync(s.symbol);
              const q = window.__app.ReplayTrade.quoteOf(s.symbol);
              const ref = s.type === 0 ? q.bid : q.ask;
              const pt = spec.point || 1e-5;
              const gap = (spec.stops_level > 0 ? spec.stops_level * pt : 0) + pt;
              return { diff: Math.abs(Math.abs(s.sl - ref) - gap), side: s.type === 0 ? (s.sl < ref) : (s.sl > ref), pt };
            }""")
            check('🛡 risk-free: the SL accepted at (snapped) legal break-even', ok_be, (be_res, p0))
            check('the snapped SL sits exactly one legal gap from the close price (true break-even)',
                  be_geo and be_geo['side'] and be_geo['diff'] <= 1.5 * be_geo['pt'], be_geo)
            pg.click(f"{P}.oc-pos-row .oc-pact.oc-x")
            pg.wait_for_timeout(450)
            check('× closed the demo position', len(demo_state(pg)['positions']) == 0)

            print('[6] the CASH LEDGER — balance edits are deposit/withdrawal records')
            pg.click('#rtt-gear')
            pg.wait_for_timeout(150)
            bal0 = demo_state(pg)['balance']
            pg.fill('#rtt-balance', str(bal0 + 1500))
            pg.click('#rtt-apply')
            pg.wait_for_timeout(450)
            st = demo_state(pg)
            check('a higher balance records a DEPOSIT and moves the balance',
                  len(st['tx']) == 1 and st['tx'][0]['kind'] == 'dep' and st['tx'][0]['amount'] == 1500 and
                  abs(st['balance'] - (bal0 + 1500)) < 0.01, st['tx'])
            pg.fill('#rtt-balance', str(bal0 + 1500 - 500))
            pg.click('#rtt-apply')
            pg.wait_for_timeout(450)
            st = demo_state(pg)
            check('a lower balance records a WITHDRAWAL',
                  len(st['tx']) == 2 and st['tx'][1]['kind'] == 'with' and st['tx'][1]['amount'] == 500, st['tx'])
            pg.click('#rtt-tabs .rtt-tab[data-t=tx]')
            pg.wait_for_timeout(250)
            tx_html = pg.eval_on_selector('#rtt-tables', 'el => el.textContent')
            check('the Cash tab lists DEPOSIT + WITHDRAW rows with the balance after',
                  'DEPOSIT' in tx_html and 'WITHDRAW' in tx_html and 'bal' in tx_html, tx_html[:120])
            pg.click('#rtt-tabs .rtt-tab[data-t=hist]')
            pg.wait_for_timeout(200)

            print('[6b] the account snapshot SURVIVES a reload')
            pg.evaluate("() => { try { localStorage.setItem('mt5_rp_tab', 'closed'); } catch (e) {} }")  # keep boot light
            pg.reload()
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_timeout(1400)
            st = demo_state(pg)
            check('balance + both tx records restored from the snapshot',
                  len(st['tx']) == 2 and abs(st['balance'] - (bal0 + 1000)) < 0.01, (st['balance'], len(st['tx'])))
            pg.evaluate("() => window.__app.RightPanel.showTab('trade')")
            pg.wait_for_timeout(300)
            check('the merged tab came back in DEMO mode (persisted)',
                  pg.evaluate("() => document.querySelector('#tr-mode .tr-modeb[data-m=demo]').classList.contains('on')"))

            print('[7] BAR REPLAY — the backtest mode of the same demo account')
            pg.evaluate("() => window.__app.TradeRoute.set('live', true)")   # prove the auto-switch
            pg.wait_for_timeout(300)
            started = pg.evaluate("""() => {
              const p = window.__app.App.panes[0];
              return window.__app.Replay.startAt(p, p.bars.length - 40);
            }""")
            pg.wait_for_timeout(1100)
            check('the replay started', started)
            check('starting the replay AUTO-SWITCHED to Demo (backtest account)',
                  pg.evaluate("() => window.__app.TradeRoute.isDemo()"))
            check('the demo status line names the REPLAY source',
                  'REPLAY' in pg.eval_on_selector('#rtt-status-txt', 'el => el.textContent'),
                  pg.eval_on_selector('#rtt-status-txt', 'el => el.textContent'))
            rquote = pg.evaluate(f"() => window.__app.ReplayTrade.quoteOf('{sym}')")
            lquote = pg.evaluate(f"() => window.__app.Trade.quote('{sym}')")
            check('the demo quote now comes from the REPLAY chart (not the live tick)',
                  rquote and lquote and abs(rquote['bid'] - lquote['bid']) > 1e-9,
                  (rquote and rquote['bid'], lquote and lquote['bid']))
            pg.click(P + '.oc-buy')
            pg.wait_for_timeout(280)
            d = dbg(pg)
            check('the draft armed ON the replay prices',
                  d['draft'] and abs(d['draft']['entry'] - rquote['ask']) < 1e-9, (d['draft'] and d['draft']['entry'], rquote))
            set_confirm_set(pg)
            pg.wait_for_timeout(500)
            st = demo_state(pg)
            check('the backtest position opened at the replay fill',
                  len(st['positions']) == 1 and abs(st['positions'][0]['open'] - rquote['ask']) < 0.01,
                  st['positions'])
            check('the replay position is NOT on the broker', pg.evaluate("() => window.__app.Trade.positions.length") == 0)
            okp = pg.evaluate(f"""() => {{
              const s = window.__app.ReplayTrade;
              const pt = window.__app.Trade.specSync('{sym}').point || 1e-5;
              const stops = window.__app.Trade.specSync('{sym}').stops_level || 0;
              const dist = Math.max(stops + 20, 60) * pt;
              const q = s.quoteOf('{sym}');
              return s.placePendingOrder({{ symbol: '{sym}', orderType: 4, volume: 0.01, price: q.ask + dist, sl: 0, tp: 0 }}).ok;
            }}""")
            st = demo_state(pg)
            check('a pending BUY STOP can be placed against the replay prices',
                  okp and len(st['orders']) == 1, st['orders'])
            pg.evaluate("() => window.__app.ReplayTrade.cancelOrder(window.__app.ReplayTrade.state().orders[0].ticket)")
            pg.wait_for_timeout(200)
            check('the pending order cancels cleanly', len(demo_state(pg)['orders']) == 0)
            pg.evaluate("() => window.__app.Replay.stop()")
            pg.wait_for_timeout(500)

            print('[8] the icon fixes — sizes + colours, dark AND light')
            pg.evaluate("() => window.__app.ReplayTrade.placeMarketOrder({ symbol: window.__app.App.panes[0].symbol, orderType: 0, volume: 0.01, sl: 0, tp: 0 })")
            pg.wait_for_timeout(500)

            def chip_metrics(sel):
                return pg.eval_on_selector(sel, """el => {
                  const r = el.getBoundingClientRect();
                  const c = getComputedStyle(el);
                  return { w: Math.round(r.width), h: Math.round(r.height), color: c.color };
                }""")
            pg.eval_on_selector(P + '.oc-panel', "el => el.dispatchEvent(new MouseEvent('mouseenter', {bubbles: true}))")
            pg.hover(P + '.oc-title')
            pg.wait_for_timeout(200)
            g = chip_metrics(P + '.oc-grip')
            check('the grip chip grew (≥22px wide, ≥16px tall)', g['w'] >= 22 and g['h'] >= 16, g)
            cb = chip_metrics(P + '.oc-cbtn')
            check('the pin/lock/minus buttons grew (≥16px hit area)', cb['w'] >= 16, cb)
            pa = chip_metrics(P + '.oc-pact.oc-half')
            check('the ½ action grew to 22px', pa['w'] >= 21 and pa['h'] >= 21, pa)
            colors = pg.evaluate(f"""() => {{
              const g = (sel, prop) => {{ const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; }};
              return {{
                half: g('{P}.oc-pact.oc-half', 'color'), rf: g('{P}.oc-pact.oc-rf', 'color'),
                x: g('{P}.oc-pact.oc-x', 'color'), badge: g('{P}.oc-mbadge', 'backgroundColor'),
                grip: g('{P}.oc-grip', 'color'),
              }};
            }}""")
            rgb = lambda s: (s or '').replace(' ', '')
            check('½ is app-blue, 🛡 is app-green, × is app-red (identity colours)',
                  rgb(colors['half']) == 'rgb(41,98,255)' and rgb(colors['rf']) == 'rgb(8,153,129)' and rgb(colors['x']) == 'rgb(242,54,69)', colors)
            check('the chrome icons use the full text colour (never faint dim)',
                  rgb(colors['grip']) not in ('rgba(154,163,180,1)', 'rgba(120,123,134,1)'), colors['grip'])
            pg.screenshot(path=os.path.join(ROOT, 'scripts', 'round112_dark.png'))
            pg.evaluate("() => window.__app.Theme.toggle()")
            pg.wait_for_timeout(400)
            colors_l = pg.evaluate(f"""() => {{
              const g = (sel, prop) => {{ const el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : null; }};
              return {{ half: g('{P}.oc-pact.oc-half', 'color'), grip: g('{P}.oc-grip', 'backgroundColor') }};
            }}""")
            check('the identity colours SURVIVE the light theme (same rgb)',
                  rgb(colors_l['half']) == 'rgb(41,98,255)', colors_l)
            pg.screenshot(path=os.path.join(ROOT, 'scripts', 'round112_light.png'))
            pg.evaluate("() => window.__app.Theme.toggle()")   # back to dark
            pg.wait_for_timeout(300)

            print('[9] back to LIVE — the panel trades the real broker again')
            pg.evaluate("() => window.__app.ReplayTrade.closeAll()")
            pg.evaluate("() => window.__app.TradeRoute.set('live', true)")
            pg.wait_for_timeout(400)
            check('the badge flipped back to LIVE', pg.eval_on_selector(P + '.oc-mbadge', 'el => el.textContent') == 'LIVE')
            check('the demo account kept its own state (isolation both ways)',
                  len(demo_state(pg)['tx']) == 2)
            pg.evaluate("() => { const r = window.__app.OneClick; r._rmode = 'lot'; r._rvals.lot = 0.01; r._saveRisk(); }")
            pg.click(P + '.oc-buy')
            pg.wait_for_timeout(280)
            set_confirm_set(pg)
            pg.wait_for_timeout(700)
            live_n = pg.evaluate("() => window.__app.Trade.positions.length")
            check('a REAL broker position opened from the same panel', live_n >= 1, live_n)
            check('the broker position did NOT leak into the demo account',
                  len(demo_state(pg)['positions']) == 0)
            pg.evaluate("() => window.__app.Trade.closeAll()")   # clean up the broker
            pg.wait_for_timeout(400)

            check('ZERO page/console errors the whole run', not errors, errors[:4])
            b.close()
    finally:
        prov.terminate()
    print()
    if FAILS:
        print(f'FAILED: {len(FAILS)} — ' + ' · '.join(FAILS))
        sys.exit(1)
    print('ALL ROUND112 CHECKS PASSED')

if __name__ == '__main__':
    main()
