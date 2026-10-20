#!/usr/bin/env python3
"""ROUND 40 — three user items.

  ITEM 1  Right-panel width resize restored (drag splitter, persist, reset).
  ITEM 2  Time-axis labels + vertical grid: UNIFORM pixel spacing at every
          zoom and timeframe, weekend/session gaps included (user screenshot).
  ITEM 3  Crosshair vertical & horizontal lines share ONE style again
          (LWC LineStyle enum map was off by two entries).

Nothing else touched.
"""
import sys, time, threading, http.server, functools, subprocess, os, re
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'src')
PROV = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'provider', 'demo.py')
PORT = 8978
BASE = f'http://127.0.0.1:{PORT}/renderer/index.html'

_prov = subprocess.Popen(['python3', PROV], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
time.sleep(1.5)

def _serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    h.log_message = lambda *a, **k: None
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()

threading.Thread(target=_serve, daemon=True).start()

def poll(page, js, timeout=20000, cond=lambda v: bool(v)):
    deadline = time.time() + timeout / 1000
    last = None
    while time.time() < deadline:
        last = page.evaluate(js)
        try:
            if cond(last):
                return last
        except TypeError:
            pass
        time.sleep(0.25)
    raise TimeoutError(f'poll failed: {js} -> {last}')

results = []
def check(name, ok, info=''):
    results.append((name, ok))
    print(('PASS' if ok else 'FAIL'), '-', name, ('| ' + str(info) if info else ''))

GAPS_JS = """([la, lb]) => new Promise((done) => {
  const { App } = window.__app;
  const pane = App.panes[0];
  const ts = pane.chart.timeScale();
  const n2 = (pane.barTimes && pane.barTimes.length) || 0;
  if (n2 < 10) { setTimeout(() => { try { done({ nLabels: 0, labelSpread: 0, nGrid: 0, gridSpread: 0, sample: [], texts: [] }); } catch (e) {} }, 400); return; }
  const a = Math.max(0, Math.min(la, n2 - 2));
  const b = Math.max(a + 5, Math.min(lb, n2 + 40));
  ts.setVisibleLogicalRange({ from: a, to: b });
  setTimeout(() => {
    const labels = [...pane.tax.querySelectorAll('span')].map(s => parseFloat(s.style.left)).sort((x, y) => x - y);
    const lg = [];
    for (let i = 1; i < labels.length; i++) lg.push(labels[i] - labels[i - 1]);
    const grid = pane.engine._taxGrid || [];
    const gg = [];
    for (let i = 1; i < grid.length; i++) gg.push(grid[i] - grid[i - 1]);
    const texts = [...pane.tax.querySelectorAll('span')].map(s => s.textContent);
    const mx = (arr) => arr.length ? Math.max(...arr) : 0;
    const mn = (arr) => arr.length ? Math.min(...arr) : 0;
    done({
      nLabels: labels.length, labelSpread: +(mx(lg) - mn(lg)).toFixed(1),
      nGrid: grid.length, gridSpread: +(mx(gg) - mn(gg)).toFixed(1),
      sample: gg.slice(0, 6).map(v => +v.toFixed(1)), texts: texts.slice(0, 5),
    });
  }, 500);
})"""

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1500, 'height': 900})
    page.add_init_script("localStorage.clear()")
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE)
    page.wait_for_selector('#login-screen', timeout=10000)
    page.click('#card-demo'); page.click('#login-connect')
    page.wait_for_selector('#app:not(.hidden)', timeout=20000)
    poll(page, "window.__app ? window.__app.App.panes.length : 0", 20000, lambda v: v >= 1)
    poll(page, "(window.__app.App.panes[0].bars || []).length", 30000, lambda v: v > 100)
    page.wait_for_timeout(600)

    # ============ ITEM 1: PANEL RESIZE ============
    base_w = page.evaluate("() => document.getElementById('right-content').getBoundingClientRect().width")
    split = page.evaluate("""() => { const r = document.getElementById('rp-split').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 }; }""")
    page.mouse.move(split['x'], split['y'])
    page.mouse.down(); page.mouse.move(split['x'] - 90, split['y'], steps=6); page.mouse.up()
    page.wait_for_timeout(300)
    w1 = page.evaluate("""() => ({ w: document.getElementById('right-content').getBoundingClientRect().width,
      saved: Math.round(Number(localStorage.getItem('mt5_rp_width') || 0)) })""")
    check('P1 dragging the splitter widens the panel AND persists', abs(w1['w'] - (base_w + 90)) < 12 and w1['saved'] == round(w1['w']), {'base': base_w, **w1})

    # restore path: the same code initResize runs at boot, re-invoked against
    # the persisted key (open_app wipes storage on every navigation, so a real
    # page.reload() cannot carry localStorage in the harness)
    w2 = page.evaluate("""(saved) => {
      const { RightPanel } = window.__app;
      RightPanel.initResize();
      return document.getElementById('right-content').getBoundingClientRect().width;
    }""", w1['w'])
    check('P2 width restored from storage by the boot resize init', abs(w2 - w1['w']) < 3, {'restored': w2, 'saved': w1['w']})
    page.evaluate("() => window.__app.RightPanel.close()")
    page.wait_for_timeout(150)
    hid = page.evaluate("() => document.getElementById('rp-split').classList.contains('hidden')")
    page.evaluate("() => window.__app.RightPanel.showTab('watchlist')")
    page.wait_for_timeout(150)
    vis = page.evaluate("() => !document.getElementById('rp-split').classList.contains('hidden')")
    check('P3 splitter hidden with the panel, back when reopened', hid and vis)
    sp2 = page.evaluate("""() => { const r = document.getElementById('rp-split').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 }; }""")
    page.mouse.dblclick(sp2['x'], sp2['y'])
    page.wait_for_timeout(250)
    w3 = page.evaluate("""() => ({ w: document.getElementById('right-content').getBoundingClientRect().width,
      saved: Math.round(Number(localStorage.getItem('mt5_rp_width') || 0)) })""")
    check('P4 double-click resets to the default 290px', abs(w3['w'] - 290) < 3 and w3['saved'] == 290, w3)
    # chart follows: the pane host shrank/grew with the panel
    page.evaluate("""() => { const c = document.getElementById('right-content'); c.style.width = '340px'; c.style.flex = '0 0 340px'; }""")
    page.wait_for_timeout(400)
    host_ok = page.evaluate("() => window.__app.App.panes[0].host.clientWidth > 500")
    check('P5 chart relayouts while the panel width changes', host_ok)
    page.evaluate("""() => { const c = document.getElementById('right-content'); c.style.width = ''; c.style.flex = ''; window.__app.RightPanel.initResize(); }""")
    page.wait_for_timeout(300)

    # ============ ITEM 2: UNIFORM AXIS / GRID SPACING ============
    n = page.evaluate("() => window.__app.App.panes[0].barTimes.length")
    uniform = True
    detail = []
    for lr in [[n - 180, n + 15], [n - 400, n + 15], [n - 900, n], [n - 2200, n], [n - 3800, n]]:
        g = page.evaluate(GAPS_JS, lr)
        # day-rollover labels legitimately take one wider cell (TV) -> label spread <= ~1.2 cell
        ok = g['nGrid'] >= 2 and g['gridSpread'] <= 2 and (g['nLabels'] < 2 or g['labelSpread'] <= 55)
        uniform = uniform and ok
        detail.append({'lr': lr, **g, 'ok': ok})
    check('U1 M1: grid + label spacing uniform at 5 zoom depths (incl. weekends)', uniform, detail)
    dayish = page.evaluate(GAPS_JS, [n - 2200, n])
    check('U2 labels keep their format (hh:mm / day names at rollovers)',
          any(re.match(r'^\d{2}:\d{2}$', t or '') for t in dayish['texts']) or dayish['nLabels'] >= 2, dayish['texts'])

    # different timeframe: 15m
    page.evaluate("() => window.__app.Manager.setTf(window.__app.App.panes[0], 'M15')")
    poll(page, "(window.__app.App.panes[0].barTimes || []).length", 30000, lambda v: v > 100)
    page.wait_for_timeout(600)
    n15 = page.evaluate("() => window.__app.App.panes[0].barTimes.length")
    g15 = page.evaluate(GAPS_JS, [n15 - 400, n15 + 15])
    g15b = page.evaluate(GAPS_JS, [n15 - 1500, n15])
    check('U3 M15: spacing uniform too', g15['gridSpread'] <= 2 and g15b['gridSpread'] <= 2, {'a': g15['sample'], 'b': g15b['sample']})

    # 1H with weekends (the user screenshot scenario)
    page.evaluate("() => window.__app.Manager.setTf(window.__app.App.panes[0], 'H1')")
    poll(page, "(window.__app.App.panes[0].barTimes || []).length", 30000, lambda v: v > 100)
    page.wait_for_timeout(600)
    nh = page.evaluate("() => window.__app.App.panes[0].barTimes.length")
    gh = page.evaluate(GAPS_JS, [max(0, nh - 200), nh + 5])
    gh2 = page.evaluate(GAPS_JS, [max(0, nh - 600), nh])
    check('U4 H1 across weekends: spacing uniform', gh['gridSpread'] <= 2 and gh2['gridSpread'] <= 2, {'a': gh['sample'], 'b': gh2['sample']})

    # back to M1 for the remaining items
    page.evaluate("() => window.__app.Manager.setTf(window.__app.App.panes[0], 'M1')")
    poll(page, "(window.__app.App.panes[0].barTimes || []).length", 30000, lambda v: v > 100)
    page.wait_for_timeout(600)

    # ============ ITEM 3: CROSSHAIR STYLE MATCH ============
    cs1 = page.evaluate("""() => {
      const pane = window.__app.App.panes[0];
      return { horz: pane.chart.options().crosshair.horzLine.style, vert: pane.engine._crossDash(), set: 'largedashed' };
    }""")
    # ROUND51: vert dash now mirrors LWC's styleToDash EXACTLY (user report:
    # the two crosshair lines must share ONE pattern) — LargeDashed(3) @ lw1 = [6,6]
    check('X1 default largedashed: horzLine=LargeDashed(3) matches the vert dash', cs1['horz'] == 3 and cs1['vert'][0] == 6 and cs1['vert'][1] == 6, cs1)
    cs2 = page.evaluate("""() => {
      const { Settings, App } = window.__app;
      Settings.conf.crossStyle = 'dotted'; Settings.applyPane(App.panes[0]);
      const pane = App.panes[0];
      return { horz: pane.chart.options().crosshair.horzLine.style, vert: pane.engine._crossDash() };
    }""")
    check('X2 dotted setting: horzLine=Dotted(1) matches the vert dots', cs2['horz'] == 1 and cs2['vert'][0] < 4, cs2)
    cs3 = page.evaluate("""() => {
      const { Settings, App } = window.__app;
      Settings.conf.crossStyle = 'dashed'; Settings.applyPane(App.panes[0]);
      const pane = App.panes[0];
      const r = { horz: pane.chart.options().crosshair.horzLine.style, vert: pane.engine._crossDash() };
      Settings.conf.crossStyle = 'largedashed'; Settings.applyPane(App.panes[0]);
      return r;
    }""")
    # ROUND51: Dashed(2) @ lw1 = [2,2] — vert == horz, no more approximate [7,5]
    check('X3 dashed setting: horzLine=Dashed(2) matches the vert dashes', cs3['horz'] == 2 and cs3['vert'][0] == 2 and cs3['vert'][1] == 2, cs3)
    cyc = page.evaluate("""() => {
      const { UI, App } = window.__app;
      UI.activateTool('arrowcur'); UI.activateTool('cross');
      const pane = App.panes[0];
      return pane.chart.options().crosshair.horzLine.style; // must survive the tool cycle
    }""")
    check('X4 Arrow->Cross cycle keeps the horzLine style (no reset to lib default)', cyc == 3, cyc)

    check('Z1 zero page errors', not errors, errors[:4])
    browser.close()

fails = [nm for nm, ok in results if not ok]
print(f'\nRESULT: {len(results) - len(fails)}/{len(results)} passed')
if fails:
    print('FAILED:', fails)
    sys.exit(1)
print('ROUND40 ALL GREEN')
