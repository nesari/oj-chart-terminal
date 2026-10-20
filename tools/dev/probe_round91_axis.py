#!/usr/bin/env python3
"""ROUND91 probe — boot the app with the USER'S exact example (Custom Session
04:30–07:30 Tehran over ~12 days, GMT+3 demo broker) and SCREENSHOT the chart
+ axis so we can see what the user sees. No assertions, pure visual."""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = '/home/z/my-project/mt5-terminal'
PORT_HTTP, PORT_WS = 8908, 8777

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

APPLY_JS = """(o) => {
  const a = window.__app;
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: a.App.tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = fmt.format(new Date()).split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); };
  a.SessionRange.openDialog();
  const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
  set('cs-hfrom', o.hFrom); set('cs-mfrom', o.mFrom); set('cs-hto', o.hTo); set('cs-mto', o.mTo);
  set('cs-dfrom', iso(p[0], p[1], p[2] - 14)); set('cs-dto', iso(p[0], p[1], p[2] - 1));
  document.getElementById('cs-apply').click();
  return true;
}"""

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py'), '--off', '10800'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        assert wait_port(PORT_HTTP) and wait_port(PORT_WS)
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            b = pw.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            pg = b.new_page(viewport={'width': 1600, 'height': 900})
            pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            pg.wait_for_selector('#login-connect', timeout=15000)
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_selector('#charts-grid canvas', timeout=20000)
            pg.wait_for_timeout(1500)
            pg.evaluate("() => { const a = window.__app; a.App.tz = 'Asia/Tehran'; a.Manager.applyTimezone(); }")
            pg.wait_for_timeout(400)
            # USER'S EXACT EXAMPLE: 04:30 - 07:30, 10+ days
            pg.evaluate(APPLY_JS, {'hFrom': '4', 'mFrom': '30', 'hTo': '7', 'mTo': '30'})
            pg.wait_for_timeout(2500)
            info = pg.evaluate("""() => {
              const pane = window.__app.App.panes[0];
              const lr = pane.chart.timeScale().getVisibleLogicalRange();
              return { n: pane.barTimes.length, regions: (pane._sessRegions||[]).length,
                       tf: pane.tfSec, from: lr && lr.from, to: lr && lr.to };
            }""")
            print('boot info:', info)
            # default view (whatever the user gets right after apply)
            pg.screenshot(path='/home/z/my-project/scripts/shot91_default.png')
            # zoom to a couple of full regions if possible
            view = pg.evaluate("""() => {
              const pane = window.__app.App.panes[0];
              const rs = pane._sessRegions || [];
              return rs.length >= 4 ? { from: rs[2].a - 2, to: rs[3].b + 3 } : null;
            }""")
            if view:
                for _ in range(6):
                    pg.evaluate(f"() => {{ const p = window.__app.App.panes[0]; p.chart.timeScale().setVisibleLogicalRange({{ from: {view['from']}, to: {view['to']} }}); }}")
                    pg.wait_for_timeout(700)
                pg.wait_for_timeout(800)
            pg.screenshot(path='/home/z/my-project/scripts/shot91_zoomed.png')
            # report the actual axis text sequence
            ax = pg.evaluate("""() => {
              const pane = window.__app.App.panes[0];
              const eng = pane.engine;
              const rs = pane._sessRegions || [];
              const gt = pane._sessWithGapTimes || [];
              const spans = Array.from(document.querySelectorAll('.tax-ext span'));
              const meta = rs.map((r) => ({ x0: eng._xOf(gt[r.a]), x1: eng._xOf(gt[r.b]) }));
              const per = meta.map(() => []);
              for (const s of spans) {
                const x = parseFloat(s.style.left) || 0;
                meta.forEach((m, i) => { if (x >= m.x0 - 2 && x <= m.x1 + 2) per[i].push((s.textContent||'').trim()); });
              }
              return per;
            }""")
            for i, seq in enumerate(ax):
                print(f'region[{i}] labels: {seq}')
            b.close()
    finally:
        prov.terminate()

if __name__ == '__main__':
    main()
