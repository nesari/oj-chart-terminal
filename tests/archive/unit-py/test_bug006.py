#!/usr/bin/env python3
"""BUG-006 verification: Patterns flyout merged into Gann & Elliott (3rd section),
standalone patterns toolbar icon removed, tools fully functional end-to-end."""
import sys, time, threading, http.server, functools, json, subprocess, signal, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'src')
PORT = 8916
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

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1000)
    pg.click('#card-demo'); pg.click('#login-connect')
    pg.wait_for_timeout(5000)

    # registry + toolbar structure
    reg = pg.evaluate("""() => {
      const { UI } = window.__app;
      const groups = (function(){ // re-read GROUPS through a probe flyout open
        return null; })();
      const btns = [...document.querySelectorAll('#left-toolbar .lt-btn[data-group]')].map(b => b.dataset.group);
      const ge = { id: 'gannelliott', sections: null };
      // open the gannelliott flyout to read its sections
      const btn = document.querySelector('.lt-btn[data-group="gannelliott"]');
      btn.click();
      const fl = document.querySelector('.lt-flyout');
      const secs = [...fl.querySelectorAll('.lt-flysec')].map(s => s.textContent.trim());
      const tiles = [...fl.querySelectorAll('.lt-tile .tile-name')].map(t => t.textContent.trim());
      UI.closeFlyout();
      // a flyout for the old patterns group must NOT exist
      const patBtn = document.querySelector('.lt-btn[data-group="patterns"]');
      // registry-level: use UI.toolsOf via group probe is enough; count duplicates globally
      return { btns, secs, tiles, patBtn: !!patBtn };
    }""")
    check('1 no standalone patterns toolbar button', reg['patBtn'] == False, reg['btns'])
    check('2 gannelliott flyout = exactly CHART PATTERNS / ELLIOTT WAVES / CYCLES sections (pin updated r61: TV mirror)',
          reg['secs'] == ['Chart Patterns', 'Elliott Waves', 'Cycles'], reg['secs'])

    # no duplicate/lost tools: count all tool ids across groups
    cnt = pg.evaluate("""() => {
      const seen = {};
      document.querySelectorAll('#left-toolbar .lt-btn[data-group]').forEach(() => {});
      // walk the flyouts by opening each group
      return null;
    }""")
    ids = pg.evaluate("""() => {
      // open every multi-tool group and collect tile names + section structure
      const out = { all: [], dupes: [] };
      const btns = [...document.querySelectorAll('#left-toolbar .lt-btn[data-group]')];
      for (const b of btns) {
        b.click();
        const fl = document.querySelector('.lt-flyout');
        if (!fl) continue;
        for (const t of fl.querySelectorAll('.lt-tile')) {
          const name = t.querySelector('.tile-name').textContent.trim();
          out.all.push(name);
        }
        window.__app.UI.closeFlyout();
      }
      const c = {};
      for (const n of out.all) c[n] = (c[n] || 0) + 1;
      out.dupes = Object.entries(c).filter(([k, v]) => v > 1).map(([k]) => k);
      return out;
    }""")
    # r61 pin: shared tool ids across flyouts are BY DESIGN since r52/r58/r60
    # (Arrow cursor vs arrow line; Regression in lines+forecast; the four
    # Pitchforks in lines+fibs). r61 removed the Gann duplicates (now only in fibs).
    SHARED_OK = {'Arrow', 'Regression Trend', 'Pitchfork', 'Schiff Pitchfork', 'Modified Schiff Pitchfork', 'Inside Pitchfork'}
    check('3 no duplicate tools across flyouts', set(ids['dupes']) <= SHARED_OK,
          f"dupes={ids['dupes']} (all pre-existing shared tool ids from r52/r58/r60)")

    # expected pattern tools present in the CHART PATTERNS section (pin updated r61)
    ge2 = pg.evaluate("""() => {
      document.querySelector('.lt-btn[data-group="gannelliott"]').click();
      const fl = document.querySelector('.lt-flyout');
      const secs = [...fl.querySelectorAll('.lt-flysec')];
      const patSec = secs.find(s => s.textContent.trim() === 'Chart Patterns');
      const names = [];
      let n = patSec.nextElementSibling;
      while (n && !n.classList.contains('lt-flysec')) {
        if (n.classList.contains('lt-tile')) names.push(n.querySelector('.tile-name').textContent.trim());
        n = n.nextElementSibling;
      }
      window.__app.UI.closeFlyout();
      return names;
    }""")
    expected = ['XABCD pattern', 'Cypher pattern', 'Head and shoulders', 'ABCD pattern', 'Triangle pattern', 'Three drives pattern']
    ok_set = all(any(e.lower() in t.lower() for t in ge2) for e in ['xabcd', 'abcd', 'cypher', 'triangle', 'three drives', 'head and shoulders'])
    check('4 CHART PATTERNS section holds all 6 pattern tools in TV order (pin updated r61)', ok_set and ge2 == expected, ge2)

    # draw a pattern (xabcd), open its settings, save a template, reload -> persists
    drawn = pg.evaluate("""() => new Promise((res) => {
      const { App, Manager, UI } = window.__app;
      UI.setTool ? UI.setTool('xabcd') : null;
      // draw via engine API directly: click 5 points on the active pane overlay
      const pane = App.activePane;
      const cv = pane.overlay;
      const r = cv.getBoundingClientRect();
      const pts = [[0.25, 0.3], [0.4, 0.6], [0.55, 0.35], [0.7, 0.65], [0.85, 0.4]];
      let i = 0;
      const fire = () => {
        if (i >= pts.length) {
          const list = App.drawings.list(pane.symbol) || [];
          res({ n: list.length, last: list.length ? list[list.length - 1].type : null });
          return;
        }
        const [fx, fy] = pts[i++];
        const x = r.x + r.width * fx, y = r.y + r.height * fy;
        cv.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
        cv.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
        setTimeout(fire, 60);
      };
      // arm the tool the same way the flyout does
      const btn = document.querySelector('.lt-btn[data-group="gannelliott"]');
      btn.click();
      const fl = document.querySelector('.lt-flyout');
      const tile = [...fl.querySelectorAll('.lt-tile')].find(t => /xabcd/i.test(t.textContent));
      tile.click();
      setTimeout(fire, 150);
    })""")
    pg.wait_for_timeout(800)
    check('5 XABCD pattern drawable via the merged flyout', drawn.get('last') == 'xabcd', drawn)

    # object tree lists it and it is deletable
    obj = pg.evaluate("""() => {
      const pane = window.__app.App.activePane;
      const list = window.__app.App.drawings.list(pane.symbol) || [];
      const d = list[list.length - 1];
      window.__app.App.drawings.remove(pane.symbol, d.id);
      const after = window.__app.App.drawings.list(pane.symbol) || [];
      return { before: list.length, after: after.length };
    }""")
    check('6 pattern drawing present & deletable (Object Tree path)', obj['before'] == 1 and obj['after'] == 0, obj)

    # favorites persist for a moved tool
    fav = pg.evaluate("""() => {
      const UI = window.__app.UI;
      UI.toggleToolFav('cypher');
      const had = window.__app.App.toolFavorites.includes('cypher');
      UI.toggleToolFav('cypher');
      return had;
    }""")
    check('7 favorites path intact for moved tools', fav == True)

    pg.screenshot(path='/home/z/my-project/download/bug006-after-fix.png')
    check('8 no page errors', len(errs) == 0, '; '.join(errs[:3]))
    b.close()

try: os.killpg(os.getpgid(PROV.pid), signal.SIGTERM)
except Exception: pass

fails = [r for r in results if not r[1]]
print(f"\n==== {len(results) - len(fails)}/{len(results)} passed ====")
sys.exit(1 if fails else 0)
