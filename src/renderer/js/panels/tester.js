/**
 * Strategy Tester panel (round 173, phase 2c): backtest report for Pine
 * strategy scripts — summary stats, open position, trade list. Data comes
 * from PineUI.strategyReport (engine broker state, no recomputation here).
 * Right-rail tab wiring follows the diagnostics panel pattern.
 *
 * @module panels/tester
 */

import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { PineUI } from '../chart/pine-ui.js';
import { tradeGroups, tradesCsv, filterReport, paginate, excursionSpikes, runupDrawdown, tradesAnalysis, perfSummary } from '../../../core/pine/stdlib/strategy.js';
import { GoToDate } from '../panels/gotodate.js';

const Tester = {};

/* ROUND177: groups-mode toggle state (By signals | By side), kept at module
   level so the toggle re-renders without a full panel refresh. */
let groupsMode = 'signals';
let groupsRep = null;

/* ROUND179: sticky-toolbar range filter — {from, to} seconds (either may be
   null) applied report-side on every render; null = full loaded range. */
let rangeSel = null;
/* Last rendered instance, so the dock toolbar can rebuild it (capital edit). */
let curSel = null;
/* ROUND180: trade-list pager state (100/page, newest first). */
let tradePage = 0;
let lastTradeKey = '';

function fmtT(sec) {
  if (sec == null) return '—';
  try {
    const d = new Date(sec * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  } catch (e) { return '—'; }
}

/* ROUND181: TV tooltip date — "Wed, Sep 30, 2026, 23:53". */
function fmtTip(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  try {
    const d = new Date(sec * 1000);
    const p = (n) => String(n).padStart(2, '0');
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return DOW[d.getDay()] + ', ' + M[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ', ' + p(d.getHours()) + ':' + p(d.getMinutes());
  } catch (e) { return '—'; }
}

/* ROUND181: newest trade open at tt (entry <= tt <= exit), or null. */
function activeTrade(trades, tt) {
  for (let i = (trades || []).length - 1; i >= 0; i--) {
    const tr = trades[i];
    if (tr && tr.entryTime != null && tr.entryTime <= tt && (tr.exitTime == null || tt <= tr.exitTime)) return tr;
  }
  return null;
}

function fmtD(sec) {
  if (sec == null) return '—';
  try {
    const d = new Date(sec * 1000);
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return M[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  } catch (e) { return '—'; }
}

/* ROUND175: money follows the TV tester — K-suffixed thousands, full dust
   precision below one cent (a 1-contract forex fill nets ~$0.005, which
   "0.00" used to hide and looked like a zero-P&L bug). */
function fmtMoney(v, cur) {
  if (v == null || (typeof v === 'number' && !isFinite(v))) return '—';
  if (typeof v !== 'number') return String(v);
  const a = Math.abs(v);
  const suf = cur ? ' ' + cur : '';
  if (a !== 0 && a < 0.01) return v.toFixed(5) + suf;
  if (a >= 10000) return (Math.round(v / 100) / 10) + 'K' + suf;
  return (Math.round(v * 100) / 100).toFixed(2) + suf;
}

function fmtN(v, digits) {
  if (v == null || (typeof v === 'number' && !isFinite(v))) return '—';
  if (typeof v !== 'number') return String(v);
  if (!isFinite(digits)) return String(Math.round(v * 100) / 100);
  return v.toFixed(digits);
}

function statRow(grid, label, value, cls) {
  const r = U.el('div', 'tst-stat', grid);
  const k = U.el('span', 'tst-k', r);
  k.textContent = label;
  const v = U.el('span', 'tst-v' + (cls ? ' ' + cls : ''), r);
  v.textContent = value;
}

/* ROUND194: "Performance summary" — TV's All/Long/Short table between Key
   stats and the chart. Trade-based rows split per side; equity-shared rows
   (run-up/drawdown/B&H/fees/open/max-held) are All-only. Fees and max-held
   are range-ambiguous, so a dock-filtered report shows '—' there
   (filterReport rule); Open PL / Open Trades are live state and always show.
   Grid divs + classes only (round-81 CSP); data-pk pins rows for E2E. */
function renderPerfSum(box, rep) {
  U.clear(box);
  const cur = rep.currency || 'USD';
  let S = null;
  try {
    S = perfSummary(rep.trades || [], {
      capital: rep.initialCapital || 0,
      equity: ((rep.perf && rep.perf.equity) || []).map((p) => p.v),
      buyHold: (rep.perf && rep.perf.buyHold) || [],
      fees: rep.ranged ? undefined : ((rep.stats || {}).fees),
      openPL: rep.openProfit,
      openTrades: (rep.position && rep.position.open) || 0,
      maxLong: rep.ranged ? undefined : rep.maxLong,
      maxShort: rep.ranged ? undefined : rep.maxShort,
      marginCalls: rep.marginCalls, // ROUND213: live count (row shows — when ranged)
    });
  } catch (e) { S = null; }
  if (!S) return;
  const head = U.el('div', 'tst-sec-h', box);
  head.textContent = 'Performance summary';
  const pctS = (v) => ((v >= 0 ? '+' : '') + (Math.round(v * 100) / 100).toFixed(2) + '%');
  const M = (x) => ((typeof x === 'number' && isFinite(x)) ? fmtMoney(x, cur) : '—');
  const MC = (x) => ((!isFinite(x)) ? '' : (x >= 0 ? ' tst-pos' : ' tst-neg'));
  const MP = (x, p) => ((!isFinite(x)) ? '—' : (fmtMoney(x, cur) + ' ' + pctS(isFinite(p) ? p : 0)));
  const PF = (x) => (x === Infinity ? '∞' : fmtN(x, 3));
  const N3 = (x) => (isFinite(x) ? fmtN(x, 3) : '—');
  const PC = (side, x) => ((side.n === 0 || !isFinite(x)) ? '—' : ((Math.round(x * 100) / 100).toFixed(2) + '%'));
  const BR = (side, x) => ((side.n === 0 || !isFinite(x)) ? '—' : ((Math.round(x * 100) / 100).toFixed(2)));
  const Q = (x) => ((typeof x === 'number' && isFinite(x)) ? fmtN(x, 4) : '—');
  const has = (side) => side.n > 0;
  const sh = S.shared || {};
  const openN = (rep.position && rep.position.open) || 0;
  const rows = [
    ['net', 'Net Profit', MP(S.all.net, S.all.netPct), MC(S.all.net), has(S.long) ? MP(S.long.net, S.long.netPct) : '—', MC(S.long.net), has(S.short) ? MP(S.short.net, S.short.netPct) : '—', MC(S.short.net)],
    ['grossp', 'Gross Profit', M(S.all.grossP), '', M(S.long.grossP), '', M(S.short.grossP), ''],
    ['grossl', 'Gross Loss', M(S.all.grossL), '', M(S.long.grossL), '', M(S.short.grossL), ''],
    ['runup', 'Max Run-up', MP(sh.maxRU, sh.maxRUPct), MC(sh.maxRU), '—', '', '—', ''],
    ['drawdown', 'Max Drawdown', MP(sh.maxDD, sh.maxDDPct), (isFinite(sh.maxDD) && sh.maxDD > 0 ? ' tst-neg' : ''), '—', '', '—', ''],
    ['bh', 'Buy & Hold Return', MP(sh.bhNet, sh.bhPct), MC(sh.bhNet), '—', '', '—', ''],
    ['sharpe', 'Sharpe Ratio', N3(S.all.sharpe), '', N3(S.long.sharpe), '', N3(S.short.sharpe), ''],
    ['sortino', 'Sortino Ratio', N3(S.all.sortino), '', N3(S.long.sortino), '', N3(S.short.sortino), ''],
    ['pf', 'Profit Factor', PF(S.all.profitFactor), '', has(S.long) ? PF(S.long.profitFactor) : '—', '', has(S.short) ? PF(S.short.profitFactor) : '—', ''],
    ['maxc', 'Max Contracts Held', (rep.ranged ? '—' : Q(Math.max(sh.maxLong || 0, sh.maxShort || 0))), '', (rep.ranged ? '—' : Q(sh.maxLong)), '', (rep.ranged ? '—' : Q(sh.maxShort)), ''],
    ['openpl', 'Open PL', M(rep.openProfit), MC(rep.openProfit), '—', '', '—', ''],
    ['fees', 'Commission Paid', (sh.fees == null ? '—' : M(sh.fees)), '', '—', '', '—', ''],
    ['closed', 'Total Closed Trades', String(S.all.n), '', String(S.long.n), '', String(S.short.n), ''],
    ['opent', 'Total Open Trades', String(openN), '', '—', '', '—', ''],
    ['wins', 'Number Winning Trades', String(S.all.wins), '', String(S.long.wins), '', String(S.short.wins), ''],
    ['losses', 'Number Losing Trades', String(S.all.losses), '', String(S.long.losses), '', String(S.short.losses), ''],
    ['winpct', 'Percent Profitable', PC(S.all, S.all.winPct), '', PC(S.long, S.long.winPct), '', PC(S.short, S.short.winPct), ''],
    ['avg', 'Avg Trade', has(S.all) ? MP(S.all.avg, S.all.avgPct) : '—', MC(S.all.avg), has(S.long) ? MP(S.long.avg, S.long.avgPct) : '—', MC(S.long.avg), has(S.short) ? MP(S.short.avg, S.short.avgPct) : '—', MC(S.short.avg)],
    ['avgw', 'Avg Winning Trade', has(S.all) ? M(S.all.avgW) : '—', '', has(S.long) ? M(S.long.avgW) : '—', '', has(S.short) ? M(S.short.avgW) : '—', ''],
    ['avgl', 'Avg Losing Trade', has(S.all) ? M(S.all.avgL) : '—', '', has(S.long) ? M(S.long.avgL) : '—', '', has(S.short) ? M(S.short.avgL) : '—', ''],
    ['ratio', 'Ratio Avg Win / Avg Loss', has(S.all) ? PF(S.all.ratio) : '—', '', has(S.long) ? PF(S.long.ratio) : '—', '', has(S.short) ? PF(S.short.ratio) : '—', ''],
    ['largestw', 'Largest Winning Trade', has(S.all) ? MP(S.all.largestW, S.all.largestWPct) : '—', MC(S.all.largestW), has(S.long) ? MP(S.long.largestW, S.long.largestWPct) : '—', MC(S.long.largestW), has(S.short) ? MP(S.short.largestW, S.short.largestWPct) : '—', MC(S.short.largestW)],
    ['largestl', 'Largest Losing Trade', has(S.all) ? MP(S.all.largestL, S.all.largestLPct) : '—', MC(S.all.largestL), has(S.long) ? MP(S.long.largestL, S.long.largestLPct) : '—', MC(S.long.largestL), has(S.short) ? MP(S.short.largestL, S.short.largestLPct) : '—', MC(S.short.largestL)],
    ['bars', 'Avg # Bars in Trades', BR(S.all, S.all.avgBars), '', BR(S.long, S.long.avgBars), '', BR(S.short, S.short.avgBars), ''],
    ['barsw', 'Avg # Bars in Winning Trades', BR(S.all, S.all.avgWBars), '', BR(S.long, S.long.avgWBars), '', BR(S.short, S.short.avgWBars), ''],
    ['barsl', 'Avg # Bars in Losing Trades', BR(S.all, S.all.avgLBars), '', BR(S.long, S.long.avgLBars), '', BR(S.short, S.short.avgLBars), ''],
    ['margin', 'Margin Calls', (rep.ranged ? '—' : String(sh.marginCalls != null ? sh.marginCalls : 0)), '', '—', '', '—', ''],
  ];
  const hr = U.el('div', 'tst-prow tst-ph', box);
  for (const h of ['', 'All', 'Long', 'Short']) {
    const c = U.el('span', h ? 'tst-pv' : 'tst-pl', hr);
    c.textContent = h;
  }
  for (const [key, label, a, ac, l, lc, s, sc] of rows) {
    const r = U.el('div', 'tst-prow', box);
    r.dataset.pk = key;
    const nm = U.el('span', 'tst-pl', r);
    nm.textContent = label;
    const cells = [[a, ac], [l, lc], [s, sc]];
    for (const [txt, cls] of cells) {
      const c = U.el('span', 'tst-pv' + (cls || ''), r);
      c.textContent = txt;
    }
  }
}

/* ROUND176: tester Performance chart — equity vs buy&hold as one SVG
   (pure DOM + geometry attributes; colors ride CSS classes, never inline
   style — round-81 CSP). */
/* ROUND176: tester Performance chart — equity vs buy&hold as one SVG
   (pure DOM + geometry attributes; colors ride CSS classes, never inline
   style — round-81 CSP).
   ROUND180: TV-parity redesign. The old ABSOLUTE scale buried the equity
   wiggle under the buy&hold swing (user screenshot: flat blue under a wild
   gray), so both series are now RELATIVE PnL (minus capital) on one
   zero-centered scale. Legend chips toggle series, hover shows the TV
   tooltip, and the bottom strip paints position sign per bar. */
let perfShow = { pnl: true, bh: true, exc: true, rd: false };
/* ROUND182: x-zoom window as fractions of the full span (wheel to zoom,
   double-click to reset). Reset whenever a new report object arrives. */
let perfZoom = null;
let perfZoomRep = null;
let clipSeq = 0;
function renderPerf(box, rep) {
  U.clear(box);
  const perf = rep.perf || {};
  const cur = rep.currency || 'USD';
  const cap = (typeof perf.capital === 'number' && isFinite(perf.capital)) ? perf.capital : 0;
  const rel = (rows) => ((rows || []).map((p) => ({ t: p.t, v: p.v - cap })));
  const eq = rel(perf.equity), bh = rel(perf.buyHold);
  const pos = (rep.posBar || []).slice();
  /* ROUND182: per-trade excursion spikes (TV green/red histogram) + the
     run-up/drawdown pair, both toggleable legend rows like TV. */
  let spikes = [];
  try { spikes = excursionSpikes(rep.trades || []); } catch (e) { spikes = []; }
  if (spikes.length > 400) {
    const st = Math.ceil(spikes.length / 400);
    spikes = spikes.filter((_, i) => i % st === 0);
  }
  let rd = [];
  try { rd = runupDrawdown(eq); } catch (e) { rd = []; }
  if (perfZoomRep !== rep) { perfZoom = null; perfZoomRep = rep; }
  if (eq.length < 2) {
    const e = U.el('div', 'tst-empty', box);
    e.textContent = 'No performance data yet.';
    return;
  }
  const NS = 'http://www.w3.org/2000/svg';
  const head = U.el('div', 'tst-sec-h', box);
  head.textContent = 'Performance';
  const lg = U.el('div', 'tst-legend', box);
  const chip = (key, cls, text, on) => {
    const s = U.el('button', 'tst-chip' + (on ? ' on' : ' off'), lg);
    s.type = 'button';
    U.el('i', cls, s);
    const tx = U.el('span', '', s);
    tx.textContent = text;
    s.addEventListener('click', () => { perfShow[key] = !perfShow[key]; renderPerf(box, rep); });
  };
  chip('pnl', 'tst-sw-eq', 'Cumulative PnL', perfShow.pnl);
  chip('bh', 'tst-sw-bh', 'Buy and hold', perfShow.bh);
  chip('exc', 'tst-sw-exc', 'Trades excursions', perfShow.exc);
  chip('rd', 'tst-sw-rd', 'Run-ups and drawdowns', perfShow.rd);
  const vis = [];
  if (perfShow.pnl) vis.push(eq);
  if (perfShow.bh && bh.length > 1) vis.push(bh);
  const spikeVals = [];
  if (perfShow.exc) for (const s of spikes) { spikeVals.push(s.fav); spikeVals.push(s.adv); }
  const rdRu = [], rdDd = [];
  if (perfShow.rd) for (const p of rd) { rdRu.push(p.ru); rdDd.push(p.dd); }
  let mn = Infinity, mx = -Infinity;
  for (const rows of vis) for (const p of rows) {
    if (p.v < mn) mn = p.v;
    if (p.v > mx) mx = p.v;
  }
  for (const v of spikeVals.concat(rdRu, rdDd)) {
    if (typeof v === 'number' && isFinite(v)) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  if (!vis.length || !isFinite(mn) || !isFinite(mx)) {
    const e = U.el('div', 'tst-empty', box);
    e.textContent = 'Toggle a series to show it.';
    return;
  }
  if (mx - mn <= 0) { mx = mn + 1; }
  const pad = (mx - mn) * 0.06;
  mn -= pad; mx += pad;
  const W = 1200, H = 300, PT = 10, PR = 64, PL = 8, AXH = 24;
  const plotY1 = H - AXH;
  const t0 = eq[0].t, t1 = eq[eq.length - 1].t;
  /* ROUND182: zoom window (fractions); everything maps through it. */
  const za = perfZoom ? perfZoom.a : 0, zb = perfZoom ? perfZoom.b : 1;
  const zw0 = t0 + (t1 - t0) * za, zw1 = t0 + (t1 - t0) * zb;
  const X = (t) => PL + ((t - zw0) / Math.max(1e-9, zw1 - zw0)) * (W - PL - PR);
  const Y = (v) => PT + (1 - (v - mn) / (mx - mn)) * (plotY1 - PT);
  const inW = (t) => t >= zw0 && t <= zw1;
  const wrap = U.el('div', 'tst-perfwrap', box);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('class', 'tst-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('data-zw', (Math.round(za * 1000) / 1000) + ',' + (Math.round(zb * 1000) / 1000));
  /* clip the series group to the plot area so zoomed-out tails never spill */
  const cpId = 'tst-cp-' + (++clipSeq);
  const defs = document.createElementNS(NS, 'defs');
  const cp = document.createElementNS(NS, 'clipPath');
  cp.setAttribute('id', cpId);
  const cpR = document.createElementNS(NS, 'rect');
  cpR.setAttribute('x', String(PL));
  cpR.setAttribute('y', String(PT));
  cpR.setAttribute('width', String(W - PL - PR));
  cpR.setAttribute('height', String(plotY1 - PT));
  cp.appendChild(cpR);
  defs.appendChild(cp);
  svg.appendChild(defs);
  const series = document.createElementNS(NS, 'g');
  series.setAttribute('clip-path', 'url(#' + cpId + ')');
  svg.appendChild(series);
  /* gridlines + right axis (max / 0 / min) */
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const gy = PT + f * (plotY1 - PT);
    const gl = document.createElementNS(NS, 'line');
    gl.setAttribute('class', 'tst-grid');
    gl.setAttribute('x1', String(PL));
    gl.setAttribute('x2', String(W - PR));
    gl.setAttribute('y1', String(Math.round(gy * 10) / 10));
    gl.setAttribute('y2', String(Math.round(gy * 10) / 10));
    svg.appendChild(gl);
  }
  /* ROUND180: the zero line is drawn explicitly (not left to grid chance). */
  if (mn < 0 && mx > 0) {
    const zl = document.createElementNS(NS, 'line');
    zl.setAttribute('class', 'tst-zero');
    zl.setAttribute('x1', String(PL));
    zl.setAttribute('x2', String(W - PR));
    zl.setAttribute('y1', String(Math.round(Y(0) * 10) / 10));
    zl.setAttribute('y2', String(Math.round(Y(0) * 10) / 10));
    svg.appendChild(zl);
  }
  const ax = (vv, yy) => {
    const tx = document.createElementNS(NS, 'text');
    tx.setAttribute('class', 'tst-ax');
    tx.setAttribute('x', String(W - PR + 5));
    tx.setAttribute('y', String(Math.round(yy * 10) / 10));
    tx.textContent = fmtMoney(vv, null);
    svg.appendChild(tx);
  };
  ax(mx - pad, PT + 8);
  ax(0, Math.min(plotY1 - 3, Math.max(PT + 8, Y(0) - 3)));
  ax(mn + pad, plotY1 - 3);
  /* ROUND182: TV time axis — day-boundary dates with intraday times between
     (like TV's "28 · 15:30 · 22:32 · 29 · 15:40 · 30"). */
  const MNAME = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (n) => String(n).padStart(2, '0');
  const dLabel = (tt) => { const d = new Date(tt * 1000); return MNAME[d.getMonth()] + ' ' + d.getDate(); };
  const tLabel = (tt) => { const d = new Date(tt * 1000); return p2(d.getHours()) + ':' + p2(d.getMinutes()); };
  const ticks = [];
  {
    const DAY = 86400;
    if (zw1 - zw0 < 1.5 * DAY) {
      for (let k = 0; k <= 6; k++) ticks.push({ t: zw0 + (zw1 - zw0) * k / 6, date: false });
    } else {
      const bounds = [];
      for (let d = Math.ceil(zw0 / DAY) * DAY; d <= zw1; d += DAY) bounds.push(d);
      const stride = Math.max(1, Math.ceil(bounds.length / 5));
      const kept = bounds.filter((_, i) => i % stride === 0);
      const edges = [zw0, ...kept.filter((d) => d > zw0 && d < zw1), zw1];
      for (const d of kept) if (d >= zw0 && d <= zw1) ticks.push({ t: d, date: true });
      for (let i = 0; i + 1 < edges.length && ticks.length < 9; i++) {
        ticks.push({ t: (edges[i] + edges[i + 1]) / 2, date: false });
      }
      ticks.sort((a, b) => a.t - b.t);
    }
  }
  for (const tk of ticks) {
    const tx = document.createElementNS(NS, 'text');
    tx.setAttribute('class', 'tst-axt');
    tx.setAttribute('x', String(Math.round(X(tk.t) * 10) / 10));
    tx.setAttribute('y', String(H - 6));
    tx.setAttribute('text-anchor', 'middle');
    tx.textContent = tk.date ? dLabel(tk.t) : tLabel(tk.t);
    svg.appendChild(tx);
  }
  const line = (rows, cls, parent) => {
    const pl = document.createElementNS(NS, 'polyline');
    pl.setAttribute('class', cls);
    let pts = '';
    for (const p of rows) pts += Math.round(X(p.t) * 10) / 10 + ',' + Math.round(Y(p.v) * 10) / 10 + ' ';
    pl.setAttribute('points', pts.trim());
    (parent || svg).appendChild(pl);
  };
  if (perfShow.bh && bh.length > 1) line(bh, 'tst-bh', series);
  if (perfShow.pnl) line(eq, 'tst-eq', series);
  /* ROUND182: excursion spikes (green up / red down at each exit) + the
     run-up (green) / drawdown (red) pair, all clipped to the plot area. */
  if (perfShow.exc) {
    const y0 = Y(0);
    for (const s of spikes) {
      if (!inW(s.t)) continue;
      const x = Math.round(X(s.t) * 10) / 10;
      if (s.fav > 0) {
        const ln = document.createElementNS(NS, 'line');
        ln.setAttribute('class', 'tst-exc-f');
        ln.setAttribute('x1', String(x)); ln.setAttribute('x2', String(x));
        ln.setAttribute('y1', String(Math.round(y0 * 10) / 10));
        ln.setAttribute('y2', String(Math.round(Y(s.fav) * 10) / 10));
        series.appendChild(ln);
      }
      if (s.adv < 0) {
        const ln = document.createElementNS(NS, 'line');
        ln.setAttribute('class', 'tst-exc-a');
        ln.setAttribute('x1', String(x)); ln.setAttribute('x2', String(x));
        ln.setAttribute('y1', String(Math.round(y0 * 10) / 10));
        ln.setAttribute('y2', String(Math.round(Y(s.adv) * 10) / 10));
        series.appendChild(ln);
      }
    }
  }
  if (perfShow.rd && rd.length > 1) {
    line(rd.map((p) => ({ t: p.t, v: p.ru })), 'tst-ru', series);
    line(rd.map((p) => ({ t: p.t, v: p.dd })), 'tst-dd', series);
  }
  /* position strip (TV bottom long/short bar) — thin, like TV. */
  if (pos.length > 1) {
    const py = plotY1 + 4, ph = 3;
    for (let i = 0; i < pos.length; i++) {
      const x0 = X(pos[i].t);
      const x1 = (i + 1 < pos.length) ? X(pos[i + 1].t) : (W - PR);
      if (!(x1 > x0)) continue;
      const rc = document.createElementNS(NS, 'rect');
      rc.setAttribute('class', pos[i].s > 0 ? 'tst-p-long' : pos[i].s < 0 ? 'tst-p-short' : 'tst-p-flat');
      rc.setAttribute('x', String(Math.round(x0 * 10) / 10));
      rc.setAttribute('y', String(py));
      rc.setAttribute('width', String(Math.max(0.8, Math.round((x1 - x0) * 10) / 10)));
      rc.setAttribute('height', String(ph));
      svg.appendChild(rc);
    }
  }
  /* hover crosshair + TV tooltip (positions via CSSOM, never style="") */
  const cross = document.createElementNS(NS, 'line');
  cross.setAttribute('class', 'tst-cross hidden');
  cross.setAttribute('y1', String(PT));
  cross.setAttribute('y2', String(plotY1));
  svg.appendChild(cross);
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('class', 'tst-dot hidden');
  dot.setAttribute('r', '4');
  svg.appendChild(dot);
  const tip = U.el('div', 'tst-tip hidden', wrap);
  const nearest = (rows, tt) => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < rows.length; i++) {
      const d = Math.abs(rows[i].t - tt);
      if (d < bd) { bd = d; bi = i; }
    }
    return rows[bi];
  };
  svg.addEventListener('mousemove', (ev) => {
    try {
      const rc = svg.getBoundingClientRect();
      if (rc.width <= 0) return;
      const sx = (ev.clientX - rc.left) / rc.width * W;
      const tt = zw0 + Math.min(1, Math.max(0, (sx - PL) / (W - PL - PR))) * (zw1 - zw0);
      const primary = perfShow.pnl ? eq : bh;
      const np = nearest(primary, tt);
      if (!np) return;
      const cx = X(np.t);
      cross.setAttribute('x1', String(cx));
      cross.setAttribute('x2', String(cx));
      cross.classList.remove('hidden');
      dot.setAttribute('cx', String(cx));
      dot.setAttribute('cy', String(Y(np.v)));
      dot.classList.remove('hidden');
      /* ROUND181: TV trade-aware tooltip — the active trade (with its
         favorable/adverse excursion), series values, TV date, and a
         click-through that jumps the chart to the trade entry. */
      const showBh = perfShow.bh && bh.length > 1;
      const tr = activeTrade(rep.trades, np.t);
      U.clear(tip);
      tip.onclick = null;
      if (tr) {
        const th = U.el('div', 'tst-tip-t', tip);
        th.textContent = 'Trade ' + (tr.n != null ? tr.n : '?') + ' ' + (tr.dir < 0 ? 'short' : 'long');
        const row = (cls, label, val) => {
          const r = U.el('div', 'tst-tip-r', tip);
          U.el('i', cls, r);
          const k = U.el('span', '', r);
          k.textContent = label;
          const v = U.el('b', '', r);
          v.textContent = val;
        };
        if (perfShow.pnl) row('tst-d-eq', 'Cumulative PnL', fmtMoney(nearest(eq, np.t).v, cur));
        row('tst-d-fav', 'Favorable excursion', fmtMoney(tr.mfe || 0, cur));
        row('tst-d-adv', 'Adverse excursion', fmtMoney(tr.mae || 0, cur));
        if (showBh) row('tst-d-bh', 'Buy and hold', fmtMoney(nearest(bh, np.t).v, cur));
        const dt = U.el('div', 'tst-tip-d', tip);
        dt.textContent = fmtTip(np.t);
        const go = U.el('div', 'tst-tip-go', tip);
        go.textContent = 'Click to show on chart';
        tip.style.cursor = 'pointer';
        tip.onclick = () => { try { if (tr.entryTime != null) GoToDate.jump(tr.entryTime); } catch (e) {} };
      } else {
        tip.style.cursor = '';
        const dt = U.el('div', 'tst-tip-d', tip);
        dt.textContent = fmtTip(np.t);
        const row = (cls, label, val) => {
          const r = U.el('div', 'tst-tip-r', tip);
          U.el('i', cls, r);
          const k = U.el('span', '', r);
          k.textContent = label;
          const v = U.el('b', '', r);
          v.textContent = val;
        };
        if (perfShow.pnl) row('tst-d-eq', 'Cumulative PnL', fmtMoney(nearest(eq, np.t).v, cur));
        if (showBh) row('tst-d-bh', 'Buy and hold', fmtMoney(nearest(bh, np.t).v, cur));
      }
      tip.classList.remove('hidden');
      const px = (cx / W) * rc.width;
      tip.style.left = Math.min(Math.max(0, px - 90), Math.max(0, rc.width - 190)) + 'px';
      tip.style.top = '8px';
    } catch (e) {}
  });
  /* hide when the cursor leaves the whole chart wrapper (not the svg —
     the tooltip itself is clickable, so svg->tip travel must not hide it). */
  wrap.addEventListener('mouseleave', () => {
    cross.classList.add('hidden');
    dot.classList.add('hidden');
    tip.classList.add('hidden');
  });
  /* ROUND182: wheel zooms the time window around the cursor (TV detail
     zoom), double-click resets to the full span. */
  svg.addEventListener('wheel', (ev) => {
    try {
      ev.preventDefault();
      const rc = svg.getBoundingClientRect();
      if (rc.width <= 0) return;
      const sx = (ev.clientX - rc.left) / rc.width * W;
      const f = Math.min(1, Math.max(0, (sx - PL) / (W - PL - PR)));
      const factor = ev.deltaY > 0 ? 1.3 : 1 / 1.3;
      const w0 = zb - za;
      const nw = Math.min(1, Math.max(0.02, w0 * factor));
      const na = Math.min(1 - nw, Math.max(0, za + (w0 - nw) * f));
      const nb = na + nw;
      perfZoom = (nb - na >= 0.999) ? null : { a: na, b: nb };
      renderPerf(box, rep);
    } catch (e) {}
  }, { passive: false });
  svg.addEventListener('dblclick', () => {
    perfZoom = null;
    try { renderPerf(box, rep); } catch (e) {}
  });
  wrap.insertBefore(svg, tip);
  box.appendChild(wrap);
  const cap2 = U.el('div', 'tst-capline', box);
  const last = (rows) => (rows.length ? rows[rows.length - 1].v : NaN);
  const sgn = (v) => ((isFinite(v) && v > 0 ? '+' : '') + fmtMoney(v, cur));
  cap2.textContent = 'Cumulative ' + sgn(last(eq))
    + (bh.length ? '  ·  Buy&hold ' + sgn(last(bh)) : '');
}

/* ROUND177: "Profits and losses" — P&L grouped By signals (entryId, like
   TV's MacdLE/MacdSE rows) or By side (Long/Short). Bars are SVG rects
   (width attribute = geometry, paint via classes — round-81 CSP). */
function renderGroups(box) {
  U.clear(box);
  const rep = groupsRep;
  if (!rep) return;
  const cur = rep.currency || 'USD';
  const head = U.el('div', 'tst-sec-h', box);
  head.textContent = 'Profits and losses';
  const tg = U.el('div', 'tst-toggle', box);
  const modes = [['signals', 'By signals'], ['side', 'By side']];
  for (const [m, label] of modes) {
    const b = U.el('button', 'tst-tg' + (groupsMode === m ? ' on' : ''), tg);
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => { groupsMode = m; renderGroups(box); });
  }
  let rows = [];
  try {
    const g = tradeGroups(rep.trades || []);
    rows = groupsMode === 'side' ? g.bySide : g.bySignal;
  } catch (e) { rows = []; }
  if (!rows.length) {
    const e = U.el('div', 'tst-empty', box);
    e.textContent = 'No closed trades yet.';
    return;
  }
  let mx = 0;
  for (const r of rows) mx = Math.max(mx, Math.abs(r.profit));
  const NS = 'http://www.w3.org/2000/svg';
  const BW = 120, BH = 10;
  for (const r of rows) {
    const row = U.el('div', 'tst-grow', box);
    const nm = U.el('span', 'tst-gname', row);
    nm.textContent = r.name + ' (' + r.n + ')';
    nm.title = r.name;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + BW + ' ' + BH);
    svg.setAttribute('class', 'tst-gbar');
    const w = mx > 0 ? Math.max(1, Math.round(Math.abs(r.profit) / mx * BW)) : 0;
    if (w > 0) {
      const rc = document.createElementNS(NS, 'rect');
      rc.setAttribute('class', r.profit >= 0 ? 'tst-gpos' : 'tst-gneg');
      rc.setAttribute('x', '0');
      rc.setAttribute('y', '0');
      rc.setAttribute('width', String(w));
      rc.setAttribute('height', String(BH));
      svg.appendChild(rc);
    }
    row.appendChild(svg);
    const vv = U.el('span', 'tst-gval' + (r.profit >= 0 ? ' tst-pos' : ' tst-neg'), row);
    vv.textContent = fmtMoney(r.profit, cur);
  }
}

