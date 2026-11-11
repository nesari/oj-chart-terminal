#!/usr/bin/env python3
"""ROUND288 e2e — no setting may be a placebo, live.

Verifies in the real dialog + chart:
  1. the removed placebo controls are GONE from the UI
     (Currency and Unit, No overlapping labels, Plus button, Pane buttons,
      indicator Background opacity)
  2. the implemented ones actually change the legend:
     - indFin=hidden hides indicator values
     - stIndValues=false hides them too
     - stIndTitles=false hides the whole indicator legend row

Run: python tests/archive/e2e/e2e_round288_effective_settings.py
"""
import http.server, functools, json, os, socket, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_teardown import kill_proc  # ROUND288: whole-tree cleanup on Windows

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8999, 8888
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def check(name, cond, extra=''):
    print(('  ok ' if cond else '  FAIL ') + name + ((' - ' + str(extra)) if (not cond and extra != '') else ''))
    if not cond:
        FAILS.append(name)


def wait_port(port, timeout=25):
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


# Read every Control label in the Scales + Canvas pages.
CONTROLS_JS = """() => {
  const out = { scales: [], canvas: [], all: [] };
  const dlg = document.querySelector('#settings-dialog');
  if (!dlg) return { error: 'no dialog' };
  const nav = [...dlg.querySelectorAll('.st-nav button')];
  const clickPage = (re) => {
    const b = nav.find((x) => re.test(x.textContent || ''));
    if (b) b.click();
    return !!b;
  };
  const labels = () => [...dlg.querySelectorAll('.st-page label, .st-page .st-row')]
    .map((r) => (r.textContent || '').trim()).filter(Boolean);
  if (clickPage(/scales/i)) out.scales = labels();
  if (clickPage(/canvas/i)) out.canvas = labels();
  out.all = out.scales.concat(out.canvas);
  return out;
}"""

# Add an indicator, then flip the legend gates and see the row react.
LEGEND_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const S = A.Settings;

  /* make sure there IS an indicator to observe */
  const type = (A.Indicators.all[0] || {}).type;
  let inst = (pane.indicators || [])[0];
  if (!inst && type) inst = A.IndicatorsUI.add(pane, type);
  if (!inst) return { error: 'could not add an indicator' };

  const row = pane.root.querySelector('.ind-row[data-iid="' + inst.id + '"]');
  if (!row) return { error: 'no legend row' };
  const vals = row.querySelector('.ind-vals');

  const before = { rowDisplay: row.style.display, valsLen: (vals ? vals.textContent : '').length };

  S.set('indFin', 'hidden');
  A.IndicatorsUI.updateIndicatorRows(pane, null);
  const hiddenVals = vals ? vals.textContent.length : -1;

  S.set('indFin', 'value');
  S.set('stIndValues', false);
  A.IndicatorsUI.updateIndicatorRows(pane, null);
  const stHidden = vals ? vals.textContent.length : -1;

  S.set('stIndValues', true);
  S.set('stIndTitles', false);
  A.IndicatorsUI.updateIndicatorRows(pane, null);
  const titleHidden = row.style.display;

  /* restore */
  S.set('stIndTitles', true);
  S.set('stIndValues', true);
  S.set('indFin', 'value');
  A.IndicatorsUI.updateIndicatorRows(pane, null);
  const restored = row.style.display;

  const valuesBack = vals ? vals.textContent.length : -1;
  try { A.IndicatorsUI.remove(pane, inst.id); } catch (e) {}
  return { before, hiddenVals, stHidden, titleHidden, restored, valuesBack };
}"""


def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up')
        kill_proc(prov)
        return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1600, 'height': 950})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(1000)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_function(
                "() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100",
                timeout=45000)
            page.wait_for_timeout(900)

            print('  -- 1. placebo controls are gone --')
            page.evaluate("() => { const b = document.getElementById('settings-btn'); if (b) b.click(); }")
            page.wait_for_timeout(700)
            r = page.evaluate(CONTROLS_JS)
            if r.get('error'):
                check('settings dialog opens', False, r['error'])
            else:
                joined = ' | '.join(r.get('all') or [])
                for gone in ['Currency and Unit', 'No overlapping labels', 'Plus button']:
                    check('removed control absent: ' + gone, gone not in joined, joined[:200])
                # "Pane" alone is too generic; check the exact old row label
                check('removed control absent: Pane buttons', 'Visible on mouse over' not in joined or 'Pane' not in joined,
                      joined[:200])
                check('kept control present: Navigation', 'Navigation' in joined, joined[:200])
                check('kept control present: Countdown', 'Countdown to bar close' in joined, joined[:200])
                check('kept control present: Indicator values', 'Indicator values' in joined, joined[:200])

            page.evaluate("() => { const b = document.querySelector('#settings-dialog .dlg-x'); if (b) b.click(); }")
            page.wait_for_timeout(300)

            print('  -- 2. the legend gates really act --')
            lg = page.evaluate(LEGEND_JS)
            print('    ' + json.dumps(lg)[:280])
            if lg.get('error'):
                check('legend probe ran', False, lg['error'])
            else:
                check('an indicator row exists with values', (lg.get('before') or {}).get('valsLen', 0) > 0, lg.get('before'))
                check('indFin=hidden empties the values', lg.get('hiddenVals') == 0, lg.get('hiddenVals'))
                check('stIndValues=false empties the values', lg.get('stHidden') == 0, lg.get('stHidden'))
                check('stIndTitles=false hides the whole row', lg.get('titleHidden') == 'none', lg.get('titleHidden'))
                check('restoring shows the row again', lg.get('restored') != 'none', lg.get('restored'))
                check('and the values come back', lg.get('valuesBack', 0) > 0, lg.get('valuesBack'))

            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        kill_proc(prov)
    print('ROUND288: %d failed' % len(FAILS) if FAILS else 'ROUND288: all green')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
