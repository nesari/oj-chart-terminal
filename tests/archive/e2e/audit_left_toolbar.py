#!/usr/bin/env python3
"""Left-toolbar audit — every group, every flyout entry, every tool.

The user's report was "the tools on the left of the chart are incomplete".
This walks the REAL toolbar: opens each group's flyout, counts the sections
and tools it lists, checks every tool id resolves to a real TOOLS entry with
draw/handles/hitBody, and records anything broken or missing.

Run: python tests/archive/e2e/audit_left_toolbar.py
"""
import http.server, functools, json, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP, PORT_WS = 8987, 8876
FINDINGS = []

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def bug(area, issue, detail=''):
    FINDINGS.append({'area': area, 'issue': issue, 'detail': str(detail)[:400]})
    print('  BUG  [' + area + '] ' + issue + ((' - ' + str(detail)[:220]) if detail else ''))


def ok(area, what):
    print('  ok   [' + area + '] ' + what)


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


# Toolbar structure + integrity of every tool id it references.
STRUCT_JS = """() => {
  const A = window.__app;
  const UIm = A.UI || (A.DrawTools && null);
  const GROUPS = (A.UI && A.UI.GROUPS) || [];
  const T = A.DrawTools || {};
  const out = { groups: [], badTools: [], unreachable: [], missingImpl: [] };
  const seen = new Set();
  for (const g of GROUPS) {
    const ids = [];
    if (g.tools) for (const t of g.tools) ids.push(t);
    if (g.sections) for (const s of g.sections) for (const t of (s.tools || [])) ids.push(t);
    out.groups.push({ id: g.id, base: g.base || null, count: ids.length,
                      sections: (g.sections || []).map((s) => ({ title: s.title, n: (s.tools || []).length })) });
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const tool = T[id];
      if (!tool) { out.badTools.push(id); continue; }
      const hasImpl = typeof tool.draw === 'function' && typeof tool.handles === 'function'
        && typeof tool.hitBody === 'function' && typeof tool.dragHandle === 'function';
      if (!hasImpl) out.missingImpl.push(id);
    }
  }
  out.totalUnique = seen.size;
  /* tools registered but not reachable from ANY toolbar group */
  for (const id of Object.keys(T)) {
    if (!seen.has(id)) out.unreachable.push(id);
  }
  return out;
}"""

# Open every group's flyout and count the rendered items/sections.
FLYOUT_JS = """() => {
  const A = window.__app;
  const bar = document.getElementById('left-toolbar');
  const out = [];
  const btns = [...bar.querySelectorAll('.lt-btn[data-group]')];
  for (const b of btns) {
    const gid = b.dataset.group;
    /* a group with ONE tool activates it directly — no flyout, by design */
    const hasChev = !!b.querySelector('.chev');
    if (!hasChev) { out.push({ gid, single: true }); continue; }
    try { b.click(); } catch (e) { out.push({ gid, error: String(e && e.message || e) }); continue; }
    /* flyouts are popups in #popup-layer or an .lt-flyout element */
    /* openFlyout() builds a .lt-flyout of .lt-tile rows grouped by .lt-flysec */
    const fly = document.querySelector('.lt-flyout');
    const items = fly ? fly.querySelectorAll('.lt-tile').length : 0;
    const titles = fly ? [...fly.querySelectorAll('.lt-flysec')].map((e) => (e.textContent || '').trim()) : [];
    const names = fly ? [...fly.querySelectorAll('.tile-name')].map((e) => (e.textContent || '').trim()) : [];
    out.push({ gid, opened: !!fly, items, titles, names: names.slice(0, 4) });
    /* close it again (flyouts have their own closer) */
    try { A.Toolbar.closePopup(); } catch (e) {}
    const again = document.querySelector('.lt-flyout');
    if (again) again.remove();
  }
  return out;
}"""

