#!/usr/bin/env python3
"""Probe 3: EXACT e2e sequence including the reload, click immediately."""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = '/home/z/my-project/work'
PORT_HTTP, PORT_WS = 8943, 8777

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

threading.Thread(target=serve_http, daemon=True).start()
prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
wait_port(PORT_HTTP); wait_port(PORT_WS)

from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
    page = browser.new_page(viewport={'width': 1500, 'height': 880})
    page.goto('http://127.0.0.1:8943/renderer/index.html')
    page.wait_for_timeout(900)
    page.click('#login-connect')
    page.wait_for_selector('#app:not(.hidden)', timeout=20000)
    page.wait_for_timeout(900)
    page.evaluate("() => window.__app.RightPanel.showTab('alerts')")
    page.wait_for_timeout(300)

    # step [2]+[3]: open sound card, reload, reconnect
    page.evaluate("() => document.querySelector('#alert-sound-settings .al-head').click()")
    page.wait_for_timeout(200)
    page.reload()
    page.wait_for_timeout(900)
    page.click('#login-connect')
    page.wait_for_selector('#app:not(.hidden)', timeout=20000)
    page.wait_for_timeout(700)
    page.evaluate("() => window.__app.RightPanel.showTab('alerts')")
    page.wait_for_timeout(300)

    # step [5]: ta card open + trade 1
    page.evaluate("() => document.querySelector('#trade-alert-settings .al-head').click()")
    page.wait_for_timeout(200)
    page.evaluate("""async () => {
      const A = window.__app; const sym = A.App.panes[0].symbol;
      await A.TradeRoute.sendOrder({ symbol: sym, orderType: 0, volume: 0.10, price: 0, sl: 0, tp: 0, deviation: 20, comment: 'p3a' });
    }""")
    page.wait_for_timeout(2600)

    # step [6]: capture on, trade 2, collapse, close
    page.evaluate("() => document.querySelector('#tn-enabled').click()")
    page.wait_for_timeout(300)
    page.evaluate("""async () => {
      const A = window.__app; const sym = A.App.panes[0].symbol;
      await A.TradeRoute.sendOrder({ symbol: sym, orderType: 0, volume: 0.05, price: 0, sl: 0, tp: 0, deviation: 20, comment: 'p3b' });
    }""")
    page.wait_for_timeout(2600)
    page.evaluate("() => document.querySelector('#trade-notify-log .al-head').click()")
    page.wait_for_timeout(200)
    t2 = page.evaluate("() => window.__app.Trade.positions.map((p) => p.ticket).pop()")
    page.evaluate("(t) => window.__app.TradeRoute.close(t)", t2)
    page.wait_for_timeout(2600)
    print('badge:', page.evaluate("() => document.querySelector('#tn-badge').textContent"))
    try:
        page.click('#tn-bell', timeout=8000)
        print('REAL CLICK OK, open:', page.evaluate("() => !!document.querySelector('#tn-list')"))
    except Exception as e:
        print('REAL CLICK FAILED:', str(e)[:200])
        info = page.evaluate("""
        () => {
          const bs = [...document.querySelectorAll('#tn-bell')];
          const b = bs[0];
          const chain = [];
          let el = b;
          while (el && el !== document.documentElement) {
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            chain.push({ tag: el.tagName, cls: (el.className || el.id || '').toString().slice(0, 30),
                         disp: s.display, hidden: el.classList.contains('hidden'),
                         w: r.width, h: r.height });
            el = el.parentElement;
          }
          // which tab is visible?
          const tabs = [...document.querySelectorAll('.rtab')].map((t) => ({ id: t.id, hidden: t.classList.contains('hidden') }));
          const rc = document.getElementById('right-content');
          return { chain, tabs, rcHidden: rc.classList.contains('hidden') };
        }""")
        print('at failure:', info)

browser.close()
prov.terminate()
