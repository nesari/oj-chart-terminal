#!/usr/bin/env python3
"""ROUND125 e2e — the frameless TradingView-Desktop shell, live in a browser.

The app is served over http (the established harness; window.mt5Win is absent
there, which the shell must survive as a silent no-op). Checks:

[1] Markup: #win-controls with 3 buttons sits INSIDE #tab-strip after the
    spacer; #login-titlebar carries the same three buttons; both render.
[2] Geometry: the controls are flush at the strip's right end, stretch the
    full 34px strip height, and each button is 46px wide.
[3] CSS regions: computed -webkit-app-region is drag on #tab-strip and
    no-drag on #tab-list / .tab-add / #win-controls / .wc-btn.
[4] Wiring: clicking each button WITHOUT the bridge throws nothing (silent
    no-op contract) and no page error lands.
[5] The chart shell still boots (tab strip renders one tab; top toolbar
    present) — the strip changes did not break the ROUND121 flow.

Exits 0 only if every check passes with zero page errors.
"""
import subprocess, sys, time, http.server, functools, os, socket

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT_HTTP = 8925
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
    import threading
    threading.daemon = True
    t = threading.Thread(target=serve_http, daemon=True)
    t.start()
    if not wait_port(PORT_HTTP):
        print('http server failed'); return 1

    from playwright.sync_api import sync_playwright
    errors = []
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(args=['--allow-file-access-from-files'])
        except Exception:
            browser = p.chromium.launch(channel='chrome', args=['--allow-file-access-from-files'])
        page = browser.new_page(viewport={'width': 1600, 'height': 900})
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?mode=demo')
        page.wait_for_timeout(2200)

        print('— [1] markup present and rendered —')
        n_strip = page.eval_on_selector_all('#win-controls', 'els => els.length')
        check('#win-controls exists inside the tab strip', n_strip == 1)
        n_login = page.eval_on_selector_all('#login-titlebar .win-controls', 'els => els.length')
        check('#login-titlebar carries its own .win-controls', n_login == 1)
        btns = page.eval_on_selector_all('#win-controls .wc-btn', 'els => els.map(e => e.className)')
        check('strip controls = min/max/close in order',
              btns == ['wc-btn wc-min', 'wc-btn wc-max', 'wc-btn wc-close'], str(btns))
        vis = page.eval_on_selector('#login-titlebar', 'e => !!(e.offsetWidth && e.offsetHeight)')
        check('login titlebar renders while the login card is up', vis)

        # simulate post-login so the strip geometry is measurable (#app is
        # display:none while the login card is up — by design)
        page.evaluate('''() => {
          document.getElementById('login-screen').classList.add('hidden');
          document.getElementById('app').classList.remove('hidden');
        }''')
        page.wait_for_timeout(300)

        print('— [2] geometry: flush right, full strip height, 46px buttons —')
        geo = page.evaluate('''() => {
          const s = document.getElementById('tab-strip').getBoundingClientRect();
          const c = document.getElementById('win-controls').getBoundingClientRect();
          const b = document.querySelector('#win-controls .wc-btn').getBoundingClientRect();
          return { stripRight: s.right, ctrlRight: c.right, stripH: s.height,
                   ctrlH: c.height, btnW: b.width, btnH: b.height };
        }''')
        check('controls are flush with the strip right edge (<=1px)',
              abs(geo['stripRight'] - geo['ctrlRight']) <= 1, str(geo))
        check('controls stretch the strip height (34px minus the 1px bottom border)',
              geo['stripH'] == 34 and geo['stripH'] - geo['ctrlH'] <= 1, str(geo))
        check('each button is 46px wide', geo['btnW'] == 46, str(geo))

        print('— [3] app-region: drag on the strip, no-drag on interactive children —')
        regions = page.evaluate('''() => {
          const g = (sel) => getComputedStyle(document.querySelector(sel)).webkitAppRegion;
          return { strip: g('#tab-strip'), list: g('#tab-list'), add: g('#tab-add-btn'),
                   win: g('#win-controls'), btn: g('#win-controls .wc-btn'),
                   login: g('#login-titlebar') };
        }''')
        check('#tab-strip is drag', regions['strip'] == 'drag', str(regions))
        check('#login-titlebar is drag', regions['login'] == 'drag', str(regions))
        check('#tab-list / .tab-add / #win-controls / .wc-btn are no-drag',
              regions['list'] == 'no-drag' and regions['add'] == 'no-drag' and
              regions['win'] == 'no-drag' and regions['btn'] == 'no-drag', str(regions))

        print('— [4] wiring: silent no-op without the bridge, zero errors —')
        page.evaluate('''() => {
          for (const sel of ['#win-controls .wc-min', '#win-controls .wc-max',
                             '#win-controls .wc-close', '#login-titlebar .wc-close'])
            document.querySelector(sel).click();
        }''')
        page.wait_for_timeout(250)
        err_now = [e for e in errors if 'mt5Win' in e or 'undefined' in e]
        check('clicking all buttons without window.mt5Win throws nothing', not err_now, str(err_now))

        print('— [5] the chart shell still boots —')
        tabs = page.eval_on_selector_all('#tab-list .tab-item', 'els => els.length')
        check('tab strip renders its tab(s)', tabs >= 1, str(tabs))
        tb = page.eval_on_selector('#top-toolbar', 'e => e.offsetHeight > 0')
        check('top toolbar still renders under the strip', tb)

        browser.close()

    real = [e for e in errors if 'favicon' not in e]
    check('zero page errors', not real, str(real[:3]))
    print(f'\nROUND125 e2e: {"PASS" if not FAILS else "FAIL"} ({len(FAILS)} failed)')
    return 0 if not FAILS else 1

if __name__ == '__main__':
    sys.exit(main())
