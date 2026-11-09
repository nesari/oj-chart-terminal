#!/usr/bin/env python3
"""ROUND247 e2e — pitchfork medians + regression/flattop spans, live.

  - schiff median is flat (P0-time origin); old code sloped it
  - mschiff/inside origins at mid(P0,P1); inside median ends at P2
  - fork median ray reaches the right edge; extendLeft reaches x=0
  - extended fork rays are hittable far from the anchors
  - regression extend spans the viewport; bands hittable
  - flattop sloped side + hit follow extendRight
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8932, 8872
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
    w: 800, h: 600, pw: 800, ph: 600, digits: 2, tOf: (x) => x, pOf: (y) => y,
    times: [], bars: [] }, extra || {});
  const O = { color: '#2962ff', width: 2, forkKind: 'std' };
  const out = {};
  const P3 = [{t:100,p:300},{t:200,p:100},{t:300,p:300}];
  const flat = (segs) => segs.filter((s) => s[0][1] === s[1][1]);
  let ctx = mkCtx();
  T.pitchfork_s.draw(V(ctx), { points: P3, opts: Object.assign({forkKind: 'schiff'}, O) }, false);
  out.schiffMed = ctx.segs.slice(0, 1);
  ctx = mkCtx();
  T.pitchfork_ms.draw(V(ctx), { points: P3, opts: Object.assign({forkKind: 'mschiff'}, O) }, false);
  out.mschiffMed = ctx.segs.slice(0, 1);
  ctx = mkCtx();
  T.pitchfork_i.draw(V(ctx), { points: P3, opts: Object.assign({forkKind: 'inside'}, O) }, false);
  out.insideMed = ctx.segs.slice(0, 1);
  ctx = mkCtx();
  T.pitchfork.draw(V(ctx), { points: P3, opts: Object.assign({}, O) }, false);
  out.stdMed = ctx.segs.slice(0, 1);
  ctx = mkCtx();
  T.pitchfork.draw(V(ctx), { points: P3, opts: Object.assign({extendLeft: true}, O) }, false);
  out.stdMedL = ctx.segs.slice(0, 1);
  const Vh = V(mkCtx());
  const H = (id, x, y, kind) => T[id].hitBody(Vh,
    { points: P3, opts: Object.assign({forkKind: kind}, O) })(x, y);
  out.forkHit = H('pitchfork', 400, 100, 'std');
  out.forkMiss = H('pitchfork', 400, 500, 'std');
  const times = [], bars = [];
  for (let i = 0; i < 10; i++) {
    times.push(i * 60);
    bars.push({ time: i * 60, open: 100 + i, high: 101 + i, low: 99 + i,
      close: 100 + i + (i % 2 ? 2 : -2), volume: 10 });
  }
  const RE = { points: [{t: 120, p: 0}, {t: 420, p: 0}], opts: { color: '#2962ff', width: 2, devs: [1], extend: true } };
  ctx = mkCtx();
  T.regression.draw(V(ctx, { times, bars }), RE, false);
  out.reg = ctx.segs;
  const RE0 = { points: [{t: 120, p: 0}, {t: 420, p: 0}], opts: { color: '#2962ff', width: 2, devs: [1], extend: false } };
  ctx = mkCtx();
  T.regression.draw(V(ctx, { times, bars }), RE0, false);
  out.reg0 = ctx.segs;
  const Vhr = V(mkCtx(), { times, bars });
  const mid = out.reg.length ? out.reg[1] : null;
  out.regHit = mid ? T.regression.hitBody(Vhr, RE)((mid[0][0] + mid[1][0]) / 2, (mid[0][1] + mid[1][1]) / 2) : false;
  out.regMiss = T.regression.hitBody(Vhr, RE)(790, 590);
  ctx = mkCtx();
  const FL = { points: [{t:100,p:300},{t:300,p:100},{t:200,p:250}],
    opts: { color: '#2962ff', width: 2, extendLeft: false, extendRight: true, fill: false } };
  T.flattop.draw(V(ctx), FL, false);
  out.flat = ctx.segs;
  out.flatHit = T.flattop.hitBody(V(mkCtx()), FL)(700, -300);
  out.flatMiss = T.flattop.hitBody(V(mkCtx()), FL)(700, 590);
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
            page.wait_for_function("() => window.__app.DrawTools && window.__app.DrawTools.pitchfork", timeout=15000)
            g = page.evaluate(GEO_JS)
            r = lambda v: round(v)
            sm = g.get('schiffMed', [[]])[0]
            check('schiff median flat at y=200 from x=100',
                  sm and sm[0] == [100, 200] and sm[1][1] == 200, sm)
            mm = g.get('mschiffMed', [[]])[0]
            check('mschiff median from mid01 (150,200)',
                  mm and mm[0] == [150, 200] and mm[1][1] == 200, mm)
            im = g.get('insideMed', [[]])[0]
            check('inside median mid01 -> P2 direction',
                  im and im[0] == [150, 200] and r(im[1][1]) == 600 and im[1][0] > 300, im)
            st = g.get('stdMed', [[]])[0]
            check('std median reaches viewport edge',
                  st and st[0] == [100, 300] and (st[1][0] == 800 or st[1][1] in (0, 600)), st)
            stL = g.get('stdMedL', [[]])[0]
            check('extendLeft opens x=0', stL and stL[0][0] == 0, stL)
            check('extended fork ray hittable', g.get('forkHit') is True, g.get('forkHit'))
            check('fork miss far away', g.get('forkMiss') is False, g.get('forkMiss'))
            rg = g.get('reg', [])
            check('regression extend spans viewport',
                  len(rg) == 3 and rg[0][0][0] == 0 and rg[0][1][0] == 800, rg)
            rg0 = g.get('reg0', [])
            check('regression calm without extend',
                  len(rg0) == 3 and rg0[0][0][0] > 0 and rg0[0][1][0] < 800, rg0)
            check('regression band hittable', g.get('regHit') is True, g.get('regHit'))
            check('regression miss far away', g.get('regMiss') is False, g.get('regMiss'))
            fl = g.get('flat', [])
            check('flattop sloped side follows extendRight',
                  any(s[1][0] == 800 for s in fl), fl)
            check('flattop hit on the extension', g.get('flatHit') is True, g.get('flatHit'))
            check('flattop miss far away', g.get('flatMiss') is False, g.get('flatMiss'))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND247: %d failed' % len(FAILS) if FAILS else 'ROUND247: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
