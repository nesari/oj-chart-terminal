#!/usr/bin/env python3
"""ROUND255 e2e — settings batch 3, live on a stub canvas.

  - text border strokes only when enabled
  - regression source changes the fitted line; side bands toggle + recolor
  - dialogs carry the new rows
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8947, 8888
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
    const strokes = [];
    const ctx = { beginPath(){}, stroke(){}, save(){}, restore(){}, closePath(){}, fill(){},
      setLineDash(){}, moveTo(){}, lineTo(){}, fillText(){}, rect(){}, clip(){},
      fillRect(){}, strokeRect(){}, measureText(){ return { width: 10 }; } };
    return { ctx, strokes };
  };
  const V = (c, extra) => Object.assign({ xOf: (t) => t, yOf: (p) => p,
    w: 800, h: 600, pw: 800, ph: 600, digits: 2, tOf: (x) => x, pOf: (y) => y,
    times: [], bars: [] }, extra || {}, { ctx: c });
  const out = {};
  let m = mkCtx();
  const rects = [];
  m.ctx.strokeRect = function (x, y, w, h) { rects.push([x, y, w, h]); };
  T.text.draw(V(m.ctx), { points: [{t:100,p:100}],
    opts: { color: '#111111', fontSize: 14, text: 'Hi', border: true, borderColor: '#ff0000' } }, false);
  out.borderOn = rects.length;
  m = mkCtx();
  const rects0 = [];
  m.ctx.strokeRect = function (x, y, w, h) { rects0.push([x, y, w, h]); };
  T.text.draw(V(m.ctx), { points: [{t:100,p:100}],
    opts: { color: '#111111', fontSize: 14, text: 'Hi' } }, false);
  out.borderOff = rects0.length;
  const times = [], bars = [];
  for (let i = 0; i < 8; i++) {
    times.push(i * 60);
    bars.push({ time: i * 60, open: 100, high: 100 + 2 * i, low: 100, close: 100, volume: 10 });
  }
  const RR = (opts) => ({ points: [{t: 0, p: 0}, {t: 420, p: 0}],
    opts: Object.assign({ color: '#2962ff', width: 2, devs: [1], extend: false }, opts) });
  const segsOf = (opts) => {
    const c = mkCtx();
    const segs = [];
    c.ctx.moveTo = function (x, y) { this._c = [x, y]; };
    c.ctx.lineTo = function (x, y) { segs.push([this._c, [x, y]]); this._c = [x, y]; };
    T.regression.draw(V(c.ctx, { times, bars }), RR(opts), false);
    return segs;
  };
  const base = segsOf({});
  const hlc = segsOf({ source: 'hlc3' });
  out.srcDiff = JSON.stringify(base[0]) !== JSON.stringify(hlc[0]);
  out.baseY = Math.round(base[0][1][1] * 10) / 10;
  out.hlcY = Math.round(hlc[0][1][1] * 10) / 10;
  out.full = segsOf({}).length;
  out.noUp = segsOf({ upShow: false }).length;
  out.noDn = segsOf({ downShow: false }).length;
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
            page.wait_for_function("() => window.__app.DrawTools && window.__app.DrawTools.regression", timeout=15000)
            g = page.evaluate(GEO_JS)
            print('    geo:', {k: v for k, v in g.items()})
            check('text border strokes when on, silent when off',
                  g.get('borderOn', 0) >= 1 and g.get('borderOff', 1) == 0,
                  (g.get('borderOn'), g.get('borderOff')))
            check('source changes the fit',
                  g.get('srcDiff') is True and g.get('baseY') == 100 and g.get('hlcY') != 100,
                  (g.get('baseY'), g.get('hlcY')))
            check('bands toggle per side',
                  g.get('full') == 3 and g.get('noUp') == 2 and g.get('noDn') == 2,
                  (g.get('full'), g.get('noUp'), g.get('noDn')))
            for tid, row, npt, extra in (('text', 'Border', 1, {}), ('regression', 'Upper color', 2, {'upShow': True}),
                                  ('regression', 'Source', 2, {})):
                d = page.evaluate(DLG_JS, [tid, row, npt, extra])
                check('dialog %s has %s' % (tid, row), d.get('has') is True, d)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND255: %d failed' % len(FAILS) if FAILS else 'ROUND255: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
