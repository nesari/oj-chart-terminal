#!/usr/bin/env python3
"""ROUND222 e2e — forward-compat: new v6 decl params never kill a script.

  A live script declaring dynamic_requests/behind_chart/timeframe= must still
  reach engine ok, and the Diagnostics log must hold the forward-compat debug
  line naming the ignored params. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8963, 8842
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

SRC = '//@version=6\nindicator("TST222", overlay=true, dynamic_requests=true, behind_chart=true, timeframe="D")\nplot(close)\n'

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
  const logs = A.Log.entries({ search: 'forward-compat' }).map((e) => e.msg);
  const out = { instId: inst.id, status: st ? st.status : 'no-st',
                errors: (st && st.errors) || [], fcLogs: logs };
  try { out.tfSec = st.rt.env.tfSec; out.runBars = st.rt.totalBars; } catch (e) { out.tfErr = String(e); }
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
            r = page.evaluate(READ_JS, {'name': 'TST222', 'src': SRC})
            print('    status:', r.get('status'), 'fcLogs=', len(r.get('fcLogs') or []))
            check('engine ok with new decl params', r['status'] == 'ok', r.get('errors'))
            fcs = r.get('fcLogs') or []
            # ROUND226: timeframe= is consumed into meta.timeframe (runs HTF),
            # so the ignored list holds only the still-ignored params.
            # ROUND236: dynamic_requests is understood into meta (no longer
            # in the ignored line) — behind_chart still is.
            check('forward-compat line in Diagnostics log', any('behind_chart' in str(m) and 'dynamic_requests' not in str(m) for m in fcs), fcs[:2])
            check('declaration timeframe runs daily buckets', r.get('tfSec') == 86400, (r.get('tfSec'), r.get('runBars')))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND222: %d failed' % len(FAILS) if FAILS else 'ROUND222: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
