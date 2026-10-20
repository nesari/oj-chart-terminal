#!/usr/bin/env python3
"""debug — why did the outside-the-panel hover not fire the tag?"""
import subprocess, sys, time, threading, http.server, functools, os, socket

ROOT = '/home/z/my-project/mt5-terminal'
PORT_HTTP, PORT_WS = 8909, 8777

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
            pg.evaluate("""() => {
              const App = window.__app.App, T = window.__app.Trade;
              const sym = App.panes[0].symbol; window.__sym = sym;
              const s = T.specSync(sym) || {}, q = T.quote(sym) || {};
              const ask = q.ask || s.ask, pt = s.point || 0.00001;
              return T.placeOrder({ symbol: sym, orderType: 0, volume: 0.02, price: 0,
                sl: Number((ask - 60 * pt).toFixed(5)), tp: Number((ask + 60 * pt).toFixed(5)),
                deviation: 20, comment: 'dbg' });
            }""")
            pg.wait_for_timeout(2500)
            blocked = pg.evaluate("""() => {
              const pane = window.__app.App.panes[0], T = window.__app.Trade;
              const panel = pane.root.querySelector('.oc-panel');
              const pr = panel.getBoundingClientRect();
              const lwc = window.__app.TradeOverlay._lwcRect(pane);
              const s = T.specSync(window.__sym), q = T.quote(window.__sym);
              const ask = q.ask || s.ask, pt = s.point;
              for (const frac of [0.7, 0.5, 0.3, 0.85, 0.15]) {
                const cy = pr.top + pr.height * frac;
                const price = pane.series.coordinateToPrice(cy - lwc.top);
                if (price > ask + 21 * pt) return { price: Number(price.toFixed(5)),
                  panel: { l: pr.left, r: pr.right, t: pr.top, b: pr.bottom } };
              }
              return null;
            }""")
            print('blocked:', blocked)
            pg.evaluate(f"""() => window.__app.Trade.placeOrder({{ symbol: window.__sym,
              orderType: 4, volume: 0.02, price: {blocked['price']}, sl: 0, tp: 0,
              deviation: 20, comment: 'r116p' }})""")
            pg.wait_for_timeout(2600)
            ly = pg.evaluate("""() => {
              const pane = window.__app.App.panes[0];
              const st = window.__app.TradeOverlay._state(pane);
              const l = st.lines.find(l2 => l2.kind === 'order');
              let y = pane.series.priceToCoordinate(l.price);
              const r = window.__app.TradeOverlay._lwcRect(pane);
              return r.top + y;
            }""")
            lx = blocked['panel']['r'] + 220
            print('hover target:', lx, ly, 'panel:', blocked['panel'])
            pg.mouse.move(lx, ly)
            for i in range(10):
                pg.wait_for_timeout(300)
                s = pg.evaluate("""() => {
                  const pane = window.__app.App.panes[0];
                  const st = window.__app.TradeOverlay._state(pane);
                  const l = st.lines.find(l2 => l2.kind === 'order');
                  let y = null;
                  try { y = pane.series.priceToCoordinate(l.price); } catch (e) {}
                  const r = window.__app.TradeOverlay._lwcRect(pane);
                  const el = document.elementFromPoint(""" + str(lx) + """, r.top + y);
                  return { dwell: st.dwell ? st.dwell.key : null,
                           tipKey: st.tipKey,
                           tip: pane._tradeTip ? pane._tradeTip.style.display : 'absent',
                           lineY: r.top + y,
                           orders: window.__app.Trade.orders.length,
                           target: el ? (el.className || el.tagName).toString().slice(0, 40) : 'none' };
                }""")
                print(f'  t={i*0.3+0.3:.1f}s', s)
            print('errors:', errs[:2])
            b.close()
    finally:
        prov.terminate()

if __name__ == '__main__':
    main()
