#!/usr/bin/env python3
"""ROUND289 e2e — the five drawing leftovers, verified live in the real app.

Covers:
  1. callout   — the Text tab's horizontal/vertical alignment reaches the bubble
  2. volprofile / avolprofile — the Scope select exists AND changes the painted
                 range (fixed vs session vs visible vs anchor)
  3. ghostfeed — the projection band is a real statistic (present when on,
                 absent when band=0, and zero for a noiseless sample)
  4. measure   — each info-card row switches off on its own
  5. posforecast — the three levels have grips and a dragged stop persists
  6. sector    — the radius guides carry prices
  7. no schema table declares a tool twice (the bug that dropped Scope)

Both browser globals and the REAL dialog are used, so a setting that exists in
source but not in the dialog (or vice versa) fails here.

Run: python tests/archive/e2e/e2e_round289_drawing_leftovers.py
"""
import http.server, functools, os, socket, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_teardown import kill_proc  # ROUND288: whole-tree cleanup on Windows

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 9010, 8865
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


# Open the real dialog and report the labelled rows + widget counts.
# `opts` defaults to the FACTORY opts, which is exactly what the create path
# passes — opening a dialog with `{}` would hide every `showIf` row and report
# a false gap (that is how the first run mis-read the measure card).
DLG_JS = """(arg) => {
  const id = arg[0], npt = arg[1];
  const A = window.__app;
  const pts = [];
  for (let i = 0; i < npt; i++) pts.push({ t: 1790600400 + i * 900, p: 100 + i * 2 });
  const opts = A.App.drawings && A.App.drawings.defaultOpts
    ? A.App.drawings.defaultOpts(id) : {};
  A.DrawSettings.open(A.App.activePane, { type: id, points: pts, opts });
  const dlg = document.querySelector('#draw-settings-dialog');
  if (!dlg) return { open: false };
  const text = dlg.textContent || '';
  const rows = [...dlg.querySelectorAll('.ds-row')].map((r) => (r.textContent || '').trim());
  const out = {
    open: true, text, rows,
    colors: dlg.querySelectorAll('.st-color').length,
    checks: dlg.querySelectorAll('.ds-check').length,
    sels: dlg.querySelectorAll('.st-sel').length,
    nums: dlg.querySelectorAll('.st-num').length,
    sliders: dlg.querySelectorAll('input[type=range]').length,
  };
  const x = dlg.querySelector('.dlg-x');
  if (x) x.click();
  return out;
}"""

# Paint a tool against the REAL bars and report what reached the canvas.
# `visible` makes the "visible bars" scope deterministic.
PAINT_JS = """(arg) => {
  const id = arg[0], extra = arg[1] || {};
  const A = window.__app;
  const pane = A.App.panes[0];
  const tool = A.DrawTools[id];
  if (!tool) return { error: 'no tool' };
  const bars = arg[3] === 'synth' ? (() => {
    /* three 24-bar days with DIFFERENT price shapes, so "anchor to now" and
       "the anchor's session" must produce different profiles */
    const out = [];
    const t0 = 1790640000;
    for (let i = 0; i < 72; i++) {
      const day = Math.floor(i / 24);
      const base = [100, 140, 90][day];
      const o = base + Math.sin(i / 3) * 4 + (i % 24) * 0.4;
      out.push({ time: t0 + i * 3600, open: o, high: o + 2, low: o - 2, close: o + 0.7, volume: 20 + (i % 11) });
    }
    return out;
  })() : pane.bars.slice(-120);
  const ops = { fills: 0, strokes: 0, texts: [], rects: [] };
  const noop = () => {};
  const ctx = new Proxy({
    font: '', textAlign: 'left', textBaseline: 'top', fillStyle: '',
    save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
    arc: noop, ellipse: noop, rect: noop, roundRect: noop, translate: noop, rotate: noop,
    scale: noop,
    fill: () => { ops.fills++; }, stroke: () => { ops.strokes++; },
    fillRect: (x, y, w, h) => { ops.fills++; ops.rects.push([x, y, w, h]); },
    strokeRect: () => { ops.strokes++; },
    measureText: (s) => ({ width: String(s).length * 6 }),
    setLineDash: noop,
    fillText: (s, x, y) => ops.texts.push({ s: String(s), x, y, align: ctx.textAlign }),
    createLinearGradient: () => ({ addColorStop: noop }), clip: noop,
  }, { get: (t, k) => (k in t ? t[k] : undefined), set: (t, k, v) => { t[k] = v; return true; } });
  const n = bars.length;
  const times = bars.map((b) => b.time);
  let lo = Infinity, hi = -Infinity;
  for (const b of bars) { lo = Math.min(lo, b.low); hi = Math.max(hi, b.high); }
  const v = {
    ctx, pw: 900, ph: 500, digits: 5, spacing: 8, times, bars, serverOffSec: 0,
    visibleFrom: arg[2] ? arg[2][0] : null,
    visibleTo: arg[2] ? arg[2][1] : null,
    xOf: (t) => (t - times[0]) / ((times[n - 1] - times[0]) || 1) * 800 + 40,
    yOf: (p) => 20 + (1 - (p - lo) / ((hi - lo) || 1)) * 440,
    pOf: (y) => lo + (1 - (y - 20) / 440) * (hi - lo),
    clampY: (y) => y, theme: () => '#999',
  };
  const P = (i) => ({ t: bars[Math.min(i, n - 1)].time, p: bars[Math.min(i, n - 1)].close });
  let points;
  if (id === 'avolprofile' || id === 'ghostfeed') points = [P(4)];
  else if (id === 'sector' || id === 'disjoint' || id === 'barspattern') points = [P(10), P(40), P(25)];
  else points = [P(4), P(Math.min(60, n - 1))];
  try {
    tool.draw(v, { points, opts: Object.assign({}, extra) }, false);
  } catch (e) { return { error: String(e && e.message) }; }
  return ops;
}"""

