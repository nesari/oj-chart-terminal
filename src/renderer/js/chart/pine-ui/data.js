/**
 * Pine instance manager — data concern.
 *
 * Moved verbatim out of chart/pine-ui.js in F4.3 (no logic changes).
 *
 * @module chart/pine-ui/data
 */
import { U } from '../../core/util.js';
import { icon } from '../../ui/icons.js';
import { App } from '../../../../core/state.js';
import { Log } from '../../../../core/logger.js';
import { Manager } from '../manager.js';
import { compile } from '../../../../core/pine/compile.js';
import { toColor } from '../../../../core/pine/types.js';
import { drawingCensus } from '../../../../core/pine/stdlib/objects.js';
import { brokerStats, downsample, tradeMarkers } from '../../../../core/pine/stdlib/strategy.js';
import { buildHtfBars, remapOut, lowerWindowForChart } from '../../../../core/pine/mtf.js';
import { tfSeconds } from '../../../../core/pine/stdlib/request.js';
import { PineRenderAdapter } from '../pine-render-adapter.js';
import { PineScriptsStore } from '../../panels/pine-scripts-store.js';
import { runFull } from './panel.js';
import { RT } from './shared.js';

/* ------------------------------ ROUND144: MTF -------------------------- */
/* ROUND226 (TV parity): a declaration timeframe="..." runs the script on
   HTF buckets by default (TV runs indicator(timeframe=...) there); the
   dialog pick still wins per instance. Raw string -> provider TF id. */
function resolveDeclTf(pane, raw) {
  try {
    if (!raw || typeof raw !== 'string' || !raw.trim()) return '';
    const t = raw.trim();
    if (App.tfById[t]) return t;
    const sec = tfSeconds(t) || 0;
    if (!sec) return '';
    for (const id of Object.keys(App.tfById || {})) {
      if ((App.tfById[id] || {}).sec === sec) return id;
    }
  } catch (e) {}
  return '';
}
/* Indicator Timeframe: a higher-TF pick runs the script on HTF buckets
   aggregated from the chart bars (core/pine/mtf.js), then maps every
   visual output back to chart bars. Returns {id, sec, dir} or null
   (= chart). Lower/equal picks are handled by the ROUND146 lower path;
   lower-TF scripts (security_lower_tf needs chart-frame intrabars) fall
   back to the chart TF. */
function htfSpec(pane, inst, scriptSource) {
  try {
    /* ROUND226: declaration timeframe= is the default; an explicit dialog
       pick wins; an explicit Chart pick (touched) beats the declaration. */
    let id = '';
    if (inst) {
      if (inst.timeframe) id = String(inst.timeframe);
      else if (inst._tfTouched) id = '';
      else id = inst._declTimeframe || '';
    }
    if (!id) return null;
    const chartSec = (App.tfById[pane.tf] || {}).sec || 60;
    const rec = App.tfById[id];
    const sec = rec && rec.sec;
    if (!sec || sec === chartSec) return null;
    if (scriptSource && scriptSource.indexOf('request.security_lower_tf') >= 0) return null;
    return { id, sec, dir: sec > chartSec ? 'htf' : 'ltf' };
  } catch (e) { return null; }
}

/** bars the runtime executes over (SYNC: HTF buckets or chart; lower-TF
 *  needs async fetch — the tick path uses the cache, runFull ensures it) */
function runBarsFor(pane, inst, scriptSource) {
  const spec = htfSpec(pane, inst, scriptSource);
  if (!spec || spec.dir !== 'htf' || !pane.bars.length) return { spec, bars: pane.bars, map: null };
  try {
    const r = buildHtfBars(pane.bars, spec.sec);
    if (!r.bars.length) return { spec: null, bars: pane.bars, map: null };
    return { spec, bars: r.bars, map: r.map };
  } catch (e) { return { spec: null, bars: pane.bars, map: null }; }
}

/* ------------------------------ ROUND146: lower-TF MTF ----------------- */
/* A lower-TF pick runs the script on real lower history (provider fetch,
   paginated + capped) windowed to the chart range with a warmup tail.
 * Cached per pane (TTL refresh + new-chart-bar refresh); ticks patch the
 * cached forming lower bar from the chart forming bar (same last tick, so
 * close is exact and high/low are correct bounds) instead of refetching. */
const LOWER_CAP = 25000; // max lower bars held per pane (fetch + run budget)
const LOWER_WARMUP = 500; // seed bars before the chart window (atr/rma warmup)

function lowerCacheFresh(pane, lowerId) {
  const c = pane._mtfLower;
  if (!c || c.id !== lowerId || !Array.isArray(c.bars) || !c.bars.length) return false;
  const lowerSec = (App.tfById[lowerId] || {}).sec || 60;
  const ttl = Math.max(15000, Math.min(120000, lowerSec * 1000));
  if (Date.now() - (c.at || 0) > ttl) return false;
  if (!pane.bars.length) return false;
  // a new chart bar arrived past the cache coverage -> stale
  if (c.bars[c.bars.length - 1].time < pane.bars[pane.bars.length - 1].time) {
    const chartSec = (App.tfById[pane.tf] || {}).sec || 60;
    if (pane.bars[pane.bars.length - 1].time - c.bars[c.bars.length - 1].time >= chartSec) return false;
  }
  return true;
}

