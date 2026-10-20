#!/usr/bin/env python3
"""ROUND 52 verify — TradingView trend-line flyout parity:
- flyout = three labelled sections LINES / CHANNELS / PITCHFORKS in exact TV order
- new tools Trend Angle / Flat Top-Bottom / Disjoint Channel draw + persist
- Regression Trend reachable from CHANNELS; Pitchfork family in PITCHFORKS
- settings dialogs expose the TV-style Style-tab fields
- group button follows only the section the tool was picked from
- nothing removed: Arrow still in LINES; fibs flyout still lists pitchforks
- dark + light, zero page errors"""
import os, sys, json
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__))))
from e2e_helper_round32 import open_app  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, '..', '..', 'work', 'shots52-verify')
os.makedirs(OUT, exist_ok=True)

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  | ' + str(detail)[:220] if detail != '' else ''))

TV_ORDER = [
    'Trend Line', 'Ray', 'Info Line', 'Extended Line', 'Trend Angle',
    'Horizontal Line', 'Horizontal Ray', 'Vertical Line', 'Cross Line', 'Arrow',
    'Parallel Channel', 'Regression Trend', 'Flat Top/Bottom', 'Disjoint Channel',
    'Pitchfork', 'Schiff Pitchfork', 'Modified Schiff Pitchfork', 'Inside Pitchfork',
]

# ---------- static ----------
tools_src = open(os.path.join(ROOT, 'src/renderer/js/drawing/tools.js'), encoding='utf-8').read()
tools2_src = open(os.path.join(ROOT, 'src/renderer/js/drawing/tools2.js'), encoding='utf-8').read()
ui_src = open(os.path.join(ROOT, 'src/renderer/js/drawing/ui.js'), encoding='utf-8').read()
set_src = open(os.path.join(ROOT, 'src/renderer/js/drawing/settings.js'), encoding='utf-8').read()
icons_src = open(os.path.join(ROOT, 'src/renderer/js/ui/icons.js'), encoding='utf-8').read()
pkg = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))
check('static: version 1.9.3+ (test pin updated r53)', pkg.get('version') in ('1.9.3', '1.9.4', '1.9.5', '1.9.6', '1.9.7', '1.9.8', '1.9.9', '1.9.10', '1.9.11', '1.9.12'), pkg.get('version'))
check('static: TOOLS.trendangle registered', 'TOOLS.trendangle' in tools_src and "name: 'Trend Angle'" in tools_src)
check('static: TOOLS.flattop registered', 'TOOLS.flattop' in tools_src and "name: 'Flat Top/Bottom'" in tools_src)
check('static: TOOLS.disjoint registered', 'TOOLS.disjoint' in tools_src and "name: 'Disjoint Channel'" in tools_src)
check('static: disjoint Line2 keys', 'color2' in tools_src and 'width2' in tools_src and 'style2' in tools_src)
check('static: schemas added', all(k in set_src for k in ['trendangle:', 'flattop:', 'disjoint:', 'regression:']))
check('static: pitchfork renamed to TV menu name', "forkTool('pitchfork', 'Pitchfork'" in tools2_src)
check('static: tools2 fill helpers', 'function fillAlphaOf' in tools2_src and 'function fillColorOf' in tools2_src)
check('static: regression background fill', 'd.opts.fill && devs.length' in tools2_src)
check('static: new icons', all(k in icons_src for k in ['trendangle:', 'flattop:', 'disjoint:']))
check('static: groups 3 sections TV order', "'title: 'Lines'" in ui_src.replace('"', "'") or ("title: 'Lines'" in ui_src and "title: 'Channels'" in ui_src and "title: 'Pitchforks'" in ui_src))
check('static: arrow kept in LINES', "'trend', 'ray', 'infoline', 'extended', 'trendangle', 'hline', 'hray', 'vline', 'crossline', 'arrow'" in ui_src)
check('static: fibs flyout keeps pitchforks (r58 sections)', "{ title: 'Pitchforks', tools: ['pitchfork', 'pitchfork_s', 'pitchfork_ms', 'pitchfork_i'] }" in ui_src and "'fib', 'fibext', 'fibchannel', 'fibtz'" in ui_src)
check('static: activateTool src-group guard', 'function activateTool(tid, srcGroup)' in ui_src and 'g.id !== srcGroup.id' in ui_src)

