"""ROUND35 final visual gallery: all 6 fixes, dark + light."""
import base64, os, subprocess, sys, time
subprocess.run(['pkill', '-f', 'provider/demo.py'], capture_output=True)
subprocess.run(['pkill', '-f', 'demo_mt5sim.py'], capture_output=True)
time.sleep(0.8)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_helper_round32 as H
from playwright.sync_api import sync_playwright

OUT = '/home/z/my-project/work/app/scripts/shots35'
os.makedirs(OUT, exist_ok=True)

with sync_playwright() as pw:
    browser, page = H.open_app(pw)

    # custom TFs so the menu shows mixed default/custom rows
    page.evaluate("() => { window.__app.App.addCustomTf(7, 'm'); window.__app.App.addCustomTf(6, 'h'); }")
    page.wait_for_timeout(200)

    # ---- 1: TF menu (dark) with aligned star/trash ----
    page.click('#tf-menu-btn')
    page.wait_for_timeout(400)
    page.locator('#tf-menu').screenshot(path=f'{OUT}/01-tf-menu-dark.png')

    # ---- 2: delete keeps menu open ----
    page.evaluate("""(() => {
      const m = document.getElementById('tf-menu');
      for (const it of m.querySelectorAll('.tf-group-items .pu-item'))
        if (it.querySelector('span').textContent === '7m') { it.querySelector('.pu-trash').click(); break; }
    })()""")
    page.wait_for_timeout(400)
    open_now = page.evaluate("() => !!document.getElementById('tf-menu')")
    print('menu open after delete:', open_now)
    page.locator('#tf-menu').screenshot(path=f'{OUT}/02-tf-menu-after-delete.png')
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)

    # ---- 3: compare on chart + legend chip ----
    page.evaluate("() => window.__app.Compare.add(window.__app.App.panes[0], 'GBPUSD')")
    page.wait_for_timeout(1500)
    page.screenshot(path=f'{OUT}/03-compare-chart.png')

    # compare popup with existing rows + search
    page.click('#compare-btn')
    page.wait_for_timeout(300)
    page.fill('.cmp-search', 'jpy')
    page.wait_for_timeout(700)
    page.locator('.popup').screenshot(path=f'{OUT}/04-compare-popup.png')
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)

    # ---- 4: vline date tag (M5) ----
    page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      const lr = p.chart.timeScale().getVisibleLogicalRange();
      const i = Math.max(0, Math.min(p.bars.length - 1, Math.round((lr.from + lr.to) / 2)));
      const b = p.bars[i];
      window.__app.App.drawings.add(p.symbol, { type: 'vline', points: [{ t: b.time, p: b.close }], opts: window.__app.App.drawings.defaultOpts('vline') });
    })()""")
    page.wait_for_timeout(700)
    page.screenshot(path=f'{OUT}/05-vline-date-tag.png')
    # zoomed crop of the time axis area
    page.evaluate("""(() => {
      const p = window.__app.App.panes[0];
      const r = p.overlay.getBoundingClientRect();
      window.__r = { x: r.left, y: r.top, w: r.width, h: r.height };
    })()""")
    r = page.evaluate("() => window.__r")
    page.screenshot(path=f'{OUT}/06-vline-tag-zoom.png',
                    clip={'x': r['x'] + r['w'] / 2 - 220, 'y': r['y'] + r['h'] - 60, 'width': 440, 'height': 60})

    # ---- 5: lowercase search in the symbol dialog ----
    page.keyboard.press('Escape')
    page.click('#symbol-btn')
    page.wait_for_timeout(400)
    page.fill('#sym-search-input', 'xau')
    page.wait_for_timeout(700)
    page.screenshot(path=f'{OUT}/07-search-lowercase.png', clip={'x': 380, 'y': 140, 'width': 720, 'height': 620})
    page.keyboard.press('Escape')

    # ---- light theme: TF menu + vline ----
    page.evaluate("() => localStorage.removeItem('mt5_tf_menu_collapsed')")
    page.evaluate("() => window.__app.Theme.apply('light')")
    page.wait_for_timeout(400)
    page.click('#tf-menu-btn')
    page.wait_for_timeout(400)
    page.locator('#tf-menu').screenshot(path=f'{OUT}/08-tf-menu-light.png')
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)
    page.screenshot(path=f'{OUT}/09-vline-light.png')

    browser.close()
print('GALLERY DONE')
