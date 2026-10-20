/**
 * test_round235_exitdir.mjs — ROUND235 exit closing-side direction.
 *
 * Reference §strategy.exit: TP fills "or better (higher for long, lower for
 * short)", SL "or worse (lower for long, higher for short)". A long exit
 * sells (marketable limit at/below the open, breached stop = open at/below
 * it); a short exit buys (mirror). Was entry-sided before this round.
 *
 * Run: node scripts/test_round235_exitdir.mjs
 */

import { compile } from '../src/core/pine/compile.js';

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
const BD = [];
for (let i = 0; i < 6; i++) BD.push({ time: 1700000000 + i * 60, open: 100 - i, high: 101 - i, low: 99 - i, close: 100 - i, volume: 10 });
const TAIL = 'ct = strategy.closedtrades\nps = strategy.position_size\nplot(1)\n';
const LE = 'if bar_index == 0\n    strategy.entry("E", strategy.long)\n';
const SE = 'if bar_index == 0\n    strategy.entry("E", strategy.short)\n';

// 1: long waiting limit (1000 above a 102-105 market) never fills
{
  const r = runAll('//@version=6\nstrategy("T")\n' + LE + 'if bar_index == 1\n    strategy.exit("X", "E", limit=1000)\n' + TAIL, B);
  ok(!r.err && g(r, 'ct') === 0 && g(r, 'ps') === 1, 'long wait limit holds (ct/ps ' + g(r, 'ct') + '/' + g(r, 'ps') + ')');
}
// 2: long marketable limit fills at the open (bar2 @102)
{
  const r = runAll('//@version=6\nstrategy("T")\n' + LE + 'if bar_index == 1\n    strategy.exit("X", "E", limit=100)\nxp = strategy.closedtrades.exit_price(0)\n' + TAIL, B);
  ok(!r.err && g(r, 'ct') === 1 && g(r, 'xp') === 102, 'long marketable limit (ct/xp ' + g(r, 'ct') + '/' + g(r, 'xp') + ')');
}
// 3: long rising touch fills touch-or-better (103, not the 102 open)
{
  const r = runAll('//@version=6\nstrategy("T")\n' + LE + 'if bar_index == 1\n    strategy.exit("X", "E", limit=103)\nxp = strategy.closedtrades.exit_price(0)\n' + TAIL, B);
  ok(!r.err && g(r, 'ct') === 1 && g(r, 'xp') === 103, 'long touch-or-better (xp ' + g(r, 'xp') + ')');
}
// 4: long unbreached stop waits (90 under a rising market)
{
  const r = runAll('//@version=6\nstrategy("T")\n' + LE + 'if bar_index == 1\n    strategy.exit("X", "E", stop=90)\n' + TAIL, B);
  ok(!r.err && g(r, 'ct') === 0 && g(r, 'ps') === 1, 'long wait stop holds (ct/ps ' + g(r, 'ct') + '/' + g(r, 'ps') + ')');
}
// 5: long breached stop fills at the open (104.5 over bar4 open 104)
{
  const r = runAll('//@version=6\nstrategy("T")\n' + LE + 'if bar_index == 3\n    strategy.exit("X", "E", stop=104.5)\nxp = strategy.closedtrades.exit_price(0)\n' + TAIL, B);
  ok(!r.err && g(r, 'ct') === 1 && g(r, 'xp') === 104, 'long breached stop (xp ' + g(r, 'xp') + ')');
}
// 6: short marketable limit mirrors (100 over bar2 open 98 -> 98)
{
  const r = runAll('//@version=6\nstrategy("T")\n' + SE + 'if bar_index == 1\n    strategy.exit("X", "E", limit=100)\nxp = strategy.closedtrades.exit_price(0)\n' + TAIL, BD);
  ok(!r.err && g(r, 'ct') === 1 && g(r, 'xp') === 98, 'short marketable limit (ct/xp ' + g(r, 'ct') + '/' + g(r, 'xp') + ')');
}
// 7: short waiting limit holds (90 under a 98-95 market waits to fall)
{
  const r = runAll('//@version=6\nstrategy("T")\n' + SE + 'if bar_index == 1\n    strategy.exit("X", "E", limit=90)\n' + TAIL, BD);
  ok(!r.err && g(r, 'ct') === 0 && g(r, 'ps') === -1, 'short wait limit holds (ct/ps ' + g(r, 'ct') + '/' + g(r, 'ps') + ')');
}
// 8: short breached stop fills at the open (97 at/below bar2 open 98)
{
  const r = runAll('//@version=6\nstrategy("T")\n' + SE + 'if bar_index == 1\n    strategy.exit("X", "E", stop=97)\nxp = strategy.closedtrades.exit_price(0)\n' + TAIL, BD);
  ok(!r.err && g(r, 'ct') === 1 && g(r, 'xp') === 98, 'short breached stop (xp ' + g(r, 'xp') + ')');
}
// 9: v5 absolute limit rides the same mirror (99 marketable at open 100)
{
  const bars = [];
  for (let i = 0; i < 6; i++) bars.push({ time: 1700000000 + i * 60, open: 100, high: 101, low: 98.5, close: 100, volume: 10 });
  const r = runAll('//@version=5\nstrategy("T")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 0\n    strategy.exit("X", from_entry="L", limit=99, qty=1)\nxp = strategy.closedtrades.exit_price(0)\n' + TAIL, bars);
  ok(!r.err && g(r, 'xp') === 100, 'v5 absolute mirror (xp ' + g(r, 'xp') + ')');
}

console.log('\nROUND235: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
