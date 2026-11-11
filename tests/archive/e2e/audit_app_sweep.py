#!/usr/bin/env python3
"""Full-app UI audit — walks every panel, dialog and toolbar group and records
real failures (page errors, console errors, missing DOM, thrown handlers).

This is a DISCOVERY tool: it prints a report so bugs can be triaged, and exits
non-zero when something is broken. Later rounds turn confirmed findings into
pinned regression tests.

Run: python tests/archive/e2e/audit_app_sweep.py [--json out.json]
"""
import http.server, functools, json, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8975, 8864
FINDINGS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def finding(area, issue, detail=''):
    FINDINGS.append({'area': area, 'issue': issue, 'detail': str(detail)[:400]})
    print('  BUG  [' + area + '] ' + issue + ((' - ' + str(detail)[:200]) if detail else ''))


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


# Discover the real panel list and toolbar buttons from the live DOM.
DISCOVER_JS = """() => {
  const rail = [...document.querySelectorAll('#right-tabs .rt-btn[data-tab]')].map((b) => b.dataset.tab);
  const rtabs = [...document.querySelectorAll('.rtab')].map((e) => e.id.replace(/^tab-/, ''));
  const toolbarGroups = [...document.querySelectorAll('#toolbar [data-group], #toolbar .tb-btn, .tb-group')].length;
  return { rail, rtabs, toolbarGroups };
}"""

# Open one right-panel tab and report its visible content + any immediate error.
OPEN_TAB_JS = """(tab) => {
  const out = { tab, opened: false, visible: false, textLen: 0, children: 0, error: null };
  try {
    window.__app.RightPanel.showTab(tab);
    const el = document.getElementById('tab-' + tab);
    if (!el) { out.error = 'no #tab-' + tab; return out; }
    out.opened = true;
    out.visible = !el.classList.contains('hidden');
    out.textLen = (el.textContent || '').trim().length;
    out.children = el.querySelectorAll('*').length;
  } catch (e) { out.error = String(e && e.message || e); }
  return out;
}"""

# Exercise the main toolbar dialogs / toggles.
CLICK_ID_JS = """(id) => {
  const el = document.getElementById(id);
  if (!el) return { id, found: false };
  try { el.click(); return { id, found: true, clicked: true }; }
  catch (e) { return { id, found: true, clicked: false, error: String(e && e.message || e) }; }
}"""

# Generic "does this button open something" probe.
CLICK_SEL_JS = """(sel) => {
  const el = document.querySelector(sel);
  if (!el) return { sel, found: false };
  try { el.click(); return { sel, found: true, clicked: true }; }
  catch (e) { return { sel, found: true, clicked: false, error: String(e && e.message || e) }; }
}"""

DIALOG_STATE_JS = """() => {
  const dlgs = [...document.querySelectorAll('.dlg-layer:not(.hidden), #draw-settings-dialog, .dialog:not(.hidden)')];
  return {
    open: dlgs.length,
    ids: dlgs.map((d) => d.id || d.className.split(' ')[0]),
    textLen: dlgs.reduce((a, d) => a + (d.textContent || '').length, 0),
  };
}"""

CLOSE_ALL_JS = """() => {
  /* close dialogs the way a user would */
  let n = 0;
  for (const sel of ['#draw-settings-dialog .dlg-x', '.dlg-layer:not(.hidden) .dlg-x',
                     '.dlg-layer:not(.hidden) .dlg-cancel', '.ds-close']) {
    for (const b of document.querySelectorAll(sel)) { try { b.click(); n++; } catch (e) {} }
  }
  for (const l of document.querySelectorAll('.dlg-layer:not(.hidden)')) l.classList.add('hidden');
  return n;
}"""


