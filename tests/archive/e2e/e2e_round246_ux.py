#!/usr/bin/env python3
"""ROUND246 e2e — creation flows + annotations + gannbox, live.

  - staged Esc: temp dies, tool stays; second Esc disarms
  - right-click aborts creation, tool stays
  - sticky tools: a finished trend leaves the tool armed
  - magnet OFF: anchors sit between bars (free time)
  - Annotations section lists the 6 revived tools; flagmark creates
  - avwap line is hittable away from its anchor
  - position body-drag carries opts.target with the points
  - gannbox: 4x4 grid counts + labels on/off on a stub canvas
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8929, 8869
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

RECT_JS = """() => {
  const r = document.querySelector('.pane-root').getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}"""

STATE_JS = """() => {
  const A = window.__app;
  const eng = A.App.activePane.engine;
  return { tool: A.App.tool, temp: !!eng.temp,
    n: A.App.drawings.list(A.App.activePane.symbol).length };
}"""

ARM_JS = """(tool) => {
  const A = window.__app;
  A.App.tool = tool;
  A.App.magnetMode = 'off';
  return true;
}"""

LAST_JS = """() => {
  const A = window.__app;
  const list = A.App.drawings.list(A.App.activePane.symbol);
  const d = list[list.length - 1];
  const bt = new Set(A.App.activePane.barTimes);
  return { type: d.type, pts: d.points.map((p) => ({ t: p.t, p: p.p })),
    target: d.opts.target, free: d.points.map((p) => !bt.has(p.t)) };
}"""

CENTER_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const vw = pane.engine.view();
  const list = A.App.drawings.list(pane.symbol);
  const d = list[list.length - 1];
  const xs = d.points.map((p) => vw.xOf(p.t)), ys = d.points.map((p) => vw.yOf(p.p));
  const pr = pane.engine.canvas.getBoundingClientRect();
  const mx = (Math.min(...xs) + Math.max(...xs)) / 2, my = (Math.min(...ys) + Math.max(...ys)) / 2;
  return { cx: pr.left + mx, cy: pr.top + my, p0: d.points[0].p, target: d.opts.target };
}"""

