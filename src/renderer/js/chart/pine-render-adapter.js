/**
 * Pine render adapter (round 74 — roadmap phase 5)
 *
 * Maps a compiled script runtime's visual output to the chart:
 *   plot()            -> LWC LineSeries / HistogramSeries on the pane's scale
 *   plotshape/char/arrow -> the pine overlay canvas (full TV shape set)
 *   bgcolor()         -> a canvas UNDER the chart (transparent LWC skin shows it)
 *   barcolor()        -> candle repainting on the overlay canvas
 *   fill()            -> canvas polygon between two plot series
 *   hline()           -> series price lines
 *   line/box/label    -> the pine overlay canvas (script-owned objects; no
 *                        handles/selection — the source is the script, not
 *                        the mouse, so the drawing engine stays untouched)
 *
 * The overlay repaints every frame from the runtime state with visibility
 * culling — pan/zoom never leaves stale pixels.
 *
 * @module chart/pine-render-adapter
 */

import { U } from '../core/util.js';
import { Log } from '../../../core/logger.js';
import { App } from '../../../core/state.js';
import { Manager } from './manager.js';
import { sessionRegionEnds } from '../../../core/session-math.js';
import { arrowHeight, magRange } from '../../../core/pine/arrow.js';
import { drawKindOn } from '../../../core/pine/stdlib/objects.js';

const LWC = window.LightweightCharts;
try { Log.info('chart', 'pine-render-adapter ROUND136 gap-fix build loaded'); } catch (e) {}

const LWC_LINE_STYLE = { solid: 0, dotted: 1, dashed: 2, largedashed: 3 };
const SIZE_PX = { tiny: 8, small: 10, normal: 12, large: 15, huge: 19, auto: 12 };

/* ROUND141 (BUG: adding a 2nd Pine script erased the 1st every frame):
   every adapter shares the pane's TWO host canvases, but each paint began
   with an unconditional clear — the last painter of the frame won and its
   siblings' lines/shapes/fills vanished (only legends + native series
   survived, exactly the "lines jump, some effects remain" report).
   Clearing is now GENERATIONAL: each full paint cycle (loop frame, range
   event, settle) bumps pane._pineGen once, and each canvas is cleared by
   its first painter of that generation only — every adapter then overpaints
   onto the same fresh frame. paintPaneForced is the funnel for every path
   that must repaint the WHOLE set synchronously (range events: zero x-lag
   per ROUND79; settles: post-LWC y per ROUND139). */
function paintPaneForced(pane) {
  if (!pane || pane._pinePaintForced) return;
  pane._pinePaintForced = true;
  try {
    pane._pineGen = (pane._pineGen || 0) + 1;
    const set = pane._pineAdapters;
    if (set) for (const ad of set) { try { ad.frame(true); } catch (e) { Log.debug('pine', 'adapter frame broadcast failed', e) } }
  } finally {
    pane._pinePaintForced = false;
  }
}

class PineRenderAdapter {
  /**
   * @param {object} pane  the app pane (chart, bars, engine, ...)
   * @param {object} inst  the pine instance record { id, scriptId, inputs, visible }
   */
  constructor(pane, inst) {
    this.pane = pane;
    this.inst = inst;
    this.rt = null;          // PineRuntime
    this.series = [];        // [{ s (LWC series), key, isHist }]
    this.priceLines = [];    // hline price lines
    this.priceLineOwner = null; // series (or main series) that owns the price lines
    this.legEl = null;       // legend row values span
    this.title = 'Pine Script';
    this.sub = null;         // ROUND 74: own sub-pane when meta.overlay === false
    /* ROUND155: owned table-dashboard divs (table id -> element) + dirty key */
    this._tableEls = new Map();
    this._tablesVersion = -1;
    this._tablesHidden = false;
    this._tablesW = 0;
    this._tablesH = 0;
  }

  /* ========================= lifecycle ========================= */

