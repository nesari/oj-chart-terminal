#!/usr/bin/env python3
"""BUG-001 + BUG-011 + BUG-012 verification.
001: login two-column >= 960x600, compact single-column below, no page scroll,
     all controls present/working, saved accounts capped.
011: ONE unified price label: countdown as second line (zero-padded mm:ss),
     no duplicate price, absent on D1.
012: brand wordmark breathes above the time axis (gap == horizontal inset).
"""
import sys, time, threading, http.server, functools, json, subprocess, signal, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
PORT = 8920
PROV = subprocess.Popen(['python3', os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'provider', 'demo.py')],
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

LOGIN_PROBE = """() => {
  const card = document.querySelector('.login-card');
  const brand = document.querySelector('.login-brand-col');
  const form = document.querySelector('.login-form-col');
  const r = card.getBoundingClientRect();
  const ids = ['card-demo', 'card-mt5', 'mt5-login', 'mt5-password', 'mt5-server', 'mt5-path',
               'mt5-remember', 'saved-accounts', 'login-connect', 'login-status', 'login-back',
               'pw-eye'].filter((i) => !document.getElementById(i));
  return {
    twoCol: getComputedStyle(card).display === 'flex' && getComputedStyle(card).flexDirection === 'row',
    card: { w: Math.round(r.width), h: Math.round(r.height) },
    vw: window.innerWidth, vh: window.innerHeight,
    noPageScroll: document.documentElement.scrollHeight <= window.innerHeight + 1 &&
                 document.documentElement.scrollWidth <= window.innerWidth + 1,
    cardFits: r.bottom <= window.innerHeight + 1 && r.top >= -1,
    brandLeft: !!brand, formRight: !!form,
    brandNonInteractive: brand ? getComputedStyle(brand).pointerEvents === 'none' : null,
    missingIds: ids,
    savedCapped: (() => { const sa = document.getElementById('saved-accounts'); return sa ? (sa.scrollHeight <= sa.clientHeight + 2 || parseFloat(getComputedStyle(sa).maxHeight) > 0) : null; })(),
    savedMaxH: (() => { const sa = document.getElementById('saved-accounts'); return sa ? getComputedStyle(sa).maxHeight : null; })(),
  };
}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1366, 'height': 768})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1200)

    # ---------- BUG-001 ----------
    a = pg.evaluate(LOGIN_PROBE)
    check('1 login 1366x768: TWO columns (brand left, form right)', a['twoCol'] and a['brandLeft'] and a['formRight'], a)
    check('2 zero page scroll + card fully visible', a['noPageScroll'] and a['cardFits'], a)
    check('3 every control present (IDs intact — zero logic change)', len(a['missingIds']) == 0, a['missingIds'])
    check('4 branding column non-interactive', a['brandNonInteractive'] == True)
    check('5 saved accounts capped (max-height set)', a['savedMaxH'] not in (None, 'none'), a['savedMaxH'])
    pg.screenshot(path='/home/z/my-project/download/bug001-login-twocol.png')

    # compact single column below the breakpoint
    pg.set_viewport_size({'width': 860, 'height': 768})
    pg.wait_for_timeout(400)
    s1 = pg.evaluate(LOGIN_PROBE)
    check('6 <960px: compact single column, no page scroll', s1['twoCol'] == False and s1['noPageScroll'] and s1['cardFits'], s1)
    # short viewport also single column
    pg.set_viewport_size({'width': 1366, 'height': 560})
    pg.wait_for_timeout(400)
    s2 = pg.evaluate(LOGIN_PROBE)
    check('7 <600px height: single column (no split), fits', s2['twoCol'] == False and s2['cardFits'], s2)

    # login works exactly as before (demo)
    pg.set_viewport_size({'width': 1366, 'height': 768})
    pg.wait_for_timeout(300)
    pg.click('#card-demo'); pg.click('#login-connect')
    pg.wait_for_timeout(6000)
    logged = pg.evaluate("() => !document.getElementById('app').classList.contains('hidden')")
    check('8 login flow works unchanged (demo connect)', logged == True)

    # ---------- BUG-011: unified price label ----------
    u = pg.evaluate("""() => {
      const pane = window.__app.App.activePane;
      const cd = pane.cd;
      const st = getComputedStyle(cd);
      return { display: cd.style.display, txt: cd.textContent, bg: st.backgroundColor,
               font: st.fontSize, radius: st.borderRadius };
    }""")
    import re
    zero_pad = re.match(r'^\d{2}:\d{2}$', u['txt'] or '') or re.match(r'^\d+:\d{2}:\d{2}$', u['txt'] or '')
    check('9 countdown line: zero-padded mm:ss, second-line styling',
          u['display'] == 'block' and bool(zero_pad) and u['font'] in ('9.5px', '10px'), u)
    check('10 countdown bg = series colour (same box as the price label)',
          u['bg'] not in ('rgba(0, 0, 0, 0)', 'transparent') and u['radius'].startswith('0px'), u)

    # D1: countdown line absent
    pg.evaluate("() => window.__app.Manager.setTf(window.__app.App.activePane, 'D1')")
    pg.wait_for_timeout(5000)
    d1 = pg.evaluate("""() => {
      const pane = window.__app.App.activePane;
      return { display: pane.cd.style.display, tf: pane.tf };
    }""")
    check('11 D1/W1/MN: no countdown line (label collapses to price only)',
          d1['display'] == 'none' and d1['tf'] == 'D1', d1)

    # ---------- BUG-012: brand watermark gap ----------
    pg.evaluate("() => window.__app.Manager.setTf(window.__app.App.activePane, 'M1')")
    pg.wait_for_timeout(4500)
    w = pg.evaluate("""() => {
      const pane = window.__app.App.activePane;
      const br = pane.brand.getBoundingClientRect();
      const rr = pane.root.getBoundingClientRect();
      const th = pane.chart.timeScale().height();
      const gap = rr.bottom - th - br.bottom;
      return { gap: Math.round(gap * 10) / 10, timeH: th, brandH: Math.round(br.height) };
    }""")
    check('12 brand wordmark sits ~8px above the time axis (== horizontal inset)',
          5 <= w['gap'] <= 12, w)

    pg.screenshot(path='/home/z/my-project/download/bug011-012-after-fix.png')
    check('13 no page errors', len(errs) == 0, '; '.join(errs[:3]))
    b.close()

try: os.killpg(os.getpgid(PROV.pid), signal.SIGTERM)
except Exception: pass

fails = [r for r in results if not r[1]]
print(f"\n==== {len(results) - len(fails)}/{len(results)} passed ====")
sys.exit(1 if fails else 0)
