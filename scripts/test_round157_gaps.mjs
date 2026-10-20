/**
 * test_round157_gaps.mjs — ROUND157 gaps_on na-injection (TV parity)
 *
 * Run: node scripts/test_round157_gaps.mjs
 *
 * gaps=barmerge.gaps_on means confirmed closes only: a bucket whose last bar
 * is not strictly before the current bar is unconfirmed, so the expression
 * yields na (a real gap). The realtime bar is therefore always na under
 * gaps_on; gaps_off (default) keeps running/backfilled values.
 */

import { compile } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

/* 48 M15 bars on an hour grid: 6 buckets x 8 bars */
const T0 = 1790600400 - (1790600400 % 3600);
const bars = [];
let px = 200;
for (let i = 0; i < 48; i++) {
  const o = px, cl = o + Math.sin(i / 5) * 2;
  bars.push({ time: T0 + i * 900, open: o, high: Math.max(o, cl) + 0.5,
    low: Math.min(o, cl) - 0.5, close: cl, volume: 100 });
  px = cl;
}

function secVals(extra) {
  const src = '//@version=6\nindicator("g", overlay=true)\n'
    + 'plot(request.security(syminfo.tickerid, "60", close' + (extra ? ', ' + extra : '') + '), title="v")';
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + String((c.errors[0] && c.errors[0].message) || '') };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 0 });
    rt.runAll(bars);
    return { vals: rt.out.plots.get(rt.out.plotsOrder[0]).values };
  } catch (e) {
    return { error: 'run: ' + String((e && e.message) || e) };
  }
}

{
  const a = secVals('');
  ok(!a.error, 'gaps_off runs' + (a.error ? ' (-> ' + a.error.slice(0, 80) + ')' : ''));
  if (!a.error) {
    /* gaps_off backfills each bucket's FINAL close onto all its bars
       (the official repaint): bar 0 shows bars[3].close, not bars[0].close */
    ok(a.vals[0] != null && Math.abs(a.vals[0] - bars[3].close) < 1e-9, 'gaps_off bar 0 = bucket-final backfill (got ' + a.vals[0] + ')');
    ok(a.vals[47] === bars[47].close, 'gaps_off realtime bar = running close');
    ok(a.vals.every((v) => v != null), 'gaps_off has no gaps');
  }
}
{
  const b = secVals('gaps=barmerge.gaps_on');
  ok(!b.error, 'gaps_on runs' + (b.error ? ' (-> ' + b.error.slice(0, 80) + ')' : ''));
  if (!b.error) {
    /* H1 buckets on M15 bars are 4 wide: [0-3],[4-7],... */
    ok(b.vals.slice(0, 4).every((v) => v == null), 'first bucket bars are na (nothing confirmed)');
    ok(b.vals[4] != null && Math.abs(b.vals[4] - bars[3].close) < 1e-9, 'bar 4 shows bucket[0-3] close (' + b.vals[4] + ' vs ' + bars[3].close + ')');
    ok(b.vals[8] != null && Math.abs(b.vals[8] - bars[7].close) < 1e-9, 'bar 8 steps to bucket[4-7] close');
    ok(b.vals[47] == null, 'realtime bar is na under gaps_on');
    const mid = b.vals.slice(4, 47);
    ok(mid.every((v) => v != null), 'confirmed region fully stepped (no holes)');
  }
}
{
  // lookahead+gaps_on: own bucket never confirmed -> all na (rule consequence)
  const c = secVals('gaps=barmerge.gaps_on, lookahead=barmerge.lookahead_on');
  ok(!c.error && c.vals.every((v) => v == null), 'lookahead+gaps_on is all na'
    + (c.error ? ' (-> ' + c.error.slice(0, 80) + ')' : ''));
}

console.log('\nROUND157: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
