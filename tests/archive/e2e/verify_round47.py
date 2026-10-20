#!/usr/bin/env python3
"""ROUND 47 verify — frame separators, round-2 tuning per user feedback:
DARK thickened 2px -> 3px (color stays #2e2e2e, a step lighter than bars);
LIGHT gets the boundary for the first time: 2px #ccd0da (a step darker than
the #f0f3fa bars). Five edges both themes, collapse guard, layout stable,
screenshots, static audit (change confined to the separator block), zero
page errors.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from e2e_helper_round32 import open_app  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, '..', '..', 'work', 'shots47-verify')
os.makedirs(OUT, exist_ok=True)

R46 = '/home/z/my-project/work/mt5-round46/src/renderer/css/app.css'
R47 = os.path.join(ROOT, 'src', 'renderer', 'css', 'app.css')

DARK_C = 'rgb(46, 46, 46)'        # #2e2e2e
LIGHT_C = 'rgb(204, 208, 218)'    # #ccd0da

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

    # ============ T1: dark — five frame separators = 3px #2e2e2e ============
    m = page.evaluate(BORDERS_JS)
    for key, label, side in (('top', 'top-toolbar', 'bottom'), ('left', 'left-toolbar', 'right'),
                             ('bottom', 'bottom-toolbar', 'top'), ('rc', 'right-content', 'left'),
                             ('rt', 'right-tabs', 'left')):
        check(f'T1 dark: {label} border-{side} 3px rgb(46,46,46)',
              m[key]['w'] == '3px' and m[key]['c'] == DARK_C, m[key])

    # ============ T2: layout stability ============
    check('T2 heights/widths unchanged (top 42, bottom 36, rail 46, content 290, rail-r 40)',
          m['topH'] == 42 and m['botH'] == 36 and m['railW'] == 46
          and m['rcW'] == 290 and m['rtW'] == 40,
          {'topH': m['topH'], 'botH': m['botH'], 'railW': m['railW'], 'rcW': m['rcW'], 'rtW': m['rtW']})

    # ---- dark screenshots ----
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

    # ============ T3: left-rail collapse guard (dark) ============
    page.evaluate("window.__app.UI.setLtCollapsed(true)")
    page.wait_for_timeout(350)
    lv = page.evaluate("""() => { const el = document.querySelector('#left-toolbar');
      const cs = getComputedStyle(el);
      return { w: cs.borderRightWidth, cls: el.classList.contains('collapsed'), bw: el.getBoundingClientRect().width }; }""")
    check('T3 collapsed rail: no right border (0px), width 0, class on',
          lv['w'] == '0px' and lv['cls'] and lv['bw'] == 0, lv)
    page.evaluate("window.__app.UI.setLtCollapsed(false)")
    page.wait_for_timeout(350)
    c2 = page.evaluate("() => getComputedStyle(document.querySelector('#left-toolbar')).borderRightWidth")
    check('T3 restored rail: right border back to 3px', c2 == '3px', c2)

    # ============ T4: light theme — 2px #ccd0da on all five ============
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(500)
    L = page.evaluate(BORDERS_JS)
    for key, label, side in (('top', 'top-toolbar', 'bottom'), ('left', 'left-toolbar', 'right'),
                             ('bottom', 'bottom-toolbar', 'top'), ('rc', 'right-content', 'left'),
                             ('rt', 'right-tabs', 'left')):
        check(f'T4 light: {label} border-{side} 2px rgb(204,208,218)',
              L[key]['w'] == '2px' and L[key]['c'] == LIGHT_C, L[key])
    page.screenshot(path=f'{OUT}/light_full.png')
    page.screenshot(path=f'{OUT}/light_top_edge.png',
                    clip={'x': 0, 'y': g['top']['y'] + g['top']['h'] - 12, 'width': 750, 'height': 24})
    page.screenshot(path=f'{OUT}/light_left_edge.png',
                    clip={'x': g['left']['x'] + g['left']['w'] - 10, 'y': 200, 'width': 20, 'height': 200})
    page.evaluate("window.__app.Theme.apply('dark')")
    page.wait_for_timeout(400)
    D = page.evaluate("() => getComputedStyle(document.querySelector('#top-toolbar')).borderBottomWidth")
    check('T4 dark round-trip: top separator 3px again', D == '3px', D)

    # ============ T5: static source audit — change confined to the block ============
    with open(R47, encoding='utf-8') as f:
        css47 = f.read()
    with open(R46, encoding='utf-8') as f:
        css46 = f.read()
    dark_rules = [
        'body:not(.theme-light) #top-toolbar { border-bottom-width: 3px; }',
        'body:not(.theme-light) #left-toolbar:not(.collapsed) { border-right-width: 3px; }',
        'body:not(.theme-light) #bottom-toolbar { border-top-width: 3px; }',
        'body:not(.theme-light) #right-content { border-left-width: 3px; }',
        'body:not(.theme-light) #right-tabs { border-left-width: 3px; }',
    ]
    light_rules = [
        'body.theme-light #top-toolbar { border-bottom-width: 2px; border-bottom-color: #ccd0da; }',
        'body.theme-light #left-toolbar:not(.collapsed) { border-right-width: 2px; border-right-color: #ccd0da; }',
        'body.theme-light #bottom-toolbar { border-top-width: 2px; border-top-color: #ccd0da; }',
        'body.theme-light #right-content { border-left-width: 2px; border-left-color: #ccd0da; }',
        'body.theme-light #right-tabs { border-left-width: 2px; border-left-color: #ccd0da; }',
    ]
    check('T5 static: all 10 round-47 rules present (5 dark 3px + 5 light 2px)',
          all(r in css47 for r in dark_rules + light_rules))
    check('T5 static: old 2px dark rules gone from round47',
          'border-bottom-width: 2px; }\nbody:not(.theme-light) #left-toolbar' not in css47
          and 'body:not(.theme-light) #top-toolbar { border-bottom-width: 2px; }' not in css47)
    # change confined to the separator block: same head, same tail
    i46 = css46.find('/* round 46')
    i47 = css47.find('/* round 46+47')
    e46 = css46.find('/* top toolbar */')
    e47 = css47.find('/* top toolbar */')
    check('T5 static: everything before/after the separator block byte-identical vs round46',
          i46 > 0 and i47 > 0 and e46 > 0 and e47 > 0
          and css46[:i46] == css47[:i47] and css46[e46:] == css47[e47:],
          {'head_same': css46[:i46] == css47[:i47], 'tail_same': css46[e46:] == css47[e47:]})
    check('T5 static: base rules keep 1px shorthand + collapse override intact',
          'border-bottom: 1px solid var(--border); flex: 0 0 auto;' in css47
          and 'border-right: 1px solid var(--border); /* round 45: TV rail is elevated */' in css47
          and '#left-toolbar.collapsed {\n  border-right: 0;' in css47
          and '#app { display: flex; flex-direction: column; height: 100vh; }' in css47)

    # ============ T6: zero page errors ============
    check('T6 zero page errors', len(errors) == 0, errors[:3])

    browser.close()

passed = sum(1 for _, ok, _ in results if ok)
print(f'\n==== verify_round47: {passed}/{len(results)} ====')
sys.exit(0 if passed == len(results) else 1)
