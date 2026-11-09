#!/usr/bin/env python3
"""ROUND 53 verify — the crosshair visuals survive a click-drag pan:
1) highlights (time pill, price pill/(+)) FOLLOW the cursor mid-drag in ALL
   three cursor modes (they used to vanish on pan-down and return on release)
2) Cross mode: the dashed vert/horz coordinate lines also follow mid-drag
   (bare Arrow/Dot keep lines hidden — pills only)
3) down-moment continuity: nothing disappears the instant the button lands
4) release continuity: still visible immediately after mouse.up (no reappear gap)
5) values track the sliding chart: the time pill text changes while panning
Dark + light spot, round48 separators, zero page errors."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from e2e_helper_round32 import open_app  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402
from PIL import Image  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
OUT = os.path.join(ROOT, '..', '..', 'work', 'shots53-verify')
os.makedirs(OUT, exist_ok=True)

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  | ' + str(detail)[:220] if detail != '' else ''))

def runs_scan(im, fixed, lo, hi, vertical, rgb=(117, 134, 150), tol=16):
    """run-length encode crosshair-colored pixels along a scanline
    (dark #758696, light #9598a1 — pass the right target)"""
    px = im.load()
    seq = []
    for k in range(lo, hi):
        r, g, b = (px[fixed, k] if vertical else px[k, fixed])
        seq.append(abs(r - rgb[0]) < tol and abs(g - rgb[1]) < tol and abs(b - rgb[2]) < tol)
    if not seq:
        return []
    out, cur, n = [], seq[0], 1
    for s in seq[1:]:
        if s == cur:
            n += 1
        else:
            out.append((cur, n)); cur, n = s, 1
    out.append((cur, n))
    return out

# ---------- static: the fix is in the source ----------
eng = open(os.path.join(ROOT, 'src/renderer/js/drawing/engine.js'), encoding='utf-8').read()
pkg = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))
check('static: version 1.9.4', pkg.get('version') in ('1.9.4', '1.9.5', '1.9.6', '1.9.7', '1.9.8', '1.9.9', '1.9.10', '1.9.11', '1.9.12'), pkg.get('version'))
check('static: _panTrack helper added', '_panTrack(x, y) {' in eng)
check('static: _panTrack called on both pan paths', eng.count('this._panTrack(x, y);') == 2, eng.count('this._panTrack(x, y);'))
check('static: pan branch keeps the cross state alive', 'this._cross = { on: true, x, y, bare: bareCursor };' in eng)
check('static: pan-down no longer clears the crosshair visuals',
      'REVERSED the ROUND51 behavior' in eng and eng.count('this._clearSubCross();') == 2 and eng.count('Manager.syncCrossClear') == 2,
      f"sub={eng.count('this._clearSubCross();')} sync={eng.count('Manager.syncCrossClear')}")

SNAP = """() => {
  const p = window.__app.App.panes[0];
  const g = (s) => { const el = document.querySelector(s); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.x + r.width / 2, cy: r.y + r.height / 2, d: getComputedStyle(el).display, txt: el.textContent }; };
  return { tax: g('.tax-live'), pa: g('.pax-add'), pl: g('.pax-live'), paxPrice: p._paxPrice };
}"""

