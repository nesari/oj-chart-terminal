#!/usr/bin/env python3
"""Probe the countdown + tick freshness internals live (round 27 QA)."""
import time, threading, http.server, functools, json, subprocess, signal, os

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'src')
PROV = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'provider', 'demo.py')
PORT = 8988

prov = subprocess.Popen(['python3', PROV], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
time.sleep(1.5)

def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    h.log_message = lambda *a, **k: None
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start()

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(args=['--window-size=1600,900'])
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1000)
    pg.click('#card-demo'); pg.click('#login-connect')
    pg.wait_for_timeout(8000)
    r = pg.evaluate("""() => {
      const App = window.__app.App, M = window.__app.Manager;
      const P = App.activePane;
      const tf = App.tfById[P.tf];
      const t = M.lastTickAt[P.symbol];
      const off = App.feed.serverOff || 0;
      const bs = M.bucketStartFor(tf, t);
      const now = Math.floor(Date.now() / 1000);
      return {
        sym: P.symbol, tf: P.tf, tfSec: tf.sec,
        lastTickAt: t, localNow: now, serverOff: off,
        tickAgeLocal: now - t, tickAgeServer: now + off - t,
        bucketStart: bs, rem: bs + tf.sec - t,
        cdText: P.cd ? P.cd.textContent : null, cdVis: P.cd ? P.cd.style.display : null,
        lastBarTime: P.bars.length ? P.bars[P.bars.length - 1].time : null
      };
    }""")
    print(json.dumps(r, indent=1))
    pg.wait_for_timeout(1500)
    r2 = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      return { cdText: P.cd ? P.cd.textContent : null, cdVis: P.cd ? P.cd.style.display : null };
    }""")
    print('after 1.5s:', json.dumps(r2))
    b.close()

try:
    os.killpg(os.getpgid(prov.pid), signal.SIGTERM)
except Exception:
    pass
