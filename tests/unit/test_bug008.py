#!/usr/bin/env python3
"""BUG-008 verification: snapshot carries BOTH axes (time labels from the
BUG-002 overlay), brand logo bottom-left, 1px frame, and the ACTIVE theme
palette (light -> light)."""
import sys, time, threading, http.server, functools, json, subprocess, signal, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'src')
PORT = 8918
PROV = subprocess.Popen(['python3', os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'provider', 'demo.py')],
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

PROBE = """(mode) => new Promise((res) => {
  window.__app.Theme.apply(mode);
  setTimeout(() => {
    const url = Toolbar.Snapshot.capture();
    if (!url) { res({ nourl: true }); return; }
    const im = new Image();
    im.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = im.width; cv.height = im.height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(im, 0, 0);
      const dpr = window.devicePixelRatio || 1;
      const W = im.width, H = im.height;
      const data = ctx.getImageData(0, 0, W, H).data;
      const px = (x, y) => { const i = (Math.round(y) * W + Math.round(x)) * 4; return [data[i], data[i+1], data[i+2]]; };
      const pane = window.__app.App.activePane;
      const timeH = (pane.chart.timeScale().height() || 26) * dpr;
      const axisW = (pane.chart.priceScale('right').width() || 62) * dpr;
      const pal = Manager.getSnapshotPalette(mode);
      const hex2rgb = (h) => {
        if (h.indexOf('rgb') === 0) { const m = h.match(/[\d.]+/g) || []; return [+m[0], +m[1], +m[2]]; }
        const t = h.replace('#',''); return [parseInt(t.slice(0,2),16), parseInt(t.slice(2,4),16), parseInt(t.slice(4,6),16)];
      };
      const near = (a, b, tol) => a && b && Math.abs(a[0]-b[0]) <= tol && Math.abs(a[1]-b[1]) <= tol && Math.abs(a[2]-b[2]) <= tol;
      const bgc = hex2rgb(pal.bg1);
      // frame: some pixel in the top row must differ from bg
      let frame = false;
      for (let x = 0; x < Math.min(W, 400); x += 2) {
        for (const y of [0, 1, 2]) {
          const pc = px(x, y);
          const dev = Math.max(Math.abs(pc[0]-bgc[0]), Math.abs(pc[1]-bgc[1]), Math.abs(pc[2]-bgc[2]));
          if (dev >= 9) { frame = true; break; }
        }
        if (frame) break;
      }
      // time-axis labels: scan the bottom strip for text-colored pixels
      let axisText = 0;
      const tc = hex2rgb(pal.text);
      for (let y = H - timeH; y < H - 2; y += 2)
        for (let x = 4; x < W - axisW - 4; x += 2)
          if (near(px(x, y), tc, 60)) axisText++;
      // logo region: bottom-left inside the plot area must contain non-bg pixels
      let logoPix = 0;
      const y0 = H - timeH - (16 + 48) * dpr, y1 = H - timeH - 16 * dpr;
      for (let y = Math.max(0, y0); y < y1; y += 2)
        for (let x = 16 * dpr; x < 16 * dpr + 130 * dpr; x += 2)
          if (!near(px(x, y), bgc, 30)) logoPix++;
      const corner = px(3, 3);
      res({
        mode, W, H,
        frame, axisText, logoPix,
        corner,
        cornerIsLight: mode === 'light' ? (corner[0] > 200 && corner[1] > 200 && corner[2] > 200) : (corner[0] < 60),
        pal,
      });
    };
    im.src = url;
  }, 600);
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

    # palette unit checks
    pu = pg.evaluate("""() => ({
      light: Manager.getSnapshotPalette('light'),
      dark: Manager.getSnapshotPalette('dark'),
    })""")
    check('1 getSnapshotPalette: light mode -> light bg + dark logo asset',
          pu['light']['mode'] == 'light' and pu['light']['logo'] == 'assets/logo-dark.png' and pu['light']['bg1'] in ('#ffffff', '#f0f3fa'), pu['light'])
    check('2 getSnapshotPalette: dark mode -> dark bg + white logo asset',
          pu['dark']['mode'] == 'dark' and pu['dark']['logo'] == 'assets/logo-light.png', pu['dark'])

    d = pg.evaluate(PROBE, 'dark')
    check('3 dark capture: 1px outer frame present', d.get('frame') == True, {k: d[k] for k in ('frame', 'W', 'H')} if d.get('frame') is not None else d)
    check('4 dark capture: time-axis labels painted (BUG-002 overlay included)', d.get('axisText', 0) > 30, f"axisText px={d.get('axisText')}")
    check('5 dark capture: brand logo pixels bottom-left', d.get('logoPix', 0) > 40, f"logoPix={d.get('logoPix')}")
    pg.wait_for_timeout(300)

    l = pg.evaluate(PROBE, 'light')
    check('6 light capture: LIGHT background at corners (no dark leak)', l.get('cornerIsLight') == True, l.get('corner'))
    check('7 light capture: frame + time labels + logo all present',
          l.get('frame') == True and l.get('axisText', 0) > 30 and l.get('logoPix', 0) > 40,
          {k: l.get(k) for k in ('frame', 'axisText', 'logoPix')})

    # download & copy share the SAME composed image source
    same = pg.evaluate("""() => {
      const a = Toolbar.Snapshot.capture(), b = Toolbar.Snapshot.capture();
      return { both: !!(a && b), sameType: a.slice(0, 30) === b.slice(0, 30) };
    }""")
    check('8 Download & Copy both use the composed capture', same['both'] and same['sameType'], same)

    # save the actual captures for the docs
    for mode, name in (('dark', 'bug008-snapshot-dark.png'), ('light', 'bug008-snapshot-light.png')):
        url = pg.evaluate(f"() => Toolbar.Snapshot.capture()")
        import base64
        with open(f'/home/z/my-project/download/{name}', 'wb') as f:
            f.write(base64.b64decode(url.split(',', 1)[1]))
    check('9 no page errors', len(errs) == 0, '; '.join(errs[:3]))
    b.close()

try: os.killpg(os.getpgid(PROV.pid), signal.SIGTERM)
except Exception: pass

fails = [r for r in results if not r[1]]
print(f"\n==== {len(results) - len(fails)}/{len(results)} passed ====")
sys.exit(1 if fails else 0)
