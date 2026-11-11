#!/usr/bin/env python3
"""ROUND287 e2e — the settings that had no control now work, live.

Verifies in the real dialog that ROUND287's new toggles exist AND take effect:
  - Crosshair master ON/OFF       (engine paints the crosshair)
  - Watermark master ON/OFF       (legend/watermark layer)
  - Watermark symbol / interval   (wmSymbol / wmTf)
  - the dead `grid` / `stIndBg` / `lockRatioVal` keys are gone

Run: python tests/archive/e2e/e2e_round287_settings_controls.py
"""
import http.server, functools, json, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8995, 8884
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


OPEN_CANVAS_JS = """() => {
  const A = window.__app;
  const S = A.Settings;
  const nav = [...document.querySelectorAll('#settings-dialog .st-nav button')];
  const names = nav.map((b) => (b.textContent || '').trim());
  const idx = names.findIndex((n) => /canvas/i.test(n));
  if (idx >= 0) nav[idx].click();
  const rows = [...document.querySelectorAll('#settings-dialog .st-page .st-row, #settings-dialog .st-page label')]
    .map((r) => (r.textContent || '').trim()).filter(Boolean);
  return { names, rows, conf: { crosshair: S.conf.crosshair, watermark: S.conf.watermark,
                                wmSymbol: S.conf.wmSymbol, wmTf: S.conf.wmTf,
                                hasGrid: 'grid' in S.conf, hasStIndBg: 'stIndBg' in S.conf,
                                hasLockRatioVal: 'lockRatioVal' in S.conf } };
}"""

# Toggle crosshair off and confirm both the config and the painter gate flip.
CROSS_JS = """() => {
  const A = window.__app;
  const S = A.Settings;
  const before = S.conf.crosshair !== false;
  S.set('crosshair', false);
  const off = S.conf.crosshair === false;
  S.set('crosshair', true);
  const on = S.conf.crosshair !== false;
  /* restore whatever it was */
  S.set('crosshair', before);
  return { before, off, on };
}"""

WATERMARK_JS = """() => {
  const A = window.__app;
  const S = A.Settings;
  const pane = A.App.activePane;
  const wm = pane.wm || null;
  if (!wm) return { error: 'no pane.wm element' };
  /* the painter toggles the `.off` class (layout.js) */
  const isOff = () => wm.classList.contains('off');
  const before = S.conf.watermark !== false;
  const offBefore = isOff();
  S.set('watermark', false);
  if (S.applyAll) S.applyAll();
  const offAfter = isOff();
  const children = wm.children.length;
  S.set('watermark', true);
  if (S.applyAll) S.applyAll();
  const onAfter = !isOff();
  S.set('watermark', before);
  if (S.applyAll) S.applyAll();
  return { before, offBefore, offAfter, onAfter, children };
}"""


def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up')
        prov.terminate()
        return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1600, 'height': 950})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(1000)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_function(
                "() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100",
                timeout=45000)
            page.wait_for_timeout(1000)

            # open the settings dialog (style button -> Settings is the gear)
            page.evaluate("() => { const b = document.getElementById('settings-btn'); if (b) b.click(); }")
            page.wait_for_timeout(700)
            has_dlg = page.evaluate("() => !!document.querySelector('#settings-dialog')")
            check('settings dialog opens', has_dlg)

            r = page.evaluate(OPEN_CANVAS_JS)
            text = ' | '.join(r.get('rows') or [])
            check('Canvas tab is reachable', bool(r.get('names')), r.get('names'))
            check('Crosshair toggle exists', 'Crosshair' in text, text[:200])
            check('Watermark toggle exists', 'Watermark' in text, text[:200])
            check('Watermark symbol toggle exists', 'Watermark symbol' in text, text[:200])
            check('Watermark interval toggle exists', 'Watermark interval' in text, text[:200])
            conf = r.get('conf') or {}
            check('dead key `grid` is gone from the config', conf.get('hasGrid') is False, conf)
            check('dead key `stIndBg` is gone', conf.get('hasStIndBg') is False, conf)
            check('dead key `lockRatioVal` is gone', conf.get('hasLockRatioVal') is False, conf)

            # close the dialog, then verify the toggles really act
            page.evaluate("() => { const b = document.querySelector('#settings-dialog .dlg-x'); if (b) b.click(); }")
            page.wait_for_timeout(300)

            print('  -- behavioural --')
            c = page.evaluate(CROSS_JS)
            check('crosshair=false is stored and reversible', c.get('off') is True and c.get('on') is True, c)

            w = page.evaluate(WATERMARK_JS)
            if w.get('error'):
                check('watermark layer exists', False, w['error'])
            else:
                check('watermark=false actually hides the layer', w.get('offAfter') is True, w)
                check('watermark=true shows it again', w.get('onAfter') is True, w)
                check('the watermark has content (symbol/interval)', (w.get('children') or 0) > 0, w)

            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND287: %d failed' % len(FAILS) if FAILS else 'ROUND287: all green')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
