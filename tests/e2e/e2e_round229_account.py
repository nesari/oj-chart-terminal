#!/usr/bin/env python3
"""ROUND229 e2e — account getters + session bar edges, live.

  Forced round-trip strategy: engine ok, one closed trade, finite avg_trade
  and netprofit_percent. session.isfirstbar/islastbar are true on some bars
  and false on others across the multi-day demo history. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8970, 8849
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

SRC = ('//@version=6\nstrategy("TST229", overlay=true)\n'
       'if bar_index == 0\n    strategy.entry("L", strategy.long)\n'
       'if bar_index == 5\n    strategy.close("L")\n'
       'at = strategy.avg_trade\n'
       'np = strategy.netprofit_percent\n'
       'ct = strategy.closedtrades\n'
       'plot(session.isfirstbar ? 1 : 0)\n'
       'plot(session.islastbar ? 1 : 0)\n')

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
    out.at = gv('at'); out.np = gv('np'); out.ct = gv('ct');
    out.bars = pane.bars.length;
    const keys = st.rt.out.plotsOrder;
    const cnt1 = (k) => st.rt.out.plots.get(k).values.filter((v) => v === 1).length;
    out.fbT = cnt1(keys[0]); out.lbT = cnt1(keys[1]);
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
            r = page.evaluate(READ_JS, {'name': 'TST229', 'src': SRC})
            print('    status:', r.get('status'), 'avg=%s np=%s closed=%s bars=%s' % (r.get('at'), r.get('np'), r.get('ct'), r.get('bars')), r.get('probeErr', ''))
            check('engine ok', r['status'] == 'ok', r.get('errors'))
            check('one closed trade live', r.get('ct') == 1, r)
            at, np = r.get('at'), r.get('np')
            check('getters finite live', isinstance(at, (int, float)) and isinstance(np, (int, float)), (at, np))
            fbT, lbT, nb = r.get('fbT') or 0, r.get('lbT') or 0, r.get('bars') or 0
            print('    firstbars=%s lastbars=%s' % (fbT, lbT))
            check('session edges both sides live', 0 < fbT < nb and 0 < lbT < nb, (fbT, lbT, nb))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND229: %d failed' % len(FAILS) if FAILS else 'ROUND229: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
