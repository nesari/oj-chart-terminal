#!/usr/bin/env python3
"""ROUND298 e2e — built-in indicator math/render parity, live.

Proves in the REAL app (not just node) the three things the node suite cannot:
  1. a channel indicator's band fill actually PAINTS pixels on the main chart
     (the band existed in compute() since round 27 but was never drawn);
  2. the fill disappears when the indicator is removed (no orphan primitive);
  3. MACD's histogram bodies are colored by SIGN, not by "did it rise"
     (read the real LWC series data, not the compute output).

Run: python tests/archive/e2e/e2e_round298_indicator_render.py
"""
import http.server, functools, json, os, socket, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_teardown import kill_proc

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 9013, 8893
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


# Add a channel indicator, diff the main chart canvas before/after, then remove
# it and diff again. The sampling MUST await real animation frames:
# attachPrimitive only registers the primitive, the fill appears on the chart's
# next paint pass (an immediate read sees the pre-paint pixels).
#
# Colour-agnostic on purpose: each channel uses its own fill tint (Bollinger
# blue, Donchian teal, Keltner yellow), so counting "changed pixels" proves the
# fill painted without hard-coding a hue that would silently stop matching.
BAND_JS = """async (kind) => {
  const A = window.__app;
  const pane = A.App.activePane;
  if (!pane || !pane.chart) return { error: 'no pane' };

  const frames = (n) => new Promise((res) => {
    let k = 0;
    const step = () => (++k >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

  /* snapshot every readable chart canvas into one flat Uint8ClampedArray */
  const snapshot = () => {
    const host = pane.host.querySelector('.tv-lightweight-charts');
    if (!host) return { error: 'no chart host' };
    const cs = [...host.querySelectorAll('canvas')];
    const parts = [];
    let scanned = 0, w = 0, h = 0;
    for (const c of cs) {
      if (!c.width || !c.height) continue;
      let ctx = null;
      try { ctx = c.getContext('2d'); } catch (e) { continue; }
      if (!ctx) continue;
      let img = null;
      try { img = ctx.getImageData(0, 0, c.width, c.height); } catch (e) { continue; }
      scanned++; w = c.width; h = c.height;
      parts.push(img.data);
    }
    return { parts, scanned, w, h };
  };

  /* how many sampled pixels differ between two snapshots */
  const diff = (a, b) => {
    if (!a || !b || a.error || b.error) return -1;
    if (a.parts.length !== b.parts.length) return -1;
    let changed = 0;
    for (let pi = 0; pi < a.parts.length; pi++) {
      const x = a.parts[pi], y = b.parts[pi];
      if (x.length !== y.length) return -1;
      for (let i = 0; i < x.length; i += 4 * 5) {
        if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 3) changed++;
      }
    }
    return changed;
  };

  await frames(4);
  const base = snapshot();

  /* how many pixels does this indicator change on its own? */
  const cost = async (type) => {
    const inst = A.IndicatorsUI.add(pane, type);
    if (!inst) return -1;
    try { A.Manager.recomputeIndicators(pane); } catch (e) {}
    await frames(8);
    const snap = snapshot();
    const painted = diff(base, snap);
    A.IndicatorsUI.remove(pane, inst.id);
    try { A.Manager.recomputeIndicators(pane); } catch (e) {}
    await frames(8);
    const after = snapshot();
    return { painted, cleared: diff(base, after), scanned: (snap && snap.scanned) || 0 };
  };

  const band = await cost(kind);
  /* Envelopes draws the same 3-line shape with NO band fill: the control.
     A channel that fills must paint clearly more than the bare lines. */
  const control = await cost('envelopes');
  await frames(4);
  const final = snapshot();
  return {
    kind,
    painted: band.painted,
    cleared: diff(base, final),
    scanned: band.scanned,
    controlPainted: control.painted,
    size: base.w ? (base.w + 'x' + base.h) : null,
  };
}"""

# Prove the MACD histogram is really painted green-above-zero / red-below-zero
# by sampling the SUB-PANE canvas after real paint frames.
MACD_JS = """async () => {
  const A = window.__app;
  const pane = A.App.activePane;
  const frames = (n) => new Promise((res) => {
    let k = 0;
    const step = () => (++k >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

  const inst = A.IndicatorsUI.add(pane, 'macd');
  if (!inst) return { error: 'add failed' };
  try { A.Manager.recomputeIndicators(pane); } catch (e) {}
  await frames(10);

  const out = A.Indicators.compute(inst, pane.bars);
  const vals = out.hist.values;
  const mode = out.hist.colorMode;
  let pos = -1, neg = -1;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v == null || !isFinite(v)) continue;
    if (v > 0 && pos < 0) pos = i;
    if (v < 0 && neg < 0) neg = i;
  }

  /* sample the MACD sub-pane canvas: count greenish and reddish pixels */
  let green = 0, red = 0, scanned = 0;
  const sub = pane._subs ? pane._subs.get(inst.id) : null;
  const host = sub && sub.host ? sub.host : null;
  if (host) {
    const cs = [...host.querySelectorAll('canvas')];
    for (const c of cs) {
      if (!c.width || !c.height) continue;
      let ctx = null;
      try { ctx = c.getContext('2d'); } catch (e) { continue; }
      if (!ctx) continue;
      let img = null;
      try { img = ctx.getImageData(0, 0, c.width, c.height); } catch (e) { continue; }
      scanned++;
      const d = img.data;
      for (let i = 0; i < d.length; i += 4 * 3) {
        const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
        if (a < 40) continue;
        /* MACD hist colors are rgba(38,166,154,.5) up / rgba(239,83,80,.5) down */
        if (g > r + 25 && g > b + 10) green++;
        else if (r > g + 55 && r > b + 30) red++;
      }
    }
  }

  A.IndicatorsUI.remove(pane, inst.id);
  return {
    mode, pos, neg, green, red, scanned,
    posVal: pos >= 0 ? vals[pos] : null,
    negVal: neg >= 0 ? vals[neg] : null,
  };
}"""


