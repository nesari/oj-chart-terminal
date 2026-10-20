#!/usr/bin/env python3
"""Round-26 E2E: the chart price axis must ALWAYS agree with the Watchlist.

User report (round 26): EURUSD / GBPUSD charts painted ANOTHER price level on
the price axis while the Watchlist showed the correct price. Fix = 4-layer
defense in manager.js (F1 empty-history clear, F2 guard check-0, F3 live-tick
anchor with 2-strike debounce, F4 stuck-loading release).

  0) boot            : chart series/axis == watchlist price for the boot symbol
  A) F1 empty-history: bars provider returns [] after a symbol switch ->
                       the stale series is CLEARED (never masquerades), heals on restore
  B) F2 guard check-0: bars emptied under a live series -> series cleared
  C) F3a reload path : wrong HISTORY (future-dated bars survive ticks) ->
                       live-tick anchor reloads -> axis correct again
  D) F3b refeed path : only the SERIES is poisoned -> re-feed heals
  E) acceptance      : 2x2 layout EURUSD/GBPUSD/XAUUSD/BTCUSD — series, legend,
                       axis position and watchlist row agree on EVERY pane
  F) F4 watchdog     : a leaked loading flag is force-released
  G) no false alarm  : healthy charts emit zero [axis-guard] actions
  H) FULL SWEEP      : EVERY provider symbol — chart series/legend/axis must
                       equal the watchlist price of that symbol (user asked
                       "تمام نماد ها رو چک کن" — all symbols, not just EUR/GBP)

Probe note (test-side hardening, like the R25-D pill probe): ticks arrive
every 200ms (provider tick_loop) while the watchlist row renderer is a
400ms dirty-row BATCH (round-17 design) — the RENDERED text therefore
legitimately trails the live tick by one tick most of the time, so a
direct text-vs-tickPx comparison would flake. The probe instead (a)
compares Watchlist.prices (written in the SAME synchronous tick dispatch
as Manager.tickPx) with the tick exactly, and (b) flushes the row through
the app's OWN renderer (Watchlist.updateRow — the very function the 400ms
interval calls) and requires the rendered text to equal the store exactly.
Row liveness of the batch renderer itself is covered by test_bug004_013.
"""
import sys, time, threading, http.server, functools, json, subprocess, signal, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'src')
PORT = 8944
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

