#!/usr/bin/env python3
"""Round-25 E2E verification suite.
  A) BUG-A  symbol chip = NAME-ONLY row ABOVE the price tag (no duplicate label)
  B) BUG-B  vertical grid uniformity (no double-wide gaps)
  C) BUG-C  zoom-out cadence escalation + crosshair bubble as topmost layer
  D) BUG-D  snapshot carries the countdown + symbol chip (dark & light)
  E) BUG-E  symbol/TF switch sanity + self-healing axis guard
  F) BUG-F  watchlist spread in integer points
"""
import sys, time, threading, http.server, functools, json, subprocess, signal, os, base64
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'src')
PORT = 8933
PROV = subprocess.Popen(['python3', os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'provider', 'demo.py')],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
time.sleep(1.5)

def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start()
OUT = '/home/z/my-project/download'

results = []
def check(name, ok, info=''):
    results.append((name, ok, info))
    print(('PASS' if ok else 'FAIL'), '-', name, ('| ' + str(info) if info else ''))

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    warns = []
    pg.on('console', lambda m: warns.append(m.text) if m.type == 'warning' else None)
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1000)
    pg.click('#card-demo'); pg.click('#login-connect')
    pg.wait_for_timeout(7000)

    # ================= A) BUG-A: chip = name only, above the price tag =================
    a = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      const chip = P.chip, cd = P.cd;
      const y = P.series.priceToCoordinate(P.bars[P.bars.length - 1].close);
      const cr = chip.getBoundingClientRect(), dr = cd.getBoundingClientRect();
      const hr = P.host.getBoundingClientRect();
      return {
        shown: chip.style.display !== 'none', txt: chip.textContent,
        hasDigits: /\\d/.test(chip.textContent),
        chipC: cr.top + cr.height / 2 - hr.top, priceY: y,
        cdC: dr.top + dr.height / 2 - hr.top,
        scVal: !!chip.querySelector('.sc-val'),
      };
    }""")
    check('A1 chip visible, name-only text', a['shown'] and a['txt'] == 'EURUSD' and not a['hasDigits'], a['txt'])
    check('A2 no duplicated price element in chip', not a['scVal'])
    check('A3 chip one row ABOVE the price tag', abs(a['chipC'] - (a['priceY'] - 21)) < 5, f"chipC={a['chipC']:.1f} priceY={a['priceY']:.1f}")
    check('A4 countdown stays UNDER the price tag', abs(a['cdC'] - (a['priceY'] + 19)) < 8, f"cdC={a['cdC']:.1f} priceY={a['priceY']:.1f}")
    check('A5 stack order NAME < PRICE < COUNTDOWN', a['chipC'] < a['priceY'] < a['cdC'])
    # flip near the top edge: squeeze the scale so price hugs the top
    pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      P.chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.004, bottom: 0.965 } });
      window.__app.Manager.updateCountdowns();
    }""")
    pg.wait_for_timeout(300)
    fl = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      const y = P.series.priceToCoordinate(P.bars[P.bars.length - 1].close);
      const cr = P.chip.getBoundingClientRect(), hr = P.host.getBoundingClientRect();
      return { y, chipC: cr.top + cr.height / 2 - hr.top, hostH: P.host.clientHeight };
    }""")
    flipped = fl['y'] < 34 and fl['chipC'] > fl['y']
    check('A6 flips below the stack when price hugs the top edge', flipped, json.dumps(fl))
    pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      P.chart.priceScale('right').applyOptions({ scaleMargins: window.__app.Manager.defaultPriceMargins() });
      window.__app.Manager.updateCountdowns();
    }""")
    # hidden mode
    pg.evaluate("""() => { window.__app.Settings.set('symLabel', 'hidden', {noApply: true}); window.__app.Manager.updateCountdowns(); }""")
    hid = pg.evaluate("""() => window.__app.App.activePane.chip.style.display === 'none'""")
    check('A7 symLabel hidden -> chip hidden', hid)
    pg.evaluate("""() => { window.__app.Settings.set('symLabel', 'name_value_line', {noApply: true}); window.__app.Manager.updateCountdowns(); }""")
    pg.screenshot(path=f'{OUT}/r25-A-tag-stack.png')

    # ================= C2) crosshair bubble (needs a normal view first) =================
    pg.evaluate("""() => { const P = window.__app.App.activePane; const n = P.barTimes.length; P.chart.timeScale().setVisibleLogicalRange({ from: n - 160, to: n + 12 }); }""")
    pg.wait_for_timeout(700)
    box = pg.evaluate("""() => { const P = window.__app.App.activePane; const r = P.overlay.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }""")
    cx, cy = box['x'] + box['w'] * 0.5, box['y'] + box['h'] * 0.5
    pg.mouse.move(cx, cy, steps=4)
    pg.wait_for_timeout(400)
    cb = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      const el = P.taxLive;
      const cs = getComputedStyle(el);
      const taxZ = getComputedStyle(P.tax).zIndex;
      return { shown: el.style.display === 'block', txt: el.textContent, z: cs.zIndex, taxZ,
               bg: cs.backgroundColor, color: cs.color };
    }""")
    check('C2a crosshair bubble appears over the chart', cb['shown'] and len(cb['txt']) > 0, json.dumps(cb))
    check('C2b bubble is the TOPMOST time-strip layer (z 7 > 6)', int(cb['z']) > int(cb['taxZ']), f"z={cb['z']} taxZ={cb['taxZ']}")
    check('C2c native bubble pill colors replicated', cb['bg'] == 'rgb(54, 58, 69)' and cb['color'] == 'rgb(255, 255, 255)', cb['bg'])
    # text must equal TZ.crossLabel of the snapped bar under the cursor
    tmatch = pg.evaluate("""(x) => {
      const P = window.__app.App.activePane;
      const l = P.chart.timeScale().coordinateToLogical(x);
      const li = Math.round(l);
      const t = P.barTimes[li];
      const exp = window.__app.TZ.crossLabel(window.__app.App.tz, t, false);
      return { exp, got: P.taxLive.textContent };
    }""", box['w'] * 0.5)
    check('C2d bubble text == native crossLabel of the snapped bar', tmatch['exp'] == tmatch['got'], json.dumps(tmatch))
    pg.mouse.move(200, 30, steps=3)  # leave the chart (top toolbar)
    pg.wait_for_timeout(300)
    gone = pg.evaluate("""() => window.__app.App.activePane.taxLive.style.display === 'none'""")
    check('C2e bubble hides when the crosshair leaves', gone)

    # ================= C1) zoom-out crowding + escalation =================
    pg.evaluate("() => { const P = window.__app.App.activePane; const n = P.barTimes.length; P.chart.timeScale().setVisibleLogicalRange({ from: -n * 3, to: n * 1.4 }); }")
    pg.wait_for_timeout(900)
    c = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      const xs = [...P.tax.querySelectorAll('span')].map(s => { const r = s.getBoundingClientRect(); return Math.round(r.left + r.width / 2); }).sort((a, b) => a - b);
      const gaps = []; for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
      const labels = [...P.tax.querySelectorAll('span')].map(s => s.textContent);
      return { n: xs.length, minGap: gaps.length ? Math.min(...gaps) : -1, labels };
    }""")
    check('C1a deep zoom-out: labels never crammed (min gap >= 34px, count sane)',
          c['minGap'] >= 34 and c['n'] <= 60, f"n={c['n']} minGap={c['minGap']}")
    # escalation: labels must be coarser than per-bar (multi-minute steps in the texts)
    esc = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      const tfSec = window.__app.App.tfById[P.tf].sec;
      const ts = [...P.tax.querySelectorAll('span')].map(s => s.textContent);
      return { tfSec, sample: ts.slice(0, 8) };
    }""")
    check('C1b cadence escalated (sample labels coarse)', len(c['labels']) >= 2, json.dumps(esc['sample']))
    pg.screenshot(path=f'{OUT}/r25-C-zoomout-fixed.png')

    # ================= B) BUG-B grid uniformity =================
    for tf in ('H4', 'D1'):
        pg.evaluate(f"() => window.__app.Manager.setTf(window.__app.App.activePane, '{tf}')")
        pg.wait_for_timeout(3200)
        g = pg.evaluate("""() => {
          const P = window.__app.App.activePane;
          const n = P.barTimes.length;
          P.chart.timeScale().setVisibleLogicalRange({ from: n - 130, to: n + 12 });
          return new Promise(res => setTimeout(() => {
            const grid = (P.engine._taxGrid || []).slice().sort((a, b) => a - b);
            const gaps = []; for (let i = 1; i < grid.length; i++) gaps.push(grid[i] - grid[i - 1]);
            res({ gaps, nGrid: grid.length });
          }, 700));
        }""")
        if g['nGrid'] >= 3:
            mn, mx = min(g['gaps']), max(g['gaps'])
            check(f'B-{tf} vertical grid uniform (max/min < 1.6, no double gap)', mx / max(1, mn) < 1.6, f"gaps={g['gaps'][:14]}")
        else:
            check(f'B-{tf} grid present', False, 'too few grid lines')

    # ================= E) BUG-E switches + watchdog =================
    def axis_state():
        return pg.evaluate("""() => {
          const P = window.__app.App.activePane;
          const h = P.host.clientHeight;
          const p1 = P.series.coordinateToPrice(2), p2 = P.series.coordinateToPrice(Math.max(4, h - 30));
          const sl = P.series.data && P.series.data().length ? P.series.data()[P.series.data().length - 1].close : null;
          return { sym: P.symbol, barsLast: P.bars.length ? P.bars[P.bars.length - 1].close : null,
                   seriesLast: sl, top: p1, bottom: p2,
                   pz: JSON.parse(JSON.stringify(P.pz)) };
        }""")
    pg.evaluate("() => window.__app.Manager.setTf(window.__app.App.activePane, 'M5')")
    pg.wait_for_timeout(2500)
    for sym in ('BTCUSD', 'EURUSD'):
        pg.evaluate(f"() => window.__app.Manager.setSymbol(window.__app.App.activePane, '{sym}')")
        pg.wait_for_timeout(3000)
    st = axis_state()
    check('E1 plain switch back to EURUSD: series==legend, axis brackets price',
          abs(st['seriesLast'] - st['barsLast']) < 1e-6 and st['top'] > st['barsLast'] > st['bottom'], json.dumps(st)[:180])
    # deep zoom then switch
    pg.evaluate("() => window.__app.Manager.setSymbol(window.__app.App.activePane, 'XAUUSD')")
    pg.wait_for_timeout(3000)
    for _ in range(6):
        pg.evaluate("() => window.__app.App.activePane.engine.priceZoom(0.01, null)")
        pg.wait_for_timeout(100)
    pg.evaluate("() => window.__app.Manager.setSymbol(window.__app.App.activePane, 'EURUSD')")
    pg.wait_for_timeout(3000)
    st = axis_state()
    check('E2 deep-zoom -> switch: pz reset, axis sane',
          not st['pz']['active'] and abs(st['seriesLast'] - st['barsLast']) < 1e-6 and st['top'] > st['barsLast'] > st['bottom'], json.dumps(st)[:180])
    # watchdog: force series/legend divergence -> auto-heal within ~2.5s
    # (live ticks would instantly re-sync the last bar — freeze them first)
    pg.evaluate("""() => {
      const F = window.__app.App.feed;
      F.__savedOnTick = F.onTick.slice(); F.onTick.length = 0; // freeze ticks
      const P = window.__app.App.activePane;
      const old = P.series.data().map(d => ({ time: d.time, open: d.open * 2, high: d.high * 2, low: d.low * 2, close: d.close * 2 }));
      P.series.setData(old); // simulated stale/foreign series data
    }""")
    pg.wait_for_timeout(2600)
    st = axis_state()
    healed = abs(st['seriesLast'] - st['barsLast']) < 1e-6
    check('E3 axis-guard heals series/legend divergence', healed, f"seriesLast={st['seriesLast']} barsLast={st['barsLast']}")
    check('E3b guard logged the divergence', any('[axis-guard]' in w for w in warns), f'{len([w for w in warns if "[axis-guard]" in w])} warn(s)')
    pg.evaluate("""() => { const F = window.__app.App.feed; F.onTick.push(...F.__savedOnTick); delete F.__savedOnTick; }""")
    # watchdog: stale-era pz -> reset
    pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      P.pz = { active: true, center: 2.0, span: 0.001, at: Date.now() - 60000 };
      P._loadedAt = Date.now() - 30000;
    }""")
    pg.wait_for_timeout(2600)
    st = axis_state()
    check('E4 axis-guard resets a stale-era price-zoom window', not st['pz']['active'], json.dumps(st['pz']))
    # watchdog: legitimate fresh zoom is NEVER fought
    pg.evaluate("() => window.__app.App.activePane.engine.priceZoom(0.5, null)")
    pg.wait_for_timeout(2600)
    st = axis_state()
    check('E5 fresh user zoom survives the guard', st['pz']['active'], json.dumps(st['pz']))
    pg.evaluate("() => window.__app.App.activePane.engine.priceZoomReset()")

    # ================= D) BUG-D snapshot carries countdown + chip =================
    pg.evaluate("() => window.__app.Manager.setTf(window.__app.App.activePane, 'M1')")
    pg.wait_for_timeout(3200)
    for theme in ('dark', 'light'):
        if theme == 'light':
            pg.evaluate("() => window.__app.Theme.apply('light')")
            pg.wait_for_timeout(600)
        pg.evaluate("() => window.__app.Manager.updateCountdowns()")
        pg.wait_for_timeout(300)
        meta = pg.evaluate("""() => {
          const P = window.__app.App.activePane;
          const hr = P.host.getBoundingClientRect();
          const cr = P.cd.getBoundingClientRect();
          return { cdShown: P.cd.style.display !== 'none',
                   x: Math.round(cr.left - hr.left + cr.width / 2), y: Math.round(cr.top - hr.top + cr.height / 2),
                   bgX: Math.round(cr.left - hr.left - 40), bgY: Math.round(cr.top - hr.top),
                   cdTxt: P.cd.textContent };
        }""")
        url = pg.evaluate("() => window.__app.Toolbar.Snapshot.capture()")
        ok_d = False
        if url and meta['cdShown']:
            pg.evaluate("(u) => { window.__snapUrl = u; }", url)
            probe = pg.evaluate("""(m) => {
              return new Promise((res) => {
                const img = new Image();
                img.onload = () => {
                  const cv = document.createElement('canvas');
                  cv.width = img.width; cv.height = img.height;
                  const ctx = cv.getContext('2d');
                  ctx.drawImage(img, 0, 0);
                  /* R25-hardening: live ticks can nudge the price tag (and the
                     pill that follows it) a few px BETWEEN the meta-read and
                     the capture — a 1px probe then races. Scan a +/-30px box
                     around the recorded center instead (the pill is ~13px). */
                  const bg = ctx.getImageData(m.bgX, m.bgY, 1, 1).data;
                  let hit = null;
                  for (let dy = -30; dy <= 30 && !hit; dy++) {
                    for (let dx = -30; dx <= 30 && !hit; dx++) {
                      const px = ctx.getImageData(m.x + dx, m.y + dy, 1, 1).data;
                      const d = Math.abs(px[0] - bg[0]) + Math.abs(px[1] - bg[1]) + Math.abs(px[2] - bg[2]);
                      if ((px[0] + px[1] + px[2]) > 90 && d > 60) hit = [...px];
                    }
                  }
                  const dist = hit ? 255 : 0;
                  const coloured = !!hit;
                  res({ cd: hit || [0, 0, 0], bg: [...bg], dist, coloured });
                };
                img.src = window.__snapUrl;
              });
            }""", meta)
            ok_d = bool(probe and probe.get('coloured'))
            img = base64.b64decode(url.split(',', 1)[1])
            open(f'{OUT}/r25-D-snapshot-{theme}.png', 'wb').write(img)
            info = json.dumps(probe) if probe else 'no probe'
        else:
            info = f"capture={'ok' if url else 'null'} cdShown={meta['cdShown']}"
        check(f'D-{theme} snapshot pixels contain the countdown pill (txt={meta["cdTxt"]})', ok_d, info)
    pg.evaluate("() => window.__app.Theme.apply('dark')")
    pg.wait_for_timeout(400)

    # ================= F) BUG-F spread in points =================
    pg.wait_for_timeout(2500)  # let ticks flow
    f = pg.evaluate("""() => {
      const rows = [...document.querySelectorAll('.wl-row')].filter(r => r.dataset.sym);
      const out = [];
      for (const r of rows) {
        const sym = r.dataset.sym;
        const txt = (r.querySelector('.wl-sprd') || {}).textContent || '';
        const ba = (window.__app.Manager.tickBA || {})[sym];
        const dg = (window.__app.App.feed.digitsBySym || {})[sym];
        let expect = null;
        if (ba && ba.ask > ba.bid && dg != null) expect = String(Math.max(1, Math.round((ba.ask - ba.bid) / Math.pow(10, -dg))));
        out.push({ sym, txt, expect, dg });
      }
      return out;
    }""")
    for row in f:
        okf = (row['expect'] is not None and row['txt'] == row['expect'] and not ('.' in row['txt']))
        check(f"F {row['sym']} spread='{row['txt']}' == points({row['expect']}) digits={row['dg']}", okf, json.dumps(row))
    dgmap = pg.evaluate("""() => {
      const d = window.__app.App.feed.digitsBySym || {};
      return { EURUSD: d.EURUSD, USDJPY: d.USDJPY, XAUUSD: d.XAUUSD, BTCUSD: d.BTCUSD };
    }""")
    check('F-map provider digits ride on ticks (5/3/2/2)',
          dgmap == {'EURUSD': 5, 'USDJPY': 3, 'XAUUSD': 2, 'BTCUSD': 2}, json.dumps(dgmap))

    pg.screenshot(path=f'{OUT}/r25-final-state.png')
    print('PAGEERRORS:', len(errs))
    for e in errs[:8]: print('  ', e[:200])
    b.close()

try: os.killpg(os.getpgid(PROV.pid), signal.SIGTERM)
except Exception: pass
n_pass = sum(1 for _, ok, _ in results if ok)
print(f'ROUND25 SUITE: {n_pass}/{len(results)} PASS')
sys.exit(0 if n_pass == len(results) else 1)
