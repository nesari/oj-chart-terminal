#!/usr/bin/env python3
"""ROUND285 e2e — second wave of drawing parity, live in the real app.

Verifies through the REAL module graph and the REAL settings dialog:
  1. callout   — pointer option exists and the bubble+tail paints
  2. measure   — the 3-line info card paints
  3. volprofile/avolprofile — vaPct / POC / VA settings exist and the tool paints
  4. ghostfeed — opacity + both candle colours exist in the dialog
  5. posforecast — profit/loss colours + entry toggle exist
  6. sector/barspattern/disjoint — label/distance toggles exist

Zero page errors.

Run: python tests/archive/e2e/e2e_round285_drawing_parity2.py
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8971, 8860
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


# Open the dialog and report every labelled row + the widget counts.
DLG_JS = """(arg) => {
  const id = arg[0], npt = arg[1];
  const A = window.__app;
  const pts = [];
  for (let i = 0; i < npt; i++) pts.push({ t: 1790600400 + i * 900, p: 100 + i * 2 });
  A.DrawSettings.open(A.App.activePane, { type: id, points: pts, opts: {} });
  const dlg = document.querySelector('#draw-settings-dialog');
  if (!dlg) return { open: false };
  const text = dlg.textContent || '';
  const rows = [...dlg.querySelectorAll('.ds-row')].map((r) => (r.textContent || '').trim());
  const colors = dlg.querySelectorAll('.st-color').length;
  const checks = dlg.querySelectorAll('.ds-check').length;
  const sels = dlg.querySelectorAll('.st-sel').length;
  const nums = dlg.querySelectorAll('.st-num').length;
  const sliders = dlg.querySelectorAll('input[type=range]').length;
  const x = dlg.querySelector('.dlg-x');
  if (x) x.click();
  return { open: true, text, rows, colors, checks, sels, nums, sliders };
}"""

# Paint a tool against real bars and report what reached the canvas.
PAINT_JS = """(arg) => {
  const id = arg[0], extra = arg[1] || {};
  const A = window.__app;
  const pane = A.App.panes[0];
  const tool = A.DrawTools[id];
  if (!tool) return { error: 'no tool' };
  const bars = pane.bars.slice(-80);
  const ops = { fills: 0, strokes: 0, texts: [] };
  const noop = () => {};
  const ctx = new Proxy({
    font: '', save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
    arc: noop, ellipse: noop, rect: noop, roundRect: noop, translate: noop, rotate: noop,
    fill: () => { ops.fills++; }, stroke: () => { ops.strokes++; },
    fillRect: () => { ops.fills++; }, strokeRect: () => { ops.strokes++; },
    measureText: (s) => ({ width: String(s).length * 6 }),
    setLineDash: noop,
    fillText: (s) => ops.texts.push(String(s)),
    createLinearGradient: () => ({ addColorStop: noop }), clip: noop,
  }, { get: (t, k) => (k in t ? t[k] : undefined), set: () => true });
  const n = bars.length;
  const times = bars.map((b) => b.time);
  const v = {
    ctx, pw: 900, ph: 500, digits: 5, spacing: 8, times, bars,
    xOf: (t) => (t - times[0]) / (times[n - 1] - times[0]) * 800 + 40,
    yOf: (p) => 20 + (1 - (p - bars[0].low) / ((bars[n - 1].high - bars[0].low) || 1)) * 440,
    clampY: (y) => y, theme: () => '#999',
  };
  const P = (i) => ({ t: bars[i].time, p: bars[i].close });
  let points;
  if (id === 'avolprofile' || id === 'ghostfeed') points = [P(10)];
  else if (id === 'sector' || id === 'disjoint' || id === 'barspattern') points = [P(10), P(30), P(50)];
  else points = [P(10), P(60)];
  try { tool.draw(v, { points, opts: Object.assign({}, extra) }, false); }
  catch (e) { return { error: String(e && e.message) }; }
  return ops;
}"""


def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up')
        prov.terminate()
        return 1
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
            page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_function(
                "() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100",
                timeout=45000)

            print('  -- 1. callout: pointer option + bubble/tail --')
            r = page.evaluate(DLG_JS, ['callout', 2])
            check('callout dialog opens', r.get('open') is True)
            check('callout has a Pointer row', 'Pointer' in (r.get('text') or ''), r.get('rows'))
            ops = page.evaluate(PAINT_JS, ['callout', {'text': 'Hello'}])
            check('callout paints text + bubble', (ops.get('texts') or []) and (ops.get('fills') or 0) > 0, ops)

            print('  -- 2. measure: three-line info card --')
            ops = page.evaluate(PAINT_JS, ['measure', {}])
            tx = ops.get('texts') or []
            check('measure paints the card', len(tx) >= 3, ops)
            check('measure shows a % move', any('%' in t for t in tx), tx)
            check('measure shows a bar count', any('bar' in t for t in tx), tx)
            off = page.evaluate(PAINT_JS, ['measure', {'showLabel': False}])
            check('showLabel=false hides the card', len(off.get('texts') or []) == 0, off)

            print('  -- 3. volume profiles: VA % / POC / guides --')
            for tid, npt in (('volprofile', 2), ('avolprofile', 1)):
                d = page.evaluate(DLG_JS, [tid, npt])
                check(tid + ' dialog opens', d.get('open') is True)
                check(tid + ' exposes Value area %', 'Value area %' in (d.get('text') or ''), d.get('rows'))
                check(tid + ' exposes POC', 'POC' in (d.get('text') or ''), d.get('rows'))
                ops = page.evaluate(PAINT_JS, [tid, {}])
                check(tid + ' paints histogram rows', (ops.get('fills') or 0) > 2, ops)
                check(tid + ' labels the POC', any('POC' in t for t in (ops.get('texts') or [])), ops)
                off = page.evaluate(PAINT_JS, [tid, {'showPoc': False}])
                check(tid + ': showPoc=false hides it', not any('POC' in t for t in (off.get('texts') or [])), off)

            print('  -- 4. ghostfeed: opacity + candle colours --')
            d = page.evaluate(DLG_JS, ['ghostfeed', 1])
            check('ghostfeed exposes Opacity', 'Opacity' in (d.get('text') or ''), d.get('rows'))
            check('ghostfeed exposes Up/Down colours',
                  'Up color' in (d.get('text') or '') and 'Down color' in (d.get('text') or ''), d.get('rows'))
            ops = page.evaluate(PAINT_JS, ['ghostfeed', {'bars': 8}])
            check('ghostfeed paints candles', (ops.get('fills') or 0) >= 8, ops)

            print('  -- 5. posforecast: per-zone colours + entry --')
            d = page.evaluate(DLG_JS, ['posforecast', 2])
            check('posforecast exposes Profit color', 'Profit color' in (d.get('text') or ''), d.get('rows'))
            check('posforecast exposes Loss color', 'Loss color' in (d.get('text') or ''), d.get('rows'))
            check('posforecast exposes Entry line', 'Entry line' in (d.get('text') or ''), d.get('rows'))
            ops = page.evaluate(PAINT_JS, ['posforecast', {}])
            check('posforecast paints both zones', (ops.get('fills') or 0) >= 2, ops)

            print('  -- 6. sector / barspattern / disjoint labels --')
            d = page.evaluate(DLG_JS, ['sector', 3])
            check('sector exposes Angle label', 'Angle label' in (d.get('text') or ''), d.get('rows'))
            ops = page.evaluate(PAINT_JS, ['sector', {}])
            check('sector paints the angle chip', any('°' in t for t in (ops.get('texts') or [])), ops)

            d = page.evaluate(DLG_JS, ['barspattern', 3])
            check('barspattern exposes Labels', 'Labels' in (d.get('text') or ''), d.get('rows'))
            ops = page.evaluate(PAINT_JS, ['barspattern', {}])
            check('barspattern paints its chip', any('bar' in t for t in (ops.get('texts') or [])), ops)

            d = page.evaluate(DLG_JS, ['disjoint', 3])
            check('disjoint exposes Show distance', 'Show distance' in (d.get('text') or ''), d.get('rows'))
            ops = page.evaluate(PAINT_JS, ['disjoint', {}])
            check('disjoint paints the width chip', len(ops.get('texts') or []) >= 1, ops)
            off = page.evaluate(PAINT_JS, ['disjoint', {'showDistance': False}])
            check('disjoint: Show distance=false hides it', len(off.get('texts') or []) == 0, off)

            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND285: %d failed' % len(FAILS) if FAILS else 'ROUND285: all green')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
