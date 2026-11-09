#!/usr/bin/env python3
"""ROUND133b — the 5 TV indicator templates appear in the Pine editor on a
FRESH profile (cleared localStorage) and each compiles."""
import http.server, functools, os, subprocess, sys, threading, time, pathlib

ROOT = pathlib.Path(__file__).parent.parent.parent.parent
PORT_HTTP, PORT_WS = 8952, 8779
FAILS = []
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def check(name, cond, extra=''):
    print(('  \u2713 ' if cond else '  \u2717 ') + name + ((' \u2014 ' + str(extra)) if not cond else ''))
    if not cond: FAILS.append(name)

def wait_port(port, timeout=25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with socket.create_connection(('127.0.0.1', port), 0.4): return True
        except OSError: time.sleep(0.2)
    return False

def serve_http():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / 'src'))
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT_HTTP), handler).serve_forever()

import socket
def main():
    threading.Thread(target=serve_http, daemon=True).start()
    prov = subprocess.Popen([sys.executable, str(ROOT / 'provider' / 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            env={**os.environ, 'MT5_WS_PORT': str(PORT_WS)})
    wait_port(PORT_HTTP); wait_port(PORT_WS)
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe', args=['--no-sandbox'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe', args=['--no-sandbox'])
            ctx = browser.new_context(viewport={'width': 1500, 'height': 880})
            page = ctx.new_page()
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(2000)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_timeout(3500)

            r = page.evaluate("""async () => {
                const app = window.__app;
                // FRESH profile: wipe the store, then let ensureTvSamples re-seed
                localStorage.removeItem('mt5_pine_scripts');
                location.hash = ''; // noop
                // re-seed: the module-level kick already ran; force a fresh one
                // by touching the store through a page reload is complex — the
                // editor's dropdown reads Store.all() live, so emulate first
                // open: wait, reload page (module re-inits, storage empty ->
                // seeds built-ins + fetches TV samples)
                return 'reload-next';
            }""")
            page.reload()
            page.wait_for_timeout(2000)
            # app boots to login again after reload; reconnect
            if page.evaluate("document.getElementById('login-screen') && !document.getElementById('login-screen').classList.contains('hidden')"):
                page.click('#login-connect')
                page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_timeout(3000)

            r = page.evaluate("""async () => {
                const app = window.__app;
                const scripts = app.PineScriptsStore.all();
                const tv = scripts.filter(s => s.tv);
                // compile each TV sample through the engine
                const results = [];
                for (const s of tv) {
                    try {
                        const c = await (async () => {
                            for (const u of ['../core/pine/compile.js', './core/pine/compile.js', '/core/pine/compile.js']) {
                                try { return (await import(u)).compile(s.source, { tfSec: 60, symbol: 'EURUSD' }); } catch (e) {}
                            }
                            throw new Error('compile module unreachable');
                        })();
                        results.push({ name: s.name, ok: c.ok, err: c.ok ? '' : c.errors.map(e => e.message).join('; ').slice(0, 100) });
                    } catch (e) { results.push({ name: s.name, ok: false, err: String(e && e.message || e).slice(0, 100) }); }
                }
                return { total: scripts.length, tvCount: tv.length, names: tv.map(s => s.name), results };
            }""")

            check('TV templates seeded', r['tvCount'] == 5, f"got {r['tvCount']}: {r['names']}")
            for res in r['results']:
                check(f"compile {res['name']}", res['ok'], res['err'])
            check('built-in samples still present', r['total'] >= 9, f"total {r['total']} (4 builtin + 5 tv)")

            # open the editor and confirm the dropdown lists them
            page.evaluate("window.__app.PineEditor.open()")
            page.wait_for_timeout(800)
            opts = page.evaluate("document.querySelectorAll('#pe-sel option, select option').length")
            check('editor dropdown populated', opts >= 9, f"{opts} options")
            browser.close()
    finally:
        prov.terminate()
    print(f"\nRESULT: {len(FAILS)} failed")
    sys.exit(1 if FAILS else 0)

if __name__ == '__main__':
    main()
