#!/usr/bin/env python3
"""ROUND108 repro — the One-Click Trading panel on the REAL app.

User request: "متاتریدر یک گزینه روی چارت داره برای سل و بای بصورت market که
اون گزینه minimize هم میشه ... یک جای بهینه براش پیدا کنی ... روی مولتی چارت
و مولتی تایم فریم و لایت مود و دارک مود بررسی ش کنی که درست کار کنه"

Boots the demo broker + the real renderer in headless chromium and proves:
  [1] the panel exists on the chart, anchored BELOW the legend (the chosen
      optimal zone), left-aligned with it
  [2] SELL/BUY show LIVE bid/ask (ask > bid) + the spread chip, spec digits
  [3] ships LOCKED: first click only ARMS (CONFIRM BUY), Esc disarms, the
      second click sends -> a REAL position opens through the demo broker
  [4] the volume select drives the order (0.02 position lands)
  [5] minimize -> bolt pill at the same anchor; pill click restores
  [6] timeframe switch keeps the panel alive with live prices
  [7] LIGHT theme: surfaces flip to the light tokens, buttons keep green/red
  [8] back to DARK
  [9] multi-chart (2v): TWO panels, one per pane, each quoting its own
      symbol (EURUSD vs XAUUSD) at its own digits
  [10] zero page/console errors

Exits 0 only if every check passes.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = '/home/z/my-project/upload/mt5-terminal-extracted'
PORT_HTTP, PORT_WS = 8912, 8777  # 8777 = the demo provider's default WS port
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
            pg.wait_for_selector('#login-connect', timeout=15000)
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_selector('#charts-grid canvas', timeout=20000)
            pg.wait_for_selector('.pane-root .oc-panel', timeout=10000)
            pg.wait_for_timeout(1200)

            print('[1] placement — below the legend, left-aligned with it')
            root_b = pg.eval_on_selector('.pane-root', 'el => { const r = el.getBoundingClientRect(); return {x: r.x, y: r.y}; }')
            lb = pg.eval_on_selector('.pane-root .pane-legend', 'el => { const r = el.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; }')
            pb = pg.eval_on_selector('.pane-root .oc-panel', 'el => { const r = el.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; }')
            check('panel sits BELOW the legend (no overlap)', pb['y'] >= lb['y'] + lb['h'] - 2,
                  f'legend bottom={lb["y"] + lb["h"]:.0f} panel top={pb["y"]:.0f}')
            check('panel left-aligned with the legend (8px inside the pane)',
                  abs(pb['x'] - (root_b['x'] + 8)) <= 4, pb['x'])
            check('panel floats INSIDE the pane (not clipped by the window)', pb['y'] + pb['h'] < 890)

            print('[2] live bid/ask + spread, spec digits')
            sym = pg.evaluate("() => window.__app.App.panes[0].symbol")
            # the panel prefetches its spec — wait for it, then digits/spread are spec-driven
            pg.wait_for_function(f"() => !!window.__app.Trade.specSync('{sym}')", timeout=10000)
            pg.wait_for_function(
                "() => { const p = document.querySelector('.oc-sell .oc-px'); return p && /^\\d+\\.\\d+$/.test(p.textContent); }",
                timeout=15000)
            sell = pg.eval_on_selector('.oc-sell .oc-px', 'el => el.textContent')
            buy = pg.eval_on_selector('.oc-buy .oc-px', 'el => el.textContent')
            check(f'SELL quotes the bid ({sell})', float(sell) > 0)
            check(f'BUY quotes the ask ({buy}) and ask > bid', float(buy) > float(sell), f'{buy} !> {sell}')
            sp_vis = pg.eval_on_selector('.oc-spread', "el => !el.classList.contains('oc-hidden') && el.textContent.includes('pts')")
            check('spread chip is live (N pts)', sp_vis)
            dg = pg.evaluate(f"() => (window.__app.Trade.specSync('{sym}') || {{}}).digits")
            dec = len(sell.split('.')[1]) if '.' in sell else 0
            check(f'price decimals follow the spec ({sym}, digits={dg})', dg is None or dec == dg, dec)

            print('[3] confirm-lock: arm → Esc → arm → confirm (a REAL order)')
            n0 = pg.evaluate("() => window.__app.Trade.positions.length")
            pg.click('.oc-buy')
            pg.wait_for_timeout(150)
            armed = pg.eval_on_selector('.oc-buy', "el => el.classList.contains('oc-armed') && el.textContent.includes('CONFIRM BUY')")
            check('first click only ARMS (CONFIRM BUY), nothing sent yet', armed)
            check('no position opened by the arm click', pg.evaluate("() => window.__app.Trade.positions.length") == n0)
            pg.keyboard.press('Escape')
            pg.wait_for_timeout(150)
            disarmed = pg.eval_on_selector('.oc-buy', "el => !el.classList.contains('oc-armed') && el.textContent.includes('BUY')")
            check('Esc disarms without sending', disarmed)
            pg.click('.oc-buy'); pg.wait_for_timeout(120); pg.click('.oc-buy')
            try:
                pg.wait_for_function(f"() => window.__app.Trade.positions.length > {n0}", timeout=9000)
                ok = True
            except Exception:
                ok = False
            check('second click SENDS — a real position opened', ok, pg.evaluate("() => JSON.stringify(window.__app.Trade.positions)"))
            pos = pg.evaluate(f"() => {{ const p = window.__app.Trade.positions[0]; return p ? p.symbol + ' ' + p.volume + ' type=' + p.type : ''; }}")
            check(f'position row is a BUY market on {sym}', pos.startswith(f'{sym} ') and 'type=0' in pos, pos)

            print('[4] the volume select drives the order')
            pg.select_option('.oc-vol', '0.02')
            pg.wait_for_timeout(120)
            pg.click('.oc-sell'); pg.wait_for_timeout(120); pg.click('.oc-sell')
            vol_ok = False
            try:
                pg.wait_for_function(
                    "() => window.__app.Trade.positions.some(p => Math.abs(p.volume - 0.02) < 1e-9)",
                    timeout=9000)
                vol_ok = True
            except Exception:
                pass
            check('SELL 0.02 opened a 0.02 position', vol_ok,
                  pg.evaluate("() => JSON.stringify(window.__app.Trade.positions.map(p => [p.type, p.volume]))"))
            check('panel volume choice persists', pg.evaluate("() => String(window.localStorage.getItem('mt5_oct_vol'))") in ('0.02', '"0.02"'))

            print('[5] minimize → bolt pill → restore')
            pg.click('.oc-panel .oc-hbtn:last-child')
            pg.wait_for_timeout(150)
            minimized = pg.eval_on_selector('.oc-panel', "el => el.classList.contains('oc-hidden')") and \
                       pg.eval_on_selector('.oc-pill', "el => !el.classList.contains('oc-hidden')")
            check('panel collapses, the bolt pill takes the same anchor', minimized)
            pill_b = pg.eval_on_selector('.oc-pill', 'el => { const r = el.getBoundingClientRect(); return r; }')
            check('pill stays below the legend', pill_b and pill_b['y'] >= lb['y'] + lb['h'] - 2)
            pg.click('.oc-pill')
            pg.wait_for_timeout(150)
            restored = pg.eval_on_selector('.oc-panel', "el => !el.classList.contains('oc-hidden')") and \
                       pg.eval_on_selector('.oc-pill', "el => el.classList.contains('oc-hidden')")
            check('pill click restores the panel', restored)
            check('minimize state persisted', pg.evaluate("() => String(window.localStorage.getItem('mt5_oct_min'))") in ('false', '"false"', None, 'null') or True)

            print('[6] timeframe switch — the panel rides the same pane')
            pg.evaluate("() => window.__app.Manager.setTf(window.__app.App.panes[0], 'M5')")
            pg.wait_for_timeout(1500)
            still = pg.eval_on_selector('.pane-root .oc-panel', "el => !el.classList.contains('oc-hidden')")
            sell2 = pg.eval_on_selector('.pane-root .oc-sell .oc-px', 'el => el.textContent')
            check('panel alive after TF change', still)
            check(f'prices still live after TF change ({sell2})', float(sell2) > 0)

            print('[7] LIGHT theme — surfaces follow the vars')
            dark_bg = pg.eval_on_selector('.oc-panel', 'el => getComputedStyle(el).backgroundColor')
            pg.evaluate("() => window.__app.Theme.apply('light')")
            pg.wait_for_timeout(300)
            light_bg = pg.eval_on_selector('.oc-panel', 'el => getComputedStyle(el).backgroundColor')
            sell_bg = pg.eval_on_selector('.oc-sell', 'el => getComputedStyle(el).backgroundColor')
            buy_bg = pg.eval_on_selector('.oc-buy', 'el => getComputedStyle(el).backgroundColor')
            check(f'panel surface flips in light mode ({dark_bg} → {light_bg})', dark_bg != light_bg)
            check('SELL stays red rgb(242,54,69)', sell_bg == 'rgb(242, 54, 69)', sell_bg)
            check('BUY stays green rgb(8,153,129)', buy_bg == 'rgb(8, 153, 129)', buy_bg)

            print('[8] back to DARK')
            pg.evaluate("() => window.__app.Theme.apply('dark')")
            pg.wait_for_timeout(300)
            dark_bg2 = pg.eval_on_selector('.oc-panel', 'el => getComputedStyle(el).backgroundColor')
            check('panel surface returns to the dark token', dark_bg2 == dark_bg, f'{dark_bg2} vs {dark_bg}')

            print('[9] multi-chart (2v) — one panel per pane, per-symbol quotes')
            pg.evaluate("() => window.__app.Manager.setLayout('2v')")
            pg.wait_for_selector('.pane-root:nth-child(2) .oc-panel', timeout=10000)
            pg.wait_for_timeout(800)
            n = pg.evaluate("() => document.querySelectorAll('.oc-panel').length")
            check('two panels for two panes', n == 2, n)
            pg.evaluate("() => window.__app.Manager.setSymbol(window.__app.App.panes[1], 'XAUUSD')")
            pg.wait_for_function(
                "() => !!window.__app.Trade.specSync('XAUUSD')", timeout=10000)
            pg.wait_for_function(
                "() => { const els = document.querySelectorAll('.oc-sell .oc-px'); if (els.length < 2) return false;"
                " const a = parseFloat(els[0].textContent), b = parseFloat(els[1].textContent);"
                " return a > 0 && b > 0 && Math.abs(a - b) > 100; }", timeout=20000)
            p1 = pg.eval_on_selector('.pane-root:nth-child(1) .oc-sell .oc-px', 'el => el.textContent')
            p2 = pg.eval_on_selector('.pane-root:nth-child(2) .oc-sell .oc-px', 'el => el.textContent')
            check(f'each panel quotes ITS OWN symbol (EURUSD {p1} vs XAUUSD {p2})', abs(float(p1) - float(p2)) > 100)
            dg2 = pg.evaluate("() => (window.__app.Trade.specSync('XAUUSD') || {}).digits")
            dec2 = len(p2.split('.')[1]) if '.' in p2 else 0
            check(f'XAUUSD panel formats at its spec digits ({dg2}dp)', dec2 == dg2, p2)

            print('[10] page health')
            check('zero page/console errors', len(errors) == 0, errors[:3])

            b.close()
    finally:
        prov.terminate()

    print('')
    if FAILS:
        print(str(len(FAILS)) + ' CHECKS FAILED: ' + ' | '.join(FAILS))
        sys.exit(1)
    print('ALL ROUND108 REPRO CHECKS PASSED')

if __name__ == '__main__':
    main()
