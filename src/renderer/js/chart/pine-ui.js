/**
 * Pine instance manager (round 74 — roadmap phases 6+8, renderer side)
 *
 * Owns the per-chart Pine script instances — the same lifecycle the built-in
 * indicators have through indicators-ui:
 *   pane.pineScripts = [{ id, scriptId, inputs, visible }]
 *   RT: pane -> Map(instId -> { adapter, rt, status, errors, errorLine })
 *
 * Data discipline (rounds 70–72): ONE full run over the loaded history on
 * (re)load, then per tick ONLY the forming bar is rolled back and re-run —
 * never a full re-run per tick.
 *
 * request.security_lower_tf is fed OFFLINE from the pane's own symbol: the
 * M1 history the provider already serves is cached per pane and sliced into
 * per-bar intrabar arrays.
 *
 * @module chart/pine-ui
 */

import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { App } from '../../../core/state.js';
import { Log } from '../../../core/logger.js';
import { Manager } from './manager.js';
import { compile } from '../../../core/pine/compile.js';
import { toColor } from '../../../core/pine/types.js';
import { drawingCensus } from '../../../core/pine/stdlib/objects.js';
import { brokerStats, downsample, tradeMarkers } from '../../../core/pine/stdlib/strategy.js';
import { buildHtfBars, remapOut, lowerWindowForChart } from '../../../core/pine/mtf.js';
import { tfSeconds } from '../../../core/pine/stdlib/request.js';
import { PineRenderAdapter } from './pine-render-adapter.js';
import { PineScriptsStore } from '../panels/pine-scripts-store.js';

const LWC = window.LightweightCharts;

const RT = new Map(); // pane -> Map(instId -> state)
const _tickAt = new Map(); // pane -> last forming-bar refresh ts
const _tickEvery = 250; // ms — forming-bar re-run cadence per pane

/* ---------------------------------------------------------------------- */
/* ROUND78 — color picker value helpers                                     */
/* The dialog now stores colors as 'rgba(r,g,b,a)' strings (alpha-aware,     */
/* lossless through the engine's toColor since the ROUND78 types.js fix).   */
/* ---------------------------------------------------------------------- */

const PINE_NAMED_MINI = {
  white: '#ffffff', black: '#000000', red: '#f23645', green: '#4caf50',
  blue: '#2962ff', gray: '#787b86', silver: '#b2b5be', yellow: '#f7c948',
  orange: '#ff9800', purple: '#9c27b0', aqua: '#00bcd4', lime: '#00e676',
  fuchsia: '#e040fb', maroon: '#880e4f', navy: '#311b92', olive: '#808000',
  teal: '#00bcd4',
};

/** parse anything the dialog may receive (hex 3/6/8, rgb()/rgba(), named) */
function parseColorValue(s) {
  const dflt = { r: 41, g: 98, b: 255, a: 1 };
  const v = s == null ? '' : String(s).trim();
  if (!v) return dflt;
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    const h = m[1];
    if (h.length === 3) return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1 };
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  m = /^rgba?\(\s*(\d{1,3})\s*[,.]\s*(\d{1,3})\s*[,.]\s*(\d{1,3})\s*(?:[,.]\s*([\d.]+)\s*)?\)$/i.exec(v);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : Math.min(1, Math.max(0, parseFloat(m[4]))) };
  const named = PINE_NAMED_MINI[v.toLowerCase()];
  if (named) return parseColorValue(named);
  return dflt;
}

