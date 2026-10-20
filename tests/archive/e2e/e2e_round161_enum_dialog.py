#!/usr/bin/env python3
"""ROUND161 e2e — input.enum dialog on the live app (real user path).

Script under test:
  enum Mode / Fast / Slow
  mode = input.enum(Mode.Fast, "Mode")
  plot(mode == Mode.Fast ? close : open, title="v")

Checks (live dialog, not engine-direct):
  [1] engine ok + enum inputDef present (options Fast,Slow + value map)
  [2] settings dialog opens with zero page errors
  [3] the "Mode" row is a <select> with Fast/Slow options, current = Fast
  [4] switching to Slow + Ok rebuilds: inst.inputs holds 1, engine plot
      tail flips from close-branch to open-branch
  [5] reopening the dialog shows Slow selected (persisted)
  [6] zero page errors throughout
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8959, 8887
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

SRC = ('//@version=6\nindicator("Enum161", overlay=true)\n'
       'enum Mode\n    Fast\n    Slow\n'
       'mode = input.enum(Mode.Fast, "Mode")\n'
       'plot(mode == Mode.Fast ? close : open, title="v")\n')

ADD_JS = """async ({name, src}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  await new Promise((r) => setTimeout(r, 3000));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const defs = (st && st.inputDefs) || [];
  const def = defs.find((d) => d.kind === 'enum');
  // ROUND161: compare on the last CLOSED bar (len-2) — the forming bar keeps
  // ticking after the engine run, so its close/open drifts from plot values.
  let idx = -1, tailPlot = null, tailClose = null, tailOpen = null;
  if (st && st.rt && st.rt.out) {
    const key = st.rt.out.plotsOrder && st.rt.out.plotsOrder[0];
    const vals = key != null ? st.rt.out.plots.get(key).values : [];
    const bars = A.App.panes[0].bars;
    for (let i = bars.length - 2; i >= Math.max(0, bars.length - 12); i--) {
      if (bars[i].open !== bars[i].close) { idx = i; break; }
    }
    if (idx >= 0) { tailPlot = vals[idx]; tailClose = bars[idx].close; tailOpen = bars[idx].open; }
  }
  return {
    instId: inst.id,
    status: st ? st.status : 'no-st',
    errors: (st && st.errors) || [],
    enumFound: !!def,
    enumOptions: def ? def.options : null,
    enumMap: def ? def.enumMap : null,
    enumDefId: def ? def.id : null,
    idx, tailPlot, tailClose, tailOpen,
  };
}"""

OPEN_DLG_JS = """(instId) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const inst = (pane.pineScripts || []).find((i) => i.id === instId);
  if (!inst) return { opened: false };
  A.PineUI.openSettingsDialog(pane, inst);
  return { opened: true };
}"""

ENUM_STATE_JS = """() => {
  const rows = [...document.querySelectorAll('.ind-settings label.pine-inp')];
  const row = rows.find((r) => (r.querySelector('span') || {}).textContent === 'Mode');
  if (!row) return { found: false, rows: rows.map((r) => ((r.querySelector('span') || {}).textContent || '?')) };
  const sel = row.querySelector('select');
  if (!sel) return { found: true, isSelect: false };
  return { found: true, isSelect: true, value: sel.value, options: [...sel.options].map((o) => o.value) };
}"""

AFTER_JS = """(instId) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const inst = (pane.pineScripts || []).find((i) => i.id === instId);
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
  // ROUND161: same closed-bar rule as ADD_JS (see above).
  let idx = -1, tailPlot = null, tailClose = null, tailOpen = null;
  if (st && st.rt && st.rt.out) {
    const key = st.rt.out.plotsOrder && st.rt.out.plotsOrder[0];
    const vals = key != null ? st.rt.out.plots.get(key).values : [];
    const bars = pane.bars;
    for (let i = bars.length - 2; i >= Math.max(0, bars.length - 12); i--) {
      if (bars[i].open !== bars[i].close) { idx = i; break; }
    }
    if (idx >= 0) { tailPlot = vals[idx]; tailClose = bars[idx].close; tailOpen = bars[idx].open; }
  }
  return {
    status: st ? st.status : 'no-st',
    inputs: inst ? inst.inputs : null,
    idx, tailPlot, tailClose, tailOpen,
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
            r = page.evaluate(ADD_JS, {'name': 'Enum161', 'src': SRC})
            print('    engine:', r.get('status'), r.get('enumOptions'), str(r.get('errors'))[:120])
            check('engine ok', r['status'] == 'ok', r.get('errors'))
            check('enum inputDef found', r['enumFound'] is True, r.get('enumOptions'))
            check('enum options Fast,Slow', (r.get('enumOptions') or []) == ['Fast', 'Slow'], r.get('enumOptions'))
            check('enum value map 0/1', (r.get('enumMap') or {}).get('Fast') == 0 and (r.get('enumMap') or {}).get('Slow') == 1, r.get('enumMap'))
            check('default branch = close', r['tailPlot'] == r['tailClose'], (r['tailPlot'], r['tailClose']))
            o = page.evaluate(OPEN_DLG_JS, r['instId'])
            page.wait_for_timeout(700)
            check('dialog opens', o.get('opened') is True, o)
            check('dialog visible, no page error yet', len(errors) == 0, errors[:2])
            s0 = page.evaluate(ENUM_STATE_JS)
            check('Mode row is a select', s0.get('found') is True and s0.get('isSelect') is True, s0)
            check('select offers Fast/Slow', sorted(s0.get('options') or []) == ['Fast', 'Slow'], s0.get('options'))
            check('select starts on Fast', s0.get('value') == 'Fast', s0.get('value'))
            # ROUND161: real user path — change the dropdown, then Ok (rebuild)
            page.select_option('.ind-settings label.pine-inp:has-text("Mode") select', 'Slow')
            page.wait_for_timeout(300)
            page.click('.ind-settings .ist-ok')
            page.wait_for_timeout(3200)
            a = page.evaluate(AFTER_JS, r['instId'])
            check('dialog closed after Ok', a.get('dlgOpen') is False, a.get('dlgOpen'))
            check('engine still ok after enum switch', a.get('status') == 'ok', a.get('status'))
            iv = a.get('inputs') or {}
            check('inputs persist Slow (=1)', r['enumDefId'] in iv and iv[r['enumDefId']] == 1, iv)
            check('branch flipped to open', a['tailPlot'] == a['tailOpen'] and a['tailPlot'] != a['tailClose'], (a['tailPlot'], a['tailOpen'], a['tailClose']))
            # reopen: the dropdown must remember Slow
            page.evaluate(OPEN_DLG_JS, r['instId'])
            page.wait_for_timeout(700)
            s1 = page.evaluate(ENUM_STATE_JS)
            check('reopened dialog shows Slow', s1.get('value') == 'Slow', s1.get('value'))
            page.keyboard.press('Escape')
            page.wait_for_timeout(400)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND161: %d failed' % len(FAILS) if FAILS else 'ROUND161: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
