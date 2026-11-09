#!/usr/bin/env python3
"""ROUND234 e2e — offset() == [] parity, live.

  v4 study: offset(close,2) equals close[2]; negative offset is na;
  v6 offset() is loud (removed). Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8985, 8854
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

SRC_V4 = ('//@version=4\nstudy("TST234A", overlay=true)\n'
          'o = offset(close, 2)\n'
          'e = close[2]\n'
          'ng = na(offset(close, -1))\n'
          'plot(1)\n')

SRC_V6 = ('//@version=6\nindicator("TST234B", overlay=true)\n'
          'o = offset(close, 1)\n'
          'plot(1)\n')

READ_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  for (let i = 0; i < 60; i++) {
    const s0 = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
    if (s0 && s0.status !== 'loading') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { instId: inst.id, status: st ? st.status : 'no-st', errors: (st && st.errors) || [] };
  try {
    const gv = (n) => { const r = st.rt.globals.get(n); return r ? r.value : null; };
    out.o = gv('o'); out.e = gv('e'); out.ng = gv('ng');
  } catch (e) { out.probeErr = String(e); }
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
            a = page.evaluate(READ_JS, {'name': 'TST234A', 'src': SRC_V4})
            print('    v4:', a.get('status'), 'o=%s e=%s neg_na=%s' % (a.get('o'), a.get('e'), a.get('ng')), a.get('probeErr', ''))
            check('engine ok', a['status'] == 'ok', a.get('errors'))
            check('offset parity live', a.get('o') == a.get('e') and isinstance(a.get('o'), (int, float)), (a.get('o'), a.get('e')))
            check('negative na live', a.get('ng') is True, a.get('ng'))
            b = page.evaluate(READ_JS, {'name': 'TST234B', 'src': SRC_V6})
            print('    v6:', b.get('status'), b.get('errors'))
            check('v6 loud live', b['status'] == 'error' and any('removed' in str(e) for e in b.get('errors', [])), b)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND234: %d failed' % len(FAILS) if FAILS else 'ROUND234: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