def main():
    as_json = '--json' in sys.argv
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
            page.wait_for_timeout(1200)

            print('\n=== boot ===')
            if errors:
                for e in errors[:5]:
                    finding('boot', 'page error at startup', e)
            else:
                ok('boot', 'no page errors at startup')

            disc = page.evaluate(DISCOVER_JS)
            print('  rail tabs: ' + ', '.join(disc['rail']))
            print('  panel tabs: ' + ', '.join(disc['rtabs']))

            # 1) every right-panel tab must open and render content
            print('\n=== right-panel tabs ===')
            for tab in disc['rtabs']:
                n0 = len(errors)
                r = page.evaluate(OPEN_TAB_JS, tab)
                page.wait_for_timeout(220)
                if r.get('error'):
                    finding('panel:' + tab, 'open threw', r['error'])
                elif not r.get('opened'):
                    finding('panel:' + tab, 'tab element missing')
                elif not r.get('visible'):
                    finding('panel:' + tab, 'tab stayed hidden after showTab')
                elif r.get('children', 0) < 2:
                    finding('panel:' + tab, 'tab renders (almost) nothing',
                            'text=' + str(r.get('textLen')) + ' nodes=' + str(r.get('children')))
                else:
                    ok('panel:' + tab, 'renders ' + str(r.get('children')) + ' nodes')
                if len(errors) > n0:
                    finding('panel:' + tab, 'page error while opening', errors[-1])

            # 2) rail buttons that are not panel tabs (tester dock etc.)
            print('\n=== rail buttons ===')
            for tab in disc['rail']:
                if tab in disc['rtabs']:
                    continue
                n0 = len(errors)
                # rail entries that have no #tab-<id> are dock toggles (tester)
                r = page.evaluate("""(tab) => {
                  const btn = document.querySelector('#right-tabs .rt-btn[data-tab="' + tab + '"]');
                  if (!btn) return { found: false };
                  try { btn.click(); return { found: true }; }
                  catch (e) { return { found: true, error: String(e && e.message || e) }; }
                }""", tab)
                page.wait_for_timeout(260)
                if r.get('error'):
                    finding('rail:' + tab, 'click threw', r['error'])
                elif not r.get('found'):
                    finding('rail:' + tab, 'rail button missing')
                elif len(errors) > n0:
                    finding('rail:' + tab, 'page error', errors[-1])
                else:
                    ok('rail:' + tab, 'opens without error')
                page.evaluate(CLOSE_ALL_JS)

            # 3) top-toolbar entry points (real ids from index.html)
            print('\n=== toolbar dialogs ===')
            for sel, label in [
                ('#settings-btn', 'settings'), ('#style-btn', 'chart style'),
                ('#indicators-btn', 'indicators'), ('#pine-btn', 'pine editor'),
                ('#layout-btn', 'layout'), ('#savelayout-btn', 'save layout'),
                ('#alert-btn', 'alert'), ('#replay-btn', 'replay'),
                ('#compare-btn', 'compare'), ('#session-btn', 'session'),
                ('#symbol-btn', 'symbol search'), ('#snapshot-btn', 'snapshot'),
                ('#theme-btn', 'theme'), ('#dw-btn', 'data window'),
            ]:
                n0 = len(errors)
                r = page.evaluate(CLICK_SEL_JS, sel)
                if not r.get('found'):
                    finding('toolbar:' + label, 'button missing from DOM', sel)
                    continue
                page.wait_for_timeout(300)
                st = page.evaluate(DIALOG_STATE_JS)
                if r.get('error'):
                    finding('toolbar:' + label, 'click threw', r['error'])
                elif st.get('open', 0) == 0 and label not in ('theme', 'snapshot', 'data window', 'undo', 'redo'):
                    finding('toolbar:' + label, 'click opened no dialog/menu', json.dumps(st))
                else:
                    ok('toolbar:' + label, 'opened ' + str(st.get('ids')))
                page.evaluate(CLOSE_ALL_JS)
                page.wait_for_timeout(160)
                if len(errors) > n0:
                    finding('toolbar:' + label, 'page error after click', errors[-1])

            # 4) keyboard shortcuts that every TV user expects
            print('\n=== shortcuts ===')
            for key, what in [('Alt+r', 'rename'), ('Alt+Delete', 'clear drawings'),
                              ('Control+z', 'undo'), ('Escape', 'close')]:
                n0 = len(errors)
                try:
                    page.keyboard.press(key)
                except Exception as e:
                    finding('shortcut:' + key, 'press failed', e)
                    continue
                page.wait_for_timeout(200)
                page.evaluate(CLOSE_ALL_JS)
                if len(errors) > n0:
                    finding('shortcut:' + key, 'page error', errors[-1])
                else:
                    ok('shortcut:' + key, what + ' handled')
            page.wait_for_timeout(200)

            # 5) final error tally
            print('\n=== final ===')
            if console_errs:
                seen = []
                for c in console_errs:
                    if c not in seen:
                        seen.append(c)
                for c in seen[:8]:
                    finding('console', 'console error', c)
            else:
                ok('console', 'no console errors')

            browser.close()
    finally:
        prov.terminate()

    print('\n================ AUDIT ================')
    print('findings: ' + str(len(FINDINGS)))
    if as_json:
        out = sys.argv[sys.argv.index('--json') + 1] if len(sys.argv) > sys.argv.index('--json') + 1 else 'audit.json'
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(FINDINGS, f, indent=2)
        print('written: ' + out)
    return 1 if FINDINGS else 0


if __name__ == '__main__':
    sys.exit(main())
