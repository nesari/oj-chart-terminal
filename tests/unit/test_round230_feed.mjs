/**
 * test_round230_feed.mjs — ROUND230 vendor-feed stubs + currency conversion.
 *
 * request.dividends/splits/earnings/financial/quandl/seed/economic/footprint
 * are loud with feed-specific messages (ignore_invalid_symbol=true degrades
 * to na); request.currency_rate returns 1 for same-currency pairs and is
 * loud otherwise; security(..., currency=) no-ops on USD and is loud on
 * anything else; strategy.convert_to_account/convert_to_symbol are the
 * identity while account and chart currencies match; footprint.* and
 * volume_row.* are loud per function; calc_on_every_history_tick /
 * dynamic_requests / slippage stay visible in meta.ignoredParams.
 *
 * Run: node tests/unit/test_round230_feed.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
function runAll(src, bars, opts) {
  const c = compile(src);
  if (!c.ok) return { err: 'COMPILE: ' + ((c.errors[0] || {}).message || '?'), meta: null };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 60, symbol: 'T', mintick: 1 }, opts));
    rt.runAll(bars);
    return { rt, meta: c.meta };
  } catch (e) { return { err: 'RUNTIME: ' + (e.message || e), meta: c.meta }; }
}
const g = (r, n) => { const rec = r.rt && r.rt.globals.get(n); return rec ? rec.value : '<missing>'; };
const pv = (r, i) => { const k = r.rt.out.plotsOrder[i || 0]; return r.rt.out.plots.get(k).values; };
const isNAPlot = (r, i) => pv(r, i).every((v) => v == null || (v && v.__pineNA));
const B = [
  { time: 1700000000, open: 100, high: 101, low: 99, close: 100, volume: 10 },
  { time: 1700000060, open: 100, high: 101, low: 99, close: 101, volume: 10 },
  { time: 1700000120, open: 101, high: 102, low: 100, close: 102, volume: 10 },
];

// 1-3: same-currency pairs return 1 (positional, enum, named)
{
  const r = runAll('//@version=6\nindicator("T")\nr = request.currency_rate("USD", "USD")\nplot(r)\n', B);
  ok(!r.err && pv(r, 0).every((v) => v === 1), 'currency_rate USD/USD = 1');
  const r2 = runAll('//@version=6\nindicator("T")\nr = request.currency_rate(currency.USD, currency.USD)\nplot(r)\n', B);
  ok(!r2.err && pv(r2, 0).every((v) => v === 1), 'currency_rate enum/enum = 1');
  const r3 = runAll('//@version=6\nindicator("T")\nr = request.currency_rate(from="EUR", to="EUR")\nplot(r)\n', B);
  ok(!r3.err && pv(r3, 0).every((v) => v === 1), 'currency_rate named same = 1');
}
// 4-6: cross-currency loud, ignore flag degrades, bad code loud
{
  const r = runAll('//@version=6\nindicator("T")\nr = request.currency_rate("USD", "EUR")\nplot(r)\n', B);
  ok(!!r.err && r.err.indexOf('currency_rate') >= 0 && r.err.indexOf('FX feed') >= 0, 'currency_rate USD/EUR loud (' + r.err + ')');
  const r2 = runAll('//@version=6\nindicator("T")\nr = request.currency_rate("USD", "EUR", ignore_invalid_currency=true)\nplot(r)\n', B);
  ok(!r2.err && isNAPlot(r2, 0), 'currency_rate ignore flag -> na');
  const r3 = runAll('//@version=6\nindicator("T")\nr = request.currency_rate("USD", "XX")\nplot(r)\n', B);
  ok(!!r3.err && r3.err.indexOf('invalid currency') >= 0, 'currency_rate bad code loud (' + r3.err + ')');
}
// 7-9: corporate actions loud, ignore degrades
{
  const r = runAll('//@version=6\nindicator("T")\nd = request.dividends("NASDAQ:AAPL")\nplot(d)\n', B);
  ok(!!r.err && r.err.indexOf('request.dividends') >= 0 && r.err.indexOf('feed') >= 0, 'dividends loud (' + r.err + ')');
  const r2 = runAll('//@version=6\nindicator("T")\nd = request.dividends("NASDAQ:AAPL", "gross", barmerge.gaps_off, barmerge.lookahead_off, true)\nplot(d)\n', B);
  ok(!r2.err && isNAPlot(r2, 0), 'dividends ignore -> na');
  const r3 = runAll('//@version=6\nindicator("T")\ns = request.splits("NASDAQ:AAPL")\nplot(s)\n', B);
  ok(!!r3.err && r3.err.indexOf('request.splits') >= 0, 'splits loud');
  const r4 = runAll('//@version=6\nindicator("T")\ne = request.earnings("NASDAQ:AAPL")\nplot(e)\n', B);
  ok(!!r4.err && r4.err.indexOf('request.earnings') >= 0, 'earnings loud');
}
// 10-12: financial / quandl (deprecated) / seed / economic
{
  const r = runAll('//@version=6\nindicator("T")\nf = request.financial("NASDAQ:MSFT", "ACCOUNTS_PAYABLE", "FY")\nplot(f)\n', B);
  ok(!!r.err && r.err.indexOf('request.financial') >= 0, 'financial loud (' + r.err + ')');
  const r2 = runAll('//@version=6\nindicator("T")\nq = request.quandl("CFTC/SB_FO_ALL")\nplot(q)\n', B);
  ok(!!r2.err && r2.err.indexOf('deprecated') >= 0, 'quandl deprecated loud (' + r2.err + ')');
  const r3 = runAll('//@version=6\nindicator("T")\ns = request.seed("repo", "SYM", close)\nplot(s)\n', B);
  ok(!!r3.err && r3.err.indexOf('request.seed') >= 0, 'seed loud');
  const r4 = runAll('//@version=6\nindicator("T")\ne = request.economic("US", "GDP")\nplot(e)\n', B);
  ok(!!r4.err && r4.err.indexOf('request.economic') >= 0, 'economic loud');
}
// 13-14: footprint + footprint.*/volume_row.* namespaces
{
  const r = runAll('//@version=6\nindicator("T")\nfp = request.footprint(5)\nplot(1)\n', B);
  ok(!!r.err && r.err.indexOf('request.footprint') >= 0 && r.err.indexOf('Premium') >= 0, 'footprint loud (' + r.err + ')');
  const r2 = runAll('//@version=6\nindicator("T")\nx = footprint.rows(1)\nplot(1)\n', B);
  ok(!!r2.err && r2.err.indexOf('footprint.rows') >= 0, 'footprint.rows loud (' + r2.err + ')');
  const r3 = runAll('//@version=6\nindicator("T")\nx = volume_row.has_buy_imbalance(1)\nplot(1)\n', B);
  ok(!!r3.err && r3.err.indexOf('volume_row.has_buy_imbalance') >= 0, 'volume_row loud (' + r3.err + ')');
}
// 15: security currency= (USD no-op, EUR loud)
{
  const r = runAll('//@version=6\nindicator("T")\nv = request.security(syminfo.tickerid, "1", close, currency="USD")\nplot(v)\n', B);
  ok(!r.err, 'security currency=USD no-op');
  const r2 = runAll('//@version=6\nindicator("T")\nv = request.security(syminfo.tickerid, "1", close, currency="EUR")\nplot(v)\n', B);
  ok(!!r2.err && r2.err.indexOf('FX feed') >= 0, 'security currency=EUR loud (' + r2.err + ')');
}
// 16-17: strategy conversion identity + cross-currency loud
{
  const r = runAll('//@version=6\nstrategy("T")\na = strategy.convert_to_account(100)\ns = strategy.convert_to_symbol(100)\nplot(1)\n', B);
  ok(!r.err && g(r, 'a') === 100 && g(r, 's') === 100, 'convert identity 100/100 (got ' + g(r, 'a') + '/' + g(r, 's') + ')');
  const r2 = runAll('//@version=6\nstrategy("T", currency=currency.EUR)\na = strategy.convert_to_account(100)\nplot(1)\n', B);
  ok(!!r2.err && r2.err.indexOf('convert_to_account') >= 0, 'convert EUR loud (' + r2.err + ')');
}
// 18: declaration forward-compat stays observable (ROUND236: dynamic_requests
// is understood into meta.dynamicRequests, the rest stay ignored)
{
  const r = runAll('//@version=6\nstrategy("T", calc_on_every_history_tick=true, dynamic_requests=false, slippage=1)\nplot(1)\n', B);
  const ig = (r.meta && r.meta.ignoredParams) || [];
  ok(!r.err && ig.indexOf('calc_on_every_history_tick') >= 0 && ig.indexOf('slippage') >= 0 && r.meta.dynamicRequests === false, 'decl flags observable (' + ig.join(',') + ' + dynamic=' + r.meta.dynamicRequests + ')');
}

console.log('\nROUND230: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
