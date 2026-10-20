#!/usr/bin/env python3
"""Phase 2 E2E — ES Modules + JSDoc modularization:
  T1  window.* globals are GONE for every converted module (no leaks)
  T2  sanctioned window bridges intact (LightweightCharts vendor, __app facade)
  T3  __app facade completeness (all modules reachable for tests/debug)
  T4  cross-module wiring: Feed class, Manager hooks, snapshot palette, TZ
  T5  boot hygiene: zero console errors through demo login + first bars
"""
import sys, time, threading, http.server, functools, json, subprocess, signal, os

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
PROV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'provider', 'demo.py')
PORT = 8991
OUT = '/home/z/my-project/download'
os.makedirs(OUT, exist_ok=True)

prov = subprocess.Popen(['python3', PROV], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
time.sleep(1.5)

def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    h.log_message = lambda *a, **k: None
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start()
time.sleep(0.4)

results = []
def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(('PASS' if ok else 'FAIL'), name, '—', detail)

from playwright.sync_api import sync_playwright

CONVERTED = ['App','Manager','Toolbar','Snapshot','Log','AppErr','Diagnostics','Indicators','IndicatorsUI',
             'Watchlist','TimeSales','Alerts','DataWindow','ObjectTree','Replay','UI','Settings','DrawSettings',
             'Feed','TZ','Theme','Undo','Compare','LoginUI','RightPanel','TOOLS','Engine','U','ICONS','icon',
             'layoutIconSvg','FIB_LEVELS','CTX_LAYOUT','priceDigits']

with sync_playwright() as p:
    b = p.chromium.launch(args=['--window-size=1600,900'])
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    errors = []
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append('PAGEERROR: ' + str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1200)

    # ---- T1: no window.* globals from the module graph ----
    t1 = pg.evaluate("(names) => names.filter(n => window[n] !== undefined)", CONVERTED)
    check('T1 zero converted globals on window', len(t1) == 0, json.dumps(t1))

    # ---- T2: sanctioned bridges ----
    t2 = pg.evaluate("""() => ({
      lwc: !!window.LightweightCharts, facade: !!window.__app,
      logBridge: !!(window.electronAPI && window.electronAPI.logBatch) || 'headless-ok'
    })""")
    check('T2 vendor UMD + __app facade present', t2['lwc'] and t2['facade'], json.dumps(t2))

    # ---- T3: facade completeness ----
    t3 = pg.evaluate("""() => {
      const need = ['App','Manager','Toolbar','Snapshot','UI','Watchlist','Alerts','TimeSales','Replay',
        'Settings','ObjectTree','DataWindow','Diagnostics','Compare','IndicatorsUI','Indicators',
        'DrawSettings','Log','AppErr','TZ','Theme','Undo','Feed','U','icon','RightPanel'];
      const missing = need.filter(k => !window.__app[k]);
      return { n: Object.keys(window.__app).length, missing };
    }""")
    check('T3 __app exposes all 26 module facades', len(t3['missing']) == 0 and t3['n'] >= 26, json.dumps(t3))

    # login + wait for bars
    pg.click('#card-demo'); pg.click('#login-connect')
    pg.wait_for_timeout(9000)

    # ---- T4: cross-module wiring ----
    t4 = pg.evaluate("""() => {
      const A = window.__app;
      return {
        feedClass: A.App.feed instanceof A.Feed,
        feedImportable: typeof A.Feed === 'function',
        managerHooks: typeof A.Manager.recomputeIndicators === 'function'
                      && typeof A.Manager.tickIndicators === 'function'
                      && typeof A.Manager.updateIndicatorRows === 'function',
        palette: A.Manager.getSnapshotPalette('light').mode === 'light',
        tzFunnel: A.TZ.fullLabel(A.App.tz, Math.floor(Date.now() / 1000)).length > 8,
        indicatorsLive: A.App.activePane.indicators !== undefined,
        themeTh: A.Theme.th('chipBg', '#000').length > 3,
        rightpanel: typeof A.RightPanel.showTab === 'function'
      };
    }""")
    check('T4 wiring: feed/hooks/palette/tz/theme', all(t4.values()), json.dumps(t4))

    # ---- T5: boot hygiene ----
    check('T5 zero console errors (boot+login+bars)', len(errors) == 0, '; '.join(errors[:3]))
    pg.screenshot(path=os.path.join(OUT, 'phase2-esmodules.png'))

    b.close()

try:
    os.killpg(os.getpgid(prov.pid), signal.SIGTERM)
except Exception:
    pass

fails = [r for r in results if not r[1]]
print()
print('PHASE2 RESULT:', 'ALL PASS (%d checks)' % len(results) if not fails else '%d/%d FAILED' % (len(fails), len(results)))
sys.exit(1 if fails else 0)
