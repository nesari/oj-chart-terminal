#!/usr/bin/env python3
"""ROUND109 repro — the One-Click widget v2 on the REAL app: compact, draggable,
pinnable.

User feedback that drove this round: "ایکونی که ساختی براش خیلی فضا رو اشغال
کرده ... بهینه ترش کن . بعلاوه ی اینکه بشه روی چارت جابجاش کرد ... بشه جابجاش
کرد روی چارت و بعد اگر کاربر خواست قفلش بتونه بکنه"

Boots the demo broker + the real renderer in headless chromium and proves:
  [1] COMPACT build: one slim 194px row (~36px tall, was 210×64), no header,
      spread as a floating chip above the top border, anchored below the legend
  [2] live bid/ask + spread chip at spec digits
  [3] confirm-lock intact on the compact row: arm → Esc → confirm → REAL order
  [4] DRAG by the grip: the panel moves anywhere on the pane, the position is
      persisted as pane fractions (mt5_oct_pos)
  [5] MULTI-CHART: on the 2v layout BOTH panes sit at the same fractions —
      one drag moves the widget everywhere
  [6] PIN: freezes the widget (drag blocked, button lit blue); unpin → free again
  [7] PILL: minimize keeps the custom spot; the pill itself drags; a clean
      pill press restores the panel at the same spot
  [8] timeframe switch keeps the custom position
  [9] LIGHT + DARK themes both render the v2 chrome correctly
 [10] zero page/console errors

Exits 0 only if every check passes.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = '/home/z/my-project/upload/mt5-terminal-extracted'
PORT_HTTP, PORT_WS = 8913, 8777  # 8777 = the demo provider's fixed WS port
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

def rect(pg, sel):
    return pg.eval_on_selector(sel, 'el => { const r = el.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; }')

def drag(pg, sx, sy, dx, dy, steps=14):
    """a real user drag: press → travel → release"""
    pg.mouse.move(sx, sy)
    pg.mouse.down()
    for i in range(1, steps + 1):
        pg.mouse.move(sx + dx * i / steps, sy + dy * i / steps)
    pg.mouse.up()
    pg.wait_for_timeout(120)

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
            pg.wait_for_timeout(1200)

            print('[1] COMPACT v2 build — one slim row, floating spread chip')
            sym = pg.evaluate("() => window.__app.App.panes[0].symbol")
            pg.wait_for_function(f"() => !!window.__app.Trade.specSync('{sym}')", timeout=10000)
            p = rect(pg, '.pane-root .oc-panel')
            check(f'panel is the compact row (194px wide, got {p["w"]:.0f})', abs(p['w'] - 194) <= 2, p['w'])
            check(f'panel lost ~40% of its height ({p["h"]:.0f}px, was ~64px)', p['h'] < 50, p['h'])
            check('no header row exists (oc-head gone from the DOM)',
                  pg.evaluate("() => document.querySelectorAll('.oc-head, .oc-hbtn').length") == 0)
            lb = rect(pg, '.pane-root .pane-legend')
            check('panel still anchors BELOW the legend', p['y'] >= lb['y'] + lb['h'] - 2)
            pg.wait_for_function(
                "() => { const s = document.querySelector('.oc-spread'); return s && !s.classList.contains('oc-hidden'); }",
                timeout=15000)
            sp = rect(pg, '.pane-root .oc-spread')
            check('spread floats ABOVE the panel top border (costs no row height)',
                  sp['y'] < p['y'] and sp['y'] + sp['h'] > p['y'] - 2,
                  f'panel top {p["y"]:.0f} chip {sp["y"]:.0f}..{sp["y"] + sp["h"]:.0f}')
            pg.mouse.move(700, 700)   # park the pointer away — the widget at REST
            pg.wait_for_timeout(350)
            op = pg.eval_on_selector('.pane-root .oc-chrome', 'el => getComputedStyle(el).opacity')
            check('at rest the chrome is invisible — the widget is exactly SELL|lots|BUY',
                  op == '0', op)
            pb_ = rect(pg, '.pane-root .oc-panel')
            pg.screenshot(path=os.path.join(ROOT, 'scripts', 'round109_rest.png'),
                          clip={'x': max(0, pb_['x'] - 40), 'y': max(0, pb_['y'] - 50), 'width': 300, 'height': 160})

            print('[2] live bid/ask on the compact row')
            pg.wait_for_function(
                "() => { const p = document.querySelector('.oc-sell .oc-px'); return p && /^\\d+\\.\\d+$/.test(p.textContent); }",
                timeout=15000)
            sell = pg.eval_on_selector('.oc-sell .oc-px', 'el => el.textContent')
            buy = pg.eval_on_selector('.oc-buy .oc-px', 'el => el.textContent')
            check(f'SELL quotes the bid ({sell})', float(sell) > 0)
            check(f'BUY quotes the ask ({buy}) > bid', float(buy) > float(sell))

            print('[3] confirm-lock intact (arm → Esc → confirm → REAL order)')
            n0 = pg.evaluate("() => window.__app.Trade.positions.length")
            pg.click('.oc-buy'); pg.wait_for_timeout(150)
            check('first click only ARMS',
                  pg.eval_on_selector('.oc-buy', "el => el.classList.contains('oc-armed') && el.textContent.includes('CONFIRM BUY')"))
            pg.keyboard.press('Escape'); pg.wait_for_timeout(120)
            check('Esc disarms', pg.eval_on_selector('.oc-buy', "el => !el.classList.contains('oc-armed')"))
            pg.click('.oc-buy'); pg.wait_for_timeout(120); pg.click('.oc-buy')
            try:
                pg.wait_for_function(f"() => window.__app.Trade.positions.length > {n0}", timeout=9000)
                ok = True
            except Exception:
                ok = False
            check('second click still SENDS — real position opened', ok)

            print('[4] DRAG the widget by the grip (chip floats on the top border)')
            p0 = rect(pg, '.pane-root .oc-panel')
            # grip chip: 20×16 floating on the top-left of the border, center ≈ (+13, 0)
            drag(pg, p0['x'] + 13, p0['y'], 180, 120)
            p1 = rect(pg, '.pane-root .oc-panel')
            moved_px = (p1['x'] - p0['x'], p1['y'] - p0['y'])
            check(f'panel followed the pointer (Δ{moved_px[0]:.0f},{moved_px[1]:.0f} ≈ +180,+120)',
                  abs(moved_px[0] - 180) <= 3 and abs(moved_px[1] - 120) <= 3, moved_px)
            stored = pg.evaluate("() => window.localStorage.getItem('mt5_oct_pos') || ''")
            check('position persisted as fractions (mt5_oct_pos)', 'fx' in stored and 'fy' in stored, stored)
            rootb = rect(pg, '.pane-root')
            check('widget stayed inside the pane', p1['y'] >= rootb['y'] and p1['x'] >= rootb['x'] and
                  p1['x'] + p1['w'] <= rootb['x'] + rootb['w'] + 2)

            print('[5] MULTI-CHART — one drag moves the widget on every pane')
            pg.evaluate("() => window.__app.Manager.setLayout('2v')")
            pg.wait_for_selector('.pane-root:nth-child(2) .oc-panel', timeout=10000)
            pg.wait_for_timeout(900)
            l1 = pg.eval_on_selector('.pane-root:nth-child(1) .oc-panel',
                                     'el => el.style.left + "|" + el.style.top')
            l2 = pg.eval_on_selector('.pane-root:nth-child(2) .oc-panel',
                                     'el => el.style.left + "|" + el.style.top')
            check(f'both panes show the widget at the SAME spot ({l1})', l1 == l2, f'{l1} vs {l2}')
            # a second drag on pane 1 must move pane 2 live as well
            pa = rect(pg, '.pane-root:nth-child(1) .oc-panel')
            drag(pg, pa['x'] + 13, pa['y'], -80, -40)
            l1b = pg.eval_on_selector('.pane-root:nth-child(1) .oc-panel', 'el => el.style.left + "|" + el.style.top')
            l2b = pg.eval_on_selector('.pane-root:nth-child(2) .oc-panel', 'el => el.style.left + "|" + el.style.top')
            check('live follow: dragging pane 1 also moved pane 2', l1b == l2b, f'{l1b} vs {l2b}')

            print('[6] PIN — the position lock the user asked for')
            pg.hover('.pane-root:nth-child(1) .oc-panel')
            pg.click('.pane-root:nth-child(1) .oc-pinb')
            pg.wait_for_timeout(150)
            check('pin lights up (oc-on)',
                  pg.eval_on_selector('.pane-root:nth-child(1) .oc-pinb', "el => el.classList.contains('oc-on')"))
            check('pin state persisted', pg.evaluate("() => String(window.localStorage.getItem('mt5_oct_pin'))") not in ('', 'null', None))
            pb = rect(pg, '.pane-root:nth-child(1) .oc-panel')
            drag(pg, pb['x'] + 13, pb['y'], 100, 80)
            pb2 = rect(pg, '.pane-root:nth-child(1) .oc-panel')
            check('pinned: the drag attempt does NOT move the widget',
                  abs(pb2['x'] - pb['x']) < 2 and abs(pb2['y'] - pb['y']) < 2,
                  f'{pb["x"]:.0f},{pb["y"]:.0f} → {pb2["x"]:.0f},{pb2["y"]:.0f}')
            pg.click('.pane-root:nth-child(1) .oc-pinb')
            pg.wait_for_timeout(150)
            check('unpin restores dragging', pg.eval_on_selector(
                '.pane-root:nth-child(1) .oc-pinb', "el => !el.classList.contains('oc-on')"))
            drag(pg, pb2['x'] + 13, pb2['y'], 40, 30)
            pb3 = rect(pg, '.pane-root:nth-child(1) .oc-panel')
            check('after unpin the widget moves again',
                  abs(pb3['x'] - pb2['x'] - 40) <= 3 and abs(pb3['y'] - pb2['y'] - 30) <= 3)

            print('[7] PILL — minimize keeps the spot; the pill drags; click restores')
            pg.hover('.pane-root:nth-child(1) .oc-panel')
            pg.click('.pane-root:nth-child(1) .oc-minb')
            pg.wait_for_timeout(200)
            check('panel collapses, pill shows',
                  pg.eval_on_selector('.pane-root:nth-child(1) .oc-panel', "el => el.classList.contains('oc-hidden')") and
                  pg.eval_on_selector('.pane-root:nth-child(1) .oc-pill', "el => !el.classList.contains('oc-hidden')"))
            pos_before = pg.evaluate("() => window.localStorage.getItem('mt5_oct_pos')")
            pill = rect(pg, '.pane-root:nth-child(1) .oc-pill')
            drag(pg, pill['x'] + 12, pill['y'] + 12, 60, 40)
            pill2 = rect(pg, '.pane-root:nth-child(1) .oc-pill')
            check('the pill itself is draggable',
                  abs(pill2['x'] - pill['x'] - 60) <= 3 and abs(pill2['y'] - pill['y'] - 40) <= 3)
            check('pill drag updated the stored fractions',
                  pg.evaluate("() => window.localStorage.getItem('mt5_oct_pos')") != pos_before)
            pg.mouse.move(pill2['x'] + 12, pill2['y'] + 12)
            pg.mouse.down(); pg.mouse.up()   # a clean press, zero travel
            pg.wait_for_timeout(200)
            check('clean pill press restores the panel',
                  pg.eval_on_selector('.pane-root:nth-child(1) .oc-panel', "el => !el.classList.contains('oc-hidden')") and
                  pg.eval_on_selector('.pane-root:nth-child(1) .oc-pill', "el => el.classList.contains('oc-hidden')"))

            print('[8] timeframe switch keeps the custom position')
            tpl = pg.eval_on_selector('.pane-root:nth-child(1) .oc-panel', 'el => el.style.left + "|" + el.style.top')
            pg.evaluate("() => window.__app.Manager.setTf(window.__app.App.panes[0], 'M5')")
            pg.wait_for_timeout(1500)
            tpl2 = pg.eval_on_selector('.pane-root:nth-child(1) .oc-panel', 'el => el.style.left + "|" + el.style.top')
            check(f'position survived the TF change ({tpl})', tpl == tpl2, f'{tpl} vs {tpl2}')
            check('panel alive + prices still live after TF change',
                  pg.eval_on_selector('.pane-root:nth-child(1) .oc-sell .oc-px', 'el => parseFloat(el.textContent) > 0'))

            print('[9] themes — light and dark both dress the v2 chrome')
            pg.screenshot(path=os.path.join(ROOT, 'scripts', 'round109_dark.png'),
                          clip={'x': 0, 'y': 0, 'width': 800, 'height': 450})
            dark_bg = pg.eval_on_selector('.oc-panel', 'el => getComputedStyle(el).backgroundColor')
            grip_dark = pg.eval_on_selector('.pane-root:nth-child(1) .oc-grip', 'el => getComputedStyle(el).backgroundColor')
            pg.evaluate("() => window.__app.Theme.apply('light')")
            pg.wait_for_timeout(350)
            light_bg = pg.eval_on_selector('.oc-panel', 'el => getComputedStyle(el).backgroundColor')
            check(f'panel surface flips in light mode ({dark_bg} → {light_bg})', dark_bg != light_bg)
            grip_light = pg.eval_on_selector('.pane-root:nth-child(1) .oc-grip', 'el => getComputedStyle(el).backgroundColor')
            check(f'chrome chips re-skin for light ({grip_dark} → {grip_light})', grip_dark != grip_light)
            sell_bg = pg.eval_on_selector('.pane-root:nth-child(1) .oc-sell', 'el => getComputedStyle(el).backgroundColor')
            buy_bg = pg.eval_on_selector('.pane-root:nth-child(1) .oc-buy', 'el => getComputedStyle(el).backgroundColor')
            check('SELL stays red in light mode', sell_bg == 'rgb(242, 54, 69)', sell_bg)
            check('BUY stays green in light mode', buy_bg == 'rgb(8, 153, 129)', buy_bg)
            pg.screenshot(path=os.path.join(ROOT, 'scripts', 'round109_light.png'),
                          clip={'x': 0, 'y': 0, 'width': 800, 'height': 450})
            pg.evaluate("() => window.__app.Theme.apply('dark')")
            pg.wait_for_timeout(300)
            check('panel returns to the dark token',
                  pg.eval_on_selector('.oc-panel', 'el => getComputedStyle(el).backgroundColor') == dark_bg)

            print('[10] page health')
            check('zero page/console errors', len(errors) == 0, errors[:3])

            b.close()
    finally:
        prov.terminate()

    print('')
    if FAILS:
        print(str(len(FAILS)) + ' CHECKS FAILED: ' + ' | '.join(FAILS))
        sys.exit(1)
    print('ALL ROUND109 REPRO CHECKS PASSED')

if __name__ == '__main__':
    main()
