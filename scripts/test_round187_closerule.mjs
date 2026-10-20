/**
 * test_round187_closerule.mjs — ROUND187 close_entries_rule (TV parity).
 *
 * FIFO (default): exits oldest-first even when from_entry/id names another
 * trade, sized by the named lots. ANY: named lots first. Unknown rule -> FIFO.
 *
 * Run: node scripts/test_round187_closerule.mjs
 */

import { compile } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function bars(n, base) {
  const t0 = 1790600400 - (1790600400 % 900);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = (base || 100) + i;
    out.push({ time: t0 + i * 900, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 });
  }
  return out;
}
const BARS = bars(40);

function runIt(src, opts) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + JSON.stringify(c.errors).slice(0, 200), meta: null };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 1 }, opts || {}));
    rt.runAll(BARS);
    return { rt, broker: rt.broker, meta: c.meta };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

/* two lots: Buy1 x2 (fill 111), Buy2 x1 (fill 113); exit from Buy2.
   Exits need a trigger in our model: profit=1 tick fills on the rise. */
const mkExit = (rule, exitSrc) => `//@version=5
strategy("r", overlay=true${rule == null ? '' : ", close_entries_rule='" + rule + "'"}, pyramiding=5)
if bar_index == 10
    strategy.entry("Buy1", strategy.long, qty=2)
if bar_index == 12
    strategy.entry("Buy2", strategy.long, qty=1)
if bar_index == 15
    ${exitSrc}
plot(strategy.position_size, title="p")`;

{
  const r = runIt(mkExit(null, 'strategy.exit("E", from_entry="Buy2", profit=1)'), {});
  ok(!r.error, 'fifo exit runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const t = r.broker.trades[0];
    // FIFO: oldest first (Buy1 @111) but sized by Buy2 (1 contract)
    ok(t && t.entryId === 'Buy1', 'fifo exits oldest first despite from_entry=Buy2 (got ' + (t && t.entryId) + ')');
    ok(t && t.qty === 1, 'fifo size capped by named lots = 1 (got ' + (t && t.qty) + ')');
    ok(r.broker.qty === 2, 'remainder stays open (got ' + r.broker.qty + ')');
  }
}

{
  const r = runIt(mkExit('ANY', 'strategy.exit("E", from_entry="Buy2", profit=1)'), {});
  ok(!r.error, 'any exit runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const t = r.broker.trades[0];
    ok(t && t.entryId === 'Buy2', 'any exits the named trade first (got ' + (t && t.entryId) + ')');
  }
}

{
  const r = runIt(mkExit(null, 'strategy.close("Buy2")'), {});
  ok(!r.error, 'fifo close(id) runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const t = r.broker.trades[0];
    ok(t && t.entryId === 'Buy1' && t.qty === 1, 'fifo close(Buy2) exits oldest capped at 1 (got ' + (t && t.entryId) + '/' + (t && t.qty) + ')');
  }
}

{
  const r = runIt(mkExit('any', 'strategy.close("Buy2")'), {});
  ok(!r.error, 'any close(id) runs (lowercase)' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const t = r.broker.trades[0];
    ok(t && t.entryId === 'Buy2', 'any close(Buy2) exits Buy2 first (got ' + (t && t.entryId) + ')');
  }
}

{
  const r = runIt(mkExit('SOMETHING', 'strategy.exit("E", from_entry="Buy2", profit=1)'), {});
  ok(!r.error, 'unknown rule runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.broker.cfg.closeRule === 'fifo', 'unknown rule falls back to fifo (got ' + r.broker.cfg.closeRule + ')');
    ok(r.broker.trades[0] && r.broker.trades[0].entryId === 'Buy1', 'behaves FIFO');
  }
  const m = runIt(mkExit('ANY', 'strategy.exit("E")'), {});
  ok(!m.error && m.broker.cfg.closeRule === 'any', 'rule parsed case-insensitively');
}

/* MATrend pattern (production case): close("Out") with no "Out" lot open
   still closes the open Long — lenient close-all, TV reality. */
{
  const r = runIt(`//@version=5
strategy("MATrend", overlay=true, initial_capital=10000, default_qty_value=1)
if bar_index == 10
    strategy.entry("Long", strategy.long)
if bar_index == 15
    strategy.close("Out")
plot(strategy.position_size, title="p")`, {});
  ok(!r.error, 'matrend close("Out") runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.broker.trades.length === 1 && r.broker.trades[0].dir === 1, 'non-matching close id still closes the Long');
  }
}

console.log('\nROUND187: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
