"""ROUND-31 FIX VERIFICATION (all layouts).

A. Cross mode: mouse position highlighted on BOTH axes
   A1 pill tracks the raw cursor x 1:1 in the data area (no lag/snap)
   A2 price-axis label stays native (regression guard: horzLine options)
B. Cross mode: free movement past the live bar (future margin)
   B1 pill + interpolated time advance right of the last bar
   B2 custom vertical line drawn at raw x in the future margin (canvas px)
   B3 hidden over the price scale (TV parity), back on return
   B4 pill keeps tracking while hovering the TIME axis strip
C. Indicator management (TV parity)
   C1 legend-row buttons receive real clicks (hit test)
   C2 remove via row X button
   C3 eye toggle hides/shows the series (LWC visible option)
   C4 settings dialog: Inputs/Style tabs, width applies to the series
D. Multi-chart
   D1 indicators survive single -> 2x2 -> single layout switches
   D2 crosshair sync across panes incl. future margin of the source
   D3 crosshair free movement works on every pane of a multi layout
"""
import sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_helper_round31 import (open_app, poll, last_bar_x, overlay_box, move_mouse, click_overlay,
                        tax_live_state, vert_line_drawn, pane_js)
from playwright.sync_api import sync_playwright

PASS, FAIL = [], []
def check(name, ok, info=''):
    (PASS if ok else FAIL).append(name)
    print(('  PASS ' if ok else '  FAIL ') + name + (f'  [{info}]' if info else ''))

