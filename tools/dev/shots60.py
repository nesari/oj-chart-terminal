#!/usr/bin/env python3
"""ROUND 60 delivery screenshots — draw sample new tools on the chart."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from e2e_helper_round32 import open_app  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = '/home/z/my-project/work/shots60-verify'
os.makedirs(OUT, exist_ok=True)

def draw_tool(page, pane_idx, fxys):
    return page.evaluate("""([idx, pts]) => new Promise((res) => {
      const App = window.__app.App;
      const pane = App.panes[idx];
      const cv = pane.overlay;
      const r = cv.getBoundingClientRect();
      let i = 0;
      const fire = () => {
        if (i >= pts.length) { res(true); return; }
        const [fx, fy] = pts[i++];
        const x = r.x + r.width * fx, y = r.y + r.height * fy;
        cv.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
        cv.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
        setTimeout(fire, 90);
      };
      setTimeout(fire, 120);
    })""", [pane_idx, fxys])

PICK = """(nm) => { const fl = document.querySelector('.lt-flyout');
  [...fl.querySelectorAll('.lt-tile')].find(t => t.textContent.trim().startsWith(nm)).click(); }"""

with sync_playwright() as pw:
    browser, page = open_app(pw)
    page.wait_for_timeout(400)

    # shot 3: fib time zone + speed resistance fan
    page.click('.lt-btn[data-group="fibs"]'); page.wait_for_timeout(200)
    page.evaluate(PICK, 'Fib Time Zone'); page.wait_for_timeout(120)
    draw_tool(page, 0, [[0.16, 0.55], [0.28, 0.62]])
    page.click('.lt-btn[data-group="fibs"]'); page.wait_for_timeout(200)
    page.evaluate(PICK, 'Fib Speed Resistance Fan'); page.wait_for_timeout(120)
    draw_tool(page, 0, [[0.20, 0.62], [0.46, 0.38]])
    page.evaluate("() => { window.__app.App.tool = 'cross'; window.__app.UI.refreshArmed(); }")
    page.wait_for_timeout(400)
    page.screenshot(path=f'{OUT}/03-fibtz-fan-chart.png')

    # shot 4: spiral + wedge + pitchfan
    page.evaluate("([s]) => window.__app.App.drawings.removeAll(s)", [page.evaluate("() => window.__app.App.panes[0].symbol")])
    page.click('.lt-btn[data-group="fibs"]'); page.wait_for_timeout(200)
    page.evaluate(PICK, 'Fib Spiral'); page.wait_for_timeout(120)
    draw_tool(page, 0, [[0.38, 0.52], [0.50, 0.42]])
    page.click('.lt-btn[data-group="fibs"]'); page.wait_for_timeout(200)
    page.evaluate(PICK, 'Fib Wedge'); page.wait_for_timeout(120)
    draw_tool(page, 0, [[0.58, 0.66], [0.86, 0.38], [0.70, 0.70]])
    page.click('.lt-btn[data-group="fibs"]'); page.wait_for_timeout(200)
    page.evaluate(PICK, 'Pitchfan'); page.wait_for_timeout(120)
    draw_tool(page, 0, [[0.12, 0.30], [0.30, 0.55], [0.52, 0.28]])
    page.evaluate("() => { window.__app.App.tool = 'cross'; window.__app.UI.refreshArmed(); }")
    page.wait_for_timeout(400)
    page.screenshot(path=f'{OUT}/04-spiral-wedge-pitchfan.png')

    browser.close()
print('shots done')
