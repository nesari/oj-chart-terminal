#!/usr/bin/env python3
"""ROUND56 verify — in-app broker-servers popup in the bottom toolbar.

The login-screen scan section (ROUND55) must stay untouched; the new part is
a small bottom-bar button next to the timezone that opens the same MT5-style
server list in-app: measured pings, Network Rescan, one-click switch that
really reconnects (demo: saved data center; MT5: account re-pointed, bridge
restarted by the boot auto-login path).

NOTE: the web test shell has no electronAPI, so after the switch-reload the
app cannot auto-login there — the flow asserts the login screen + persisted
pick, then reconnects manually (the Electron app auto-logins via ACC).
"""
import os, re, subprocess, sys, time, json

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
os.chdir(ROOT)

PASS, FAIL = [], []
def ok(name, cond, extra=''):
    (PASS if cond else FAIL).append(name)
    print(('  OK  ' if cond else ' FAIL ') + name + (('  -> ' + str(extra)) if (extra and not cond) else ''))

# ---------- static ----------
def read(p):
    with open(p, encoding='utf-8') as f: return f.read()

html = read('src/renderer/index.html')
tb = read('src/renderer/js/chart/toolbar.js')
lj = read('src/renderer/js/ui/login.js')
css = read('src/renderer/css/app.css')
pkg = json.loads(read('package.json'))

ok('version 1.9.7+ (pin updated r57)', pkg.get('version') in ('1.9.7', '1.9.8', '1.9.9', '1.9.10', '1.9.11', '1.9.12'), pkg.get('version'))
m = re.search(r'<button class="bt-btn bt-text" id="srv-btn".*?</button>\s*<div class="tb-sep"></div>\s*<span id="tz-clock"', html, re.S)
ok('srv-btn in bottom toolbar, beside tz-clock', bool(m))
ok('srv-btn markup (icon + label spans)', 'id="srv-ic"' in html and 'id="srv-label"' in html)
ok('toolbar: srv-btn wiring block', 'srv-btn' in tb and "openSrvMenu(r.right - 250, r.top - 8)" in tb)
ok('toolbar: updateSrvLabel called at init', 'Toolbar.updateSrvLabel();' in tb)
ok('toolbar: openSrvMenu defined', 'Toolbar.openSrvMenu = function' in tb)
ok('toolbar: scan protocol servers+servers_ping', "'servers', req_id: 'sa'" in tb and "'servers_ping', name: s.name, req_id: rid" in tb)
ok('toolbar: ascending sort after scan', "rows.sort((a, b) => (a.ping == null ? 9e9 : a.ping) - (b.ping == null ? 9e9 : b.ping));" in tb)
ok('toolbar: switchSrv demo -> localStorage dc pick', "localStorage.setItem('mt5_dc_demo', name)" in tb)
ok('toolbar: switchSrv mt5 -> event to login.js', "new CustomEvent('mt5-switch-server', { detail: name })" in tb)
ok('toolbar: currentServer reads acc label / demo pick', 'Toolbar.currentServer = function' in tb and "split(' \\u00b7 ')[1]" in tb)
ok('toolbar: async render re-fits popup above bar', 'const refit = () => { try { U.fitPopup(p, y, y); } catch (e) {} };' in tb and 'render(rows);\n        refit();' in tb)
ok('toolbar: reuse row/bars/tier styles', 'SRV_TIER' in tb and 'SRV_BARS' in tb and "U.el('span', 'srv-ic tier'" in tb)
ok('login: switchServer defined', 'async function switchServer(name)' in lj)
ok('login: switchServer re-points account server', "a.server = name;" in lj and "ACC.last = a.id;" in lj)
ok('login: mt5-switch-server listener', "addEventListener('mt5-switch-server'" in lj)
ok('login: not-remembered fallback prefills Server field', "sessionStorage.getItem('mt5_srv_switch')" in lj and "sessionStorage.setItem('mt5_srv_switch', name)" in lj)
ok('login: switchServer exported', 'const LoginUI = { init, bootApp, switchServer };' in lj)
ok('login: ROUND55 scan section untouched', all(s in lj for s in ["function scanServers(mode, opts)", "function renderServers(mode, rows)", "function applyServerScan()", "mt5_dc_demo"]))
ok('html: ROUND55 login scan section still present', 'id="srv-scan"' in html and 'id="srv-rescan"' in html and 'id="srv-list"' in html)
ok('css: .srv-rescan shares #srv-rescan styles', '#srv-rescan, .srv-rescan {' in css and '#srv-rescan:hover, .srv-rescan:hover' in css)
ok('css: popup list container + label ellipsis', '.srv-poplist' in css and '#srv-label' in css)
ok('css: light theme srv rows kept', '.theme-light .srv-row:hover' in css)
pc = read('provider/provider_common.py'); dm = read('provider/demo.py')
ok('provider: servers RPC intact', "elif t == 'servers':" in pc and "elif t == 'servers_ping':" in pc)
ok('provider: demo server list intact', 'DEMO_SERVERS' in dm and 'server_entries' in dm and 'server_ping_ms' in dm)

