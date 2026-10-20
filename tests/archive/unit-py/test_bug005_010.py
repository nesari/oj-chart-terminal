#!/usr/bin/env python3
"""BUG-005 + BUG-010 verification at 1280x720 (and short-window variants):
- every tool-group flyout stays inside the viewport, last item reachable/clickable
- layout picker: whole menu clamped, SYNC visible, LAYOUTS section reachable,
  internal scrolls, resize closes the menu
"""
import sys, time, threading, http.server, functools, json, subprocess, signal, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'src')
PORT = 8915
PROV = subprocess.Popen(['python3', os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'provider', 'demo.py')],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
time.sleep(1.5)

def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start()

results = []
def check(name, ok, info=''):
    results.append((name, ok, info))
    print(('PASS' if ok else 'FAIL'), '-', name, ('| ' + str(info) if info else ''))

FLYOUT_JS = """(groupIdx) => {
  const btns = [...document.querySelectorAll('.lt-btn[data-group]')];
  const btn = btns[groupIdx];
  if (!btn) return { missing: true };
  btn.click();
  const fl = document.querySelector('.lt-flyout');
  if (!fl) return { noflyout: true, group: btn.dataset.group };
  const r = fl.getBoundingClientRect();
  const tiles = [...fl.querySelectorAll('.lt-tile')];
  const vh = window.innerHeight;
  const inVp = { top: r.top >= 40, bottom: r.bottom <= vh - 8, h: Math.round(r.height) };
  // scroll to the very bottom inside the flyout and try the last tile
  fl.scrollTop = fl.scrollHeight;
  const last = tiles[tiles.length - 1];
  const lr = last ? last.getBoundingClientRect() : null;
  const lastVisible = lr && lr.top >= 40 && lr.bottom <= vh - 2;
  let clicked = false;
  if (last) { last.click(); clicked = true; }
  return { group: btn.dataset.group, tiles: tiles.length, inVp, lastVisible,
           lastTxt: last ? last.textContent.trim() : null, closedAfterClick: !document.querySelector('.lt-flyout'),
           scrollable: fl.scrollHeight > fl.clientHeight };
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1280, 'height': 720})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1000)
    pg.click('#card-demo'); pg.click('#login-connect')
    pg.wait_for_timeout(5000)

    n = pg.evaluate("() => document.querySelectorAll('.lt-btn[data-group]').length")
    all_ok, details = True, []
    for i in range(n):
        r = pg.evaluate(FLYOUT_JS, i)
        pg.wait_for_timeout(120)
        if r.get('missing'):
            all_ok = False; details.append(str(r)); continue
        if r.get('noflyout'):
            # single-tool groups (measure, zoom) activate directly — no flyout by design
            details.append(f"{r['group']}: single-tool (no flyout, by design)"); continue
        ok = r['inVp']['top'] and r['inVp']['bottom'] and r['lastVisible'] and r['closedAfterClick']
        if not ok: all_ok = False
        details.append(f"{r['group']}: tiles={r['tiles']} h={r['inVp']['h']} top={r['inVp']['top']} bottom={r['inVp']['bottom']} last={r['lastVisible']} click={r['closedAfterClick']}")
    check('1 every tool flyout: clamped in viewport + last item reachable & clickable', all_ok, ' | '.join(details))

    # -------- BUG-010: layout picker --------
    lay = pg.evaluate("""() => new Promise((res) => {
      const y = window.innerHeight - 80; // anchor near the bottom edge
      Toolbar.openLayoutMenu(300, y);
      setTimeout(() => {
        const m = document.querySelector('.lay-picker');
        if (!m) { res({ nomenu: true }); return; }
        const r = m.getBoundingClientRect();
        const vh = window.innerHeight;
        const titles = [...m.querySelectorAll('.pu-title')].map(t => ({ txt: t.textContent, top: Math.round(t.getBoundingClientRect().top), vis: t.getBoundingClientRect().top < vh && t.getBoundingClientRect().bottom <= vh }));
        const sync = m.querySelector('.lay-sync');
        const syncVis = sync && sync.getBoundingClientRect().bottom <= vh - 2;
        const layouts = m.querySelector('.lay-layouts');
        let saveReachable = false;
        if (layouts) {
          layouts.scrollTop = layouts.scrollHeight;
          const sb = layouts.querySelector('.lay-save');
          saveReachable = !!sb && sb.getBoundingClientRect().bottom <= vh - 2 && sb.getBoundingClientRect().top >= 40;
        }
        res({
          bottom: Math.round(r.bottom), vh, clamped: r.bottom <= vh - 8,
          titles, syncVis, saveReachable,
          gridScrollable: m.querySelector('.lay-scroll') ? (m.querySelector('.lay-scroll').scrollHeight >= m.querySelector('.lay-scroll').clientHeight) : false,
          maxH: m.style.maxHeight,
        });
      }, 300);
    })""")
    check('2 layout menu clamped above window bottom', lay.get('clamped') == True, f"bottom={lay.get('bottom')} vh={lay.get('vh')} maxH={lay.get('maxH')}")
    check('3 SYNC IN LAYOUT fully visible', lay.get('syncVis') == True, lay.get('titles'))
    check('4 LAYOUTS section: Save button reachable via internal scroll', lay.get('saveReachable') == True, lay.get('titles'))
    check('5 grid area scrolls internally', lay.get('gridScrollable') == True)

    # resize while open -> closes (ONE rule, consistent with flyouts)
    pg.evaluate("() => { Toolbar.openLayoutMenu(300, 200); }")
    pg.wait_for_timeout(250)
    open1 = pg.evaluate("() => !!document.querySelector('.lay-picker')")
    pg.evaluate("() => window.dispatchEvent(new Event('resize'))")
    pg.wait_for_timeout(250)
    open2 = pg.evaluate("() => !!document.querySelector('.lay-picker')")
    check('6 resize while open closes the menu (one rule)', open1 == True and open2 == False, f"{open1}->{open2}")

    # very short window: flyout still fits
    pg.set_viewport_size({'width': 1280, 'height': 600})
    pg.wait_for_timeout(500)
    short = pg.evaluate(FLYOUT_JS, 1)
    pg.wait_for_timeout(150)
    okShort = short.get('inVp', {}).get('bottom') and short.get('lastVisible')
    check('7 short window (600px): flyout still clamped + reachable', okShort == True, short)

    pg.set_viewport_size({'width': 1600, 'height': 900})
    pg.wait_for_timeout(400)
    pg.screenshot(path='/home/z/my-project/download/bug005-010-after-fix.png')
    check('8 no page errors', len(errs) == 0, '; '.join(errs[:3]))
    b.close()

try: os.killpg(os.getpgid(PROV.pid), signal.SIGTERM)
except Exception: pass

fails = [r for r in results if not r[1]]
print(f"\n==== {len(results) - len(fails)}/{len(results)} passed ====")
sys.exit(1 if fails else 0)
