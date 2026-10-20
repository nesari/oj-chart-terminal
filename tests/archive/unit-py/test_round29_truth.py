#!/usr/bin/env python3
"""Round 29 E2E — history/live truth mode (the "axis stuck at ~2.0" report):
  T1  boot clean: zero console errors, truth banner hidden on healthy data
  T2  payload logging: every loadBars logs a 'history loaded' entry (data cat)
  T3  poison x1: one mismatching load -> strike 1 + warning banner visible
  T4  poison x2: second consecutive mismatch -> poisoned flag + banner stays
  T5  reload choke: axisGuard with fresh ticks does NOT re-request the poisoned
      history (the old build looped the same corrupt reload forever)
  T6  diagnostics data-health row shows HISTORY≠LIVE in red
  T7  probe button: logs a 'probe' entry with the provider closes vs live tick
  T8  heal: restoring the real feed + reload resets strikes and hides the banner
  T9  regression: digits=5 chain, healthy depth, zero console errors overall
"""
import sys, time, threading, http.server, functools, json, subprocess, signal, os

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'src')
PROV = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'provider', 'demo.py')
PORT = 8991
OUT = '/home/z/my-project/download'
os.makedirs(OUT, exist_ok=True)

prov = subprocess.Popen(['python3', PROV], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=os.setsid)
time.sleep(1.5)

def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    h.log_message = lambda *a, **k: None
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), h)
    httpd.serve_forever()

threading.Thread(target=serve, daemon=True).start()
time.sleep(0.4)