# ---------- syntax check (node) ----------
def node_check(path):
    try:
        r = subprocess.run(['node', '--input-type=module', '--check', '-'],
                           input=read(path), capture_output=True, text=True, timeout=30)
        return r.returncode == 0, (r.stderr or '').strip().splitlines()[:3]
    except FileNotFoundError:
        return True, 'node missing'

print('== syntax (node esm parse) ==')
s = node_check('src/renderer/js/chart/toolbar.js')
ok('syntax: toolbar.js parses as ESM', s[0], s[1])
s2 = node_check('src/renderer/js/ui/login.js')
ok('syntax: login.js parses as ESM', s2[0], s2[1])

# ---------- e2e (sync playwright, same harness as r55) ----------
def e2e():
    from playwright.sync_api import sync_playwright
    from e2e_helper_round32 import open_app

    subprocess.run(['pkill', '-f', 'provider/demo.py'], capture_output=True)
    subprocess.run(['pkill', '-f', 'provider/mt5.py'], capture_output=True)
    time.sleep(0.8)
    prov = subprocess.Popen([sys.executable, 'provider/demo.py'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            cwd=ROOT, start_new_session=True)
    time.sleep(2.2)

    with sync_playwright() as pw:
        # boot WITHOUT the shared helper's add_init_script("localStorage.clear()"):
        # that init script re-runs on EVERY reload and would wipe the persisted
        # pick mid-test. Clear once manually instead, then boot the demo app.
        from e2e_helper_round32 import BASE, poll
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={'width': 1500, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(BASE)
        page.evaluate("try { localStorage.clear(); } catch (e) {}")
        page.reload()
        page.wait_for_selector('#login-screen', timeout=10000)
        page.click('#card-demo')
        page.click('#login-connect')
        page.wait_for_selector('#app:not(.hidden)', timeout=20000)
        poll(page, "window.__app ? window.__app.App.panes.length : 0", 20000, lambda v: v >= 1)
        poll(page, "(window.__app.App.panes[0].bars || []).length", 30000, lambda v: v > 100)

        P = 'body > .popup'
        rows_sel = P + ' .srv-row'
        def ping_txts():
            return [(rows.nth(i).locator('.srv-ping').text_content() or '').strip()
                    for i in range(rows.count())]
        def ms_list(txts):
            return [float(re.sub(r'[^0-9.]', '', t)) for t in txts if re.sub(r'[^0-9.]', '', t)]

        # bottom bar: button exists, sits left of the timezone clock
        btn = page.locator('#srv-btn')
        ok('e2e: #srv-btn visible in bottom bar', btn.is_visible())
        box = btn.bounding_box(); tzbox = page.locator('#tz-clock').bounding_box()
        ok('e2e: srv-btn left of tz-clock, same bar',
           box and tzbox and abs((box['y'] + box['height'] / 2) - (tzbox['y'] + tzbox['height'] / 2)) < 3
           and box['x'] + box['width'] <= tzbox['x'] + 2, (box, tzbox))
        lab = (page.locator('#srv-label').text_content() or '').strip()
        ok('e2e: label shows current server (Auto or pick)', lab in ('Auto', 'UK01 AS', 'DE01 DC', 'DE02 DC', 'DE03 DC', 'FI01 DC', 'AE01 DC'), lab)
        ok('e2e: icon svg rendered', page.locator('#srv-ic svg').count() == 1)

        # popup: title, 6 rows, ascending pings, current selected
        btn.click(); page.wait_for_timeout(250)
        ok('e2e: popup opened', page.locator(P).is_visible())
        title = (page.locator(P + ' .pu-title').first.text_content() or '').strip()
        ok('e2e: popup title "Broker servers"', title == 'Broker servers', title)
        page.wait_for_timeout(2600)  # list + 6 pings
        rows = page.locator(rows_sel)
        n = rows.count()
        ok('e2e: 6 server rows', n == 6, n)
        names = [(rows.nth(i).locator('.srv-name').text_content() or '').strip() for i in range(n)]
        ms = ms_list(ping_txts())
        ok('e2e: pings ascending (fastest first)', ms == sorted(ms) and len(ms) == 6, ms)
        ok('e2e: every row shows a measured ping (no dashes)', all('ms' in t for t in ping_txts()), ping_txts())
        ok('e2e: bars icon per row', page.locator(rows_sel + ' .srv-bars').count() == 6)
        sel = ((page.locator(rows_sel + '.selected .srv-name').first.text_content()) or '').strip()
        ok('e2e: fastest row selected when no pick (Auto)', sel == names[0], (sel, lab, names[0]))

        # rescan re-measures, still ascending, selection kept
        page.locator(P + ' .srv-rescan').click()
        page.wait_for_timeout(2600)
        ms2 = ms_list(ping_txts())
        ok('e2e: rescan re-measured (ascending, 6)', len(ms2) == 6 and ms2 == sorted(ms2), ms2)
        ok('e2e: rescan values actually re-measured', ms2 != ms, (ms, ms2))
        sel2 = ((page.locator(rows_sel + '.selected .srv-name').first.text_content()) or '').strip()
        ok('e2e: selection kept after rescan', sel2 == sel, (sel, sel2))

        # switch -> toast, reload, pick persisted; web shell lands on login screen
        target = 'AE01 DC' if sel != 'AE01 DC' else 'FI01 DC'
        rows.nth(names.index(target)).click()
        page.wait_for_timeout(400)
        ok('e2e: switch toast shown', ('Switching to ' + target) in (page.locator('#toasts').text_content() or ''))
        page.wait_for_timeout(1500)
        ok('e2e: reload happened (back at login in web shell)', page.locator('#login-screen').is_visible())
        pick = page.evaluate("localStorage.getItem('mt5_dc_demo')")
        ok('e2e: pick persisted to localStorage', pick == target, pick)
        page.click('#card-demo'); page.click('#login-connect')
        page.wait_for_selector('#app:not(.hidden)', timeout=20000)
        page.wait_for_timeout(1500)
        lab2 = (page.locator('#srv-label').text_content() or '').strip()
        ok('e2e: bottom-bar label = new server after reconnect', lab2 == target, lab2)
        ok('e2e: app fully restored (bar + canvas)', page.locator('#bottom-toolbar').is_visible() and page.locator('canvas').count() >= 1)

        # popup again: new server selected; clicking the SAME server just closes
        page.locator('#srv-btn').click(); page.wait_for_timeout(2600)
        sel3 = ((page.locator(rows_sel + '.selected .srv-name').first.text_content()) or '').strip()
        ok('e2e: popup shows new server selected', sel3 == target, (sel3, target))
        ok('e2e: exactly one selected row', page.locator(rows_sel + '.selected').count() == 1)
        page.locator(rows_sel + '.selected').first.click()
        page.wait_for_timeout(700)
        ok('e2e: clicking current server just closes (no reload)',
           page.locator('#bottom-toolbar').is_visible() and page.evaluate("localStorage.getItem('mt5_dc_demo')") == target)

        # light theme spot (scan is async — wait for the rows to render)
        page.evaluate("window.__app && __app.Theme.apply('light')")
        page.locator('#srv-btn').click()
        page.wait_for_selector(rows_sel, timeout=8000)
        ok('e2e: light theme popup rows visible', page.locator(rows_sel).first.is_visible())
        page.evaluate("window.__app && __app.Theme.apply('dark')")
        page.wait_for_timeout(200)

        # MT5 fallback: event -> not-remembered session -> prefilled Server field
        page.evaluate("sessionStorage.setItem('mt5Logout','1')")
        page.evaluate("window.dispatchEvent(new CustomEvent('mt5-switch-server', { detail: 'DE02 DC' }))")
        page.wait_for_timeout(1500)
        srvval = page.evaluate("document.getElementById('mt5-server') ? document.getElementById('mt5-server').value : ''")
        ok('e2e: mt5 event -> login screen Server field prefilled', srvval == 'DE02 DC', srvval)
        page.evaluate("sessionStorage.removeItem('mt5_srv_switch')")

        # r48 separators untouched + zero page errors
        # the new divider must be IDENTICAL to the pre-existing bottom-bar one
        seps = page.evaluate("[...document.querySelectorAll('#bottom-toolbar .tb-sep')].map(s => { const c = getComputedStyle(s); return c.width + '|' + c.height + '|' + c.backgroundColor; })")
        ok('e2e: new tb-sep identical to existing bar separator', len(seps) == 2 and seps[0] == seps[1], seps)
        ok('e2e: zero page errors', not errors, errors[:3])

        browser.close()

if __name__ == '__main__':
    print('== e2e ==')
    try:
        e2e()
    except Exception as e:
        ok('e2e harness completed', False, f'{type(e).__name__}: {e}')
    print(f'\nRESULT: {len(PASS)}/{len(PASS)+len(FAIL)}')
    if FAIL:
        print('FAILED:', *FAIL, sep='\n  - ')
        sys.exit(1)
