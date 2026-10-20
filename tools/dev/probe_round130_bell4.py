#!/usr/bin/env python3
"""Probe 4: bisect WHEN the right panel closes during the sequence."""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = '/home/z/my-project/work'
PORT_HTTP, PORT_WS = 8945, 8777

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
    # catch the close in the page: monkey-patch after boot
    page.goto('http://127.0.0.1:8945/renderer/index.html')
    page.wait_for_timeout(900)
    page.click('#login-connect')
    page.wait_for_selector('#app:not(.hidden)', timeout=20000)
    page.wait_for_timeout(900)

    # instrument: log stack on RightPanel.close via a MutationObserver
    page.evaluate("""
    () => {
      const rc = document.getElementById('right-content');
      window.__closeLog = [];
      new MutationObserver(() => {
        if (rc.classList.contains('hidden')) {
          window.__closeLog.push({ at: Date.now(), stack: new Error().stack.split('\\n').slice(2, 8).join(' | ') });
        }
      }).observe(rc, { attributes: true, attributeFilter: ['class'] });
    }""")

    def rcstate(label):
        print(label, page.evaluate("() => ({ hidden: document.getElementById('right-content').classList.contains('hidden'), tab: localStorage.getItem('mt5_rp_tab') })"))

    page.evaluate("() => window.__app.RightPanel.showTab('alerts')")
    page.wait_for_timeout(300); rcstate('after showTab alerts:')

    page.evaluate("() => document.querySelector('#alert-sound-settings .al-head').click()")
    page.wait_for_timeout(200); rcstate('after sound head click:')

    page.reload(); page.wait_for_timeout(900)
    page.click('#login-connect')
    page.wait_for_selector('#app:not(.hidden)', timeout=20000)
    page.wait_for_timeout(700); rcstate('after reload+connect:')
    page.evaluate("""() => {
      const rc = document.getElementById('right-content');
      window.__closeLog = [];
      new MutationObserver(() => {
        if (rc.classList.contains('hidden')) {
          window.__closeLog.push({ at: Date.now(), stack: new Error().stack.split('\\n').slice(2, 8).join(' | ') });
        }
      }).observe(rc, { attributes: true, attributeFilter: ['class'] });
    }""")
    page.evaluate("() => window.__app.RightPanel.showTab('alerts')")
    page.wait_for_timeout(300); rcstate('after re-showTab alerts:')

    page.evaluate("() => document.querySelector('#trade-alert-settings .al-head').click()")
    page.wait_for_timeout(200); rcstate('after ta head click:')

    page.evaluate("""async () => {
      const A = window.__app; const sym = A.App.panes[0].symbol;
      await A.TradeRoute.sendOrder({ symbol: sym, orderType: 0, volume: 0.10, price: 0, sl: 0, tp: 0, deviation: 20, comment: 'p4a' });
    }""")
    page.wait_for_timeout(2600); rcstate('after trade 1:')

    page.evaluate("() => document.querySelector('#tn-enabled').click()")
    page.wait_for_timeout(300); rcstate('after tn-enabled click:')

    page.evaluate("""async () => {
      const A = window.__app; const sym = A.App.panes[0].symbol;
      await A.TradeRoute.sendOrder({ symbol: sym, orderType: 0, volume: 0.05, price: 0, sl: 0, tp: 0, deviation: 20, comment: 'p4b' });
    }""")
    page.wait_for_timeout(2600); rcstate('after trade 2:')

    page.evaluate("() => document.querySelector('#trade-notify-log .al-head').click()")
    page.wait_for_timeout(200); rcstate('after tn head click (collapse):')

    t2 = page.evaluate("() => window.__app.Trade.positions.map((p) => p.ticket).pop()")
    page.evaluate("(t) => window.__app.TradeRoute.close(t)", t2)
    page.wait_for_timeout(2600); rcstate('after close:')

    print('closeLog:', page.evaluate("() => window.__closeLog"))

browser.close()
prov.terminate()