results = []
def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(('PASS' if ok else 'FAIL'), name, '—', detail)

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch(args=['--window-size=1600,900'])
    pg = b.new_page(viewport={'width': 1600, 'height': 900})
    errors = []
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errors.append('PAGEERROR: ' + str(e)))
    pg.goto(f'http://127.0.0.1:{PORT}/renderer/index.html')
    pg.wait_for_timeout(1200)
    pg.click('#card-demo'); pg.click('#login-connect')
    pg.wait_for_timeout(9000)
    pg.evaluate("() => window.__app.Manager.setSymbol(window.__app.App.activePane, 'EURUSD')")
    pg.wait_for_timeout(2500)
    # NOTE: the truth checks run on the boot M1 series on purpose — the demo
    # provider's D1 tail rolls a fresh ~2.6%-sigma random bar per day, which
    # legitimately trips the banner (real MT5 always includes the FORMING bar
    # whose close tracks the live tick, so 0.5% is the right real-world tol).

    # ---- T1: clean boot, banner hidden ----
    t1 = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      return { sym: P.symbol, bars: P.bars.length, digits: P.digits,
               bannerHidden: P.histEl.classList.contains('hidden'),
               strike: P._histStrike, poisoned: P._histPoisonedAt };
    }""")
    check('T1 clean boot: banner hidden, healthy pane',
          t1['sym'] == 'EURUSD' and t1['bars'] >= 1000 and t1['digits'] == 5 and
          t1['bannerHidden'] and t1['strike'] == 0 and not t1['poisoned'], json.dumps(t1))

    # ---- T2: payload logging ----
    t2 = pg.evaluate("""() => {
      const ent = window.__app.Log.entries({ cat: 'data', search: 'history loaded' });
      const mine = ent.find(e => e.ctx && e.ctx.symbol === 'EURUSD' && e.ctx.tf === 'M1');
      return { n: ent.length, ok: !!(mine && mine.ctx.tf === 'M1' &&
               isFinite(mine.ctx.lastClose) && mine.ctx.bars >= 1000) };
    }""")
    check('T2 loadBars logs history payload', t2['n'] >= 1 and t2['ok'], json.dumps(t2))

    # ---- T3: poison strike 1 (wrong price universe, future-dated tail = no fold) ----
    pg.evaluate("""() => {
      const App = window.__app.App, M = window.__app.Manager, P = App.activePane;
      /* deterministic judgement window: clear any boot-time demo noise strikes */
      P._histStrike = 0; P._histMismatch = null; P._histPoisonedAt = 0;
      M.updateHistWarn(P);
      P.__realBars = App.feed.bars.bind(App.feed);
      const shift = 30 * 86400; // future-dated tail so live ticks cannot fold in
      const mk = () => P.bars.map(b => ({ time: b.time + shift,
        open: 1.99995, high: 1.99999, low: 1.99991, close: 1.99997, volume: 1 }));
      P.__mk = mk;
      App.feed.bars = async (sym, tf, cnt, to) => ({ symbol: sym, timeframe: tf, digits: 5,
        off: App.feed.serverOff, bars: mk() });
      M.loadBars(P);
    }""")
    pg.wait_for_timeout(1500)
    t3 = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      return { strike: P._histStrike, mismatch: !!P._histMismatch,
               bannerShown: !P.histEl.classList.contains('hidden'),
               poisoned: P._histPoisonedAt,
               txt: (P.histEl.querySelector('.hw-txt') || {}).textContent || '' };
    }""")
    check('T3 strike 1: mismatch + warning banner',
          t3['strike'] == 1 and t3['mismatch'] and t3['bannerShown'] and not t3['poisoned'] and
          '1.99997' in t3['txt'], json.dumps({k: t3[k] for k in ('strike', 'mismatch', 'bannerShown', 'poisoned')}))

    # ---- T4: poison strike 2 -> poisoned ----
    pg.evaluate("() => window.__app.Manager.loadBars(window.__app.App.activePane)")
    pg.wait_for_timeout(1500)
    t4 = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      const ent = window.__app.Log.entries({ cat: 'data', search: 'poisoned' });
      return { strike: P._histStrike, poisoned: P._histPoisonedAt > 0,
               bannerShown: !P.histEl.classList.contains('hidden'), logPoison: ent.length >= 1 };
    }""")
    check('T4 strike 2: poisoned flag + log', t4['strike'] >= 2 and t4['poisoned'] and t4['bannerShown'] and t4['logPoison'],
          json.dumps(t4))
    pg.screenshot(path=os.path.join(OUT, 'r29-truth-banner.png'))

    # ---- T5: reload choke under a fresh-tick guard ----
    t5 = pg.evaluate("""async () => {
      const App = window.__app.App, M = window.__app.Manager, P = App.activePane;
      const count = () => window.__app.Log.entries({ cat: 'data', search: 'history loaded' }).length;
      const before = count();
      for (let i = 0; i < 3; i++) { M.axisGuard(); await new Promise(r => setTimeout(r, 200)); }
      await new Promise(r => setTimeout(r, 2500)); // old build: guard reload fires here
      return { before, after: count(), bannerStill: !P.histEl.classList.contains('hidden') };
    }""")
    check('T5 choke: no history re-request while poisoned',
          t5['before'] == t5['after'] and t5['bannerStill'], json.dumps(t5))

    # ---- T6: data health row ----
    pg.evaluate("() => window.__app.RightPanel.showTab('diagnostics')")
    pg.wait_for_timeout(2600)  # 2s interval paints #dg-data
    t6 = pg.evaluate("""() => {
      const el = document.getElementById('dg-data');
      const row = el.querySelector('.dg-drow.bad');
      return { head: !!el.querySelector('.dg-dhead'), rows: el.querySelectorAll('.dg-drow').length,
               bad: !!row, sym: row ? row.querySelector('b').textContent : '',
               flag: row ? !!row.querySelector('em') : false };
    }""")
    check('T6 data health row red (HISTORY≠LIVE)',
          t6['head'] and t6['rows'] >= 1 and t6['bad'] and t6['sym'] == 'EURUSD' and t6['flag'], json.dumps(t6))

    # ---- T7: probe ----
    pg.click('#dg-probe')
    pg.wait_for_timeout(1800)
    t7 = pg.evaluate("""() => {
      const ent = window.__app.Log.entries({ cat: 'probe' });
      return { n: ent.length, ok: !!(ent.length && ent[ent.length - 1].msg.includes('live=') &&
               ent[ent.length - 1].msg.includes('last closes=[')) };
    }""")
    check('T7 probe logs closes vs live', t7['n'] >= 1 and t7['ok'], json.dumps(t7))

    # ---- T8: heal ----
    pg.evaluate("""() => {
      const App = window.__app.App, M = window.__app.Manager, P = App.activePane;
      App.feed.bars = P.__realBars;
      M.loadBars(P);
    }""")
    pg.wait_for_timeout(2500)
    t8 = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      const ent = window.__app.Log.entries({ cat: 'data', search: 'agreement restored' });
      return { strike: P._histStrike, poisoned: P._histPoisonedAt, mismatch: !!P._histMismatch,
               bannerHidden: P.histEl.classList.contains('hidden'), restored: ent.length >= 1,
               bars: P.bars.length };
    }""")
    check('T8 heal: agreement restored, banner hidden',
          t8['strike'] == 0 and not t8['poisoned'] and not t8['mismatch'] and t8['bannerHidden'] and
          t8['restored'] and t8['bars'] >= 1000, json.dumps(t8))

    # ---- T9: regression ----
    t9 = pg.evaluate("""() => {
      const P = window.__app.App.activePane, W = window.__app.Watchlist;
      return { digits: P.digits, bars: P.bars.length,
               watch: typeof W.prices['EURUSD'] === 'number' && W.prices['EURUSD'] > 0 };
    }""")
    check('T9 regression: digits=5, depth, watchlist alive',
          t9['digits'] == 5 and t9['bars'] >= 1000 and t9['watch'], json.dumps(t9))
    check('console: zero errors across the whole run', len(errors) == 0, '; '.join(errors[:3]))

    b.close()

prov_ok = True
try:
    os.killpg(os.getpgid(prov.pid), signal.SIGTERM)
except Exception:
    prov_ok = False

fails = [r for r in results if not r[1]]
print('\n=== ROUND29 SUMMARY: %d/%d PASS ===' % (len(results) - len(fails), len(results)))
sys.exit(1 if fails else 0)
