#!/usr/bin/env python3
"""ROUND 50 verify — user report: in ALL three cursor modes the mouse could
not reach the (+) button ('everything disappears' on the way). The fix pins
the price pill + (+) while the pointer is in the (+) zone (price-scale strip
or the button itself) and keeps hover state alive for pane-root moves.
Checks: stepped approach + dwell (survives data-tick renders), axis-strip
dwell, popup opens, menu item works, drag-then-approach, true-leave still
hides, mode rules (lines only in Cross) — dark + light, zero page errors,
round48 separators untouched."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from e2e_helper_round32 import open_app  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402
from PIL import Image  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, '..', '..', 'work', 'shots50-verify')
os.makedirs(OUT, exist_ok=True)

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  | ' + str(detail)[:220] if detail != '' else ''))

VIS = """(sel) => { const el = document.querySelector(sel);
  return el ? getComputedStyle(el).display : 'missing'; }"""

count_drawings = "() => (window.__app.App.drawings.list(window.__app.App.panes[0].symbol) || []).length"

def run_mode(page, mode, cx, cy, tag, probe=False, out=OUT):
    """full (+) reachability flow in one cursor mode; returns checks"""
    page.evaluate(f"window.__app.UI.activateTool('{mode}')")
    page.wait_for_timeout(150)
    page.mouse.move(cx - 80, cy - 60); page.wait_for_timeout(60)
    page.mouse.move(cx, cy); page.wait_for_timeout(250)

    tl = page.evaluate(VIS, '.tax-live')
    check(f'{tag} {mode}: time pill visible on plot', tl == 'block', tl)
    pa = page.evaluate(VIS, '.pax-add')
    check(f'{tag} {mode}: (+) visible on plot', pa == 'flex', pa)
    pl = page.evaluate(VIS, '.pax-live')
    want_pill = 'block' if mode != 'cross' else 'none'   # r49 rule: Cross keeps native label over the plot
    check(f'{tag} {mode}: DOM pill rule over plot', pl == want_pill, pl)

    if probe:
        page.screenshot(path=f'{out}/probe_{tag}_{mode}.png')
        im = Image.open(f'{out}/probe_{tag}_{mode}.png').convert('RGB')
        px = im.load()
        n = 0
        lx, ly = int(cx), int(cy)
        for dx in range(-260, 261):
            for ddy in (-1, 0, 1):
                r, g, b = px[lx + dx, ly + ddy]
                if abs(r - 117) < 14 and abs(g - 134) < 14 and abs(b - 150) < 14: n += 1
        for dy in range(-160, 161):
            for ddx in (-1, 0, 1):
                r, g, b = px[lx + ddx, ly + dy]
                if abs(r - 117) < 14 and abs(g - 134) < 14 and abs(b - 150) < 14: n += 1
        want = n > 60 if mode == 'cross' else n < 8
        check(f'{tag} {mode}: dashed lines only in Cross (pixels)', want, n)

    # --- stepped approach onto the (+) + DWELL through data-tick renders ---
    b = page.evaluate("""() => { const r = window.__app.App.panes[0].paxAdd.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }""")
    page.mouse.move(b['x'], b['y'], steps=30)   # real intermediate mousemoves
    page.wait_for_timeout(1500)
    pa = page.evaluate(VIS, '.pax-add')
    check(f'{tag} {mode}: (+) ALIVE after approach+dwell', pa == 'flex', pa)
    pl = page.evaluate(VIS, '.pax-live')
    check(f'{tag} {mode}: pill ALIVE after approach+dwell', pl == 'block', pl)
    tl = page.evaluate(VIS, '.tax-live')
    check(f'{tag} {mode}: time pill ALIVE after approach+dwell', tl == 'block', tl)

    # --- dwell on the price-axis strip itself ---
    ax_x = page.evaluate("""() => { const r = document.querySelector('.pane-overlay').getBoundingClientRect();
      const p = window.__app.App.panes[0]; const w = r.width;
      let axw = 62; try { axw = p.chart.priceScale('right').width() || 62; } catch (e) {}
      return r.x + w - axw / 2; }""")
    page.mouse.move(ax_x, b['y'], steps=12)
    page.wait_for_timeout(1200)
    pa = page.evaluate(VIS, '.pax-add')
    check(f'{tag} {mode}: (+) ALIVE on axis-strip dwell', pa == 'flex', pa)

    # --- click through: (+) -> popup -> Draw horizontal line ---
    b = page.evaluate("""() => { const r = window.__app.App.panes[0].paxAdd.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }""")
    page.mouse.move(b['x'], b['y'], steps=8)
    page.wait_for_timeout(200)
    page.mouse.click(b['x'], b['y'])
    page.wait_for_timeout(350)
    pop = page.evaluate("() => document.querySelectorAll('.pu-item').length")
    check(f'{tag} {mode}: popup opened with 5 items', pop >= 5, pop)
    if tag == 'dark' and mode == 'arrowcur':
        page.screenshot(path=f'{OUT}/{tag}_{mode}_menu.png')
    n0 = page.evaluate(count_drawings)
    if pop >= 5:
        page.evaluate("""() => { const its = document.querySelectorAll('.pu-item');
          its[its.length - 1].click(); }""")
        page.wait_for_timeout(300)
    n1 = page.evaluate(count_drawings)
    check(f'{tag} {mode}: hline menu item works', n1 == n0 + 1, f'{n0}->{n1}')

    # --- drag toward (+), release, then normal approach must still work ---
    page.mouse.move(cx, cy, steps=6); page.wait_for_timeout(150)
    page.mouse.down(); page.mouse.move(cx + 40, cy + 20, steps=6); page.mouse.up()
    page.wait_for_timeout(250)
    b = page.evaluate("""() => { const r = window.__app.App.panes[0].paxAdd.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, ok: r.width > 0 }; }""")
    if b['ok']:
        page.mouse.move(b['x'], b['y'], steps=20)
        page.wait_for_timeout(900)
        page.mouse.click(b['x'], b['y'])
        page.wait_for_timeout(300)
        pop2 = page.evaluate("() => document.querySelectorAll('.pu-item').length")
        check(f'{tag} {mode}: (+) clickable after drag+approach', pop2 >= 5, pop2)
        if pop2 >= 5:
            page.evaluate("() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); }")
            page.wait_for_timeout(250)
    else:
        check(f'{tag} {mode}: (+) clickable after drag+approach', False, 'button gone')

    # --- true leave (outside pane root) still hides the pair ---
    page.mouse.move(12, 450, steps=4)   # over the left toolbar, outside pane root
    page.wait_for_timeout(1200)
    pa = page.evaluate(VIS, '.pax-add')
    check(f'{tag} {mode}: true leave still hides (+)', pa == 'none', pa)

with sync_playwright() as pw:
    errors = []
    browser, page = open_app(pw)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.wait_for_timeout(500)

    bb = page.evaluate("""() => { const r = document.querySelector('.pane-overlay').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; }""")
    cx, cy = bb['x'] + bb['w'] * 0.45, bb['y'] + bb['h'] * 0.4

    # ---- DARK: all three modes, full flow ----
    page.evaluate("window.__app.__theme && window.__app.Theme ? window.__app.Theme.apply('dark') : null")
    page.wait_for_timeout(200)
    sep = page.evaluate("getComputedStyle(document.querySelector('#top-toolbar')).borderBottomWidth")
    sepc = page.evaluate("getComputedStyle(document.querySelector('#top-toolbar')).borderBottomColor")
    check('dark: round48 separator still 5px #2e2e2e', sep == '5px' and sepc == 'rgb(46, 46, 46)', f'{sep} {sepc}')

    for mode in ('arrowcur', 'cross', 'dot'):
        run_mode(page, mode, cx, cy, 'dark', probe=(mode == 'cross' or mode == 'arrowcur'))

    # ---- LIGHT: all three modes, full flow ----
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(250)
    sep = page.evaluate("getComputedStyle(document.querySelector('#top-toolbar')).borderBottomWidth")
    sepc = page.evaluate("getComputedStyle(document.querySelector('#top-toolbar')).borderBottomColor")
    check('light: round48 separator still 2px #ccd0da', sep == '2px' and sepc == 'rgb(204, 208, 218)', f'{sep} {sepc}')
    addbg = page.evaluate("getComputedStyle(window.__app.App.panes[0].paxAdd).backgroundColor")
    check('light: (+) white chip style', addbg == 'rgb(255, 255, 255)', addbg)

    for mode in ('arrowcur', 'cross', 'dot'):
        run_mode(page, mode, cx, cy, 'light', probe=False)

    page.screenshot(path=f'{OUT}/light_arrow_pair.png')

    check('zero page errors', len(errors) == 0, errors[:3])
    browser.close()

fails = [r for r in results if not r[1]]
print(f"\nVERIFY ROUND50: {len(results) - len(fails)}/{len(results)} green, {len(fails)} red")
sys.exit(1 if fails else 0)
