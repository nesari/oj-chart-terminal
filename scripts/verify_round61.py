#!/usr/bin/env python3
"""ROUND 61 verify — the Gann & Elliott flyout now mirrors the TradingView
reference screenshot EXACTLY (user request):
- three labelled sections CHART PATTERNS / ELLIOTT WAVES / CYCLES in exact TV order
- all 11 pattern/Elliott tools renamed to the EXACT TV flyout text (ids/engines kept)
- 3 NEW researched Cycles tools: Cyclic lines (2 anchors, repeat interval,
  Coeff/Cycles/Extend settings), Time cycles (3 anchors, boundary+middle lines,
  repeating cycle), Sine line (2 anchors, sine wave on the A->B trend, Coeff/
  Extend/Trend-line settings) — each draws end-to-end with factory defaults and
  opens its Settings dialog
- nothing lost: the 4 Gann tools still live in the fibs flyout GANN section
- toolbar glyph = TV zigzag; every flyout row has a drawn icon
- dark + light, zero page errors"""
import os, sys, json, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_helper_round32 import open_app, poll  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, '..', '..', 'work', 'shots61-verify')
os.makedirs(OUT, exist_ok=True)

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  | ' + str(detail)[:200] if detail != '' else ''))

TV_SECS = ['Chart Patterns', 'Elliott Waves', 'Cycles']
TV_ORDER = [
    'XABCD pattern', 'Cypher pattern', 'Head and shoulders', 'ABCD pattern', 'Triangle pattern', 'Three drives pattern',
    'Elliott impulse wave (1-2-3-4-5)', 'Elliott correction wave (A-B-C)', 'Elliott triangle wave (A-B-C-D-E)',
    'Elliott double combo wave (W-X-Y)', 'Elliott triple combo wave (W-X-Y-Z)',
    'Cyclic lines', 'Time cycles', 'Sine line',
]
NEW2 = {'cycliclines': 2, 'sineline': 2}
NEW3 = {'timecycles': 3}

# ---------- static ----------
tools2_src = open(os.path.join(ROOT, 'src/renderer/js/drawing/tools2.js'), encoding='utf-8').read()
set_src = open(os.path.join(ROOT, 'src/renderer/js/drawing/settings.js'), encoding='utf-8').read()
ui_src = open(os.path.join(ROOT, 'src/renderer/js/drawing/ui.js'), encoding='utf-8').read()
icons_src = open(os.path.join(ROOT, 'src/renderer/js/ui/icons.js'), encoding='utf-8').read()
pkg = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))

check('static: version 1.9.12', pkg.get('version') == '1.9.12', pkg.get('version'))
for tid in list(NEW2) + list(NEW3):
    nm = {'cycliclines': 'Cyclic lines', 'timecycles': 'Time cycles', 'sineline': 'Sine line'}[tid]
    check(f'static: TOOLS.{tid} registered', f'TOOLS.{tid} = {{' in tools2_src and f"name: '{nm}'" in tools2_src)
TV_NAMES = ['Elliott impulse wave (1-2-3-4-5)', 'Elliott correction wave (A-B-C)', 'Elliott triangle wave (A-B-C-D-E)',
            'Elliott double combo wave (W-X-Y)', 'Elliott triple combo wave (W-X-Y-Z)',
            'XABCD pattern', 'ABCD pattern', 'Cypher pattern', 'Triangle pattern', 'Three drives pattern', 'Head and shoulders']
check('static: all 11 pattern/Elliott names = exact TV text', all(f"'{n}'" in tools2_src for n in TV_NAMES))
check('static: old names gone', not any(n in tools2_src for n in ['Elliott Impulse (12345)', 'XABCD Pattern', 'Three Drives Pattern', 'Head and Shoulders Pattern', 'Cypher Pattern']))
check('static: 3 cycles schemas added', all(f'{tid}: [' in set_src for tid in ['cycliclines', 'timecycles', 'sineline']))
check('static: cycliclines Coeff/Cycles/Extend settings', "key: 'coeff'" in set_src and "key: 'cycles'" in set_src and "key: 'extendLeft'" in set_src and "key: 'extendRight'" in set_src)
check('static: sineline Extend select + Trend line', "key: 'extend'" in set_src and "key: 'showTrend'" in set_src)
check('static: factory defaults for 3 cycles tools', all(f'{tid}: Object.assign' in tools2_src for tid in ['cycliclines', 'timecycles', 'sineline']))
check('static: 4 new icons present', all(f'{i}:' in icons_src for i in ['cycliclines', 'timecycles', 'sineline', 'patwaves']))
check('static: gannelliott = 3 TV sections exact order', "{ title: 'Chart Patterns', tools: ['xabcd', 'cypher', 'hs', 'abcd', 'trianglepat', 'threedrives'] }" in ui_src and "{ title: 'Elliott Waves', tools: ['elliott_i', 'elliott_c', 'elliott_t', 'elliott_wxy', 'elliott_wxyxz'] }" in ui_src and "{ title: 'Cycles', tools: ['cycliclines', 'timecycles', 'sineline'] }" in ui_src)
check('static: toolbar glyph = TV zigzag (patwaves)', "base: 'patwaves'" in ui_src)
check('static: tooltip fallback for glyph-only groups', 'GROUP_TITLE' in ui_src and 'Chart patterns, Elliott waves' in ui_src)
check('static: NOTHING LOST — Gann section still in fibs flyout', "{ title: 'Gann', tools: ['gannbox', 'gannsquaref', 'gannsquare', 'gannfan'] }" in ui_src)
check('static: fibs Fibonacci/Pitchforks sections untouched', "{ title: 'Fibonacci', tools: ['fib', 'fibext', 'fibchannel', 'fibtz', 'fibspeedfan', 'fibttime', 'fibcircles', 'fibspiral', 'fibarcs', 'fibwedge', 'pitchfan'] }" in ui_src and "{ title: 'Pitchforks', tools: ['pitchfork', 'pitchfork_s', 'pitchfork_ms', 'pitchfork_i'] }" in ui_src)

