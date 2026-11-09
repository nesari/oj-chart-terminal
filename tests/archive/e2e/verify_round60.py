#!/usr/bin/env python3
"""ROUND 60 verify — TradingView Fibonacci flyout parity:
- fibs flyout = three labelled sections FIBONACCI / GANN / PITCHFORKS in exact TV order
- 7 new tools: Fib Time Zone, Fib Speed Resistance Fan, Trend-Based Fib Time,
  Fib Spiral, Fib Speed Resistance Arcs, Fib Wedge, Pitchfan
- each new tool: registers, draws end-to-end on the demo chart (ink on overlay),
  factory defaults applied, Settings dialog opens without error
- nothing removed: pitchforks stay in the fibs flyout; Gann tools also stay in gannelliott
- dark + light, zero page errors"""
import os, sys, json, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from e2e_helper_round32 import open_app, poll  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
OUT = os.path.join(ROOT, '..', '..', 'work', 'shots60-verify')
os.makedirs(OUT, exist_ok=True)

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  | ' + str(detail)[:200] if detail != '' else ''))

TV_ORDER = [
    'Fib Retracement', 'Trend-Based Fib Extension', 'Fib Channel', 'Fib Time Zone',
    'Fib Speed Resistance Fan', 'Trend-Based Fib Time', 'Fib Circles', 'Fib Spiral',
    'Fib Speed Resistance Arcs', 'Fib Wedge', 'Pitchfan',
    'Gann Box', 'Gann Square Fixed', 'Gann Square', 'Gann Fan',
    'Pitchfork', 'Schiff Pitchfork', 'Modified Schiff Pitchfork', 'Inside Pitchfork',
]
NEW2 = {'fibtz': 2, 'fibspeedfan': 2, 'fibspiral': 2, 'fibarcs': 2}
NEW3 = {'fibttime': 3, 'fibwedge': 3, 'pitchfan': 3}
NAME_OF = {
    'fibtz': 'Fib Time Zone', 'fibspeedfan': 'Fib Speed Resistance Fan',
    'fibttime': 'Trend-Based Fib Time', 'fibspiral': 'Fib Spiral',
    'fibarcs': 'Fib Speed Resistance Arcs', 'fibwedge': 'Fib Wedge', 'pitchfan': 'Pitchfan',
}

# ---------- static ----------
tools2_src = open(os.path.join(ROOT, 'src/renderer/js/drawing/tools2.js'), encoding='utf-8').read()
set_src = open(os.path.join(ROOT, 'src/renderer/js/drawing/settings.js'), encoding='utf-8').read()
ui_src = open(os.path.join(ROOT, 'src/renderer/js/drawing/ui.js'), encoding='utf-8').read()
icons_src = open(os.path.join(ROOT, 'src/renderer/js/ui/icons.js'), encoding='utf-8').read()
pkg = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))

check('static: version 1.9.11+ (pin updated r61)', pkg.get('version') in ('1.9.11', '1.9.12'), pkg.get('version'))
for tid in NEW2:
    check(f'static: TOOLS.{tid} registered', f'TOOLS.{tid} = {{' in tools2_src and f"name: '{NAME_OF[tid]}'" in tools2_src)
for tid in NEW3:
    check(f'static: TOOLS.{tid} registered', f'TOOLS.{tid} = {{' in tools2_src and f"name: '{NAME_OF[tid]}'" in tools2_src)
check('static: all 7 schemas added', all(f'{tid}: [' in set_src for tid in list(NEW2) + list(NEW3)))
check('static: spiral Coefficient/Turns settings', "key: 'coeff'" in set_src and "key: 'turns'" in set_src)
check('static: arcs Fullscreen setting', "key: 'fullscreen'" in set_src)
check('static: factory defaults for all 7', all(f'{tid}: Object.assign' in tools2_src for tid in list(NEW2) + list(NEW3)))
check('static: 8 new icons present', all(f'{i}:' in icons_src for i in ['fibtz', 'fibspeedfan', 'fibttime', 'fibspiral', 'fibarcs', 'fibwedge', 'pitchfan', 'gannsquaref']))
check('static: gannsquaref icon wired', "name: 'Gann Square Fixed', icon: 'gannsquaref'" in tools2_src)
check('static: fibs = sectioned TV flyout', "id: 'fibs', base: 'fib', sections: [" in ui_src)
check('static: FIBONACCI section exact TV order', "{ title: 'Fibonacci', tools: ['fib', 'fibext', 'fibchannel', 'fibtz', 'fibspeedfan', 'fibttime', 'fibcircles', 'fibspiral', 'fibarcs', 'fibwedge', 'pitchfan'] }" in ui_src)
check('static: GANN section exact TV order (fixed before square)', "{ title: 'Gann', tools: ['gannbox', 'gannsquaref', 'gannsquare', 'gannfan'] }" in ui_src)
check('static: nothing removed — Pitchforks section kept in fibs', "{ title: 'Pitchforks', tools: ['pitchfork', 'pitchfork_s', 'pitchfork_ms', 'pitchfork_i'] }" in ui_src)
check('static: gannelliott flyout = TV Cycles structure (pin updated r61)', "{ title: 'Chart Patterns', tools: ['xabcd', 'cypher', 'hs', 'abcd', 'trianglepat', 'threedrives'] }" in ui_src and "{ title: 'Cycles', tools: ['cycliclines', 'timecycles', 'sineline'] }" in ui_src)
check('static: lines flyout untouched (round 52)', "{ title: 'Lines', tools: ['trend', 'ray', 'infoline', 'extended', 'trendangle', 'hline', 'hray', 'vline', 'crossline', 'arrow'] }" in ui_src)

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
    'fibtz': [[0.25, 0.30], [0.45, 0.55]],
    'fibspeedfan': [[0.22, 0.65], [0.60, 0.30]],
    'fibttime': [[0.18, 0.62], [0.34, 0.30], [0.50, 0.50]],
    'fibspiral': [[0.30, 0.55], [0.48, 0.38]],
    'fibarcs': [[0.28, 0.62], [0.55, 0.35]],
    'fibwedge': [[0.22, 0.65], [0.62, 0.30], [0.40, 0.72]],
    'pitchfan': [[0.18, 0.30], [0.42, 0.55], [0.68, 0.28]],
}

