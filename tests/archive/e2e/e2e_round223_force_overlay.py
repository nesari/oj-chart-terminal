#!/usr/bin/env python3
"""ROUND223 e2e — force_overlay paints on the main chart from a sub-pane script.

  overlay=false script with one forced + one unforced box: engine ok, the
  forced box's y-mapping uses the main series (routing), and the fg canvas
  holds painted pixels inside the MAIN plot rect (paint proof). Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8965, 8844
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

SRC = ('//@version=6\nindicator("TST223", overlay=false)\n'
       'b1 = box.new(bar_index - 5, close * 1.02, bar_index, close * 0.98, bgcolor=color.new(color.red, 0), force_overlay=true)\n'
       'b2 = box.new(bar_index - 5, 0, bar_index, 1, bgcolor=color.new(color.blue, 0))\n'
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
  await new Promise((r) => setTimeout(r, 1500));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { instId: inst.id, status: st ? st.status : 'no-st', errors: (st && st.errors) || [] };
  try {
    const ad = st.adapter;
    const boxes = [...st.rt.store.box.values()];
    out.boxes = boxes.length;
    out.forced = boxes.filter((b) => b.force_overlay).length;
    const px = 1.0;
    out.yPlain = ad._yOf(px);
    out.yForced = ad._yOf(px, true);
    out.yMain = pane.series.priceToCoordinate(px);
    const r = ad._paintRect(true);
    out.mainRect = r;
    const cv = pane._pineCanvases.fg;
    const ctx = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(pane.host.clientWidth), h = Math.floor(r.h);
    const img = ctx.getImageData(0, 0, Math.floor(w * dpr), Math.floor(h * dpr)).data;
    let n = 0;
    for (let i = 3; i < img.length; i += 4) if (img[i] > 0) n++;
    out.mainPx = n;
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
            r = page.evaluate(READ_JS, {'name': 'TST223', 'src': SRC})
            print('    status:', r.get('status'), 'boxes=%s forced=%s mainPx=%s' % (r.get('boxes'), r.get('forced'), r.get('mainPx')), r.get('probeErr', ''))
            check('engine ok (sub-pane script)', r['status'] == 'ok', r.get('errors'))
            check('forced + plain boxes stored ( uncapped per-bar )', (r.get('boxes') or 0) > 0 and (r.get('forced') or 0) > 0 and (r.get('boxes') or 0) > (r.get('forced') or 0), (r.get('boxes'), r.get('forced')))
            yP, yF, yM = r.get('yPlain'), r.get('yForced'), r.get('yMain')
            check('forced y-mapping rides the main series', isinstance(yF, (int, float)) and isinstance(yM, (int, float)) and abs(yF - yM) < 2, (yP, yF, yM))
            check('forced mapping differs from sub mapping', yP != yF, (yP, yF))
            check('paint pixels inside MAIN rect', isinstance(r.get('mainPx'), int) and r.get('mainPx') > 50, r.get('mainPx'))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND223: %d failed' % len(FAILS) if FAILS else 'ROUND223: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
