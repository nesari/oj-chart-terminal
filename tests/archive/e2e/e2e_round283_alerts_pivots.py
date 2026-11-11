#!/usr/bin/env python3
"""ROUND283 e2e — Pine alerts bridge + ROUND282 pivots on the live chart.

Two live paths that only exist end-to-end:

  A. Pine -> Alerts bridge (ROUND279). A script raising alert() on the live
     bar must (1) land on the engine's live tape, (2) be drained by
     PineUI.pollAlerts() through the registered sink, and (3) reach the
     Alerts panel's Script alerts card as notification state (not history:
     the full-pass replay is suppressed by the renderer cursor). The card's
     master switch must silence it.

  B. Pivot levels (ROUND282). ta.pivot_point_levels + ta.max/ta.min +
     time("D") anchors must produce real drawings on the chart, proving the
     time()/bare-variable fixes reach the renderer.

Zero page errors throughout.

Run: python tests/archive/e2e/e2e_round283_alerts_pivots.py
"""
import http.server, functools, os, socket, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_teardown import kill_proc  # ROUND288: whole-tree cleanup on Windows

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8963, 8852
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


# A script that fires alert() and alertcondition() on the LIVE bar only.
ALERT_SRC = """//@version=5
indicator("TST283 alerts", overlay = true)
alertcondition(close > open, "Bullish bar", "close above open")
if barstate.islast
    alert("round283 live alert", alert.freq_once_per_bar)
plot(close)
"""

# The ROUND282 pivot fixture already lives in the corpus dir.
with open(os.path.join(ROOT, 'fixtures', 'pine', 'corpus', 'pivot-levels-sample.pine'), encoding='utf-8') as f:
    PIVOT_SRC = f.read()

# Stage A: install the script, rebuild, then drive the alert plumbing.
ALERT_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 1500));

  const seen = [];
  A.PineUI.setAlertSink((ev) => seen.push(ev));

  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const tapeBefore = st ? st.alerts : -1;
  const cursorBefore = st ? st.alertCursor : -1;

  /* A full pass must never surface as a live alert: the cursor starts past
     everything that pass produced. */
  const afterReplay = A.PineUI.pollAlerts();

  /* Now simulate the NEXT live bar: append a bar and push it (the same-bar
     forming re-run is deliberately deduped by the engine, so only a new bar
     may legitimately fire again).
     NOTE: the app's own Alerts.onTick hook drains the tape continuously, so
     the events may already have reached the sink by the time we poll. The
     contract under test is "the sink sees the live events exactly once", not
     "our manual poll is the one that drained them". */
  const bars = pane.bars.slice();
  const last = bars[bars.length - 1];
  const o = last.close;
  bars.push({ time: last.time + 900, open: o, high: o + 6, low: o - 1, close: o + 5, volume: 10 });
  st.rt.pushNewBar(bars);
  await new Promise((r) => setTimeout(r, 600));

  const drained = A.PineUI.pollAlerts();
  /* whatever the app drained, a further poll must find nothing new */
  const redrained = A.PineUI.pollAlerts();
  const inv = A.PineUI.pineAlertInventory();

  const out = {
    instId: inst.id,
    status: st ? st.status : 'no-st',
    errors: (st && st.errors) || [],
    tapeBefore, cursorBefore, afterReplay, drained, redrained,
    seen: seen.map((e) => ({ kind: e.kind, title: e.title, message: e.message, script: e.script })),
    inv: inv.map((i) => ({ title: i.title, key: i.key, script: i.script })),
    replaySuppressed: afterReplay === 0,
  };
  A.PineUI.remove(pane, inst.id);
  return out;
}"""

PIVOT_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 2500));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const out = { status: st ? st.status : 'no-st', errors: (st && st.errors) || [],
                line: 0, label: 0, plots: 0, shapes: 0 };
  if (st && st.rt && st.rt.store) {
    out.line = st.rt.store.line.size;
    out.label = st.rt.store.label.size;
  }
  if (st && st.rt && st.rt.out) {
    out.plots = st.rt.out.plotsOrder.length;
    out.shapes = st.rt.out.shapes.size;
  }
  A.PineUI.remove(pane, inst.id);
  return out;
}"""

