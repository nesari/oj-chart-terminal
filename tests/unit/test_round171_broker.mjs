/**
 * test_round171_broker.mjs — ROUND171 backtester order core (phase 2a).
 *
 * Next-bar-open fills, limit/stop touch rules, reverse, pyramiding cap,
 * profit exits (ticks), cancel, partial close, getter histories, and the
 * indicator-script guard. Hand-authored bars (no randomness): opens 100+i.
 *
 * Run: node tests/unit/test_round171_broker.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function bars(n) {
  const t0 = 1790600400 - (1790600400 % 900);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 100 + i;
    out.push({ time: t0 + i * 900, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 });
  }
  return out;
}
const BARS = bars(30);

function runIt(src, opts) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + JSON.stringify(c.errors).slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 1 }, opts || {}));
    rt.runAll(BARS);
    return { rt, out: rt.out, broker: rt.broker };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

const HEAD = `//@version=5
strategy("m", overlay=true, initial_capital=10000, default_qty_value=2, pyramiding=0)
`;

/* 1. basic long + close at next opens */
{
  const r = runIt(HEAD + `if bar_index == 10
    strategy.entry("L", strategy.long, qty=2)
if bar_index == 15
    strategy.close("X")
plot(strategy.position_size, title="p")`);
  ok(!r.error, 'basic runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const t = r.broker.trades;
    ok(t.length === 1, 'one closed trade (got ' + t.length + ')');
    if (t.length) {
      ok(t[0].entryBar === 11 && t[0].entryPrice === 111, 'entry fill bar 11 @111 (got ' + t[0].entryBar + '@' + t[0].entryPrice + ')');
      ok(t[0].exitBar === 16 && t[0].exitPrice === 116, 'exit fill bar 16 @116');
      ok(t[0].qty === 2 && t[0].profit === 10, 'qty 2 profit 10 (got ' + t[0].qty + '/' + t[0].profit + ')');
    }
    const P = r.out.plots.get(r.out.plotsOrder[0]).values;
    ok(P[9] === 0 && P[12] === 2 && P[17] === 0, 'position_size 0/2/0 at bars 9/12/17 (got ' + P[9] + '/' + P[12] + '/' + P[17] + ')');
    ok(P[11] === 2 && P[10] === 0, 'no same-bar fill (bar 10 flat, bar 11 long)');
    ok(r.broker.closedN === 1 && r.broker.realized === 10, 'closedN/realized 1/10');
  }
}

/* 2. short + openprofit + loss side */
{
  const r = runIt(HEAD + `if bar_index == 20
    strategy.entry("S", strategy.short, qty=1)
if bar_index == 25
    strategy.close("X")
plot(strategy.openprofit, title="o")`);
  ok(!r.error, 'short runs');
  if (!r.error) {
    const t = r.broker.trades;
    ok(t.length === 1 && t[0].dir === -1 && t[0].exitBar === 26 && t[0].profit === -5,
      'short fill 121 exit 126 profit -5 (got ' + JSON.stringify(t[0]) + ')');
    const O = r.out.plots.get(r.out.plotsOrder[0]).values;
    // openprofit at bar 22: (close 123 - avg 121) * -1 = -2
    ok(O[22] === -2, 'openprofit bar 22 = -2 (got ' + O[22] + ')');
    ok(O[27] === 0, 'flat openprofit 0 after close');
  }
}

/* 3. reverse */
{
  const r = runIt(HEAD + `if bar_index == 10
    strategy.entry("L", strategy.long, qty=2)
if bar_index == 12
    strategy.entry("S", strategy.short, qty=1)
plot(strategy.position_size, title="p")`);
  ok(!r.error, 'reverse runs');
  if (!r.error) {
    const t = r.broker.trades;
    ok(t.length === 1 && t[0].profit === 4, 'long closed at reversal open 113 profit 4 (got ' + JSON.stringify(t[0]) + ')');
    const P = r.out.plots.get(r.out.plotsOrder[0]).values;
    ok(P[13] === -1, 'short 1 after reversal bar 13 (got ' + P[13] + ')');
  }
}

