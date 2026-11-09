#!/usr/bin/env python3
"""ROUND242 e2e — toolbar/dialog overflow fixes on narrow + short windows, live.

  Wide: top cluster fits (no scroll, chevrons hidden).
  Narrow (1000px): top buttons keep their widths (flex:none, never squeezed),
  the cluster scrolls with a visible chevron; bottom buttons never compress,
  tz-clock auto-hides, the bar scrolls instead of clipping.
  Tighter (800px): srv/tz labels hide (icons stay).
  Short (600px height): the chart Settings dialog fits inside the viewport.
  Zero page errors.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8922, 8862
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

def check(name, cond, extra=''):
    print(('  ok ' if cond else '  FAIL ') + name + ((' - ' + str(extra)) if (not cond and extra != '') else ''))
    if not cond:
        FAILS.append(name)

def wait_port(port, timeout=25):
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

WIDE_JS = """() => {
  const q = (s) => document.querySelector(s);
  const left = q('#tb-left');
  return {
    symW: q('#symbol-btn').offsetWidth,
    tfmW: q('#tf-menu-btn').offsetWidth,
    indW: q('#indicators-btn').offsetWidth,
    over: left.scrollWidth - left.clientWidth,
    chevL: q('#tb-scroll-l').classList.contains('hidden'),
    chevR: q('#tb-scroll-r').classList.contains('hidden'),
  };
}"""

NARROW_JS = """() => {
  const q = (s) => document.querySelector(s);
  const cs = (el) => getComputedStyle(el);
  const left = q('#tb-left');
  const btns = [...document.querySelectorAll('#bottom-toolbar .bt-btn')];
  return {
    symW: q('#symbol-btn').offsetWidth,
    tfmW: q('#tf-menu-btn').offsetWidth,
    indW: q('#indicators-btn').offsetWidth,
    over: left.scrollWidth - left.clientWidth,
    chevL: q('#tb-scroll-l').classList.contains('hidden'),
    chevR: q('#tb-scroll-r').classList.contains('hidden'),
    btShrink: btns.map((b) => cs(b).flexShrink),
    btOverX: cs(q('#bottom-toolbar')).overflowX,
    btClip: q('#bottom-toolbar').scrollWidth - q('#bottom-toolbar').clientWidth,
    clockHidden: cs(q('#tz-clock')).display === 'none',
  };
}"""

TIGHT_JS = """() => {
  const cs = (el) => getComputedStyle(el);
  return {
    srvHidden: cs(document.querySelector('#srv-label')).display === 'none',
    tzHidden: cs(document.querySelector('#tz-label')).display === 'none',
    srvBtnShown: document.querySelector('#srv-btn').offsetWidth > 0,
    tzBtnShown: document.querySelector('#tz-btn').offsetWidth > 0,
  };
}"""

DLG_JS = """() => {
  const d = document.querySelector('#settings-dialog');
  if (!d) return { open: false };
  const r = d.getBoundingClientRect();
  return { open: true, bottom: Math.round(r.bottom), vh: window.innerHeight, fits: r.bottom <= window.innerHeight + 1 };
}"""

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up'); prov.terminate(); return 1
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
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_function("() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100", timeout=25000)
            w = page.evaluate(WIDE_JS)
            print('    wide:', w)
            check('wide: cluster fits, chevrons hidden', w['over'] <= 1 and w['chevL'] and w['chevR'], w)
            page.set_viewport_size({'width': 1000, 'height': 700})
            page.wait_for_timeout(600)
            n = page.evaluate(NARROW_JS)
            print('    narrow:', n)
            check('narrow: buttons not squeezed', n['symW'] == w['symW'] and n['tfmW'] == w['tfmW'] and n['indW'] == w['indW'], (w, n))
            check('narrow: cluster scrolls with chevron', n['over'] > 1 and (not n['chevL'] or not n['chevR']), n)
            check('narrow: bottom buttons not squeezed', all(s == '0' for s in n['btShrink']), n['btShrink'][:6])
            check('narrow: bottom bar scrolls, clock hides', n['btOverX'] == 'auto' and n['clockHidden'], n)
            page.set_viewport_size({'width': 800, 'height': 700})
            page.wait_for_timeout(600)
            t = page.evaluate(TIGHT_JS)
            print('    tight:', t)
            check('tight: labels hide, icon buttons stay', t['srvHidden'] and t['tzHidden'] and t['srvBtnShown'] and t['tzBtnShown'], t)
            page.set_viewport_size({'width': 1560, 'height': 600})
            page.wait_for_timeout(600)
            page.click('#settings-btn')
            page.wait_for_selector('#settings-dialog', timeout=8000)
            page.wait_for_timeout(400)
            d = page.evaluate(DLG_JS)
            print('    dialog:', d)
            check('short: settings dialog fits viewport', d.get('open') and d.get('fits'), d)
            page.keyboard.press('Escape')
            page.wait_for_timeout(300)
            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        prov.terminate()
    print('ROUND242: %d failed' % len(FAILS) if FAILS else 'ROUND242: all green')
    return 1 if FAILS else 0

if __name__ == '__main__':
    sys.exit(main())
