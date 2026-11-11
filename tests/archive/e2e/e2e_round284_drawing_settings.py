#!/usr/bin/env python3
"""ROUND284 e2e — drawing-tool settings parity, live.

Opens the REAL settings dialog for every tool that ROUND284 touched and checks
the controls are actually rendered and wired (not just present in the schema
text): the field must exist in the DOM, and toggling it must change d.opts.

Also paints the filled shapes on a stub canvas to prove the new Background
defaults do not change their look until the user opts in.

Zero page errors.

Run: python tests/archive/e2e/e2e_round284_drawing_settings.py
"""
import http.server, functools, os, socket, subprocess, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_teardown import kill_proc  # ROUND288: whole-tree cleanup on Windows

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8967, 8856
FAILS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def check(name, cond, extra=''):
    print(('  ok ' if cond else '  FAIL ') + name + ((' - ' + str(extra)) if (not cond and extra != '') else ''))
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
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.join(ROOT, 'src'))
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT_HTTP), handler).serve_forever()


# Open the dialog for one tool and report what the Style tab really contains.
DLG_JS = """(arg) => {
  const id = arg[0], npt = arg[1];
  const A = window.__app;
  const pts = [];
  for (let i = 0; i < npt; i++) pts.push({ t: 100 + i * 100, p: 100 + i * 10 });
  const d = { type: id, points: pts, opts: {} };
  A.DrawSettings.open(A.App.activePane, d);
  const dlg = document.querySelector('#draw-settings-dialog');
  if (!dlg) return { open: false };
  const txt = dlg.textContent || '';
  /* every labelled row in the Style tab */
  const rows = [...dlg.querySelectorAll('.ds-row')].map((r) => (r.textContent || '').trim());
  const checks = dlg.querySelectorAll('.ds-check').length;
  const sels = dlg.querySelectorAll('.st-sel').length;
  const nums = dlg.querySelectorAll('.st-num').length;
  const sliders = dlg.querySelectorAll('input[type=range]').length;
  const colors = dlg.querySelectorAll('.st-color').length;
  const emoji = dlg.querySelectorAll('.ds-emoji-grid').length;
  /* The Background row is a `.st-check` span INSIDE the row that also holds the
     colour swatch; buildFill binds the toggle on the ROW (ignoring clicks on
     the swatch), so click the row and watch opts.fill. */
  let toggled = null;
  const firstFill = dlg.querySelector('.st-check');
  if (firstFill) {
    const row = firstFill.closest('.ds-row') || firstFill.parentElement;
    const before = JSON.stringify(d.opts.fill);
    row.click();
    const after = JSON.stringify(d.opts.fill);
    toggled = { before, after, changed: before !== after };
  }
  const x = dlg.querySelector('.dlg-x');
  if (x) x.click();
  return { open: true, text: txt, rows, checks, sels, nums, sliders, colors, emoji, toggled };
}"""

# Does the tool actually PAINT a fill when asked (and stay plain when not)?
FILL_JS = """(arg) => {
  const id = arg[0], npt = arg[1];
  const A = window.__app;
  const T = A.DrawTools;
  const tool = T[id];
  const pts = [];
  for (let i = 0; i < npt; i++) pts.push({ t: 100 + i * 100, p: 100 + i * 10 });
  const mk = () => {
    const calls = { fills: 0, strokes: 0 };
    const noop = () => {};
    const ctx = new Proxy({
      canvas: { width: 400, height: 300 },
      save: noop, restore: noop, beginPath: noop, closePath: noop,
      moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
      arc: noop, ellipse: noop, rect: noop, roundRect: noop, translate: noop, rotate: noop,
      fill: () => { calls.fills++; },
      stroke: () => { calls.strokes++; },
      fillRect: () => { calls.fills++; },
      strokeRect: () => { calls.strokes++; },
      measureText: () => ({ width: 40 }),
      setLineDash: noop,
      fillText: noop, strokeText: noop,
      createLinearGradient: () => ({ addColorStop: noop }),
    }, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && /^(fillStyle|strokeStyle|lineWidth|globalAlpha|font|textAlign|textBaseline|lineCap|lineJoin|shadowColor|shadowBlur)$/.test(k) ? undefined : undefined)), set: () => true });
    return { ctx, calls };
  };
  const V = (ctx) => ({
    ctx, pw: 400, ph: 300, digits: 5, times: [],
    xOf: (t) => (t - 100) * 0.5, yOf: (p) => 300 - (p - 100),
    clampY: (y) => y, theme: (k) => '#999',
  });
  const draw = (fill) => {
    const { ctx, calls } = mk();
    try { tool.draw(V(ctx), { points: pts, opts: { fill, fillColor: '#00ff00', fillOpacity: 0.3, color: '#2962ff', width: 2, style: 'solid' } }, false); }
    catch (e) { return { error: String(e && e.message) }; }
    return calls;
  };
  return { on: draw(true), off: draw(false) };
}"""


