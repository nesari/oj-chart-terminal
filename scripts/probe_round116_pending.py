#!/usr/bin/env python3
"""ROUND116 probe — establish the live facts before fixing:
  [1] does a placed pending order land in Trade.orders (state poll)?
  [2] does the chart overlay draw the pending lines?
  [3] do the pending lines SURVIVE a chart-style switch (suspected bug)?
  [4] does hover fire THROUGH the floating panel (suspected bug)?
"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = '/home/z/my-project/mt5-terminal'
PORT_HTTP, PORT_WS = 8905, 8777

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

def main():
    threading.Thread(target=serve_http, daemon=True).start()
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        assert wait_port(PORT_HTTP) and wait_port(PORT_WS)
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            b = pw.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            pg = b.new_page(viewport={'width': 1600, 'height': 900})
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            pg.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            pg.wait_for_selector('#login-connect', timeout=15000)
            pg.click('#login-connect')
            pg.wait_for_selector('#app:not(.hidden)', timeout=20000)
            pg.wait_for_selector('#charts-grid canvas', timeout=20000)
            pg.wait_for_timeout(2000)

            print('== [1] place a BUY_LIMIT 150 pts below the market ==')
            pg.evaluate("""() => {
              const App = window.__app.App, T = window.__app.Trade;
              const sym = App.panes[0].symbol;
              const s = T.specSync(sym) || {};
              const q = T.quote(sym) || {};
              const px = Number((((q.bid || s.bid) || 1) - 150 * (s.point || 0.00001)).toFixed(5));
              window.__px = px;
              return T.placeOrder({ symbol: sym, orderType: 2, volume: 0.02, price: px,
                sl: 0, tp: 0, deviation: 20, comment: 'r116' });
            }""")
            pg.wait_for_timeout(3000)   # 2+ state polls
            st = pg.evaluate("""() => {
              const App = window.__app.App, T = window.__app.Trade, O = window.__app.TradeOverlay;
              const lines = (O._state ? O._state(App.panes[0]) : { lines: [] }).lines.map(l => l.kind + ':' + l.ticket);
              return {
                orders: T.orders.map(o => ({ ticket: o.ticket, type: o.type, price: o.price, symbol: o.symbol })),
                px: window.__px,
                overlayLines: lines,
              };
            }""")
            print('  Trade.orders:', st['orders'])
            print('  overlay lines:', st['overlayLines'])

            print('== [2] dock tabs: Orders rows vs Positions rows ==')
            for tab in ('orders', 'positions'):
                pg.evaluate(f"() => {{ const d = window.__app.TradeDock; d.show(); d._tab = '{tab}'; d._render(); }}")
                pg.wait_for_timeout(300)
                n = pg.evaluate(f"() => document.querySelectorAll('#td-{tab if tab != 'orders' else 'ord'} .td-item, #td-{tab if tab != 'orders' else 'ord'} .td-h2item').length")
                print(f'  {tab} tab rows:', n)

            print('== [3] chart-style switch kills trade lines? ==')
            pg.evaluate("() => window.__app.Trade.placeOrder({ symbol: window.__app.App.panes[0].symbol, orderType: 0, volume: 0.02, price: 0, deviation: 20, comment: 'r116m' })")
            pg.wait_for_timeout(3000)
            cnt = lambda: pg.evaluate("() => window.__app.TradeOverlay._state(window.__app.App.panes[0]).lines.length")
            print('  lines with candles:', cnt())
            pg.evaluate("() => window.__app.Manager.setStyle(window.__app.App.panes[0], 'line')")
            pg.wait_for_timeout(1200)
            print('  lines after switch to line:', cnt())
            pg.evaluate("() => window.__app.Manager.setStyle(window.__app.App.panes[0], 'candles')")
            pg.wait_for_timeout(1200)
            print('  lines after back to candles:', cnt())

            print('== [4] hover through the floating panel? ==')
            # geometry: find a trade line Y + the panel rect
            geo = pg.evaluate("""() => {
              const App = window.__app.App, O = window.__app.TradeOverlay;
              const pane = App.panes[0];
              const st = O._state(pane);
              if (!st.lines.length) return null;
              const l = st.lines[0];
              const y = pane.series.priceToCoordinate(l.price);
              const r = pane.root.getBoundingClientRect();
              const panel = pane.root.querySelector('.oc-panel');
              const pr = panel ? panel.getBoundingClientRect() : null;
              return { y: y + r.top, rootTop: r.top, panel: pr ? { x: pr.x + pr.width / 2, y: pr.y + pr.height / 2 } : null };
            }""")
            print('  geo:', geo)
            if geo and geo['panel']:
                # park the mouse at the CENTER of the floating panel (a line may or may not be behind)
                pg.mouse.move(geo['panel']['x'], geo['panel']['y'])
                pg.wait_for_timeout(300)
                tip = pg.evaluate("""() => {
                  const pane = window.__app.App.panes[0];
                  const t = pane._tradeTip;
                  return t ? { display: t.style.display, html: t.innerHTML.slice(0, 60) } : null;
                }""")
                print('  tip state while over the panel:', tip)

            print('  page errors:', errs[:3])
            b.close()
    finally:
        prov.terminate()

if __name__ == '__main__':
    main()
