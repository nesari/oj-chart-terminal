#!/usr/bin/env python3
"""ROUND168 e2e — cross-symbol request.security on the live app (phase 1a).

  GBPUSD chart + request.security("EURUSD", <chart TF>, close): engine ok,
  and the security plot tail equals EURUSD's own close on the last closed
  bar (fetched live via the feed — closed bar, tick-immune like round 161).
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8967, 8895
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if (not cond and extra != '') else ''))
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

SRC = ('//@version=5\nindicator("xsym168", overlay=false)\n'
       'c = request.security("EURUSD", "", close)\n'
       'plot(c, title="xeur")\n'
       'plot(close, title="here")\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  let xeur = null, here = null, idx = -1;
  if (st && st.rt && st.rt.out) {
    const bars = pane.bars;
    for (let i = bars.length - 2; i >= Math.max(0, bars.length - 12); i--) {
      if (bars[i].open !== bars[i].close) { idx = i; break; }
    }
    if (idx >= 0) {
      for (const key of st.rt.out.plotsOrder) {
        const p = st.rt.out.plots.get(key);
        if (p.title === 'xeur') xeur = p.values[idx];
        if (p.title === 'here') here = p.values[idx];
      }
    }
  }
  return { instId: inst.id, status: st ? st.status : 'no-st', errors: (st && st.errors) || [],
           xeur, here, idx, tf: pane.tf, symbol: pane.symbol };
}"""

FEED_JS = """async ({tf}) => {
  const A = window.__app;
  const resp = await A.App.feed.bars('EURUSD', tf, 5);
  const bars = (resp && resp.bars) || [];
  const b = bars.length >= 2 ? bars[bars.length - 2] : null;
  return b ? { time: b.time, close: b.close } : null;
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
            # switch the chart to GBPUSD so EURUSD is genuinely foreign
            page.evaluate("""() => {
              const A = window.__app;
              const pane = A.App.panes[0];
              return A.Manager.setSymbol ? A.Manager.setSymbol(pane, 'GBPUSD') : null;
            }""")
            page.wait_for_timeout(2500)
            r = page.evaluate(ADD_JS, {'name': 'XSYM168', 'src': SRC})
            print('    chart:', r.get('symbol'), r.get('tf'), 'engine:', r.get('status'), str(r.get('errors'))[:120])
            check('chart is GBPUSD', r.get('symbol') == 'GBPUSD', r.get('symbol'))
            check('engine ok (was: loud throw)', r['status'] == 'ok', r.get('errors'))
            check('security plot has a value', isinstance(r.get('xeur'), (int, float)), r.get('xeur'))
            check('security != chart close (foreign data)', r.get('xeur') != r.get('here'), (r.get('xeur'), r.get('here')))
            f = page.evaluate(FEED_JS, {'tf': r.get('tf')})
            if f and isinstance(r.get('xeur'), (int, float)):
                # closed-bar comparison can still straddle a bar boundary on a
                # live feed; allow one bar of slippage via the feed window
                page.wait_for_timeout(500)
                f2 = page.evaluate(FEED_JS, {'tf': r.get('tf')})
                okv = abs(r['xeur'] - f['close']) < 1e-9 or (f2 and abs(r['xeur'] - f2['close']) < 1e-9)
                check('security == EURUSD close', okv, (r['xeur'], f, f2))
            else:
                check('security == EURUSD close', False, (r.get('xeur'), f))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND168: %d failed' % len(FAILS) if FAILS else 'ROUND168: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
