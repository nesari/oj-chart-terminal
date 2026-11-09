#!/usr/bin/env python3
"""ROUND245 e2e — Fibs/Cycles/Sine geometry, live on a stub canvas.

  - speedfan: 7 rays from A, all forward (no mirrors)
  - fibext: r=1 level runs C.x -> right edge; extendLeft opens x=0
  - fib reverse: 0.382 level mirrors (161.8 <-> 138.2)
  - fibchannel: k=1 line reaches the right edge; extendLeft reaches x=0
  - cycliclines: exactly the base positions, no duplicates
  - sineline: wave locked to TIME across a scale gap (hit at t=25 -> 225)
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8928, 8868
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
  const mkCtx = () => {
    const segs = []; let cur = null;
    return { segs,
      beginPath(){}, stroke(){}, save(){}, restore(){}, closePath(){}, fill(){},
      setLineDash(){}, moveTo(x, y){ cur = [x, y]; }, lineTo(x, y){ segs.push([cur, [x, y]]); cur = [x, y]; },
      fillText(){}, rect(){}, clip(){}, fillRect(){}, strokeRect(){} };
  };
  const V = (ctx, extra) => Object.assign({ ctx, xOf: (t) => t, yOf: (p) => p,
    w: 800, h: 600, pw: 800, ph: 600, digits: 2, tOf: (x) => x, pOf: (y) => y }, extra || {});
  const O = { color: '#2962ff', width: 1 };
  const out = {};
  let ctx = mkCtx();
  T.fibspeedfan.draw(V(ctx), { points: [{t:100,p:500},{t:300,p:100}], opts: Object.assign({}, O) }, false);
  out.fan = ctx.segs;
  ctx = mkCtx();
  T.fibext.draw(V(ctx), { points: [{t:100,p:100},{t:200,p:200},{t:300,p:150}],
    opts: Object.assign({showRatio: false, showPrice: false}, O) }, false);
  out.ext = ctx.segs;
  ctx = mkCtx();
  T.fibext.draw(V(ctx), { points: [{t:100,p:100},{t:200,p:200},{t:300,p:150}],
    opts: Object.assign({showRatio: false, showPrice: false, extendLeft: true}, O) }, false);
  out.extL = ctx.segs;
  ctx = mkCtx();
  T.fib.draw(V(ctx), { points: [{t:100,p:100},{t:200,p:200}],
    opts: Object.assign({showRatio: false, showPrice: false}, O) }, false);
  out.fib = ctx.segs;
  ctx = mkCtx();
  T.fib.draw(V(ctx), { points: [{t:100,p:100},{t:200,p:200}],
    opts: Object.assign({showRatio: false, showPrice: false, reverse: true}, O) }, false);
  out.fibR = ctx.segs;
  ctx = mkCtx();
  T.fibchannel.draw(V(ctx), { points: [{t:100,p:300},{t:300,p:300},{t:100,p:200}],
    opts: Object.assign({showRatio: false}, O) }, false);
  out.chan = ctx.segs;
  ctx = mkCtx();
  T.fibchannel.draw(V(ctx), { points: [{t:100,p:300},{t:300,p:300},{t:100,p:200}],
    opts: Object.assign({showRatio: false, extendLeft: true}, O) }, false);
  out.chanL = ctx.segs;
  ctx = mkCtx();
  T.cycliclines.draw(V(ctx), { points: [{t:0,p:0},{t:100,p:0}],
    opts: Object.assign({cycles: 3, extendLeft: false, extendRight: false}, O) }, false);
  const xs = ctx.segs.filter((s) => s[0][0] === s[1][0]).map((s) => Math.round(s[0][0]));
  out.cyc = xs;
  out.cycDup = xs.length - new Set(xs).size;
  const gapped = { xOf: (t) => (t < 50 ? t : t + 100), tOf: (x) => (x < 50 ? x : x - 100) };
  ctx = mkCtx();
  T.sineline.draw(V(ctx, gapped), { points: [{t:0,p:100},{t:100,p:200}],
    opts: Object.assign({showTrend: false}, O) }, false);
  out.sineSegs = ctx.segs.length;
  const Vh = V(mkCtx(), gapped);
  out.sineHit = T.sineline.hitBody(Vh,
    { points: [{t:0,p:100},{t:100,p:200}], opts: Object.assign({}, O) })(25, 225);
  out.sineMiss = T.sineline.hitBody(Vh,
    { points: [{t:0,p:100},{t:100,p:200}], opts: Object.assign({}, O) })(25, 300);
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
            page.wait_for_function("() => window.__app.DrawTools && window.__app.DrawTools.fibspeedfan", timeout=15000)
            g = page.evaluate(GEO_JS)
            fan = g.get('fan', [])
            check('fan: 7 rays from A, all forward',
                  len(fan) == 7 and all(s[0] == [100, 500] for s in fan) and all(s[1][0] >= 300 for s in fan), fan)
            ex = [s for s in g.get('ext', []) if s[0][1] == s[1][1] == 250]
            check('fibext r=1 runs C.x -> right edge',
                  any(s[0][0] == 300 and s[1][0] == 800 for s in ex), g.get('ext'))
            exL = [s for s in g.get('extL', []) if s[0][1] == s[1][1] == 250]
            check('fibext extendLeft opens x=0',
                  any(s[0][0] == 0 and s[1][0] == 800 for s in exL), g.get('extL'))
            rows = lambda ss: [round(s[0][1], 1) for s in ss if s[0][1] == s[1][1]]
            nR, rR = rows(g.get('fib', [])), rows(g.get('fibR', []))
            check('fib reverse mirrors ends (200 <-> 100)',
                  nR and rR and nR[0] == 200 and rR[0] == 100 and nR[1] == 176.4 and rR[1] == 123.6, (nR, rR))
            ch = g.get('chan', [])
            check('channel k=1 reaches right edge', any(s[1][0] == 800 for s in ch), ch)
            chL = g.get('chanL', [])
            check('channel extendLeft reaches x=0', any(s[0][0] == 0 for s in chL), chL)
            check('cyclic base positions, no dupes',
                  sorted(g.get('cyc', [])) == [0, 100, 200] and g.get('cycDup') == 0, (g.get('cyc'), g.get('cycDup')))
            check('sine draws across the gap', g.get('sineSegs', 0) > 100, g.get('sineSegs'))
            check('sine locked to time (hit 225, miss 300)',
                  g.get('sineHit') is True and g.get('sineMiss') is False, (g.get('sineHit'), g.get('sineMiss')))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND245: %d failed' % len(FAILS) if FAILS else 'ROUND245: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
