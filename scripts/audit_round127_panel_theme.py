#!/usr/bin/env python3
"""ROUND127 audit — the floating Trade panel in DARK and LIGHT mode.

Boots the app over http (?mode=demo, no provider), injects a fake demo
position so every section of the panel is populated, then for BOTH themes:
  · screenshots the pane (panel fully visible)
  · dumps the computed color/background/border of every visible .oc-* part
  · runs a text-contrast check (WCAG-ish 3.0 ratio) over text-bearing
    elements inside the panel — flags anything unreadable

Exits 0 when no low-contrast text node is found in either theme.
"""
import time, http.server, functools, os, socket, json, subprocess, sys, threading

ROOT = '/home/z/my-project/upload/mt5-app'
PORT_HTTP, PORT_WS = 8931, 8777  # 8777 = the demo provider's fixed WS port
SHOTS = '/home/z/my-project/scripts/shots'
FAILS = []

def wait_port(port, timeout=15):
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

AUDIT_JS = """
() => {
  const lum = (c) => {
    const m = c.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
    if (!m) return null;
    const a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (a < 0.85) return null; // translucent bg -> caller resolves against parent
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(+m[1]) + 0.7152 * f(+m[2]) + 0.0722 * f(+m[3]);
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const l = n instanceof Element ? lum(getComputedStyle(n).backgroundColor) : null;
      if (l != null) return l;
      n = n.parentElement;
    }
    return lum('rgb(255,255,255)');
  };
  const ratio = (a, b) => {
    if (a == null || b == null) return null;
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  };
  const panel = document.querySelector('.oc-panel');
  if (!panel) return { error: 'no panel' };
  const out = [];
  const parts = panel.querySelectorAll('*');
  for (const el of parts) {
    if (!(el instanceof HTMLElement)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const text = (el.childNodes.length && Array.from(el.childNodes)
      .some((n) => n.nodeType === 3 && n.textContent.trim())) ? el.textContent.trim().slice(0, 30) : '';
    if (!text) continue;
    const fg = lum(cs.color);
    const bg = bgOf(el);
    const r = ratio(fg, bg);
    out.push({ cls: el.className && el.className.baseVal === undefined ? String(el.className) : el.tagName,
               text, color: cs.color, bgc: cs.backgroundColor, ratio: r == null ? null : Math.round(r * 100) / 100 });
  }
  return out;
}
"""

def main():
    os.makedirs(SHOTS, exist_ok=True)
    threading.daemon = True
    t = threading.Thread(target=serve_http, daemon=True)
    t.start()
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up'); return 1

    from playwright.sync_api import sync_playwright
    errors = []
    try:
      with sync_playwright() as p:
        browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
        page = browser.new_page(viewport={'width': 1500, 'height': 880})
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
        page.wait_for_timeout(900)
        page.click('#login-connect')   # demo server — straight to the chart
        page.wait_for_selector('#app:not(.hidden)', timeout=20000)
        page.wait_for_selector('.pane-root .oc-panel', timeout=10000)
        page.wait_for_timeout(1200)

        # exercise EVERY section: position rows (½/🛡/× chips + P/L colors)
        # and an armed draft (the live status strip). The 1.2s state poll
        # rewrites Trade.positions, so the harness pins a stable fake row
        # through the route facade (test-only shim, restored implicitly when
        # the page dies).
        page.evaluate("""
        () => {
          const A = window.__app;
          const fake = {
            ticket: 900001, time: Math.floor(Date.now() / 1000) - 600, type: 0,
            volume: 0.37, open: 1.08450, sl: 1.08200, tp: 1.08950,
            current: 1.08610, swap: 0.42, profit: 27.93, symbol: A.App.panes[0].symbol, comment: 'audit',
          };
          const orig = A.TradeRoute.positions.bind(A.TradeRoute);
          A.TradeRoute.positions = () => [fake].concat(orig());
          const pane = A.App.panes[0];
          const st = A.OneClick._st(pane);
          if (st) { st.posSig = ''; try { A.OneClick._posRefresh(st); } catch (e) {} }
        }
        """)
        page.wait_for_timeout(700)
        page.click('.pane-root .oc-side.oc-buy')   # arm a draft (no order sent)
        page.wait_for_timeout(700)

        ok = True
        for theme in ('dark', 'light'):
            page.evaluate(f"() => window.__app.Theme.apply('{theme}')")
            page.wait_for_timeout(350)
            panel = page.query_selector('.pane-root .oc-panel')
            if panel and panel.is_visible():
                box = panel.bounding_box()
                page.screenshot(path=f'{SHOTS}/r127_panel_{theme}.png',
                    clip={'x': max(0, box['x'] - 14), 'y': max(0, box['y'] - 14),
                          'width': box['width'] + 28, 'height': box['height'] + 28})
            else:
                page.screenshot(path=f'{SHOTS}/r127_panel_{theme}.png')
            rows = page.evaluate(AUDIT_JS)
            if isinstance(rows, dict) and rows.get('error'):
                print(f'  ✗ {theme}: {rows["error"]}'); ok = False; continue
            bad = [r for r in rows if r['ratio'] is not None and r['ratio'] < 3.0]
            print(f'— {theme}: {len(rows)} text parts, {len(bad)} low-contrast')
            for r in bad:
                print(f'  ✗ [{theme}] .{r["cls"]} "{r["text"]}" color={r["color"]} bg={r["bgc"]} ratio={r["ratio"]}')
            if bad:
                ok = False
            with open(f'{SHOTS}/r127_panel_{theme}.json', 'w') as f:
                json.dump(rows, f, indent=1)

        browser.close()
        if errors:
            print('page errors:', errors[:5]); ok = False
    finally:
        try:
            prov.terminate(); prov.wait(timeout=5)
        except Exception:
            pass
    print('AUDIT', 'PASS' if ok else 'FAIL')
    return 0 if ok else 1

if __name__ == '__main__':
    raise SystemExit(main())
