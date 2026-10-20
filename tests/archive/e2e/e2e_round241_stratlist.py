#!/usr/bin/env python3
"""ROUND241 e2e — STRATEGIES section + STRATEGY tags in the Indicators dialog, live.

  A strategy() script appears under its own STRATEGIES section with a
  STRATEGY tag; a plain indicator() script stays under MY SCRIPTS with no
  tag; search filters both sections. Zero page errors.
"""
import http.server, functools, json, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8921, 8861
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

SRC_STRAT = ('//@version=6\nstrategy("TST241 Strat", overlay=true)\n'
             'strategy.entry("L", strategy.long)\nplot(close)\n')
SRC_IND = ('//@version=6\nindicator("TST241 Ind", overlay=true)\nplot(close)\n')

READ_JS = """async () => {
  const A = window.__app;
  const S = A.PineScriptsStore;
  const rS = S.create('TST241 Strat', %s);
  const rI = S.create('TST241 Ind', %s);
  A.IndicatorsUI.openDialog();
  await new Promise((r) => setTimeout(r, 300));
  const out = { secs: [], rows: [], search: null, sid: rS.id, iid: rI.id };
  const kids = [...document.querySelectorAll('.ind-dialog .ind-list')[0].children];
  let sec = '';
  for (const k of kids) {
    if (k.classList.contains('st-sec')) { sec = k.textContent; out.secs.push(sec); continue; }
    const nm = k.querySelector('.ind-item-name');
    if (nm) out.rows.push({ sec, name: nm.textContent, tag: !!nm.querySelector('.pine-strat-tag') });
  }
  const inp = document.querySelector('#ind-search-input');
  inp.value = 'tst241 strat';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  const kids2 = [...document.querySelectorAll('.ind-dialog .ind-list')[0].children];
  let sec2 = '', rows2 = [];
  const secs2 = [];
  for (const k of kids2) {
    if (k.classList.contains('st-sec')) { sec2 = k.textContent; secs2.push(sec2); continue; }
    const nm = k.querySelector('.ind-item-name');
    if (nm) rows2.push({ sec: sec2, name: nm.textContent, tag: !!nm.querySelector('.pine-strat-tag') });
  }
  out.search = { secs: secs2, rows: rows2 };
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  out.closed = document.getElementById('popup-layer').classList.contains('hidden');
  S.remove(rS.id); S.remove(rI.id);
  return out;
}""" % (json.dumps(SRC_STRAT), json.dumps(SRC_IND))

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
            a = page.evaluate(READ_JS)
            print('    secs:', a.get('secs'), 'rows:', a.get('rows'))
            check('STRATEGIES + MY SCRIPTS sections', 'STRATEGIES' in a.get('secs', []) and 'MY SCRIPTS' in a.get('secs', []), a.get('secs'))
            srow = [r for r in a.get('rows', []) if 'TST241 Strat' in r['name']]
            irow = [r for r in a.get('rows', []) if r['name'] == 'TST241 Ind']
            check('strategy row under STRATEGIES with tag', len(srow) == 1 and srow[0]['sec'] == 'STRATEGIES' and srow[0]['tag'], a.get('rows'))
            check('indicator row under MY SCRIPTS without tag', len(irow) == 1 and irow[0]['sec'] == 'MY SCRIPTS' and not irow[0]['tag'], a.get('rows'))
            s2 = (a.get('search') or {})
            check('search keeps STRATEGIES, drops MY SCRIPTS',
                  'STRATEGIES' in s2.get('secs', []) and 'MY SCRIPTS' not in s2.get('secs', []) and
                  any('TST241 Strat' in r['name'] and r['tag'] for r in s2.get('rows', [])), s2)
            check('dialog closes on Escape', a.get('closed') is True, a.get('closed'))
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND241: %d failed' % len(FAILS) if FAILS else 'ROUND241: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