# JS: full health probe of one pane vs the live tick (the watchlist's number).
# Flushes the watchlist row with the app's own renderer — see module docstring.
PROBE = """(sym) => {
  const App = window.__app.App, M = window.__app.Manager, W = window.__app.Watchlist;
  const P = App.panes.find(p => p.symbol === sym) || App.activePane;
  const dg = P.digits || 5, point = Math.pow(10, -dg);
  const px = M.tickPx[sym], pxAt = M.lastTickAt[sym];
  const store = W.prices[sym] != null ? W.prices[sym] : null;
  const row = [...document.querySelectorAll('.wl-row')].find(r => r.dataset.sym === sym);
  const hasRow = !!row;
  // force-flush the row through the app's own renderer (the 400ms batch
  // interval calls exactly this) so the text reflects the store, not a
  // documented one-tick batch lag
  if (hasRow && W.updateRow) { try { W.updateRow(sym); } catch (e) {} }
  const txt = hasRow ? (((row.querySelector('.wl-price') || {}).textContent) || '') : null;
  const dom = txt != null ? parseFloat(txt.replace(/,/g, '')) : null;
  let sl = null;
  try { const sd = P.series.data ? P.series.data() : null;
        if (sd && sd.length) sl = sd[sd.length-1].close != null ? sd[sd.length-1].close : sd[sd.length-1].value; } catch (e) {}
  const bl = P.bars.length ? P.bars[P.bars.length-1].close : null;
  const tol = Math.max(point * 2, (px || 0) * 1e-4);
  let y = null; try { y = P.series.priceToCoordinate(px); } catch (e) {}
  return { sym, px, fresh: pxAt && (Date.now()/1000 - pxAt) <= 90,
           sl, bl, seriesOk: sl != null && px != null && Math.abs(sl - px) <= tol,
           legendOk: bl != null && px != null && Math.abs(bl - px) <= tol,
           agree: sl != null && bl != null && Math.abs(sl - bl) <= point / 2,
           axisOk: y != null && isFinite(y) && y >= 0 && y <= P.host.clientHeight,
           wlStoreOk: store != null && px != null && Math.abs(store - px) <= point / 2,
           wlDomOk: !hasRow ? null : (dom != null && store != null && Math.abs(dom - store) <= point / 2),
           nBars: P.bars.length, y, h: P.host.clientHeight };
}"""

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

    def wcount(needle):
        return sum(1 for w in warns if needle in w)

    # ================= 0) boot: chart == watchlist =================
    r0 = pg.evaluate(PROBE, 'EURUSD')
    check('0 boot: series==tick, legend==tick, axis in view, watchlist==tick',
          r0['seriesOk'] and r0['legendOk'] and r0['axisOk'] and r0['wlStoreOk'] and r0['wlDomOk'] is True and r0['fresh'],
          json.dumps(r0))

    # ================= A) F1: empty history after symbol switch =================
    pg.evaluate("""() => {
      const F = window.__app.App.feed;
      F.__realBars = F.bars;
      F.bars = (symbol, tf, count) => Promise.resolve({ symbol, timeframe: tf, digits: 5, bars: [] });
    }""")
    pg.evaluate("() => window.__app.Manager.setSymbol(window.__app.App.activePane, 'GBPUSD')")
    pg.wait_for_timeout(9000)  # 4 retries x 1.5s + margin
    a = pg.evaluate("""() => {
      const P = window.__app.App.activePane, M = window.__app.Manager;
      let n = -1; try { const sd = P.series.data ? P.series.data() : null; n = sd ? sd.length : 0; } catch (e) {}
      return { sym: P.symbol, bars: P.bars.length, seriesN: n,
               wlPx: M.tickPx['GBPUSD'] || 0 };
    }""")
    check('A1 empty history: stale EURUSD series CLEARED (no wrong axis)', a['sym'] == 'GBPUSD' and a['bars'] == 0 and a['seriesN'] == 0, json.dumps(a))
    check('A2 watchlist kept ticking during the empty window', a['wlPx'] > 0, a['wlPx'])
    pg.evaluate("() => { const F = window.__app.App.feed; F.bars = F.__realBars; delete F.__realBars; }")
    pg.evaluate("() => window.__app.Manager.loadBars(window.__app.App.activePane)")
    pg.wait_for_timeout(2500)
    ra = pg.evaluate(PROBE, 'GBPUSD')
    check('A3 heals on restore: series==tick & axis in view (GBPUSD)', ra['seriesOk'] and ra['axisOk'] and ra['legendOk'], json.dumps(ra))

    # ================= B) F2: guard check-0 (bars emptied under a live series) =====
    pg.evaluate("""() => {
      const P = window.__app.App.activePane, F = window.__app.App.feed;
      F.__realBars2 = F.bars;
      F.bars = (symbol, tf, count) => Promise.resolve({ symbol, timeframe: tf, digits: 5, bars: [] });
      P._staleReloadAt = Date.now();      // freeze tick-driven reloads for 30s
      P.bars = []; P.barTimes = [];       // the pathological state
    }""")
    before_b = wcount('axis-guard')
    pg.wait_for_timeout(4000)  # >= 2 guard cycles
    bb = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      let n = -1; try { const sd = P.series.data ? P.series.data() : null; n = sd ? sd.length : 0; } catch (e) {}
      return { seriesN: n };
    }""")
    check('B guard check-0: series cleared while bars empty',
          bb['seriesN'] == 0 and wcount('axis-guard') > before_b, json.dumps(bb))
    pg.evaluate("""() => {
      const F = window.__app.App.feed; F.bars = F.__realBars2; delete F.__realBars2;
      window.__app.Manager.loadBars(window.__app.App.activePane);
    }""")
    pg.wait_for_timeout(2500)

    # ================= C) F3a: wrong HISTORY (future-dated) -> live-tick reload ====
    pg.evaluate("() => window.__app.Manager.setSymbol(window.__app.App.activePane, 'EURUSD')")
    pg.wait_for_timeout(2500)
    pg.evaluate("""() => {
      const P = window.__app.App.activePane, M = window.__app.Manager;
      // future-dated wrong-level bars: ticks land BEFORE the last bar and are
      // dropped (changed=null) -> bars stay wrong -> only the live-tick anchor sees it
      const wrong = P.bars.map(b => ({ time: b.time + 86400, open: 155, high: 155.6, low: 154.4, close: 155.2, volume: 1 }));
      P.bars = wrong;
      window.__app.Manager.setPaneData(P, wrong);
      P._staleReloadAt = 0;               // allow the guard to schedule the reload now
    }""")
    before_c = wcount('reloading history')
    pg.wait_for_timeout(8000)  # 2 strikes (3s) + reload + settle
    rc = pg.evaluate(PROBE, 'EURUSD')
    check('C live-tick anchor: wrong history auto-reloaded, chart==watchlist',
          rc['seriesOk'] and rc['legendOk'] and rc['axisOk'],
          json.dumps(rc))
    check('C2 the reload was logged by the guard', wcount('reloading history') > before_c, f"warns={wcount('reloading history')}")

    # ================= D) only the series poisoned -> re-feed ======================
    pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      const wrong = P.bars.map(b => ({ time: b.time, open: 155, high: 155.6, low: 154.4, close: 155.2, volume: 1 }));
      window.__app.Manager.setPaneData(P, wrong);   // series wrong, pane.bars stays correct
    }""")
    pg.wait_for_timeout(5000)
    rd = pg.evaluate(PROBE, 'EURUSD')
    check('D series-only poison: re-fed from bars, chart==watchlist',
          rd['seriesOk'] and rd['agree'], json.dumps(rd))

    # ================= E) acceptance: 2x2 layout, four symbols at once ============
    pg.evaluate("""() => {
      const M = window.__app.Manager, App = window.__app.App;
      M.setLayout('4', false);
    }""")
    pg.wait_for_timeout(1500)
    pg.evaluate("""() => {
      const M = window.__app.Manager, App = window.__app.App;
      const syms = ['EURUSD', 'GBPUSD', 'XAUUSD', 'BTCUSD'];
      App.panes.forEach((p, i) => M.setSymbol(p, syms[i]));
    }""")
    pg.wait_for_timeout(6000)  # all four loads + ticks
    sweep = {}
    for s in ('EURUSD', 'GBPUSD', 'XAUUSD', 'BTCUSD'):
        sweep[s] = pg.evaluate(PROBE, s)
    ok_e = all(v['seriesOk'] and v['legendOk'] and v['axisOk'] and v['wlStoreOk'] and v['wlDomOk'] is True and v['agree'] and v['fresh'] for v in sweep.values())
    check('E ALL symbols: series+legend+axis+watchlist agree on every pane', ok_e,
          json.dumps({k: {kk: (round(vv, 5) if isinstance(vv, float) else vv) for kk, vv in v.items()} for k, v in sweep.items()}))
    pg.screenshot(path=f'{OUT}/r26-2x2-all-symbols.png')

    # ================= H) FULL SWEEP: every provider symbol =======================
    # The user: "تمام نماد ها رو چک کن" — walk EVERY symbol the provider serves,
    # one chart pane at a time, and demand chart series/legend/axis == the
    # watchlist-side price for that symbol.
    pg.evaluate("() => window.__app.Manager.setLayout('1', false)")
    pg.wait_for_timeout(1200)
    syms = pg.evaluate("() => window.__app.App.feed.search('').then(r => r.symbols)")  # ROUND36: {symbols,total}
    syms = list(dict.fromkeys(syms or []))  # dedupe, keep order
    bad = []
    for i, s in enumerate(syms):
        pg.evaluate("(s) => window.__app.Manager.setSymbol(window.__app.App.activePane, s)", s)
        pg.wait_for_timeout(1600 if i == 0 else 1100)
        r = pg.evaluate(PROBE, s)
        ok = (r['seriesOk'] and r['legendOk'] and r['axisOk'] and r['agree'] and r['fresh']
              and r['wlStoreOk'] and r['wlDomOk'] is not False)
        if not ok:
            bad.append({k: (round(v, 6) if isinstance(v, float) else v)
                        for k, v in r.items()
                        if k in ('sym', 'px', 'sl', 'bl', 'seriesOk', 'legendOk', 'axisOk',
                                 'agree', 'fresh', 'wlStoreOk', 'wlDomOk', 'nBars')})
    check(f'H FULL SWEEP: all {len(syms)} symbols — chart == watchlist everywhere',
          len(syms) >= 30 and not bad, (json.dumps(bad[:3]) if bad else f'{len(syms)} symbols OK'))

    # ================= F) F4: stuck loading flag released =========================
    pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      P.loading = true; P._loadStartedAt = Date.now() - 61000;
    }""")
    pg.wait_for_timeout(2500)
    rf = pg.evaluate("() => window.__app.App.activePane.loading")
    check('F stuck-loading watchdog released the flag', rf is False, f"loading={rf}")

    # ================= G) quiet window: zero guard actions on healthy charts ======
    before_g = wcount('axis-guard')
    pg.wait_for_timeout(6000)
    check('G healthy charts: zero [axis-guard] actions in 6s', wcount('axis-guard') == before_g,
          f"actions={wcount('axis-guard') - before_g}")

    pg.evaluate("() => window.__app.Manager.setLayout('1', false)")
    pg.wait_for_timeout(1200)
    pg.screenshot(path=f'{OUT}/r26-final-state.png')

    b.close()

try:
    os.killpg(os.getpgid(PROV.pid), signal.SIGTERM)
except Exception:
    pass

fails = [r for r in results if not r[1]]
print(f"PAGEERRORS: {len(errs)}")
for e in errs[:10]:
    print('  -', e[:200])
print(f"ROUND26 SUITE: {len(results) - len(fails)}/{len(results)} PASS")
sys.exit(1 if fails or errs else 0)
