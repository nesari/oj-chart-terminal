/**
 * test_round162_smc_parity.mjs — ROUND162 SMC event-path parity pins.
 *
 * Why: the user's TV-vs-app screenshot showed many more SMC lines/labels on
 * our chart (same symbol/TF). Census showed drawing counts scale with history
 * depth and swing with tiny data noise, so the prime suspects were engine
 * defects that MULTIPLY structure events: pivot primitives (leg()), the
 * crossover edge, and the UDT crossed-latch. This test pins all three against
 * independent batch references on choppy AND trending regimes:
 *   1. high[size] > ta.highest(size) / low[size] < ta.lowest(size) for
 *      size=5/50 bar-by-bar vs a pure-JS reference (the exact leg() pattern).
 *   2. full leg() flip sequences (engine-implied vs reference) identical.
 *   3. UDT crossed-latch: ~20 crossings of one fixed level draw exactly ONE
 *      line + ONE label and stay latched (TV behaviour).
 *
 * Run: node tests/unit/test_round162_smc_parity.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function gen(n, seed, choppy) {
  const t0 = 1790600400 - (1790600400 % 900);
  let px = 4180, s = seed;
  const bars = [];
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    const o = px;
    const cl = choppy ? o + rnd() * 2.2 + Math.sin(i / 90) * 0.12 : o + rnd() * 1.6 + Math.sin(i / 400) * 0.55;
    const w = Math.abs(rnd()) * (choppy ? 1.2 : 0.9) + (choppy ? 0.3 : 0.2);
    const h = Math.max(o, cl) + w, l = Math.min(o, cl) - w;
    bars.push({ time: t0 + i * 900, open: o, high: h, low: l, close: cl, volume: 100 });
    px = cl;
  }
  return bars;
}

/* ROUND162: batch reference for SMC leg() (smartmoney.pine lines 337-346):
   newLegHigh = high[size] > highest of bars [i-size+1 .. i] (ta.highest(size)
   covers the last `size` bars including current). */
function refNewLegs(bars, size) {
  const out = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < size) { out.push([null, null]); continue; }
    let hi = -Infinity, lo = Infinity;
    for (let k = 0; k < size; k++) { hi = Math.max(hi, bars[i - k].high); lo = Math.min(lo, bars[i - k].low); }
    out.push([bars[i - size].high > hi ? 1 : 0, bars[i - size].low < lo ? 1 : 0]);
  }
  return out;
}

const probeSrc = `//@version=5
indicator("probe162", overlay=false)
newLegHigh5 = high[5] > ta.highest(5)
newLegLow5 = low[5] < ta.lowest(5)
newLegHigh50 = high[50] > ta.highest(50)
newLegLow50 = low[50] < ta.lowest(50)
plot(newLegHigh5 ? 1 : 0, title="h5")
plot(newLegLow5 ? 1 : 0, title="l5")
plot(newLegHigh50 ? 1 : 0, title="h50")
plot(newLegLow50 ? 1 : 0, title="l50")
`;
const pc = compile(probeSrc);
ok(pc.ok, 'pivot probe compiles' + (pc.ok ? '' : ' -> ' + JSON.stringify(pc.errors).slice(0, 200)));

const truthy = (v) => !(v == null || v === 0 || (typeof v === 'object' && v.__pineNA));

if (pc.ok) {
  for (const choppy of [true, false]) {
    const tag = choppy ? 'choppy' : 'trend';
    const bars = gen(1200, 99, choppy);
    const rt = pc.createInstance({ tfSec: 900, symbol: 'T' });
    rt.runAll(bars);
    const V = rt.out.plotsOrder.map((t) => rt.out.plots.get(t).values);
    let bad = 0;
    for (const size of [5, 50]) {
      const ref = refNewLegs(bars, size);
      const hp = size === 5 ? V[0] : V[2], lp = size === 5 ? V[1] : V[3];
      for (let i = 0; i < bars.length; i++) {
        const [eH, eL] = ref[i];
        if (eH == null) continue; // engine na-window: reference has no expectation
        const gH = truthy(hp[i]) ? 1 : 0, gL = truthy(lp[i]) ? 1 : 0;
        if (gH !== eH || gL !== eL) bad++;
      }
    }
    ok(bad === 0, tag + ': leg() primitives match reference on 1200 bars x4 probes (diffs=' + bad + ')');
    // full leg flip-sequence parity (engine-implied vs reference legs)
    for (const size of [5, 50]) {
      const ref = refNewLegs(bars, size);
      const hp = size === 5 ? V[0] : V[2], lp = size === 5 ? V[1] : V[3];
      let eLeg = 0, rLeg = 0, diff = 0;
      for (let i = 0; i < bars.length; i++) {
        const [eH, eL] = ref[i];
        if (eH != null) { if (eH) rLeg = 0; else if (eL) rLeg = 1; }
        if (i >= size) { if (truthy(hp[i])) eLeg = 0; else if (truthy(lp[i])) eLeg = 1; }
        if (i >= size && eLeg !== rLeg) diff++;
      }
      ok(diff === 0, tag + ' size=' + size + ': leg flip sequence identical (diffs=' + diff + ')');
    }
  }
}

/* ROUND162: UDT crossed-latch (the displayStructure gate). ~20 crossings of
   one fixed level must draw exactly ONE line + ONE label (TV latches
   crossed=true until a new pivot arrives). A broken latch would spray a
   drawing per crossing — the exact "extra lines" symptom. */
{
  const src = `//@version=5
indicator("latch162", overlay=true)
type P
    float lvl
    bool crossed
var P p = P.new(100.0, false)
if ta.crossover(close, p.lvl) and not p.crossed
    p.crossed := true
    line.new(bar_index - 1, p.lvl, bar_index, p.lvl, xloc.bar_index)
    label.new(bar_index, high, "X", xloc.bar_index)
plot(p.crossed ? 1 : 0, title="latched")
`;
  const c = compile(src);
  ok(c.ok, 'latch probe compiles');
  if (c.ok) {
    const bars = [];
    const t0 = 1790600400 - (1790600400 % 900);
    for (let i = 0; i < 400; i++) {
      const cl = 100 + Math.sin(i / 3.2) * 2;
      const o = 100 + Math.sin((i - 1) / 3.2) * 2;
      bars.push({ time: t0 + i * 900, open: o, high: Math.max(o, cl) + 0.3, low: Math.min(o, cl) - 0.3, close: cl, volume: 100 });
    }
    const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
    rt.runAll(bars);
    ok(rt.store.line.size === 1 && rt.store.label.size === 1,
      '20 crossings of one level draw exactly 1 line + 1 label (got ' + rt.store.line.size + '/' + rt.store.label.size + ')');
    const lat = rt.out.plots.get(rt.out.plotsOrder[0]).values;
    ok(lat[lat.length - 1] === 1, 'latch stays set through bar 399');
  }
}

console.log('\nROUND162: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