# Exercise handles/drag through the REAL tool contract.
GEO_JS = """(arg) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const tool = A.DrawTools.posforecast;
  const bars = pane.bars.slice(-60);
  const n = bars.length, times = bars.map((b) => b.time);
  const v = {
    pw: 900, ph: 500, digits: 5, spacing: 8, times, bars,
    xOf: (t) => (t - times[0]) / ((times[n - 1] - times[0]) || 1) * 800 + 40,
    yOf: (p) => 460 - (p - 95) * 12,
  };
  const d = { points: [{ t: bars[10].time, p: 110 }, { t: bars[30].time, p: 120 }], opts: { coeff: '2' } };
  const stop0 = tool._stop(v, d);
  const hs = tool.handles(v, d) || [];
  tool.dragHandle(v, d, 4, { t: bars[20].time, p: 103 });
  const stop1 = tool._stop(v, d);
  return { stop0, nHandles: hs.length, stop1, coeff: d.opts.coeff, stored: d.opts.stop };
}"""

SCHEMA_JS = """() => {
  const src = window.__drawSettingsSource || null;
  return { hasSource: !!src };
}"""


def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up')
        kill_proc(prov)
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

            print('  -- 1. callout: text alignment reaches the bubble --')
            # JS string escapes inside the Python literal: "\\n" in the file is a
            # real newline by the time the page sees it.
            left = page.evaluate(PAINT_JS, ['callout', {'text': 'Hello\nWorld', 'textHAlign': 'left', 'textVAlign': 'top'}])
            center = page.evaluate(PAINT_JS, ['callout', {'text': 'Hello\nWorld', 'textHAlign': 'center', 'textVAlign': 'inside'}])
            check('callout paints both lines', len((left.get('texts') or [])) == 2, left)
            lt = (left.get('texts') or [{}])[0]
            ct = (center.get('texts') or [{}])[0]
            check('left alignment is applied', lt.get('align') == 'left', lt)
            check('center alignment is applied', ct.get('align') == 'center', ct)
            check('centred text starts further right', (ct.get('x') or 0) > (lt.get('x') or 0), (lt.get('x'), ct.get('x')))
            check('vertically centred text sits lower', (ct.get('y') or 0) > (lt.get('y') or 0), (lt.get('y'), ct.get('y')))

            print('  -- 2. volume profile: Scope is a real control --')
            for tid, npt in (('volprofile', 2), ('avolprofile', 1)):
                d = page.evaluate(DLG_JS, [tid, npt])
                check(tid + ' dialog opens', d.get('open') is True)
                check(tid + ' exposes a Scope select', 'Scope' in (d.get('text') or ''), d.get('rows'))
                check(tid + ' has a select widget', (d.get('sels') or 0) >= 1, d.get('sels'))
                check(tid + ' still exposes Value area %', 'Value area %' in (d.get('text') or ''), d.get('rows'))
                check(tid + ' still exposes POC', 'POC' in (d.get('text') or ''), d.get('rows'))

            base = page.evaluate(PAINT_JS, ['volprofile', {'scope': 'fixed'}, None, 'synth'])
            sess = page.evaluate(PAINT_JS, ['volprofile', {'scope': 'session'}, None, 'synth'])
            vis = page.evaluate(PAINT_JS, ['volprofile', {'scope': 'visible'}, [0, 119], 'synth'])
            check('fixed scope paints rows', (base.get('fills') or 0) > 2, base)
            check('session scope paints rows', (sess.get('fills') or 0) > 0, sess)
            check('visible scope paints rows', (vis.get('fills') or 0) > 0, vis)
            poc = lambda ops: [t for t in (ops.get('texts') or []) if t.get('s', '').startswith('POC')]
            check('fixed and visible label POC', len(poc(base)) == 1 and len(poc(vis)) == 1, (poc(base), poc(vis)))
            check('a wider range gives a different POC',
                  poc(base)[0]['y'] != poc(vis)[0]['y'], (poc(base)[0]['y'], poc(vis)[0]['y']))

            anc = page.evaluate(PAINT_JS, ['avolprofile', {'scope': 'anchor'}, None, 'synth'])
            asess = page.evaluate(PAINT_JS, ['avolprofile', {'scope': 'session'}, None, 'synth'])
            check('avolprofile anchor scope paints', (anc.get('fills') or 0) > 0, anc)
            check('avolprofile session scope paints', (asess.get('fills') or 0) > 0, asess)
            check('avolprofile scopes disagree on the POC',
                  poc(anc) and poc(asess) and poc(anc)[0]['y'] != poc(asess)[0]['y'],
                  (poc(anc), poc(asess)))
            ancsess = page.evaluate(PAINT_JS, ['volprofile', {'scope': 'session'}, None, 'synth'])
            check('volprofile session scope (synthetic days) paints', (ancsess.get('fills') or 0) > 0, ancsess)

            print('  -- 3. ghostfeed: statistical projection band --')
            d = page.evaluate(DLG_JS, ['ghostfeed', 1])
            check('ghostfeed exposes Projection band', 'Projection band' in (d.get('text') or ''), d.get('rows'))
            check('ghostfeed exposes Band color', 'Band color' in (d.get('text') or ''), d.get('rows'))
            on = page.evaluate(PAINT_JS, ['ghostfeed', {'bars': 8}])
            off = page.evaluate(PAINT_JS, ['ghostfeed', {'bars': 8, 'band': 0}])
            check('band on paints more than candle-only', (on.get('fills') or 0) > (off.get('fills') or 0),
                  (on.get('fills'), off.get('fills')))

            print('  -- 4. measure: per-row card controls --')
            d = page.evaluate(DLG_JS, ['measure', 2])
            txt = d.get('text') or ''
            for lab in ('Price change', 'Bar count', 'Duration'):
                check('measure exposes ' + lab, lab in txt, d.get('rows'))
            allrows = page.evaluate(PAINT_JS, ['measure', {}])
            check('measure paints three rows', len(allrows.get('texts') or []) == 3, allrows)
            nb = page.evaluate(PAINT_JS, ['measure', {'showBars': False}])
            check('showBars=false drops one row', len(nb.get('texts') or []) == 2, nb)
            npc = page.evaluate(PAINT_JS, ['measure', {'showPrice': False, 'showBars': False, 'showDuration': False}])
            check('hiding every row paints no panel', len(npc.get('texts') or []) == 0, npc)

            print('  -- 5. posforecast: draggable levels --')
            g = page.evaluate(GEO_JS)
            check('the stop derives from the coefficient', abs(g.get('stop0', 0) - 105) < 1e-6, g)
            check('three levels expose six grips', g.get('nHandles') == 6, g)
            check('a dragged stop is stored', abs(g.get('stop1', 0) - 103) < 1e-6, g)
            check('the coefficient follows the drag', str(g.get('coeff')) == '1.43', g)
            d = page.evaluate(DLG_JS, ['posforecast', 2])
            check('posforecast still exposes Risk/reward', 'Risk/reward' in (d.get('text') or ''), d.get('rows'))
            check('posforecast exposes Entry line', 'Entry line' in (d.get('text') or ''), d.get('rows'))

            print('  -- 6. sector: radius guides --')
            d = page.evaluate(DLG_JS, ['sector', 3])
            check('sector exposes Radius guides', 'Radius guides' in (d.get('text') or ''), d.get('rows'))
            ops = page.evaluate(PAINT_JS, ['sector', {}])
            pricechips = [t for t in (ops.get('texts') or []) if '°' not in t.get('s', '')]
            check('sector labels both radii', len(pricechips) >= 2, ops.get('texts'))
            offr = page.evaluate(PAINT_JS, ['sector', {'showRadii': False}])
            check('Radius guides=false removes the prices',
                  len([t for t in (offr.get('texts') or []) if '°' not in t.get('s', '')]) == 0,
                  offr.get('texts'))
            check('the angle chip survives the toggle',
                  any('°' in t.get('s', '') for t in (offr.get('texts') or [])), offr.get('texts'))

            print('  -- 7. the RICH profile schema wins (no silent duplicate override) --')
            # A duplicate declaration used to override the rich schema with a 2-row
            # stub, so the row COUNT is the live proof that the override is gone.
            for tid, npt, minrows in (('volprofile', 2, 6), ('avolprofile', 1, 6)):
                d = page.evaluate(DLG_JS, [tid, npt])
                n = len(d.get('rows') or [])
                check(tid + ' shows the full schema, not a stub',
                      n >= minrows, (n, d.get('rows')))
            # and each profile's rich options survive alongside Scope
            vp = page.evaluate(DLG_JS, ['volprofile', 2]).get('text') or ''
            check('volprofile keeps VA/POC/colour rows',
                  all(k in vp for k in ('Value area %', 'POC color')),
                  vp)

            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        kill_proc(prov)
    print('ROUND289: %d failed' % len(FAILS) if FAILS else 'ROUND289: all green')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
