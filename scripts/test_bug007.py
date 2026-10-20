#!/usr/bin/env python3
"""BUG-007 verification: constant ~1.99998 price axis.
Scenarios:
  A) boot EURUSD -> axis span must be realistic (non-degenerate)
  B) stale deep-zoom window (simulating a previous ~2.0-priced symbol,
     e.g. GBPNZD deep-zoomed) -> reproduce degenerate axis
  C) symbol switch -> pz must reset -> axis back to real values (THE FIX)
  D) timeframe switch while deep-zoomed -> pz reset (THE FIX)
  E) sanitizeBars unit checks (bad payloads cleaned, history never reordered)
  F) deep-zoom drag on price axis -> pz.active; dblclick resets (Round-14 intact)
"""
import sys, time, threading, http.server, functools, json, subprocess, signal, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
PORT = 8901
PROV = subprocess.Popen(['python3', os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'provider', 'demo.py')],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
time.sleep(1.5)

def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start()

JS_SPAN = """() => {
  const p = window.__app.App.activePane;
  const h = p.host.clientHeight;
  const p1 = p.series.coordinateToPrice(2);
  const p2 = p.series.coordinateToPrice(Math.max(4, h - 30));
  return {
    pz: JSON.parse(JSON.stringify(p.pz)),
    span: (p1 != null && p2 != null) ? Math.abs(p1 - p2) : null,
    top: p1, bottom: p2,
    sym: p.symbol, digits: p.digits,
    lastClose: p.bars.length ? p.bars[p.bars.length - 1].close : null,
    seriesLast: (p.series.data && p.series.data().length) ? p.series.data()[p.series.data().length - 1].close : null,
    free: window.__app.App.freeTransform,
  };
}"""

