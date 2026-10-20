import os, re, subprocess, sys, time
ROOT = '/home/z/my-project/work/mt5-round56'
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
os.chdir(ROOT)
OUT = '/home/z/my-project/work/round56-screenshots'
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
    page.wait_for_timeout(800)
    page.locator('#srv-btn').click()
    page.wait_for_selector('body > .popup .srv-row', timeout=8000)
    page.wait_for_timeout(700)
    page.screenshot(path=f'{OUT}/round56_popup_dark.png')
    page.evaluate("window.__app && __app.Theme.apply('light')")
    page.wait_for_timeout(400)
    page.screenshot(path=f'{OUT}/round56_popup_light.png')
    page.evaluate("window.__app && __app.Theme.apply('dark')")
    page.locator('body > .popup .srv-row:has-text("AE01 DC")').click()
    page.wait_for_timeout(600)
    page.screenshot(path=f'{OUT}/round56_switch_toast.png')
    browser.close()
print('shots done')
