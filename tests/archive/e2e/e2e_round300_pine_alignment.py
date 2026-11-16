#!/usr/bin/env python3
"""ROUND300 e2e — a Pine drawing must sit exactly on its bar.

THE BUG THIS PINS (reported as "the whole chart is broken, candles have gaps,
the timeline is wrecked, indicator lines jump when I zoom"):
  Pine drawings were painted through `_xOf()`, which looked the bar time up in
  `pane.barTimes` unless the Custom Session hook happened to be active. With
  "Session breaks" ON the chart's series are fed a GAP-INCLUSIVE axis
  (`_sessWithGapTimes`, 3 whitespace slots per trading day), so the lookup
  returned a logical index 12 slots too small and every line, band, label, box
  and shape sat ~86 px LEFT of its candle — and moved as you panned or zoomed,
  because the error was a fixed number of SLOTS, not pixels.

So the invariant is: for one bar, the painter's x/y must equal the chart's own
time/price coordinate for that same bar, at rest AND after panning AND after
zooming in/out, on more than one timeframe.

Run: python tests/archive/e2e/e2e_round300_pine_alignment.py
"""
import http.server, functools, json, os, socket, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_teardown import kill_proc

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 9039, 8919
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


# Drive the real chart: add an overlay indicator with a known plot, then measure
# painter-vs-chart coordinates while panning and zooming.
ALIGN_JS = """async (opts) => {
  const A = window.__app;
  const pane = A.App.activePane;
  const frames = (n) => new Promise((res) => {
    let k = 0;
    const step = () => (++k >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  const settle = async (instId) => {
    for (let k = 0; k < 120; k++) {
      const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
      if (st && st.status !== 'loading') return st;
      await frames(2);
    }
    return null;
  };

  /* make sure the session-break axis is in the state under test */
  A.Settings.set('sessionBreaks', !!opts.breaks);
  await frames(6);

  const rec = A.IndicatorsUI.add(pane, 'sma');
  const inst = (pane.pineScripts || [])[pane.pineScripts.length - 1];
  const st = await settle(inst.id);
  await frames(12);
  if (!st || !st.adapter) return { error: 'no adapter' };

  const ad = st.adapter;
  const ts = pane.chart.timeScale();
  const samples = [];

  const sample = (label) => {
    const bars = pane.bars;
    const i = Math.max(0, bars.length - 5);
    const o = st.rt.viewOut || st.rt.out;
    const plot = o.plots.get(o.plotsOrder[0]);
    const v = plot ? plot.values[i] : null;
    const chartX = ts.timeToCoordinate(bars[i].time);
    const paintX = ad._xOf(ad._barMs(bars[i].time));
    const paintY = v == null ? null : ad._yOf(v, false);
    const chartY = v == null ? null : pane.series.priceToCoordinate(v);
    samples.push({
      label,
      dX: (chartX != null && paintX != null) ? Math.abs(paintX - chartX) : 999,
      dY: (chartY != null && paintY != null) ? Math.abs(paintY - chartY) : 999,
    });
  };

  sample('initial');
  for (const step of [-40, 25, -8]) {
    const lr = ts.getVisibleLogicalRange();
    if (!lr) break;
    ts.setVisibleLogicalRange({ from: lr.from + step, to: lr.to + step });
    await frames(3);
    sample('pan' + step);
    await frames(6);
    sample('pan' + step + 'settled');
  }
  for (const shrink of [120, 300]) {
    const lr = ts.getVisibleLogicalRange();
    if (!lr) break;
    const mid = (lr.from + lr.to) / 2;
    const half = Math.max(25, (lr.to - lr.from) / 2 - shrink);
    ts.setVisibleLogicalRange({ from: mid - half, to: mid + half });
    await frames(2);
    sample('zoomIn' + shrink);
    await frames(8);
    sample('zoomIn' + shrink + 'settled');
  }
  for (const grow of [400, 1500]) {
    const lr = ts.getVisibleLogicalRange();
    if (!lr) break;
    const mid = (lr.from + lr.to) / 2;
    const half = (lr.to - lr.from) / 2 + grow;
    ts.setVisibleLogicalRange({ from: mid - half, to: mid + half });
    await frames(2);
    sample('zoomOut' + grow);
    await frames(8);
    sample('zoomOut' + grow + 'settled');
  }

  const out = {
    breaks: A.Settings.conf.sessionBreaks,
    bars: pane.bars.length,
    axis: pane._sessWithGapTimes ? pane._sessWithGapTimes.length : null,
    samples,
  };
  A.IndicatorsUI.remove(pane, rec.id);
  return out;
}"""

