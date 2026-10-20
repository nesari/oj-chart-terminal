/**
 * test_round188_oca.mjs — ROUND188 OCA groups (TV parity).
 *
 * cancel (default): a fill kills the group's working orders — including a
 * same-bar sibling placed LATER in signal order. reduce: siblings' explicit
 * quantities shrink by the filled amount (to zero = gone). Invalid oca_type
 * stays loud; entries without oca_name are untouched by the group.
 *
 * Run: node scripts/test_round188_oca.mjs
 */

import { compile } from '../src/core/pine/compile.js';

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
const BARS = bars(40);

function runIt(src, opts) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + JSON.stringify(c.errors).slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 1 }, opts || {}));
    rt.runAll(BARS);
    return { rt, broker: rt.broker };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

/* cancel: A (stop 105, fills bar 11) kills B (stop 110, would fill bar 11 too) */
{
  const mk = (extra) => `//@version=5
strategy("oc", overlay=true, pyramiding=5)
if bar_index == 10
    strategy.entry("A", strategy.long, stop=105${extra})
    strategy.entry("B", strategy.long, stop=110${extra})
plot(strategy.position_size, title="p")`;
  const r = runIt(mk(', oca_name="G"'), {});
  ok(!r.error, 'oca cancel runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const ids = r.broker.entries.map((e) => e.id);
    ok(ids.length === 1 && ids[0] === 'A', 'B cancelled after A filled (open: [' + ids.join(',') + '])');
    ok(r.broker.pending.length === 0, 'no working orders left');
  }
  const r2 = runIt(mk(''), {});
  ok(!r2.error, 'no-oca control runs' + (r2.error ? ' -> ' + r2.error : ''));
  if (!r2.error) ok(r2.broker.entries.length === 2, 'without oca both fill (control proves the cancel)');
}

/* explicit strategy.oca.cancel parses (no throw) */
{
  const r = runIt(`//@version=5
strategy("occ", overlay=true, pyramiding=5)
if bar_index == 10
    strategy.entry("A", strategy.long, oca_name="G", oca_type=strategy.oca.cancel)
    strategy.entry("B", strategy.long, stop=110, oca_name="G", oca_type=strategy.oca.cancel)
plot(strategy.position_size, title="p")`, {});
  ok(!r.error, 'oca.cancel enum parses' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) ok(r.broker.entries.length === 1 && r.broker.entries[0].id === 'A', 'explicit cancel behaves cancel');
}

/* reduce: position 10; E1 qty 2 + E2 qty 5, same reduce group, same trigger */
{
  const r = runIt(`//@version=5
strategy("or", overlay=true)
if bar_index == 5
    strategy.entry("P", strategy.long, qty=10)
if bar_index == 10
    strategy.exit("E1", qty=2, profit=1, oca_name="G", oca_type=strategy.oca.reduce)
    strategy.exit("E2", qty=5, profit=1, oca_name="G", oca_type=strategy.oca.reduce)
plot(strategy.position_size, title="p")`, {});
  ok(!r.error, 'oca reduce runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const qs = r.broker.trades.map((t) => t.qty).sort((a, b) => a - b);
    ok(JSON.stringify(qs) === '[2,3]', 'E1 fills 2, E2 reduced 5->3 (got [' + qs.join(',') + '])');
    ok(Math.abs(r.broker.qty - 5) < 1e-9, 'position 5 left (got ' + r.broker.qty + ')');
  }
}

/* reduce to zero cancels; invalid oca_type stays loud */
{
  const r = runIt(`//@version=5
strategy("orz", overlay=true)
if bar_index == 5
    strategy.entry("P", strategy.long, qty=10)
if bar_index == 10
    strategy.exit("E1", qty=5, profit=1, oca_name="G", oca_type=strategy.oca.reduce)
    strategy.exit("E2", qty=5, profit=1, oca_name="G", oca_type=strategy.oca.reduce)
plot(strategy.position_size, title="p")`, {});
  ok(!r.error, 'reduce-to-zero runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.broker.trades.length === 1 && r.broker.trades[0].qty === 5, 'second exit reduced to zero and gone');
  }
  const bad = runIt(`//@version=5
strategy("ob", overlay=true)
if bar_index == 10
    strategy.entry("A", strategy.long, oca_name="G", oca_type="bogus")
plot(strategy.position_size, title="p")`, {});
  ok(bad.error && /oca_type/.test(bad.error), 'invalid oca_type loud (got ' + (bad.error || 'ran') + ')');
}

console.log('\nROUND188: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