for f in ['src/renderer/js/drawing/tools2.js', 'src/renderer/js/drawing/settings.js', 'src/renderer/js/drawing/ui.js', 'src/renderer/js/ui/icons.js']:
    r = subprocess.run(['node', '--check', os.path.join(ROOT, f)], capture_output=True, text=True)
    check(f'static: node --check {os.path.basename(f)}', r.returncode == 0, r.stderr[:150])

FLY_JS = """(() => { const fl = document.querySelector('.lt-flyout'); if (!fl) return null;
  return { secs: [...fl.querySelectorAll('.lt-flysec')].map(s => s.textContent.trim()),
           names: [...fl.querySelectorAll('.tile-name')].map(n => n.textContent.trim()),
           emptyIcons: [...fl.querySelectorAll('.lt-tile .tile-ic')].filter(ic => !ic.querySelector('svg path, svg circle, svg rect, svg ellipse')).length }; })()"""

INK_JS = """() => { const pane = window.__app.App.panes[0]; const cv = pane.overlay;
  const ctx = cv.getContext('2d'); const img = ctx.getImageData(0, 0, cv.width, cv.height);
  let n = 0; for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 8) n++; return n; }"""

def draw_tool(page, pane_idx, fxys):
    return page.evaluate("""([idx, pts]) => new Promise((res) => {
      const App = window.__app.App;
      const pane = App.panes[idx];
      const cv = pane.overlay;
      const r = cv.getBoundingClientRect();
      let i = 0;
      const fire = () => {
        if (i >= pts.length) {
          const list = App.drawings.list(pane.symbol) || [];
          const d = list[list.length - 1] || null;
          res(d ? { type: d.type, npts: d.points.length, opts: d.opts } : null);
          return;
        }
        const [fx, fy] = pts[i++];
        const x = r.x + r.width * fx, y = r.y + r.height * fy;
        cv.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
        cv.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
        setTimeout(fire, 80);
      };
      setTimeout(fire, 120);
    })""", [pane_idx, fxys])

DRAW_PTS = {
    'cycliclines': [[0.20, 0.30], [0.40, 0.62]],
    'timecycles': [[0.18, 0.35], [0.32, 0.50], [0.46, 0.35]],
    'sineline': [[0.22, 0.62], [0.50, 0.35]],
}

