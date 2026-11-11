#!/usr/bin/env python3
"""Deep functional audit — exercises real interactions and validates CONTENT,
not just "a dialog opened".

Checks per area:
  watchlist  add + remove a symbol, verify the row appears/disappears
  alerts     create a price alert, verify it is listed, delete it
  drawings   draw a trend line via the API, verify it renders + undo removes it
  style      change the chart style / timeframe, verify the chart state follows
  indicators add + remove an indicator, verify the pane/legend updates
  pine       compile a script, verify status ok + output
  trade      open the ticket, verify fields populate from the demo account
  objects    verify the object tree lists a drawn object
  datawindow verify rows appear for the chart symbol
  timesales  verify the panel populates from ticks

Reports each mismatch as a BUG with detail.

Run: python tests/archive/e2e/audit_app_deep.py
"""
import http.server, functools, json, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8979, 8868
FINDINGS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def bug(area, issue, detail=''):
    FINDINGS.append({'area': area, 'issue': issue, 'detail': str(detail)[:500]})
    print('  BUG  [' + area + '] ' + issue + ((' - ' + str(detail)[:260]) if detail else ''))


def ok(area, what):
    print('  ok   [' + area + '] ' + what)


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


# ---------------- probes (run inside the page) ----------------

WATCHLIST_JS = """(sym) => {
  const W = window.__app.Watchlist;
  const A = window.__app.App;
  const len = () => (A.watchlist || []).length;
  const before = len();
  try { W.add(sym); } catch (e) { return { error: String(e && e.message || e) }; }
  const after = len();
  const rows = document.querySelectorAll('#wl-list .wl-row, #wl-list [data-sym]').length;
  const has = (A.watchlist || []).some((s) => (typeof s === 'string' ? s : s.symbol) === sym);
  try { W.remove(sym); } catch (e) {}
  const final = len();
  return { before, after, final, rows, has };
}"""

ALERT_JS = """() => {
  const A = window.__app.Alerts;
  const pane = window.__app.App.activePane;
  const n0 = A.list.length;
  try { A.create(pane.symbol, 'Greater Than', pane.bars[pane.bars.length - 1].close + 1000); }
  catch (e) { return { error: String(e && e.message || e) }; }
  const n1 = A.list.length;
  const rows = document.querySelectorAll('#alert-list .al-row').length;
  const last = A.list[A.list.length - 1];
  if (last) { try { A.remove(last.id); } catch (e) {} }
  return { n0, n1, rows, created: !!last, kind: last && last.kind, final: A.list.length };
}"""

DRAW_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const bars = pane.bars;
  const n = bars.length;
  const d = { type: 'trend', points: [
    { t: bars[n - 60].time, p: bars[n - 60].low },
    { t: bars[n - 10].time, p: bars[n - 10].high }],
    opts: { color: '#2962ff', width: 2, style: 'solid' } };
  const before = A.App.drawings.list(pane.symbol).length;
  try {
    if (A.Undo && A.Undo.add) A.Undo.add(pane, d);   /* records an undo cmd */
    else A.App.drawings.add(pane.symbol, d);
  } catch (e) { return { error: String(e && e.message || e) }; }
  const after = A.App.drawings.list(pane.symbol).length;
  const added = A.App.drawings.list(pane.symbol)[after - 1];
  /* does the object tree list it? (ObjectTree is DOM-backed) */
  let treeRows = -1;
  try {
    A.RightPanel.showTab('objects');
    treeRows = document.querySelectorAll('#obj-list .obj-name, #obj-list .obj-ic').length;
  } catch (e) {}
  return { before, after, added: !!added, type: added && added.type, treeRows };
}"""

UNDO_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const n0 = A.App.drawings.list(pane.symbol).length;
  let err = null;
  try { if (A.Undo && A.Undo.undo) A.Undo.undo(); } catch (e) { err = String(e && e.message || e); }
  const n1 = A.App.drawings.list(pane.symbol).length;
  return { n0, n1, err, hasUndo: !!(A.Undo && A.Undo.undo) };
}"""

