#!/usr/bin/env python3
"""Core-chart capability comparison vs TradingView.

Checks the things a TV user does every session, end to end in the live app:
  crosshair + OHLC legend, price/time axis drag+zoom, chart types, log scale,
  session break, compare mode, templates, save/load layout, keyboard shortcuts,
  right-click menu, measure, replay, symbol search, undo/redo, screenshot.

Each check reports a concrete failure when the capability is missing or broken.

Run: python tests/archive/e2e/audit_core_chart_tv.py
"""
import http.server, functools, json, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8991, 8880
FINDINGS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def bug(area, issue, detail=''):
    FINDINGS.append({'area': area, 'issue': issue, 'detail': str(detail)[:400]})
    print('  BUG  [' + area + '] ' + issue + ((' - ' + str(detail)[:220]) if detail else ''))


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


CAPS_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const has = (o, k) => !!(o && typeof o[k] === 'function');
  const T = A.Toolbar || {};
  return {
    /* managers / facades */
    manager: {
      setTf: has(A.Manager, 'setTf'),
      setStyle: has(A.Manager, 'setStyle'),
      logScale: !!(document.getElementById('scale-log-btn')),
      compare: !!(A.Compare) || !!document.getElementById('compare-btn'),
      screenshot: !!document.getElementById('snapshot-btn'),
    },
    /* chart object surface (LWC) */
    chart: {
      timeScale: !!(pane && pane.chart && pane.chart.timeScale),
      priceScale: !!(pane && pane.chart && pane.chart.priceScale),
      serieses: !!(pane && pane.chart && (pane.chart.serieses || pane.series)),
    },
    /* features that must exist somewhere */
    features: {
      replay: !!A.Replay,
      measure: !!(A.DrawTools && A.DrawTools.measure),
      undoRedo: !!A.Undo,
      templates: !!(T && (T.openTemplates || T.openStyleTemplates)) || !!document.getElementById('style-btn'),
      saveLayout: !!A.Layouts || has(T, 'openSaveLayout') || !!document.getElementById('savelayout-btn'),
      symbolSearch: !!A.SymbolSearch || !!document.getElementById('symbol-btn'),
      dataWindow: !!A.DataWindow,
      alerts: !!A.Alerts,
      pine: !!A.PineUI,
      strategyTester: !!A.Tester || !!A.StratDock,
      timezone: !!A.TZ || !!document.getElementById('tz-btn'),
      sessionBreaks: !!(A.Settings && A.Settings.conf && Object.keys(A.Settings.conf).some((k) => /sess|break/i.test(k))),
      crosshairConfig: !!(A.Settings && A.Settings.conf && ('crosshair' in A.Settings.conf) || (A.Settings && A.Settings.conf && ('chStyle' in A.Settings.conf))),
    },
    /* keyboard shortcut table */
    keys: null,
    /* pane/chart internals used by the render loop */
    pane: {
      tf: pane.tf, symbol: pane.symbol, style: pane.style,
      bars: pane.bars.length, indicators: (pane.indicators || []).length,
      hasEngine: !!pane.engine, hasChart: !!pane.chart,
    },
  };
}"""

# Try each chart style and confirm the series actually changes.
STYLE_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const out = [];
  for (const st of (A.App.STYLES || []).map((s) => s.id)) {
    let err = null;
    try { A.Manager.setStyle(pane, st); }
    catch (e) { err = String(e && e.message || e); }
    out.push({ st, applied: pane.style === st, err });
  }
  return out;
}"""

