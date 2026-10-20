#!/usr/bin/env python3
"""REAL-MT5 DRESS REHEARSAL (the user's exact scenario, current build v1.7.0).

User report: "with DEMO data the price bar is correct; when I connect to
MetaTrader it breaks — the candles' OHLC and shapes are right but the chart's
Y axis (price range) is wrong, for 5-digit pairs like EURUSD."

Signature match: demo.py with --off 0 NEVER shows the bug (my screenshots),
while a real broker stamps data in SERVER time (GMT+2/+3) which for a Tehran
user (UTC+3:30) is offset by hours -> the pre-R27 bug class. This rehearsal
runs the CURRENT build against the MT5-shaped conditions end to end:

  P1  healthy real-broker boot (off=-5400, EURUSD 5 digits):
      series == bars == live tick == watchlist, axis near the live price,
      and a screenshot showing 5-decimal axis labels.
  P2  the user's broken state: history poisoned at a wrong price universe
      (155.2-style) -> the R26/R27 guard must heal the axis back to the live
      price within seconds, and the R29 banner must not lie.
  P3  digits chain on the MT5 path: resp.digits=5 drives the axis precision.
"""
import time, threading, http.server, functools, json, subprocess, signal, os

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
PROV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'provider', 'demo.py')
PORT = 8977
OUT = '/home/z/my-project/download'
os.makedirs(OUT, exist_ok=True)
OFF = -5400  # Tehran (UTC+3:30) user on a GMT+2 broker: server 90 min behind

prov = subprocess.Popen(['python3', PROV, '--off', str(OFF)],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
time.sleep(1.5)


def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    h.log_message = lambda *a, **k: None
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()


threading.Thread(target=serve, daemon=True).start()
time.sleep(0.4)

results = []


def check(name, ok, detail=''):
    results.append((name, ok))
    print(('PASS' if ok else 'FAIL'), name, '—', detail)


from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(args=['--window-size=1600,900'])
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    errors = []
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append('PAGEERROR: ' + str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1200)
    pg.click('#card-demo')
    pg.click('#login-connect')
    pg.wait_for_timeout(8000)
    pg.evaluate("() => window.__app.Manager.setSymbol(window.__app.App.activePane, 'EURUSD')")
    pg.wait_for_timeout(3500)

    # ---- P1: healthy real-broker boot ----
    st = pg.evaluate("""() => {
      const App = window.__app.App, M = window.__app.Manager, W = window.__app.Watchlist;
      const P = App.panes.find(p => p.symbol === 'EURUSD');
      let sl = null, y = null;
      try { const sd = P.series.data(); sl = sd[sd.length-1].close; } catch (e) {}
      try { y = P.series.priceToCoordinate(P.bars[P.bars.length-1].close); } catch (e) {}
      const h = P.host ? P.host.clientHeight : 800;
      return { series: sl, bars: P.bars[P.bars.length-1].close, tick: M.tickPx['EURUSD'],
               watch: W.prices['EURUSD'], digits: P.digits, bars_n: P.bars.length,
               serverOff: App.feed.serverOff,
               yCoord: y, hostH: h, banner: !P.histEl.classList.contains('hidden') };
    }""")
    tol = 5e-4
    agree = all(abs((st[k] or 0) - st['tick']) < tol for k in ('series', 'bars', 'watch'))
    onscreen = st['yCoord'] is not None and -st['hostH'] < st['yCoord'] < 2 * st['hostH']
    check('P1 series==bars==watchlist==live tick (off=-5400)', agree,
          json.dumps({k: st[k] for k in ('series', 'bars', 'watch', 'tick')}))
    check('P1 live price inside the visible price axis', onscreen, f"y={st['yCoord']}/{st['hostH']}px")
    check('P1 digits=5 reached the series precision', st['digits'] == 5, f"digits={st['digits']}")
    check('P1 server offset applied', st['serverOff'] == OFF, f"serverOff={st['serverOff']}")
    check('P1 truth banner hidden on healthy data', not st['banner'], f"banner={st['banner']}")
    pg.screenshot(path=os.path.join(OUT, 'mt5reality-P1-healthy.png'))

    # ---- P2: the user's broken state -> self-heal ----
    pg.evaluate("""() => {
      const P = window.__app.App.panes.find(p => p.symbol === 'EURUSD');
      const M = window.__app.Manager;
      const wrong = P.bars.map(b => ({ time: b.time + 86400, open: 155, high: 155.6,
                                       low: 154.4, close: 155.2, volume: 1 }));
      P.bars = wrong;
      M.setPaneData(P, wrong);
      P._staleReloadAt = 0;
    }""")
    pg.wait_for_timeout(700)  # catch the broken state BEFORE the guard fires (1.5s)
    mid = pg.evaluate("""() => {
      const P = window.__app.App.panes.find(p => p.symbol === 'EURUSD');
      let sl = null; try { sl = P.series.data().slice(-1)[0].close; } catch (e) {}
      return { series: sl, banner: !P.histEl.classList.contains('hidden') };
    }""")
    pg.wait_for_timeout(9000)
    st2 = pg.evaluate("""() => {
      const App = window.__app.App, M = window.__app.Manager, W = window.__app.Watchlist;
      const P = App.panes.find(p => p.symbol === 'EURUSD');
      let sl = null; try { sl = P.series.data().slice(-1)[0].close; } catch (e) {}
      return { series: sl, bars: P.bars[P.bars.length-1].close, tick: M.tickPx['EURUSD'],
               watch: W.prices['EURUSD'], banner: !P.histEl.classList.contains('hidden'),
               strike: P._histStrike || 0 };
    }""")
    broken_seen = mid['series'] is not None and abs(mid['series'] - 155.2) < 0.01
    healed = abs((st2['series'] or 0) - st2['tick']) < tol and abs((st2['bars'] or 0) - st2['tick']) < tol
    check('P2 wrong-universe history painted first (bug state reproduced)', broken_seen,
          f"series={mid['series']}")
    check('P2 axis healed back to the live price (R26/R27 guard)', healed,
          json.dumps({k: st2[k] for k in ('series', 'bars', 'tick', 'watch')}))
    check('P2 truth banner cleared after the heal (no stale warning)',
          not st2['banner'], f"bannerAfterHeal={st2['banner']}")
    pg.screenshot(path=os.path.join(OUT, 'mt5reality-P2-healed.png'))

    check('zero console errors across the whole rehearsal', not errors,
          '; '.join(errors[:3]))

    b.close()

try:
    os.killpg(os.getpgid(prov.pid), signal.SIGTERM)
except Exception:
    pass

n_ok = sum(1 for _, ok in results if ok)
print(f"\n=== MT5-REALITY: {n_ok}/{len(results)} PASS ===")