results = []
def check(name, ok, info=''):
    results.append((name, ok, info))
    print(('PASS' if ok else 'FAIL'), '-', name, ('| ' + str(info) if info else ''))

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1000)
    pg.click('#card-demo'); pg.click('#login-connect')
    pg.wait_for_timeout(7000)

    # ---------- A) boot: realistic axis ----------
    a = pg.evaluate(JS_SPAN)
    tick = 10 ** -a['digits']
    check('A1 boot EURUSD: pz inactive', a['pz']['active'] == False, a['pz'])
    check('A2 boot EURUSD: axis span realistic', a['span'] is not None and a['span'] > tick * 50,
          f"span={a['span']} tick={tick}")
    check('A3 boot: series/legend agree', abs((a['seriesLast'] or 0) - (a['lastClose'] or 0)) < 1e-9,
          f"series={a['seriesLast']} legend={a['lastClose']}")

    # ---------- B) reproduce: stale pz (previous ~2.0 symbol deep-zoom) ----------
    pg.evaluate("""() => { const p = window.__app.App.activePane;
      p.pz = { active: true, center: 1.99998, span: 1e-5 }; p.chart.priceScale('right').applyOptions({autoScale:true}); }""")
    pg.wait_for_timeout(400)
    c = pg.evaluate(JS_SPAN)
    check('B1 REPRO stale pz: axis degenerate (constant label class)', c['span'] is not None and c['span'] <= 1e-4,
          f"span={c['span']} (labels would all read 1.99998)")

    # ---------- C) THE FIX: symbol switch resets stale window ----------
    pg.evaluate("() => window.__app.Manager.setSymbol(window.__app.App.activePane, 'GBPUSD')")
    pg.wait_for_timeout(4000)
    d = pg.evaluate(JS_SPAN)
    check('C1 after symbol switch: pz inactive', d['pz']['active'] == False, d['pz'])
    check('C2 after switch: axis span realistic again (no constant axis)',
          d['span'] is not None and d['span'] > tick * 50 and d['sym'] == 'GBPUSD',
          f"span={d['span']} sym={d['sym']}")
    check('C3 after switch: series/legend agree',
          abs((d['seriesLast'] or 0) - (d['lastClose'] or 0)) < 1e-9,
          f"series={d['seriesLast']} legend={d['lastClose']}")

    # ---------- D) deep zoom -> timeframe switch resets ----------
    pg.evaluate("() => window.__app.App.activePane.engine.priceZoom(0.01, null)")
    pg.wait_for_timeout(300)
    e1 = pg.evaluate(JS_SPAN)
    check('D1 deep zoom engages pz (Free-Transform path intact)', e1['pz']['active'] == True and e1['free'] == True, e1['pz'])
    pg.evaluate("() => window.__app.Manager.setTf(window.__app.App.activePane, 'M15')")
    pg.wait_for_timeout(4000)
    e2 = pg.evaluate(JS_SPAN)
    check('D2 after TF switch: pz inactive', e2['pz']['active'] == False, e2['pz'])
    check('D3 after TF switch: axis span realistic', e2['span'] is not None and e2['span'] > tick * 50, f"span={e2['span']}")

    # ---------- E) sanitizeBars unit checks ----------
    s = pg.evaluate("""() => {
      const sb = window.__app.Manager.sanitizeBars;
      const bad = [
        { time: 1000, open: 1, high: 2, low: NaN, close: 1.5 },   // non-finite -> dropped
        { time: 900,  open: 1, high: 2, low: 0.5, close: 1.4 },   // older -> dropped (no reorder)
        { time: 1000, open: 1, high: 2.5, low: 0.4, close: 1.6, volume: 5 }, // dup stamp -> merged
        { time: 2000, open: 1.5, high: 2.6, low: 1.2, close: 2.0, volume: 3 }, // kept
        { time: 'x', open: 1, high: 1, low: 1, close: 1 },         // bad time -> dropped
        null,                                                      // dropped
      ];
      const out = sb(bad, 'TEST', 'M5');
      return { n: out.length, t: out.map(b => b.time), last: out[out.length-1] };
    }""")
    check('E1 sanitize: only clean bars kept, dup merged, order kept',
          s['n'] == 3 and s['t'] == [900, 1000, 2000] and s['last']['high'] == 2.6 and s['last']['close'] == 2.0,
          json.dumps(s))
    s2 = pg.evaluate("""() => {
      const sb = window.__app.Manager.sanitizeBars;
      const good = [{ time: 1000, open: 1, high: 2, low: .5, close: 1.5 }];
      const out = sb(good, 'T', 'M5');
      return out.length === 1 && out[0].time === 1000;
    }""")
    check('E2 sanitize: clean payload untouched', s2 == True)

    # ---------- F) price-axis drag + dblclick reset (Round-14 interactions) ----------
    box = pg.evaluate("""() => { const r = document.querySelector('.pane-overlay').getBoundingClientRect();
      return {x: r.x, y: r.y, w: r.width, h: r.height}; }""")
    ax_x = box['x'] + box['w'] - 25
    ax_y = box['y'] + 260
    pg.mouse.move(ax_x, ax_y); pg.mouse.down()
    for i in range(12):
        pg.mouse.move(ax_x, ax_y + i * 5, steps=2); pg.wait_for_timeout(12)
    pg.mouse.up(); pg.wait_for_timeout(400)
    f1 = pg.evaluate(JS_SPAN)
    check('F1 price-axis drag zooms (pz active)', f1['pz']['active'] == True, f1['pz'])
    pg.mouse.dblclick(ax_x, ax_y); pg.wait_for_timeout(500)
    f2 = pg.evaluate(JS_SPAN)
    check('F2 dblclick on axis resets zoom (pz inactive, autoScale back)', f2['pz']['active'] == False, f2['pz'])
    check('F3 no page errors during whole scenario', len(errs) == 0, '; '.join(errs[:3]))

    pg.screenshot(path='/home/z/my-project/download/bug007-after-fix.png')

    # BEFORE screenshot for docs: reproduce stale window once more and capture
    pg.evaluate("""() => { const p = window.__app.App.activePane;
      p.pz = { active: true, center: 1.99998, span: 1e-5 }; p.chart.priceScale('right').applyOptions({autoScale:true}); }""")
    pg.wait_for_timeout(400)
    pg.screenshot(path='/home/z/my-project/download/bug007-before-fix-repro.png')
    b.close()

try: os.killpg(os.getpgid(PROV.pid), signal.SIGTERM)
except Exception: pass

fails = [r for r in results if not r[1]]
print(f"\n==== {len(results) - len(fails)}/{len(results)} passed ====")
sys.exit(1 if fails else 0)
