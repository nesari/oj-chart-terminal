#!/usr/bin/env python3
"""ROUND222a e2e — v4 bundle live: offset(), bare aliases, bare series vars.

  A v4 script using offset(close,1), bare alma()/tsi() and bare accdist must
  reach engine ok with offset==close[1] and bare==namespaced values read from
  the live runtime. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8964, 8843
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

SRC = ('//@version=4\nstudy("TST222a", overlay=true)\n'
       'o = offset(close, 1)\nh = close[1]\n'
       'a = alma(close, 9, 0.85, 6)\nan = ta.alma(close, 9, 0.85, 6)\n'
       'd = accdist\ndn = ta.accdist\n'
       'plot(o)\n')

READ_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  for (let i = 0; i < 40; i++) {
    const s0 = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
    if (s0 && s0.status !== 'loading') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const g = (n) => { try { const r = st.rt.globals.get(n); return r ? r.value : '<missing>'; } catch (e) { return '<err>'; } };
  const out = { instId: inst.id, status: st ? st.status : 'no-st',
                errors: (st && st.errors) || [],
                o: g('o'), h: g('h'), a: g('a'), an: g('an'), d: g('d'), dn: g('dn') };
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
            r = page.evaluate(READ_JS, {'name': 'TST222a', 'src': SRC})
            print('    status:', r.get('status'), 'o=%s h=%s a=%s' % (r.get('o'), r.get('h'), r.get('a')))
            check('engine ok with v4 legacy calls', r['status'] == 'ok', r.get('errors'))
            check('live offset(close,1) == close[1]', r.get('o') == r.get('h') and isinstance(r.get('o'), (int, float)), r)
            check('live bare alma == ta.alma', r.get('a') == r.get('an') and isinstance(r.get('a'), (int, float)), r)
            check('live bare accdist == ta.accdist', r.get('d') == r.get('dn') and isinstance(r.get('d'), (int, float)), r)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND222a: %d failed' % len(FAILS) if FAILS else 'ROUND222a: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
