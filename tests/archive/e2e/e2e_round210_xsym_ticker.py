#!/usr/bin/env python3
"""ROUND210 e2e — static prefetch for synthetic ticker handles.

  A cross-symbol renko ticker must be prefetched statically: the xsymPairs
  debug probe contains the SYM|baseSec pair (no first-run failure + retry
  flash), the engine runs ok, and the renko series is stepwise. Zero page
  errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8992, 8830
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

SETUP_JS = """() => {
  const pane = window.__app.App.panes[0];
  const sym = pane.symbol || '';
  const xsym = /EUR/i.test(sym) ? 'GBPUSD' : 'EURUSD';
  const bars = pane.bars;
  const cl = bars.map((b) => b.close).filter((v) => typeof v === 'number' && isFinite(v));
  const tail = cl.slice(-500);
  let m = 0;
  for (let i = 1; i < tail.length; i++) m += Math.abs(tail[i] - tail[i - 1]);
  m /= Math.max(1, tail.length - 1);
  return { xsym, brick: m * 3 || 0.01, chartSym: sym, tf: pane.tf };
}"""

RUN_JS = """async ({src, xsym}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create('TST210', src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 6000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { status: st ? st.status : 'no-st', errors: (st && st.errors) || [],
                pairs: (st && st.xsymPairs) || null, vals: {} };
  if (st && st.rt && st.rt.out) {
    for (const key of st.rt.out.plotsOrder) {
      const p = st.rt.out.plots.get(key);
      out.vals[p.title] = p.values.map((v) => (v == null || (typeof v === 'object' && v.__pineNA) ? null : v));
    }
  }
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
            s = page.evaluate(SETUP_JS)
            xsym, brick = s['xsym'], float(s['brick'])
            print('    chart %s %s -> xsym %s brick %.6g' % (s['chartSym'], s['tf'], xsym, brick))
            src = ('//@version=5\nindicator("TST210", overlay=true)\n'
                   't = ticker.renko("%s", "D", %r)\n'
                   'plot(request.security(t, "", close), title="rk")\n') % (xsym, brick)
            r = page.evaluate(RUN_JS, {'src': src, 'xsym': xsym})
            print('    engine:', r.get('status'), str(r.get('errors'))[:120])
            print('    pairs:', r.get('pairs'))
            check('engine ok', r['status'] == 'ok', r.get('errors'))
            pairs = r.get('pairs') or []
            check('static scan saw ticker handle', any(str(p).startswith(xsym + '|') for p in pairs), pairs)
            check('prefetched at daily base', (xsym + '|86400') in [str(p) for p in pairs], pairs)
            rk = (r.get('vals') or {}).get('rk') or []
            n = len(rk)
            try:
                steps = sum(1 for i in range(1, n) if rk[i] is not None and rk[i - 1] is not None and abs(rk[i] - rk[i - 1]) > 1e-12)
                check('cross-sym renko stepwise (%d steps/%d)' % (steps, n), n > 100 and steps < n / 2, (steps, n))
            except TypeError:
                check('renko series numeric', False, n)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND210: %d failed' % len(FAILS) if FAILS else 'ROUND210: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
