#!/usr/bin/env python3
"""BUG-002 + BUG-003 verification.
BUG-002: ONE uniform tick cadence across the whole time axis (data + future),
grid-aligned, day labels not clipped, engine vertical grid aligned to labels.
BUG-003: bottom-bar clock shows the real selected-zone time (no double
broker-offset subtraction); clock and axis share the same pipeline.
"""
import sys, time, threading, http.server, functools, json, subprocess, signal, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
PORT = 8902
PROV = subprocess.Popen(['python3', os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'provider', 'demo.py')],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
time.sleep(1.5)

def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start()

results = []
def check(name, ok, info=''):
    results.append((name, ok, info))
    print(('PASS' if ok else 'FAIL'), '-', name, ('| ' + str(info) if info else ''))

def mdiff(a, b):
    ah, am = a.split(':')[:2]; bh, bm = b.split(':')[:2]
    return abs((int(ah)*60+int(am)) - (int(bh)*60+int(bm)))

JS_AXIS = """() => {
  const p = window.__app.App.activePane;
  const el = p.tax;
  const spans = [...el.querySelectorAll('span')];
  const strip = el.getBoundingClientRect();
  const liveX = p.engine._xOf(p.barTimes[p.barTimes.length - 1]);
  const labels = spans.map(s => {
    const r = s.getBoundingClientRect();
    const cx = r.x - strip.x + r.width / 2;
    return { txt: s.textContent, x: r.x - strip.x, w: r.width, cx, live: Math.abs(cx - liveX) < 4 };
  });
  const gaps = [];
  for (let i = 1; i < labels.length; i++) gaps.push(+(labels[i].cx - labels[i-1].cx).toFixed(1));
  const future = labels.filter(l => !l.live && l.cx > liveX + 4).length;
  const clipped = labels.filter(l => (l.cx - l.w/2 < -0.5) || (l.cx + l.w/2 > strip.width + 0.5)).map(l => l.txt);
  // gaps between GRID labels only (the live label may sit off-grid by design)
  const gridGaps = [];
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].live) continue; // gap ending at the live label is off-grid on purpose
    gridGaps.push(+(labels[i].cx - labels[i-1].cx).toFixed(1));
  }
  let base = null, nonUniform = [];
  if (gridGaps.length) {
    const counts = {};
    for (const g of gridGaps) { const k = Math.round(g); counts[k] = (counts[k] || 0) + 1; }
    base = +Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
    nonUniform = gridGaps.filter(g => Math.abs(g / base - Math.round(g / base)) > 0.18);
  }
  return {
    n: labels.length, labels: labels.map(l => l.txt), gridGaps, base, nonUniform,
    future, clipped, grid: (p.engine._taxGrid || []).length,
    liveX, stripW: strip.width,
  };
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1000)
    pg.click('#card-demo'); pg.click('#login-connect')
    pg.wait_for_timeout(7000)

    # ---------- BUG-002: uniform axis ----------
    a = pg.evaluate(JS_AXIS)
    check('1 axis populated', a['n'] >= 4, a['labels'])
    check('2 ONE uniform cadence (grid-label gaps are integer multiples of the modal step)',
          a['base'] and len(a['nonUniform']) == 0,
          f"gridGaps={a['gridGaps']} base={a['base']} nonUniform={a['nonUniform']}")
    # widen the right offset so several future slots must label
    pg.evaluate("() => window.__app.App.activePane.chart.timeScale().setVisibleLogicalRange({ from: window.__app.App.activePane.barTimes.length - 40, to: window.__app.App.activePane.barTimes.length + 90 })")
    pg.wait_for_timeout(600)
    af = pg.evaluate(JS_AXIS)
    check('3 future area labelled (wide right margin)', af['future'] >= 2,
          f"future={af['future']} labels={af['labels'][-6:]}")
    check('4 no clipped labels at edges', len(a['clipped']) == 0, a['clipped'])
    check('5 engine grid lines present & aligned', a['grid'] >= 2, f"grid lines={a['grid']}")

    # grid x == label x alignment
    al = pg.evaluate("""() => {
      const p = window.__app.App.activePane;
      const strip = p.tax.getBoundingClientRect();
      const xs = [...p.tax.querySelectorAll('span')].map(s => {
        const r = s.getBoundingClientRect(); return +(r.x - strip.x + r.width/2).toFixed(0);
      });
      const grid = (p.engine._taxGrid || []).map(v => +v.toFixed(0));
      const matched = xs.filter(x => grid.some(g => Math.abs(g - x) <= 2)).length;
      return { xs: xs.length, grid: grid.length, matched };
    }""")
    check('6 every label except the live one has a grid line under it', al['matched'] >= al['xs'] - 1 and al['grid'] >= al['xs'] - 1, al)

    # zoom in -> cadence may change but must stay uniform
    pg.evaluate("() => { const p = window.__app.App.activePane; const n = p.barTimes.length; p.chart.timeScale().setVisibleLogicalRange({ from: n - 30, to: n + 8 }); }")
    pg.wait_for_timeout(600)
    z1 = pg.evaluate(JS_AXIS)
    check('7 zoom-in keeps uniform cadence', z1['base'] and len(z1['nonUniform']) == 0, f"gridGaps={z1['gridGaps']}")
    # zoom out far -> day labels appear fully rendered
    pg.evaluate("() => { const p = window.__app.App.activePane; const n = p.barTimes.length; p.chart.timeScale().setVisibleLogicalRange({ from: n - 1600, to: n + 30 }); }")
    pg.wait_for_timeout(600)
    z2 = pg.evaluate(JS_AXIS)
    check('8 zoom-out keeps uniform cadence', z2['base'] and len(z2['nonUniform']) == 0, f"gridGaps={z2['gridGaps']}")
    check('9 zoom-out: no clipped labels', len(z2['clipped']) == 0, z2['clipped'])

    # ---------- BUG-003: clock (±1s tolerance — two reads may straddle a second boundary) ----------
    def sec_diff(a, b):
        ah, am, as_ = a.split(':'); bh, bm, bs_ = b.split(':')
        return abs((int(ah)*3600 + int(am)*60 + int(as_)) - (int(bh)*3600 + int(bm)*60 + int(bs_)))
    c0 = pg.evaluate("""() => {
      const real = (tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false,
        hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
      return {
        before: TZ.nowLabel('Asia/Tehran'),
        tehranReal: real('Asia/Tehran'),
        utc: TZ.nowLabel('UTC'), utcReal: real('UTC'),
        ny: TZ.nowLabel('America/New_York'), nyReal: real('America/New_York'),
        broker: TZ.nowLabel('broker'),
      };
    }""")
    check('10 Tehran clock == real Tehran time (off=0 demo)', sec_diff(c0['before'], c0['tehranReal']) <= 1,
          f"got={c0['before']} real={c0['tehranReal']}")

    # THE BUG SCENARIO: broker on GMT+3 must not shift the Tehran clock 3h back.
    # stub _setOff so the provider's per-tick off:0 cannot undo the simulated
    # offset mid-check (the app CORRECTLY re-measures from the provider)
    pg.evaluate("() => { window.__app.App.feed._setOff = () => {}; window.__app.App.feed.serverOff = 3 * 3600; }")
    pg.wait_for_timeout(1200)
    c1 = pg.evaluate("""() => {
      const real = (tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false,
        hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
      const realBroker = () => { const d = new Date(Date.now() + 3*3600*1000); 
        const p2 = n => String(n).padStart(2,'0');
        return p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds()); };
      const app = window.__app;
      return {
        tehran: TZ.nowLabel('Asia/Tehran'), tehranReal: real('Asia/Tehran'),
        utc: TZ.nowLabel('UTC'), utcReal: real('UTC'),
        broker: TZ.nowLabel('broker'), brokerReal: realBroker(),
        clockDom: (document.getElementById('tz-clock') || {}).textContent,
      };
    }""")
    check('11 GMT+3 broker: Tehran clock still correct (THE BUG)', sec_diff(c1['tehran'], c1['tehranReal']) <= 1,
          f"got={c1['tehran']} real={c1['tehranReal']} (was 10:47-vs-13:47 class)")
    check('12 GMT+3 broker: UTC clock correct', sec_diff(c1['utc'], c1['utcReal']) <= 1, f"got={c1['utc']} real={c1['utcReal']}")
    check('13 GMT+3 broker: Broker zone label correct', sec_diff(c1['broker'], c1['brokerReal']) <= 1,
          f"got={c1['broker']} real={c1['brokerReal']}")
    # consistency invariant: the axis label of a bar formed THIS minute must
    # equal the clock (same conversion funnel), both at off=0 and off=3h
    c2 = pg.evaluate("""() => {
      const out = [];
      for (const off of [0, 3 * 3600]) {
        window.__app.App.feed.serverOff = off;
        const now = Date.now() / 1000;
        /* chart stamps are SERVER-WALL (utc + off) — a bar formed "now" carries now+off */
        const bucket = window.__app.Manager.bucketStartFor({ sec: 60, id: 'M1' }, now + off);
        out.push({
          off,
          axis: TZ.tickLabel('Asia/Tehran', bucket, 3, false),
          clock: TZ.nowLabel('Asia/Tehran'),
        });
      }
      window.__app.App.feed.serverOff = 0;
      return out;
    }""")
    for r in c2:
        check(f"14 clock minute == current-bar axis minute (off={r['off']})",
              r['axis'][:5] == r['clock'][:5] or mdiff(r['axis'], r['clock']) <= 1, r)
    pg.evaluate("() => { window.__app.App.feed.serverOff = 0; }")

    # tz switch updates axis labels + clock together
    pg.evaluate("() => { window.__app.App.tz = 'Asia/Tehran'; window.__app.Manager.applyTimezone(); }")
    pg.wait_for_timeout(700)
    tzsw = pg.evaluate("""() => {
      const p = window.__app.App.activePane;
      const labels = [...p.tax.querySelectorAll('span')].map(s => s.textContent);
      const clock = TZ.nowLabel('Asia/Tehran');
      const real = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', hour12: false,
        hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
      return { labels: labels.slice(0, 4), clock, real };
    }""")
    check('15 tz switch: clock follows Tehran', sec_diff(tzsw['clock'], tzsw['real']) <= 1, f"{tzsw['clock']} vs {tzsw['real']}")
    check('16 tz switch: axis still uniform', (lambda r: r['base'] and len(r['nonUniform']) == 0)(pg.evaluate(JS_AXIS)))
    pg.evaluate("() => { window.__app.App.tz = 'broker'; window.__app.Manager.applyTimezone(); }")
    pg.wait_for_timeout(400)

    pg.screenshot(path='/home/z/my-project/download/bug002-003-after-fix.png')
    check('17 no page errors', len(errs) == 0, '; '.join(errs[:3]))
    b.close()

try: os.killpg(os.getpgid(PROV.pid), signal.SIGTERM)
except Exception: pass

fails = [r for r in results if not r[1]]
print(f"\n==== {len(results) - len(fails)}/{len(results)} passed ====")
sys.exit(1 if fails else 0)
