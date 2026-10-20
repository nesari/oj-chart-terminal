#!/usr/bin/env python3
"""ROUND61 screenshots — the gannelliott flyout as the exact TradingView mirror:
(1) flyout open (dark): CHART PATTERNS / ELLIOTT WAVES / CYCLES, 14 rows,
    zigzag toolbar glyph; (2) the three new CYCLES tools drawn on the chart;
    (3) light-theme flyout spot."""
import os, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
os.chdir(ROOT)
OUT = os.path.join(ROOT, '..', '..', 'work', 'shots61')
os.makedirs(OUT, exist_ok=True)

subprocess.run(['pkill', '-f', 'provider/demo.py'], capture_output=True)
time.sleep(0.8)
prov = subprocess.Popen([sys.executable, 'provider/demo.py'],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        cwd=ROOT, start_new_session=True)
time.sleep(2.2)

from playwright.sync_api import sync_playwright
from e2e_helper_round32 import BASE, poll

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1500, 'height': 900})
    page.goto(BASE)
    page.evaluate("try { localStorage.clear(); } catch (e) {}")
    page.reload()
    page.wait_for_selector('#login-screen', timeout=10000)
    page.click('#card-demo')
    page.click('#login-connect')
    page.wait_for_selector('#app:not(.hidden)', timeout=20000)
    poll(page, "window.__app ? window.__app.App.panes.length : 0", 20000, lambda v: v >= 1)
    poll(page, "(window.__app.App.panes[0].bars || []).length", 30000, lambda v: v > 100)
    page.wait_for_timeout(800)

    # 1) dark: the flyout open — TV mirror
    page.click('.lt-btn[data-group="gannelliott"]')
    page.wait_for_timeout(350)
    page.screenshot(path=os.path.join(OUT, 'round61_flyout_dark.png'))
    page.evaluate("() => window.__app.UI.closeFlyout && window.__app.UI.closeFlyout()")
    page.wait_for_timeout(150)

    # helper to arm a tool from the flyout by visible name
    arm = """(nm) => { const fl = document.querySelector('.lt-flyout');
      [...fl.querySelectorAll('.lt-tile')].find(t => t.textContent.trim().startsWith(nm)).click(); }"""
    drawpts = """([pts]) => new Promise((res) => {
      const pane = window.__app.App.panes[0]; const cv = pane.overlay;
      const r = cv.getBoundingClientRect(); let i = 0;
      const fire = () => { if (i >= pts.length) { res(1); return; }
        const [fx, fy] = pts[i++];
        const x = r.x + r.width * fx, y = r.y + r.height * fy;
        cv.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
        cv.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
        setTimeout(fire, 90); };
      setTimeout(fire, 120); })"""

    # 2) dark: all three Cycles tools on one chart
    for nm, pts in [('Cyclic lines', [[0.06, 0.30], [0.20, 0.60]]),
                    ('Time cycles', [[0.30, 0.35], [0.38, 0.52], [0.46, 0.35]]),
                    ('Sine line', [[0.55, 0.62], [0.78, 0.30]])]:
        page.click('.lt-btn[data-group="gannelliott"]')
        page.wait_for_timeout(250)
        page.evaluate(arm, nm)
        page.wait_for_timeout(150)
        page.evaluate(drawpts, [pts])
        page.wait_for_timeout(200)
    page.evaluate("() => { window.__app.App.tool = 'cross'; window.__app.UI.refreshArmed && window.__app.UI.refreshArmed(); }")
    page.wait_for_timeout(400)
    page.screenshot(path=os.path.join(OUT, 'round61_cycles_drawn_dark.png'))

    # 3) light theme: flyout spot
    page.evaluate("() => window.__app.Theme.apply('light')")
    page.wait_for_timeout(300)
    page.click('.lt-btn[data-group="gannelliott"]')
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(OUT, 'round61_flyout_light.png'))
    page.evaluate("() => window.__app.UI.closeFlyout && window.__app.UI.closeFlyout()")
    page.evaluate("() => window.__app.Theme.apply('dark')")

    browser.close()
print('shots61 done ->', OUT)
