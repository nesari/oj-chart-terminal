#!/usr/bin/env python3
"""ROUND132 e2e — Bar Replay speed menu + pick graphic + TV top-bar rebuild.

Boots the demo broker + renderer, then:

 [1] TOP BAR REBUILD: 46px bar, 34px buttons, every icon box 24x24 (the
     layout glyph included), 8 group separators, TV labels on
     Indicators/Alert/Replay, the symbol selector rendered as a TV pill
     (filled, fully rounded, bold, chevron), both themes
 [2] REPLAY SPEED: 14 speeds (0.1x ... 20x), click still cycles, the
     chevron opens the speed MENU, picking 0.25x applies + persists, the
     active row is marked and follows cycle clicks
 [3] REPLAY PICK GRAPHIC (TV parity): arming the pick paints the blue
     line + badge + veil on the chart canvas (pixel-probed), Escape
     cancels, a chart click starts the session, re-clicking the toolbar
     button while armed aborts
 [4] SCREENSHOTS: top bar (dark+light), armed pick state, speed menu open
 [5] zero page errors across the whole run

Exits 0 only if every check passes.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8943, 8777
SHOTS = os.path.join(ROOT, 'docs', 'shots-round132')
FAILS = []
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def check(name, cond, extra=''):
    print(('  \u2713 ' if cond else '  \u2717 ') + name + ((' \u2014 ' + str(extra)) if (not cond and extra != '') else ''))
    if not cond:
        FAILS.append(name)

def wait_port(port, timeout=20):
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

BLUE_JS = """(cv) => {
  // probe the overlay canvas for the TV-blue pick line (#2962ff)
  const ctx = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  if (!w || !h) return false;
  const img = ctx.getImageData(0, 0, w, h).data;
  let hits = 0;
  for (let i = 0; i < img.length; i += 4) {
    if (Math.abs(img[i] - 41) < 30 && Math.abs(img[i+1] - 98) < 30 && Math.abs(img[i+2] - 255) < 30 && img[i+3] > 120) hits++;
    if (hits > 8) return true;
  }
  return false;
}"""

def main():
    threading.daemon = True
    t = threading.Thread(target=serve_http, daemon=True)
    t.start()
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up'); return 1
    ok = True
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
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_timeout(1200)

            print('\u2014 [1] the top bar: sizes, groups, pill, labels \u2014')
            tb = page.evaluate("""() => {
              const bar = document.getElementById('top-toolbar');
              const visBtns = [...document.querySelectorAll('#top-toolbar .tb-btn')]
                .filter((b) => b.offsetParent !== null && !b.classList.contains('tf-plus'));
              const btn = document.getElementById('tf-menu-btn');
              const svgs = visBtns
                .flatMap((b) => [...b.querySelectorAll(':scope > svg')])
                .map((s) => Math.round(s.getBoundingClientRect().width * 10) / 10);
              const lay = document.querySelector('#layout-btn > svg');
              const layBox = lay ? lay.getBoundingClientRect() : null;
              const sym = document.getElementById('symbol-btn');
              const symCs = getComputedStyle(sym);
              const seps = document.querySelectorAll('#top-toolbar .tb-sep').length;
              const lbl = (id) => {
                const b = document.getElementById(id);
                const l = b ? b.querySelector('.tb-lbl') : null;
                return l ? l.textContent : null;
              };
              const indChev = !!document.querySelector('#indicators-btn .tb-chev svg');
              const symIcW = (() => {
                const ic = document.querySelector('#symbol-btn .ic svg');
                return ic ? Math.round(ic.getBoundingClientRect().width) : 0;
              })();
              return {
                barH: Math.round(bar.getBoundingClientRect().height),
                btnH: Math.round(btn.getBoundingClientRect().height),
                svgMin: Math.min(...svgs), svgMax: Math.max(...svgs), svgN: svgs.length,
                layW: layBox ? Math.round(layBox.width) : 0,
                layH: layBox ? Math.round(layBox.height) : 0,
                symRadius: symCs.borderRadius, symBg: symCs.backgroundColor,
                symW: Math.round(sym.getBoundingClientRect().width),
                seps, ind: lbl('indicators-btn'), al: lbl('alert-btn'), rp: lbl('replay-btn'),
                indChev, symIcW,
              };
            }""")
            check('bar is 46px tall with 34px buttons', tb['barH'] == 46 and tb['btnH'] == 34, str(tb['barH']) + '/' + str(tb['btnH']))
            check('every direct icon is 24x24 (layout included; the tf-bar "+" mini-glyph exempt)',
                  tb['svgN'] >= 10 and tb['svgMin'] == 24 and tb['svgMax'] == 24 and tb['layW'] == 24 and tb['layH'] == 24,
                  str({'n': tb['svgN'], 'min': tb['svgMin'], 'max': tb['svgMax'], 'lay': (tb['layW'], tb['layH'])}))
            plusW = page.evaluate("() => { const s = document.querySelector('#tf-fav-bar .tf-plus svg'); return s ? Math.round(s.getBoundingClientRect().width) : 0; }")
            check('the tf-bar "+" mini-glyph rides at 20px (proportional, secondary)', plusW == 20, str(plusW))
            check('8 group separators (9 groups, TV grouping)', tb['seps'] == 8, str(tb['seps']))
            check('TV labels: Indicators + chevron, Alert, Replay',
                  tb['ind'] == 'Indicators' and tb['indChev'] and tb['al'] == 'Alert' and tb['rp'] == 'Replay',
                  str({'ind': tb['ind'], 'chev': tb['indChev'], 'al': tb['al'], 'rp': tb['rp']}))
            check('symbol selector is the TV pill (filled, round, bold, chevron 15px)',
                  tb['symRadius'] == '999px' and tb['symBg'] not in ('rgba(0, 0, 0, 0)', 'transparent') and tb['symIcW'] == 15 and tb['symW'] > 80,
                  str({'r': tb['symRadius'], 'bg': tb['symBg'], 'ic': tb['symIcW'], 'w': tb['symW']}))
            # nothing clips: every VISIBLE button fits inside the 46px bar
            fits = page.evaluate("""() => {
              const barTop = document.getElementById('top-toolbar').getBoundingClientRect().top;
              return [...document.querySelectorAll('#top-toolbar .tb-btn')]
                .filter((b) => b.offsetParent !== null)
                .every((b) => { const r = b.getBoundingClientRect(); return r.top >= barTop - 1 && r.bottom <= barTop + 47; });
            }""")
            check('no button clips the taller bar', fits)

            print('\u2014 [2] replay speed: more speeds + the selection menu \u2014')
            page.evaluate("() => window.__app.Replay.startAt(window.__app.App.activePane, Math.floor(window.__app.App.activePane.bars.length / 2))")
            page.wait_for_timeout(400)
            vis = page.evaluate("() => !document.getElementById('replay-bar').classList.contains('hidden')")
            check('replay session started (bar visible)', vis)
            speeds = page.evaluate("""() => {
              const items = [...document.querySelectorAll('#replay-bar .rp-speed-wrap, #replay-bar .rp-speed')];
              return { wrap: !!document.querySelector('#replay-bar .rp-speed-wrap'),
                       menuBtn: !!document.getElementById('rp-speed-menu'),
                       label: document.getElementById('rp-speed').textContent };
            }""")
            check('speed control is the split button (label + chevron)',
                  speeds['wrap'] and speeds['menuBtn'], str(speeds))
            # click the chevron -> menu with 14 items
            page.click('#rp-speed-menu')
            page.wait_for_timeout(300)
            menu = page.evaluate("""() => ({
              open: !!document.querySelector('.popup.rp-menu'),
              items: [...document.querySelectorAll('.popup.rp-menu .rpm-item')].map((b) => b.textContent),
              onIdx: [...document.querySelectorAll('.popup.rp-menu .rpm-item')].findIndex((b) => b.classList.contains('on')),
            })""")
            check('the menu opens with 14 speeds 0.1x\u202620x',
                  menu['open'] and len(menu['items']) == 14 and menu['items'][0] == '0.1x' and menu['items'][-1] == '20x',
                  str(menu['items']))
            # pick 0.25x
            page.evaluate("""() => [...document.querySelectorAll('.popup.rp-menu .rpm-item')]
              .find((b) => b.textContent === '0.25x').click()""")
            page.wait_for_timeout(250)
            after = page.evaluate("""() => ({
              label: document.getElementById('rp-speed').textContent,
              closed: !document.querySelector('.popup.rp-menu'),
              stored: localStorage.getItem('mt5_replay_speed'),
            })""")
            check('picking 0.25x applies, closes the menu, persists',
                  after['label'] == '0.25x' and after['closed'] and after['stored'] == '0.25', str(after))
            # reopen: the active row follows
            page.click('#rp-speed-menu')
            page.wait_for_timeout(250)
            on = page.evaluate("""() => {
              const items = [...document.querySelectorAll('.popup.rp-menu .rpm-item')];
              return items.findIndex((b) => b.classList.contains('on'));
            }""")
            check('the reopened menu marks 0.25x active', on == 1, str(on))
            # cycle clicks still work and keep the menu marker in sync
            page.evaluate("() => document.getElementById('rp-speed').click()")
            page.wait_for_timeout(150)
            cyc = page.evaluate("""() => ({
              label: document.getElementById('rp-speed').textContent,
              onIdx: [...document.querySelectorAll('.popup.rp-menu .rpm-item')].findIndex((b) => b.classList.contains('on')),
              stillOpen: !!document.querySelector('.popup.rp-menu'),
            })""")
            check('label clicks still cycle (0.25x -> 0.5x) and the marker follows',
                  cyc['label'] == '0.5x' and cyc['onIdx'] == 2 and cyc['stillOpen'], str(cyc))
            page.evaluate("() => document.body.click()")
            page.wait_for_timeout(200)

            print('\u2014 [3] the pick graphic (TV parity) \u2014')
            page.evaluate("() => window.__app.Replay.stop()")
            page.wait_for_timeout(300)
            page.click('#replay-btn')
            page.wait_for_timeout(250)
            armed = page.evaluate("() => window.__app.Replay.pickArmed()")
            btnActive = page.evaluate("() => document.getElementById('replay-btn').classList.contains('active')")
            check('arming the pick: Replay.pickArmed() + toolbar .active', armed and btnActive)
            # hover the chart -> overlay paints the blue pick line
            ov = page.evaluate("() => !!document.querySelector('#charts-grid canvas.pane-overlay')")
            check('overlay canvas present', ov)
            page.mouse.move(500, 400)
            page.wait_for_timeout(120)
            page.mouse.move(520, 405)   # two moves: engine tracks the raw cursor
            page.wait_for_timeout(300)
            painted = page.evaluate("(" + BLUE_JS + ")(document.querySelector('#charts-grid canvas.pane-overlay'))")
            check('the pick paints the TV-blue line/badge/pill on the overlay', painted)
            os.makedirs(SHOTS, exist_ok=True)
            page.locator('#charts-area').screenshot(path=os.path.join(SHOTS, 'pick-armed-dark.png'))
            # Escape cancels
            page.keyboard.press('Escape')
            page.wait_for_timeout(250)
            esc = page.evaluate("""() => ({
              armed: window.__app.Replay.pickArmed(),
              active: document.getElementById('replay-btn').classList.contains('active'),
            })""")
            check('Escape aborts the pick', (not esc['armed']) and (not esc['active']), str(esc))
            # re-arm, re-click on the toolbar button aborts too
            page.click('#replay-btn')
            page.wait_for_timeout(200)
            page.click('#replay-btn')
            page.wait_for_timeout(200)
            reclk = page.evaluate("() => window.__app.Replay.pickArmed()")
            check('re-clicking the toolbar button aborts the pick', not reclk)
            # arm and CLICK the chart -> the session starts
            page.click('#replay-btn')
            page.wait_for_timeout(200)
            page.mouse.click(520, 400)
            page.wait_for_timeout(400)
            started = page.evaluate("""() => ({
              on: window.__app.Replay.isActive(),
              armed: window.__app.Replay.pickArmed(),
              bar: !document.getElementById('replay-bar').classList.contains('hidden'),
            })""")
            check('clicking the chart starts the session from the picked bar',
                  started['on'] and not started['armed'] and started['bar'], str(started))
            page.evaluate("() => window.__app.Replay.stop()")
            page.wait_for_timeout(250)

            print('\u2014 [4] screenshots: top bar + speed menu, dark & light \u2014')
            # dark top bar
            page.locator('#top-toolbar').screenshot(path=os.path.join(SHOTS, 'topbar-dark.png'))
            # speed menu open (dark)
            page.evaluate("() => window.__app.Replay.startAt(window.__app.App.activePane, Math.floor(window.__app.App.activePane.bars.length / 2))")
            page.wait_for_timeout(300)
            page.click('#rp-speed-menu')
            page.wait_for_timeout(300)
            page.locator('#replay-bar').screenshot(path=os.path.join(SHOTS, 'replaybar-dark.png'))
            menu_shot = page.evaluate("() => { const m = document.querySelector('.popup.rp-menu'); const r = m.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; }")
            page.screenshot(path=os.path.join(SHOTS, 'speed-menu-dark.png'),
                            clip={'x': max(0, menu_shot['x'] - 10), 'y': max(0, menu_shot['y'] - 10),
                                  'width': menu_shot['w'] + 20, 'height': menu_shot['h'] + 20})
            page.evaluate("() => document.body.click()")
            page.wait_for_timeout(150)
            page.evaluate("() => window.__app.Replay.stop()")
            # light theme pass
            page.evaluate("() => window.__app.Theme.apply('light')")
            page.wait_for_timeout(250)
            light = page.evaluate("""() => {
              const sym = getComputedStyle(document.getElementById('symbol-btn'));
              const bar = getComputedStyle(document.getElementById('top-toolbar'));
              const item = document.querySelector('.rpm-item') || null;
              return { symBg: sym.backgroundColor, symColor: sym.color, barBg: bar.backgroundColor };
            }""")
            check('light theme: the pill + bar re-skin (no dark leftovers)',
                  light['symBg'] not in ('rgba(0, 0, 0, 0)',) and light['barBg'] != 'rgb(26, 26, 26)', str(light))
            page.locator('#top-toolbar').screenshot(path=os.path.join(SHOTS, 'topbar-light.png'))
            # light pick state
            page.click('#replay-btn')
            page.wait_for_timeout(200)
            page.mouse.move(520, 400)
            page.wait_for_timeout(120)
            page.mouse.move(540, 405)
            page.wait_for_timeout(300)
            page.locator('#charts-area').screenshot(path=os.path.join(SHOTS, 'pick-armed-light.png'))
            page.keyboard.press('Escape')
            page.wait_for_timeout(200)
            page.evaluate("() => window.__app.Theme.apply('dark')")

            print('\u2014 [5] page errors \u2014')
            check('zero page errors across the whole run', not errors, str(errors[:4]))

            browser.close()
    except Exception as e:
        ok = False
        print('E2E EXCEPTION:', e)
        import traceback; traceback.print_exc()
    finally:
        prov.terminate()
    print('\nRESULT:', 'PASS' if (ok and not FAILS) else f'FAIL ({len(FAILS)}): ' + ' ; '.join(FAILS))
    return 0 if (ok and not FAILS) else 1

if __name__ == '__main__':
    sys.exit(main())
