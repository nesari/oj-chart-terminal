#!/usr/bin/env python3
"""ROUND44 verification: dark-mode background family now matches TradingView's
current dark palette (#0f0f0f, was the legacy navy #131722).

Covers: fresh-boot body/chart background, the LEGACY migration for existing
users whose saved settings still hold #131722/#0c0e15, preservation of
deliberate user picks, gradient mode stops, static source audit, light-theme
untouchedness, screenshots of both themes, zero page errors.
Boots the app from THIS work copy against the demo provider."""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
import e2e_helper_round32 as H
from playwright.sync_api import sync_playwright

OUT = '/home/z/my-project/work/shots44'
os.makedirs(OUT, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  | ' + str(detail)[:300] if detail != '' else ''))

def login(page):
    page.wait_for_selector('#login-screen', timeout=10000)
    page.click('#card-demo')
    page.click('#login-connect')
    page.wait_for_selector('#app:not(.hidden)', timeout=20000)
    H.poll(page, "window.__app ? window.__app.App.panes.length : 0", 20000, lambda v: v >= 1)
    H.poll(page, "(window.__app.App.panes[0].bars || []).length", 30000, lambda v: v > 100)

def boot_state(page):
    return page.evaluate("""() => {
      const conf = window.__app.Settings.conf;
      const host = window.__app.App.panes[0].host;
      return {
        bodyBg: getComputedStyle(document.body).backgroundColor,
        hostBg: getComputedStyle(host).backgroundColor,
        hostStyle: host.style.background,
        savedBg1: JSON.parse(localStorage.getItem('mt5_settings') || '{}').bg1,
        savedBg2: JSON.parse(localStorage.getItem('mt5_settings') || '{}').bg2,
        confBg1: conf.bg1, confBg2: conf.bg2,
      };
    }""")

with sync_playwright() as pw:
    # ============ A: FRESH BOOT (storage cleared by helper's init script) ============
    errors = []
    browser, page = H.open_app(pw)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.wait_for_timeout(500)

    st = boot_state(page)
    check('T1 fresh boot: body background is rgb(15, 15, 15)',
          st['bodyBg'] == 'rgb(15, 15, 15)', st['bodyBg'])
    check('T2 fresh boot: chart host background is rgb(15, 15, 15)',
          st['hostBg'] == 'rgb(15, 15, 15)', st['hostBg'])
    check('T3 fresh boot: settings bg1/bg2 = #0f0f0f / #0a0a0a (solid)',
          st['confBg1'] == '#0f0f0f' and st['confBg2'] == '#0a0a0a', st)

    # ============ T4: gradient mode uses the new stops ============
    g = page.evaluate("""() => {
      const A = window.__app;
      A.Settings.conf.bgMode = 'gradient';
      A.Settings.applyAll();
      const host = A.App.panes[0].host;
      const out = { style: host.style.background, computed: getComputedStyle(host).backgroundImage };
      A.Settings.conf.bgMode = 'solid';
      A.Settings.applyAll();
      return out;
    }""")
    check('T4 gradient mode: stops rgb(15,15,15) -> rgb(10,10,10)',
          'rgb(15, 15, 15) 0%' in g['computed'] and 'rgb(10, 10, 10) 100%' in g['computed'],
          g['computed'])

    # ============ T5: static audit of every changed spot ============
    def rd(p):
        with open(os.path.join(ROOT, p), encoding='utf-8') as f: return f.read()
    css, them, sett, mgr = (rd('src/renderer/css/app.css'), rd('src/renderer/js/core/theme.js'),
                            rd('src/renderer/js/chart/settings.js'), rd('src/renderer/js/chart/manager.js'))
    navy = re.findall(r'rgba\(19, ?23, ?34[^)]*\)', css)
    ok_css = ('--bg: #0f0f0f;' in css
              and '#1e222d 0%, #0f0f0f 60%' in css and '#1e222d 0%, #0f0f0f 78%' in css
              and 'rgba(15,15,15,.42)' in css and 'rgba(15,15,15,.4);' in css
              and '--bg: #131722' not in css
              and navy == ['rgba(19,23,34,.18)'])  # ONLY the light-theme dialog shadow remains
    ok_theme = ("bg1: '#0f0f0f', bg2: '#0a0a0a'" in them
                and "LEGACY_DARK_DEFAULTS = { bg1: '#131722', bg2: '#0c0e15' }" in them
                and "this.mode === 'dark' && legacy && cur === legacy" in them)
    ok_sett = "bgMode: 'solid', bg1: '#0f0f0f', bg2: '#0a0a0a'" in sett and '#131722' not in sett
    ok_mgr = "dark ? '#0f0f0f' : '#ffffff'" in mgr and "dark ? '#0a0a0a' : '#f0f3fa'" in mgr
    # the only #131722 left in theme.js must be the LEGACY constant + light theme values
    theme_left = [l.strip() for l in them.splitlines() if '#131722' in l or '#0c0e15' in l]
    ok_left = all(('LEGACY' in l) or ('light' in l) or ('scaleText' in l) or ('symLabelColor' in l)
                  or ('chipText' in l) or (l.startswith('text:')) for l in theme_left)
    check('T5 app.css: --bg + login gradients + both rgba scrims switched, no navy surface left', ok_css)
    check('T5 theme.js: new dark defaults + LEGACY migration hook present', ok_theme)
    check('T5 settings.js: factory defaults switched, zero navy left', ok_sett)
    check('T5 manager.js: snapshot fallbacks switched', ok_mgr)
    check('T5 remaining #131722 in theme.js = legacy const / light values only',
          ok_left, theme_left)

    # ============ T6: LIGHT theme untouched ============
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(400)
    lt = boot_state(page)
    check('T6 light theme: body white, chart host white (untouched)',
          lt['bodyBg'] == 'rgb(255, 255, 255)' and lt['hostBg'] == 'rgb(255, 255, 255)',
          (lt['bodyBg'], lt['hostBg']))
    page.evaluate("window.__app.Theme.apply('dark')")
    page.wait_for_timeout(400)
    st2 = boot_state(page)
    check('T6 back to dark: body/chart return to rgb(15, 15, 15)',
          st2['bodyBg'] == 'rgb(15, 15, 15)' and st2['hostBg'] == 'rgb(15, 15, 15)',
          (st2['bodyBg'], st2['hostBg']))

    page.screenshot(path=os.path.join(OUT, 'dark.png'))
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(400)
    page.screenshot(path=os.path.join(OUT, 'light.png'))
    page.evaluate("window.__app.Theme.apply('dark')")
    page.wait_for_timeout(300)
    browser.close()

    # ============ B: LEGACY MIGRATION (saved #131722/#0c0e15 from an old install) ============
    browser2 = pw.chromium.launch(headless=True)
    page2 = browser2.new_page(viewport={'width': 1500, 'height': 900})
    page2.add_init_script("""() => {}""")
    page2.add_init_script(
        "localStorage.setItem('mt5_theme','dark');"
        "localStorage.setItem('mt5_settings', JSON.stringify({bg1:'#131722', bg2:'#0c0e15'}));")
    page2.on('pageerror', lambda e: errors.append('legacy: ' + str(e)))
    page2.goto(H.BASE)
    login(page2)
    page2.wait_for_timeout(500)
    lg = boot_state(page2)
    check('T7 legacy saved #131722/#0c0e15 migrates to #0f0f0f/#0a0a0a and persists',
          lg['confBg1'] == '#0f0f0f' and lg['confBg2'] == '#0a0a0a'
          and lg['savedBg1'] == '#0f0f0f' and lg['savedBg2'] == '#0a0a0a'
          and lg['hostBg'] == 'rgb(15, 15, 15)', lg)
    browser2.close()

    # ============ C: USER PICK PRESERVED (deliberate colour is never touched) ============
    browser3 = pw.chromium.launch(headless=True)
    page3 = browser3.new_page(viewport={'width': 1500, 'height': 900})
    page3.add_init_script(
        "localStorage.setItem('mt5_theme','dark');"
        "localStorage.setItem('mt5_settings', JSON.stringify({bg1:'#123456', bg2:'#0c0e15'}));")
    page3.on('pageerror', lambda e: errors.append('userpick: ' + str(e)))
    page3.goto(H.BASE)
    login(page3)
    page3.wait_for_timeout(500)
    up = boot_state(page3)
    check('T8 deliberate user pick (#123456) is NOT overwritten',
          up['confBg1'] == '#123456' and up['savedBg1'] == '#123456', up)
    # bg2 still holds the old factory value -> migrates
    check('T8 legacy bg2 (#0c0e15) still migrates next to the user pick',
          up['confBg2'] == '#0a0a0a', up['confBg2'])
    browser3.close()

    check('T9 zero page errors across all three boots', not errors, errors[:3])

passed = sum(1 for _, ok, _ in results if ok)
print(f"\n{passed}/{len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