VWAP_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const vw = pane.engine.view();
  const list = A.App.drawings.list(pane.symbol);
  const d = list[list.length - 1];
  const hit = A.DrawTools.avwap.hitBody(vw, d);
  const xA = vw.xOf(d.points[0].t), yA = vw.yOf(d.points[0].p);
  const x = xA + 120;
  let found = false;
  for (let y = 0; y < vw.ph; y += 8) { if (hit(x, y)) { found = true; break; } }
  return { type: d.type, anchorHit: hit(xA, yA), lineHit: found };
}"""

GANN_JS = """(showLabels) => {
  const T = window.__app.DrawTools;
  const texts = [];
  const ctx = { beginPath(){}, stroke(){}, save(){}, restore(){}, closePath(){},
    setLineDash(){}, moveTo(x, y){ this._c = [x, y]; }, lineTo(x, y){ this._s.push([this._c, [x, y]]); this._c = [x, y]; },
    fillText(t){ texts.push(String(t)); }, strokeRect(x, y, w, h){ this._r.push([x, y, w, h]); },
    _s: [], _r: [] };
  const V = { ctx, xOf: (t) => t, yOf: (p) => p, w: 800, h: 600, pw: 800, ph: 600, digits: 2 };
  T.gannbox.draw(V, { points: [{t:0,p:0},{t:400,p:100}],
    opts: { color: '#888', width: 1, timeLevels: 4, priceLevels: 4, showLabels } }, false);
  const segs = ctx._s;
  const vert = segs.filter((s) => s[0][0] === s[1][0] && s[0][0] > 0 && s[0][0] < 400);
  const horz = segs.filter((s) => s[0][1] === s[1][1] && s[0][1] > 0 && s[0][1] < 100);
  const diag = segs.filter((s) => s[0][0] !== s[1][0] && s[0][1] !== s[1][1]);
  return { vert: vert.length, horz: horz.length, diag: diag.length,
    border: ctx._r.length, labels: texts.length };
}"""

ANN_JS = """() => {
  const A = window.__app;
  const g = A.UI.GROUPS.find((x) => x.id === 'shapes');
  const sec = g.sections.find((s) => s.title === 'Annotations');
  const ids = ['text', 'note', 'callout', 'flagmark', 'arrowmarkl', 'arrowmarkr'];
  return { sec: !!sec, tools: sec ? sec.tools : [],
    defs: ids.map((id) => !!A.DrawTools[id]) };
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
            r = page.evaluate(RECT_JS)
            X = lambda f: r['x'] + r['w'] * f
            Y = lambda f: r['y'] + r['h'] * f
            page.evaluate(ARM_JS, 'trend')
            page.mouse.click(X(0.30), Y(0.35))
            page.wait_for_timeout(250)
            s = page.evaluate(STATE_JS)
            check('temp armed after 1 click', s['temp'] and s['tool'] == 'trend', s)
            page.keyboard.press('Escape')
            page.wait_for_timeout(250)
            s = page.evaluate(STATE_JS)
            check('Esc kills temp, keeps tool', (not s['temp']) and s['tool'] == 'trend', s)
            page.keyboard.press('Escape')
            page.wait_for_timeout(250)
            check('idle Esc disarms', page.evaluate(STATE_JS)['tool'] is None, s)
            page.evaluate(ARM_JS, 'trend')
            page.mouse.click(X(0.30), Y(0.35))
            page.wait_for_timeout(250)
            page.mouse.click(X(0.30), Y(0.35), button='right')
            page.wait_for_timeout(250)
            s = page.evaluate(STATE_JS)
            check('right-click aborts, keeps tool', (not s['temp']) and s['tool'] == 'trend' and s['n'] == 0, s)
            page.mouse.click(X(0.32), Y(0.36))
            page.wait_for_timeout(250)
            page.mouse.click(X(0.48), Y(0.44))
            page.wait_for_timeout(300)
            s = page.evaluate(STATE_JS)
            check('one-shot: tool disarms after finish', s['n'] == 1 and s['tool'] is None, s)
            page.click('#left-toolbar .lt-btn[data-util="stay"]')
            page.wait_for_timeout(250)
            check('stay lock arms via toolbar', page.evaluate("() => window.__app.App.stayDraw") is True, None)
            page.evaluate(ARM_JS, 'trend')
            page.mouse.click(X(0.60), Y(0.30))
            page.wait_for_timeout(250)
            page.mouse.click(X(0.72), Y(0.38))
            page.wait_for_timeout(300)
            s = page.evaluate(STATE_JS)
            check('stay lock: tool armed after finish', s['n'] == 2 and s['tool'] == 'trend', s)
            page.click('#left-toolbar .lt-btn[data-util="stay"]')
            page.wait_for_timeout(250)
            check('stay lock off via toolbar', page.evaluate("() => window.__app.App.stayDraw") is False, None)
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)
            d = page.evaluate(LAST_JS)
            check('magnet-off free time', any(d['free']), d['pts'])
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)
            a = page.evaluate(ANN_JS)
            print('    ann:', a)
            check('Annotations section live', a['sec'] and len(a['tools']) == 6 and all(a['defs']), a)
            n0 = page.evaluate(STATE_JS)['n']
            page.evaluate(ARM_JS, 'flagmark')
            page.mouse.click(X(0.55), Y(0.40))
            page.wait_for_timeout(300)
            s = page.evaluate(STATE_JS)
            check('flagmark creates in 1 click', s['n'] == n0 + 1, (n0, s['n']))
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)
            page.evaluate(ARM_JS, 'avwap')
            page.mouse.click(X(0.25), Y(0.45))
            page.wait_for_timeout(900)
            v = page.evaluate(VWAP_JS)
            print('    vwap:', v)
            check('avwap line hittable', v.get('type') == 'avwap' and v.get('lineHit') is True, v)
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)
            page.evaluate(ARM_JS, 'positionl')
            page.mouse.click(X(0.30), Y(0.35))
            page.wait_for_timeout(250)
            page.mouse.click(X(0.50), Y(0.55))
            page.wait_for_timeout(300)
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)
            c = page.evaluate(CENTER_JS)
            page.mouse.move(c['cx'], c['cy'])
            page.mouse.down()
            page.mouse.move(c['cx'], c['cy'] + 40, steps=8)
            page.mouse.up()
            page.wait_for_timeout(300)
            c2 = page.evaluate(LAST_JS)
            cur = page.evaluate(CENTER_JS)
            print('    pos:', {k: cur[k] for k in ('p0', 'target')}, 'was:', {k: c[k] for k in ('p0', 'target')})
            moved = cur['p0'] - c['p0']
            dt = cur['target'] - c['target']
            check('position body-drag moves', abs(moved) > 0, (c['p0'], cur['p0']))
            check('target rides along', abs(moved) > 0 and abs(moved - dt) / abs(moved) < 0.05, (moved, dt))
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)
            g1 = page.evaluate(GANN_JS, True)
            g0 = page.evaluate(GANN_JS, False)
            print('    gann:', g1, g0)
            check('gannbox 4x4 grid + labels',
                  g1['vert'] == 3 and g1['horz'] == 3 and g1['diag'] == 2 and g1['border'] == 1 and g1['labels'] == 15,
                  (g1, g0))
            check('gannbox labels toggle off', g0['labels'] == 0 and g0['vert'] == 3, g0)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND246: %d failed' % len(FAILS) if FAILS else 'ROUND246: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
