"""Round 36 E2E suite (self-bootstrapping, same pattern as round32-35).

User reports fixed here:
  Report 1  "the symbol windows show NOTHING at all" — every search surface
            (Symbol Search dialog / Watchlist add / Compare) was silently
            broken on the REAL MT5 provider by the SYM_CACHE clobber
            (KeyError swallowed by the ws handler -> no reply). Root-cause
            proof lives in scripts/repro36_search_keyerror.py (fake MT5).
            Here we verify the RESTORED UI on the demo provider:
              - Symbol Search opens with CATEGORIZED groups
                (Forex / Metals / Energies / Indices / Crypto / Stocks & Others)
              - an exact footer count ("33 symbols") — the old behaviour the
                user asked to keep
              - case-insensitive search still works in all three surfaces
              - "No matching symbol" placeholder + "0 symbols" on garbage
              - "+N more…" cap inside an oversized category (stubbed feed)
  Report 2  "TF menu width is still too big" — narrowed 240px -> 190px.
"""
import os, subprocess, sys, time
subprocess.run(['pkill', '-f', 'provider/demo.py'], capture_output=True)
subprocess.run(['pkill', '-f', 'demo_mt5sim.py'], capture_output=True)
time.sleep(0.8)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
import e2e_helper_round32 as H
from playwright.sync_api import sync_playwright

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'scripts', 'shots36')
os.makedirs(OUT, exist_ok=True)
PASS, FAIL = [], []

