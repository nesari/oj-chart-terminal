#!/usr/bin/env python3
"""ROUND 38 — left-toolbar batch-2 tools restoration.

ROOT CAUSE: drawing/tools2.js (34 batch-2 tools) was imported by NOBODY after
the phase-2 ES-module migration — its registrations never executed, so every
left-toolbar flyout listing those tools rendered EMPTY (user report: the Gann
group and the Risk/Reward group "have no icon and don't open at all").
FIX: one side-effect import in app.js. Nothing else touched.

This suite locks, on the demo provider:
  A. every group button gets a real icon + non-empty tooltip
  B. flyout row counts EXACT (gannelliott 14 in 3 TV sections r61, forecast 4, ...)
  C. end-to-end draw: Gann Box renders + factory defaults applied
  D. end-to-end draw: Long Position (Risk/Reward) renders + R:R afterFinish
  E. draw-settings dialog opens for both drawings without error
  F. zero page errors
"""
import sys, time, threading, http.server, functools, subprocess, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
PROV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'provider', 'demo.py')
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

BTN_JS = """(() => [...document.querySelectorAll('#left-toolbar .lt-btn[data-group]')]
  .map(b => ({ g: b.dataset.group, svg: !!b.querySelector('svg'),
               title: b.title, xbmp: (b.querySelector('svg')||{innerHTML:''}).innerHTML.includes('M6 6l12 12M18 6L6 18') })))()"""

FLY_JS = """(() => { const fl = document.querySelector('.lt-flyout'); if (!fl) return null;
  return { secs: [...fl.querySelectorAll('.lt-flysec')].map(s => s.textContent.trim()),
           names: [...fl.querySelectorAll('.tile-name')].map(n => n.textContent.trim()) }; })()"""

def open_flyout(page, gid):
    page.click(f'.lt-btn[data-group="{gid}"]')
    page.wait_for_timeout(200)
    return page.evaluate(FLY_JS)

def close_flyout(page):
    page.evaluate("() => window.__app.UI.closeFlyout && window.__app.UI.closeFlyout()")
    page.wait_for_timeout(100)

def draw_tool(page, pane_idx, fxys):
    """Dispatch mousedown/mouseup at fractional chart coords on a pane overlay."""
    return page.evaluate(f"""([idx, pts]) => new Promise((res) => {{
      const App = window.__app.App;
      const pane = App.panes[idx];
      const cv = pane.overlay;
      const r = cv.getBoundingClientRect();
      let i = 0;
      const fire = () => {{
        if (i >= pts.length) {{
          const list = App.drawings.list(pane.symbol) || [];
          const d = list[list.length - 1] || null;
          res(d ? {{ type: d.type, npts: d.points.length, opts: d.opts }} : null);
          return;
        }}
        const [fx, fy] = pts[i++];
        const x = r.x + r.width * fx, y = r.y + r.height * fy;
        cv.dispatchEvent(new MouseEvent('mousedown', {{ clientX: x, clientY: y, bubbles: true }}));
        cv.dispatchEvent(new MouseEvent('mouseup', {{ clientX: x, clientY: y, bubbles: true }}));
        setTimeout(fire, 80);
      }};
      setTimeout(fire, 120);
    }})""", [pane_idx, fxys])

