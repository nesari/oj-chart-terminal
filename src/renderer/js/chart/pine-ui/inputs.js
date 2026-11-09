/**
 * Pine instance manager — inputs concern.
 *
 * Moved verbatim out of chart/pine-ui.js in F4.3 (no logic changes).
 *
 * @module chart/pine-ui/inputs
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
 *   objects: { boxes?: bool, lines?: bool, labels?: bool, polylines?: bool, linefills?: bool },
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
  try { localStorage.setItem(styleDefKey(scriptId), JSON.stringify(style || {})); } catch (e) { Log.warn('pine', 'default style save failed', e) }
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

export { PINE_NAMED_MINI, parseColorValue, rgbaStr, hexStr, effServerOffSec, tfVisible, PLOT_STYLE_SET, applyInstanceStyle, styleDefKey, loadDefaultStyle, saveDefaultStyle, XSYM_LAST, _xsymHooked, hookXSymTicks, refreshXSymTicks, tfIdForSec, fetchXSym, scanXSymPairs };
