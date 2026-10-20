#!/usr/bin/env python3
"""ROUND110 repro — manual volume entry in the One-Click widget, on the REAL app.

User ask: "عالیه . فقط توی بخش انتخاب حجم باید کاربر بتونه بصورت دستی هم عدد
وارد کنه . اینو هم سریع برام درست کن"

Boots the demo broker + the real renderer in headless chromium and proves:
  [1] the volume cell is a real editable field showing the spec-formatted lot
  [2] typing "0.37" + Enter commits it (field + mt5_oct_vol)
  [3] decimal comma "0,25" works
  [4] an invalid draft ("abc") silently reverts, storing nothing
  [5] an out-of-range draft clamps to the symbol spec (vol_max / vol_step)
  [6] ArrowUp / ArrowDown step by vol_step
  [7] a REAL order is sent at the typed lot (0.37) through the confirm gate
  [8] the preset menu: opens via the chevron, picks a lot, closes on outside
      press; the current lot is highlighted
  [9] MULTI-CHART: typing in pane 1 syncs pane 2's field at its own spec
 [10] light + dark themes dress the field and the menu correctly
 [11] zero page/console errors

Exits 0 only if every check passes.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket, re

ROOT = '/home/z/my-project/upload/mt5-terminal-extracted'
PORT_HTTP, PORT_WS = 8914, 8777  # 8777 = the demo provider's fixed WS port
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

def set_vol(pg, sel, txt, commit='Enter'):
    """focus the field, replace the whole value, commit like a user would"""
    pg.click(sel)
    pg.fill(sel, txt)
    pg.keyboard.press(commit)
    pg.wait_for_timeout(160)

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

            print('[1] the volume cell is an editable field')
            tag = pg.eval_on_selector('.pane-root .oc-vol', 'el => el.tagName')
            check('volume cell is an INPUT (was a read-only select)', tag == 'INPUT', tag)
            step = float(pg.evaluate(f"() => window.__app.Trade.specSync('{sym}').vol_step || 0.01"))
            dp = 3 if (step > 0 and step < 0.01) else 2
            v0 = pg.eval_on_selector('.pane-root .oc-vol', 'el => el.value')
            check(f'field shows the spec-formatted current lot ({v0})',
                  re.match('^\\d+\\.\\d{%d,%d}$' % (dp, dp), v0) is not None, v0)
            vmax = pg.evaluate(f"() => window.__app.Trade.specSync('{sym}').vol_max || 100")

            print('[2] type a manual lot — "0.37" + Enter')
            set_vol(pg, '.pane-root .oc-vol', '0.37')
            check('field commits 0.37',
                  pg.eval_on_selector('.pane-root .oc-vol', 'el => el.value') == '0.37',
                  pg.eval_on_selector('.pane-root .oc-vol', 'el => el.value'))
            stored = pg.evaluate("() => parseFloat(window.localStorage.getItem('mt5_oct_vol'))")
            check(f'persisted (mt5_oct_vol = {stored})', abs(stored - 0.37) < 1e-9, stored)

            print('[3] decimal comma — "0,25"')
            set_vol(pg, '.pane-root .oc-vol', '0,25')
            check('comma form commits 0.25',
                  pg.eval_on_selector('.pane-root .oc-vol', 'el => el.value') == '0.25')

            print('[4] invalid draft reverts, stores nothing')
            set_vol(pg, '.pane-root .oc-vol', 'abc')
            check('"abc" reverted to the stored 0.25',
                  pg.eval_on_selector('.pane-root .oc-vol', 'el => el.value') == '0.25',
                  pg.eval_on_selector('.pane-root .oc-vol', 'el => el.value'))
            stored2 = pg.evaluate("() => parseFloat(window.localStorage.getItem('mt5_oct_vol'))")
            check('nothing invalid was persisted', abs(stored2 - 0.25) < 1e-9, stored2)

            print('[5] out-of-range draft clamps to the spec')
            set_vol(pg, '.pane-root .oc-vol', '9999')
            expect = pg.evaluate(f"() => {{ const v = window.__app.Trade.clampVolume('{sym}', 9999); const s = window.__app.Trade.specSync('{sym}'); const dp = (s && s.vol_step > 0 && s.vol_step < 0.01) ? 3 : 2; return v.toFixed(dp); }}")
            got = pg.eval_on_selector('.pane-root .oc-vol', 'el => el.value')
            check(f'9999 clamps to vol_max ({expect}, step {step})', got == expect, got)

            print('[6] ArrowUp / ArrowDown step by vol_step')
            set_vol(pg, '.pane-root .oc-vol', '0.10')
            pg.click('.pane-root .oc-vol')
            pg.keyboard.press('ArrowUp'); pg.wait_for_timeout(160)
            up = pg.eval_on_selector('.pane-root .oc-vol', 'el => el.value')
            check(f'ArrowUp: 0.10 → {up}', abs(float(up) - (0.10 + step)) < 1e-9, up)
            pg.keyboard.press('ArrowDown'); pg.wait_for_timeout(160)
            dn = pg.eval_on_selector('.pane-root .oc-vol', 'el => el.value')
            check(f'ArrowDown: {up} → {dn}', abs(float(dn) - 0.10) < 1e-9, dn)
            pg.keyboard.press('Escape')   # leave the field clean
            pg.wait_for_timeout(120)

            print('[7] a REAL order at the typed lot (0.37) through the confirm gate')
            set_vol(pg, '.pane-root .oc-vol', '0.37')
            n0 = pg.evaluate("() => window.__app.Trade.positions.length")
            pg.click('.pane-root .oc-buy'); pg.wait_for_timeout(150)
            pg.click('.pane-root .oc-buy')
            try:
                pg.wait_for_function(f"() => window.__app.Trade.positions.length > {n0}", timeout=9000)
                ok = True
            except Exception:
                ok = False
            check('position opened', ok)
            if ok:
                pv = pg.evaluate(f"() => window.__app.Trade.positions[window.__app.Trade.positions.length - 1].volume")
                check(f'position volume == typed 0.37 (got {pv})', abs(pv - 0.37) < 1e-6, pv)

            print('[8] the preset menu — chevron opens, pick, outside closes, current highlighted')
            pg.click('.pane-root .oc-vol-dd')
            pg.wait_for_timeout(150)
            check('menu opens', pg.evaluate("() => { const m = document.querySelector('.pane-root .oc-vol-menu'); return m && !m.classList.contains('oc-hidden'); }"))
            n_items = pg.evaluate("() => document.querySelectorAll('.pane-root .oc-vol-it').length")
            check(f'preset items rendered ({n_items})', n_items >= 13, n_items)
            cur_it = pg.evaluate("() => {{ const b = document.querySelector('.pane-root .oc-vol-it.oc-cur'); return b ? b.dataset.v : ''; }}")
            check(f'current lot highlighted (data-v={cur_it})', cur_it == '0.37', cur_it)
            pg.click(".pane-root .oc-vol-it[data-v='0.05']")
            pg.wait_for_timeout(160)
            check('picking 0.05 commits it to the field',
                  pg.eval_on_selector('.pane-root .oc-vol', 'el => el.value') == '0.05')
            check('menu closed after the pick', pg.evaluate("() => document.querySelector('.pane-root .oc-vol-menu').classList.contains('oc-hidden')"))
            pg.click('.pane-root .oc-vol-dd'); pg.wait_for_timeout(120)
            pg.mouse.click(900, 650); pg.wait_for_timeout(160)   # a press on the chart body
            check('outside press closes the menu', pg.evaluate("() => document.querySelector('.pane-root .oc-vol-menu').classList.contains('oc-hidden')"))

            print('[9] MULTI-CHART — typing in pane 1 syncs pane 2 at its own spec')
            pg.evaluate("() => window.__app.Manager.setLayout('2v')")
            pg.wait_for_selector('.pane-root:nth-child(2) .oc-panel', timeout=10000)
            sym2 = pg.evaluate("() => window.__app.App.panes[1].symbol")
            pg.wait_for_function(f"() => !!window.__app.Trade.specSync('{sym2}')", timeout=10000)
            pg.wait_for_timeout(900)
            set_vol(pg, '.pane-root:nth-child(1) .oc-vol', '0.33')
            v2 = pg.eval_on_selector('.pane-root:nth-child(2) .oc-vol', 'el => el.value')
            v2_expect = pg.evaluate(f"() => {{ const v = window.__app.Trade.clampVolume('{sym2}', 0.33); const s = window.__app.Trade.specSync('{sym2}'); const dp = (s && s.vol_step > 0 && s.vol_step < 0.01) ? 3 : 2; return v.toFixed(dp); }}")
            check(f'pane 2 field follows ({v2_expect})', v2 == v2_expect, v2)

            print('[10] themes — light and dark dress field + menu')
            def bg(sel):
                return pg.eval_on_selector(sel, 'el => getComputedStyle(el).backgroundColor')
            field_dark, menu_dark = bg('.pane-root:nth-child(1) .oc-vol'), bg('.pane-root:nth-child(1) .oc-vol-menu')
            pg.evaluate("() => window.__app.Theme.apply('light')")
            pg.wait_for_timeout(350)
            field_light, menu_light = bg('.pane-root:nth-child(1) .oc-vol'), bg('.pane-root:nth-child(1) .oc-vol-menu')
            check(f'field surface flips in light mode ({field_dark} → {field_light})', field_dark != field_light)
            check(f'menu surface flips in light mode ({menu_dark} → {menu_light})', menu_dark != menu_light)
            pg.click('.pane-root:nth-child(1) .oc-vol-dd'); pg.wait_for_timeout(150)
            pg.screenshot(path=os.path.join(ROOT, 'scripts', 'round110_light.png'),
                          clip={'x': 0, 'y': 0, 'width': 800, 'height': 450})
            pg.keyboard.press('Escape'); pg.wait_for_timeout(120)
            pg.evaluate("() => window.__app.Theme.apply('dark')")
            pg.wait_for_timeout(300)
            check('field returns to the dark token', bg('.pane-root:nth-child(1) .oc-vol') == field_dark)

            print('[11] page health')
            check('zero page/console errors', len(errors) == 0, errors[:3])

            b.close()
    finally:
        prov.terminate()

    print('')
    if FAILS:
        print(str(len(FAILS)) + ' CHECKS FAILED: ' + ' | '.join(FAILS))
        sys.exit(1)
    print('ALL ROUND110 REPRO CHECKS PASSED')

if __name__ == '__main__':
    main()
