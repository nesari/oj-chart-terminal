#!/usr/bin/env python3
"""ROUND301 e2e — switching timeframe with indicators on the chart.

THE REPORT (with an exported Diagnostics log):
  "when I add an indicator and switch the timeframe the chart jumps, the
   indicator stays behind, then after some scrolling the candles come back and
   the log fills up"
  The log had 129/145 entries as `Value is null` thrown from INSIDE
  lightweight-charts' candlestick renderer.

ROOT CAUSE (two defects, both in the timeframe switch):
  1. `applyTf` cleared `pane.bars` but not the SERIES. For ~20 frames the pane
     had bars=[] while `series` still held the previous interval's 5000 rows,
     so LWC rendered a series whose axis no consumer shared -> "Value is null"
     spam, and the old candles visibly stayed on screen (the "jump").
  2. The Pine instances kept painting during that window: their painters map
     `pane.bars` (empty) through the still-populated chart, i.e. the indicator
     stayed behind on stale coordinates.

Pins, in the real app, with an indicator present:
  * no "Value is null" during the switch
  * the series never shows rows from a previous timeframe while bars is empty
  * indicators go blank with the chart and come back on the new timeframe
  * the drawing is aligned once the new history lands (x and y)
  * the log stays quiet (no error entries)

Run: python tests/archive/e2e/e2e_round301_tf_switch.py
"""
import http.server, functools, json, os, socket, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_teardown import kill_proc

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 9045, 8925
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


# Collect every "Value is null" that escapes LWC, with its stack.
INIT = """
window.__nullErrs = [];
(function () {
  window.addEventListener('error', (e) => {
    try {
      const m = e && e.error && String(e.error.message);
      if (m && m.indexOf('Value is null') >= 0) {
        window.__nullErrs.push((e.error.stack || '').split('\\n').slice(0, 8).join(' | '));
      }
    } catch (x) {}
  });
  const origErr = console.error;
  console.error = function () {
    try {
      for (const a of arguments) {
        const s = (a && a.stack) ? a.stack : (typeof a === 'string' ? a : '');
        if (s && s.indexOf('Value is null') >= 0) window.__nullErrs.push(String(s).slice(0, 400));
      }
    } catch (x) {}
    return origErr.apply(this, arguments);
  };
})();
"""

# Drive the exact reported flow and sample the pane throughout the switch.
SWITCH_JS = """async () => {
  const A = window.__app;
  const pane = A.App.activePane;
  const frames = (n) => new Promise((res) => {
    let k = 0;
    const step = () => (++k >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  const settle = async (instId) => {
    for (let k = 0; k < 200; k++) {
      const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
      if (st && st.status !== 'loading') return st;
      await frames(2);
    }
    return null;
  };

  window.__nullErrs = [];

  /* start from a symbol like the reported log (XAUUSD, 2 digits) */
  A.Manager.setSymbol(pane, 'XAUUSD');
  await frames(30);
  await new Promise((r) => setTimeout(r, 900));

  const rec = A.IndicatorsUI.add(pane, 'sma');
  const inst = (pane.pineScripts || [])[pane.pineScripts.length - 1];
  await settle(inst.id);
  await frames(12);

  const samples = [];
  const snap = (label) => {
    let rows = -1;
    try { rows = pane.series.data().length; } catch (e) { rows = -2; }
    const dbg = A.PineUI.debug(pane);
    samples.push({
      label, tf: pane.tf, bars: pane.bars.length, rows,
      pine: dbg.map((s) => s.status).join(','),
      pineBars: dbg.map((s) => s.bars).join(','),
    });
  };

  const before = { tf: pane.tf, bars: pane.bars.length };
  snap('before');
  A.Manager.setTf(pane, 'H1');
  /* sample every frame of the loading window */
  for (let k = 0; k < 3; k++) { await frames(1); snap('load+' + (k + 1)); }
  await frames(10);
  snap('load+13');
  await settle(inst.id);
  await frames(14);
  snap('after');

  /* final alignment on the new timeframe */
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  let dX = 999, dY = 999, value = null;
  if (st && st.adapter && pane.bars.length) {
    const bars = pane.bars;
    const i = Math.max(0, bars.length - 5);
    const o = st.rt.viewOut || st.rt.out;
    const plot = o.plots.get(o.plotsOrder[0]);
    const v = plot ? plot.values[i] : null;
    value = v == null ? null : +v.toFixed(6);
    const ts = pane.chart.timeScale();
    dX = Math.abs(st.adapter._xOf(st.adapter._barMs(bars[i].time)) - ts.timeToCoordinate(bars[i].time));
    dY = (v == null) ? 999 : Math.abs(st.adapter._yOf(v, false) - pane.series.priceToCoordinate(v));
  }

  A.IndicatorsUI.remove(pane, rec.id);
  return {
    before, samples, dX, dY, value,
    nullErrs: (window.__nullErrs || []).length,
    nullSample: (window.__nullErrs || [])[0] || null,
    finalStatus: st ? st.status : 'none',
  };
}"""

