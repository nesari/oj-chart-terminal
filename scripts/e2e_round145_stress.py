#!/usr/bin/env python3
"""ROUND145 stress — violent TF/style/layout/indicator churn, zero tolerance.

Reproduces the conditions of the original "Value is null" spam (rapid TF
hopping H4/H1/M15/…) on the instrumented build: every main-series write is
now guarded (caught + logged with context), so NOTHING may escape to
window.onerror anymore. Any page error fails the run.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8961, 8889
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if (not cond and extra != '') else ''))
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

CHURN_JS = """async () => {
  const A = window.__app;
  const pane = () => A.App.panes[0];
  const tfs = ['H4', 'H1', 'M15', 'M5', 'M1', 'H1', 'D1', 'H4', 'M30', 'H1'];
  for (const tf of tfs) {
    try { A.Manager.setTf(pane(), tf); } catch (e) {}
    await new Promise((r) => setTimeout(r, 700));
  }
  return pane().tf;
}"""

STYLE_JS = """async () => {
  const A = window.__app;
  const styles = ['line', 'area', 'heikin', 'renko', 'bars', 'candles', 'step', 'candles'];
  for (const s of styles) {
    try { A.Manager.setStyle(A.App.panes[0], s); } catch (e) {}
    await new Promise((r) => setTimeout(r, 600));
  }
  return A.App.panes[0].style;
}"""

IND_JS = """async () => {
  const A = window.__app;
  const out = [];
  try {
    const r1 = A.IndicatorsUI.add(A.App.panes[0], 'rsi');
    out.push(r1 && r1.id ? 'rsi' : 'rsi-fail');
    await new Promise((r) => setTimeout(r, 800));
    const res = await fetch('assets/pine-samples/sample-Supertrend.pine');
    const rec = A.PineScriptsStore.create('StressST', await res.text());
    A.PineUI.add(A.App.panes[0], rec.id);
    out.push('st');
    await new Promise((r) => setTimeout(r, 2500));
    try { A.Manager.setLayout('2v'); } catch (e) { out.push('layout-fail'); }
    await new Promise((r) => setTimeout(r, 1500));
    try { A.Manager.setLayout('1'); } catch (e) {}
    await new Promise((r) => setTimeout(r, 1200));
  } catch (e) { out.push('ERR:' + String(e).slice(0, 120)); }
  return out;
}"""

STATE_JS = """() => {
  const A = window.__app;
  const p = A.App.panes[0];
  return { tf: p.tf, style: p.style, bars: p.bars.length,
           pine: (p.pineScripts || []).length, ind: (p.indicators || []).length };
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
            page.on('pageerror', lambda e: errors.append(str(e)[:250]))
            page.on('console', lambda m: errors.append(m.text[:250]) if m.type == 'error' else None)
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100", timeout=25000)
            tf = page.evaluate(CHURN_JS)
            check('tf churn lands', tf == 'H1', tf)
            st = page.evaluate(STYLE_JS)
            check('style cycle lands', st == 'candles', st)
            ind = page.evaluate(IND_JS)
            check('indicator churn runs', 'rsi' in ind and 'st' in ind, ind)
            page.wait_for_timeout(2000)
            state = page.evaluate(STATE_JS)
            check('chart alive with data', state['bars'] > 100, state)
            check('zero page/console errors under churn', len(errors) == 0, errors[:5])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND145-stress: %d failed' % len(FAILS) if FAILS else 'ROUND145-stress: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
