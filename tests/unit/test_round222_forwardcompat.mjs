/**
 * test_round222_forwardcompat.mjs — ROUND222 TV forward-compat.
 *
 * Newer declaration params must never kill a script: declMeta() accepts and
 * records them in meta.ignoredParams (renderer Log.debug's them, R221
 * pattern); input.* active= is accepted and recorded on the def.
 * Section C of the Pine audit pins the current lenient-superset behavior
 * (all accepted today; TV-strict rejections like alertcondition-in-strategy
 * are R225 work, marked TODO).
 *
 * Run: node tests/unit/test_round222_forwardcompat.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
const BARS = [
  { time: 1700000000, open: 1, high: 1.1, low: 0.9, close: 1, volume: 10 },
  { time: 1700000060, open: 1, high: 1.1, low: 0.9, close: 1, volume: 10 },
];
function runOk(src) {
  const c = compile(src);
  if (!c.ok) return { c, ran: false, err: (c.errors[0] || {}).message || 'compile failed' };
  try {
    const rt = c.createInstance({ tfSec: 60, symbol: 'T', mintick: 0.01 });
    rt.runAll(BARS);
    return { c, ran: true, rt };
  } catch (e) { return { c, ran: false, err: (e && e.message) || String(e) }; }
}

// 1-3: indicator with every new v6 decl param — ok, recorded, runs
{
  const r = runOk('//@version=6\nindicator("T", overlay=true, dynamic_requests=true, behind_chart=true, explicit_plot_zorder=true, calc_bars_count=100, shorttitle="T", precision=2)\nplot(close)\n');
  ok(r.c.ok && r.ran, 'indicator with new v6 decl params compiles and runs');
  const ig = (r.c.ok && r.c.meta.ignoredParams) || [];
  /* ROUND236: dynamic_requests is UNDERSTOOD now (meta.dynamicRequests), no
     longer lumped into ignoredParams. */
  ok(['behind_chart', 'explicit_plot_zorder', 'calc_bars_count'].every((k) => ig.includes(k)), 'new params recorded in ignoredParams');
  ok(r.c.meta.dynamicRequests === true && !ig.includes('dynamic_requests'), 'dynamic_requests consumed into meta');
  ok(!ig.includes('overlay') && !ig.includes('title'), 'consumed params NOT in ignoredParams');
}
// 4-5: strategy with new params — ok, recorded, runs
{
  const r = runOk('//@version=6\nstrategy("T", risk_free_rate=1, fill_orders_on_standard_ohlc=true, backtest_fill_limits_assumption=0, calc_bars_count=100, calc_on_every_history_tick=true)\nif bar_index > 0\n    strategy.entry("L", strategy.long)\n');
  ok(r.c.ok && r.ran, 'strategy with new v6 decl params compiles and runs');
  const ig = (r.c.ok && r.c.meta.ignoredParams) || [];
  ok(['risk_free_rate', 'fill_orders_on_standard_ohlc', 'backtest_fill_limits_assumption', 'calc_bars_count', 'calc_on_every_history_tick'].every((k) => ig.includes(k)), 'strategy extras recorded');
}
// 6: timeframe=/timeframe_gaps= — TF consumed by declMeta (R226), gaps still ignored
{
  const r = runOk('//@version=6\nindicator("T", timeframe="D", timeframe_gaps=true)\nplot(close)\n');
  const ig = (r.c.ok && r.c.meta.ignoredParams) || [];
  ok(r.c.ok && r.ran && r.c.meta.timeframe === 'D' && !ig.includes('timeframe') && ig.includes('timeframe_gaps'), 'timeframe consumed into meta (renderer runs HTF), gaps ignored');
}
// 7-8: input active= accepted + recorded
{
  const r = runOk('//@version=6\nindicator("T", overlay=true)\na = input.int(5, "N", active=false)\nb = input.int(6, "M")\nplot(a + b)\n');
  const defs = r.c.ok ? r.c.collectInputs({ tfSec: 60, symbol: 'T', mintick: 0.01 }).inputs : [];
  const da = defs.find((d) => d.title === 'N'), db = defs.find((d) => d.title === 'M');
  ok(r.ran && da && da.active === false, 'input active=false recorded on def');
  ok(r.ran && db && db.active === true, 'input default active=true');
}
// 9-14: section-C leniency pins (superset behavior, documented)
{
  const H = '//@version=6\nindicator("T", overlay=true)\n';
  /* ROUND225: v6 removals are loud now (migration guide) — the pins moved
     from lenient to loud for v6 headers; older versions stay lenient. */
  const noisy = (src) => runOk(H + src);
  ok(noisy('plot(close, transp=50)\n').err && /removed in Pine v6/.test(noisy('plot(close, transp=50)\n').err), 'C-pin: v6 transp= loud (removed)');
  ok(!runOk('//@version=4\nstudy("T")\nplot(close, transp=50)\n').err, 'C-pin: v4 transp= still mapped');
  const lit = runOk(H + 'plot(5[1])\n');
  ok(lit.err && /literal/.test(lit.err), 'C-pin: v6 history on literal loud');
  ok(runOk(H + 'plot(nz(true) ? 1 : 0)\n').ran, 'C-pin: nz(bool) accepted (lenient)');
  ok(runOk(H + 'plot(close, linewidth=0)\n').ran, 'C-pin: linewidth=0 accepted (lenient)');
  ok(runOk(H + 'for ln in line.all\n    line.delete(ln)\nplot(close)\n').ran, 'C-pin: for...in over line.all accepted');
  const ac = runOk('//@version=6\nstrategy("T")\nif bar_index > 0\n    strategy.entry("L", strategy.long)\nalertcondition(close > open, title="X", message="m")\n');
  ok(ac.err && /cannot be used in strategy/.test(ac.err), 'C-pin: alertcondition in strategy loud (ROUND225)');
}

console.log('\nROUND222: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
