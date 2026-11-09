#!/usr/bin/env python3
"""ROUND200 e2e — box extend paints to the pane edge (TV parity).

  Same magenta box geometry twice (control extend.none vs extend.right):
  the extended run's rightmost magenta column must reach the fg canvas edge
  while the control's ends well inside. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8992, 8820
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

def SRC(ext):
    line = ('\nline.new(bar_index - 10, close, bar_index - 5, close, extend=extend.right, '
            'color=color.new(#00ffff, 0), width=3)\n' if ext == 'x' else '\n')
    return ('//@version=5\nindicator("TST200%s", overlay=true)\n'
            'if barstate.islast\n'
            '    box.new(bar_index - 10, close + 0.004, bar_index - 5, close - 0.004, '
            'bgcolor=color.new(color.magenta, 0), border_color=color.new(color.magenta, 0)%s)%s'
            'plot(close, title="p")\n') % (ext, ', extend=extend.right' if ext == 'x' else '', line)

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 2500));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  return { instId: inst.id, status: st ? st.status : 'no-st', errors: (st && st.errors) || [] };
}"""

SCAN_JS = """() => {
  // rightmost column per paint color on the pine fg canvas (magenta = boxes,
  // cyan = the extend.right reference line — same edge convention as _lineEnds)
  const pane = window.__app.App.panes[0];
  const pc = pane._pineCanvases;
  if (!pc || !pc.fg || !pc.fg.width) return { w: -1, mag: -1, cyn: -1 };
  const c = pc.fg;
  let img;
  try { img = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; }
  catch (e) { return { w: c.width, mag: -2, cyn: -2 }; }
  let mag = -1, cyn = -1;
  const W = c.width, H = c.height;
  for (let y = 0; y < H; y += 2) {
    for (let x = Math.max(0, Math.max(mag, cyn)); x < W; x += 2) {
      const i = (y * W + x) * 4;
      if (img[i + 3] < 40) continue;
      if (img[i] > 200 && img[i + 2] > 200 && img[i + 1] < 110 && x > mag) mag = x;
      if (img[i + 1] > 200 && img[i + 2] > 200 && img[i] < 110 && x > cyn) cyn = x;
    }
  }
  return { w: W, mag, cyn };
}"""

RM_JS = """(instId) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const inst = (pane.pineScripts || []).find((i) => i.id === instId);
  if (inst) A.PineUI.remove(pane, inst.id);
  return true;
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
            r1 = page.evaluate(ADD_JS, {'name': 'TST200c', 'src': SRC('c')})
            print('    control:', r1.get('status'), str(r1.get('errors'))[:100])
            check('control engine ok', r1['status'] == 'ok', r1.get('errors'))
            page.wait_for_timeout(1200)
            m1 = page.evaluate(SCAN_JS)
            print('    control scan:', m1)
            check('control box paints', (m1.get('mag') or -1) > 50, m1)
            page.evaluate(RM_JS, r1['instId'])
            page.wait_for_timeout(800)
            r2 = page.evaluate(ADD_JS, {'name': 'TST200x', 'src': SRC('x')})
            print('    extended:', r2.get('status'), str(r2.get('errors'))[:100])
            check('extended engine ok', r2['status'] == 'ok', r2.get('errors'))
            page.wait_for_timeout(1200)
            m2 = page.evaluate(SCAN_JS)
            print('    extended scan:', m2)
            w = m2.get('w') or 0
            # the LWC price scale overlays the right ~60px (opaque): the box
            # paints underneath (same convention as lines), so the pinned
            # assertions are relative, not absolute-edge
            check('extended outruns control', m2.get('mag', -1) - m1.get('mag', -1) > 40, (m1, m2))
            try:
                check('box edge == line edge (same convention)', abs(m2['mag'] - m2['cyn']) <= 8, m2)
            except TypeError:
                check('box edge == line edge (same convention)', False, m2)
            check('control ends inside', m1.get('mag', w) < w - 60, m1)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND200: %d failed' % len(FAILS) if FAILS else 'ROUND200: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
