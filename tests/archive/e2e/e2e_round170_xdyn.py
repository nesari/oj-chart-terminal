#!/usr/bin/env python3
"""ROUND170 e2e — dynamic input.symbol on the live app (phase 1c).

  GBPUSD chart + s = input.symbol("EURUSD") + security(s, "", close):
  works immediately (static default prefetched); then the dialog changes
  Sym to USDJPY (never prefetched) -> first pass throws no-history ->
  fetch-and-retry -> ok with USDJPY values from the feed. Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8971, 8899
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if (not cond and extra != '') else ''))
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

SRC = ('//@version=5\nindicator("xdyn170", overlay=false)\n'
       's = input.symbol("EURUSD", "Sym")\n'
       'c = request.security(s, "", close)\n'
       'plot(c, title="xdyn")\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await A.PineUI.rebuild(pane, inst);
  await new Promise((r) => setTimeout(r, 4000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  return { instId: inst.id, status: st ? st.status : 'no-st', errors: (st && st.errors) || [] };
}"""

OPEN_DLG_JS = """(instId) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const inst = (pane.pineScripts || []).find((i) => i.id === instId);
  if (!inst) return { opened: false };
  A.PineUI.openSettingsDialog(pane, inst);
  return { opened: true };
}"""

WAIT_OK_JS = """(instId) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
  return !!st && st.status === 'ok';
}"""

VAL_JS = """(instId) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
  let val = null;
  if (st && st.rt && st.rt.out) {
    const bars = pane.bars;
    let idx = -1;
    for (let i = bars.length - 2; i >= Math.max(0, bars.length - 12); i--) {
      if (bars[i].open !== bars[i].close) { idx = i; break; }
    }
    if (idx >= 0) {
      for (const key of st.rt.out.plotsOrder) {
        const p = st.rt.out.plots.get(key);
        if (p.title === 'xdyn') val = p.values[idx];
      }
    }
  }
  return { status: st ? st.status : 'no-st', errors: (st && st.errors) || [], val };
}"""

FEED_JS = """async ({sym, tf}) => {
  const A = window.__app;
  const resp = await A.App.feed.bars(sym, tf, 5);
  const bars = (resp && resp.bars) || [];
  const b = bars.length >= 2 ? bars[bars.length - 2] : null;
  return b ? b.close : null;
}"""

def wait_ok(page, instId, timeout=90):
    try:
        page.wait_for_function(WAIT_OK_JS, arg=instId, timeout=timeout * 1000)
        return True
    except Exception:
        return False

def val_matches(page, instId, sym, tf):
    a = page.evaluate(VAL_JS, instId)
    for _ in range(3):
        f = page.evaluate(FEED_JS, {'sym': sym, 'tf': tf})
        if isinstance(a.get('val'), (int, float)) and isinstance(f, (int, float)) and abs(a['val'] - f) < 1e-9:
            return True, (a.get('val'), f)
        page.wait_for_timeout(800)
        a = page.evaluate(VAL_JS, instId)
    return False, (a.get('val'), f)

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up'); prov.terminate(); return 1
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
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100", timeout=25000)
            page.evaluate("""() => {
              const A = window.__app;
              const pane = A.App.panes[0];
              return A.Manager.setSymbol ? A.Manager.setSymbol(pane, 'GBPUSD') : null;
            }""")
            page.wait_for_timeout(2500)
            tf = page.evaluate("() => window.__app.App.panes[0].tf")
            r = page.evaluate(ADD_JS, {'name': 'XDYN170', 'src': SRC})
            check('static default works', r['status'] == 'ok', r.get('errors'))
            okv, info = val_matches(page, r['instId'], 'EURUSD', tf)
            check('value == EURUSD feed', okv, info)
            # dynamic change to a never-prefetched symbol
            o = page.evaluate(OPEN_DLG_JS, r['instId'])
            print('    dialog:', o)
            page.wait_for_timeout(700)
            try:
                page.fill('.ind-settings label.pine-inp:has-text("Sym") input', 'USDJPY', timeout=8000)
            except Exception:
                dump = page.evaluate("""() => {
                  const rows = [...document.querySelectorAll('.ind-settings label.pine-inp')];
                  return rows.slice(0, 8).map((r) => (r.querySelector('span') || {}).textContent + '::' + (r.querySelector('select,input') || {}).tagName);
                }""")
                print('    dlg rows:', dump)
                raise
            page.wait_for_timeout(300)
            page.click('.ind-settings .ist-ok')
            check('engine ok after retry', wait_ok(page, r['instId'], timeout=90))
            okv2, info2 = val_matches(page, r['instId'], 'USDJPY', tf)
            check('value == USDJPY feed', okv2, info2)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND170: %d failed' % len(FAILS) if FAILS else 'ROUND170: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
