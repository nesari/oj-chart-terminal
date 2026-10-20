/**
 * test_round212_closefill.mjs — ROUND212 process_orders_on_close (TV parity).
 *
 * Declaration literal (or dialog strategyProps) switches market fills from
 * next-bar-open to signal-bar-close; stop/limit levels still fill at touch.
 * A market order signaled on the last bar fills with the flag, never without.
 * (Open lots live in broker.entries; closed portions in broker.trades.)
 *
 * Run: node tests/unit/test_round212_closefill.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

/* Rising bars; signals reference fixed indices. */
const BARS = Array.from({ length: 10 }, (_, i) => ({
  time: 1790600400 + i * 900, open: 100 + i, high: 102 + i, low: 98 + i,
  close: 101 + i, volume: 10,
}));
function runIt(src, opts) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 0.01 }, opts || {}));
    rt.runAll(BARS);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
const S = (extra) => `//@version=5\nstrategy("T", overlay=true${extra || ''})\n`;
const lot = (rt) => rt.broker.entries[0];
const trade = (rt) => rt.broker.trades[0];

{
  const d = runIt(S('') + 'if bar_index == 2\n    strategy.entry("L", strategy.long)\nplot(1)\n');
  const f = runIt(S(', process_orders_on_close=true') + 'if bar_index == 2\n    strategy.entry("L", strategy.long)\nplot(1)\n');
  ok(!d.error && !f.error, 'both run' + (d.error || f.error ? ' -> ' + (d.error || f.error) : ''));
  if (!d.error && !f.error) {
    const ld = lot(d.rt), lf = lot(f.rt);
    ok(ld && lf, 'one open lot each');
    if (ld && lf) {
      ok(ld.bar === 3 && ld.price === 103, 'default: next-bar open (got bar ' + ld.bar + ' @' + ld.price + ')');
      ok(lf.bar === 2 && lf.price === 103, 'flag: signal-bar close (got bar ' + lf.bar + ' @' + lf.price + ')');
    }
  }
}
{
  const d = runIt(S('') + 'if bar_index == 2\n    strategy.entry("L", strategy.long)\nif bar_index == 5\n    strategy.close("L")\nplot(1)\n');
  const f = runIt(S(', process_orders_on_close=true') + 'if bar_index == 2\n    strategy.entry("L", strategy.long)\nif bar_index == 5\n    strategy.close("L")\nplot(1)\n');
  ok(!d.error && !f.error, 'exit runs');
  if (!d.error && !f.error) {
    const td = trade(d.rt), tf = trade(f.rt);
    ok(td && tf, 'one closed trade each');
    if (td && tf) {
      ok(td.exitBar === 6 && td.exitPrice === 106, 'default exit next open (got ' + td.exitBar + ' @' + td.exitPrice + ')');
      ok(tf.exitBar === 5 && tf.exitPrice === 106, 'flag exit same close (got ' + tf.exitBar + ' @' + tf.exitPrice + ')');
    }
  }
}
{
  // stop level touched on the signal bar fills at the level in both modes (bars differ)
  const src = (decl) => S(decl) + 'if bar_index == 2\n    strategy.entry("L", strategy.long, stop=103.5)\nplot(1)\n';
  const d = runIt(src(''));
  const f = runIt(src(', process_orders_on_close=true'));
  ok(!d.error && !f.error, 'stop runs');
  if (!d.error && !f.error) {
    const ld = lot(d.rt), lf = lot(f.rt);
    ok(ld && lf && ld.price === 103.5 && lf.price === 103.5, 'stop fills at level both modes');
    if (ld && lf) ok(ld.bar === 3 && lf.bar === 2, 'stop bars differ (got ' + ld.bar + '/' + lf.bar + ')');
  }
}
{
  // last-bar market order: default strands it, flag fills at the last close
  const src = S('') + 'if barstate.islast\n    strategy.entry("L", strategy.long)\nplot(1)\n';
  const d = runIt(src);
  ok(!d.error && d.rt.broker.qty === 0, 'default: last-bar order never fills');
  const f = runIt(S(', process_orders_on_close=true') + 'if barstate.islast\n    strategy.entry("L", strategy.long)\nplot(1)\n');
  ok(!f.error && f.rt.broker.qty === 1, 'flag: last-bar order fills');
  if (!f.error && f.rt.broker.qty === 1) {
    ok(f.rt.broker.avg === 110, 'filled at last close (got ' + f.rt.broker.avg + ')');
  }
}
{
  // strategy.order() nets same-bar under the flag
  const f = runIt(S(', process_orders_on_close=true') + 'if bar_index == 2\n    strategy.order("O", strategy.long, qty=3)\nplot(1)\n');
  ok(!f.error && f.rt.broker.qty === 3 && f.rt.broker.avg === 103, 'order() same-bar fill');
}
{
  // dialog/strategyProps override wins over the declaration default
  const r = runIt(S('') + 'if bar_index == 2\n    strategy.entry("L", strategy.long)\nplot(1)\n',
    { strategyProps: { process_orders_on_close: true } });
  ok(!r.error && lot(r.rt) && lot(r.rt).bar === 2, 'strategyProps override fills same-bar');
}
{
  // declaration literal folds into meta
  const c = compile(S(', process_orders_on_close=true') + 'plot(1)\n');
  ok(c.ok && c.meta.strategy && c.meta.strategy.process_orders_on_close === true, 'literal folds to meta');
}

console.log('\nROUND212: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
