#!/usr/bin/env python3
"""ROUND217 e2e — positional overlay lands scripts on the right pane.

  indicator("T", "T", true) must render on the main chart (adapter.sub is
  None); indicator("T", "T", false) must get its own sub-pane.
  Deterministic mini-scripts (not KZP — its first-bar-in-session fragility
  is wall-clock dependent). Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8958, 8837
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

SRC_OVERLAY = '//@version=6\nindicator("OVL217", "OVL217", true)\nplot(close, title="c")\n'
SRC_PANE = '//@version=6\nindicator("PNE217", "PNE217", false)\nplot(close, title="c")\n'

READ_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { instId: inst.id, status: st ? st.status : 'no-st', errors: (st && st.errors) || [],
                overlay: !!(st && st.rt && st.rt.meta && st.rt.meta.overlay),
                sub: !!(st && st.adapter && st.adapter.sub) };
  A.PineUI.remove(pane, inst.id);
  return out;
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
            page = browser.new_page(viewport={'width': 1560, 'height': 900})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100", timeout=25000)
            o = page.evaluate(READ_JS, {'name': 'OVL217', 'src': SRC_OVERLAY})
            print('    overlay script:', o.get('status'), 'meta.overlay=%s sub=%s' % (o.get('overlay'), o.get('sub')))
            check('overlay engine ok', o['status'] == 'ok', o.get('errors'))
            check('positional true renders on main chart (no sub-pane)', o.get('overlay') is True and o.get('sub') is False, o)
            q = page.evaluate(READ_JS, {'name': 'PNE217', 'src': SRC_PANE})
            print('    pane script:', q.get('status'), 'meta.overlay=%s sub=%s' % (q.get('overlay'), q.get('sub')))
            check('pane engine ok', q['status'] == 'ok', q.get('errors'))
            check('positional false gets sub-pane', q.get('overlay') is False and q.get('sub') is True, q)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND217: %d failed' % len(FAILS) if FAILS else 'ROUND217: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
