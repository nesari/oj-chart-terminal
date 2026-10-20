#!/usr/bin/env python3
"""ROUND252 e2e — settings batch 1, live on a stub canvas.

  - hline price label toggles (pill painted / skipped)
  - infoline extends right; Price toggle rows in its dialog
  - parallel mid level paints + hittable
  - brush fill paints a closed fill
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8938, 8878
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
    const segs = []; let cur = null; const pills = []; let fills = 0;
    return { segs, pills, fills: 0,
      beginPath(){}, stroke(){}, save(){}, restore(){}, closePath(){}, fill(){ fills++; this._f = (this._f || 0) + 1; },
      setLineDash(){}, moveTo(x, y){ cur = [x, y]; }, lineTo(x, y){ segs.push([cur, [x, y]]); cur = [x, y]; },
      fillText(){}, rect(){}, clip(){}, fillRect(x, y, w, h){ pills.push([x, y, w, h]); }, strokeRect(){},
      measureText(){ return { width: 10 }; } };
  };
  const V = (ctx) => ({ ctx, xOf: (t) => t, yOf: (p) => p,
    w: 800, h: 600, pw: 800, ph: 600, digits: 2, axisW: 62, axisQueue: null,
    tOf: (x) => x, pOf: (y) => y, times: [], bars: [] });
  const O = { color: '#2962ff', width: 2 };
  const out = {};
  let ctx = mkCtx();
  T.hline.draw(V(ctx), { points: [{t:100,p:100}], opts: Object.assign({}, O) }, false);
  out.hlinePills = ctx.pills.length;
  ctx = mkCtx();
  T.hline.draw(V(ctx), { points: [{t:100,p:100}], opts: Object.assign({priceLabels: false}, O) }, false);
  out.hlineOff = ctx.pills.length;
  ctx = mkCtx();
  T.infoline.draw(V(ctx), { points: [{t:100,p:300},{t:300,p:100}],
    opts: Object.assign({extendRight: true, showPrices: true}, O) }, false);
  out.info = ctx.segs;
  ctx = mkCtx();
  T.parallel.draw(V(ctx), { points: [{t:100,p:300},{t:300,p:300},{t:400,p:200}],
    opts: Object.assign({extendLeft: false, extendRight: false, fill: false,
      levels: [{ r: 0.5, c: '#ff0000', on: true }]}, O) }, false);
  out.par = ctx.segs;
  const Vh = V(mkCtx());
  out.parHit = T.parallel.hitBody(Vh, { points: [{t:100,p:300},{t:300,p:300},{t:400,p:200}],
    opts: Object.assign({extendLeft: false, extendRight: false, fill: false,
      levels: [{ r: 0.5, c: '#ff0000', on: true }]}, O) })(200, 250);
  out.parMiss = T.parallel.hitBody(Vh, { points: [{t:100,p:300},{t:300,p:300},{t:400,p:200}],
    opts: Object.assign({extendLeft: false, extendRight: false, fill: false, levels: []}, O) })(200, 250);
  ctx = mkCtx();
  T.brush.draw(V(ctx), { points: [{t:0,p:0},{t:10,p:10},{t:20,p:0}],
    opts: Object.assign({fill: true, fillColor: '#00ff00', fillOpacity: 0.2}, O) }, false);
  out.brushFill = ctx._f || 0;
  ctx = mkCtx();
  T.brush.draw(V(ctx), { points: [{t:0,p:0},{t:10,p:10},{t:20,p:0}],
    opts: Object.assign({}, O) }, false);
  out.brushPlain = ctx._f || 0;
  return out;
}"""

DLG_JS = """(arg) => {
  const id = arg[0], row = arg[1], npt = arg[2];
  const A = window.__app;
  const pts = [];
  for (let i = 0; i < npt; i++) pts.push({ t: 100 + i * 100, p: 100 + i * 10 });
  A.DrawSettings.open(A.App.activePane, { type: id, points: pts, opts: {} });
  const dlg = document.querySelector('#draw-settings-dialog');
  const txt = dlg ? dlg.textContent : '';
  const has = txt.indexOf(row) >= 0;
  const x = dlg ? dlg.querySelector('.dlg-x') : null;
  if (x) x.click();
  return { has };
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
            page.wait_for_function("() => window.__app.DrawTools && window.__app.DrawTools.infoline", timeout=15000)
            g = page.evaluate(GEO_JS)
            print('    geo:', {k: (v if not isinstance(v, list) or len(v) < 6 else str(len(v)) + ' segs') for k, v in g.items()})
            check('hline pill on/off', g.get('hlinePills', 0) >= 1 and g.get('hlineOff', 1) == 0,
                  (g.get('hlinePills'), g.get('hlineOff')))
            info = g.get('info', [])
            check('infoline reaches viewport edge',
                  len(info) >= 1 and (info[0][1][0] == 800 or info[0][1][1] in (0, 600)), info[:2])
            par = g.get('par', [])
            check('parallel mid level paints',
                  any(s[0] == [100, 250] and s[1] == [300, 250] for s in par), par)
            check('parallel level hittable, absent without it',
                  g.get('parHit') is True and g.get('parMiss') is False, (g.get('parHit'), g.get('parMiss')))
            check('brush fill paints closed fill',
                  (g.get('brushFill') or 0) >= 1 and (g.get('brushPlain') or 0) == 0,
                  (g.get('brushFill'), g.get('brushPlain')))
            for tid, row, npt in (('infoline', 'Prices', 2), ('hline', 'Price label', 1), ('vline', 'Time label', 1),
                             ('parallel', 'LEVELS', 3), ('polyline', 'Background', 2)):
                d = page.evaluate(DLG_JS, [tid, row, npt])
                check('dialog %s has %s' % (tid, row), d.get('has') is True, d)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND252: %d failed' % len(FAILS) if FAILS else 'ROUND252: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
