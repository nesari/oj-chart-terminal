#!/usr/bin/env python3
"""ROUND196 e2e — matrix.* + map.* on the live app.

  Indicator builds a 2x2 float matrix from close, a transposed copy, and a
  string->float map: engine ok, cell/sum/shape/map reads equal close-derived
  values, and matrix<box> fails loud. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8989, 8817
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

SRC = ('//@version=5\nindicator("TST196", overlay=false)\n'
       'm = matrix.new<float>(2, 2, 0.0)\n'
       'm.set(0, 0, close)\nm.set(0, 1, close)\nm.set(1, 0, close)\nm.set(1, 1, close)\n'
       't = m.transpose()\n'
       'plot(m.get(1, 1), title="cell")\n'
       'plot(m.sum(), title="msum")\n'
       'plot(matrix.rows(m) * 10 + matrix.columns(m), title="shape")\n'
       'plot(t.get(0, 1), title="tc")\n'
       'mp = map.new<string, float>()\n'
       'mp.put("c", close)\nmp.put("k", 42.0)\n'
       'plot(mp.get("c"), title="mget")\n'
       'plot(mp.size(), title="msize")\n')

BAD_SRC = ('//@version=5\nindicator("TST196bad", overlay=false)\n'
           'm = matrix.new<box>(2, 2)\n'
           'plot(1, title="x")\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { instId: inst.id, status: st ? st.status : 'no-st',
    errors: (st && st.errors) || [], vals: {}, idx: -1 };
  if (st && st.rt && st.rt.out) {
    const bars = pane.bars;
    /* ROUND283: the plots are computed against the runtime's OWN bar array.
       A live tick can append a bar between the rebuild and this read, which
       shifts one index and made this suite flaky under load. Read the
       runtime's bars (the array the pass actually used), and pick a bar whose
       values are settled (not the forming last bar). */
    const rb = (st.rt.bars && st.rt.bars.length) ? st.rt.bars : bars;
    out.barsSeen = rb.length;
    for (let i = Math.min(rb.length - 2, st.rt.totalBars - 2); i >= Math.max(0, rb.length - 12); i--) {
      if (i < 0) continue;
      if (rb[i].open !== rb[i].close) { out.idx = i; break; }
    }
    if (out.idx >= 0) {
      for (const key of st.rt.out.plotsOrder) {
        const p = st.rt.out.plots.get(key);
        out.vals[p.title] = p.values[out.idx];
      }
      out.close = rb[out.idx].close;
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
            r = page.evaluate(ADD_JS, {'name': 'TST196', 'src': SRC})
            print('    engine:', r.get('status'), str(r.get('errors'))[:150])
            check('engine ok', r['status'] == 'ok', r.get('errors'))
            v, c = r.get('vals') or {}, r.get('close')
            try:
                check('cell == close', abs(v['cell'] - c) < 1e-9, (v.get('cell'), c))
                check('sum == 4x close', abs(v['msum'] - 4 * c) < 1e-6, (v.get('msum'), c))
                check('transpose cell == close', abs(v['tc'] - c) < 1e-9, (v.get('tc'), c))
                check('map get == close', abs(v['mget'] - c) < 1e-9, (v.get('mget'), c))
            except TypeError:
                check('matrix/map values numeric', False, v)
            check('shape 2x2', v.get('shape') == 22, v.get('shape'))
            check('map size 2', v.get('msize') == 2, v.get('msize'))
            b = page.evaluate(ADD_BAD_JS, {'name': 'TST196bad', 'src': BAD_SRC})
            check('matrix<box> is error status', b.get('status') == 'error', b.get('status'))
            msgs = ' '.join([(e.get('message') if isinstance(e, dict) else str(e)) for e in (b.get('errors') or [])])
            check('matrix<box> loud', 'not supported' in msgs, msgs[:160])
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND196: %d failed' % len(FAILS) if FAILS else 'ROUND196: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
