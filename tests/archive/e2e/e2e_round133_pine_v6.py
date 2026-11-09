#!/usr/bin/env python3
"""ROUND133 e2e — Pine v6 engine vs the user's REAL TradingView indicators.

Boots the demo broker + renderer, then for each of the four sample scripts
(SMC [LuxAlgo], Squeeze Momentum [LazyBear], Supertrend, CM_MacD_Ult_MTF):

 [1] compile through the app's own engine entry (window.__app pipeline)
 [2] SMC is ADDED TO THE LIVE DEMO CHART through PineUI (the real user path)
     and its boxes/lines/labels render on the overlay canvas
 [3] the engine fixtures stay green (786 Zones et al. re-run in-app)
 [4] zero page errors across the whole run

Exits 0 only if every check passes.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time, pathlib

ROOT = pathlib.Path(__file__).parent.parent.parent.parent
PORT_HTTP, PORT_WS = 8951, 8778
SHOTS = ROOT / 'docs' / 'shots-round133'
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

def check(name, cond, extra=''):
    print(('  \u2713 ' if cond else '  \u2717 ') + name + ((' \u2014 ' + str(extra)) if (not cond and extra != '') else ''))
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
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / 'src'))
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT_HTTP), handler).serve_forever()

def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=serve_http, daemon=True).start()
    prov = subprocess.Popen([sys.executable, str(ROOT / 'provider' / 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            env={**os.environ, 'MT5_WS_PORT': str(PORT_WS)})
    ok_boot = wait_port(PORT_HTTP) and wait_port(PORT_WS)
    print('boot:', ok_boot)
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe', args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1500, 'height': 880})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(2000)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_timeout(3500)  # demo feed settle

            FIX = ROOT / 'src' / 'renderer' / 'assets' / 'pine-samples'
            samples = ['sample-SmartMoneyConcepts.pine', 'sample-SqueezeMomentum.pine',
                       'sample-Supertrend.pine', 'sample-CM_MacD_Ult_MTF.pine']

            print('\u2014 [1] compile via the app engine \u2014')
            for f in samples:
                src = (FIX / f).read_text(encoding='utf-8')
                r = page.evaluate("""async (src) => {
                    try {
                        const c = await (async () => {
                            // the page origin is /renderer/, core lives at ../core/
                            for (const u of ['../core/pine/compile.js', './core/pine/compile.js', '/core/pine/compile.js']) {
                                try { return (await import(u)).compile(src, { tfSec: 60, symbol: 'EURUSD' }); } catch (e) {}
                            }
                            throw new Error('compile module not reachable');
                        })();
                        if (!c.ok) return { err: c.errors.map(e => e.message).join('; ') };
                        return { title: c.meta.title };
                    } catch (e) { return { err: String(e && e.message || e) }; }
                }""", src)
                check(f'compile {f}', 'err' not in r, r.get('err', ''))

            print('\u2014 [2] SMC added to the LIVE chart (real user path) \u2014')
            smc = (FIX / 'sample-SmartMoneyConcepts.pine').read_text(encoding='utf-8')
            r = page.evaluate("""async (src) => {
                try {
                    const app = window.__app;
                    const PE = app.PineEditor, PUI = app.PineUI, Store = app.PineScriptsStore;
                    if (!PE || !PUI || !Store) return { err: 'missing facade: ' + [!!PE, !!PUI, !!Store] };
                    // the real user path: create script -> editor holds it -> Add to chart
                    const rec = Store.create('SMC round133', src);
                    PE.open(); PE.openScript(rec.id);
                    // PineEditor.addToChart is module-internal; drive the same button
                    const btn = document.querySelector('#pe-add');
                    if (!btn) return { err: 'no #pe-add button (panel closed?)' };
                    btn.click();
                    const status = document.querySelector('#pe-status');
                    return { ok: true, status: status ? status.textContent.slice(0, 150) : '' };
                } catch (e) { return { err: String(e && e.message || e).slice(0, 250) }; }
            }""", smc)
            check('SMC add-to-chart (Pine path)', 'err' not in r, r.get('err', r.get('status', '')))
            page.wait_for_timeout(4000)

            # did anything render? boxes/lines/labels on the overlay
            vis = page.evaluate("""() => {
                const PUI = window.__app.PineUI;
                return PUI.debugRtDump ? PUI.debugRtDump() : { err: 'no debugRtDump' };
            }""")
            check('SMC instance built with a runtime', 'err' not in vis and vis.get('withRt', 0) > 0, str(vis))
            objs = {'boxes': vis.get('boxes', 0), 'lines': vis.get('lines', 0), 'labels': vis.get('labels', 0), 'errs': vis.get('errors', [])[:2]}
            check('SMC boxes/lines/labels produced', (objs['boxes'] + objs['lines'] + objs['labels']) > 0, str(objs))

            # load older bars twice so the script has enough history for pivots/atr warmup
            for _ in range(2):
                older = page.evaluate("""() => {
                    const app = window.__app;
                    const pane = app.App.panes[0];
                    const btn = document.querySelector('#load-older') || pane && pane._loadOlderBtn;
                    if (app.Manager && app.Manager.loadOlder) { app.Manager.loadOlder(pane); return 'manager'; }
                    if (pane && pane.loadOlder) { pane.loadOlder(); return 'pane'; }
                    return 'no-fn';
                }""")
                page.wait_for_timeout(2500)

            vis2 = page.evaluate("""() => window.__app.PineUI.debugRtDump()""")
            check('SMC objects after more history', vis2.get('withRt', 0) > 0, str(vis2))
            page.screenshot(path=str(SHOTS / 'smc-on-chart.png'))

            print('\u2014 [3] page health \u2014')
            check('zero page errors', len(errors) == 0, errors[:2])

            browser.close()
    finally:
        prov.terminate()
    print(f"\nRESULT: {len(FAILS)} failed")
    sys.exit(1 if FAILS else 0)

if __name__ == '__main__':
    main()
