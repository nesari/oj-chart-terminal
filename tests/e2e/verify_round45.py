#!/usr/bin/env python3
"""ROUND45 verification: menus/flyouts/popups + toolbars adopt TradingView's
current dark surface ladder (toolbars #1a1a1a, menus #212121, hover/toggle
#2a2a2a — all neutral), and active/toggled states (active TF pill, magnet,
favorites star, log/%/free toggles, armed tools, menu keyboard highlight) are
neutral gray/white like TV instead of blue. Light theme must remain EXACTLY
as before. Boots the app from THIS work copy against the demo provider."""
import os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'scripts'))
import e2e_helper_round32 as H
from playwright.sync_api import sync_playwright

OUT = '/home/z/my-project/work/shots45-verify'
os.makedirs(OUT, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS  ' if cond else 'FAIL  ') + name + ('  | ' + str(detail)[:300] if detail != '' else ''))

with sync_playwright() as pw:
    errors = []
    browser, page = H.open_app(pw)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.wait_for_timeout(500)

    # ================= T1: surface ladder (dark, live computed) =================
    surf = page.evaluate("""() => {
      const cs = s => { const el = document.querySelector(s); return el ? getComputedStyle(el).backgroundColor : null; };
      return {
        top: cs('#top-toolbar'), rail: cs('#left-toolbar'), bottom: cs('#bottom-toolbar'),
        body: getComputedStyle(document.body).backgroundColor,
      };
    }""")
    check('T1 dark: top/bottom toolbars + left rail = rgb(26,26,26) (#1a1a1a)',
          surf['top'] == 'rgb(26, 26, 26)' and surf['rail'] == 'rgb(26, 26, 26)'
          and surf['bottom'] == 'rgb(26, 26, 26)', surf)
    check('T1 dark: chart/body stays rgb(15,15,15) below the ladder',
          surf['body'] == 'rgb(15, 15, 15)', surf['body'])

    # ---- popup (tz menu) bg = #212121 ----
    page.click('#tz-btn')
    page.wait_for_selector('.popup', timeout=5000)
    page.wait_for_timeout(250)
    pop = page.evaluate("() => getComputedStyle(document.querySelector('.popup')).backgroundColor")
    check('T2 dark: popup menu bg = rgb(33,33,33) (#212121)', pop == 'rgb(33, 33, 33)', pop)
    hl = page.evaluate("""() => {
      const it = document.querySelector('.popup .pu-item');
      it.classList.add('hl');
      const c = getComputedStyle(it).backgroundColor;
      it.classList.remove('hl');
      return c;
    }""")
    check('T2 dark: popup highlighted row = rgb(42,42,42) (neutral, was blue)',
          hl == 'rgb(42, 42, 42)', hl)
    page.evaluate("() => { const b=document.querySelector('#tz-btn'); if(b) b.click(); }")
    page.wait_for_timeout(200)

    # ---- flyout bg = #212121 ----
    page.evaluate("() => document.querySelector('#left-toolbar .lt-btn[data-group=\"lines\"]').click()")
    page.wait_for_selector('.lt-flyout', timeout=5000)
    page.wait_for_timeout(250)
    fly = page.evaluate("() => getComputedStyle(document.querySelector('.lt-flyout')).backgroundColor")
    check('T3 dark: tool flyout bg = rgb(33,33,33) (#212121)', fly == 'rgb(33, 33, 33)', fly)
    page.evaluate("() => { const b = document.querySelector('#left-toolbar .lt-btn[data-group]'); if (b) b.click(); }")
    page.wait_for_timeout(200)

    # ================= T4: active states neutral (dark) =================
    tf = page.evaluate("""() => {
      const A = window.__app;
      if (A.App.activePane && A.Manager.setTf) A.Manager.setTf(A.App.activePane, 'M15');
      if (A.Toolbar.refreshActive) A.Toolbar.refreshActive();
      const b = document.querySelector('#tf-fav-bar .tb-btn.active');
      if (!b) return null;
      const cs = getComputedStyle(b);
      return { bg: cs.backgroundColor, color: cs.color, label: b.textContent.trim() };
    }""")
    check('T4 dark: active TF pill = gray #2a2a2a + white text (was blue)',
          tf and tf['bg'] == 'rgb(42, 42, 42)' and tf['color'] == 'rgb(255, 255, 255)', tf)

    mag = page.evaluate("""() => {
      const b = document.querySelector('#left-toolbar .lt-btn[data-util="magnet"]');
      b.click();
      const cs = getComputedStyle(b);
      const out = { cls: b.className, color: cs.color, bg: cs.backgroundColor };
      b.click(); b.click(); // cycle back to off
      return out;
    }""")
    check('T4 dark: magnet ON = white icon, transparent bg (was blue)',
          'on' in mag['cls'] and mag['color'] == 'rgb(255, 255, 255)'
          and mag['bg'] == 'rgba(0, 0, 0, 0)', mag)

    star = page.evaluate("""() => {
      const b = document.querySelector('#favbar-toggle');
      const was = b.classList.contains('on');
      if (!was) b.click();
      const cs = getComputedStyle(b);
      const out = { color: cs.color, bg: cs.backgroundColor };
      if (!was) b.click();
      return out;
    }""")
    check('T4 dark: favorites star toggle ON = white icon (was blue)',
          star['color'] == 'rgb(255, 255, 255)' and star['bg'] == 'rgba(0, 0, 0, 0)', star)

    bt = page.evaluate("""() => {
      const b = document.querySelector('#scale-log-btn');
      b.click();
      const cs = getComputedStyle(b);
      const out = { cls: b.className, color: cs.color, bg: cs.backgroundColor };
      b.click();
      return out;
    }""")
    check('T4 dark: bottom toggle (log) ON = white text on #2a2a2a (was blue)',
          'on' in bt['cls'] and bt['color'] == 'rgb(255, 255, 255)'
          and bt['bg'] == 'rgb(42, 42, 42)', bt)

    page.screenshot(path=os.path.join(OUT, 'dark-tv-surfaces.png'))

    # ================= T5: light theme EXACTLY as before =================
    page.evaluate("window.__app.Theme.apply('light')")
    page.wait_for_timeout(400)
    lt = page.evaluate("""() => {
      const A = window.__app;
      if (A.App.activePane && A.Manager.setTf) A.Manager.setTf(A.App.activePane, 'M15');
      if (A.Toolbar.refreshActive) A.Toolbar.refreshActive();
      const cs = s => { const el = document.querySelector(s); return el ? getComputedStyle(el).backgroundColor : null; };
      const tb = document.querySelector('#tf-fav-bar .tb-btn.active');
      const bt = document.querySelector('#scale-log-btn'); bt.click();
      const btcs = getComputedStyle(bt);
      const m = document.querySelector('#left-toolbar .lt-btn[data-util="magnet"]'); m.click();
      const mcs = getComputedStyle(m);
      const out = {
        popup: null, tfBg: tb ? getComputedStyle(tb).backgroundColor : null,
        btColor: btcs.color, btBg: btcs.backgroundColor,
        magnetColor: mcs.color,
        top: cs('#top-toolbar'),
      };
      bt.click(); m.click(); m.click();
      return out;
    }""")
    page.click('#tz-btn'); page.wait_for_selector('.popup', timeout=5000); page.wait_for_timeout(200)
    lt['popup'] = page.evaluate("() => getComputedStyle(document.querySelector('.popup')).backgroundColor")
    page.evaluate("() => { const b=document.querySelector('#tz-btn'); if(b) b.click(); }")
    check('T5 light: popup bg unchanged rgb(240,243,250)', lt['popup'] == 'rgb(240, 243, 250)', lt['popup'])
    check('T5 light: active TF pill still blue tint rgba(41,98,255,.14)',
          lt['tfBg'] == 'rgba(41, 98, 255, 0.14)', lt['tfBg'])
    check('T5 light: bottom toggle ON still blue rgba(41,98,255,.12)+blue text',
          lt['btBg'] == 'rgba(41, 98, 255, 0.12)' and lt['btColor'] == 'rgb(41, 98, 255)',
          (lt['btBg'], lt['btColor']))
    check('T5 light: magnet ON still blue icon', lt['magnetColor'] == 'rgb(41, 98, 255)', lt['magnetColor'])
    check('T5 light: top toolbar unchanged rgb(240,243,250)', lt['top'] == 'rgb(240, 243, 250)', lt['top'])
    page.evaluate("window.__app.Theme.apply('dark')")
    page.wait_for_timeout(300)

    # ================= T6: static audit =================
    def rd(p):
        with open(os.path.join(ROOT, p), encoding='utf-8') as f: return f.read()
    css = rd('src/renderer/css/app.css')
    ok_vars = all(v in css for v in ['--panel: #1a1a1a;', '--panel2: #2a2a2a;', '--menu: #212121;',
                                     '--border: #2e2e2e;', '--border2: #3d3d3d;', '--pane-sep: #4a4a4a;',
                                     '--menu: #f0f3fa']) and '--panel: #1e222d' not in css
    check('T6 dark :root ladder + light --menu override present', ok_vars)
    keep_selectors = ('.acc-chip.active', '.acc-tag.mt5', '.provider-card.selected', '.pane-root.active-pane',
                      '.pane-root.maximized', '.pl-spin', '.obj-row.sel', '.hw-retry', '.am-item.am-add',
                      '.wl-row.active')
    bad = []
    for m in re.finditer(r'([^{}]+)\{[^{}]*rgba\(41, ?98, ?255[^{}]*\}', css):
        sel = m.group(1).strip().splitlines()[-1].strip()
        if sel.startswith('body.theme-light'):
            continue
        if any(k in sel for k in keep_selectors):
            continue
        bad.append(sel[:110])
    check('T6 every remaining blue-rgba rule is light-scoped or a known non-toolbar accent',
          not bad, bad)
    ok_surf = (css.count('background: var(--menu)') == 3
               and css.count('background: var(--panel); /* round 45') == 2
               and 'background: var(--panel); border-right: 1px solid var(--border); /* round 45: TV rail is elevated */' in css)
    check('T6 flyout/popup/dialog ride --menu; toolbars ride --panel', ok_surf,
          (css.count('background: var(--menu)'), css.count('background: var(--panel); /* round 45')))

    check('T7 zero page errors', not errors, errors[:3])
    browser.close()

passed = sum(1 for _, ok, _ in results if ok)
print(f"\n{passed}/{len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