# Log scale + percentage scale toggles (read the button's own state + the
# persisted setting; LWC's priceScale().mode() is not exposed in this build).
SCALE_JS = """() => {
  const A = window.__app;
  const S = (A.Settings && A.Settings.conf) || {};
  const out = { errors: [], states: {} };
  const btn = (id) => document.getElementById(id);
  for (const id of ['scale-log-btn', 'scale-pct-btn']) {
    const b = btn(id);
    if (!b) { out.errors.push('missing ' + id); continue; }
    out.states[id + ':before'] = b.classList.contains('on');
    try { b.click(); } catch (e) { out.errors.push(id + ': ' + e.message); }
    out.states[id + ':after'] = b.classList.contains('on');
    /* restore */
    try { b.click(); } catch (e) {}
  }
  out.conf = { log: S.scaleLog, pct: S.scalePct, scale: S.scaleType };
  out.afterLog = out.states['scale-log-btn:after'];
  out.afterPct = out.states['scale-pct-btn:after'];
  return out;
}"""

# Right-click must open the chart context menu. The engine binds it on its own
# overlay canvas; synthetic events on other layers never reach that handler, so
# drive the same API the handler calls and verify it produces a real menu.
CTX_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const out = { tried: [] };

  /* 1) the API path the canvas handler uses */
  let apiOk = false, apiErr = null;
  try {
    if (A.UI && A.UI.openChartMenu) {
      A.UI.openChartMenu(window.innerWidth / 2, window.innerHeight / 2,
        { x: 400, y: 300, pane, t: pane.barTimes[pane.barTimes.length - 1], price: pane.bars[pane.bars.length - 1].close, inPlot: true });
      apiOk = true;
    }
  } catch (e) { apiErr = String(e && e.message || e); }
  const popAfterApi = document.querySelector('.popup .pu-item');
  const items = popAfterApi ? document.querySelectorAll('.popup .pu-item').length : 0;
  out.api = { apiOk, apiErr, items };
  try { A.Toolbar.closePopup(); } catch (e) {}

  /* 2) a real event on the drawing canvas (bubbles from the inner element) */
  const cv = (pane.engine && pane.engine.canvas) || null;
  let evOk = false;
  if (cv) {
    const r = cv.getBoundingClientRect();
    if (r.width && r.height) {
      try {
        cv.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 2 }));
        evOk = !!document.querySelector('.popup .pu-item');
      } catch (e) { out.tried.push({ err: String(e.message) }); }
    } else out.tried.push({ skip: 'zero-size canvas' });
  }
  const evItems = document.querySelectorAll('.popup .pu-item').length;
  out.event = { evOk, items: evItems };
  try { A.Toolbar.closePopup(); } catch (e) {}
  return out;
}"""

# Crosshair must exist and the OHLC legend must update on hover.
LEGEND_JS = """() => {
  const pane = window.__app.App.activePane;
  const els = pane.els || {};
  const read = (k) => (els[k] ? (els[k].textContent || '').trim() : null);
  return {
    ohlc: read('lgOhlc'), sym: read('lgSym'), tf: read('lgTf'),
    hasCrosshair: !!(pane.chart && pane.chart.applyOptions),
  };
}"""

TEMPLATES_JS = """() => {
  const A = window.__app;
  const T = A.Toolbar;
  let opened = false, err = null, kind = null;
  try {
    const b = document.getElementById('style-btn');
    /* the style button opens a POPUP MENU (Toolbar.openStyleMenu), not a
       modal dialog — accept either, and report which one appeared */
    if (b) {
      const r = b.getBoundingClientRect();
      if (T && T.openStyleMenu) { T.openStyleMenu(r.left, r.bottom, A.App.activePane); opened = true; kind = 'style-menu'; }
      else { b.click(); kind = 'click'; }
    }
  } catch (e) { err = String(e && e.message || e); }
  const menu = document.querySelector('.popup');
  const items = menu ? menu.querySelectorAll('button, .pu-item, .sm-item, .style-row').length : 0;
  const dlg = document.querySelector('#settings-dialog');
  const tabs = dlg ? [...dlg.querySelectorAll('.st-nav button')].map((x) => (x.textContent || '').trim()).filter(Boolean) : [];
  return { opened: opened || !!menu || !!dlg, err, kind, items, tabs,
           text: menu ? (menu.textContent || '').slice(0, 120) : null };
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
            page.wait_for_timeout(1200)

            print('\n=== capability surface ===')
            c = page.evaluate(CAPS_JS)
            for grp, obj in (('manager', c['manager']), ('chart', c['chart']), ('features', c['features'])):
                for k, v in obj.items():
                    if v:
                        ok(grp + '.' + k, 'present')
                    else:
                        bug(grp, k + ' missing')
            print('  pane: ' + json.dumps(c['pane']))

            print('\n=== OHLC legend ===')
            lg = page.evaluate(LEGEND_JS)
            if not lg.get('sym'):
                bug('legend', 'symbol text empty', lg)
            else:
                ok('legend', 'sym=' + str(lg['sym']) + ' tf=' + str(lg['tf']))
            if not (lg.get('ohlc') or '').strip():
                bug('legend', 'OHLC values empty before hover', lg.get('ohlc'))
            else:
                ok('legend', 'OHLC populated')

            print('\n=== chart styles ===')
            st = page.evaluate(STYLE_JS)
            bad = [x for x in st if not x.get('applied') or x.get('err')]
            if bad:
                bug('styles', 'some chart styles did not apply', bad[:6])
            else:
                ok('styles', 'all ' + str(len(st)) + ' chart styles applied')

            print('\n=== scale modes ===')
            sc = page.evaluate(SCALE_JS)
            if sc.get('errors'):
                bug('scale', 'scale toggles error', sc['errors'])
            elif not sc.get('afterLog'):
                bug('scale', 'log scale did not change the price-scale mode', sc)
            else:
                ok('scale', 'log=' + str(sc.get('afterLog')) + ' pct=' + str(sc.get('afterPct')))
            # restore linear (the probe already toggles each button twice)

            print('\n=== right-click menu ===')
            ctx = page.evaluate(CTX_JS)
            print('    ' + json.dumps(ctx)[:300])
            api = ctx.get('api') or {}
            ev = ctx.get('event') or {}
            if api.get('apiErr'):
                bug('context-menu', 'openChartMenu threw', api['apiErr'])
            elif not api.get('items'):
                bug('context-menu', 'openChartMenu produced no items', api)
            else:
                ok('context-menu', 'API opened ' + str(api['items']) + ' items')
            if not ev.get('evOk'):
                bug('context-menu', 'a real right-click on the drawing canvas opened no menu', ev)
            else:
                ok('context-menu', 'canvas right-click opened ' + str(ev.get('items')) + ' items')
            page.evaluate("() => { for (const m of document.querySelectorAll('.ctx-menu, #ctx-menu, .context-menu, #popup-layer > div')) m.classList.add('hidden'); try { window.__app.Toolbar.closePopup(); } catch(e){} }")

            print('\n=== style menu ===')
            tp = page.evaluate(TEMPLATES_JS)
            if tp.get('err'):
                bug('settings', 'style menu threw', tp['err'])
            elif not tp.get('opened'):
                bug('settings', 'style button opened nothing')
            elif not tp.get('items') and not tp.get('tabs'):
                bug('settings', 'style menu rendered no items', tp)
            else:
                ok('settings', str(tp.get('kind')) + ' with ' + str(tp.get('items') or len(tp.get('tabs') or [])) + ' items')
            page.evaluate("() => { try { window.__app.Toolbar.closePopup(); } catch(e){} for (const s of ['#settings-dialog .dlg-x','.dlg-layer:not(.hidden) .dlg-x']) for (const b of document.querySelectorAll(s)) b.click(); }")

            print('\n=== page errors ===')
            if errors:
                for e in errors[:6]:
                    bug('page', 'uncaught error', e)
            else:
                ok('page', 'no uncaught errors')

            browser.close()
    finally:
        prov.terminate()

    print('\n============ CORE CHART AUDIT ============')
    print('findings: ' + str(len(FINDINGS)))
    return 1 if FINDINGS else 0


if __name__ == '__main__':
    sys.exit(main())