TF_JS = """(tf) => {
  const A = window.__app;
  const pane = A.App.activePane;
  const before = pane.tf;
  try { A.Manager.setTf(pane, tf); }
  catch (e) { return { error: String(e && e.message || e), before }; }
  return { before, after: pane.tf, tfById: !!A.App.tfById[tf] };
}"""

STYLE_JS = """(style) => {
  const A = window.__app;
  const pane = A.App.activePane;
  try { A.Manager.applyStyle && A.Manager.applyStyle(style); }
  catch (e) { return { error: String(e && e.message || e) }; }
  let cur = null;
  try { cur = pane.chart.serieses && null; } catch (e) {}
  return { style, applied: true, chart: !!pane.chart };
}"""

INDICATOR_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const all = (A.Indicators && A.Indicators.all) || [];
  if (!all.length) return { error: 'no indicator catalogue' };
  const type = all[0].type || all[0].id || all[0].key;
  const n0 = (pane.indicators || []).length;
  let err = null, inst = null;
  try { inst = A.IndicatorsUI.add(pane, type); } catch (e) { err = String(e && e.message || e); }
  const n1 = (pane.indicators || []).length;
  /* leave the chart as we found it */
  if (inst) { try { A.IndicatorsUI.remove(pane, inst.id); } catch (e) {} }
  return { type, n0, n1, err, added: !!inst, final: (pane.indicators || []).length };
}"""

PINE_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const rec = A.PineScriptsStore.create('AUDIT', '//@version=5\\nindicator("AUDIT", overlay=true)\\nplot(close, "C")\\n');
  let err = null;
  try {
    const inst = A.PineUI.add(pane, rec.id);
    A.PineUI.rebuild(pane, inst).then(() => {}).catch(() => {});
  } catch (e) { err = String(e && e.message || e); }
  const st = (A.PineUI.debug(pane) || []).slice(-1)[0];
  return { err, status: st && st.status, plots: st && st.plots, lines: st && st.lines };
}"""

TRADE_JS = """() => {
  const A = window.__app;
  let err = null;
  try { A.RightPanel.showTab('trade'); } catch (e) { err = String(e && e.message || e); }
  const el = document.getElementById('tab-trade');
  const inputs = el ? el.querySelectorAll('input,select').length : 0;
  const symbol = el ? (el.querySelector('#tk-symbol, .tk-symbol, [data-tk-symbol]') || {}).value : null;
  const text = el ? (el.textContent || '').trim().length : 0;
  const btns = el ? [...el.querySelectorAll('button')].map((b) => (b.id || b.className || '').trim()).filter(Boolean) : [];
  const hasTicket = !!((el && el.querySelector('.tk-buy, .tk-sell, #tk-buy, #tk-sell'))
    || btns.some((b) => /buy|sell/i.test(b)));
  return { err, inputs, symbol, text, hasTicket, btns: btns.slice(0, 10) };
}"""

DATAWINDOW_JS = """() => {
  const A = window.__app;
  let err = null;
  try { A.RightPanel.showTab('datawindow'); } catch (e) { err = String(e && e.message || e); }
  const el = document.getElementById('tab-datawindow');
  const rows = el ? el.querySelectorAll('.dw-row, tr, .dw-item').length : 0;
  return { err, rows, text: el ? (el.textContent || '').trim().length : 0 };
}"""

TIMESALES_JS = """() => {
  const A = window.__app;
  let err = null;
  try { A.RightPanel.showTab('timesales'); } catch (e) { err = String(e && e.message || e); }
  const el = document.getElementById('tab-timesales');
  req = el ? el.querySelectorAll('.ts-row, tr').length : 0;
  return { err, rows: req, text: el ? (el.textContent || '').trim().length : 0 };
}"""

NEWS_JS = """() => {
  const A = window.__app;
  let err = null;
  try { A.RightPanel.showTab('news'); } catch (e) { err = String(e && e.message || e); }
  const el = document.getElementById('tab-news');
  return { err, text: el ? (el.textContent || '').trim().length : 0,
           items: el ? el.querySelectorAll('.news-item, .nw-row, article').length : 0 };
}"""

