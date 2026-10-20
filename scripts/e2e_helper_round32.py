"""Self-bootstrapping E2E helper for the round-32 suite.

Same pattern as e2e_helper_round31 (demo provider ws://127.0.0.1:8778 +
static server on port 8978) plus sub-pane helpers.
"""
import time, threading, http.server, functools, subprocess, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src')
PROV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'provider', 'demo.py')
PORT = 8978
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


def move_mouse(page, px_x, px_y, idx=0):
    """dispatch a mousemove on pane idx's overlay canvas at pane-local coords"""
    page.evaluate(f"""(([x, y, i]) => {{
        const p = window.__app.App.panes[i];
        const ev = new MouseEvent('mousemove', {{clientX: p.overlay.getBoundingClientRect().left + x,
          clientY: p.overlay.getBoundingClientRect().top + y, bubbles: true}});
        p.overlay.dispatchEvent(ev);
    }})""", [px_x, px_y, idx])


def sub_info(page, inst_type, idx=0):
    """geometry + existence of one separate indicator's sub-pane"""
    return pane_js(page, """p => {
        const inst = (p.indicators || []).find(i => i.type === arguments_placeholder);
        if (!inst) return { exists: false };
        const sub = p._subs ? p._subs.get(inst.id) : null;
        if (!sub) return { exists: false, inst: true };
        const wrapH = sub.host.clientHeight;
        const canv = [...sub.host.querySelectorAll('canvas')].map(c => ({ w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight }));
        const rows = sub.host.querySelectorAll('.ind-row').length;
        const rowInSub = !!sub.host.querySelector('.ind-row');
        const chartEl = !!sub.host.querySelector('.tv-lightweight-charts');
        return { exists: true, wrapH, canv, rows, rowInSub, chartEl,
                 top: sub.host.offsetTop,
                 mainH: p._mainPlotH, subTotal: p._subTotalH,
                 hostH: p.host.clientHeight };
    }""".replace('arguments_placeholder', repr(inst_type)), idx)


def axis_width(page, which, inst_type=None, idx=0):
    if which == 'main':
        return pane_js(page, "p => p.chart.priceScale('right').width()", idx)
    return pane_js(page, """p => {
        const inst = (p.indicators || []).find(i => i.type === INST);
        const sub = p._subs.get(inst.id);
        return sub.chart.priceScale('right').width();
    }""".replace('INST', repr(inst_type)), idx)


def logical_range(page, which, inst_type=None, idx=0):
    if which == 'main':
        return pane_js(page, "p => { const r = p.chart.timeScale().getVisibleLogicalRange(); return {f: r.from, t: r.to}; }", idx)
    return pane_js(page, """p => {
        const inst = (p.indicators || []).find(i => i.type === INST);
        const sub = p._subs.get(inst.id);
        const r = sub.chart.timeScale().getVisibleLogicalRange();
        return { f: r.from, t: r.to };
    }""".replace('INST', repr(inst_type)), idx)


def has_crosshair_label_px(page, inst_type, idx=0):
    """detect the native crosshair price label (bg #363a45) on a sub-chart's
    price-axis canvas — proves the horzLine label rendered in THAT pane"""
    return pane_js(page, """p => {
        const inst = (p.indicators || []).find(i => i.type === INST);
        const sub = p._subs.get(inst.id);
        const tds = sub.host.querySelectorAll('.tv-lightweight-charts td');
        if (tds.length < 3) return { ok: false, why: 'no tds' };
        const cvs = tds[2].querySelectorAll('canvas');
        if (!cvs.length) return { ok: false, why: 'no axis canvas' };
        const cv = cvs[cvs.length - 1];
        const ctx = cv.getContext('2d');
        let found = 0;
        try {
            const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
            for (let i = 0; i < d.length; i += 4) {
                if (Math.abs(d[i] - 54) < 6 && Math.abs(d[i+1] - 58) < 6 && Math.abs(d[i+2] - 69) < 6 && d[i+3] > 200) found++;
            }
        } catch (e) { return { ok: false, why: String(e) }; }
        return { ok: true, found };
    }""".replace('INST', repr(inst_type)), idx)


def overlay_alpha_at(page, x, y0, y1, idx=0):
    """any non-transparent overlay pixel in the vertical strip x, rows y0..y1?"""
    return pane_js(page, """p => {
        const cv = p.overlay, ctx = cv.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        const x = Math.round(X * dpr), y0 = Math.round(Y0 * dpr), y1 = Math.round(Y1 * dpr);
        const data = ctx.getImageData(x, y0, 1, y1 - y0).data;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 10) return true;
        return false;
    }""".replace('X', repr(x)).replace('Y0', repr(y0)).replace('Y1', repr(y1)), idx)
