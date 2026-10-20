/**
 * test_round213_margin.mjs — ROUND213 margin_long/margin_short + margin calls.
 *
 * Requirement = |contracts x price| x side-% / 100 against marked equity.
 * Under-margined entries/orders drop silently (risk precedent); equity below
 * maintenance flattens at the close (counted, no latch). margin 100 can
 * never be called (equality boundary).
 *
 * Run: node tests/unit/test_round213_margin.mjs
 */

import { compile } from '../../src/core/pine/compile.js';
import { perfSummary } from '../../src/core/pine/stdlib/strategy.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const T0 = 1790600400 - (1790600400 % 900);
const rising = (n, base) => Array.from({ length: n }, (_, i) => ({
  time: T0 + i * 900, open: base + i, high: base + i + 0.6, low: base + i - 0.6,
  close: base + i + 0.5, volume: 10,
}));
function runIt(src, bars, opts) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 0.01 }, opts || {}));
    rt.runAll(bars);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
const S = (decl) => `//@version=5\nstrategy("T", overlay=true${decl || ''})\n`;

/* ---------- placement gate ---------- */
{
  // cap 10k, 200 contracts @~103, margin 100 -> req ~20.6k: dropped
  const r = runIt(S(', initial_capital=10000, margin_long=100') + 'if bar_index == 2\n    strategy.entry("L", strategy.long, qty=200)\nplot(1)\n', rising(10, 100));
  ok(!r.error && r.rt.broker.qty === 0 && r.rt.broker.pending.length === 0, 'under-margined entry dropped silently');
}
{
  // same but margin 50 -> req ~10.3k vs 10k... still over! use qty 190: 190x103x.5=9785 <= 10k
  const r = runIt(S(', initial_capital=10000, margin_long=50') + 'if bar_index == 2\n    strategy.entry("L", strategy.long, qty=190)\nplot(1)\n', rising(10, 100));
  ok(!r.error && r.rt.broker.qty === 190, 'affordable leveraged entry fills');
}
{
  // boundary: req == equity exactly -> accepted (strict > to reject)
  const r = runIt(S(', initial_capital=10000, margin_long=100') + 'if bar_index == 2\n    strategy.entry("L", strategy.long, qty=97)\nplot(1)\n', rising(10, 100));
  // req = 97 x 103 = 9991 <= 10000
  ok(!r.error && r.rt.broker.qty === 97, 'boundary req<=equity accepted');
}
{
  // cash mode resolves at fill price for the gate
  const r = runIt(S(', initial_capital=10000, margin_long=100, default_qty_type="cash", default_qty_value=5000') + 'if bar_index == 2\n    strategy.entry("L", strategy.long)\nplot(1)\n', rising(10, 100));
  ok(!r.error && r.rt.broker.qty > 40 && r.rt.broker.qty < 60, 'cash-mode gate resolves (qty ' + (!r.error && r.rt.broker.qty) + ')');
}
{
  // exits/closes never gated, even with dust equity
  const r = runIt(S(', initial_capital=10000, margin_long=0') + 'if bar_index == 2\n    strategy.entry("L", strategy.long, qty=10)\nif bar_index == 5\n    strategy.close("L")\nplot(1)\n', rising(10, 100));
  ok(!r.error && r.rt.broker.trades.length === 1, 'close works under margin 0');
}

/* ---------- maintenance margin call ---------- */
const crashBars = (() => {
  const out = [];
  const closes = [100, 100, 100, 100, 90, 80, 80, 80];
  closes.forEach((c, i) => out.push({ time: T0 + i * 900, open: c, high: c + 1, low: c - 1, close: c, volume: 10 }));
  return out;
})();
{
  // long 190 @100 (req 9500 <= 10k), crash to 80: eq 6200 < req 7600 -> call
  const r = runIt(S(', initial_capital=10000, margin_long=50') + 'if bar_index == 2\n    strategy.entry("L", strategy.long, qty=190)\nplot(1)\n', crashBars);
  ok(!r.error, 'call run ok' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const b = r.rt.broker;
    ok(b.qty === 0 && b.marginCalls === 1, 'flat with 1 call (qty ' + b.qty + ', calls ' + b.marginCalls + ')');
    const t = b.trades[0];
    ok(t && t.exitPrice === 90 && t.exitId === 'MarginCall' && t.profit === 190 * (90 - 100),
      'call trade at 90 with loss (got ' + JSON.stringify(t && { p: t.exitPrice, id: t.exitId, pl: t.profit }) + ')');
  }
}
{
  // margin 100: equality holds all the way down -> never called
  const r = runIt(S(', initial_capital=10000, margin_long=100') + 'if bar_index == 2\n    strategy.entry("L", strategy.long, qty=100)\nplot(1)\n', crashBars);
  ok(!r.error && r.rt.broker.qty === 100 && r.rt.broker.marginCalls === 0, 'margin-100 never called');
}
{
  // short mirror: margin_short 50, short 190 @100, spike to 120
  const spike = crashBars.map((b) => ({ ...b, open: 200 - b.open, high: 200 - b.high, low: 200 - b.low, close: 200 - b.close }));
  const r = runIt(S(', initial_capital=10000, margin_short=50') + 'if bar_index == 2\n    strategy.entry("S", strategy.short, qty=190)\nplot(1)\n', spike);
  ok(!r.error && r.rt.broker.qty === 0 && r.rt.broker.marginCalls === 1, 'short call mirrors');
}
{
  // strategy keeps trading after a call (no latch)
  const r = runIt(S(', initial_capital=10000, margin_long=50') + 'if bar_index == 2\n    strategy.entry("L", strategy.long, qty=190)\nif bar_index == 6\n    strategy.entry("L2", strategy.long, qty=10)\nplot(1)\n', crashBars);
  ok(!r.error && r.rt.broker.qty === 10, 'no latch after call (qty ' + (!r.error && r.rt.broker.qty) + ')');
}
{
  // stop-entry affordable at placement but not at fill price -> dropped
  const gap = rising(10, 100).map((b, i) => (i === 3 ? { ...b, open: 200, high: 205, low: 195, close: 202 } : b));
  const r = runIt(S(', initial_capital=10000, margin_long=100') + 'if bar_index == 2\n    strategy.entry("L", strategy.long, qty=95, stop=103.5)\nplot(1)\n', gap);
  ok(!r.error && r.rt.broker.qty === 0 && r.rt.broker.pending.length === 0, 'fill-time gate drops gap stop');
}

/* ---------- reporting / parsing ---------- */
{
  const a = perfSummary([], { marginCalls: 2 });
  const b = perfSummary([], {});
  ok(a.shared.marginCalls === 2 && b.shared.marginCalls === 0, 'perfSummary marginCalls wiring');
}
{
  const c = compile(S(', margin_long=25, margin_short=30') + 'plot(1)\n');
  ok(c.ok && c.meta.strategy.margin_long === 25 && c.meta.strategy.margin_short === 30, 'literals fold to meta');
}
{
  // override: declaration margin 100 rejects, props margin 25 accepts
  const src = S(', initial_capital=10000, margin_long=100') + 'if bar_index == 2\n    strategy.entry("L", strategy.long, qty=200)\nplot(1)\n';
  const r = runIt(src, rising(10, 100), { strategyProps: { margin_long: 25 } });
  ok(!r.error && r.rt.broker.qty === 200, 'strategyProps margin override wins');
}

console.log('\nROUND213: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
