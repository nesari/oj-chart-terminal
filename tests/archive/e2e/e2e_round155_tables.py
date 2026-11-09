#!/usr/bin/env python3
"""ROUND155 e2e — table dashboards render as DOM on the live app.

Boots demo feed + renderer, then for each dashboard script
(LuxAlgo Sessions, Wyckoff):
  [1] adds the script from the repo corpus (input dashboard flag ON),
  [2] asserts .pine-table divs exist in the DOM with real cell text
      (e.g. "Sessions [LuxAlgo]"), zero page errors;
  [3] eye-off hides the tables, eye-on restores them.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time, json

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8955, 8883
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

ADD_JS = """async ({name, src, flagTitle}) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const rec = A.PineScriptsStore.create(name, src);
  const inst = A.PineUI.add(pane, rec.id);
  // enable the dashboard flag like the Inputs dialog would
  await new Promise((r) => setTimeout(r, 2500));
  const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  const defs = (st && st.inputDefs) || [];
  const def = defs.find((d) => d.title === flagTitle);
  if (def) {
    inst.inputs = inst.inputs || {};
    inst.inputs[def.id] = true;
    // ROUND155: like the dialog Ok path — inputs only take effect on rebuild
    // (runFull reuses the runtime whose inputValues were fixed at creation)
    await A.PineUI.rebuild(pane, inst);
  }
  await new Promise((r) => setTimeout(r, 3500));
  const st2 = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id);
  let engineCells = -1, engineStatus = 'no-rt', engineErr = '';
  if (st2 && st2.rt && st2.rt.store && st2.rt.store.table) {
    engineCells = 0;
    for (const t of st2.rt.store.table.values()) {
      for (const c of t.cells.values()) if (c.text) engineCells++;
    }
    engineStatus = st2.status;
    engineErr = JSON.stringify((st2.errors || []).slice(0, 1));
  }
  return { instId: inst.id, flagFound: !!def, engineCells, engineStatus, engineErr };
}"""

TABLES_JS = """(instId) => {
  const sel = '.pine-table[data-inst="' + instId + '"]';
  const tables = [...document.querySelectorAll(sel)].filter((t) => !t.classList.contains('hidden'));
  const texts = tables.map((t) => t.textContent).join(' | ');
  const cellEls = [...document.querySelectorAll(sel + ':not(.hidden) .pine-tcell')];
  const filled = cellEls.filter((d) => d.textContent.trim() !== '').length;
  return { n: tables.length, cells: cellEls.length, filled, texts: texts.slice(0, 2000) };
}"""

EYE_JS = """(instId) => {
  const A = window.__app;
  const pane = A.App.panes[0];
  A.PineUI.toggleVisible(pane, instId);
}"""

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up'); prov.terminate(); return 1
    corpus = os.path.join(ROOT, 'fixtures', 'pine', 'corpus')
    cases = [
        ('Sessions155', 'sessions.pine', 'Dashboard', 'Sessions [LuxAlgo]'),
        ('Wyckoff155', 'wyckoff.pine', 'Show Status Table', 'Structure'),
    ]
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
            for name, f, flag, needle in cases:
                with open(os.path.join(corpus, f), encoding='utf-8') as fh:
                    src = fh.read()
                r = page.evaluate(ADD_JS, {'name': name, 'src': src, 'flagTitle': flag})
                print('    engine:', r.get('engineCells'), r.get('engineStatus'), str(r.get('engineErr'))[:160])
                check(name + ' flag input found', r['flagFound'] is True, r)
                t = page.evaluate(TABLES_JS, r['instId'])
                check(name + ' tables in DOM', t['n'] >= 1, t)
                check(name + ' cells rendered', t['cells'] > 5, t['cells'])
                check(name + ' cells filled', t['filled'] > 5, t)
                check(name + ' real text ("%s")' % needle, needle in t['texts'], t['texts'][:120])
                page.evaluate(EYE_JS, r['instId'])
                page.wait_for_timeout(1200)
                t2 = page.evaluate(TABLES_JS, r['instId'])
                check(name + ' eye-off hides tables', t2['n'] == 0, t2)
                page.evaluate(EYE_JS, r['instId'])
                page.wait_for_timeout(1500)
                t3 = page.evaluate(TABLES_JS, r['instId'])
                check(name + ' eye-on restores tables', t3['n'] >= 1, t3)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND155: %d failed' % len(FAILS) if FAILS else 'ROUND155: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
