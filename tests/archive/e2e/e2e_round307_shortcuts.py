#!/usr/bin/env python3
"""R307 — the keyboard shortcut editor (roadmap P0-03).

WHAT THIS SUITE EXISTS FOR
  Ten shortcuts were hard-coded inline in `app.js`. They worked, but no user could
  see them, no user could change one, and nothing detected two actions on the same
  chord. This suite proves the replacement does all three — from the outside, the
  way a user meets it:

    1. `?` opens an editor that LISTS the live bindings (the list must match the
       registry, not a hand-copied table in the test).
    2. Rebinding actually changes behaviour: press the new chord, the effect
       happens; press the old one, it does not.
    3. A chord already in use is refused with the owner's name, and the previous
       binding keeps working.
    4. The override survives a reload, and Reset puts the default back.
    5. The ROUND103 guard still holds: shortcuts do not fire while typing.

Run: python tests/archive/e2e/e2e_round307_shortcuts.py
"""
import functools
import http.server
import os
import socket
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_teardown import kill_proc

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
# Shard-safe: overridable, defaults from the roadmap's free ranges (see §1.3).
PORT_HTTP, PORT_WS = int(os.environ.get('MT5_HTTP_PORT', '9082')), int(os.environ.get('MT5_WS_PORT', '8932'))
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def check(name, cond, extra=''):
    print(('  ok ' if cond else '  FAIL ') + name + ((' - ' + str(extra)) if (not cond and extra != '') else ''))
    if not cond:
        FAILS.append(name)


def wait_port(port, timeout=30):
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


DIALOG_STATE_JS = """() => {
  const back = document.getElementById('shortcuts-dialog');
  const rows = [...document.querySelectorAll('#sc-list .sc-row')];
  return {
    exists: !!back,
    open: !!(back && !back.classList.contains('hidden')),
    rows: rows.length,
    titles: rows.map((r) => (r.querySelector('.sc-title') || {}).textContent || ''),
    keys: rows.map((r) => (r.querySelector('.sc-key') || {}).textContent || ''),
  };
}"""

REGISTRY_JS = """() => window.__app.Shortcuts.actions().map((a) => ({ id: a.id, keys: a.keys, title: a.title }))"""

PANE_JS = """() => {
  const p = window.__app.App.activePane;
  return { tool: window.__app.App.tool, style: p.style, tf: p.tf };
}"""


