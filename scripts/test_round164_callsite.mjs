/**
 * test_round164_callsite.mjs — ROUND164 per-call-site function `var` (SMC clutter bug).
 *
 * Bug: function-local `var` used ONE persistent slot per DECLARATION, shared
 * across every call site. SMC calls leg(50)/leg(5)/leg(3) every bar, so the
 * three sizes overwrote one `leg` slot and polluted each other's
 * ta.change(leg) history — constant phantom "new leg" pivots, a crossover
 * storm, and ~2x the structure lines/labels of TV (worst in chop).
 * TV inlines user functions: each static call site owns its `var` state.
 * Fix: slot keys carry the call-site frame id (interpreter _varSlot).
 *
 * Pins: (1) minimal f(1)/f(10) independence; (2) a 3-size leg() replica
 * whose per-size flip sequences match independent batch references;
 * (3) SMC drawing counts on fixed-seed data below the polluted levels.
 *
 * Run: node scripts/test_round164_callsite.mjs
 */

import { readFileSync } from 'node:fs';
import { compile } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function flatBars(n) {
  const t0 = 1790600400 - (1790600400 % 900);
  const bars = [];
  for (let i = 0; i < n; i++) bars.push({ time: t0 + i * 900, open: 1, high: 1.1, low: 0.9, close: 1, volume: 1 });
  return bars;
}

/* 1. minimal call-site independence */
{
  const src = `//@version=5
indicator("cs164", overlay=false)
f(int size) =>
    var v = 0
    v := v + size
    v
a = f(1)
b = f(10)
plot(a, title="a")
plot(b, title="b")
`;
  const c = compile(src);
  ok(c.ok, 'callsite probe compiles');
  if (c.ok) {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
    rt.runAll(flatBars(10));
    const A = rt.out.plots.get(rt.out.plotsOrder[0]).values;
    const B = rt.out.plots.get(rt.out.plotsOrder[1]).values;
    ok(A[9] === 10 && B[9] === 100, 'f(1)/f(10) independent: a=10 b=100 at bar 9 (got ' + A[9] + '/' + B[9] + ')');
  }
}

/* 2. three-size leg() replica vs independent references */
function gen(n, seed, choppy) {
  const t0 = 1790600400 - (1790600400 % 900);
  let px = 4150, s = seed;
  const bars = [];
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    const o = px;
    const cl = choppy ? o + rnd() * 2.2 + Math.sin(i / 90) * 0.12 : o + rnd() * 1.6 + Math.sin(i / 400) * 0.55;
    const w = Math.abs(rnd()) * 1.1 + 0.25;
    bars.push({ time: t0 + i * 900, open: o, high: Math.max(o, cl) + w, low: Math.min(o, cl) - w, close: cl, volume: 100 });
    px = cl;
  }
  return bars;
}
function refLegs(bars, size) {
  const legs = [];
  let leg = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i >= size) {
      let hi = -Infinity, lo = Infinity;
      for (let k = 0; k < size; k++) { hi = Math.max(hi, bars[i - k].high); lo = Math.min(lo, bars[i - k].low); }
      if (bars[i - size].high > hi) leg = 0;
      else if (bars[i - size].low < lo) leg = 1;
    }
    legs.push(leg);
  }
  return legs;
}
{
  const src = `//@version=5
indicator("leg3164", overlay=false)
leg(int size) =>
    var l = 0
    h = high[size] > ta.highest(size)
    w = low[size] < ta.lowest(size)
    if h
        l := 0
    else if w
        l := 1
    l
plot(leg(50), title="l50")
plot(leg(5), title="l5")
plot(leg(3), title="l3")
`;
  const c = compile(src);
  ok(c.ok, '3-size leg replica compiles');
  if (c.ok) {
    for (const choppy of [true, false]) {
      const bars = gen(1200, 99, choppy);
      const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
      rt.runAll(bars);
      const tag = choppy ? 'choppy' : 'trend';
      let allDiff = 0;
      const sizes = [50, 5, 3];
      for (let p = 0; p < 3; p++) {
        const ref = refLegs(bars, sizes[p]);
        const vals = rt.out.plots.get(rt.out.plotsOrder[p]).values;
        let diff = 0;
        for (let i = 0; i < bars.length; i++) if (vals[i] !== ref[i]) diff++;
        allDiff += diff;
        ok(diff === 0, tag + ' leg(' + sizes[p] + ') matches its independent reference (diffs=' + diff + ')');
      }
      void allDiff;
    }
  }
}

/* 3. SMC end-to-end counts below the polluted level (fixed seeds) */
{
  const src = readFileSync(new URL('../scripts/pine-fixtures/corpus/smartmoney.pine', import.meta.url), 'utf8');
  const c = compile(src);
  ok(c.ok, 'SMC compiles');
  if (c.ok) {
    const ch = gen(4000, 7, true);
    const rt = c.createInstance({ tfSec: 900, symbol: 'XAUUSD' });
    rt.runAll(ch);
    // polluted engine: 511 line-adds with 22 GC evictions on this seed; fixed: 235, zero evictions
    ok(rt.store.adds.line < 300 && rt.store.gced === 0,
      'choppy 4000 bars: line-adds=' + rt.store.adds.line + ' gced=' + rt.store.gced + ' (polluted: 511/22)');
    const tr = gen(4000, 7, false);
    const rt2 = c.createInstance({ tfSec: 900, symbol: 'XAUUSD' });
    rt2.runAll(tr);
    // polluted: 142 alive lines; fixed: 66
    ok(rt2.store.line.size < 100, 'trend 4000 bars: alive lines=' + rt2.store.line.size + ' (polluted: 142)');
  }
}

console.log('\nROUND164: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