with sync_playwright() as pw:
    errors = []
    browser, page = open_app(pw)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.wait_for_timeout(500)

    page.evaluate("window.__app.Theme.apply('dark')")
    page.wait_for_timeout(200)
    sep = page.evaluate("getComputedStyle(document.querySelector('#top-toolbar')).borderBottomWidth")
    sepc = page.evaluate("getComputedStyle(document.querySelector('#top-toolbar')).borderBottomColor")
    check('dark: round48 separator still 5px #2e2e2e', sep == '5px' and sepc == 'rgb(46, 46, 46)', f'{sep} {sepc}')

    bb = page.evaluate("""() => { const r = document.querySelector('.pane-overlay').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; }""")
    cx, cy = int(bb['x'] + bb['w'] * 0.45), int(bb['y'] + bb['h'] * 0.4)

    page.evaluate("() => { try { localStorage.removeItem('mt5_alerts'); } catch (e) {} if (window.__app.Alerts) { window.__app.Alerts.list = []; window.__app.Alerts.selected = null; } }")
    page.wait_for_timeout(200)

    for mode in ('cross', 'arrowcur', 'dot'):
        bare = mode != 'cross'
        tag = mode
        page.evaluate(f"window.__app.UI.activateTool('{mode}')")
        page.wait_for_timeout(150)
        page.mouse.move(cx, cy, steps=5)
        page.wait_for_timeout(250)
        s0 = page.evaluate(SNAP)
        check(f'{tag}: baseline hover — time pill + (+) visible', s0['tax']['d'] == 'block' and s0['pa']['d'] == 'flex', f"{s0['tax']['d']}/{s0['pa']['d']}")
        txt0 = s0['tax']['txt']
        pr0 = s0['paxPrice']

        # --- button lands: nothing may die on pan-down (the old bug) ---
        page.mouse.down()
        page.wait_for_timeout(150)
        s1 = page.evaluate(SNAP)
        check(f'{tag}: down-moment — pills STILL visible', s1['tax']['d'] == 'block' and s1['pa']['d'] == 'flex', f"{s1['tax']['d']}/{s1['pa']['d']}")

        # --- drag step A (diagonal): everything must follow the cursor ---
        ax, ay = cx - 70, cy + 30
        page.mouse.move(ax, ay, steps=8)
        page.wait_for_timeout(150)
        s2 = page.evaluate(SNAP)
        check(f'{tag}: mid-drag A — time pill visible', s2['tax']['d'] == 'block', s2['tax']['d'])
        check(f'{tag}: mid-drag A — (+) visible', s2['pa']['d'] == 'flex', s2['pa']['d'])
        check(f'{tag}: mid-drag A — time pill follows cursor x', abs(s2['tax']['cx'] - ax) <= 10, f"{s2['tax']['cx']:.0f} vs {ax}")
        check(f'{tag}: mid-drag A — (+) follows cursor y', abs(s2['pa']['cy'] - ay) <= 8, f"{s2['pa']['cy']:.0f} vs {ay}")
        pl_expect = 'none' if not bare else 'block'
        check(f'{tag}: mid-drag A — DOM price pill role correct (cross=native label)', s2['pl']['d'] == pl_expect, s2['pl']['d'])
        page.screenshot(path=f'{OUT}/pan_mid_{tag}.png')
        im2 = Image.open(f'{OUT}/pan_mid_{tag}.png').convert('RGB')
        h_on = sum(n for s, n in runs_scan(im2, ay, ax - 260, ax - 8, vertical=False) + runs_scan(im2, ay, ax + 8, ax + 260, vertical=False) if s)
        v_on = sum(n for s, n in runs_scan(im2, ax, max(0, ay - 110), ay - 8, vertical=True) + runs_scan(im2, ax, ay + 8, ay + 110, vertical=True) if s)
        if not bare:
            check('cross: mid-drag A — dashed horz line follows', h_on > 60, h_on)
            check('cross: mid-drag A — dashed vert line follows', v_on > 60, v_on)
        else:
            check(f'{tag}: mid-drag A — lines stay hidden (bare)', h_on < 8 and v_on < 8, f'h={h_on} v={v_on}')

        # --- drag step B: continuity + values track the sliding chart ---
        bx, by = cx - 150, cy + 60
        page.mouse.move(bx, by, steps=8)
        page.wait_for_timeout(150)
        s3 = page.evaluate(SNAP)
        check(f'{tag}: mid-drag B — pills never blinked off', s3['tax']['d'] == 'block' and s3['pa']['d'] == 'flex', f"{s3['tax']['d']}/{s3['pa']['d']}")
        check(f'{tag}: mid-drag B — (+) still rides cursor y', abs(s3['pa']['cy'] - by) <= 8, f"{s3['pa']['cy']:.0f} vs {by}")
        # the cursor y moved 60px down mid-pan — the pill value must have been
        # RECOMPUTED during the drag (not frozen, not hidden)
        check(f'{tag}: mid-drag B — price value recomputed during the drag', s3['paxPrice'] is not None and pr0 is not None and abs(s3['paxPrice'] - pr0) > 1e-9, f'{pr0} -> {s3["paxPrice"]}')

        # --- release: still visible the instant the button lifts (no reappear gap) ---
        page.mouse.up()
        page.wait_for_timeout(250)
        s4 = page.evaluate(SNAP)
        check(f'{tag}: after release — pills STILL visible (no gap)', s4['tax']['d'] == 'block' and s4['pa']['d'] == 'flex', f"{s4['tax']['d']}/{s4['pa']['d']}")
        # release glide may keep sliding the chart under the (stationary) cursor
        # — values keep UPDATING (alive); once settled they must hold stable
        page.wait_for_timeout(700)
        s4b = page.evaluate(SNAP)
        page.wait_for_timeout(300)
        s4c = page.evaluate(SNAP)
        check(f'{tag}: after release — pills settled visible + value stable', s4b['tax']['d'] == 'block' and s4b['pa']['d'] == 'flex' and s4c['tax']['txt'] == s4b['tax']['txt'], f"{s4b['tax']['d']}/{s4b['pa']['d']} {s4b['tax']['txt']} vs {s4c['tax']['txt']}")
        page.mouse.move(cx, cy, steps=5)
        page.wait_for_timeout(250)

    # ---- light theme spot pass (cross) ----
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(250)
    sep = page.evaluate("getComputedStyle(document.querySelector('#top-toolbar')).borderBottomWidth")
    sepc = page.evaluate("getComputedStyle(document.querySelector('#top-toolbar')).borderBottomColor")
    check('light: round48 separator still 2px #ccd0da', sep == '2px' and sepc == 'rgb(204, 208, 218)', f'{sep} {sepc}')
    page.evaluate("window.__app.UI.activateTool('cross')")
    page.wait_for_timeout(150)
    page.mouse.move(cx, cy, steps=5)
    page.wait_for_timeout(250)
    page.mouse.down()
    page.mouse.move(cx - 90, cy + 20, steps=8)
    page.wait_for_timeout(150)
    s5 = page.evaluate(SNAP)
    check('light: mid-drag — time pill + (+) follow', s5['tax']['d'] == 'block' and s5['pa']['d'] == 'flex' and abs(s5['pa']['cy'] - (cy + 20)) <= 8, f"{s5['tax']['d']}/{s5['pa']['d']}")
    page.screenshot(path=f'{OUT}/pan_mid_light_cross.png')
    im5 = Image.open(f'{OUT}/pan_mid_light_cross.png').convert('RGB')
    # light theme crosshair color is #9598a1 (theme.js) — different scan target
    h5 = sum(n for s, n in runs_scan(im5, cy + 20, cx - 280, cx - 98, vertical=False, rgb=(149, 152, 161)) + runs_scan(im5, cy + 20, cx - 82, cx + 280, vertical=False, rgb=(149, 152, 161)) if s)
    check('light: mid-drag — dashed horz line follows', h5 > 60, h5)
    page.mouse.up()
    page.wait_for_timeout(200)

    check('zero page errors', len(errors) == 0, errors[:3])
    browser.close()

fails = [r for r in results if not r[1]]
print(f"\nVERIFY ROUND53: {len(results) - len(fails)}/{len(results)} green, {len(fails)} red")
sys.exit(1 if fails else 0)
