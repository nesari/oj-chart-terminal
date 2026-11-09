#!/usr/bin/env python3
"""ROUND167 e2e — plot-style menu + price line on the live app.

  PSAR script (style=cross): Style tab shows the plot-style select (11 TV
  options) + Price line checkbox; switching Cross -> Line + Price line on
  + Ok rebuilds with p.style=='line', trackprice on, pixels still painted,
  zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8965, 8893
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

PSAR_SRC = ('//@version=6\nindicator(title="Parabolic SAR", shorttitle="SAR", overlay=true, timeframe="", timeframe_gaps=true)\n'
            'start = input(0.02)\nincrement = input(0.02)\nmaximum = input(0.2, "Max value")\n'
            'out = ta.sar(start, increment, maximum)\nplot(out, "ParabolicSAR", style=plot.style_cross, color=#2962FF)\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  return { instId: inst.id };
}"""

WAIT_OK_JS = """(instId) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
  return !!st && st.status === 'ok';
}"""

OPEN_DLG_JS = """(instId) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const inst = (pane.pineScripts || []).find((i) => i.id === instId);
  if (!inst) return { opened: false };
  A.PineUI.openSettingsDialog(pane, inst);
  return { opened: true };
}"""

ROW_JS = """() => {
  const rows = [...document.querySelectorAll('.ind-settings .pine-style-row')];
  const row = rows.find((r) => (r.querySelector('.pine-style-name') || {}).textContent === 'ParabolicSAR');
  if (!row) return { found: false, n: rows.length };
  const sels = [...row.querySelectorAll('select')].map((s) => ({ title: s.title, value: s.value, n: s.options.length,
    opts: [...s.options].map((o) => o.value) }));
  const pl = row.querySelector('.pine-style-pl input');
  return { found: true, sels, hasPrice: !!pl, priceChecked: pl ? pl.checked : null };
}"""

AFTER_JS = """(instId) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
  let style = null, track = null;
  if (st && st.rt && st.rt.out) {
    const key = st.rt.out.plotsOrder && st.rt.out.plotsOrder[0];
    const p = key != null ? st.rt.out.plots.get(key) : null;
    if (p) { style = p.style; track = !!p.trackprice; }
  }
  return { status: st ? st.status : 'no-st', style, track,
    dlgOpen: !document.getElementById('popup-layer').classList.contains('hidden') };
}"""

PIX_JS = """() => {
  const pane = window.__app.App.panes[0];
  const cv = [...pane.host.querySelectorAll('canvas')];
  if (!cv.length) return -1;
  let n = 0;
  for (const c of cv) {
    if (!c.width) continue;
    let img;
    try { img = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; } catch (e) { continue; }
    const step = Math.max(4, ((c.width * c.height) / 400000) * 4 | 0);
    for (let i = 0; i < img.length; i += step) {
      if (img[i + 3] < 40) continue;
      if (img[i + 2] > 180 && img[i + 2] > img[i] + 60 && img[i + 2] > img[i + 1] + 60) n++;
    }
  }
  return n;
}"""

def wait_ok(page, instId, timeout=60):
    try:
        page.wait_for_function(WAIT_OK_JS, arg=instId, timeout=timeout * 1000)
        return True
    except Exception:
        return False

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
            r = page.evaluate(ADD_JS, {'name': 'PSAR167', 'src': PSAR_SRC})
            check('psar engine ok', wait_ok(page, r['instId']))
            page.evaluate(OPEN_DLG_JS, r['instId'])
            page.wait_for_timeout(700)
            page.click('.ind-settings .pine-tab[data-tab="style"]')
            page.wait_for_timeout(500)
            w = page.evaluate(ROW_JS)
            check('parabolicsar style row', w.get('found') is True, w)
            ysel = [s for s in (w.get('sels') or []) if s.get('title') == 'Plot style']
            check('plot-style select with 11 options', len(ysel) == 1 and ysel[0]['n'] == 11, ysel)
            check('select starts on Cross', ysel and ysel[0]['value'] == 'cross', ysel)
            check('price line checkbox present, off', w.get('hasPrice') is True and w.get('priceChecked') is False, w)
            # TV path: Cross -> Line + Price line on, then Ok (rebuild)
            page.select_option('.ind-settings .pine-style-row:has-text("ParabolicSAR") select[title="Plot style"]', 'line')
            page.wait_for_timeout(200)
            page.check('.ind-settings .pine-style-row:has-text("ParabolicSAR") .pine-style-pl input')
            page.wait_for_timeout(200)
            page.click('.ind-settings .ist-ok')
            page.wait_for_timeout(2500)
            a = page.evaluate(AFTER_JS, r['instId'])
            check('dialog closed after Ok', a.get('dlgOpen') is False, a.get('dlgOpen'))
            check('engine ok after style switch', a.get('status') == 'ok', a.get('status'))
            check('engine style flipped to line', a.get('style') == 'line', a.get('style'))
            check('trackprice on', a.get('track') is True, a.get('track'))
            px = page.evaluate(PIX_JS)
            check('line-styled psar still paints', (px or 0) > 300, px)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND167: %d failed' % len(FAILS) if FAILS else 'ROUND167: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
