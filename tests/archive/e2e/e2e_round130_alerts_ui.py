#!/usr/bin/env python3
"""ROUND130 e2e — the Alerts panel redesigned: tidy, unified, beautiful.

Boots the demo broker + renderer, then:

 [1] ORDER: the alert list sits ABOVE the settings stack; the three blocks
     are uniform accordion cards (icon chip + title + switch + chevron),
     all COLLAPSED by default
 [2] ACCORDIONS: clicking a header expands/collapses that card only — and
     clicking a header switch toggles the switch WITHOUT folding the card
 [3] PERSISTENCE: an opened card survives a full page reload
 [4] SOUND CARD: picker + segmented Repeat + (hidden) Stop button live in
     the body; the header switch mirrors cfg.enabled; seg writes cfg.loop
 [5] TRADING-ALERTS CARD: the three type pills; a real demo trade produces
     a per-trade row with working SL/TP mini pills
 [6] NOTIFICATIONS CARD: capture-on auto-expands; a real demo trade lands
     as an OPEN row with a time; the badge counts; per-row delete + Clear
     all still work; a REAL click on the bell expands/collapses
 [7] the daily purge contract still holds (forced sweep / gate / stamp)
 [8] screenshots: dark + light theme of the redesigned panel
 [9] zero page errors across the whole run

Exits 0 only if every check passes.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8937, 8777
SHOTS = os.path.join(ROOT, 'docs', 'shots-round130')
FAILS = []
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


# showTab is a TOGGLE when the tab is already open+active (TV behavior) —
# after a reload the boot auto-restores the saved tab, so guard every call
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
            page.evaluate(SHOW_ALERTS)
            page.wait_for_timeout(300)

            print('— [0] deterministic slate: close leftover positions, reset toggles —')
            page.evaluate("""
            async () => {
              const A = window.__app;
              for (const p of (A.TradeRoute.positions ? A.TradeRoute.positions() : A.Trade.positions) || []) {
                try { await A.TradeRoute.close(p.ticket); } catch (e) {}
              }
              A.TradeAlerts.cfg.enabled = true;
              A.TradeAlerts.setCfg('onSL', true);
              A.TradeAlerts.setCfg('notifyLog', false);
              A.TradeAlerts.clearNlog();
            }""")
            page.wait_for_timeout(2800)   # one state poll + margin
            check('the demo book is clean (no leftover positions)',
                  page.evaluate("() => ((A => (A.TradeRoute.positions ? A.TradeRoute.positions() : A.Trade.positions) || [])(window.__app)).length") == 0)

            print('— [1] the tidy order: list first, three uniform collapsed cards —')
            geo = page.evaluate("""
            () => {
              const list = document.querySelector('#tab-alerts #alert-list').getBoundingClientRect();
              const stack = document.querySelector('#tab-alerts #al-stack').getBoundingClientRect();
              const cards = [...document.querySelectorAll('#al-stack > div')].map((d) => ({
                id: d.id, head: !!d.querySelector('.al-head'), body: !!d.querySelector('.al-body'),
                ico: !!d.querySelector('.al-head .al-ico, .al-head .tn-bell'),
                t: (d.querySelector('.al-t, .tn-title') || {}).textContent || '',
                sw: !!d.querySelector('.al-head .al-sw input'),
                chev: !!d.querySelector('.al-head .al-chev'),
              }));
              return { listTop: list.top, stackTop: stack.top, listH: list.height, cards };
            }""")
            check('the alert list renders ABOVE the settings stack', geo['listTop'] < geo['stackTop'], str(geo['listTop']))
            check('the list keeps the bulk of the panel (flex:1)', geo['listH'] >= 110, str(geo['listH']))
            check('the stack holds exactly the 3 cards in order (notifications, trading alerts, sound)',
                  [c['id'] for c in geo['cards']] == ['trade-notify-log', 'trade-alert-settings', 'alert-sound-settings'],
                  str([c['id'] for c in geo['cards']]))
            check('every card has the uniform header (icon chip + title + switch + chevron)',
                  all(c['head'] and c['ico'] and c['sw'] and c['chev'] for c in geo['cards']), str(geo['cards']))
            check('every card is COLLAPSED by default (no body rendered)',
                  all(not c['body'] for c in geo['cards']), str([c['body'] for c in geo['cards']]))
            titles = [c['t'] for c in geo['cards']]
            check('titles: "Trade notifications" / "Trading alerts" / "Sound & repeat"',
                  titles == ['Trade notifications', 'Trading alerts', 'Sound & repeat'], str(titles))

            print('— [2] accordion behavior + switch-safe headers —')
            page.evaluate("() => document.querySelector('#alert-sound-settings .al-head').click()")
            page.wait_for_timeout(200)
            check('clicking the sound header EXPANDS it (picker + seg + stop appear)',
                  page.evaluate("() => !!document.querySelector('#alert-sound-settings .al-body #alert-sound-select') && !!document.querySelector('#alert-sound-settings .al-body #alert-loop-seg')"))
            check('the card carries .al-open (chevron rotates with it)',
                  page.evaluate("() => document.querySelector('#alert-sound-settings .al-card').classList.contains('al-open')"))
            page.evaluate("() => document.querySelector('#alert-sound-on').click()")
            page.wait_for_timeout(200)
            check('clicking the header SWITCH did NOT fold the card (only flipped the switch)',
                  page.evaluate("() => !!document.querySelector('#alert-sound-settings .al-body') && !document.querySelector('#alert-sound-on').checked"))
            page.evaluate("() => document.querySelector('#alert-sound-on').click()")  # restore ON
            page.evaluate("() => document.querySelector('#alert-sound-settings .al-head').click()")
            page.wait_for_timeout(520)
            check('clicking the sound header again COLLAPSES it',
                  page.evaluate("() => !document.querySelector('#alert-sound-settings .al-body')"))

            print('— [3] the opened card persists across a reload —')
            page.evaluate("() => document.querySelector('#alert-sound-settings .al-head').click()")
            page.wait_for_timeout(200)
            page.reload()
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_timeout(700)
            page.evaluate(SHOW_ALERTS)
            page.wait_for_timeout(300)
            check('after the reload the sound card is STILL open',
                  page.evaluate("() => !!document.querySelector('#alert-sound-settings .al-body')"))
            check('the other two cards stayed collapsed',
                  page.evaluate("() => !document.querySelector('#trade-notify-log .al-body') && !document.querySelector('#trade-alert-settings .al-body')"))

            print('— [4] the sound card body works —')
            check('the header switch mirrors cfg.enabled (on)',
                  page.evaluate("() => document.querySelector('#alert-sound-on').checked && window.__app.Alerts.cfg.enabled !== false"))
            check('the Stop button ships hidden (CSSOM, not inline)',
                  page.evaluate("() => document.querySelector('#alert-sound-stop').style.display === 'none'"))
            page.evaluate("() => document.querySelector('#alert-loop-seg button[data-v=\"2\"]').click()")
            check('the segmented Repeat pill writes cfg.loop = 2 (persisted)',
                  page.evaluate("() => String(window.__app.Alerts.cfg.loop) === '2'"))
            page.evaluate("() => document.querySelector('#alert-loop-seg button[data-v=\"1\"]').click()")  # restore

            print('— [5] the trading-alerts card: type pills + per-trade pills —')
            page.evaluate("() => document.querySelector('#trade-alert-settings .al-head').click()")
            page.wait_for_timeout(200)
            pills = page.evaluate("""
            () => [...document.querySelectorAll('#trade-alert-settings .ta-defs .sw-row')].map((l) => ({
              id: l.querySelector('input').id, on: l.querySelector('input').checked }))""")
            check('the three type pills render checked (fill / sl / tp)',
                  [x['id'] for x in pills] == ['ta-fill', 'ta-sl', 'ta-tp'] and all(x['on'] for x in pills), str(pills))
            page.evaluate("() => document.querySelector('#ta-sl').click()")
            check('toggling the SL pill writes cfg.onSL = false',
                  page.evaluate("() => window.__app.TradeAlerts.cfg.onSL === false"))
            page.evaluate("() => document.querySelector('#ta-sl').click()")  # restore
            placed = page.evaluate("""
            async () => {
              const A = window.__app;
              const sym = A.App.panes[0].symbol;
              return await A.TradeRoute.sendOrder({ symbol: sym, orderType: 0, volume: 0.10, price: 0, sl: 0, tp: 0, deviation: 20, comment: 'e2e130' });
            }""")
            check('the demo market order was accepted', bool(placed and placed.get('ok')), str(placed))
            page.wait_for_timeout(2600)
            rows = page.evaluate("""
            () => [...document.querySelectorAll('#ta-list .ta-row')].map((r) => ({
              name: r.querySelector('.ta-name b').textContent,
              togs: [...r.querySelectorAll('.ta-tog em')].map((e) => e.textContent) }))""")
            check('the open trade produced a per-trade row with SL/TP mini pills',
                  len(rows) == 1 and rows[0]['togs'] == ['SL', 'TP'], str(rows))
            page.evaluate("() => document.querySelector('#ta-list .ta-row .ta-tog input').click()")
            check('the per-trade SL pill works (items[0].sl = false)',
                  page.evaluate("() => window.__app.TradeAlerts.items.some((i) => i.sl === false)"))
            page.evaluate("() => document.querySelector('#ta-list .ta-row .ta-tog input').click()")  # restore

            print('— [6] the notifications card: capture, badge, rows, cleanup —')
            page.evaluate("() => document.querySelector('#tn-enabled').click()")
            page.wait_for_timeout(300)
            check('turning capture ON auto-expanded the card',
                  page.evaluate("() => !!document.querySelector('#trade-notify-log .al-body #tn-list')"))
            check('the empty hint shows',
                  page.evaluate("() => /No events yet/.test(document.querySelector('#tn-list').textContent)"))
            placed2 = page.evaluate("""
            async () => {
              const A = window.__app;
              const sym = A.App.panes[0].symbol;
              return await A.TradeRoute.sendOrder({ symbol: sym, orderType: 0, volume: 0.05, price: 0, sl: 0, tp: 0, deviation: 20, comment: 'e2e130b' });
            }""")
            check('a second demo order was accepted', bool(placed2 and placed2.get('ok')), str(placed2))
            page.wait_for_timeout(2600)
            check('the OPEN event landed with its time',
                  page.evaluate("() => document.querySelector('#tn-list .tn-row .tn-tag').textContent === 'OPEN'") and
                  page.evaluate("() => document.querySelector('#tn-list .tn-row .tn-time').textContent.trim() !== ''"))
            # collapse, then CLOSE the trade — the badge must count while collapsed
            page.evaluate("() => document.querySelector('#trade-notify-log .al-head').click()")
            page.wait_for_timeout(520)
            t2 = page.evaluate("() => window.__app.Trade.positions.map((p) => p.ticket).pop()")
            page.evaluate("(t) => window.__app.TradeRoute.close(t)", t2)
            page.wait_for_timeout(2600)
            check('the badge counted the CLOSE while collapsed (=2)',
                  page.evaluate("() => document.querySelector('#tn-badge').textContent") == '2')
            page.click('#tn-bell')   # a REAL user click on the bell
            page.wait_for_timeout(200)
            check('a real bell click expands the list (CLOSE newest first)',
                  page.evaluate("() => document.querySelector('#tn-list .tn-row .tn-tag').textContent") == 'CLOSE')
            page.evaluate("() => document.querySelector('#tn-list .tn-row .tn-del').click()")
            page.wait_for_timeout(300)
            check('per-row delete leaves one row (badge = 1)',
                  page.evaluate("() => document.querySelector('#tn-badge').textContent") == '1')
            page.evaluate("() => document.querySelector('#tn-clear').click()")
            page.wait_for_timeout(300)
            check('Clear all empties the list (badge hidden)',
                  page.evaluate("() => document.querySelector('#tn-badge').classList.contains('tn-zero')"))

            print('— [7] the daily auto-purge contract still holds —')
            pr = page.evaluate("""
            () => {
              const A = window.__app;
              A.TradeAlerts.nlog.unshift({ id: 'r130-old', type: 'open', msg: 'OLD', at: Date.now() - 25 * 3600e3 });
              A.TradeAlerts.nlog.unshift({ id: 'r130-new', type: 'open', msg: 'NEW', at: Date.now() });
              const forced = A.TradeAlerts.purgeNlog(true);
              const gated = A.TradeAlerts.purgeNlog();
              return { forced, gated, stamp: Number(localStorage.getItem('mt5_trnotify_purge') || 0),
                       ids: A.TradeAlerts.nlog.map((r) => r.id) };
            }""")
            check('the forced sweep dropped the 25 h row, the gate held after it',
                  pr['forced'] == 1 and pr['gated'] == 0 and pr['stamp'] > 0 and pr['ids'] == ['r130-new'], str(pr))
            page.evaluate("() => window.__app.TradeAlerts.clearNlog()")

            print('— [8] screenshots (dark + light) —')
            os.makedirs(SHOTS, exist_ok=True)
            page.evaluate("""
            () => { const h = document.querySelector('#trade-notify-log .al-head');
                    if (!document.querySelector('#trade-notify-log .al-body')) h.click(); }""")
            page.evaluate("""
            () => { const h = document.querySelector('#trade-alert-settings .al-head');
                    if (!document.querySelector('#trade-alert-settings .al-body')) h.click(); }""")
            page.evaluate("""
            () => {
              const A = window.__app;
              const now = Date.now();
              A.TradeAlerts.nlog.unshift({ id: 'shot1', type: 'open', msg: 'Position opened — EURUSD BUY 0.10 @ 1.08421 (#5001)', at: now - 3600e3 });
              A.TradeAlerts.nlog.unshift({ id: 'shot2', type: 'tp', msg: 'Take profit hit — EURUSD BUY 0.10 @ 1.08640 (#5001)', at: now - 1800e3 });
              A.TradeAlerts.nlog.unshift({ id: 'shot3', type: 'partial', msg: 'Partial close — EURUSD BUY 0.03 of 0.10 lots (#5001)', at: now - 600e3 });
              A.TradeAlerts.nlog.unshift({ id: 'shot4', type: 'close', msg: 'Position closed — EURUSD BUY 0.07 (#5001)', at: now - 120e3 });
            }""")
            page.wait_for_timeout(1600)   # onChange re-render paints the rows
            check('the seeded shot rows render (4 tags)',
                  page.evaluate("() => document.querySelectorAll('#tn-list .tn-row').length === 4"), )
            alert_card = page.locator('#tab-alerts')
            alert_card.screenshot(path=os.path.join(SHOTS, 'alerts-round130-dark.png'))
            page.evaluate("() => document.body.classList.add('theme-light')")
            page.wait_for_timeout(200)
            alert_card.screenshot(path=os.path.join(SHOTS, 'alerts-round130-light.png'))
            page.evaluate("() => document.body.classList.remove('theme-light')")
            page.evaluate("() => window.__app.TradeAlerts.clearNlog()")

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
