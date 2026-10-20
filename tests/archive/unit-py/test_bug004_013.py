#!/usr/bin/env python3
"""BUG-004 + BUG-013 verification: watchlist Last/Spread live for ALL symbols.
Covers: panel-open batch subscribe, continuous updates while switching chart
symbols, spread = ask-bid, stale affordance, dash tooltip, close->unsubscribe,
reopen->resubscribe, row stability (no reorder)."""
import sys, time, threading, http.server, functools, json, subprocess, signal, os
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'src')
PORT = 8911
PROV = subprocess.Popen(['python3', os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'provider', 'demo.py')],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
time.sleep(1.5)

def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start()

results = []
def check(name, ok, info=''):
    results.append((name, ok, info))
    print(('PASS' if ok else 'FAIL'), '-', name, ('| ' + str(info) if info else ''))

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1000)
    pg.click('#card-demo'); pg.click('#login-connect')
    pg.wait_for_timeout(5000)

    # open the watchlist panel (fresh profiles restore it open by default —
    # showTab TOGGLES, so loop until Watchlist.open is actually true)
    pg.evaluate("""() => {
      let guard = 0;
      while (!window.__app.Watchlist.open && guard++ < 3) window.__app.RightPanel.showTab('watchlist');
    }""")
    pg.wait_for_timeout(4000)
    opened = pg.evaluate("() => window.__app.Watchlist.open")
    check('0 watchlist panel open', opened == True, f'open={opened}')

    rows = pg.evaluate("""() => {
      const out = [];
      for (const r of document.querySelectorAll('.wl-row:not(.wl-head)')) {
        const sym = r.dataset.sym;
        const price = r.querySelector('.wl-price').textContent.trim();
        const sprd = r.querySelector('.wl-sprd').textContent.trim();
        const sprdTt = r.querySelector('.wl-sprd').title || '';
        out.push({ sym, price, sprd, sprdTt });
      }
      return out;
    }""")
    check('1 all rows live Last (no dashes)', rows and all(r['price'] not in ('', '\u2014', '-') for r in rows),
          json.dumps(rows[:2]) + f'... ({len(rows)} rows)')
    check('2 spread numeric on every row', all(_re_num(r['sprd']) for r in rows) if (_re_num := (lambda s: s.replace('.', '', 1).isdigit())) else False,
          [r['sprd'] for r in rows])

    # spread == ask - bid within rounding
    sp = pg.evaluate("""() => {
      let ok = 0, n = 0;
      for (const sym of Object.keys(Watchlist.ba)) {
        const ba = Watchlist.ba[sym];
        const el = document.querySelector(`.wl-row[data-sym="${sym}"] .wl-sprd`);
        if (!el) continue;
        n++;
        /* R25: the cell shows the spread in POINTS (integer) —
           round((ask-bid) / 10^-digits), per the user's round-25 report.
           The raw price-unit format this test asserted before is gone. */
        const real = ba.ask - ba.bid;
        const txt = el.textContent.trim();
        const dg = (App.feed.digitsBySym || {})[sym] != null ? App.feed.digitsBySym[sym] : 5;
        const expect = String(Math.max(1, Math.round(real / Math.pow(10, -dg))));
        if (txt === expect && txt.indexOf('.') < 0) ok++;
      }
      return { ok, n };
    }""")
    check('3 spread == ask-bid in POINTS (integer, R25 format)', sp['n'] >= 3 and sp['ok'] == sp['n'], sp)

    # live update: capture prices, wait, compare
    v1 = pg.evaluate("() => JSON.stringify(Watchlist.prices)")
    pg.wait_for_timeout(3500)
    v2 = pg.evaluate("() => JSON.stringify(Watchlist.prices)")
    changed = pg.evaluate("""(a) => {
      const A = JSON.parse(a[0]), B = JSON.parse(a[1]);
      let ch = 0;
      for (const k of Object.keys(B)) if (A[k] !== undefined && B[k] !== A[k]) ch++;
      return { ch, total: Object.keys(B).length };
    }""", [v1, v2])
    check('4 ALL rows keep ticking (live updates)', changed['ch'] >= max(1, changed['total'] - 2), changed)

    # click a different row -> chart switches, ALL rows still tick
    order1 = pg.evaluate("() => [...document.querySelectorAll('.wl-row:not(.wl-head)')].map(r => r.dataset.sym)")
    target = order1[2] if order1[0] == 'EURUSD' else order1[0]
    pg.evaluate(f"""() => {{
      const row = document.querySelector('.wl-row[data-sym="{target}"]');
      row.click();
    }}""")
    pg.wait_for_timeout(2500)
    symNow = pg.evaluate("() => window.__app.App.activePane.symbol")
    check('5 click row switches chart symbol', symNow == target, f"{symNow} == {target}")
    v3 = pg.evaluate("() => JSON.stringify(Watchlist.prices)")
    pg.wait_for_timeout(3500)
    v4 = pg.evaluate("() => JSON.stringify(Watchlist.prices)")
    changed2 = pg.evaluate("""(a) => {
      const A = JSON.parse(a[0]), B = JSON.parse(a[1]);
      let ch = 0;
      for (const k of Object.keys(B)) if (A[k] !== undefined && B[k] !== A[k]) ch++;
      return { ch, total: Object.keys(B).length };
    }""", [v3, v4])
    check('6 after symbol switch: all rows STILL ticking (BUG-013 core)', changed2['ch'] >= max(1, changed2['total'] - 2), changed2)

    # row stability (no reorder)
    order2 = pg.evaluate("() => [...document.querySelectorAll('.wl-row:not(.wl-head)')].map(r => r.dataset.sym)")
    check('7 rows never reorder', json.dumps(order1) == json.dumps(order2), order2)

    # close panel -> unsubscribe all except the chart symbol (refcounted).
    # Wait out the in-flight straggler ticks first, then measure a clean window.
    pg.evaluate("""() => {
      window.__seen = new Set();
      App.feed.onTick.push((sym) => window.__seen.add(sym));
      if (window.__app.Watchlist.open) window.__app.RightPanel.close();
      return true;
    }""")
    pg.wait_for_timeout(1200)  # let pre-unsubscribe in-flight ticks flush
    pg.evaluate("() => window.__seen.clear()")
    pg.wait_for_timeout(3500)
    seenSyms = pg.evaluate("() => [...window.__seen]")
    check('8 panel close: only the chart symbol keeps ticking (others unsubscribed)',
          seenSyms == ['USDJPY'], seenSyms)

    # reopen -> resubscribe, rows live again
    pg.evaluate("""() => {
      let guard = 0;
      while (!window.__app.Watchlist.open && guard++ < 3) window.__app.RightPanel.showTab('watchlist');
    }""")
    pg.wait_for_timeout(4000)
    v5 = pg.evaluate("() => JSON.stringify(Watchlist.prices)")
    pg.wait_for_timeout(3500)
    v6 = pg.evaluate("() => JSON.stringify(Watchlist.prices)")
    changed3 = pg.evaluate("""(a) => {
      const A = JSON.parse(a[0]), B = JSON.parse(a[1]);
      let ch = 0;
      for (const k of Object.keys(B)) if (A[k] !== undefined && B[k] !== A[k]) ch++;
      return { ch, total: Object.keys(B).length };
    }""", [v5, v6])
    check('9 reopen: all rows live again', changed3['ch'] >= max(1, changed3['total'] - 2), changed3)

    # stale affordance + dash tooltip (forced)
    st = pg.evaluate("""() => {
      const sym = App.watchlist[0];
      Watchlist._lastTickAt[sym] = Date.now() - 40000; // no ticks for 40s
      Watchlist.updateRow(sym);
      const row = document.querySelector(`.wl-row[data-sym="${sym}"]`);
      const priceEl = row.querySelector('.wl-price');
      const out = { stale: priceEl.classList.contains('stale'), title: row.title };
      // dash + tooltip when bid/ask truly absent
      const keep = Watchlist.ba[sym];
      delete Watchlist.ba[sym];
      if (Manager.tickBA) delete Manager.tickBA[sym];
      Watchlist.updateRow(sym);
      const sprdEl = row.querySelector('.wl-sprd');
      out.dash = sprdEl.textContent.trim();
      out.dashTt = sprdEl.title;
      Watchlist.ba[sym] = keep;
      return out;
    }""")
    check('10 stale state dims price + tooltip', st['stale'] == True and 'no ticks' in st['title'], st)
    check('11 no bid/ask => dash WITH tooltip (never silent)', st['dash'] == '\u2014' and 'bid/ask' in st['dashTt'], st)

    pg.screenshot(path='/home/z/my-project/download/bug004-013-after-fix.png')
    check('12 no page errors', len(errs) == 0, '; '.join(errs[:3]))
    b.close()

try: os.killpg(os.getpgid(PROV.pid), signal.SIGTERM)
except Exception: pass

fails = [r for r in results if not r[1]]
print(f"\n==== {len(results) - len(fails)}/{len(results)} passed ====")
sys.exit(1 if fails else 0)
