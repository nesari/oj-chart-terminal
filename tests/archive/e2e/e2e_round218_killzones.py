#!/usr/bin/env python3
"""ROUND218 e2e — ICT Killzones & Pivots draws on the live chart.

  The fixture (fixtures/pine/killzones_tfo.pine) carries the 3-line
  left-edge guard (upstream crashes when history starts mid-session —
  TV-identical, see CHANGELOG 216), so this is deterministic: engine ok,
  drawings on the overlay pane, data table present. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8959, 8838
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

with open(os.path.join(ROOT, 'fixtures', 'pine', 'killzones_tfo.pine'), encoding='utf-8') as f:
    SRC = f.read()

READ_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 5000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { instId: inst.id, status: st ? st.status : 'no-st', errors: (st && st.errors) || [],
                overlay: !!(st && st.rt && st.rt.meta && st.rt.meta.overlay),
                sub: !!(st && st.adapter && st.adapter.sub),
                box: 0, line: 0, label: 0, table: 0, cells: 0 };
  if (st && st.rt && st.rt.store) {
    out.box = st.rt.store.box.size; out.line = st.rt.store.line.size;
    out.label = st.rt.store.label.size; out.table = st.rt.store.table.size;
    for (const t of st.rt.store.table.values()) out.cells += t.cells.size;
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
            r = page.evaluate(READ_JS, {'name': 'TST218', 'src': SRC})
            print('    engine:', r.get('status'), str(r.get('errors'))[:150],
                  'overlay=%s sub=%s box=%s line=%s label=%s table=%s cells=%s' % (
                      r.get('overlay'), r.get('sub'), r.get('box'), r.get('line'),
                      r.get('label'), r.get('table'), r.get('cells')))
            check('engine ok', r['status'] == 'ok', r.get('errors'))
            check('renders on main chart (overlay, no sub-pane)', r.get('overlay') is True and r.get('sub') is False, r)
            check('killzone drawings live', (r.get('box', 0) + r.get('line', 0) + r.get('label', 0)) > 0, r)
            check('data table live', r.get('table', 0) > 0 and r.get('cells', 0) > 0, r)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND218: %d failed' % len(FAILS) if FAILS else 'ROUND218: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
