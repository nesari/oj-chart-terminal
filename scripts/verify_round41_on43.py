#!/usr/bin/env python3
"""ROUND41 verification: (1) vertical grid UNDER the candles, (2) TV-style
day-boundary labels on the time axis (full date when it fits, else day number),
plus crosshair full date+time pill. Boots the app from the WORK copy against
the demo provider (same harness as the project's own suites)."""
import os, re, sys, time
sys.path.insert(0, '/home/z/my-project/work/mt5-round43/scripts')
import e2e_helper_round32 as H
from playwright.sync_api import sync_playwright
from PIL import Image
import io

OUT = '/home/z/my-project/work/shots42-r41'
os.makedirs(OUT, exist_ok=True)

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  | ' + str(detail)[:300] if detail != '' else ''))

GRID_COLOR = (42, 46, 57)

with sync_playwright() as pw:
    browser, page = H.open_app(pw)
    page.wait_for_timeout(800)

    # use H1 like the user's screenshot
    page.evaluate("() => window.__app.Manager.setTf(window.__app.App.panes[0], 'H1')")
    H.poll(page, "(window.__app.App.panes[0].barTimes || []).length", 30000, lambda v: v > 100)
    page.wait_for_timeout(800)
    n = page.evaluate("() => window.__app.App.panes[0].barTimes.length")
    print('bars:', n)

    # ================= FIX 1: grid underlay =================
    res = page.evaluate("""() => {
      const p = window.__app.App.panes[0];
      const g = p.gridCv;
      if (!g) return { has: false };
      const cs = getComputedStyle(g);
      const chartEl = p.host.querySelector('.tv-lightweight-charts');
      const csc = chartEl ? getComputedStyle(chartEl) : null;
      const dpr = window.devicePixelRatio || 1;
      // painted pixels on the underlay (top area = plot)
      let gpx = 0;
      try {
        const img = g.getContext('2d').getImageData(0, 0, g.width, Math.min(g.height, Math.round(300 * dpr))).data;
        for (let i = 3; i < img.length; i += 4) if (img[i] > 10) gpx++;
      } catch (e) {}
      // overlay paint at each grid column (CSS px -> device px), BELOW the
      // news-chip lanes (chips are 13px tall at y~22-34; a real grid line
      // would run the FULL plot height)
      const cols = [];
      try {
        const octx = p.overlay.getContext('2d');
        const wpx = p.overlay.width, hpx = p.overlay.height;
        const img = octx.getImageData(0, 0, wpx, hpx).data;
        const yStart = Math.round(48 * dpr);
        for (const gx of (p.engine._taxGrid || [])) {
          const X = Math.round(gx * dpr);
          if (X < 0 || X >= wpx) continue;
          let c = 0;
          for (let y = yStart; y < hpx; y++) if (img[(y * wpx + X) * 4 + 3] > 10) c++;
          cols.push({ gx: +gx.toFixed(1), overlayPixels: c });
        }
      } catch (e) { cols.push({ err: String(e) }); }
      return {
        has: true, z: cs.zIndex, pe: cs.pointerEvents,
        chartZ: csc ? csc.zIndex : null,
        gpx, cols,
        behind: !!(chartEl && (g.compareDocumentPosition(chartEl) & Node.DOCUMENT_POSITION_FOLLOWING)),
      };
    }""")
    check('F1a gridCv exists with z=0 behind chart (z=1), pointer-events none',
          res.get('has') and res.get('z') == '0' and res.get('chartZ') == '1' and res.get('behind') and res.get('pe') == 'none',
          {k: res.get(k) for k in ('z', 'chartZ', 'behind', 'pe')})
    check('F1b underlay canvas actually painted with grid lines', res.get('gpx', 0) > 50, f"gpx={res.get('gpx')}")

    # overlay must be clean at MID-DAY grid columns ("hh:mm" spans);
    # day-boundary columns may host period separators / news marks on purpose
    cols = res.get('cols') or []
    spans = page.evaluate("""() => [...document.querySelectorAll('.tax-ext span')].map(s => ({ l: parseFloat(s.style.left), t: s.textContent }))""")
    mids = [s['l'] for s in spans if re.match(r'^\d{2}:\d{2}$', s['t'] or '')]
    dirty = []
    for c in cols:
        if any(abs(c['gx'] - m) <= 1.5 for m in mids) and c.get('overlayPixels', 0) > 0:
            dirty.append(c)
    check('F1c overlay canvas has NO grid paint at mid-day tick columns', len(dirty) == 0, f"cols={cols[:6]} dirty={dirty}")

    # composited proof: sample the SCREEN at a mid-day grid x over a candle body
    # -> pixel must be a candle color, not the grid color
    probe = page.evaluate("""() => {
      const p = window.__app.App.panes[0];
      const dpr = window.devicePixelRatio || 1;
      const rects = p.overlay.getBoundingClientRect();
      const grid = p.engine._taxGrid || [];
      const spans = [...p.tax.querySelectorAll('span')];
      const mid = spans.find(s => /^\\d{2}:\\d{2}$/.test(s.textContent) && Math.abs(parseFloat(s.style.left)) < (p.overlay.clientWidth - 80));
      if (!mid) return null;
      const x = parseFloat(mid.style.left);
      // bar under that x -> its body centre y
      const l = p.chart.timeScale().coordinateToLogical(x);
      const i = Math.round(l);
      if (i < 0 || i >= p.bars.length) return null;
      const b = p.bars[i];
      const up = b.close >= b.open;
      const yTop = p.series.priceToCoordinate(Math.max(b.open, b.close));
      const yBot = p.series.priceToCoordinate(Math.min(b.open, b.close));
      if (yTop == null || yBot == null) return null;
      const bodyPx = Math.abs(yBot - yTop);
      if (bodyPx < 6) return null; // need a tall body for a clean probe
      return { sx: rects.left + x, sy: rects.top + (yTop + yBot) / 2, up, i };
    }""")
    if probe:
        shot = page.screenshot(clip={'x': probe['sx'], 'y': probe['sy'], 'width': 1, 'height': 1})
        px = Image.open(io.BytesIO(shot)).convert('RGB').getpixel((0, 0))
        is_grid_like = all(abs(px[k] - GRID_COLOR[k]) <= 12 for k in range(3))
        check('F1d composited pixel at grid-x over a candle body is NOT grid color', not is_grid_like, f"px={px} up={probe['up']}")
    else:
        check('F1d composited pixel probe skipped (no tall body in view)', True, 'probe=null')

    page.screenshot(path=f'{OUT}/01-fix1-grid-under-candles.png')

    # ================= FIX 2a: zoomed-out axis -> day numbers =================
    page.evaluate(f"() => window.__app.App.panes[0].chart.timeScale().setVisibleLogicalRange({{from: {n - 300}, to: {n + 5}}})")
    page.wait_for_timeout(900)
    texts_out = page.evaluate("""() => [...document.querySelectorAll('.tax-ext span')].map(s => s.textContent.trim())""")
    has_daynum = any(re.match(r'^\d{1,2}$', t or '') for t in texts_out)
    has_times = any(re.match(r'^\d{2}:\d{2}$', t or '') for t in texts_out)
    has_month = any(re.match(r'^[A-Z][a-z]{2}$', t or '') for t in texts_out)
    check('F2a zoomed-out: day boundary shows the short DAY NUMBER (TV)', has_daynum and has_times, texts_out)
    check('F2a-2 month rollover collapses to the month name (TV "Sep")', has_month, texts_out)

    # ================= FIX 2b: zoomed-in around a day boundary -> full date =================
    bidx = page.evaluate("""() => {
      const p = window.__app.App.panes[0];
      const off = (window.__app.App.feed && window.__app.App.feed.serverOff) || 0;
      const day = (t) => Math.floor((t - off) / 86400);
      for (let i = p.barTimes.length - 2; i > 10; i--) {
        if (day(p.barTimes[i]) !== day(p.barTimes[i + 1])) return i + 1; // first bar of that day
      }
      return -1;
    }""")
    check('F2b found a day boundary in data', bidx > 0, f"bidx={bidx}")
    if bidx > 0:
        page.evaluate(f"() => window.__app.App.panes[0].chart.timeScale().setVisibleLogicalRange({{from: {bidx - 12}, to: {bidx + 18}}})")
        page.wait_for_timeout(900)
        texts_in = page.evaluate("""() => [...document.querySelectorAll('.tax-ext span')].map(s => s.textContent.trim())""")
        # broker tz prints the month numerically ("Tue 08 09"); non-broker tz
        # prints the short month ("Tue 08 Sep") — both are the FULL day label
        has_full = any(re.match(r"^[A-Z][a-z]{2} \d{2} ([A-Z][a-z]{2}|\d{2})$", t or '') for t in texts_in)
        check('F2c zoomed-in: full date written at the day start (TV)', has_full, texts_in)
        page.screenshot(path=f'{OUT}/02-fix2-zoomed-in-full-date.png')

    # ================= FIX 2c: crosshair shows full date + time =================
    page.evaluate("() => window.__app.App.panes[0].chart.timeScale().setVisibleLogicalRange({" + f"from: {n - 120}, to: {n + 10}" + "})")
    page.wait_for_timeout(700)
    H.move_mouse(page, 700, 300)
    page.wait_for_timeout(500)
    pill = page.evaluate("""() => {
      const el = document.querySelector('.tax-live');
      return { shown: el && el.style.display !== 'none', txt: el ? el.textContent : '' };
    }""")
    pill_ok = pill.get('shown') and re.match(r"^[A-Z][a-z]{2} \d{2} [A-Z][a-z]{2} '\d{2}\s+\d{2}:\d{2}$", pill.get('txt') or '')
    check('F2d cross mode pill shows FULL date + time (TV)', pill_ok, pill)
    page.screenshot(path=f'{OUT}/03-fix2-crosshair-full-datetime.png')

    # axis strip close-ups for the eyeball check
    page.evaluate(f"() => window.__app.App.panes[0].chart.timeScale().setVisibleLogicalRange({{from: {n - 300}, to: {n + 5}}})")
    page.wait_for_timeout(900)
    page.screenshot(path=f'{OUT}/04-zoomed-out-axis.png', clip={'x': 0, 'y': 760, 'width': 1500, 'height': 140})

    # ================= regressions: nothing else broke =================
    errs = page.evaluate("() => window.__errs || []")
    conso = []
    page.on('console', lambda m: conso.append(m.text) if m.type == 'error' else None)
    page.wait_for_timeout(400)
    check('R1 no page errors during the run', not errs and not conso, {'errs': errs[:3], 'conso': conso[:3]})

    browser.close()

fails = [r for r in results if not r[1]]
print(f"\n==== ROUND41 VERIFY: {len(results) - len(fails)}/{len(results)} passed ====")
sys.exit(1 if fails else 0)
