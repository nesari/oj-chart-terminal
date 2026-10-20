#!/usr/bin/env python3
"""Round 78 e2e — color picker + broker-offset timezone + perf instrumentation.

Boots the demo provider with --off 10800 (a GMT+3 broker, exactly the user's
complaint: MT5 feeds are stamped in the BROKER wall clock) and the real
786 Zones, then asserts:
  1. the feed offset reaches the Pine runtime (env.serverOffSec == 10800)
  2. every MAIN session box sits at LOCAL hour 9 of its own session tz —
     the boxes are at the correct wall-clock hour on the chart
  3. the settings dialog carries the ROUND78 color picker (palette grid +
     custom row + '+' + OPACITY slider + percent box) and the Data Timezone
     row with the live feed offset
  4. an opacity edit (65% -> 40%) flows Ok -> rebuild -> box bgcolor css
  5. lastRunMs perf telemetry is recorded; an immediate recomputePine on the
     SAME data does NOT repeat the heavy full pass (round-78 coalescing)
Exits 0 only if every check passes with zero page errors.
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
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py'), '--off', '10800'],
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

            print('[1] boot (demo broker = GMT+3) + add the REAL 786 Zones')
            pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            pg.wait_for_selector('#login-connect', timeout=15000)
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_selector('#charts-grid canvas', timeout=20000)
            pg.wait_for_timeout(1500)
            pg.evaluate("""() => { const app = window.__app.App; app.setTf && app.setTf('M15'); }""")
            pg.wait_for_timeout(2500)
            feed_off = pg.evaluate("() => (window.__app.App.feed && window.__app.App.feed.serverOff) || 0")
            check('feed measured the GMT+3 broker offset', feed_off == 10800, feed_off)
            src = open(FIXTURE, encoding='utf-8').read()
            added = pg.evaluate("""(src) => {
              const { PineScriptsStore, PineUI } = window.__app;
              const rec = PineScriptsStore.create('786 Zones r78', src);
              const pane = window.__app.App.panes[0];
              window.__pane = pane;
              window.__inst = PineUI.add(pane, rec.id, {});
              return !!window.__inst;
            }""", src)
            check('instance added', added)
            print('[2] full pass + timezone correctness of the drawn boxes')
            deadline = time.time() + 90
            st = None
            while time.time() < deadline:
                st = pg.evaluate("""() => {
                  const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
                  return s ? { status: s.status, boxes: s.boxes, labels: s.labels, zoneFormed: s.zoneFormed,
                               serverOffSec: s.serverOffSec, lastRunMs: s.lastRunMs, errors: s.errors } : null;
                }""")
                if st and st['status'] == 'ok' and st['boxes'] > 0:
                    break
                time.sleep(1.2)
            check('runtime ok with boxes on the chart', st and st['status'] == 'ok' and st['boxes'] > 0, st)
            # all-session audit: widen Days Back AFTER the initial pass is done
            ov = pg.evaluate("""() => {
              const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
              if (!s || !s.inputDefs) return false;
              const def = s.inputDefs.find((d) => (d.title || '').toLowerCase() === 'days back');
              if (!def) return false;
              window.__inst.inputs[def.id] = 3;   // all six sessions across 3 days
              return true;
            }""")
            check('Days Back override applied (all-session audit)', ov)
            pg.wait_for_timeout(1700)
            pg.evaluate("() => window.__app.Manager.recomputePine(window.__pane)")
            deadline2 = time.time() + 60
            st2 = None
            while time.time() < deadline2:
                st2 = pg.evaluate("""() => {
                  const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
                  return s ? { status: s.status, boxes: s.boxes } : null;
                }""")
                if st2 and st2['status'] == 'ok' and st2['boxes'] > 0:
                    # a re-run is only trustworthy once lastRunMs CHANGED (new pass ran)
                    if st.get('lastRunMs') != st2.get('lastRunMs'):
                        break
                time.sleep(1.0)
            check('runtime uses the feed offset (10800s)', st and st['serverOffSec'] == 10800, st and st['serverOffSec'])
            check('lastRunMs telemetry recorded', st and isinstance(st['lastRunMs'], int) and st['lastRunMs'] > 0, st and st['lastRunMs'])
            hours = pg.evaluate("""() => {
              const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
              const out = {};
              if (!s || !s.rt) return out;
              for (const [, lb] of s.rt.store.label) {
                // labels may carry a days-back suffix ("FR (-1d)") — audit the
                // session prefix; which sessions have formed depends on the
                // provider's wall clock at boot (weekend/early-morning runs
                // have no db=0 FR/LN/NY yet), so collect across ALL days
                const key = String(lb.text).trim().split(' (')[0].trim();
                const tz = { SY: 'Australia/Sydney', TK: 'Asia/Tokyo', HK: 'Asia/Hong_Kong',
                             FR: 'Europe/Berlin', LN: 'Europe/London', NY: 'America/New_York' }[key];
                if (!tz) continue;
                const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: 'numeric' });
                let h = parseInt(f.formatToParts(new Date(lb.x)).find(p => p.type === 'hour').value, 10);
                if (h === 24) h = 0;
                out[key] = h;
              }
              return out;
            }""")
            check('6 main session keys found for the hour audit', len(hours) >= 6, hours)
            all9 = hours and all(h == 9 for h in hours.values())
            check('every main zone sits at LOCAL hour 9 (broker GMT+3 accounted)', all9, hours)

            print('[3] round-78 coalescing: an immediate recomputePine is free')
            before = pg.evaluate("""() => {
              const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
              return { at: Date.now(), ms: s.lastRunMs };
            }""")
            pg.evaluate("() => window.__app.Manager.recomputePine(window.__pane)")
            pg.wait_for_timeout(700)
            after = pg.evaluate("""() => {
              const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
              return { ms: s.lastRunMs, boxes: s.boxes };
            }""")
            check('recompute on the same data skipped the duplicate full pass',
                  after['ms'] == before['ms'] and after['boxes'] > 0, (before['ms'], after['ms']))

            print('[4] settings dialog: Data Timezone row + ROUND78 color picker')
            pg.evaluate("""() => {
              const row = document.querySelector('.ind-row[data-pine]');
              row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }""")
            pg.wait_for_timeout(700)
            layer_hidden = pg.evaluate("() => document.getElementById('popup-layer').classList.contains('hidden')")
            check('settings dialog opens', not layer_hidden)
            tz_txt = pg.evaluate("() => { const el = document.querySelector('.pine-tz-info'); return el ? el.textContent : ''; }")
            check('Data Timezone row shows the live feed offset', 'UTC+03:00' in tz_txt, tz_txt)
            tz_inp = pg.evaluate("() => !!document.querySelector('.pine-tz-inp')")
            check('broker-offset override input present', tz_inp)
            # ROUND214: scope to the Inputs body (the Style tab paints its own
            # plot-color swatches under the same dialog).
            n_swatch = pg.evaluate("() => document.querySelectorAll('#popup-layer .pine-inputs .pine-swatch-btn').length")
            # ROUND214: the 786 fixture grew color inputs over time (11 -> 17);
            # pin the swatch count against the engine's own color defs instead.
            n_cdefs = pg.evaluate("() => { const s = (window.__app.PineUI.debug(window.__pane) || [])[0]; return (s && s.inputDefs ? s.inputDefs.filter((d) => d.kind === 'color').length : -1); }")
            check('every color input is now a palette swatch button (engine %s, swatches %s)' % (n_cdefs, n_swatch),
                  n_swatch == n_cdefs and n_cdefs >= 11, (n_cdefs, n_swatch))
            # open the FIRST session color picker (Sydney = first standalone 'Color' row)
            opened = pg.evaluate("""() => {
              const rows = [...document.querySelectorAll('#popup-layer .pine-inp')];
              const syd = rows.find(el => (el.querySelector('span') || {}).textContent === 'Color');
              if (!syd) return false;
              const sw = syd.querySelector('.pine-swatch-btn');
              if (!sw) return false;
              sw.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return true;
            }""")
            check('Sydney color swatch clickable', opened)
            pg.wait_for_timeout(400)
            pal = pg.evaluate("""() => {
              const p = document.querySelector('.pine-palette');
              if (!p) return null;
              return { swatches: p.querySelectorAll('.pine-pal-sw').length,
                       plus: !!p.querySelector('.pine-pal-plus'),
                       slider: !!p.querySelector('.pine-pal-slider'),
                       num: !!p.querySelector('.pine-pal-num'),
                       sliderVal: p.querySelector('.pine-pal-slider') ? p.querySelector('.pine-pal-slider').value : '' };
            }""")
            check('palette panel opens (TV-style)', bool(pal), pal)
            check('50-swatch preset grid', pal and pal['swatches'] == 50, pal and pal['swatches'])
            check('custom row + eyedropper (+) present', pal and pal['plus'])
            check('OPACITY slider + percent box present', pal and pal['slider'] and pal['num'])
            check('slider initialized from the default alpha (35%)', pal and pal['sliderVal'] == '35', pal and pal['sliderVal'])
            pg.screenshot(path=os.path.join(SHOTS, 'r78-picker.png'))
            # opacity 35% -> 40% through the slider (the exact user workflow)
            set_ok = pg.evaluate("""() => {
              const p = document.querySelector('.pine-palette');
              if (!p) return false;
              const s = p.querySelector('.pine-pal-slider');
              s.value = '40';
              s.dispatchEvent(new Event('input', { bubbles: true }));
              return true;
            }""")
            check('opacity slider editable', set_ok)
            num_val = pg.evaluate("() => { const p = document.querySelector('.pine-palette'); return p.querySelector('.pine-pal-num').value; }")
            check('percent box follows the slider (40)', num_val == '40', num_val)
            # close the palette, then Ok -> rebuild
            pg.evaluate("""() => document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))""")
            pg.wait_for_timeout(200)
            pg.click('#popup-layer .ind-settings .ist-ok')
            pg.wait_for_timeout(9000)
            bg = pg.evaluate("""() => {
              const s = (window.__app.PineUI.debug(window.__pane) || [])[0];
              if (!s || !s.rt) return null;
              for (const [, bx] of s.rt.store.box) {
                if (bx.bgcolor && bx.bgcolor.r === 65) return bx.bgcolor.css();
              }
              return null;
            }""")
            check('opacity edit survived Ok -> rebuild (Sydney fill = rgba(...,0.4))',
                  bg == 'rgba(65,105,225,0.4)', bg)
            layer_hidden = pg.evaluate("() => document.getElementById('popup-layer').classList.contains('hidden')")
            check('dialog closed cleanly after Ok', layer_hidden)

            print('[5] pixel proof + UI stays interactive')
            # the Ok-rebuild repaints after the full pass — poll generously
            pix = None
            for _ in range(22):
                pg.wait_for_timeout(1000)
                pix = pg.evaluate("""() => {
                  const pane = window.__pane;
                  const cv = pane._pineCanvases && pane._pineCanvases.fg;
                  if (!cv) return null;
                  const ctx = cv.getContext('2d');
                  const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
                  let colored = 0;
                  for (let i = 3; i < img.length; i += 4) if (img[i] > 8) colored++;
                  return { colored };
                }""")
                if pix and pix['colored'] > 3000:
                    break
            check('foreground canvas painted (boxes visible)', pix and pix['colored'] > 3000, pix)
            pg.screenshot(path=os.path.join(SHOTS, 'r78-zones.png'))
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
