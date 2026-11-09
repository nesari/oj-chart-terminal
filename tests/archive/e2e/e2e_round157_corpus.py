#!/usr/bin/env python3
"""ROUND157 e2e — remaining corpus on the live app (algoalpha/sessions/smartmoney).

Boots demo feed + renderer, adds each script from the repo corpus, then:
  [1] engine status ok (no error state),
  [2] structural evidence (plots/shapes/drawings counts via debug),
  [3] pixel evidence (saturated pixels on the pine fg canvas),
  [4] zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8956, 8884
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

def check(name, cond, extra=''):
    print(('  PASS ' if cond else '  FAIL ') + name + ((' — ' + str(extra)) if (not cond and extra != '') else ''))
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

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 3000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  let shapes = -1;
  if (st && st.rt) shapes = st.rt.out.shapes ? st.rt.out.shapes.size : -1;
  return {
    instId: inst.id,
    status: st ? st.status : 'no-st',
    errors: (st && st.errors) || [],
    plots: st ? st.plots : -1,
    shapes,
    drawings: st ? (st.boxes + st.lines + st.labels) : -1,
    bars: st ? st.bars : -1,
  };
}"""

PIXELS_JS = """() => {
  const pane = window.__app.App.panes[0];
  const pc = pane._pineCanvases;
  if (!pc || !pc.fg || !pc.fg.width) return -1;
  const img = pc.fg.getContext('2d').getImageData(0, 0, pc.fg.width, pc.fg.height).data;
  let n = 0;
  for (let i = 0; i < img.length; i += 16) {
    if (img[i+3] < 40) continue;
    if (Math.max(img[i], img[i+1], img[i+2]) - Math.min(img[i], img[i+1], img[i+2]) > 30) n++;
  }
  return n;
}"""

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up'); prov.terminate(); return 1
    corpus = os.path.join(ROOT, 'fixtures', 'pine', 'corpus')
    # name, file, structural expectations (plots, shapes, drawings) — minimums
    cases = [
        ('Algo157', 'algoalpha.pine', {'drawings': 5}),
        ('Sessions157', 'sessions.pine', {'plots': 5, 'shapes': 5}),
        ('SMC157', 'smartmoney.pine', {'drawings': 100}),
    ]
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
            for name, f, expect in cases:
                with open(os.path.join(corpus, f), encoding='utf-8') as fh:
                    src = fh.read()
                r = page.evaluate(ADD_JS, {'name': name, 'src': src})
                print('    engine:', name, r.get('status'), 'plots=', r.get('plots'), 'shapes=', r.get('shapes'), 'draw=', r.get('drawings'), 'bars=', r.get('bars'), str(r.get('errors'))[:120])
                check(name + ' engine ok', r['status'] == 'ok', r)
                for k, minimum in expect.items():
                    check(name + ' ' + k + '>=' + str(minimum), (r.get(k) or -1) >= minimum, r.get(k))
                px = page.evaluate(PIXELS_JS)
                check(name + ' paints pixels', px is not None and px > 500, px)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND157: %d failed' % len(FAILS) if FAILS else 'ROUND157: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