count_drawings = """() => {
  const p = window.__app.App.panes[0];
  return (window.__app.App.drawings.list(p.symbol) || []).length;
}"""
draw_of = """(type) => {
  const p = window.__app.App.panes[0];
  const l = window.__app.App.drawings.list(p.symbol) || [];
  const d = l.filter(x => x.type === type).pop() || null;
  return d ? { id: d.id, pts: d.points.length, fill: !!d.opts.fill, has2: d.opts.color2 !== undefined, a0: [d.points[0].p, d.points[0].t], a1: d.points[1] ? [d.points[1].p, d.points[1].t] : null, a2: d.points[2] ? [d.points[2].p, d.points[2].t] : null } : null;
}"""

with sync_playwright() as pw:
    errors = []
    browser, page = open_app(pw)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.wait_for_timeout(400)
    page.evaluate("window.__app.Theme.apply('dark')")
    page.wait_for_timeout(250)

    bb = page.evaluate("""() => { const r = document.querySelector('.pane-overlay').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; }""")

    def open_lines_flyout():
        page.evaluate("() => document.querySelector('#left-toolbar .lt-btn[data-group=\"lines\"]').click()")
        page.wait_for_timeout(300)

    def flyout_state():
        return page.evaluate("""() => {
          const fl = document.querySelector('.lt-flyout');
          if (!fl) return null;
          return {
            secs: Array.from(fl.querySelectorAll('.lt-flysec')).map(e => e.textContent),
            tiles: Array.from(fl.querySelectorAll('.lt-tile .tile-name')).map(e => e.textContent),
            stars: fl.querySelectorAll('.tile-star').length,
          };
        }""")

    # ================= T1: flyout structure =================
    open_lines_flyout()
    st = flyout_state()
    check('flyout opens with sections', bool(st), 'no flyout')
    if st:
        check('flyout: 3 section headers', st['secs'] == ['Lines', 'Channels', 'Pitchforks'], st['secs'])
        check('flyout: exact TV order (18 tools)', st['tiles'] == TV_ORDER, st['tiles'])
        check('flyout: favorite star on every row', st['stars'] == len(TV_ORDER), st['stars'])
        page.screenshot(path=os.path.join(OUT, 'r52-flyout-dark.png'))
    # fibs flyout still has its own pitchforks (nothing removed) — NOTE: a
    # group-button click TOGGLES any open flyout, so DISMISS the lines flyout
    # with a real outside click first (a DOM .remove() would leave the module
    # handle stale and swallow the next open)
    page.mouse.click(int(bb['x'] + bb['w'] * 0.5), int(bb['y'] + bb['h'] * 0.5))
    page.wait_for_timeout(250)
    page.evaluate("() => document.querySelector('#left-toolbar .lt-btn[data-group=\"fibs\"]').click()")
    page.wait_for_timeout(300)
    fst = page.evaluate("""() => Array.from(document.querySelectorAll('.lt-flyout .lt-tile .tile-name')).map(e => e.textContent)""")
    check('fibs flyout untouched (pitchforks still there)', all(n in fst for n in ['Pitchfork', 'Schiff Pitchfork', 'Modified Schiff Pitchfork', 'Inside Pitchfork']), fst)
    page.keyboard.press('Escape')
    page.evaluate("() => { const f = document.querySelector('.lt-flyout'); if (f) f.remove(); }")
    page.wait_for_timeout(150)

    # ================= T2: group button follows only its own section =================
    guard = page.evaluate("""() => {
      const G = window.__app.UI.GROUPS;
      const lines = G.find(g => g.id === 'lines'), fibs = G.find(g => g.id === 'fibs');
      window.__app.UI.activateTool('pitchfork', lines);
      const lb = document.querySelector('#left-toolbar .lt-btn[data-group="lines"]');
      const fb = document.querySelector('#left-toolbar .lt-btn[data-group="fibs"]');
      const pi = 'M5 19L12 5l7 14M5 19l14-9M5 19l14 0';
      return { linesGot: lb.innerHTML.includes(pi), fibsKept: !fb.innerHTML.includes(pi) };
    }""")
    check('group guard: lines btn follows pick', guard.get('linesGot') is True, guard)
    check('group guard: fibs btn untouched', guard.get('fibsKept') is True, guard)

    # ================= T3: draw the three NEW tools on the canvas =================
    def draw_pts(pts, dwell=120):
        page.mouse.move(pts[0][0], pts[0][1], steps=4)
        page.wait_for_timeout(dwell)
        for (x, y) in pts:
            page.mouse.move(x, y, steps=4)
            page.wait_for_timeout(60)
            page.mouse.click(x, y)
            page.wait_for_timeout(dwell)

    def activate(tid):
        page.evaluate(f"() => window.__app.UI.activateTool('{tid}')")
        page.wait_for_timeout(200)

    x0, y0 = int(bb['x'] + bb['w'] * 0.30), int(bb['y'] + bb['h'] * 0.45)
    before = page.evaluate(count_drawings)
    check('clean start: no drawings', before == 0, before)

    activate('trendangle')
    draw_pts([(x0, y0), (x0 + 160, y0 - 90)])
    d = page.evaluate(f"({draw_of})('trendangle')")
    check('trendangle drawn + stored (2 pts)', bool(d) and d['pts'] == 2, d)

    activate('flattop')
    draw_pts([(x0, y0 + 40), (x0 + 180, y0 - 30), (x0 + 90, y0 - 110)])
    d = page.evaluate(f"({draw_of})('flattop')")
    check('flattop drawn + stored (3 pts, fill on)', bool(d) and d['pts'] == 3 and d['fill'] is True, d)

    activate('disjoint')
    draw_pts([(x0 + 40, y0 + 90), (x0 + 220, y0 + 10), (x0 + 300, y0 + 130)])
    d = page.evaluate(f"({draw_of})('disjoint')")
    check('disjoint drawn + stored (3 pts, color2 present)', bool(d) and d['pts'] == 3 and d['has2'] is True, d)

    activate('regression')
    draw_pts([(x0 + 60, y0 + 20), (x0 + 260, y0 - 50)])
    d = page.evaluate(f"({draw_of})('regression')")
    check('regression drawn from CHANNELS id', bool(d) and d['pts'] == 2, d)

    activate('pitchfork')
    draw_pts([(x0 + 120, y0 + 150), (x0 + 240, y0 + 60), (x0 + 330, y0 + 120)])
    d = page.evaluate(f"({draw_of})('pitchfork')")
    check('pitchfork drawn from PITCHFORKS id', bool(d) and d['pts'] == 3, d)

    total = page.evaluate(count_drawings)
    check('all five stored', total == 5, total)
    page.evaluate("() => window.__app.UI.activateTool('cross')")
    page.wait_for_timeout(250)
    page.screenshot(path=os.path.join(OUT, 'r52-drawings-dark.png'))

    # ================= T4: settings dialogs expose TV fields =================
    def settings_fields(dtype):
        js = """(dtype) => {
          const p = window.__app.App.panes[0];
          const l = window.__app.App.drawings.list(p.symbol) || [];
          const d = l.filter(x => x.type === dtype).pop();
          if (!d) return null;
          window.__app.DrawSettings.open(p, d);
          return true;
        }"""
        page.evaluate(js, dtype)
        page.wait_for_timeout(350)
        rows = page.evaluate("""() => Array.from(document.querySelectorAll('.ds-row .ds-lab, .ds-row .ds-lab2')).map(e => e.textContent)""")
        labels = [r for r in rows if r]
        page.evaluate("""() => { const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent === 'Ok'); if (b) b.click(); }""")
        page.wait_for_timeout(250)
        return labels

    f = settings_fields('trendangle')
    check('trendangle settings: TV fields', f and 'Extend left' in f and 'Extend right' in f and 'Angle label' in f, f)
    f = settings_fields('flattop')
    check('flattop settings: TV fields', f and 'Background' in f and 'Extend left' in f and 'Extend right' in f, f)
    f = settings_fields('disjoint')
    check('disjoint settings: Line1/Line2/Background', f and 'Line 1' in f and 'Line 2' in f and 'Background' in f, f)
    f = settings_fields('regression')
    check('regression settings: Background + Extend', f and 'Background' in f and 'Extend' in f, f)

    # ================= T5: light theme flyout =================
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(250)
    open_lines_flyout()
    st = flyout_state()
    check('light: sections + order intact', bool(st) and st['secs'] == ['Lines', 'Channels', 'Pitchforks'] and st['tiles'] == TV_ORDER, st and st['secs'])
    page.screenshot(path=os.path.join(OUT, 'r52-flyout-light.png'))
    page.evaluate("() => { const f = document.querySelector('.lt-flyout'); if (f) f.remove(); }")
    page.wait_for_timeout(150)
    page.screenshot(path=os.path.join(OUT, 'r52-drawings-light.png'))

    check('zero page errors', len(errors) == 0, errors[:3])

    browser.close()

passed = sum(1 for _, ok, _ in results if ok)
print(f"\n{passed}/{len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
