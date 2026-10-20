#!/usr/bin/env python3
"""ROUND166 e2e — PSAR paints + Style-tab sweep on the live app.

  [PSAR] the user's exact script: engine ok + blue cross pixels on canvas
         (was: ta.sar all-na -> blank chart, no error);
  [BOX]  magenta box script: red-flag pixel count >0, then Style tab ->
         uncheck Boxes -> Ok -> magenta gone (graphic-object master toggle);
  [STYLE] SMC dialog Style tab rows: PlotCandle row, Graphic objects
         (Boxes/Lines/Pane labels), Input values; legend shows an input
         value ('Historical'); zero page errors throughout.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP, PORT_WS = 8963, 8891
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

BOX_SRC = ('//@version=5\nindicator("boxtest166", overlay=true)\n'
           'if barstate.islast\n'
           '    box.new(bar_index - 60, close + 5, bar_index, close - 5, border_color=color.new(#FF00FF, 0), bgcolor=color.new(#FF00FF, 0))\n'
           'plot(close, title="c")\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  return { instId: inst.id };
}"""

STATUS_JS = """(instId) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
  return { status: st ? st.status : 'no-st', errors: (st && st.errors) || [] };
}"""

WAIT_OK_JS = """(instId) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
  return !!st && st.status === 'ok';
}"""

PIX_JS = """(kind) => {
  const pane = window.__app.App.panes[0];
  const cv = [...pane.host.querySelectorAll('canvas')];
  if (kind === 'magenta') {
    // box paint lives on the pine fg canvas only
    const pc = pane._pineCanvases;
    if (!pc || !pc.fg || !pc.fg.width) return -1;
    cv.length = 0; cv.push(pc.fg);
  }
  if (!cv.length) return -1;
  let n = 0;
  for (const c of cv) {
    if (!c.width) continue;
    let img;
    try { img = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; } catch (e) { continue; }
    const step = Math.max(4, ((c.width * c.height) / 400000) * 4 | 0);
    for (let i = 0; i < img.length; i += step) {
      const r = img[i], g = img[i + 1], b = img[i + 2], a = img[i + 3];
      if (a < 40) continue;
      // ROUND166: native LWC point markers (plot circles/cross) paint on the
      // chart canvas, not the pine fg canvas — scan every pane canvas.
      if (kind === 'blue') { if (b > 180 && b > r + 60 && b > g + 60) n++; }
      else if (kind === 'magenta') { if (r > 200 && b > 200 && g < 110) n++; }
    }
  }
  return n;
}"""

OPEN_DLG_JS = """(instId) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const inst = (pane.pineScripts || []).find((i) => i.id === instId);
  if (!inst) return { opened: false };
  A.PineUI.openSettingsDialog(pane, inst);
  return { opened: true };
}"""

STYLE_ROWS_JS = """() => {
  const rows = [...document.querySelectorAll('.ind-settings .pine-style-row .pine-style-name')].map((e) => e.textContent);
  const checks = [...document.querySelectorAll('.ind-settings label.pine-inp.pine-check span')].map((e) => e.textContent);
  const secs = [...document.querySelectorAll('.ind-settings .ist-sec')].map((e) => e.textContent);
  return { rows, checks, secs };
}"""

LEGEND_JS = """(instId) => {
  const row = document.querySelector('.ind-row[data-pine="' + instId + '"] .ind-vals');
  return row ? row.textContent : null;
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
            # --- PSAR ---
            r = page.evaluate(ADD_JS, {'name': 'PSAR166', 'src': PSAR_SRC})
            check('psar engine ok', wait_ok(page, r['instId']), page.evaluate(STATUS_JS, r['instId']))
            page.wait_for_timeout(1500)
            nblue = page.evaluate(PIX_JS, 'blue')
            check('psar blue crosses paint pixels', (nblue or 0) > 300, nblue)
            # --- magenta box on/off ---
            r2 = page.evaluate(ADD_JS, {'name': 'BOX166', 'src': BOX_SRC})
            check('box engine ok', wait_ok(page, r2['instId']), page.evaluate(STATUS_JS, r2['instId']))
            page.wait_for_timeout(1500)
            nmag0 = page.evaluate(PIX_JS, 'magenta')
            check('magenta box paints', (nmag0 or 0) > 2000, nmag0)
            page.evaluate(OPEN_DLG_JS, r2['instId'])
            page.wait_for_timeout(600)
            page.click('.ind-settings .pine-tab[data-tab="style"]')
            page.wait_for_timeout(400)
            page.uncheck('.ind-settings label.pine-inp:has-text("Boxes") input')
            page.wait_for_timeout(300)
            page.click('.ind-settings .ist-ok')
            nmag1 = nmag0
            for _ in range(8):
                page.wait_for_timeout(2000)
                nmag1 = page.evaluate(PIX_JS, 'magenta')
                if (nmag1 or 0) < 100:
                    break
            check('boxes-off hides the box', (nmag1 or 0) < 100, nmag1)
            # --- SMC style rows + inputs legend ---
            with open(os.path.join(ROOT, 'scripts', 'pine-fixtures', 'corpus', 'smartmoney.pine'), encoding='utf-8') as fh:
                smc = fh.read()
            r3 = page.evaluate(ADD_JS, {'name': 'SMC166', 'src': smc})
            check('smc engine ok', wait_ok(page, r3['instId'], timeout=90), page.evaluate(STATUS_JS, r3['instId']))
            page.evaluate(OPEN_DLG_JS, r3['instId'])
            page.wait_for_timeout(700)
            page.click('.ind-settings .pine-tab[data-tab="style"]')
            page.wait_for_timeout(500)
            s = page.evaluate(STYLE_ROWS_JS)
            check('plotcandle style row', 'PlotCandle' in (s.get('rows') or []), s.get('rows'))
            check('graphic objects section', 'Graphic objects' in (s.get('secs') or []), s.get('secs'))
            for want in ('Boxes', 'Lines', 'Pane labels'):
                check('toggle ' + want, want in (s.get('checks') or []), s.get('checks'))
            check('input values section', 'Input values' in (s.get('secs') or []), s.get('secs'))
            check('inputs-in-status-line check', 'Inputs in status line' in (s.get('checks') or []), s.get('checks'))
            page.keyboard.press('Escape')
            page.wait_for_timeout(400)
            leg = page.evaluate(LEGEND_JS, r3['instId'])
            check('legend shows input values', leg is not None and 'Historical' in leg, (leg or '')[:160])
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND166: %d failed' % len(FAILS) if FAILS else 'ROUND166: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