const rgbaStr = (c) => `rgba(${c.r},${c.g},${c.b},${Math.round(c.a * 1000) / 1000})`;
const hexStr = (c) => '#' + [c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();

/** effective broker/server offset for an instance: explicit override wins */
function effServerOffSec(inst) {
  const v = inst && inst.tzOffH;
  if (v != null && v !== '' && isFinite(+v)) return Math.round(Math.max(-14, Math.min(14, +v)) * 3600);
  return (App.feed && App.feed.serverOff) || 0;
}

/* ------------------------------ ROUND143: Style overrides -------------- */
/* inst.style = {
 *   plots:  { [plotKey]: { visible?: bool, color?: css, width?: 1..4, style?: 'solid'|'dashed'|'dotted' } },
 *   shapes: { [shapeKey]: { visible?: bool, color?: css, size?: 'tiny'..'huge' } },
 *   fills:  { [fillIdx]: { visible?: bool, color0?: css, color1?: css } },
 *   candles: { visible?: bool, color?: css, wickcolor?: css, bordercolor?: css },
 *   hlines: { [idx]: { visible?: bool, color?: css } },
 *   objects: { boxes?: bool, lines?: bool, labels?: bool },
 *   precision?: 'default' | 0..8, priceLabels?: bool, statusValues?: bool, statusInputs?: bool }
 * Applied as a post-pass over rt.out after every run (full + forming) so
 * canvas painters, legend and native series all see one consistent output.
 * Rebuilds re-run from scratch, so no originals need restoring. */

/** per-timeframe visibility (TV Visibility tab): null/undefined = all on */
function tfVisible(inst, tfId) {
  const v = inst && inst.visTF;
  if (v == null || typeof v !== 'object') return true;
  if (Object.keys(v).length === 0) return true;
  return v[tfId] !== false;
}

/* ROUND167: the TV plot-style menu values (plot.style_* payloads). Style
   overrides are validated against this — garbage never reaches the
   painters' style dispatch. */
const PLOT_STYLE_SET = new Set(['line', 'linebr', 'stepline', 'steplinebr', 'stepline_diamond', 'histogram', 'columns', 'cross', 'area', 'areabr', 'circles']);

function applyInstanceStyle(rt, style) {
  if (!rt || !style || typeof style !== 'object') return;
  const P = style.plots || {}, S = style.shapes || {}, F = style.fills || {};
  for (const key of Object.keys(P)) {
    const ov = P[key];
    const p = ov && rt.out.plots.get(key);
    if (!p) continue;
    if (ov.color) {
      const c = toColor(ov.color);
      if (c) for (let i = 0; i < p.colors.length; i++) {
        if (p.values[i] != null && isFinite(p.values[i])) p.colors[i] = c;
      }
    }
    if (ov.width != null && isFinite(+ov.width)) p.linewidth = Math.max(1, Math.min(4, Math.round(+ov.width)));
    if (ov.style === 'solid' || ov.style === 'dashed' || ov.style === 'dotted') p.linestyle = ov.style;
    /* ROUND167 (TV plot style menu: Line … Circles + Price line toggle).
       Applied pre-syncStructure (runFull order), so native series are born
       with the overridden kind and every painter reads it live. */
    if (typeof ov.plotstyle === 'string' && PLOT_STYLE_SET.has(ov.plotstyle)) p.style = ov.plotstyle;
    if (ov.trackprice === true || ov.trackprice === false) p.trackprice = ov.trackprice;
  }
  for (const key of Object.keys(S)) {
    const ov = S[key];
    const sh = ov && rt.out.shapes.get(key);
    if (!sh) continue;
    if (ov.color) {
      const c = toColor(ov.color);
      if (c) for (let i = 0; i < sh.colors.length; i++) {
        if (sh.ys[i] != null) sh.colors[i] = c;
      }
    }
    if (typeof ov.size === 'string' && ov.size) sh.size = ov.size;
  }
  (rt.out.fills || []).forEach((f, idx) => {
    const ov = F[idx];
    if (!ov || !f) return;
    const c0 = ov.color0 ? toColor(ov.color0) : null;
    const c1 = ov.color1 ? toColor(ov.color1) : null;
    if (!c0 && !c1) return;
    /* TV shows a fill's distinct runtime colors as Color 0 / Color 1 — map
       each distinct used color to its override in first-seen order */
    const seen = [];
    for (let i = 0; i < f.colors.length; i++) {
      const c = f.colors[i];
      if (!c || !c.css) continue;
      const css = c.css();
      let k = seen.indexOf(css);
      if (k < 0) { k = seen.length; seen.push(css); }
      const rep = (k === 0 ? c0 : c1) || c0 || c1;
      if (rep) f.colors[i] = rep;
    }
  });
  /* ROUND166 (TV Style-tab sweep): PlotCandle color overrides + hline color.
     Eye toggles need no apply — the adapter gates on inst.style live. */
  const CD = style.candles || {};
  if ((CD.color || CD.wickcolor || CD.bordercolor) && Array.isArray(rt.out.candles)) {
    const cc = CD.color ? toColor(CD.color) : null;
    const wc = CD.wickcolor ? toColor(CD.wickcolor) : null;
    const bc = CD.bordercolor ? toColor(CD.bordercolor) : null;
    if (cc || wc || bc) {
      for (const rec of rt.out.candles) {
        if (!rec) continue;
        if (cc) rec.color = cc;
        if (wc) rec.wickcolor = wc;
        if (bc) rec.bordercolor = bc;
      }
    }
  }
  const HL = style.hlines || {};
  (rt.out.hlines || []).forEach((h, idx) => {
    const ov = HL[idx];
    if (!ov || !h) return;
    if (ov.color) {
      const c = toColor(ov.color);
      if (c) h.color = c;
    }
  });
}

/* per-script saved style defaults (TV Defaults menu -> Save as default) */
function styleDefKey(scriptId) { return 'mt5_pine_style_def_' + String(scriptId || ''); }
function loadDefaultStyle(scriptId) {
  try {
    const raw = localStorage.getItem(styleDefKey(scriptId));
    if (!raw) return null;
    const o = JSON.parse(raw);
    return (o && typeof o === 'object') ? o : null;
  } catch (e) { return null; }
}
function saveDefaultStyle(scriptId, style) {
  try { localStorage.setItem(styleDefKey(scriptId), JSON.stringify(style || {})); } catch (e) {}
}

/* ROUND170 (phase 1c: live ticks + dynamic symbols for cross-symbol).
   XSYM_LAST holds the newest tick per foreign symbol (module-global: ticks
   are feed-global, runtimes are per-pane). refreshXSymTicks copies the
   relevant ones into a runtime's env.symTicks (keyed 'SYM|sec' like
   symBars) ahead of every full pass and every forming update. */
const XSYM_LAST = {};
let _xsymHooked = false;
function hookXSymTicks() {
  if (_xsymHooked) return;
  try {
    if (!App.feed || !Array.isArray(App.feed.onTick)) return;
    _xsymHooked = true;
    App.feed.onTick.push((sym, price, time) => {
      if (sym == null || !isFinite(price)) return;
      XSYM_LAST[String(sym).replace(/^[A-Z]+:/, '')] = { price, time: time || Date.now() };
    });
  } catch (e) {}
}
function refreshXSymTicks(rt) {
  try {
    if (!rt || !rt.env || !rt.env.symBars) return;
    const t = {};
    for (const key of Object.keys(rt.env.symBars)) {
      const last = XSYM_LAST[String(key.split('|')[0] || '')];
      if (last) t[key] = last;
    }
    rt.env.symTicks = t;
  } catch (e) {}
}
function tfIdForSec(sec) {
  try {
    for (const id of Object.keys(App.tfById || {})) {
      if ((App.tfById[id] || {}).sec === sec) return id;
    }
  } catch (e) {}
  return null;
}
async function fetchXSym(symBare, tfId, want) {
  try {
    const resp = await App.feed.bars(symBare, tfId, Math.max(100, Math.min(25000, want || 5000)));
    const bl = (resp && resp.bars) || [];
    return bl.length ? bl : null;
  } catch (e) { return null; }
}

/* ROUND168 (phase 1a): static cross-symbol pairs for prefetch.
   Returns [[symBare, tfId, sec]] — symbol without broker prefix (same
   strip rule as the engine), tfId resolved to a provider timeframe
   (literal id preferred, else first id with equal seconds; '' resolves
   to the chart TF). Chart-symbol and unresolvable entries are dropped.
   Dynamic symbols (input.symbol) cannot be seen statically — the engine
   throws loudly for those. */
function scanXSymPairs(source, chartSymbol, chartTfId) {
  const out = [];
  if (!source) return out;
  const seen = new Set();
  const re = /\b(?:request\.security|security)\s*\(\s*(['"])([A-Za-z0-9_:.^\/-]+)\1\s*,\s*(['"])([^'"]*)\3/g;
  /* ROUND170: input.symbol("X") defaults are static too — same chart TF. */
  const reSym = /\binput\.symbol\s*\(\s*(['"])([A-Za-z0-9_:.^\/-]+)\1/g;
  const pushSym = (symRaw) => {
    const symBare = String(symRaw).replace(/^[A-Z]+:/, '');
    if (!symBare) return;
    if (chartSymbol && (chartSymbol.includes(symBare) || symBare.includes(chartSymbol))) return;
    let tfId = null, sec = 0;
    try {
      if (chartTfId && App.tfById[chartTfId]) { tfId = chartTfId; sec = App.tfById[chartTfId].sec || 0; }
    } catch (e) { tfId = null; }
    if (!tfId || !sec) return;
    const k = symBare + '|' + sec;
    if (seen.has(k)) return;
    seen.add(k);
    out.push([symBare, tfId, sec]);
  };
  let ms = null;
  while ((ms = reSym.exec(source)) !== null) pushSym(ms[2]);
  /* ROUND210 (synthetic chart-type tickers): literal ticker handles hide
     their symbol + base TF from the security regex above
     (request.security(ticker.renko("EURUSD","D",2), ...) never matches it),
     so cross-symbol formations always ate the first-run failure + retry
     flash. Scan ticker.heikinashi("SYM") and
     ticker.renko|linebreak|kagi|pointfigure("SYM"[,"TF"]) directly; a
     missing/empty TF means the chart TF (same rule as the engine's handle
     resolution). Dynamic (input-driven) handles still ride the retry loop. */
  const reTick = /\bticker\.(heikinashi|renko|linebreak|kagi|pointfigure)\s*\(\s*(['"])([A-Za-z0-9_:.^\/-]+)\2\s*(?:,\s*(['"])([^'"]*)\4)?/g;
  let mt = null;
  while ((mt = reTick.exec(source)) !== null) {
    const symBare = String(mt[3]).replace(/^[A-Z]+:/, '');
    const tfRaw = String(mt[5] || '');
    if (!symBare) continue;
    if (chartSymbol && (chartSymbol.includes(symBare) || symBare.includes(chartSymbol))) continue;
    let sec = 0, tfId = null;
    try {
      if (!tfRaw && chartTfId && App.tfById[chartTfId]) {
        tfId = chartTfId;
        sec = App.tfById[chartTfId].sec || 0;
      } else {
        sec = tfSeconds(tfRaw) || 0;
        if (App.tfById[tfRaw]) tfId = tfRaw;
        else if (sec) {
          for (const id of Object.keys(App.tfById || {})) {
            if ((App.tfById[id] || {}).sec === sec) { tfId = id; break; }
          }
        }
      }
    } catch (e) { tfId = null; }
    if (!tfId || !sec) continue;
    const k = symBare + '|' + sec;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([symBare, tfId, sec]);
  }
  let m = null;
  while ((m = re.exec(source)) !== null) {
    const symBare = String(m[2]).replace(/^[A-Z]+:/, '');
    const tfRaw = String(m[4] || '');
    if (!symBare) continue;
    if (chartSymbol && (chartSymbol.includes(symBare) || symBare.includes(chartSymbol))) continue;
    let sec = 0, tfId = null;
    try {
      if (!tfRaw && chartTfId && App.tfById[chartTfId]) {
        tfId = chartTfId;
        sec = App.tfById[chartTfId].sec || 0;
      } else {
        sec = tfSeconds(tfRaw) || 0;
        if (App.tfById[tfRaw]) tfId = tfRaw;
        else if (sec) {
          for (const id of Object.keys(App.tfById || {})) {
            if ((App.tfById[id] || {}).sec === sec) { tfId = id; break; }
          }
        }
      }
    } catch (e) { tfId = null; }
    if (!tfId || !sec) continue;
    const k = symBare + '|' + sec;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([symBare, tfId, sec]);
  }
  return out;
}

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

/* ------------------------------ instance lifecycle -------------------- */

/**
 * One full (re)build of a script instance: compile -> runtime -> adapter ->
 * history run. Async because of the M1 fetch; safe to call repeatedly.
 */
async function rebuild(pane, inst, opts) {
  opts = opts || {};
  const script = PineScriptsStore.get(inst.scriptId);
  const map = rtMap(pane);
  const prev = map.get(inst.id);
  if (!script) {
    if (prev && prev.adapter) prev.adapter.detach();
    map.delete(inst.id);
    renderRows(pane);
    return;
  }
  const c = compiledFor(script);
  /* ROUND226 (TV parity): declaration timeframe= defaults the run TF.
     Resolved here (before st/htf/env.tfSec all derive from htfSpec). */
  try {
    inst._declTimeframe = (c.ok && c.meta && c.meta.timeframe) ? resolveDeclTf(pane, c.meta.timeframe) : '';
    if (c.ok && c.meta && c.meta.timeframe && !inst._declTimeframe && Log) {
      Log.debug('pine', 'forward-compat: ' + (script.name || 'script') +
        ' timeframe="' + c.meta.timeframe + '" not resolvable — chart TF',
        { script: script.name || '' });
    }
  } catch (e) { try { inst._declTimeframe = ''; } catch (e2) {} }
  /* ROUND222 (forward-compat observability): newer declaration params are
     accepted-and-ignored by declMeta (meta.ignoredParams) — one debug line
     names them so the exported log shows exactly what ran degraded
     (notably timeframe=, which runs on chart TF until R226). */
  try {
    if (c.ok && c.meta && c.meta.ignoredParams && c.meta.ignoredParams.length) {
      Log.debug('pine', 'forward-compat: ' + (script.name || 'script') +
        ' ignored declaration params [' + c.meta.ignoredParams.join(', ') + ']',
        { script: script.name || '' });
    }
    /* ROUND236 (TV parity, observability only): explicit dynamic_requests=false
       with request.* calls in local scope runs LENIENTLY here (R226 machinery)
       while TV rejects it at compile — one debug line names the count so the
       exported log shows the deviation instead of hiding it. */
    if (c.ok && c.meta && c.meta.dynamicRequests === false && (c.meta.localRequests || 0) > 0) {
      Log.debug('pine', 'dynamic_requests=false: ' + (script.name || 'script') +
        ' runs ' + c.meta.localRequests + ' local-scope request.* call(s) leniently (TV rejects)',
        { script: script.name || '' });
    }
  } catch (e) {}
  if (!c.ok) {
    if (prev && prev.adapter) prev.adapter.detach();
    map.set(inst.id, { adapter: null, rt: null, status: 'error', errors: c.errors,
      errorLine: c.errors.length ? c.errors[0].line : 0, script, scriptId: inst.scriptId });
    /* ROUND221 (user report: legend ⚠ with no findable error text): compile
       failures used to live only in st.errors, invisible to the Diagnostics
       log — the user was asked for an "errors column" that had nothing in
       it. Every error transition now lands in Log (cat 'pine') with the
       script name + first message + line, so the Diagnostics ERR filter
       finds it and the exported log carries it. */
    try {
      const f = c.errors[0] || {};
      Log.error('pine', 'compile failed: ' + (script.name || script.scriptId || 'script') +
        ': ' + (f.message || 'unknown error'),
        { script: script.name || String(script.scriptId || ''), line: f.line || 0, code: f.code || '' });
    } catch (e) {}
    renderRows(pane);
    return;
  }
  // fresh adapter + runtime every rebuild (inputs/script/pane may have changed)
  if (prev && prev.adapter) prev.adapter.detach();
  /* ROUND143: Defaults menu "Save as default" — a fresh instance with no
     explicit style inherits the saved one (explicit per-instance style wins) */
  if (!inst.style) {
    const dd = loadDefaultStyle(inst.scriptId);
    if (dd) inst.style = dd;
  }
  const adapter = new PineRenderAdapter(pane, inst);
  /* ROUND77 (BUG-76-B): running/pendingRerun serialize the lifecycle — see runFull */
  const st = { adapter, rt: null, status: 'loading', errors: [], errorLine: 0, script, scriptId: inst.scriptId,
    running: false, pendingRerun: false,
    /* ROUND80: the TF this runtime was built for — a TF switch must REBUILD
       (fresh globals + correct env.tfSec), never re-run the old runtime */
    tf: pane.tf,
    /* ROUND144: the indicator timeframe this runtime was built for */
    htf: (htfSpec(pane, inst, script.source) || {}).id || '' };
  map.set(inst.id, st);
  renderRows(pane);
  if (!pane.bars.length) return; // data arrives later via Manager.recomputePine
  // input defs: dry-collect once so the settings dialog can open before data
  if (!st.inputDefs || !st.inputDefs.length) {
    const ci = c.collectInputs({
      tfSec: (App.tfById[pane.tf] || {}).sec || 60, symbol: pane.symbol,
      mintick: 0.00001, serverOffSec: effServerOffSec(inst),
    });
    if (ci.ok) st.inputDefs = ci.inputs;
  }
  const rt = c.createInstance({
    tfSec: (htfSpec(pane, inst, script.source) || {}).sec || (App.tfById[pane.tf] || {}).sec || 60,
    symbol: pane.symbol,
    mintick: 0.00001,
    serverOffSec: effServerOffSec(inst),
    inputValues: inst.inputs || {},
    /* ROUND175: dialog Properties (capital / order size / pyramiding /
       commission / slippage) override the static strategy() literals. */
    strategyProps: inst.strategyProps || null,
    slippageTicks: (inst.strategyProps && +inst.strategyProps.slippage_ticks > 0)
      ? +inst.strategyProps.slippage_ticks : 0,
    /* ROUND156: the declaration's max_bars_back finally reaches the runtime
       (it used to be parsed, clamped, then dropped — every script ran 5000) */
    maxBarsBack: (c.meta && c.meta.maxBarsBack) || undefined,
    /* ROUND216 (TV parity): live chart theme colors for chart.fg_color /
       chart.bg_color. fg comes from the rendered chart's own textColor;
       bg falls back to the theme factory default (the chart surface is
       transparent over CSS). No Theme import — avoids a manager-cycle. */
    chartFg: (() => { try { return pane.chart ? pane.chart.options().layout.textColor : null; } catch (e) { return null; } })(),
    chartBg: (typeof document !== 'undefined' && document.body && document.body.classList.contains('theme-light')) ? '#ffffff' : '#0f0f0f',
  });
  st.rt = rt;
  adapter.attach(rt);
  /* ROUND168 (phase 1a: cross-symbol history): prefetch literal
     request.security("SYM","TF",...) pairs so the engine branch finds
     env.symBars['SYM|sec'] (§12). Parallel, best-effort, skipped when the
     script only references the chart symbol.
     ROUND170 (phase 1c): subscribe for live ticks + missing-pair retry. */
  const spanSec = pane.bars.length > 1
    ? Math.max(60, pane.bars[pane.bars.length - 1].time - pane.bars[0].time) : 86400;
  const wantFor = (sec) => Math.max(100, Math.min(5000, Math.ceil(spanSec / sec) + 50));
  try {
    const pairs = scanXSymPairs(script.source, pane.symbol, pane.tf);
    /* ROUND210 probe: which cross-symbol pairs the static scan saw (ticker
       handles included) — the E2E pins prefetch without timing tricks. */
    st.lastXSymPairs = pairs.map(([s, t, sec]) => s + '|' + sec);
    if (pairs.length && pane.bars.length) {
      hookXSymTicks();
      const got = {};
      await Promise.all(pairs.map(async ([symBare, tfId, sec]) => {
        try { await App.feed.subscribe(symBare); } catch (e) {}
        const bl = await fetchXSym(symBare, tfId, wantFor(sec));
        if (bl) got[symBare + '|' + sec] = bl;
      }));
      if (Object.keys(got).length) rt.env.symBars = got;
    }
  } catch (e) {}
  rt.env.symBars = rt.env.symBars || null; // explicit null beats undefined for the engine branch
  refreshXSymTicks(rt);
  st.rt.missingSymBars = [];
  await runFull(pane, inst);
  /* ROUND226 (dynamic requests): fixpoint data fetch. Static prefetch
     covers literal pairs; series-driven symbols/TFs (input.symbol values,
     loop and local-scope calls, library runtimes — env is SHARED, so libs
     see fetched bars too) surface only at runtime. Throw-mode aborts at the
     first miss; then ONE NA-provisional discovery pass collects the FULL
     missing set at once (own + library runtimes, deduped); fetch all; final
     clean pass. Every full pass resets state (R87), so the provisional pass
     pollutes nothing. Cap 4 rounds; unfetchable pairs keep the loud error
     (R221 observability). */
  const clearMisses = () => {
    try {
      if (st.rt) st.rt.missingSymBars = [];
      if (st.rt && st.rt.libs) for (const [, lib] of st.rt.libs) { if (lib && lib.rt) lib.rt.missingSymBars = []; }
    } catch (e) {}
  };
  const collectMisses = () => {
    const out = [], seen = new Set();
    const grab = (rt) => {
      try {
        for (const m of (rt && rt.missingSymBars) || []) {
          if (!m || !m.sym || !m.sec) continue;
          const k = m.sym + '|' + m.sec;
          if (seen.has(k)) continue;
          seen.add(k);
          const have = st.rt && st.rt.env && st.rt.env.symBars && st.rt.env.symBars[k];
          if (have && have.length) continue;
          out.push({ sym: m.sym, sec: m.sec });
        }
      } catch (e) {}
    };
    grab(st.rt);
    try { if (st.rt && st.rt.libs) for (const [, lib] of st.rt.libs) { if (lib && lib.rt) grab(lib.rt); } } catch (e) {}
    return out;
  };
  for (let round = 0; round < 4; round++) {
    const miss = collectMisses();
    const isMissingErr = st.status === 'error' && st.errors.some((e) => /no history for/.test(e.message || ''));
    if (!isMissingErr || !miss.length) break;
    /* discovery: NA-provisional full pass learns every dynamic pair at once
       (single-pair throw-abort would need a round per pair). */
    st.rt.env.collectMissing = true;
    clearMisses();
    await runFull(pane, inst);
    st.rt.env.collectMissing = false;
    const miss2 = collectMisses();
    let fetched = false;
    for (const m of miss2) {
      const tfId = tfIdForSec(m.sec);
      if (!tfId) continue;
      try { await App.feed.subscribe(m.sym); } catch (e) {}
      const bl = await fetchXSym(m.sym, tfId, wantFor(m.sec));
      if (bl) {
        st.rt.env.symBars = st.rt.env.symBars || {};
        st.rt.env.symBars[m.sym + '|' + m.sec] = bl;
        fetched = true;
        /* ROUND226 observability: which dynamic pairs the fixpoint fed. */
        try { if (Log) Log.debug('pine', 'dynamic fetch: ' + m.sym + '|' + m.sec + ' (' + bl.length + ' bars)', { script: (script && script.name) || '' }); } catch (e) {}
      }
    }
    hookXSymTicks();
    refreshXSymTicks(st.rt);
    clearMisses();
    /* unfetched: re-run throw-mode once so the loud error (not a silent
       NA-provisional ok) is what stands. */
    await runFull(pane, inst);
    if (!fetched) break;
  }
}

async function runFull(pane, inst) {
  const st = state(pane, inst.id);
  if (!st || !st.rt) return;
  if (!pane.bars.length) return;
  /* ROUND77 (BUG-76-B): the per-tick hook used to re-enter the runtime while
     the initial chunked history pass was still yielding to the event loop —
     updateForming()/runAll() then executed the LAST bar against HALF-BUILT
     var state (786 Zones: zones not yet accumulated) and the polluted
     pre-forming snapshot outlived the real pass. The initial pass now owns
     the runtime exclusively; concurrent runFull calls re-queue once. */
  if (st.running) { st.pendingRerun = true; return; }
  st.running = true;
  /* ROUND160 (user report: adding SMC wiped every OTHER indicator until it
     finished, and its own lines visibly "grew" across the chart): the chunked
     pass yields to the event loop, and each 400-bar chunk changes barIndex +
     store.version — i.e. the paint key — so the manager loop repainted the
     PARTIAL output every chunk; the generational clear in that partial paint
     wiped the siblings whose keys hadn't changed, and their key-skip left
     them erased until the next tick. While a full pass is in flight, panes
     skip every non-forced paint; completion ends with one forced full-set
     repaint (see finally). */
  pane._pineRunning = (pane._pineRunning || 0) + 1;
  try {
    let intrabars = null;
    const needsLowerTf = st.script && st.script.source.indexOf('request.security_lower_tf') >= 0;
    /* ROUND192: strategies with use_bar_magnifier ride the same M1 cache
       (fills evaluate sub-bar ranges; uncovered bars fall back). */
    const stratPropsNow = (inst && inst.strategyProps) || null;
    const needsMagnifier = !!(st.rt && st.rt.meta && st.rt.meta.isStrategy &&
      (((st.rt.meta.strategy || {}).use_bar_magnifier === true) ||
        (stratPropsNow && stratPropsNow.use_bar_magnifier === true)));
    if (needsLowerTf || needsMagnifier) {
      const cache = await ensureM1Cache(pane, !pane._pineM1);
      if (cache && cache.bars) intrabars = buildIntrabars(pane, cache.bars);
    }
    st.rt.env.intrabars = intrabars;
    const t0 = performance.now();
    /* ROUND144: MTF — run over HTF buckets, then map visuals to chart bars.
       ROUND146: lower-TF runs over fetched lower history (async). */
    const specAll = htfSpec(pane, inst, st.script && st.script.source);
    let rb;
    if (specAll && specAll.dir === 'ltf') {
      const cache = await ensureLowerBars(pane, specAll.id);
      const lr = cache ? lowerRunFor(pane, specAll.id) : null;
      if (!lr) {
        st.status = 'error';
        st.errors = [{ code: 'MTF', message: 'lower-TF history unavailable for ' + specAll.id, line: 0 }];
        st.errorLine = 0;
        try { Log.error('pine', 'runtime error: ' + ((st.script && st.script.name) || 'script') + ': lower-TF history unavailable for ' + specAll.id, { script: (st.script && st.script.name) || '', line: 0, code: 'MTF' }); } catch (e) {}
        return;
      }
      patchLowerForming(pane, specAll.id);
      rb = { spec: specAll, bars: lr.bars, map: lr.map };
    } else {
      rb = runBarsFor(pane, inst, st.script && st.script.source);
    }
    try {
      /* ROUND221 (gate traceability for the "growth left-to-right on Add"
         report): one debug line per full pass with the in-flight gate state,
         so the exported log proves the R160 gate engaged and shows exactly
         when the single forced repaint fired. Debug level — no user noise. */
      try { Log.debug('pine', 'full pass start: ' + ((st.script && st.script.name) || 'script') + ' over ' + (rb.bars ? rb.bars.length : 0) + ' bars', { script: (st.script && st.script.name) || '' }); } catch (e) {}
      // chunked full pass: heavy scripts (786 Zones) yield to the event loop
      await st.rt.runChunked(rb.bars, 400);
      st.status = 'ok';
      st.errors = [];
      /* ROUND143+144b: style overrides mutate the RUN-frame output, so they
         must land BEFORE the chart-frame view is derived (not after). */
      applyInstanceStyle(st.rt, inst.style);
      st.rt.viewOut = rb.map ? remapOut(st.rt.out, rb.map, pane.bars.length) : null;
    } catch (e) {
      st.status = 'error';
      st.errors = [{ code: e.code || 'RE', message: e.message || String(e), line: e.line || 0 }];
      st.errorLine = e.line || 0;
      try {
        Log.error('pine', 'runtime error: ' + ((st.script && st.script.name) || 'script') + ': ' +
          (e.message || String(e)) + ' (line ' + (e.line || 0) + ')',
          { script: (st.script && st.script.name) || '', line: e.line || 0, code: e.code || 'RE', bars: st.lastRunBars || null });
      } catch (le) {}
    }
    /* ROUND78 perf: honest per-run timing — surfaces in the legend tooltip
       and Diagnostics (PineUI.debug) so the optimization work is measurable */
    st.lastRunMs = Math.round(performance.now() - t0);
    st.lastRunBars = pane.bars.length;
    st.lastRunAt = Date.now();
    /* ROUND163 (user report: "extra SMC lines that look higher-timeframe"):
       one census line per successful full pass — alive/added/GC'd drawings +
       line-span histogram + longest lines + top labels — so the next user log
       traces exact line origins (stale-swing re-cross vs anything else).
       Ticks use updateForming (not runFull), so this never spams per tick. */
    if (st.status === 'ok' && st.rt && st.rt.store) {
      try {
        const dc = drawingCensus(st.rt.store, (st.rt.env && st.rt.env.tfSec) || 60);
        if (dc.line + dc.box + dc.label > 0 && Log) {
          Log.info('pine', 'drawing census', {
            sym: pane.symbol, tf: pane.tf, script: (st.script && st.script.name) || '',
            bars: st.lastRunBars, ms: st.lastRunMs, alive: [dc.line, dc.box, dc.label],
            adds: [dc.adds.line, dc.adds.box, dc.adds.label], gced: dc.gced,
            lineBars: dc.lineBars, longest: dc.longest, labelTop: dc.labelTop,
          });
        }
      } catch (e) {}
    }
    /* ROUND 74 (BUG): the series/hlines could not exist before this first
       pass (plotsOrder was empty at attach) — build them now, then feed */
    if (st.status === 'ok' && st.adapter) st.adapter.syncStructure();
    st.adapter.refillAll();
  } finally {
    st.running = false;
    renderRows(pane);
    pane._pineRunning = Math.max(0, (pane._pineRunning || 0) - 1);
    /* ROUND184: a finished pass may have closed/opened strategy trades —
       repaint the chart trade markers (closed trades only, so ticks which
       use updateForming never need this). */
    try { if (Manager.applyPaneMarkers) Manager.applyPaneMarkers(pane); } catch (e) {}
    if (st.pendingRerun) { st.pendingRerun = false; runFull(pane, inst); }
    /* ROUND160: completion ends with one forced full-set repaint — without
       it the siblings (key-skipped through the whole run) would stay erased
       until the next tick, and the newcomer would show nothing on a quiet chart.
       Fires only when no other pass is still in flight (overlapping loads
       must not paint each other's partials). */
    else if ((pane._pineRunning || 0) === 0) { try { framePane(pane, true); } catch (e) {} }
  }
}

/** tick hook: forming-bar rollback + re-run, throttled per pane */
function onTickPane(pane) {
  const map = rtMap(pane);
  if (!map.size) return;
  const now = Date.now();
  const last = _tickAt.get(pane) || 0;
  if (now - last < _tickEvery) return;
  _tickAt.set(pane, now);
  const bars = pane.bars;
  if (!bars.length) return;
  const needsAnyM1 = Array.from(map.values()).some((st) => st.rt && st.rt.env.intrabars);
  for (const [instId, st] of map) {
    if (!st.rt || st.status === 'error') continue;
    refreshXSymTicks(st.rt); // ROUND170/phase-1c: foreign-symbol live ticks into the forming aggregate
    /* ROUND77 (BUG-76-B): never re-enter a runtime whose initial chunked
       history pass is still in flight (half-built var state + polluted
       snapshot -> dead drawing objects -> nothing on the chart) */
    if (st.running) continue;
    /* ROUND144: MTF instances tick in the HTF frame (lengths, push and
       forming all run on buckets; visuals remap to chart bars after).
       ROUND146: lower-TF instances tick on the cached lower window (patched
       forming bar, no fetch); a missing/stale cache refreshes in the
       background while this tick is skipped (never paint a wrong frame). */
    const irec0 = (pane.pineScripts || []).find((x) => x.id === instId);
    const specAll = htfSpec(pane, irec0, st.script && st.script.source);
    let rb;
    if (specAll && specAll.dir === 'ltf') {
      patchLowerForming(pane, specAll.id);
      const lr = lowerCacheFresh(pane, specAll.id) ? lowerRunFor(pane, specAll.id) : null;
      if (!lr) {
        ensureLowerBars(pane, specAll.id).then((c) => {
          if (c) { try { runFull(pane, { id: instId }); } catch (e) {} }
        }).catch(() => {});
        continue;
      }
      rb = { spec: specAll, bars: lr.bars, map: lr.map };
    } else {
      rb = runBarsFor(pane, irec0, st.script && st.script.source);
    }
    const eb = rb.bars;
    try {
      if (st.rt.env.intrabars) refreshLastIntrabar(pane, st.rt.env.intrabars, (pane._pineM1 || {}).bars);
      if (eb.length > (st.rt.totalBars || 0)) {
        // a new bar arrived since the last run
        if (eb.length - 1 === (st.rt.totalBars || 0)) {
          st.rt.pushNewBar(eb);
        } else {
          /* ROUND77 (BUG-76-C): a multi-bar gap used to run a FULL SYNCHRONOUS
             runAll() on the main thread — for heavy scripts (786 Zones) on a
             deep history that froze the renderer for tens of seconds and, when
             pages of older bars kept arriving, chained run-after-run until the
             tab crashed. Route it through the chunked runFull() instead: the
             same honest full pass, but yielding to the event loop every 400
             bars, with the BUG-76-B running-guard serializing re-entry. */
          runFull(pane, { id: instId });
        }
      } else {
        st.rt.updateForming(eb);
      }
      /* ROUND143+144b: style first (run frame), then derive the view —
         the tick feed below must see styled values. */
      const irec = (pane.pineScripts || []).find((x) => x.id === instId);
      applyInstanceStyle(st.rt, irec && irec.style);
      st.rt.viewOut = rb.map ? remapOut(st.rt.out, rb.map, bars.length) : null;
      st.status = 'ok';
    } catch (e) {
      st.status = 'error';
      st.errors = [{ code: e.code || 'RE', message: e.message || String(e), line: e.line || 0 }];
      try {
        Log.error('pine', 'tick error: ' + ((st.script && st.script.name) || 'script') + ': ' +
          (e.message || String(e)) + ' (line ' + (e.line || 0) + ')',
          { script: (st.script && st.script.name) || '', line: e.line || 0, code: e.code || 'RE' });
      } catch (le) {}
    }
  }
  if (needsAnyM1 && pane._pineM1 && Date.now() - pane._pineM1.at > 30000) ensureM1Cache(pane, true);
  // tick path: incremental last-bar series update only (never full setData)
  for (const [, st] of map) if (st.adapter && st.status === 'ok') st.adapter.updateLast();
}

/* ------------------------------ public API ---------------------------- */

function recomputePine(pane) {
  if (!pane || !pane.chart) return;
  const list = pane.pineScripts || [];
  const seen = new Set();
  for (const inst of list) {
    seen.add(inst.id);
    const st = state(pane, inst.id);
    if (!st || st.scriptId !== inst.scriptId) {
      rebuild(pane, inst);
    } else if (!pane.bars.length) {
      // data gone (symbol switch): drop the runtime until bars return
      st.adapter.detach();
      rtMap(pane).delete(inst.id);
    } else {
      /* ROUND80: a TF switch used to re-run the SAME runtime over the new
         history — `var`/series state from the previous TF leaked into the
         new pass (TV re-executes from scratch per interval) and env.tfSec
         stayed stale. A TF change now rebuilds the instance (compile is
         cached, so this is cheap); only a same-TF history reload re-runs. */
      if (st.tf !== pane.tf) { rebuild(pane, inst); }
      /* ROUND144: an Indicator-Timeframe edit must rebuild too (fresh
         HTF-frame globals + env.tfSec) — same rule as a chart TF switch */
      else if (((htfSpec(pane, inst, st.script && st.script.source) || {}).id || '') !== (st.htf || '')) { rebuild(pane, inst); }
      else {
        /* ROUND78 perf: rebuild()/add()/the settings-Ok path ALREADY ran a
           full pass a moment ago; recomputePine fires right after on the SAME
           data and used to repeat the entire history run back-to-back (2x the
           heavy work per add/Ok). Skip when the state is fresh and the bar
           count is unchanged — a genuine history reload changes the length. */
        const fresh = st.lastRunAt && st.lastRunBars === pane.bars.length && Date.now() - st.lastRunAt < 1500;
        if (!fresh) runFull(pane, inst); // history reloaded
      }
    }
  }
  for (const instId of Array.from(rtMap(pane).keys())) {
    if (!seen.has(instId)) {
      const st = rtMap(pane).get(instId);
      if (st && st.adapter) st.adapter.detach();
      rtMap(pane).delete(instId);
    }
  }
  renderRows(pane);
}

function add(pane, scriptId, inputs) {
  if (!pane || !scriptId) return null;
  pane.pineScripts = pane.pineScripts || [];
  const inst = { id: Date.now() + Math.floor(Math.random() * 999), scriptId, inputs: inputs || {}, visible: true };
  pane.pineScripts.push(inst);
  Manager.persistPanes();
  rebuild(pane, inst);
  return inst;
}

function remove(pane, instId) {
  pane.pineScripts = (pane.pineScripts || []).filter((i) => i.id !== instId);
  const st = state(pane, instId);
  if (st && st.adapter) st.adapter.detach();
  rtMap(pane).delete(instId);
  Manager.persistPanes();
  renderRows(pane);
  /* ROUND184: dropping a strategy drops its chart markers with it. */
  try { if (Manager.applyPaneMarkers) Manager.applyPaneMarkers(pane); } catch (e) {}
}

function toggleVisible(pane, instId) {
  const inst = (pane.pineScripts || []).find((i) => i.id === instId);
  if (!inst) return;
  inst.visible = inst.visible === false;
  const st = state(pane, instId);
  /* ROUND140: one funnel (adapter.setVisible) — native series, hlines,
     canvases and legend; the old inline loop left hlines + legend behind
     and rebuilds (TF switch) never re-applied the eye at all */
  if (st && st.adapter) st.adapter.setVisible(inst.visible !== false);
  Manager.persistPanes();
  renderRows(pane);
}

function applyVisibility(pane, inst) {
  const st = state(pane, inst.id);
  if (!st) return;
  const on = inst.visible !== false;
  for (const { s } of st.adapter.series) { try { s.applyOptions({ visible: on }); } catch (e) {} }
}

/* ------------------------------ legend rows --------------------------- */

function ensureRows(pane) {
  if (!pane._pineRows) pane._pineRows = U.el('div', 'ind-rows', pane.legend);
  return pane._pineRows;
}

function renderRows(pane) {
  U.clear(ensureRows(pane));
  for (const inst of pane.pineScripts || []) {
    const st = state(pane, inst.id);
    /* ROUND 74 (TV parity): a non-overlay script's row lives INSIDE its
       sub-pane header (like every built-in separate indicator since
       round 32); overlay rows stay in the chart's top legend. Same
       sub._rows wrapper + no-sub-yet fallback as indicators-ui. */
    let box = ensureRows(pane);
    if (st && st.adapter && st.adapter.sub) {
      const sub = st.adapter.sub;
      if (!sub._rows) sub._rows = U.el('div', 'ind-rows', sub.legend);
      U.clear(sub._rows);
      box = sub._rows;
    }
    const row = U.el('div', 'ind-row' + (inst.visible === false ? ' hidden-inst' : ''), box);
    row.dataset.pine = String(inst.id);
    const title = U.el('span', 'ind-title', row);
    const dotCls = (st && st.rt && st.status === 'ok') ? 'dot-ok' : (st && st.status === 'error') ? 'dot-error' : 'dot-idle';
    const label = st && st.rt ? st.rt.meta.title : (st && st.script ? st.script.name : 'Pine Script');
    title.innerHTML = `<i class="${dotCls}"></i>${U.esc(label)}` +
      (st && st.status === 'error' ? ' <span class="u-err-color">⚠</span>' : '');
    /* ROUND175: strategy instances carry a STRATEGY tag so they are never
       mistaken for plain indicators (user request — visible in the legend,
       the settings title and the tester picker). */
    try {
      const isStrat = !!(st && st.rt && st.rt.meta && st.rt.meta.isStrategy);
      if (isStrat) {
        const tag = U.el('span', 'pine-strat-tag', title);
        tag.textContent = 'STRATEGY';
        tag.title = 'Pine strategy (backtested) — not an indicator';
      }
    } catch (e) {}
    /* ROUND78 perf: expose the measured full-pass time on the row tooltip */
    if (st && st.status === 'error' && st.errors && st.errors.length) {
      /* ROUND221: the ⚠ row carries the actual error text in its tooltip
         (title property — no innerHTML), so the user can read/copy it
         without opening anything; the same text is in Diagnostics (cat
         'pine', ERR filter) via the Log.error on every error transition. */
      const fe = st.errors[0] || {};
      row.title = label + ' — ERROR: ' + (fe.message || 'unknown error') +
        (fe.line ? ' (line ' + fe.line + ')' : '') + ' — see Diagnostics (ERR filter, pine category)';
    } else if (st && st.lastRunMs != null) {
      row.title = `${label} — full pass ${st.lastRunMs}ms over ${st.lastRunBars} bars` +
        (st.rt ? ` — memo hits ${st.rt._memoHits || 0}` : '');
    }
    const vals = U.el('span', 'ind-vals', row);
    const btns = U.el('span', 'ind-btns', row);
    const eye = U.el('button', 'ind-btn', btns);
    eye.innerHTML = icon(inst.visible === false ? 'eyeoff' : 'eye');
    eye.title = 'Show / Hide';
    eye.addEventListener('click', (e) => { e.stopPropagation(); toggleVisible(pane, inst.id); });
    const gear = U.el('button', 'ind-btn', btns);
    gear.innerHTML = icon('gear');
    gear.title = 'Settings';
    gear.addEventListener('click', (e) => { e.stopPropagation(); openSettingsDialog(pane, inst); });
    const del = U.el('button', 'ind-btn ind-del', btns);
    del.innerHTML = icon('x');
    del.title = 'Remove';
    del.addEventListener('click', (e) => { e.stopPropagation(); remove(pane, inst.id); });
    row.addEventListener('click', () => openSettingsDialog(pane, inst));
    if (st && st.adapter) st.adapter.legEl = vals;
  }
  updateRowValues(pane, null);
}

function updateRowValues(pane, hoverTime) {
  for (const inst of pane.pineScripts || []) {
    const st = state(pane, inst.id);
    if (st && st.adapter) st.adapter.updateLegendValues(hoverTime);
  }
}

/* ------------------------------ settings dialog ----------------------- */

function openSettingsDialog(pane, inst) {
  const st = state(pane, inst.id);
  const script = PineScriptsStore.get(inst.scriptId);
  if (!st || !script) return;
  const defs = (st.inputDefs && st.inputDefs.length) ? st.inputDefs : (() => {
    const ci = compiledFor(script).collectInputs({ tfSec: (App.tfById[pane.tf] || {}).sec || 60, symbol: pane.symbol, mintick: 0.00001 });
    if (ci.ok) { st.inputDefs = ci.inputs; return ci.inputs; }
    return [];
  })();
  const title = st.rt ? st.rt.meta.title : script.name;
  /* ROUND175: strategy identity — a 4th Properties tab (TV parity) holds
     the broker-emulator settings; plain indicators keep 3 tabs. */
  const isStratDlg = !!(st.rt && st.rt.meta && st.rt.meta.isStrategy);
  const stratDefaults = (st.rt && st.rt.meta && st.rt.meta.strategy) || {};
  const layer = document.getElementById('popup-layer');
  U.clear(layer);
  const back = U.el('div', 'dialog-backdrop', layer);
  const dlg = U.el('div', 'dialog ind-settings', back);
  /* ROUND 75 (BUG): the layer used to be un-hidden BEFORE the dialog body was
     built — any throw mid-build left an EMPTY dialog floating over a live
     backdrop that swallowed every click on the chart (the UI felt frozen
     until restart; BUG-74-D "U.escape is not a function" shipped exactly
     that way). Now everything is built while still hidden and the layer is
     revealed only after success; the catch path restores a clean hidden
     layer + removes the key handler, so a broken build can never lock the
     UI again — the error still reaches the global handler via re-throw. */
  const close = () => { layer.classList.add('hidden'); U.clear(layer); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  try {
    dlg.innerHTML = `<h3>${U.esc(title)} <span class="pine-dlg-src">(${U.esc(script.name)})</span>${isStratDlg ? ' <span class="pine-strat-tag">STRATEGY</span>' : ''}<button class="mini-btn dlg-x" title="Close">${icon('x')}</button></h3>
      <div class="pine-tabs"><button class="pine-tab on" data-tab="inputs">Inputs</button>${isStratDlg ? '<button class="pine-tab" data-tab="props">Properties</button>' : ''}<button class="pine-tab" data-tab="style">Style</button><button class="pine-tab" data-tab="vis">Visibility</button></div>
      <div class="ist-body pine-inputs"></div>
      ${isStratDlg ? '<div class="ist-body pine-props hidden"></div>' : ''}
      <div class="ist-body pine-style hidden"></div>
      <div class="ist-body pine-vis hidden"></div>
      <div class="dlg-actions">
        <button class="dlg-btn dlg-ghost ist-remove">Remove</button>
        <button class="dlg-btn dlg-ghost ist-defaults">Defaults</button>
        <span class="dlg-spacer"></span>
        <button class="dlg-btn dlg-primary ist-ok">Ok</button>
      </div>`;
    const body = dlg.querySelector('.pine-inputs');
    const propsBody = dlg.querySelector('.pine-props');
    const styleBody = dlg.querySelector('.pine-style');
    const visBody = dlg.querySelector('.pine-vis');
    /* ROUND143: TV tab switching (Inputs / Style / Visibility).
       ROUND143b: visibility rides the .hidden class, NEVER an inline
       style="display:none" — the round-81 CSP blocks inline style
       attributes (present in DOM, never applied), which stranded every
       tab's content in Inputs until the first click (CSSOM) fixed it. */
    dlg.querySelectorAll('.pine-tab').forEach((t) => {
      t.addEventListener('click', () => {
        dlg.querySelectorAll('.pine-tab').forEach((x) => x.classList.toggle('on', x === t));
        const k = t.dataset.tab;
        body.classList.toggle('hidden', k !== 'inputs');
        if (propsBody) propsBody.classList.toggle('hidden', k !== 'props');
        styleBody.classList.toggle('hidden', k !== 'style');
        visBody.classList.toggle('hidden', k !== 'vis');
        closePal();
      });
    });
    document.addEventListener('keydown', onKey);
    dlg.querySelector('.dlg-x').addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });

    const values = {};
    /* ROUND145 (Defaults Reset): when armed, controls render script
       defvals instead of the saved inst.inputs (TV: Reset shows factory
       values; Ok commits them). */
    let showDefaults = false;
    const getVal = (d) => {
      if (showDefaults) return d.defval;
      return (inst.inputs && inst.inputs[d.id] != null) ? inst.inputs[d.id] : d.defval;
    };
    /* ------------------------------------------------------------------ */
    /* ROUND78 — TV-style color picker (user request + reference shot):     */
    /* every color input gets a swatch that opens a palette panel with a    */
    /* preset grid, a custom-swatch row (+ exact-color eyedropper) and an   */
    /* OPACITY slider + percent box. The old native <input type=color>      */
    /* silently DROPPED the alpha of defaults like color.new(#4169E1, 65).  */
    /* Values flow as 'rgba(r,g,b,a)' strings — lossless in the engine.     */
    /* ------------------------------------------------------------------ */
    const PAL_ROWS = [
      ['#FFFFFF', '#D1D4DC', '#A3A6AD', '#787B86', '#4F535E', '#363A45', '#1E222D', '#131722', '#0C0E15', '#000000'],
      ['#F23645', '#FF9800', '#FDD835', '#8BC34A', '#4CAF50', '#00BCD4', '#2962FF', '#311B92', '#9C27B0', '#E040FB'],
      ['#FFCDD2', '#FFE0B2', '#FFF9C4', '#DCEDC8', '#C8E6C9', '#B2DFDB', '#B3E5FC', '#BBDEFB', '#E1BEE7', '#F8BBD0'],
      ['#E57373', '#FFB74D', '#FFF176', '#AED581', '#81C784', '#4DB6AC', '#4FC3F7', '#64B5F6', '#BA68C8', '#F48FB1'],
      ['#B71C1C', '#E65100', '#F9A825', '#33691E', '#1B5E20', '#006064', '#01579B', '#1A237E', '#4A148C', '#880E4F'],
    ];
    if (!dlg._pineCustomColors) dlg._pineCustomColors = [];
    let openPal = null;
    const closePal = () => { if (openPal) { openPal.remove(); openPal = null; } };
    dlg.addEventListener('scroll', closePal, true); // .ist-body scroll closes it

    /* ROUND143: generalized from an input-bound picker to (initialCss,
       onPick) so the Style tab reuses the same palette for plot/shape/fill
       swatches. Colors flow as 'rgba(r,g,b,a)' strings (lossless). */
    const buildColorPicker = (row, getCss, setCss, btnCls) => {
      const cur = parseColorValue(typeof getCss === 'function' ? getCss() : getCss);
      const swatch = U.el('button', btnCls || 'pine-swatch-btn', row);
      swatch.type = 'button';
      const fill = U.el('span', 'pine-swatch-fill', swatch);
      const paint = () => { fill.style.background = rgbaStr(cur); swatch.title = hexStr(cur) + ' — ' + Math.round(cur.a * 100) + '% opacity'; };
      paint();
      setCss(rgbaStr(cur));

      const commit = () => { paint(); setCss(rgbaStr(cur)); };
      const open = () => {
        if (openPal) { closePal(); return; }
        const pal = U.el('div', 'pine-palette');
        openPal = pal;
        const grid = U.el('div', 'pine-pal-grid', pal);
        for (const r of PAL_ROWS) for (const hx of r) {
          const sw = U.el('button', 'pine-pal-sw', grid);
          sw.type = 'button';
          sw.style.background = hx;
          sw.title = hx;
          sw.addEventListener('click', () => {
            const p = parseColorValue(hx);
            cur.r = p.r; cur.g = p.g; cur.b = p.b; commit();
          });
        }
        // custom row (+ = exact color via the native eyedropper dialog)
        const cust = U.el('div', 'pine-pal-custom', pal);
        const renderCustom = () => {
          U.clear(cust);
          for (const hx of dlg._pineCustomColors.slice(0, 8)) {
            const sw = U.el('button', 'pine-pal-sw pine-pal-csw', cust);
            sw.type = 'button'; sw.style.background = hx; sw.title = hx;
            sw.addEventListener('click', () => {
              const p = parseColorValue(hx);
              cur.r = p.r; cur.g = p.g; cur.b = p.b; commit();
            });
          }
          const plus = U.el('button', 'pine-pal-plus', cust);
          plus.type = 'button'; plus.textContent = '+'; plus.title = 'Custom color';
          const eye = document.createElement('input');
          eye.type = 'color'; eye.style.position = 'absolute'; eye.style.width = '0'; eye.style.height = '0'; eye.style.opacity = '0'; eye.style.pointerEvents = 'none';
          cust.appendChild(eye);
          plus.addEventListener('click', () => eye.click());
          eye.addEventListener('input', () => {
            const hx = eye.value.toUpperCase();
            const arr = dlg._pineCustomColors;
            const i = arr.indexOf(hx);
            if (i >= 0) arr.splice(i, 1);
            arr.unshift(hx);
            if (arr.length > 8) arr.length = 8;
            const p = parseColorValue(hx);
            cur.r = p.r; cur.g = p.g; cur.b = p.b; commit();
            renderCustom();
          });
        };
        renderCustom();
        // opacity slider + percent box (0% = invisible, TV parity)
        const opa = U.el('div', 'pine-pal-opacity', pal);
        U.el('span', 'pine-pal-olabel', opa).textContent = 'Opacity';
        const slider = U.el('input', 'pine-pal-slider', opa);
        slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
        const num = U.el('input', 'pine-pal-num', opa);
        num.type = 'number'; num.min = '0'; num.max = '100'; num.step = '1';
        const syncOpa = () => { slider.value = String(Math.round(cur.a * 100)); num.value = String(Math.round(cur.a * 100)); };
        syncOpa();
        const setOpa = (v) => {
          const n = Math.min(100, Math.max(0, Math.round(+v || 0)));
          cur.a = n / 100; syncOpa(); commit();
        };
        slider.addEventListener('input', () => setOpa(slider.value));
        num.addEventListener('keydown', (e) => e.stopPropagation());
        num.addEventListener('change', () => setOpa(num.value));

        dlg.appendChild(pal); // position: fixed — placed from the viewport rect
        const sr = swatch.getBoundingClientRect();
        const pw = pal.offsetWidth || 236, ph = pal.offsetHeight || 190;
        let x = Math.min(sr.left, window.innerWidth - pw - 10);
        let y = sr.bottom + 6;
        if (y + ph > window.innerHeight - 8) y = Math.max(8, sr.top - ph - 6);
        pal.style.left = x + 'px'; pal.style.top = y + 'px';
        setTimeout(() => {
          const outside = (ev) => {
            if (!openPal) { document.removeEventListener('mousedown', outside, true); return; }
            if (!openPal.contains(ev.target) && !swatch.contains(ev.target)) {
              closePal();
              document.removeEventListener('mousedown', outside, true);
            }
          };
          document.addEventListener('mousedown', outside, true);
        }, 0);
      };
      swatch.addEventListener('click', (e) => { e.stopPropagation(); open(); });
    };

    /* ROUND143: TV "Indicator Timeframe" row (first row, like TV). '' =
       chart TF. ROUND144: higher TFs run on HTF buckets; ROUND146: lower
       TFs run on fetched lower history. ROUND145: extracted into
       renderInputsTab so Defaults Reset can rebuild the whole body.
       ROUND226: defaults to the declaration timeframe= (untouched). */
    let tfPick = inst.timeframe || (!inst._tfTouched && inst._declTimeframe) || '';
    let tfSel = null;
    const renderInputsTab = () => {
      U.clear(body);
      for (const k of Object.keys(values)) delete values[k];
      {
        const tfRow = U.el('label', 'pine-inp pine-tf-row', body);
        U.el('span', '', tfRow).textContent = 'Indicator Timeframe';
        tfSel = U.el('select', '', tfRow);
        const addOpt = (v, label) => { const o = U.el('option', '', tfSel); o.value = v; o.textContent = label; };
        addOpt('', 'Chart');
        for (const t of (App.tf || [])) {
          if (t && t.id && t.id !== pane.tf) addOpt(t.id, t.label || t.id);
        }
        tfSel.value = [...tfSel.options].some((o) => o.value === tfPick) ? tfPick : '';
        tfPick = tfSel.value;
        tfSel.addEventListener('change', () => { tfPick = tfSel.value; });
      }
    // group sections, TV order: group name headers, inputs in registration order
    const groups = [];
    const byGroup = {};
    for (const d of defs) {
      const g = d.group || '';
      if (!byGroup[g]) { byGroup[g] = []; groups.push(g); }
      byGroup[g].push(d);
    }

    const buildInput = (container, d) => {
      const row = U.el('label', 'pine-inp', container);
      if (d.title) U.el('span', '', row).textContent = d.title;
      if (d.tooltip) row.title = d.tooltip;
      if (d.kind === 'bool') {
        const inp = U.el('input', '', row);
        inp.type = 'checkbox';
        inp.checked = !!getVal(d);
        inp.addEventListener('change', () => { values[d.id] = inp.checked; });
        values[d.id] = inp.checked;
      } else if (d.kind === 'int' || d.kind === 'float') {
        const inp = U.el('input', '', row);
        inp.type = 'number';
        inp.step = d.kind === 'int' ? '1' : 'any';
        if (d.min != null) inp.min = d.min;
        if (d.max != null) inp.max = d.max;
        inp.value = String(getVal(d));
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        inp.addEventListener('change', () => {
          const v = parseFloat(inp.value);
          values[d.id] = isFinite(v) ? (d.kind === 'int' ? Math.round(v) : v) : d.defval;
        });
        values[d.id] = parseFloat(inp.value);
      } else if (d.kind === 'string' || d.kind === 'textarea') {
        /* ROUND220 (TV parity): input.text_area renders a multiline box, not
           a single-line input (KZP one-per-line lists were unviewable). */
        const isArea = d.kind === 'textarea';
        /* ROUND 76 (BUG): two traps here. (1) options could arrive as a
           Pine array proxy ({__pineArray, items}) with no .length — the
           dialog then misread it as "no options" (BUG-74-E, from the
           user's 786 Zones log). (2) a free-text string was built as a
           <select> and "switched" via `select.type = 'text'` — but
           HTMLSelectElement.type is read-only, so that line THREW and the
           whole dialog failed. Now: read options proxy-safely; a list
           renders a real <select>, free text renders a real text <input>. */
        const raw = d.options;
        const optList = Array.isArray(raw) ? raw
          : (raw && raw.__pineArray && Array.isArray(raw.items)) ? raw.items : [];
        /* ROUND165: an enum-object value (input.string(size.tiny,...) defval)
           must display as its payload, never "[object Object]". */
        const dispVal = (v) => (v && v.__pineEnum && v.payload != null) ? String(v.payload)
          : String(v == null ? '' : v);
        let inp;
        if (isArea) {
          inp = U.el('textarea', 'pine-textarea', row);
          inp.rows = 4;
          inp.spellcheck = false;
        } else if (optList.length) {
          inp = U.el('select', '', row);
          for (const o of optList) {
            const op = U.el('option', '', inp);
            op.value = dispVal(o); op.textContent = dispVal(o);
          }
        } else {
          inp = U.el('input', '', row);
          inp.type = 'text';
          inp.spellcheck = false;
          inp.autocomplete = 'off';
        }
        inp.value = dispVal(getVal(d));
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        inp.addEventListener('change', () => { values[d.id] = inp.value; });
        values[d.id] = inp.value;
      } else if (d.kind === 'enum') {
        /* ROUND154: input.enum dropdown — options are member NAMES, but the
           script value is the member VALUE (number), mapped via d.enumMap. */
        const inp = U.el('select', '', row);
        const names = Array.isArray(d.options) ? d.options : [];
        const map = (d.enumMap && typeof d.enumMap === 'object') ? d.enumMap : {};
        for (const n of names) {
          const op = U.el('option', '', inp);
          op.value = String(n); op.textContent = String(n);
        }
        const cur = getVal(d);
        const curName = names.find((n) => map[n] === cur) || names.find((n) => String(map[n]) === String(cur));
        inp.value = curName != null ? String(curName) : (names[0] != null ? String(names[0]) : '');
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        inp.addEventListener('change', () => {
          values[d.id] = (inp.value in map) ? map[inp.value] : inp.value;
        });
        values[d.id] = (inp.value in map) ? map[inp.value] : inp.value;
      } else if (d.kind === 'color') {
        /* ROUND78: TV-style picker (palette + custom + opacity) replaces the
           native color input that discarded transparency */
        buildColorPicker(row, () => getVal(d), (css) => { values[d.id] = css; });
      } else if (d.kind === 'source') {
        /* ROUND142: TV display labels + the full source set (hlcc4 was
           missing from the hardcoded list). Engine defvals are canonical
           names (see BUILTIN_SOURCES); the dropdown shows TV's labels. */
        const SRC_OPTS = [['open', 'Open'], ['high', 'High'], ['low', 'Low'], ['close', 'Close'],
          ['hl2', '(H + L)/2'], ['hlc3', '(H + L + C)/3'], ['ohlc4', '(O + H + L + C)/4'],
          ['hlcc4', '(H + L + C + C)/4'], ['volume', 'Volume']];
        const inp = U.el('select', '', row);
        for (const [v, label] of SRC_OPTS) {
          const op = U.el('option', '', inp);
          op.value = v; op.textContent = label;
        }
        const cur = String(getVal(d) || 'close');
        inp.value = SRC_OPTS.some(([v]) => v === cur) ? cur : 'close';
        inp.addEventListener('change', () => { values[d.id] = inp.value; });
        values[d.id] = inp.value;
      }
    };
    for (const g of groups) {
      if (g) U.el('div', 'ist-sec', body).textContent = g;
      const defs = byGroup[g];
      for (let i = 0; i < defs.length; i++) {
        const d = defs[i];
        if (d.inline) {
          // consecutive run with the same inline key -> one horizontal row
          let j = i;
          while (j < defs.length && defs[j].inline === d.inline) j++;
          const runRow = U.el('div', 'pine-inline-row', body);
          runRow.dataset.inline = d.inline;
          for (let k = i; k < j; k++) buildInput(runRow, defs[k]);
          i = j - 1;
        } else {
          buildInput(body, d);
        }
      }
    }
    };
    renderInputsTab();

    /* ------------------------------------------------------------------ */
    /* ROUND175 — TV Properties tab (strategies only): the broker-emulator */
    /* settings. Values persist on inst.strategyProps and override the    */
    /* static strategy() literals at rebuild (strategy.js brokerInit).    */
    /* ------------------------------------------------------------------ */
    const numOr = (v, fb) => (typeof v === 'number' && isFinite(v) ? v : fb);
    const freshProps = () => ({
      initial_capital: numOr(inst.strategyProps && inst.strategyProps.initial_capital,
        numOr(stratDefaults.initial_capital, 100000)),
      currency: (inst.strategyProps && inst.strategyProps.currency) || stratDefaults.currency || 'USD',
      default_qty_value: numOr(inst.strategyProps && inst.strategyProps.default_qty_value,
        numOr(stratDefaults.default_qty_value, 1)),
      default_qty_type: (inst.strategyProps && inst.strategyProps.default_qty_type)
        || stratDefaults.default_qty_type || 'fixed',
      pyramiding: Math.max(0, Math.round(numOr(inst.strategyProps && inst.strategyProps.pyramiding,
        numOr(stratDefaults.pyramiding, 0)))), /* ROUND225: TV default 0 */
      commission_value: Math.max(0, numOr(inst.strategyProps && inst.strategyProps.commission_value,
        numOr(stratDefaults.commission_value, 0))),
      commission_type: (inst.strategyProps && inst.strategyProps.commission_type)
        || stratDefaults.commission_type || 'percent',
      /* ROUND213: margin requirements, % of notional (TV Properties). */
      margin_long: Math.max(0, numOr(inst.strategyProps && inst.strategyProps.margin_long,
        numOr(stratDefaults.margin_long, 100))),
      margin_short: Math.max(0, numOr(inst.strategyProps && inst.strategyProps.margin_short,
        numOr(stratDefaults.margin_short, 100))),
      slippage_ticks: Math.max(0, Math.round(numOr(inst.strategyProps && inst.strategyProps.slippage_ticks, 0))),
      /* ROUND192: Bar Magnifier opt-in (dialog wins when set, else the
         declaration literal). */
      use_bar_magnifier: !!((inst.strategyProps && inst.strategyProps.use_bar_magnifier) ||
        stratDefaults.use_bar_magnifier),
      /* ROUND212: process_orders_on_close (same precedence). */
      process_orders_on_close: !!((inst.strategyProps && inst.strategyProps.process_orders_on_close) ||
        stratDefaults.process_orders_on_close),
    });
    let propsVals = (isStratDlg && propsBody) ? freshProps() : null;
    /* ROUND175: Reset shows factory (declaration) values, committed on Ok. */
    const factoryProps = () => ({
      initial_capital: numOr(stratDefaults.initial_capital, 100000),
      currency: stratDefaults.currency || 'USD',
      default_qty_value: numOr(stratDefaults.default_qty_value, 1),
      default_qty_type: stratDefaults.default_qty_type || 'fixed',
      pyramiding: Math.max(0, Math.round(numOr(stratDefaults.pyramiding, 0))), /* ROUND225: TV default 0 */
      commission_value: Math.max(0, numOr(stratDefaults.commission_value, 0)),
      commission_type: stratDefaults.commission_type || 'percent',
      margin_long: Math.max(0, numOr(stratDefaults.margin_long, 100)),
      margin_short: Math.max(0, numOr(stratDefaults.margin_short, 100)),
      slippage_ticks: 0,
      use_bar_magnifier: false,
      process_orders_on_close: false,
    });
    const renderPropsTab = () => {
      if (!propsBody || !propsVals) return;
      U.clear(propsBody);
      const sec = (t) => { U.el('div', 'ist-sec', propsBody).textContent = t; };
      const numRow = (label, key, opt) => {
        const row = U.el('label', 'pine-inp', propsBody);
        U.el('span', '', row).textContent = label;
        const inp = U.el('input', '', row);
        inp.type = 'number';
        inp.step = (opt && opt.step) || 'any';
        if (opt && opt.min != null) inp.min = opt.min;
        inp.value = String(propsVals[key]);
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        inp.addEventListener('change', () => {
          const v = parseFloat(inp.value);
          propsVals[key] = isFinite(v) ? v : propsVals[key];
          if (opt && opt.int) propsVals[key] = Math.max(opt.min || 0, Math.round(propsVals[key]));
        });
      };
      const selRow = (label, key, opts) => {
        const row = U.el('label', 'pine-inp', propsBody);
        U.el('span', '', row).textContent = label;
        const sel = U.el('select', '', row);
        for (const [v, text] of opts) {
          const o = U.el('option', '', sel);
          o.value = v; o.textContent = text;
        }
        sel.value = opts.some(([vv]) => vv === propsVals[key]) ? propsVals[key] : opts[0][0];
        propsVals[key] = sel.value;
        sel.addEventListener('change', () => { propsVals[key] = sel.value; });
      };
      sec('General');
      numRow('Initial capital', 'initial_capital', { min: 1 });
      selRow('Currency', 'currency', [['USD', 'USD'], ['EUR', 'EUR'], ['GBP', 'GBP'], ['JPY', 'JPY'], ['CHF', 'CHF'], ['AUD', 'AUD'], ['CAD', 'CAD']]);
      numRow('Default order size', 'default_qty_value', { min: 0 });
      selRow('Order size unit', 'default_qty_type', [['fixed', 'Contracts'], ['cash', 'Cash'], ['percent', '% of equity']]);
      numRow('Pyramiding', 'pyramiding', { min: 0, step: '1', int: true });
      /* ROUND192: Bar Magnifier (intrabar fills from lower-TF data). */
      {
        const row = U.el('label', 'pine-inp pine-check', propsBody);
        const inp = U.el('input', '', row);
        inp.type = 'checkbox';
        inp.checked = !!propsVals.use_bar_magnifier;
        U.el('span', '', row).textContent = 'Use bar magnifier';
        row.title = 'Fill stop/limit orders against lower-timeframe ranges when available';
        inp.addEventListener('change', () => { propsVals.use_bar_magnifier = inp.checked; });
      }
      sec('Broker emulator');
      numRow('Commission', 'commission_value', { min: 0 });
      selRow('Commission unit', 'commission_type', [['percent', 'Percent'], ['cash_per_contract', 'Cash per contract'], ['cash_per_order', 'Cash per order']]);
      numRow('Slippage (ticks)', 'slippage_ticks', { min: 0, step: '1', int: true });
      /* ROUND213: margin requirements (% of notional per side). */
      numRow('Margin long (%)', 'margin_long', { min: 0 });
      numRow('Margin short (%)', 'margin_short', { min: 0 });
      /* ROUND212: process_orders_on_close (market fills at the bar close). */
      {
        const row = U.el('label', 'pine-inp pine-check', propsBody);
        const inp = U.el('input', '', row);
        inp.type = 'checkbox';
        inp.checked = !!propsVals.process_orders_on_close;
        U.el('span', '', row).textContent = 'Process orders on close';
        row.title = 'Fill market orders at the signal bar close instead of the next bar open';
        inp.addEventListener('change', () => { propsVals.process_orders_on_close = inp.checked; });
      }
    };
    if (isStratDlg && propsBody) renderPropsTab();

    /* ------------------------------------------------------------------ */
    /* ROUND143 — TV Style tab: per-output eye + color + width/style,      */
    /* fills with Color 0/1, OUTPUT VALUES (precision, price-scale labels, */
    /* status-line values) and a Defaults menu. Overrides collect into     */
    /* styleVals and apply on Ok (rebuild); the engine post-pass           */
    /* (applyInstanceStyle) paints them onto every output path.            */
    /* ------------------------------------------------------------------ */
    const styleValsInit = () => {
      const o = Object.assign({ plots: {}, shapes: {}, fills: {}, candles: {}, hlines: {}, objects: {},
        precision: 'default', priceLabels: true, statusValues: true, statusInputs: true },
        JSON.parse(JSON.stringify(inst.style || {})));
      o.plots = o.plots || {};
      o.shapes = o.shapes || {};
      o.fills = o.fills || {};
      return o;
    };
    /* ROUND145: let-bound — Defaults Reset replaces the whole object */
    let styleVals = styleValsInit();
    const rtOut = st.rt ? st.rt.out : null;
    const firstCss = (arr) => {
      for (const c of (arr || [])) {
        if (c && c.css && !(c.a === 0)) { try { return c.css(); } catch (e) { return null; } }
      }
      return null;
    };
    const plotTitleOf = (key) => {
      try {
        const p = rtOut && rtOut.plots.get(key);
        return (p && p.title) || key;
      } catch (e) { return key; }
    };
    const eyeBtn = (row, isOn, onFlip) => {
      const b = U.el('button', 'pine-eye-btn', row);
      b.type = 'button';
      const paintEye = () => { b.innerHTML = icon(isOn() ? 'eye' : 'eyeoff'); b.classList.toggle('off', !isOn()); };
      paintEye();
      b.addEventListener('click', (e) => { e.stopPropagation(); onFlip(); paintEye(); });
      return b;
    };
    const renderStyleTab = () => {
      U.clear(styleBody);
      /* ROUND145: persisted/saved styles may lack sections — normalize */
      for (const k of ['plots', 'shapes', 'fills', 'candles', 'hlines', 'objects']) {
        if (!styleVals[k] || typeof styleVals[k] !== 'object') styleVals[k] = {};
      }
      if (!rtOut) {
        U.el('div', 'pine-style-empty', styleBody).textContent = 'No visual outputs yet — add data first.';
        return;
      }
      const LINE_LIKES = ['line', 'linebr', 'stepline', 'steplinebr', 'stepline_diamond', 'area', 'areabr'];
      for (const key of (rtOut.plotsOrder || [])) {
        const p = rtOut.plots.get(key);
        if (!p || p.display === 'none') continue;
        if (!styleVals.plots[key]) styleVals.plots[key] = {};
        const ov = styleVals.plots[key];
        const row = U.el('div', 'pine-style-row', styleBody);
        eyeBtn(row, () => ov.visible !== false, () => { ov.visible = ov.visible !== false ? false : true; });
        buildColorPicker(row, () => (ov.color || firstCss(p.colors) || '#2962ff'), (css) => { ov.color = css; }, 'pine-swatch-btn pine-sw-sm');
        const nm = U.el('span', 'pine-style-name', row);
        nm.textContent = p.title || key;
        nm.title = key;
        /* ROUND167: TV plot-style menu (Line … Circles). Native select —
           same values as plot.style_*. Changing line↔histogram re-births the
           native series (apply lands pre-syncStructure). */
        {
          const ySel = U.el('select', 'pine-style-sel', row);
          ySel.title = 'Plot style';
          for (const [v, label] of [['line', 'Line'], ['linebr', 'Line with breaks'], ['stepline', 'Step line'], ['steplinebr', 'Step line with breaks'], ['stepline_diamond', 'Step line with diamonds'], ['histogram', 'Histogram'], ['cross', 'Cross'], ['area', 'Area'], ['areabr', 'Area with breaks'], ['columns', 'Columns'], ['circles', 'Circles']]) {
            const o = U.el('option', '', ySel);
            o.value = v; o.textContent = label;
          }
          /* ROUND167: steplinebr = step base + linebr break rule (engine +
             adapter both know it — see PLOT_STYLE_SET). */
          const curStyle = ov.plotstyle || p.style || 'line';
          ySel.value = [...ySel.options].some((o) => o.value === curStyle) ? curStyle : 'line';
          ySel.addEventListener('change', () => {
            ov.plotstyle = (ySel.value === (p.style || 'line')) ? undefined : ySel.value;
            if (ov.plotstyle === undefined) delete ov.plotstyle;
          });
          const plLbl = U.el('label', 'pine-style-pl', row);
          plLbl.title = 'Price line';
          const plInp = U.el('input', '', plLbl);
          plInp.type = 'checkbox';
          plInp.checked = ov.trackprice != null ? !!ov.trackprice : !!p.trackprice;
          const plTx = U.el('span', '', plLbl);
          plTx.textContent = 'Price line';
          plInp.addEventListener('change', () => {
            ov.trackprice = plInp.checked === !!p.trackprice ? undefined : plInp.checked;
            if (ov.trackprice === undefined) delete ov.trackprice;
          });
        }
        if (LINE_LIKES.includes(p.style)) {
          const wSel = U.el('select', 'pine-style-sel', row);
          wSel.title = 'Line width';
          for (let wNum = 1; wNum <= 4; wNum++) {
            const o = U.el('option', '', wSel);
            o.value = String(wNum); o.textContent = String(wNum);
          }
          wSel.value = String(ov.width != null ? ov.width : (p.linewidth > 0 ? p.linewidth : 1));
          wSel.addEventListener('change', () => { ov.width = +wSel.value; });
          const sSel = U.el('select', 'pine-style-sel', row);
          sSel.title = 'Line style';
          for (const [v, label] of [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']]) {
            const o = U.el('option', '', sSel);
            o.value = v; o.textContent = label;
          }
          sSel.value = ov.style || p.linestyle || 'solid';
          sSel.addEventListener('change', () => { ov.style = sSel.value; });
        }
      }
      const SIZE_IDS = ['tiny', 'small', 'normal', 'large', 'huge'];
      for (const [key, sh] of (rtOut.shapes || new Map())) {
        if (!styleVals.shapes[key]) styleVals.shapes[key] = {};
        const ov = styleVals.shapes[key];
        const row = U.el('div', 'pine-style-row', styleBody);
        eyeBtn(row, () => ov.visible !== false, () => { ov.visible = ov.visible !== false ? false : true; });
        buildColorPicker(row, () => (ov.color || firstCss(sh.colors) || '#2962ff'), (css) => { ov.color = css; }, 'pine-swatch-btn pine-sw-sm');
        const nm = U.el('span', 'pine-style-name', row);
        let label = sh.title;
        if (!label) {
          for (const t of (sh.texts || [])) { if (t) { label = String(t); break; } }
        }
        nm.textContent = label || key;
        nm.title = (sh.style || '') + ' · ' + key;
        const glyph = U.el('span', 'pine-style-glyph', row);
        glyph.textContent = sh.style || '';
        const zSel = U.el('select', 'pine-style-sel', row);
        zSel.title = 'Size';
        for (const z of SIZE_IDS) {
          const o = U.el('option', '', zSel);
          o.value = z; o.textContent = z[0].toUpperCase() + z.slice(1);
        }
        zSel.value = SIZE_IDS.includes(ov.size || sh.size) ? (ov.size || sh.size) : 'small';
        zSel.addEventListener('change', () => { ov.size = zSel.value; });
        /* ROUND146: TV location dropdown (plotshape/plotchar only —
           plotarrow has no location param, same as TV). Reinterpreted at
           paint time: bar-anchored modes read the live bar high/low. */
        if (sh.hasLoc) {
          const lSel = U.el('select', 'pine-style-sel', row);
          lSel.title = 'Location';
          for (const [v, label] of [['absolute', 'Absolute'], ['abovebar', 'Above bar'], ['belowbar', 'Below bar'], ['top', 'Top'], ['bottom', 'Bottom']]) {
            const o = U.el('option', '', lSel);
            o.value = v; o.textContent = label;
          }
          const curLoc = ov.loc || sh.loc || 'absolute';
          lSel.value = ['absolute', 'abovebar', 'belowbar', 'top', 'bottom'].includes(curLoc) ? curLoc : 'absolute';
          lSel.addEventListener('change', () => {
            if (lSel.value === (sh.loc || 'absolute')) delete ov.loc;
            else ov.loc = lSel.value;
          });
        }
      }
      (rtOut.fills || []).forEach((f, idx) => {
        if (!styleVals.fills[idx]) styleVals.fills[idx] = {};
        const ov = styleVals.fills[idx];
        const row = U.el('div', 'pine-style-row', styleBody);
        eyeBtn(row, () => ov.visible !== false, () => { ov.visible = ov.visible !== false ? false : true; });
        const distinct = [];
        for (const c of (f.colors || [])) {
          if (!c || !c.css || c.a === 0) continue;
          try {
            const css = c.css();
            if (!distinct.includes(css)) distinct.push(css);
          } catch (e) {}
          if (distinct.length >= 2) break;
        }
        buildColorPicker(row, () => (ov.color0 || distinct[0] || '#2962ff'), (css) => { ov.color0 = css; }, 'pine-swatch-btn pine-sw-sm');
        buildColorPicker(row, () => (ov.color1 || distinct[1] || distinct[0] || '#2962ff'), (css) => { ov.color1 = css; }, 'pine-swatch-btn pine-sw-sm');
        const nm = U.el('span', 'pine-style-name', row);
        nm.textContent = f.title || (plotTitleOf(f.p1) + ' → ' + plotTitleOf(f.p2));
      });
      /* ROUND166 (TV Style-tab sweep): PlotCandle row (eye + up/down/wick/
         border colors) and hline rows (eye + color). The engine records one
         candle descriptor (candleMeta); editable=false outputs get no row,
         like TV. */
      {
        const meta = rtOut.candleMeta;
        if (meta && meta.editable !== false) {
          if (!styleVals.candles) styleVals.candles = {};
          const ov = styleVals.candles;
          const row = U.el('div', 'pine-style-row', styleBody);
          eyeBtn(row, () => ov.visible !== false, () => { ov.visible = ov.visible !== false ? false : true; });
          const firstCol = (pick) => {
            for (const c of (rtOut.candles || [])) {
              if (c && c[pick] && c[pick].css && !(c[pick].a === 0)) { try { return c[pick].css(); } catch (e) { return null; } }
            }
            return null;
          };
          const nm = U.el('span', 'pine-style-name', row);
          nm.textContent = meta.title || 'PlotCandle';
          nm.title = 'plotcandle';
          for (const fld of ['color', 'wickcolor', 'bordercolor']) {
            buildColorPicker(row, () => (ov[fld] || firstCol(fld) || '#2962ff'), (css) => { ov[fld] = css; }, 'pine-swatch-btn pine-sw-sm');
          }
        }
      }
      (rtOut.hlines || []).forEach((h, idx) => {
        if (!styleVals.hlines[idx]) styleVals.hlines[idx] = {};
        const ov = styleVals.hlines[idx];
        const row = U.el('div', 'pine-style-row', styleBody);
        eyeBtn(row, () => ov.visible !== false, () => { ov.visible = ov.visible !== false ? false : true; });
        buildColorPicker(row, () => (ov.color || (h.color && h.color.css ? h.color.css() : null) || '#787B86'), (css) => { ov.color = css; }, 'pine-swatch-btn pine-sw-sm');
        const nm = U.el('span', 'pine-style-name', row);
        nm.textContent = h.title || ('Hline ' + h.price);
        nm.title = String(h.price);
      });
      /* ROUND166: TV GRAPHIC OBJECTS master toggles (all default on) */
      U.el('div', 'ist-sec', styleBody).textContent = 'Graphic objects';
      {
        const mkObjCheck = (label, kind) => {
          const r = U.el('label', 'pine-inp pine-check', styleBody);
          const inp = U.el('input', '', r);
          inp.type = 'checkbox';
          inp.checked = (styleVals.objects && styleVals.objects[kind] === false) ? false : true;
          U.el('span', '', r).textContent = label;
          inp.addEventListener('change', () => {
            if (!styleVals.objects || typeof styleVals.objects !== 'object') styleVals.objects = {};
            styleVals.objects[kind] = inp.checked;
          });
        };
        mkObjCheck('Boxes', 'boxes');
        mkObjCheck('Lines', 'lines');
        mkObjCheck('Pane labels', 'labels');
      }
      /* OUTPUT VALUES (TV footer of the Style tab) */
      U.el('div', 'ist-sec', styleBody).textContent = 'Output values';
      const prRow = U.el('label', 'pine-inp', styleBody);
      U.el('span', '', prRow).textContent = 'Precision';
      const prSel = U.el('select', '', prRow);
      for (const pv of ['default', '0', '1', '2', '3', '4', '5', '6', '7', '8']) {
        const o = U.el('option', '', prSel);
        o.value = pv; o.textContent = pv === 'default' ? 'Default' : pv;
      }
      prSel.value = styleVals.precision != null ? String(styleVals.precision) : 'default';
      prSel.addEventListener('change', () => { styleVals.precision = prSel.value; });
      const mkCheck = (label, get, set) => {
        const r = U.el('label', 'pine-inp pine-check', styleBody);
        const inp = U.el('input', '', r);
        inp.type = 'checkbox';
        inp.checked = !!get();
        U.el('span', '', r).textContent = label;
        inp.addEventListener('change', () => set(inp.checked));
      };
      mkCheck('Labels on price scale', () => styleVals.priceLabels !== false, (v) => { styleVals.priceLabels = v; });
      mkCheck('Values in status line', () => styleVals.statusValues !== false, (v) => { styleVals.statusValues = v; });
      /* ROUND166: TV INPUT VALUES footer */
      U.el('div', 'ist-sec', styleBody).textContent = 'Input values';
      mkCheck('Inputs in status line', () => styleVals.statusInputs !== false, (v) => { styleVals.statusInputs = v; });
    };
    renderStyleTab();
    /* Defaults menu (TV footer, pinned next to Remove so it is clickable
       from every tab): reset + save-as-default */
    {
      const defBtn = dlg.querySelector('.ist-defaults');
      defBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.pine-def-menu').forEach((m) => m.remove());
        const menu = U.el('div', 'pine-def-menu');
        const item = (label, fn) => {
          const b = U.el('button', 'pine-def-item', menu);
          b.type = 'button'; b.textContent = label;
          b.addEventListener('click', (ev) => { ev.stopPropagation(); menu.remove(); fn(); });
        };
        item('Reset to script defaults', () => {
          /* ROUND145 (user report: Reset left edited settings in place) —
             TV resets the WHOLE dialog: style -> saved default if one was
             stored, else factory; inputs -> script defvals (showDefaults);
             visibility -> all on; timeframe -> Chart. Bodies re-render. */
          const saved = loadDefaultStyle(inst.scriptId);
          /* factory-fresh (NOT merged with the instance style) */
          styleVals = saved ? JSON.parse(JSON.stringify(saved)) : { plots: {}, shapes: {}, fills: {}, candles: {}, hlines: {}, objects: {}, precision: 'default', priceLabels: true, statusValues: true, statusInputs: true };
          for (const k of ['plots', 'shapes', 'fills', 'candles', 'hlines', 'objects']) if (!styleVals[k] || typeof styleVals[k] !== 'object') styleVals[k] = {};
          showDefaults = true;
          visVals = {};
          tfPick = '';
          if (tfSel) tfSel.value = '';
          if (isStratDlg && propsBody) { propsVals = factoryProps(); renderPropsTab(); }
          renderInputsTab();
          renderStyleTab();
          renderVisTab();
        });
        item('Save current as default', () => saveDefaultStyle(inst.scriptId, styleVals));
        dlg.appendChild(menu);
        const r = defBtn.getBoundingClientRect();
        menu.style.left = Math.min(r.left, window.innerWidth - 220) + 'px';
        menu.style.top = Math.max(8, r.top - menu.offsetHeight - 6) + 'px';
        setTimeout(() => {
          const outside = (ev) => {
            if (!menu.isConnected) { document.removeEventListener('mousedown', outside, true); return; }
            if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', outside, true); }
          };
          document.addEventListener('mousedown', outside, true);
        }, 0);
      });
    }

    /* ------------------------------------------------------------------ */
    /* ROUND143 - TV Visibility tab: per-interval eyes (chart TFs). Stored */
    /* as falses-only {tfId:false}; missing = shown (tfVisible helper).    */
    /* ROUND145: extracted into renderVisTab so Defaults Reset rebuilds it. */
    /* ------------------------------------------------------------------ */
    let visVals = Object.assign({}, inst.visTF || {});
    const renderVisTab = () => {
      U.clear(visBody);
      {
        let lastGroup = null;
        for (const t of (App.tf || [])) {
          if (!t || !t.id) continue;
          if (t.group !== lastGroup) {
            lastGroup = t.group;
            if (lastGroup) U.el('div', 'ist-sec', visBody).textContent = lastGroup;
          }
          const r = U.el('label', 'pine-inp pine-check', visBody);
          const inp = U.el('input', '', r);
          inp.type = 'checkbox';
          inp.checked = visVals[t.id] !== false;
          U.el('span', '', r).textContent = t.label || t.id;
          inp.addEventListener('change', () => {
            if (inp.checked) delete visVals[t.id];
            else visVals[t.id] = false;
          });
        }
      }
    };
    renderVisTab();
    /* every Pine settings dialog (before the action buttons). The feed     */
    /* offset (measured by the provider, auto-healed) is the default; a     */
    /* numeric override is for the rare feed that mis-measures. The engine  */
    /* shifts script `time` and the adapter shifts drawing x-times with     */
    /* this same value, so session boxes land on the correct wall-clock     */
    /* hour for EVERY broker.                                               */
    /* ------------------------------------------------------------------ */
    const effOff = effServerOffSec(inst);
    const feedOff = (App.feed && App.feed.serverOff) || 0;
    const dlgActions = dlg.querySelector('.dlg-actions');
    const tzSec = U.el('div', 'ist-sec pine-tz-sec', null);
    tzSec.textContent = 'Data Timezone (broker server)';
    const tzRow = U.el('div', 'pine-tz-row', null);
    const tzInfo = U.el('span', 'pine-tz-info', tzRow);
    tzInfo.textContent = 'Feed offset: ' + fmtOff(feedOff) + (feedOff === effOff ? ' (auto)' : ' (overridden)');
    const tzInp = U.el('input', 'pine-tz-inp', tzRow);
    tzInp.type = 'number'; tzInp.step = '0.5'; tzInp.min = '-14'; tzInp.max = '14';
    tzInp.placeholder = 'auto';
    tzInp.title = 'Broker server UTC offset in hours (empty = follow the feed)';
    if (inst.tzOffH != null && inst.tzOffH !== '') tzInp.value = String(inst.tzOffH);
    tzInp.addEventListener('keydown', (e) => e.stopPropagation());
    const tzHint = U.el('div', 'pine-tz-hint', null);
    tzHint.textContent = 'Pine time runs on true UTC; the broker offset above is applied to session math automatically. Override only if your feed reports the wrong offset.';
    const tzSync = () => { tzInfo.textContent = 'Feed offset: ' + fmtOff(feedOff) + (tzInp.value.trim() === '' ? ' (auto)' : ' (overridden)'); };
    tzInp.addEventListener('input', tzSync);
    const tzAnchor = dlgActions || null;
    if (tzAnchor) { dlg.insertBefore(tzSec, tzAnchor); dlg.insertBefore(tzRow, tzAnchor); dlg.insertBefore(tzHint, tzAnchor); }
    else { dlg.appendChild(tzSec); dlg.appendChild(tzRow); dlg.appendChild(tzHint); }

    dlg.querySelector('.ist-ok').addEventListener('click', () => {
      close();
      /* ROUND78 (timezone): persist the override (empty = follow the feed) */
      const tv = tzInp.value.trim();
      inst.tzOffH = (tv === '' || !isFinite(+tv)) ? null : Math.max(-14, Math.min(14, +tv));
      inst.inputs = values;
      /* ROUND175: strategy broker-emulator settings ride alongside inputs */
      if (isStratDlg && propsVals) inst.strategyProps = Object.assign({}, propsVals);
      /* ROUND143: Style tab + Visibility tab + Indicator Timeframe */
      inst.style = styleVals;
      inst.visTF = Object.keys(visVals).length ? visVals : null;
      /* ROUND144: Indicator Timeframe executes for real (HTF buckets) */
      /* ROUND226: mark explicit picks so '' (Chart) beats a declaration. */
      inst.timeframe = tfPick || '';
      inst._tfTouched = true;
      Manager.persistPanes();
      rebuild(pane, inst);
    });
    dlg.querySelector('.ist-remove').addEventListener('click', () => { close(); remove(pane, inst.id); });
    /* reveal only after a fully-built, fully-wired dialog (ROUND 75 BUG) */
    layer.classList.remove('hidden');
  } catch (e) {
    close();
    throw e; // global handler still reports it (toast + Diagnostics panel)
  }
}

/* ------------------------------ pane teardown ------------------------- */

function dropPane(pane) {
  const map = RT.get(pane);
  if (map) {
    for (const [, st] of map) { try { if (st.adapter) st.adapter.detach(); } catch (e) {} }
    RT.delete(pane);
  }
}

/** per-frame canvas repaint hook (manager loop) */
function framePane(pane, force) {
  const map = RT.get(pane);
  if (!map || !map.size) return;
  /* ROUND141: one generation per full paint cycle — the first painter of
     each shared canvas clears it, siblings overpaint (see adapter). */
  pane._pineGen = (pane._pineGen || 0) + 1;
  for (const [, st] of map) { try { if (st.adapter && st.rt) st.adapter.frame(force); } catch (e) {} }
}

/* ROUND140 (user report: lines still float on VERTICAL drags): a vertical
   pan/zoom changes only the price scale — no time-range event fires, so the
   ROUND139 settle never runs and the overlay paints from the persistent
   loop BEFORE LWC's redraw (stale y) for the whole gesture. The manager
   loop calls this while a gesture is active; each adapter's coalesced
   post-LWC paint then converges it the same frame. */
function settlePane(pane) {
  const map = RT.get(pane);
  if (!map || !map.size) return;
  for (const [, st] of map) { try { if (st.adapter && st.rt) st.adapter._settlePaint(); } catch (e) {} }
}

function updateHover(pane, hoverTime) { updateRowValues(pane, hoverTime); }

/* ROUND80 (perf on TF switch): the lower-TF (M1) fetch used to START only
   after the new timeframe's own history had fully arrived (runFull awaits
   ensureM1Cache before the first bar runs) — two serial network round-trips
   per switch. The manager now fires this at the START of loadBars so both
   fetches overlap; the runFull-time call then hits a warm cache. */
async function prefetchM1(pane) {
  if (!pane || !pane.pineScripts || !pane.pineScripts.length) return;
  const needs = pane.pineScripts.some((i) => {
    const sc = PineScriptsStore.get(i.scriptId);
    return !!(sc && sc.source && (sc.source.indexOf('request.security_lower_tf') >= 0 ||
      /* ROUND192: warm the M1 cache early for magnifier strategies too. */
      sc.source.indexOf('use_bar_magnifier') >= 0));
  });
  if (needs) await ensureM1Cache(pane, false);
}

const PineUI = {
  add, remove, recomputePine, rebuild, onTickPane, dropPane, framePane, settlePane, updateHover,
  toggleVisible, openSettingsDialog, prefetchM1,
  /** diagnostics/tests: read per-pane instance states without touching them */
  debug(pane) {
    const map = RT.get(pane);
    if (!map) return [];
    return Array.from(map.values()).map((st) => ({
      status: st.status,
      errors: st.errors,
      rt: st.rt || null, /* ROUND77 probe: live runtime for diagnostics */
      adapter: st.adapter || null, /* ROUND87 probe: clamp/_xOf/canvas access for the drawing tests */
      inputDefs: st.inputDefs || null, /* ROUND87: settings ids for test overrides */
      boxes: st.rt ? st.rt.store.count('box') : 0,
      lines: st.rt ? st.rt.store.count('line') : 0,
      labels: st.rt ? st.rt.store.count('label') : 0,
      plots: st.rt ? st.rt.out.plots.size : 0,
      bars: st.rt ? st.rt.totalBars : 0,
      /* ROUND78 perf/timezone observability */
      lastRunMs: st.lastRunMs != null ? st.lastRunMs : -1,
      memoHits: st.rt ? (st.rt._memoHits || 0) : 0,
      serverOffSec: st.rt && st.rt.env ? (st.rt.env.serverOffSec || 0) : null,
      intrabars: st.rt && st.rt.env.intrabars ? st.rt.env.intrabars.filter(Boolean).length : 0,
      intrabarBars: st.rt && st.rt.env.intrabars ? st.rt.env.intrabars.reduce((a, b) => a + (b ? b.length : 0), 0) : 0,
      zoneFormed: (function () {
        if (!st.rt) return -1;
        const rec = st.rt.globals.get('zoneFormed');
        return rec && rec.value && rec.value.items ? rec.value.items.filter((v) => v === true).length : -1;
      })(),
      gced: st.rt ? st.rt.store.gced : 0,
      adds: st.rt ? st.rt.store.adds : null,
      xsymPairs: st.lastXSymPairs || null, /* ROUND210 probe: static prefetch pairs */
    }));
  },
  /** snapshot for persistence (Manager.persistPanes) */
  serialize(pane) {
    return (pane.pineScripts || []).map((i) => ({
      scriptId: i.scriptId,
      inputs: (i.inputs && typeof i.inputs === 'object') ? JSON.parse(JSON.stringify(i.inputs)) : {},
      visible: i.visible !== false,
      /* ROUND78 (timezone): per-instance broker-offset override (hours) */
      ...(i.tzOffH != null && i.tzOffH !== '' ? { tzOffH: Number(i.tzOffH) } : {}),
      /* ROUND 74: sub-pane height share (pane splitter drag) persists too */
      ...(Number(i.frac) > 0 ? { frac: Number(i.frac) } : {}),
      /* ROUND143: Style-tab overrides + TF visibility + indicator timeframe */
      ...(i.style && typeof i.style === 'object' && Object.keys(i.style).length ? { style: JSON.parse(JSON.stringify(i.style)) } : {}),
      ...(i.visTF && typeof i.visTF === 'object' && Object.keys(i.visTF).length ? { visTF: Object.assign({}, i.visTF) } : {}),
      ...(i.timeframe ? { timeframe: String(i.timeframe) } : {}),
    }));
  },
  /** restore from a persisted pane record */
  restoreInto(pane, recs) {
    if (!Array.isArray(recs)) return;
    const store = PineScriptsStore;
    pane.pineScripts = recs
      .filter((r) => r && r.scriptId && store.get(r.scriptId))
      .map((r, k) => ({ id: Date.now() + k + Math.floor(Math.random() * 999), scriptId: String(r.scriptId),
        inputs: (r.inputs && typeof r.inputs === 'object') ? r.inputs : {}, visible: r.visible !== false,
        /* ROUND78 (timezone): restored broker-offset override */
        ...(r.tzOffH != null && isFinite(Number(r.tzOffH)) ? { tzOffH: Number(r.tzOffH) } : {}),
        /* ROUND 74: restored sub-pane height share */
        ...(Number(r.frac) > 0 ? { frac: Number(r.frac) } : {}),
        /* ROUND143: restored style overrides + visibility + timeframe */
        ...(r.style && typeof r.style === 'object' ? { style: JSON.parse(JSON.stringify(r.style)) } : {}),
        ...(r.visTF && typeof r.visTF === 'object' ? { visTF: Object.assign({}, r.visTF) } : {}),
        ...(r.timeframe ? { timeframe: String(r.timeframe) } : {}),
      }));
  },

  /* ------- test/debug facade (round133 e2e): introspect the RT map ------- */
  debugRtDump() {
    const out = { panes: 0, insts: 0, withRt: 0, boxes: 0, lines: 0, labels: 0, errors: [] };
    for (const [pane, map] of RT) {
      out.panes++;
      for (const [instId, st] of map) {
        out.insts++;
        if (st.rt) {
          out.withRt++;
          try {
            out.boxes += st.rt.store.box.size; out.lines += st.rt.store.line.size;
            out.labels += st.rt.store.label.size;
            if (st.rt.store.errors && st.rt.store.errors.length) out.errors.push(...st.rt.store.errors.slice(0, 3));
          } catch (e) { out.errors.push(String(e).slice(0, 120)); }
        } else if (st.errors && st.errors.length) out.errors.push(...st.errors.slice(0, 3));
      }
    }
    return out;
  },
  /* ROUND173 (phase 2c: Strategy Tester panel): serializable backtest
     report for one instance — stats (brokerStats) + trades with wall times
     + open position. Times come from the pane bars (seconds). */
  strategyReport(pane, instId) {
    const st = state(pane, instId);
    if (!st || !st.rt || !st.rt.broker) return null;
    const b = st.rt.broker;
    const bars = pane.bars || [];
    const t = (i) => (bars[i] && bars[i].time != null ? bars[i].time : null);
    /* ROUND175: header context — backtest span + capital/currency, like the
       TV tester toolbar (date range + capital picker readout). */
    const n = bars.length;
    /* ROUND176: performance series for the tester chart — per-bar equity
       (capital + realized + open, from the broker tape) plus the TV
       buy&hold baseline (capital deployed at the first close). Capped at
       300 points so the panel never ships ten thousand DOM nodes. */
    let perf = null;
    try {
      const cap = b.cfg.capital || 0;
      const c0 = (n && bars[0] && typeof bars[0].close === 'number' && isFinite(bars[0].close)) ? bars[0].close : NaN;
      const eqRows = [], bhRows = [];
      for (let i = 0; i < n; i++) {
        const tm = bars[i] && bars[i].time;
        if (tm == null) continue;
        const e = b.equity ? b.equity[i] : NaN;
        if (typeof e === 'number' && isFinite(e)) eqRows.push({ t: tm, v: e });
        const c = bars[i] && bars[i].close;
        if (isFinite(c0) && c0 !== 0 && typeof c === 'number' && isFinite(c)) {
          bhRows.push({ t: tm, v: cap * c / c0 });
        }
      }
      if (eqRows.length > 1) perf = { capital: cap, equity: downsample(eqRows, 300), buyHold: downsample(bhRows, 300) };
    } catch (e) { perf = null; }
    /* ROUND180: position-sign strip (TV bottom long/short bar) — strided
       sample of the broker qty tape, ≤300 segments. */
    let posBar = null;
    try {
      const qt = (b.qtyTape || []);
      if (n > 1 && qt.length) {
        const stride = Math.max(1, Math.ceil(n / 300));
        const rows = [];
        for (let i = 0; i < n; i += stride) {
          if (bars[i] && bars[i].time != null) {
            const q = qt[i] || 0;
            rows.push({ t: bars[i].time, s: q > 0 ? 1 : q < 0 ? -1 : 0 });
          }
        }
        if (rows.length > 1) posBar = rows;
      }
    } catch (e) { posBar = null; }
    /* ROUND194 (Performance Summary): live open P&L (last close vs avg) and
       max held contracts per side (from the signed qty tape magnitudes). */
    let openProfit = 0, maxLong = 0, maxShort = 0;
    try {
      const qt = (b.qtyTape || []);
      for (const q of qt) {
        if (typeof q !== 'number' || !isFinite(q)) continue;
        if (q > maxLong) maxLong = q;
        if (-q > maxShort) maxShort = -q;
      }
      const last = n ? bars[n - 1] : null;
      const lc = last && last.close;
      if (b.qty !== 0 && typeof lc === 'number' && isFinite(lc)) openProfit = (lc - b.avg) * b.qty;
    } catch (e) { openProfit = 0; }
    return {
      title: (st.rt.meta && st.rt.meta.title) || 'Strategy',
      status: st.status,
      errors: (st.errors || []).slice(0, 1),
      stats: brokerStats(b),
      position: { qty: b.qty, avg: b.avg, open: b.entries.length, pending: (b.pending || []).length },
      openProfit, maxLong, maxShort,
      marginCalls: b.marginCalls || 0, // ROUND213: maintenance count for the summary row
      initialCapital: b.cfg.capital,
      currency: b.cfg.currency || 'USD',
      marginLong: b.cfg.marginLong != null ? b.cfg.marginLong : 100, // ROUND213
      marginShort: b.cfg.marginShort != null ? b.cfg.marginShort : 100, // ROUND213
      marginCalls: b.marginCalls || 0, // ROUND213: live count for the summary row
      barCount: n,
      fromTime: n ? t(0) : null,
      toTime: n ? t(n - 1) : null,
      perf,
      posBar,
      trades: (b.trades || []).map((tr, k) => Object.assign({ n: k + 1 }, tr, {
        entryTime: t(tr.entryBar), exitTime: t(tr.exitBar),
      })),
    };
  },
  /* ROUND173 (phase 2c: Strategy Tester panel): enumerate strategy
     instances across panes for the instance picker. */
  strategyInstances() {
    const out = [];
    for (const [pane, map] of RT) {
      for (const [instId, st] of map) {
        if (st && st.rt && st.rt.meta && st.rt.meta.isStrategy) {
          out.push({ pane, instId, title: st.rt.meta.title || 'Strategy', status: st.status });
        }
      }
    }
    return out;
  },
  /* ROUND184: chart trade markers for every ok strategy on the pane
     (TV entry/exit flags). The dock checkbox flips stratMarksOn; removals
     clean up by construction (dead instances contribute nothing). */
  strategyMarkers(pane) {
    if (!stratMarksOn) return [];
    const out = [];
    try {
      const bars = (pane && pane.bars) || [];
      if (!bars.length) return out;
      const timeOf = (i) => (typeof i === 'number' && bars[i] && bars[i].time != null) ? bars[i].time : null;
      const map = RT.get(pane);
      for (const [, st] of (map || new Map())) {
        if (!st || !st.rt || !st.rt.meta || !st.rt.meta.isStrategy) continue;
        if (st.status !== 'ok' || !st.rt.broker) continue;
        out.push(...tradeMarkers(st.rt.broker.trades || [], timeOf));
      }
    } catch (e) {}
    out.sort((a, b) => a.time - b.time);
    return out;
  },
  setStratMarks(on) { stratMarksOn = on !== false; },
  stratMarksOn() { return stratMarksOn; },
  initMarkers,
  /* ROUND193 (Pine Logs viewer): log.info/warning/error entries from every
     live instance — script title + wall time + level + message, oldest
     first, capped. Feeds the Diagnostics "Pine Logs" section. */
  pineLogs(maxN) {
    const out = [];
    try {
      for (const [pane, map] of RT) {
        const bars = (pane && pane.bars) || [];
        for (const [, st] of map) {
          if (!st || !st.rt || !st.rt.out || !st.rt.out.pineLogs) continue;
          const title = (st.rt.meta && st.rt.meta.title) || (st.script && st.script.name) || 'Pine Script';
          for (const l of st.rt.out.pineLogs) {
            const bt = bars[l.bar] && bars[l.bar].time != null ? bars[l.bar].time : null;
            out.push({ script: title, level: l.level, msg: l.msg, bar: l.bar, t: bt });
          }
        }
      }
    } catch (e) {}
    out.sort((a, b) => (a.t || 0) - (b.t || 0));
    const n = Math.max(1, Math.min(500, Math.floor(maxN) || 200));
    return out.slice(-n);
  },
};

/* ROUND184: strategy trade markers ride the Manager marker funnel
   (trade/dock.js pattern). Registration is LAZY via PineUI.initMarkers()
   (called from Tester.init at boot) — manager.js <-> pine-ui.js form an
   import cycle, so touching Manager at module top-level throws a TDZ
   ReferenceError and the flags silently never showed (user report). */
let stratMarksOn = true;
function initMarkers() {
  try {
    if (Manager) Manager.strategyMarkers = (pane) => PineUI.strategyMarkers(pane);
  } catch (e) {}
}

export { PineUI };
