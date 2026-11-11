#!/usr/bin/env python3
"""ROUND288b e2e — Session breaks really render, live.

Proves in the running app that:
  1. the "Session breaks" setting exists and defaults ON
  2. the series fed to the chart actually CONTAINS whitespace rows
     (more data points than bars)
  3. turning the setting OFF removes them
  4. turning it back ON restores them
  5. a single-day window degrades gracefully (no crash)

Run: python tests/archive/e2e/e2e_round288b_session_breaks.py
"""
import http.server, functools, json, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 9003, 8892
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


# Inspect the pane's REAL state. LWC's series.data() deliberately drops
# whitespace rows, so the authoritative signal is the gap-inclusive axis the
# manager publishes (_sessWithGapTimes) and its per-slot flags (_sessGapIdx).
STATE_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const hooks = A.App.sessionHook || {};
  const axis = Array.isArray(pane._sessWithGapTimes) ? pane._sessWithGapTimes : null;
  const flags = pane._sessGapIdx ? Array.from(pane._sessGapIdx) : null;
  const gapSlots = flags ? flags.filter((v) => v === 1).length : 0;
  let rows = 0;
  try { rows = pane.series.data ? pane.series.data().length : 0; } catch (e) {}
  return {
    bars: pane.bars.length,
    rows,
    axisLen: axis ? axis.length : 0,
    gapSlots,
    breaksOnly: !!pane._sessBreaksOnly,
    setting: (A.Settings.conf.sessionBreaks !== false),
    hookHasRefresh: typeof hooks.refreshBreaks === 'function',
    customSession: !!(hooks.active && hooks.active()),
  };
}"""

TOGGLE_JS = """(on) => {
  const A = window.__app;
  A.Settings.set('sessionBreaks', !!on);
  return { setting: A.Settings.conf.sessionBreaks };
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
            page.wait_for_timeout(1500)

            print('  -- 1. the setting exists --')
            st = page.evaluate(STATE_JS)
            print('    ' + json.dumps(st)[:300])
            if st.get('error'):
                check('series readable', False, st['error'])
            check('Session breaks defaults ON', st.get('setting') is True, st.get('setting'))
            check('the hook exposes refreshBreaks', st.get('hookHasRefresh') is True, st)

            print('  -- 2. gap slots are in the published axis --')
            check('the axis is LONGER than the bars (whitespace gaps present)',
                  (st.get('axisLen') or 0) > (st.get('bars') or 0),
                  str(st.get('axisLen')) + ' axis vs ' + str(st.get('bars')) + ' bars')
            check('the axis carries real gap slots', (st.get('gapSlots') or 0) > 0, st.get('gapSlots'))
            check('the gap count is a multiple of 3 (TV gap width)',
                  (st.get('gapSlots') or 0) % 3 == 0, st.get('gapSlots'))
            check('the pane is marked as breaks-only', st.get('breaksOnly') is True, st.get('breaksOnly'))

            print('  -- 3. turning it OFF removes the gaps --')
            page.evaluate(TOGGLE_JS, False)
            page.wait_for_timeout(1200)
            off = page.evaluate(STATE_JS)
            print('    ' + json.dumps(off)[:260])
            check('setting is off', off.get('setting') is False, off.get('setting'))
            check('no gap slots remain', (off.get('gapSlots') or 0) == 0, off.get('gapSlots'))
            check('no gap axis is published at all', (off.get('axisLen') or 0) == 0, off.get('axisLen'))
            check('the bars are intact', (off.get('bars') or 0) > 100, off.get('bars'))
            check('the breaks flag is cleared', off.get('breaksOnly') is False, off.get('breaksOnly'))

            print('  -- 4. turning it back ON restores them --')
            page.evaluate(TOGGLE_JS, True)
            page.wait_for_timeout(1200)
            on = page.evaluate(STATE_JS)
            check('gaps are back', (on.get('gapSlots') or 0) > 0, on.get('gapSlots'))
            check('the axis is longer than the bars again', (on.get('axisLen') or 0) > (on.get('bars') or 0), on)

            print('  -- 5. graceful on a single-day window --')
            # switch to a timeframe where the loaded window is one day
            page.evaluate("() => { window.__app.Manager.setTf(window.__app.App.activePane, 'MN1'); }")
            page.wait_for_timeout(2500)
            day = page.evaluate(STATE_JS)
            check('a single-bucket timeframe does not crash', not day.get('error'), day.get('error'))
            check('still renders rows', (day.get('rows') or 0) > 0, day.get('rows'))
            page.evaluate("() => { window.__app.Manager.setTf(window.__app.App.activePane, 'M15'); }")
            page.wait_for_timeout(2500)

            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND288b: %d failed' % len(FAILS) if FAILS else 'ROUND288b: all green')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
