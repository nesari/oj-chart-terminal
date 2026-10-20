#!/usr/bin/env python3
"""ROUND226 e2e — declaration timeframe + dynamic requests, live.

  (1) indicator(timeframe="D") on the intraday demo chart: engine ok, runtime
      TF is daily, run bars < chart bars (HTF buckets).
  (2) series-symbol security with NO static literal pair: engine ok via the
      fixpoint fetch (Diagnostics holds the 'dynamic fetch' line), and plot
      values equal a static-mirror run (parity proof).
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8968, 8847
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

SRC_TF = '//@version=6\nindicator("TST226T", overlay=true, timeframe="D")\nplot(close)\n'
SRC_DYN = ('//@version=6\nindicator("TST226D", overlay=true)\n'
           's = bar_index % 2 == 0 ? __SYM0__ : "GBPUSD"\n'
           'x = request.security(s, "", close)\nplot(x)\n')
SRC_STATIC = ('//@version=6\nindicator("TST226S", overlay=true)\n'
              'x = request.security("GBPUSD", "", close)\nplot(x)\n')

READ_JS = """async ({tf, dyn, stat}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const sym0 = pane.symbol;
  dyn = dyn.replace(/__SYM0__/, '"' + sym0 + '"');
  const out = { sym0 };
  async function add(name, src, keep) {
    const rec = A.PineScriptsStore.create(name, src);
    const inst = A.PineUI.add(pane, rec.id);
    await A.PineUI.rebuild(pane, inst);
    for (let i = 0; i < 60; i++) {
      const s0 = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
      if (s0 && s0.status !== 'loading') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
    const r = { inst, status: st ? st.status : 'no-st', errors: (st && st.errors) || [], st };
    if (!keep) A.PineUI.remove(pane, inst.id);
    return r;
  }
  const t1 = await add('TST226T', tf, true);
  out.tfStatus = t1.status; out.tfErrors = t1.errors;
  try {
    out.tfSec = t1.st.rt.env.tfSec;
    out.runBars = t1.st.rt.totalBars;
    out.chartBars = pane.bars.length;
    out.declTf = t1.st.adapter ? undefined : undefined;
  } catch (e) { out.tfErr = String(e); }
  A.PineUI.remove(pane, t1.inst.id);
  const d1 = await add('TST226D', dyn, true);
  out.dynStatus = d1.status; out.dynErrors = d1.errors;
  let dynVals = null;
  try {
    const key = d1.st.rt.out.plotsOrder[0];
    dynVals = d1.st.rt.out.plots.get(key).values.slice();
    out.dynN = dynVals.length;
  } catch (e) { out.dynErr = String(e); }
  A.PineUI.remove(pane, d1.inst.id);
  const s1 = await add('TST226S', stat, true);
  out.statStatus = s1.status;
  let statVals = null, closes = null;
  try {
    const key = s1.st.rt.out.plotsOrder[0];
    statVals = s1.st.rt.out.plots.get(key).values.slice();
    closes = pane.bars.map((b) => b.close);
  } catch (e) { out.statErr = String(e); }
  A.PineUI.remove(pane, s1.inst.id);
  try {
    let bad = 0, checked = 0;
    for (let i = 0; i < dynVals.length; i++) {
      const want = i % 2 === 0 ? closes[i] : statVals[i];
      if (want == null) continue;
      checked++;
      if (Math.abs(dynVals[i] - want) > 1e-9) { bad++; if (bad < 4) out['m' + bad] = [i, dynVals[i], want]; }
    }
    out.checked = checked; out.bad = bad;
  } catch (e) { out.cmpErr = String(e); }
  out.dynFetchLogs = A.Log.entries({ search: 'dynamic fetch' }).map((e) => e.msg);
  return out;
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
            r = page.evaluate(READ_JS, {'tf': SRC_TF, 'dyn': SRC_DYN, 'stat': SRC_STATIC})
            print('    sym0:', r.get('sym0'), 'tf:', r.get('tfStatus'), 'tfSec=', r.get('tfSec'), 'run=', r.get('runBars'), 'chart=', r.get('chartBars'))
            print('    dyn:', r.get('dynStatus'), 'checked=%s bad=%s' % (r.get('checked'), r.get('bad')), 'fetchLogs=', (r.get('dynFetchLogs') or [])[:1])
            check('decl timeframe engine ok', r['tfStatus'] == 'ok', r.get('tfErrors'))
            check('runtime runs daily buckets', r.get('tfSec') == 86400 and (r.get('runBars') or 0) < (r.get('chartBars') or 0), (r.get('tfSec'), r.get('runBars'), r.get('chartBars')))
            check('dynamic series-symbol ok', r['dynStatus'] == 'ok', r.get('dynErrors'))
            check('fixpoint fetch logged', any('GBPUSD' in str(m) for m in (r.get('dynFetchLogs') or [])), r.get('dynFetchLogs'))
            check('dynamic values == static mirror', (r.get('bad') or 0) == 0 and (r.get('checked') or 0) > 50, (r.get('checked'), r.get('bad')))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND226: %d failed' % len(FAILS) if FAILS else 'ROUND226: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
