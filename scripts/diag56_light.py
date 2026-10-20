import os, re, subprocess, sys, time
ROOT = '/home/z/my-project/work/mt5-round56'
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
os.chdir(ROOT)
from playwright.sync_api import sync_playwright
from e2e_helper_round32 import BASE, poll

subprocess.run(['pkill', '-f', 'provider/demo.py'], capture_output=True); time.sleep(0.8)
subprocess.Popen([sys.executable, 'provider/demo.py'], stdout=subprocess.DEVNULL,
                 stderr=subprocess.DEVNULL, cwd=ROOT, start_new_session=True)
time.sleep(2.2)
with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1500, 'height': 900})
    page.goto(BASE)
    page.evaluate("try { localStorage.clear(); } catch (e) {}")
    page.reload()
    page.wait_for_selector('#login-screen', timeout=10000)
    page.click('#card-demo'); page.click('#login-connect')
    page.wait_for_selector('#app:not(.hidden)', timeout=20000)
    poll(page, "window.__app ? window.__app.App.panes.length : 0", 20000, lambda v: v >= 1)
    poll(page, "(window.__app.App.panes[0].bars || []).length", 30000, lambda v: v > 100)
    page.evaluate("window.__app && __app.Theme.apply('light')")
    page.wait_for_timeout(300)
    print('srv-btn visible:', page.locator('#srv-btn').is_visible())
    page.locator('#srv-btn').click()
    page.wait_for_timeout(300)
    print('popup count:', page.evaluate("document.querySelectorAll('body > .popup').length"))
    print('popup html head:', re.sub(r'<svg.*?</svg>', '<SVG/>', page.evaluate("(document.querySelector('body > .popup')||{}).outerHTML || 'NONE'"), flags=re.S)[:300])
    print('rows:', page.evaluate("document.querySelectorAll('body > .popup .srv-row').length"))
    page.wait_for_timeout(2600)
    print('rows after scan:', page.evaluate("document.querySelectorAll('body > .popup .srv-row').length"))
    print('popup box:', page.evaluate("(() => { const p = document.querySelector('body > .popup'); if (!p) return null; const r = p.getBoundingClientRect(); return {top: r.top, left: r.left, h: r.height, w: r.width}; })()"))
    print('row1 visible:', page.locator('body > .popup .srv-row').first.is_visible())
    browser.close()