def ink_pixels(page, pane_idx, x0f, x1f, y0f, y1f):
    """Count non-transparent overlay pixels inside a fractional region."""
    return page.evaluate(f"""([idx, a]) => {{
      const pane = window.__app.App.panes[idx];
      const cv = pane.overlay;
      const ctx = cv.getContext('2d');
      const r = cv.getBoundingClientRect();
      const x0 = Math.floor(r.width * a[0]), x1 = Math.ceil(r.width * a[1]);
      const y0 = Math.floor(r.height * a[2]), y1 = Math.ceil(r.height * a[3]);
      const img = ctx.getImageData(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      let n = 0;
      for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 8) n++;
      return n;
    }}""", [pane_idx, [x0f, x1f, y0f, y1f]])

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

    # ---------- A. buttons: icon + tooltip ----------
    btns = {b['g']: b for b in page.evaluate(BTN_JS)}
    check('A1 all 8 group buttons have an svg icon', len(btns) == 8 and all(b['svg'] for b in btns.values()), list(btns))
    check('A2 gannelliott tooltip = group label (pin updated r61: TV zigzag glyph)', btns['gannelliott']['title'] == 'Chart patterns, Elliott waves & cycles', btns['gannelliott']['title'])
    check('A3 forecast (Risk/Reward) tooltip = Long Position (was empty)', btns['forecast']['title'] == 'Long Position', btns['forecast']['title'])
    check('A4 no group button shows the X fallback icon', not any(b['xbmp'] for b in btns.values()))

    # ---------- B. flyout contents ----------
    # r61: the gannelliott flyout mirrors TradingView — 14 tools in three
    # TV-ordered sections (CHART PATTERNS 6 + ELLIOTT WAVES 5 + CYCLES 3);
    # the Gann section moved to the fibs flyout in r60
    f = open_flyout(page, 'gannelliott')
    check('B1 gannelliott flyout = 3 sections Chart Patterns/Elliott Waves/Cycles (pin updated r61)', f['secs'] == ['Chart Patterns', 'Elliott Waves', 'Cycles'], f['secs'])
    check('B2 gannelliott flyout lists 14 tools (Gann 4 live in fibs since r60)', len(f['names']) == 14, len(f['names']))
    pat6 = ['XABCD pattern', 'Cypher pattern', 'Head and shoulders', 'ABCD pattern', 'Triangle pattern', 'Three drives pattern']
    elliott5 = ['Elliott impulse wave (1-2-3-4-5)', 'Elliott correction wave (A-B-C)', 'Elliott triangle wave (A-B-C-D-E)', 'Elliott double combo wave (W-X-Y)', 'Elliott triple combo wave (W-X-Y-Z)']
    cyc3 = ['Cyclic lines', 'Time cycles', 'Sine line']
    check('B4 all 6 patterns + 5 Elliott + 3 Cycles present (exact TV names, pin updated r61)', f['names'] == pat6 + elliott5 + cyc3, f['names'])
    close_flyout(page)

    f = open_flyout(page, 'forecast')
    check('B5 Risk/Reward flyout lists exactly Long/Short Position + Regression + Vol Profile (was 0)',
          f['names'] == ['Long Position', 'Short Position', 'Regression Trend', 'Volume Profile'], f['names'])
    close_flyout(page)

    # r52: the lines flyout mirrors the TradingView reference — 18 tools in
    # three TV-ordered sections (LINES 10 + CHANNELS 4 + PITCHFORKS 4)
    expect = {'cursor': 3, 'lines': 18, 'fibs': 19, 'shapes': 13}  # r58: fibs = 11 FIBONACCI + 4 GANN + 4 PITCHFORKS
    for gid, n in expect.items():
        f = open_flyout(page, gid)
        check(f'B6 {gid} flyout lists {n} tools', f and len(f['names']) == n, f and f['names'])
        close_flyout(page)
    # measure / zoom are single-tool groups: click activates DIRECTLY (no flyout)
    for gid, name in [('measure', 'Measure'), ('zoom', 'Zoom In')]:
        page.click(f'.lt-btn[data-group="{gid}"]'); page.wait_for_timeout(200)
        f = page.evaluate(FLY_JS)
        b = {x['g']: x for x in page.evaluate(BTN_JS)}[gid]
        check(f'B7 {gid} activates directly, tooltip={name}', f is None and b['title'] == name, f and b['title'])
    page.evaluate("() => { window.__app.App.tool = 'cross'; window.__app.UI.refreshArmed(); }")
    page.wait_for_timeout(80)

    # ---------- C. draw a Gann Box end-to-end (r61: Gann lives in the fibs flyout) ----------
    page.click('.lt-btn[data-group="fibs"]'); page.wait_for_timeout(200)
    page.evaluate("""() => { const fl = document.querySelector('.lt-flyout');
      [...fl.querySelectorAll('.lt-tile')].find(t => /Gann Box/.test(t.textContent)).click(); }""")
    page.wait_for_timeout(150)
    check('C1 Gann Box armed (App.tool)', page.evaluate("() => window.__app.App.tool") == 'gannbox')
    d = draw_tool(page, 0, [[0.30, 0.35], [0.62, 0.62]])
    check('C2 drawing created type=gannbox 2 points', d and d['type'] == 'gannbox' and d['npts'] == 2, d)
    check('C3 factory defaults applied (diagColor #2962ff via registerFactoryOpts)', d and d['opts'].get('diagColor') == '#2962ff', d and d['opts'].get('diagColor'))
    ink = ink_pixels(page, 0, 0.30, 0.62, 0.35, 0.62)
    check('C4 Gann Box visible on overlay (ink pixels)', ink > 200, ink)
    sym = page.evaluate("() => window.__app.App.panes[0].symbol")
    setres = page.evaluate("""([sym]) => { try {
        const App = window.__app.App;
        const d = (App.drawings.list(sym) || []).find(x => x.type === 'gannbox');
        window.__app.DrawSettings.open(App.panes[0], d);
        return { ok: !!document.querySelector('.ds-dialog, .draw-settings, .dlg'), vis: true };
      } catch (e) { return { ok: false, err: String(e) }; } }""", [sym])
    check('C5 draw-settings opens for Gann Box without error', setres['ok'], setres)
    page.evaluate("() => { const el = document.querySelector('.ds-dialog, .draw-settings, .dlg .dlg-x'); if (el) { const x = document.querySelector('.ds-close, .dlg-x'); if (x) x.click(); } }")
    page.wait_for_timeout(120)
    page.evaluate("([s]) => window.__app.App.drawings.removeAll(s)", [sym])
    page.wait_for_timeout(120)

    # ---------- D. draw a Long Position (Risk/Reward) ----------
    page.click('.lt-btn[data-group="forecast"]'); page.wait_for_timeout(200)
    page.evaluate("""() => { const fl = document.querySelector('.lt-flyout');
      [...fl.querySelectorAll('.lt-tile')].find(t => /Long Position/.test(t.textContent)).click(); }""")
    page.wait_for_timeout(150)
    check('D1 Long Position armed (App.tool)', page.evaluate("() => window.__app.App.tool") == 'positionl')
    check('D2 button tooltip switched to Long Position', {b['g']: b for b in page.evaluate(BTN_JS)}['forecast']['title'] == 'Long Position')
    d = draw_tool(page, 0, [[0.35, 0.55], [0.68, 0.40]])
    check('D3 drawing created type=positionl 2 points', d and d['type'] == 'positionl' and d['npts'] == 2, d)
    tgt = d and d['opts'].get('target')
    check('D4 R:R afterFinish set a numeric target', isinstance(tgt, (int, float)), tgt)
    ink = ink_pixels(page, 0, 0.35, 0.68, 0.40, 0.55)
    check('D5 position box visible on overlay (ink pixels)', ink > 200, ink)
    setres = page.evaluate("""([sym]) => { try {
        const App = window.__app.App;
        const d = (App.drawings.list(sym) || []).find(x => x.type === 'positionl');
        window.__app.DrawSettings.open(App.panes[0], d);
        return { ok: true };
      } catch (e) { return { ok: false, err: String(e) }; } }""", [sym])
    check('D6 draw-settings opens for Long Position without error', setres['ok'], setres)
    page.evaluate("([s]) => { window.__app.App.drawings.removeAll(s); }", [sym])
    page.wait_for_timeout(120)
    check('D7 cleanup left no drawings', page.evaluate("([s]) => (window.__app.App.drawings.list(s) || []).length", [sym]) == 0)

    # ---------- F. health ----------
    check('F1 zero page errors', not errors, errors[:3])
    browser.close()

fails = [n for n, ok in results if not ok]
print(f'\nRESULT: {len(results) - len(fails)}/{len(results)} passed')
if fails:
    print('FAILED:', fails)
    sys.exit(1)
print('ROUND38 ALL GREEN')