# Switching timeframes must keep alignment and actually re-run the script.
TF_JS = """async () => {
  const A = window.__app;
  const pane = A.App.activePane;
  const frames = (n) => new Promise((res) => {
    let k = 0;
    const step = () => (++k >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  const settle = async (instId) => {
    for (let k = 0; k < 160; k++) {
      const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
      if (st && st.status !== 'loading') return st;
      await frames(2);
    }
    return null;
  };
  const rec = A.IndicatorsUI.add(pane, 'sma');
  const inst = (pane.pineScripts || [])[pane.pineScripts.length - 1];
  await settle(inst.id);
  await frames(10);
  const out = [];
  for (const tf of ['M5', 'M15', 'H1', 'H4', 'M1']) {
    A.Manager.setTf(pane, tf);
    await frames(6);
    const st = await settle(inst.id);
    await frames(12);
    if (!st || !st.adapter) { out.push({ tf, err: 'no adapter' }); continue; }
    const bars = pane.bars;
    const i = Math.max(0, bars.length - 5);
    const o = st.rt.viewOut || st.rt.out;
    const plot = o.plots.get(o.plotsOrder[0]);
    const v = plot ? plot.values[i] : null;
    const ts = pane.chart.timeScale();
    out.push({
      tf: pane.tf,
      bars: bars.length,
      status: st.status,
      value: v == null ? null : +v.toFixed(6),
      dX: Math.abs(st.adapter._xOf(st.adapter._barMs(bars[i].time)) - ts.timeToCoordinate(bars[i].time)),
      dY: (v == null) ? 999 : Math.abs(st.adapter._yOf(v, false) - pane.series.priceToCoordinate(v)),
    });
  }
  A.IndicatorsUI.remove(pane, rec.id);
  return out;
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
            page.wait_for_timeout(1200)

            # Both axis states matter: continuous (the default) and gapped.
            for breaks in [False, True]:
                label = 'session breaks ON ' if breaks else 'session breaks OFF'
                print('  -- alignment with %s --' % label.strip())
                r = page.evaluate(ALIGN_JS, {'breaks': breaks})
                if r.get('error'):
                    check(label + ': probe ran', False, r['error'])
                    continue
                check(label + ': the axis matches the mode',
                      (r.get('axis') is None) if not breaks else (r.get('axis') > r.get('bars')),
                      'axis=%s bars=%s' % (r.get('axis'), r.get('bars')))
                worst_x = max(s['dX'] for s in r['samples'])
                worst_y = max(s['dY'] for s in r['samples'])
                check(label + ': every drawing stays on its bar while panning/zooming (x)',
                      worst_x <= 1.0, 'worst dX=%.2f px over %d samples' % (worst_x, len(r['samples'])))
                check(label + ': and on its price level (y)',
                      worst_y <= 1.0, 'worst dY=%.2f px' % worst_y)

            print('  -- alignment across timeframes --')
            tf = page.evaluate(TF_JS)
            print('    ' + json.dumps(tf)[:400])
            for row in tf:
                dx = row.get('dX')
                dy = row.get('dY')
                check('tf %s: script ran' % row.get('tf'), row.get('status') == 'ok', row)
                # NOTE: `or 99` would turn a perfect 0 into a failure — compare
                # against None explicitly.
                check('tf %s: drawing on its bar' % row.get('tf'),
                      dx is not None and dx <= 1.0, dx)
                check('tf %s: drawing on its price' % row.get('tf'),
                      dy is not None and dy <= 1.0, dy)
                check('tf %s: bar count is consistent' % row.get('tf'),
                      (row.get('bars') or 0) > 100, row.get('bars'))
            values = {row.get('tf'): row.get('value') for row in tf}
            check('the script really re-ran per timeframe (different values)',
                  len(set(values.values())) >= 3, values)

            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        kill_proc(prov)
    print('ROUND300: %d failed' % len(FAILS) if FAILS else 'ROUND300: all green')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
