# WHY do objects with valid ms coords not show in the visible window?
# The demo feed's last bar spikes +5% (demo quirk). The visible window is
# ~150 bars; SMC lines span the whole history and SHOULD cross the view.
# Verify: repaint + pixel-sample the fg canvas in-app.
import http.server, functools, os, subprocess, threading, time, pathlib
ROOT = r'C:/Users/amirh/Desktop/mt5-chart-terminal(22)'
PORT_HTTP, PORT_WS = 8951, 8778
def serve_http():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, 'src'))
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT_HTTP), handler).serve_forever()
threading.Thread(target=serve_http, daemon=True).start()
prov = subprocess.Popen([r'C:/Users/amirh/AppData/Local/Programs/Python/Python311/python.exe', os.path.join(ROOT, 'provider', 'demo.py')],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**os.environ, 'MT5_WS_PORT': str(PORT_WS)})
time.sleep(2)
from playwright.sync_api import sync_playwright
FIX = pathlib.Path(ROOT) / 'scripts' / 'pine-fixtures'
smc = (FIX / 'sample-SmartMoneyConcepts.pine').read_text(encoding='utf-8')
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe', args=['--no-sandbox'])
    page = b.new_page(viewport={'width': 1500, 'height': 880})
    page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
    page.wait_for_timeout(2500)
    page.click('#login-connect')
    page.wait_for_selector('#app:not(.hidden)', timeout=45000)
    page.wait_for_timeout(3500)
    r = page.evaluate("""async (src) => {
        const app = window.__app;
        const rec = app.PineScriptsStore.create('SMC vis', src);
        app.PineEditor.open(); app.PineEditor.openScript(rec.id);
        document.querySelector('#pe-add').click();
        await new Promise(r => setTimeout(r, 6000));
        const pane = app.App.panes[0];
        const times = pane.barTimes; // seconds
        const visLo = times[Math.max(0, times.length - 150)] * 1000;
        const visHi = times[times.length - 1] * 1000 + 6e5;
        let inView = { line: 0, label: 0, box: 0 }, total = { line: 0, label: 0, box: 0 };
        for (const [, map] of app.PineUI.debugRtDump ? [] : []) {};
        // reach into one rt via debugRtDump is aggregate; use pane's own adapter
        const st = pane.pineScripts[pane.pineScripts.length - 1];
        // walk the RT map through PineUI's facade: use the adapter's canvas paint state
        // instead: repaint NOW and pixel-sample
        const cv = pane._pineCanvases.fg;
        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, cv.width, cv.height);
        // force repaint via scroll nudge
        pane.chart.timeScale().scrollToRealTime();
        await new Promise(r => setTimeout(r, 800));
        const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let px = 0;
        for (let i = 3; i < img.length; i += 4) if (img[i] > 0) px++;
        return { bars: times.length, px };
    }""", smc)
    print('RESULT:', r)
    page.screenshot(path=str(pathlib.Path(ROOT) / 'docs' / 'shots-round133' / 'smc-final.png'))
    b.close()
prov.terminate()
