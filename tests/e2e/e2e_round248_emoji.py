#!/usr/bin/env python3
"""ROUND248 e2e — Icons (emoji) tool, live.

  - toolbar has an icons group button; clicking arms the emoji tool
  - 1 click creates an emoji drawing (default glyph + size)
  - draw paints the glyph on a stub canvas; hit works at/around it
  - style dialog shows the 3-category grid; picking a glyph + size commits
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8934, 8874
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

GEO_JS = """(ch) => {
  const T = window.__app.DrawTools;
  const texts = [];
  const ctx = { beginPath(){}, stroke(){}, save(){}, restore(){}, closePath(){},
    setLineDash(){}, moveTo(){}, lineTo(){}, fillText(t){ texts.push(String(t)); } };
  const V = { ctx, xOf: (t) => t, yOf: (p) => p, w: 800, h: 600, pw: 800, ph: 600 };
  T.emoji.draw(V, { points: [{t:100,p:100}], opts: { ch, size: 24 } }, false);
  const hit = T.emoji.hitBody(V, { points: [{t:100,p:100}], opts: { ch, size: 24 } });
  return { texts, at: hit(100, 100), near: hit(110, 108), far: hit(300, 300) };
}"""

STATE_JS = """() => {
  const A = window.__app;
  const list = A.App.drawings.list(A.App.activePane.symbol);
  const d = list[list.length - 1];
  if (!d) return { tool: A.App.tool, n: 0, type: null, ch: null, size: null };
  return { tool: A.App.tool, n: list.length, type: d.type, ch: d.opts.ch, size: d.opts.size };
}"""

DLG_JS = """(want) => {
  const A = window.__app;
  const sym = A.App.activePane.symbol;
  const list = A.App.drawings.list(sym);
  const d = list[list.length - 1];
  A.DrawSettings.open(A.App.activePane, d);
  const dlg = document.querySelector('#draw-settings-dialog');
  const grid = dlg ? dlg.querySelectorAll('.ds-emoji-ch') : [];
  const secs = dlg ? dlg.querySelectorAll('.ds-emoji .ds-sec') : [];
  let picked = null;
  for (const b of grid) { if (b.dataset.ch === want) { b.click(); picked = b.dataset.ch; break; } }
  const num = dlg ? dlg.querySelector('.st-num') : null;
  if (num) { num.value = '48'; num.dispatchEvent(new Event('change', { bubbles: true })); }
  const after = { ch: d.opts.ch, size: d.opts.size };
  const x = dlg ? dlg.querySelector('.dlg-x') : null;
  if (x) x.click();
  return { n: grid.length, cats: secs.length, picked, after };
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
            page = browser.new_page(viewport={'width': 1560, 'height': 1020})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100", timeout=25000)
            page.wait_for_function("() => window.__app.DrawTools && window.__app.DrawTools.emoji", timeout=15000)
            g = page.evaluate(GEO_JS, '\U0001F680')
            print('    geo:', g)
            check('draw paints the glyph', g.get('texts') == ['\U0001F680'], g)
            check('hit at/near, miss far',
                  g.get('at') is True and g.get('near') is True and g.get('far') is False, g)
            page.click('#left-toolbar .lt-btn[data-group="icons"]')
            page.wait_for_timeout(300)
            check('toolbar button arms emoji',
                  page.evaluate("() => window.__app.App.tool") == 'emoji', None)
            r = page.evaluate("() => { const r = document.querySelector('.pane-root').getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; }")
            n0 = page.evaluate(STATE_JS)['n']
            page.mouse.click(r['x'] + r['w'] * 0.4, r['y'] + r['h'] * 0.4)
            page.wait_for_timeout(300)
            s = page.evaluate(STATE_JS)
            print('    created:', s)
            check('1 click creates emoji with defaults',
                  s['n'] == n0 + 1 and s['type'] == 'emoji' and s['ch'] == '\U0001F44D' and s['size'] == 24, s)
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)
            d = page.evaluate(DLG_JS, '\U0001F680')
            print('    dialog:', d)
            check('grid has 60 glyphs in 3 categories', d['n'] == 60 and d['cats'] == 3, d)
            check('pick + size commit live',
                  d['picked'] == '\U0001F680' and d['after']['ch'] == '\U0001F680' and d['after']['size'] == 48, d)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND248: %d failed' % len(FAILS) if FAILS else 'ROUND248: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