# The Diagnostics log must not fill with errors either.
LOG_JS = """() => {
  const A = window.__app;
  const L = A.Log;
  if (!L || !L.entries) return { error: 'no log' };
  const all = L.entries();
  const errs = all.filter((e) => e && e.level === 'error');
  return {
    total: all.length,
    errors: errs.length,
    nullish: errs.filter((e) => String(e.message || '').indexOf('Value is null') >= 0).length,
    sample: errs.slice(0, 2).map((e) => String(e.message || '').slice(0, 80)),
  };
}"""


# The same defect exists on a SYMBOL switch — pin both paths.
SYMBOL_JS = """async () => {
  const A = window.__app;
  const pane = A.App.activePane;
  const frames = (n) => new Promise((res) => {
    let k = 0;
    const step = () => (++k >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  const settle = async (instId) => {
    for (let k = 0; k < 200; k++) {
      const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
      if (st && st.status !== 'loading') return st;
      await frames(2);
    }
    return null;
  };
  window.__nullErrs = [];
  const rec = A.IndicatorsUI.add(pane, 'sma');
  const inst = (pane.pineScripts || [])[pane.pineScripts.length - 1];
  await settle(inst.id);
  await frames(12);

  const samples = [];
  const snap = (label) => {
    let rows = -1;
    try { rows = pane.series.data().length; } catch (e) { rows = -2; }
    samples.push({ label, sym: pane.symbol, bars: pane.bars.length, rows,
      pineBars: A.PineUI.debug(pane).map((s) => s.bars).join(',') });
  };
  snap('before');
  A.Manager.setSymbol(pane, 'GBPUSD');
  for (let k = 0; k < 3; k++) { await frames(1); snap('load+' + (k + 1)); }
  await frames(12);
  await settle(inst.id);
  await frames(14);
  snap('after');
  A.IndicatorsUI.remove(pane, rec.id);
  return { samples, nullErrs: (window.__nullErrs || []).length,
           sym: pane.symbol, bars: pane.bars.length };
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
            ctx = browser.new_context(viewport={'width': 1600, 'height': 950})
            ctx.add_init_script(INIT)
            page = ctx.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(1000)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_function(
                "() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100",
                timeout=45000)
            page.wait_for_timeout(1500)

            print('  -- switching timeframe with an indicator on the chart --')
            r = page.evaluate(SWITCH_JS)
            print('    ' + json.dumps({'before': r['before'], 'dX': r['dX'], 'dY': r['dY'],
                                       'value': r['value'], 'nullErrs': r['nullErrs']}))
            for s in r['samples']:
                print('      %-10s tf=%-4s bars=%-5s rows=%-5s pine=%-8s pineBars=%s' % (
                    s['label'], s['tf'], s['bars'], s['rows'], s['pine'], s['pineBars']))

            check('no "Value is null" escapes during the switch', r['nullErrs'] == 0,
                  {'count': r['nullErrs'], 'sample': r['nullSample']})

            # the loading window must never show a series whose rows belong to
            # the PREVIOUS timeframe while the pane's own bars are empty
            stale = [s for s in r['samples'] if s['bars'] == 0 and s['rows'] > 0]
            check('the series is blanked with the bars (no stale rows on screen)',
                  not stale, stale[:2])

            loading = [s for s in r['samples'] if s['label'].startswith('load')]
            check('indicators do not paint against an empty bar array',
                  all(s['pineBars'] in ('', '0') or s['bars'] > 0 for s in loading), loading[:2])

            after = [s for s in r['samples'] if s['label'] == 'after']
            check('the chart came back on the new timeframe',
                  bool(after) and after[0]['bars'] > 100, after[:1])
            check('the indicator came back with it',
                  bool(after) and after[0]['pine'] == 'ok' and (after[0]['pineBars'] in ('2500', '3500', '3000')),
                  after[:1])
            check('the drawing is still on its bar after the switch', r['dX'] <= 1.0, r['dX'])
            check('the drawing is still on its price level', r['dY'] <= 1.0, r['dY'])
            check('the script actually re-ran on the new timeframe (real value)', r['value'] is not None, r['value'])

            print('  -- switching symbol with an indicator on the chart --')
            sy = page.evaluate(SYMBOL_JS)
            for s in sy.get('samples', []):
                print('      %-10s sym=%-7s bars=%-5s rows=%-5s pineBars=%s' % (
                    s['label'], s['sym'], s['bars'], s['rows'], s['pineBars']))
            check('symbol switch: no "Value is null"', sy.get('nullErrs') == 0, sy.get('nullErrs'))
            staleSym = [s for s in sy.get('samples', []) if s['bars'] == 0 and s['rows'] > 0]
            check('symbol switch: the series is blanked with the bars', not staleSym, staleSym[:2])
            check('symbol switch: the new symbol loaded', sy.get('sym') == 'GBPUSD' and (sy.get('bars') or 0) > 100, sy)

            print('  -- the Diagnostics log stays quiet --')
            lg = page.evaluate(LOG_JS)
            print('    ' + json.dumps(lg)[:240])
            if not lg.get('error'):
                check('no "Value is null" entries in the log', (lg.get('nullish') or 0) == 0, lg)

            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        kill_proc(prov)
    print('ROUND301: %d failed' % len(FAILS) if FAILS else 'ROUND301: all green')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
