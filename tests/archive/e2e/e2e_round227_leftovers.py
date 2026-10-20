#!/usr/bin/env python3
"""ROUND227 e2e — forced plot lines + markers paint on the main chart.

  overlay=false script, phase A with force_overlay on plot()+plotshape(),
  phase B without: engine ok both ways; pine fg canvas holds painted pixels
  inside the MAIN rect only in phase A (differential paint proof). Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8969, 8848
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

def SRC(forced):
    flag = ', force_overlay=true' if forced else ''
    return ('//@version=6\nindicator("TST227", overlay=false)\n'
            'plot(close%s)\n'
            'plotshape(bar_index %% 5 == 0, style=shape.circle%s)\n' % (flag, flag))

READ_JS = """async ({src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const out = {};
  const rec = A.PineScriptsStore.create('TST227', src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  for (let i = 0; i < 40; i++) {
    const s0 = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
    if (s0 && s0.status !== 'loading') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await new Promise((r) => setTimeout(r, 1200));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  out.status = st ? st.status : 'no-st';
  out.errors = (st && st.errors) || [];
  try {
    const ad = st.adapter;
    const r = ad._paintRect(true);
    const cv = pane._pineCanvases.fg;
    const ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(pane.host.clientWidth), h = Math.floor(r.h);
    const img = ctx.getImageData(0, Math.floor(r.top * dpr), Math.floor(w * dpr), Math.floor(h * dpr)).data;
    let n = 0;
    for (let i = 3; i < img.length; i += 4) if (img[i] > 0) n++;
    out.mainPx = n;
    out.plots = [...st.rt.out.plots.values()].map((p) => !!p.force_overlay);
    out.shapes = [...st.rt.out.shapes.values()].map((s) => !!s.force_overlay);
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
            a = page.evaluate(READ_JS, {'src': SRC(True)})
            print('    forced:', a.get('status'), 'mainPx=%s plots=%s shapes=%s' % (a.get('mainPx'), a.get('plots'), a.get('shapes')), a.get('probeErr', ''))
            b = page.evaluate(READ_JS, {'src': SRC(False)})
            print('    plain: ', b.get('status'), 'mainPx=%s' % (b.get('mainPx'),), b.get('probeErr', ''))
            check('engine ok both phases', a['status'] == 'ok' and b['status'] == 'ok', (a.get('errors'), b.get('errors')))
            check('forced flags stored live', a.get('plots') == [True] and a.get('shapes') == [True], (a.get('plots'), a.get('shapes')))
            check('main-rect paint only when forced', (a.get('mainPx') or 0) > 100 and (b.get('mainPx') or 0) < (a.get('mainPx') or 0) // 10 + 10, (a.get('mainPx'), b.get('mainPx')))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND227: %d failed' % len(FAILS) if FAILS else 'ROUND227: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