/* ROUND183: "Trades analysis" — Distribution (returns histogram + donut),
   Streaks (run stats + chronological run chart), Time patterns (weekday
   bars). All SVG geometry via attributes, paint via classes (CSP). */
let analysisTab = 'dist';
let analysisRep = null;

function analysisCards(grid, cur, items) {
  for (const [label, value, cls] of items) statRow(grid, label, value, cls);
}

function renderAnalysis(box) {
  U.clear(box);
  const rep = analysisRep;
  if (!rep) return;
  const cur = rep.currency || 'USD';
  let A = null;
  try { A = tradesAnalysis(rep.trades || [], rep.initialCapital || 0); } catch (e) { A = null; }
  if (!A) return;
  const head = U.el('div', 'tst-sec-h', box);
  head.textContent = 'Trades analysis';
  const tg = U.el('div', 'tst-toggle', box);
  for (const [m, label] of [['dist', 'Distribution'], ['streaks', 'Streaks'], ['time', 'Time patterns']]) {
    const b = U.el('button', 'tst-tg' + (analysisTab === m ? ' on' : ''), tg);
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => { analysisTab = m; renderAnalysis(box); });
  }
  const NS = 'http://www.w3.org/2000/svg';
  const pct2 = (v) => ((v >= 0 ? '+' : '') + (Math.round(v * 100) / 100).toFixed(2) + '%');
  if (analysisTab === 'dist') {
    const grid = U.el('div', 'tst-agrid', box);
    analysisCards(grid, cur, [
      ['Expectancy', fmtMoney(A.expectancy, cur) + ' ' + pct2(A.expectancyPct)],
      ['Outliers PnL', fmtMoney(A.outliers, cur) + ' ' + pct2(A.outliersPct)],
      ['Largest profit', fmtMoney(A.largestWin, cur) + ' ' + pct2(A.largestWinPct), 'tst-pos'],
      ['Largest loss', fmtMoney(A.largestLoss, cur) + ' ' + pct2(A.largestLossPct), 'tst-neg'],
    ]);
    const cols = U.el('div', 'tst-acols', box);
    /* returns histogram */
    const left = U.el('div', 'tst-acol', cols);
    const lh = U.el('div', 'tst-sec-h', left);
    lh.textContent = 'Returns distribution';
    if (A.bins.length) {
      const W = 420, H = 150, PL = 4, PR = 30, PT = 6, PB = 18;
      const lo = A.bins[0].lo, hi = A.bins[A.bins.length - 1].hi;
      let cmax = 1;
      for (const b of A.bins) cmax = Math.max(cmax, b.w + b.l);
      const X = (v) => PL + ((v - lo) / Math.max(1e-9, hi - lo)) * (W - PL - PR);
      const Y = (c) => PT + (1 - c / cmax) * (H - PT - PB);
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('class', 'tst-svg');
      const bw = Math.max(1, (W - PL - PR) / A.bins.length - 1);
      for (const b of A.bins) {
        const n = b.w + b.l;
        const rc = document.createElementNS(NS, 'rect');
        rc.setAttribute('class', (b.hi + b.lo) / 2 >= 0 ? 'tst-hbar-w' : 'tst-hbar-l');
        rc.setAttribute('x', String(Math.round(X(b.lo) * 10) / 10));
        rc.setAttribute('y', String(Math.round(Y(n) * 10) / 10));
        rc.setAttribute('width', String(Math.round(bw * 10) / 10));
        rc.setAttribute('height', String(Math.max(1, Math.round((H - PB - Y(n)) * 10) / 10)));
        rc.appendChild(document.createElementNS(NS, 'title')).textContent =
          (Math.round(b.lo * 100) / 100).toFixed(2) + '% … ' + (Math.round(b.hi * 100) / 100).toFixed(2) + '%: ' + n;
        svg.appendChild(rc);
      }
      const avg = (v, cls) => {
        if (!isFinite(v) || v < lo || v > hi) return;
        const ln = document.createElementNS(NS, 'line');
        ln.setAttribute('class', cls);
        ln.setAttribute('x1', String(Math.round(X(v) * 10) / 10));
        ln.setAttribute('x2', String(Math.round(X(v) * 10) / 10));
        ln.setAttribute('y1', String(PT));
        ln.setAttribute('y2', String(H - PB));
        svg.appendChild(ln);
      };
      avg(A.avgLossRet, 'tst-avg-l');
      avg(A.avgWinRet, 'tst-avg-w');
      const ax = (v, txt) => {
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('class', 'tst-axt');
        t.setAttribute('x', String(Math.round(X(v) * 10) / 10));
        t.setAttribute('y', String(H - 4));
        t.setAttribute('text-anchor', 'middle');
        t.textContent = txt;
        svg.appendChild(t);
      };
      ax(lo, pct2(lo).replace('+', ''));
      ax((lo + hi) / 2, '0%');
      ax(hi, pct2(hi).replace('+', ''));
      const cnt = document.createElementNS(NS, 'text');
      cnt.setAttribute('class', 'tst-ax');
      cnt.setAttribute('x', String(W - PR + 4));
      cnt.setAttribute('y', String(PT + 8));
      cnt.textContent = String(cmax);
      svg.appendChild(cnt);
      left.appendChild(svg);
      const lg = U.el('div', 'tst-legend', left);
      const chip = (cls, text) => {
        const s = U.el('span', 'tst-chip', lg);
        U.el('i', cls, s);
        const tx = U.el('span', '', s);
        tx.textContent = text;
      };
      chip('tst-sw-exc', 'Winners');
      chip('tst-sw-rd', 'Losers');
      const av = U.el('div', 'tst-capline', left);
      av.textContent = 'Average loss ' + (isFinite(A.avgLossRet) ? pct2(A.avgLossRet) : '—')
        + '   ·   Average profit ' + (isFinite(A.avgWinRet) ? pct2(A.avgWinRet) : '—');
    } else {
      const e = U.el('div', 'tst-empty', left);
      e.textContent = 'No priced trades yet.';
    }
    /* donut */
    const right = U.el('div', 'tst-acol', cols);
    const rh = U.el('div', 'tst-sec-h', right);
    rh.textContent = 'Trades distribution';
    const D = A.donut;
    if (D.total > 0) {
      const S = 150, R = 52, C = 2 * Math.PI * R;
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + S + ' ' + S);
      svg.setAttribute('class', 'tst-donut');
      const segs = [
        ['tst-dw', D.win / D.total], ['tst-dl', D.loss / D.total], ['tst-de', D.even / D.total],
      ];
      let acc = 0.25;
      for (const [cls, frac] of segs) {
        if (!(frac > 0)) continue;
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('class', cls);
        c.setAttribute('cx', String(S / 2));
        c.setAttribute('cy', String(S / 2));
        c.setAttribute('r', String(R));
        c.setAttribute('stroke-dasharray', (frac * C - 2) + ' ' + C);
        c.setAttribute('stroke-dashoffset', String(-acc * C));
        c.setAttribute('transform', 'rotate(-90 ' + S / 2 + ' ' + S / 2 + ')');
        svg.appendChild(c);
        acc += frac;
      }
      const t1 = document.createElementNS(NS, 'text');
      t1.setAttribute('class', 'tst-dtot');
      t1.setAttribute('x', String(S / 2));
      t1.setAttribute('y', String(S / 2 - 2));
      t1.setAttribute('text-anchor', 'middle');
      t1.textContent = String(D.total);
      svg.appendChild(t1);
      const t2 = document.createElementNS(NS, 'text');
      t2.setAttribute('class', 'tst-dsub');
      t2.setAttribute('x', String(S / 2));
      t2.setAttribute('y', String(S / 2 + 14));
      t2.setAttribute('text-anchor', 'middle');
      t2.textContent = 'Total trades';
      svg.appendChild(t2);
      right.appendChild(svg);
      const leg = U.el('div', 'tst-dleg', right);
      for (const [cls, label, cnt, pc] of [
        ['tst-sw-exc', 'Winners', D.win, D.winPct],
        ['tst-sw-rd', 'Losers', D.loss, D.lossPct],
        ['tst-sw-bh', 'Breakevens', D.even, D.evenPct]]) {
        const r = U.el('div', 'tst-drow', leg);
        U.el('i', cls, r);
        const nm = U.el('span', '', r);
        nm.textContent = label;
        const cc = U.el('span', 'tst-dn', r);
        cc.textContent = cnt + ' trades';
        const pp = U.el('span', 'tst-dp', r);
        pp.textContent = pct2(pc).replace('+', '');
      }
    } else {
      const e = U.el('div', 'tst-empty', right);
      e.textContent = 'No trades yet.';
    }
  } else if (analysisTab === 'streaks') {
    const S = A.streaks;
    const grid = U.el('div', 'tst-agrid', box);
    const curS = S.current.dir > 0 ? S.current.n + ' wins' : S.current.dir < 0 ? S.current.n + ' losses' : '—';
    analysisCards(grid, cur, [
      ['Longest win streak', String(S.maxWin)],
      ['Longest loss streak', String(S.maxLoss)],
      ['Avg win streak', (Math.round(S.avgWin * 100) / 100).toFixed(2)],
      ['Avg loss streak', (Math.round(S.avgLoss * 100) / 100).toFixed(2)],
      ['Current streak', curS],
    ]);
    if (S.runs.length) {
      const h = U.el('div', 'tst-sec-h', box);
      h.textContent = 'Streaks in order';
      const W = 600, H = 90, PT = 6, PB = 6;
      let runs = S.runs;
      if (runs.length > 120) {
        const st = Math.ceil(runs.length / 120);
        runs = runs.filter((_, i) => i % st === 0);
      }
      let mx = 1;
      for (const r of runs) mx = Math.max(mx, r.n);
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('class', 'tst-svg');
      const bw = (W - 8) / runs.length;
      runs.forEach((r, i) => {
        const bh2 = Math.max(2, (r.n / mx) * (H - PT - PB));
        const rc = document.createElementNS(NS, 'rect');
        rc.setAttribute('class', r.dir > 0 ? 'tst-hbar-w' : 'tst-hbar-l');
        rc.setAttribute('x', String(Math.round((4 + i * bw + 0.5) * 10) / 10));
        rc.setAttribute('y', String(Math.round((H - PB - bh2) * 10) / 10));
        rc.setAttribute('width', String(Math.max(1, Math.round((bw - 1) * 10) / 10)));
        rc.setAttribute('height', String(Math.round(bh2 * 10) / 10));
        rc.appendChild(document.createElementNS(NS, 'title')).textContent =
          (r.dir > 0 ? 'Win' : 'Loss') + ' × ' + r.n;
        svg.appendChild(rc);
      });
      box.appendChild(svg);
    }
  } else {
    const rows = A.weekdays;
    let mx = 0;
    for (const r of rows) mx = Math.max(mx, Math.abs(r.net));
    const NS2 = NS;
    for (const r of rows) {
      const row = U.el('div', 'tst-wrow', box);
      const nm = U.el('span', 'tst-gname', row);
      nm.textContent = r.d + ' (' + r.n + ')';
      const svg = document.createElementNS(NS2, 'svg');
      svg.setAttribute('viewBox', '0 0 120 10');
      svg.setAttribute('class', 'tst-gbar');
      const w = mx > 0 ? Math.max(r.n ? 1 : 0, Math.round(Math.abs(r.net) / mx * 120)) : 0;
      if (w > 0) {
        const rc = document.createElementNS(NS2, 'rect');
        rc.setAttribute('class', r.net >= 0 ? 'tst-gpos' : 'tst-gneg');
        rc.setAttribute('x', '0');
        rc.setAttribute('y', '0');
        rc.setAttribute('width', String(w));
        rc.setAttribute('height', '10');
        svg.appendChild(rc);
      }
      row.appendChild(svg);
      const vv = U.el('span', 'tst-gval' + (r.net >= 0 ? ' tst-pos' : ' tst-neg'), row);
      vv.textContent = fmtMoney(r.net, cur);
    }
    if (!rows.some((r) => r.n > 0)) {
      const e = U.el('div', 'tst-empty', box);
      e.textContent = 'No dated trades yet.';
    }
  }
}

