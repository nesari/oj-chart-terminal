#!/usr/bin/env python3
"""DECISIVE EXPERIMENT for the user's minMove theory.

Theory under test: "Math.pow(10,-5) returns 0.000009999999999999999 (dirty
IEEE-754 value) and feeding it to lightweight-charts as minMove makes the
axis tick algorithm quantize/lock the Y axis near ~2.0 for 5-digit symbols."

Falsification plan (current build v1.7.0, EURUSD digits=5):
  E1  In the REAL renderer (Chromium V8): Math.pow(10,-5) === 1e-5 ===
      parseFloat('1e-5') === (10 ** -5), bit-identical.
  E2  Feed the series the DIRTIEST minMove the theory claims
      (0.000009999999999999999) -> axis must still autoscale around 1.16,
      live price on-screen, labels sane.
  E3  Absurd minMove = 0.5 (50,000x wrong) -> the axis RANGE is still
      data-driven around 1.16 (only label text coarsens) -> minMove provably
      does NOT drive axis range/ticks in this LWC build.
"""
import time, threading, http.server, functools, json, subprocess, signal, os

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'src')
PROV = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'provider', 'demo.py')
PORT = 8978
OUT = '/home/z/my-project/download'
os.makedirs(OUT, exist_ok=True)

prov = subprocess.Popen(['python3', PROV, '--off', '-5400'],
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
    pg.on('pageerror', lambda e: errors.append('PAGEERROR: ' + str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1200)
    pg.click('#card-demo')
    pg.click('#login-connect')
    pg.wait_for_timeout(8000)
    pg.evaluate("() => window.__app.Manager.setSymbol(window.__app.App.activePane, 'EURUSD')")
    pg.wait_for_timeout(3000)

    # ---- E1: renderer-context float premise (Chromium V8) ----
    e1 = pg.evaluate("""() => {
      const f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer);
      const bits = (x) => { f64[0] = x; return u64[0].toString(16); };
      const pow = Math.pow(10, -5), par = parseFloat('1e-5'), lit = 1e-5, exp = 10 ** -5;
      return { pow: String(pow), par: String(par),
               powEqLit: pow === lit, parEqLit: par === lit, expEqLit: exp === lit,
               powBits: bits(pow), litBits: bits(lit) };
    }""")
    check('E1 renderer V8: Math.pow(10,-5) bit-identical to 1e-5/parseFloat/(10**-5)',
          e1['powEqLit'] and e1['parEqLit'] and e1['expEqLit'], json.dumps(e1))

    def probe_state():
        return pg.evaluate("""() => {
          const App = window.__app.App, M = window.__app.Manager;
          const P = App.panes.find(p => p.symbol === 'EURUSD');
          let y = null;
          const px = M.tickPx['EURUSD'] || P.bars[P.bars.length-1].close;
          try { y = P.series.priceToCoordinate(px); } catch (e) {}
          const h = P.host ? P.host.clientHeight : 800;
          const pf = P.series.options().priceFormat;
          return { pf, tick: px, y, h, onscreen: y != null && y > -h && y < 2*h };
        }""")

    base = probe_state()
    check('BASELINE (Math.pow minMove) healthy: live price on the visible axis',
          base['onscreen'], json.dumps(base))

    # ---- E2: the "dirty" minMove from the theory ----
    pg.evaluate("""() => {
      const P = window.__app.App.panes.find(p => p.symbol === 'EURUSD');
      P.series.applyOptions({ priceFormat: { type: 'price', precision: 5,
        minMove: 0.000009999999999999999 } });
    }""")
    pg.wait_for_timeout(1200)
    e2 = probe_state()
    check('E2 dirty minMove (9.99999...e-6): axis still centered on the live price',
          e2['onscreen'] and abs(e2['tick'] - base['tick']) < 0.01, json.dumps(e2))
    pg.screenshot(path=os.path.join(OUT, 'minmove-E2-dirty.png'))

    # ---- E3: absurd minMove (50000x wrong) — range must stay data-driven ----
    pg.evaluate("""() => {
      const P = window.__app.App.panes.find(p => p.symbol === 'EURUSD');
      P.series.applyOptions({ priceFormat: { type: 'price', precision: 5, minMove: 0.5 } });
    }""")
    pg.wait_for_timeout(1200)
    e3 = probe_state()
    check('E3 absurd minMove=0.5: axis RANGE still around the live price (data-driven)',
          e3['onscreen'], json.dumps(e3))
    pg.screenshot(path=os.path.join(OUT, 'minmove-E3-absurd.png'))

    check('zero page errors throughout', not errors, '; '.join(errors[:3]))
    b.close()

try:
    os.killpg(os.getpgid(prov.pid), signal.SIGTERM)
except Exception:
    pass

n_ok = sum(1 for _, ok in results if ok)
print(f"\n=== MINMOVE-EXPERIMENT: {n_ok}/{len(results)} PASS ===")
