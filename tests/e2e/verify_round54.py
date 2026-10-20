#!/usr/bin/env python3
"""ROUND 54 verify — the price-axis countdown label + symbol chip track a
click-drag 1:1 (zero lag) in all three cursor modes:
1) static: syncCdPos exists + is called every frame in startLoop, guarded
   writes in updateCountdown/updateSymChip
2) mid-drag: for EVERY sampled drag step, cd.top and chip.top equal the
   expected priceToCoordinate(last close) position within 2px — the old
   400ms throttle produced visible catch-up lag (tens of px mid-drag)
3) nothing blinks off mid-drag (cd block / chip flex the whole way)
4) text integrity: countdown keeps mm:ss(/h:mm:ss) format, chip keeps the
   symbol name through the whole drag
5) horizontal-only drag segment: same tracking (any drag, not just 2-axis)
6) release: still visible + settled; light spot; r48 separators; 0 errors."""
import os, sys, json, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from e2e_helper_round32 import open_app  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, '..', '..', 'work', 'shots54-verify')
os.makedirs(OUT, exist_ok=True)

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  | ' + str(detail)[:220] if detail != '' else ''))

# ---------- static: the fix is in the source ----------
mgr = open(os.path.join(ROOT, 'src/renderer/js/chart/manager.js'), encoding='utf-8').read()
pkg = json.load(open(os.path.join(ROOT, 'package.json'), encoding='utf-8'))
check('static: version 1.9.5', pkg.get('version') in ('1.9.5', '1.9.6', '1.9.7', '1.9.8', '1.9.9', '1.9.10', '1.9.11', '1.9.12'), pkg.get('version'))
check('static: Manager.syncCdPos defined', 'Manager.syncCdPos = function' in mgr)
check('static: syncCdPos reuses the real updaters', 'updateCountdown(p);' in mgr and 'updateSymChip(p);' in mgr and mgr.count('if (p.cd && p.cd.style.display') == 1)
check('static: syncCdPos called per frame in startLoop', mgr.count('Manager.syncCdPos();') == 1 and 'Manager.syncCdPos();' in mgr.split('const loop = (ts)')[1])
check('static: cd text write is change-guarded', "if (el.textContent !== txt) el.textContent = txt;" in mgr)
check('static: cd background write is change-guarded', 'if (el.style.background !== bg) el.style.background = bg;' in mgr)
check('static: chip name write is change-guarded', 'if (el.textContent !== pane.symbol) el.textContent = pane.symbol;' in mgr)
check('static: throttle untouched (400ms full refresh kept)', mgr.count('if (ts - lastCd > 400) {') == 1)

SNAP = """() => {
  const p = window.__app.App.panes[0];
  const S = window.__app.Settings ? window.__app.Settings.conf : {};
  const rd = (sel) => { const el = document.querySelector(sel); if (!el) return null;
    return { top: parseFloat(el.style.top), d: getComputedStyle(el).display, txt: el.textContent }; };
  let y = null;
  try { y = p.series.priceToCoordinate(p.bars[p.bars.length - 1].close); } catch (e) {}
  const lblOn = (S.symLabel || 'name_value_line') !== 'hidden';
  const cdExp = (y != null && isFinite(y)) ? Math.round(y) + (lblOn ? 10 : 0) : null;
  let chipExp = null;
  if (y != null && isFinite(y)) {
    const hostH = p.host ? p.host.clientHeight : 9999;
    let t = (y >= 34) ? (y - 21) : (y + 21 + ((S.countdown !== false) ? 21 : 0));
    chipExp = Math.round(Math.max(10, Math.min(t, hostH - 12)));
  }
  return { cd: rd('.cd-label'), chip: rd('.sym-chip'), cdExp, chipExp, sym: p.symbol };
}"""

def tops_ok(s, tol=2.0):
    """cd+chip both visible AND glued to the expected position"""
    cd_ok = s['cd'] and s['cd']['d'] == 'block' and s['cdExp'] is not None and abs(s['cd']['top'] - s['cdExp']) <= tol
    ch_ok = s['chip'] and s['chip']['d'] == 'flex' and s['chipExp'] is not None and abs(s['chip']['top'] - s['chipExp']) <= tol
    return cd_ok, ch_ok

