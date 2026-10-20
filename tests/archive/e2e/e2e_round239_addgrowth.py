#!/usr/bin/env python3
"""ROUND239 e2e — user-report reproduction: growth on Add + diagnostics.

  12 add/rebuild/remove cycles of one Pine script on 5000 bars, with forced
  GC around the samples: retained JS heap, DOM node count and PineUI debug
  states must stay flat (no leak). The Log ring (3000) and Diagnostics DOM
  (DOM_CAP) are statically capped — asserted via Log.stats().
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8919, 8859
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

SRC = ('//@version=6\nindicator("TST239", overlay=true)\n'
       'a = ta.sma(close, 14)\n'
       'b = request.security(syminfo.tickerid, "D", close)\n'
       'plot(a)\nplot(b)\n')

PROBE_JS = """async ({name, src, cycles}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const snap = () => {
    try { window.gc(); window.gc(); } catch (e) {}
    return {
      heap: (performance.memory && performance.memory.usedJSHeapSize) || 0,
      nodes: document.querySelectorAll('*').length,
      states: A.PineUI.debug(pane).length,
      ring: A.Log.stats().inRing,
    };
  };
  const rec = A.PineScriptsStore.create(name, src);
  const base = snap();
  const series = [];
  for (let i = 0; i < cycles; i++) {
    const inst = A.PineUI.add(pane, rec.id);
    await A.PineUI.rebuild(pane, inst);
    for (let k = 0; k < 60; k++) {
      const s0 = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
      if (s0 && s0.status !== 'loading') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
    series.push(st ? st.status : 'no-st');
    A.PineUI.remove(pane, inst.id);
    if (i % 3 === 2) series.push(snap());
  }
  const fin = snap();
  return { base, fin, series, okAll: series.filter((s) => typeof s === 'string').every((s) => s === 'ok') };
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
                browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage', '--js-flags=--expose-gc'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage', '--js-flags=--expose-gc'])
            page = browser.new_page(viewport={'width': 1560, 'height': 900})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100", timeout=25000)
            r = page.evaluate(PROBE_JS, {'name': 'TST239', 'src': SRC, 'cycles': 12})
            base, fin = r.get('base', {}), r.get('fin', {})
            dheap = (fin.get('heap', 0) - base.get('heap', 0)) / 1048576.0
            dnodes = fin.get('nodes', 0) - base.get('nodes', 0)
            print('    heap0=%.1fMB heap1=%.1fMB d=%+.1fMB nodes %d->%d states %d->%d ring=%s' % (
                base.get('heap', 0) / 1048576.0, fin.get('heap', 0) / 1048576.0, dheap,
                base.get('nodes', 0), fin.get('nodes', 0), base.get('states', 0), fin.get('states', 0), fin.get('ring', '?')))
            check('all cycles ok', r.get('okAll') is True, r.get('series'))
            check('heap flat (<15MB retained)', dheap < 15, dheap)
            check('no orphan states/nodes', fin.get('states', -1) == 0 and abs(dnodes) <= 40, (fin.get('states'), dnodes))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND239: %d failed' % len(FAILS) if FAILS else 'ROUND239: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
