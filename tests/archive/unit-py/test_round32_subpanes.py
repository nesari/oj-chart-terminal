"""ROUND-32 FIX VERIFICATION (TradingView-parity indicators + pill + copy).

A. Time-axis crosshair highlight (user: "highlight sometimes huge, sometimes small")
   A1 pill width CONSTANT while the cursor sweeps the chart
   A2 pill compact (hugs its text, never spans to the plot edges)
   A3 pill vertically centered in the axis strip (compact height)
B. Single -> Multi indicator copy (user: indicators must appear on the other
   charts of the same symbol, then be managed independently)
   B1 1 -> 2v copies every indicator to the new same-symbol chart
   B2 copies are independent (edit params on the copy, source untouched)
   B3 remove on the copy, source keeps its instance
   B4 multi -> single: source indicators intact
C. TRUE sub-panes (user: MACD/RSI must be separate panes below the price
   chart with their own axis, like TradingView — not squeezed into it)
   C1 MACD creates a real sub-pane with its OWN lightweight-charts instance
   C2 price chart wrapper crops its native axis (canvas taller than wrapper)
   C3 MACD legend row lives INSIDE its sub-pane header
   C4 sub-chart mirrors the main chart's visible logical range
   C5 hover over the sub-pane -> ITS axis shows the crosshair price label
      (and the main chart's one is gone)
   C6 hover back over the price pane -> main label returns, sub cleared
   C7 price-axis widths aligned across main + sub (TV look)
   C8 eye toggle: series hidden, sub-pane REMAINS (TV keeps the pane)
   C9 remove via row X -> sub-pane removed from the stack
   C10 Volume gets its own pane (separate-mode indicator)
   C11 two oscillators stack (main plot shrinks, both subs have height)
   C12 engine vertical crosshair spans the sub-pane region too
"""
import sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from e2e_helper_round32 import (open_app, poll, pane_js, move_mouse, sub_info,
                        axis_width, logical_range, has_crosshair_label_px, overlay_alpha_at)
from playwright.sync_api import sync_playwright

PASS, FAIL = [], []
def check(name, ok, info=''):
    (PASS if ok else FAIL).append(name)
    print(('  PASS ' if ok else '  FAIL ') + name + (f'  [{info}]' if info else ''))