with sync_playwright() as pw:
    browser, page = open_app(pw)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.wait_for_timeout(500)

    # ---------- A. fibs flyout: sections + exact TV order ----------
    page.click('.lt-btn[data-group="fibs"]')
    page.wait_for_timeout(250)
    f = page.evaluate(FLY_JS)
    check('A1 fibs flyout has 3 sections Fibonacci/Gann/Pitchforks', f and f['secs'] == ['Fibonacci', 'Gann', 'Pitchforks'], f and f['secs'])
    check('A2 flyout lists exactly 19 tools in TV order', f and f['names'] == TV_ORDER, f and f['names'])
    check('A3 every row has a drawn icon (no empty svg)', f and f['emptyIcons'] == 0, f and f['emptyIcons'])
    page.screenshot(path=f'{OUT}/01-fibs-flyout.png')
    page.evaluate("() => window.__app.UI.closeFlyout && window.__app.UI.closeFlyout()")
    page.wait_for_timeout(120)

    # ---------- B. draw each new tool end-to-end ----------
    sym = page.evaluate("() => window.__app.App.panes[0].symbol")
    for tid, npts in list(NEW2.items()) + list(NEW3.items()):
        page.click('.lt-btn[data-group="fibs"]')
        page.wait_for_timeout(200)
        page.evaluate("""(nm) => { const fl = document.querySelector('.lt-flyout');
          [...fl.querySelectorAll('.lt-tile')].find(t => t.textContent.trim().startsWith(nm)).click(); }""", NAME_OF[tid])
        page.wait_for_timeout(150)
        armed = page.evaluate("() => window.__app.App.tool")
        check(f'B-{tid} armed (App.tool)', armed == tid, armed)
        base_ink = page.evaluate(INK_JS)
        d = draw_tool(page, 0, DRAW_PTS[tid])
        check(f'B-{tid} drawing created type + {npts} points', d and d['type'] == tid and d['npts'] == npts, d and (d['type'], d['npts']))
        check(f'B-{tid} factory defaults applied (levels/color)', d and d['opts'] and ('levels' in d['opts'] or 'coeff' in d['opts']) and d['opts'].get('color') == '#2962ff', d and sorted(list((d['opts'] or {}).keys()))[:6])
        page.wait_for_timeout(250)
        ink = page.evaluate(INK_JS)
        check(f'B-{tid} visible on overlay (ink delta > 150)', ink - base_ink > 150, ink - base_ink)
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

    # ---------- C. nothing removed: gannelliott still a 3-section flyout (pin updated r61:
    # Gann lives in the fibs flyout's GANN section; Cycles = the new third section) ----------
    page.click('.lt-btn[data-group="gannelliott"]')
    page.wait_for_timeout(200)
    g = page.evaluate(FLY_JS)
    check('C1 gannelliott flyout intact (Chart Patterns/Elliott Waves/Cycles + 14 tools)', g and g['secs'] == ['Chart Patterns', 'Elliott Waves', 'Cycles'] and len(g['names']) == 14, g and (g['secs'], len(g['names'])))
    page.evaluate("() => window.__app.UI.closeFlyout && window.__app.UI.closeFlyout()")

    # ---------- D. light theme spot check ----------
    page.evaluate("() => window.__app.Theme.apply('light')")
    page.wait_for_timeout(250)
    page.click('.lt-btn[data-group="fibs"]')
    page.wait_for_timeout(200)
    f2 = page.evaluate(FLY_JS)
    check('D1 light theme: fibs flyout still 19 tools / 3 sections', f2 and f2['names'] == TV_ORDER, f2 and len(f2['names'] or []))
    page.screenshot(path=f'{OUT}/02-fibs-flyout-light.png')
    page.evaluate("() => window.__app.UI.closeFlyout && window.__app.UI.closeFlyout()")
    page.evaluate("() => window.__app.Theme.apply('dark')")

    # ---------- E. draw sanity of gannsquaref (icon switch must not break tool) ----------
    page.click('.lt-btn[data-group="fibs"]')
    page.wait_for_timeout(200)
    page.evaluate("""() => { const fl = document.querySelector('.lt-flyout');
      [...fl.querySelectorAll('.lt-tile')].find(t => /Gann Square Fixed/.test(t.textContent)).click(); }""")
    page.wait_for_timeout(150)
    d = draw_tool(page, 0, [[0.30, 0.35], [0.55, 0.60]])
    check('E1 Gann Square Fixed still draws (icon wiring safe)', d and d['type'] == 'gannsquaref' and d['npts'] == 2, d and (d['type'], d['npts']))
    page.evaluate("([s]) => window.__app.App.drawings.removeAll(s)", [sym])

    check('E2 zero page errors', not errors, errors[:3])
    browser.close()

fails = [r for r in results if not r[1]]
print(f'\nROUND60 VERIFY: {len(results) - len(fails)}/{len(results)} passed')
sys.exit(1 if fails else 0)
