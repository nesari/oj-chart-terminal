"""Round 35 E2E suite (self-bootstrapping, same pattern as round32/33):

  Item 1  TF menu: star column at the SAME x on default AND custom rows,
          trash sits immediately LEFT of the star (one aligned action zone)
  Item 2  deleting a custom interval keeps the menu OPEN (row removed in
          place); outside click still closes
  Item 3  TF menu width reduced (<= 250px)
  Item 4  symbol search is case-insensitive (dialog, watchlist add, compare)
          and de-duplicated
  Item 5  Compare works across symbol/TF switches (re-align wrapper) and the
          remove options exist (legend chip X + popup trash); empty-fetch
          retry path
  Item 6  vertical-line time tag shows DATE + time on the time axis (TV)
"""
import os, subprocess, sys, time
# kill stale providers holding the ws port (a leftover from an earlier run or
# a probe would silently serve OLD provider code/symbol lists to this suite)
subprocess.run(['pkill', '-f', 'provider/demo.py'], capture_output=True)
subprocess.run(['pkill', '-f', 'demo_mt5sim.py'], capture_output=True)
time.sleep(0.8)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_helper_round32 as H
from playwright.sync_api import sync_playwright

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts', 'shots35')
os.makedirs(OUT, exist_ok=True)
PASS, FAIL = [], []

def check(name, cond, extra=''):
    (PASS if cond else FAIL).append(f'{name} {extra}')
    print(('PASS' if cond else 'FAIL'), name, extra)

def tf_rows(page):
    """star/trash geometry for every row of the open tf-menu (pane-local x)."""
    return page.evaluate("""(() => {
      const m = document.getElementById('tf-menu');
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return {
        w: Math.round(r.width),
        rows: [...m.querySelectorAll('.tf-group-items .pu-item')].map(it => {
          const lbl = it.querySelector('span').textContent;
          const star = it.querySelector('.pu-star:not(.pu-trash)');
          const trash = it.querySelector('.pu-trash');
          const sr = star && star.getBoundingClientRect();
          const tr = trash && trash.getBoundingClientRect();
          return { lbl,
                   starL: sr ? +(sr.left - r.left).toFixed(1) : null,
                   starR: sr ? +(sr.right - r.left).toFixed(1) : null,
                   trashL: tr ? +(tr.left - r.left).toFixed(1) : null,
                   trashR: tr ? +(tr.right - r.left).toFixed(1) : null };
        }) };
    })()""")

def open_tf_menu(page):
    page.evaluate("() => { Toolbar_closePopup_safe(); }") if False else None
    page.keyboard.press('Escape')  # close anything open
    page.wait_for_timeout(150)
    page.click('#tf-menu-btn')
    page.wait_for_timeout(250)

