#!/usr/bin/env python3
"""R306 — the chart right-click menu (roadmap P0-02).

WHAT THIS SUITE EXISTS FOR
  The menu had seven reachable rows (three of its eight `mk(` calls are
  conditional on where the click landed) and TradingView has twenty-odd. Growing
  it is easy; growing it CORRECTLY is not, because a context menu is mostly
  invisible wiring:

    * a row wired to an un-imported identifier (`typeof X !== 'undefined'`) is a
      button that looks alive and does nothing — ROUND305 shipped four of those.
    * a "Hide all drawings" row that flips `App.hideAll` but paints nothing is a
      placebo toggle; the visible result is the only proof.
    * a submenu built from a copied tool list drifts the day a tool is added.

  So this suite asserts the three things a screenshot cannot:
    1. the menu really renders 15+ non-empty rows,
    2. "Hide all drawings" really makes the drawings disappear (pixel ink before
       vs after on a screenshot, not a flag read),
    3. the drawing submenu really lists every tool from UI.GROUPS and arming one
       from it really arms it.

Run: python tests/archive/e2e/e2e_round306_chart_menu.py
"""
import functools
import http.server
import os
import socket
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_teardown import kill_proc

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
# Shard-safe: overridable, defaults from the roadmap's free ranges (see §1.3).
PORT_HTTP, PORT_WS = int(os.environ.get('MT5_HTTP_PORT', '9081')), int(os.environ.get('MT5_WS_PORT', '8931'))
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def check(name, cond, extra=''):
    print(('  ok ' if cond else '  FAIL ') + name + ((' - ' + str(extra)) if (not cond and extra != '') else ''))
    if not cond:
        FAILS.append(name)


def wait_port(port, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with socket.create_connection(('127.0.0.1', port), 0.4):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def serve_http():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, 'src'))
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT_HTTP), handler).serve_forever()


# Open the real menu through the same entry point the right-click uses, then
# report what the DOM holds. Reading the DOM (not the source) is the point: it
# proves the popup actually built.
OPEN_MENU_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const r = pane.host.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  // the same call the mousedown handler makes
  A.UI.openChartMenu(x, y, { pane, x, y, price: pane.bars.length ? pane.bars[pane.bars.length - 1].close : null, t: 0 });
  const items = [...document.querySelectorAll('body > .popup .pu-item')];
  const labels = items.map((b) => (b.querySelector('span:nth-child(2)') || {}).textContent || b.textContent || '').map((s) => s.trim());
  return {
    n: items.length,
    nonEmpty: labels.filter((s) => s.length > 0).length,
    labels,
    hasSub: document.querySelectorAll('body > .popup .pu-item.pu-has-sub').length,
    seps: document.querySelectorAll('body > .popup .pu-sep').length,
  };
}"""

MENU_ROW_JS = """(labelStart) => {
  const items = [...document.querySelectorAll('body > .popup .pu-item')];
  const hit = items.find((b) => {
    const t = b.querySelector('span:nth-child(2)');
    return t && t.textContent.trim().startsWith(labelStart);
  });
  return !!hit;
}"""

CLICK_ROW_JS = """(labelStart) => {
  const items = [...document.querySelectorAll('body > .popup .pu-item')];
  const hit = items.find((b) => {
    const t = b.querySelector('span:nth-child(2)');
    return t && t.textContent.trim().startsWith(labelStart);
  });
  if (!hit) return false;
  hit.click();
  return true;
}"""

# Draw three shapes, then report the ink inside the chart area so "hide all" can
# be measured as pixels rather than as a flag.
DRAW_JS = """async () => {
  const A = window.__app;
  const pane = A.App.activePane;
  const frames = (n) => new Promise((res) => { let k = 0; const s = () => (++k >= n ? res() : requestAnimationFrame(s)); requestAnimationFrame(s); });
  const t = pane.barTimes;
  const n = t.length;
  /* `App.drawings.add(symbol, drawing)` is the real API; there is no `create`.
     The shape is the same one the engine stores. */
  const mk = (type, i0, i1, p0, p1) => {
    return A.App.drawings.add(pane.symbol, {
      type,
      points: [
        { t: t[n - i0], p: p0 },
        { t: t[n - i1], p: p1 },
      ],
      opts: { color: '#ff9800', width: 3 },
    });
  };
  const c = pane.bars[n - 1].close;
  try { mk('rect', 120, 60, c * 1.01, c * 0.99); } catch (e) {}
  try { mk('hline', 10, 10, c * 1.005, c * 1.005); } catch (e) {}
  try { mk('trend', 160, 40, c * 0.995, c * 1.004); } catch (e) {}
  A.Manager.repaint ? A.Manager.repaint(pane) : null;
  await frames(30);
  return { count: (A.App.drawings.list(pane.symbol) || []).length };
}"""

COUNT_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  return {
    count: (A.App.drawings.list(pane.symbol) || []).length,
    hideAll: !!A.App.hideAll,
    lockAll: !!A.App.lockAll,
  };
}"""