def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up')
        kill_proc(prov)
        return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1560, 'height': 900})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_function(
                "() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100",
                timeout=25000)
            page.wait_for_function("() => window.__app.DrawSettings && window.__app.DrawTools", timeout=30000)

            print('  -- A. every tool exposes its own Style tab --')
            # (tool, points, a label that MUST appear in the Style tab)
            # NOTE: most of these already had a schema via `SCHEMAS.x = [...]`;
            # the audit's first pass missed that. They are still checked here
            # because the labels prove the REAL dialog renders them.
            TOOLS = [
                ('measure', 2, 'Show arrows'),
                ('measure', 2, 'Show info label'),
                ('callout', 2, 'Background'),
                ('callout', 2, 'Font size'),
                ('emoji', 1, 'Size'),
                ('flagmark', 1, 'Size'),
                ('arrowmarker', 2, 'Size'),
                ('circle', 2, 'Background'),
                ('curve', 3, 'Background'),
                ('dblcurve', 4, 'Background'),
                ('polyline', 3, 'Background'),
                ('rotrect', 3, 'Background'),
                ('zoomin', 2, 'Border opacity'),
                ('arc', 4, 'Line'),
                ('path', 3, 'Line'),
            ]
            seen = {}
            for tid, npt, label in TOOLS:
                r = page.evaluate(DLG_JS, [tid, npt])
                if not r.get('open'):
                    check(f'{tid}: dialog opens', False)
                    continue
                seen.setdefault(tid, r)
                check(f'{tid}: Style tab shows "{label}"', label in (r.get('text') or ''),
                      str(r.get('rows'))[:160])

            print('  -- B. the controls are real widgets, not just text --')
            m = seen.get('measure') or {}
            check('measure: has white check toggles and a slider',
                  (m.get('checks') or 0) >= 2 and (m.get('sliders') or 0) >= 1, m)
            e = seen.get('emoji') or {}
            check('emoji: renders a glyph picker grid', (e.get('emoji') or 0) >= 1, e)
            check('emoji: has a numeric size field', (e.get('nums') or 0) >= 1, e)
            z = seen.get('zoomin') or {}
            check('zoomin: has a border-opacity slider and a background row',
                  (z.get('sliders') or 0) >= 1 and 'Background' in (z.get('text') or ''), z)
            for tid in ('circle', 'curve', 'dblcurve', 'polyline', 'rotrect', 'callout', 'flagmark', 'zoomin'):
                rr = seen.get(tid) or {}
                check(f'{tid}: has a colour swatch', (rr.get('colors') or 0) >= 1, rr)

            print('  -- C. clicking the Background toggle really changes the drawing --')
            for tid in ('circle', 'polyline', 'curve', 'dblcurve', 'rotrect', 'callout'):
                rr = seen.get(tid) or {}
                tg = rr.get('toggled') or {}
                check(f'{tid}: first toggle writes opts', tg.get('changed') is True, tg)

            print('  -- D. the fill actually reaches the painter --')
            for tid, npt in (('circle', 2), ('polyline', 3), ('curve', 3), ('dblcurve', 4), ('rotrect', 3)):
                f = page.evaluate(FILL_JS, [tid, npt])
                on, off = f.get('on') or {}, f.get('off') or {}
                check(f'{tid}: paints a fill when on', (on.get('fills') or 0) > 0, f)
                check(f'{tid}: paints none when off', (off.get('fills') or 0) == 0, f)

            print('  -- E. TV Box Extend has all four states --')
            r = page.evaluate(DLG_JS, ['rect', 2])
            opts = page.evaluate("""() => {
              const A = window.__app;
              A.DrawSettings.open(A.App.activePane, { type: 'rect', points: [{t:100,p:100},{t:200,p:200}], opts: {} });
              const dlg = document.querySelector('#draw-settings-dialog');
              const sel = dlg ? dlg.querySelector('.st-sel') : null;
              const vals = sel ? [...sel.options].map((o) => o.value) : [];
              if (dlg) dlg.querySelector('.dlg-x').click();
              return vals;
            }""")
            check('rect: Extend offers none/left/right/both',
                  opts == ['none', 'left', 'right', 'both'], opts)

            check('zero page errors', len(errors) == 0, errors[:3])
            browser.close()
    finally:
        kill_proc(prov)
    print('ROUND284: %d failed' % len(FAILS) if FAILS else 'ROUND284: all green')
    return 1 if FAILS else 0


if __name__ == '__main__':
    sys.exit(main())
