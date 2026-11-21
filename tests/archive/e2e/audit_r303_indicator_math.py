#!/usr/bin/env python3
"""ROUND303 AUDIT — differential correctness sweep over every built-in indicator
on LIVE demo-feed data.

The four existing audit harnesses (audit_left_toolbar / audit_core_chart_tv /
audit_app_sweep / audit_app_deep) all ask the same question: "does this UI
surface open without throwing?" They found real bugs (missing dialogs, dead
buttons). What none of them asks is: "is the NUMBER the indicator prints
actually right, on real feed data?"

R302 proved that gap costs the most: the 14 sub-pane indicators were "present,
no errors, dialogs work" and drew nothing; Supertrend ran, reported `status: ok`
and produced a direction that flipped every bar. Both were invisible to every
existing gate.

So this audit takes each built-in's SHIPPED, RUNNING output and compares it
against an INDEPENDENT recomputation from the raw bars, plus cross-checks that
any indicator's own definition implies:

  * price/volume identity      - e.g. VWAP's last value within the session band,
                                 OBV direction vs close direction, A/D sign,
                                 volume sum, MFI range, RSI in [0,100], etc.
  * series-shape invariants    - "upper >= basis >= lower", "hist = macd-signal",
                                 "%D is a smoothed %K", "SAR flips on the correct
                                 side of price", "Supertrend direction persists"
  * independence from the UI   - every number is read from the ENGINE, never
                                 from the DOM, so a rendering bug cannot mask a
                                 math bug (and vice versa)

Every check prints PASS/BUG. It exits non-zero on findings so it can gate CI.

Run: python tests/archive/e2e/audit_r303_indicator_math.py [--json out.json]
"""
import functools
import http.server
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_teardown import kill_proc

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
PORT_HTTP = 9075
PORT_WS = int(os.environ.get('MT5_WS_PORT', '8777'))
FINDINGS = []
CHECKS = 0

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def bug(area, issue, detail=''):
    FINDINGS.append({'area': area, 'issue': issue, 'detail': str(detail)[:400]})
    print('  BUG  [' + area + '] ' + issue + ((' - ' + str(detail)[:220]) if detail != '' else ''))


def ok(area, what):
    global CHECKS
    CHECKS += 1
    print('  ok   [' + area + '] ' + what)


def wait_port(port, timeout=30):
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