/* ROUND177: List-of-trades CSV export (TV's download icon). Full precision;
   the panel stays rounded. */
function downloadCsv(rep) {
  try {
    const cur = rep.currency || 'USD';
    const csv = tradesCsv(rep.trades || [], cur);
    const slug = String(rep.title || 'strategy').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'strategy';
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = slug + '-trades.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {} }, 500);
  } catch (e) {}
}

Tester.refresh = function () {
  let insts = [];
  try { insts = PineUI.strategyInstances() || []; } catch (e) { insts = []; }
  const sel = document.getElementById('tst-inst');
  const head = document.getElementById('tst-head');
  const sum = document.getElementById('tst-summary');
  const psum = document.getElementById('tst-perfsum');
  const perfBox = document.getElementById('tst-perf');
  const groupsBox = document.getElementById('tst-groups');
  const tbl = document.getElementById('tst-trades');
  const pos = document.getElementById('tst-pos');
  if (!sel || !sum || !tbl) return;
  U.clear(sel); U.clear(sum); U.clear(tbl);
  if (psum) U.clear(psum);
  if (head) U.clear(head);
  if (perfBox) U.clear(perfBox);
  if (groupsBox) U.clear(groupsBox);
  const analysisBox0 = document.getElementById('tst-analysis');
  if (analysisBox0) U.clear(analysisBox0);
  if (pos) U.clear(pos);
  if (!insts.length) {
    const e = U.el('div', 'tst-empty', sum);
    e.textContent = 'No strategy on the chart yet. Add one from the Pine Editor (a strategy() script).';
    return;
  }
  for (const it of insts) {
    const o = U.el('option', '', sel);
    o.value = String(it.instId);
    o.textContent = it.title + (it.status === 'error' ? ' (error)' : '');
  }
  const pick = insts[0];
  sel.value = String(pick.instId);
  curSel = { pane: pick.pane, instId: pick.instId };
  Tester.render(pick.pane, pick.instId);
};

