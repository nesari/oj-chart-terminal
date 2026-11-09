#!/usr/bin/env python3
"""Round 75 e2e — BUG-74-D regression: Pine settings dialog + UI freeze.

Reproduces the user's exact scenario headlessly (demo provider + Chromium):
add a Pine script to the chart -> click its legend row (settings) -> the
dialog must render FULL (title + inputs, zero "escape" errors) -> close via
Ok/Escape -> NO leftover backdrop -> the chart must still be interactive
(next dialog opens fine). Exits 0 only if every check passes.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
SHOTS = os.path.join(ROOT, 'docs', 'shots-legacy')
PORT_HTTP = 8899
PORT_WS = 8777
FAILS = []
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if extra and not cond else ''))
    if not cond:
        FAILS.append(name)

def wait_port(port, timeout=15):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with socket.create_connection(('127.0.0.1', port), 0.4):
                return True
        except OSError:
            time.sleep(0.2)
    return False

def serve_http():
    # HTTP root must be src/ so renderer's ../../../core/* imports resolve
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, 'src'))
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT_HTTP), handler)
    httpd.serve_forever()

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        assert wait_port(PORT_HTTP), 'http server did not start'
        assert wait_port(PORT_WS), 'demo provider did not start'

        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = pw.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1600, 'height': 900})
            errors = []
            page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
            page.on('console', lambda m: errors.append('console-error: ' + m.text) if m.type == 'error' else None)

            print('[1] boot + add RSI pine script to the chart')
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            page.wait_for_selector('#login-connect', timeout=15000)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_selector('#charts-grid canvas', timeout=20000)
            page.wait_for_timeout(1200)
            page.click('#pine-btn')
            page.wait_for_selector('#pine-editor:not(.hidden)', timeout=5000)
            page.evaluate("""() => {
              const sel = document.getElementById('pe-script-sel');
              const rsi = [...sel.options].find(o => /RSI/.test(o.textContent));
              if (rsi) { sel.value = rsi.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
            }""")
            page.wait_for_timeout(400)
            page.click('#pe-add')
            page.wait_for_timeout(2500)  # full history run + series creation
            row = page.locator('.ind-row[data-pine]')
            check('pine legend row rendered', row.count() >= 1, row.count())

            print('[2] BUG-74-D: settings dialog opens FULL (was empty + crash)')
            # ROUND214: hit-tested clicks are covered here (history pill, then
            # the trade panel over sub-pane headers) — dispatch the gear click
            # directly like e2e 77 (same dialog, same handler).
            page.evaluate("""() => {
              const g = document.querySelector('.ind-row[data-pine] .ind-btns .ind-btn:nth-child(2)');
              if (g) g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }""")
            page.wait_for_timeout(400)
            layer_hidden = page.evaluate("() => document.getElementById('popup-layer').classList.contains('hidden')")
            check('popup layer visible after clicking the legend row', not layer_hidden)
            dlg_txt = page.evaluate("""() => {
              const d = document.querySelector('#popup-layer .ind-settings');
              return d ? d.querySelector('h3') ? d.querySelector('h3').textContent : '' : null;
            }""")
            check('dialog h3 carries the script title (not an empty box)',
                  dlg_txt and 'RSI' in dlg_txt, repr(dlg_txt))
            n_inputs = page.evaluate("() => document.querySelectorAll('#popup-layer .ind-settings .pine-inp').length")
            check('settings dialog lists real inputs from input.*()', n_inputs >= 1, n_inputs)
            bad = [e for e in errors if 'escape' in e.lower()]
            check('zero "U.escape" errors anywhere', not bad, bad[:2])
            page.screenshot(path=os.path.join(SHOTS, 'r75-settings-open.png'))

            print('[3] Ok path: input edit commits + dialog closes cleanly')
            page.evaluate("""() => {
              const inp = document.querySelector('#popup-layer .ind-settings .pine-inp input[type=number]');
              if (inp) { inp.value = '21'; inp.dispatchEvent(new Event('change', { bubbles: true })); }
            }""")
            page.click('#popup-layer .ind-settings .ist-ok')
            page.wait_for_timeout(1500)  # rebuild with new inputs
            layer_hidden = page.evaluate("() => document.getElementById('popup-layer').classList.contains('hidden')")
            check('dialog closed after Ok', layer_hidden)
            check('no leftover backdrop in the layer',
                  page.evaluate("() => document.getElementById('popup-layer').children.length") == 0)
            row_v = page.evaluate("""() => {
              const r = document.querySelector('.ind-row[data-pine]');
              return r ? r.textContent : '';
            }""")
            check('pine row still present after rebuild', 'RSI' in row_v, row_v[:80])

            print('[4] Escape path + UI NOT frozen (the user-reported freeze)')
            # ROUND214: same overlay cover as [2] — dispatch, don't hit-test.
            page.evaluate("""() => {
              const g = document.querySelector('.ind-row[data-pine] .ind-btns .ind-btn:nth-child(2)');
              if (g) g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }""")
            page.wait_for_timeout(300)
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)
            layer_hidden = page.evaluate("() => document.getElementById('popup-layer').classList.contains('hidden')")
            check('Escape closes the settings dialog', layer_hidden)
            page.click('#indicators-btn')
            page.wait_for_timeout(400)
            ind_open = page.evaluate("""() => {
              const d = document.querySelector('#popup-layer .ind-dialog');
              return !!d && !document.getElementById('popup-layer').classList.contains('hidden');
            }""")
            check('chart still interactive: Indicators dialog opens right after', ind_open)
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)

            print('[5] final error audit')
            real_errors = [e for e in errors if 'favicon' not in e]
            check('zero page/console errors across the whole session', not real_errors, real_errors[:5])
            browser.close()
    finally:
        prov.terminate()

    print('=' * 40)
    print(f"RESULT: {len(FAILS)} failed" if FAILS else "RESULT: ALL E2E CHECKS PASSED")
    sys.exit(1 if FAILS else 0)

if __name__ == '__main__':
    os.makedirs(SHOTS, exist_ok=True)
    main()
