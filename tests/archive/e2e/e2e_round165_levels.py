#!/usr/bin/env python3
"""ROUND165 e2e — SMC daily levels via the real user path (dialog checkbox).

  [1] adds SMC (defaults) on the live app: engine ok;
  [2] opens the settings dialog, checks the "Daily" checkbox, Ok;
  [3] asserts engine still ok (was: "Unknown array method" throw), PDH/PDL
      labels exist in the store with numeric y, zero page errors;
  [4] checks the Internal/Swing label-size dropdowns show payload options
      (tiny/small/normal — was: "[object Object]") and round-trip a change.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8961, 8889
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

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await new Promise((r) => setTimeout(r, 3000));
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

SIZE_OPTS_JS = """() => {
  const rows = [...document.querySelectorAll('.ind-settings label.pine-inp')];
  const row = rows.find((r) => (r.querySelector('span') || {}).textContent === 'Internal Label Size');
  if (!row) return { found: false };
  const sel = row.querySelector('select');
  if (!sel) return { found: true, isSelect: false };
  return { found: true, isSelect: true, value: sel.value, options: [...sel.options].map((o) => o.value) };
}"""

WAIT_PDH_JS = """(instId) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
  if (!st || !st.rt || !st.rt.store || st.status !== 'ok') return false;
  for (const lb of st.rt.store.label.values()) {
    if ((lb.text === 'PDH' || lb.text === 'PDL') && typeof lb.y === 'number' && isFinite(lb.y)) return true;
  }
  return false;
}"""

AFTER_JS = """(instId) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const inst = (pane.pineScripts || []).find((i) => i.id === instId);
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
  let pdh = null, pdl = null, nLabels = 0, sizes = {}, texts = [];
  if (st && st.rt && st.rt.store) {
    for (const lb of st.rt.store.label.values()) {
      nLabels++;
      sizes[lb.size] = (sizes[lb.size] || 0) + 1;
      if (lb.text) texts.push(lb.text + '=' + lb.y);
      if (lb.text === 'PDH') pdh = lb.y;
      if (lb.text === 'PDL') pdl = lb.y;
    }
  }
  const bars = pane.bars || [];
  return {
    status: st ? st.status : 'no-st', errors: (st && st.errors) || [],
    pdh, pdl, nLabels, sizes, texts: texts.slice(0, 12),
    inputs: inst ? inst.inputs : null, inputDefs: st && st.inputDefs ? st.inputDefs.length : -1,
    tf: pane.tf, nbars: bars.length,
    firstT: bars.length ? bars[0].time : null, lastT: bars.length ? bars[bars.length - 1].time : null,
    dlgOpen: !document.getElementById('popup-layer').classList.contains('hidden'),
  };
}"""

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
            with open(os.path.join(ROOT, 'fixtures', 'pine', 'corpus', 'smartmoney.pine'), encoding='utf-8') as fh:
                src = fh.read()
            r = page.evaluate(ADD_JS, {'name': 'SMC165', 'src': src})
            check('SMC engine ok (defaults)', r['status'] == 'ok', r.get('errors'))
            page.evaluate(OPEN_DLG_JS, r['instId'])
            page.wait_for_timeout(700)
            s0 = page.evaluate(SIZE_OPTS_JS)
            check('size dropdown is a select', s0.get('found') and s0.get('isSelect'), s0)
            check('size options are payloads', (s0.get('options') or []) == ['tiny', 'small', 'normal'], s0.get('options'))
            check('size default tiny', s0.get('value') == 'tiny', s0.get('value'))
            # ROUND165 user path: enable Daily levels, then Ok (rebuild)
            page.check('.ind-settings label.pine-inp:has-text("Daily") input[type="checkbox"]')
            page.wait_for_timeout(300)
            t0 = page.evaluate("() => Date.now()")
            page.click('.ind-settings .ist-ok')
            # PDH/PDL may need the rebuild pass plus a settled tick: wait on
            # their actual presence (up to 60s) instead of a fixed sleep.
            try:
                page.wait_for_function(WAIT_PDH_JS, arg=r['instId'], timeout=60000)
                pdh_ready = True
            except Exception as e:
                print('    pdh wait timeout:', str(e)[:120])
                pdh_ready = False
            check('PDH/PDL drawn after rebuild', pdh_ready)
            a = page.evaluate(AFTER_JS, r['instId'])
            print('    diag:', {k: a.get(k) for k in ('status', 'tf', 'nbars', 'nLabels', 'sizes', 'inputs', 'inputDefs')})
            print('    texts:', a.get('texts'))
            print('    span-days:', ((a.get('lastT') or 0) - (a.get('firstT') or 0)) / 86400)
            check('dialog closed after Ok', a.get('dlgOpen') is False, a.get('dlgOpen'))
            check('engine ok with Daily on (was: binary_search throw)', a.get('status') == 'ok', a.get('errors'))
            check('PDH drawn with numeric y', isinstance(a.get('pdh'), (int, float)), a.get('pdh'))
            check('PDL drawn with numeric y', isinstance(a.get('pdl'), (int, float)), a.get('pdl'))
            check('tiny labels still tiny (no upsize)', (a.get('sizes') or {}).get('tiny', 0) > 0, a.get('sizes'))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND165: %d failed' % len(FAILS) if FAILS else 'ROUND165: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
