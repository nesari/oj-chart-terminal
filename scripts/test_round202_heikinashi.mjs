/**
 * test_round202_heikinashi.mjs — ROUND202 ticker.heikinashi (TV parity).
 *
 * HA math (seed/chain/high/low/hole carry-forward) + request.security over
 * HA tickers (same-TF, HTF buckets, history) + ticker.new passthrough and
 * loud gaps (empty symbol, non-none adjustment; renko-family builds handles
 * since round 207 — only missing params stay loud).
 *
 * Run: node scripts/test_round202_heikinashi.mjs
 */

import { compile } from '../src/core/pine/compile.js';
import { haTransform } from '../src/core/pine/stdlib/ticker.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};
const near = (a, b) => (a == null && b == null) || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9);

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
const HEAD = `//@version=5
indicator("T", overlay=true)
`;
function runIt(body, bb, opts) {
  const c = compile(HEAD + body);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 1 }, opts || {}));
    rt.runAll(bb || BARS);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
function plotVals(r, idx) {
  if (r.error) return null;
  const key = r.rt.out.plotsOrder[idx || 0];
  return r.rt.out.plots.get(key).values.slice();
}

/* haTransform unit math */
{
  const rows = [
    { time: 1, open: 10, high: 12, low: 9, close: 11, volume: 5 },
    { time: 2, open: 11, high: 13, low: 10, close: 12, volume: 6 },
    { time: 3, open: 12, high: 12, low: 8, close: 9, volume: 7 },
  ];
  const ha = haTransform(rows);
  ok(near(ha[0].close, 10.5) && near(ha[0].open, 10.5), 'seed (O+C)/2');
  ok(near(ha[1].close, 11.5) && near(ha[1].open, 10.5), 'chain (prevO+prevC)/2');
  ok(ha[1].high === 13 && near(ha[1].low, 10), 'high/low extremes');
  ok(ha[2].high === 12 && ha[2].low === 8, 'down bar extremes');
  ok(ha[0].time === 1 && ha[2].volume === 7, 'time/volume pass through');
  const hole = haTransform([
    { time: 1, open: 10, high: 12, low: 9, close: 11, volume: 5 },
    { time: 2, open: NaN, high: NaN, low: NaN, close: NaN, volume: 0 },
    { time: 3, open: 12, high: 14, low: 11, close: 13, volume: 7 },
  ]);
  ok(near(hole[1].close, 10.5) && near(hole[2].open, 10.5), 'hole carries forward, chain survives');
  const lead = haTransform([{ time: 1, open: NaN, high: 1, low: 1, close: 1, volume: 0 }]);
  ok(lead[0].close == null || typeof lead[0].close !== 'number', 'leading hole stays na');
}
/* same-TF security over the HA ticker == HA series */
{
  const body = 'hat = ticker.heikinashi(syminfo.tickerid)\n'
    + 'plot(request.security(hat, "", close), title="c")\n'
    + 'plot(request.security(hat, "", open), title="o")\n'
    + 'plot(request.security(hat, "", high), title="h")\n'
    + 'plot(request.security(hat, "", low), title="l")\n';
  const r = runIt(body);
  ok(!r.error, 'HA same-TF runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const exp = haTransform(BARS);
    const cc = plotVals(r, 0), oo = plotVals(r, 1), hh = plotVals(r, 2), ll = plotVals(r, 3);
    let good = true;
    for (let i = 0; i < BARS.length; i++) {
      if (!near(cc[i], exp[i].close) || !near(oo[i], exp[i].open) || !near(hh[i], exp[i].high) || !near(ll[i], exp[i].low)) { good = false; break; }
    }
    ok(good, 'every bar matches haTransform (O/H/L/C)');
  }
}
/* HTF: HA over the daily buckets (what a D HA chart shows) */
{
  const t0 = 1790600400 - (1790600400 % 86400);
  const bb = [];
  for (let i = 0; i < 384; i++) { // 4 days of M15
    const o = 100 + i * 0.5;
    bb.push({ time: t0 + i * 900, open: o, high: o + 1, low: o - 1, close: o + 0.5, volume: 10 });
  }
  const r = runIt('hat = ticker.heikinashi(syminfo.tickerid)\nplot(request.security(hat, "D", close), title="d")\n', bb);
  ok(!r.error, 'HA daily runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    /* independent expectation: plain daily aggs, then HA over them */
    const days = [];
    for (let d = 0; d < 4; d++) {
      const sl = bb.slice(d * 96, d * 96 + 96);
      days.push({ time: sl[0].time, open: sl[0].open,
        high: Math.max(...sl.map((b) => b.high)), low: Math.min(...sl.map((b) => b.low)),
        close: sl[95].close, volume: 960 });
    }
    const hd = haTransform(days);
    const v = plotVals(r, 0);
    /* last bar of day 0 (i=95): bucket closed as of this bar -> hd[0] */
    ok(near(v[95], hd[0].close), 'day-0 close bar reads hd[0] (got ' + v[95] + ' vs ' + hd[0].close + ')');
    /* mid day-1 bar (i=100): previous committed bucket -> hd[0] */
    ok(near(v[100], hd[0].close), 'mid-bucket bar reads previous daily HA');
    /* last bar of day 1 (i=191): hd[1] */
    ok(near(v[191], hd[1].close), 'day-1 close bar reads hd[1]');
    /* realtime bar: running daily HA chained off hd[2] */
    const d3 = bb.slice(288, 384);
    const pO = d3[0].open, pH = Math.max(...d3.map((b) => b.high)), pL = Math.min(...d3.map((b) => b.low));
    const runC = (pO + pH + pL + d3[95].close) / 4;
    const runO = (hd[2].open + hd[2].close) / 2;
    ok(near(v[383], runC), 'realtime bar reads running daily HA close');
    void runO;
  }
}
/* history + ticker.new + loud gaps */
{
  const r = runIt('hat = ticker.heikinashi(syminfo.tickerid)\nplot(request.security(hat, "", close)[1], title="h")\n');
  ok(!r.error, 'HA history runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const exp = haTransform(BARS);
    const v = plotVals(r, 0);
    ok(near(v[5], exp[4].close) && near(v[29], exp[28].close), 'h[1] lags one bucket');
  }
  const r2 = runIt('t = ticker.new("X", "T")\nplot(request.security(t, "", close), title="c")\n');
  ok(!r2.error && near(plotVals(r2, 0)[29], BARS[29].close), 'ticker.new passes through');
  /* ROUND207: the renko family builds handles now (used to stay loud) —
     missing brick_size is still loud. */
  const r3 = runIt('t = ticker.renko("T", "", 2)\nplot(request.security(t, "", close), title="c")\n');
  ok(!r3.error, 'renko handle resolves' + (r3.error ? ' -> ' + r3.error : ''));
  const r3b = runIt('plot(request.security(ticker.renko("T"), "", close), title="c")\n');
  ok(!!r3b.error && /brick_size/.test(r3b.error), 'missing brick_size loud');
  const r4 = runIt('plot(request.security(ticker.heikinashi(""), "", close), title="c")\n');
  ok(!!r4.error && /needs a symbol/.test(r4.error), 'empty heikinashi symbol loud');
  const r5 = runIt('t = ticker.new("X", "T", "0930-1600", true, "dividends")\nplot(1)\n');
  ok(!!r5.error && /adjustment/.test(r5.error), 'non-none adjustment loud');
}

console.log('\nROUND202: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