Tester.render = function (pane, instId) {
  const head = document.getElementById('tst-head');
  const sum = document.getElementById('tst-summary');
  const psum = document.getElementById('tst-perfsum');
  const perfBox = document.getElementById('tst-perf');
  const groupsBox0 = document.getElementById('tst-groups');
  const tbl = document.getElementById('tst-trades');
  const pos = document.getElementById('tst-pos');
  if (!sum || !tbl) return;
  U.clear(sum); U.clear(tbl);
  if (psum) U.clear(psum);
  if (head) U.clear(head);
  if (perfBox) U.clear(perfBox);
  if (groupsBox0) U.clear(groupsBox0);
  const analysisBoxR = document.getElementById('tst-analysis');
  if (analysisBoxR) U.clear(analysisBoxR);
  if (pos) U.clear(pos);
  let rep = null;
  try { rep = PineUI.strategyReport(pane, Number(instId) || instId); } catch (e) { rep = null; }
  if (!rep) {
    const e = U.el('div', 'tst-empty', sum);
    e.textContent = 'No report for this instance yet.';
    return;
  }
  if (rep.status === 'error') {
    const e = U.el('div', 'tst-empty', sum);
    e.textContent = 'Script error: ' + ((rep.errors[0] && rep.errors[0].message) || 'unknown');
    return;
  }
  /* ROUND179: sticky-toolbar range filter (report-side; history backfill for
     out-of-range periods arrives in round 180). */
  if (rangeSel && (rangeSel.from != null || rangeSel.to != null)) {
    try {
      const f = filterReport(rep, rangeSel.from, rangeSel.to);
      rep = Object.assign({}, rep, { trades: f.trades, stats: f.stats, perf: f.perf, ranged: true });
    } catch (e) {}
  }
  /* ROUND175: TV-style header — backtest span + capital + bar count, so the
     "which range / which capital produced this" is never a mystery.
     ROUND178: TV toolbar pills (calendar + capital) instead of a flat line. */
  if (head) {
    const bar = U.el('div', 'tst-toolbar', head);
    const pill = (ic, text, title) => {
      const p = U.el('span', 'tst-pill', bar);
      if (ic) {
        const i = U.el('span', 'tst-pill-ic', p);
        i.innerHTML = icon(ic);
      }
      const t = U.el('span', '', p);
      t.textContent = text;
      if (title) p.title = title;
    };
    const range = (rep.fromTime != null && rep.toTime != null)
      ? (fmtD(rep.fromTime) + ' – ' + fmtD(rep.toTime)) : 'no bars';
    pill('calendar', range, 'Backtest range');
    pill(null, fmtMoney(rep.initialCapital || 0, rep.currency || 'USD'), 'Initial capital');
    if (rep.barCount) pill(null, rep.barCount + ' bars', 'Bars in the backtest');
  }
  const keyH = U.el('div', 'tst-sec-h', sum);
  keyH.textContent = 'Key stats';
  const st = rep.stats || {};
  const cur = rep.currency || 'USD';
  const cap = rep.initialCapital || 0;
  const net = st.netProfit || 0;
  const netPct = cap > 0 ? (net / cap * 100) : 0;
  statRow(sum, 'Total P&L', fmtMoney(net, cur) + ' ' + (net >= 0 ? '+' : '') + (Math.round(netPct * 100) / 100).toFixed(2) + '%', net >= 0 ? 'tst-pos' : 'tst-neg');
  statRow(sum, 'Max drawdown', fmtMoney(st.maxDD, cur) + ' ' + (Math.round((st.maxDDPct || 0) * 10000) / 100).toFixed(2) + '%');
  statRow(sum, 'Profitable', st.trades ? ((Math.round(st.winRate * 10000) / 100).toFixed(2) + '%  ' + st.wins + '/' + st.trades) : '—');
  statRow(sum, 'Profit factor', st.profitFactor === Infinity ? '∞' : fmtN(st.profitFactor, 3));
  statRow(sum, 'Gross profit', fmtMoney(st.grossProfit, cur));
  statRow(sum, 'Gross loss', fmtMoney(st.grossLoss, cur));
  statRow(sum, 'Expectancy', fmtMoney(st.expectancy, cur));
  statRow(sum, 'Fees', fmtMoney(st.fees, cur));
  /* ROUND194: TV Performance Summary (All/Long/Short) right under Key stats. */
  if (psum) { try { renderPerfSum(psum, rep); } catch (e) {} }
  /* ROUND176: equity-vs-buy&hold chart between the stats and the position. */
  if (perfBox && rep.perf && rep.perf.equity && rep.perf.equity.length > 1) {
    try { renderPerf(perfBox, rep); } catch (e) {}
  }
  /* ROUND177: signal/side breakdown + CSV live on the same report. */
  groupsRep = rep;
  const groupsBox = document.getElementById('tst-groups');
  if (groupsBox) { try { renderGroups(groupsBox); } catch (e) {} }
  /* ROUND183: trades-analysis tabs live on the same report. */
  analysisRep = rep;
  const analysisBox = document.getElementById('tst-analysis');
  if (analysisBox) { try { renderAnalysis(analysisBox); } catch (e) {} }
  if (pos) {
    const p = rep.position || {};
    const pe = U.el('div', 'tst-posline', pos);
    pe.textContent = 'Position: ' + (p.qty > 0 ? 'LONG ' : p.qty < 0 ? 'SHORT ' : 'FLAT ') + (p.qty ? (Math.abs(p.qty) + ' @ ' + fmtN(p.avg, 5)) : '');
    if (p.pending) {
      const pw = U.el('span', 'tst-pending', pos);
      pw.textContent = p.pending + ' working';
    }
  }
  const head2 = U.el('div', 'tst-listbar', tbl);
  const lt = U.el('span', 'tst-sec-h', head2);
  lt.textContent = 'List of trades';
  const csvBtn = U.el('button', 'mini-btn tst-csv', head2);
  csvBtn.type = 'button';
  /* ROUND180: icon-only (TV download glyph) with an explicit tooltip. */
  csvBtn.title = 'Export positions';
  csvBtn.setAttribute('aria-label', 'Export positions');
  csvBtn.innerHTML = icon('downloadBold');
  /* ROUND182: explicit geometry — a bare viewBox svg collapsed to ~6px in
     the flex button (hence the "dot"); attributes + CSSOM pin it to 15px. */
  try {
    const glyph = csvBtn.querySelector('svg');
    if (glyph) {
      glyph.setAttribute('width', '15');
      glyph.setAttribute('height', '15');
      glyph.style.width = '15px';
      glyph.style.height = '15px';
      glyph.style.flex = 'none';
    }
  } catch (e) {}
  csvBtn.addEventListener('click', () => downloadCsv(rep));
  const head3 = U.el('div', 'tst-thead', tbl);
  for (const h of ['#', 'Side', 'Qty', 'Entry', '@', 'Exit', '@', 'Net P&L', 'Return']) {
    const c = U.el('span', 'tst-th', head3);
    c.textContent = h;
  }
  /* ROUND180: full history with a pager (the old slice(-200) silently hid
     trades 1..N-200 — the user's "185..384" report). Newest first, like TV. */
  const allTrades = rep.trades || [];
  const tkey = String(instId) + '|' + allTrades.length + '|' + (rangeSel ? rangeSel.from + '-' + rangeSel.to : 'full');
  if (tkey !== lastTradeKey) { lastTradeKey = tkey; tradePage = 0; }
  const pg = paginate(allTrades.length, tradePage, 100);
  tradePage = pg.page;
  const trades = allTrades.slice().reverse().slice(pg.start, pg.end);
  if (!allTrades.length) {
    const e = U.el('div', 'tst-empty', tbl);
    e.textContent = 'No closed trades yet.';
    return;
  }
  for (const t of trades) {
    const r = U.el('div', 'tst-trow', tbl);
    /* ROUND175: Return = signed profit over entry notional (TV List-of-trades
       column); guards zero/na notionals. */
    let ret = null;
    try {
      const notion = (typeof t.entryPrice === 'number' && typeof t.qty === 'number') ? t.entryPrice * t.qty : NaN;
      if (isFinite(notion) && notion !== 0 && isFinite(t.profit)) ret = t.profit / Math.abs(notion) * 100;
    } catch (e) { ret = null; }
    const cells = [String(t.n), t.dir > 0 ? 'Long' : 'Short', fmtN(t.qty, 4),
      fmtT(t.entryTime), fmtN(t.entryPrice, 5), fmtT(t.exitTime), fmtN(t.exitPrice, 5),
      fmtMoney(t.profit, cur), (ret == null || !isFinite(ret)) ? '—' : ((ret >= 0 ? '+' : '') + (Math.round(ret * 100) / 100).toFixed(2) + '%')];
    cells.forEach((cv, i) => {
      /* ROUND178: TV side colors (Long blue / Short red) + P&L colors. */
      let cls = 'tst-td';
      if (i === 1) cls += t.dir > 0 ? ' tst-long' : ' tst-short';
      if (i === 7 || i === 8) cls += t.profit >= 0 ? ' tst-pos' : ' tst-neg';
      const c = U.el('span', cls, r);
      c.textContent = cv;
    });
  }
  /* ROUND180: pager bar (always rendered when trades exist — count included). */
  {
    const bar = U.el('div', 'tst-pager', tbl);
    const prev = U.el('button', 'mini-btn', bar);
    prev.type = 'button';
    prev.textContent = '‹';
    prev.title = 'Newer trades';
    prev.disabled = pg.page <= 0;
    prev.addEventListener('click', () => { tradePage = Math.max(0, pg.page - 1); Tester.render(pane, instId); });
    const info = U.el('span', 'tst-pageinfo', bar);
    info.textContent = 'Page ' + (pg.page + 1) + ' of ' + pg.pages + '  ·  ' + pg.count + ' trades';
    const next = U.el('button', 'mini-btn', bar);
    next.type = 'button';
    next.textContent = '›';
    next.title = 'Older trades';
    next.disabled = pg.page >= pg.pages - 1;
    next.addEventListener('click', () => { tradePage = Math.min(pg.pages - 1, pg.page + 1); Tester.render(pane, instId); });
  }
};

