/**
 * test_round144_mtf.mjs — ROUND144 Indicator-Timeframe (MTF) engine
 *
 * Run: node tests/unit/test_round144_mtf.mjs
 *
 * Pure core/pine/mtf.js: HTF bucket aggregation, chart map, output remap —
 * plus an end-to-end Supertrend run in the HTF frame with remapped output.
 */

import { compile } from '../../src/core/pine/compile.js';
import { buildHtfBars, remapOut, lowerWindowForChart } from '../../src/core/pine/mtf.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

/* 8 M15 bars on an hour grid: 2 buckets x 4 bars */
const T0 = 1790600400 - (1790600400 % 3600);
const bars = [];
for (let i = 0; i < 8; i++) {
  const o = 100 + i, cl = o + (i % 2 ? 2 : -1);
  bars.push({ time: T0 + i * 900, open: o, high: Math.max(o, cl) + 0.5, low: Math.min(o, cl) - 0.5, close: cl, volume: 10 + i });
}

{
  const { bars: hb, map } = buildHtfBars(bars, 3600);
  ok(hb.length === 2, 'two H1 buckets from 8 M15 bars');
  ok(hb[0].time === bars[0].time && hb[1].time === bars[4].time, 'bucket time = first chart bar stamp');
  ok(hb[0].open === bars[0].open && hb[0].close === bars[3].close, 'bucket open/close edges');
  ok(hb[0].high === Math.max(...bars.slice(0, 4).map((b) => b.high)), 'bucket high = max');
  ok(hb[0].low === Math.min(...bars.slice(0, 4).map((b) => b.low)), 'bucket low = min');
  ok(hb[0].volume === 10 + 11 + 12 + 13, 'bucket volume = sum');
  ok(JSON.stringify(map) === JSON.stringify([0, 0, 0, 0, 1, 1, 1, 1]), 'chart->bucket map');
}

{
  /* remap: HTF-space arrays become chart-length step series */
  const out = {
    plots: new Map([['k', { values: [10, 20], colors: [{ css: () => 'a' }, { css: () => 'b' }] }]]),
    shapes: new Map([['g:1', { ys: [1, null], texts: ['x', null], colors: [{ css: () => 'c' }, null] }]]),
    fills: [{ colors: [{ css: () => 'f0' }, null] }],
    bgcolor: [null, { css: () => 'bg' }],
    barcolor: [],
    candles: [],
  };
  const view = remapOut(out, [0, 0, 0, 0, 1, 1, 1, 1], 8);
  ok(out.plots.get('k').values.length === 2, 'input untouched (engine frame intact)');
  const v = view.plots.get('k').values;
  ok(v.length === 8 && v.slice(0, 4).every((x) => x === 10) && v.slice(4).every((x) => x === 20), 'plot values step across buckets');
  const sh = view.shapes.get('g:1');
  ok(sh.ys[3] === 1 && sh.ys[0] == null && sh.ys[4] == null && sh.texts[3] === 'x', 'markers anchor once per bucket (last chart bar)');
  ok(view.fills[0].colors[0] && view.fills[0].colors[4] == null, 'fill colors remap');
  ok(view.bgcolor[4] && view.bgcolor[0] == null, 'bgcolor remaps');
}

