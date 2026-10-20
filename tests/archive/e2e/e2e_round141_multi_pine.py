#!/usr/bin/env python3
"""ROUND141 e2e — two Pine scripts share one chart without erasing each other.

Regression test for the user report "adding another indicator (e.g. RSI)
wipes Supertrend's lines, some effects remain":

  root cause — every PineRenderAdapter began its paint with an unconditional
  clearRect on the pane's TWO shared host canvases, so the last painter of
  each frame won and sibling scripts vanished (legends + native series
  survived, hence "some effects remain").

  fix — generational clearing (one clear per full paint cycle, first painter
  only) + a pane-level forced full-set funnel for range events / settles.

Covers: ST overlay alone paints (>10k saturated px) -> adding a 2nd Pine
overlay keeps ST alive (no collapse to the ~1.6k single-line level) ->
zero page errors throughout.

A/B proof on this machine: pre-fix ST pixels 17158 -> 1593 after the 2nd
script; post-fix 17514 -> 18388 (both alive).
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8951, 8879
FAILS = []

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

ADD_ST_JS = """async () => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const res = await fetch('assets/pine-samples/sample-Supertrend.pine');
  const src = await res.text();
  const rec = A.PineScriptsStore.create('E2E-ST', src);
  A.PineUI.add(pane, rec.id);
  return rec.id;
}"""

ADD_LINE_JS = """() => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create('E2E-Line', 'indicator("E2ELine", overlay=true)\\nplot(close, title="C", color=color.red, linewidth=2)');
  A.PineUI.add(pane, rec.id);
  return rec.id;
}"""

COLORED_JS = """() => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const pc = pane._pineCanvases;
  if (!pc || !pc.fg || !pc.fg.width) return -1;
  const hostH = pane.host.clientHeight, mainH = pane._mainPlotH || hostH;
  const yMax = Math.floor(pc.fg.height * (mainH / hostH));
  const img = pc.fg.getContext('2d').getImageData(0, 0, pc.fg.width, yMax).data;
  let n = 0;
  for (let i = 0; i < img.length; i += 16) {
    if (img[i+3] < 40) continue;
    if (Math.max(img[i], img[i+1], img[i+2]) - Math.min(img[i], img[i+1], img[i+2]) > 30) n++;
  }
  return n;
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
            page.evaluate(ADD_ST_JS)
            page.wait_for_timeout(4000)
            c0 = page.evaluate(COLORED_JS)
            check('supertrend paints alone', c0 > 10000, c0)
            page.evaluate(ADD_LINE_JS)
            page.wait_for_timeout(3500)
            c1 = page.evaluate(COLORED_JS)
            n = page.evaluate("() => (window.__app.App.panes[0].pineScripts || []).length")
            check('two pine instances live', n == 2, n)
            check('second script does not erase the first', c1 >= max(10000, c0 * 0.8), f'{c0} -> {c1}')
            page.wait_for_timeout(1500)
            c2 = page.evaluate(COLORED_JS)
            check('overlay stable a cycle later', c2 >= max(10000, c0 * 0.8), f'{c0} -> {c2}')
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND141: %d failed' % len(FAILS) if FAILS else 'ROUND141: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
