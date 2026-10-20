/**
 * test_round168_xsym.mjs — ROUND168 cross-symbol security history (phase 1a).
 *
 * request.security("OTHER","TF",expr) runs the same bucket machinery over
 * prefetched env.symBars['SYM|sec'], time-aligned (last bar at-or-before
 * chart time — no future leak), so [k] history works cross-symbol too.
 * Missing data -> loud "no history" (never silent); chart time before the
 * other history -> na.
 *
 * Run: node tests/unit/test_round168_xsym.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function walk(n, t0, step, seed, base, skipIdx) {
  let px = base, s = seed;
  const bars = [];
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    if (i === skipIdx) continue;
    const o = px, cl = o + rnd() * 0.002;
    bars.push({ time: t0 + i * step, open: o, high: Math.max(o, cl) + 0.0004, low: Math.min(o, cl) - 0.0004, close: cl, volume: 100 });
    px = cl;
  }
  return bars;
}

const T0 = 1790600400 - (1790600400 % 900);
const N = 400;
const barsA = walk(N, T0, 900, 11, 1.0850, -1);
// B: same grid, different prices (+0.05), starts 10 bars later, one hole at 200
const barsBfull = walk(N, T0, 900, 77, 1.1350, -1);
const barsB = barsBfull.filter((b, i) => i >= 10 && i !== 200);

{
  const src = `//@version=5
indicator("x168", overlay=false)
c = request.security("GBPUSD", "15", close)
c1 = request.security("GBPUSD", "15", close[1])
s = request.security("GBPUSD", "15", close + open)
plot(c, title="c")
plot(c1, title="c1")
plot(s, title="s")
`;
  const cmp = compile(src);
  ok(cmp.ok, 'xsym probe compiles');
  if (cmp.ok) {
    const rt = cmp.createInstance({ tfSec: 900, symbol: 'EURUSD' });
    rt.env.symBars = { 'GBPUSD|900': barsB };
    rt.runAll(barsA);
    const V = rt.out.plotsOrder.map((t) => rt.out.plots.get(t).values);
    // align: for each chart bar, last B bar at-or-before chart time
    let badC = 0, bad1 = 0, badS = 0, naEarly = 0, checked = 0;
    let bi = 0;
    for (let i = 0; i < barsA.length; i++) {
      while (bi + 1 < barsB.length && barsB[bi + 1].time <= barsA[i].time) bi++;
      const b = (bi >= 0 && barsB[bi].time <= barsA[i].time) ? barsB[bi] : null;
      if (!b) {
        if (V[0][i] != null && typeof V[0][i] !== 'object') badC++;
        else naEarly++;
        continue;
      }
      checked++;
      if (V[0][i] !== b.close) badC++;
      // [1]: previous B bar (tape history) — but a hole shifts alignment;
      // recompute expected by stepping back one B bar
      const prev = bi > 0 ? barsB[bi - 1] : null;
      const g1 = V[1][i];
      const e1 = prev ? prev.close : null;
      if (e1 == null) { if (g1 != null && typeof g1 !== 'object') bad1++; }
      else if (g1 !== e1) bad1++;
      if (V[2][i] !== b.close + b.open) badS++;
    }
    ok(checked > 300 && badC === 0, 'close tracks other symbol (' + checked + ' bars, diffs=' + badC + ')');
    ok(bad1 === 0, '[1] history rides the other tape (diffs=' + bad1 + ')');
    ok(badS === 0, 'compound expression in other frame (diffs=' + badS + ')');
    ok(naEarly === 10, 'chart bars before other history read na (' + naEarly + ')');
  }
}

/* unknown symbol -> loud error (never silent) */
{
  const src = `//@version=5
indicator("x168e", overlay=false)
c = request.security("NOPE", "15", close)
plot(c)
`;
  const cmp = compile(src);
  if (cmp.ok) {
    const rt = cmp.createInstance({ tfSec: 900, symbol: 'EURUSD' });
    let msg = '';
    try { rt.runAll(barsA); } catch (e) { msg = String((e && e.message) || e); }
    ok(/no history for "NOPE"/.test(msg), 'missing bars throw loudly (got ' + msg.slice(0, 80) + ')');
  } else ok(false, 'error-path probe compiles');
}

/* cross-TF over other bars (daily buckets on M15 arrays) */
{
  const src = `//@version=5
indicator("x168h", overlay=false)
d = request.security("GBPUSD", "D", close)
plot(d, title="d")
`;
  const cmp = compile(src);
  ok(cmp.ok, 'cross-tf xsym compiles');
  if (cmp.ok) {
    const rt = cmp.createInstance({ tfSec: 900, symbol: 'EURUSD' });
    rt.env.symBars = { 'GBPUSD|86400': barsB };
    rt.runAll(barsA);
    const V = rt.out.plots.get(rt.out.plotsOrder[0]).values;
    const last = V[V.length - 1];
    // expected: running daily aggregate close of B at the last chart bar
    const dayStart = Math.floor(barsA[barsA.length - 1].time / 86400) * 86400;
    const dayBars = barsB.filter((b) => b.time >= dayStart && b.time <= barsA[barsA.length - 1].time);
    const exp = dayBars.length ? dayBars[dayBars.length - 1].close : null;
    ok(typeof last === 'number' && exp != null && Math.abs(last - exp) < 1e-12,
      'daily bucket close over other bars (got ' + last + ' exp ' + exp + ')');
  }
}

console.log('\nROUND168: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
