#!/usr/bin/env python3
"""ROUND195 e2e — library/import on the live app (local-store resolution).

  A saved library() script + an importing indicator: engine ok, lib-driven
  plots equal their local equivalents (close+10, const, ta.sma parity through
  the library boundary), and an unresolvable import fails loud. Zero page
  errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8988, 8816
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

LIB_SRC = ('//@version=5\nlibrary("TSTLib195")\n'
           'export add10(x) => x + 10\n'
           'export K = 7\n'
           'export avg3(x) => ta.sma(x, 3)\n')

IMP_SRC = ('//@version=5\nindicator("TST195", overlay=false)\n'
           'import Me/TSTLib195/1 as L\n'
           'plot(L.add10(close), title="plus")\n'
           'plot(L.K, title="kay")\n'
           'plot(L.avg3(close), title="sm")\n'
           'plot(ta.sma(close, 3), title="ref")\n')

BAD_SRC = ('//@version=5\nindicator("TST195bad", overlay=false)\n'
           'import Me/NoSuchLib195/1 as N\n'
           'plot(N.f(close), title="x")\n')

ADD_JS = """async ({libName, libSrc, name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const lib = A.PineScriptsStore.create(libName, libSrc);
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { instId: inst.id, status: st ? st.status : 'no-st',
    errors: (st && st.errors) || [], vals: {}, idx: -1 };
  if (st && st.rt && st.rt.out) {
    const bars = pane.bars;
    for (let i = bars.length - 2; i >= Math.max(0, bars.length - 12); i--) {
      if (bars[i].open !== bars[i].close) { out.idx = i; break; }
    }
    if (out.idx >= 0) {
      for (const key of st.rt.out.plotsOrder) {
        const p = st.rt.out.plots.get(key);
        out.vals[p.title] = p.values[out.idx];
      }
      out.close = bars[out.idx].close;
    }
  }
  return out;
}"""

ADD_BAD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 2500));
  // compile-error states carry no adapter — find by the error payload itself
  const st = A.PineUI.debug(pane).find((s) => (s.errors || []).length);
  return { status: st ? st.status : 'no-st', errors: (st && st.errors) || [] };
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
            r = page.evaluate(ADD_JS, {'libName': 'TSTLib195src', 'libSrc': LIB_SRC,
                                       'name': 'TST195', 'src': IMP_SRC})
            print('    engine:', r.get('status'), str(r.get('errors'))[:150])
            check('engine ok', r['status'] == 'ok', r.get('errors'))
            v, c = r.get('vals') or {}, r.get('close')
            check('lib plot present', 'plus' in v and 'kay' in v and 'sm' in v, v)
            try:
                check('add10 == close+10', abs(v['plus'] - (c + 10)) < 1e-9, (v.get('plus'), c))
            except TypeError:
                check('add10 == close+10', False, (v.get('plus'), c))
            check('exported const == 7', v.get('kay') == 7, v.get('kay'))
            try:
                check('lib sma == local sma', abs(v['sm'] - v['ref']) < 1e-9, (v.get('sm'), v.get('ref')))
            except TypeError:
                check('lib sma == local sma', False, (v.get('sm'), v.get('ref')))
            b = page.evaluate(ADD_BAD_JS, {'name': 'TST195bad', 'src': BAD_SRC})
            check('missing lib is error status', b.get('status') == 'error', b.get('status'))
            msgs = ' '.join([(e.get('message') if isinstance(e, dict) else str(e)) for e in (b.get('errors') or [])])
            check('missing lib names the shelf', 'no matching library' in msgs, msgs[:160])
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND195: %d failed' % len(FAILS) if FAILS else 'ROUND195: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
