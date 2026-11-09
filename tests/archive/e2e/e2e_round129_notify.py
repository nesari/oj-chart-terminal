#!/usr/bin/env python3
"""ROUND129 e2e — the trade-notification list lives BEHIND a bell icon and
self-cleans once a day (user request).

Boots the demo broker + renderer, then:

 [1] the Alerts section renders a compact BELL header (icon + count badge +
     title + capture switch) with the list COLLAPSED by default — no list
     rows in the DOM until the bell is clicked
 [2] clicking the bell expands the list INSIDE the same Alerts section
     (off-explanation first); clicking again collapses it; the choice
     persists across a page reload
 [3] turning the capture switch on auto-expands; a real demo trade then
     lands in the list with a time (badge increments while collapsed too)
 [4] per-row delete removes ONE row; Clear all empties the list
 [5] the AUTO-PURGE: a forced sweep drops a 25 h-old event and keeps the
     fresh one (returns the removal count); an immediate unforced call is
     GATED (returns 0); the stamp persists in localStorage
 [6] zero page errors across the whole run

Exits 0 only if every check passes.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8935, 8777
FAILS = []
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


# showTab is a TOGGLE when the tab is already open+active — after a reload
# the boot auto-restores the saved tab, so guard the call (ROUND130 lesson)
SHOW_ALERTS = """() => {
  const tab = document.getElementById('tab-alerts');
  if (!tab || tab.classList.contains('hidden')) window.__app.RightPanel.showTab('alerts');
}"""

def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if (not cond and extra != '') else ''))
    if not cond:
        FAILS.append(name)

def wait_port(port, timeout=20):
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
    threading.daemon = True
    t = threading.Thread(target=serve_http, daemon=True)
    t.start()
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up'); return 1
    ok = True
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1500, 'height': 880})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_timeout(900)

            # open the Alerts panel
            page.evaluate(SHOW_ALERTS)
            page.wait_for_timeout(300)

            print('— [1] the bell header (collapsed by default) —')
            check('bell icon exists in the Alerts section',
                  page.evaluate("() => !!document.querySelector('#trade-notify-log #tn-bell')"))
            check('the badge is hidden at zero events',
                  page.evaluate("() => document.querySelector('#tn-badge').classList.contains('tn-zero')"))
            check('the capture switch defaults OFF',
                  page.evaluate("() => !document.querySelector('#tn-enabled').checked"))
            check('the list is NOT in the DOM while collapsed',
                  page.evaluate("() => !document.querySelector('#trade-notify-log #tn-list')"))
            check('the collapsed state shows only the header (no body, ROUND130 card)',
                  page.evaluate("() => !document.querySelector('#trade-notify-log .al-body') && !!document.querySelector('#trade-notify-log .al-head')"))
            check('aria-expanded = false',
                  page.evaluate("() => document.querySelector('#tn-bell').getAttribute('aria-expanded') === 'false'"))

            print('— [2] bell click expands INSIDE the Alerts section —')
            page.click('#tn-bell')
            page.wait_for_timeout(500)
            check('expanded while OFF: explanation instead of a list (nothing captured yet)',
                  page.evaluate("() => !document.querySelector('#trade-notify-log #tn-list')"))
            check('the off-explanation shows (capture still off)',
                  page.evaluate("() => /Off — trade events are not listed/.test(document.querySelector('#trade-notify-log').textContent)"))
            check('aria-expanded = true',
                  page.evaluate("() => document.querySelector('#tn-bell').getAttribute('aria-expanded') === 'true'"))
            page.click('#tn-bell')
            page.wait_for_timeout(500)
            check('the second click collapses again',
                  page.evaluate("() => !document.querySelector('#trade-notify-log #tn-list')"))

            print('— [3] capture ON + a real demo trade lands with its time —')
            page.evaluate("() => document.querySelector('#tn-enabled').click()")
            page.wait_for_timeout(300)
            check('the switch turned capture on (persisted cfg)',
                  page.evaluate("() => window.__app.TradeAlerts.cfg.notifyLog === true"))
            check('turning it ON auto-expanded the list',
                  page.evaluate("() => !!document.querySelector('#trade-notify-log #tn-list')"))
            check('the empty hint shows',
                  page.evaluate("() => /No events yet/.test(document.querySelector('#tn-list').textContent)"))
            check('the auto-cleanup hint names the 24 h rule',
                  page.evaluate("() => /events older than 24 h are purged automatically once a day/.test(document.querySelector('#trade-notify-log .tn-hint').textContent)"))

            # COLLAPSE, then trade — the badge must count live while collapsed
            page.click('#tn-bell')
            page.wait_for_timeout(500)
            placed = page.evaluate("""
            async () => {
              const A = window.__app;
              const sym = A.App.panes[0].symbol;
              const r = await A.TradeRoute.sendOrder({ symbol: sym, orderType: 0, volume: 0.10, price: 0, sl: 0, tp: 0, deviation: 20, comment: 'e2e129' });
              return r;
            }""")
            check('the demo market order was accepted', bool(placed and placed.get('ok')), str(placed))
            page.wait_for_timeout(2600)   # one state poll (1.2 s) + margin
            check('the badge counts the OPEN event while COLLAPSED',
                  page.evaluate("() => document.querySelector('#tn-badge').textContent") == '1')
            page.click('#tn-bell')
            page.wait_for_timeout(500)
            rows = page.evaluate("""
            () => [...document.querySelectorAll('#tn-list .tn-row')].map((r) => ({
              msg: r.querySelector('.tn-msg').textContent,
              time: r.querySelector('.tn-time').textContent,
            }))""")
            check('one OPEN row with a non-empty time', len(rows) == 1 and rows[0]['time'].strip() != '', str(rows))

            ticket = page.evaluate("() => window.__app.Trade.positions[0] && window.__app.Trade.positions[0].ticket")
            page.evaluate("(t) => window.__app.TradeRoute.close(t)", ticket)
            page.wait_for_timeout(2600)
            check('the CLOSE event lands (badge = 2)',
                  page.evaluate("() => document.querySelector('#tn-badge').textContent") == '2')
            check('the newest row is the CLOSE (newest first)',
                  page.evaluate("() => document.querySelector('#tn-list .tn-row .tn-tag').textContent") == 'CLOSE')

            print('— [4] manual cleanup: per-row delete + Clear all —')
            page.evaluate("() => document.querySelector('#tn-list .tn-row .tn-del').click()")
            page.wait_for_timeout(300)
            check('per-row delete leaves one row (badge = 1)',
                  page.evaluate("() => document.querySelector('#tn-badge').textContent") == '1')
            page.evaluate("() => document.querySelector('#tn-clear').click()")
            page.wait_for_timeout(300)
            check('Clear all empties the list (badge hidden)',
                  page.evaluate("() => document.querySelector('#tn-badge').classList.contains('tn-zero')"))
            check('the empty hint is back',
                  page.evaluate("() => /No events yet/.test(document.querySelector('#tn-list').textContent)"))

            print('— [5] the once-a-day AUTO-PURGE —')
            pr = page.evaluate("""
            () => {
              const A = window.__app;
              A.TradeAlerts.nlog.unshift({ id: 'e2e-old', type: 'open', msg: 'OLD EVENT', at: Date.now() - 25 * 3600e3 });
              A.TradeAlerts.nlog.unshift({ id: 'e2e-new', type: 'open', msg: 'NEW EVENT', at: Date.now() });
              const forced = A.TradeAlerts.purgeNlog(true);          /* drops the 25 h row */
              const gated = A.TradeAlerts.purgeNlog();               /* same day -> gated */
              const stamp = Number(localStorage.getItem('mt5_trnotify_purge') || 0);
              return { forced, gated, stamp, ids: A.TradeAlerts.nlog.map((r) => r.id) };
            }""")
            check('the forced sweep removed exactly the 25 h event', pr['forced'] == 1, str(pr))
            check('the fresh event survived', pr['ids'] == ['e2e-new'], str(pr['ids']))
            check('an immediate unforced sweep is GATED (returns 0)', pr['gated'] == 0, str(pr))
            check('the last-purge stamp persists in localStorage', pr['stamp'] > 0, str(pr))
            page.wait_for_timeout(300)
            check('the badge mirrors the purged list (1)',
                  page.evaluate("() => document.querySelector('#tn-badge').textContent") == '1')

            print('— [6] the collapsed choice persists across a reload —')
            page.evaluate("() => { document.querySelector('#tn-bell').click(); }")
            page.wait_for_timeout(500)
            page.reload()
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_timeout(700)
            page.evaluate(SHOW_ALERTS)
            page.wait_for_timeout(300)
            check('after the reload the list is STILL collapsed',
                  page.evaluate("() => !document.querySelector('#trade-notify-log #tn-list')"))
            check('the persisted event is counted on the badge (1)',
                  page.evaluate("() => document.querySelector('#tn-badge').textContent") == '1')
            check('the capture switch is still ON (persisted cfg)',
                  page.evaluate("() => document.querySelector('#tn-enabled').checked"))

            check('zero page errors', len(errors) == 0, str(errors[:3]))
            browser.close()
    finally:
        try:
            prov.terminate(); prov.wait(timeout=5)
        except Exception:
            pass
    print('E2E', 'PASS' if not FAILS else 'FAIL')
    return 0 if not FAILS else 1

if __name__ == '__main__':
    raise SystemExit(main())
