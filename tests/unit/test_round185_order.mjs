/**
 * test_round185_order.mjs — ROUND185 TV order mechanics parity.
 *
 * (a) strategy.order() nets signed quantities: long 15 then three short 5s
 *     walks 15 -> 10 -> 5 -> 0 and NEVER goes short (TV market-order demo).
 *     order() also flips (long 15, short 20 -> short 5) and ignores the
 *     pyramiding gate (two same-direction orders fill at pyramiding 0/1).
 * (b) Pyramiding TV parity: N allows up to N successive same-direction
 *     entries (default 1): pyr 4 -> 4 lots, pyr 1 -> 1, default -> 1.
 *
 * Run: node tests/unit/test_round185_order.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function bars(n) {
  const t0 = 1790600400 - (1790600400 % 900);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 100 + i;
    out.push({ time: t0 + i * 900, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 });
  }
  return out;
}
const BARS = bars(160);

function runIt(src, opts) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + JSON.stringify(c.errors).slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 1 }, opts || {}));
    rt.runAll(BARS);
    return { rt, broker: rt.broker };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

/* --- TV market-order demo: 15 long every 100th, 5 short every 25th --- */
{
  const r = runIt(`//@version=5
strategy("odemo", overlay=true)
buyCondition = bar_index % 100 == 0
sellCondition = bar_index % 25 == 0
if buyCondition
    strategy.order("buy", strategy.long, qty=15)
else if sellCondition
    strategy.order("sell", strategy.short, qty=5)
plot(strategy.position_size, title="p")`);
  ok(!r.error, 'TV order demo runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    // fills at 101(+15), 26? no — first buy at bar 0 fills 1; sells at 25/50/75 fill 26/51/76
    const E = r.rt.out.plots.get(r.rt.out.plotsOrder[0]).values;
    ok(E[1] === 15, 'long 15 after first buy (got ' + E[1] + ')');
    ok(E[26] === 10 && E[51] === 5 && E[76] === 0, 'three shorts walk 10/5/0 (got ' + E[26] + '/' + E[51] + '/' + E[76] + ')');
    ok(E[101] === 15, 'cycle repeats with long 15 (got ' + E[101] + ')');
    ok(r.broker.qty === 0 || r.broker.qty > 0, 'never net short (final ' + r.broker.qty + ')');
    const hasShort = r.broker.trades.some((t) => t.dir < 0);
    ok(!hasShort, 'no short POSITION ever opens (entry() would reverse here)');
  }
}

/* --- order() flips through zero: long 15 then short 20 -> short 5 --- */
{
  const r = runIt(`//@version=5
strategy("flip", overlay=true)
if bar_index == 10
    strategy.order("A", strategy.long, qty=15)
if bar_index == 20
    strategy.order("B", strategy.short, qty=20)
plot(strategy.position_size, title="p")`);
  ok(!r.error, 'flip runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const E = r.rt.out.plots.get(r.rt.out.plotsOrder[0]).values;
    ok(E[11] === 15, 'long 15 first (got ' + E[11] + ')');
    ok(E[21] === -5, 'netted flip to short 5 (got ' + E[21] + ')');
    const st = r.broker.trades.find((t) => t.exitBar === 21);
    ok(st && st.qty === 15, 'close leg shuts exactly 15 (got ' + (st && st.qty) + ')');
  }
}

/* --- order() ignores the pyramiding gate --- */
{
  const src = `//@version=5
strategy("og", overlay=true, pyramiding=0)
if bar_index == 10
    strategy.order("A", strategy.long, qty=1)
if bar_index == 11
    strategy.order("B", strategy.long, qty=1)
plot(strategy.position_size, title="p")`;
  const r = runIt(src, {});
  ok(!r.error, 'order adds run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) ok(r.broker.qty === 2, 'two same-direction orders both fill at pyramiding 0 (got ' + r.broker.qty + ')');
}

/* --- pyramiding counts: 4 -> 4 lots, 1 -> 1, default -> 1 --- */
{
  const mk = (pyr) => `//@version=5
strategy("p${pyr}", overlay=true${pyr == null ? '' : ', pyramiding=' + pyr})
if bar_index == 10 or bar_index == 11 or bar_index == 12 or bar_index == 13 or bar_index == 14
    strategy.entry("L", strategy.long)
plot(strategy.position_size, title="p")`;
  const r4 = runIt(mk(4), {});
  const r1 = runIt(mk(1), {});
  const rd = runIt(mk(null), {});
  ok(!r4.error && !r1.error && !rd.error, 'pyramiding trio runs');
  if (!r4.error && !r1.error && !rd.error) {
    ok(r4.broker.entries.length === 4, 'pyramiding=4 holds 4 lots (got ' + r4.broker.entries.length + ')');
    ok(r1.broker.entries.length === 1, 'pyramiding=1 holds 1 lot (got ' + r1.broker.entries.length + ')');
    ok(rd.broker.entries.length === 1, 'default holds 1 lot (got ' + rd.broker.entries.length + ')');
  }
}

console.log('\nROUND185: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
