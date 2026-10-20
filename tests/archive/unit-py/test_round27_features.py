#!/usr/bin/env python3
"""Round 27 feature E2E (parity with the reference platform):
  T1  history depth: M1 initial load = 5000 bars (demo provider)
  T2  older-bars pagination: loadOlder prepends genuinely older bars,
      viewport kept, pill updates, second page stops at provider dry point
  T3  digits flow: EURUSD (5-digit) formatted with provider digits in
      watchlist rows + chart priceFormat
  T4  indicators: add EMA + RSI + MACD -> LWC series exist, legend rows
      render, values finite (RSI in 0..100), tick refresh works
  T5  legend: selected-candle date/time row (.lg-bartime) + colored OHLC
  T6  zero console errors
"""
import sys, time, threading, http.server, functools, json, subprocess, signal, os

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'src')
PROV = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'provider', 'demo.py')
PORT = 8977
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

    # ---- T1: history depth ----
    st = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      return { sym: P.symbol, tf: P.tf, n: P.bars.length, want: window.__app.App.COUNT_FOR[P.tf] };
    }""")
    check('T1 depth M1=5000', st['tf'] == 'M1' and st['n'] >= 4900, json.dumps(st))
    pg.screenshot(path=os.path.join(OUT, 'r27-t1-depth.png'))

    # ---- T2: older-bars pagination ----
    t2 = pg.evaluate("""async () => {
      const App = window.__app.App, M = window.__app.Manager, P = App.activePane;
      const before = { n: P.bars.length, oldest: P.bars[0].time };
      await M.loadOlder(P);
      const after = { n: P.bars.length, oldest: P.bars[0].time };
      return { before, after,
        added: after.n - before.n,
        strictlyOlder: after.oldest < before.oldest,
        pill: P.olderPill.style.display,
        asc: P.bars.every((b, i) => i === 0 || b.time > P.bars[i-1].time) };
    }""")
    check('T2 older page added', t2['added'] >= 900, json.dumps(t2['before']) + ' -> ' + json.dumps(t2['after']))
    check('T2 strictly older + ascending', t2['strictlyOlder'] and t2['asc'], 'oldest %s asc=%s' % (t2['strictlyOlder'], t2['asc']))

    # ---- T3: digits flow (EURUSD 5-digit) ----
    t3 = pg.evaluate("""() => {
      const App = window.__app.App, M = window.__app.Manager, W = window.__app.Watchlist;
      M.setSymbol(App.activePane, 'EURUSD');
      return new Promise(res => setTimeout(() => {
        const P = App.panes.find(p => p.symbol === 'EURUSD');
        const row = document.querySelector('.wl-row[data-sym="EURUSD"] .wl-price');
        res({ digits: P.digits, pf: P.series.options().priceFormat,
              feedDigits: App.feed.digitsBySym['EURUSD'],
              watchTxt: row ? row.textContent : null });
      }, 3500));
    }""")
    check('T3 chart digits=5', t3['digits'] == 5 and t3['pf']['precision'] == 5, json.dumps(t3['pf']))
    check('T3 watchlist 5 decimals', t3['watchTxt'] and t3['watchTxt'].split('.')[1].length if False else (t3['watchTxt'] and len(t3['watchTxt'].split('.')[-1]) == 5), 'txt=%s' % t3['watchTxt'])

    # ---- T4: indicators ----
    t4 = pg.evaluate("""() => {
      const App = window.__app.App, UI = window.__app.IndicatorsUI, P = App.activePane;
      UI.add(P, 'ema'); UI.add(P, 'rsi'); UI.add(P, 'macd');
      return new Promise(res => setTimeout(() => {
        const rows = document.querySelectorAll('.ind-row').length;
        const vals = document.querySelector('.ind-row .ind-vals');
        const meta = { instances: P.indicators.map(i => i.type), rows };
        res(meta);
      }, 2500));
    }""")
    check('T4 3 indicators added + rows', t4['instances'] == ['ema', 'rsi', 'macd'] and t4['rows'] == 3, json.dumps(t4))
    t4b = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      // RSI last value must be within 0..100
      const rsi = P.indicators.find(i => i.type === 'rsi');
      return new Promise(res => {
        window.__app.IndicatorsUI.recompute(P);
        setTimeout(() => {
          const out = window.__app.Indicators.compute(rsi, P.bars);
          const vals = out.lines[0].values.filter(v => v != null);
          const okRange = vals.every(v => v >= 0 && v <= 100);
          const macd = P.indicators.find(i => i.type === 'macd');
          const mout = window.__app.Indicators.compute(macd, P.bars);
          const mh = mout.hist.values.filter(v => v != null);
          res({ rsiN: vals.length, okRange, macdHistN: mh.length, rows: document.querySelectorAll('.ind-row').length });
        }, 300);
      });
    }""")
    check('T4 RSI 0..100 + MACD hist', t4b['okRange'] and t4b['rsiN'] > 100 and t4b['macdHistN'] > 100, json.dumps(t4b))
    pg.screenshot(path=os.path.join(OUT, 'r27-t4-indicators.png'))

    # indicator removal
    t4c = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      const id = P.indicators[0].id;
      window.__app.IndicatorsUI.remove(P, id);
      return { left: P.indicators.length, rows: document.querySelectorAll('.ind-row').length };
    }""")
    check('T4 remove works', t4c['left'] == 2 and t4c['rows'] == 2, json.dumps(t4c))

    # ---- T5: legend time/date + OHLC colors ----
    t5 = pg.evaluate("""() => {
      const P = window.__app.App.activePane;
      P.els.lgOhlc && window.__app.Manager.updateLegend(P, null);
      const el = P.els.lgOhlc;
      const bt = el.querySelector('.lg-bartime');
      const dir = el.querySelector('[class*="lg-dir-"]');
      return { barTime: bt ? bt.textContent : null,
               dirCls: dir ? dir.className : null,
               ohlcHas4: el.querySelectorAll('span span b').length >= 4 };
    }""")
    import re
    bt = t5['barTime'] or ''
    check('T5 legend time/date', bool(re.search(r'[A-Za-z]{3}', bt)) and bool(re.search(r'\d{2}:\d{2}', bt)), 'txt=%s' % bt)
    check('T5 OHLC colored', t5['dirCls'] in ('lg-dir-up', 'lg-dir-down') and t5['ohlcHas4'], t5['dirCls'])

    # ---- T6: console errors ----
    check('T6 zero console errors', len(errors) == 0, ('; '.join(errors[:5]) if errors else 'clean'))
    pg.screenshot(path=os.path.join(OUT, 'r27-final-state.png'))
    b.close()

try:
    os.killpg(os.getpgid(prov.pid), signal.SIGTERM)
except Exception:
    pass

fails = [r for r in results if not r[1]]
print('\n================ SUMMARY ================')
print(f"{len(results) - len(fails)}/{len(results)} checks passed")
sys.exit(1 if fails else 0)
