/**
 * test_round177_groups.mjs — ROUND177 Profits-breakdown grouping + CSV export.
 *
 * tradeGroups: per-signal sums (entryId, TV's MacdLE/MacdSE rows), per-side
 * sums, total. tradesCsv: header + one full-precision row per closed trade.
 *
 * Run: node scripts/test_round177_groups.mjs
 */

import { tradeGroups, tradesCsv } from '../src/core/pine/stdlib/strategy.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const TRADES = [
  { entryId: 'MacdLE', exitId: 'X', dir: 1, qty: 10, entryBar: 1, entryPrice: 100, exitBar: 2, exitPrice: 110, profit: 100, entryTime: 1000, exitTime: 2000 },
  { entryId: 'MacdSE', exitId: 'X', dir: -1, qty: 10, entryBar: 3, entryPrice: 110, exitBar: 4, exitPrice: 105, profit: 50, entryTime: 3000, exitTime: 4000 },
  { entryId: 'MacdLE', exitId: 'X', dir: 1, qty: 10, entryBar: 5, entryPrice: 105, exitBar: 6, exitPrice: 100, profit: -50, entryTime: 5000, exitTime: 6000 },
];

/* --- tradeGroups --- */
{
  const g = tradeGroups(TRADES);
  ok(g.bySignal.length === 2, 'two signal groups (got ' + g.bySignal.length + ')');
  const le = g.bySignal.find((x) => x.name === 'MacdLE');
  const se = g.bySignal.find((x) => x.name === 'MacdSE');
  ok(le && le.profit === 50 && le.n === 2, 'MacdLE sums to +50 over 2 (got ' + (le && le.profit) + '/' + (le && le.n) + ')');
  ok(se && se.profit === 50 && se.n === 1, 'MacdSE sums to +50 over 1');
  ok(g.bySignal[0].profit >= g.bySignal[1].profit, 'signals sorted desc by profit');
  const lo = g.bySide.find((x) => x.name === 'Long');
  const sh = g.bySide.find((x) => x.name === 'Short');
  ok(lo && lo.profit === 50 && lo.n === 2, 'Long side +50/2');
  ok(sh && sh.profit === 50 && sh.n === 1, 'Short side +50/1');
  ok(g.total === 100, 'total = 100 (got ' + g.total + ')');
}
{
  const g = tradeGroups([]);
  ok(g.bySignal.length === 0 && g.bySide.length === 0 && g.total === 0, 'empty trades -> empty groups');
  const g2 = tradeGroups([{ dir: 1, profit: NaN, entryId: '' }]);
  ok(g2.bySignal.length === 1 && g2.bySignal[0].profit === 0, 'na profit counts as 0 under (no signal)');
}

/* --- tradesCsv --- */
{
  const csv = tradesCsv(TRADES, 'USD');
  const lines = csv.split('\n');
  ok(lines.length === 4, 'header + 3 rows (got ' + lines.length + ')');
  ok(lines[0] === 'Trade,Side,Qty,Entry time,Entry price,Exit time,Exit price,Net PnL (USD),Return %', 'header exact (got ' + lines[0] + ')');
  ok(lines[1].startsWith('1,Long,10,'), 'row 1 long prefix (got ' + lines[1].slice(0, 20) + ')');
  ok(lines[1].includes('1970-01-01T00:16:40.000Z'), 'entry time ISO (got ' + lines[1] + ')');
  ok(lines[2].startsWith('2,Short,10,'), 'row 2 short');
  ok(/,10\.0000$/.test(lines[1]), 'return 10% full precision (got ' + lines[1].slice(-12) + ')');
  ok(tradesCsv([], 'USD').split('\n').length === 1, 'empty trades -> header only');
}

console.log('\nROUND177: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