# Coloured pixels in the chart area — the only honest measure of "the drawings
# are not on screen". Orange #ff9800 is far from the candle green/red, so a
# saturated-orange count isolates the shapes we drew.
INK_JS = """async function (b64) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let orange = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    // #ff9800-ish: strong red, mid green, near-zero blue
    if (r > 200 && g > 110 && g < 190 && b < 60) orange++;
  }
  return orange;
}"""


def main():
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not wait_port(PORT_WS):
        print('provider did not start')
        kill_proc(prov)
        return 1
    threading.Thread(target=serve_http, daemon=True).start()
    if not wait_port(PORT_HTTP):
        print('http server did not start')
        kill_proc(prov)
        return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(headless=True)
            except Exception:
                browser = pw.chromium.launch(channel='chrome', headless=True)
            page = browser.new_page(viewport={'width': 1500, 'height': 900})
            page.add_init_script("localStorage.clear()")
            errs = []
            page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_selector('#login-screen', timeout=15000)
            page.click('#card-demo')
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=25000)
            for _ in range(250):
                if page.evaluate("window.__app && window.__app.App.panes[0] && window.__app.App.panes[0].bars.length > 300"):
                    break
                time.sleep(0.2)
            page.wait_for_timeout(2500)

            # ---------------- the menu renders ----------------
            print('  -- the menu renders --')
            menu = page.evaluate(OPEN_MENU_JS)
            check('the menu opened', menu['n'] > 0, menu['n'])
            check('it has 15+ non-empty rows (was 7 reachable)', menu['nonEmpty'] >= 15, menu['nonEmpty'])
            check('every row has a label (no blank buttons)', menu['nonEmpty'] == menu['n'],
                  f"{menu['nonEmpty']}/{menu['n']}")
            check('the rows are grouped with separators', menu['seps'] >= 3, menu['seps'])
            check('the drawing tools are a submenu, not a flat list', menu['hasSub'] >= 1, menu['hasSub'])

            labels = menu['labels']
            for need in ['Add indicator', 'Add drawing', 'Go to date', 'Timezone',
                         'Copy image', 'Download image', 'Compare symbol', 'Object tree',
                         'Save layout', 'Settings', 'Reset chart']:
                check(f'the menu has "{need}"',
                      any(l.startswith(need) for l in labels),
                      [l for l in labels if need.split()[0] in l][:3])

            # state-driven labels must be truthful
            check('the hide row says "Hide all drawings" while drawings are visible',
                  any(l == 'Hide all drawings' for l in labels),
                  [l for l in labels if 'drawings' in l])
            check('the lock row says "Lock all drawings" while unlocked',
                  any(l == 'Lock all drawings' for l in labels),
                  [l for l in labels if 'drawings' in l])

            page.keyboard.press('Escape')
            page.wait_for_timeout(200)

            # ---------------- hide-all is VISIBLE ----------------
            print('  -- hide-all really hides (pixels, not a flag) --')
            drawn = page.evaluate(DRAW_JS)
            check('three drawings were created', drawn['count'] >= 3, drawn['count'])
            page.wait_for_timeout(500)
            before = page.evaluate(INK_JS, __import__('base64').b64encode(
                page.screenshot()).decode())
            check('the drawings are painted (orange ink present)', before > 200, before)

            page.evaluate(OPEN_MENU_JS)
            clicked = page.evaluate(CLICK_ROW_JS, 'Hide all drawings')
            check('the "Hide all drawings" row was found and clicked', clicked)
            page.wait_for_timeout(700)
            st = page.evaluate(COUNT_JS)
            check('App.hideAll is now true', st['hideAll'] is True, st)
            after = page.evaluate(INK_JS, __import__('base64').b64encode(
                page.screenshot()).decode())
            check('the drawings are GONE from the screen', after < before * 0.35,
                  f'{before} -> {after} orange px')
            check('the drawings were not deleted, only hidden', st['count'] >= 3, st['count'])

            # show again
            page.evaluate(OPEN_MENU_JS)
            page.evaluate(CLICK_ROW_JS, 'Show all drawings')
            page.wait_for_timeout(700)
            back = page.evaluate(INK_JS, __import__('base64').b64encode(
                page.screenshot()).decode())
            check('"Show all drawings" brings them back', back > before * 0.6,
                  f'{before} -> {back} orange px')
            check('App.hideAll is false again', page.evaluate(COUNT_JS)['hideAll'] is False)

            # ---------------- lock-all is a real flag ----------------
            print('  -- lock-all flips a flag the engine reads --')
            page.evaluate(OPEN_MENU_JS)
            page.evaluate(CLICK_ROW_JS, 'Lock all drawings')
            page.wait_for_timeout(400)
            check('App.lockAll is true after the row', page.evaluate(COUNT_JS)['lockAll'] is True)
            page.evaluate(OPEN_MENU_JS)
            page.evaluate(CLICK_ROW_JS, 'Unlock all drawings')
            page.wait_for_timeout(400)
            check('App.lockAll is false after unlocking', page.evaluate(COUNT_JS)['lockAll'] is False)

            # ---------------- the drawing submenu ----------------
            print('  -- the drawing submenu lists every tool --')
            page.evaluate(OPEN_MENU_JS)
            page.evaluate(CLICK_ROW_JS, 'Add drawing')
            page.wait_for_timeout(500)
            sub = page.evaluate("""() => {
              const items = [...document.querySelectorAll('body > .popup .pu-item')];
              const titles = [...document.querySelectorAll('body > .popup .pu-title')].map((t) => t.textContent.trim());
              return { n: items.length, labels: items.map((b) => (b.querySelector('span:nth-child(2)') || {}).textContent || '').filter(Boolean), titles };
            }""")
            expect = page.evaluate("""() => {
              const A = window.__app;
              const ids = new Set();
              for (const g of (A.UI.GROUPS || [])) {
                // the menu skips these three groups (they are single-tool groups
                // for cursor/zoom/measure and are not "drawings")
                if (['cursor', 'zoom', 'measure'].includes(g.id)) continue;
                for (const t of (g.tools || [])) ids.add(t);
                for (const s of (g.sections || [])) for (const t of (s.tools || [])) ids.add(t);
              }
              return ids.size;
            }""")
            check('the submenu lists a substantial tool set', sub['n'] >= 50, sub['n'])
            check('it is organised in titled sections', len(sub['titles']) >= 4, sub['titles'])
            check('the submenu lists EXACTLY the de-duplicated tool set',
                  sub['n'] == expect, f"{sub['n']} rows vs {expect} expected")

            armed = page.evaluate("""() => {
              const items = [...document.querySelectorAll('body > .popup .pu-item')];
              const rect = items.find((b) => /Rectangle/i.test(b.textContent));
              if (!rect) return { found: false };
              rect.click();
              return { found: true, tool: window.__app.App.tool };
            }""")
            check('clicking a tool row arms that tool', armed['found'] and armed['tool'] == 'rect', armed)

            # ---------------- the count is not inflated by dead rows ----------------
            print('  -- no duplicate labels (a sign of a copied list) --')
            page.wait_for_timeout(200)
            dupes = page.evaluate("""() => {
              const labels = [...document.querySelectorAll('body > .popup .pu-item')]
                .map((b) => (b.querySelector('span:nth-child(2)') || {}).textContent || '').filter(Boolean);
              const seen = new Set(); const d = [];
              for (const l of labels) { if (seen.has(l)) d.push(l); seen.add(l); }
              return d;
            }""")
            check('no duplicate rows in the submenu (5 tools are in two flyouts, so '
                  'the menu must de-duplicate)', len(dupes) == 0, dupes[:5])

            page.keyboard.press('Escape')

            # ---------------- console ----------------
            check('no console errors during the run', len(errs) == 0, errs[:3])

            browser.close()
    finally:
        kill_proc(prov)

    print()
    if FAILS:
        print(f'ROUND306 menu E2E: {len(FAILS)} FAILED — ' + ', '.join(FAILS))
        return 1
    print('ROUND306 menu E2E: all green')
    return 0


if __name__ == '__main__':
    sys.exit(main())
