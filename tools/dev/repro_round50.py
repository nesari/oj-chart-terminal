#!/usr/bin/env python3
"""ROUND 50 repro — user report: in ALL three cursor modes the mouse cannot
reach the (+) button: 'everything disappears' on the way. Stepped approach
(real intermediate mousemoves) + a 1.5s DWELL on the button (several live
data-tick renders) + an axis-strip dwell, then a real click -> popup.
Run on the unpatched tree it must FAIL (bug reproduced); after the fix, green.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from e2e_helper_round32 import open_app  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)))
results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  | ' + str(detail)[:200] if detail != '' else ''))

VIS = """(sel) => { const el = document.querySelector(sel);
  return el ? getComputedStyle(el).display : 'missing'; }"""

with sync_playwright() as pw:
    browser, page = open_app(pw)
    page.wait_for_timeout(500)

    bb = page.evaluate("""() => { const r = document.querySelector('.pane-overlay').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; }""")
    cx, cy = bb['x'] + bb['w'] * 0.45, bb['y'] + bb['h'] * 0.4
    ax_x = bb['x'] + bb['w'] - 30          # inside the price-axis strip

    def btn_xy():
        r = page.evaluate("""() => { const r = window.__app.App.panes[0].paxAdd.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, ok: r.width > 0 }; }""")
        return r

    count_drawings = "() => (window.__app.App.drawings.list(window.__app.App.panes[0].symbol) || []).length"

    for mode in ('arrowcur', 'cross', 'dot'):
        page.evaluate(f"window.__app.UI.activateTool('{mode}')")
        page.wait_for_timeout(150)
        page.mouse.move(cx - 80, cy - 60); page.wait_for_timeout(60)
        page.mouse.move(cx, cy); page.wait_for_timeout(250)

        # --- path A: stepped approach onto the (+) button, then DWELL ---
        b = btn_xy()
        check(f'{mode}: (+) visible before approach', b['ok'] and page.evaluate(VIS, '.pax-add') == 'flex')
        page.mouse.move(b['x'], b['y'], steps=30)   # real intermediate mousemoves
        page.wait_for_timeout(1500)                 # >= several data-tick renders
        pa = page.evaluate(VIS, '.pax-add')
        pl = page.evaluate(VIS, '.pax-live')
        check(f'{mode}: (+) ALIVE after approach+dwell', pa == 'flex', f'pax-add={pa}')
        check(f'{mode}: pill ALIVE after approach+dwell', pl in ('flex', 'block'), f'pax-live={pl}')

        # --- path B: dwell on the price-axis strip itself ---
        y_row = b['y']
        page.mouse.move(ax_x, y_row, steps=12)
        page.wait_for_timeout(1200)
        pa2 = page.evaluate(VIS, '.pax-add')
        check(f'{mode}: (+) ALIVE on axis strip dwell', pa2 == 'flex', f'pax-add={pa2}')

        # --- click through: (+) -> popup -> Draw horizontal line ---
        b = btn_xy()
        page.mouse.move(b['x'], b['y'], steps=8)
        page.wait_for_timeout(200)
        page.mouse.click(b['x'], b['y'])
        page.wait_for_timeout(350)
        pop = page.evaluate("() => { const p = document.querySelector('.pu-item'); return p ? document.querySelectorAll('.pu-item').length : 0; }")
        check(f'{mode}: popup opened with items', pop >= 5, f'items={pop}')
        n0 = page.evaluate(count_drawings)
        if pop >= 5:
            page.evaluate("""() => { const its = document.querySelectorAll('.pu-item');
              its[its.length - 1].click(); }""")
            page.wait_for_timeout(300)
        n1 = page.evaluate(count_drawings)
        check(f'{mode}: hline menu item works', n1 == n0 + 1, f'{n0}->{n1}')
        page.keyboard.press('Escape'); page.wait_for_timeout(150)

    browser.close()

fails = [r for r in results if not r[1]]
print(f"\nREPRO RESULT: {len(results) - len(fails)}/{len(results)} green, {len(fails)} red")
sys.exit(1 if fails else 0)
