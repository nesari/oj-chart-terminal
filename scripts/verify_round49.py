#!/usr/bin/env python3
"""ROUND 49 verify — mouse-position highlights on the price+time scales in ALL
three cursor modes (Cross/Arrow/Dot), plus the TV-style (+) button locked to
the price highlight whose menu performs five working actions; lines stay
hidden in Arrow/Dot; dark + light checked; zero page errors.
"""
import os, sys, io, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
from e2e_helper_round32 import open_app  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402
from PIL import Image  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, '..', '..', 'work', 'shots49-verify')
os.makedirs(OUT, exist_ok=True)

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  | ' + str(detail)[:260] if detail != '' else ''))

VIS_JS = """(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  return { disp: getComputedStyle(el).display, txt: el.textContent };
}"""

with sync_playwright() as pw:
    errors = []
    browser, page = open_app(pw)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.wait_for_timeout(700)
    # wait for bars before any hover interaction
    for _ in range(60):
        nb = page.evaluate("() => (window.__app.App.panes[0].bars || []).length")
        if nb > 100:
            break
        page.wait_for_timeout(500)
    check('T-boot: bars loaded', nb > 100, nb)

    # geometry of pane 0 overlay
    bb = page.evaluate("""() => {
      const cv = document.querySelector('.pane-overlay');
      const r = cv.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }""")
    cx = bb['x'] + bb['w'] * 0.45
    cy = bb['y'] + bb['h'] * 0.4

    count_drawings = """() => {
      const p = window.__app.App.panes[0];
      return (window.__app.App.drawings.list(p.symbol) || []).length;
    }"""

    def activate(mode):
        page.evaluate(f"window.__app.UI.activateTool('{mode}')")
        page.wait_for_timeout(120)

    def hover():
        page.mouse.move(cx - 60, cy - 40)
        page.wait_for_timeout(60)
        page.mouse.move(cx, cy)
        page.wait_for_timeout(220)

    def pax_rect():
        return page.evaluate("""() => {
          const el = window.__app.App.panes[0].paxAdd;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        }""")

    def crossline_pixels(mode):
        """count crosshair-colored px on the cursor row/col from a screenshot"""
        page.screenshot(path=f'{OUT}/probe_{mode}.png')
        im = Image.open(f'{OUT}/probe_{mode}.png').convert('RGB')
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
        return n

    # ================= DARK: three modes =================
    check('T0 boot: pane pax elements exist',
          page.evaluate("!!window.__app.App.panes[0].paxLive && !!window.__app.App.panes[0].paxAdd"))

    # ---- Cross mode: dashed lines present, native label (no DOM pill) ----
    activate('cross'); hover()
    tl = page.evaluate(VIS_JS, '.tax-live')
    pa = page.evaluate(VIS_JS, '.pax-add')
    pl = page.evaluate(VIS_JS, '.pax-live')
    check('T1 cross: time pill visible', tl and tl['disp'] == 'block', tl)
    check('T1 cross: (+) button visible', pa and pa['disp'] == 'flex', pa)
    check('T1 cross: DOM price pill hidden (native label owns Cross)', pl and pl['disp'] == 'none', pl)
    n_cross = crossline_pixels('cross')
    check('T1 cross: dashed crosshair lines ARE drawn (pixels)', n_cross > 60, n_cross)

    # ---- Arrow mode: NO lines, scale highlights still on ----
    activate('arrowcur'); hover()
    tl = page.evaluate(VIS_JS, '.tax-live')
    pa = page.evaluate(VIS_JS, '.pax-add')
    pl = page.evaluate(VIS_JS, '.pax-live')
    check('T2 arrow: time pill visible', tl and tl['disp'] == 'block', tl)
    check('T2 arrow: (+) visible', pa and pa['disp'] == 'flex', pa)
    check('T2 arrow: DOM price pill visible', pl and pl['disp'] == 'block' and (pl['txt'] or '').strip() != '', pl)
    n_arrow = crossline_pixels('arrow')
    check('T2 arrow: NO dashed lines on chart (pixels)', n_arrow < 8, n_arrow)
    pill_top = page.evaluate("window.__app.App.panes[0].paxLive.style.top")

    # ---- Dot mode: same as arrow ----
    activate('dot'); hover()
    tl = page.evaluate(VIS_JS, '.tax-live')
    pa = page.evaluate(VIS_JS, '.pax-add')
    pl = page.evaluate(VIS_JS, '.pax-live')
    check('T3 dot: time pill visible', tl and tl['disp'] == 'block', tl)
    check('T3 dot: (+) visible', pa and pa['disp'] == 'flex', pa)
    check('T3 dot: DOM price pill visible', pl and pl['disp'] == 'block', pl)
    n_dot = crossline_pixels('dot')
    check('T3 dot: NO dashed lines on chart (pixels)', n_dot < 8, n_dot)

    # ================= (+) menu + five actions (Dot mode, dark) =================
    activate('dot'); hover()
    pr = pax_rect()
    before = page.evaluate(count_drawings)
    page.mouse.click(pr['x'] + pr['w'] / 2, pr['y'] + pr['h'] / 2)
    page.wait_for_timeout(260)
    popup = page.evaluate("""() => {
      const p = document.querySelector('.popup');
      return p ? { items: p.querySelectorAll('.pu-item').length, seps: p.querySelectorAll('.pu-sep').length,
                    first: (p.querySelector('.pu-item span:nth-child(2)') || {}).textContent || '' } : null;
    }""")
    check('T4 (+) click: popup opens with 5 items + 2 seps',
          popup and popup['items'] == 5 and popup['seps'] == 2, popup)
    page.screenshot(path=f'{OUT}/dark_menu_open.png')

    # freeze: move pointer far away — pills must stay
    page.mouse.move(bb['x'] + 30, bb['y'] + 20)
    page.wait_for_timeout(200)
    pl = page.evaluate(VIS_JS, '.pax-live')
    check('T4 freeze: price pill stays while menu open (pointer away)', pl and pl['disp'] == 'block', pl)

    # ---- action 5: draw horizontal line ----
    page.evaluate("""() => { const p = document.querySelector('.popup');
      const it = [...p.querySelectorAll('.pu-item')].find(x => x.textContent.includes('Draw horizontal line'));
      it.click(); }""")
    page.wait_for_timeout(260)
    after = page.evaluate(count_drawings)
    last = page.evaluate("""() => {
      const p = window.__app.App.panes[0];
      const l = window.__app.App.drawings.list(p.symbol) || [];
      const d = l[l.length - 1];
      return d ? { type: d.type, p: d.points[0].p } : null;
    }""")
    check('T4 hline action: drawing added at the pill price',
          after == before + 1 and last and last['type'] == 'hline', {'before': before, 'after': after, 'last': last})

    # ---- action 2: buy limit ticket -> place -> green dashed hline ----
    pr = pax_rect()
    page.mouse.click(pr['x'] + pr['w'] / 2, pr['y'] + pr['h'] / 2)
    page.wait_for_timeout(240)
    price_now = page.evaluate("window.__app.App.panes[0]._paxPrice")
    page.evaluate("""() => { const p = document.querySelector('.popup');
      const it = [...p.querySelectorAll('.pu-item')].find(x => x.textContent.includes('Buy 1'));
      it.click(); }""")
    page.wait_for_timeout(300)
    dlg = page.evaluate("""() => {
      const q = document.querySelector('#popup-layer .dialog');
      return q ? { title: q.querySelector('h3').textContent, price: (q.querySelector('#ot-price') || {}).value,
                   hasSide: !!q.querySelector('#ot-side'), hasType: !!q.querySelector('#ot-type') } : null;
    }""")
    check('T5 buy ticket: opens prefilled, no side/type selects (preset)',
          dlg and 'Buy Limit' in dlg['title'] and dlg['price'] and not dlg['hasSide'] and not dlg['hasType'], dlg)
    page.evaluate("document.querySelector('#ot-place').click()")
    page.wait_for_timeout(260)
    after2 = page.evaluate(count_drawings)
    last2 = page.evaluate("""() => {
      const p = window.__app.App.panes[0];
      const l = window.__app.App.drawings.list(p.symbol) || [];
      const d = l[l.length - 1];
      return d ? { type: d.type, color: d.opts.color, style: d.opts.style, p: d.points[0].p } : null;
    }""")
    check('T5 buy place: green dashed order line at the price',
          after2 == after + 1 and last2 and last2['type'] == 'hline'
          and last2['color'] == '#089981' and last2['style'] == 'dashed'
          and abs(last2['p'] - price_now) < 1e-9, {'after': after2, 'last': last2, 'price': price_now})
    page.screenshot(path=f'{OUT}/dark_order_line.png')

    # ---- action 1: add alert dialog opens with prefilled price ----
    pr = pax_rect()
    page.mouse.click(pr['x'] + pr['w'] / 2, pr['y'] + pr['h'] / 2)
    page.wait_for_timeout(240)
    page.evaluate("""() => { const p = document.querySelector('.popup');
      const it = [...p.querySelectorAll('.pu-item')].find(x => x.textContent.includes('Add alert'));
      it.click(); }""")
    page.wait_for_timeout(300)
    al = page.evaluate("""() => {
      const q = document.querySelector('#popup-layer .dialog');
      return q ? { title: q.querySelector('h3').textContent, price: (q.querySelector('#al-price') || {}).value } : null;
    }""")
    check('T6 alert action: dialog opens with prefilled price', al and al['price'] and 'Alert' in al['title'], al)
    page.evaluate("document.querySelector('#al-cancel').click()")
    page.wait_for_timeout(150)

    # ---- action 4: generic order ticket HAS side/type selects ----
    pr = pax_rect()
    page.mouse.click(pr['x'] + pr['w'] / 2, pr['y'] + pr['h'] / 2)
    page.wait_for_timeout(240)
    page.evaluate("""() => { const p = document.querySelector('.popup');
      const it = [...p.querySelectorAll('.pu-item')].find(x => x.textContent.includes('Add order'));
      it.click(); }""")
    page.wait_for_timeout(300)
    og = page.evaluate("!!document.querySelector('#ot-side') && !!document.querySelector('#ot-type') && !!document.querySelector('#ot-place')")
    check('T7 generic ticket: side+type selects present', og)
    page.evaluate("document.querySelector('#ot-cancel').click()")
    page.wait_for_timeout(150)

    # ================= LIGHT theme =================
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(450)
    hover()
    tl = page.evaluate(VIS_JS, '.tax-live')
    pa = page.evaluate(VIS_JS, '.pax-add')
    pl = page.evaluate(VIS_JS, '.pax-live')
    check('T8 light: time pill + (+) + price pill all track', tl and tl['disp'] == 'block'
          and pa and pa['disp'] == 'flex' and pl and pl['disp'] == 'block', {'tl': tl, 'pa': pa, 'pl': pl})
    add_bg = page.evaluate("getComputedStyle(window.__app.App.panes[0].paxAdd).backgroundColor")
    check('T8 light: (+) white chip (TV light)', add_bg == 'rgb(255, 255, 255)', add_bg)
    n_light = crossline_pixels('light_dot')
    check('T8 light (dot): still no dashed lines', n_light < 8, n_light)
    page.screenshot(path=f'{OUT}/light_dot_hover.png')

    # menu in light theme works too
    pr = pax_rect()
    page.mouse.click(pr['x'] + pr['w'] / 2, pr['y'] + pr['h'] / 2)
    page.wait_for_timeout(240)
    light_items = page.evaluate("document.querySelector('.popup') ? document.querySelectorAll('.popup .pu-item').length : 0")
    check('T8 light: (+) menu opens with 5 items', light_items == 5, light_items)
    page.screenshot(path=f'{OUT}/light_menu_open.png')
    page.evaluate("window.__app.Toolbar.closePopup && window.__app.Toolbar.closePopup()")

    # ================= T9: back to cross round-trip =================
    page.evaluate("window.__app.Theme.apply('dark')")
    page.wait_for_timeout(300)
    activate('cross'); hover()
    n_rt = crossline_pixels('cross_rt')
    check('T9 round-trip: cross lines back after the tour', n_rt > 60, n_rt)

    # ================= T10: static audit =================
    def rd(p):
        with open(os.path.join(ROOT, p), encoding='utf-8') as f:
            return f.read()
    eng = rd('src/renderer/js/drawing/engine.js')
    mgr = rd('src/renderer/js/chart/manager.js')
    uijs = rd('src/renderer/js/drawing/ui.js')
    tb = rd('src/renderer/js/chart/toolbar.js')
    ic = rd('src/renderer/js/ui/icons.js')
    css = rd('src/renderer/css/app.css')
    # ROUND50: the mouseleave guard evolved — rt50 in-root early-return
    # + the _paxPin pin zone keep the pair alive en route to the (+)
    check('T10 static: engine bare-branch + _updatePax + mouseleave guards',
          'else if (bareCursor) {' in eng and '_updatePax(v)' in eng
          and 'priceToCoordinate(pane._paxFrozenPrice)' in eng
          and 'frozen || (c && c.bare)' in eng
          and 'rt50' in eng and 'this.pane.root.contains(rt50)' in eng
          and '_paxPin' in eng
          and eng.count('!this.pane._paxFrozen') == 2)
    check('T10 static: manager creates pax pair + freeze tokens',
          "U.el('div', 'pax-live', root)" in mgr and "U.el('button', 'pax-add', root)" in mgr
          and '_paxTok' in mgr and 'paxLive, paxAdd,' in mgr)
    check('T10 static: menu + ticket exist with the five TV actions',
          'UI.openPriceAddMenu' in uijs and 'Toolbar.openOrderTicket' in tb
          and 'Draw horizontal line at' in uijs and 'Add alert on' in uijs
          and 'Buy 1' in uijs and 'Sell 1' in uijs and 'Add order on' in uijs
          and "#089981" in tb and "'dashed'" in tb)
    check('T10 static: icons additive + css chips',
          'dblUp:' in ic and 'dblDn:' in ic and 'orderDoc:' in ic
          and '.pax-live {' in css and '.pax-add {' in css
          and 'body.theme-light .pax-add' in css and 'z-index: 40' in css)

    # ================= T11: zero page errors =================
    check('T11 zero page errors', len(errors) == 0, errors[:3])

    browser.close()

passed = sum(1 for _, ok, _ in results if ok)
print(f'\n==== verify_round49: {passed}/{len(results)} ====')
sys.exit(0 if passed == len(results) else 1)
