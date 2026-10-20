#!/usr/bin/env python3
"""DECISIVE EXPERIMENT: does the R26 live-tick anchor (F3) survive a real
broker server-tz offset?

demo.py --off X stamps ticks at (local_epoch + X) — exactly like mt5.py
stamps them at server_now(). A Tehran (UTC+3:30) user on a GMT+2 broker has
server 90 minutes BEHIND local  =>  --off -5400.

Then reproduce test_round26 section C (future-dated wrong-level history on
EURUSD — the real-broker class the user reported: axis wrong, watchlist right)
and check whether the guard heals it.

Control run: off=0 (what the R26 test suite used) -> expected to heal.
"""
import sys, time, threading, http.server, functools, json, subprocess, signal, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
PROV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'provider', 'demo.py')
PORT = 8966
OUT = '/home/z/my-project/download'

def run_case(off, tag):
    prov = subprocess.Popen(['python3', PROV, '--off', str(off)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
    time.sleep(1.5)
    def serve():
        h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
        httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
        httpd.serve_forever()
    threading.Thread(target=serve, daemon=True).start()
    time.sleep(0.4)

    warns = []
    print(f'\n===== CASE {tag}: off={off} =====')
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--window-size=1600,900'])
        pg = b.new_page(viewport={'width': 1600, 'height': 900})
        pg.on('console', lambda m: warns.append(m.text) if m.type == 'warning' else None)
        pg.on('pageerror', lambda e: warns.append('PAGEERROR: ' + str(e)))
        pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
        pg.wait_for_timeout(1200)
        pg.click('#card-demo'); pg.click('#login-connect')
        pg.wait_for_timeout(8000)
        # switch to EURUSD and let it settle
        pg.evaluate("() => window.__app.Manager.setSymbol(window.__app.App.activePane, 'EURUSD')")
        pg.wait_for_timeout(3000)

        # F3 liveness: how does the guard's freshness check see the tick?
        liv = pg.evaluate("""() => {
          const M = window.__app.Manager;
          const pxAt = M.lastTickAt['EURUSD'] || 0;
          const nowS = Date.now() / 1000;
          return { pxAt, nowS, skew: Math.round(nowS - pxAt), f3alive: (nowS - pxAt) <= 90 };
        }""")
        print('F3 LIVENESS:', json.dumps(liv))

        # section-C poison: future-dated wrong-level history (axis wrong, watchlist right)
        pg.evaluate("""() => {
          const P = window.__app.App.activePane, M = window.__app.Manager;
          const wrong = P.bars.map(b => ({ time: b.time + 86400, open: 155, high: 155.6, low: 154.4, close: 155.2, volume: 1 }));
          P.bars = wrong;
          window.__app.Manager.setPaneData(P, wrong);
          P._staleReloadAt = 0;
        }""")
        pg.wait_for_timeout(10000)  # 2 strikes (3s) + reload + settle
        st = pg.evaluate("""() => {
          const App = window.__app.App, M = window.__app.Manager, W = window.__app.Watchlist;
          const P = App.panes.find(p => p.symbol === 'EURUSD');
          let sl = null;
          try { const sd = P.series.data(); sl = sd[sd.length-1].close; } catch (e) {}
          return { seriesLast: sl, barsLast: P.bars[P.bars.length-1].close,
                   watch: W.prices['EURUSD'], tick: M.tickPx['EURUSD'] };
        }""")
        healed = abs((st['seriesLast'] or 0) - (st['tick'] or 0)) < 0.01
        print('AFTER POISON:', json.dumps(st))
        print(f'RESULT [{tag}]:', 'HEALED (axis back to live price)' if healed
              else 'STUCK (axis shows stale wrong price while watchlist is live)  <-- USER BUG')
        pg.screenshot(path=os.path.join(OUT, f'bug-{tag}.png'))
        rel = [w for w in warns if 'reloading history' in w or 'axis-guard' in w]
        print('guard reloads fired:', len(rel))
        b.close()
    try:
        os.killpg(os.getpgid(prov.pid), signal.SIGTERM)
    except Exception:
        pass
    return healed

ok0 = run_case(0, 'off0-control')
okOff = run_case(-5400, 'off-5400-realbroker')
print('\n================ VERDICT ================')
print('control off=0       :', 'HEALED' if ok0 else 'STUCK')
print('real-broker off=-5400:', 'HEALED' if okOff else 'STUCK  <-- R26 fix INERT for real brokers')