# The Alerts panel card must exist, be switchable, and gate notifications.
CARD_JS = """() => {
  const A = window.__app;
  const box = document.getElementById('pine-alert-settings');
  const card = box && box.querySelector('.al-card');
  const master = box && box.querySelector('#pa-enabled');
  const title = box && box.querySelector('.al-t');
  const cfg = A.Alerts && A.Alerts.pineCfg;
  const before = cfg ? cfg.enabled : null;
  if (master) { master.checked = false; master.dispatchEvent(new Event('change')); }
  const off = A.Alerts.pineCfg.enabled;
  if (master) { master.checked = true; master.dispatchEvent(new Event('change')); }
  const on = A.Alerts.pineCfg.enabled;
  return { mounted: !!box, card: !!card, hasMaster: !!master,
           title: title ? title.textContent.trim() : '',
           before, off, on, persisted: !!(window.localStorage.getItem('mt5_pa_cfg')) };
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
            page = browser.new_page(viewport={'width': 1560, 'height': 900})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_function(
                "() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100",
                timeout=25000)

            print('  -- A. Pine -> Alerts bridge (ROUND279) --')
            a = page.evaluate(ALERT_JS, {'name': 'TST283-ALERTS', 'src': ALERT_SRC})
            print('    status=%s tape=%s cursor=%s replay=%s drained=%s' % (
                a.get('status'), a.get('tapeBefore'), a.get('cursorBefore'),
                a.get('afterReplay'), a.get('drained')))
            print('    seen=%s' % (a.get('seen'),))
            check('alert script runs', a['status'] == 'ok', a.get('errors'))
            check('the full pass produced a tape', (a.get('tapeBefore') or 0) > 0, a)
            check('renderer cursor starts past the replay tape',
                  (a.get('cursorBefore') or 0) >= (a.get('tapeBefore') or 0), a)
            check('history replay surfaces NO live alert', a.get('replaySuppressed') is True, a)
            kinds = {e.get('kind') for e in (a.get('seen') or [])}
            check('a new live bar delivered alerts to the sink',
                  ('condition' in kinds or 'alert' in kinds), a.get('seen'))
            check('polling is idempotent (nothing new on a second drain)', a.get('redrained') == 0, a)
            check('the sink received events', len(a.get('seen') or []) > 0, a.get('seen'))
            check('a condition event was delivered', 'condition' in kinds, kinds)
            check('an alert() message was delivered', 'alert' in kinds, kinds)
            check('the inventory lists the alertcondition',
                  any(i.get('title') == 'Bullish bar' for i in (a.get('inv') or [])), a.get('inv'))

            print('  -- B. Script alerts card --')
            c = page.evaluate(CARD_JS)
            print('    mounted=%s card=%s title=%r before=%s off=%s on=%s' % (
                c.get('mounted'), c.get('card'), c.get('title'), c.get('before'), c.get('off'), c.get('on')))
            check('the card is mounted in the Alerts panel', c.get('mounted') is True and c.get('card') is True, c)
            check('the card is titled "Script alerts"', c.get('title') == 'Script alerts', c.get('title'))
            check('the master switch turns notifications off', c.get('off') is False, c)
            check('and back on', c.get('on') is True, c)
            check('the setting persists to mt5_pa_cfg', c.get('persisted') is True, c)

            print('  -- C. ROUND282 pivots render on the live chart --')
            b = page.evaluate(PIVOT_JS, {'name': 'TST283-PIVOTS', 'src': PIVOT_SRC})
            print('    status=%s line=%s label=%s plots=%s shapes=%s' % (
                b.get('status'), b.get('line'), b.get('label'), b.get('plots'), b.get('shapes')))
            check('pivot fixture runs live', b['status'] == 'ok', b.get('errors'))
            check('pivot lines drawn (time("D") anchors fire)', (b.get('line') or 0) > 0, b)
            check('pivot labels drawn', (b.get('label') or 0) > 0, b)
            check('plots present (ta.max/ta.min)', (b.get('plots') or 0) >= 5, b)
            check('session shape drawn', (b.get('shapes') or 0) > 0, b)

            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        kill_proc(prov)
    print('ROUND283: %d failed' % len(FAILS) if FAILS else 'ROUND283: all green')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
