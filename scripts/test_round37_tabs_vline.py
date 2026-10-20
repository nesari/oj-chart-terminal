"""Round 37 E2E suite (self-bootstrapping, same pattern as round32-36).

User reports fixed here:
  Report 1  "symbol search used to be split into TABS exactly like
            TradingView — look at the category section — you deleted it,
            bring it back" — the Symbol Search dialog gets the TV-style
            pill-tab row (All / Forex / Metals / Energies / Indices /
            Crypto / Stocks) under the search input:
              - All keeps the round-36 grouped view + exact footer count
              - a category tab filters the list to that asset class
                (flat rows, exact per-category count, no refetch)
              - a typed query keeps respecting the active tab
              - case-insensitivity (round 35/36) untouched
  Report 2  "a vertical line drawn on the chart must also come down
            through the indicator window, fully to the bottom, exactly
            like the mouse cross" — vline now clips to the FULL pane
            stack (v.ph) instead of the price pane only (v.mainH);
            verified by overlay pixel probes above AND below the
            price/RSI boundary, plus a removed-drawing control probe.
"""
import os, subprocess, sys, time
subprocess.run(['pkill', '-f', 'provider/demo.py'], capture_output=True)
subprocess.run(['pkill', '-f', 'demo_mt5sim.py'], capture_output=True)
time.sleep(0.8)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_helper_round32 as H
from playwright.sync_api import sync_playwright

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts', 'shots37')
os.makedirs(OUT, exist_ok=True)
PASS, FAIL = [], []

def check(name, cond, extra=''):
    (PASS if cond else FAIL).append(f'{name} {extra}')
    print(('PASS' if cond else 'FAIL'), name, extra)

EXPECT_TABS = ['All', 'Forex', 'Metals', 'Energies', 'Indices', 'Crypto', 'Stocks']
# demo catalog classification (provider/demo.py, 33 symbols)
CAT_COUNTS = {'Forex': 12, 'Metals': 2, 'Energies': 3, 'Indices': 7, 'Crypto': 2, 'Stocks': 7}
FIAT = {'EURUSD','GBPUSD','USDJPY','USDCHF','USDCAD','AUDUSD','NZDUSD',
        'EURGBP','EURJPY','GBPJPY','AUDJPY','CHFJPY'}

def open_sym_dialog(page):
    page.keyboard.press('Escape')
    page.wait_for_timeout(150)
    page.click('#symbol-btn')
    page.wait_for_timeout(450)

def dialog_state(page):
    return page.evaluate("""(() => {
      const d = document.getElementById('sym-dialog');
      if (!d) return null;
      const heads = [...d.querySelectorAll('.sym-group-head')].map(h => h.textContent);
      const rows = [...d.querySelectorAll('#sym-results .sym-row .sym-name')].map(e => e.textContent);
      const tabs = [...d.querySelectorAll('#sym-tabs .sym-tab')].map(b => ({
        t: b.textContent, on: b.classList.contains('on'),
        bg: getComputedStyle(b).backgroundColor }));
      return { open: !!d, heads, rows, tabs,
               count: (d.querySelector('#sym-count') || {}).textContent || '',
               empty: (d.querySelector('.sym-empty') || {}).textContent || null };
    })()""")

def click_tab(page, label):
    page.evaluate("""(label) => {
      const d = document.getElementById('sym-dialog');
      const b = [...d.querySelectorAll('#sym-tabs .sym-tab')].find(x => x.textContent === label);
      b.click();
    }""", label)
    page.wait_for_timeout(120)

def set_query(page, q):
    page.evaluate("""(q) => {
      const i = document.getElementById('sym-search-input');
      i.value = q;
      i.dispatchEvent(new Event('input', { bubbles: true }));
    }""", q)

def strip_has_px(page, x, y0, y1):
    """any non-transparent overlay pixel in the vertical strip (pane 0)"""
    return page.evaluate("""(([x, y0, y1]) => {
      const p = window.__app.App.panes[0];
      const ctx = p.overlay.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const X = Math.round(x * dpr), Y0 = Math.round(y0 * dpr), Y1 = Math.round(y1 * dpr);
      const data = ctx.getImageData(X, Y0, 1, Y1 - Y0).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 10) return true;
      return false;
    })""", [x, y0, y1])

