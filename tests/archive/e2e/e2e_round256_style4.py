#!/usr/bin/env python3
"""ROUND256 e2e — settings batch 4, live on a stub canvas.

  - useOneColor repaints every fib level with the line color
  - trend line toggles off on fib
  - levels width applies; wedge background fills
  - dialogs carry the new rows
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8948, 8890
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
    const strokes = [], widths = [];
    let fills = 0;
    const ctx = { beginPath(){}, stroke(){}, save(){}, restore(){}, closePath(){},
      fill(){ fills++; }, setLineDash(){}, moveTo(){}, lineTo(){},
      fillText(){}, rect(){}, clip(){}, fillRect(){}, strokeRect(){},
      measureText(){ return { width: 10 }; } };
    Object.defineProperty(ctx, 'strokeStyle', {
      set(v) { strokes.push(String(v)); }, get() { return strokes.length ? strokes[strokes.length - 1] : ''; },
    });
    Object.defineProperty(ctx, 'lineWidth', {
      set(v) { widths.push(v); }, get() { return widths.length ? widths[widths.length - 1] : 1; },
    });
    return { ctx, strokes, widths, fills: () => fills };
  };
  const V = (c) => ({ ctx: c, xOf: (t) => t, yOf: (p) => p,
    w: 800, h: 600, pw: 800, ph: 600, digits: 2, axisW: 62, axisQueue: null,
    tOf: (x) => x, pOf: (y) => y, times: [], bars: [] });
  const O = { color: '#0000ff', width: 2 };
  const out = {};
  const LV = [{ r: 0.5, c: '#ff0000', on: true }, { r: 0.618, c: '#00ff00', on: true }];
  let m = mkCtx();
  T.fib.draw(V(m.ctx), { points: [{t:100,p:100},{t:200,p:200}],
    opts: Object.assign({ levels: LV, showRatio: false, showPrice: false }, O) }, false);
  out.mixed = m.strokes.slice();
  m = mkCtx();
  T.fib.draw(V(m.ctx), { points: [{t:100,p:100},{t:200,p:200}],
    opts: Object.assign({ levels: LV, showRatio: false, showPrice: false, useOneColor: true }, O) }, false);
  out.one = m.strokes.slice();
  const diag = (segs) => segs.some((s) => s[0][0] !== s[1][0] && s[0][1] !== s[1][1]);
  m = mkCtx();
  const segs = [];
  m.ctx.moveTo = function (x, y) { this._c = [x, y]; };
  m.ctx.lineTo = function (x, y) { segs.push([this._c, [x, y]]); this._c = [x, y]; };
  T.fib.draw(V(m.ctx), { points: [{t:100,p:100},{t:200,p:200}],
    opts: Object.assign({ levels: LV, showRatio: false, showPrice: false }, O) }, false);
  out.trendOn = diag(segs);
  m = mkCtx();
  const segs0 = [];
  m.ctx.moveTo = function (x, y) { this._c = [x, y]; };
  m.ctx.lineTo = function (x, y) { segs0.push([this._c, [x, y]]); this._c = [x, y]; };
  T.fib.draw(V(m.ctx), { points: [{t:100,p:100},{t:200,p:200}],
    opts: Object.assign({ levels: LV, showRatio: false, showPrice: false, showTrend: false }, O) }, false);
  out.trendOff = diag(segs0);
  m = mkCtx();
  T.fib.draw(V(m.ctx), { points: [{t:100,p:100},{t:200,p:200}],
    opts: Object.assign({ levels: LV, showRatio: false, showPrice: false, levelWidth: 3 }, O) }, false);
  out.widths = m.widths.slice();
  m = mkCtx();
  T.fibwedge.draw(V(m.ctx), { points: [{t:0,p:0},{t:100,p:100},{t:200,p:0}],
    opts: Object.assign({ fill: true, fillColor: '#00ff00', fillOpacity: 0.2 }, O) }, false);
  out.wedgeFill = m.fills();
  m = mkCtx();
  T.fibwedge.draw(V(m.ctx), { points: [{t:0,p:0},{t:100,p:100},{t:200,p:0}],
    opts: Object.assign({}, O) }, false);
  out.wedgePlain = m.fills();
  return out;
}"""

DLG_JS = """(arg) => {
  const id = arg[0], row = arg[1], npt = arg[2], extra = arg[3] || {};
  const A = window.__app;
  const pts = [];
  for (let i = 0; i < npt; i++) pts.push({ t: 100 + i * 100, p: 100 + i * 10 });
  A.DrawSettings.open(A.App.activePane, { type: id, points: pts, opts: Object.assign({}, extra) });
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
            page.wait_for_function("() => window.__app.DrawTools && window.__app.DrawTools.fibwedge", timeout=15000)
            g = page.evaluate(GEO_JS)
            check('levels keep colors by default',
                  '#ff0000' in g.get('mixed', []) and '#00ff00' in g.get('mixed', []), g.get('mixed'))
            check('one color repaints all levels',
                  '#ff0000' not in g.get('one', []) and '#00ff00' not in g.get('one', []) and
                  '#0000ff' in g.get('one', []), g.get('one'))
            check('trend toggles', g.get('trendOn') is True and g.get('trendOff') is False,
                  (g.get('trendOn'), g.get('trendOff')))
            check('levels width applies', 3 in g.get('widths', []), g.get('widths'))
            check('wedge fill paints iff enabled',
                  (g.get('wedgeFill') or 0) >= 1 and (g.get('wedgePlain') or 0) == 0,
                  (g.get('wedgeFill'), g.get('wedgePlain')))
            for tid, row, npt, extra in (('fib', 'Use one color', 2, {}), ('fib', 'Trend line', 2, {}),
                                         ('fibwedge', 'Background', 3, {})):
                d = page.evaluate(DLG_JS, [tid, row, npt, extra])
                check('dialog %s has %s' % (tid, row), d.get('has') is True, d)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND256: %d failed' % len(FAILS) if FAILS else 'ROUND256: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
