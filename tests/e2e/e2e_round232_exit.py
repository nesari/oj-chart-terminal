#!/usr/bin/env python3
"""ROUND232 e2e — exit modify + level-less pin, live.

  Same-bar double-place modifies (limit=1 would fill, 1e9 holds -> no trade
  while the position stays open); level-less exit holds the position with no
  error. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8974, 8852
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

SRC_MOD = ('//@version=6\nstrategy("TST232A", overlay=true)\n'
           'if bar_index == 0\n    strategy.entry("E", strategy.long)\n'
           'if bar_index == 1\n    strategy.exit("X", "E", limit=1)\n    strategy.exit("X", "E", limit=1000000000)\n'
           'ct = strategy.closedtrades\n'
           'ps = strategy.position_size\n'
           'plot(1)\n')

SRC_BARE = ('//@version=6\nstrategy("TST232B", overlay=true)\n'
            'if bar_index == 0\n    strategy.entry("E", strategy.long)\n'
            'if bar_index == 1\n    strategy.exit("X", "E")\n'
            'ct = strategy.closedtrades\n'
            'ps = strategy.position_size\n'
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
    out.ct = gv('ct'); out.ps = gv('ps'); out.bars = pane.bars.length;
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
            a = page.evaluate(READ_JS, {'name': 'TST232A', 'src': SRC_MOD})
            print('    modify:', a.get('status'), 'ct=%s ps=%s bars=%s' % (a.get('ct'), a.get('ps'), a.get('bars')), a.get('probeErr', ''))
            check('engine ok (modify)', a['status'] == 'ok', a.get('errors'))
            check('modify holds live', a.get('ct') == 0 and a.get('ps') == 1, (a.get('ct'), a.get('ps')))
            b = page.evaluate(READ_JS, {'name': 'TST232B', 'src': SRC_BARE})
            print('    bare:', b.get('status'), 'ct=%s ps=%s' % (b.get('ct'), b.get('ps')))
            check('engine ok (bare)', b['status'] == 'ok', b.get('errors'))
            check('level-less holds live', b.get('ct') == 0 and b.get('ps') == 1, (b.get('ct'), b.get('ps')))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND232: %d failed' % len(FAILS) if FAILS else 'ROUND232: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
