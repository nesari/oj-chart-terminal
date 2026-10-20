/**
 * test_round189_risk.mjs — ROUND189 strategy.risk.* guards (TV parity).
 *
 * allow_entry_in (opposite closes, never reverses) / max_drawdown cash
 * (cancel+flatten+latch) / max_intraday_filled_orders (cancel+flatten, fresh
 * bucket next UTC day) / max_intraday_loss cash+percent (flatten+block rest
 * of day, next day resumes) / max_position_size (reduce-or-drop) /
 * max_cons_loss_days (latch after N red UTC days) / loud misconfiguration.
 * Days are UTC (house rule).
 *
 * Run: node tests/unit/test_round189_risk.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const DAY = 86400;
const dayStart = (t) => Math.floor(t / DAY) * DAY;

function tbars(n, t0, closes) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = closes[i];
    out.push({ time: t0 + i * 900, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 10 });
  }
  return out;
}

function runIt(src, opts, barSet) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + JSON.stringify(c.errors).slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 0.01 }, opts || {}));
    rt.runAll(barSet);
    return { rt, broker: rt.broker };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

/* rising strip for direction tests */
function riseBars(n, t0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 100 + i;
    out.push({ time: t0 + i * 900, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 });
  }
  return out;
}
const T0 = dayStart(1790600400) + 3600; // 01:00 UTC, plenty of same-day room

/* 1. allow_entry_in(long): short only closes, never reverses; flat ignores */
{
  const r = runIt(`//@version=5
strategy("a", overlay=true)
strategy.risk.allow_entry_in(strategy.direction.long)
if bar_index == 10
    strategy.entry("L", strategy.long, qty=2)
if bar_index == 15
    strategy.entry("S", strategy.short, qty=2)
if bar_index == 20
    strategy.entry("S", strategy.short, qty=2)
if bar_index == 25
    strategy.entry("L2", strategy.long, qty=1)
plot(strategy.position_size, title="p")`, {}, riseBars(40, T0));
  ok(!r.error, 'allow runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const E = r.rt.out.plots.get(r.rt.out.plotsOrder[0]).values;
    ok(E[16] === -0 || E[16] === 0, 'short at 15 flattened the long (got ' + E[16] + ')');
    ok(!r.broker.trades.some((t) => t.dir < 0), 'no short trade ever opened');
    ok(r.broker.trades.length === 1 && r.broker.trades[0].dir === 1, 'only the long round trip closed');
    ok(E[E.length - 1] === 1, 'long re-entry at 25 opens normally (got ' + E[E.length - 1] + ')');
  }
}

/* 2. max_drawdown cash: latch, flatten, pending gone, later entries dead */
{
  const closes = [];
  for (let i = 0; i <= 12; i++) closes.push(100 + i);
  for (let i = 13; i < 40; i++) closes.push(113 - 3 * (i - 12));
  const r = runIt(`//@version=5
strategy("dd", overlay=true, initial_capital=10000)
strategy.risk.max_drawdown(50, strategy.cash)
if bar_index == 10
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 25
    strategy.entry("L2", strategy.long, qty=10)
plot(strategy.position_size, title="p")`, {}, tbars(40, T0, closes));
  ok(!r.error, 'maxdd runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.broker.riskTrip === 'max_drawdown', 'latched (got ' + r.broker.riskTrip + ')');
    ok(r.broker.qty === 0, 'flattened');
    ok(r.broker.pending.length === 0, 'pending cancelled');
    ok(r.broker.trades.some((t) => t.exitId === 'risk:max_drawdown'), 'risk exit recorded');
    const E = r.rt.out.plots.get(r.rt.out.plotsOrder[0]).values;
    ok(E[E.length - 1] === 0, 'post-trip entry never opens (got ' + E[E.length - 1] + ')');
  }
}

/* 3. max_intraday_filled_orders(2): third same-day fill blocked, next day fresh */
{
  const t0 = dayStart(1790600400) - 3600; // bars 0..3 day A, 4+ day B
  const r = runIt(`//@version=5
strategy("mf", overlay=true, pyramiding=5)
strategy.risk.max_intraday_filled_orders(2)
if bar_index == 0 or bar_index == 1 or bar_index == 2
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 5
    strategy.entry("M", strategy.long, qty=1)
plot(strategy.position_size, title="p")`, {}, riseBars(12, t0));
  ok(!r.error, 'maxfills runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.broker.trades.length === 2, 'trip flattened the 2 day-A lots (2 risk exits)');
    ok(r.broker.trades.every((t) => t.exitId === 'risk:max_intraday_filled_orders'), 'both exits are risk exits');
    ok(r.broker.qty === 1, 'day-B entry opens fresh (got ' + r.broker.qty + ')');
  }
}

