#!/usr/bin/env python3
"""BUG-014 verification: Template Default = full factory reset (active-theme
colors), persists across reload, named templates + Cancel untouched."""
import sys, time, threading, http.server, functools, json, subprocess, signal, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'src')
PORT = 8919
PROV = subprocess.Popen(['python3', os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'provider', 'demo.py')],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
time.sleep(1.5)

def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start()

results = []
def check(name, ok, info=''):
    results.append((name, ok, info))
    print(('PASS' if ok else 'FAIL'), '-', name, ('| ' + str(info) if info else ''))

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    warns = []
    pg.on('console', lambda m: warns.append(m.text) if 'BUG-014 guard' in m.text else None)
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1000)
    pg.click('#card-demo'); pg.click('#login-connect')
    pg.wait_for_timeout(5000)

    # 1) customize several keys across groups (via Settings.set = the dialog write path)
    pg.evaluate("""() => {
      Settings.set('hGrid', false, { noApply: true }); Settings.applyAll();
      Settings.set('bg1', '#123456', { noApply: true }); Settings.applyAll();
      Settings.set('countdown', false, { noApply: true }); Settings.applyAll();
    }""")
    pg.wait_for_timeout(300)
    cust = pg.evaluate("() => ({ hGrid: Settings.conf.hGrid, bg1: Settings.conf.bg1, cd: Settings.conf.countdown })")
    check('1 customize applied', cust['hGrid'] == False and cust['bg1'] == '#123456' and cust['cd'] == False, cust)

    # 2) select Default in the template dropdown (the actual dialog path)
    dflt = pg.evaluate("""() => new Promise((res) => {
      Settings.open();
      setTimeout(() => {
        const sel = document.querySelector('#settings-dialog .st-tpl select');
        if (!sel) { res({ nosel: true }); return; }
        sel.value = '__default';
        sel.dispatchEvent(new Event('change'));
        setTimeout(() => {
          const host = window.__app.App.activePane.host;
          res({
            hGrid: Settings.conf.hGrid, bg1: Settings.conf.bg1, cd: Settings.conf.countdown,
            hostBg: getComputedStyle(host).backgroundColor,
            persisted: JSON.parse(localStorage.getItem('mt5_settings')),
            stillOpen: !!document.querySelector('#settings-dialog'),
          });
        }, 400);
      }, 300);
    })""")
    check('2 Default resets ALL groups (toggles, background, countdown)',
          dflt['hGrid'] == True and dflt['cd'] == True and dflt['bg1'] != '#123456', dflt)
    check('3 reset persisted to mt5_settings (survives Ok/reload)',
          dflt['persisted']['hGrid'] == True and dflt['persisted']['bg1'] == dflt['bg1'], dflt['persisted']['bg1'])
    check('4 rendered chart reflects the reset immediately', dflt['hostBg'] == 'rgb(19, 23, 34)', dflt['hostBg'])

    # 5) light theme: Default -> LIGHT factory colors
    pg.evaluate("() => window.__app.Theme.apply('light')")
    pg.wait_for_timeout(400)
    light = pg.evaluate("""() => new Promise((res) => {
      Settings.set('bg1', '#123456', { noApply: true }); Settings.applyAll();
      Settings.open();
      setTimeout(() => {
        const sel = document.querySelector('#settings-dialog .st-tpl select');
        sel.value = '__default'; sel.dispatchEvent(new Event('change'));
        setTimeout(() => {
          res({ bg1: Settings.conf.bg1, hostBg: getComputedStyle(window.__app.App.activePane.host).backgroundColor });
        }, 400);
      }, 300);
    })""")
    check('5 light theme: Default restores LIGHT factory colors',
          light['bg1'] == '#ffffff' and light['hostBg'] == 'rgb(255, 255, 255)', light)

    # 6) named template save/apply unaffected + Cancel semantics
    pg.evaluate("() => window.__app.Theme.apply('dark')")
    pg.wait_for_timeout(300)
    named = pg.evaluate("""() => new Promise((res) => {
      // save current (default) as MyT under a custom tweak
      Settings.set('hGrid', false, { noApply: true }); Settings.applyAll();
      const tpls = JSON.parse(localStorage.getItem('mt5_st_tpl') || '{}');
      tpls['MyT'] = JSON.parse(JSON.stringify(Settings.conf));
      localStorage.setItem('mt5_st_tpl', JSON.stringify(tpls));
      // reset to Default
      Settings.open();
      setTimeout(() => {
        let sel = document.querySelector('#settings-dialog .st-tpl select');
        sel.value = '__default'; sel.dispatchEvent(new Event('change'));
        setTimeout(() => {
          const afterDefault = Settings.conf.hGrid;
          // now apply MyT
          sel = document.querySelector('#settings-dialog .st-tpl select');
          sel.value = 'MyT'; sel.dispatchEvent(new Event('change'));
          setTimeout(() => {
            const afterTpl = Settings.conf.hGrid;
            // Cancel must restore the pre-dialog snapshot
            document.querySelector('#settings-dialog .st-cancel').click();
            setTimeout(() => {
              res({ afterDefault, afterTpl, afterCancel: Settings.conf.hGrid });
            }, 250);
          }, 350);
        }, 350);
      }, 300);
    })""")
    check('6 named template still applies; Default reset worked before it',
          named['afterDefault'] == True and named['afterTpl'] == False, named)
    check('7 Cancel commits nothing (snapshot semantics intact)', named['afterCancel'] == False, named)

    # 8) reload persistence: whatever the Cancel restored (hGrid=false) must persist
    pre = pg.evaluate("() => Settings.conf.hGrid")
    pg.reload()
    pg.wait_for_timeout(4000)
    rel = pg.evaluate("() => Settings.conf.hGrid")
    check('8 reload keeps the last-committed state (persistence works)', rel == pre, f'pre={pre} post={rel}')
    check('9 full-coverage guard silent for dialog keys', len(warns) == 0, warns[:2])
    check('10 no page errors', len(errs) == 0, '; '.join(errs[:3]))
    b.close()

try: os.killpg(os.getpgid(PROV.pid), signal.SIGTERM)
except Exception: pass

fails = [r for r in results if not r[1]]
print(f"\n==== {len(results) - len(fails)}/{len(results)} passed ====")
sys.exit(1 if fails else 0)
