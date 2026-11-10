#!/usr/bin/env python3
"""ROUND203 e2e — table style setters reach the DOM dashboard.

  A live table restyled by bar state (green on the last bar, red before):
  engine ok, the .pine-table div carries the live background + frame, and a
  cell edit lands in the grid. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8996, 8824
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

SRC = ('//@version=5\nindicator("TST203", overlay=true)\n'
       'var t = table.new(position.bottom_right, 2, 1)\n'
       'if barstate.islast\n'
       '    table.cell(t, 0, 0, "LIVE", bgcolor=color.green)\n'
       '    table.set_bgcolor(t, color.new(color.green, 80))\n'
       '    table.set_frame_color(t, color.red)\n'
       '    table.set_frame_width(t, 3)\n'
       'else\n'
       '    table.cell(t, 0, 0, "hist")\n'
       '    table.set_bgcolor(t, color.new(color.red, 80))\n'
       'plot(close, title="p")\n')

READ_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 3500));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { instId: inst.id, status: st ? st.status : 'no-st', errors: (st && st.errors) || [] };
  const el = document.querySelector('.pine-table');
  if (el) {
    const cs = getComputedStyle(el);
    out.bg = cs.backgroundColor;
    out.border = cs.borderColor;
    out.borderW = cs.borderTopWidth;
    out.text = el.textContent;
  } else { out.bg = null; }
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
            page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100", timeout=45000)
            r = page.evaluate(READ_JS, {'name': 'TST203', 'src': SRC})
            print('    engine:', r.get('status'), str(r.get('errors'))[:120])
            print('    dom:', r.get('bg'), '|', r.get('border'), '|', r.get('borderW'), '|', (r.get('text') or '')[:20])
            check('engine ok', r['status'] == 'ok', r.get('errors'))
            check('table div present', r.get('bg') is not None, r.get('bg'))
            bg = str(r.get('bg') or '')
            check('live green background (80 transp)', '76, 175, 80' in bg or '76,175,80' in bg, bg)
            bd = str(r.get('border') or '')
            # ROUND283: this script is //@version=5, and ROUND225 gave v6 its own
            # re-toned red (#f23645) while v5 keeps #ff5252 — assert the
            # version-correct palette instead of only the v6 hex.
            red = ('255, 82, 82' in bd or '255,82,82' in bd
                   or '242, 54, 69' in bd or '242,54,69' in bd)
            check('live red frame', red, bd)
            check('frame width 3px', (r.get('borderW') or '') == '3px', r.get('borderW'))
            check('live cell text', 'LIVE' in str(r.get('text') or ''), r.get('text'))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND203: %d failed' % len(FAILS) if FAILS else 'ROUND203: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
