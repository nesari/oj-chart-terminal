#!/usr/bin/env python3
"""Round 77 e2e — BUG-76-A/B regression: 786 Zones drawings must SURVIVE the
realtime rollback loop and stay VISIBLE on the chart.

The user's report: "settings panel is fine now, but NOTHING draws on the
chart". Root causes fixed this round:
  BUG-76-A  snapshot/restore aliasing — the rollback handed the snapshot's
            cloned arrays/sites to the live state by reference; the first
            array.set() polluted the snapshot, later rollbacks restored
            refs to already-deleted objects and the script only mutated
            dead objects -> objects created once, then vanished forever.
  BUG-76-B  tick-hook re-entry — updateForming()/runAll() ran against a
            runtime whose initial chunked pass was still in flight.

Headless flow (demo provider): boot -> add the REAL 786 Zones -> wait for the
full pass + several realtime ticks -> assert store keeps boxes/labels -> ALSO
pixel-check the pine foreground canvas (non-transparent colored pixels) ->
open the settings gear (round-76 regression) -> edit Days Back -> Ok ->
rebuild keeps the drawings. Exits 0 only if every check passes error-free.
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.join(ROOT, 'docs', 'shots-legacy')
FIXTURE = os.path.join(ROOT, 'fixtures', 'pine', 'corpus', '786-zones.pine')
PORT_HTTP, PORT_WS = 8899, 8777
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
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT_HTTP), handler).serve_forever()

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        assert wait_port(PORT_HTTP) and wait_port(PORT_WS)
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            try:
                b = pw.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                b = pw.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            pg = b.new_page(viewport={'width': 1600, 'height': 900})
            errors = []
            pg.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
            pg.on('console', lambda m: errors.append('console-error: ' + m.text) if m.type == 'error' else None)

            print('[1] boot + add the REAL 786 Zones')
            pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            pg.wait_for_selector('#login-connect', timeout=15000)
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_selector('#charts-grid canvas', timeout=20000)
            pg.wait_for_timeout(1200)
            # M15 chart so the session boxes are large enough to see
            pg.evaluate("""() => { const app = window.__app.App; app.setTf && app.setTf('M15'); }""")
            pg.wait_for_timeout(2500)
            src = open(FIXTURE, encoding='utf-8').read()
            added = pg.evaluate("""(src) => {
              const { PineScriptsStore, PineUI } = window.__app;
              const rec = PineScriptsStore.create('786 Zones r77', src);
              const pane = window.__app.App.panes[0];
              window.__pane = pane;
              return !!PineUI.add(pane, rec.id, {});
            }""", src)
            check('instance added', added)

            print('[2] wait for the full pass + realtime ticks (BUG-76-A/B)')
            deadline = time.time() + 90
            st = None
            while time.time() < deadline:
                st = pg.evaluate("""() => {
                  const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
                  return s ? { status: s.status, boxes: s.boxes, labels: s.labels, lines: s.lines,
                               bars: s.bars, intrabars: s.intrabars, intrabarBars: s.intrabarBars,
                               zoneFormed: s.zoneFormed, adds: s.adds, errors: s.errors,
                               running: s.rt ? !!s.rt._preFormSnap : false } : null;
                }""")
                if st and st['status'] == 'ok' and st['bars'] > 0:
                    # give the realtime loop a few ticks to try to kill the objects
                    pg.wait_for_timeout(4000)
                    st2 = pg.evaluate("""() => {
                      const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
                      return { boxes: s.boxes, labels: s.labels, zoneFormed: s.zoneFormed,
                               intrabars: s.intrabars, adds: s.adds, status: s.status };
                    }""")
                    st.update(st2)
                    break
                time.sleep(1.5)
            check('runtime ok after the full pass', st and st['status'] == 'ok', st)
            check('M1 intrabars fed (security_lower_tf)', st and st['intrabars'] > 0, st and st['intrabars'])
            check('zones formed from M1 data', st and st['zoneFormed'] > 0, st and st['zoneFormed'])
            check('boxes SURVIVE the realtime rollback loop', st and st['boxes'] > 0,
                  st and {k: st[k] for k in ('boxes', 'labels', 'adds')})
            check('labels SURVIVE the realtime rollback loop', st and st['labels'] > 0,
                  st and {k: st[k] for k in ('boxes', 'labels', 'adds')})
            check('object churn per tick (official re-create semantics)', st and st['adds']['box'] > st['boxes'],
                  st and st['adds'])

            print('[3] PIXEL PROOF: the drawings are actually ON the canvas')
            pix = pg.evaluate("""() => {
              const pane = window.__pane;
              const cv = pane._pineCanvases && pane._pineCanvases.fg;
              if (!cv) return null;
              const ctx = cv.getContext('2d');
              const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
              let colored = 0;
              for (let i = 3; i < img.length; i += 4) if (img[i] > 8) colored++;
              return { w: cv.width, h: cv.height, colored };
            }""")
            check('foreground canvas painted (thousands of colored px)',
                  pix and pix['colored'] > 3000, pix)
            pg.screenshot(path=os.path.join(SHOTS, 'r77-786-drawings.png'))

            print('[4] round-76 regression: settings dialog still fully works')
            pg.evaluate("""() => {
              const row = document.querySelector('.ind-row[data-pine]');
              row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }""")
            pg.wait_for_timeout(700)
            layer_hidden = pg.evaluate("() => document.getElementById('popup-layer').classList.contains('hidden')")
            check('settings dialog opens', not layer_hidden)
            n_inputs = pg.evaluate("() => document.querySelectorAll('#popup-layer .ind-settings .pine-inp').length")
            # ROUND214: newer tabs (Style/Visibility) also live under
            # .ind-settings now — scope the count to the Inputs body, minus
            # the synthetic Indicator-Timeframe row (round 144).
            n_tab = pg.evaluate("() => document.querySelectorAll('#popup-layer .pine-inputs label.pine-inp:not(.pine-tf-row)').length")
            # ROUND214: the 786 fixture grew inputs over time (70 -> 98); pin
            # dialog count against the engine's own collected defs instead.
            n_defs = pg.evaluate("() => { const s = (window.__app.PineUI.debug(window.__pane) || [])[0]; return (s && s.inputDefs ? s.inputDefs.length : -1); }")
            check('all inputs render (engine %s, dialog %s of %s rows)' % (n_defs, n_tab, n_inputs),
                  n_tab == n_defs and n_defs >= 70, (n_defs, n_tab, n_inputs))
            pg.evaluate("""() => {
              const inps = [...document.querySelectorAll('#popup-layer .ind-settings .pine-inp')];
              const db = inps.find(el => (el.querySelector('span') || {}).textContent === 'Days Back');
              const i = db.querySelector('input[type=number]');
              i.value = '3';
              i.dispatchEvent(new Event('change', { bubbles: true }));
            }""")
            pg.click('#popup-layer .ind-settings .ist-ok')
            pg.wait_for_timeout(9000)  # rebuild: M1 fetch + chunked pass
            st3 = pg.evaluate("""() => {
              const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
              return { status: s.status, boxes: s.boxes, labels: s.labels, zoneFormed: s.zoneFormed };
            }""")
            check('after Ok+rebuild: daysBack=3 formed multi-day zones', st3['status'] == 'ok' and st3['boxes'] > 6, st3)
            layer_hidden = pg.evaluate("() => document.getElementById('popup-layer').classList.contains('hidden')")
            check('dialog closed cleanly', layer_hidden)
            pg.screenshot(path=os.path.join(SHOTS, 'r77-786-daysback3.png'))

            print('[5] UI stays interactive')
            pg.click('#indicators-btn')
            pg.wait_for_timeout(400)
            ind_open = pg.evaluate("""() => {
              const d = document.querySelector('#popup-layer .ind-dialog');
              return !!d && !document.getElementById('popup-layer').classList.contains('hidden');
            }""")
            check('Indicators dialog opens right after (no freeze)', ind_open)
            pg.keyboard.press('Escape')
            pg.wait_for_timeout(200)

            print('[6] final error audit')
            real_errors = [e for e in errors if 'favicon' not in e]
            check('zero page/console errors across the session', not real_errors, real_errors[:5])
            b.close()
    finally:
        prov.terminate()

    print('=' * 40)
    print(f"RESULT: {len(FAILS)} failed" if FAILS else "RESULT: ALL E2E CHECKS PASSED")
    sys.exit(1 if FAILS else 0)

if __name__ == '__main__':
    os.makedirs(SHOTS, exist_ok=True)
    main()
