#!/usr/bin/env python3
"""ROUND201 e2e — session.* on the live app (killzone-style usage).

  NY-session flag plotted over chart history: engine ok, binary values with
  both states present at a sane daytime fraction, and a bad spec fails loud.
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8994, 8822
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

SRC = ('//@version=5\nindicator("TST201", overlay=false)\n'
       'inNY = session.ismarket(time, "0930-1600:23456", "America/New_York")\n'
       'preNY = session.ispremarket(time, "0930-1600:23456", "America/New_York")\n'
       'plot(inNY ? 1 : 0, title="ny")\n'
       'plot(preNY ? 1 : 0, title="pre")\n')

BAD_SRC = ('//@version=5\nindicator("TST201bad", overlay=false)\n'
           'plot(session.ismarket(time, "nope", "GMT") ? 1 : 0, title="x")\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { instId: inst.id, status: st ? st.status : 'no-st',
    errors: (st && st.errors) || [], ny: [], pre: [] };
  if (st && st.rt && st.rt.out) {
    for (const key of st.rt.out.plotsOrder) {
      const p = st.rt.out.plots.get(key);
      if (p.title === 'ny') out.ny = p.values.filter((v) => v != null);
      if (p.title === 'pre') out.pre = p.values.filter((v) => v != null);
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
            r = page.evaluate(ADD_JS, {'name': 'TST201', 'src': SRC})
            print('    engine:', r.get('status'), str(r.get('errors'))[:120])
            check('engine ok', r['status'] == 'ok', r.get('errors'))
            ny, pre = r.get('ny') or [], r.get('pre') or []
            check('ny values binary', len(ny) > 50 and all(v in (0, 1) for v in ny), len(ny))
            check('both session states present', 0 in ny and 1 in ny, (ny.count(1), len(ny)))
            frac = (sum(ny) / len(ny)) if ny else -1
            check('daytime fraction sane (6.5h NY of 24h)', 0.15 <= frac <= 0.40, round(frac, 3))
            check('premarket oscillates too', 0 in pre and 1 in pre, (pre.count(1), len(pre)))
            b = page.evaluate(ADD_BAD_JS, {'name': 'TST201bad', 'src': BAD_SRC})
            check('bad spec is error status', b.get('status') == 'error', b.get('status'))
            msgs = ' '.join([(e.get('message') if isinstance(e, dict) else str(e)) for e in (b.get('errors') or [])])
            check('bad spec loud', 'bad session' in msgs, msgs[:160])
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND201: %d failed' % len(FAILS) if FAILS else 'ROUND201: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
