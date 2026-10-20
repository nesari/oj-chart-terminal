/**
 * test_round183_analysis.mjs — ROUND183 Trades analysis helper.
 *
 * tradesAnalysis: expectancy/outliers/largest, returns histogram, donut,
 * streaks, weekday patterns — all pure.
 *
 * Run: node scripts/test_round183_analysis.mjs
 */

import { tradesAnalysis, tradeReturn } from '../src/core/pine/stdlib/strategy.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const T = (n, profit, qty, ep, day) => ({
  n, entryId: 'S', dir: profit >= 0 ? 1 : -1, qty, entryPrice: ep, exitPrice: ep,
  profit, entryTime: day, exitTime: day,
});
const TRADES = [
  T(1, 100, 10, 100, 1700000000),  // Mon
  T(2, -50, 10, 100, 1700086400),  // Tue
  T(3, 200, 10, 100, 1700086400),  // Tue
  T(4, -300, 10, 100, 1700172800), // Wed
  T(5, 0, 10, 100, 1700172800),    // Wed even
];

{
  const A = tradesAnalysis(TRADES, 100000);
  ok(A.n === 5 && A.wins === 2 && A.losses === 2 && A.evens === 1, 'counts 5/2/2/1');
  ok(A.net === -50 && A.expectancy === -10, 'net -50 expectancy -10 (got ' + A.net + '/' + A.expectancy + ')');
  ok(Math.abs(A.expectancyPct - (-0.01)) < 1e-9, 'expectancy % of capital (got ' + A.expectancyPct + ')');
  ok(A.largestWin === 200 && A.largestLoss === -300, 'largest win/loss');
  ok(A.donut.total === 5 && Math.abs(A.donut.winPct - 40) < 1e-9, 'donut 40% wins');
  ok(A.bins.length > 0, 'histogram bins built (' + A.bins.length + ')');
  const tot = A.bins.reduce((a, b) => a + b.w + b.l, 0);
  ok(tot === 4, 'sided trades land in bins; the even one colors neither (got ' + tot + ')');
  ok(isFinite(A.avgWinRet) && isFinite(A.avgLossRet), 'avg win/loss returns finite');
  ok(A.streaks.maxWin === 1 && A.streaks.maxLoss === 1, 'alternation: max streaks 1/1');
  ok(A.streaks.runs.length === 4, 'even breaks runs without adding one (got ' + A.streaks.runs.length + ')');
  const wed = A.weekdays[2];
  ok(wed.n === 2 && wed.net === 150, 'Wed aggregates 2 trades net +150');
  ok(A.weekdays.reduce((a, d) => a + d.n, 0) === 5, 'all trades dated across weekdays');
}
{
  const A = tradesAnalysis([T(1, 10, 1, 100, 1700000000), T(2, 20, 1, 100, 1700000000), T(3, -5, 1, 100, 1700000000), T(4, -6, 1, 100, 1700000000), T(5, -7, 1, 100, 1700000000)], 1000);
  ok(A.streaks.maxWin === 2 && A.streaks.maxLoss === 3, 'streaks 2W/3L');
  ok(Math.abs(A.streaks.avgWin - 2) < 1e-9 && Math.abs(A.streaks.avgLoss - 3) < 1e-9, 'avg streak lengths');
  ok(A.streaks.current.dir === -1 && A.streaks.current.n === 3, 'current streak L3');
}
{
  // outlier: one monster among dust
  const dust = [];
  for (let i = 0; i < 10; i++) dust.push(T(i, 1, 1, 100, 1700000000));
  dust.push(T(99, 1000, 1, 100, 1700000000));
  const A = tradesAnalysis(dust, 100000);
  ok(A.outliers === 1000, 'monster trade flagged outlier (got ' + A.outliers + ')');
  ok(Math.abs(A.outliersPct - 1) < 1e-9, 'outliers % of capital = 1%');
}
{
  const A = tradesAnalysis([], 1000);
  ok(A.n === 0 && A.bins.length === 0 && A.streaks.maxWin === 0 && A.donut.total === 0, 'empty-safe');
  ok(tradeReturn({}) !== tradeReturn({}), 'na return is NaN');
  ok(tradeReturn({ profit: 10, entryPrice: 100, qty: 2 }) === 5, 'return = 10/200 = 5%');
}

console.log('\nROUND183: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