{
  /* full Supertrend in the HTF frame + remap: chart-length, single-fire */
  const src = readFileSync(join(HERE, '..', '..', 'src', 'renderer', 'assets', 'pine-samples', 'sample-Supertrend.pine'), 'utf8');
  const c = compile(src);
  ok(c.ok, 'supertrend compiles');
  const big = [];
  let px = 4000;
  const B0 = 1790600400 - (1790600400 % 3600);
  for (let i = 0; i < 450; i++) {
    const drift = i < 150 ? 0.6 : i < 300 ? -0.9 : 0.7;
    const o = px, cl = o + drift;
    big.push({ time: B0 + i * 900, open: o, high: Math.max(o, cl) + 0.4, low: Math.min(o, cl) - 0.4, close: cl, volume: 100 });
    px = cl;
  }
  const { bars: hb, map } = buildHtfBars(big, 3600);
  ok(hb.length === 113, '450 M15 bars -> 113 H1 buckets (got ' + hb.length + ')');
  const rt = c.createInstance({ tfSec: 3600, symbol: 'XAUUSD', serverOffSec: 10800 });
  rt.runAll(hb);
  const view1 = remapOut(rt.out, map, big.length);
  let chartLen = true;
  for (const [, p] of view1.plots) {
    if (p.values.length !== big.length) { chartLen = false; break; }
  }
  ok(chartLen, 'remapped plots are chart-length');
  const fires = {};
  for (const [, sh] of view1.shapes) {
    const idx = [];
    for (let i = 0; i < big.length; i++) if (sh.ys[i] != null) idx.push(i);
    if (idx.length) fires[sh.texts[idx[0]] || sh.style] = idx;
  }
  const singles = Object.values(fires).every((a) => a.length === 1);
  ok(singles, 'HTF supertrend single-fires per flip ' + JSON.stringify(Object.keys(fires)));
  /* the live-tick scenario that broke MTF: an incremental HTF update writes
     by HTF barIndex into rt.out (engine frame), then the view re-remaps —
     the rendered output must stay byte-identical apart from the forming bar */
  const htfKey = [...rt.out.plots.keys()][0];
  ok(rt.out.plots.get(htfKey).values.length === hb.length,
    'engine output stays in HTF frame after remap');
  rt.out.plots.get(htfKey).values[hb.length - 1] += 0.5; // forming-bar tick
  const view2 = remapOut(rt.out, map, big.length);
  let stable = true;
  const v1 = view1.plots.get(htfKey).values, v2 = view2.plots.get(htfKey).values;
  const lastBucketStart = map.indexOf(hb.length - 1); // first chart bar of the forming bucket
  for (let i = 0; i < lastBucketStart; i++) {
    if (Math.abs((v1[i] == null ? 0 : v1[i]) - (v2[i] == null ? 0 : v2[i])) > 1e-9) { stable = false; break; }
  }
  ok(stable, 'forming tick only moves the forming bucket on re-remap');
}

/* ROUND146: lower-TF window — H1 chart over synthetic M15 history */
{
  const lo = [];
  const L0 = 1790600400 - (1790600400 % 3600);
  for (let i = -20; i < 240; i++) {
    const o = 4000 + i * 0.4, cl = o + 0.3;
    lo.push({ time: L0 + i * 900, open: o, high: Math.max(o, cl) + 0.2, low: Math.min(o, cl) - 0.2, close: cl, volume: 50 });
  }
  // H1 chart bars derived from the same tape (every 4th M15 close)
  const chart = [];
  for (let h = 0; h < 60; h++) {
    const seg = lo.slice(20 + h * 4, 20 + h * 4 + 4);
    chart.push({ time: seg[0].time, open: seg[0].open,
      high: Math.max(...seg.map((b) => b.high)), low: Math.min(...seg.map((b) => b.low)),
      close: seg[3].close, volume: 200 });
  }
  const { bars: run, map } = lowerWindowForChart(chart, lo, 8);
  ok(run.length === 248, 'run window = chart span + 8 warmup (got ' + run.length + ')');
  ok(map.length === 60 && map[0] === 8 && map[59] === 244, 'chart bars map to last lower at/before them');
  ok(map.every((v, i) => v < 0 || (i === 0 || map[i] >= map[i - 1])), 'map is non-decreasing');
  // full lower-frame run + remap: chart-length, values track lower detail
  const src2 = 'study("t", overlay=true)\nplot(close, title="c")';
  const c2 = compile(src2);
  const rt = c2.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 0 });
  rt.runAll(run);
  const view = remapOut(rt.out, map, chart.length);
  const vals = view.plots.get([...view.plots.keys()][0]).values;
  ok(vals.length === 60, 'lower output remapped to chart length');
  let same = true;
  for (let i = 0; i < 60; i++) {
    if (Math.abs(vals[i] - run[map[i]].close) > 1e-9) { same = false; break; }
  }
  ok(same, 'chart bar shows its last lower close (up-map)');
  // no lower data at all -> all na, no crash
  const empty = lowerWindowForChart(chart, [], 8);
  ok(empty.bars.length === 0 && empty.map.every((v) => v === -1), 'empty lower history maps to na');
}

console.log('\nROUND144: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
