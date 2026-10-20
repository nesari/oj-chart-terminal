#!/usr/bin/env python3
"""ROUND 46 verify — TV frame separators: the five bar|chart boundary lines
widened 1px -> 2px in DARK only (color stays TV's exact #2e2e2e).

Covers: live computed widths+colors (dark), left-rail collapse guard,
light-theme pixel-identity (1px + old light border), layout heights stable,
screenshots (dark full + the 3 user-marked boundaries, light full), static
source audit (only the round-46 block added, base rules intact), zero page
errors.
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from e2e_helper_round32 import open_app  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, '..', '..', 'work', 'shots46-verify')
os.makedirs(OUT, exist_ok=True)

R45 = '/home/z/my-project/work/mt5-round45/src/renderer/css/app.css'
R46 = os.path.join(ROOT, 'src', 'renderer', 'css', 'app.css')

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  | ' + str(detail)[:300] if detail != '' else ''))

BORDERS_JS = """() => {
  const b = (id, side) => { const el = document.querySelector(id); if (!el) return null;
    const cs = getComputedStyle(el);
    return { w: cs['border' + side + 'Width'], c: cs['border' + side + 'Color'] };
  };
  const o = { top: b('#top-toolbar', 'Bottom'), left: b('#left-toolbar', 'Right'),
              bottom: b('#bottom-toolbar', 'Top'), rc: b('#right-content', 'Left'),
              rt: b('#right-tabs', 'Left') };
  o.leftAll = (() => { const cs = getComputedStyle(document.querySelector('#left-toolbar'));
    return { r: cs.borderRightWidth, rc: cs.borderRightColor }; })();
  const h = id => { const el = document.querySelector(id); return el ? el.getBoundingClientRect().height : null; };
  const wd = id => { const el = document.querySelector(id); return el ? el.getBoundingClientRect().width : null; };
  o.topH = h('#top-toolbar'); o.botH = h('#bottom-toolbar'); o.railW = wd('#left-toolbar');
  o.rcW = wd('#right-content'); o.rtW = wd('#right-tabs');
  return o;
}"""

with sync_playwright() as pw:
    errors = []
    browser, page = open_app(pw)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.wait_for_timeout(600)

    # ============ T1: dark — all five frame separators = 2px #2e2e2e ============
    m = page.evaluate(BORDERS_JS)
    check('T1 dark: top-toolbar border-bottom 2px rgb(46,46,46)',
          m['top']['w'] == '2px' and m['top']['c'] == 'rgb(46, 46, 46)', m['top'])
    check('T1 dark: left-toolbar border-right 2px rgb(46,46,46)',
          m['left']['w'] == '2px' and m['left']['c'] == 'rgb(46, 46, 46)', m['left'])
    check('T1 dark: bottom-toolbar border-top 2px rgb(46,46,46)',
          m['bottom']['w'] == '2px' and m['bottom']['c'] == 'rgb(46, 46, 46)', m['bottom'])
    check('T1 dark: right-content border-left 2px rgb(46,46,46)',
          m['rc']['w'] == '2px' and m['rc']['c'] == 'rgb(46, 46, 46)', m['rc'])
    check('T1 dark: right-tabs border-left 2px rgb(46,46,46)',
          m['rt']['w'] == '2px' and m['rt']['c'] == 'rgb(46, 46, 46)', m['rt'])

    # ============ T2: layout stability (border-box; sizes unchanged) ============
    check('T2 heights/widths unchanged (top 42, bottom 36, rail 46, content 290, rail-r 40)',
          m['topH'] == 42 and m['botH'] == 36 and m['railW'] == 46
          and m['rcW'] == 290 and m['rtW'] == 40,
          {'topH': m['topH'], 'botH': m['botH'], 'railW': m['railW'], 'rcW': m['rcW'], 'rtW': m['rtW']})

    # ---- dark screenshot + the 3 user-marked boundaries ----
    page.screenshot(path=f'{OUT}/dark_full.png')
    g = page.evaluate("""() => {
      const r = id => { const e = document.querySelector(id); const b = e.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height }; };
      return { top: r('#top-toolbar'), left: r('#left-toolbar'), rc: r('#right-content'), rt: r('#right-tabs') };
    }""")
    page.screenshot(path=f'{OUT}/dark_top_edge.png',
                    clip={'x': 0, 'y': g['top']['y'] + g['top']['h'] - 12, 'width': 750, 'height': 24})
    page.screenshot(path=f'{OUT}/dark_left_edge.png',
                    clip={'x': g['left']['x'] + g['left']['w'] - 10, 'y': 200, 'width': 20, 'height': 200})
    page.screenshot(path=f'{OUT}/dark_right_edge.png',
                    clip={'x': g['rc']['x'] - 10, 'y': 200, 'width': 20, 'height': 200})

    # ============ T3: left-rail collapse guard ============
    page.evaluate("window.__app.UI.setLtCollapsed(true)")
    page.wait_for_timeout(350)
    c = page.evaluate(BORDERS_JS)
    lv = page.evaluate("""() => { const el = document.querySelector('#left-toolbar');
      const cs = getComputedStyle(el);
      return { w: cs.borderRightWidth, cls: el.classList.contains('collapsed'), bw: el.getBoundingClientRect().width }; }""")
    check('T3 collapsed rail: no right border (0px), width 0, class on',
          lv['w'] == '0px' and lv['cls'] and lv['bw'] == 0, lv)
    page.evaluate("window.__app.UI.setLtCollapsed(false)")
    page.wait_for_timeout(350)
    c2 = page.evaluate("() => getComputedStyle(document.querySelector('#left-toolbar')).borderRightWidth")
    check('T3 restored rail: right border back to 2px', c2 == '2px', c2)

    # ============ T4: light theme — pixel-identical 1px + old light border ============
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(500)
    L = page.evaluate(BORDERS_JS)
    ok_l = (L['top']['w'] == '1px' and L['left']['w'] == '1px' and L['bottom']['w'] == '1px'
            and L['rc']['w'] == '1px' and L['rt']['w'] == '1px')
    cols = {L['top']['c'], L['left']['c'], L['bottom']['c'], L['rc']['c'], L['rt']['c']}
    # per-side colors — wrong-side reads would surface currentColor (text) values
    check('T4 light: all five separators back to 1px', ok_l,
          {'top': L['top']['w'], 'left': L['left']['w'], 'bottom': L['bottom']['w'],
           'rc': L['rc']['w'], 'rt': L['rt']['w']})
    check('T4 light: separator color = old light border rgb(213,217,226) (#d5d9e2)',
          cols == {'rgb(213, 217, 226)'}, cols)
    page.screenshot(path=f'{OUT}/light_full.png')
    page.evaluate("window.__app.Theme.apply('dark')")
    page.wait_for_timeout(400)
    D = page.evaluate("() => getComputedStyle(document.querySelector('#top-toolbar')).borderBottomWidth")
    check('T4 dark round-trip: top separator 2px again', D == '2px', D)

    # ============ T5: static source audit ============
    with open(R46, encoding='utf-8') as f:
        css46 = f.read()
    with open(R45, encoding='utf-8') as f:
        css45 = f.read()
    rules = [
        'body:not(.theme-light) #top-toolbar { border-bottom-width: 2px; }',
        'body:not(.theme-light) #left-toolbar:not(.collapsed) { border-right-width: 2px; }',
        'body:not(.theme-light) #bottom-toolbar { border-top-width: 2px; }',
        'body:not(.theme-light) #right-content { border-left-width: 2px; }',
        'body:not(.theme-light) #right-tabs { border-left-width: 2px; }',
    ]
    check('T5 static: all five round-46 rules present in round46 app.css',
          all(r in css46 for r in rules))
    check('T5 static: none of them existed in round45 (pure addition)',
          not any(r in css45 for r in rules))
    check('T5 static: base rules keep light-default 1px shorthand',
          'border-bottom: 1px solid var(--border); flex: 0 0 auto;'
          in css46 and 'border-top: 1px solid var(--border);' in css46
          and 'border-right: 1px solid var(--border); /* round 45: TV rail is elevated */' in css46)
    check('T5 static: #app frame rule byte-identical (no side edits)',
          '#app { display: flex; flex-direction: column; height: 100vh; }' in css46)
    import difflib
    sm = difflib.SequenceMatcher(None, css45.splitlines(), css46.splitlines(), autojunk=False)
    ins = sum(j2 - j1 for tag, _i1, _i2, j1, j2 in sm.get_opcodes() if tag == 'insert')
    dele = sum(i2 - i1 for tag, i1, i2, _j1, _j2 in sm.get_opcodes() if tag == 'delete')
    check('T5 static: app.css diff = +16 lines / -0 lines (true diff)',
          ins == 16 and dele == 0, {'+': ins, '-': dele})

    # ============ T6: zero page errors ============
    check('T6 zero page errors', len(errors) == 0, errors[:3])

    browser.close()

passed = sum(1 for _, ok, _ in results if ok)
print(f'\n==== verify_round46: {passed}/{len(results)} ====')
sys.exit(0 if passed == len(results) else 1)
