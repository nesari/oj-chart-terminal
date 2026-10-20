/**
 * Indicator-timeframe (MTF) resampling (round 144)
 *
 * A script pinned to a HIGHER timeframe runs a full pass over HTF buckets
 * aggregated from the chart's own bars, then every visual output is mapped
 * back to chart bars (step/hold: chart bar i shows the latest bucket whose
 * first bar is at or before it — TV's confirmed-value semantics).
 *
 * Bucketing reuses request.security's convention (UTC-epoch grid on the
 * chart-server stamps) so security("H1") and indicator-timeframe H1 agree.
 * Only higher TFs are supported (a lower/equal pick falls back to chart).
 *
 * Pure module (no host refs) — unit-tested in scripts/test_round144_mtf.mjs.
 *
 * @module core/pine/mtf
 */

import { bucketStart } from './stdlib/request-security.js';

/** aggregate chart bars into HTF buckets.
 *  @returns {{bars: Array, map: Array}} bars = HTF OHLCV (time = first chart
 *  bar's stamp in the bucket), map[i] = bucket index for chart bar i. */
function buildHtfBars(chartBars, htfSec) {
  const buckets = []; // {start, i0, bars:[]}
  const map = new Array(chartBars.length);
  let cur = null;
  for (let i = 0; i < chartBars.length; i++) {
    const b = chartBars[i];
    const bs = bucketStart(b.time, htfSec);
    if (!cur || cur.start !== bs) {
      cur = { start: bs, i0: i, bars: [] };
      buckets.push(cur);
    }
    cur.bars.push(b);
    map[i] = buckets.length - 1;
  }
  const out = buckets.map((bk) => {
    const bs = bk.bars;
    const first = bs[0], last = bs[bs.length - 1];
    let high = -Infinity, low = Infinity, volume = 0;
    for (const x of bs) {
      if (x.high > high) high = x.high;
      if (x.low < low) low = x.low;
      volume += x.volume || 0;
    }
    return {
      time: first.time,
      open: first.open,
      high: high === -Infinity ? first.high : high,
      low: low === Infinity ? first.low : low,
      close: last.close,
      volume,
    };
  });
  return { bars: out, map };
}

/** remap every per-bar visual array from HTF index space to chart index
 *  space — PURE: returns a NEW out-like object, the input is untouched.
 *  Continuous series (plots, fills, bgcolor, candles) STEP across their
 *  bucket (TV holds the HTF value for the whole bucket); discrete markers
 *  (plotshape/char/arrow) land ONCE per bucket, on its last chart bar — the
 *  bar where the bucket's value became known. Arrays shorter than the HTF
 *  length (ragged tails from offset plots) read as null past their end.
 *
 *  Purity matters: the engine keeps mutating rt.out in the run frame
 *  (updateForming/pushNewBar write by HTF barIndex), so the rendered
 *  (chart-frame) arrays must live separately (rt.viewOut) — remapping in
 *  place corrupted every later incremental update. */
function remapOut(out, map, chartLen) {
  const htfLen = map.length ? Math.max(0, ...map) + 1 : 0;
  const step = (arr) => {
    const res = new Array(chartLen);
    for (let i = 0; i < chartLen; i++) {
      const bi = map[i];
      res[i] = (bi != null && arr && bi < arr.length) ? arr[bi] : null;
    }
    return res;
  };
  /* last chart bar of each bucket (marker anchor) */
  const anchor = new Array(htfLen).fill(-1);
  for (let i = 0; i < map.length; i++) anchor[map[i]] = i;
  const once = (arr) => {
    const res = new Array(chartLen).fill(null);
    if (!arr) return res;
    for (let b = 0; b < htfLen; b++) {
      const i = anchor[b];
      if (i >= 0 && b < arr.length && arr[b] != null) res[i] = arr[b];
    }
    return res;
  };
  /* fresh containers — the input Maps/arrays keep the run frame intact */
  const plots = new Map();
  if (out.plots) {
    for (const [key, p] of out.plots) {
      plots.set(key, Object.assign({}, p, { values: step(p.values), colors: step(p.colors) }));
    }
  }
  const shapes = new Map();
  if (out.shapes) {
    for (const [key, sh] of out.shapes) {
      /* ROUND148: plotarrow's per-bar direction must remap with its marker
         (once-per-bucket, like ys/texts/colors) or MTF arrows lose up/down.
         ROUND149: same for the magnitude series (height scaling). */
      shapes.set(key, Object.assign({}, sh, { ys: once(sh.ys), texts: once(sh.texts), colors: once(sh.colors) }, sh.dirs ? { dirs: once(sh.dirs) } : null, sh.mags ? { mags: once(sh.mags) } : null));
    }
  }
  return {
    plots,
    plotsOrder: out.plotsOrder ? out.plotsOrder.slice() : [],
    shapes,
    candles: Array.isArray(out.candles) ? step(out.candles) : out.candles,
    fills: Array.isArray(out.fills) ? out.fills.map((f) => Object.assign({}, f, { colors: step(f.colors) })) : out.fills,
    bgcolor: Array.isArray(out.bgcolor) ? step(out.bgcolor) : out.bgcolor,
    barcolor: Array.isArray(out.barcolor) ? step(out.barcolor) : out.barcolor,
    hlines: out.hlines,
    candleMeta: out.candleMeta || null, // ROUND166: Style-tab descriptor rides the remap
    alertconds: out.alertconds,
    alerts: out.alerts,
  };
}

/* lower-TF window: slice cached lower bars to the chart range (plus a
 * warmup tail for indicator seeds) and map every chart bar to the last
 * lower bar at/before it. bars[] entries are shared refs (read-only use).
 * @returns {{bars: Array, map: Array}} map[i] = run-index or -1 (no lower
 * data yet — renders na, same spirit as maxBarsBack). */
function lowerWindowForChart(chartBars, lowerBars, warmup) {
  const W = Math.max(0, Math.min(2000, Math.floor(warmup == null ? 500 : warmup)));
  const n = chartBars.length;
  if (!n || !lowerBars || !lowerBars.length) return { bars: [], map: new Array(n).fill(-1) };
  const start = chartBars[0].time;
  const end = chartBars[n - 1].time;
  const chartSec = n > 1 ? (end - chartBars[0].time) / (n - 1) : 60;
  // first lower bar at/after chart start, backed off by the warmup tail
  let s = lowerBars.length;
  {
    let lo = 0, hi = lowerBars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lowerBars[mid].time < start) lo = mid + 1;
      else hi = mid;
    }
    s = lo;
  }
  const from = Math.max(0, s - W);
  const bars = [];
  for (let i = from; i < lowerBars.length && lowerBars[i].time < end + chartSec; i++) bars.push(lowerBars[i]);
  // chart bar -> last run-index at/before it (run is ascending: linear walk)
  const map = new Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = chartBars[i].time;
    if (bars.length && bars[0].time > t) { map[i] = -1; continue; }
    while (j + 1 < bars.length && bars[j + 1].time <= t) j++;
    map[i] = bars.length ? j : -1;
  }
  return { bars, map };
}

export { buildHtfBars, remapOut, lowerWindowForChart };