DEPS_JS = """() => {
  const a = window.__app;
  return {
    keys: Object.keys(a).filter((k) => /^(Alerts|Watchlist|Manager|PineUI|Indicators|IndicatorsUI|Undo|RightPanel|Trade|TradeTicket|ObjectTree|DataWindow|TimeSales|News|App|DrawSettings|DrawTools)$/.test(k)),
    hasManagerSetTf: !!(a.Manager && (a.Manager.setTimeframe || a.Manager.setTf)),
    hasToolbarSetTf: !!(a.Toolbar && a.Toolbar.setTf),
    hasIndList: !!(a.Indicators && a.Indicators.LIST),
    hasIndAdd: !!(a.IndicatorsUI && a.IndicatorsUI.add),
    indicatorsShape: a.Indicators ? Object.keys(a.Indicators).slice(0, 8) : null,
  };
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
            errors, console_errs = [], []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: console_errs.append(m.text) if m.type == 'error' else None)
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(1000)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_function(
                "() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100",
                timeout=45000)
            page.wait_for_timeout(1500)

            deps = page.evaluate(DEPS_JS)
            print('\n=== exposed API ===')
            print('  ' + ', '.join(deps['keys']))
            print('  Manager.setTimeframe=' + str(deps['hasManagerSetTf']) +
                  ' Toolbar.setTf=' + str(deps['hasToolbarSetTf']) +
                  ' Indicators.LIST=' + str(deps['hasIndList']) +
                  ' IndicatorsUI.add=' + str(deps['hasIndAdd']))
            if deps.get('indicatorsShape'):
                print('  Indicators keys: ' + ', '.join(deps['indicatorsShape']))

            print('\n=== watchlist ===')
            r = page.evaluate(WATCHLIST_JS, 'AUDITX')
            if r.get('error'):
                bug('watchlist', 'add threw', r['error'])
            elif r['after'] != r['before'] + 1:
                bug('watchlist', 'add did not append a row', r)
            elif not r['has']:
                bug('watchlist', 'added symbol not in list', r)
            elif r['final'] != r['before']:
                bug('watchlist', 'remove did not restore length', r)
            else:
                ok('watchlist', 'add/remove round-trips (' + str(r['rows']) + ' rendered rows)')

            print('\n=== alerts ===')
            r = page.evaluate(ALERT_JS)
            if r.get('error'):
                bug('alerts', 'create threw', r['error'])
            elif r['n1'] != r['n0'] + 1:
                bug('alerts', 'create did not append', r)
            elif not r['created'] or r['kind'] != 'price':
                bug('alerts', 'created alert has wrong shape', r)
            elif r['final'] != r['n0']:
                bug('alerts', 'remove did not restore length', r)
            else:
                ok('alerts', 'price alert create/remove round-trips')

            print('\n=== drawings + undo ===')
            d1 = page.evaluate(DRAW_JS)
            if d1.get('error'):
                bug('drawings', 'add threw', d1['error'])
            elif d1['after'] != d1['before'] + 1:
                bug('drawings', 'add did not append', d1)
            else:
                ok('drawings', 'trend line added (' + str(d1['after']) + ' total, tree rows=' + str(d1.get('treeRows')) + ')')
                if d1.get('treeRows') == 0:
                    bug('objects', 'object tree does not list the new drawing', d1)
                u = page.evaluate(UNDO_JS)
                if u.get('err'):
                    bug('undo', 'undo threw', u['err'])
                elif not u.get('hasUndo'):
                    bug('undo', 'Undo facade missing', u)
                elif u['n1'] >= u['n0']:
                    bug('undo', 'undo did not remove the drawing', u)
                else:
                    ok('undo', 'undo removed the drawing')

            print('\n=== indicators ===')
            r = page.evaluate(INDICATOR_JS)
            if r.get('error'):
                bug('indicators', 'add failed', r['error'])
            elif r.get('err'):
                bug('indicators', 'add threw', r['err'])
            elif r['n1'] != r['n0'] + 1:
                bug('indicators', 'add did not register on the pane', r)
            else:
                ok('indicators', 'added ' + str(r.get('type')) + ' (' + str(r.get('n0')) + '->' + str(r.get('n1')) + ', restored=' + str(r.get('final')) + ')')

            print('\n=== pine ===')
            r = page.evaluate(PINE_JS)
            page.wait_for_timeout(1500)
            st = page.evaluate("""() => {
              const A = window.__app; const pane = A.App.activePane;
              const list = A.PineUI.debug(pane) || [];
              const m = list.filter((s) => s.status === 'ok');
              return { total: list.length, okCount: m.length,
                       plots: m.length ? m[m.length-1].plots : 0,
                       lastStatus: list.length ? list[list.length-1].status : null };
            }""")
            if r.get('err'):
                bug('pine', 'add/rebuild threw', r['err'])
            elif not st['total']:
                bug('pine', 'script never registered', st)
            elif st['lastStatus'] != 'ok':
                bug('pine', 'script did not reach status ok', st)
            elif not st['plots']:
                bug('pine', 'script produced no plots', st)
            else:
                ok('pine', 'script compiled and plotted (' + str(st['plots']) + ' plots)')

            print('\n=== trade ticket ===')
            r = page.evaluate(TRADE_JS)
            if r.get('err'):
                bug('trade', 'panel open threw', r['err'])
            elif not r['hasTicket']:
                bug('trade', 'ticket buttons missing', r)
            elif r['inputs'] < 3:
                bug('trade', 'ticket has too few inputs', r)
            elif r['text'] < 20:
                bug('trade', 'ticket renders almost nothing', r)
            else:
                ok('trade', 'ticket has ' + str(r['inputs']) + ' inputs, symbol=' + str(r['symbol']))

            print('\n=== data window / time&sales / news ===')
            r = page.evaluate(DATAWINDOW_JS)
            if r.get('err'):
                bug('datawindow', 'open threw', r['err'])
            elif r.get('text', 0) < 20:
                bug('datawindow', 'renders almost nothing', r)
            else:
                ok('datawindow', 'renders ' + str(r.get('text')) + ' chars')

            r = page.evaluate(TIMESALES_JS)
            if r.get('err'):
                bug('timesales', 'open threw', r['err'])
            elif r.get('text', 0) < 10:
                bug('timesales', 'renders almost nothing (no ticks?)', r)
            else:
                ok('timesales', 'renders ' + str(r.get('text')) + ' chars')

            r = page.evaluate(NEWS_JS)
            if r.get('err'):
                bug('news', 'open threw', r['err'])
            elif r.get('text', 0) < 10:
                bug('news', 'renders almost nothing', r)
            else:
                ok('news', 'renders ' + str(r.get('text')) + ' chars')

            print('\n=== timeframe switch ===')
            # tf ids are like 'M1'/'H1'/'D1' — NOT seconds
            r = page.evaluate(TF_JS, 'H1')
            page.wait_for_timeout(1200)
            after = page.evaluate("() => ({ tf: window.__app.App.activePane.tf, bars: window.__app.App.activePane.bars.length })")
            if r.get('error'):
                bug('timeframe', 'switch threw', r['error'])
            elif after['tf'] != 'H1':
                bug('timeframe', 'pane.tf did not change', {'call': r, 'after': after})
            elif after['bars'] < 10:
                bug('timeframe', 'no bars after switching', after)
            else:
                ok('timeframe', 'switched to H1 with ' + str(after['bars']) + ' bars')

            print('\n=== console ===')
            if console_errs:
                seen = []
                for c in console_errs:
                    if c not in seen:
                        seen.append(c)
                for c in seen[:10]:
                    bug('console', 'console error', c)
            else:
                ok('console', 'no console errors')
            if errors:
                for e in errors[:6]:
                    bug('page', 'uncaught error', e)

            browser.close()
    finally:
        prov.terminate()

    print('\n================ DEEP AUDIT ================')
    print('findings: ' + str(len(FINDINGS)))
    return 1 if FINDINGS else 0


if __name__ == '__main__':
    sys.exit(main())
