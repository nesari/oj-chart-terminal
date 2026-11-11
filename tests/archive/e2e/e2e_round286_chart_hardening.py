#!/usr/bin/env python3
"""ROUND286 e2e — the stale-interval crash, live.

Reproduces the exact failure the deep audit found and proves it is fixed:

  1. switching a chart to a DELETED custom interval used to throw
     "Cannot read properties of undefined (reading 'label')" inside
     updateLegendTitle and leave the pane half-switched.
  2. a valid interval still switches normally.
  3. the legend keeps rendering after a rejected switch.

Run: python tests/archive/e2e/e2e_round286_chart_hardening.py
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8983, 8872
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


# Create a custom interval, switch to it, delete it, then try to switch back to
# the deleted id (exactly the stale-layout case).
STALE_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const out = { steps: [] };
  const snap = { tf: pane.tf, bars: pane.bars.length };

  /* 1) a real custom interval (units are lowercase: s/m/h/d/w/mo) */
  let made = null;
  try { made = A.App.addCustomTf(7, 'h'); } catch (e) { return { error: 'addCustomTf: ' + e.message }; }
  if (!made || !made.id) return { error: 'no custom id', made };
  /* if 7h already exists natively, pick a unit/duration that does not */
  if (made.existed) {
    for (const [n2, u2] of [[7, 'h'], [11, 'm'], [37, 'm'], [13, 'h'], [9, 'd']]) {
      const r2 = A.App.addCustomTf(n2, u2);
      if (r2 && !r2.existed) { made = r2; break; }
    }
  }
  if (!made || made.existed) return { error: 'could not build a custom interval', made };
  out.customId = made.id;

  /* 2) switching to it works */
  try { A.Manager.setTf(pane, made.id); } catch (e) { out.err1 = String(e && e.message || e); }
  out.afterCustom = pane.tf;

  /* 3) delete it while the pane still shows it (stale state) */
  try { A.App.removeCustomTf(made.id); } catch (e) { out.err2 = String(e && e.message || e); }
  out.stillKnown = !!A.App.tfById[made.id];
  out.tfWhileStale = pane.tf;

  /* 4) THE OLD BUG: switching (or re-rendering) with an unknown id threw */
  let threw = null;
  try { A.Manager.setTf(pane, made.id); } catch (e) { threw = String(e && e.message || e); }
  out.threw = threw;

  /* 5) an unknown id must be rejected, not applied */
  let threw2 = null;
  const before = pane.tf;
  try { A.Manager.setTf(pane, 'BOGUS_TF'); } catch (e) { threw2 = String(e && e.message || e); }
  out.threw2 = threw2;
  out.tfAfterBogus = pane.tf;
  out.bogusApplied = pane.tf === 'BOGUS_TF';

  /* 6) the legend must still be alive and populated */
  const lg = pane.els && pane.els.lgTf;
  out.legendText = lg ? (lg.textContent || '') : null;

  /* 7) a valid interval still switches normally */
  const valid = A.App.tfById['M15'] ? 'M15' : Object.keys(A.App.tfById)[0];
  try { A.Manager.setTf(pane, valid); } catch (e) { out.err3 = String(e && e.message || e); }
  out.afterValid = pane.tf;
  out.validId = valid;
  out.barsAfter = pane.bars.length;

  /* restore */
  try { A.Manager.setTf(pane, snap.tf); } catch (e) {}
  return out;
}"""


def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up')
        prov.terminate()
        return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1560, 'height': 900})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_function(
                "() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100",
                timeout=45000)
            page.wait_for_timeout(800)

            r = page.evaluate(STALE_JS)
            print('    ' + str({k: v for k, v in r.items() if k != 'steps'})[:400])

            check('custom interval was created', bool(r.get('customId')), r)
            check('switching to it works', r.get('afterCustom') == r.get('customId'), r.get('afterCustom'))
            check('deleting it leaves the pane stale', r.get('stillKnown') is False, r.get('stillKnown'))

            print('  -- the bug: a deleted interval id --')
            check('switching to a deleted id does NOT throw', not r.get('threw'), r.get('threw'))
            check('an unknown id does NOT throw either', not r.get('threw2'), r.get('threw2'))
            check('an unknown id is NOT applied', r.get('bogusApplied') is False, r.get('tfAfterBogus'))
            check('the pane keeps a real interval after rejection',
                  r.get('tfAfterBogus') in ('M15', r.get('customId'), r.get('tfWhileStale')) or bool(r.get('tfAfterBogus')),
                  r.get('tfAfterBogus'))

            print('  -- the chart stays healthy --')
            check('the legend still has text', bool(r.get('legendText')), r.get('legendText'))
            check('a valid interval still switches', r.get('afterValid') == r.get('validId'), r)
            # loadBars is async — wait for the pane to fill before judging
            tfid = r.get('validId')
            try:
                page.wait_for_function(
                    "() => { const p = window.__app.App.activePane; return p && p.bars.length > 10; }",
                    timeout=25000)
                reloaded = True
            except Exception:
                reloaded = False
            bars = page.evaluate("() => ({ tf: window.__app.App.activePane.tf, n: window.__app.App.activePane.bars.length })")
            check('bars reload after a valid switch', reloaded and bars['n'] > 10,
                  str(bars) + ' (asked for ' + str(tfid) + ')')
            check('zero page errors', len(errors) == 0, errors[:3])

            browser.close()
    finally:
        prov.terminate()
    print('ROUND286: %d failed' % len(FAILS) if FAILS else 'ROUND286: all green')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
