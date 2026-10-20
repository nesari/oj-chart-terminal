#!/usr/bin/env python3
"""Round 76 e2e — BUG-74-E regression: Pine settings dialog for the REAL
786 Zones indicator (70 inputs: 42 bool / 11 color / 8 int / 7 string-with-
options / 2 source).

Reproduces the user's exact flow headlessly: paste 786 Zones into the Pine
Editor -> Add to chart -> click the legend gear -> the settings dialog must
render ALL 70 inputs with correct control types (selects with real options,
text inputs for free text — never a `select.type` write) -> edit Days Back
-> Ok -> clean close + rebuild. Exits 0 only if every check passes and the
session is error-free.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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

            print('[1] boot + load the REAL 786 Zones into the editor')
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            page.wait_for_selector('#login-connect', timeout=15000)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_selector('#charts-grid canvas', timeout=20000)
            page.wait_for_timeout(1200)
            page.click('#pine-btn')
            page.wait_for_selector('#pine-editor:not(.hidden)', timeout=5000)
            with open(os.path.join(ROOT, 'scripts', 'pine-fixtures', '786-zones.pine'), 'r', encoding='utf-8') as f:
                src786 = f.read()
            page.evaluate("""(src) => {
              const ta = document.getElementById('pe-ta');
              ta.value = src;
              ta.dispatchEvent(new Event('input', { bubbles: true }));
            }""", src786)
            page.wait_for_timeout(1800)  # autosave + compile
            status = page.locator('#pe-status').inner_text()
            check('786 Zones compiles green in the editor', '✓' in status, status)

            print('[2] Add to chart (heavy script, chunked history run)')
            page.click('#pe-add')
            page.wait_for_timeout(6000)
            row = page.locator('.ind-row[data-pine]')
            check('786 Zones legend row rendered', row.count() >= 1, row.count())

            print('[3] BUG-74-E: settings dialog opens with ALL 70 inputs')
            # ROUND214: hit-tested row clicks are covered by overlays — dispatch.
            page.evaluate("""() => {
              const r = document.querySelector('.ind-row[data-pine]');
              if (r) r.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }""")
            page.wait_for_timeout(600)
            layer_hidden = page.evaluate("() => document.getElementById('popup-layer').classList.contains('hidden')")
            check('settings dialog opens (layer visible)', not layer_hidden)
            stats = page.evaluate("""() => {
              // ROUND214: scope to the Inputs body (Style/Visibility tabs share
              // .ind-settings now) and skip the synthetic TF row (round 144).
              const dlg = document.querySelector('#popup-layer .ind-settings');
              if (!dlg) return null;
              const inps = [...dlg.querySelectorAll('.pine-inputs label.pine-inp:not(.pine-tf-row)')];
              const kind = (el) => {
                const c = el.querySelector('select');
                if (c) return 'select';
                const i = el.querySelector('input');
                if (!i) return 'none';
                return i.type; // checkbox | number | color | text
              };
              const by = {};
              for (const el of inps) { const k = kind(el); by[k] = (by[k] || 0) + 1; }
              const h3 = dlg.querySelector('h3') ? dlg.querySelector('h3').textContent : '';
              const em = inps.find(el => (el.querySelector('span') || {}).textContent === 'Extend Mode');
              const emSel = em ? em.querySelector('select') : null;
              return { total: inps.length, by, h3,
                       emIsSelect: !!emSel, emValue: emSel ? emSel.value : null,
                       emOptions: emSel ? [...emSel.options].map(o => o.value) : [] };
            }""")
            check('dialog h3 carries the title', stats and '786' in stats['h3'], stats and stats['h3'])
            check('ALL 70 inputs rendered', stats and stats['total'] == 70, stats and stats['total'])
            by = stats['by'] if stats else {}
            check('42 checkboxes (bool)', by.get('checkbox', 0) == 42, by)
            # ROUND78: the native <input type=color> became the palette swatch
            # button (same 11 color inputs, alpha-aware) — count both forms,
            # scoped to the Inputs body like above (ROUND214).
            n_swatch = page.evaluate("() => document.querySelectorAll('#popup-layer .pine-inputs .pine-swatch-btn').length")
            check('11 color pickers (native or ROUND78 swatch)',
                  by.get('color', 0) == 11 or (by.get('color', 0) == 0 and n_swatch == 11),
                  {'color': by.get('color', 0), 'swatch': n_swatch})
            check('8 number inputs (int)', by.get('number', 0) == 8, by)
            check('9 selects (7 string-with-options + 2 source)', by.get('select', 0) == 9, by)
            check('Extend Mode renders a real select with TV options',
                  stats and stats['emIsSelect'] and stats['emValue'] == 'Fixed'
                  and stats['emOptions'] == ['Fixed', 'End of Day', 'End of Chart'], stats and stats['emOptions'])
            inline_rows = page.evaluate("() => document.querySelectorAll('#popup-layer .pine-inline-row').length")
            check('19 TV-parity inline runs (same inline= key -> one row)', inline_rows == 19, inline_rows)
            bad = [e for e in errors if 'Cannot set property type' in e or 'escape' in e.lower()]
            check('zero BUG-74-D/E errors (select.type / escape)', not bad, bad[:2])
            page.screenshot(path=os.path.join(SHOTS, 'r76-786-settings.png'))

            print('[4] edit Days Back -> Ok commits + rebuilds cleanly')
            page.evaluate("""() => {
              const inps = [...document.querySelectorAll('#popup-layer .ind-settings .pine-inp')];
              const db = inps.find(el => (el.querySelector('span') || {}).textContent === 'Days Back');
              const i = db.querySelector('input[type=number]');
              i.value = '3';
              i.dispatchEvent(new Event('change', { bubbles: true }));
            }""")
            page.click('#popup-layer .ind-settings .ist-ok')
            page.wait_for_timeout(4000)  # full rebuild with overrides
            layer_hidden = page.evaluate("() => document.getElementById('popup-layer').classList.contains('hidden')")
            check('dialog closed after Ok', layer_hidden)
            check('no leftover backdrop (layer fully cleared)',
                  page.evaluate("() => document.getElementById('popup-layer').children.length") == 0)
            st = page.evaluate("""() => {
              // ROUND214: match the 786 row anywhere (the shelf seeds other
              // samples and row order is not contractual).
              const rows = [...document.querySelectorAll('.ind-row[data-pine]')];
              return rows.map((r) => r.textContent || '');
            }""")
            # ROUND214: the heavy 786 rebuild is chunked — the row can show
            # the record name mid-rebuild. Wait for the 786 label to land.
            try:
                page.wait_for_function("""() => [...document.querySelectorAll('.ind-row[data-pine]')].some((r) => (r.textContent || '').indexOf('786') >= 0)""", timeout=30000)
                st = page.evaluate("""() => [...document.querySelectorAll('.ind-row[data-pine]')].map((r) => r.textContent || '')""")
            except Exception:
                pass
            check('786 Zones row still healthy after rebuild (green dot)',
                  any(('786' in t and '⚠' not in t) for t in st), [t[:60] for t in st])

            print('[5] UI still interactive after the heavy dialog')
            page.click('#indicators-btn')
            page.wait_for_timeout(400)
            ind_open = page.evaluate("""() => {
              const d = document.querySelector('#popup-layer .ind-dialog');
              return !!d && !document.getElementById('popup-layer').classList.contains('hidden');
            }""")
            check('Indicators dialog opens right after (no freeze)', ind_open)
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)

            print('[6] final error audit')
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