Tester.onShow = function () {
  Tester.refresh();
};

Tester.init = function () {
  /* ROUND184: late marker-funnel registration (import-cycle safe). */
  try { if (PineUI.initMarkers) PineUI.initMarkers(); } catch (e) {}
  const btn = document.getElementById('tst-refresh');
  if (btn) {
    btn.innerHTML = icon('sync');
    btn.title = 'Refresh report';
    btn.addEventListener('click', () => Tester.refresh());
  }
  const sel = document.getElementById('tst-inst');
  if (sel) {
    sel.addEventListener('change', () => {
      let insts = [];
      try { insts = PineUI.strategyInstances() || []; } catch (e) {}
      const it = insts.find((x) => String(x.instId) === String(sel.value));
      if (it) { curSel = { pane: it.pane, instId: it.instId }; Tester.render(it.pane, it.instId); }
    });
  }
};

/* ROUND179: sticky-toolbar API for the bottom dock. */
Tester.setRange = function (fromSec, toSec) {
  rangeSel = { from: (fromSec != null && isFinite(fromSec)) ? fromSec : null,
    to: (toSec != null && isFinite(toSec)) ? toSec : null };
  Tester.refresh();
};
Tester.clearRange = function () { rangeSel = null; Tester.refresh(); };
Tester.getRange = function () { return rangeSel ? { from: rangeSel.from, to: rangeSel.to } : null; };
Tester.currentSel = function () { return curSel; };

export { Tester };
