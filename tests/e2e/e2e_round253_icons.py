#!/usr/bin/env python3
"""ROUND253 e2e — toolbar icon wiring, live.

  - the Elliott flyout shows 5 distinct tile glyphs (no shared fallback)
  - the stay-lock util button renders its own glyph
  - every drawing group button renders a real svg
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8942, 8882
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

def check(name, cond, extra=''):
    print(('  ok ' if cond else '  FAIL ') + name + ((' - ' + str(extra)) if (not cond and extra != '') else ''))
    if not cond:
        FAILS.append(name)

def wait_port(port, timeout=25):
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

FLY_JS = """() => {
  const A = window.__app;
  const btns = [...document.querySelectorAll('#left-toolbar .lt-btn[data-group]')];
  const withSvg = btns.filter((b) => b.querySelector('svg')).length;
  const g = A.UI.GROUPS.find((x) => x.id === 'gannelliott');
  const elli = g.sections[1].tools;
  const got = elli.map((tid) => {
    const def = A.DrawTools[tid] || {};
    return A.icon(def.icon || 'x');
  });
  const stayBtn = document.querySelector('#left-toolbar .lt-btn[data-util="stay"]');
  return { groups: btns.length, withSvg, elli: got,
    staySvg: !!(stayBtn && stayBtn.querySelector('svg')) };
}"""

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up'); prov.terminate(); return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1560, 'height': 1020})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100", timeout=25000)
            f = page.evaluate(FLY_JS)
            check('all group buttons render svg', f['groups'] >= 9 and f['withSvg'] == f['groups'],
                  (f['groups'], f['withSvg']))
            check('5 distinct Elliott glyphs', len(f['elli']) == 5 and len(set(f['elli'])) == 5, len(set(f['elli'])))
            check('stay button has glyph', f['staySvg'] is True, f['staySvg'])
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND253: %d failed' % len(FAILS) if FAILS else 'ROUND253: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
