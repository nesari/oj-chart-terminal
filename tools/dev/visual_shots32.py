"""Round 32 visual verification screenshots."""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from e2e_helper_round32 import open_app, poll, pane_js, move_mouse
from playwright.sync_api import sync_playwright

OUT = '/home/z/my-project/scripts/shots32'
os.makedirs(OUT, exist_ok=True)

with sync_playwright() as p:
    browser, page = open_app(p)
    page.wait_for_timeout(600)

    # shot 1: single chart + EMA overlay + MACD + RSI sub-panes
    page.evaluate("window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'ema')")
    page.evaluate("window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'macd')")
    page.evaluate("window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'rsi')")
    poll(page, "window.__app.App.panes[0]._subs ? window.__app.App.panes[0]._subs.size : 0", 10000, lambda v: v == 2)
    page.wait_for_timeout(900)
    move_mouse(page, 620, 260); page.wait_for_timeout(250)
    page.screenshot(path=f'{OUT}/1-single-subpanes.png')

    # shot 2: crosshair over an RSI sub-pane — per-pane labels + pill
    si = pane_js(page, """p => { const i = p.indicators.find(x => x.type==='rsi'); const s = p._subs.get(i.id); return s.host.offsetTop + 30; }""")
    move_mouse(page, 700, si); page.wait_for_timeout(250)
    page.screenshot(path=f'{OUT}/2-crosshair-subpane.png')

    # shot 3: 2v multi-chart — copies with sub-panes on both charts
    page.evaluate("window.__app.Manager.setLayout('2v', true)")
    page.wait_for_timeout(3000)
    page.screenshot(path=f'{OUT}/3-two-charts-copies.png')

    # shot 4: single chart, volume + stochastic (many panes)
    page.evaluate("window.__app.Manager.setLayout('1', true)")
    page.wait_for_timeout(2000)
    page.evaluate("window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'volume')")
    page.evaluate("window.__app.IndicatorsUI.add(window.__app.App.panes[0], 'stochastic')")
    page.wait_for_timeout(1500)
    page.screenshot(path=f'{OUT}/4-many-panes.png')

    browser.close()
    print('shots saved to', OUT)
