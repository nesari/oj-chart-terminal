#!/usr/bin/env python3
"""ROUND132 probe — narrow window: the labeled top bar must overflow into
the TV scroll arrows instead of breaking the layout."""
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

def main():
    threading.daemon = True
    t = threading.Thread(target=serve_http, daemon=True)
    t.start()
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('did not come up'); return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 980, 'height': 700})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            page.wait_for_timeout(800)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_timeout(1000)
            st = page.evaluate("""() => ({
                over: !document.getElementById('tb-scroll-r').classList.contains('hidden') ||
                      !document.getElementById('tb-scroll-l').classList.contains('hidden'),
                barH: Math.round(document.getElementById('top-toolbar').getBoundingClientRect().height),
                errs: 0,
            })""")
            print('narrow-window:', st, 'pageErrors:', len(errors))
            os.makedirs(os.path.join(ROOT, 'docs', 'shots-round132'), exist_ok=True)
            page.locator('#top-toolbar').screenshot(path=os.path.join(ROOT, 'docs', 'shots-round132', 'topbar-narrow.png'))
            browser.close()
            print('RESULT:', 'PASS' if (st['over'] and st['barH'] == 46 and not errors) else 'FAIL')
            return 0 if (st['over'] and st['barH'] == 46 and not errors) else 1
    finally:
        prov.terminate()

if __name__ == '__main__':
    sys.exit(main())