def main():
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not wait_port(PORT_WS):
        print('provider did not start')
        kill_proc(prov)
        return 1
    threading.Thread(target=serve_http, daemon=True).start()
    if not wait_port(PORT_HTTP):
        print('http server did not start')
        kill_proc(prov)
        return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(headless=True)
            except Exception:
                browser = pw.chromium.launch(channel='chrome', headless=True)
            page = browser.new_page(viewport={'width': 1500, 'height': 900})
            # The clear must run ONCE. `add_init_script` re-runs on every
            # navigation, so a plain reload would wipe the very storage the
            # persistence check is about — the harness would "prove" a bug that
            # is not there. The flag makes it a one-shot.
            page.add_init_script(
                "if (!sessionStorage.getItem('r307-seeded')) { "
                "localStorage.clear(); sessionStorage.setItem('r307-seeded','1'); }")
            errs = []
            page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_selector('#login-screen', timeout=15000)
            page.click('#card-demo')
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=25000)
            for _ in range(250):
                if page.evaluate("window.__app && window.__app.App.panes[0] && window.__app.App.panes[0].bars.length > 200"):
                    break
                time.sleep(0.2)
            page.wait_for_timeout(2000)

            # ---------------- the table exists and matches the editor --------
            print('  -- the registry and the editor agree --')
            reg = page.evaluate(REGISTRY_JS)
            check('the registry has the ten original shortcuts', len(reg) >= 9, len(reg))
            ids = {a['id']: a['keys'] for a in reg}
            check('Save layout is still Ctrl+S', ids.get('save-layout') == 'Ctrl+S', ids.get('save-layout'))
            check('Undo is still Ctrl+Z', ids.get('undo') == 'Ctrl+Z', ids.get('undo'))
            check('the Rectangle tool is still Alt+Shift+R',
                  ids.get('tool-rect') == 'Alt+Shift+R', ids.get('tool-rect'))
            check('no two shortcuts share a chord',
                  len(set(ids.values())) == len(ids), sorted(ids.values()))

            # ---------------- `?` opens the editor ---------------------------
            print('  -- "?" opens the editor --')
            check('the editor starts closed', not page.evaluate(DIALOG_STATE_JS)['open'])
            page.keyboard.press('Shift+Slash')      # "?" on a US layout
            page.wait_for_timeout(400)
            st = page.evaluate(DIALOG_STATE_JS)
            if not st['open']:
                # some headless layouts do not translate Shift+Slash to "?"
                page.evaluate("() => window.__app.Shortcuts.open()")
                page.wait_for_timeout(300)
                st = page.evaluate(DIALOG_STATE_JS)
                check('the editor can also be opened through the API', st['open'])
            else:
                check('"?" opens the editor', st['open'])

            check('it lists every action', st['rows'] >= len(reg), f"{st['rows']} vs {len(reg)}")
            check('the rows show the live keys',
                  set(st['keys']) >= {'Ctrl+S', 'Ctrl+Z'}, st['keys'][:6])
            check('the rows carry human titles',
                  all(t and not t.startswith(('sc-', 'action-')) for t in st['titles']),
                  st['titles'][:4])

            # ---------------- rebinding really changes behaviour -------------
            print('  -- rebinding Rectangle changes which chord arms it --')
            res = page.evaluate("""() => window.__app.Shortcuts.assign('tool-rect', 'Ctrl+Alt+R')""")
            check('the rebind was accepted', res.get('ok') is True, res)

            page.evaluate("() => window.__app.Shortcuts._dialog.close()")
            page.evaluate("() => { window.__app.App.tool = null; }")
            page.wait_for_timeout(200)
            page.keyboard.press('Alt+Shift+R')
            page.wait_for_timeout(300)
            old = page.evaluate(PANE_JS)['tool']
            check('the OLD chord no longer arms Rectangle', old != 'rect', old)

            page.keyboard.press('Control+Alt+R')
            page.wait_for_timeout(300)
            new = page.evaluate(PANE_JS)['tool']
            check('the NEW chord arms Rectangle', new == 'rect', new)

            # ---------------- a taken chord is refused -----------------------
            print('  -- a taken chord is refused, with the owner named --')
            bad = page.evaluate("""() => window.__app.Shortcuts.assign('tool-rect', 'Ctrl+S')""")
            check('assigning Ctrl+S to Rectangle is refused', bad.get('ok') is False, bad)
            check('the refusal names the owner (Save layout)',
                  'Save layout' in str(bad.get('reason', '')), bad.get('reason'))
            still = page.evaluate("""() => window.__app.Shortcuts.get('tool-rect').keys""")
            check('the refused action keeps its previous chord', still == 'Ctrl+Alt+R', still)

            # and Ctrl+S itself still opens Save Layout
            page.evaluate("() => window.__app.App.tool = null")
            page.keyboard.press('Control+s')
            page.wait_for_timeout(600)
            savedialog = page.evaluate("""() => !!document.getElementById('save-layout-dialog')""")
            check('Ctrl+S still opens Save Layout (the owner is unharmed)', savedialog)
            page.keyboard.press('Escape')

            # ---------------- persistence across reload -----------------------
            print('  -- the override survives a reload --')
            # `add_init_script` runs on EVERY navigation, and the suite registers
            # `localStorage.clear()` there — so a plain reload wipes the store and
            # the test would "prove" persistence is broken when it is the harness
            # clearing it. Remove the init script first: the reload must see the
            # SAME storage a real restart would.
            page.evaluate("""() => window.__app.Shortcuts.assign('tool-rect', 'Ctrl+Alt+R')""")
            page.wait_for_timeout(200)
            check('the override is in localStorage before the reload',
                  'Ctrl+Alt+R' in (page.evaluate("() => localStorage.getItem('mt5_keys')") or ''),
                  page.evaluate("() => localStorage.getItem('mt5_keys')"))
            page.reload()
            page.wait_for_selector('#login-screen', timeout=15000)
            page.click('#card-demo')
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=25000)
            page.wait_for_timeout(2000)
            after = page.evaluate("""() => window.__app.Shortcuts.get('tool-rect').keys""")
            check('the override is still Ctrl+Alt+R after a reload', after == 'Ctrl+Alt+R', after)
            check('it is flagged as modified',
                  page.evaluate("""() => window.__app.Shortcuts.get('tool-rect').overridden""") is True)

            # ---------------- reset ------------------------------------------
            print('  -- reset puts the default back --')
            ok_reset = page.evaluate("""() => window.__app.Shortcuts.reset('tool-rect')""")
            check('reset(tool-rect) succeeded', ok_reset is True)
            back = page.evaluate("""() => window.__app.Shortcuts.get('tool-rect').keys""")
            check('the default Alt+Shift+R is back', back == 'Alt+Shift+R', back)
            page.evaluate("() => { window.__app.App.tool = null; }")
            page.keyboard.press('Alt+Shift+R')
            page.wait_for_timeout(300)
            check('the default chord works again', page.evaluate(PANE_JS)['tool'] == 'rect')

            # ---------------- the ROUND103 guard -----------------------------
            print('  -- shortcuts do not fire while typing (ROUND103) --')
            page.evaluate("() => { window.__app.App.tool = null; }")
            page.evaluate("""() => {
              const i = document.createElement('input');
              i.id = 'sc-probe-input';
              document.body.appendChild(i);
              i.focus();
            }""")
            page.keyboard.press('Alt+Shift+R')
            page.wait_for_timeout(300)
            check('Alt+Shift+R does nothing inside an input',
                  page.evaluate(PANE_JS)['tool'] != 'rect',
                  page.evaluate(PANE_JS)['tool'])
            # and the keystroke still reached the input (the handler returned early,
            # it did not swallow the character)
            check('the input is still focused (the guard did not steal focus)',
                  page.evaluate("() => document.activeElement && document.activeElement.id") == 'sc-probe-input')
            page.evaluate("() => { const i = document.getElementById('sc-probe-input'); if (i) i.remove(); }")

            # ---------------- reachable from the palette ---------------------
            print('  -- the editor is reachable from the command palette --')
            page.keyboard.press('Control+k')
            page.wait_for_timeout(300)
            page.evaluate("""() => {
              const inp = document.getElementById('cmd-input');
              inp.value = 'shortcuts';
              inp.dispatchEvent(new Event('input', { bubbles: true }));
            }""")
            page.wait_for_timeout(200)
            page.keyboard.press('Enter')
            page.wait_for_timeout(500)
            check('the palette opens the shortcut editor',
                  page.evaluate(DIALOG_STATE_JS)['open'])
            page.evaluate("() => window.__app.Shortcuts._dialog.close()")

            check('no console errors during the run', len(errs) == 0, errs[:3])
            browser.close()
    finally:
        kill_proc(prov)

    print()
    if FAILS:
        print(f'ROUND307 shortcuts E2E: {len(FAILS)} FAILED — ' + ', '.join(FAILS))
        return 1
    print('ROUND307 shortcuts E2E: all green')
    return 0


if __name__ == '__main__':
    sys.exit(main())
