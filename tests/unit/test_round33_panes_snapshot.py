"""Round 33 E2E suite (self-bootstrapping, same pattern as round32): watermark/brand visibility, separators, resizable
panes (drag), snapshot completeness (ind rows, separators, clipping, per-chart
logo) — in DARK and LIGHT, single and multi-chart."""
import base64, os, sys
sys.path.insert(0, '/home/z/my-project/work/app/scripts')
import e2e_helper_round32 as H
from playwright.sync_api import sync_playwright

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'scripts', 'shots33')
os.makedirs(OUT, exist_ok=True)
PASS, FAIL = [], []

def check(name, cond, extra=''):
    (PASS if cond else FAIL).append(f'{name} {extra}')
    print(('PASS' if cond else 'FAIL'), name, extra)

def geom(page):
    return page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      const wm = p.wm.getBoundingClientRect();
      const br = p.brand.getBoundingClientRect();
      const root = p.root.getBoundingClientRect();
      const splits = [...p.host.querySelectorAll('.pane-split')].map(s => ({
        top: s.offsetTop, visible: s.style.display !== 'none', w: s.clientWidth, h: s.clientHeight }));
      const subs = p._subs ? [...p._subs.values()].map(s => ({ top: s.host.offsetTop, h: s.host.clientHeight })) : [];
      return {
        wmW: wm.width, wmH: wm.height, wmTopInRoot: wm.top - root.top, wmBottomInRoot: wm.bottom - root.top,
        brandW: br.width, brandH: br.height, brandBottomInRoot: br.bottom - root.top,
        mainH: p._mainPlotH, hostH: p.host.clientHeight,
        splits, subs,
        sepColor: getComputedStyle(p.host.querySelector('.sub-pane.sub-ind')).boxShadow.slice(0, 60),
      };
    })()""")

def snap(page, name):
    url = page.evaluate("window.__app.Snapshot.capture()")
    if url:
        with open(f'{OUT}/{name}.png', 'wb') as f:
            f.write(base64.b64decode(url.split(',', 1)[1]))
    return bool(url)

with sync_playwright() as pw:
    browser, page = H.open_app(pw, headless=True)
    page.evaluate("window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'macd')")
    page.evaluate("window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'rsi')")
    page.wait_for_timeout(1200)

    g = geom(page)
    print('DARK geom:', g)
    check('dark: watermark box has height', g['wmH'] > 40, f"wmH={g['wmH']}")
    check('dark: watermark inside price pane', g['wmTopInRoot'] >= -2 and g['wmBottomInRoot'] <= g['mainH'] + 2,
          f"top={g['wmTopInRoot']:.0f} bottom={g['wmBottomInRoot']:.0f} mainH={g['mainH']}")
    check('dark: brand visible + small', 8 <= g['brandH'] <= 22 and g['brandBottomInRoot'] <= g['mainH'] + 2,
          f"h={g['brandH']} bottom={g['brandBottomInRoot']:.0f}")
    check('dark: 2 splitters present', len(g['splits']) == 2 and all(s['visible'] and s['w'] > 100 for s in g['splits']),
          str(g['splits']))
    check('dark: separator uses pane-sep', '--pane-sep' in g['sepColor'] or 'rgb(65, 70, 83)' in g['sepColor'], g['sepColor'])
    page.screenshot(path=f'{OUT}/dark_screen.png')
    check('dark: snapshot captured', snap(page, 'dark_snap'))

    # --- drag test: splitter 0 (main/MACD boundary) ---
    before = page.evaluate("window.__app.App.panes[0]._mainPlotH")
    page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      const sp = p.host.querySelectorAll('.pane-split')[0];
      const r = sp.getBoundingClientRect();
      const fire = (type, y) => document.dispatchEvent(new MouseEvent(type, {clientX: r.left + 50, clientY: y, bubbles: true, button: 0}));
      sp.dispatchEvent(new MouseEvent('mousedown', {clientX: r.left + 50, clientY: r.top + 3, bubbles: true, button: 0}));
      fire('mousemove', r.top + 3 - 120);  // drag up 120px -> MACD taller, price smaller
      fire('mouseup', r.top + 3 - 120);
    })()""")
    page.wait_for_timeout(300)
    after = page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      const subs = [...p._subs.values()].map(s => s.host.clientHeight).sort((a,b)=>a-b);
      const inst = p.indicators.find(i => i.type === 'macd');
      return { mainH: p._mainPlotH, subs, macdFrac: inst && inst.frac,
               ls: JSON.parse(localStorage.getItem('mt5_boot_panes') || 'null') };
    })()""")
    print('after drag:', after)
    check('drag: price pane shrank', after['mainH'] < before - 80, f"{before} -> {after['mainH']}")
    check('drag: macd frac persisted to localStorage',
          after['ls'] and any(i.get('frac') for i in after['ls']['panes'][0]['indicators']),
          str([i.get('frac') for i in (after['ls'] or {'panes':[{'indicators':[]}]})['panes'][0]['indicators']]))
    page.screenshot(path=f'{OUT}/dark_after_drag.png')
    snap(page, 'dark_snap_after_drag')

    # remove one indicator -> splitter count follows
    page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      const inst = p.indicators.find(i => i.type === 'rsi');
      window.__app.IndicatorsUI.remove(p, inst.id);
    })()""")
    page.wait_for_timeout(300)
    g2 = page.evaluate("(() => { const p = window.__app.App.panes[0]; return { splits: [...p.host.querySelectorAll('.pane-split')].filter(s => s.style.display !== 'none').length, subs: p._subs ? p._subs.size : 0 }; })()")
    check('remove rsi -> 1 splitter left', g2['splits'] == 1 and g2['subs'] == 1, str(g2))

    # re-add rsi for the multi-chart test
    page.evaluate("window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'rsi')")
    page.wait_for_timeout(500)

    # --- multi-chart: 2v layout -> indicators copy, each chart has own splits ---
    page.evaluate("window.__app.Manager.setLayout('2v', true)")
    page.wait_for_timeout(2500)
    m = page.evaluate("""(() => {
      const A = window.__app.App;
      return A.panes.map(p => ({
        subs: p._subs ? p._subs.size : 0,
        splits: [...p.host.querySelectorAll('.pane-split')].filter(s => s.style.display !== 'none').length,
        inds: (p.indicators || []).map(i => i.type),
      }));
    })()""")
    print('multi:', m)
    check('multi: both charts have MACD+RSI', all(x['subs'] == 2 for x in m), str(m))
    check('multi: both charts have 2 splitters', all(x['splits'] == 2 for x in m), str(m))
    page.screenshot(path=f'{OUT}/dark_multi.png')
    check('multi: snapshot captured', snap(page, 'dark_multi_snap'))

    # --- LIGHT theme ---
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(800)
    g3 = geom(page)
    print('LIGHT geom:', g3)
    check('light: watermark box has height', g3['wmH'] > 40, f"wmH={g3['wmH']}")
    check('light: watermark inside price pane', g3['wmTopInRoot'] >= -2 and g3['wmBottomInRoot'] <= g3['mainH'] + 2,
          f"top={g3['wmTopInRoot']:.0f} bottom={g3['wmBottomInRoot']:.0f}")
    check('light: brand visible + small', 8 <= g3['brandH'] <= 22, f"h={g3['brandH']}")
    check('light: separator uses pane-sep', 'rgb(184, 191, 204)' in g3['sepColor'], g3['sepColor'])
    page.screenshot(path=f'{OUT}/light_multi.png')
    check('light: snapshot captured', snap(page, 'light_multi_snap'))

    # watermark settings respect hidden mode
    page.evaluate("""(() => {
      const S = window.__app.Settings;
      S.set('wmContent', 'hidden');
    })()""")
    page.wait_for_timeout(300)
    hid = page.evaluate("window.__app.App.panes[0].wm.classList.contains('off')")
    check('wmContent=hidden hides watermark', hid)
    page.evaluate("window.__app.Settings.set('wmContent', 'ticker_interval_desc')")
    page.wait_for_timeout(200)

    # zero page errors?
    browser.close()

print(f'\n==== {len(PASS)} passed, {len(FAIL)} failed ====')
for f in FAIL: print('  FAIL:', f)
