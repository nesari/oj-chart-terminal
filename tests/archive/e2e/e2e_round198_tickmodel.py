#!/usr/bin/env python3
"""ROUND198 e2e — tick model on the live app (fills-only vs recalc ticks).

  Two strategies (default calc_on_every_tick=false vs explicit true): a
  synthetic spiked forming bar is pushed through updateForming — the default
  one fills a working stop WITHOUT running its body (no TICK order), the
  explicit-true one places the TICK order. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8991, 8819
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

def SRC(flag):
    return ('//@version=5\nstrategy("TST198%s", overlay=true%s)\n'
            'if barstate.isconfirmed and bar_index == 0\n    strategy.entry("E", strategy.long, stop=5000)\n'
            'if close > 4000\n    strategy.entry("TICK", strategy.long)\n'
            'plot(close, title="p")\n') % (flag, ', calc_on_every_tick=true' if flag == 't' else '')

TICK_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const sts = A.PineUI.debug(pane);
  const st = sts.find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { status: st ? st.status : 'no-st', errors: (st && st.errors) || [] };
  if (!st || !st.rt) return out;
  // working stop from bar 0, then a synthetic spiked tick on the forming bar
  // (thresholds 4000/5000 are unreachable for live demo ticks)
  const br0 = st.rt.broker;
  out.prePending = (br0.pending || []).map((o) => o.id);
  const bars = pane.bars.map((b) => Object.assign({}, b));
  const last = bars.length - 1;
  bars[last] = Object.assign({}, bars[last], { high: 6000, close: 6000 });
  st.rt.updateForming(bars);
  const br = st.rt.broker;
  out.pending = (br.pending || []).map((o) => o.id);
  out.lots = (br.entries || []).map((e) => e.id + '@' + e.price);
  out.trades = (br.trades || []).length;
  out.plot = st.rt.out.plots.get(st.rt.out.plotsOrder[0]).values[last];
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
            d = page.evaluate(TICK_JS, {'name': 'TST198d', 'src': SRC('d')})
            t = page.evaluate(TICK_JS, {'name': 'TST198t', 'src': SRC('t')})
            print('    default:', d.get('status'), d.get('lots'), d.get('pending'), str(d.get('errors'))[:100])
            print('    true:   ', t.get('status'), t.get('lots'), t.get('pending'), str(t.get('errors'))[:100])
            check('default engine ok', d['status'] == 'ok', d.get('errors'))
            check('explicit engine ok', t['status'] == 'ok', t.get('errors'))
            check('default: E working before tick', 'E' in (d.get('prePending') or []), d.get('prePending'))
            check('default: tick fills E, no TICK order',
                  'E@5000' in (d.get('lots') or []) and 'TICK' not in (d.get('pending') or []) and 'TICK' not in (d.get('lots') or []),
                  (d.get('lots'), d.get('pending')))
            check('explicit: TICK placed on tick', 'TICK' in (t.get('pending') or []), t.get('pending'))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND198: %d failed' % len(FAILS) if FAILS else 'ROUND198: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
