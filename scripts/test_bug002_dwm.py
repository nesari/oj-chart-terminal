#!/usr/bin/env python3
"""BUG-002 supplementary: D1 / W1 charts — day/week labels uniform & unclipped."""
import sys, time, threading, http.server, functools, json, subprocess, signal, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
PORT = 8904
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

JS = """(tf) => new Promise((res) => {
  const { Manager, App } = window.__app;
  Manager.setTf(App.activePane, tf);
  setTimeout(() => {
    const p = App.activePane;
    const el = p.tax;
    const strip = el.getBoundingClientRect();
    const spans = [...el.querySelectorAll('span')];
    const liveX = p.engine._xOf(p.barTimes[p.barTimes.length - 1]);
    const labels = spans.map(s => {
      const r = s.getBoundingClientRect();
      const cx = r.x - strip.x + r.width / 2;
      return { txt: s.textContent, w: r.width, cx, live: Math.abs(cx - liveX) < 4 };
    });
    const gridGaps = [];
    for (let i = 1; i < labels.length; i++) {
      if (labels[i].live) continue;
      gridGaps.push(+(labels[i].cx - labels[i-1].cx).toFixed(1));
    }
    let base = null, nonUniform = [];
    if (gridGaps.length) {
      const counts = {};
      for (const g of gridGaps) { const k = Math.round(g); counts[k] = (counts[k]||0)+1; }
      base = +Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0];
      nonUniform = gridGaps.filter(g => Math.abs(g/base - Math.round(g/base)) > 0.2);
    }
    const clipped = labels.filter(l => (l.cx - l.w/2 < -0.5) || (l.cx + l.w/2 > strip.width + 0.5)).map(l=>l.txt);
    res({ labels: labels.map(l=>l.txt), gridGaps, base, nonUniform, clipped, n: p.barTimes.length });
  }, 5000);
})"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1000)
    pg.click('#card-demo'); pg.click('#login-connect')
    pg.wait_for_timeout(6000)
    d1 = pg.evaluate(JS, 'D1')
    import re as _re
    is_date = lambda l: bool(_re.match(r'^(\d{4}|[A-Z][a-z]{2}( \d{2})?|([A-Z][a-z]{2} )?\d{2} \d{2})$', l))
    check('D1: axis labels are dates (day/month/year forms)', all(is_date(l) for l in d1['labels']), d1['labels'][:8])
    check('D1: uniform gaps', d1['base'] and len(d1['nonUniform']) == 0, f"gaps={d1['gridGaps'][:10]} base={d1['base']}")
    check('D1: nothing clipped', len(d1['clipped']) == 0, d1['clipped'])
    w1 = pg.evaluate(JS, 'W1')
    check('W1: uniform gaps', w1['base'] and len(w1['nonUniform']) == 0, f"gaps={w1['gridGaps'][:10]} base={w1['base']}")
    check('W1: nothing clipped', len(w1['clipped']) == 0, w1['clipped'])
    mn = pg.evaluate(JS, 'MN1')
    check('MN: uniform gaps', mn['base'] and len(mn['nonUniform']) == 0, f"gaps={mn['gridGaps'][:10]} base={mn['base']}")
    check('MN: nothing clipped', len(mn['clipped']) == 0, mn['clipped'])
    pg.screenshot(path='/home/z/my-project/download/bug002-d1-weekly.png')
    check('no page errors', len(errs) == 0, '; '.join(errs[:3]))
    b.close()

try: os.killpg(os.getpgid(PROV.pid), signal.SIGTERM)
except Exception: pass
fails = [r for r in results if not r[1]]
print(f"\n==== {len(results) - len(fails)}/{len(results)} passed ====")
sys.exit(1 if fails else 0)
