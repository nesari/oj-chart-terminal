#!/usr/bin/env python3
"""ROUND224 e2e — v6 features live: once, int sizes, cell formatting.

  Script with once counter + int-size bold label + formatted table cells must
  reach engine ok; the once counter reads 1 from the live runtime; the table
  cell div carries 18px + bold. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8966, 8845
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

SRC = ('//@version=6\nindicator("TST224", overlay=true)\n'
       'var n = 0\nonce\n    n := n + 1\n'
       'l = label.new(bar_index, high, "TST224LBL", size=16, text_formatting=text.format_bold)\n'
       't = table.new(position.top_right, 2, 1)\n'
       'table.cell(t, 0, 0, "a", text_size=18, text_formatting=text.format_bold)\n'
       'plot(close)\n')

READ_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  for (let i = 0; i < 40; i++) {
    const s0 = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
    if (s0 && s0.status !== 'loading') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await new Promise((r) => setTimeout(r, 1200));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { instId: inst.id, status: st ? st.status : 'no-st', errors: (st && st.errors) || [] };
  try {
    out.once = st.rt.globals.get('n').value;
    const labels = [...st.rt.store.label.values()];
    out.labels = labels.length;
    out.lsize = labels.length ? labels[labels.length - 1].size : null;
    out.lfmt = labels.length ? labels[labels.length - 1].text_formatting : null;
    const cell = document.querySelector('.pine-tcell');
    out.cellText = cell ? cell.textContent : null;
    out.cellSize = cell ? cell.style.fontSize : null;
    out.cellWeight = cell ? cell.style.fontWeight : null;
  } catch (e) { out.probeErr = String(e); }
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
            r = page.evaluate(READ_JS, {'name': 'TST224', 'src': SRC})
            print('    status:', r.get('status'), 'once=%s lsize=%s cell=%s/%s' % (r.get('once'), r.get('lsize'), r.get('cellSize'), r.get('cellWeight')), r.get('probeErr', ''))
            check('engine ok with v6 features', r['status'] == 'ok', r.get('errors'))
            check('once counter is 1 live', r.get('once') == 1, r)
            check('label int size + bold stored live', r.get('lsize') == 16 and r.get('lfmt') == 'bold', r)
            check('table cell 18px bold in DOM', r.get('cellText') == 'a' and r.get('cellSize') == '18px' and r.get('cellWeight') == 'bold', r)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND224: %d failed' % len(FAILS) if FAILS else 'ROUND224: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
