/**
 * test_round194_summary.mjs — ROUND194 Performance Summary helper.
 *
 * perfSummary: All/Long/Short split (net/gross/PF/counts/avgs/largest/bars),
 * equity-shared (maxDD/maxRU/buy&hold), Sharpe/Sortino, passthroughs —
 * all pure.
 *
 * Run: node scripts/test_round194_summary.mjs
 */

import { perfSummary } from '../src/core/pine/stdlib/strategy.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9);

const T = (dir, profit, eb, xb) => ({ dir, profit, qty: 1, entryPrice: 100, exitPrice: 100, entryBar: eb, exitBar: xb });
const TRADES = [
  T(1, 100, 0, 5), T(1, -50, 5, 7),
  T(-1, 200, 7, 10), T(-1, -300, 10, 11), T(-1, 0, 11, 12),
];
const EQ = [100000, 100100, 100050, 100250, 99950, 99950];
const BH = [{ t: 1, v: 100000 }, { t: 2, v: 105000 }];

{
  const S = perfSummary(TRADES, { capital: 100000, equity: EQ, buyHold: BH, fees: 12.5, openPL: 7, openTrades: 1, maxLong: 2, maxShort: 1 });
  ok(S.all.n === 5 && S.all.wins === 2 && S.all.losses === 2 && S.all.evens === 1, 'all counts 5/2/2/1');
  ok(S.all.net === -50 && near(S.all.netPct, -0.05), 'all net -50 (-0.05%)');
  ok(S.all.grossP === 300 && S.all.grossL === 350 && near(S.all.profitFactor, 300 / 350), 'all gross 300/350 PF');
  ok(near(S.all.winPct, 40), 'all win% 40');
  ok(S.all.avg === -10 && near(S.all.avgPct, -0.01), 'all avg -10');
  ok(S.all.avgW === 150 && S.all.avgL === -175 && near(S.all.ratio, 150 / 175), 'all avgW/avgL/ratio');
  ok(S.all.largestW === 200 && S.all.largestL === -300, 'all largest +200/-300');
  ok(near(S.all.avgBars, 2.4) && near(S.all.avgWBars, 4) && near(S.all.avgLBars, 1.5), 'all avg bars 2.4/4/1.5');
  ok(S.long.n === 2 && S.long.net === 50 && S.long.profitFactor === 2 && near(S.long.winPct, 50), 'long split 2/+50/PF2/50%');
  ok(S.long.avg === 25 && S.long.avgW === 100 && S.long.avgL === -50 && S.long.ratio === 2, 'long avgs 25/100/-50/r2');
  ok(near(S.long.avgBars, 3.5), 'long avgBars 3.5');
  ok(S.short.n === 3 && S.short.net === -100 && near(S.short.profitFactor, 200 / 300), 'short split 3/-100');
  ok(S.short.evens === 1 && near(S.short.winPct, 100 / 3), 'short even + win%');
  ok(S.all.net === S.long.net + S.short.net && S.all.grossP === S.long.grossP + S.short.grossP, 'additivity all=long+short');
  ok(S.shared.maxDD === 300 && near(S.shared.maxDDPct, 300 / 100250 * 100), 'maxDD 300 of peak (got ' + S.shared.maxDD + ')');
  ok(S.shared.maxRU === 250 && near(S.shared.maxRUPct, 0.25), 'maxRU 250 (0.25% of cap)');
  ok(S.shared.bhNet === 5000 && near(S.shared.bhPct, 5), 'buy&hold +5000 (+5%)');
  ok(isFinite(S.all.sharpe) && S.all.sharpe < 0 && isFinite(S.all.sortino) && S.all.sortino < 0, 'sharpe/sortino finite negative');
  ok(S.shared.fees === 12.5 && S.shared.openPL === 7 && S.shared.openTrades === 1, 'fees/open passthrough');
  ok(S.shared.maxLong === 2 && S.shared.maxShort === 1 && S.shared.marginCalls === 0, 'max-held passthrough, margin 0');
}
{
  const S = perfSummary([], { capital: 1000, equity: [], buyHold: [] });
  ok(S.all.n === 0 && S.all.profitFactor === 0 && S.all.sharpe === 0 && S.all.sortino === 0, 'empty-safe zeros');
  ok(S.shared.maxDD === 0 && S.shared.bhNet === 0 && S.shared.fees === undefined, 'empty-shared zeros/undefined');
  ok(!isFinite(S.all.avgW) && !isFinite(S.all.avgBars), 'empty avgs NaN (panel shows —)');
}
{
  const S = perfSummary([T(1, 10, 0, 1), T(1, 20, 1, 3)], { capital: 1000 });
  ok(S.all.profitFactor === Infinity && S.all.ratio === Infinity, 'all-wins PF/ratio Infinity');
  ok(S.short.n === 0 && S.short.profitFactor === 0, 'missing side zero-safe');
}
{
  // trades without bar indexes are excluded from bar avgs, not from money
  const S = perfSummary([{ dir: 1, profit: 40, qty: 1, entryPrice: 10 }, T(1, 60, 0, 4)], { capital: 1000 });
  ok(S.all.net === 100 && S.all.avgBars === 4, 'barless trade keeps money, skips bars (got ' + S.all.avgBars + ')');
}
{
  // non-finite profits degrade to 0, never NaN the aggregates
  const S = perfSummary([{ dir: 1, profit: NaN, qty: 1, entryPrice: 10, entryBar: 0, exitBar: 2 }], { capital: 1000 });
  ok(S.all.net === 0 && S.all.n === 1 && S.all.evens === 1, 'na profit counts as even zero');
}

console.log('\nROUND194: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
