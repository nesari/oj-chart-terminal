#!/usr/bin/env python3
"""ROUND 51 verify — four scoped fixes:
1) price alerts on the chart: click = select (floating delete chip), drag =
   moves the level (persisted), chip click = delete from the chart
2) OS notification identity: "OJChart Notification" instead of the dev AUMID
3) default alert icon inside the toast
4) crosshair dash parity: painted vertical == native horzLine ([6,6])
5) pan zero-lag: highlights + crosshair visuals — REVERSED in ROUND53: they
   now FOLLOW the cursor mid-drag (time pill block, (+) flex, dashed lines
   present at the cursor) and never disappear during or after the gesture
Dark + light, zero page errors, round48 separators untouched."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from e2e_helper_round32 import open_app  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402
from PIL import Image  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
OUT = os.path.join(ROOT, '..', '..', 'work', 'shots51-verify')
os.makedirs(OUT, exist_ok=True)

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  | ' + str(detail)[:220] if detail != '' else ''))

VIS = """(sel) => { const el = document.querySelector(sel);
  return el ? getComputedStyle(el).display : 'missing'; }"""

def alert_count(page):
    return page.evaluate("() => JSON.parse(localStorage.getItem('mt5_alerts') || '[]').length")

def alert0(page):
    return page.evaluate("() => JSON.parse(localStorage.getItem('mt5_alerts') || '[]')[0] || null")

def runs_scan(im, fixed, lo, hi, vertical, tol=16):
    """run-length encode crosshair-colored pixels along a scanline"""
    px = im.load()
    seq = []
    for k in range(lo, hi):
        r, g, b = (px[fixed, k] if vertical else px[k, fixed])
        seq.append(abs(r - 117) < tol and abs(g - 134) < tol and abs(b - 150) < tol)
    if not seq:
        return []
    out, cur, n = [], seq[0], 1
    for s in seq[1:]:
        if s == cur:
            n += 1
        else:
            out.append((cur, n)); cur, n = s, 1
    out.append((cur, n))
    return out

def dash_stats(rl):
    on = [n for s, n in rl if s and n >= 2]
    off = [n for s, n in rl if not s and n >= 2]
    avg = lambda a: (sum(a) / len(a)) if a else -1
    return avg(on), avg(off), len(on)

# ---------- static: notification identity + icon ----------
main_src = open(os.path.join(ROOT, 'main.js'), encoding='utf-8').read()
check('static: AUMID set to OJChart Notification', "app.setAppUserModelId('OJChart Notification')" in main_src)
check('static: app.setName OJChart Notification', "app.setName('OJChart Notification')" in main_src)
check('static: notify passes icon', 'icon: ALERT_ICON' in main_src and "assets', 'alert-icon.png" in main_src)
ic = os.path.join(ROOT, 'assets', 'alert-icon.png')
ok_icon = False
if os.path.exists(ic):
    im = Image.open(ic); ok_icon = (im.size == (256, 256) and im.mode == 'RGBA')
check('static: alert icon 256x256 PNG', ok_icon, Image.open(ic).size if os.path.exists(ic) else 'missing')
pkg = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))
check('static: version >= 1.9.2 (test pin updated r53)', pkg.get('version') in ('1.9.2', '1.9.3', '1.9.4', '1.9.5', '1.9.6', '1.9.7', '1.9.8', '1.9.9', '1.9.10', '1.9.11', '1.9.12'), pkg.get('version'))

with sync_playwright() as pw:
    errors = []
    browser, page = open_app(pw)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.wait_for_timeout(500)

    page.evaluate("window.__app.Theme.apply('dark')")
    page.wait_for_timeout(200)
    sep = page.evaluate("getComputedStyle(document.querySelector('#top-toolbar')).borderBottomWidth")
    sepc = page.evaluate("getComputedStyle(document.querySelector('#top-toolbar')).borderBottomColor")
    check('dark: round48 separator still 5px #2e2e2e', sep == '5px' and sepc == 'rgb(46, 46, 46)', f'{sep} {sepc}')

    bb = page.evaluate("""() => { const r = document.querySelector('.pane-overlay').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; }""")
    cx, cy = int(bb['x'] + bb['w'] * 0.45), int(bb['y'] + bb['h'] * 0.4)
    right_px = int(bb['x'] + bb['w'])

    page.evaluate("() => { try { localStorage.removeItem('mt5_alerts'); } catch (e) {} }")
    page.evaluate("() => { if (window.__app.Alerts) { window.__app.Alerts.list = []; window.__app.Alerts.selected = null; } }")
    page.evaluate("() => { const p = window.__app.App.panes[0]; if (window.__app.Manager.applyPriceLines) window.__app.Manager.applyPriceLines(p); }")
    page.wait_for_timeout(200)

    # ================= T2: alert add via (+) -> select -> drag -> delete =================
    page.evaluate("window.__app.UI.activateTool('arrowcur')")
    page.wait_for_timeout(150)
    page.mouse.move(cx, cy, steps=6)
    page.wait_for_timeout(250)
    b = page.evaluate("""() => { const r = window.__app.App.panes[0].paxAdd.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }""")
    page.mouse.move(b['x'], b['y'], steps=10)
    page.wait_for_timeout(300)
    page.mouse.click(b['x'], b['y'])
    page.wait_for_timeout(350)
    pop = page.evaluate("() => document.querySelectorAll('.pu-item').length")
    check('alert: (+) popup opened', pop >= 5, pop)
    if pop >= 5:
        page.evaluate("() => { const its = document.querySelectorAll('.pu-item'); its[0].click(); }")  # Add alert
        page.wait_for_timeout(350)
        val = page.evaluate("() => { const el = document.querySelector('#al-price'); return el ? el.value : null; }")
        check('alert: dialog prefilled with price', val is not None and val != '', val)
        page.evaluate("() => { const el = document.querySelector('#al-create'); if (el) el.click(); }")
        page.wait_for_timeout(350)
    n = alert_count(page)
    check('alert: created via (+) flow', n == 1, n)
    a0 = alert0(page)
    y0 = page.evaluate(f"() => {{ const p = window.__app.App.panes[0]; let y = null; try {{ y = p.series.priceToCoordinate({a0['price']}); }} catch (e) {{}} return y; }}")
    y0 = int(y0) if y0 is not None else -1
    check('alert: level maps onto the plot', 0 < y0 < bb['h'], y0)
    ay0 = bb['y'] + y0  # priceToCoordinate is pane-local; mouse is viewport-absolute

    # click on the line -> select + chip
    page.mouse.click(cx, ay0)
    page.wait_for_timeout(350)
    chipd = page.evaluate(VIS, '.alert-del')
    check('alert: click selects — delete chip visible', chipd == 'flex', chipd)
    chip = page.evaluate("""() => { const r = document.querySelector('.alert-del').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }""")
    chip_cy = chip['y'] + chip['h'] / 2
    check('alert: chip rides the selected line', abs(chip_cy - ay0) <= 4, f'{chip_cy:.0f} vs {ay0}')
    page.screenshot(path=f'{OUT}/alert_selected.png')

    # drag the line down 70px -> price follows
    page.mouse.move(cx, ay0, steps=4)
    page.mouse.down()
    page.mouse.move(cx, ay0 + 70, steps=10)
    page.mouse.up()
    page.wait_for_timeout(400)
    a1 = alert0(page)
    y1 = page.evaluate(f"() => {{ const p = window.__app.App.panes[0]; let y = null; try {{ y = p.series.priceToCoordinate({a1['price']}); }} catch (e) {{}} return y; }}")
    y1 = int(y1) if y1 is not None else -1
    ay1 = bb['y'] + y1
    check('alert: drag moves the level ~70px', abs((y1 - y0) - 70) <= 6, f'{y0} -> {y1}')
    check('alert: drag persisted to storage', abs(a1['price'] - a0['price']) > 1e-9, f"{a0['price']} -> {a1['price']}")
    chipd = page.evaluate(VIS, '.alert-del')
    chip2 = page.evaluate("""() => { const r = document.querySelector('.alert-del').getBoundingClientRect(); return r.y + r.height / 2; }""")
    check('alert: chip still rides after drag', chipd == 'flex' and abs(chip2 - ay1) <= 4, f'{chip2:.0f} vs {ay1}')

    # click-away deselects
    page.mouse.click(cx, max(int(bb['y']) + 20, ay1 - 160))
    page.wait_for_timeout(350)
    chipd = page.evaluate(VIS, '.alert-del')
    check('alert: click-away deselects (chip hides)', chipd == 'none', chipd)

    # re-select, delete from the chart via the chip
    page.mouse.click(cx, ay1)
    page.wait_for_timeout(300)
    chipd = page.evaluate(VIS, '.alert-del')
    check('alert: re-select shows chip', chipd == 'flex', chipd)
    chip = page.evaluate("""() => { const r = document.querySelector('.alert-del').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }""")
    page.mouse.click(chip['x'], chip['y'])
    page.wait_for_timeout(400)
    check('alert: chip click deletes from chart', alert_count(page) == 0, alert_count(page))
    chipd = page.evaluate(VIS, '.alert-del')
    check('alert: chip hides after delete', chipd == 'none', chipd)

    # ================= T3: dash parity (cross mode, pixels) =================
    page.evaluate("window.__app.UI.activateTool('cross')")
    page.wait_for_timeout(200)
    page.mouse.move(cx, cy, steps=6)
    page.wait_for_timeout(400)
    page.screenshot(path=f'{OUT}/dash_cross.png')
    im = Image.open(f'{OUT}/dash_cross.png').convert('RGB')
    h_runs = runs_scan(im, cy, cx - 190, cx - 8, vertical=False) + runs_scan(im, cy, cx + 8, cx + 190, vertical=False)
    v_runs = runs_scan(im, cx, cy - 120, cy - 8, vertical=True) + runs_scan(im, cx, cy + 8, cy + 120, vertical=True)
    hon, hoff, hn = dash_stats(h_runs)
    von, voff, vn = dash_stats(v_runs)
    check('dash: both lines present', hn > 8 and vn > 8, f'h_on_runs={hn} v_on_runs={vn}')
    check('dash: vertical == horizontal pattern', abs(hon - von) <= 1.5 and abs(hoff - voff) <= 1.5,
          f'on h={hon:.2f} v={von:.2f} | off h={hoff:.2f} v={voff:.2f}')
    check('dash: pattern is ~[6,6] (largedashed)', abs(hon - 6) <= 1.5 and abs(hoff - 6) <= 1.5, f'{hon:.2f}/{hoff:.2f}')

    # ================= T4: pan zero-lag =================
    # clean slate: no alert lines under the drag path
    page.evaluate("() => { try { localStorage.removeItem('mt5_alerts'); } catch (e) {} if (window.__app.Alerts) { window.__app.Alerts.list = []; window.__app.Alerts.selected = null; } const p = window.__app.App.panes[0]; window.__app.Manager.applyPriceLines(p); }")
    page.wait_for_timeout(250)
    page.screenshot(path=f'{OUT}/pan_before.png')
    im0 = Image.open(f'{OUT}/pan_before.png').convert('RGB')
    pre_h = sum(n for s, n in runs_scan(im0, cy, cx - 190, cx + 190, vertical=False) if s)
    pre_v = sum(n for s, n in runs_scan(im0, cx, cy - 120, cy + 120, vertical=True) if s)
    check('pan: crosshair present before drag', pre_h > 60 and pre_v > 60, f'h={pre_h} v={pre_v}')
    page.mouse.move(cx, cy, steps=4)
    page.mouse.down()
    page.mouse.move(cx - 140, cy, steps=8)
    page.wait_for_timeout(150)
    tl = page.evaluate(VIS, '.tax-live')
    pa = page.evaluate(VIS, '.pax-add')
    pl = page.evaluate(VIS, '.pax-live')
    check('pan: pills FOLLOW mid-drag (r53: time pill + (+) stay alive; the DOM price pill stays cross-hidden — the native horzLine label plays that role)', tl == 'block' and pa == 'flex' and pl == 'none', f'{tl}/{pa}/{pl}')
    page.screenshot(path=f'{OUT}/pan_mid.png')
    im2 = Image.open(f'{OUT}/pan_mid.png').convert('RGB')
    row = runs_scan(im2, cy, cx - 320, cx + 320, vertical=False)
    col = runs_scan(im2, cx - 140, max(0, cy - 140), cy + 140, vertical=True)  # line rides the dragged cursor x
    non_h = sum(n for s, n in row if s)
    non_v = sum(n for s, n in col if s)
    check('pan: crosshair lines STILL mid-drag (r53: dashed lines follow the cursor)', non_h > 60 and non_v > 60, f'h_px={non_h} v_px={non_v}')
    page.mouse.up()
    page.wait_for_timeout(250)
    page.mouse.move(cx, cy, steps=5)
    page.wait_for_timeout(400)
    page.screenshot(path=f'{OUT}/pan_after.png')
    im3 = Image.open(f'{OUT}/pan_after.png').convert('RGB')
    row2 = runs_scan(im3, cy, cx - 190, cx + 190, vertical=False)
    col2 = runs_scan(im3, cx, cy - 120, cy + 120, vertical=True)
    back_h = sum(n for s, n in row2 if s)
    back_v = sum(n for s, n in col2 if s)
    check('pan: crosshair fully back after gesture', back_h > 60 and back_v > 60, f'h_px={back_h} v_px={back_v}')
    tla = page.evaluate(VIS, '.tax-live')
    check('pan: time pill back after gesture', tla == 'block', tla)

    # ================= T5: light theme quick pass =================
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(250)
    sep = page.evaluate("getComputedStyle(document.querySelector('#top-toolbar')).borderBottomWidth")
    sepc = page.evaluate("getComputedStyle(document.querySelector('#top-toolbar')).borderBottomColor")
    check('light: round48 separator still 2px #ccd0da', sep == '2px' and sepc == 'rgb(204, 208, 218)', f'{sep} {sepc}')
    # alert select in light: chip white variant
    page.evaluate(f"() => {{ window.__app.Alerts.create(window.__app.App.panes[0].symbol, 'Greater Than', {a0['price']}); }}")
    page.wait_for_timeout(300)
    yl = page.evaluate(f"() => {{ const p = window.__app.App.panes[0]; let y = null; try {{ y = p.series.priceToCoordinate({a0['price']}); }} catch (e) {{}} return y; }}")
    # the alert line spans the full width; a T1 drawing may sit under ONE x —
    # try a few (drawing hits take precedence by design) — r55 test-side fix
    for tx in (cx, cx - 220, cx + 220, cx - 110):
        page.mouse.click(tx, int(bb['y'] + yl))
        page.wait_for_timeout(350)
        chipd = page.evaluate(VIS, '.alert-del')
        if chipd == 'flex':
            break
    chipbg = page.evaluate("() => getComputedStyle(document.querySelector('.alert-del')).backgroundColor")
    check('light: chip visible + white variant', chipd == 'flex' and chipbg == 'rgb(255, 255, 255)', f'{chipd} {chipbg}')
    page.screenshot(path=f'{OUT}/light_alert_chip.png')
    chip = page.evaluate("""() => { const r = document.querySelector('.alert-del').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }""")
    page.mouse.click(chip['x'], chip['y'])
    page.wait_for_timeout(300)
    check('light: chip delete works', alert_count(page) == 0, alert_count(page))

    check('zero page errors', len(errors) == 0, errors[:3])
    browser.close()

fails = [r for r in results if not r[1]]
print(f"\nVERIFY ROUND51: {len(results) - len(fails)}/{len(results)} green, {len(fails)} red")
sys.exit(1 if fails else 0)