  attach(rt) {
    this.rt = rt;
    this.title = (rt.meta && rt.meta.title) || this.title;
    this._buildSeries();
    this._ensureCanvases();
    const pane = this.pane;
    if (!pane._pineAdapters) pane._pineAdapters = new Set();
    pane._pineAdapters.add(this);
    /* ROUND79: same-frame tracking for rAF-driven range animations — the
       engine's TV-style inertia glide (drawing/engine _inertia) and any
       programmatic setVisibleLogicalRange update the model INSIDE their own
       rAF step; the manager loop can read the pre-step range and trail the
       candles by a frame (~7px at glide speed). Painting synchronously on
       the range-change event keeps the overlay in the SAME frame as the
       chart. The paint key still dedupes, so idle costs nothing.
       ROUND141: ONE pane-level subscription — every adapter used to
       subscribe (and clear-paint) on its own, so N scripts meant N full
       repaints per event with each wiping the previous. The funnel paints
       the whole set once, synchronously (reentrancy-guarded). */
    if (!pane._pineRangeSub) {
      pane._pineRangeSub = true;
      try {
        pane.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
          paintPaneForced(pane);
          this._settlePaint(); // ROUND139: second chance after LWC flushes (see below)
        });
      } catch (e) {}
    }
    this.refillAll();
  }

  /* ROUND139 (user report: Supertrend lines "float" up/down while dragging
     the chart, then snap correct on release):
     the sync paint above runs INSIDE the range-change event — i.e. BEFORE
     LWC re-renders. The x mapping (timeScale model) is already new, but the
     y mapping (priceToCoordinate) still rides the pre-render price scale
     whenever autoscale breathes with the pan, so the overlay paints new-x +
     old-y and hangs a step off the candles until the next paint. LWC
     schedules its own redraw synchronously inside setVisibleLogicalRange —
     i.e. BEFORE this subscriber runs — so a freshly-registered rAF is
     guaranteed to run AFTER LWC flushed, converging the overlay onto the
     rendered mapping within the same frame cycle. Coalesced (one pending
     settle max, key-deduped on arrival), so mousemove storms and idle cost
     ~nothing; the sync paint stays for ROUND79's zero x-lag. */
  _settlePaint() {
    /* ROUND141: funnels to the pane-level forced paint (whole set, one
       clear) — a lone self-paint here would wipe sibling scripts. Pane-
       coalesced: one pending settle max per pane per cycle. */
    const pane = this.pane;
    if (this._settleQueued || pane._pineSettleQueued) return;
    this._settleQueued = true;
    pane._pineSettleQueued = true;
    const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : ((f) => setTimeout(f, 16));
    raf(() => {
      this._settleQueued = false;
      pane._pineSettleQueued = false;
      paintPaneForced(pane);
    });
  }

  detach() {
    const pane = this.pane;
    if (pane._pineAdapters) pane._pineAdapters.delete(this); // ROUND141: leave the shared set
    const chart = this.sub ? this.sub.chart : pane.chart;
    for (const { s } of this.series) { try { chart.removeSeries(s); } catch (e) {} }
    this.series = [];
    const plOwner = this.priceLineOwner || pane.series;
    try { plOwner.removePriceLine && this.priceLines.forEach((pl) => plOwner.removePriceLine(pl)); } catch (e) {}
    this.priceLines = [];
    this._removeCanvases();
    this._removeTables(); // ROUND155: owned dashboard divs die with the instance
    this._settleQueued = false; // ROUND139: drop any pending settle pass with the instance
    /* ROUND 74: a non-overlay script owns a real sub-pane (round-32 parity) —
       it dies with the instance; layout re-stacks the remaining panes */
    if (this.sub) { try { Manager.removeSubPane(pane, this.inst.id); } catch (e) {} this.sub = null; }
    this.rt = null;
  }

  _ensureCanvases() {
    const pane = this.pane;
    if (!pane._pineCanvases) {
      // bg canvas sits BEHIND the (transparent) LWC chart, above the grid
      const bg = U.el('canvas', 'pine-bg-canvas', pane.host);
      // fg canvas carries shapes/lines/boxes/labels/barcolor, above the chart,
      // BELOW the drawing engine overlay (user drawings stay on top)
      const fg = U.el('canvas', 'pine-fg-canvas', pane.host);
      fg.addEventListener('mousedown', (e) => e.stopPropagation());
      pane._pineCanvases = { bg, fg };
    }
    /* ROUND155: table dashboards live in a shared DOM layer (text grids are
       DOM, like TV — canvas text cannot do grids/borders cleanly). */
    if (!pane._pineTables) {
      pane._pineTables = U.el('div', 'pine-tables', pane.host);
    }
  }

  _removeCanvases() {
    const pc = this.pane._pineCanvases;
    if (!pc) return;
    // shared across instances: removed when the LAST instance detaches
    const remaining = (this.pane.pineScripts || []).filter((i) => i.id !== this.inst.id);
    if (!remaining.length) { try { pc.bg.remove(); pc.fg.remove(); } catch (e) { Log.debug('pine', 'pine canvas teardown failed', e) } this.pane._pineCanvases = null; }
  }

  /* ROUND155: per-adapter dashboard divs; the shared layer dies with the
     last instance, like the canvases above. */
  _removeTables() {
    if (this._tableEls) {
      for (const el of this._tableEls.values()) { try { el.remove(); } catch (e) {} }
      this._tableEls.clear();
    }
    this._tablesVersion = -1;
    const remaining = (this.pane.pineScripts || []).filter((i) => i.id !== this.inst.id);
    if (!remaining.length && this.pane._pineTables) {
      try { this.pane._pineTables.remove(); } catch (e) {}
      this.pane._pineTables = null;
    }
  }

  /* ========================= series ========================= */

  /* ROUND 74 (roadmap phase 5, TV parity): a script declared with
     overlay=false gets a TRUE sub-pane — own LWC chart, own price scale,
     own legend row — through the same machinery the built-in indicators
     use since round 32 (pane._subs + Manager.layoutSubPanes), NOT a
     series squeezed onto the price scale. Mirrors indicators-ui.js
     ensureSub with a sub-pine skin class. */
  _ensureSub() {
    const pane = this.pane;
    if (!pane._subs) pane._subs = new Map();
    let sub = pane._subs.get(this.inst.id);
    if (sub) { this.sub = sub; return sub; }
    const hostEl = U.el('div', 'sub-pane sub-pine', pane.host);
    const leg = U.el('div', 'sub-legend', hostEl);
    const chart = LWC.createChart(hostEl, Manager.subChartOptions(pane));
    sub = { instId: this.inst.id, host: hostEl, legend: leg, chart,
      chartEl: hostEl.querySelector('.tv-lightweight-charts'), firstSeries: null };
    pane._subs.set(this.inst.id, sub);
    /* fresh charts lack the synced axis width — force the next re-apply
       (same round-32 C7 guard the built-ins hit) */
    if (Manager.invalidateAxisSync) Manager.invalidateAxisSync(pane);
    try {
      const lr = pane.chart.timeScale().getVisibleLogicalRange();
      if (lr) chart.timeScale().setVisibleLogicalRange({ from: lr.from, to: lr.to });
    } catch (e) { Log.debug('pine', 'adapter range restore failed', e) }
    Manager.layoutSubPanes(pane);
    this.sub = sub;
    return sub;
  }

  /* axis-label precision for oscillator-scale pine values (round-32 parity:
     MACD-scale numbers would print 0.00 with the lib default) */
  _autoPrecision() {
    let m = 0;
    for (const p of this._out().plots.values()) {
      const vals = p.values || [];
      for (let i = Math.max(0, vals.length - 400); i < vals.length; i++) {
        const v = vals[i];
        if (v != null && isFinite(v)) { const a = Math.abs(v); if (a > m) m = a; }
      }
    }
    if (m === 0) return 2;
    if (m < 0.01) return 6;
    if (m < 0.1) return 5;
    if (m < 1) return 4;
    if (m < 100) return 2;
    if (m < 10000) return 1;
    return 0;
  }

  _buildSeries() {
    const pane = this.pane, rt = this.rt;
    if (!rt || !pane.bars.length) return;
    const overlay = !(rt.meta && rt.meta.overlay === false);
    if (!overlay) this._ensureSub();
    const targetChart = this.sub ? this.sub.chart : pane.chart;
    const scaleId = pane._scaleId || 'right';
    /* ROUND 74: the user price-zoom provider belongs to the MAIN scale only —
       a sub-pane oscillator must keep its own autoscale (built-in parity) */
    const prov = (!this.sub && pane) ? Manager.priceZoomProvider(pane) : null;
    const opt = (o) => (prov ? Object.assign({ autoscaleInfoProvider: prov }, o) : o);
    const pr = this._autoPrecision();
    /* ROUND140 (BUG: eye-off + TF switch left remnants): a rebuild creates
       FRESH native series that default to visible:true — the eye state has
       to ride birth too, not just the toggle path.
       ROUND143: same for the Style-tab eye and the TF-visibility tab. */
    const on = this._tfOn();
    let first = null;
    for (const key of this._out().plotsOrder) {
      const p = this._out().plots.get(key);
      if (p.display === 'none') continue;
      const isHist = p.style === 'histogram' || p.style === 'columns';
      let s;
      try {
        if (isHist) {
          s = targetChart.addHistogramSeries(opt({
            priceScaleId: scaleId, priceLineVisible: false, lastValueVisible: false,
            visible: on,
            base: typeof p.histbase === 'number' ? p.histbase : 0, // ROUND142: plot(histbase=)
          }));
        } else {
          const dots = p.style === 'circles' || p.style === 'cross';
          /* ROUND135: a plot with linewidth=0 is invisible in TV (e.g.
             Supertrend's mPlot exists only to anchor a fill). Show neither
             the line nor the point markers.
             ROUND138: the old `!dots &&` exempted circle/cross plots, so
             mPlot (style=circles, linewidth=0) painted thousands of blue
             dots over the candles — TV shows none. Default linewidth is 1
             (interpreter), so only an explicit 0 hides. */
          const invisible = !(p.linewidth > 0);
          /* ROUND136 (BUG: na gaps bridged into one long diagonal line):
             this LWC build has no line-break/gap support — a whitespace
             point (na) is simply left out of the polyline, so the line
             connects straight through to the next real value, however far
             away it is (plot.style_linebr scripts like Supertrend rely on
             na to STOP the line at every trend flip; instead the two ends
             got joined into one long diagonal). The native series keeps
             going for autoscale/price-line/crosshair/last-value purposes,
             but its own stroke is always OFF; _paintPlotLines draws the
             real, gap-aware stroke on the fg canvas every frame. */
          s = targetChart.addLineSeries(opt({
            priceScaleId: scaleId,
            color: '#2962ff',
            lineWidth: invisible ? 1 : Math.min(4, Math.max(1, p.linewidth || 1)),
            lineStyle: LWC_LINE_STYLE[p.linestyle] || 0,
            lineVisible: false,
            visible: on,
            pointMarkersVisible: dots && !invisible,
            crosshairMarkerVisible: on && !dots && !invisible && this._priceLabels(),
            priceLineVisible: false,
            /* TV: the oscillator pane shows its last value pill on the axis */
            lastValueVisible: on && !overlay && !first && this._priceLabels(),
            priceFormat: overlay ? undefined : { type: 'price', precision: pr, minMove: Math.pow(10, -pr) },
          }));
        }
      } catch (e) { continue; }
      if (!first) first = s;
      this.series.push({ s, key, isHist });
    }
    if (this.sub) {
      this.sub.firstSeries = first;
      try { this.sub.chart.priceScale(scaleId).applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } }); } catch (e) {}
    }
    // hlines: on the script's pane — the main series (overlay) or the sub's
    // first series (non-overlay), exactly like the built-in levels.
    // ROUND140: price lines have no `visible` flag — only create them while
    // shown; setVisible() removes/recreates them on toggle (a rebuild births
    // them through this same gate, so eye-off survives TF switches).
    const plOwner = overlay ? pane.series : (first || pane.series);
    this.priceLineOwner = plOwner;
    this.priceLines = [];
    if (on) this._createPriceLines();
  }

  _createPriceLines() {
    const rt = this.rt;
    const plOwner = this.priceLineOwner || this.pane.series;
    const hs = rt.out.hlines;
    for (let hi = 0; hi < hs.length; hi++) {
      if (this._hlineHidden(hi)) continue; // ROUND166: Style-tab hline eye
      const h = hs[hi];
      try {
        const pl = plOwner.createPriceLine({
          price: h.price,
          color: h.color ? h.color.css() : 'rgba(178,181,190,0.4)',
          lineWidth: h.linewidth || 1,
          lineStyle: ({ solid: LWC.LineStyle.Solid, dotted: LWC.LineStyle.Dotted, dashed: LWC.LineStyle.Dashed })[h.linestyle] || LWC.LineStyle.Dashed,
          axisLabelVisible: false, title: '',
        });
        this.priceLines.push(pl);
      } catch (e) {}
    }
  }

  /* ROUND140: the ONE visibility funnel — native series, hlines, canvases
     (via markDirty + the paint early-returns) and legend all follow it.
     toggleVisible() and any rebuild path (TF switch) come through here. */
  setVisible(show) {
    const on = show !== false;
    for (const { s } of this.series) { try { s.applyOptions({ visible: on }); } catch (e) {} }
    const plOwner = this.priceLineOwner || this.pane.series;
    if (!on) {
      try { plOwner.removePriceLine && this.priceLines.forEach((pl) => plOwner.removePriceLine(pl)); } catch (e) {}
      this.priceLines = [];
    } else if (!this.priceLines.length && this.rt && this.rt.out.hlines.length) {
      this._createPriceLines();
    }
    this.markDirty();
  }

  /**
   * ROUND 74 (BUG): at attach() time the runtime has NOT run yet, so
   * rt.out.plotsOrder/hlines are empty and the series built then would be
   * none — the chart stayed blank forever. After the first full pass the
   * plot set is final: rebuild the series/hlines to match it (cheap no-op
   * when the structure already matches). MUST run before refillAll().
   */
  syncStructure() {
    const rt = this.rt;
    if (!rt || !this.pane.bars.length) return;
    this._forcePaint = true; // ROUND78 perf
    const want = (this._out().plotsOrder || []).filter((k) => {
      const p = this._out().plots.get(k);
      return p && p.display !== 'none';
    });
    const have = this.series.map((x) => x.key);
    const same = want.length === have.length && want.every((k, i) => k === have[i])
      && this._hlinesBuilt === (rt.out.hlines && rt.out.hlines.length > 0);
    if (same) return;
    const chart = this.sub ? this.sub.chart : this.pane.chart;
    for (const { s } of this.series) { try { chart.removeSeries(s); } catch (e) { Log.debug('pine', 'adapter series teardown failed', e) } }
    this.series = [];
    const plOwner = this.priceLineOwner;
    if (plOwner) { try { plOwner.removePriceLine && this.priceLines.forEach((pl) => plOwner.removePriceLine(pl)); } catch (e) {} }
    this.priceLines = [];
    this.priceLineOwner = null;
    this._buildSeries(); // _ensureSub inside is idempotent for non-overlay
    this._hlinesBuilt = (rt.out.hlines && rt.out.hlines.length > 0) || false;
    /* ROUND 74: the range set at birth ran BEFORE any data existed — LWC's
       first setData can auto-fit and leave the slave chart drifted from the
       main chart. Re-apply the main's current visible range now that the
       series are fed (the main-range subscription keeps it synced after). */
    if (this.sub) {
      try {
        const lr = this.pane.chart.timeScale().getVisibleLogicalRange();
        if (lr) this.sub.chart.timeScale().setVisibleLogicalRange({ from: lr.from, to: lr.to });
      } catch (e) {}
    }
  }

  /** (re)feed every LWC series + price lines from the runtime output */
  refillAll() {
    this._forcePaint = true; // ROUND78 perf: full data swap the key cannot see
    const pane = this.pane, rt = this.rt;
    if (!rt || !pane.bars.length) return;
    const bars = pane.bars;
    for (const { s, key, isHist } of this.series) {
      const p = this._out().plots.get(key);
      if (!p) continue;
      const data = [];
      for (let i = 0; i < bars.length; i++) {
        const v = p.values[i];
        if (v == null || v === undefined || !isFinite(v)) { data.push({ time: bars[i].time }); continue; }
        const c = p.colors[i];
        const item = { time: bars[i].time, value: v };
        if (c && c.css && (isHist || (c && c.a != null && c.a < 1))) item.color = c.css();
        else if (c && c.css) item.color = c.css();
        data.push(item);
      }
      try { s.setData(data); } catch (e) {}
    }
  }

  /**
   * Tick-path update: ONLY the forming bar's values change — feed them with
   * the O(1) series.update (the rounds-71/72 no-full-refresh discipline;
   * full setData stays for history reloads).
   */
  updateLast() {
    this._forcePaint = true; // ROUND78 perf: tick-path mutation the key cannot see
    const pane = this.pane, rt = this.rt;
    if (!rt || !pane.bars.length) return;
    const b = pane.bars[pane.bars.length - 1];
    const i = pane.bars.length - 1;
    for (const { s, key } of this.series) {
      const p = this._out().plots.get(key);
      if (!p) continue;
      const v = p.values[i];
      try {
        if (v == null || !isFinite(v)) s.update({ time: b.time });
        else {
          const c = p.colors[i];
          const item = { time: b.time, value: v };
          if (c && c.css) item.color = c.css();
          s.update(item);
        }
      } catch (e) {}
    }
  }

  /* ========================= per-frame paint ========================= */

  /* ROUND78 perf: the manager render loop calls frame() for every pane EVERY
     frame. Painting is pure output of runtime state + the visible window, so
     a tiny state key decides whether pixels can have changed at all — if not,
     the canvases are left untouched (0 draw calls on idle frames).
     _forcePaint marks the events a key cannot see (series refills, tick-path
     set_* mutations on the same bar, visibility flips).
     ROUND79 (BUG: boxes swam during pan and snapped back on release): the
     round-78 key quantized the visible range to INTEGER bar indices, so a
     pan only repainted when the range crossed a bar boundary — the overlay
     lagged the moving chart by up to a full bar and caught up at tick rate.
     The key now carries (a) the FRACTIONAL visible range (1e-3 bar ≈ 0.008px
     at the default 8px spacing — absorbs float noise, still fires on every
     real pan frame) and (b) a vertical-mapping fingerprint, because free
     vertical pan (auto-scale off) and price-axis drag-zoom move
     priceToCoordinate() WITHOUT touching the logical range at all. Idle
     frames keep both fingerprints stable → the skip fast-path is preserved. */
  markDirty() { this._forcePaint = true; }

  /** ROUND79: vertical mapping fingerprint — y of the last close (shift)
      plus the pixel distance to close*1.01 (zoom), probed on the SAME
      series the painters map prices through (main for overlay, the sub's
      first series for non-overlay scripts). Quarter-pixel resolution. */
  _vertKey() {
    try {
      const s = this.sub
        ? (this.sub.firstSeries || (this.series[0] && this.series[0].s))
        : this.pane.series;
      const bars = this.pane.bars;
      const b = bars && bars.length ? bars[bars.length - 1] : null;
      if (!s || !b || !isFinite(b.close)) return '';
      const yA = s.priceToCoordinate(b.close);
      if (yA == null || !isFinite(yA)) return '';
      const yB = s.priceToCoordinate(b.close * 1.01);
      const d = (yB != null && isFinite(yB)) ? yB - yA : 0;
      return Math.round(yA * 4) + '|' + Math.round(d * 4);
    } catch (e) { return ''; }
  }

  _paintKey(from, to, frKey) {
    const pane = this.pane;
    const rt = this.rt;
    return rt.env.barTimeMs + '|' + rt.env.barIndex + '|' + rt.store.version +
      '|' + from + '|' + to + '|' + (frKey || '') +
      '|' + this._vertKey() +
      '|' + pane.host.clientWidth + 'x' + pane.host.clientHeight +
      '|' + (this._tfOn() ? 1 : 0) + '|' + (rt.env.serverOffSec || 0);
  }

  /** repaint the pine canvases (called every frame by the manager loop) */
  frame(force) {
    this._paintIfKeyChanged(force);
    /* ROUND160: dashboards share the in-flight rule (no partial tables). */
    if (!force && (this.pane._pineRunning || 0) > 0) return;
    try { this._syncTables(); } catch (e) {}
  }

  /* ROUND79: shared key-check + paint. Returns true when pixels changed.
     ROUND141: `force` (forced full-set cycles) bypasses the key — the
     generation clear already wiped the canvas, so a key-skip here would
     leave this adapter's output erased for the whole cycle. */
  _paintIfKeyChanged(force) {
    const pane = this.pane;
    const pc = pane._pineCanvases;
    if (!pc || !this.rt) return false;
    /* ROUND160: while any full pass is in flight on this pane (chunked history
       run yielding to the loop), skip every non-forced paint WITHOUT touching
       the canvases — the in-flight runtime's partial output must neither show
       (growing lines) nor clear away the siblings (vanishing indicators).
       The run's finally ends with one forced full-set repaint. */
    if (!force && (pane._pineRunning || 0) > 0) return false;
    let from = 0, to = 0, frKey = '';
    try {
      const lr = pane.chart.timeScale().getVisibleLogicalRange();
      if (lr) {
        from = Math.floor(lr.from); to = Math.ceil(lr.to);
        /* ROUND79: exact fractional scroll — see the _paintKey note */
        frKey = Math.round(lr.from * 1000) + '|' + Math.round(lr.to * 1000);
      }
    } catch (e) {}
    const key = this._paintKey(from, to, frKey);
    if (!this._forcePaint && !force && key === this._lastPaintKey) return false;
    this._lastPaintKey = key;
    this._forcePaint = false;
    this._paintBg();
    this._paintFg();
    return true;
  }

  _ctxFor(cv) {
    const pane = this.pane;
    const w = pane.host.clientWidth, h = pane.host.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    /* ROUND141: generational clear — each canvas is wiped by its FIRST
       painter of the generation only (the generation is bumped once per
       full paint cycle in framePane/paintPaneForced). The old unconditional
       clear erased sibling scripts sharing these host canvases (A/B proof:
       ST pixels 17158 -> 1593 after a 2nd script). */
    if (cv._pineGen !== pane._pineGen) {
      cv._pineGen = pane._pineGen;
      ctx.clearRect(0, 0, w, h);
    }
    return { ctx, w, h };
  }

  /** x coordinate for a pine epoch-ms time (chart stamps are seconds).
   *  ROUND78 (timezone): Pine times are TRUE UTC ms while chart stamps carry
   *  the broker wall-clock shift (+serverOffSec) — re-apply it here so
   *  xloc.bar_time drawings land on the same bars the script's own `time`
   *  series refers to, whatever the broker's UTC offset is.
   *  ROUND87 (Custom Session): LWC's logical frame counts the whitespace GAP
   *  rows the session series was fed, while pane.barTimes is COMPACT —
   *  mixing them shifted every bar_time drawing left by ~2-3 bars per day
   *  boundary. On session panes the search runs over the gap-INCLUSIVE
   *  time axis (pane._sessWithGapTimes) so the logical is LWC-exact.
   *  ROUND138 (BUG: Supertrend +36 bars on +3h brokers): _xOf expects TRUE-UTC
   *  ms (the `time` frame — see interpreter barTimeMs). Every bar-indexed
   *  caller used to pass bars[i].time*1000, but bars[i].time already carries
   *  the broker wall shift, so the +serverOffSec above double-applied it
   *  (10800s / 300s = 36 bars on M5 XAUUSD). Those callers must route
   *  through _barMs() below, which strips the shift back to true UTC first;
   *  bar_time objects (already true UTC) keep calling _xOf directly. */
  _xOf(tMs) {
    const pane = this.pane;
    const ts = pane.chart.timeScale();
    const tSec = tMs / 1000 + ((this.rt && this.rt.env && this.rt.env.serverOffSec) || 0);
    const hook = App.sessionHook;
    const times = (hook && hook.active && hook.active() && pane._sessWithGapTimes)
      ? pane._sessWithGapTimes : pane.barTimes;
    const l = U.timeToLogical(times, tSec);
    const i0 = Math.floor(l);
    const a = ts.logicalToCoordinate(i0);
    if (a == null) return null;
    if (l === i0) return a;
    let sp = 8;
    try { sp = ts.options().barSpacing || 8; } catch (e) {}
    return a + (l - i0) * sp;
  }

  /** ROUND144: the RENDERED output — rt.viewOut in MTF mode (chart-frame
      remap), else the engine output itself. Painters, feeds and legend read
      ONLY through here; hlines stay on rt.out (frame-independent statics).
      The engine keeps mutating rt.out in the run frame, so incremental
      updates can never corrupt the rendered arrays again. */
  _out() {
    const rt = this.rt;
    if (!rt) return null;
    return rt.viewOut || rt.out;
  }

  /** broker-wall bar stamp (sec) -> true-UTC ms for _xOf (see note above). */
  _barMs(bSec) {
    return (bSec - ((this.rt && this.rt.env && this.rt.env.serverOffSec) || 0)) * 1000;
  }

  /** ROUND143: master visibility — eye toggle AND TF-visibility tab.
      Every painter, the legend and the native-series birth gate on this. */
  _tfOn() {
    if (this.inst.visible === false) return false;
    const v = this.inst.visTF;
    if (v == null || typeof v !== 'object' || !Object.keys(v).length) return true;
    return v[this.pane.tf] !== false;
  }

  _plotOv(key) {
    const s = this.inst.style;
    return (s && s.plots && s.plots[key]) || null;
  }

  _plotHidden(key) {
    const o = this._plotOv(key);
    return !!(o && o.visible === false);
  }

  _shapeHidden(key) {
    const s = this.inst.style;
    const o = s && s.shapes && s.shapes[key];
    return !!(o && o.visible === false);
  }

  _fillHidden(idx) {
    const s = this.inst.style;
    const o = s && s.fills && s.fills[idx];
    return !!(o && o.visible === false);
  }

  /* ROUND166 (TV Style-tab sweep): per-candle + per-hline eye, and the
     GRAPHIC OBJECTS master toggles (Boxes / Lines / Pane labels). All
     default on; the dialog persists falses into inst.style like the
     plot/shape eyes above. */
  _candleHidden() {
    const s = this.inst.style;
    if (s && s.candles && s.candles.visible === false) return true;
    const m = this._out() && this._out().candleMeta;
    if (m && m.display === 'none') return true;
    return false;
  }

  _hlineHidden(idx) {
    const s = this.inst.style;
    const o = s && s.hlines && s.hlines[idx];
    return !!(o && o.visible === false);
  }

  _drawKindOn(kind) {
    return drawKindOn(this.inst.style, kind);
  }

  _statusInputs() {
    const s = this.inst.style;
    return !s || s.statusInputs !== false;
  }

  /** ROUND143 (TV Style tab): "Labels on price scale" + "Values in status
      line" — both default on. */
  _priceLabels() {
    const s = this.inst.style;
    return !s || s.priceLabels !== false;
  }

  _statusValues() {
    const s = this.inst.style;
    return !s || s.statusValues !== false;
  }

  _stylePrecision() {
    const s = this.inst.style;
    const p = s && s.precision;
    if (p === 'default' || p == null) return null;
    const n = Math.floor(Number(p));
    return (isFinite(n) && n >= 0 && n <= 8) ? n : null;
  }

  _yOf(price, force) {
    /* ROUND 74 (sub-pane parity): coordinates are HOST-level — for a
       non-overlay script the price maps through the SUB chart's first
       series and is offset by the sub-pane's top, so every painter
       (shapes/fills/lines/boxes/labels) lands inside the script's pane.
       Overlay scripts keep the main-series mapping (unchanged).
       ROUND223 (TV parity): force skips the sub mapping — force_overlay
       drawings land on the MAIN chart even from a sub-pane script. */
    try {
      const pane = this.pane;
      const overlay = force || !(this.rt && this.rt.meta && this.rt.meta.overlay === false) || !this.sub;
      if (overlay) return pane.series.priceToCoordinate(price);
      const fs = this.sub.firstSeries || (this.series[0] && this.series[0].s);
      if (!fs) return null;
      const y = fs.priceToCoordinate(price);
      if (y == null) return null;
      return y + this._paintRect().top;
    } catch (e) { return null; }
  }

  /** main-chart coordinate — ONLY for barcolor() (it repaints the main
      candles even from a non-overlay script, exactly like TV) */
  _yOfMain(price) {
    try { return this.pane.series.priceToCoordinate(price); } catch (e) { return null; }
  }

  /** ROUND 74: the clip rect of THIS script's pane inside the host-level
      pine canvases — the main plot area (overlay) or the instance's
      sub-pane rect from Manager.layoutSubPanes (non-overlay).
     ROUND223: force selects the MAIN rect for force_overlay objects. */
  _paintRect(force) {
    const pane = this.pane;
    /* ROUND223: force selects the MAIN rect for force_overlay objects. */
    if (!force && this.sub && Array.isArray(pane._subRects)) {
      const r = pane._subRects.find((q) => q.chart === this.sub.chart);
      if (r) return { top: r.top, h: r.plotH > 0 ? r.plotH : r.h };
    }
    const mainH = pane._mainPlotH > 0 ? pane._mainPlotH : Math.max(10, pane.host.clientHeight - 26);
    return { top: 0, h: mainH };
  }

  /** ROUND80 (user report): the pine canvases are HOST-level (they span the
   *  pane INCLUDING the price scale), but drawings must never paint over the
   *  axis — TV clips everything to the plot area (the app's own drawing
   *  engine does the same via its plot clip + axisQueue). The plot width is
   *  the host width minus the price-scale width; every painter below clips
   *  to (0, r.top, pw, r.h) so boxes/lines/labels stop exactly at the plot's
   *  right edge no matter how far their time coordinates extend (future
   *  margin, xloc.bar_time far right) or how the chart is panned. */
  _plotW() {
    const pane = this.pane;
    let w = 0;
    try { w = pane.host.clientWidth; } catch (e) { return 10; }
    let axisW = 62;
    try { axisW = pane.chart.priceScale(pane._scaleId || 'right').width() || axisW; } catch (e) {}
    return Math.max(10, w - axisW);
  }

  /** visible bar window [from, to] in logical indices */
  _visRange() {
    try {
      const lr = this.pane.chart.timeScale().getVisibleLogicalRange();
      if (lr) return [Math.max(0, Math.floor(lr.from) - 2), Math.min(this.pane.barTimes.length - 1, Math.ceil(lr.to) + 2)];
    } catch (e) {}
    return [0, this.pane.barTimes.length - 1];
  }

  /* ---- bgcolor: under-candle wash on the bg canvas ---- */
  _paintBg() {
    const { ctx } = this._ctxFor(pc_bg(this.pane));
    const rt = this.rt;
    if (!rt) return;
    /* ROUND140: the fg hid on eye-off but the bg wash never checked — a
       hidden script's bgcolor() survived every toggle AND every rebuild */
    if (!this._tfOn()) return;
    const pane = this.pane;
    const bars = pane.bars;
    if (!bars.length) return;
    const [from, to] = this._visRange();
    const r = this._paintRect(); // ROUND 74: wash stays inside the script's pane
    /* ROUND80: the wash is clipped to the plot area too — the rightmost bar's
       cell would otherwise run past the candles onto the price scale */
    ctx.save();
    ctx.beginPath(); ctx.rect(0, r.top, this._plotW(), r.h); ctx.clip();
    for (let i = from; i <= to; i++) {
      const c = this._out().bgcolor[i];
      if (!c || !c.css) continue;
      const x0 = this._xOf(this._barMs(bars[i].time));
      const x1 = this._xOf(this._barMs(bars[i].time + (App.tfById[pane.tf] ? App.tfById[pane.tf].sec : 60)));
      if (x0 == null || x1 == null) continue;
      ctx.fillStyle = c.css();
      ctx.fillRect(Math.min(x0, x1), r.top, Math.max(1.5, Math.abs(x1 - x0)), r.h);
    }
    ctx.restore();
  }

  /* ---- fg: barcolor + plotshapes + line/box/label objects ---- */
  _paintFg() {
    const { ctx, w, h } = this._ctxFor(this.pane._pineCanvases.fg);
    const rt = this.rt;
    const pane = this.pane;
    if (!rt) return;
    /* ROUND78 (TV parity): hiding an indicator hides EVERYTHING it draws —
       the canvases were just cleared by _ctxFor, so an early return is the
       hide (previously barcolor/shapes checked the flag but boxes/labels
       kept painting after the eye toggle) */
    if (!this._tfOn()) return;
    const bars = pane.bars;
    const tfSec = App.tfById[pane.tf] ? App.tfById[pane.tf].sec : 60;
    const r = this._paintRect(); // ROUND 74: clip to the script's own pane

    /* ROUND80 (user report: boxes painted over the price scale): clip to the
       PLOT area (host width minus the price scale), not the full host — the
       same rule the app's own rectangles follow. Vertical extent unchanged
       (r.top/r.h already exclude the time axis, so the bottom scale is safe
       too); panning/zooming can never push a drawing onto either axis. */
    ctx.save();
    ctx.beginPath(); ctx.rect(0, r.top, this._plotW(), r.h); ctx.clip();

    /* 1) barcolor: repaint candle bodies/wicks of the affected bars —
       always on the MAIN candles (TV semantics), so main-chart mapping */
    const styleColors = Manager._styleColors ? Manager._styleColors() : { up: '#089981', down: '#f23645' };
    const bw = Math.max(1, Math.min(24, (this.pane.engine && this.pane.engine.view ? 0 : 0)));
    const spacing = (() => { try { return pane.chart.timeScale().options().barSpacing || 8; } catch (e) { return 8; } })();
    const bodyW = Math.max(1, Math.floor(spacing * 0.7));
    for (let i = 0; i < bars.length; i++) {
      const c = this._out().barcolor[i];
      if (!c || !c.css) continue;
      const x = this._xOf(this._barMs(bars[i].time));
      if (x == null || x < -bodyW || x > w + bodyW) continue;
      const yO = this._yOfMain(bars[i].open), yC = this._yOfMain(bars[i].close);
      const yH = this._yOfMain(bars[i].high), yL = this._yOfMain(bars[i].low);
      if (yO == null || yC == null || yH == null || yL == null) continue;
      ctx.fillStyle = c.css();
      ctx.strokeStyle = c.css();
      // wick
      ctx.fillRect(x - 0.5, Math.min(yH, yL), 1, Math.max(1, Math.abs(yL - yH)));
      // body
      const top = Math.min(yO, yC);
      const bh = Math.max(1, Math.abs(yC - yO));
      ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
    }

    /* 1b) plotcandle: script-defined synthetic candles drawn over/instead of
       the hosts bar (SMC's colored trend candles, TV semantics) */
    const cdOn = !this._candleHidden(); // ROUND166: Style-tab PlotCandle eye
    for (let i = 0; i < bars.length; i++) {
      if (!cdOn) break;
      const cd = this._out().candles && this._out().candles[i];
      if (!cd || (cd.open == null && cd.high == null)) continue;
      const x = this._xOf(this._barMs(bars[i].time));
      if (x == null || x < -bodyW || x > w + bodyW) continue;
      const o = this._yOfMain(cd.open != null ? cd.open : bars[i].open);
      const c = this._yOfMain(cd.close != null ? cd.close : bars[i].close);
      const h = this._yOfMain(cd.high != null ? cd.high : bars[i].high);
      const l = this._yOfMain(cd.low != null ? cd.low : bars[i].low);
      if (o == null || c == null || h == null || l == null) continue;
      const col = cd.color && cd.color.css ? cd.color.css() : (cd.close != null && cd.open != null && cd.close >= cd.open ? styleColors.up : styleColors.down);
      ctx.fillStyle = col; ctx.strokeStyle = col;
      ctx.fillRect(x - 0.5, Math.min(h, l), 1, Math.max(1, Math.abs(l - h))); // wick
      ctx.fillRect(x - bodyW / 2, Math.min(o, c), bodyW, Math.max(1, Math.abs(c - o))); // body
    }

    /* 2) plotshape / plotchar / plotarrow markers */
    /* (forced members skip here and paint in the second pass — see below.) */
    for (const [, sh] of this._out().shapes) {
      if (sh && sh.force_overlay && this.sub && this.rt.meta.overlay === false) continue;
      this._paintShape(ctx, sh, bars, tfSec, w, false);
    }

    /* 3) fills between plot pairs (canvas polygons under the objects) */
    for (let fi = 0; fi < this._out().fills.length; fi++) {
      const f = this._out().fills[fi];
      /* ROUND143: Style-tab eye per fill + per endpoint plot */
      if (this._fillHidden(fi)) continue;
      const p1 = this._out().plots.get(f.p1), p2 = this._out().plots.get(f.p2);
      if (!p1 || !p2) continue;
      if (this._plotHidden(f.p1) || this._plotHidden(f.p2)) continue;
      const [from, to] = this._visRange();
      /* ROUND135: fills must be painted SEGMENT BY SEGMENT — a fill's color
         is a series (e.g. Supertrend's highlighter flips green/red by trend).
         Painting one big polygon with the LAST color swamps the whole band
         with a single color and buries the candles. Split the visible range
         into runs of equal color, one polygon per run. */
      const lastColor = (function (arr) { for (let k = arr.length - 1; k >= 0; k--) if (arr[k]) return arr[k]; return null; })(f.colors);
      const norm = (c) => {
        if (!c || !c.css) return null;
        const s = c.css();
        /* ROUND134: color.white is TV's "no highlight" state — opaque white
           would bury the candles on a dark theme; keep it at 10% opacity. */
        if (/^rgba?\(\s*255\s*,\s*255\s*,\s*255/.test(s)) return 'rgba(255,255,255,0.10)';
        /* ROUND135: fills paint on the FOREGROUND canvas, ABOVE the candles.
           In TV they are drawn UNDER the candles, so a declared-opaque fill
           looks translucent there. Scale any fill with alpha >= 0.9 down to
           0.18 so the candles stay visible (TV parity of the visual result). */
        const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
        if (m) {
          const a = m[4] != null ? parseFloat(m[4]) : 1;
          if (a >= 0.9) return `rgba(${m[1]},${m[2]},${m[3]},0.18)`;
          return s;
        }
        return s;
      };
      let runColor = null, runTop = [], runBot = [];
      const flushRun = () => {
        if (runTop.length > 1 && runColor) {
          ctx.beginPath();
          ctx.moveTo(runTop[0][0], runTop[0][1]);
          for (const [x, y] of runTop) ctx.lineTo(x, y);
          for (let k = runBot.length - 1; k >= 0; k--) ctx.lineTo(runBot[k][0], runBot[k][1]);
          ctx.closePath();
          ctx.fillStyle = runColor;
          ctx.fill();
        }
        runTop = []; runBot = [];
      };
      for (let i = from; i <= to; i++) {
        const c = f.colors[i] || lastColor;
        const v1 = p1.values[i], v2 = p2.values[i];
        if (v1 == null || v2 == null || !isFinite(v1) || !isFinite(v2)) {
          /* ROUND137 (BUG: gap bridged into a thin diagonal sliver): this used
             to just `continue`, leaving the run open — so the point right
             before a na gap (e.g. Supertrend's dn plot during an uptrend)
             got joined straight to the point right after it, across however
             many bars the gap spanned. Flushing here closes the polygon at
             the gap instead, same fix as the line-plot bridging bug above. */
          flushRun();
          runColor = null;
          continue;
        }
        const x = this._xOf(this._barMs(bars[i].time));
        const y1 = this._yOf(v1), y2 = this._yOf(v2);
        if (x == null || y1 == null || y2 == null) { flushRun(); runColor = null; continue; }
        const col = norm(c);
        if (col !== runColor) { flushRun(); runColor = col; }
        runTop.push([x, y1]); runBot.push([x, y2]);
      }
      flushRun();
    }

    /* 3b) plot() line-style stroke — ROUND136: painted here (not via the
       native LWC series, which stays invisible) so na gaps actually break
       the line instead of bridging into one long diagonal, and per-bar
       color changes (e.g. a trend-colored plot) render exactly like the
       fills above: one flush per contiguous run of the same color. */
    this._paintPlotLines(ctx, bars, false);

    /* 4) script-owned line/box/label objects (786 Zones' main output) */
    const objs = [];
    for (const [, o] of rt.store.box) objs.push(o);
    for (const [, o] of rt.store.line) objs.push(o);
    for (const [, o] of rt.store.label) objs.push(o);
    for (const [, o] of rt.store.polyline) objs.push(o);
    for (const [, o] of rt.store.linefill) objs.push(o);
    /* ROUND223 (TV parity): force_overlay objects belong to the MAIN chart
       even from a sub-pane script — a linefill follows a forced constituent
       line. They paint in a second pass clipped to the main rect; everything
       else keeps the sub clip above. Overlay adapters never split (their
       single clip is already the main rect). */
    const isForced = (o) => (o.kind === 'line' || o.kind === 'box' || o.kind === 'label')
      ? !!o.force_overlay
      : (o.kind === 'linefill' && ((o.line1 && o.line1.force_overlay) || (o.line2 && o.line2.force_overlay)));
    const wantSplit = this.sub && (this.rt.meta.overlay === false) && (
      objs.some(isForced) ||
      /* ROUND227: forced plot lines / markers join the split (native
         histogram/column series stay sub-pane — see paintObjs note). */
      [...this._out().plots.values()].some((p) => p && p.force_overlay) ||
      [...this._out().shapes.values()].some((sh) => sh && sh.force_overlay));
    const paintObjs = (list) => {
      // boxes / polylines / linefills first (fills), then lines, then labels on top
      for (const o of list) if (o.kind === 'box' && this._drawKindOn('boxes')) this._paintBox(ctx, o);
      for (const o of list) if (o.kind === 'polyline') this._paintPolyline(ctx, o);
      for (const o of list) if (o.kind === 'linefill') this._paintLinefill(ctx, o);
      for (const o of list) if (o.kind === 'line' && this._drawKindOn('lines')) this._paintLine(ctx, o);
      for (const o of list) if (o.kind === 'label' && this._drawKindOn('labels')) this._paintLabel(ctx, o);
    };
    if (!wantSplit) {
      paintObjs(objs);
      ctx.restore();
    } else {
      paintObjs(objs.filter((o) => !isForced(o)));
      ctx.restore();
      ctx.save();
      const r2 = this._paintRect(true);
      ctx.beginPath(); ctx.rect(0, r2.top, this._plotW(), r2.h); ctx.clip();
      /* ROUND227 (TV parity): forced plot lines + markers join the forced
         objects on the main chart (native histogram/column series stay
         sub-pane — documented limitation). */
      this._paintPlotLines(ctx, bars, true);
      for (const [, sh] of this._out().shapes) {
        if (sh && sh.force_overlay) this._paintShape(ctx, sh, bars, tfSec, w, true);
      }
      paintObjs(objs.filter(isForced));
      ctx.restore();
    }
  }

  /* ============ ROUND155: table dashboards (DOM overlay) ============
     Engine owns the data (rt.store.table, phase-151 MVP); here each table
     becomes a positioned CSS grid. Dirty on store.version (bumped by
     new/cell/clear/set_position/delete) or geometry change; visibility
     follows the same _tfOn master as every other painter. All dynamic
     styling rides the CSSOM — no style="" markup (CSP round81). */
  _syncTables() {
    const pane = this.pane, rt = this.rt;
    if (!pane._pineTables) this._ensureTables();
    const on = !!(rt && rt.store && rt.store.table && this._tfOn());
    if (!on) {
      if (!this._tablesHidden) {
        for (const el of this._tableEls.values()) el.classList.add('hidden');
        this._tablesHidden = true;
      }
      return;
    }
    /* ROUND155-fix: an eye-off→on flip must unhide even when nothing is
       dirty — the key-skip below would otherwise leave the divs hidden
       forever on data-quiet scripts (no version bumps while hidden). */
    const wasHidden = this._tablesHidden;
    this._tablesHidden = false;
    // drop divs for deleted tables
    const live = new Set(rt.store.table.keys());
    for (const [id, el] of this._tableEls) {
      if (!live.has(id)) { try { el.remove(); } catch (e) {} this._tableEls.delete(id); }
    }
    const r = this._paintRect();
    const pw = this._plotW();
    const ver = rt.store.version;
    if (!wasHidden && ver === this._tablesVersion && pw === this._tablesW && r.h === this._tablesH && this._tableEls.size === live.size) return;
    this._tablesVersion = ver;
    this._tablesW = pw;
    this._tablesH = r.h;
    const cursors = {}; // corner -> stacked extent (same-corner tables pile)
    for (const [, t] of rt.store.table) {
      if (t.deleted) continue;
      let el = this._tableEls.get(t.id);
      if (!el) { el = U.el('div', 'pine-table', pane._pineTables); this._tableEls.set(t.id, el); }
      el.classList.remove('hidden');
      /* ROUND155-fix: instance attribution for tests/debugging (several
         scripts share one DOM layer). */
      if (el.dataset.inst !== this.inst.id) el.dataset.inst = this.inst.id;
      this._fillTableEl(el, t);
      this._placeTableEl(el, t.pos, cursors, pw, r);
    }
  }

  _fillTableEl(el, t) {
    while (el.firstChild) el.removeChild(el.firstChild);
    const css = (c) => (c && c.css ? c.css() : null);
    /* ROUND219 (TV parity): a table shows ONLY rows/columns that define data —
       "if the script does not define cell data for an entire row or column,
       the table automatically omits that row/column" (docs/visuals/tables).
       KZP declares 20x20 but fills ~4x10; we rendered the whole 400-cell grid.
       Merges keep their anchor; spans count actually-rendered neighbours. */
    const usedC = new Set(), usedR = new Set();
    for (const key of t.cells.keys()) {
      const p = String(key).split(',');
      const cc = Number(p[0]), rr = Number(p[1]);
      if (isFinite(cc) && isFinite(rr)) { usedC.add(cc); usedR.add(rr); }
    }
    const cols = Array.from(usedC).sort((a, b) => a - b);
    const rows = Array.from(usedR).sort((a, b) => a - b);
    // no defined cells: TV shows nothing (table.new alone displays no visuals)
    if (!cols.length || !rows.length) {
      el.style.gridTemplateColumns = '';
      el.style.backgroundColor = 'rgba(0,0,0,0)';
      el.style.border = '0px solid transparent';
      return;
    }
    const cIdx = {}, rIdx = {};
    cols.forEach((c, i) => { cIdx[c] = i; });
    rows.forEach((r, i) => { rIdx[r] = i; });
    el.style.gridTemplateColumns = 'repeat(' + cols.length + ', auto)';
    const frameC = css(t.frame_color);
    const bw = (typeof t.border_width === 'number' && isFinite(t.border_width)) ? Math.max(0, t.border_width) : 1;
    const bC = css(t.border_color) || 'transparent';
    const bg = css(t.bgcolor);
    el.style.backgroundColor = bg || 'rgba(0,0,0,0)';
    el.style.border = ((typeof t.frame_width === 'number' && isFinite(t.frame_width)) ? Math.max(0, t.frame_width) : 1) + 'px solid ' + (frameC || 'transparent');
    const sizePx = (s) => (typeof s === 'number' && isFinite(s) ? s : (SIZE_PX[s] || 11));
    const halign = (h) => (h === 'left' ? 'flex-start' : h === 'right' ? 'flex-end' : 'center');
    const valign = (v) => (v === 'top' ? 'flex-start' : v === 'bottom' ? 'flex-end' : 'center');
    /* ROUND155: merged headers — the anchor spans, covered cells are skipped.
       Every cell carries explicit grid lines so holes land correctly. */
    const covered = new Set();
    const spanOf = {};
    for (const m of (t.merges || [])) {
      spanOf[m.sc + ',' + m.sr] = m;
      for (let rr = m.sr; rr <= m.er; rr++) {
        for (let cc = m.sc; cc <= m.ec; cc++) {
          if (cc !== m.sc || rr !== m.sr) covered.add(cc + ',' + rr);
        }
      }
    }
    for (const r of rows) {
      for (const c of cols) {
        if (covered.has(c + ',' + r)) continue;
        /* TV excludes undefined cells from the display entirely (no empty
           placeholder div) — only defined cells occupy grid slots. */
        const cell = t.cells.get(c + ',' + r);
        if (!cell) continue;
        const d = U.el('div', 'pine-tcell', el);
        d.style.gridColumn = (cIdx[c] + 1) + '';
        d.style.gridRow = (rIdx[r] + 1) + '';
        const sp = spanOf[c + ',' + r];
        if (sp) {
          // span counts only rendered neighbours inside the merged range
          let w = 0;
          for (let cc = sp.sc; cc <= sp.ec; cc++) if (cIdx[cc] != null) w++;
          let h = 0;
          for (let rr = sp.sr; rr <= sp.er; rr++) if (rIdx[rr] != null) h++;
          d.style.gridColumn = (cIdx[sp.sc] + 1) + ' / span ' + Math.max(1, w);
          d.style.gridRow = (rIdx[sp.sr] + 1) + ' / span ' + Math.max(1, h);
        }
        d.textContent = cell.text;
        const cbg = css(cell.bgcolor);
        if (cbg) d.style.backgroundColor = cbg;
        const ctc = css(cell.text_color);
        d.style.color = ctc || '#d1d4dc';
        d.style.fontSize = sizePx(cell.text_size) + 'px';
        /* ROUND224 (TV parity): cell text formatting + font family. */
        const cfmt = cell.text_formatting || 'none';
        if (cfmt === 'bold' || cfmt === 'bold_italic') d.style.fontWeight = 'bold';
        if (cfmt === 'italic' || cfmt === 'bold_italic') d.style.fontStyle = 'italic';
        if (cell.text_font_family === 'monospace') d.style.fontFamily = 'Consolas, monospace';
        d.style.justifyContent = halign(cell.text_halign);
        d.style.alignItems = valign(cell.text_valign);
        d.style.border = bw + 'px solid ' + bC;
        if (typeof cell.height === 'number' && isFinite(cell.height) && cell.height > 0) {
          d.style.minHeight = cell.height + 'px';
        }
      }
    }
  }

  _placeTableEl(el, pos, cursors, pw, r) {
    const M = 8;
    const w = el.offsetWidth || 0, h = el.offsetHeight || 0;
    const used = cursors[pos] || 0;
    let left, top;
    if (pos.indexOf('left') >= 0) left = M;
    else if (pos.indexOf('right') >= 0) left = Math.max(M, pw - M - w);
    else left = Math.max(M, (pw - w) / 2);
    if (pos.indexOf('top') === 0) top = r.top + M + used;
    else if (pos.indexOf('bottom') === 0) top = r.top + r.h - M - h - used;
    else top = r.top + Math.max(0, (r.h - h) / 2) + used;
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(Math.max(0, top)) + 'px';
    cursors[pos] = used + h + 4;
  }

  /* ROUND136/141: hand-painted plot() output — gap-aware and colour-aware.
     Styles (docs): line bridges na, linebr/areabr break on it, stepline changes
     value mid-bar, area/areabr fill down to histbase, circles/cross join only
     with join=true. trackprice draws the dotted last-value line; show_last
     hides everything before the last N bars. */
  _paintPlotLines(ctx, bars, forcedOnly) {
    const rt = this.rt;
    const [from, to] = this._visRange();
    const step = (App.tfById[this.pane.tf] ? App.tfById[this.pane.tf].sec : 60);
    for (const key of this._out().plotsOrder) {
      const p = this._out().plots.get(key);
      if (!p || p.display === 'none') continue;
      /* ROUND227 (TV parity): force_overlay plots paint on the main chart
         (second pass, main clip); the native histogram/column series stay
         sub-pane (documented limitation). */
      if (!!p.force_overlay !== !!forcedOnly) continue;
      if (this._plotHidden(key)) continue; // ROUND143: Style-tab eye
      if (p.style === 'histogram' || p.style === 'columns') continue;
      const dots = p.style === 'circles' || p.style === 'cross';
      const shownFrom = p.show_last > 0 ? Math.max(0, bars.length - p.show_last) : 0;
      const val = (i) => { if (i < shownFrom) return null; const v = p.values[i]; return (v == null || !isFinite(v)) ? null : v; };
      const colAt = (i) => { const c = p.colors[i]; return (c && c.css) ? c.css() : '#2962ff'; };
      const hidden = (i) => { const c = p.colors[i]; return !!(c && c.a === 0); };

      // trackprice: dotted horizontal line at the last plotted value
      if (p.trackprice) {
        let lv = null;
        for (let i = bars.length - 1; i >= 0; i--) { const v = val(i); if (v != null) { lv = v; break; } }
        const ty = lv == null ? null : this._yOf(lv, forcedOnly);
        if (ty != null) {
          ctx.save(); ctx.strokeStyle = colAt(bars.length - 1); ctx.lineWidth = 1; ctx.setLineDash([1, 3]);
          ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(this.pane.host.clientWidth, ty); ctx.stroke(); ctx.restore();
        }
      }

      if (dots) {
        if (!(p.linewidth > 0)) continue; // ROUND138: linewidth 0 hides markers too (mPlot anchor)
        if (!p.join) continue; // markers are LWC's; only join=true adds the 1px connecting line
        ctx.lineWidth = 1; ctx.setLineDash([]);
        let prev = null;
        for (let i = from; i <= to; i++) {
          const v = val(i);
          if (v == null || hidden(i)) continue;
          const x = this._xOf(this._barMs(bars[i].time)), y = this._yOf(v, forcedOnly);
          if (x == null || y == null) continue;
          if (prev) { ctx.strokeStyle = colAt(i); ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(x, y); ctx.stroke(); }
          prev = [x, y];
        }
        continue;
      }

      const isArea = p.style === 'area' || p.style === 'areabr';
      const isStep = p.style === 'stepline' || p.style === 'stepline_diamond' || p.style === 'steplinebr';
      const breaks = p.style === 'linebr' || p.style === 'areabr' || p.style === 'steplinebr';
      if (!isArea && !(p.linewidth > 0)) continue; // linewidth 0 => invisible line (e.g. a fill anchor)

      // build the point list once: [{x,y,col,hide}] with null = a break
      const pts = [];
      for (let i = from; i <= to; i++) {
        const v = val(i);
        if (v == null) { if (breaks) pts.push(null); continue; }
        const x = this._xOf(this._barMs(bars[i].time)), y = this._yOf(v, forcedOnly);
        if (x == null || y == null) { pts.push(null); continue; }
        pts.push({ x, y, col: colAt(i), hide: hidden(i) });
      }

      if (isArea) {
        const base = this._yOf(p.histbase != null ? p.histbase : 0, forcedOnly);
        if (base != null) {
          let run = [];
          const flush = () => {
            if (run.length > 1) {
              const c = run[0].col;
              ctx.beginPath(); ctx.moveTo(run[0].x, base);
              for (const q of run) ctx.lineTo(q.x, q.y);
              ctx.lineTo(run[run.length - 1].x, base); ctx.closePath();
              ctx.fillStyle = c.replace(/rgba?\(([^)]+)\)/, (m, inner) => { const s = inner.split(','); return 'rgba(' + s[0] + ',' + s[1] + ',' + s[2] + ',' + (0.25 * (s[3] != null ? +s[3] : 1)) + ')'; });
              ctx.fill();
            }
            run = [];
          };
          for (const q of pts) { if (q === null || q.hide) flush(); else run.push(q); }
          flush();
        }
        if (!(p.linewidth > 0)) continue;
      }

      ctx.lineWidth = Math.max(1, Math.min(4, p.linewidth || 1));
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.setLineDash(p.linestyle === 'dashed' ? [6, 4] : p.linestyle === 'dotted' ? [2, 3] : []);
      let open = false, lastCol = null, prev = null;
      const endRun = () => { if (open) { ctx.stroke(); open = false; lastCol = null; } prev = null; };
      const seg = (q) => {
        if (q.hide) { endRun(); return; }
        if (!open) { ctx.beginPath(); ctx.strokeStyle = q.col; ctx.moveTo(q.x, q.y); open = true; lastCol = q.col; prev = q; return; }
        if (q.col !== lastCol) {
          ctx.lineTo(q.x, q.y); ctx.stroke();
          ctx.beginPath(); ctx.strokeStyle = q.col; ctx.moveTo(q.x, q.y); lastCol = q.col;
        } else if (isStep) {
          const midX = (prev.x + q.x) / 2; // stepline: the value changes at the middle of the bar
          if (p.style === 'stepline_diamond') { ctx.lineTo(midX, prev.y); ctx.lineTo(midX, q.y); } else { ctx.lineTo(midX, prev.y); ctx.lineTo(midX, q.y); }
          ctx.lineTo(q.x, q.y);
        } else ctx.lineTo(q.x, q.y);
        prev = q;
      };
      for (const q of pts) { if (q === null) endRun(); else seg(q); }
      endRun();
      if (p.style === 'stepline_diamond') { // small diamonds on each real data point
        ctx.setLineDash([]);
        for (const q of pts) if (q && !q.hide) { ctx.fillStyle = q.col; this._paintGlyph(ctx, 'diamond', q.x, q.y, 3); }
      }
    }
    ctx.setLineDash([]);
  }

  _paintShape(ctx, sh, bars, tfSec, w, force) {
    if (!this._tfOn()) return;
    if (sh && sh.key && this._shapeHidden(sh.key)) return; // ROUND143: Style-tab eye
    /* ROUND146: Style-tab location override — the script location is the
       default; an override reinterprets the bar: bar-anchored modes read
       the LIVE bar high/low (fresher than the baked eval-time value on the
       forming bar), absolute keeps the stored series price (skipped when
       the stored value isn't a price). */
    const scriptLoc = (sh && sh.loc) || 'absolute';
    const sty = this.inst.style;
    const ovLoc = sty && sty.shapes && sty.shapes[sh.key] && sty.shapes[sh.key].loc;
    const loc = ovLoc || scriptLoc;
    const relocated = ovLoc && ovLoc !== scriptLoc;
    const [from, to] = this._visRange();
    const size = SIZE_PX[sh.size] || 10;
    const r = this._paintRect(force); // ROUND 74: top/bottom anchors live in the script's pane (ROUND227: forced on main)
    /* ROUND149: arrow height normalizes over the series' full-run magnitude
       range — computed once per paint, not per bar. */
    const arrowRng = (sh && sh.isArrow) ? magRange(sh.mags) : null;
    for (let i = from; i <= to; i++) {
      let y = sh.ys[i];
      if (y === null || y === undefined) continue;
      if (relocated) {
        if (loc === 'abovebar') y = bars[i].high;
        else if (loc === 'belowbar') y = bars[i].low;
        else if (loc === 'top') y = 'top';
        else if (loc === 'bottom') y = 'bottom';
        else if (loc === 'absolute' && (typeof y !== 'number' || !isFinite(y))) continue;
      }
      const col = sh.colors[i];
      const text = sh.texts[i];
      const x = this._xOf(this._barMs(bars[i].time) + tfSec * 500);
      if (x == null || x < -20 || x > w + 20) continue;
      ctx.fillStyle = col && col.css ? col.css() : '#2962ff';
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1.4;
      if (y === 'top' || y === 'bottom') {
        this._drawShape(ctx, sh.style, x, y === 'top' ? r.top + 14 : r.top + r.h - 8, size);
        if (text) this._drawText(ctx, text, x, y === 'top' ? r.top + 12 + size : r.top + r.h - 12 - size, col);
        continue;
      }
      if (y === 'above' || y === 'below') continue; // legacy sentinel (plotarrow pre-148); arrows now carry numeric anchors
      if (!isFinite(y)) continue;
      let yPx = this._yOf(y, force);
      if (yPx == null) continue;
      let glyph = sh.style;
      if (sh && sh.isArrow) {
        /* ROUND148: one arrow site mixes up+down arrows, so the glyph comes
           from the per-bar direction (not the site style); the arrow sits
           clear of the bar edge — up below the low, down above the high.
           ROUND149: value-proportional height — |v| mapped across the
           series' own full-run range onto [minH, maxH] px (stable under
           pan); absent params keep the Style-tab size. */
        const dir = (sh.dirs && sh.dirs[i]) || (sh.style === 'arrowdown' ? 'down' : 'up');
        glyph = dir === 'down' ? 'arrowdown' : 'arrowup';
        const ah = arrowHeight(sh.mags ? sh.mags[i] : null, sh.minH, sh.maxH,
          arrowRng ? arrowRng[0] : 0, arrowRng ? arrowRng[1] : 0, size);
        yPx += (glyph === 'arrowup' ? 1 : -1) * (ah * 0.6 + 4);
        this._drawShape(ctx, glyph, x, yPx, ah);
        continue;
      }
      this._drawShape(ctx, glyph, x, yPx, size);
      if (text) this._drawText(ctx, text, x, yPx - size - 2, col);
    }
    // bar-anchored markers need the bar's high/low — second pass
    if (sh._loc === 'abovebar' || sh._loc === 'belowbar') { /* y captured at eval time */ }
  }

  _drawShape(ctx, style, x, y, size) {
    const s = size;
    ctx.beginPath();
    switch (style) {
      case 'triangleup': case 'arrowup':
        ctx.moveTo(x, y - s); ctx.lineTo(x - s * 0.9, y + s * 0.6); ctx.lineTo(x + s * 0.9, y + s * 0.6); ctx.closePath(); ctx.fill();
        break;
      case 'triangledown': case 'arrowdown':
        ctx.moveTo(x, y + s); ctx.lineTo(x - s * 0.9, y - s * 0.6); ctx.lineTo(x + s * 0.9, y - s * 0.6); ctx.closePath(); ctx.fill();
        break;
      case 'triangleleft': ctx.moveTo(x - s, y); ctx.lineTo(x + s * 0.6, y - s * 0.9); ctx.lineTo(x + s * 0.6, y + s * 0.9); ctx.closePath(); ctx.fill(); break;
      case 'triangleright': ctx.moveTo(x + s, y); ctx.lineTo(x - s * 0.6, y - s * 0.9); ctx.lineTo(x - s * 0.6, y + s * 0.9); ctx.closePath(); ctx.fill(); break;
      case 'circle':
        ctx.arc(x, y, s * 0.75, 0, Math.PI * 2); ctx.fill();
        break;
      case 'square': case 'squareleft': case 'squareright':
        ctx.fillRect(x - s * 0.7, y - s * 0.7, s * 1.4, s * 1.4);
        break;
      case 'diamond':
        ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath(); ctx.fill();
        break;
      case 'cross': case 'xcross':
        ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
        ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
        if (style === 'xcross') { ctx.moveTo(x - s, y); ctx.lineTo(x + s, y); ctx.moveTo(x, y - s); ctx.lineTo(x, y + s); }
        ctx.stroke();
        break;
      case 'flag':
        ctx.moveTo(x - s, y + s); ctx.lineTo(x - s, y - s); ctx.lineTo(x + s * 0.6, y - s * 0.5); ctx.lineTo(x - s, y); ctx.stroke();
        break;
      case 'arrowleft': case 'arrowright':
        ctx.moveTo(x + (style === 'arrowleft' ? s : -s), y);
        ctx.lineTo(x - (style === 'arrowleft' ? s : -s), y - s * 0.7);
        ctx.lineTo(x - (style === 'arrowleft' ? s : -s), y + s * 0.7);
        ctx.closePath(); ctx.fill();
        break;
      case 'labelup': case 'labeldown': {
        const up = style === 'labelup';
        ctx.moveTo(x, up ? y - s : y + s);
        ctx.lineTo(x - s, up ? y + s : y - s);
        ctx.lineTo(x + s, up ? y + s : y - s);
        ctx.closePath(); ctx.fill();
        break;
      }
      default:
        ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
    }
  }

  _drawText(ctx, text, x, y, col) {
    ctx.font = '10px Segoe UI, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = col && col.css ? col.css() : '#d1d4dc';
    ctx.fillText(String(text), x, y);
  }

  _stylePx(obj, colorField) {
    const c = obj[colorField];
    return c && c.css ? c.css() : null;
  }

  _paintBox(ctx, o) {
    const pane = this.pane;
    const x1 = this._xOf(this._objMs(o, o.left)), x2 = this._xOf(this._clampSessionEdge(o, 'right', 'left'));
    const y1 = this._yOf(o.top, o.force_overlay), y2 = this._yOf(o.bottom, o.force_overlay);
    if (x1 == null || x2 == null || y1 == null || y2 == null) return;
    let left = Math.min(x1, x2), right = Math.max(x1, x2);
    /* ROUND200 (box extend, TV parity): extended edges run to the pane sides
       (same edge convention as _lineEnds). Applied before the cull so an
       off-view box with extend still paints its visible stretch. */
    const ext = o.extend || 'none';
    if (ext === 'left' || ext === 'both') left = -1;
    if (ext === 'right' || ext === 'both') right = this.pane.host.clientWidth + 2;
    const top = Math.min(y1, y2), bot = Math.max(y1, y2);
    const w = pane.host.clientWidth, mainH = pane._mainPlotH > 0 ? pane._mainPlotH : Math.max(10, pane.host.clientHeight - 26);
    if (right < -40 || left > w + 40) return;
    // fill
    const bg = this._stylePx(o, 'bgcolor');
    if (bg && bg !== 'rgba(0,0,0,0)') {
      ctx.fillStyle = bg;
      ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bot - top));
    }
    // border
    const bc = this._stylePx(o, 'border_color');
    if (bc) {
      ctx.strokeStyle = bc;
      ctx.lineWidth = Math.max(1, o.border_width || 1);
      ctx.setLineDash(o.border_style === 'dashed' ? [6, 4] : o.border_style === 'dotted' ? [2, 3] : []);
      ctx.strokeRect(left, top, Math.max(1, right - left), Math.max(1, bot - top));
      ctx.setLineDash([]);
    }
    // box text
    if (o.text) {
      /* ROUND224 (TV parity): int point sizes + text_formatting (bold/italic). */
      const bpx = (typeof o.text_size === 'number' && isFinite(o.text_size)) ? o.text_size : (SIZE_PX[o.text_size] || 11);
      const bfmt = o.text_formatting || 'none';
      ctx.font = (bfmt === 'italic' || bfmt === 'bold_italic' ? 'italic ' : '') + (bfmt === 'bold' || bfmt === 'bold_italic' ? 'bold ' : '') + bpx + 'px Segoe UI, Arial, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = this._stylePx(o, 'text_color') || '#d1d4dc';
      ctx.fillText(o.text, (left + right) / 2, (top + bot) / 2);
      ctx.textBaseline = 'alphabetic';
    }
  }

  /* ---- ROUND87: Custom Session edge clamp for script-owned drawings ----
     On a stitched chart the world only exists inside the user's daily
     window, so a box/line whose FAR edge lands past its own day's window
     end (786 Zones "End of Day" = 21:00 GMT, "Fixed" = start + N minutes)
     must stop at that region end instead of spilling through the day gap
     toward the next region. An edge that reaches the END OF THE CHART
     (time_close of the last bar — the "End of Chart" extend mode) passes
     through untouched. Pure pass-through while Custom Session is off. */

  _sessClampState(w) {
    const pane = this.pane;
    const off = (this.rt && this.rt.env && this.rt.env.serverOffSec) || 0;
    /* region ends are keyed by bar TIME — pane.barTimes (numbers); pane.bars
       holds bar OBJECTS and would poison the day math with NaN */
    const times = (pane.barTimes && pane.barTimes.length) ? pane.barTimes
      : (pane.bars || []).map((b) => b.time);
    const tfSec = (App.tfById[pane.tf] || {}).sec || 60;
    /* ROUND88: region days follow the CHART timezone (the window the user
       entered); the map is keyed by WALL day, lookups convert the anchor */
    const hook = App.sessionHook;
    const shift = (hook && hook.shift && hook.shift()) || null;
    const key = times.length + ':' + (times.length ? times[0] + '/' + times[times.length - 1] : '') +
      ':' + w.sFrom + '/' + w.sTo + ':' + tfSec + ':' + pane.tf + ':' + pane.symbol + ':' + App.tz + ':' + off;
    if (this._sessKey === key) return this._sessClamp;
    const ends = sessionRegionEnds(times, tfSec, w.sTo / 3600, (w.sTo % 3600) / 60, shift);
    const st = {
      ends,
      offSec: off,
      shift,
      chartEndSec: times.length ? times[times.length - 1] + tfSec : 0,
    };
    this._sessKey = key;
    this._sessClamp = st;
    return st;
  }

  /** far edge (ms, true-UTC Pine frame) clamped to the anchor's day region */
  _clampSessionEdge(o, edgeField, anchorField) {
    if (o.xloc !== 'bar_time') return this._objMs(o, o[edgeField]); // bar_index: no session clamp
    const tMs = o[edgeField];
    const hook = App.sessionHook;
    if (!hook || !hook.active || !hook.active()) return tMs;
    if (o.xloc && o.xloc !== 'bar_time') return tMs;
    const w = hook.windowSec && hook.windowSec();
    if (!w || !(w.sTo > w.sFrom)) return tMs;
    const st = this._sessClampState(w);
    if (!st.chartEndSec || !st.ends.size) return tMs;
    const anchorMs = o[anchorField];
    if (!isFinite(tMs) || !isFinite(anchorMs)) return tMs;
    const tSec = tMs / 1000 + st.offSec;
    /* End of Chart: time_close of the last bar — allow through (float-exact:
       (t - off) + off is integer-exact for these magnitudes) */
    if (tSec >= st.chartEndSec) return tMs;
    const aSec = anchorMs / 1000 + st.offSec;
    /* ROUND88: region days are WALL days in the chart timezone */
    const sh = st.shift ? st.shift(aSec) : 0;
    const day = Math.floor((aSec + sh) / 86400) * 86400;
    const end = st.ends.get(day);
    if (end != null && tSec > end) return (end - st.offSec) * 1000;
    return tMs;
  }

  /* ROUND141: objects created with xloc.bar_index carry BAR INDICES, but _xOf
     wants a time in ms. Every painter used to pass the index straight through,
     so bar_index-anchored lines/boxes/labels/polylines landed at 1970. Convert
     via the chart's bar times (extrapolating past either end by one bar step). */
  _objMs(o, v) {
    if (v == null || !isFinite(v)) return v;
    if (o && o.xloc === 'bar_time') return v;
    const pane = this.pane;
    const times = pane.barTimes;
    if (!times || !times.length) return v;
    const off = (this.rt && this.rt.env && this.rt.env.serverOffSec) || 0;
    const step = (times.length > 1) ? (times[times.length - 1] - times[0]) / (times.length - 1) : 60;
    const i = Math.round(v);
    let tSec;
    if (i < 0) tSec = times[0] + i * step;
    else if (i >= times.length) tSec = times[times.length - 1] + (i - times.length + 1) * step;
    else tSec = times[i];
    return (tSec - off) * 1000;
  }

  /* ROUND141: line endpoints in pixels, with extend left/right/both applied
     (the line is extended along its own slope to the pane edges).
     ROUND223: force routes y through the main series (force_overlay). */
  _lineEnds(o, force) {
    const x1 = this._xOf(this._objMs(o, o.x1)), x2 = this._xOf(this._clampSessionEdge(o, 'x2', 'x1'));
    const y1 = this._yOf(o.y1, force), y2 = this._yOf(o.y2, force);
    if (x1 == null || x2 == null || y1 == null || y2 == null) return null;
    let a = [x1, y1], b = [x2, y2];
    const ext = o.extend || 'none';
    if (ext !== 'none' && (x1 !== x2 || y1 !== y2)) {
      const W = this.pane.host.clientWidth + 2, dx = x2 - x1, dy = y2 - y1;
      const at = (x) => (dx === 0 ? null : y1 + (dy / dx) * (x - x1));
      const wantR = ext === 'right' || ext === 'both', wantL = ext === 'left' || ext === 'both';
      if (dx === 0) { // vertical: extend along y to the pane edges
        const H = this.pane.host.clientHeight;
        if (wantR) { if (dy >= 0) b = [x2, H]; else b = [x2, 0]; }
        if (wantL) { if (dy >= 0) a = [x1, 0]; else a = [x1, H]; }
      } else {
        const right = dx > 0 ? b : a, left = dx > 0 ? a : b;
        if (wantR) { const t = [W, at(W)]; if (dx > 0) b = t; else a = t; }
        if (wantL) { const t = [-1, at(-1)]; if (dx > 0) a = t; else b = t; }
      }
    }
    return { a, b, x1, y1, x2, y2 };
  }

  _paintLine(ctx, o) {
    const e = this._lineEnds(o, o.force_overlay);
    if (!e) return;
    const col = this._stylePx(o, 'color') || '#2962ff';
    ctx.strokeStyle = col; ctx.fillStyle = col;
    ctx.lineWidth = Math.max(1, o.width || 1);
    ctx.setLineDash(o.style === 'dashed' ? [6, 4] : o.style === 'dotted' ? [2, 3] : []);
    ctx.beginPath(); ctx.moveTo(e.a[0], e.a[1]); ctx.lineTo(e.b[0], e.b[1]); ctx.stroke();
    ctx.setLineDash([]);
    // arrow heads (line.style_arrow_left / right / both)
    const head = (from, to) => {
      const ang = Math.atan2(to[1] - from[1], to[0] - from[0]), s = 5 + ctx.lineWidth * 2;
      ctx.beginPath();
      ctx.moveTo(to[0], to[1]);
      ctx.lineTo(to[0] - s * Math.cos(ang - 0.45), to[1] - s * Math.sin(ang - 0.45));
      ctx.lineTo(to[0] - s * Math.cos(ang + 0.45), to[1] - s * Math.sin(ang + 0.45));
      ctx.closePath(); ctx.fill();
    };
    const st = o.style || '';
    if (st === 'arrow_right' || st === 'arrow_both') head([e.x1, e.y1], [e.x2, e.y2]);
    if (st === 'arrow_left' || st === 'arrow_both') head([e.x2, e.y2], [e.x1, e.y1]);
  }

  /* linefill: the quad between two script lines, re-read every frame so it
     follows the lines when they move (TV: no manual update needed). */
  _paintLinefill(ctx, o) {
    if (!o.line1 || !o.line2 || o.line1.deleted || o.line2.deleted) return;
    /* ROUND223: a forced constituent line drags the fill's coords with it. */
    const a = this._lineEnds(o.line1, o.line1.force_overlay), b = this._lineEnds(o.line2, o.line2.force_overlay);
    const col = this._stylePx(o, 'color');
    if (!a || !b || !col || col === 'rgba(0,0,0,0)') return;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(a.a[0], a.a[1]); ctx.lineTo(a.b[0], a.b[1]);
    ctx.lineTo(b.b[0], b.b[1]); ctx.lineTo(b.a[0], b.a[1]);
    ctx.closePath(); ctx.fill();
  }

  /* polyline: straight segments or a smooth (Catmull-Rom -> bezier) curve,
     optional closing segment and fill. */
  _paintPolyline(ctx, o) {
    const pts = [];
    for (const p of o.points) {
      const x = this._xOf(this._objMs(o, p.x)), y = this._yOf(p.y);
      if (x == null || y == null) return; // an off-range point: skip the whole shape rather than distort it
      pts.push([x, y]);
    }
    if (pts.length < 2) return;
    const path = () => {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      const n = pts.length;
      if (!o.curved) {
        for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      } else {
        const cnt = o.closed ? n : n - 1;
        for (let i = 0; i < cnt; i++) {
          const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
          const q0 = (o.closed || i > 0) ? p0 : p1, q3 = (o.closed || i < n - 2) ? p3 : p2;
          ctx.bezierCurveTo(p1[0] + (p2[0] - q0[0]) / 6, p1[1] + (p2[1] - q0[1]) / 6,
            p2[0] - (q3[0] - p1[0]) / 6, p2[1] - (q3[1] - p1[1]) / 6, p2[0], p2[1]);
        }
      }
      if (o.closed) ctx.closePath();
    };
    const fill = this._stylePx(o, 'fill_color');
    if (fill && fill !== 'rgba(0,0,0,0)') { path(); ctx.fillStyle = fill; ctx.fill(); }
    const col = this._stylePx(o, 'line_color') || '#2962ff';
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, o.line_width || 1);
    ctx.setLineDash(o.line_style === 'dashed' ? [6, 4] : o.line_style === 'dotted' ? [2, 3] : []);
    path(); ctx.stroke(); ctx.setLineDash([]);
  }

  /* ROUND141: shape-type label styles (xcross, cross, flag, square, diamond,
     triangleup, triangledown) are markers, not bubbles: glyph on the anchor,
     text beside it. `none` is text only. Everything else is the classic bubble. */
  _paintGlyph(ctx, kind, x, y, r) {
    ctx.beginPath();
    switch (kind) {
      case 'xcross': ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke(); return;
      case 'cross': ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke(); return;
      case 'square': ctx.rect(x - r, y - r, 2 * r, 2 * r); break;
      case 'diamond': ctx.moveTo(x, y - r * 1.3); ctx.lineTo(x + r * 1.3, y); ctx.lineTo(x, y + r * 1.3); ctx.lineTo(x - r * 1.3, y); ctx.closePath(); break;
      case 'triangleup': ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); ctx.closePath(); break;
      case 'triangledown': ctx.moveTo(x, y + r); ctx.lineTo(x + r, y - r); ctx.lineTo(x - r, y - r); ctx.closePath(); break;
      case 'flag': ctx.moveTo(x, y + r); ctx.lineTo(x, y - r * 1.4); ctx.lineTo(x + r * 1.6, y - r * 0.7); ctx.lineTo(x, y); ctx.closePath(); break;
      default: return;
    }
    ctx.fill();
  }

  _paintLabel(ctx, o) {
    const pane = this.pane;
    const x = this._xOf(this._objMs(o, o.x));
    const y = this._yOf(o.y, o.force_overlay);
    if (x == null || y == null) return;
    const text = o.text == null ? '' : String(o.text);
    /* ROUND224: size takes an int point size too (v6). */
    const px = (typeof o.size === 'number' && isFinite(o.size)) ? o.size : (SIZE_PX[o.size] || 11);
    const fmt = o.text_formatting || 'none';
    const mono = o.text_font_family === 'monospace';
    ctx.font = (fmt === 'italic' || fmt === 'bold_italic' ? 'italic ' : '') + (fmt === 'bold' || fmt === 'bold_italic' ? 'bold ' : '') + px + 'px ' + (mono ? 'Consolas, monospace' : 'Segoe UI, Arial, sans-serif');
    const lines = text.split('\n');
    const tw = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
    const lh = px + 2, th = lines.length * lh;
    const tcol = this._stylePx(o, 'textcolor') ||
      /* ROUND225 (TV parity): label.new() default text is white in v6, black
         in v5 and older (migration guide). */
      ((this.rt && this.rt.meta && (this.rt.meta.version || 5) >= 6) ? '#ffffff' : '#000000');
    const align = o.textalign === 'left' ? 'left' : o.textalign === 'right' ? 'right' : 'center';
    const drawText = (cx, cy, colr) => {
      ctx.fillStyle = colr; ctx.textBaseline = 'middle';
      lines.forEach((l, i) => {
        const ty = cy - th / 2 + lh * i + lh / 2;
        ctx.textAlign = align;
        const tx = align === 'left' ? cx - tw / 2 : align === 'right' ? cx + tw / 2 : cx;
        ctx.fillText(l, tx, ty);
      });
      ctx.textBaseline = 'alphabetic';
    };
    const st = o.style || 'label_down';
    const bg = this._stylePx(o, 'color');
    const hasBg = bg && bg !== 'rgba(0,0,0,0)';
    if (st === 'none') { drawText(x, y, tcol); return; }
    const glyph = ['xcross', 'cross', 'flag', 'square', 'diamond', 'triangleup', 'triangledown'].indexOf(st) >= 0;
    if (glyph) {
      const r = Math.max(3, px / 2.2);
      ctx.fillStyle = hasBg ? bg : '#2962ff'; ctx.strokeStyle = hasBg ? bg : '#2962ff'; ctx.lineWidth = 2;
      this._paintGlyph(ctx, st, x, y, r);
      if (text) drawText(x, y + (st === 'triangleup' || st === 'square' || st === 'cross' || st === 'xcross' || st === 'diamond' ? r + th / 2 + 3 : -(r + th / 2 + 3)), tcol);
      return;
    }
    // bubble: tail direction from the style name
    const bw2 = tw + 10, bh2 = th + 6;
    let bx, by, tail = null; // tail = [tipX, tipY, baseA, baseB]
    const gap = 8;
    if (st === 'label_up') { bx = x - bw2 / 2; by = y + gap; tail = [x, y, [x - 4, by], [x + 4, by]]; }
    else if (st === 'label_left') { bx = x + gap; by = y - bh2 / 2; tail = [x, y, [bx, y - 4], [bx, y + 4]]; }
    else if (st === 'label_right') { bx = x - gap - bw2; by = y - bh2 / 2; tail = [x, y, [bx + bw2, y - 4], [bx + bw2, y + 4]]; }
    else if (st === 'label_center') { bx = x - bw2 / 2; by = y - bh2 / 2; }
    else if (st === 'label_lower_left') { bx = x - bw2 - 2; by = y - bh2 - 2; }
    else if (st === 'label_lower_right') { bx = x + 2; by = y - bh2 - 2; }
    else if (st === 'label_upper_left') { bx = x - bw2 - 2; by = y + 2; }
    else if (st === 'label_upper_right') { bx = x + 2; by = y + 2; }
    else { bx = x - bw2 / 2; by = y - bh2 - gap; tail = [x, y, [x - 4, by + bh2], [x + 4, by + bh2]]; } // label_down (default)
    if (hasBg) {
      ctx.fillStyle = bg;
      ctx.beginPath();
      const r = 3;
      ctx.moveTo(bx + r, by);
      ctx.arcTo(bx + bw2, by, bx + bw2, by + bh2, r);
      ctx.arcTo(bx + bw2, by + bh2, bx, by + bh2, r);
      ctx.arcTo(bx, by + bh2, bx, by, r);
      ctx.arcTo(bx, by, bx + bw2, by, r);
      ctx.closePath(); ctx.fill();
      if (tail) {
        ctx.beginPath(); ctx.moveTo(tail[2][0], tail[2][1]); ctx.lineTo(tail[0], tail[1]); ctx.lineTo(tail[3][0], tail[3][1]);
        ctx.closePath(); ctx.fill();
      }
    }
    drawText(bx + bw2 / 2, by + bh2 / 2, tcol);
  }

  /* ========================= legend row ========================= */

  updateLegendValues(hoverTime) {
    const pane = this.pane;
    const rt = this.rt;
    if (!rt || !this.legEl) return;
    /* ROUND140: eye-off clears the value pills too (TV shows the grey title only) */
    if (!this._tfOn()) { this.legEl.innerHTML = ''; return; }
    /* ROUND143: "Values in status line" off hides the pills like eye-off */
    if (!this._statusValues()) { this.legEl.innerHTML = ''; return; }
    const bars = pane.bars;
    let idx = bars.length - 1;
    if (hoverTime != null && pane.barTimes.length) idx = U.nearestIndex(pane.barTimes, hoverTime);
    const parts = [];
    const colors = [];
    /* ROUND166 (TV "Inputs in status line", default on): input values lead
       the legend, values-only like TV. Colors have no text form — skipped.
       Enum objects (size.tiny defvals) display as payloads. */
    if (this._statusInputs() && rt.inputDefs) {
      for (const d of rt.inputDefs) {
        if (!d || d.kind === 'color') continue;
        let v = (this.inst.inputs && this.inst.inputs[d.id] != null) ? this.inst.inputs[d.id] : d.defval;
        if (v && v.__pineEnum && v.payload != null) v = v.payload;
        if (v == null || typeof v === 'object') continue;
        if (typeof v === 'boolean') v = v ? 'true' : 'false';
        parts.push(`<b>${U.esc(String(v))}</b>`);
        colors.push('#787B86');
      }
    }
    const precOv = this._stylePrecision();
    for (const key of this._out().plotsOrder) {
      const p = this._out().plots.get(key);
      if (this._plotHidden(key)) continue; // ROUND143: Style-tab eye
      const v = idx >= 0 ? p.values[idx] : null;
      if (v == null || !isFinite(v)) continue;
      if (idx >= 0 && p.colors[idx] && p.colors[idx].a === 0) continue; // colour=na: hidden on this bar
      colors.push((p.colors[idx] && p.colors[idx].css) ? p.colors[idx].css() : '#2962ff');
      const pr = precOv != null ? precOv : (p.precision != null ? p.precision : Math.min(8, Math.max(2, (pane.digits || 5) + 1)));
      parts.push(`<b>${v.toFixed(pr)}</b>`); // ROUND142: plot(precision=)
    }
    this.legEl.innerHTML = parts.join(' ');
    // round 81 CSP hardening: per-plot color set via CSSOM (el.style.color),
    // not a style="" attribute, so style-src no longer needs 'unsafe-inline'.
    const bEls = this.legEl.children;
    for (let i = 0; i < bEls.length; i++) bEls[i].style.color = colors[i];
  }
}

/* tiny helper: bg canvas accessor (avoids reordering in _paintBg) */
function pc_bg(pane) { return pane._pineCanvases.bg; }

export { PineRenderAdapter };
