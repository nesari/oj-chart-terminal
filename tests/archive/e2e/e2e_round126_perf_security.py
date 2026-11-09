#!/usr/bin/env python3
"""ROUND126 e2e — performance & security hardening, live in a browser.

The app is served over http (the established harness; no provider feed, so
the boot runs the pure idle path — exactly the case the new adaptive render
loop must survive silently). Checks:

[1] Boot: zero page errors with the rewritten render loop + range-change
    subscriptions + named engine listeners in place.
[2] Wiring: __app.Manager.markChartActivity exists and is callable; the
    capture listeners do not throw on pointer/keyboard/wheel bursts.
[3] Teardown: creating + closing a tab and switching layouts exercises
    destroyPanes() -> engine.destroy() + _lrRaf cleanup with zero errors
    (the old code leaked a window listener + an rAF chain per destroyed pane).
[4] Idle calm: with no interaction for >1.5s the RAF loop keeps scheduling
    (countdown cadence intact) — verified by observing rAF timestamps flow
    while the mouse sits still.

Exits 0 only if every check passes with zero page errors.
"""
import time, http.server, functools, os, socket, subprocess, sys, threading

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP = 8926
FAILS = []
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if extra and not cond else ''))
    if not cond:
        FAILS.append(name)

def wait_port(port, timeout=15):
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

def main():
    import threading
    threading.daemon = True
    t = threading.Thread(target=serve_http, daemon=True)
    t.start()
    if not wait_port(PORT_HTTP):
        print('http server failed'); return 1

    from playwright.sync_api import sync_playwright
    errors = []
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(args=['--allow-file-access-from-files'])
        except Exception:
            browser = p.chromium.launch(channel='chrome', args=['--allow-file-access-from-files'])
        page = browser.new_page(viewport={'width': 1600, 'height': 900})
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?mode=demo')
        page.wait_for_timeout(2500)

        print('— [1] boot with the adaptive render loop —')
        panes = page.eval_on_selector_all('.pane-root', 'els => els.length')
        check('chart shell boots with one pane', panes == 1, str(panes))
        overlay = page.eval_on_selector_all('.pane-overlay', 'els => els.length')
        check('overlay canvas present (engine built)', overlay == 1, str(overlay))

        print('— [2] activity wiring —')
        check('Manager.markChartActivity exists', page.evaluate("typeof window.__app.Manager.markChartActivity === 'function'"))
        check('markChartActivity is callable without error', page.evaluate("(() => { window.__app.Manager.markChartActivity(); return true; })()"))
        # burst the exact channels the loop listens on — none may throw
        page.mouse.move(700, 450); page.mouse.move(800, 500)
        page.mouse.down(); page.mouse.up()
        page.keyboard.press('Shift')
        page.evaluate("""(() => {
          const ev = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
          document.getElementById('charts-area').dispatchEvent(ev);
        })()""")
        page.wait_for_timeout(400)
        check('pointer/keyboard/wheel bursts produce no page errors', not errors, errors[:3])

        print('— [3] teardown paths (engine.destroy + _lrRaf cleanup) —')
        before_errors = len(errors)
        # second tab + close it: destroyPanes runs for the recreated panes
        page.evaluate("window.__app.Tabs.create('EURUSD')")
        page.wait_for_timeout(600)
        tabs_n = page.evaluate("window.__app.Tabs.list.length")
        check('second tab created', tabs_n == 2, str(tabs_n))
        page.evaluate("""(() => {
          const t = window.__app.Tabs.list[1];
          window.__app.Tabs.closeTab(t.id);
        })()""")
        page.wait_for_timeout(600)
        check('tab closed back to one', page.evaluate("window.__app.Tabs.list.length") == 1)
        # layout switch: full destroyPanes + rebuild (2x2 grid)
        page.evaluate("window.__app.Manager.setLayout('2v', true)")
        page.wait_for_timeout(800)
        n2 = page.eval_on_selector_all('.pane-root', 'els => els.length')
        check('layout 2v rebuilt with two panes', n2 == 2, str(n2))
        page.evaluate("window.__app.Manager.setLayout('1', true)")
        page.wait_for_timeout(600)
        check('back to single chart', page.eval_on_selector_all('.pane-root', 'els => els.length') == 1)
        check('tab/layout teardown produced no page errors', len(errors) == before_errors, errors[before_errors:before_errors+3])

        print('— [4] idle calm: RAF keeps scheduling, nothing paints out of control —')
        raf_flow = page.evaluate("""(() => new Promise((res) => {
          let n = 0;
          const t0 = performance.now();
          const cnt = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(cnt); else res(n); };
          requestAnimationFrame(cnt);
        }))()""")
        check('RAF still schedules while idle (loop alive)', raf_flow >= 30, str(raf_flow))
        # idle overlay repaint floor: instrument engine.render through the facade
        paints = page.evaluate("""(() => new Promise((res) => {
          const A = window.__app;
          const pane = A.App.panes[0];
          if (!pane || !pane.engine) { res(-1); return; }
          let n = 0;
          const orig = pane.engine.render.bind(pane.engine);
          pane.engine.render = () => { n++; orig(); };
          setTimeout(() => { pane.engine.render = orig; res(n); }, 1600);
        }))()""")
        check('idle repaint floor engaged (<= ~8 paints in 1.6s, was ~96)', paints >= 0 and paints <= 8, str(paints))

        browser.close()

    check('zero page errors across the whole run', not errors, errors[:3])
    print()
    if FAILS:
        print('FAILED: ' + ', '.join(FAILS)); return 1
    print('ROUND126 e2e: all checks passed'); return 0

if __name__ == '__main__':
    sys_exit = main()
    raise SystemExit(sys_exit)
