import sys, os, subprocess, time
subprocess.run(['pkill', '-f', 'provider/demo.py'], capture_output=True); time.sleep(1.2)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
from e2e_helper_round32 import open_app
from playwright.sync_api import sync_playwright

PROBE = """() => {
  const p = window.__app.App.panes[0];
  const el = document.elementFromPoint(675, %d);
  return { at: el ? el.tagName + '|' + (typeof el.className === 'string' ? el.className : 'svg') : 'NONE',
           vy: (p.engine._view && p.engine._view.yOf) ? p.engine._view.yOf(%r) : null,
           mode: p.engine.mode };
}"""

with sync_playwright() as pw:
    errs = []
    b, page = open_app(pw)
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.wait_for_timeout(400)
    bb = page.evaluate("""() => { const r = document.querySelector('.pane-overlay').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; }""")
    cx, cy = int(bb['x'] + bb['w'] * 0.45), int(bb['y'] + bb['h'] * 0.4)
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
    # cleanup + pan (T4 replica)
    page.evaluate("() => { try { localStorage.removeItem('mt5_alerts'); } catch(e) {} if (window.__app.Alerts) { window.__app.Alerts.list = []; window.__app.Alerts.selected = null; } const p = window.__app.App.panes[0]; window.__app.Manager.applyPriceLines(p); }")
    page.wait_for_timeout(250)
    page.evaluate("window.__app.UI.activateTool('cross')")
    page.mouse.move(cx, cy, steps=4); page.mouse.down(); page.mouse.move(cx - 140, cy, steps=8)
    page.wait_for_timeout(150); page.mouse.up(); page.wait_for_timeout(250)
    page.mouse.move(cx, cy, steps=5); page.wait_for_timeout(700)
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(300)
    page.evaluate(f"() => {{ window.__app.Alerts.create(window.__app.App.panes[0].symbol, 'Greater Than', {a0}); }}")
    page.wait_for_timeout(300)
    yl = page.evaluate(f"() => {{ const p = window.__app.App.panes[0]; let y=null; try {{ y = p.series.priceToCoordinate({a0}); }} catch(e) {{}} return y; }}")
    print('PAN+LIGHT yl =', yl)
    print('PROBE:', page.evaluate(PROBE % (int(bb['y'] + yl), a0)))
    page.mouse.click(cx, int(bb['y'] + yl)); page.wait_for_timeout(350)
    print('PAN+LIGHT select ->', page.evaluate("() => { const el=document.querySelector('.alert-del'); return el ? getComputedStyle(el).display : 'NOEL'; }"))
    # try DARK after pan for completeness
    page.evaluate("window.__app.Theme.apply('dark')"); page.wait_for_timeout(250)
    y2 = page.evaluate(f"() => {{ const p = window.__app.App.panes[0]; let y=null; try {{ y = p.series.priceToCoordinate({a0}); }} catch(e) {{}} return y; }}")
    page.mouse.click(cx, int(bb['y'] + y2)); page.wait_for_timeout(350)
    print('PAN+DARK select ->', page.evaluate("() => { const el=document.querySelector('.alert-del'); return el ? getComputedStyle(el).display : 'NOEL'; }"))
    print('PAGEERRORS:', errs[:2])
    b.close()
