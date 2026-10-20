#!/usr/bin/env python3
"""ROUND88 probe — why does the 786 Zones form 0 boxes inside Custom Session?"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = '/home/z/my-project/mt5-terminal'
USER_SRC = '/home/z/my-project/user-tests/786-zones.pine'
PORT_HTTP, PORT_WS = 8904, 8777

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
            pg.wait_for_timeout(1500)
            pg.evaluate("() => { const a = window.__app; a.App.tz = 'Asia/Tehran'; a.Manager.applyTimezone(); }")
            pg.wait_for_timeout(300)
            # apply session via API (fast path for the probe)
            rng = pg.evaluate("""() => {
              const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' });
              const p = fmt.format(new Date()).split('-').map(Number);
              const pad = (n) => String(n).padStart(2, '0');
              const iso = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()); };
              const df = Math.floor(new Date(iso(p[0], p[1], p[2] - 12) + 'T00:00:00Z').getTime() / 1000 / 86400);
              const dt = Math.floor(new Date(iso(p[0], p[1], p[2] - 1) + 'T00:00:00Z').getTime() / 1000 / 86400);
              return { df, dt };
            }""")
            pg.evaluate("""(r) => window.__app.SessionRange.apply({ hFrom: 3, hTo: 6, mFrom: 30, mTo: 30, dFrom: r.df, dTo: r.dt })""", rng)
            pg.wait_for_timeout(3000)
            base = pg.evaluate("""() => {
              const a = window.__app;
              const pane = a.App.panes[0];
              return { base: a.SessionRange.baseInfo(pane.symbol), tf: pane.tf, nbars: pane.barTimes.length,
                       m1src: (a.SessionRange.m1Source && a.SessionRange.m1Source(pane.symbol) || []).length };
            }""")
            print('base info =', base)
            src = open(USER_SRC, encoding='utf-8').read()
            pg.evaluate("""(src) => {
              const a = window.__app;
              const rec = a.PineScriptsStore.create('786 sess', src);
              window.__pane = a.App.panes[0];
              window.__inst = a.PineUI.add(window.__pane, rec.id, {});
            }""", src)
            pg.wait_for_timeout(2000)
            pg.evaluate("""() => {
              const a = window.__app;
              const s = (a.PineUI.debug(window.__pane) || [])[0];
              const defs = {};
              if (s && s.inputDefs) for (const d of s.inputDefs) { if (['Days Back', 'Extend Mode'].includes(d.title)) defs[d.title] = d.id; }
              window.__ids = defs;
              if (defs['Days Back']) window.__inst.inputs[defs['Days Back']] = 3;
            }""")
            pg.wait_for_timeout(1700)
            pg.evaluate("() => window.__app.PineUI.recomputePine(window.__pane)")
            deadline = time.time() + 60
            info = None
            while time.time() < deadline:
                info = pg.evaluate("""() => {
                  const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
                  if (!s) return null;
                  const zf = s.zoneFormed;
                  let firstSub = null;
                  if (s.rt && s.rt.env.intrabars) {
                    for (const arr of s.rt.env.intrabars) { if (arr && arr.length) { firstSub = arr[0]; break; } }
                  }
                  return { status: s.status, boxes: s.boxes, labels: s.labels, zf,
                           ibars: s.intrabars, ibarBars: s.intrabarBars, firstSub,
                           db: s.rt ? s.rt.globals.get('daysBack') && s.rt.globals.get('daysBack').value : null };
                }""")
                if info and info.get('boxes', 0) > 0:
                    break
                time.sleep(1.5)
            print('instance info =', info)
            # deeper: the zone slot arrays + a sample targetStart vs an intrabar time
            deep = pg.evaluate("""() => {
              const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
              if (!s || !s.rt) return null;
              const g = (n) => { const rec = s.rt.globals.get(n); return rec && rec.value && rec.value.items ? rec.value.items.slice(0, 12) : null; };
              const tf = s.rt.env.intrabars ? s.rt.env.intrabars.filter(Boolean).length : 0;
              return { zoneStartMs: g('zoneStartMs') && g('zoneStartMs').filter(v => v && v > 0).slice(0, 4),
                       zoneFormed: g('zoneFormed'),
                       timenow: s.rt.globals.get('nowRef') ? s.rt.globals.get('nowRef').value : null,
                       serverOffSec: s.rt.env.serverOffSec, ibarsWith: tf };
            }""")
            print('deep =', deep)
            b.close()
    finally:
        prov.terminate()

if __name__ == '__main__':
    main()