with sync_playwright() as p:
    browser, page = open_app(p)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)[:200]))
    page.wait_for_timeout(600)

    print('--- A: time-axis pill sizing ---')
    pw_ = pane_js(page, "p => { const v = p.engine.view(); return {pw: v.pw, ph: v.ph, timeH: v.timeH}; }")
    widths = []
    for x in [200, 500, 800]:
        move_mouse(page, x, 300); page.wait_for_timeout(50)
        w = pane_js(page, "p => p.taxLive.offsetWidth")
        d = pane_js(page, "p => p.taxLive.style.display")
        if d != 'block': w = -1
        widths.append(w)
    check('A1 pill width constant across cursor positions',
          widths[0] > 0 and widths[0] == widths[1] == widths[2], f'{widths}')
    check('A2 pill compact (not stretched to the plot edges)', 0 < widths[0] < 200, f'w={widths[0]} pw={pw_["pw"]}')
    h = pane_js(page, "p => p.taxLive.offsetHeight")
    check('A3 pill compact height, centered in the strip', 0 < h <= pw_['timeH'], f'h={h} timeH={pw_["timeH"]}')

    print('--- B: single -> multi indicator copy ---')
    page.evaluate("window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'rsi')")
    page.evaluate("window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'ema')")
    poll(page, "window.__app.App.panes[0].indicators.length", 8000, lambda v: v == 2)
    # customize the RSI length so B2 can verify independence
    page.evaluate("""(() => {
        const p = window.__app.App.panes[0];
        const inst = p.indicators.find(i => i.type === 'rsi');
        inst.params.length = 21;
        window.__app.Manager.persistPanes();
        window.__app.Manager.recomputeIndicators(p);
    })()""")
    page.evaluate("window.__app.Manager.setLayout('2v', true)")
    page.wait_for_timeout(2500)
    types2 = page.evaluate("window.__app.App.panes.map(pp => (pp.indicators || []).map(i => i.type).sort())")
    check('B1 1->2v copies indicators to the new chart',
          len(types2) == 2 and types2[0] == ['ema', 'rsi'] and types2[1] == ['ema', 'rsi'], f'{types2}')
    lens = page.evaluate("window.__app.App.panes.map(pp => (pp.indicators.find(i => i.type === 'rsi') || {}).params ? pp.indicators.find(i => i.type === 'rsi').params.length : null)")
    check('B1b copies carry the params', lens == [21, 21], f'{lens}')
    # B2: edit the COPY on pane 1 — pane 0 must stay at 21
    page.evaluate("""(() => {
        const p = window.__app.App.panes[1];
        const inst = p.indicators.find(i => i.type === 'rsi');
        inst.params.length = 9;
        window.__app.Manager.recomputeIndicators(p);
    })()""")
    lens2 = page.evaluate("window.__app.App.panes.map(pp => pp.indicators.find(i => i.type === 'rsi').params.length)")
    check('B2 copies are independent (pane1 len=9, pane0 len=21)', lens2 == [21, 9], f'{lens2}')
    # B3: remove rsi on pane 1 — pane 0 keeps it
    page.evaluate("""(() => {
        const p = window.__app.App.panes[1];
        const inst = p.indicators.find(i => i.type === 'rsi');
        window.__app.IndicatorsUI.remove(p, inst.id);
    })()""")
    t3 = page.evaluate("window.__app.App.panes.map(pp => (pp.indicators || []).map(i => i.type).sort())")
    check('B3 removed on the copy only', t3[0] == ['ema', 'rsi'] and t3[1] == ['ema'], f'{t3}')
    # B4: back to single — source still has both
    page.evaluate("window.__app.Manager.setLayout('1', true)")
    page.wait_for_timeout(2000)
    t4 = page.evaluate("window.__app.App.panes.map(pp => (pp.indicators || []).map(i => i.type).sort())")
    check('B4 2v->1 keeps the source indicators', t4 == [['ema', 'rsi']], f'{t4}')

    print('--- C: true sub-panes (TV parity) ---')
    page.evaluate("window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'macd')")
    poll(page, "(() => { const p = window.__app.App.panes[0]; const i = (p.indicators||[]).find(x => x.type==='macd'); return !!(i && p._subs && p._subs.get(i.id)); })()",
         8000, lambda v: v is True)
    page.wait_for_timeout(400)

    si = sub_info(page, 'macd')
    check('C1 MACD gets its own sub-pane + own LWC chart', si.get('exists') and si.get('chartEl'), f'{si}')
    crop = pane_js(page, """p => {
        const wrap = p.mainWrap;
        const chartEl = wrap.querySelector('.tv-lightweight-charts');
        return { wrapH: wrap.clientHeight, chartH: chartEl ? chartEl.clientHeight : 0 };
    }""")
    check('C2 main chart canvas cropped (+axis) when subs exist',
          crop['chartH'] > crop['wrapH'] + 10, f'{crop}')
    check('C3 MACD row lives inside the sub-pane header', si.get('rowInSub') and si.get('rows') == 1, f'{si}')

    # C4: sub mirrors the main visible range
    page.evaluate("""(() => {
        const p = window.__app.App.panes[0];
        const n = p.barTimes.length;
        p.chart.timeScale().setVisibleLogicalRange({ from: n - 120, to: n + 8 });
    })()""")
    page.wait_for_timeout(300)
    lm = logical_range(page, 'main')
    ls = logical_range(page, 'sub', 'macd')
    check('C4 sub-chart mirrors the main range',
          abs(lm['f'] - ls['f']) < 0.6 and abs(lm['t'] - ls['t']) < 0.6, f'main={lm} sub={ls}')

    # C5: hover over the sub-pane -> crosshair label on ITS axis, none on main
    st0 = has_crosshair_label_px(page, 'macd')
    top = si['top']
    move_mouse(page, 400, top + 25); page.wait_for_timeout(150)
    st1 = has_crosshair_label_px(page, 'macd')
    main_lbl = pane_js(page, """p => {
        const tds = p.mainWrap.querySelectorAll('.tv-lightweight-charts td');
        if (tds.length < 3) return -1;
        const cvs = tds[2].querySelectorAll('canvas');
        const cv = cvs[cvs.length - 1];
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let f = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (Math.abs(d[i]-54) < 6 && Math.abs(d[i+1]-58) < 6 && Math.abs(d[i+2]-69) < 6 && d[i+3] > 200) f++;
        }
        return f;
    }""")
    check('C5 sub-pane shows its own crosshair price label',
          st0.get('ok') and st0['found'] == 0 and st1.get('ok') and st1['found'] > 0, f'before={st0} after={st1}')
    check('C5b main price label cleared while over the sub-pane', main_lbl == 0, f'mainLabelPx={main_lbl}')

    # C6: hover back on the price pane — main label returns, sub cleared
    move_mouse(page, 400, 250); page.wait_for_timeout(150)
    st2 = has_crosshair_label_px(page, 'macd')
    main_lbl2 = pane_js(page, """p => {
        const tds = p.mainWrap.querySelectorAll('.tv-lightweight-charts td');
        if (tds.length < 3) return -1;
        const cvs = tds[2].querySelectorAll('canvas');
        const cv = cvs[cvs.length - 1];
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let f = 0;
        for (let i = 0; i < d.length; i += 4) {
            if (Math.abs(d[i]-54) < 6 && Math.abs(d[i+1]-58) < 6 && Math.abs(d[i+2]-69) < 6 && d[i+3] > 200) f++;
        }
        return f;
    }""")
    check('C6 price pane label returns + sub label cleared', st2.get('ok') and st2['found'] == 0 and main_lbl2 > 0,
          f'sub={st2} main={main_lbl2}')

    # C7: axis widths aligned
    aw_m = axis_width(page, 'main')
    aw_s = axis_width(page, 'sub', 'macd')
    check('C7 axis widths aligned (main == sub)', abs(aw_m - aw_s) <= 2, f'main={aw_m} sub={aw_s}')

    # C8: eye toggle hides the series but KEEPS the pane
    eye = page.evaluate("""(() => {
        const p = window.__app.App.panes[0];
        const inst = p.indicators.find(i => i.type === 'macd');
        const row = document.querySelector('.ind-row[data-iid="' + inst.id + '"]');
        row.querySelector('.ind-btn').click();
        return inst.visible;
    })()""")
    page.wait_for_timeout(300)
    si8 = sub_info(page, 'macd')
    check('C8 eye toggle: hidden flag + sub-pane kept', eye is False and si8.get('exists'), f'visible={eye} sub={si8.get("exists")}')

    # C9: remove -> sub-pane gone (RSI + Volume subs remain)
    page.evaluate("""(() => {
        const p = window.__app.App.panes[0];
        const inst = p.indicators.find(i => i.type === 'macd');
        window.__app.IndicatorsUI.remove(p, inst.id);
    })()""")
    page.wait_for_timeout(400)
    n9 = pane_js(page, "p => p._subs ? p._subs.size : 0")
    check('C9 remove drops the sub-pane', n9 == 1, f'subs={n9}')

    # C10: Volume also gets its own pane (separate-mode indicator)
    page.evaluate("window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'volume')")
    poll(page, "(() => { const p = window.__app.App.panes[0]; const i = (p.indicators||[]).find(x => x.type==='volume'); return !!(i && p._subs && p._subs.get(i.id)); })()",
         8000, lambda v: v is True)
    sv = sub_info(page, 'volume')
    check('C10 Volume gets its own sub-pane', sv.get('exists') and sv.get('chartEl') and sv.get('rowInSub'), f'{sv}')

    # C11: add Stochastic too -> two NEW sub-panes total 3, main plot shrinks
    page.evaluate("window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'stochastic')")
    poll(page, "(() => { const p = window.__app.App.panes[0]; const i = (p.indicators||[]).find(x => x.type==='stochastic'); return !!(i && p._subs && p._subs.get(i.id)); })()",
         8000, lambda v: v is True)
    page.wait_for_timeout(400)
    s_stoch = sub_info(page, 'stochastic')
    s_vol = sub_info(page, 'volume')
    stacked = pane_js(page, "p => ({mainH: p._mainPlotH, ph: p.engine.view().ph, subs: p._subs.size})")
    check('C11a three sub-panes stack, main plot shrinks',
          stacked['subs'] == 3 and stacked['mainH'] < stacked['ph'] and stacked['mainH'] > 80, f'{stacked}')
    check('C11b sub-panes have height + header row',
          s_stoch.get('wrapH', 0) > 30 and s_vol.get('wrapH', 0) > 30 and s_stoch.get('rows') == 1 and s_vol.get('rows') == 1,
          f'stoch={s_stoch.get("wrapH")},vol={s_vol.get("wrapH")},rows={s_stoch.get("rows")},{s_vol.get("rows")}')

    # C12: engine vertical crosshair spans a sub-pane region
    move_mouse(page, 500, s_stoch['top'] + 20); page.wait_for_timeout(120)
    span = overlay_alpha_at(page, 500, s_stoch['top'] + 5, s_stoch['top'] + s_stoch['wrapH'] - 5)
    check('C12 vertical crosshair spans the sub-pane', span is True)

    # layout survival with sub-panes: 1 -> 2v -> 1
    page.evaluate("window.__app.Manager.setLayout('2v', true)")
    page.wait_for_timeout(2200)
    both = page.evaluate("window.__app.App.panes.map(pp => (pp.indicators || []).map(i => i.type).sort())")
    check('C13 sub-pane indicators copy to 2v correctly',
          both[0] == ['ema', 'rsi', 'stochastic', 'volume'] and both[1] == ['ema', 'rsi', 'stochastic', 'volume'], f'{both}')
    subs2 = page.evaluate("window.__app.App.panes.map(pp => pp._subs ? pp._subs.size : -1)")
    check('C13b both charts built their sub-panes', subs2 == [3, 3], f'{subs2}')

    check('NO page errors during the whole suite', len(errors) == 0, f'{errors[:3]}')

    browser.close()
    print(f'\n===== RESULT: {len(PASS)} passed, {len(FAIL)} failed =====')
    if FAIL:
        print('FAILED:', FAIL)
        sys.exit(1)
