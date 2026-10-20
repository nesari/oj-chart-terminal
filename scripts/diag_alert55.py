import sys, os, subprocess, time
subprocess.run(['pkill', '-f', 'provider/demo.py'], capture_output=True); time.sleep(1.2)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_helper_round32 import open_app
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    errs = []
    b, page = open_app(pw)
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.wait_for_timeout(400)
    bb = page.evaluate("""() => { const r = document.querySelector('.pane-overlay').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; }""")
    cx, cy = int(bb['x'] + bb['w'] * 0.45), int(bb['y'] + bb['h'] * 0.4)
    # create an alert near mid-chart like T2 does via (+)
    page.evaluate("window.__app.UI.activateTool('arrowcur')")
    page.mouse.move(cx, cy, steps=5); page.wait_for_timeout(200)
    bpos = page.evaluate("() => { const r = window.__app.App.panes[0].paxAdd.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; }")
    page.mouse.move(bpos['x'], bpos['y'], steps=8); page.wait_for_timeout(250)
    page.mouse.click(bpos['x'], bpos['y']); page.wait_for_timeout(300)
    page.evaluate("() => { const its = document.querySelectorAll('.pu-item'); if (its.length) its[0].click(); }")
    page.wait_for_timeout(300)
    page.evaluate("() => { const el = document.querySelector('#al-create'); if (el) el.click(); }")
    page.wait_for_timeout(400)
    a0 = page.evaluate("() => window.__app.Alerts.list[window.__app.Alerts.list.length-1].price")
    # select in dark
    y0 = page.evaluate(f"() => {{ const p = window.__app.App.panes[0]; let y=null; try {{ y = p.series.priceToCoordinate({a0}); }} catch(e) {{}} return y; }}")
    page.mouse.click(cx, int(bb['y'] + y0)); page.wait_for_timeout(350)
    print('DARK select ->', page.evaluate("() => { const el=document.querySelector('.alert-del'); return el ? getComputedStyle(el).display : 'NOEL'; }"), 'y0=', y0)
    # deselect + delete all, mimic T4 cleanup
    page.evaluate("() => { try { localStorage.removeItem('mt5_alerts'); } catch(e) {} if (window.__app.Alerts) { window.__app.Alerts.list = []; window.__app.Alerts.selected = null; } const p = window.__app.App.panes[0]; window.__app.Manager.applyPriceLines(p); }")
    page.wait_for_timeout(250)
    # T4 pan
    page.evaluate("window.__app.UI.activateTool('cross')")
    page.mouse.move(cx, cy, steps=4); page.mouse.down(); page.mouse.move(cx - 140, cy, steps=8)
    page.wait_for_timeout(150); page.mouse.up(); page.wait_for_timeout(250)
    page.mouse.move(cx, cy, steps=5); page.wait_for_timeout(700)
    # T5 light
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(250)
    page.evaluate(f"() => {{ window.__app.Alerts.create(window.__app.App.panes[0].symbol, 'Greater Than', {a0}); }}")
    page.wait_for_timeout(300)
    yl = page.evaluate(f"() => {{ const p = window.__app.App.panes[0]; let y=null; try {{ y = p.series.priceToCoordinate({a0}); }} catch(e) {{}} return y; }}")
    rng = page.evaluate("() => { const p = window.__app.App.panes[0]; try { const s = p.series.priceScale(); return JSON.stringify(s.getVisibleRange()); } catch(e) { return 'ERR'; } }")
    page.mouse.click(cx, int(bb['y'] + yl)); page.wait_for_timeout(350)
    st = page.evaluate("""() => { const el = document.querySelector('.alert-del');
      return { chip: el ? getComputedStyle(el).display : 'NOEL',
               sel: window.__app.Alerts.selected,
               n: window.__app.Alerts.list.length }; }""")
    print('LIGHT click ->', st, 'yl=', yl, 'visibleRange=', rng)
    print('PAGEERRORS:', errs[:2])
    b.close()
