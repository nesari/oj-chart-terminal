/**
 * test_round229_account.mjs — ROUND229 account getters + session bar edges.
 *
 * strategy avg and percent getters, max runup, max contracts held,
 * openprofit percent, position entry name, capital held and
 * margin liquidation price (v6 reference, linear solve of the R213 rule),
 * plus session.isfirstbar/islastbar day edges. Values hand-computed.
 *
 * Run: node tests/unit/test_round229_account.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
const near = (a, b, e) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (e || 1e-9);
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
const pv = (r, i) => { const k = r.rt.out.plotsOrder[i || 0]; return r.rt.out.plots.get(k).values; };

// two round trips: +10 then -15 (opens crafted; fills at next open)
const B = [
  { time: 1700000000, open: 100, high: 100, low: 100, close: 100, volume: 10 },
  { time: 1700000060, open: 100, high: 100, low: 100, close: 100, volume: 10 },
  { time: 1700000120, open: 100, high: 100, low: 100, close: 100, volume: 10 },
  { time: 1700000180, open: 110, high: 110, low: 110, close: 110, volume: 10 },
  { time: 1700000240, open: 110, high: 110, low: 110, close: 110, volume: 10 },
  { time: 1700000300, open: 110, high: 110, low: 110, close: 110, volume: 10 },
  { time: 1700000360, open: 110, high: 110, low: 110, close: 110, volume: 10 },
  { time: 1700000420, open: 95, high: 95, low: 95, close: 95, volume: 10 },
  { time: 1700000480, open: 95, high: 95, low: 95, close: 95, volume: 10 },
];
const STRAT = '//@version=6\nstrategy("T")\nif bar_index == 0\n    strategy.entry("A", strategy.long)\nif bar_index == 2\n    strategy.close("A")\nif bar_index == 4\n    strategy.entry("B", strategy.long)\nif bar_index == 6\n    strategy.close("B")\n';

// 1-6: averages + percents
{
  const src = STRAT + 'a = strategy.avg_trade\nap = strategy.avg_trade_percent\nw = strategy.avg_winning_trade\nl = strategy.avg_losing_trade\nlp = strategy.avg_losing_trade_percent\nplot(1)\n';
  const r = runAll(src, B);
  ok(!r.err && g(r, 'a') === -2.5, 'avg_trade -2.5 (got ' + g(r, 'a') + ')');
  ok(!r.err && near(g(r, 'ap'), (10 - 15 / 110 * 100) / 2, 1e-9), 'avg_trade_percent (got ' + g(r, 'ap') + ')');
  ok(!r.err && g(r, 'w') === 10, 'avg_winning_trade 10');
  ok(!r.err && g(r, 'l') === -15, 'avg_losing_trade -15');
  ok(!r.err && near(g(r, 'lp'), -15 / 110 * 100, 1e-9), 'avg_losing_trade_percent');
  const r0 = runAll('//@version=6\nstrategy("T")\nplot(strategy.avg_trade)\n', B.slice(0, 2));
  ok(!r0.err && pv(r0, 0).every((v) => v == null || (v && v.__pineNA)), 'avg_trade na with no trades');
}
// 7-10: run-up + capital percents + max held
{
  const src = STRAT + 'ru = strategy.max_runup\nnp = strategy.netprofit_percent\ngp = strategy.grossprofit_percent\nmc = strategy.max_contracts_held_all\nml = strategy.max_contracts_held_long\nms = strategy.max_contracts_held_short\nplot(1)\n';
  const r = runAll(src, B);
  ok(!r.err && g(r, 'ru') === 10, 'max_runup 10 (got ' + g(r, 'ru') + ')');
  ok(!r.err && near(g(r, 'np'), -0.0005, 1e-12), 'netprofit_percent -0.0005');
  ok(!r.err && near(g(r, 'gp'), 0.001, 1e-12), 'grossprofit_percent 0.001');
  ok(!r.err && g(r, 'mc') === 1 && g(r, 'ml') === 1 && g(r, 'ms') === 0, 'max contracts 1/1/0');
}
// 11-12: open position reads (own scenario, stays open)
{
  const B2 = B.slice(0, 8).map((b, i) => Object.assign({}, b, { open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i }));
  const src = '//@version=6\nstrategy("T")\nif bar_index == 2\n    strategy.entry("B", strategy.long)\nop = strategy.openprofit\nopp = strategy.openprofit_percent\nnm = strategy.position_entry_name\nplot(1)\n';
  const r = runAll(src, B2);
  // fills bar3 @103; last close 107 -> (107-103)*1 = 4; pct 4/1M*100
  ok(!r.err && g(r, 'op') === 4 && near(g(r, 'opp'), 0.0004, 1e-12) && g(r, 'nm') === 'B', 'openprofit/pct/entry_name (got ' + g(r, 'op') + '/' + g(r, 'opp') + '/' + g(r, 'nm') + ')');
  const r2 = runAll('//@version=6\nstrategy("T")\nplot(strategy.position_entry_name)\n', B2.slice(0, 2));
  ok(!r2.err && pv(r2, 0).every((v) => v == null || (v && v.__pineNA)), 'entry_name na when flat');
}
// 13-14: capital_held + liquidation price (declared margin_long=25)
{
  const B3 = B.slice(0, 6).map((b) => Object.assign({}, b, { open: 100, high: 100, low: 100, close: 100 }));
  const src = '//@version=6\nstrategy("T", margin_long=25, initial_capital=10000)\nif bar_index == 0\n    strategy.entry("L", strategy.long, qty=200)\nch = strategy.opentrades.capital_held\nliq = strategy.margin_liquidation_price\nplot(1)\n';
  const r = runAll(src, B3);
  // held = 200*100*0.25 = 5000; liq: K=200*.25-200=-150, RHS=10000-20000=-10000 -> 66.67
  ok(!r.err && g(r, 'ch') === 5000, 'capital_held 5000 (got ' + g(r, 'ch') + ')');
  ok(!r.err && near(g(r, 'liq'), 200 / 3, 1e-9), 'liquidation ~66.67 (got ' + g(r, 'liq') + ')');
  const r2 = runAll('//@version=6\nstrategy("T")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nch = strategy.opentrades.capital_held\nliq = strategy.margin_liquidation_price\nplot(1)\n', B3);
  const isNA = (v) => v && v.__pineNA;
  ok(!r2.err && isNA(g(r2, 'ch')) && isNA(g(r2, 'liq')), 'unmargined -> na/na');
}
// 15-18: session day edges (two UTC days)
{
  const D = 1700265600; // Sat 2023-11-18 00:00 UTC
  const bars = [
    { time: D - 7200, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { time: D - 3600, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { time: D + 1800, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { time: D + 7200, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  ];
  const src = '//@version=6\nindicator("T")\nplot(session.isfirstbar ? 1 : 0)\nplot(session.islastbar ? 1 : 0)\nplot(session.isfirstbar_regular ? 1 : 0)\nplot(session.islastbar_regular ? 1 : 0)\n';
  const r = runAll(src, bars, { tfSec: 3600 });
  const vals = [0, 1, 2, 3].map((k) => pv(r, k));
  const want = [[1, 0, 1, 0], [0, 1, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  // isfirstbar: bar0 (no prev) + bar2 (day change); islastbar: bar1 (day change) + bar3 (no next)
  want[0] = [1, 0, 1, 0]; want[1] = [0, 1, 0, 1]; want[2] = [1, 0, 1, 0]; want[3] = [0, 1, 0, 1];
  let good = !r.err;
  for (let k = 0; k < 4 && good; k++) for (let i = 0; i < 4 && good; i++) if (vals[k][i] !== want[k][i]) good = false;
  ok(good, 'isfirstbar/islastbar(+regular) day edges');
}

console.log('\nROUND229: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
