#!/usr/bin/env python3
"""Load the renderer in headless chromium against the demo provider,
auto-login to demo, and dump console errors + optional screenshot."""
import sys, time, threading, http.server, functools, json, subprocess, signal, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
PORT = 8899
PROV = subprocess.Popen(
    ['python3', os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'provider', 'demo.py')],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    preexec_fn=os.setsid)
time.sleep(1.5)

def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start()
time.sleep(0.5)

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/shot.png'
WAIT = int(sys.argv[2]) if len(sys.argv) > 2 else 12
SCRIPT = sys.argv[3] if len(sys.argv) > 3 else None

with sync_playwright() as p:
    b = p.chromium.launch(args=['--window-size=1600,900'])
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    errors = []
    pg.on('console', lambda m: errors.append(m.text) if m.type in ('error',) else None)
    pg.on('pageerror', lambda e: errors.append('PAGEERROR: ' + str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1200)
    # login to demo
    try:
        pg.click('#card-demo')
        pg.click('#login-connect')
    except Exception as e:
        print('login click failed:', e)
    pg.wait_for_timeout(WAIT * 1000)
    if SCRIPT:
        r = pg.evaluate(SCRIPT)
        print('EVAL:', json.dumps(r, default=str)[:3000])
    pg.screenshot(path=OUT)
    print('CONSOLE ERRORS:' if errors else 'no console errors')
    for e in errors[:20]:
        print('  -', e[:300])
    b.close()

try:
    os.killpg(os.getpgid(PROV.pid), signal.SIGTERM)
except Exception:
    pass