/* 4. stop entry touches at stop-or-better */
{
  const r = runIt(HEAD + `if bar_index == 2
    strategy.entry("L", strategy.long, qty=1, stop=105)
plot(strategy.position_size, title="p")`);
  ok(!r.error, 'stop entry runs');
  if (!r.error) {
    const t = r.broker.trades;
    ok(r.broker.entries.length === 1 && r.broker.entries[0].bar === 3 && r.broker.entries[0].price === 105,
      'stop fill bar 3 @105 (got ' + JSON.stringify(r.broker.entries[0]) + ')');
    void t;
  }
}

/* 5. pyramiding cap + cancel + partial close */
{
  const r = runIt(HEAD + `if bar_index == 10
    strategy.entry("L", strategy.long, qty=2)
if bar_index == 12
    strategy.entry("L2", strategy.long, qty=2)
if bar_index == 5
    strategy.entry("C", strategy.long, qty=1)
if bar_index == 5
    strategy.cancel("C")
plot(strategy.position_size, title="p")`);
  ok(!r.error, 'pyramiding/cancel runs');
  if (!r.error) {
    ok(r.broker.entries.length === 1 && r.broker.entries[0].qty === 2, 'second entry ignored at pyramiding 0, cancelled never filled');
    const P = r.out.plots.get(r.out.plotsOrder[0]).values;
    ok(P[14] === 2, 'position stays 2 (got ' + P[14] + ')');
  }
  const r2 = runIt(HEAD + `if bar_index == 10
    strategy.entry("L", strategy.long, qty=2)
if bar_index == 12
    strategy.close("X", qty=1)
plot(strategy.position_size, title="p")`);
  if (!r2.error) {
    ok(r2.broker.trades.length === 1 && r2.broker.trades[0].profit === 2, 'partial close profit 2 (113-111 x1)');
    ok(r2.broker.closedN === 0, 'lot not fully closed -> closedN 0');
    const P2 = r2.out.plots.get(r2.out.plotsOrder[0]).values;
    ok(P2[13] === 1, 'position 1 after partial (got ' + P2[13] + ')');
  } else ok(false, 'partial close runs: ' + r2.error);
}

/* 6. profit exit in ticks (mintick=1) */
{
  const r = runIt(HEAD + `if bar_index == 10
    strategy.entry("L", strategy.long, qty=2)
if bar_index == 12
    strategy.exit("TP", from_entry="L", profit=5)
plot(strategy.position_size, title="p")`);
  ok(!r.error, 'profit exit runs');
  if (!r.error) {
    const t = r.broker.trades;
    // avg 111, target 116: high hits 116 at bar 14 (high=116) -> fill 116
    ok(t.length === 1 && t[0].exitBar === 14 && t[0].exitPrice === 116 && t[0].profit === 10,
      'profit fill bar 14 @116 profit 10 (got ' + JSON.stringify(t[0]) + ')');
  }
}

/* 7. getters history + guards */
{
  const r = runIt(HEAD + `if bar_index == 10
    strategy.entry("L", strategy.long, qty=2)
plot(strategy.position_size[1], title="p")`);
  if (!r.error) {
    const P = r.out.plots.get(r.out.plotsOrder[0]).values;
    ok(P[11] === 0 && P[12] === 2, 'position_size[1] lags one bar (got ' + P[11] + '/' + P[12] + ')');
  } else ok(false, 'history probe runs: ' + r.error);
  const g = runIt(`//@version=5
indicator("i")
strategy.entry("L", strategy.long)
plot(close)`);
  ok(!!g.error && /only in strategy/.test(g.error), 'indicator script loud on strategy.* (got ' + (g.error || 'no error').slice(0, 70) + ')');
  const g2 = runIt(`//@version=5
strategy("s2")
strategy.risk.max_drawdown(10)
plot(close)`);
  /* ROUND189: risk.* is implemented now (see test_round189_risk.mjs) — a
     bare max_drawdown call configures and runs clean. */
  ok(!g2.error, 'risk.* configures cleanly since round 189' + (g2.error ? ' (got ' + g2.error.slice(0, 70) + ')' : ''));
}

console.log('\nROUND171: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