with sync_playwright() as pw:
    errors = []
    browser, page = open_app(pw)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.wait_for_timeout(600)
    page.evaluate("window.__app.Theme.apply('dark')")
    page.wait_for_timeout(300)

    bb = page.evaluate("""() => { const r = document.querySelector('.pane-overlay').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; }""")
    cx, cy = int(bb['x'] + bb['w'] * 0.45), int(bb['y'] + bb['h'] * 0.4)

    page.evaluate("() => { try { localStorage.removeItem('mt5_alerts'); } catch (e) {} if (window.__app.Alerts) { window.__app.Alerts.list = []; window.__app.Alerts.selected = null; } }")
    page.wait_for_timeout(200)

    CD_FMT = re.compile(r'^\d{1,2}:\d{2}(:\d{2})?$')

    for mode in ('cross', 'arrowcur', 'dot'):
        tag = mode
        page.evaluate(f"window.__app.UI.activateTool('{mode}')")
        page.wait_for_timeout(150)
        page.mouse.move(cx, cy, steps=5)
        page.wait_for_timeout(300)
        s0 = page.evaluate(SNAP)
        cd0, ch0 = tops_ok(s0)
        check(f'{tag}: baseline — cd visible + glued (y={s0["cdExp"]})', cd0, f"{s0['cd']} exp={s0['cdExp']}")
        check(f'{tag}: baseline — chip visible + glued (y={s0["chipExp"]})', ch0, f"{s0['chip']} exp={s0['chipExp']}")
        check(f'{tag}: baseline — cd text is a countdown', bool(CD_FMT.match(s0['cd']['txt'] or '')), s0['cd']['txt'])
        check(f'{tag}: baseline — chip shows the symbol name', s0['chip']['txt'] == s0['sym'], f"{s0['chip']['txt']} vs {s0['sym']}")

        # --- two-axis drag: sample EVERY step, both labels must be glued ---
        page.mouse.down()
        page.wait_for_timeout(120)
        lag_hits = 0
        samples = 0
        blink = 0
        x, y = cx, cy
        for i in range(9):  # diagonal down-left: vertical moves the price scale
            x -= 9
            y += 11
            page.mouse.move(x, y, steps=2)
            page.wait_for_timeout(40)
            si = page.evaluate(SNAP)
            cdi, chi = tops_ok(si)
            samples += 1
            if not (cdi and chi):
                lag_hits += 1
            if si['cd']['d'] != 'block' or si['chip']['d'] != 'flex':
                blink += 1
        check(f'{tag}: 2-axis drag — cd+chip glued at ALL {samples} samples (<=2px)', lag_hits == 0, f'{lag_hits}/{samples} off')
        check(f'{tag}: 2-axis drag — nothing blinked off', blink == 0, blink)
        page.screenshot(path=f'{OUT}/drag2ax_{tag}.png')

        # --- horizontal-only segment: same tracking (any drag) ---
        lag_h = 0
        for i in range(5):
            x -= 10
            page.mouse.move(x, y, steps=2)
            page.wait_for_timeout(40)
            si = page.evaluate(SNAP)
            cdi, chi = tops_ok(si)
            if not (cdi and chi):
                lag_h += 1
        check(f'{tag}: horizontal drag — cd+chip still glued', lag_h == 0, f'{lag_h}/5 off')

        # --- text integrity mid-drag ---
        s2 = page.evaluate(SNAP)
        check(f'{tag}: mid-drag — cd still a valid countdown', bool(CD_FMT.match(s2['cd']['txt'] or '')), s2['cd']['txt'])
        check(f'{tag}: mid-drag — chip still the symbol name', s2['chip']['txt'] == s2['sym'], s2['chip']['txt'])

        # --- release: visible + settled, positions still glued ---
        page.mouse.up()
        page.wait_for_timeout(250)
        s3 = page.evaluate(SNAP)
        cdi, chi = tops_ok(s3)
        check(f'{tag}: after release — cd+chip still glued (no gap)', cdi and chi, f"{s3['cd']}/{s3['chip']}")
        page.wait_for_timeout(700)
        s3b = page.evaluate(SNAP)
        cdb, chb = tops_ok(s3b)
        # release glide may keep sliding the chart under the stationary cursor
        # (r53 lesson) — the labels MUST keep tracking it, so assert glued,
        # not frozen tops
        check(f'{tag}: settled — cd+chip glued (tracking the glide)', cdb and chb, f"{s3b['cd']['top']}/{s3b['chip']['top']} exp {s3b['cdExp']}/{s3b['chipExp']}")

        # drag back for the next mode
        page.mouse.move(cx, cy, steps=4)
        page.wait_for_timeout(250)

    # ---- light theme spot (cross) ----
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(300)
    sep = page.evaluate("getComputedStyle(document.querySelector('#top-toolbar')).borderBottomWidth")
    sepc = page.evaluate("getComputedStyle(document.querySelector('#top-toolbar')).borderBottomColor")
    check('light: round48 separator still 2px #ccd0da', sep == '2px' and sepc == 'rgb(204, 208, 218)', f'{sep} {sepc}')
    page.evaluate("window.__app.UI.activateTool('cross')")
    page.wait_for_timeout(150)
    page.mouse.move(cx, cy, steps=5)
    page.wait_for_timeout(300)
    s4 = page.evaluate(SNAP)
    cd4, ch4 = tops_ok(s4)
    check('light: baseline cd+chip glued', cd4 and ch4, f"{s4['cd']}/{s4['chip']}")
    page.mouse.down()
    lag_l = 0
    x, y = cx, cy
    for i in range(6):
        x -= 9
        y -= 10
        page.mouse.move(x, y, steps=2)
        page.wait_for_timeout(40)
        si = page.evaluate(SNAP)
        cdi, chi = tops_ok(si)
        if not (cdi and chi):
            lag_l += 1
    check('light: mid-drag (up-left) cd+chip glued', lag_l == 0, f'{lag_l}/6 off')
    page.screenshot(path=f'{OUT}/drag_light.png')
    page.mouse.up()
    page.wait_for_timeout(200)

    check('zero page errors', len(errors) == 0, errors[:3])
    browser.close()

fails = [r for r in results if not r[1]]
print(f"\nVERIFY ROUND54: {len(results) - len(fails)}/{len(results)} green, {len(fails)} red")
sys.exit(1 if fails else 0)