def check(name, cond, extra=''):
    (PASS if cond else FAIL).append(f'{name} {extra}')
    print(('PASS' if cond else 'FAIL'), name, extra)

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
      const more = [...d.querySelectorAll('.sym-more')].map(e => e.textContent);
      return { open: !!d,
               heads,
               rows,
               more,
               count: (d.querySelector('#sym-count') || {}).textContent || '',
               empty: (d.querySelector('.sym-empty') || {}).textContent || null };
    })()""")

with sync_playwright() as pw:
    browser, page = H.open_app(pw)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))

    # ============ REPORT 1a: SYMBOL SEARCH DIALOG — categories + count ============
    open_sym_dialog(page)
    st = dialog_state(page)
    check('A1: dialog opens with results', st and len(st['rows']) > 0, str(st and st['count']))
    check('A1: category headers render', st['heads'] == ['Forex', 'Metals', 'Energies', 'Indices', 'Crypto', 'Stocks & Others'],
          str(st['heads']))
    check('A1: every demo symbol appears exactly once', len(st['rows']) == len(set(st['rows'])) and len(st['rows']) == 33,
          f"n={len(st['rows'])}")
    check('A1: footer shows the exact total', st['count'] == '33 symbols', st['count'])
    gold = {'EURUSD': 'Forex', 'XAUUSD': 'Metals', 'USOIL': 'Energies', 'US30': 'Indices',
            'BTCUSD': 'Crypto', 'AAPL': 'Stocks & Others'}
    page.screenshot(path=f'{OUT}/01-sym-dialog-dark.png')

    # category of each gold symbol = position of its group header vs rows order
    ok_cat = page.evaluate("""(gold) => {
      const d = document.getElementById('sym-results');
      const kids = [...d.children];
      let cur = null; const map = {};
      for (const k of kids) {
        if (k.classList.contains('sym-group-head')) cur = k.textContent;
        else if (k.classList.contains('sym-row')) map[k.querySelector('.sym-name').textContent] = cur;
      }
      return Object.entries(gold).every(([s, c]) => map[s] === c);
    }""", gold)
    check('A1: spot-check symbols land in the right category', ok_cat, str(gold))

    # ---- case-insensitive search still works, grouped, count updates ----
    page.fill('#sym-search-input', 'xau')
    page.wait_for_timeout(700)
    st = dialog_state(page)
    check('A2: lowercase "xau" -> XAUUSD only, in Metals', st['heads'] == ['Metals'] and st['rows'] == ['XAUUSD'], str(st))
    check('A2: footer updates to "1 symbol"', st['count'] == '1 symbol', st['count'])

    page.fill('#sym-search-input', 'GbP')
    page.wait_for_timeout(700)
    st = dialog_state(page)
    check('A2: mixed case "GbP" -> GBP symbols in Forex', st['heads'] == ['Forex'] and all('GBP' in s for s in st['rows']), str(st))

    page.fill('#sym-search-input', 'zzz')
    page.wait_for_timeout(700)
    st = dialog_state(page)
    check('A3: garbage query -> placeholder + "0 symbols"', st['empty'] == 'No matching symbol' and st['count'] == '0 symbols' and not st['rows'], str(st))
    page.screenshot(path=f'{OUT}/02-sym-dialog-empty.png')

    # ---- clicking a result applies the symbol ----
    page.fill('#sym-search-input', 'GBPJPY')
    page.wait_for_timeout(700)
    page.click('#sym-results .sym-row')
    page.wait_for_timeout(900)
    check('A4: clicking a result switches the chart symbol',
          page.evaluate("() => window.__app.App.panes[0].symbol") == 'GBPJPY')

    # ---- "+N more…" cap inside an oversized category (stubbed feed) ----
    page.evaluate("""(() => {
      const pairs = [];
      const c3 = ['EUR', 'GBP', 'USD', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD'];
      outer: for (const a of c3) for (const b of c3) {
        if (a === b) continue;
        pairs.push(a + b);
        if (pairs.length >= 45) break outer;
      }
      window.__app._origSearch = window.__app.App.feed.search.bind(window.__app.App.feed);
      window.__app.App.feed.search = (q) => Promise.resolve({ symbols: pairs.filter(s => !q || s.includes(q.toUpperCase())), total: 45 });
    })()""")
    open_sym_dialog(page)
    st = dialog_state(page)
    check('A5: 45-pair Forex category capped at 40 rows + "+5 more…"',
          st['heads'] == ['Forex'] and len(st['rows']) == 40 and st['more'] == ['+5 more…'],
          f"rows={len(st['rows'])} more={st['more']}")
    check('A5: footer keeps the TRUE total (45) beyond the cap', st['count'] == '45 symbols', st['count'])
    page.screenshot(path=f'{OUT}/03-sym-dialog-more-cap.png')
    page.evaluate("() => { window.__app.App.feed.search = window.__app._origSearch; }")
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)

    # ============ REPORT 1b: WATCHLIST ADD SEARCH ============
    wl = page.evaluate("""(() => {
      const row = document.getElementById('wl-add-row');
      if (!row) return false;
      row.classList.remove('hidden');
      return !!document.getElementById('wl-add-input');
    })()""")
    if wl:
        page.fill('#wl-add-input', 'gbp')
        page.wait_for_timeout(700)
        r = page.evaluate("() => [...document.querySelectorAll('#wl-add-results .pu-item')].map(e => e.textContent.trim())")
        check('B1: watchlist add lowercase "gbp" -> results', any('GBPUSD' in s for s in r), str(r[:5]))
        page.evaluate("() => { const row = document.getElementById('wl-add-row'); if (row) row.classList.add('hidden'); }")
    else:
        check('B1: watchlist add input exists', False, 'no #wl-add-row')

    # ============ REPORT 1c: COMPARE SEARCH ============
    page.click('#compare-btn')
    page.wait_for_timeout(300)
    page.fill('.cmp-search', 'eUr')
    page.wait_for_timeout(700)
    r = page.evaluate("() => [...document.querySelectorAll('.popup .cmp-results .pu-item')].map(b => b.textContent.trim())")
    check('C1: compare lowercase/mixed "eUr" -> results', any(s.startswith('EUR') for s in r), str(r[:5]))
    # click the first result -> compare is added -> chip + removable X
    page.evaluate("""(() => {
      const it = document.querySelector('.popup .cmp-results .pu-item');
      if (it) it.click();
    })()""")
    page.wait_for_timeout(1400)
    cst = page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      return { n: (p._compares || []).length, chip: !!(p._cmpLegend && p._cmpLegend.querySelector('.cmp-chip')),
               x: !!(p._cmpLegend && p._cmpLegend.querySelector('.cmp-x')) };
    })()""")
    check('C2: compare result click ADDS the overlay + chip + X', cst['n'] == 1 and cst['chip'] and cst['x'], str(cst))
    # remove via the chip X (the restored remove feature)
    page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      const x = p._cmpLegend && p._cmpLegend.querySelector('.cmp-x');
      if (x) x.click();
    })()""")
    page.wait_for_timeout(400)
    check('C2: chip X removes the compare', page.evaluate("() => (window.__app.App.panes[0]._compares || []).length === 0"))

    # ============ REPORT 2: TF MENU WIDTH ============
    page.keyboard.press('Escape')
    page.wait_for_timeout(150)
    page.click('#tf-menu-btn')
    page.wait_for_timeout(250)
    w = page.evaluate("() => document.getElementById('tf-menu').getBoundingClientRect().width")
    check('D1: TF menu narrowed to 190px (<=200)', w <= 200, f"w={w}")
    page.screenshot(path=f'{OUT}/04-tf-menu-narrow.png')
    rows = page.evaluate("""(() => {
      const m = document.getElementById('tf-menu');
      const r = m.getBoundingClientRect();
      return [...m.querySelectorAll('.tf-group-items .pu-item')].slice(0, 4).map(it => {
        const star = it.querySelector('.pu-star:not(.pu-trash)').getBoundingClientRect();
        return +(star.right - r.left).toFixed(1);
      });
    })()""")
    check('D2: star column still flush right at the narrower width', len(set(rows)) == 1 and rows[0] >= 150,
          str(rows))
    page.mouse.click(700, 500)
    page.wait_for_timeout(250)

    # ============ THEME: light mode dialog + menu ============
    page.evaluate("() => window.__app.Theme.apply('light')")
    page.wait_for_timeout(250)
    open_sym_dialog(page)
    page.screenshot(path=f'{OUT}/05-sym-dialog-light.png')
    st = dialog_state(page)
    check('E1: light theme — dialog renders categories + count', st['heads'] == ['Forex', 'Metals', 'Energies', 'Indices', 'Crypto', 'Stocks & Others'] and st['count'] == '33 symbols', st['count'])
    page.keyboard.press('Escape')
    page.wait_for_timeout(150)
    page.click('#tf-menu-btn')
    page.wait_for_timeout(250)
    page.screenshot(path=f'{OUT}/06-tf-menu-light.png')
    page.keyboard.press('Escape')

    # ============ HYGIENE ============
    check('F1: zero page errors', not errors, str(errors[:3]))

    browser.close()

print(f'\n==== ROUND36: {len(PASS)} PASS / {len(FAIL)} FAIL ====')
if FAIL:
    for f in FAIL: print('  FAIL:', f)
sys.exit(1 if FAIL else 0)
