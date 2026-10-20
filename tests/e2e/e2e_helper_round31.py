"""Self-bootstrapping E2E helper for the round-31 suite.

Spawns the demo provider (ws://127.0.0.1:8777) and a static server for
src/ (port 8977), logs into demo and exposes pane-level helpers.
Pattern copied from scripts/harness.py.
"""
import time, threading, http.server, functools, subprocess, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'src')
PROV = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'provider', 'demo.py')
PORT = 8977
BASE = f'http://127.0.0.1:{PORT}/renderer/index.html'

_prov = subprocess.Popen(['python3', PROV], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
time.sleep(1.5)

def _serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    h.log_message = lambda *a, **k: None
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()

threading.Thread(target=_serve, daemon=True).start()


def poll(page, js, timeout=20000, cond=lambda v: bool(v)):
    """CSP-safe wait: poll page.evaluate (no eval) until cond(value)."""
    deadline = time.time() + timeout / 1000
    last = None
    while time.time() < deadline:
        last = page.evaluate(js)
        try:
            if cond(last):
                return last
        except TypeError:
            pass
        time.sleep(0.25)
    raise TimeoutError(f'poll failed: {js} -> {last}')


def open_app(pw, headless=True, layout=None):
    try:
        browser = pw.chromium.launch(headless=headless)
    except Exception:
        browser = pw.chromium.launch(channel='chrome', headless=headless)
    page = browser.new_page(viewport={'width': 1500, 'height': 900})
    page.add_init_script("localStorage.clear()")
    page.goto(BASE)
    page.wait_for_selector('#login-screen', timeout=10000)
    page.click('#card-demo')
    page.click('#login-connect')
    page.wait_for_selector('#app:not(.hidden)', timeout=20000)
    poll(page, "window.__app ? window.__app.App.panes.length : 0", 20000, lambda v: v >= 1)
    poll(page, "(window.__app.App.panes[0].bars || []).length", 30000, lambda v: v > 100)
    if layout:
        page.evaluate("l => window.__app.Manager.setLayout(l, true)", layout)
        page.wait_for_timeout(1500)
    return browser, page


def pane_js(page, expr, idx=0):
    """expr = JS lambda (p => ...) evaluated with the pane object."""
    return page.evaluate(f"(({expr})(window.__app.App.panes[{idx}]))")


def last_bar_x(page, idx=0):
    return pane_js(page, "p => p.engine._xOf(p.barTimes[p.barTimes.length-1])", idx)


def overlay_box(page, idx=0):
    return pane_js(page, "p => (b => ({x:b.x,y:b.y,w:b.width,h:b.height}))(p.overlay.getBoundingClientRect())", idx)


def move_mouse(page, px_x, px_y, idx=0):
    """dispatch a mousemove on pane idx's overlay canvas at pane-local coords"""
    page.evaluate(f"""(([x, y, i]) => {{
        const p = window.__app.App.panes[i];
        const ev = new MouseEvent('mousemove', {{clientX: p.overlay.getBoundingClientRect().left + x,
          clientY: p.overlay.getBoundingClientRect().top + y, bubbles: true}});
        p.overlay.dispatchEvent(ev);
    }})""", [px_x, px_y, idx])


def click_overlay(page, px_x, px_y, idx=0):
    page.evaluate(f"""(([x, y, i]) => {{
        const p = window.__app.App.panes[i];
        const r = p.overlay.getBoundingClientRect();
        const ev = new MouseEvent('mousedown', {{clientX: r.left + x, clientY: r.top + y, button: 0, bubbles: true}});
        p.overlay.dispatchEvent(ev);
        const up = new MouseEvent('mouseup', {{clientX: r.left + x, clientY: r.top + y, button: 0, bubbles: true}});
        window.dispatchEvent(up);
    }})""", [px_x, px_y, idx])


def tax_live_state(page, idx=0):
    return pane_js(page, "p => p.taxLive ? {d: p.taxLive.style.display, l: p.taxLive.style.left, txt: p.taxLive.textContent, w: p.taxLive.offsetWidth} : null", idx)


def vert_line_drawn(page, x_px, idx=0):
    """read a vertical strip of the overlay canvas at x_px: any non-transparent pixel in plot area?"""
    return pane_js(page, f"""p => {{
        const cv = p.overlay, ctx = cv.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const x = Math.round({x_px} * dpr);
        const data = ctx.getImageData(x, Math.round(20*dpr), 1, Math.round(200*dpr)).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 10) return true;
        return false;
    }}""", idx)
