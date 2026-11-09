#!/usr/bin/env python3
"""ROUND205 e2e — deleted drawings are loud + gone on the live chart.

  BAD script (use-after-delete): engine errors with "was deleted".
  OK script (delete on last bar): engine ok and the box store is empty.
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8997, 8825
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

SRC_BAD = ('//@version=5\nindicator("TST205B", overlay=true)\n'
           'l = line.new(bar_index, high, bar_index + 1, low)\n'
           'line.delete(l)\n'
           'x = line.get_x1(l)\n'
           'plot(close, title="p")\n')

SRC_OK = ('//@version=5\nindicator("TST205G", overlay=true)\n'
          'var b = box.new(bar_index, high, bar_index + 1, low)\n'
          'if barstate.islast\n'
          '    box.delete(b)\n'
          'plot(close, title="p")\n')

READ_JS = """async ({bad, good}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const out = {};
  for (const [key, src] of [['bad', bad], ['good', good]]) {
    const rec = A.PineScriptsStore.create('TST205' + key, src);
    const inst = A.PineUI.add(pane, rec.id);
    await A.PineUI.rebuild(pane, inst);
    await new Promise((r) => setTimeout(r, 2500));
    const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
    out[key] = { status: st ? st.status : 'no-st', errors: (st && st.errors) || [],
                 boxes: st ? st.boxes : -1, lines: st ? st.lines : -1 };
    A.PineUI.remove(pane, inst.id);
  }
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
            r = page.evaluate(READ_JS, {'bad': SRC_BAD, 'good': SRC_OK})
            print('    bad:', r['bad'].get('status'), str(r['bad'].get('errors'))[:140])
            print('    good:', r['good'].get('status'), 'boxes=%s lines=%s' % (r['good'].get('boxes'), r['good'].get('lines')))
            check('use-after-delete errors the engine', r['bad']['status'] == 'error', r['bad'].get('errors'))
            check('error names the deleted line', 'was deleted' in str(r['bad'].get('errors')), r['bad'].get('errors'))
            check('clean delete runs ok', r['good']['status'] == 'ok', r['good'].get('errors'))
            check('deleted box gone from store', r['good'].get('boxes') == 0, r['good'])
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND205: %d failed' % len(FAILS) if FAILS else 'ROUND205: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
