/**
 * test_round232_exit.mjs — ROUND232 exit modify + level-less pin.
 *
 * TV parity (reference §strategy.exit Remarks): repeated same-id exit calls
 * MODIFY the working order (used to accumulate); a level-less exit never
 * fills and never halts (exit creates no market orders); an unmatched
 * from_entry stays ignored.
 *
 * Run: node tests/unit/test_round232_exit.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
function runAll(src, bars, opts) {
  const c = compile(src);
  if (!c.ok) return { err: 'COMPILE: ' + ((c.errors[0] || {}).message || '?') };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 60, symbol: 'T', mintick: 1 }, opts));
    rt.runAll(bars);
    return { rt };
  } catch (e) { return { err: 'RUNTIME: ' + (e.message || e) }; }
}
const g = (r, n) => { const rec = r.rt && r.rt.globals.get(n); return rec ? rec.value : '<missing>'; };
const B = [];
for (let i = 0; i < 6; i++) B.push({ time: 1700000000 + i * 60, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10 });
// entry bar0 fills bar1 @101 (long 1)
const TAIL = 'ct = strategy.closedtrades\nps = strategy.position_size\nplot(1)\n';

// NOTE (ROUND235): exit levels ride the CLOSING side (TV parity, fixed this
// round — was entry-sided). Sell limit at/below the open fills at the open;
// above it waits. Sell stop breached (open below it) fills at the open.

// 1: same-bar double place modifies (lone 100 would fill bar2@102)
{
  const src = '//@version=6\nstrategy("T")\nif bar_index == 0\n    strategy.entry("E", strategy.long)\nif bar_index == 1\n    strategy.exit("X", "E", limit=100)\n    strategy.exit("X", "E", limit=1000)\n' + TAIL;
  const r = runAll(src, B);
  ok(!r.err && g(r, 'ct') === 0 && g(r, 'ps') === 1, 'same-bar modify holds (ct/ps ' + g(r, 'ct') + '/' + g(r, 'ps') + ')');
}
// 2: sanity — lone limit=100 IS marketable, fills bar2@102
{
  const src = '//@version=6\nstrategy("T")\nif bar_index == 0\n    strategy.entry("E", strategy.long)\nif bar_index == 1\n    strategy.exit("X", "E", limit=100)\nxp = strategy.closedtrades.exit_price(0)\n' + TAIL;
  const r = runAll(src, B);
  ok(!r.err && g(r, 'ct') === 1 && g(r, 'xp') === 102, 'lone marketable limit fills (ct/xp ' + g(r, 'ct') + '/' + g(r, 'xp') + ')');
}
// 3: modify across bars fills at the NEW level (103 marketable at bar4 open 104)
{
  const src = '//@version=6\nstrategy("T")\nif bar_index == 0\n    strategy.entry("E", strategy.long)\nif bar_index == 1 or bar_index == 2\n    strategy.exit("X", "E", limit=1000)\nif bar_index == 3\n    strategy.exit("X", "E", limit=103)\nxp = strategy.closedtrades.exit_price(0)\nnp = strategy.closedtrades.entry_price(0)\n' + TAIL;
  const r = runAll(src, B);
  ok(!r.err && g(r, 'ct') === 1 && g(r, 'xp') === 104 && g(r, 'np') === 101, 'cross-bar modify fills new level (xp/np ' + g(r, 'xp') + '/' + g(r, 'np') + ')');
}
// 4: stop modify across bars (waiting 99.5 -> breached 103.5 fills bar4 open)
{
  const src = '//@version=6\nstrategy("T")\nif bar_index == 0\n    strategy.entry("E", strategy.long)\nif bar_index == 1\n    strategy.exit("X", "E", stop=99.5)\nif bar_index == 3\n    strategy.exit("X", "E", stop=103.5)\nxp = strategy.closedtrades.exit_price(0)\n' + TAIL;
  const r = runAll(src, B);
  ok(!r.err && g(r, 'ct') === 1 && g(r, 'xp') === 104, 'breached stop fills open (xp ' + g(r, 'xp') + ')');
}
// 5: level-less exit holds the position open, no halt
{
  const src = '//@version=6\nstrategy("T")\nif bar_index == 0\n    strategy.entry("E", strategy.long)\nif bar_index == 1\n    strategy.exit("X", "E")\n' + TAIL;
  const r = runAll(src, B);
  ok(!r.err && g(r, 'ct') === 0 && g(r, 'ps') === 1, 'level-less exit holds (ct/ps ' + g(r, 'ct') + '/' + g(r, 'ps') + ')');
}
// 6: unmatched from_entry stays ignored, no halt
{
  const src = '//@version=6\nstrategy("T")\nif bar_index == 0\n    strategy.entry("E", strategy.long)\nif bar_index == 1\n    strategy.exit("X", "NOPE", limit=50)\n' + TAIL;
  const r = runAll(src, B);
  ok(!r.err && g(r, 'ct') === 0 && g(r, 'ps') === 1, 'unmatched from_entry ignored (ct/ps ' + g(r, 'ct') + '/' + g(r, 'ps') + ')');
}
// 7: exit without from_entry covers the position
{
  const src = '//@version=6\nstrategy("T")\nif bar_index == 0\n    strategy.entry("E", strategy.long)\nif bar_index == 1\n    strategy.exit("X", limit=100)\n' + TAIL;
  const r = runAll(src, B);
  ok(!r.err && g(r, 'ct') === 1, 'no from_entry covers all (ct ' + g(r, 'ct') + ')');
}

console.log('\nROUND232: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
