#!/usr/bin/env python3
"""ROUND90 probe — dump the session axis items + region intervals."""
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
            pg.evaluate("""() => {
              const a = window.__app;
              const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: a.App.tz, year: 'numeric', month: '2-digit', day: '2-digit' });
              const p = fmt.format(new Date()).split('-').map(Number);
              const pad = (n) => String(n).padStart(2, '0');
              const iso = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); };
              a.SessionRange.openDialog();
              const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
              set('cs-hfrom', '3'); set('cs-mfrom', '30'); set('cs-hto', '6'); set('cs-mto', '30');
              set('cs-dfrom', iso(p[0], p[1], p[2] - 12)); set('cs-dto', iso(p[0], p[1], p[2] - 1));
              document.getElementById('cs-apply').click();
            }""")
            for _ in range(40):
                n = pg.evaluate("() => window.__app.App.panes[0].barTimes.length")
                if n > 50:
                    break
                time.sleep(1.2)
            pg.evaluate("() => { const p = window.__app.App.panes[0]; p.chart.timeScale().setVisibleLogicalRange({ from: 0, to: 80 }); }")
            pg.wait_for_timeout(1200)
            out = pg.evaluate("""() => {
              const a = window.__app;
              const pane = a.App.panes[0];
              const eng = pane.engine;
              const shift = a.SessionRange.shift();
              const regions = [];
              let cur = null;
              for (const t of pane.barTimes) {
                const w = t + (shift ? shift(t) : 0);
                const d = Math.floor(w / 86400) * 86400;
                if (!cur || cur.d !== d) { cur = { d, first: t, last: t }; regions.push(cur); }
                else cur.last = t;
              }
              for (const r of regions) { r.x0 = eng._xOf(r.first); r.x1 = eng._xOf(r.last); }
              const lr = pane.chart.timeScale().getVisibleLogicalRange();
              const spans = Array.from(document.querySelectorAll('.tax-ext span')).map((s) => ({
                txt: (s.textContent || '').trim(), x: Math.round(parseFloat(s.style.left) || 0),
              }));
              return {
                lr, nSlots: pane._sessWithGapTimes.length, nCompact: pane.barTimes.length,
                regions: regions.slice(0, 3).map((r) => ({ x0: Math.round(r.x0), x1: Math.round(r.x1) })),
                spans,
                N: null, bs: null,
              };
            }""")
            print('lr =', out['lr'], 'slots =', out['nSlots'], 'compact =', out['nCompact'])
            print('regions[:3] x-intervals =', out['regions'])
            for s in out['spans']:
                print('  span', s['x'], repr(s['txt']))
            b.close()
    finally:
        prov.terminate()

if __name__ == '__main__':
    main()