/** provider lower history covering [fromT, toT] (paginated, capped) */
async function fetchLowerBars(pane, lowerId, fromT, toT) {
  const out = [];
  let to = toT;
  let guard = 0;
  while (out.length < LOWER_CAP && guard++ < 8) {
    let resp = null;
    try {
      resp = await App.feed.bars(pane.symbol, lowerId, Math.min(5000, LOWER_CAP - out.length), out.length ? to : undefined);
    } catch (e) { break; }
    const bars = (resp && resp.bars) || [];
    if (!bars.length) break;
    out.unshift(...bars);
    if (bars[0].time <= fromT) break;
    to = bars[0].time;
    if (out.length >= LOWER_CAP) break;
  }
  // ascending, deduped
  out.sort((a, b) => a.time - b.time);
  const ded = [];
  for (const b of out) {
    if (!ded.length || b.time > ded[ded.length - 1].time) ded.push(b);
  }
  return ded.slice(-LOWER_CAP);
}

async function ensureLowerBars(pane, lowerId) {
  if (!pane.bars.length || !App.feed) return null;
  if (lowerCacheFresh(pane, lowerId)) return pane._mtfLower;
  const lowerSec = (App.tfById[lowerId] || {}).sec || 60;
  const chartSec = (App.tfById[pane.tf] || {}).sec || 60;
  const end = pane.bars[pane.bars.length - 1].time + chartSec;
  const spanBars = Math.ceil((end - pane.bars[0].time) / lowerSec);
  const want = Math.min(LOWER_CAP, spanBars + LOWER_WARMUP + 10);
  const fromT = pane.bars[0].time - LOWER_WARMUP * lowerSec;
  let bars = null;
  try {
    bars = await fetchLowerBars(pane, lowerId, fromT, end);
  } catch (e) { bars = null; }
  if (!bars || !bars.length) return null;
  // keep at most `want` most recent (warmup-bounded window)
  if (bars.length > want) bars = bars.slice(-want);
  pane._mtfLower = { id: lowerId, bars, at: Date.now() };
  return pane._mtfLower;
}

/** fold the chart forming bar's live tick into the cached forming lower bar:
 *  same last tick => close exact, high/low are correct bounds. No fetch. */
function patchLowerForming(pane, lowerId) {
  try {
    const c = pane._mtfLower;
    if (!c || c.id !== lowerId || !c.bars.length || !pane.bars.length) return;
    const cb = pane.bars[pane.bars.length - 1];
    const lb = c.bars[c.bars.length - 1];
    if (!lb || lb.time > cb.time || !isFinite(cb.close)) return;
    if (isFinite(cb.high) && cb.high > lb.high) lb.high = cb.high;
    if (isFinite(cb.low) && cb.low < lb.low) lb.low = cb.low;
    lb.close = cb.close;
    lb.volume = (lb.volume || 0);
  } catch (e) {}
}

/** lower run-window for the CURRENT chart bars (window + up-map) */
function lowerRunFor(pane, lowerId) {
  const c = pane._mtfLower;
  if (!c || c.id !== lowerId || !c.bars.length || !pane.bars.length) return null;
  try {
    const r = lowerWindowForChart(pane.bars, c.bars, LOWER_WARMUP);
    if (!r.bars.length) return null;
    return r;
  } catch (e) { return null; }
}

/** seconds -> 'UTC+03:00' (display) */
function fmtOff(sec) {
  const s = Math.round(sec || 0);
  const sign = s < 0 ? '-' : '+';
  const a = Math.abs(s);
  return 'UTC' + sign + String(Math.floor(a / 3600)).padStart(2, '0') + ':' + String(Math.floor((a % 3600) / 60)).padStart(2, '0');
}

function rtMap(pane) {
  if (!RT.has(pane)) RT.set(pane, new Map());
  return RT.get(pane);
}

function state(pane, instId) { return rtMap(pane).get(instId) || null; }

/* ------------------------------ compile cache ------------------------- */
/* scriptId:updatedAt -> { ok, errors, meta, createInstance, collectInputs } */
const COMPILE_CACHE = new Map();

function compiledFor(script) {
  /* ROUND195: the key carries the store fingerprint — a library edit must
     recompile its importers (resolution snapshots at compile time). */
  let stamp = '';
  try { stamp = PineScriptsStore.all().map((s) => s.id + ':' + s.updatedAt).join(','); } catch (e) {}
  const key = script.id + ':' + script.updatedAt + '#' + stamp;
  let c = COMPILE_CACHE.get(key);
  if (!c) {
    c = compile(script.source, {
      resolveImport: (p) => PineScriptsStore.resolveLibrary(p),
      listCandidates: () => PineScriptsStore.listLibraries(),
    });
    if (COMPILE_CACHE.size > 40) COMPILE_CACHE.clear();
    COMPILE_CACHE.set(key, c);
  }
  return c;
}

