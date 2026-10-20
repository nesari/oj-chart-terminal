import sys, os, subprocess, time
subprocess.run(['pkill', '-f', 'provider/demo.py'], capture_output=True); time.sleep(1.2)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_helper_round32 import open_app
from playwright.sync_api import sync_playwright

PROBE = """() => {
  const p = window.__app.App.panes[0];
  const ov = document.querySelector('.pane-overlay').getBoundingClientRect();
  const cv = p.engine && p.engine.canvas ? p.engine.canvas.getBoundingClientRect() : null;
  const el = document.elementFromPoint(675, %d);
  return { ovY: ov.y, cvY: cv ? cv.y : null, cvTop: cv ? cv.top : null,
           at: el ? el.tagName + '|' + (typeof el.className === 'string' ? el.className : 'svg') : 'NONE',
           vy: (p.engine._view && p.engine._view.yOf) ? p.engine._view.yOf(%r) : null,
           hostY: p.host.getBoundingClientRect().y };
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
    # light FIRST (no pan) — isolate variables: theme alone
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(300)
    yl = page.evaluate(f"() => {{ const p = window.__app.App.panes[0]; let y=null; try {{ y = p.series.priceToCoordinate({a0}); }} catch(e) {{}} return y; }}")
    print('LIGHT-no-pan yl =', yl)
    print('PROBE:', page.evaluate(PROBE % (int(bb['y'] + yl), a0)))
    page.mouse.click(cx, int(bb['y'] + yl)); page.wait_for_timeout(350)
    print('LIGHT-no-pan select ->', page.evaluate("() => { const el=document.querySelector('.alert-del'); return el ? getComputedStyle(el).display : 'NOEL'; }"))
    print('PAGEERRORS:', errs[:2])
    b.close()
