/**
 * test_round198_tickmodel.mjs — ROUND198 realtime tick model (TV parity).
 *
 * calc_on_every_tick parsing (strategy=false / indicator=true defaults) and
 * the fills-only realtime tick: no body re-exec, working fills still fire,
 * close calculations unaffected.
 *
 * Run: node tests/unit/test_round198_tickmodel.mjs
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
const BARS = bars(10);

function runIt(src, opts) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 1 }, opts || {}));
    rt.runAll(BARS);
    return { c, rt };
  } catch (e) { return { c, error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
/* spike the forming bar like a realtime tick (close/high far above history) */
function spike(rt, px) {
  const bb = BARS.map((b) => Object.assign({}, b));
  bb[bb.length - 1] = Object.assign({}, bb[bb.length - 1], { high: px, close: px });
  rt.updateForming(bb);
  return bb;
}

/* 1. declaration parsing + defaults */
{
  const s = compile('//@version=5\nstrategy("S")\nplot(1)\n');
  ok(s.ok && s.meta.calcEveryTick === false && s.meta.calcOnOrderFills === true, 'strategy defaults false/true');
  const s2 = compile('//@version=5\nstrategy("S", calc_on_every_tick=true, calc_on_order_fills=false)\nplot(1)\n');
  ok(s2.ok && s2.meta.calcEveryTick === true && s2.meta.calcOnOrderFills === false, 'strategy explicit flags honored');
  const i = compile('//@version=5\nindicator("I")\nplot(1)\n');
  ok(i.ok && i.meta.calcEveryTick === true, 'indicator defaults true');
  const i2 = compile('//@version=5\nindicator("I", calc_on_every_tick=false)\nplot(1)\n');
  ok(i2.ok && i2.meta.calcEveryTick === false, 'indicator explicit false honored');
  const v4 = compile('//@version=4\nstudy("S", overlay=true)\nplot(1)\n');
  ok(v4.ok && v4.meta.calcEveryTick === true, 'study() ticks like an indicator');
}

/* 2. default-false strategy: tick does NOT run the body... */
{
  const src = `//@version=5
strategy("T", overlay=true)
if close > 1000
    strategy.entry("TICK", strategy.long)
plot(close)
`;
  const r = runIt(src);
  ok(!r.error, 'tick-gated fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.rt.broker.pending.length === 0, 'no order after full run (spike never in history)');
    spike(r.rt, 2000);
    const b = r.rt.broker;
    ok(b.pending.length === 0 && b.entries.length === 0 && b.trades.length === 0, 'spiked tick places NOTHING (body skipped)');
  }
}
/* 3. ...but an explicit true recalculates per tick */
{
  const src = `//@version=5
strategy("T", overlay=true, calc_on_every_tick=true)
if close > 1000
    strategy.entry("TICK", strategy.long)
plot(close)
`;
  const r = runIt(src);
  ok(!r.error, 'explicit-true fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    spike(r.rt, 2000);
    const p = r.rt.broker.pending;
    ok(p.length === 1 && p[0].id === 'TICK', 'spiked tick places the entry (body ran)');
  }
}
/* 4. fills still fire on fills-only ticks: a stop working since bar 8 fills
   on the spiked tick while the TICK marker stays absent (no body run). */
{
  const src = `//@version=5
strategy("T", overlay=true)
if bar_index == 8
    strategy.entry("E", strategy.long, stop=150)
if close > 1000
    strategy.entry("TICK", strategy.long)
plot(close)
`;
  const r = runIt(src);
  ok(!r.error, 'stop fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.rt.broker.pending.length === 1 && r.rt.broker.pending[0].id === 'E', 'stop working after full run');
    spike(r.rt, 2000);
    const b = r.rt.broker;
    const ids = b.entries.map((e) => e.id).concat(b.pending.map((p) => p.id));
    ok(b.entries.length === 1 && b.entries[0].id === 'E' && b.entries[0].price === 150 &&
      b.pending.length === 0 && b.trades.length === 0 && ids.indexOf('TICK') < 0,
      'tick fills E@150 into position, TICK absent (got ' + JSON.stringify(ids) + ')');
  }
}
/* 5. close calculations still run under false (pushNewBar) */
{
  const src = `//@version=5
strategy("T", overlay=true)
if close > 1000
    strategy.entry("TICK", strategy.long)
plot(close)
`;
  const r = runIt(src);
  ok(!r.error, 'close fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const bb = bars(11);
    bb[10] = Object.assign({}, bb[10], { high: 2000, close: 2000 });
    r.rt.pushNewBar(bb);
    const p = r.rt.broker.pending;
    ok(p.length === 1 && p[0].id === 'TICK', 'closed spiked bar places the entry (close calculates)');
  }
}
/* 6. indicator false freezes plots intrabar; default follows ticks */
{
  const srcF = `//@version=5
indicator("I", overlay=false, calc_on_every_tick=false)
plot(close)
`;
  const r = runIt(srcF);
  ok(!r.error, 'frozen fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const key = r.rt.out.plotsOrder[0];
    const before = r.rt.out.plots.get(key).values[9];
    spike(r.rt, 2000);
    const after = r.rt.out.plots.get(key).values[9];
    ok(before === after, 'fills-only tick leaves plots untouched (got ' + before + '/' + after + ')');
  }
  const srcT = `//@version=5
indicator("I", overlay=false)
plot(close)
`;
  const r2 = runIt(srcT);
  ok(!r2.error, 'live fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r2.error) {
    spike(r2.rt, 2000);
    ok(r2.rt.out.plots.get(r2.rt.out.plotsOrder[0]).values[9] === 2000, 'default indicator follows the tick');
  }
}
/* 7. repeated ticks stay consistent (rollback each tick, no double-fill) */
{
  const src = `//@version=5
strategy("T", overlay=true)
if bar_index == 8
    strategy.entry("E", strategy.long, stop=150)
plot(close)
`;
  const r = runIt(src);
  ok(!r.error, 'repeat fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    spike(r.rt, 2000);
    const n1 = r.rt.broker.entries.length;
    spike(r.rt, 2000);
    const n2 = r.rt.broker.entries.length;
    ok(n1 === 1 && n2 === 1, 'second identical tick does not double-fill (got ' + n1 + '/' + n2 + ')');
  }
}

console.log('\nROUND198: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