/* ------------------------------ intrabar provider --------------------- */

async function ensureM1Cache(pane, force) {
  const cache = pane._pineM1;
  if (!force && cache && Date.now() - cache.at < 30000) return cache;
  /* ROUND87 (indicator inside Custom Session): the session base cache IS M1
     whenever the ladder picked M1 — full-day M1 bars for the WHOLE selected
     range, so historical stitched charts get lower-tf data the live-tail
     cache cannot offer. Always refreshed (in-memory) so a re-apply with a
     new window/range never serves the previous range's bars. */
  const hook = App.sessionHook;
  if (hook && hook.active && hook.active() && hook.m1Source) {
    const src = hook.m1Source(pane.symbol);
    if (src && src.length) {
      pane._pineM1 = { bars: src, at: Date.now(), session: true };
      return pane._pineM1;
    }
  }
  if (!App.feed || !App.feed.connected) return cache || null;
  try {
    const resp = await App.feed.bars(pane.symbol, 'M1', Math.min(App.MAX_CHART_BARS || 25000, 25000));
    if (!App.panes.includes(pane) || pane.symbol !== (resp.symbol || pane.symbol)) return cache || null;
    pane._pineM1 = { bars: resp.bars || [], at: Date.now() };
    return pane._pineM1;
  } catch (e) {
    return cache || null;
  }
}

/* ROUND87: inside Custom Session the synthetic world only contains the
   user's daily window — intrabars outside it (e.g. the tail of a partially
   filled chart-TF bucket) must NOT reach the script, or zones would be
   detected in regions that do not exist on the chart. */
function sessionWindowFilter() {
  const hook = App.sessionHook;
  if (!hook || !hook.active || !hook.active()) return null;
  const w = hook.windowSec && hook.windowSec();
  if (!w || !(w.sTo > w.sFrom)) return null;
  /* ROUND88: the window is entered in the CHART's timezone — the same shift
     the stitch used maps M1 stamps into that wall frame */
  w.shift = (hook.shift && hook.shift()) || null;
  return w;
}

function inWindowSec(t, w) {
  const wall = t + (w.shift ? w.shift(t) : 0);
  const off = wall - Math.floor(wall / 86400) * 86400;
  return off >= w.sFrom && off < w.sTo;
}

/** slice the cached M1 history into per-chart-bar intrabar arrays */
function buildIntrabars(pane, m1Bars) {
  const bars = pane.bars;
  const tfSec = (App.tfById[pane.tf] || {}).sec || 60;
  const out = new Array(bars.length);
  if (!m1Bars || !m1Bars.length || !bars.length) return out;
  // binary search per bar over the sorted M1 times
  const times = m1Bars.map((b) => b.time);
  const win = sessionWindowFilter();   // ROUND87: null outside Custom Session
  for (let i = 0; i < bars.length; i++) {
    const t0 = bars[i].time, t1 = bars[i].time + tfSec;
    // first M1 with time >= t0
    let lo = 0, hi = times.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < t0) lo = mid + 1; else hi = mid; }
    const subs = [];
    for (let k = lo; k < m1Bars.length && m1Bars[k].time < t1; k++) {
      const m = m1Bars[k];
      if (win && !inWindowSec(m.time, win)) continue;
      subs.push({ time: m.time * 1000, open: m.open, high: m.high, low: m.low, close: m.close, volume: m.volume || 0 });
    }
    out[i] = subs;
  }
  return out;
}

function refreshLastIntrabar(pane, intrabars, m1Bars) {
  const bars = pane.bars;
  if (!bars.length || !m1Bars || !m1Bars.length) return;
  const tfSec = (App.tfById[pane.tf] || {}).sec || 60;
  const t0 = bars[bars.length - 1].time, t1 = t0 + tfSec;
  const win = sessionWindowFilter();   // ROUND87
  // binary search the window start (runs per tick — keep it O(log n))
  let lo = 0, hi = m1Bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (m1Bars[mid].time < t0) lo = mid + 1; else hi = mid; }
  const subs = [];
  for (let k = lo; k < m1Bars.length && m1Bars[k].time < t1; k++) {
    const m = m1Bars[k];
    if (win && !inWindowSec(m.time, win)) continue;
    subs.push({ time: m.time * 1000, open: m.open, high: m.high, low: m.low, close: m.close, volume: m.volume || 0 });
  }
  intrabars[bars.length - 1] = subs;
}

export { resolveDeclTf, htfSpec, runBarsFor, LOWER_CAP, LOWER_WARMUP, lowerCacheFresh, fetchLowerBars, ensureLowerBars, patchLowerForming, lowerRunFor, fmtOff, rtMap, state, COMPILE_CACHE, compiledFor, ensureM1Cache, sessionWindowFilter, inWindowSec, buildIntrabars, refreshLastIntrabar };