def pane_geo(page):
    return page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      const v = p.engine.view();
      const sub = p._subRects && p._subRects.length ? p._subRects[0] : null;
      return { pw: v.pw, ph: v.ph, mainH: v.mainH,
               sub: sub ? { top: sub.top, h: sub.h } : null };
    })()""")

with sync_playwright() as pw:
    browser, page = H.open_app(pw)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))

    # wait for the full catalog to be searchable
    page.wait_for_timeout(800)

    # ---------- A. tab row + All (grouped) view, dark theme ----------
    open_sym_dialog(page)
    st = dialog_state(page)
    page.screenshot(path=f'{OUT}/01-dialog-tabs-dark.png')
    check('A1: 7 pill tabs in TV order', st and [t['t'] for t in st['tabs']] == EXPECT_TABS,
          str(st and [t['t'] for t in st['tabs']]))
    on = [t['t'] for t in (st['tabs'] if st else []) if t['on']]
    check('A2: exactly All active on open', on == ['All'], str(on))
    check('A3: All view grouped (6 category heads)',
          st and set(st['heads']) == {'Forex','Metals','Energies','Indices','Crypto','Stocks & Others'},
          str(st and st['heads']))
    check('A4: exact total footer on All', st and st['count'] == '33 symbols', st and st['count'])
    check('A5: no "+N more" rows (no demo category exceeds the cap)',
          st and st['rows'] and len(st['rows']) == 33, f"rows={len(st['rows']) if st else 0}")

    # pill colours, dark theme: active white, inactive panel2
    bg = {t['t']: t['bg'] for t in st['tabs']}
    check('A6: dark active pill white', bg['All'] == 'rgb(255, 255, 255)', bg['All'])
    check('A7: dark inactive pill panel2', bg['Forex'] == 'rgb(42, 46, 57)', bg['Forex'])

    # ---------- B. tab filtering ----------
    click_tab(page, 'Forex')
    st = dialog_state(page)
    check('B1: Forex tab active', [t['t'] for t in st['tabs'] if t['on']] == ['Forex'])
    check('B2: Forex flat list (no group heads)', st['heads'] == [], str(st['heads']))
    check('B3: 12 fiat rows', len(st['rows']) == 12 and set(st['rows']) <= FIAT,
          f"n={len(st['rows'])}")
    check('B4: per-category footer', st['count'] == '12 symbols', st['count'])
    page.screenshot(path=f'{OUT}/02-dialog-forex-tab.png')

    set_query(page, 'eur')
    page.wait_for_timeout(600)  # debounce 220 + provider roundtrip
    st = dialog_state(page)
    check('B5: lowercase query inside Forex tab',
          st['rows'] == ['EURUSD', 'EURGBP', 'EURJPY'] and st['count'] == '3 symbols',
          f"{st['rows']} {st['count']}")

    set_query(page, '')
    page.wait_for_timeout(600)
    click_tab(page, 'Metals')
    st = dialog_state(page)
    check('B6: Metals tab', st['rows'] == ['XAUUSD', 'XAGUSD'] and st['count'] == '2 symbols',
          f"{st['rows']} {st['count']}")

    for tab, n in (('Crypto', 2), ('Energies', 3), ('Indices', 7), ('Stocks', 7)):
        click_tab(page, tab)
        st = dialog_state(page)
        check(f'B7: {tab} tab count', st['count'] == f'{n} symbols' and len(st['rows']) == n,
              f"{st['count']} rows={len(st['rows'])}")

    click_tab(page, 'All')
    st = dialog_state(page)
    check('B8: back to All restores grouped view + total',
          len(st['heads']) == 6 and st['count'] == '33 symbols', st['count'])

    set_query(page, 'qqq')
    page.wait_for_timeout(600)
    st = dialog_state(page)
    check('B9: garbage query -> placeholder + 0 (All tab)',
          st['empty'] == 'No matching symbol' and st['count'] == '0 symbols',
          f"{st['empty']} {st['count']}")
    set_query(page, '')
    page.wait_for_timeout(600)

    # Enter applies the first VISIBLE row of the active tab
    click_tab(page, 'Metals')
    page.focus('#sym-search-input')
    page.keyboard.press('Enter')
    page.wait_for_timeout(700)
    sym = page.evaluate("() => window.__app.App.panes[0].symbol")
    check('B10: Enter applies first row of active tab (XAUUSD)', sym == 'XAUUSD', sym)
    page.evaluate("() => window.__app.Manager.setSymbol(window.__app.App.panes[0], 'EURUSD')")
    page.wait_for_timeout(900)

    # ---------- C. light theme pill colours ----------
    page.evaluate("() => window.__app.Theme.apply('light')")
    page.wait_for_timeout(250)
    open_sym_dialog(page)
    st = dialog_state(page)
    page.screenshot(path=f'{OUT}/03-dialog-tabs-light.png')
    bg = {t['t']: t['bg'] for t in st['tabs']}
    check('C1: light active pill dark', bg['All'] == 'rgb(19, 23, 34)', bg['All'])
    check('C2: light inactive pill panel2', bg['Forex'] == 'rgb(224, 227, 235)', bg['Forex'])
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)
    page.evaluate("() => window.__app.Theme.apply('dark')")
    page.wait_for_timeout(250)

    # ---------- D. vline spans the indicator pane ----------
    page.evaluate("() => window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'rsi')")
    ok = H.poll(page, """(() => {
        const p = window.__app.App.panes[0];
        return !!(p.indicators && p.indicators.some(i => i.type === 'rsi') &&
                  p._subs && p._subRects && p._subRects.length);
    })()""", 15000, lambda v: bool(v))
    check('D1: RSI sub-pane exists', ok)
    page.wait_for_timeout(500)  # let a render frame settle the layout

    # pick a bar whose x column is CLEAN in the sub region (no grid tick)
    geo, x, t = None, None, None
    for off in (60, 75, 90, 105, 120):
        g, xx, tt = page.evaluate("""(off) => {
            const p = window.__app.App.panes[0];
            const t = p.barTimes[p.barTimes.length - off];
            return [((() => { const v = p.engine.view();
              const sub = p._subRects[0];
              return { pw: v.pw, ph: v.ph, mainH: v.mainH, sub: { top: sub.top, h: sub.h } }; })()),
              p.engine.view().xOf(t), t];
        }""", off)
        if not g['sub'] or xx < 10 or xx > g['pw'] - 10:
            continue
        dirty = strip_has_px(page, round(xx), g['sub']['top'] + 4, g['sub']['top'] + g['sub']['h'] - 4)
        if not dirty:
            geo, x, t = g, round(xx), tt
            break
    check('D2: clean probe column found below mainH', geo is not None,
          f"x={x} sub={geo and geo['sub']}")

    if geo:
        top4, bot4 = geo['sub']['top'] + 4, geo['sub']['top'] + geo['sub']['h'] - 4
        check('D3: baseline empty in sub region (before drawing)',
              not strip_has_px(page, x, top4, bot4))

        page.evaluate("""(t) => {
            const A = window.__app.App, p = A.panes[0];
            A.drawings.add(p.symbol, { type: 'vline', points: [{ t, p: 0 }],
              opts: A.drawings.defaultOpts('vline') });
        }""", t)
        page.wait_for_timeout(400)  # render loop repaint
        in_price = strip_has_px(page, x, 4, geo['mainH'] - 4)
        in_sub = strip_has_px(page, x, top4, bot4)
        at_bottom = strip_has_px(page, x, bot4 - 8, bot4)
        check('D4: vline visible in price pane', in_price)
        check('D5: vline NOW spans the indicator pane (the fix)', in_sub,
              f"y {top4}..{bot4}")
        check('D6: vline reaches the BOTTOM of the sub-pane', at_bottom)
        page.screenshot(path=f'{OUT}/04-vline-through-rsi.png')

        page.evaluate("""(t) => {
            const A = window.__app.App, p = A.panes[0];
            const b = A.drawings.data[p.symbol];
            const it = b.items.find(d => d.type === 'vline' && d.points[0].t === t);
            A.drawings.remove(p.symbol, it.id);
        }""", t)
        page.wait_for_timeout(400)
        check('D7: control — pixels gone after removal (both regions)',
              not strip_has_px(page, x, 4, geo['mainH'] - 4) and
              not strip_has_px(page, x, top4, bot4))

    check('Z: zero page errors', not errors, '; '.join(errors[:3]))

    browser.close()

print(f'\n==== ROUND37: {len(PASS)} passed, {len(FAIL)} failed ====')
if FAIL:
    print('FAILURES:'); [print(' -', f) for f in FAIL]
sys.exit(1 if FAIL else 0)
