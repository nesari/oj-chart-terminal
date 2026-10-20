/**
 * test_round176_perf.mjs — ROUND176 tester Performance series + long-only lock.
 *
 * (a) downsample: endpoints preserved, length capped, na rows dropped.
 * (b) broker equity tape starts at capital and tracks realized after closes.
 * (c) LONG-ONLY LOCK (user question, round 175 triage): the exact MATrend
 *     script on wave data (real crossovers AND crossunders in both
 *     directions) yields Long-only trades — by construction, since it never
 *     calls strategy.short. The same signals with a short entry alternate
 *     directions, proving the engine opens shorts fine.
 *
 * Run: node tests/unit/test_round176_perf.mjs
 */

import { compile } from '../../src/core/pine/compile.js';
import { downsample } from '../../src/core/pine/stdlib/strategy.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function waveBars(n) {
  const t0 = 1790600400 - (1790600400 % 900);
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = 100 + 12 * Math.sin(i / 6);
    out.push({ time: t0 + i * 900, open: c, high: c + 0.4, low: c - 0.4, close: c, volume: 10 });
  }
  return out;
}
const WAVES = waveBars(240);

function runIt(src, opts, barSet) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + JSON.stringify(c.errors).slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 0.01 }, opts || {}));
    rt.runAll(barSet || WAVES);
    return { rt, broker: rt.broker };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

/* --- downsample --- */
{
  const rows = [];
  for (let i = 0; i < 1000; i++) rows.push({ t: 1000 + i, v: i });
  const d = downsample(rows, 300);
  ok(d.length === 300, 'downsample caps at 300 (got ' + d.length + ')');
  ok(d[0].t === 1000 && d[d.length - 1].t === 1999, 'downsample preserves endpoints');
  const dirty = [{ t: 1, v: 1 }, { t: 2, v: NaN }, { t: NaN, v: 3 }, null, { t: 4, v: 4 }];
  const d2 = downsample(dirty, 300);
  ok(d2.length === 2 && d2[0].t === 1 && d2[1].t === 4, 'downsample drops na rows');
  const small = [{ t: 5, v: 5 }];
  ok(downsample(small, 300).length === 1, 'downsample keeps short series whole');
}

/* --- equity tape --- */
{
  const r = runIt(`//@version=5
strategy("eq", overlay=true, initial_capital=10000)
if bar_index == 10
    strategy.entry("L", strategy.long, qty=2)
if bar_index == 15
    strategy.close("X")
plot(strategy.equity, title="e")`);
  ok(!r.error, 'equity script runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.broker.equity[0] === 10000, 'equity starts at capital (got ' + r.broker.equity[0] + ')');
    const last = r.broker.equity[r.broker.equity.length - 1];
    ok(Math.abs(last - (10000 + r.broker.realized)) < 1e-9,
      'equity tracks capital+realized after flat (' + last + ' vs ' + (10000 + r.broker.realized) + ')');
    ok(isFinite(r.broker.equity[12]) && r.broker.equity[12] !== 10000, 'equity moves with the open position');
  }
}

/* --- LONG-ONLY LOCK: exact user MATrend on wave data --- */
{
  const r = runIt(`//@version=5
strategy("MATrend", overlay=true, initial_capital=10000, default_qty_value=1)
fast = ta.sma(close, 14)
slow = ta.sma(close, 28)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Out")
plot(strategy.position_size, title="p")`);
  ok(!r.error, 'exact MATrend runs on waves' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const dirs = r.broker.trades.map((t) => t.dir);
    ok(r.broker.trades.length > 1, 'crossunders fired: multiple round trips closed (' + r.broker.trades.length + ')');
    ok(dirs.length > 0 && dirs.every((d) => d === 1), 'MATrend trades are all Long — by construction, no strategy.short call');
  }
}

/* --- same signals with a short entry DO alternate --- */
{
  const r = runIt(`//@version=5
strategy("MATrendBS", overlay=true, initial_capital=10000, default_qty_value=1)
fast = ta.sma(close, 14)
slow = ta.sma(close, 28)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.entry("Short", strategy.short)
plot(strategy.position_size, title="p")`);
  ok(!r.error, 'long/short variant runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const dirs = r.broker.trades.map((t) => t.dir);
    ok(dirs.includes(1) && dirs.includes(-1), 'engine opens shorts fine: dirs [' + dirs.join(',') + ']');
  }
}

/* --- exact user MACD alternates too --- */
{
  const r = runIt(`//@version=6
strategy("MACD strategy", overlay=true)
fastLength = input(12, "Fast length")
slowlength = input(26, "Slow length")
MACDLength = input(9, "MACD length")
MACD = ta.ema(close, fastLength) - ta.ema(close, slowlength)
aMACD = ta.ema(MACD, MACDLength)
delta = MACD - aMACD
if (ta.crossover(delta, 0))
    strategy.entry("MacdLE", strategy.long, comment="MacdLE")
if (ta.crossunder(delta, 0))
    strategy.entry("MacdSE", strategy.short, comment="MacdSE")
plot(strategy.position_size, title="p")`);
  ok(!r.error, 'exact MACD runs on waves' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const dirs = r.broker.trades.map((t) => t.dir);
    ok(dirs.includes(1) && dirs.includes(-1), 'MACD yields both sides: [' + dirs.join(',') + ']');
  }
}

console.log('\nROUND176: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