with sync_playwright() as pw:
    browser, page = H.open_app(pw)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))

    # ================= ITEM 1 + 2 + 3 : TF MENU =================
    # create two custom intervals (one in Minutes, one in Hours)
    page.evaluate("() => { window.__app.App.addCustomTf(7, 'm'); window.__app.App.addCustomTf(6, 'h'); }")
    page.wait_for_timeout(150)
    open_tf_menu(page)
    data = tf_rows(page)
    print('tf menu:', data['w'])
    page.screenshot(path=f'{OUT}/tf_menu_dark.png')

    check('A3: menu width <= 200 (narrowed in round36)', data['w'] <= 200, f"w={data['w']}")

    custom = [r for r in data['rows'] if r['trashL'] is not None]
    plain = [r for r in data['rows'] if r['trashL'] is None]
    check('A1: custom rows exist in probe (7m, 6H)', len(custom) == 2, str([r['lbl'] for r in custom]))
    check('A1: plain rows exist', len(plain) >= 10, f"n={len(plain)}")

    starXs = [r['starL'] for r in data['rows']]
    spread = max(starXs) - min(starXs)
    check('A1: star column IDENTICAL on all rows (spread<=2px)', spread <= 2.0, f"spread={spread:.1f}px")

    ok_order = all(r['starL'] is not None and r['trashR'] is not None and r['trashR'] <= r['starL'] + 1.5 for r in custom)
    check('A1: trash sits LEFT of the star on custom rows', ok_order,
          str([(r['lbl'], r['trashR'], r['starL']) for r in custom]))

    rightmost = max(r['starR'] for r in data['rows'])
    check('A1: star is the rightmost element of every row', all(abs(r['starR'] - rightmost) <= 2 for r in data['rows']),
          f"rightmost={rightmost:.0f}")

    # -------- ITEM 2: delete must NOT close the menu --------
    # delete 7m via its trash
    res = page.evaluate("""(() => {
      const m = document.getElementById('tf-menu');
      for (const it of m.querySelectorAll('.tf-group-items .pu-item')) {
        if (it.querySelector('span').textContent === '7m') {
          it.querySelector('.pu-trash').click();
          return { gone: !it.isConnected, menuOpen: !!document.getElementById('tf-menu') };
        }
      }
      return { gone: null, menuOpen: !!document.getElementById('tf-menu') };
    })()""")
    check('A2: delete keeps the menu OPEN', res['menuOpen'], str(res))
    check('A2: deleted row removed in place', res['gone'], str(res))
    check('A2: 7m removed from App.tf', page.evaluate("() => !window.__app.App.tfById['7m']"))

    # delete 45s too (Seconds keeps its 4 default rows — defaults never empty
    # a group; the empty-group cleanup stays a defensive branch)
    page.evaluate("() => window.__app.App.addCustomTf(45, 's')")
    page.wait_for_timeout(120)
    open_tf_menu(page)
    res2 = page.evaluate("""(() => {
      const m = document.getElementById('tf-menu');
      for (const it of m.querySelectorAll('.tf-group-items .pu-item')) {
        if (it.querySelector('span').textContent === '45s') { it.querySelector('.pu-trash').click(); break; }
      }
      const seconds = [...m.querySelectorAll('.tf-group')].filter(g => {
        const head = g.querySelector('.tf-group-head span');
        return head && head.textContent === 'Seconds';
      });
      const secRows = seconds.length ? [...seconds[0].querySelectorAll('.pu-item span')] : [];
      return { menuOpen: !!document.getElementById('tf-menu'), secondsGroups: seconds.length,
               secLabels: secRows.map(s => s.textContent) };
    })()""")
    check('A2: menu still open after 2nd delete', res2['menuOpen'], str(res2['menuOpen']))
    check('A2: 45s row gone, Seconds defaults intact', res2['secLabels'] == ['1s', '5s', '15s', '30s'], str(res2))

    # -------- A4: clicking a group header / star does not close; outside click closes --------
    res3 = page.evaluate("""(() => {
      const m = document.getElementById('tf-menu');
      const head = m.querySelector('.tf-group-head');
      head.click();
      const afterHead = !!document.getElementById('tf-menu');
      const star = m.querySelector('.tf-group-items .pu-item .pu-star:not(.pu-trash)');
      if (star) star.click();
      const afterStar = !!document.getElementById('tf-menu');
      return { afterHead, afterStar };
    })()""")
    check('A2: group-header click keeps menu open', res3['afterHead'], str(res3))
    check('A2: star toggle keeps menu open', res3['afterStar'], str(res3))
    page.mouse.click(700, 500)  # outside
    page.wait_for_timeout(250)
    check('A2: outside click closes the menu', not page.evaluate("() => !!document.getElementById('tf-menu')"))
    # restore fav state polluted by the star toggle above
    page.evaluate("() => { const a = window.__app.App; const id = a.tf[0].id; if (a.tfFavorites.includes(id)) { a.tfFavorites.splice(a.tfFavorites.indexOf(id),1); localStorage.setItem('mt5_tf_favs', JSON.stringify(a.tfFavorites)); } }")

    # ================= ITEM 4 : CASE-INSENSITIVE SEARCH =================
    page.click('#symbol-btn')
    page.wait_for_timeout(400)
    page.fill('#sym-search-input', 'gbp')       # lowercase
    page.wait_for_timeout(700)
    r1 = page.evaluate("() => [...document.querySelectorAll('#sym-results .sym-row .sym-name')].map(e => e.textContent)")
    check('B1: symbol dialog lowercase "gbp" -> results', len(r1) >= 2 and all(s == s.upper() for s in r1), str(r1[:6]))
    page.fill('#sym-search-input', 'GbPjPy')    # mixed case
    page.wait_for_timeout(700)
    r2 = page.evaluate("() => [...document.querySelectorAll('#sym-results .sym-row .sym-name')].map(e => e.textContent)")
    check('B1: mixed case "GbPjPy" -> GBPJPY', 'GBPJPY' in r2, str(r2[:4]))
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)

    # watchlist add input
    wl = page.evaluate("""(() => {
      const row = document.getElementById('wl-add-row');
      if (!row) return false;
      row.classList.remove('hidden');
      return !!document.getElementById('wl-add-input');
    })()""")
    if wl:
        page.fill('#wl-add-input', 'usdj')      # lowercase fragment
        page.wait_for_timeout(700)
        r3 = page.evaluate("() => [...document.querySelectorAll('#wl-add-results .pu-item')].map(e => e.textContent.trim())")
        check('B2: watchlist add lowercase "usdj" -> results', any('USDJPY' in s for s in r3), str(r3[:5]))
        page.evaluate("() => { const row = document.getElementById('wl-add-row'); if (row) row.classList.add('hidden'); }")

    # compare search mixed case
    page.click('#compare-btn')
    page.wait_for_timeout(300)
    page.fill('.cmp-search', 'eUrJ')
    page.wait_for_timeout(700)
    r4 = page.evaluate("() => [...document.querySelectorAll('.popup .cmp-results .pu-item')].map(b => b.textContent.trim())")
    check('B3: compare search mixed case "eUrJ" -> EURJPY (once)', r4 == ['EURJPY'], str(r4))
    # empty search has no duplicates (compare's own input returns early on
    # empty — assert on the FEED like the symbol-search dialog does)
    r5 = page.evaluate("async () => (await window.__app.App.feed.search('')).symbols")  # ROUND36: {symbols,total}
    check('B4: no duplicate symbols in results', len(r5) == len(set(r5)), f"n={len(r5)}")
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)

    # ================= ITEM 5 : COMPARE =================
    # C1: add + chip
    page.evaluate("() => window.__app.Compare.add(window.__app.App.panes[0], 'GBPUSD')")
    page.wait_for_timeout(1200)
    st = page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      return { n: (p._compares || []).length, chip: !!(p._cmpLegend && p._cmpLegend.querySelector('.cmp-chip')),
               x: !!(p._cmpLegend && p._cmpLegend.querySelector('.cmp-x')) };
    })()""")
    check('C1: compare added + chip + X present', st['n'] == 1 and st['chip'] and st['x'], str(st))

    # C1b (round 35: the remove X used to render 4px wide — CSS-less chip):
    # the dot and the X must be VISIBLE and the X must be the element under
    # its own center point (truly clickable).
    st1b = page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      const chip = p._cmpLegend && p._cmpLegend.querySelector('.cmp-chip');
      const dot = chip && chip.querySelector('i');
      const x = chip && chip.querySelector('.cmp-x');
      if (!chip || !dot || !x) return { ok: false };
      const r = x.getBoundingClientRect();
      const dr = dot.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { ok: true, dotW: dr.width, dotH: dr.height, xW: r.width, xH: r.height,
               hitIsX: hit === x || x.contains(hit) };
    })()""")
    check('C1b: chip dot visible', st1b['ok'] and st1b['dotW'] >= 7 and st1b['dotH'] >= 7, str(st1b))
    check('C1b: remove X visible AND clickable', st1b['ok'] and st1b['xW'] >= 12 and st1b['xH'] >= 12 and st1b['hitIsX'], str(st1b))

    # C2: TF switch -> compare re-aligns (the round-35 core fix)
    page.evaluate("() => window.__app.Manager.setTf(window.__app.App.panes[0], 'M15')")
    page.wait_for_timeout(1600)
    st2 = page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      const c = (p._compares || [])[0];
      if (!c) return { exists: false };
      const times = new Set(p.bars.map(b => b.time));
      let foreign = 0, n = 0;
      try {
        const data = c.series.data();
        for (const d of data) { n++; if (!times.has(d.time)) foreign++; }
      } catch (e) { return { exists: true, err: String(e) }; }
      return { exists: true, tf: c.tf, paneTf: p.tf, foreign, n };
    })()""")
    check('C2: compare survives TF switch', st2['exists'] and not st2.get('err'), str(st2))
    check('C2: compare tf follows pane tf', st2.get('tf') == 'M15' and st2.get('paneTf') == 'M15', str(st2))
    check('C2: NO foreign timestamps in compare data (re-aligned)', st2.get('foreign') == 0 and st2.get('n', 0) > 2, str(st2))

    # C3: symbol switch -> re-aligns to the new main bars
    page.evaluate("() => window.__app.Manager.setSymbol(window.__app.App.panes[0], 'AUDUSD')")
    page.wait_for_timeout(1600)
    st3 = page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      const c = (p._compares || [])[0];
      if (!c) return { exists: false };
      const times = new Set(p.bars.map(b => b.time));
      let foreign = 0, n = 0;
      try { for (const d of c.series.data()) { n++; if (!times.has(d.time)) foreign++; } } catch (e) {}
      return { exists: true, sym: p.symbol, foreign, n };
    })()""")
    check('C3: compare survives symbol switch (AUDUSD)', st3['exists'] and st3.get('sym') == 'AUDUSD', str(st3))
    check('C3: re-aligned to AUDUSD bars (no foreign times)', st3.get('foreign') == 0 and st3.get('n', 0) > 2, str(st3))
    page.screenshot(path=f'{OUT}/cmp_realign.png')

    # C4: remove via legend chip X
    page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      const x = p._cmpLegend && p._cmpLegend.querySelector('.cmp-x');
      if (x) x.click();
    })()""")
    page.wait_for_timeout(400)
    st4 = page.evaluate("() => ({ n: (window.__app.App.panes[0]._compares || []).length, chip: !!window.__app.App.panes[0]._cmpLegend })")
    check('C4: chip X removes the compare', st4['n'] == 0 and not st4['chip'], str(st4))

    # C5: remove via the compare popup trash
    page.evaluate("() => window.__app.Compare.add(window.__app.App.panes[0], 'GBPJPY')")
    page.wait_for_timeout(900)
    page.click('#compare-btn')
    page.wait_for_timeout(300)
    page.evaluate("""(() => {
      const p = document.querySelector('.popup');
      const tr = p && p.querySelector('.pu-item .pu-trash');
      if (tr) tr.click();
    })()""")
    page.wait_for_timeout(400)
    st5 = page.evaluate("() => (window.__app.App.panes[0]._compares || []).length")
    check('C5: popup trash removes the compare', st5 == 0, f"n={st5}")

    # C6: empty-fetch retry (first two calls empty, third returns bars)
    page.evaluate("""(() => {
      const feed = window.__app.App.feed;
      const orig = feed.bars.bind(feed);
      let calls = 0;
      feed.bars = async (s, tf, c, to) => {
        calls++;
        if (calls <= 2) return { bars: [] };
        return orig(s, tf, c, to);
      };
      window.__setBarsProbe = () => { feed.bars = orig; };
    })()""")
    page.evaluate("() => window.__app.Compare.add(window.__app.App.panes[0], 'USDCHF')")
    page.wait_for_timeout(3500)
    st6 = page.evaluate("() => ({ n: (window.__app.App.panes[0]._compares || []).map(c=>c.symbol) })")
    page.evaluate("() => window.__setBarsProbe && window.__setBarsProbe()")
    check('C6: empty fetch retried -> compare still added', 'USDCHF' in st6['n'], str(st6))

    # ================= ITEM 6 : VLINE DATE TAG =================
    def tag_width_at(x, pane_idx=0):
        """width (css px) of the contiguous tag-colored run on the time strip
        around the vertical line at x. Scans the TOP rows of the tag box —
        the middle rows are interrupted by the white label glyphs."""
        return page.evaluate(
            """(([x, idx]) => {
              const p = window.__app.App.panes[idx];
              const cv = p.overlay, ctx = cv.getContext('2d');
              const dpr = window.devicePixelRatio || 1;
              const h = cv.height, timeH = Math.round((p.engine.view().timeH || 26) * dpr);
              const img = ctx.getImageData(0, cv.height - timeH, cv.width, timeH).data;
              const xc = Math.round(x * dpr);
              const W = cv.width;
              const px = (xx, yy) => {
                const o = (yy * W + xx) * 4;
                if (img[o + 3] < 200) return false;
                return Math.abs(img[o] - 41) < 40 && Math.abs(img[o + 1] - 98) < 40 && Math.abs(img[o + 2] - 255) < 40;
              };
              let best = 0;
              for (const dy of [2, 3, 4]) {           // top rows of the box: pure fill, no glyphs
                const yy = timeH - Math.max(2, timeH - dy);
                const yTop = dy;                      // rows 2..4 of the strip
                if (!px(xc, yTop)) continue;
                let l = xc, r = xc;
                while (l > 0 && px(l - 1, yTop)) l--;
                while (r < W - 1 && px(r + 1, yTop)) r++;
                best = Math.max(best, (r - l + 1) / dpr);
              }
              return best;
            })""", [x, pane_idx])

    # M5 chart: tag must carry date + time -> wide box (>= 70 css px; the old
    # time-only label was <= 50px). Pick a bar INSIDE the visible logical
    # range (a mid-history bar sits far off-screen with 3000 bars loaded).
    page.evaluate("() => window.__app.Manager.setTf(window.__app.App.panes[0], 'M5')")
    page.wait_for_timeout(1500)
    page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      const lr = p.chart.timeScale().getVisibleLogicalRange();
      const i = Math.max(0, Math.min(p.bars.length - 1, Math.round((lr.from + lr.to) / 2)));
      const b = p.bars[i];
      window.__vlineT = b.time;
      window.__app.App.drawings.add(p.symbol, { type: 'vline', points: [{ t: b.time, p: b.close }], opts: window.__app.App.drawings.defaultOpts('vline') });
    })()""")
    page.wait_for_timeout(600)
    vx = page.evaluate("() => window.__app.App.panes[0].engine.view().xOf(window.__vlineT)")
    w_intra = tag_width_at(vx)
    check('D1: vline tag on M5 is DATE+TIME wide (>=70px, old <=50px)', w_intra >= 70, f"x={vx:.0f} w={w_intra:.0f}px")

    # Daily chart: date-only TV tag (also wide; old numeric "07 09 '26" was ~55px)
    page.evaluate("() => window.__app.Manager.setTf(window.__app.App.panes[0], 'D1')")
    page.wait_for_timeout(1800)
    page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      const du = window.__app.App.drawings.list(p.symbol)[0];
      const lr = p.chart.timeScale().getVisibleLogicalRange();
      const i = Math.max(0, Math.min(p.bars.length - 1, Math.round((lr.from + lr.to) / 2)));
      du.points[0].t = p.bars[i].time;
      window.__vlineT = du.points[0].t;
    })()""")
    page.wait_for_timeout(600)
    vx2 = page.evaluate("() => window.__app.App.panes[0].engine.view().xOf(window.__app.App.drawings.list(window.__app.App.panes[0].symbol)[0].points[0].t)")
    w_daily = tag_width_at(vx2)
    check('D2: vline tag on D1 shows the date (>=70px)', w_daily >= 70, f"x={vx2:.0f} w={w_daily:.0f}px")
    page.screenshot(path=f'{OUT}/vline_daily.png')

    # cleanup drawings for the light-theme shots
    page.evaluate("() => window.__app.App.drawings.removeAll(window.__app.App.panes[0].symbol)")

    # light theme sanity for the new menu
    page.evaluate("() => window.__app.Theme.apply('light')")
    page.wait_for_timeout(400)
    page.evaluate("() => localStorage.removeItem('mt5_tf_menu_collapsed')")  # expand all groups
    open_tf_menu(page)
    page.evaluate("() => window.__app.App.addCustomTf(7, 'm')")
    page.wait_for_timeout(150)
    open_tf_menu(page)
    lt = tf_rows(page)
    starXs = [r['starL'] for r in lt['rows']]
    check('A5(light): star column identical (spread<=2px)', max(starXs) - min(starXs) <= 2.0, f"spread={max(starXs)-min(starXs):.1f}")
    page.screenshot(path=f'{OUT}/tf_menu_light.png')

    check('Z: zero page errors', not errors, str(errors[:3]))

    browser.close()

print(f'\n==== ROUND35: {len(PASS)} PASS / {len(FAIL)} FAIL ====')
for f in FAIL: print('  FAIL:', f)
sys.exit(1 if FAIL else 0)