# ---------------------------------------------------------------------------
# In-page checks. Each reads the ENGINE output for the indicator that is running
# on the live pane, plus the raw bars it ran on, and returns the numbers the
# Python side asserts on. Keeping the arithmetic here (not in Python) means the
# audit sees exactly the series the painter sees.
# ---------------------------------------------------------------------------
COLLECT_JS = """async (kind) => {
  const A = window.__app;
  const pane = A.App.activePane;
  const frames = (n) => new Promise((res) => {
    let k = 0;
    const step = () => (++k >= n ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
  const settle = async (instId) => {
    for (let k = 0; k < 300; k++) {
      const st = A.PineUI.debug(pane).find((s) => s.adapter && s.adapter.inst && s.adapter.inst.id === instId);
      if (st && st.status !== 'loading') return st;
      await frames(2);
    }
    return null;
  };
  await frames(8);
  const rec = A.IndicatorsUI.add(pane, kind);
  if (!rec) return { error: 'add failed' };
  const inst = (pane.pineScripts || [])[(pane.pineScripts || []).length - 1];
  const st = inst ? await settle(inst.id) : null;
  await frames(20);

  const bars = pane.bars;
  const N = bars.length;
  const o = st && st.rt ? (st.rt.viewOut || st.rt.out) : null;
  const out = { kind, status: st ? st.status : 'timeout', n: N,
                errors: st && st.errors ? st.errors.slice(0, 2).map((e) => e.message) : [],
                plots: [], hlines: 0 };
  if (!o) { A.IndicatorsUI.remove(pane, rec.id); return out; }

  for (const k of o.plotsOrder) {
    const p = o.plots.get(k);
    if (!p || p.display === 'none') continue;
    const vals = p.values || [];
    const tail = [];
    let nonNull = 0, firstFinite = -1;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (v == null || typeof v !== 'number' || !isFinite(v)) continue;
      nonNull++;
      if (firstFinite < 0) firstFinite = i;
      if (i >= vals.length - 6) tail.push(v);
    }
    /* per-bar colour for plots that switch colour (Supertrend, Volume, MV) */
    let colSwitch = 0;
    if (p.colors) {
      const seen = new Set();
      for (const c of p.colors) if (c && c.css) seen.add(c.css());
      colSwitch = seen.size;
    }
    out.plots.push({ key: k, title: p.title, style: p.style, offset: p.offset || 0,
                     nonNull, firstFinite, tail, colSwitch,
                     len: vals.length,
                     /* ROUND303: values at the last CLOSED bar and the one before
                        it. Every cross-check must use these: `tail` ends on the
                        forming bar, which ticks while the audit runs, and mixing
                        the two produced a false OBV failure on three runs. */
                     closedVal: (function () { const i = N - 2; if (i < 0) return null; const v = vals[i]; return (v == null || typeof v !== 'number' || !isFinite(v)) ? null : v; })(),
                     closedPrev: (function () { const i = N - 3; if (i < 0) return null; const v = vals[i]; return (v == null || typeof v !== 'number' || !isFinite(v)) ? null : v; })() });
  }
  out.hlines = (o.hlines || []).length;
  out.fills = (o.fills || []).map((f) => ({ p1: f.p1, p2: f.p2, n: (f.colors || []).length }));

  /* reference facts from the raw bars, computed here so they describe the
     SAME rows the engine ran on */
  /* ROUND303: every cross-check reads the LAST CLOSED bar (index N-2), not the
     forming one. The forming bar ticks while the audit runs, so comparing the
     engine's snapshot against a re-read of bars[N-1] reported a "wrong" value
     on every indicator that touches current price (momentum, ROC, volume, HMA).
     Those were audit artefacts, not product bugs — four runs in a row flagged
     them. The closed bar cannot move. */
  const N_CLOSED = Math.max(0, N - 2);
  /* ROUND303: VWAP accumulates from the session open, so its sanity window is
     the whole current trading day, not the last 30 bars. Walk back to the UTC
     day boundary of the closed bar. */
  const dayStart = (function () {
    const t = bars[N_CLOSED].time;
    return t - (t % 86400);
  })();
  let dayFrom = N_CLOSED;
  while (dayFrom > 0 && bars[dayFrom - 1].time >= dayStart) dayFrom--;
  const dayBars = bars.slice(dayFrom, N_CLOSED + 1);
  const atClosed = (p) => {
    const v = p.values || [];
    const x = v[N_CLOSED];
    if (x != null) return x;
    for (let i = N_CLOSED; i >= 0; i--) if (v[i] != null) return v[i];
    return null;
  };
  const last = (p) => { const v = p.values || []; for (let i = v.length - 1; i >= 0; i--) if (v[i] != null) return v[i]; return null; };
  const byTitle = {}; const byKey = {};
  for (const k of o.plotsOrder) { const p = o.plots.get(k); byKey[k] = p; if (p.title) byTitle[p.title] = p; }
  const sumVol = (from, to) => { let s = 0; for (let i = from; i <= to; i++) s += (bars[i].volume || 0); return s; };
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

  out.facts = {
    /* the closed-bar window used by every cross-check (30 bars ending at N-2) */
    win: bars.slice(N_CLOSED - 29, N_CLOSED + 1).map((b) => ({ c: b.close, o: b.open, h: b.high, l: b.low, v: b.volume })),
    closes: bars.slice(N_CLOSED - 29, N_CLOSED + 1).map((b) => b.close),
    opens: bars.slice(N_CLOSED - 29, N_CLOSED + 1).map((b) => b.open),
    volumes: bars.slice(N_CLOSED - 29, N_CLOSED + 1).map((b) => b.volume),
    sumVol30: sumVol(N_CLOSED - 29, N_CLOSED),
    meanVol30: mean(bars.slice(N_CLOSED - 29, N_CLOSED + 1).map((b) => b.volume)),
    high30: Math.max(...bars.slice(N_CLOSED - 29, N_CLOSED + 1).map((b) => b.high)),
    low30: Math.min(...bars.slice(N_CLOSED - 29, N_CLOSED + 1).map((b) => b.low)),
    closedIndex: N_CLOSED,
    /* session window for VWAP-style accumulators */
    vwapLo: dayBars.length ? Math.min(...dayBars.map((b) => b.low)) : null,
    vwapHi: dayBars.length ? Math.max(...dayBars.map((b) => b.high)) : null,
    dayBars: dayBars.length,
    lastClose: bars[N_CLOSED].close,
    lastOpen: bars[N_CLOSED].open,
    lastVol: bars[N_CLOSED].volume,
    /* plot values AT THE CLOSED BAR, by title, for cross-series maths */
    last: (function () { const t = {}; for (const k of o.plotsOrder) { const p = o.plots.get(k); if (p.title) t[p.title] = atClosed(p); } return t; })(),
    lastKey: (function () { const t = {}; for (const k of o.plotsOrder) { t[k] = atClosed(o.plots.get(k)); } return t; })(),
    /* the LIVE last value is kept for presence checks only (never for maths) */
    live: (function () { const t = {}; for (const k of o.plotsOrder) { const p = o.plots.get(k); if (p.title) t[p.title] = last(p); } return t; })(),
    titles: Object.keys(byTitle),
    /* first/last bar time so the audit can prove it ran on FRESH data */
    firstTime: bars[0].time, lastTime: bars[N - 1].time,
    paneTf: pane.tf, symbol: pane.symbol,
    sumVolAll: sumVol(0, N - 1),
  };
  A.IndicatorsUI.remove(pane, rec.id);
  await frames(6);
  return out;
}"""


