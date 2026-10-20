/**
 * test_round192_magnifier.mjs — ROUND192 Bar Magnifier (TV parity).
 *
 * With use_bar_magnifier + per-bar M1 ranges, stop/limit touches evaluate
 * in time order on real sub-ranges instead of the assumed OHLC path.
 * Pinned divergences: M1 fills where the assumed path stays working, and
 * vice versa. Flag off (or no coverage) falls back to round 191.
 *
 * Run: node tests/unit/test_round192_magnifier.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const T0 = 1790600400 - (1790600400 % 900);
function B(t, o, h, l, c) {
  return { time: t, open: o, high: h, low: l, close: c, volume: 10 };
}
function M(o, h, l, c) {
  return { open: o, high: h, low: l, close: c, volume: 1 };
}

function runIt(src, opts, barSet) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + JSON.stringify(c.errors).slice(0, 200), meta: null };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 0.01 }, opts || {}));
    rt.runAll(barSet);
    return { rt, broker: rt.broker, meta: c.meta };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

const SRC = (mag) => `//@version=5
strategy("mg", overlay=true${mag ? ', use_bar_magnifier=true' : ''})
if bar_index == 0
    strategy.entry("L", strategy.long, stop=105, limit=99)
plot(strategy.position_size, title="p")
plot(strategy.opentrades.entry_price(0), title="ep")`;

/* M1 fills where the assumed path stays working.
   Chart bar1: O=100 H=106 L=98 C=104. Assumed (closer to low): [100,98,106,104]
   seg1 (limit 99 crossed, inactive), seg2 (stop 105 activates; 99 not in
   105..106), seg3 (106->104 misses 99) -> working.
   M1: [100->98 (inactive touch), 98->106 (stop activates), 106->102
   (limit 99 hit)] -> fills 99. */
{
  const bars = [B(T0, 100, 101, 99, 100), B(T0 + 900, 100, 106, 98, 104), B(T0 + 1800, 104, 105, 103, 104)];
  const m1 = [[M(100, 100, 98, 98)], [M(100, 98, 98, 98)], null];
  const ib = [null, [M(100, 100, 98, 98), M(98, 106, 98, 106), M(106, 106, 102, 102)], null];
  void m1;
  const r = runIt(SRC(true), { intrabars: ib }, bars);
  ok(!r.error, 'magnifier run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.meta.strategy.use_bar_magnifier === true, 'declaration flag parsed');
    const P = r.rt.out.plots.get(r.rt.out.plotsOrder[1]).values;
    ok(P[P.length - 1] === 99, 'M1 fills at 99 where assumed stays working (got ' + P[P.length - 1] + ')');
  }
  const r2 = runIt(SRC(false), {}, bars);
  ok(!r2.error, 'assumed-path control runs' + (r2.error ? ' -> ' + r2.error : ''));
  if (!r2.error) ok(r2.broker.qty === 0 && r2.broker.pending.length === 1, 'assumed path stays working (control)');
}

/* Agreement: both models fill at the same price.
   O=100 H=110 L=96 C=98, stop=105, limit=99. Assumed: seg1 limit
   crossed inactive, seg2 stop activates, seg3 110->98 crosses 99.
   M1 [100->96, 96->110 (activate + same-sub 99), 110->98]: same fill. */
{
  const bars = [B(T0, 100, 101, 99, 100), B(T0 + 900, 100, 110, 96, 98), B(T0 + 1800, 98, 99, 97, 98)];
  const ib = [null, [M(100, 100, 96, 96), M(96, 110, 96, 110), M(110, 110, 98, 98)], null];
  const SRCAG = `//@version=5
strategy("ag", overlay=true, use_bar_magnifier=true)
if bar_index == 0
    strategy.entry("L", strategy.long, stop=105, limit=99)
plot(strategy.position_size, title="p")
plot(strategy.opentrades.entry_price(0), title="ep")`;
  const r = runIt(SRCAG, { intrabars: ib }, bars);
  ok(!r.error, 'agreement run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const P = r.rt.out.plots.get(r.rt.out.plotsOrder[1]).values;
    ok(P[P.length - 1] === 99, 'M1 fills 99 (got ' + P[P.length - 1] + ')');
  }
}

/* Flag on but no coverage -> assumed path (TV: uncovered bars unaffected) */
{
  const bars = [B(T0, 100, 101, 99, 100), B(T0 + 900, 100, 112, 96, 100), B(T0 + 1800, 100, 101, 99, 100)];
  const r = runIt(SRC(true), { intrabars: [null, null, null] }, bars);
  ok(!r.error, 'no-coverage runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.broker.qty === 0 && r.broker.pending.length === 1, 'falls back to the assumed path (working, like the control)');
  }
}

/* strategyProps override enables the magnifier without the declaration */
{
  const bars = [B(T0, 100, 101, 99, 100), B(T0 + 900, 100, 106, 98, 104), B(T0 + 1800, 104, 105, 103, 104)];
  const ib = [null, [M(100, 100, 98, 98), M(98, 106, 98, 106), M(106, 106, 102, 102)], null];
  const r = runIt(SRC(false), { strategyProps: { use_bar_magnifier: true }, intrabars: ib }, bars);
  ok(!r.error, 'props override runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const P = r.rt.out.plots.get(r.rt.out.plotsOrder[1]).values;
    ok(P[P.length - 1] === 99, 'props flag drives magnifier fills (got ' + P[P.length - 1] + ')');
  }
}

console.log('\nROUND192: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
