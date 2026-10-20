#!/usr/bin/env python3
"""ROUND243 e2e — Lines/Channels geometry + creation undo, live.

  Geometry (DrawTools against a stub canvas, identity pixels):
  - disjoint line 2 passes through click 3, parallel to line 1
  - parallel channel with click 3 past the segment keeps TV width
  - extended line with both edges reaches both viewport edges (old code
    collapsed to extend-left); single-side ray unchanged
  - hitBody on the fixed second lines
  Flow (real mouse clicks on the chart):
  - trend (2 clicks) / parallel + disjoint (3 clicks) create drawings
  - App.undo.undo() removes a fresh creation (was missing before R243)
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8923, 8863
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

GEO_JS = """() => {
  const T = window.__app.DrawTools;
  if (!T) return { noTools: true };
  const mkCtx = () => {
    const segs = []; let cur = null;
    return { segs,
      beginPath(){}, stroke(){}, save(){}, restore(){}, closePath(){}, fill(){},
      setLineDash(){}, moveTo(x, y){ cur = [x, y]; }, lineTo(x, y){ segs.push([cur, [x, y]]); cur = [x, y]; } };
  };
  const V = (ctx) => ({ ctx, xOf: (t) => t, yOf: (p) => p, w: 800, h: 600, pw: 800, ph: 600 });
  const O = { color: '#fff', width: 2 };
  const out = {};
  let ctx = mkCtx();
  T.disjoint.draw(V(ctx), { points: [{t:100,p:300},{t:300,p:300},{t:300,p:200}],
    opts: Object.assign({extendLeft:false,extendRight:false,fill:false}, O) }, false);
  out.disjoint = ctx.segs;
  ctx = mkCtx();
  T.parallel.draw(V(ctx), { points: [{t:100,p:300},{t:300,p:300},{t:400,p:200}],
    opts: Object.assign({extendLeft:false,extendRight:false,fill:false}, O) }, false);
  out.parallel = ctx.segs;
  ctx = mkCtx();
  T.extended.draw(V(ctx), { points: [{t:100,p:300},{t:300,p:100}], opts: Object.assign({}, O) }, false);
  out.extended = ctx.segs;
  ctx = mkCtx();
  T.ray.draw(V(ctx), { points: [{t:100,p:300},{t:300,p:100}], opts: Object.assign({}, O) }, false);
  out.ray = ctx.segs;
  const Vh = V(mkCtx());
  const DP = [{t:100,p:300},{t:300,p:300},{t:300,p:200}];
  out.disHit = T.disjoint.hitBody(Vh, { points: DP, opts: {width:2} })(400, 205);
  out.disMiss = T.disjoint.hitBody(Vh, { points: DP, opts: {width:2} })(400, 450);
  out.parHit = T.parallel.hitBody(Vh,
    { points: [{t:100,p:300},{t:300,p:300},{t:400,p:200}], opts: {width:2} })(200, 200);
  return out;
}"""

FLOW_JS = """(tool) => {
  const A = window.__app;
  const r = document.querySelector('.pane-root').getBoundingClientRect();
  const before = A.App.drawings.list(A.App.activePane.symbol).length;
  A.App.tool = tool;
  return { x: r.left, y: r.top, w: r.width, h: r.height, before,
    after: -1, sym: A.App.activePane.symbol };
}"""

COUNT_JS = """() => {
  const A = window.__app;
  return A.App.drawings.list(A.App.activePane.symbol).length;
}"""

UNDO_JS = """() => {
  const A = window.__app;
  const before = A.App.drawings.list(A.App.activePane.symbol).length;
  A.App.undo.undo();
  return { before, after: A.App.drawings.list(A.App.activePane.symbol).length };
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
            page.wait_for_function("() => window.__app.DrawTools && window.__app.DrawTools.disjoint", timeout=15000)
            g = page.evaluate(GEO_JS)
            print('    geo:', g)
            check('DrawTools exposed', not g.get('noTools'), g)
            dj = g.get('disjoint', [])
            check('disjoint line2 parallel through click3',
                  len(dj) == 2 and dj[1][0] == [300, 200] and dj[1][1] == [500, 200], dj)
            pa = g.get('parallel', [])
            check('parallel unclamped width',
                  len(pa) >= 2 and pa[1][0] == [100, 200] and pa[1][1] == [300, 200], pa)
            ex = g.get('extended', [])
            r = lambda v: round(v)
            check('extend-both reaches both edges',
                  len(ex) == 1 and r(ex[0][0][0]) == 0 and r(ex[0][1][0]) == 400 and r(ex[0][1][1]) == 0, ex)
            ra = g.get('ray', [])
            check('single-side ray unchanged',
                  len(ra) == 1 and ra[0][0] == [100, 300] and ra[0][1] == [400, 0], ra)
            check('hit on fixed second lines', g.get('disHit') is True and g.get('parHit') is True, g)
            check('hit misses far away', g.get('disMiss') is False, g)
            for tool, pts in (('trend', 2), ('parallel', 3), ('disjoint', 3)):
                f = page.evaluate(FLOW_JS, tool)
                xs = [f['x'] + f['w'] * (0.3 + 0.15 * i) for i in range(pts)]
                y = f['y'] + f['h'] * 0.35
                for x in xs:
                    page.mouse.click(x, y)
                    page.wait_for_timeout(250)
                n = page.evaluate(COUNT_JS)
                check('%s creates (%d clicks)' % (tool, pts), n == f['before'] + 1, (f['before'], n))
                u = page.evaluate(UNDO_JS)
                check('undo removes fresh %s' % tool, u['after'] == u['before'] - 1, u)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND243: %d failed' % len(FAILS) if FAILS else 'ROUND243: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
