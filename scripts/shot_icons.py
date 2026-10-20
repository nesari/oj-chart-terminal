#!/usr/bin/env python3
"""Shot all drawing-tool icons (dark + light) for visual review."""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8939, 8879

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

SHEET_JS = """() => {
  const A = window.__app;
  const host = document.createElement('div');
  host.id = 'icon-sheet';
  const h2 = document.createElement('h2');
  const seen = {};
  const ids = [];
  for (const g of A.UI.GROUPS) {
    for (const tid of A.UI.toolsOf(g)) {
      if (!seen[tid]) { seen[tid] = 1; ids.push(tid); }
    }
  }
  const FOCUS = ['pitchfan', 'disjoint', 'elliott_i', 'elliott_c', 'elliott_t', 'elliott_wxy', 'elliott_wxyxz',
    'sineline', 'avwap', 'posforecast', 'positionl', 'positions', 'brush', 'fibchannel', 'pitchfork',
    'timecycles', 'fibwedge', 'fibttime'];
  const show = ids.filter((id) => FOCUS.indexOf(id) >= 0);
  h2.textContent = 'icons: ' + show.length + ' (focus)';
  host.appendChild(h2);
  const table = document.createElement('table');
  let tr = null;
  show.forEach((tid, i) => {
    if (i % 8 === 0) { tr = document.createElement('tr'); table.appendChild(tr); }
    const td = document.createElement('td');
    const def = A.DrawTools[tid] || {};
    const wrap = document.createElement('div');
    wrap.innerHTML = A.icon(def.icon || 'x');
    const svg = wrap.querySelector('svg');
    if (svg) { svg.setAttribute('width', '52'); svg.setAttribute('height', '52'); }
    td.appendChild(wrap);
    const lab = document.createElement('div');
    lab.textContent = tid;
    td.appendChild(lab);
    tr.appendChild(td);
  });
  host.appendChild(table);
  document.body.appendChild(host);
  return show.length;
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
            page = browser.new_page(viewport={'width': 1100, 'height': 900})
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_function("() => window.__app && window.__app.DrawTools && window.__app.DrawTools.emoji", timeout=25000)
            n = page.evaluate(SHEET_JS)
            print('icons:', n)
            info = page.evaluate("() => { const h = document.querySelector('#icon-sheet'); const t = h.querySelectorAll('div')[3]; const svg = h.querySelector('svg'); const r = svg ? svg.getBoundingClientRect() : null; return { tile: t ? t.outerHTML.slice(0, 400) : null, svgBox: r ? [r.width, r.height, r.x, r.y] : null, nsvg: h.querySelectorAll('svg').length }; }")
            print('sheet:', info)
            page.locator('#icon-sheet').screenshot(path=os.path.join(ROOT, 'scripts', 'shot_icons_dark.png'))
            page.screenshot(path=os.path.join(ROOT, 'scripts', 'shot_page_dark.png'))
            page.evaluate("() => document.body.classList.add('theme-light')")
            page.wait_for_timeout(300)
            page.locator('#icon-sheet').screenshot(path=os.path.join(ROOT, 'scripts', 'shot_icons_light.png'))
            browser.close()
    finally:
        prov.terminate()
    return 0

if __name__ == '__main__':
    sys.exit(main())
