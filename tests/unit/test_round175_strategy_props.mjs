/**
 * test_round175_strategy_props.mjs — ROUND175 strategy Properties + P&L triage.
 *
 * Covers the user's report: (1) MATrend close("Out") with a non-matching id
 * still closes (exitId only); (2) dust P&L is real (~0.005 on 1 contract),
 * the old "0.00" was display rounding — fmt fixed in the tester; (3) dialog
 * strategyProps override declaration literals (capital / % equity sizing);
 * (4) long+short entries produce both trade directions (netting reverse).
 *
 * Run: node tests/unit/test_round175_strategy_props.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function bars(n, base) {
  const t0 = 1790600400 - (1790600400 % 900);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = (base || 100) + i;
    out.push({ time: t0 + i * 900, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 });
  }
  return out;
}
const BARS = bars(30);

function fxBars() {
  // forex-like 1.32 levels: dust profits per single contract
  const t0 = 1790600400 - (1790600400 % 900);
  const out = [];
  for (let i = 0; i < 30; i++) {
    const o = 1.32 + i * 0.001;
    out.push({ time: t0 + i * 900, open: o, high: o + 0.001, low: o - 0.001, close: o + 0.0005, volume: 10 });
  }
  return out;
}

function runIt(src, opts, barSet) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + JSON.stringify(c.errors).slice(0, 200), meta: null };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 0.0001 }, opts || {}));
    rt.runAll(barSet || BARS);
    return { rt, broker: rt.broker, meta: c.meta };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

/* 1. MATrend declaration parses to strategy meta */
{
  const c = compile(`//@version=5
strategy("MATrend", overlay=true, initial_capital=10000, default_qty_value=1)
fast = ta.sma(close, 14)
slow = ta.sma(close, 28)
plot(fast, title="f")`);
  ok(c.ok && c.meta.isStrategy, 'MATrend decl: isStrategy');
  ok(c.ok && c.meta.strategy.initial_capital === 10000, 'MATrend decl: initial_capital=10000');
  ok(c.ok && c.meta.strategy.default_qty_value === 1, 'MATrend decl: default_qty_value=1');
}

/* 2. close() with a non-matching id still closes the open Long (exitId only) */
{
  const r = runIt(`//@version=5
strategy("MATrend", overlay=true, initial_capital=10000, default_qty_value=1)
if bar_index == 10
    strategy.entry("Long", strategy.long)
if bar_index == 15
    strategy.close("Out")
plot(strategy.position_size, title="p")`);
  ok(!r.error, 'MATrend close("Out") runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.broker.trades.length === 1, 'close("Out") closed the Long (1 trade, got ' + r.broker.trades.length + ')');
    ok(r.broker.trades[0] && r.broker.trades[0].exitId === 'Out', 'exitId recorded as "Out"');
    ok(r.broker.trades[0] && r.broker.trades[0].dir === 1, 'trade direction is Long');
  }
}

/* 3. dust P&L is real — 1 contract on forex-like prices nets 0.005, not 0 */
{
  const r = runIt(`//@version=5
strategy("dust", overlay=true, initial_capital=10000, default_qty_value=1)
if bar_index == 10
    strategy.entry("L", strategy.long)
if bar_index == 15
    strategy.close("X")
plot(strategy.position_size, title="p")`, {}, fxBars());
  ok(!r.error, 'dust script runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const p = r.broker.trades.length ? r.broker.trades[0].profit : NaN;
    ok(r.broker.trades.length === 1, 'dust: 1 closed trade');
    ok(isFinite(p) && Math.abs(p) > 0, 'dust: raw profit is non-zero (' + p + ') — old "0.00" was display rounding');
    ok(Math.abs(p - 0.005) < 1e-9, 'dust: profit is exactly 0.005 (got ' + p + ')');
  }
}

/* 4. strategyProps override the declaration (capital + % of equity sizing) */
{
  const src = `//@version=5
strategy("pct", overlay=true, initial_capital=10000, default_qty_value=1)
if bar_index == 10
    strategy.entry("L", strategy.long)
if bar_index == 15
    strategy.close("X")
plot(strategy.position_size, title="p")`;
  const r = runIt(src, { strategyProps: { initial_capital: 100000, default_qty_type: 'percent', default_qty_value: 100, currency: 'USD' } });
  ok(!r.error, 'props override runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.broker.cfg.capital === 100000, 'props: capital 100000 wins over decl 10000 (got ' + r.broker.cfg.capital + ')');
    ok(r.broker.cfg.qtyMode === 'percent' && r.broker.cfg.qtyValue === 100, 'props: 100% of equity sizing');
    const q = r.broker.trades.length ? r.broker.trades[0].qty : NaN;
    // fill at bar 11 open = 110, equity ~100000 -> ~909 contracts
    ok(isFinite(q) && q > 800 && q < 1000, 'props: %-equity qty is TV-scale (~909, got ' + q + ')');
    const p = r.broker.trades.length ? r.broker.trades[0].profit : NaN;
    ok(isFinite(p) && p > 4000, 'props: profit is TV-scale, not dust (got ' + p + ')');
  }
}

/* 5. long+short entries reverse through both directions */
{
  const r = runIt(`//@version=6
strategy("MACD strategy", overlay=true)
if bar_index == 10
    strategy.entry("MacdLE", strategy.long)
if bar_index == 15
    strategy.entry("MacdSE", strategy.short)
if bar_index == 20
    strategy.close("X")
plot(strategy.position_size, title="p")`);
  ok(!r.error, 'long/short script runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const dirs = r.broker.trades.map((t) => t.dir).sort();
    ok(dirs.includes(1) && dirs.includes(-1), 'both Long and Short trades present (got [' + dirs.join(',') + '])');
  }
}

/* 6. slippage_ticks + commission flow from props into the runtime */
{
  const r = runIt(`//@version=5
strategy("s", overlay=true, initial_capital=10000)
if bar_index == 10
    strategy.entry("L", strategy.long, qty=2)
if bar_index == 15
    strategy.close("X")
plot(strategy.position_size, title="p")`,
  { strategyProps: { slippage_ticks: 3, commission_value: 1, commission_type: 'percent' } });
  ok(!r.error, 'slippage/commission props run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.rt.env.slippageTicks === 3, 'env.slippageTicks = 3 (got ' + r.rt.env.slippageTicks + ')');
    ok(r.broker.cfg.commValue === 1 && r.broker.cfg.commType === 'percent', 'commission props land in cfg');
    ok(r.broker.fees > 0, 'fees charged (got ' + r.broker.fees + ')');
  }
}

/* 7. pyramiding from props caps same-direction adds (TV parity: N allows
   up to N successive entries, default 1) */
{
  const src = `//@version=5
strategy("pyr", overlay=true)
if bar_index == 10
    strategy.entry("L", strategy.long)
if bar_index == 11
    strategy.entry("L", strategy.long)
plot(strategy.position_size, title="p")`;
  const r0 = runIt(src, {});
  const r1 = runIt(src, { strategyProps: { pyramiding: 2 } });
  ok(!r0.error && !r1.error, 'pyramiding pair runs');
  if (!r0.error && !r1.error) {
    ok(Math.abs(r0.broker.qty - 1) < 1e-9, 'default pyramiding=1 keeps 1 contract (got ' + r0.broker.qty + ')');
    ok(Math.abs(r1.broker.qty - 2) < 1e-9, 'props pyramiding=2 allows 2 contracts (got ' + r1.broker.qty + ')');
  }
}

console.log('\nROUND175: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
