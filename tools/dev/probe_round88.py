#!/usr/bin/env python3
"""ROUND88 quick probe — debug the dialog date math + debug() shape."""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = '/home/z/my-project/mt5-terminal'
PORT_HTTP, PORT_WS = 8903, 8777

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
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            pg.wait_for_selector('#login-connect', timeout=15000)
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_timeout(1500)
            pg.evaluate("() => { const a = window.__app; a.App.tz = 'Asia/Tehran'; a.Manager.applyTimezone(); }")
            pg.wait_for_timeout(400)
            rng = pg.evaluate("""() => {
              const a = window.__app;
              const nowStamp = Math.floor(Date.now() / 1000) + ((a.App.feed && a.App.feed.serverOff) || 0);
              const p = a.TZ.parts('Asia/Tehran', nowStamp);
              const pad = (n) => String(n).padStart(2, '0');
              const to = { y: +p.year, m: +p.month, d: +p.day - 1 };
              const from = { y: +p.year, m: +p.month, d: +p.day - 12 };
              const iso = (o) => o.y + '-' + pad(o.m) + '-' + pad(o.d);
              return { from: iso(from), to: iso(to), parts: { y: p.year, m: p.month, d: p.day }, nowStamp };
            }""")
            print('rng =', rng)
            pg.evaluate("() => window.__app.SessionRange.openDialog()")
            pg.wait_for_selector('#cs-hfrom', timeout=8000)
            pg.evaluate("""(rng) => {
              const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
              set('cs-hfrom', '3'); set('cs-mfrom', '30'); set('cs-hto', '6'); set('cs-mto', '30');
              set('cs-dfrom', rng.from); set('cs-dto', rng.to);
            }""", rng)
            pg.wait_for_timeout(300)
            state = pg.evaluate("""() => ({
              info: document.getElementById('cs-info').textContent,
              dfrom: document.getElementById('cs-dfrom').value,
              dto: document.getElementById('cs-dto').value,
              hfrom: document.getElementById('cs-hfrom').value,
              mfrom: document.getElementById('cs-mfrom').value,
              hto: document.getElementById('cs-hto').value,
              mto: document.getElementById('cs-mto').value,
            })""")
            print('dialog state =', state)
            print('pageerrors =', errs[:3])
            b.close()
    finally:
        prov.terminate()

if __name__ == '__main__':
    main()
