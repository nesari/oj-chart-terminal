#!/usr/bin/env python3
"""ROUND249 e2e — freehand end handle + bend controls ride, live.

  - brush end handle (idx 1) moves the LAST point, not points[1]
  - a path bend control shifts with the body (same t/p deltas as points)
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8936, 8876
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

HANDLE_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const vw = pane.engine.view();
  const list = A.App.drawings.list(pane.symbol);
  const d = list[list.length - 1];
  const n = d.points.length;
  const before1 = JSON.stringify(d.points[1]);
  const beforeLast = JSON.stringify(d.points[n - 1]);
  const bars = pane.bars;
  const np = { t: bars[50].time, p: bars[50].close + 5 };
  A.DrawTools.brush.dragHandle(vw, d, 1, np);
  return { n, same1: JSON.stringify(d.points[1]) === before1,
    lastMoved: JSON.stringify(d.points[n - 1]) === JSON.stringify(np),
    lastWas: beforeLast };
}"""

INJECT_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const bars = pane.bars;
  const P = (i, dp) => ({ t: bars[i].time, p: bars[i].close + (dp || 0) });
  const n = bars.length;
  const d = { type: 'path', points: [P(n - 60, 0), P(n - 50, 0), P(n - 40, 0)],
    opts: { color: '#2962ff', width: 2, style: 'solid', ctrls: [P(n - 55, 0.0005)] } };
  A.App.drawings.add(pane.symbol, d);
  const list = A.App.drawings.list(pane.symbol);
  const back = list[list.length - 1];
  A.App.selection = { pane, d: back };
  const vw = pane.engine.view();
  const xs = back.points.map((p) => vw.xOf(p.t)), ys = back.points.map((p) => vw.yOf(p.p));
  const pr = pane.engine.canvas.getBoundingClientRect();
  /* grab the quad midpoint of segment 0->1 (exactly on the bent curve —
     a plain segment-mid can sit pixels off it past the hit tolerance) */
  const cc = back.opts.ctrls[0];
  const qx = 0.25 * xs[0] + 0.5 * vw.xOf(cc.t) + 0.25 * xs[1];
  const qy = 0.25 * ys[0] + 0.5 * vw.yOf(cc.p) + 0.25 * ys[1];
  return { cx: pr.left + qx, cy: pr.top + qy,
    p0: back.points[0], c0: back.opts.ctrls[0] };
}"""

AFTER_JS = """() => {
  const A = window.__app;
  const list = A.App.drawings.list(A.App.activePane.symbol);
  const d = list[list.length - 1];
  return { p0: d.points[0], c0: d.opts.ctrls[0] };
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
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 200", timeout=25000)
            r = page.evaluate("() => { const r = document.querySelector('.pane-root').getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; }")
            page.evaluate("() => { window.__app.App.tool = 'brush'; }")
            page.mouse.move(r['x'] + r['w'] * 0.3, r['y'] + r['h'] * 0.4)
            page.mouse.down()
            for i in range(1, 9):
                page.mouse.move(r['x'] + r['w'] * (0.3 + 0.02 * i), r['y'] + r['h'] * (0.4 + 0.01 * i), steps=2)
            page.mouse.up()
            page.wait_for_timeout(400)
            h = page.evaluate(HANDLE_JS)
            print('    handle:', h)
            check('brush has 3+ points', h['n'] >= 3, h['n'])
            check('end handle moves LAST point', h['lastMoved'], h)
            check('points[1] untouched', h['same1'], h)
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)
            c = page.evaluate(INJECT_JS)
            page.mouse.move(c['cx'], c['cy'])
            page.mouse.down()
            page.mouse.move(c['cx'], c['cy'] + 40, steps=8)
            page.mouse.up()
            page.wait_for_timeout(300)
            a = page.evaluate(AFTER_JS)
            print('    drag:', {k: c[k] for k in ('p0', 'c0')}, '->', a)
            dp = a['p0']['p'] - c['p0']['p']
            dc = a['c0']['p'] - c['c0']['p']
            dtp = a['p0']['t'] - c['p0']['t']
            dtc = a['c0']['t'] - c['c0']['t']
            check('body drag moves points', abs(dp) > 0, dp)
            check('bend rides price', abs(dp) > 0 and abs(dp - dc) / abs(dp) < 0.05, (dp, dc))
            check('bend rides time', dtp == dtc, (dtp, dtc))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND249: %d failed' % len(FAILS) if FAILS else 'ROUND249: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
