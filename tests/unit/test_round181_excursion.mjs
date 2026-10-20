/**
 * test_round181_excursion.mjs — ROUND181 favorable/adverse excursion.
 *
 * Per-lot unrealized extremes tracked each bar land on the closed trade
 * (TV hover tooltip: Favorable/Adverse excursion). Monotonic-up long:
 * mfe = full run, mae = 0. Monotonic-down long: mae = full drop, mfe = 0.
 * Partial closes share the lot extremes.
 *
 * Run: node tests/unit/test_round181_excursion.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function runIt(src, closes) {
  const t0 = 1790600400 - (1790600400 % 900);
  const bars = closes.map((c, i) => ({ time: t0 + i * 900, open: c, high: c, low: c, close: c, volume: 10 }));
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + JSON.stringify(c.errors).slice(0, 200) };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', mintick: 0.01 });
    rt.runAll(bars);
    return { rt, broker: rt.broker };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

const LONG = `//@version=5
strategy("e", overlay=true)
if bar_index == 2
    strategy.entry("L", strategy.long, qty=2)
if bar_index == 8
    strategy.close("X")
plot(strategy.position_size, title="p")`;

/* monotonic rise 100..110: long gains throughout.
   (fill model: entry fills bar3, exit fills bar9 — extremes are recorded
   over bars 3..8; the exit bar gap itself is never an unrealized print.) */
{
  const r = runIt(LONG, [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110]);
  ok(!r.error, 'rise runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const t = r.broker.trades[0];
    ok(r.broker.trades.length === 1, 'one trade (got ' + r.broker.trades.length + ')');
    // closes over bars 3..8: 103..108 -> mfe=(108-103)*2=10
    ok(t && t.mfe === 10, 'mfe = 10 over bars 3..8 (got ' + (t && t.mfe) + ')');
    ok(t && t.mae === 0, 'mae = 0 on the way up (got ' + (t && t.mae) + ')');
  }
}

/* monotonic fall 110..100: long loses throughout */
{
  const r = runIt(LONG, [110, 109, 108, 107, 106, 105, 104, 103, 102, 101, 100]);
  ok(!r.error, 'fall runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const t = r.broker.trades[0];
    // closes over bars 3..8: 107..102 -> mae=(102-107)*2=-10
    ok(t && t.mae === -10, 'mae = -10 over bars 3..8 (got ' + (t && t.mae) + ')');
    ok(t && t.mfe === 0, 'mfe = 0 on the way down (got ' + (t && t.mfe) + ')');
  }
}

/* hump: up then down — both extremes recorded, profit = net */
{
  const r = runIt(LONG, [100, 100, 100, 100, 106, 107, 104, 103, 102, 101, 101]);
  ok(!r.error, 'hump runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const t = r.broker.trades[0];
    // closes over bars 3..8: 100,106,107,104,103,102 -> mfe=14, mae=0
    ok(t && t.mfe === 14 && t.mae === 0, 'hump mfe=14 mae=0 (got ' + (t && t.mfe) + '/' + (t && t.mae) + ')');
    ok(t && t.profit === 2, 'profit is exit-only 2 (got ' + (t && t.profit) + ')');
  }
}

/* short direction mirrors */
{
  const r = runIt(`//@version=5
strategy("s", overlay=true)
if bar_index == 2
    strategy.entry("S", strategy.short, qty=1)
if bar_index == 8
    strategy.close("X")
plot(strategy.position_size, title="p")`, [110, 109, 108, 107, 106, 105, 104, 103, 102, 101, 100]);
  ok(!r.error, 'short runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const t = r.broker.trades[0];
    ok(t && t.mfe === 5 && t.mae === 0, 'short on falling market: mfe=5 mae=0 (got ' + (t && t.mfe) + '/' + (t && t.mae) + ')');
  }
}

console.log('\nROUND181: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