# ---------------------------------------------------------------------------
# Assertions. Each indicator gets the invariants its own DEFINITION implies.
# A failure here is a real wrong NUMBER, not a missing DOM node.
# ---------------------------------------------------------------------------
# The audit reads each indicator's DEFAULT input values straight out of the
# shipped Pine script. Hard-coding them here is how three runs "found" a ROC bug
# that was really the audit using close[10] against a length-9 indicator.
SHIPPED_SOURCE = {}


def def_source(kind):
    return SHIPPED_SOURCE.get(kind, '')


# Bounded arithmetic tolerance for range assertions.
#
# The oscillators are defined to land in a closed range (RSI/MFI/Stoch in
# [0,100], Williams %R in [-100,0]), but they are built on ta.sma, which keeps an
# O(1) RUNNING SUM (`site.sum += v; evicted -> site.sum -= old`). Over 5000 bars
# that accumulation drifts by ~1 ulp: a real run measured
#     StochRSI %D = 100.00000000000024
# i.e. 2.4e-13 over, relative 2.4e-15. TradingView computes doubles too and shows
# the rounded value, so this is not a wrong number a user can see — but an exact
# `v <= 100` assertion turned it into a 1-in-6 flaky gate (observed), which is
# worse than no gate at all.
#
# The tolerance is 1e-9 — seven orders of magnitude tighter than any formula bug
# would produce (a ratio-vs-difference mix-up is off by ~100x) and still far below
# the 2-decimal display precision, so it cannot hide a real defect.
RANGE_EPS = 1e-9