with sync_playwright() as pw:
    browser, page = open_app(pw)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.wait_for_timeout(500)

    # ---------- A. gannelliott flyout: sections + exact TV order ----------
    page.click('.lt-btn[data-group="gannelliott"]')
    page.wait_for_timeout(250)
    f = page.evaluate(FLY_JS)
    check('A1 gannelliott flyout has 3 sections Chart Patterns/Elliott Waves/Cycles', f and f['secs'] == TV_SECS, f and f['secs'])
    check('A2 flyout lists exactly 14 tools in TV order', f and f['names'] == TV_ORDER, f and f['names'])
    check('A3 every row has a drawn icon (no empty svg)', f and f['emptyIcons'] == 0, f and f['emptyIcons'])
    btn_info = page.evaluate("""() => { const b = document.querySelector('.lt-btn[data-group="gannelliott"]');
      return { svg: !!b.querySelector('svg path'), title: b.title }; }""")
    check('A4 toolbar button = zigzag glyph + group tooltip', btn_info['svg'] and btn_info['title'] == 'Chart patterns, Elliott waves & cycles', btn_info)
    page.screenshot(path=f'{OUT}/01-gannelliott-flyout.png')
    page.evaluate("() => window.__app.UI.closeFlyout && window.__app.UI.closeFlyout()")
    page.wait_for_timeout(120)

    # ---------- B. draw each new Cycles tool end-to-end ----------
    sym = page.evaluate("() => window.__app.App.panes[0].symbol")
    for tid, npts in list(NEW2.items()) + list(NEW3.items()):
        page.click('.lt-btn[data-group="gannelliott"]')
        page.wait_for_timeout(200)
        page.evaluate("""(nm) => { const fl = document.querySelector('.lt-flyout');
          [...fl.querySelectorAll('.lt-tile')].find(t => t.textContent.trim().startsWith(nm)).click(); }""", {'cycliclines': 'Cyclic lines', 'timecycles': 'Time cycles', 'sineline': 'Sine line'}[tid])
        page.wait_for_timeout(150)
        armed = page.evaluate("() => window.__app.App.tool")
        check(f'B-{tid} armed (App.tool)', armed == tid, armed)
        base_ink = page.evaluate(INK_JS)
        d = draw_tool(page, 0, DRAW_PTS[tid])
        check(f'B-{tid} drawing created type + {npts} points', d and d['type'] == tid and d['npts'] == npts, d and (d['type'], d['npts']))
        check(f'B-{tid} factory defaults applied (color #2962ff)', d and d['opts'] and d['opts'].get('color') == '#2962ff', d and sorted(list((d['opts'] or {}).keys()))[:8])
        if tid == 'cycliclines':
            check('B-cycliclines TV defaults (cycles=12, extendRight on)', d and d['opts'].get('cycles') == 12 and d['opts'].get('extendRight') == True, d and (d['opts'].get('cycles'), d['opts'].get('extendRight')))
        page.wait_for_timeout(250)
        ink = page.evaluate(INK_JS)
        check(f'B-{tid} visible on overlay (ink delta > 100)', ink - base_ink > 100, ink - base_ink)
        setres = page.evaluate("""([sym, tid]) => { try {
            const App = window.__app.App;
            const d = (App.drawings.list(sym) || []).find(x => x.type === tid);
            window.__app.DrawSettings.open(App.panes[0], d);
            const dlg = !!document.querySelector('.ds-dialog, .draw-settings, .dlg');
            const x = document.querySelector('.ds-close, .dlg-x');
            if (x) x.click();
            return { ok: dlg };
          } catch (e) { return { ok: false, err: String(e) }; } }""", [sym, tid])
        check(f'B-{tid} settings dialog opens without error', setres['ok'], setres)
        page.evaluate("([s]) => window.__app.App.drawings.removeAll(s)", [sym])
        page.wait_for_timeout(100)

    # ---------- C. nothing lost: Gann still fully present in the fibs flyout ----------
    page.click('.lt-btn[data-group="fibs"]')
    page.wait_for_timeout(200)
    f2 = page.evaluate(FLY_JS)
    check('C1 fibs flyout still has GANN section with 4 tools', f2 and f2['secs'].count('Gann') == 1 and all(t in f2['names'] for t in ['Gann Box', 'Gann Square Fixed', 'Gann Square', 'Gann Fan']), f2 and f2['names'][11:15])
    page.evaluate("() => window.__app.UI.closeFlyout && window.__app.UI.closeFlyout()")

    # ---------- D. pattern/Elliott tools still draw after rename (sample: xabcd + elliott_i) ----------
    for tid, nm, npts in [('xabcd', 'XABCD pattern', 5), ('elliott_i', 'Elliott impulse wave (1-2-3-4-5)', 5)]:
        page.click('.lt-btn[data-group="gannelliott"]')
        page.wait_for_timeout(200)
        page.evaluate("""(nm) => { const fl = document.querySelector('.lt-flyout');
          [...fl.querySelectorAll('.lt-tile')].find(t => t.textContent.trim().startsWith(nm)).click(); }""", nm)
        page.wait_for_timeout(150)
        pts = {'xabcd': [[0.15, 0.60], [0.28, 0.30], [0.40, 0.55], [0.52, 0.25], [0.65, 0.50]],
               'elliott_i': [[0.15, 0.60], [0.30, 0.35], [0.42, 0.55], [0.54, 0.30], [0.68, 0.48]]}[tid]
        d = draw_tool(page, 0, pts)
        check(f'D-{tid} still draws with {npts} points after rename', d and d['type'] == tid and d['npts'] == npts, d and (d['type'], d['npts']))
        page.evaluate("([s]) => window.__app.App.drawings.removeAll(s)", [sym])

    # ---------- E. light theme spot check ----------
    page.evaluate("() => window.__app.Theme.apply('light')")
    page.wait_for_timeout(250)
    page.click('.lt-btn[data-group="gannelliott"]')
    page.wait_for_timeout(200)
    f3 = page.evaluate(FLY_JS)
    check('E1 light theme: gannelliott flyout still 14 tools / 3 TV sections', f3 and f3['names'] == TV_ORDER and f3['secs'] == TV_SECS, f3 and len(f3['names'] or []))
    page.screenshot(path=f'{OUT}/02-gannelliott-flyout-light.png')
    page.evaluate("() => window.__app.UI.closeFlyout && window.__app.UI.closeFlyout()")
    page.evaluate("() => window.__app.Theme.apply('dark')")

    check('E2 zero page errors', not errors, errors[:3])
    browser.close()

fails = [r for r in results if not r[1]]
print(f'\nROUND61 VERIFY: {len(results) - len(fails)}/{len(results)} passed')
sys.exit(1 if fails else 0)
