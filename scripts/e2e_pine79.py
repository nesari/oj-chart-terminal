#!/usr/bin/env python3
"""Round 79 e2e — BUG: Pine boxes "swam" during chart pan and snapped back
into place on release (they were not locked to their bars while dragging).

Root cause: the round-78 perf dirty-check quantized the visible logical
range to INTEGER bar indices (floor/ceil), so a pan only repainted the Pine
canvases when the range crossed a bar boundary — the overlay lagged the
moving chart by up to a full bar width and caught up at tick rate. Free
vertical pan / price-scale margin changes were invisible to the key too.

Fix: the paint key now carries the FRACTIONAL visible range (1e-3 bar) plus
a vertical-mapping fingerprint (y of last close + px distance to close*1.01).

Headless flow (demo provider, ticks muted during measurement):
  boot -> add the REAL 786 Zones -> wait for boxes -> pick a clean box ->
  measure (painted box left edge x) - (model x) DIFFERENTIALLY:
    M0 at rest -> drag RIGHT 44px (5.5 bars) HOLDING -> measure mid-drag
    -> release -> measure -> drag LEFT 76px (9.5 bars) -> measure
    -> restore ticks -> measure
  every sample must stay locked to the bars (|delta| <= 1.5px); on the
  pre-fix build the 0.5-bar fractional remainder shows up as ~4px drift.
  Then a price-scale margin change must also repaint the overlay vertically
  (the painted box top edge must track the new mapping).
Exits 0 only if every check passes with zero page errors.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, 'docs', 'shots-legacy')
FIXTURE = os.path.join(ROOT, 'scripts', 'pine-fixtures', '786-zones.pine')
PORT_HTTP, PORT_WS = 8899, 8777
FAILS = []
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if extra and not cond else ''))
    if not cond:
        FAILS.append(name)

def wait_port(port, timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with socket.create_connection(('127.0.0.1', port), 0.4):
                return True
        except OSError:
            time.sleep(0.2)
    return False

def serve_http():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, 'src'))
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT_HTTP), handler).serve_forever()

PROBE_JS = r"""
() => {
  /* ---- same math as the adapter's _xOf (serverOffSec = 0 on this demo) ---- */
  const pane = window.__pane;
  const times = pane.barTimes;
  const ts = pane.chart.timeScale();
  function logicalOf(tSec) {
    const n = times.length;
    if (!n) return 0;
    if (tSec <= times[0]) { const sp = n > 1 ? times[1] - times[0] : 60; return (tSec - times[0]) / sp; }
    if (tSec >= times[n - 1]) { const sp = n > 1 ? times[n - 1] - times[n - 2] : 60; return (n - 1) + (tSec - times[n - 1]) / sp; }
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= tSec) lo = m; else hi = m; }
    return lo + (tSec - times[lo]) / ((times[hi] - times[lo]) || 1);
  }
  let sp = 8;
  try { sp = ts.options().barSpacing || 8; } catch (e) {}
  const xOfMs = (ms) => {
    const l = logicalOf(ms / 1000);
    const i0 = Math.floor(l);
    const a = ts.logicalToCoordinate(i0);
    if (a == null) return null;
    return a + (l - i0) * sp;
  };

  const cv = pane._pineCanvases && pane._pineCanvases.fg;
  if (!cv) return { error: 'no fg canvas' };
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const row = ctx.getImageData(0, 0, W, H).data; // full scan once per probe call
  const PX = (x, y) => { const i = ((y | 0) * W + (x | 0)) * 4; return (i >= 0 && i + 3 < row.length) ? [row[i], row[i + 1], row[i + 2], row[i + 3]] : [0, 0, 0, 0]; };
  const GREEN = (x, y) => { const p = PX(x, y); return p[3] > 10 && p[1] > 180 && p[0] < 90 && p[2] < 90; }; // the synthetic test box color

  const dbg = window.__app.PineUI.debug(pane) || [];
  const rt = dbg[0] && dbg[0].rt;
  if (!rt) return { error: 'no runtime' };
  const gb = Array.from(rt.store.box.values()).find((o) => o && o.kind === 'box' && o.__testBox);
  if (!gb) return { error: 'no test box in store' };

  const hostW = pane.host.clientWidth, hostH = pane.host.clientHeight;
  const tx = xOfMs(gb.left), tx2 = xOfMs(gb.right);
  if (tx == null || tx2 == null) return { error: 'no model x' };
  let yT = null, yB = null;
  try { yT = pane.series.priceToCoordinate(gb.top); yB = pane.series.priceToCoordinate(gb.bottom); } catch (e) {}
  if (yT == null || yB == null) return { error: 'no model y' };
  const top = Math.min(yT, yB), bot = Math.max(yT, yB);
  const yMid = Math.round((top + bot) / 2);
  if (yMid < 12 || yMid > hostH - 12) return { error: 'test box row off-screen', yMid };
  if (tx < 90 || tx > hostW - 260 || (tx2 - tx) < 40) return { error: 'test box off-screen', tx: Math.round(tx) };

  /* leftmost green pixel of a >=3px run inside [tx-8 .. tx+12] */
  let px = null;
  for (let x = Math.max(0, Math.round(tx) - 8); x <= Math.min(W - 4, Math.round(tx) + 12); x++) {
    if (GREEN(x, yMid) && GREEN(x + 1, yMid) && GREEN(x + 2, yMid)) { px = x; break; }
  }
  if (px == null) return { error: 'test box edge not painted', tx: Math.round(tx), yMid };
  const off = px - tx; // constant border/AA slop cancels differentially
  return { off, truthX: tx, yMid, yTop: top, leftMs: gb.left, boxN: rt.store.count('box'), W, H };
}
"""

VERT_JS = r"""
() => {
  /* painted TOP edge of the test box, as a GREEN column scan around the model y */
  const pane = window.__pane;
  const st = window.__r79box;
  if (!st) return { error: 'no box state' };
  const cv = pane._pineCanvases.fg;
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const col = ctx.getImageData(0, 0, W, H).data;
  const PX = (x, y) => { const i = ((y | 0) * W + (x | 0)) * 4; return (i >= 0 && i + 3 < col.length) ? [col[i], col[i + 1], col[i + 2], col[i + 3]] : [0, 0, 0, 0]; };
  const GREEN = (x, y) => { const p = PX(x, y); return p[3] > 10 && p[1] > 180 && p[0] < 90 && p[2] < 90; };
  const colX = Math.round(st.px) + 6; // just inside the box left edge
  let yM = null;
  try { yM = pane.series.priceToCoordinate(st.top); } catch (e) {}
  if (yM == null) return { error: 'no model y' };
  let py = null;
  for (let y = Math.round(yM) - 8; y <= Math.round(yM) + 14; y++) {
    if (GREEN(colX, y) && GREEN(colX, y + 1) && GREEN(colX, y + 2) && GREEN(colX, y + 3)) { py = y; break; }
  }
  if (py == null) return { error: 'no painted top edge', yM };
  return { py, yM, off: py - yM };
}
"""

INJECT_JS = r"""() => {
  /* inject a synthetic OPAQUE-GREEN test box into the live runtime store.
     Ticks are muted already, so the realtime rollback cannot wipe it; the
     paint key bumps (store.version) and the next frame paints it. Geometry
     is anchored to the CURRENT viewport (fixed y-band via coordinateToPrice
     and recent bar times) so it is always measurable. */
  const pane = window.__pane;
  const dbg = window.__app.PineUI.debug(pane)[0];
  const rt = dbg && dbg.rt;
  if (!rt) return { error: 'no runtime' };
  const n = pane.barTimes.length;
  const c2p = (y) => pane.series.coordinateToPrice(y);
  const o = {
    __pineObj: true, kind: 'box', id: 790001,
    left: pane.barTimes[Math.max(0, n - 80)] * 1000,
    right: pane.barTimes[Math.max(0, n - 40)] * 1000,
    top: c2p(150), bottom: c2p(330),
    xloc: 'bar_time', extend: 'none',
    bgcolor: { css: () => 'rgba(0,220,0,0.85)' },
    border_color: { css: () => 'rgba(0,255,0,1)' },
    border_width: 2, border_style: 'solid',
    text: '', text_size: 'small',
    deleted: false, bornBar: rt.barIndex, __testBox: true,
  };
  rt.store.add('box', o);
  return { id: o.id, top: o.top, bottom: o.bottom, leftMs: o.left };
}"""

MUTE_JS = r"""() => {
  const App = window.__app.App;
  if (!App.feed || !Array.isArray(App.feed.onTick)) return -1;
  if (!window.__savedTicks) { window.__savedTicks = App.feed.onTick.slice(); App.feed.onTick.length = 0; }
  return window.__savedTicks.length;
}"""
UNMUTE_JS = r"""() => {
  const App = window.__app.App;
  if (window.__savedTicks && Array.isArray(App.feed.onTick)) { App.feed.onTick.push(...window.__savedTicks); window.__savedTicks = null; return 1; }
  return 0;
}"""

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py'), '--tick-interval', '1.0'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        assert wait_port(PORT_HTTP) and wait_port(PORT_WS)
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            try:
                b = pw.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                b = pw.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            pg = b.new_page(viewport={'width': 1600, 'height': 900, 'deviceScaleFactor': 1})
            errors = []
            pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
            pg.on('console', lambda m: errors.append('console-error: ' + m.text) if m.type == 'error' else None)

            print('[1] boot + add the REAL 786 Zones')
            pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            pg.wait_for_selector('#login-connect', timeout=15000)
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_selector('#charts-grid canvas', timeout=20000)
            pg.wait_for_timeout(1500)
            pg.evaluate("""() => { const app = window.__app.App; app.setTf && app.setTf('M15'); }""")
            pg.wait_for_timeout(2500)
            src = open(FIXTURE, encoding='utf-8').read()
            added = pg.evaluate("""(src) => {
              const { PineScriptsStore, PineUI } = window.__app;
              const rec = PineScriptsStore.create('786 Zones r79', src);
              const pane = window.__app.App.panes[0];
              window.__pane = pane;
              return !!PineUI.add(pane, rec.id, {});
            }""", src)
            check('instance added', added)

            print('[2] wait for the full pass + boxes on store')
            deadline = time.time() + 90
            st = None
            while time.time() < deadline:
                st = pg.evaluate("""() => {
                  const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
                  return s ? { status: s.status, boxes: s.boxes, bars: s.bars } : null;
                }""")
                if st and st['status'] == 'ok' and st['boxes'] > 0:
                    pg.wait_for_timeout(2500)  # a few realtime ticks settle the drawing set
                    break
                time.sleep(1.2)
            check('runtime ok with boxes drawn', st and st['status'] == 'ok' and st['boxes'] > 0, st)

            print('[2b] widen the visible window (~160 bars @8px) so yesterday\'s session boxes enter the price viewport')
            sp = pg.evaluate("""() => {
              const pane = window.__pane;
              const n = pane.barTimes.length;
              pane.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 150), to: n + 10 });
              return pane.chart.timeScale().options().barSpacing || 8;
            }""")
            pg.wait_for_timeout(900)   # autoscale refit + a few repaint frames
            check('barSpacing near the default', 6 <= sp <= 10, sp)

            print('[3] MUTE ticks + inject the synthetic green test box (deterministic target)')
            muted = pg.evaluate(MUTE_JS)
            check('feed ticks muted', muted and muted > 0, muted)
            inj = pg.evaluate(INJECT_JS)
            check('test box injected', 'id' in inj, inj)
            pg.wait_for_timeout(300)   # a few rAF frames paint the injected box
            probe = pg.evaluate(PROBE_JS)
            check('probe measures the painted test box', 'off' in probe, probe)
            if 'off' not in probe:
                pg.evaluate(UNMUTE_JS)
                b.close()
                print('RESULT: 1 failed (test box not measurable)')
                sys.exit(1)
            off0 = probe['off']
            print(f"    box leftMs={probe['leftMs']} truthX={probe['truthX']:.1f} yMid={probe['yMid']} off={off0}")

            # chart plot center for the drag gestures (away from axes/legend)
            rect = pg.evaluate("""() => {
              const r = window.__pane.host.getBoundingClientRect();
              return { x: r.left + r.width * 0.45, y: r.top + r.height * 0.45 };
            }""")

            def sample(tag):
                r = pg.evaluate(PROBE_JS)
                ok = 'off' in r
                d = (r['off'] - off0) if ok else None
                print(f"    [{tag}] off={r.get('off')} delta={d}")
                return d

            print(f'[4] pan RIGHT {round(5.5 * sp)}px (5.5 bars @ {sp:.1f}px) — HOLD, measure mid-drag')
            panA = round(5.5 * sp)
            pg.mouse.move(rect['x'], rect['y'])
            pg.mouse.down()
            pg.mouse.move(rect['x'] + panA, rect['y'], steps=12)
            pg.wait_for_timeout(150)          # ≥8 rAF frames, button still down
            d_hold = sample('mid-drag hold')
            check('mid-drag: box locked to bars (|Δ| ≤ 1.5px)', d_hold is not None and abs(d_hold) <= 1.5, d_hold)

            print('[5] release -> measure DURING the inertia glide and after it settles')
            pg.mouse.up()
            pg.wait_for_timeout(80)
            d_glide = sample('release +80ms (glide active)')
            check('during glide: box locked to bars (same-frame repaint)', d_glide is not None and abs(d_glide) <= 1.5, d_glide)
            pg.wait_for_timeout(420)
            d_rest = sample('release +500ms (glide settled)')
            check('after release: still locked (no snap-back needed)', d_rest is not None and abs(d_rest) <= 1.5, d_rest)

            print(f'[6] pan RIGHT again {round(8.5 * sp)}px (8.5 more bars — stays older, no clamp) -> measure')
            panB = round(8.5 * sp)
            pg.mouse.move(rect['x'], rect['y'])
            pg.mouse.down()
            pg.mouse.move(rect['x'] + panB, rect['y'], steps=12)
            pg.wait_for_timeout(150)
            pg.mouse.up()
            pg.wait_for_timeout(100)
            d_glide2 = sample('second release +100ms (glide active)')
            check('second glide: still locked', d_glide2 is not None and abs(d_glide2) <= 1.5, d_glide2)
            pg.wait_for_timeout(450)
            d_pan2 = sample('second pan settled')
            check('second pan: still locked', d_pan2 is not None and abs(d_pan2) <= 1.5, d_pan2)
            pg.screenshot(path=os.path.join(SHOTS, 'r79-pan-locked.png'))

            print('[7] vertical lock: price-scale margin change must repaint the overlay')
            probe2 = pg.evaluate(PROBE_JS)   # fresh read: truthX moved with the pans
            check('test box still measurable after pans', 'off' in probe2, probe2)
            if 'off' not in probe2:
                pg.evaluate(UNMUTE_JS)
                b.close()
                print('RESULT: 1 failed (test box not measurable after pans)')
                sys.exit(1)
            pg.evaluate("""(tx) => { window.__r79box = { px: tx, top: null }; }""", probe2['truthX'])
            # top PRICE of the test box (fixed object property — read from the store)
            top_price = pg.evaluate("""() => {
              const rt = window.__app.PineUI.debug(window.__pane)[0].rt;
              const o = Array.from(rt.store.box.values()).find((b) => b && b.__testBox);
              return o ? o.top : null;
            }""")
            check('test box top price available', top_price is not None, top_price)
            pg.evaluate("""(tp) => { window.__r79box.top = tp; }""", top_price)
            v0 = pg.evaluate(VERT_JS)
            check('vertical baseline measured', 'py' in v0, v0)
            pg.evaluate("""() => window.__pane.chart.priceScale('right')
                             .applyOptions({ scaleMargins: { top: 0.30, bottom: 0.30 } })""")
            pg.wait_for_timeout(200)
            v1 = pg.evaluate(VERT_JS)
            dmodel = (v1['yM'] - v0['yM']) if ('py' in v0 and 'yM' in v1) else None
            dpaint = (v1['py'] - v0['py']) if ('py' in v0 and 'py' in v1) else None
            check('model mapping moved', dmodel is not None and abs(dmodel) > 4, (v0, v1))
            check('painted top edge tracked the new mapping (|Δpaint-Δmodel| ≤ 2px)',
                  dpaint is not None and dmodel is not None and abs((dpaint - dmodel)) <= 2,
                  {'dpaint': dpaint, 'dmodel': dmodel})
            pg.evaluate("""() => window.__pane.chart.priceScale('right')
                             .applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } })""")
            pg.wait_for_timeout(200)

            print('[8] unmute ticks -> realtime rollback resumes, script stays healthy')
            pg.evaluate(UNMUTE_JS)
            pg.wait_for_timeout(1500)   # a few ticks: the rollback wipes the test box, script boxes survive
            st2 = pg.evaluate("""() => {
              const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
              return { status: s.status, boxes: s.boxes, labels: s.labels, adds: s.adds };
            }""")
            check('store still healthy after panning (test box rolled back, script boxes alive)',
                  st2['status'] == 'ok' and st2['boxes'] > 0, st2)

            print('[9] final error audit')
            real_errors = [e for e in errors if 'favicon' not in e]
            check('zero page/console errors across the session', not real_errors, real_errors[:5])
            b.close()
    finally:
        prov.terminate()

    print('=' * 40)
    print(f"RESULT: {len(FAILS)} failed" if FAILS else "RESULT: ALL E2E CHECKS PASSED")
    sys.exit(1 if FAILS else 0)

if __name__ == '__main__':
    os.makedirs(SHOTS, exist_ok=True)
    main()
