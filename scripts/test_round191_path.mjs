/**
 * test_round191_path.mjs — ROUND191 assumed intrabar path (TV parity).
 *
 * TV emulator walks open→high→low→close (or open→low→high→close when open
 * sits closer to the low; ties take the second path). stop-limit activates
 * only after the stop touch and fills only on a later limit touch; first
 * touch along the path wins; gap-crossed stops fill at the open.
 *
 * Run: node scripts/test_round191_path.mjs
 */

import { compile } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function runIt(src, barSet) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + JSON.stringify(c.errors).slice(0, 200) };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', mintick: 0.01 });
    rt.runAll(barSet);
    return { rt, broker: rt.broker };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

function B(t, o, h, l, c) {
  return { time: t, open: o, high: h, low: l, close: c, volume: 10 };
}
const T0 = 1790600400 - (1790600400 % 900);

/* 1. stop-limit: stop touched, limit never touched after -> working.
   O=100 H=110 L=99 C=101 -> closer to low -> O,L,H,C. stop 105 activates
   on 99->110; limit 98 is never touched after. */
{
  const bars = [B(T0, 100, 101, 99, 100), B(T0 + 900, 100, 110, 99, 101), B(T0 + 1800, 101, 102, 100, 101)];
  const r = runIt(`//@version=5
strategy("sl", overlay=true)
if bar_index == 0
    strategy.entry("L", strategy.long, stop=105, limit=98)
plot(strategy.position_size, title="p")`, bars);
  ok(!r.error, 'stop-limit runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.broker.qty === 0, 'stop touch alone does not fill (got ' + r.broker.qty + ')');
    ok(r.broker.pending.length === 1, 'order stays working');
  }
}

/* 2. stop-limit: limit touched after activation -> fills at limit.
   O=100 H=112 L=96 C=98 -> closer to low -> O,L,H,C: seg 100->96
   (stop? no; limit 99 crossed but inactive), seg 96->112 (stop 105
   activates), seg 112->98 (limit 99 hit) -> fill 99. */
{
  const bars = [B(T0, 100, 101, 99, 100), B(T0 + 900, 100, 112, 96, 98), B(T0 + 1800, 98, 99, 97, 98)];
  const r = runIt(`//@version=5
strategy("sl2", overlay=true)
if bar_index == 0
    strategy.entry("L", strategy.long, stop=105, limit=99)
plot(strategy.position_size, title="p")
plot(strategy.opentrades.entry_price(0), title="ep")`, bars);
  ok(!r.error, 'stop-limit fill runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const E = r.rt.out.plots.get(r.rt.out.plotsOrder[0]).values;
    const P = r.rt.out.plots.get(r.rt.out.plotsOrder[1]).values;
    ok(E[E.length - 1] === 1, 'filled after activation');
    ok(P[P.length - 1] === 99, 'fill at the limit price (got ' + P[P.length - 1] + ')');
  }
}

/* 3. path order beats stop-first: the limit leg fills after activation.
   O=100 H=110 L=90 C=95 (tie -> O,L,H,C): seg 100->90 (limit 99 crossed,
   inactive), seg 90->110 (stop 105 activates), seg 110->95 (limit 99 hit
   after activation) -> fill 99. Old code filled stop-first 105. */
{
  const bars = [B(T0, 100, 101, 99, 100), B(T0 + 900, 100, 110, 90, 95), B(T0 + 1800, 95, 96, 94, 95)];
  const r = runIt(`//@version=5
strategy("ord", overlay=true)
if bar_index == 0
    strategy.entry("L", strategy.long, stop=105, limit=99)
plot(strategy.position_size, title="p")
plot(strategy.opentrades.entry_price(0), title="ep")`, bars);
  ok(!r.error, 'touch order runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const P = r.rt.out.plots.get(r.rt.out.plotsOrder[1]).values;
    ok(P[P.length - 1] === 99, 'limit filled after activation at 99, not stop-first 105 (got ' + P[P.length - 1] + ')');
  }
}

/* 4. tie takes the second path (O->L->H->C): pre-activation limit ignored.
   O=100 H=105 L=95 C=94: tie -> [100,95,105,94]. seg1 (limit 96 crossed,
   inactive), seg2 (stop 103 activates), seg3 105->94 (limit 96 hit). */
{
  // O=100 H=105 L=95: tie -> O,L,H,C. stop 103, limit 96.
  const bars = [B(T0, 100, 101, 99, 100), B(T0 + 900, 100, 105, 95, 94), B(T0 + 1800, 94, 95, 93, 94)];
  const r = runIt(`//@version=5
strategy("tie", overlay=true)
if bar_index == 0
    strategy.entry("L", strategy.long, stop=103, limit=96)
plot(strategy.position_size, title="p")
plot(strategy.opentrades.entry_price(0), title="ep")`, bars);
  ok(!r.error, 'tie path runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const P = r.rt.out.plots.get(r.rt.out.plotsOrder[1]).values;
    ok(P[P.length - 1] === 96, 'fills at 96 after activation (got ' + P[P.length - 1] + ')');
  }
}

/* 5. gap-crossed stop fills at the open */
{
  const bars = [B(T0, 90, 91, 89, 90), B(T0 + 900, 110, 112, 109, 111), B(T0 + 1800, 111, 112, 110, 111)];
  const r = runIt(`//@version=5
strategy("gap", overlay=true)
if bar_index == 0
    strategy.entry("L", strategy.long, stop=100)
plot(strategy.position_size, title="p")
plot(strategy.opentrades.entry_price(0), title="ep")`, bars);
  ok(!r.error, 'gap stop runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const P = r.rt.out.plots.get(r.rt.out.plotsOrder[1]).values;
    ok(P[P.length - 1] === 110, 'gap fill at the open 110, not the stop (got ' + P[P.length - 1] + ')');
  }
}

console.log('\nROUND191: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
