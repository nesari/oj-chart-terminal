/**
 * test_round179_range.mjs — ROUND179 sticky-toolbar range filter.
 *
 * filterReport: keeps trades whose EXIT lands in [from, to], recomputes
 * stats over the slice, slices the perf series; fees stay unknown.
 *
 * Run: node scripts/test_round179_range.mjs
 */

import { filterReport } from '../src/core/pine/stdlib/strategy.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const REP = {
  initialCapital: 10000,
  currency: 'USD',
  trades: [
    { entryId: 'A', dir: 1, qty: 1, entryPrice: 100, exitPrice: 110, profit: 10, entryTime: 1000, exitTime: 2000 },
    { entryId: 'B', dir: -1, qty: 1, entryPrice: 110, exitPrice: 105, profit: 5, entryTime: 3000, exitTime: 4000 },
    { entryId: 'A', dir: 1, qty: 1, entryPrice: 105, exitPrice: 100, profit: -5, entryTime: 5000, exitTime: 6000 },
  ],
  perf: {
    capital: 10000,
    equity: [{ t: 1000, v: 10000 }, { t: 2000, v: 10010 }, { t: 4000, v: 10015 }, { t: 6000, v: 10010 }],
    buyHold: [{ t: 1000, v: 10000 }, { t: 2000, v: 10100 }, { t: 4000, v: 9900 }, { t: 6000, v: 10150 }],
  },
};

{
  const f = filterReport(REP, 1500, 4500);
  ok(f.trades.length === 2, 'window keeps 2 exits (got ' + f.trades.length + ')');
  ok(f.stats.trades === 2 && f.stats.wins === 2, 'stats recomputed: 2 trades, 2 wins');
  ok(f.stats.netProfit === 15, 'net over slice = 15 (got ' + f.stats.netProfit + ')');
  ok(f.stats.fees === undefined, 'fees unknown on a slice');
  ok(f.perf.equity.length === 2 && f.perf.equity[0].t === 2000, 'equity sliced to window');
  ok(f.perf.buyHold.length === 2, 'buy&hold sliced too');
  ok(f.ranged === true, 'ranged flag set');
}
{
  const f = filterReport(REP, null, null);
  ok(f.trades.length === 3 && f.stats.netProfit === 10, 'null bounds keep everything (net 10)');
}
{
  const f = filterReport(REP, 7000, 8000);
  ok(f.trades.length === 0, 'empty window, no trades');
  ok(f.stats.trades === 0 && f.stats.netProfit === 0 && f.stats.profitFactor === 0, 'empty stats are zeroed');
  ok(f.perf.equity.length === 0, 'empty equity slice');
}
{
  const f = filterReport(REP, null, 2500);
  ok(f.trades.length === 1 && f.trades[0].exitTime === 2000, 'open-ended to-bound works');
  const g = filterReport(REP, 3500, null);
  ok(g.trades.length === 2, 'open-ended from-bound works');
}
{
  const f = filterReport(null, 1, 2);
  ok(f.trades.length === 0 && f.stats.trades === 0, 'null report is safe');
}

console.log('\nROUND179: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
