#!/usr/bin/env python3
"""ROUND146 e2e — lower-TF MTF: H1 chart + Supertrend@M15 on the live app.

Asserts the script executes in the LOWER frame (env.tfSec), output maps
to chart length, the canvas paints, and the page stays error-free.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8959, 8887
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

SETUP_JS = """async () => {
  const A = window.__app;
  const pane = A.App.panes[0];
  A.Manager.setTf(pane, 'H1');
  await new Promise((r) => {
    const iv = setInterval(() => {
      if (pane.tf === 'H1' && pane.bars.length > 100 && !pane.loading) { clearInterval(iv); r(); }
    }, 300);
    setTimeout(() => { clearInterval(iv); r(); }, 25000);
  });
  const res = await fetch('assets/pine-samples/sample-Supertrend.pine');
  const rec = A.PineScriptsStore.create('E2E146', await res.text());
  const inst = A.PineUI.add(pane, rec.id);
  inst.timeframe = 'M15';
  A.Manager.recomputePine(pane);
  return { tf: pane.tf, bars: pane.bars.length };
}"""

PROBE_JS = """() => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const st = A.PineUI.debug(pane)[0];
  if (!st || !st.rt) return { err: 'no rt', status: st && st.status };
  const rt = st.rt;
  const out = rt.viewOut || rt.out;
  const n = pane.bars.length;
  const key = out.plotsOrder[0];
  const p = out.plots.get(key);
  const p2 = out.plotsOrder.length > 1 ? out.plots.get(out.plotsOrder[1]) : null;
  // supertrend up/dn are complementary linebr halves (each na half the
  // time) — coverage = union, immune to trend mix
  let finite = 0;
  for (let i = 0; i < n; i++) {
    if ((p.values[i] != null && isFinite(p.values[i])) ||
        (p2 && p2.values[i] != null && isFinite(p2.values[i]))) finite++;
  }
  const pc = pane._pineCanvases;
  const img = pc.fg.getContext('2d').getImageData(0, 0, pc.fg.width, pc.fg.height).data;
  let px = 0;
  for (let i = 0; i < img.length; i += 16) {
    if (img[i+3] < 40) continue;
    if (Math.max(img[i], img[i+1], img[i+2]) - Math.min(img[i], img[i+1], img[i+2]) > 30) px++;
  }
  return { status: st.status, tfSec: rt.env.tfSec, n, plotLen: p.values.length,
           finite, px, cache: !!(pane._mtfLower && pane._mtfLower.bars.length),
           cacheN: pane._mtfLower ? pane._mtfLower.bars.length : 0 };
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
            s = page.evaluate(SETUP_JS)
            print('setup:', s)
            page.wait_for_timeout(6000)
            m = page.evaluate(PROBE_JS)
            check('lower run has no engine error', m.get('status') == 'ok', m)
            check('lower frame active (M15 env)', m.get('tfSec') == 900, m)
            check('lower history cached', m.get('cache') is True and m.get('cacheN', 0) > 1000, m)
            check('output remapped to chart length', m.get('plotLen') == m.get('n'), m)
            check('recent bars have values (warmup+window)', m.get('finite', 0) > m.get('n', 0) * 0.5, m)
            check('lower paints on canvas', m.get('px', 0) > 2000, m)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND146: %d failed' % len(FAILS) if FAILS else 'ROUND146: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
