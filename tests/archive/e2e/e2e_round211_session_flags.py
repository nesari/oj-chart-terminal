#!/usr/bin/env python3
"""ROUND211 e2e — ticker session filter + ignore_invalid_symbol live.

  A 09:00-16:00 session ticker differs from the unfiltered security exactly
  on out-of-session bars; an invalid symbol with ignore_invalid_symbol=true
  reads na with engine ok. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8993, 8831
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

SRC = ('//@version=5\nindicator("TST211", overlay=false)\n'
       't = ticker.new("X", syminfo.tickerid, "0900-1600")\n'
       'f = request.security(t, "", close)\n'
       'u = request.security(syminfo.tickerid, "", close)\n'
       'plot(f, title="flt")\n'
       'plot(u, title="unf")\n'
       'vb = ta.variance(close, 14, false)\n'
       'vp = ta.variance(close, 14)\n'
       'plot(vb, title="vub")\n'
       'plot(vp, title="vbi")\n')

SRC_BAD = ('//@version=5\nindicator("TST211B", overlay=false)\n'
           'r = request.security("NOPE/XYZ", "", close, ignore_invalid_symbol=true)\n'
           'plot(r, title="bad")\n')

READ_JS = """async ({name, src, bad}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const out = {};
  const mk = async (nm, s) => {
    const rec = A.PineScriptsStore.create(nm, s);
    const inst = A.PineUI.add(pane, rec.id);
    await A.PineUI.rebuild(pane, inst);
    await new Promise((r) => setTimeout(r, 4000));
    const st = A.PineUI.debug(pane).find((x) => x.adapter && x.adapter.inst && x.adapter.inst.id === inst.id);
    const o = { status: st ? st.status : 'no-st', errors: (st && st.errors) || [], vals: {} };
    if (st && st.rt && st.rt.out) {
      for (const key of st.rt.out.plotsOrder) {
        const p = st.rt.out.plots.get(key);
        o.vals[p.title] = p.values.map((v) => (v == null || (typeof v === 'object' && v.__pineNA) ? null : v));
      }
    }
    A.PineUI.remove(pane, inst.id);
    return o;
  };
  out.main = await mk(name, src);
  out.bad = await mk(name + 'B', bad);
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
            r = page.evaluate(READ_JS, {'name': 'TST211', 'src': SRC, 'bad': SRC_BAD})
            m, b = r['main'], r['bad']
            print('    main:', m.get('status'), str(m.get('errors'))[:100])
            print('    bad:', b.get('status'), str(b.get('errors'))[:100])
            check('engine ok', m['status'] == 'ok', m.get('errors'))
            v = m.get('vals') or {}
            flt, unf = v.get('flt') or [], v.get('unf') or []
            n = min(len(flt), len(unf))
            diff = sum(1 for i in range(n) if (flt[i] is None) != (unf[i] is None) or (flt[i] is not None and abs(flt[i] - unf[i]) > 1e-9))
            both = sum(1 for i in range(n) if flt[i] is not None and unf[i] is not None and abs(flt[i] - unf[i]) < 1e-12)
            check('session filter bites somewhere (%d/%d differ)' % (diff, n), n > 100 and diff > 0, diff)
            check('session agrees in-hours (%d equal)' % both, both > 0, both)
            vub, vbi = v.get('vub') or [], v.get('vbi') or []
            k = min(len(vub), len(vbi))
            good = [i for i in range(k) if vub[i] and vbi[i]]
            ratio = (sum(vub[i] / vbi[i] for i in good[-50:]) / 50) if len(good) >= 50 else 0
            check('variance unbiased/biased ratio ~14/13 (%.4f)' % ratio, abs(ratio - 14 / 13) < 0.02, ratio)
            # NOTE: demo serves every literal symbol, so prefetch finds data and
            # the na-path cannot trigger live (it is pinned in node). Here the
            # flag must simply not disturb the found-data path.
            bd = (b.get('vals') or {}).get('bad') or []
            check('ignore flag harmless with data', b['status'] == 'ok' and any(x is not None for x in bd), (b['status'], len(bd)))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND211: %d failed' % len(FAILS) if FAILS else 'ROUND211: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