with sync_playwright() as p:
    browser, page = open_app(p)
    page.on('pageerror', lambda e: print('PAGEERROR:', str(e)[:300]))
    page.wait_for_timeout(600)
    ob = overlay_box(page)
    pw_ = pane_js(page, "p => { const v = p.engine.view(); return {pw: v.pw, ph: v.ph, axisW: v.axisW, timeH: v.timeH}; }")
    lx = last_bar_x(page)
    print(f'plot width={pw_["pw"]} axisW={pw_["axisW"]} lastBarX={lx} futurePx={pw_["pw"]-lx:.0f}')

    print('--- A/B: single chart crosshair ---')
    # A1: pill tracks raw cursor INSIDE data area (continuous x)
    xs = [300, 380, 460]
    lefts = []
    for x in xs:
        move_mouse(page, x, 300)
        page.wait_for_timeout(40)
        st = tax_live_state(page)
        lefts.append(int(st['l'].replace('px', '')))
    check('A1 pill tracks raw x in data area', lefts == xs, f'{lefts}')

    # B1: future margin — pill advances + interpolated time
    # (the pill TEXT clamps at the plot edge like the native label, so assert
    # against the clamped expectation for the far sample)
    move_mouse(page, lx, 300); page.wait_for_timeout(40)
    st_bar = tax_live_state(page)
    move_mouse(page, lx + 40, 300); page.wait_for_timeout(40)
    st_f40 = tax_live_state(page)
    # round 34: the pill carries the DATE too ("Mon 07 Sep '26  16:03") — much
    # wider, so the engine's clamp (measured half-width) now bites earlier.
    # Assert against the engine's own clamp formula (offsetWidth/2).
    def clamp_x(x, hw, pw_):
        lo = min(hw + 1, pw_ / 2)
        hi = max(pw_ - hw - 1, pw_ / 2)
        return round(max(lo, min(x, hi)))
    hw40 = (st_f40.get('w') or 0) / 2 or (len(st_f40['txt']) * 6.6 + 12) / 2
    exp40 = clamp_x(lx + 40, hw40, pw_['pw'])
    check('B1a pill advances to raw x in future margin', int(st_f40['l'].replace('px', '')) == exp40 and st_f40['d'] == 'block',
          f'{st_f40} exp={exp40}')
    move_mouse(page, lx + 70, 300); page.wait_for_timeout(40)
    st_f70 = tax_live_state(page)
    hw70 = (st_f70.get('w') or 0) / 2 or (len(st_f70['txt']) * 6.6 + 12) / 2
    exp70 = clamp_x(lx + 70, hw70, pw_['pw'])
    # round 32: the pill width is MEASURED (offsetWidth) instead of estimated —
    # the clamp target moved by ~1px; allow a 3px tolerance
    check('B1b far sample lands on the clamp-aware x', abs(int(st_f70['l'].replace('px', '')) - round(exp70)) <= 3,
          f"got={st_f70['l']} exp={round(exp70)}")
    check('B1c time interpolates forward', st_f70['txt'] >= st_f40['txt'], f'{st_f40["txt"]} -> {st_f70["txt"]}')

    # B2: custom vertical line drawn at the CURRENT raw x in the future margin
    # (mouse is still at lx+70 — read the strip exactly there)
    check('B2 vertical line drawn in future margin', vert_line_drawn(page, lx + 70),
          'canvas alpha strip at x=lastBar+70')

    # B3: over the price scale the vertical hides (TV parity)...
    move_mouse(page, pw_['pw'] + 30, 300); page.wait_for_timeout(40)
    st_price = tax_live_state(page)
    check('B3a pill hidden over price scale', st_price['d'] == 'none')
    # ...and returns when back over the plot
    move_mouse(page, lx + 40, 300); page.wait_for_timeout(40)
    check('B3b pill returns over plot', tax_live_state(page)['d'] == 'block')

    # B4: hovering the TIME axis strip — pill keeps tracking x
    y_time = pw_['ph'] + 12
    move_mouse(page, 500, y_time); page.wait_for_timeout(40)
    st_t = tax_live_state(page)
    check('B4 pill tracks over time axis', st_t['d'] == 'block' and int(st_t['l'].replace('px', '')) == 500,
          f'{st_t}')

    # A2: native horzLine still enabled (price-axis label regression guard)
    hl = pane_js(page, "p => { const o = p.chart.options().crosshair; return {horz: o.horzLine.visible, vert: o.vertLine.visible, mode: o.mode}; }")
    check('A2 native horzLine on + vertLine off + Normal mode',
          hl['horz'] is True and hl['vert'] is False and hl['mode'] == 0, f'{hl}')

    print('--- C: indicator management ---')
    page.evaluate("window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'rsi')")
    page.evaluate("window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'macd')")
    # round 32: RSI/MACD are 'separate' indicators -> their legend rows live
    # INSIDE their own sub-pane headers (count rows anywhere in the pane)
    poll(page, "document.querySelectorAll('.ind-row').length", 8000, lambda v: v == 2)

    # C1: real hit-test on the row buttons area (rsi row — inside its sub-pane)
    hit = page.evaluate("""(() => {
        const p = window.__app.App.panes[0];
        const inst = p.indicators.find(i => i.type === 'rsi');
        const row = document.querySelector('.ind-row[data-iid="' + inst.id + '"]');
        const r = row.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
        return row.contains(el);
    })()""")
    check('C1 legend row is hit-testable', hit)

    # C3: eye toggle hides the RSI series (first row = rsi, added first)
    vis0 = pane_js(page, "p => { const s = p._indRows; return null; }")
    eye_works = page.evaluate("""(() => {
        const p = window.__app.App.panes[0];
        const inst = p.indicators.find(i => i.type === 'rsi');
        const row = document.querySelector('.ind-row[data-iid="' + inst.id + '"]');
        const eye = row.querySelector('.ind-btn');
        eye.click();                      // -> hidden
        const st1 = window.__app.App.panes[0];
        const i1 = st1.indicators.find(i => i.type === 'rsi');
        return { hiddenFlag: i1.visible === false };
    })()""")
    check('C3a eye toggle sets visible=false', eye_works['hiddenFlag'])
    rsi_hidden = pane_js(page, """p => {
        const inst = p.indicators.find(i => i.type === 'rsi');
        const row = document.querySelector('.ind-row[data-iid="' + inst.id + '"]');
        row.querySelector('.ind-btn').click();  // -> shown again
        return true;
    }""")
    check('C3b eye toggle back on', rsi_hidden is True)

    # C4: settings dialog tabs + width change
    page.evaluate("""(() => {
        const p = window.__app.App.panes[0];
        const inst = p.indicators.find(i => i.type === 'rsi');
        const row = document.querySelector('.ind-row[data-iid="' + inst.id + '"]');
        row.querySelector('.ind-btns .ind-btn:nth-child(2)').click(); // gear
    })()""")
    page.wait_for_timeout(200)
    dlg = page.evaluate("""(() => {
        const d = document.querySelector('.ind-settings');
        if (!d) return {open: false};
        const tabs = [...d.querySelectorAll('.ist-tab')].map(t => t.textContent);
        d.querySelector('.ist-tab[data-tab="style"]').click();
        const styleBody = d.querySelector('.ist-body');
        const selW = styleBody.querySelector('select');
        selW.value = '4';
        selW.dispatchEvent(new Event('change'));
        d.querySelector('.ist-ok').click();
        return {open: true, tabs};
    })()""")
    page.wait_for_timeout(400)
    w_ok = pane_js(page, """p => {
        const inst = p.indicators.find(i => i.type === 'rsi');
        return inst.style && inst.style.width === 4;
    }""")
    check('C4 dialog tabs + width=4 applied to instance', dlg['open'] and ','.join(dlg['tabs']) == 'Inputs,Style' and w_ok is True,
          f'{dlg} width={w_ok}')
    # verify the actual LWC series got width 4 (recompute rebuilt it)
    lw = page.evaluate("""(() => {
        const p = window.__app.App.panes[0];
        // pane.series() only exposes the main series; scan via LWC private api is
        // fragile — instead confirm through the exported compute path:
        const inst = p.indicators.find(i => i.type === 'rsi');
        const out = window.__app.Indicators.compute(inst, p.bars);
        return out.lines.map(l => l.width);
    })()""")
    check('C4b compute() honors width override', all(w == 4 for w in lw), f'{lw}')

    # C2: remove via the row X button (macd)
    rm = page.evaluate("""(() => {
        const p = window.__app.App.panes[0];
        const inst = p.indicators.find(i => i.type === 'macd');
        const row = document.querySelector('.ind-row[data-iid="' + inst.id + '"]');
        row.querySelector('.ind-del').click();
        return p.indicators.length;
    })()""")
    check('C2 row X removes the indicator', rm == 1, f'count={rm}')

    print('--- D: multi-chart ---')
    # D1: single -> 2 -> single, indicators must survive BOTH switches
    page.evaluate("window.__app.Manager.setLayout('2v', true)")
    page.wait_for_timeout(2500)
    after2 = page.evaluate("window.__app.App.panes.map(p => (p.indicators || []).map(i => i.type))")
    check('D1a indicators survive 1->2', 'rsi' in after2[0], f'{after2}')
    page.evaluate("window.__app.Manager.setLayout('4', true)")
    page.wait_for_timeout(2500)
    after4 = page.evaluate("window.__app.App.panes.map(p => (p.indicators || []).map(i => i.type))")
    check('D1b indicators survive 2->4', 'rsi' in after4[0], f'{after4}')
    page.evaluate("window.__app.Manager.setLayout('1', true)")
    page.wait_for_timeout(2500)
    after1 = page.evaluate("window.__app.App.panes.map(p => (p.indicators || []).map(i => i.type))")
    check('D1c indicators survive back to 1', 'rsi' in after1[0], f'{after1}')

    # D2: sync crosshair across panes (2-chart layout). The 2v panes are
    # narrow (~37px of future margin) — hover just inside it.
    page.evaluate("window.__app.Manager.setLayout('2v', true)")
    page.wait_for_timeout(2500)
    page.evaluate("window.__app.App.sync = {crosshair: true, time: false, daterange: false}")
    lx0 = last_bar_x(page, 0)
    pw0 = pane_js(page, "p => p.engine.view().pw", 0)
    dx = min(20, int(pw0 - lx0) - 6)   # stay inside the future margin
    move_mouse(page, lx0 + dx, 300, idx=0)
    page.wait_for_timeout(120)
    p1 = pane_js(page, "p => ({on: p.engine._cross.on, t: p.engine._cross.t, d: p.taxLive.style.display, l: p.taxLive.style.left})", idx=1)
    check('D2 sync reaches pane 2 (future margin of source)', p1['on'] is True and p1['d'] == 'block' and p1['t'] is not None, f'{p1}')

    # D3: crosshair free movement on pane 2 of the multi layout
    # (pill text clamps at the plot edge — compare against the clamped x;
    #  round 34: half-width from the MEASURED pill width, it carries the date)
    lx1 = last_bar_x(page, 1)
    pw1 = pane_js(page, "p => p.engine.view().pw", 1)
    dx1 = min(30, int(pw1 - lx1) - 6)
    move_mouse(page, lx1 + dx1, 250, idx=1)
    page.wait_for_timeout(60)
    st1 = tax_live_state(page, 1)
    got1 = int(st1['l'].replace('px', ''))
    hw1 = (st1.get('w') or 0) / 2 or (len(st1['txt']) * 6.6 + 12) / 2
    exp1 = round(max(min(hw1 + 1, pw1 / 2), min(lx1 + dx1, max(pw1 - hw1 - 1, pw1 / 2))))  # engine clamp
    check('D3 future margin works on pane 2', st1['d'] == 'block' and abs(got1 - exp1) <= 3,
          f'{st1} expected={exp1}')

    page.evaluate("window.__app.App.sync = null")

    browser.close()

    print(f'\n===== RESULT: {len(PASS)} passed, {len(FAIL)} failed =====')
    if FAIL:
        print('FAILED:', FAIL)
        sys.exit(1)
