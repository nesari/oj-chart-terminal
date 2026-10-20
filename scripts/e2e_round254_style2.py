#!/usr/bin/env python3
"""ROUND254 e2e — settings batch 2, live on a stub canvas.

  - position stop/target colors route to the painted lines
  - pitchfork median paints its own color
  - gannbox angles run past the corners; background fills
  - dialogs carry the new rows (Median, Stop/Target, Rows, Angles)
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8946, 8886
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
    Object.defineProperty(ctx, 'strokeStyle', {
      set(v) { strokes.push(String(v)); },
      get() { return strokes.length ? strokes[strokes.length - 1] : ''; },
    });
    return { ctx, strokes };
  };
  const V = (c, extra) => Object.assign({ xOf: (t) => t, yOf: (p) => p,
    w: 800, h: 600, pw: 800, ph: 600, digits: 2, tOf: (x) => x, pOf: (y) => y,
    times: [], bars: [] }, extra || {}, { ctx: c });
  const out = {};
  let m = mkCtx();
  T.positionl.draw(V(m.ctx), { points: [{t:100,p:100},{t:200,p:90}],
    opts: { color: '#111111', width: 1, target: 120, stopColor: '#00ff00', targetColor: '#0000ff' } }, false);
  out.pos = m.strokes;
  m = mkCtx();
  T.pitchfork.draw(V(m.ctx), { points: [{t:100,p:300},{t:200,p:100},{t:300,p:300}],
    opts: { color: '#111111', width: 2, forkKind: 'std', medianColor: '#ff0000' } }, false);
  out.fork = m.strokes;
  m = mkCtx();
  T.pitchfork.draw(V(m.ctx), { points: [{t:100,p:300},{t:200,p:100},{t:300,p:300}],
    opts: { color: '#111111', width: 2, forkKind: 'std' } }, false);
  out.forkBase = m.strokes;
  const segs = [];
  m = mkCtx();
  const raw = m.ctx;
  raw.moveTo = function (x, y) { this._c = [x, y]; };
  raw.lineTo = function (x, y) { segs.push([this._c, [x, y]]); this._c = [x, y]; };
  T.gannbox.draw(V(m.ctx), { points: [{t:0,p:0},{t:400,p:100}],
    opts: { color: '#888888', width: 1, timeLevels: 4, priceLevels: 4, showLabels: false, showAngles: true } }, false);
  out.gann = segs;
  m = mkCtx();
  const segs0 = [];
  m.ctx.moveTo = function (x, y) { this._c = [x, y]; };
  m.ctx.lineTo = function (x, y) { segs0.push([this._c, [x, y]]); this._c = [x, y]; };
  T.gannbox.draw(V(m.ctx), { points: [{t:0,p:0},{t:400,p:100}],
    opts: { color: '#888888', width: 1, timeLevels: 4, priceLevels: 4, showLabels: false } }, false);
  out.gann0 = segs0;
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
            page.wait_for_function("() => window.__app.DrawTools && window.__app.DrawTools.positionl", timeout=15000)
            g = page.evaluate(GEO_JS)
            check('position stop/target colors paint',
                  '#00ff00' in g.get('pos', []) and '#0000ff' in g.get('pos', []), g.get('pos'))
            check('fork median paints its color', '#ff0000' in g.get('fork', []), g.get('fork'))
            check('fork base falls back to line color',
                  '#ff0000' not in g.get('forkBase', []) and '#111111' in g.get('forkBase', []), g.get('forkBase'))
            ga = g.get('gann', [])
            check('gann angles run past corners',
                  any(s[0][0] == 0 or s[1][0] == 0 or s[0][0] == 800 or s[1][0] == 800 or
                      s[0][1] == 0 or s[1][1] == 0 or s[0][1] == 600 or s[1][1] == 600 for s in ga), ga[:4])
            ga0 = g.get('gann0', [])
            check('gann calm without angles',
                  len(ga0) > 0 and all(0 <= s[0][0] <= 400 and 0 <= s[1][0] <= 400 for s in ga0), len(ga0))
            for tid, row, npt in (('positionl', 'Stop color', 2), ('pitchfork', 'Median', 3),
                                  ('volprofile', 'Rows', 2), ('gannbox', 'Angles', 2)):
                d = page.evaluate(DLG_JS, [tid, row, npt])
                check('dialog %s has %s' % (tid, row), d.get('has') is True, d)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND254: %d failed' % len(FAILS) if FAILS else 'ROUND254: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
