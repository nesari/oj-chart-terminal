#!/usr/bin/env python3
"""ROUND235 e2e — exit closing-side direction, live.

  Demo prices sit far above 1 and below 1e9: a marketable sell limit (1)
  fills at the open, a waiting one (1e9) never does. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8957, 8855
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

SRC_FILL = ('//@version=6\nstrategy("TST235A", overlay=true)\n'
            'if bar_index == 0\n    strategy.entry("E", strategy.long)\n'
            'if bar_index == 1\n    strategy.exit("X", "E", limit=1)\n'
            'ct = strategy.closedtrades\n'
            'xp = strategy.closedtrades.exit_price(0)\n'
            'plot(1)\n')

SRC_HOLD = ('//@version=6\nstrategy("TST235B", overlay=true)\n'
            'if bar_index == 0\n    strategy.entry("E", strategy.long)\n'
            'if bar_index == 1\n    strategy.exit("X", "E", limit=1000000000)\n'
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
    out.ct = gv('ct'); out.xp = gv('xp'); out.ps = gv('ps');
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
            a = page.evaluate(READ_JS, {'name': 'TST235A', 'src': SRC_FILL})
            print('    marketable:', a.get('status'), 'ct=%s xp=%s' % (a.get('ct'), a.get('xp')), a.get('probeErr', ''))
            check('engine ok', a['status'] == 'ok', a.get('errors'))
            check('marketable fills live', a.get('ct') == 1 and isinstance(a.get('xp'), (int, float)), (a.get('ct'), a.get('xp')))
            b = page.evaluate(READ_JS, {'name': 'TST235B', 'src': SRC_HOLD})
            print('    waiting:', b.get('status'), 'ct=%s ps=%s' % (b.get('ct'), b.get('ps')))
            check('waiting holds live', b.get('ct') == 0 and b.get('ps') == 1, (b.get('ct'), b.get('ps')))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND235: %d failed' % len(FAILS) if FAILS else 'ROUND235: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