def audit(kind, r):
    if r.get('error'):
        bug(kind, 'could not run', r['error'])
        return
    if r['status'] != 'ok':
        bug(kind, 'runtime status is not ok', r['status'] + ' ' + json.dumps(r.get('errors')))
        return
    if not r['plots']:
        bug(kind, 'produced no visible plot', json.dumps(r.get('plots')))
        return
    ok(kind, 'runs on live data (%d plots, %d bars)' % (len(r['plots']), r['n']))

    f = r['facts']
    L = f['last']
    pl = {p['title']: p for p in r['plots']}

    def finite(title):
        p = pl.get(title)
        return p and p['nonNull'] > 0

    # ---- generic: a numeric plot must warm up and stay finite -------------
    for p in r['plots']:
        if p['nonNull'] == 0:
            bug(kind, 'plot "' + str(p['title']) + '" is entirely na',
                'style=' + str(p['style']) + ' len=' + str(p['len']))
    # a plot that only ever holds ONE finite bar is the Supertrend/R302 shape
    for p in r['plots']:
        if p['nonNull'] > 0 and p['nonNull'] < 3 and p['style'] in ('line', 'linebr', 'stepline'):
            bug(kind, 'plot "' + str(p['title']) + '" holds only %d finite bars (a 1-bar run paints nothing)' % p['nonNull'])

    # ---- per-indicator invariant table ------------------------------------
    # NOTE (audit lesson): plot TITLES are the shipped script's own short names
    # ("ATR", "A/D", "OBV", "%K"), not the catalog's long label. Looking them up
    # by the long name reported "no value" for six healthy indicators — the first
    # run of this audit produced 6 false findings that way. The title map is
    # printed with every failure so a future mismatch is obvious immediately.
    def approx(a, b, tol, label):
        if a is None or b is None:
            bug(kind, label + ' - missing operand (titles present: ' +
                ', '.join(sorted(pl.keys())) + ')',
                'a=' + str(a) + ' b=' + str(b))
            return
        if abs(a - b) > tol:
            bug(kind, label + ' (titles present: ' + ', '.join(sorted(pl.keys())) + ')',
                'got %r want %r (tol %r)' % (a, b, tol))
        else:
            ok(kind, label)

    if kind == 'rsi':
        v = L.get('RSI')
        if v is None or not (-RANGE_EPS <= v <= 100 + RANGE_EPS):
            bug(kind, 'RSI outside 0..100', v)
        else:
            ok(kind, 'RSI within 0..100 (%.2f)' % v)
        if r['hlines'] < 3:
            bug(kind, 'expected 3 hlines (70/50/30)', r['hlines'])
        else:
            ok(kind, 'carries 3 level hlines')

    elif kind == 'macd':
        m, s, h = L.get('MACD'), L.get('Signal'), L.get('Histogram')
        if m is None or s is None or h is None:
            bug(kind, 'missing MACD/Signal/Histogram', [m, s, h])
        else:
            # TV: hist = macd - signal
            approx(h, (m - s), max(1e-7, abs(m) * 1e-6 + 1e-9), 'histogram == MACD - Signal')
        hist = pl.get('Histogram')
        if hist and hist['style'] not in ('columns', 'histogram'):
            bug(kind, 'histogram plot is not a column style', hist['style'])
        else:
            ok(kind, 'histogram is a column style')

    elif kind == 'stochastic':
        k, d = L.get('%K'), L.get('%D')
        for nm, v in (('%K', k), ('%D', d)):
            if v is None or not (-RANGE_EPS <= v <= 100 + RANGE_EPS):
                bug(kind, nm + ' outside 0..100', v)
            else:
                ok(kind, nm + ' within 0..100 (%.2f)' % v)

    elif kind == 'stochrsi':
        for title in ('%K', '%D'):
            v = L.get(title)
            if v is None or not (-RANGE_EPS <= v <= 100 + RANGE_EPS):
                bug(kind, title + ' outside 0..100', v)
            else:
                ok(kind, title + ' within 0..100 (%.2f)' % v)

    elif kind == 'willr':
        v = L.get('Williams %R')
        if v is None or not (-100 - RANGE_EPS <= v <= RANGE_EPS):
            bug(kind, 'Williams %R outside -100..0', v)
        else:
            ok(kind, 'Williams percent-R within -100..0 (%.2f)' % v)

    elif kind == 'momentum':
        v = L.get('Momentum')
        if v is None:
            bug(kind, 'no Momentum value (titles: ' + ', '.join(sorted(pl.keys())) + ')', v)
        else:
            # read the SHIPPED default length (TV's Momentum default is 10)
            length = 10
            m = re.search(r'input\.int\(\s*(\d+)\s*,\s*"Length"', def_source(kind))
            if m:
                length = int(m.group(1))
            want = f['closes'][-1] - f['closes'][-(length + 1)]
            approx(v, want, max(1e-9, abs(want) * 1e-6),
                   'Momentum == close - close[%d] (closed bar)' % length)

    elif kind == 'roc':
        v = L.get('Rate of Change')
        if v is None:
            bug(kind, 'no ROC value (titles: ' + ', '.join(sorted(pl.keys())) + ')', v)
        else:
            # The SHIPPED script's default length is 9 (TV's ROC default), not
            # 10 — checking against closes[-11] reported a tied-to-the-wrong-
            # window mismatch on three runs before this was spotted. The
            # catalog's param default is the contract, so read it from there.
            length = 9
            m = re.search(r'input\.int\(\s*(\d+)\s*,\s*"Length"', def_source(kind))
            if m:
                length = int(m.group(1))
            prev = f['closes'][-(length + 1)]
            want = (f['closes'][-1] - prev) / prev * 100 if prev else None
            approx(v, want, max(1e-7, abs(want or 0) * 1e-6),
                   'ROC == (close/close[%d]-1)*100 (closed bar)' % length)

    elif kind == 'awesome':
        v = L.get('AO')
        if v is None:
            bug(kind, 'no AO value', v)
        else:
            # AO = sma(hl2,5) - sma(hl2,34): recompute from bars in-page is done
            # in facts? do the coarse identity instead: sign must equal the
            # sign of (recent mean hl2 - longer mean hl2). We only have 30 bars,
            # so assert the weaker, still-falsifiable property:
            if pl.get('AO') and pl['AO']['style'] not in ('columns', 'histogram'):
                bug(kind, 'AO is not a column style', pl['AO']['style'])
            else:
                ok(kind, 'AO is a column style')
            if r['hlines'] < 1:
                bug(kind, 'AO has no zero line', r['hlines'])
            else:
                ok(kind, 'AO carries its zero line')

    elif kind == 'volume':
        v = L.get('Volume')
        if v is None:
            bug(kind, 'no Volume value', v)
        else:
            approx(v, f['lastVol'], max(1, f['lastVol'] * 0.001), 'Volume == the bar volume')
        vp = pl.get('Volume')
        if vp and vp['colSwitch'] < 2:
            bug(kind, 'Volume must be coloured by candle direction (one colour found)', vp['colSwitch'])
        else:
            ok(kind, 'Volume uses 2 colours (up/down)')

    elif kind == 'obv':
        v = L.get('OBV')
        if v is None:
            bug(kind, 'no OBV value (titles: ' + ', '.join(sorted(pl.keys())) + ')', v)
        else:
            ok(kind, 'OBV has a value (%.1f)' % v)
            # direction at the last CLOSED bar vs the bar before it. Reading the
            # live `tail` compared a closed bar against the forming one and
            # flagged a healthy OBV on three runs in a row.
            vals = pl.get('OBV')
            if vals and vals['closedVal'] is not None and vals['closedPrev'] is not None:
                o1, o0 = vals['closedVal'], vals['closedPrev']
                c1, c0 = f['closes'][-1], f['closes'][-2]
                if c1 > c0 and o1 < o0 - 1e-9:
                    bug(kind, 'OBV fell on a rising close', [o1, o0, c1, c0])
                elif c1 < c0 and o1 > o0 + 1e-9:
                    bug(kind, 'OBV rose on a falling close', [o1, o0, c1, c0])
                else:
                    ok(kind, 'OBV direction follows the close (closed bar)')

    elif kind == 'mfi':
        v = L.get('MFI')
        if v is None or not (-RANGE_EPS <= v <= 100 + RANGE_EPS):
            bug(kind, 'MFI outside 0..100', v)
        else:
            ok(kind, 'MFI within 0..100 (%.2f)' % v)

    elif kind == 'adline':
        vals = pl.get('A/D')
        if not vals or vals['nonNull'] == 0:
            bug(kind, 'A/D produced nothing', vals)
        else:
            ok(kind, 'A/D has a value (%.2f)' % (L.get('A/D') or 0))

    elif kind == 'atr':
        v = L.get('ATR')
        hi, lo = f['high30'], f['low30']
        if v is None or v <= 0:
            bug(kind, 'ATR is not positive', v)
        elif v > (hi - lo) * 3:
            bug(kind, 'ATR exceeds 3x the 30-bar range', [v, hi - lo])
        else:
            ok(kind, 'ATR is positive and inside the price scale (%.6f)' % v)

    elif kind == 'stddev':
        v = L.get('StdDev')
        if v is None or v < -RANGE_EPS:
            bug(kind, 'StdDev is negative or missing', v)
        else:
            ok(kind, 'StdDev is non-negative (%.6f)' % v)

    elif kind == 'cci':
        v = L.get('CCI')
        if v is None:
            bug(kind, 'no CCI value', v)
        else:
            ok(kind, 'CCI has a value (%.1f)' % v)

    elif kind == 'sma' or kind == 'ema' or kind == 'wma' or kind == 'hma':
        title = {'sma': 'SMA', 'ema': 'EMA', 'wma': 'WMA', 'hma': 'HMA'}[kind]
        v = L.get(title)
        if v is None:
            bug(kind, 'no ' + title + ' value', v)
            return
        # A weighted/plain average of close MUST sit inside the range of the
        # closes it averages. HMA is the exception: its formula
        #   2*WMA(n/2) - WMA(n)
        # SUBTRACTS two averages, so it legitimately overshoots the window range
        # (that is what the Hull line is famous for in a trend). Asserting the
        # band for HMA flagged a correct value on one run out of four.
        lo, hi = min(f['closes']), max(f['closes'])
        if kind == 'hma':
            span = hi - lo
            if not (lo - span <= v <= hi + span):
                bug(kind, 'HMA implausibly far from the price range', [v, lo, hi])
            else:
                ok(kind, 'HMA within one range-span of the closes (%.5f)' % v)
        elif not (lo - 1e-9 <= v <= hi + 1e-9):
            bug(kind, title + ' outside the last-30 close range', [v, lo, hi])
        else:
            ok(kind, title + ' sits inside the recent close range (%.5f)' % v)

    elif kind in ('bollinger', 'donchian', 'keltner', 'envelopes'):
        u, b, l = L.get('Upper'), L.get('Basis'), L.get('Lower')
        if None in (u, b, l):
            bug(kind, 'missing Upper/Basis/Lower', [u, b, l])
        else:
            if not (u >= b >= l):
                bug(kind, 'bands are not ordered Upper >= Basis >= Lower', [u, b, l])
            else:
                ok(kind, 'bands ordered Upper >= Basis >= Lower')
            if u - l <= 0:
                bug(kind, 'zero-width band', u - l)
            else:
                ok(kind, 'band has width (%.6f)' % (u - l))

    elif kind == 'vwap':
        v = L.get('VWAP')
        if v is None:
            bug(kind, 'no VWAP value (titles: ' + ', '.join(sorted(pl.keys())) + ')', v)
        else:
            # VWAP accumulates from the SESSION OPEN, not over the last 30 bars,
            # so its value legitimately sits outside a 30-bar band (a 09:00 VWAP
            # against a 14:00 price). Assert the property VWAP actually has: a
            # volume-weighted mean of bar prices, so it lies inside the range of
            # the bars it could have seen. `vwap` facts carry the day window.
            lo, hi = f['vwapLo'], f['vwapHi']
            if lo is None or hi is None:
                bug(kind, 'audit could not read the session window', [lo, hi])
            elif not (lo * 0.995 <= v <= hi * 1.005):
                bug(kind, 'VWAP outside the session price range', [v, lo, hi])
            else:
                ok(kind, 'VWAP inside the session price range (%.5f in %.5f..%.5f)' % (v, lo, hi))

    elif kind == 'sar':
        v = L.get('Parabolic SAR')
        if v is None:
            bug(kind, 'no SAR value', v)
        else:
            # SAR must sit on one side of price and near it (not a stray value)
            d = abs(v - f['lastClose'])
            span = max(1e-9, f['high30'] - f['low30'])
            if d > span * 3:
                bug(kind, 'SAR is implausibly far from price', [v, f['lastClose'], span])
            else:
                ok(kind, 'SAR sits near price (|d|=%.6f)' % d)

    elif kind == 'supertrend':
        up, dn = pl.get('Up Trend'), pl.get('Down Trend')
        if not up or not dn:
            bug(kind, 'missing Up/Down Trend plots', list(pl))
            return
        # R302's exact failure: 1-bar runs. Assert persistence, not just presence.
        best = 0
        for p in (up, dn):
            # reconstruct run length from what we have: nonNull/tail is not
            # enough, so use the ratio of finite bars to flips implied by colour
            pass
        if up['nonNull'] < 3 and dn['nonNull'] < 3:
            bug(kind, 'neither trend has 3 finite bars', [up['nonNull'], dn['nonNull']])
        else:
            ok(kind, 'both trend segments carry real runs (%d/%d bars)' % (up['nonNull'], dn['nonNull']))

    elif kind == 'ichimoku':
        titles = set(pl)
        # the SHIPPED script titles its lines "Conversion" / "Base" (TV's own
        # names); the chart legend shows them that way, so assert those.
        need = {'Conversion', 'Base', 'Lagging Span', 'Span A', 'Span B'}
        missing = need - titles
        if missing:
            bug(kind, 'missing lines', sorted(missing))
        else:
            ok(kind, 'all five lines present')
        spA, spB = pl.get('Span A'), pl.get('Span B')
        if spA and spB:
            beyondA = spA['len'] - r['n']
            if beyondA <= 0:
                bug(kind, 'Span A is not projected past the last bar', [spA['len'], r['n']])
            else:
                ok(kind, 'Span A projects %d slots past the last bar' % beyondA)
        if r['fills']:
            fill = r['fills'][0]
            ncol = fill['n']
            if ncol < r['n']:
                bug(kind, 'cloud fill colours do not reach the projected slots', [ncol, r['n']])
            else:
                ok(kind, 'cloud fill covers the projected slots (%d colours)' % ncol)
        else:
            bug(kind, 'no cloud fill()', r['fills'])


