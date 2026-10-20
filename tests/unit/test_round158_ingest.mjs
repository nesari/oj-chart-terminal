/**
 * test_round158_ingest.mjs — ROUND158 ingest normalization + security-frame fix + percentiles
 *
 * Run: node tests/unit/test_round158_ingest.mjs
 *
 * 1) Feed holes (null/NaN OHLCV) normalize to NA at ingest: isNA/nz/na()
 *    work on real holes, and hl2 no longer silently computes (null+5)/2.
 * 2) Complex request.security() expressions (close+open, hl2, ohlc4) read
 *    the HTF aggregate (class-A fix: they used to read chart-frame values
 *    while bare idents took the fast path).
 * 3) ta.percentile_linear_interpolation/_nearest_rank match independent
 *    batch references + boundary properties.
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function runSrc(src, bars, opts) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + String((c.errors[0] && c.errors[0].message) || '') };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', serverOffSec: 0 }, opts));
    rt.runAll(bars);
    const byTitle = {};
    for (const k of rt.out.plotsOrder) byTitle[rt.out.plots.get(k).title] = rt.out.plots.get(k).values;
    return { vals: byTitle };
  } catch (e) {
    return { error: 'run: ' + String((e && e.message) || e) };
  }
}

/* 1) holes: bars 3 (null close) and 6 (NaN high/low) in 10 M15 bars */
{
  const t0 = 1790600400 - (1790600400 % 900);
  const bars = [];
  for (let i = 0; i < 10; i++) {
    bars.push({ time: t0 + i * 900, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10 });
  }
  bars[3] = { time: t0 + 3 * 900, open: 103, high: 104, low: 102, close: null, volume: 10 };
  bars[6] = { time: t0 + 6 * 900, open: 106, high: NaN, low: NaN, close: 106.5, volume: 10 };
  const r = runSrc('//@version=6\nindicator("h", overlay=true)\n'
    + 'plot(na(close) ? 1 : 0, title="isna")\n'
    + 'plot(nz(close, -1), title="nz")\n'
    + 'plot(hl2, title="hl2")\n', bars);
  if (r.error) ok(false, 'holes run (-> ' + r.error.slice(0, 80) + ')');
  else {
    ok(r.vals.isna[3] === 1 && r.vals.isna[6] === 0, 'null close is na (bar 3), NaN high/low alone is not close-na (bar 6)');
    ok(r.vals.nz[3] === -1, 'nz(null close) yields the replacement (got ' + r.vals.nz[3] + ')');
    /* hl2 needs only high+low: bar 3 (null close, finite h/l) still computes;
       bar 6 (NaN h/l) is na — previously (null+5)/2-style silent numbers. */
    ok(r.vals.hl2[3] === 103, 'hl2 uses h/l only, null close does not poison (got ' + r.vals.hl2[3] + ')');
    ok(r.vals.hl2[6] == null, 'hl2 na on NaN-high/low bar');
    ok(r.vals.hl2[5] === 105, 'healthy bars unaffected (hl2[5]=105)');
  }
}

/* 2) security frame: two H1 buckets (4 M15 bars each), distinct ranges */
{
  const T0 = 1790600400 - (1790600400 % 3600);
  const bars = [];
  for (let i = 0; i < 8; i++) {
    const base = i < 4 ? 100 : 500;
    const o = base + i, cl = o + 1;
    bars.push({ time: T0 + i * 900, open: o, high: cl + 0.5, low: o - 0.5, close: cl, volume: 10 });
  }
  // bar 5 sits in bucket[4-7]; repaint-free rule shows bucket[0-3]:
  // open=100, high=104.5, low=99.5, close=104
  const r = runSrc('//@version=6\nindicator("s", overlay=true)\n'
    + 'plot(request.security(syminfo.tickerid, "60", close + open), title="sum")\n'
    + 'plot(request.security(syminfo.tickerid, "60", hl2), title="h")\n'
    + 'plot(request.security(syminfo.tickerid, "60", ohlc4), title="o")\n', bars);
  if (r.error) ok(false, 'security-frame run (-> ' + r.error.slice(0, 80) + ')');
  else {
    ok(r.vals.sum[5] === 204, 'close+open reads the aggregate (got ' + r.vals.sum[5] + ', chart-frame would be 1011)');
    ok(r.vals.h[5] === 102, 'hl2 reads the aggregate (got ' + r.vals.h[5] + ')');
    ok(r.vals.o[5] === 102, 'ohlc4 reads the aggregate (got ' + r.vals.o[5] + ')');
  }
}

/* 3) percentiles vs independent batch refs (na skipped, whole run) */
{
  const t0 = 1790600400 - (1790600400 % 900);
  const bars = [];
  let px = 50, seed = 77;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < 120; i++) {
    const o = px, cl = i % 17 === 5 ? NaN : o + Math.sin(i / 4) * 2 + rnd();
    bars.push({ time: t0 + i * 900, open: o, high: o + 1, low: o - 1, close: cl, volume: 10 });
    if (isFinite(cl)) px = cl;
  }
  const closes = bars.map((b) => b.close);
  const linRef = [], nearRef = [];
  const seen = [];
  for (let i = 0; i < closes.length; i++) {
    const v = closes[i];
    seen.push(v);
    const a = seen.filter((x) => isFinite(x)).sort((p, q) => p - q);
    if (!a.length) { linRef.push(null); nearRef.push(null); continue; }
    const pos = 0.4 * (a.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
    linRef.push(a[lo] + (a[hi] - a[lo]) * (pos - lo));
    nearRef.push(a[Math.min(a.length, Math.max(1, Math.ceil(0.4 * a.length))) - 1]);
  }
  const r = runSrc('//@version=6\nindicator("p", overlay=false)\n'
    + 'plot(ta.percentile_linear_interpolation(close, 40), title="l")\n'
    + 'plot(ta.percentile_nearest_rank(close, 40), title="n")\n'
    + 'plot(ta.percentile_linear_interpolation(close, 0), title="mn")\n'
    + 'plot(ta.percentile_linear_interpolation(close, 100), title="mx")\n', bars);
  if (r.error) ok(false, 'percentile run (-> ' + r.error.slice(0, 80) + ')');
  else {
    let badL = 0, badN = 0;
    for (let i = 0; i < 120; i++) {
      const g = r.vals.l[i], e = linRef[i];
      if (!((g == null && e == null) || (g != null && e != null && Math.abs(g - e) < 1e-9))) badL++;
      const g2 = r.vals.n[i], e2 = nearRef[i];
      if (!((g2 == null && e2 == null) || (g2 != null && e2 != null && Math.abs(g2 - e2) < 1e-9))) badN++;
    }
    ok(badL === 0, 'linear matches batch ref on 120 bars (na-skipped)');
    ok(badN === 0, 'nearest-rank matches batch ref on 120 bars');
    const finite = closes.filter((x) => isFinite(x));
    const mn = Math.min(...finite), mx = Math.max(...finite);
    ok(r.vals.mn[119] === mn, 'p=0 is the run minimum');
    ok(r.vals.mx[119] === mx, 'p=100 is the run maximum');
  }
}

console.log('\nROUND158: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