# Draw one sample of every tool against real bars and record paint failures.
PAINT_ALL_JS = """() => {
  const A = window.__app;
  const pane = A.App.activePane;
  const T = A.DrawTools;
  const bars = pane.bars.slice(-120);
  const n = bars.length;
  const times = bars.map((b) => b.time);
  const P = (i) => ({ t: bars[i].time, p: bars[i].close });
  const fail = [];
  for (const id of Object.keys(T)) {
    const tool = T[id];
    if (!tool || typeof tool.draw !== 'function') continue;
    let pts;
    const k = tool.pts || 2;
    if (k <= 1) pts = [P(10)];
    else if (k === 2) pts = [P(10), P(60)];
    else if (k === 3) pts = [P(10), P(30), P(60)];
    else pts = [P(10), P(30), P(60), P(90)];
    let ops = { fills: 0, strokes: 0 };
    const noop = () => {};
    const ctx = new Proxy({
      font: '', save: noop, restore: noop, beginPath: noop, closePath: noop,
      moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
      arc: noop, ellipse: noop, rect: noop, roundRect: noop, translate: noop, rotate: noop, scale: noop,
      fill: () => { ops.fills++; }, stroke: () => { ops.strokes++; },
      fillRect: () => { ops.fills++; }, strokeRect: () => { ops.strokes++; },
      measureText: (s) => ({ width: String(s).length * 6 }),
      setLineDash: noop, fillText: noop, strokeText: noop, clip: noop,
      createLinearGradient: () => ({ addColorStop: noop }),
    }, { get: (t, kk) => (kk in t ? t[kk] : undefined), set: () => true });
    /* the production view (drawing/engine.js) exposes xOf/yOf AND the inverse
       tOf(); tools such as sineline need it, so the stub must match. */
    const xOf = (t) => (t - times[0]) / (times[n - 1] - times[0]) * 800 + 40;
    const tOf = (x) => times[0] + (x - 40) / 800 * (times[n - 1] - times[0]);
    const v = { ctx, pw: 900, ph: 500, digits: 5, spacing: 8, times, bars,
      xOf, tOf,
      yOf: (p) => 450 - (p - bars[0].low) / ((bars[n - 1].low ? (bars[n - 1].high - bars[0].low) : 1) || 1) * 400,
      clampY: (y) => y, theme: () => '#999' };
    try {
      tool.draw(v, { points: pts, opts: {} }, false);
    } catch (e) {
      fail.push({ id, error: String(e && e.message || e), stack: String(e && e.stack || '').split('\\n')[1] });
    }
  }
  return fail;
}"""


def main():
    threading.Thread(target=serve_http, daemon=True).start()
    env = dict(os.environ, MT5_WS_PORT=str(PORT_WS))
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up')
        prov.terminate()
        return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1600, 'height': 950})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html?ws=127.0.0.1:{PORT_WS}')
            page.wait_for_timeout(1000)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=45000)
            page.wait_for_function(
                "() => window.__app && window.__app.App.panes.length && window.__app.App.panes[0].bars.length > 100",
                timeout=45000)
            page.wait_for_timeout(800)

            print('\n=== toolbar structure ===')
            st = page.evaluate(STRUCT_JS)
            print('  groups: ' + str(len(st['groups'])) + ', unique tools on the bar: ' + str(st['totalUnique']))
            for g in st['groups']:
                secs = ', '.join(s['title'] + '=' + str(s['n']) for s in g['sections'])
                print('    ' + g['id'].ljust(14) + str(g['count']).rjust(3) + '  ' + secs)
            if st['badTools']:
                bug('left-toolbar', 'groups reference tools that do not exist', st['badTools'])
            else:
                ok('left-toolbar', 'every referenced tool id exists')
            if st['missingImpl']:
                bug('left-toolbar', 'tools missing a required method', st['missingImpl'])
            else:
                ok('left-toolbar', 'every tool implements draw/handles/hitBody/dragHandle')
            if st['unreachable']:
                bug('left-toolbar', 'registered tools not reachable from any group', st['unreachable'])
            else:
                ok('left-toolbar', 'no orphan tools')

            print('\n=== flyouts open + list their items ===')
            fl = page.evaluate(FLYOUT_JS)
            for f in fl:
                if f.get('single'):
                    ok('flyout:' + f['gid'], 'single-tool group activates directly (no flyout)')
                elif f.get('error'):
                    bug('flyout:' + f['gid'], 'click threw', f['error'])
                elif not f.get('opened'):
                    bug('flyout:' + f['gid'], 'no popup opened')
                elif f.get('items', 0) == 0:
                    bug('flyout:' + f['gid'], 'flyout rendered no items', f)
                else:
                    ok('flyout:' + f['gid'], str(f['items']) + ' tools, sections=' + str(f.get('titles')) + ', e.g. ' + str(f.get('names')))
            page.evaluate("() => { try { window.__app.Toolbar.closePopup(); } catch(e){} }")

            print('\n=== every tool paints without throwing ===')
            fails = page.evaluate(PAINT_ALL_JS)
            if fails:
                for f in fails:
                    bug('paint:' + f['id'], 'draw threw', f.get('error') + ' @ ' + str(f.get('stack')))
            else:
                ok('paint', 'all tools painted against real bars')

            print('\n=== page errors ===')
            if errors:
                for e in errors[:6]:
                    bug('page', 'uncaught error', e)
            else:
                ok('page', 'no uncaught errors')

            browser.close()
    finally:
        prov.terminate()

    print('\n============ LEFT TOOLBAR AUDIT ============')
    print('findings: ' + str(len(FINDINGS)))
    return 1 if FINDINGS else 0


if __name__ == '__main__':
    sys.exit(main())