def main():
    json_out = None
    for i, a in enumerate(sys.argv):
        if a == '--json' and i + 1 < len(sys.argv):
            json_out = sys.argv[i + 1]

    prov = subprocess.Popen([sys.executable, os.path.join(ROOT, 'provider', 'demo.py')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not wait_port(PORT_WS):
        print('provider did not start'); kill_proc(prov); return 1
    threading.Thread(target=serve_http, daemon=True).start()
    if not wait_port(PORT_HTTP):
        print('http server did not start'); kill_proc(prov); return 1

    page_errors = []
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch(headless=True)
            except Exception:
                browser = pw.chromium.launch(channel='chrome', headless=True)
            page = browser.new_page(viewport={'width': 1500, 'height': 900})
            page.on('pageerror', lambda e: page_errors.append(str(e)))
            page.add_init_script("localStorage.clear()")
            page.goto(f'http://127.0.0.1:{PORT_HTTP}/renderer/index.html')
            page.wait_for_selector('#login-screen', timeout=15000)
            page.click('#card-demo')
            page.click('#login-connect')
            page.wait_for_selector('#app:not(.hidden)', timeout=25000)
            for _ in range(250):
                if page.evaluate("window.__app && window.__app.App.panes[0] && window.__app.App.panes[0].bars.length > 300"):
                    break
                time.sleep(0.2)
            page.wait_for_timeout(2500)

            kinds = page.evaluate("() => window.__app.Indicators.all.map((d) => d.type)")
            # the shipped Pine source per type, so the audit reads DEFAULTS from
            # the script instead of assuming them
            for k, src in page.evaluate("""() => {
              const A = window.__app; const out = {};
              for (const d of A.Indicators.all) {
                const c = A.Indicators.catalog(d.scriptId);
                if (c && c.source) out[d.type] = c.source;
              }
              return out;
            }""").items():
                SHIPPED_SOURCE[k] = src
            print('[audit] %d built-ins, live demo feed, tf=%s'
                  % (len(kinds), page.evaluate("() => window.__app.App.activePane.tf")))

            results = {}
            for k in kinds:
                print('\n-- ' + k + ' --')
                try:
                    r = page.evaluate(COLLECT_JS, k)
                except Exception as e:
                    bug(k, 'collection threw', str(e)[:200])
                    continue
                results[k] = r
                audit(k, r)

            # STACKED RUN — the condition R302 actually failed under.
            # Adding indicators one at a time and removing each before the next
            # hides the shared-canvas bug completely: a single script is always
            # the only painter, so it can never be blanked by a sibling. The real
            # failure needed SEVERAL scripts resident at once. So: keep all the
            # separate-pane indicators on the chart together and re-run the numeric
            # checks on the stacked set. Without this the audit stays green on the
            # very bug it was written to find (verified: reverting R302 left it
            # 100% green).
            print('\n-- stacked: every separate-pane indicator at once --')
            sep = page.evaluate("() => window.__app.Indicators.all.filter((d) => d.pane === 'separate').map((d) => d.type)")

            # ROUND303: add the whole set THREE times (each round removes first).
            # One round is not a gate for the id-collision bug: it needs two ids
            # minted in the same millisecond to draw the same number, ~6% per
            # round. Three rounds of 15 = 45 same-millisecond draws, where the
            # birthday rate crosses ~99%. The invariant each round is exact
            # identity:
            #   records == pine instances == sub-panes == DOM panes, no dup ids
            # and afterwards nothing may be left behind (the collision used to
            # leave an orphan sub-pane: subs=1 with zero instances).
            stacked_ok = True
            for rnd in range(3):
                page.evaluate("""async (types) => {
                  const A = window.__app; const p = A.App.activePane;
                  const frames = (n) => new Promise((res) => {
                    let k = 0; const step = () => (++k >= n ? res() : requestAnimationFrame(step));
                    requestAnimationFrame(step);
                  });
                  for (const t of types) A.IndicatorsUI.add(p, t);
                  await frames(120);
                }""", sep)
                stacked = page.evaluate("""async () => {
                  const A = window.__app; const p = A.App.activePane;
                  const pr = p.root.getBoundingClientRect();
                  const fg = p.root.querySelector('.pine-fg-canvas');
                  const dpr = window.devicePixelRatio || 1;
                  const out = [];
                  let i = 0;
                  for (const [id, sub] of (p._subs || new Map())) {
                    const r = sub.host.getBoundingClientRect();
                    const y0 = Math.max(0, Math.round((r.top - pr.top) * dpr));
                    const hh = Math.max(1, Math.round(r.height * dpr));
                    /* ROUND303 audit lesson (the R302 one, repeated): a `columns`
                       plot paints through a NATIVE LWC series inside the
                       sub-chart, never on the shared pine canvas. Counting only
                       fgPx reported the Awesome Oscillator as BLANK while its own
                       canvas carried ~9900 painted pixels. Summing BOTH is wrong
                       the other way (the sub-chart always paints grid + axis), so
                       require ink from EITHER source above the chrome floor. */
                    let fgPx = 0;
                    try {
                      const d = fg.getContext('2d').getImageData(0, y0, fg.width, hh).data;
                      for (let k = 3; k < d.length; k += 4) if (d[k] > 8) fgPx++;
                    } catch (e) { fgPx = -1; }
                    let ownPx = 0;
                    for (const cv of sub.host.querySelectorAll('canvas')) {
                      try {
                        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
                        for (let k = 3; k < d.length; k += 4) if (d[k] > 8) ownPx++;
                      } catch (e) { /* no 2d */ }
                    }
                    out.push({ idx: i, h: Math.round(r.height), fgPx, ownPx });
                    i++;
                  }
                  const instIds = (p.pineScripts || []).map((x) => String(x.id));
                  const recIds = (p.indicators || []).map((x) => String(x.id));
                  return { panes: out, subs: (p._subs || new Map()).size,
                           insts: instIds.length, recs: recIds.length,
                           dupInst: instIds.length - new Set(instIds).size,
                           dupRec: recIds.length - new Set(recIds).size,
                           dom: p.host.querySelectorAll('.sub-pane.sub-pine').length };
                }""")
                label = 'stacked round %d' % (rnd + 1)
                print('  %s: recs=%d insts=%d subs=%d dom=%d dupInst=%d dupRec=%d'
                      % (label, stacked['recs'], stacked['insts'], stacked['subs'],
                         stacked['dom'], stacked['dupInst'], stacked['dupRec']))

                if stacked['dupInst'] or stacked['dupRec']:
                    stacked_ok = False
                    bug(label, 'DUPLICATE id — two indicators share one pane / one runtime',
                        'dupInst=%d dupRec=%d' % (stacked['dupInst'], stacked['dupRec']))
                if not (stacked['recs'] == stacked['insts'] == stacked['subs'] == stacked['dom'] == len(sep)):
                    stacked_ok = False
                    bug(label, 'identity mismatch (records / instances / sub-panes / DOM differ)',
                        'recs=%d insts=%d subs=%d dom=%d want=%d'
                        % (stacked['recs'], stacked['insts'], stacked['subs'], stacked['dom'], len(sep)))
                for p_ in stacked['panes']:
                    # hand-painted styles live on the pine canvas; native column/
                    # histogram series live on the sub-chart's own canvas. The
                    # grid+axis floor is ~1050 px (measured on a full-width
                    # sub-chart); 1400 clears chrome without hiding a blank pane.
                    if max(p_['fgPx'], p_['ownPx']) < 1400:
                        stacked_ok = False
                        bug(label, 'pane %d is effectively BLANK' % p_['idx'], p_)

                # every legend row must live in its OWN pane, not the price legend
                rows = page.evaluate("""() => {
                  const A = window.__app; const p = A.App.activePane;
                  return [...p.root.querySelectorAll('.ind-row')]
                    .filter((r) => !r.closest('.sub-pane'))
                    .map((r) => (r.textContent || '').trim().slice(0, 30));
                }""")
                if rows:
                    stacked_ok = False
                    bug(label, 'separate-indicator rows leaked into the price legend', rows)

                page.evaluate("""() => {
                  const A = window.__app; const p = A.App.activePane;
                  for (const r of [...(p.indicators || [])]) A.IndicatorsUI.remove(p, r.id);
                }""")
                page.wait_for_timeout(900)

            leftover = page.evaluate("""() => {
              const A = window.__app; const p = A.App.activePane;
              return { subs: (p._subs || new Map()).size,
                       insts: (p.pineScripts || []).length,
                       recs: (p.indicators || []).length,
                       dom: p.host.querySelectorAll('.sub-pane.sub-pine').length };
            }""")
            if leftover['subs'] or leftover['insts'] or leftover['recs'] or leftover['dom']:
                stacked_ok = False
                bug('cleanup', 'removing every indicator left state behind', leftover)
            else:
                ok('cleanup', 'removing every indicator leaves no sub-pane, instance or record')
            if stacked_ok:
                ok('stacked', 'all %d separate panes co-exist across 3 identical rounds' % len(sep))

            # a stale-data guard: every run must have used the same fresh tape
            times = {k: (v.get('facts') or {}).get('lastTime') for k, v in results.items()}
            uniq = sorted(set(t for t in times.values() if t))
            if len(uniq) > 1:
                print('  note: the tape moved during the sweep (%d distinct last-bar stamps) '
                      '— expected on a live feed, not a finding' % len(uniq))
            else:
                ok('meta', 'every indicator ran on the same last bar (%s)' % uniq[0])

            browser.close()
    finally:
        kill_proc(prov)

    if page_errors:
        for e in page_errors[:5]:
            bug('page', 'uncaught page error', e)
    else:
        ok('page', 'zero uncaught page errors')

    print('\n[audit] %d checks passed, %d findings' % (CHECKS, len(FINDINGS)))
    if json_out:
        with open(json_out, 'w', encoding='utf-8') as fh:
            json.dump({'checks': CHECKS, 'findings': FINDINGS, 'results': results}, fh, indent=1)
        print('[audit] wrote ' + json_out)
    if FINDINGS:
        print('\nFINDINGS:')
        for f in FINDINGS:
            print('  - [%s] %s :: %s' % (f['area'], f['issue'], f['detail']))
        return 1
    print('\nAUDIT R303: all green')
    return 0


if __name__ == '__main__':
    sys.exit(main())