/* 4. max_intraday_loss percent: trip flattens+blocks, next day resumes */
{
  // flat 101 to bar 11, then -2/bar; peak ~10300; 5% of peak ~515.
  // ROUND213: capital 10200 (was 10000) — 100 contracts @101 need 10100
  // margin under TV's default margin_long=100, so 10k silently rejects the
  // entry and the trip never happens. Timing is identical (trip bar 14).
  const closes = [];
  for (let i = 0; i <= 11; i++) closes.push(101);
  for (let i = 12; i < 30; i++) closes.push(101 - 2 * (i - 11));
  const r = runIt(`//@version=5
strategy("il", overlay=true, initial_capital=10200)
strategy.risk.max_intraday_loss(5, strategy.percent_of_equity)
if bar_index == 10
    strategy.entry("L", strategy.long, qty=100)
if bar_index == 16
    strategy.entry("L2", strategy.long, qty=100)
plot(strategy.position_size, title="p")`, {}, tbars(30, T0, closes));
  ok(!r.error, 'intraday loss runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    // peak = 10200 + (102-101)*100 = 10300; 5% = 515; trip at eq <= 9785 -> close <= 95.95 -> bar ~14
    ok(r.broker.qty === 0 || r.broker.day.blocked === false, 'no stale block leaks past midnight (qty ' + r.broker.qty + ')');
    const E = r.rt.out.plots.get(r.rt.out.plotsOrder[0]).values;
    ok(E[15] === 0, 'flattened by the trip (got ' + E[15] + ')');
    ok(E[17] === 0, 'same-day re-entry blocked (got ' + E[17] + ')');
    ok(r.broker.trades.some((t) => String(t.exitId).indexOf('risk:') === 0), 'risk exit recorded');
  }
}

/* 5. max_position_size(5): reduce-or-drop */
{
  const r = runIt(`//@version=5
strategy("mp", overlay=true)
strategy.risk.max_position_size(5)
if bar_index == 10
    strategy.entry("A", strategy.long, qty=10)
if bar_index == 12
    strategy.entry("B", strategy.long, qty=10)
plot(strategy.position_size, title="p")`, {}, riseBars(30, T0));
  ok(!r.error, 'maxpos runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const E = r.rt.out.plots.get(r.rt.out.plotsOrder[0]).values;
    ok(E[11] === 5, 'first fill reduced 10 -> 5 (got ' + E[11] + ')');
    ok(E[E.length - 1] === 5, 'add dropped, still 5 (got ' + E[E.length - 1] + ')');
  }
}

/* 6. max_cons_loss_days(2) on daily bars */
{
  const d0 = dayStart(1790600400);
  const db = [];
  for (let i = 0; i < 8; i++) {
    const c = 110 - i;
    db.push({ time: d0 + i * DAY, open: c + 0.5, high: c + 1, low: c - 1, close: c, volume: 10 });
  }
  const r = runIt(`//@version=5
strategy("cd", overlay=true, pyramiding=5)
strategy.risk.max_cons_loss_days(2)
if bar_index >= 0 and bar_index <= 4
    strategy.close("X")
    strategy.entry("L", strategy.long, qty=1)
if bar_index == 6
    strategy.entry("Late", strategy.long, qty=1)
plot(strategy.position_size, title="p")`, {}, db);
  ok(!r.error, 'consloss runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.broker.riskTrip === 'max_cons_loss_days', 'latched after red days (got ' + r.broker.riskTrip + ')');
    ok(r.broker.qty === 0 && r.broker.pending.length === 0, 'flat and clean at the end');
  }
}

/* 7. loud misconfiguration + indicator guard */
{
  const bad1 = runIt(`//@version=5
strategy("b", overlay=true)
strategy.risk.max_drawdown(-5, strategy.cash)
plot(close, title="c")`, {}, riseBars(10, T0));
  ok(bad1.error && /max_drawdown/.test(bad1.error), 'negative max_drawdown loud');
  const bad2 = runIt(`//@version=5
strategy("b", overlay=true)
strategy.risk.allow_entry_in("sideways")
plot(close, title="c")`, {}, riseBars(10, T0));
  ok(bad2.error && /allow_entry_in/.test(bad2.error), 'bogus direction loud');
  const bad3 = runIt(`//@version=5
indicator("b", overlay=true)
strategy.risk.max_drawdown(50, strategy.cash)
plot(close, title="c")`, {}, riseBars(10, T0));
  ok(bad3.error && /only in strategy/.test(bad3.error), 'indicator guard loud');
  const bad4 = runIt(`//@version=5
strategy("b", overlay=true)
strategy.risk.nope(1)
plot(close, title="c")`, {}, riseBars(10, T0));
  ok(bad4.error && /Unknown function strategy\.risk\.nope/.test(bad4.error), 'unknown risk fn loud');
}

console.log('\nROUND189: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
