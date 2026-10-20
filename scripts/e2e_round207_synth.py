#!/usr/bin/env python3
"""ROUND207 e2e — synthetic chart-type tickers on the live app.

  The brick is sized from live bar movement (adaptive, any symbol/TF), then
  a 4-ticker script runs: renko closes must be stepwise and match a JS mirror
  of the brick formation bar-for-bar; a bad brick_size errors loud. Zero page
  errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8999, 8827
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

BRICK_JS = """() => {
  const bars = window.__app.App.panes[0].bars;
  const cl = bars.map((b) => b.close).filter((v) => typeof v === 'number' && isFinite(v));
  const tail = cl.slice(-500);
  let m = 0;
  for (let i = 1; i < tail.length; i++) m += Math.abs(tail[i] - tail[i - 1]);
  m /= Math.max(1, tail.length - 1);
  return { brick: m * 3 || 0.01, n: cl.length };
}"""

RUN_JS = """async ({src, brick}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create('TST207', src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 5000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { status: st ? st.status : 'no-st', errors: (st && st.errors) || [], vals: {}, bars: null, bad: null };
  if (st && st.rt && st.rt.out) {
    for (const key of st.rt.out.plotsOrder) {
      const p = st.rt.out.plots.get(key);
      out.vals[p.title] = p.values.map((v) => (v == null || (typeof v === 'object' && v.__pineNA) ? null : v));
    }
  }
  // snapshot bars + plots atomically for the mirror
  out.bars = pane.bars.map((b) => ({ t: b.time, c: b.close }));
  // JS mirror of renkoTransform (same 1-brick rule, price units)
  const exp = new Array(out.bars.length).fill(null);
  let edge = null, up = 0, down = 0;
  for (let i = 0; i < out.bars.length; i++) {
    const C = out.bars[i].c;
    if (typeof C !== 'number' || !isFinite(C)) continue;
    if (edge == null) { edge = C; up = C + brick; down = C - brick; continue; }
    while (C >= up) { edge = up; up += brick; down = edge - brick; exp[i] = edge; }
    while (C <= down) { edge = down; down -= brick; up = edge + brick; exp[i] = edge; }
    if (exp[i] == null) exp[i] = i > 0 ? exp[i - 1] : null;
  }
  out.exp = exp;
  // loud path: bad brick_size
  const rb = A.PineScriptsStore.create('TST207B', '//@version=5\\nindicator("TST207B", overlay=true)\\nt = ticker.renko(syminfo.tickerid, "", 0)\\nplot(request.security(t, "", close))\\n');
  const ib = A.PineUI.add(pane, rb.id);
  await A.PineUI.rebuild(pane, ib);
  await new Promise((r) => setTimeout(r, 2500));
  const sb = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === ib.id);
  out.bad = { status: sb ? sb.status : 'no-st', errors: (sb && sb.errors) || [] };
  A.PineUI.remove(pane, inst.id);
  A.PineUI.remove(pane, ib.id);
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
            bi = page.evaluate(BRICK_JS)
            brick = float(bi['brick'])
            print('    live brick=%.6g over %d closes' % (brick, bi['n']))
            src = ('//@version=5\nindicator("TST207", overlay=true)\n'
                   'rt = ticker.renko(syminfo.tickerid, "", %r)\n'
                   'lb = ticker.linebreak(syminfo.tickerid, "", 3)\n'
                   'kg = ticker.kagi(syminfo.tickerid, "", %r)\n'
                   'pf = ticker.pointfigure(syminfo.tickerid, "", %r, 3)\n'
                   'plot(request.security(rt, "", close), title="rk")\n'
                   'plot(request.security(lb, "", close), title="lb")\n'
                   'plot(request.security(kg, "", close), title="kg")\n'
                   'plot(request.security(pf, "", close), title="pf")\n') % (brick, brick, brick / 2)
            r = page.evaluate(RUN_JS, {'src': src, 'brick': brick})
            print('    engine:', r.get('status'), str(r.get('errors'))[:120])
            check('4-ticker engine ok', r['status'] == 'ok', r.get('errors'))
            v = r.get('vals') or {}
            rk = v.get('rk') or []
            try:
                n = len(rk)
                steps = sum(1 for i in range(1, n) if rk[i] is not None and rk[i - 1] is not None and abs(rk[i] - rk[i - 1]) > 1e-12)
                check('renko stepwise on live data (%d steps/%d)' % (steps, n), n > 100 and steps < n / 2, (steps, n))
            except TypeError:
                check('renko series numeric', False, len(rk))
            try:
                exp = r.get('exp') or []
                m = min(len(rk), len(exp))
                bad = sum(1 for i in range(m) if (rk[i] is None) != (exp[i] is None) or (rk[i] is not None and abs(rk[i] - exp[i]) > 1e-9))
                check('renko == JS mirror (%d bars)' % m, m > 100 and bad == 0, bad)
            except TypeError:
                check('mirror comparable', False, (len(rk), len(r.get('exp') or [])))
            for key in ('lb', 'kg', 'pf'):
                arr = v.get(key) or []
                check(key + ' series present', len(arr) > 100 and any(x is not None for x in arr), len(arr))
            check('bad brick_size loud live', r['bad']['status'] == 'error' and 'brick_size' in str(r['bad'].get('errors')), r['bad'].get('errors'))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND207: %d failed' % len(FAILS) if FAILS else 'ROUND207: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
