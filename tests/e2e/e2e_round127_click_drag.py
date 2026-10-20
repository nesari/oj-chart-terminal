#!/usr/bin/env python3
"""ROUND127 e2e — trade lines answer ONLY to Click+drag&drop (user fix 5).

Boots the demo broker + renderer, injects a demo-shaped position so the
overlay draws the entry/SL/TP lines on the live chart, then:

 [1] a BARE CLICK (down + up, 2px jitter) on the TP line sends NOTHING:
     no modifySLTP/modifyOrder call, no toast, the line keeps its price
     (the TP sits above the docked Tool Box, which covers the chart's
     lower band — its own window chrome, like MT5's panel)
 [2] the same bare click on the ENTRY line does nothing (no ghost line
     appears, no order)
 [3] a REAL Click+drag&drop on the TP line (down, 40px of travel, up)
     moves the line and calls modifySLTP ONCE with the dropped price and
     the position's SL preserved
 [4] zero page errors across the whole run

Exits 0 only if every check passes.
"""
import http.server, functools, os, socket, subprocess, sys, threading, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PORT_HTTP, PORT_WS = 8933, 8777
FAILS = []
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def check(name, cond, extra=''):
    print(('  ✓ ' if cond else '  ✗ ') + name + ((' — ' + str(extra)) if (not cond and extra != '') else ''))
    if not cond:
        FAILS.append(name)

def wait_port(port, timeout=20):
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

INJECT = """
() => {
  const A = window.__app;
  const pane = A.App.panes[0];
  const sym = pane.symbol;
  const q = A.TradeRoute.quote(sym) || {};
  const bid = q.bid || 2000;
  /* ROUND214: demo history is live-anchored, so fixed ±% offsets drift
     off-screen with wall clock (an invisible line can't be grabbed — the
     mousedown lands on whatever covers that pixel). Anchor SL/TP inside
     the visible range instead: ±15% of the recent high-low span. */
  const tail = pane.bars.slice(-120);
  let hi = -Infinity, lo = Infinity;
  for (const b of tail) {
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  if (!isFinite(hi) || !isFinite(lo) || hi <= lo) { hi = bid * 1.01; lo = bid * 0.99; }
  const dg = 5;
  const fake = {
    ticket: 777001, time: Math.floor(Date.now() / 1000) - 300, type: 0,
    volume: 0.10, open: bid,
    sl: Number((bid - 0.15 * (bid - lo)).toFixed(dg)),
    tp: Number((bid + 0.15 * (hi - bid)).toFixed(dg)),
    current: bid, swap: 0, profit: 0, symbol: sym, comment: 'e2e',
  };
  /* the 1.2s state poll REPLACES Trade.positions wholesale — pin the fake
     row for the test's lifetime (harness-only shim) */
  Object.defineProperty(A.Trade, 'positions', { configurable: true, get: () => [fake], set: () => {} });
  window.__sent = [];
  A.Trade.modifySLTP = (t, sl, tp) => { window.__sent.push(['sltp', t, sl, tp]); return Promise.resolve(); };
  A.Trade.modifyOrder = (t, p, sl, tp) => { window.__sent.push(['order', t, p, sl, tp]); return Promise.resolve(); };
  try { for (const fn of A.Trade.onChange) { try { fn(); } catch (e) {} } } catch (e) {}
  A.TradeOverlay.sync();
  const st = A.TradeOverlay._map.get(pane);
  const r = A.TradeOverlay._lwcRect(pane);
  const sl = st.lines.find((l) => l.kind === 'sl');
  const en = st.lines.find((l) => l.kind === 'entry');
  const tp = st.lines.find((l) => l.kind === 'tp');
  return {
    sym, rect: { left: r.left, top: r.top },
    slY: pane.series.priceToCoordinate(sl.price), slPrice: sl.price,
    enY: pane.series.priceToCoordinate(en.price),
    tpY: pane.series.priceToCoordinate(tp.price), tpPrice: tp.price,
    nLines: st.lines.length,
  };
}
"""

