/**
 * test_round172_account.mjs — ROUND172 backtester account (phase 2b).
 *
 * initial_capital / commission (percent + per-contract + per-order) /
 * default_qty_type (cash, percent_of_equity) / slippage / trailing exits /
 * per-bar equity + brokerStats (win rate, profit factor, max DD).
 * Hand-authored bars (opens 100+i, mintick=1): deterministic fills.
 *
 * Run: node scripts/test_round172_account.mjs
 */

import { compile } from '../src/core/pine/compile.js';
import { brokerStats } from '../src/core/pine/stdlib/strategy.js';

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
    return { rt, broker: rt.broker };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

/* 1. capital + percent commission: entry+exit fees come off realized */
{
  const r = runIt(`//@version=5
strategy("c", overlay=true, initial_capital=5000, commission_type=strategy.commission.percent, commission_value=1)
if bar_index == 10
    strategy.entry("L", strategy.long, qty=2)
if bar_index == 15
    strategy.close("X")
plot(strategy.equity, title="e")`);
  ok(!r.error, 'commission runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    // fill 111 x2 (fee 1% of 222 = 2.22), exit 116 x2 (fee 1% of 232 = 2.32)
    // realized = 10 - 2.22 - 2.32 = 5.46
    ok(Math.abs(r.broker.realized - 5.46) < 1e-9, 'realized net of both fees = 5.46 (got ' + r.broker.realized + ')');
    ok(Math.abs(r.broker.fees - 4.54) < 1e-9, 'fees tracked = 4.54 (got ' + r.broker.fees + ')');
    const E = r.rt.out.plots.get(r.rt.out.plotsOrder[0]).values;
    ok(E[16] != null && Math.abs(E[16] - 5005.46) < 1e-9, 'equity bar 16 = 5005.46 (got ' + E[16] + ')');
    ok(E[0] === 5000, 'equity starts at capital (got ' + E[0] + ')');
  }
}

/* 2. cash + percent_of_equity qty modes */
{
  const r = runIt(`//@version=5
strategy("cash", overlay=true, default_qty_type=strategy.cash, default_qty_value=222)
if bar_index == 10
    strategy.entry("L", strategy.long)
plot(strategy.position_size, title="p")`);
  ok(!r.error, 'cash qty runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const e = r.broker.entries[0] || r.broker.trades[0];
    ok(e && Math.abs(e.qty - 2) < 1e-9, 'cash 222 @111 = 2 contracts (got ' + (e && e.qty) + ')');
  }
  const r2 = runIt(`//@version=5
strategy("pct", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=10)
if bar_index == 10
    strategy.entry("L", strategy.long)
plot(strategy.position_size, title="p")`);
  ok(!r2.error, 'percent qty runs' + (r2.error ? ' -> ' + r2.error : ''));
  if (!r2.error) {
    // equity ~10000 at fill -> 10% = 1000 @111 = 9.009...
    const e2 = r2.broker.entries[0];
    ok(e2 && Math.abs(e2.qty - (10000 * 0.1 / 111)) < 1e-9, 'percent qty sized off equity (got ' + (e2 && e2.qty) + ')');
  }
}

/* 3. trailing exit */
{
  const r = runIt(`//@version=5
strategy("tr", overlay=true)
if bar_index == 10
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 12
    strategy.exit("T", from_entry="L", trail_offset=3)
plot(strategy.position_size, title="p")`);
  ok(!r.error, 'trail exit runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    // entry fill bar 11 @111. exit placed bar 12 -> eligible bar 13:
    // peak=high[13]=115, stop=112, low[13]=111<=112 -> fill @112.
    const t = r.broker.trades;
    ok(t.length === 1 && t[0].exitBar === 13 && t[0].exitPrice === 112 && t[0].profit === 1,
      'trail fills bar 13 @112 profit 1 (got ' + JSON.stringify(t[0]) + ')');
  }
}

/* 4. slippage adverse to the trader */
{
  const mk = (slip) => runIt(`//@version=5
strategy("sl", overlay=true)
if bar_index == 10
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 15
    strategy.close("X")
plot(strategy.position_size, title="p")`, { slippageTicks: slip });
  const a = mk(0), b = mk(5);
  ok(!a.error && !b.error, 'slippage runs both ways');
  if (!a.error && !b.error) {
    // no-slip: 111 -> 116 = +5; slip 5 ticks (mintick=1): 116 -> 111 = -5
    ok(a.broker.trades[0].profit === 5 && b.broker.trades[0].profit === -5,
      'slippage costs 10 round-trip (got ' + a.broker.trades[0].profit + '/' + b.broker.trades[0].profit + ')');
    ok(a.broker.trades[0].entryPrice === 111 && b.broker.trades[0].entryPrice === 116, 'entry shifted adverse');
  }
}

/* 5. brokerStats */
{
  const r = runIt(`//@version=5
strategy("st", overlay=true)
if bar_index == 10
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 15
    strategy.close("X")
if bar_index == 20
    strategy.entry("S", strategy.short, qty=1)
if bar_index == 25
    strategy.close("X")
plot(strategy.equity, title="e")`);
  ok(!r.error, 'stats run executes');
  if (!r.error) {
    const st = brokerStats(r.broker);
    // trade1: 111->116 = +5; trade2: short 121 -> 126 = -5; net 0
    ok(st.trades === 2 && st.wins === 1 && st.losses === 1, 'wins/losses 1/1 (got ' + st.wins + '/' + st.losses + ')');
    ok(st.winRate === 0.5 && st.netProfit === 0, 'winRate 0.5 net 0');
    ok(st.profitFactor === 1, 'profit factor 1 (got ' + st.profitFactor + ')');
    ok(st.maxDD > 0 && st.maxDDPct > 0, 'drawdown measured (got ' + st.maxDD + '/' + st.maxDDPct + ')');
    ok(st.expectancy === 0, 'expectancy 0');
  }
}

console.log('\nROUND172: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