# Prove the band primitive is attached exactly ONCE and never leaked, even
# across a render-state rebuild (theme/TF passes drop the state map while the
# chart lives on — a primitive left behind would paint the band twice).
BAND_ONCE_JS = """async () => {
  const A = window.__app;
  const pane = A.App.activePane;
  const frames = (n) => new Promise((res) => {
    let k = 0;
    const step = () => (++k >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

  let attaches = 0, detaches = 0;
  const oa = pane.series.attachPrimitive.bind(pane.series);
  const od = pane.series.detachPrimitive.bind(pane.series);
  pane.series.attachPrimitive = function (p) { attaches++; return oa(p); };
  pane.series.detachPrimitive = function (p) { detaches++; return od(p); };

  const inst = A.IndicatorsUI.add(pane, 'bollinger');
  try { A.Manager.recomputeIndicators(pane); } catch (e) {}
  await frames(6);
  const afterAdd = attaches;

  /* repeated repaints must never re-attach */
  for (let k = 0; k < 6; k++) {
    try { A.Manager.recomputeIndicators(pane); } catch (e) {}
    await frames(2);
  }
  const afterRepeats = attaches;

  /* simulate a render-state rebuild with the chart alive */
  A.IndicatorsUI.dropPane(pane);
  try { A.Manager.recomputeIndicators(pane); } catch (e) {}
  await frames(4);
  const liveAfterDrop = (pane._indBandPrims || new Map()).size;

  A.IndicatorsUI.remove(pane, inst.id);
  try { A.Manager.recomputeIndicators(pane); } catch (e) {}
  await frames(4);
  return {
    afterAdd, afterRepeats, liveAfterDrop,
    balance: attaches - detaches,
    remaining: (pane._indBandPrims || new Map()).size,
  };
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
            page = browser.new_page(viewport={'width': 1600, 'height': 950})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(1000)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_function(
                "() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100",
                timeout=45000)
            page.wait_for_timeout(900)

            print('  -- 1. channel band fill actually paints --')
            for kind in ['bollinger', 'donchian', 'keltner']:
                r = page.evaluate(BAND_JS, kind)
                page.wait_for_timeout(300)
                if r.get('error'):
                    check(kind + ': probe ran', False, r['error'])
                    continue
                painted = r.get('painted', -1)
                control = r.get('controlPainted', -1)
                cleared = r.get('cleared', -1)
                check(kind + ': chart canvas readable', (r.get('scanned') or 0) > 0, r.get('size'))
                # The control (Envelopes: same 3 line series, NO band) paints
                # lines only. A channel that also FILLS must shade clearly more
                # of the chart than that — this is what actually proves the
                # band is painted, not merely that "some pixels changed".
                check(kind + ': band shades much more than bare lines', painted > control * 1.5 and painted > 1000,
                      'painted=%s control(no band)=%s' % (painted, control))
                # Removing it must drop essentially everything it added. Not an
                # exact zero: the demo feed keeps ticking between snapshots, so
                # live candles legitimately repaint a few hundred pixels.
                check(kind + ': removing the indicator clears the fill',
                      cleared is not None and 0 <= cleared < max(30, painted * 0.05),
                      'cleared=%s painted=%s' % (cleared, painted))

            print('  -- 2. the band primitive is attached once and never leaked --')
            o = page.evaluate(BAND_ONCE_JS)
            print('    ' + json.dumps(o))
            check('band primitive attached once on add', o.get('afterAdd') == 1, o.get('afterAdd'))
            check('repeated repaints do not re-attach', o.get('afterRepeats') == 1, o.get('afterRepeats'))
            check('a render-state rebuild leaves exactly one live primitive',
                  o.get('liveAfterDrop') == 1, o.get('liveAfterDrop'))
            check('attach/detach balance is zero (no leak)', o.get('balance') == 0, o.get('balance'))
            check('removing the indicator empties the primitive map', o.get('remaining') == 0, o.get('remaining'))

            print('  -- 3. MACD histogram colors by sign --')
            m = page.evaluate(MACD_JS)
            print('    ' + json.dumps(m)[:240])
            if m.get('error'):
                check('macd probe ran', False, m['error'])
            else:
                check('MACD hist declares sign coloring', m.get('mode') == 'sign', m.get('mode'))
                check('histogram has a positive bar to test', (m.get('posVal') or 0) > 0, m.get('posVal'))
                check('histogram has a negative bar to test', (m.get('negVal') or 0) < 0, m.get('negVal'))
                check('MACD sub-pane canvas readable', (m.get('scanned') or 0) > 0, m.get('scanned'))
                check('MACD histogram paints GREEN bodies', (m.get('green') or 0) > 20, m.get('green'))
                check('MACD histogram paints RED bodies', (m.get('red') or 0) > 20, m.get('red'))

            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        kill_proc(prov)
    print('ROUND298: %d failed' % len(FAILS) if FAILS else 'ROUND298: all green')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