def main():
    threading.daemon = True
    t = threading.Thread(target=serve_http, daemon=True)
    t.start()
    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not (wait_port(PORT_HTTP) and wait_port(PORT_WS)):
        print('http/provider did not come up'); return 1
    ok = True
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
            except Exception:
                browser = p.chromium.launch(channel='chrome', args=['--no-sandbox', '--disable-dev-shm-usage'])
            page = browser.new_page(viewport={'width': 1500, 'height': 880})
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            page.wait_for_timeout(900)
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=20000)
            page.wait_for_timeout(900)

            info = page.evaluate(INJECT)
            page.wait_for_timeout(400)
            check('overlay built entry+SL+TP lines for the injected position',
                  info['nLines'] >= 3, str(info['nLines']))
            # ROUND214: the TP line must be ON-SCREEN (an invisible line eats
            # the mousedown at whatever covers that pixel — fail fast here).
            vis = page.evaluate("""() => {
              const A = window.__app; const pane = A.App.panes[0];
              const st = A.TradeOverlay._map.get(pane);
              const l = st.lines.find((x) => x.kind === 'tp');
              const r = A.TradeOverlay._lwcRect(pane);
              const y = pane.series.priceToCoordinate(l.price);
              return { y, h: r.height, onscreen: y >= 0 && y <= r.height };
            }""")
            check('TP line on screen before dragging', vis['onscreen'], vis)
            sl_x = info['rect']['left'] + 320

            def line_y(kind):
                """fresh screen Y of a trade line — the live scale re-fits on
                every tick, so the position MUST be re-read per gesture"""
                return page.evaluate("""
                (kind) => {
                  const A = window.__app; const pane = A.App.panes[0];
                  const st = A.TradeOverlay._map.get(pane);
                  const l = st.lines.find((x) => x.kind === kind);
                  return A.TradeOverlay._lwcRect(pane).top + pane.series.priceToCoordinate(l.price);
                }""", kind)

            print('— [1] bare click on the TP line (2px jitter) does NOTHING —')
            page.mouse.move(sl_x, line_y('tp'))
            page.mouse.down()
            page.mouse.move(sl_x + 2, line_y('tp') + 1, steps=2)   # sub-threshold jitter
            page.mouse.up()
            page.wait_for_timeout(400)
            sent = page.evaluate('() => window.__sent')
            check('no order left the app', len(sent) == 0, str(sent))
            toasts = page.evaluate("() => document.querySelectorAll('.toast').length")
            check('no toast appeared', toasts == 0, str(toasts))
            tp_price_now = page.evaluate("""
            () => {
              const A = window.__app; const pane = A.App.panes[0];
              const st = A.TradeOverlay._map.get(pane);
              return st.lines.find((l) => l.kind === 'tp').price;
            }""")
            check('the TP line keeps its original price', abs(tp_price_now - info['tpPrice']) < 1e-9,
                  f"{tp_price_now} vs {info['tpPrice']}")

            print('— [2] bare click on the ENTRY line does NOTHING —')
            page.mouse.move(sl_x, line_y('entry'))
            page.mouse.down()
            page.mouse.move(sl_x - 1, line_y('entry') + 2, steps=2)
            page.mouse.up()
            page.wait_for_timeout(400)
            sent = page.evaluate('() => window.__sent')
            check('no order left the app (entry click)', len(sent) == 0, str(sent))
            ghosts = page.evaluate("""
            () => {
              const A = window.__app; const pane = A.App.panes[0];
              const st = A.TradeOverlay._map.get(pane);
              return st.lines.length;
            }""")
            check('no ghost line got added by the click', ghosts == info['nLines'], str(ghosts))

            print('— [3] Click+drag&drop on the TP line MOVES it and sends ONE modify —')
            y0 = line_y('tp')
            page.mouse.move(sl_x, y0)
            page.mouse.down()
            for i in range(1, 9):   # 40px of real travel upward in steps
                page.mouse.move(sl_x, y0 - 5 * i, steps=1)
            page.mouse.up()
            page.wait_for_timeout(500)
            sent = page.evaluate('() => window.__sent')
            check('exactly one modifySLTP was sent', len(sent) == 1 and sent[0][0] == 'sltp', str(sent))
            # behavioral proof of the drag: the dropped price sits strictly
            # ABOVE the original TP (40px of upward travel re-priced it) and
            # the position's own SL rides along untouched (sent[0][2]). The
            # on-chart line re-syncs from the (stubbed) account state, so its
            # post-drop price is not a stable assertion target.
            check('the drop re-priced the line ABOVE the original TP (real travel)',
                  len(sent) == 1 and sent[0][3] > info['tpPrice'] and (sent[0][3] - info['tpPrice']) > 0.0005,
                  f"dropped={sent[0][3] if sent else None} orig={info['tpPrice']}")
            check('the SL component stayed the position\'s own',
                  len(sent) == 1 and abs(sent[0][2] - info['slPrice']) < 1e-9,
                  f"sent SL={sent[0][2] if sent else None} pos SL={info['slPrice']}")
            check('zero page errors', len(errors) == 0, str(errors[:3]))
            browser.close()
    finally:
        try:
            prov.terminate(); prov.wait(timeout=5)
        except Exception:
            pass
    print('E2E', 'PASS' if not FAILS else 'FAIL')
    return 0 if not FAILS else 1

if __name__ == '__main__':
    raise SystemExit(main())
