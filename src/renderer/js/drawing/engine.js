/**
 * Drawing engine: overlay canvas + interactions
 *
 * All drawings are stored as {type, points:[{t,p}], opts} anchored to time+price,
 * so they stay locked to chart coordinates and never drift on their own.
 *
 * @module drawing/engine
 */

import { U } from '../core/util.js';
import { Log } from '../../../core/logger.js';
import { TZ } from '../../../core/timezone.js';
import { Theme } from '../core/theme.js';
import { App } from '../../../core/state.js';
import { Settings } from '../chart/settings.js';
import { DrawSettings } from './settings.js';
import { TOOLS } from './tools.js';
import { Manager } from '../chart/manager.js';
import { UI } from './ui.js';
import { Alerts } from '../panels/alerts.js'; /* ROUND51: alert select/drag/delete */
import { sessionRegions } from '../../../core/session-math.js'; /* ROUND90: session axis region cut */

const HIT = 7;
  const MAGNET_PX = 7; // TV weak magnet: snap only within this pixel radius
  /* ROUND80 (user request): four magnet strengths — off / weak / medium /
     strong. weak keeps the TV 7px feel, medium widens the capture radius
     (~2.4x) for coarser aims, strong always locks to the nearest OHLC of the
     hovered bar (TV strong). The SAME radius drives (a) drawing-point
     snapping (snap()) and (b) the hover crosshair snap (_magnetSnapY), so
     what the user SEES while aiming is exactly where the point will land. */
  const MAGNET_RADIUS = { weak: MAGNET_PX, medium: Math.round(MAGNET_PX * 2.4), strong: Infinity };
  function magnetRadius(mode) { return MAGNET_RADIUS[mode] != null ? MAGNET_RADIUS[mode] : MAGNET_PX; }

  class Engine {
    constructor(pane) {
      this.pane = pane;
      this.canvas = pane.overlay;
      this.ctx = this.canvas.getContext('2d');
      this.mode = 'idle';
      this.temp = null;
      this.handleIdx = -1;
      this.bodyDrag = null;
      this.mouse = { x: -1, y: -1, inside: false };
      /* ROUND58: timestamp of the last REAL overlay mousemove — the LWC
         crosshair subscription (manager.js) only delegates sync for events
         that follow genuine pointer activity, so data-tick / programmatic
         echoes can never re-drive the other panes (the multi-chart jump). */
      this._lastMouseMove = 0;
      this.downPt = null;
      this.moved = false;
      this.replayPick = null;
      /* BUG-C/R25 → round 31: crosshair state for the live time bubble + the
         custom vertical line. The NATIVE crosshair bubble is painted on the
         lib canvas, which sits UNDER the .tax-ext DOM strip — the static
         labels covered it (user round-25 screenshot). The native vertLine is
         DISABLED (manager.js/settings.js) and the engine paints the vertical
         line + the .tax-live pill itself.
         Round 31: the state is driven by the RAW cursor (Engine.move), NOT by
         subscribeCrosshairMove — param.point is the lib's SNAPPED/CLAMPED
         crosshair position, and LWC clamps future times to the LAST bar
         (timeToIndex findNearest), which pinned line + pill at the live
         market ("crosshair gets stuck at the live bar") and made the
         time-axis highlight lag behind the price-axis one. Shape:
           { on, x, y }          raw cursor tracking (local hover)
           { on, x, y, t }       synced from another pane (t = source time) */
      this._cross = { on: false, x: -1, y: -1 };
      this._bind();
    }
    /* theme-aware canvas chrome (dark/light, round 19) — safe without Theme */
    _th(k, fallback) { return (Theme.c) ? Theme.c(k) : fallback; }

    /* ---------- coordinate mapping ---------- */
    /* ROUND90: the array LWC's logical frame actually indexes. On Custom
       Session panes the series carries whitespace gap rows between day
       regions, so LWC's logical indices COUNT them — every time↔logical
       conversion below MUST run over the GAP-INCLUSIVE axis
       (pane._sessWithGapTimes), otherwise everything after the first day
       boundary lands GAP_BARS slots left of its bar (the exact frame bug
       round-87 fixed for Pine drawings — one time axis everywhere). Outside
       session mode this returns pane.barTimes and every path stays
       byte-identical to before. */
    _timeArr() {
      const hook = App.sessionHook;
      const p = this.pane;
      return (hook && hook.active && hook.active() && p._sessWithGapTimes &&
              p._sessGapIdx && p._sessGapIdx.length === p._sessWithGapTimes.length)
        ? p._sessWithGapTimes : p.barTimes;
    }
    _xOf(t) {
      // lib's logicalToCoordinate only accepts integers — interpolate via integer anchor + barSpacing
      const ts = this.pane.chart.timeScale();
      const l = U.timeToLogical(this._timeArr(), t);
      const i0 = Math.floor(l);
      const a = ts.logicalToCoordinate(i0);
      if (a == null) return -200;
      if (l === i0) return a;
      let sp = 8;
      try { sp = ts.options().barSpacing || 8; } catch (e) {}
      return a + (l - i0) * sp;
    }
    _tOf(x) {
      const l = this.pane.chart.timeScale().coordinateToLogical(x);
      if (l == null) return 0;
      return U.logicalToTime(this._timeArr(), l);
    }
    _lOf(x) { return this.pane.chart.timeScale().coordinateToLogical(x); }
    /* ROUND246: FRACTIONAL logical for magnet-off placement — this LWC build
       rounds coordinateToLogical to whole bars, which would pin every
       "free" anchor to a bar anyway. The visible range maps linearly over
       the canvas width, so the fraction survives. Falls back to _lOf. */
    _lFreeOf(x) {
      try {
        const ts = this.pane.chart.timeScale();
        const lr = ts.getVisibleLogicalRange();
        const w = this.canvas.clientWidth;
        if (!lr || !w || !(lr.to > lr.from)) return this._lOf(x);
        return lr.from + (x / w) * (lr.to - lr.from);
      } catch (e) { return this._lOf(x); }
    }

    /* ---------- round 32: sub-pane helpers ----------
       The sub-pane rect containing overlay-space y (null = price pane). */
    _subAt(y) {
      const rects = this.pane._subRects;
      if (!rects || !rects.length) return null;
      for (const r of rects) { if (y >= r.top && y < r.top + r.h) return r; }
      return null;
    }
    _clearSubCross() {
      const subs = this.pane._subs;
      if (!subs) return;
      for (const s of subs.values()) { try { s.chart.clearCrosshairPosition(); } catch (e) {} }
    }
    /* route the native horzLine + axis label to the pane under the cursor:
       price pane -> main series, indicator pane -> that sub-chart's series
       (TV: every pane tracks the cursor price on its own scale).
       ROUND58: each programmatic set stamps a 100ms deadman window
       (pane._xsyncUntil) — LWC fires subscribeCrosshairMove DEFERRED for
       this very call, after the synchronous turn; without the stamp the
       late event re-synced the other panes from LWC's bar-SNAPPED time and
       their crosshair jumped between the two positions on every hover. */
    _setCrossXY(v, x, y, t) {
      const pane = this.pane;
      pane._xsyncUntil = performance.now() + 100;
      const sub = this._subAt(y);
      try {
        if (sub && sub.first) {
          const localY = y - sub.top;
          const p = sub.first.coordinateToPrice(localY);
          try { pane.chart.clearCrosshairPosition(); } catch (e) {}
          const subs = pane._subs;
          if (subs) for (const s2 of subs.values()) {
            if (s2.chart === sub.chart) continue;
            try { s2.chart.clearCrosshairPosition(); } catch (e) {}
          }
          if (p != null) sub.chart.setCrosshairPosition(p, t, sub.first);
        } else {
          const p = pane.series.coordinateToPrice(y);
          this._clearSubCross();
          if (p != null) pane.chart.setCrosshairPosition(p, t, pane.series);
        }
      } catch (e) {}
    }

    view() {
      const pane = this.pane;
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      let axisW = 62, timeH = 26;
      try {
        axisW = pane.chart.priceScale('right').width() || axisW;
        timeH = pane.chart.timeScale().height() || timeH;
      } catch (e) {}
      const self = this;
      let spacing = 8;
      try { spacing = pane.chart.timeScale().options().barSpacing || 8; } catch (e) {}
      /* round 32: with indicator sub-panes the OVERLAY covers the whole stack;
         `ph` stays the full plot height (vertical grid / separators / the
         crosshair vertical span EVERY pane, like TV) while `mainH` is the
         price pane's own plot height (drawings + price mapping live there). */
      const mainH = pane._mainPlotH > 0 ? pane._mainPlotH : Math.max(10, h - timeH);
      return {
        ctx: this.ctx, w, h, pw: Math.max(10, w - axisW), ph: Math.max(10, h - timeH),
        mainH, axisW, timeH, digits: pane.digits, times: pane.barTimes, mouse: this.mouse, spacing,
        bars: pane.bars,
        /* ROUND66: the DOM time-axis highlight layer (always ABOVE the .tax-ext
           numbers — see .tax-tags) — timeTag() and the news pills append here */
        taxTags: pane.taxTags,
        /* axis-tag queue: labels drawn INSIDE the price/time axis strips (hline
           price tag, vline time tag) are collected here and flushed by render()
           AFTER the plot-area clip is popped - drawings stay UNDER the axis bar */
        axisQueue: [],
        tfSec: App.tfById[pane.tf] ? App.tfById[pane.tf].sec : 60,
        xOf: (t) => self._xOf(t),
        yOf: (p) => pane.series.priceToCoordinate(p),
        tOf: (x) => self._tOf(x),
        pOf: (y) => pane.series.coordinateToPrice(y),
        lOf: (x) => self._lOf(x),
      };
    }

    /* ---------- snapping + magnet (TV Magnet Mode) ----------
       off    — raw cursor price
       weak   — snaps to the bar's O/H/L/C only when the cursor is within
                MAGNET_PX pixels of that value (TV weak magnet)
       medium — same rule with a ~2.4x capture radius (ROUND80)
       strong — always snaps to the nearest O/H/L/C of the bar under the
                cursor (TV strong magnet)
       Holding Alt temporarily disables the magnet (TV behaviour). */
    snap(x, y) {
      const pane = this.pane;
      const arr = this._timeArr();
      const gap = (arr !== pane.barTimes) ? pane._sessGapIdx : null;
      const l = this._lOf(x);
      const mode = App.magnetMode;
      /* ROUND246 (TV parity): magnet OFF means free placement — time used to
         round to the nearest bar even with the magnet off (the default mode),
         so drawings could never sit between bars. */
      const free = !mode || mode === 'off';
      let t = 0;
      if (l != null) {
        if (free) {
          t = U.logicalToTime(arr, this._lFreeOf(x));
        } else {
          let li = Math.round(l);
          if (gap) {
            /* ROUND90: never anchor a drawing to a whitespace gap slot — walk
               left to the nearest REAL bar (gap runs sit strictly BETWEEN two
               day regions, so slot 0 and the last slot are always real bars) */
            if (li >= arr.length) li = arr.length - 1;
            if (li < 0) li = 0;
            while (li > 0 && gap[li]) li--;
          }
          if (li >= 0 && li < arr.length) t = arr[li];
          else t = U.logicalToTime(arr, l);
        }
      }
      let p = pane.series.coordinateToPrice(y);
      if (mode && mode !== 'off' && !App.altDown && p != null) {
        const li = U.nearestIndex(pane.barTimes, t);
        const b = pane.bars[li];
        if (b) {
          const R = magnetRadius(mode); // ROUND80: per-strength radius
          let best = null, bd = Infinity;
          for (const v of [b.open, b.high, b.low, b.close]) {
            if (v == null || !isFinite(v)) continue;
            const yv = pane.series.priceToCoordinate(v);
            const d = yv == null ? Math.abs(v - p) : Math.abs(yv - y); // pixel distance (log-scale safe)
            if (d < bd) { bd = d; best = v; }
          }
          if (best != null && bd <= R) p = best;
        }
      }
      return { t, p: p == null ? 0 : p };
    }

    /** ROUND80 (hover magnet): the CROSSHAIR's price half snaps to the
     *  hovered bar's O/H/L/C while the user aims — the same per-strength
     *  radius snap() uses for the committed point, so the crosshair preview
     *  and the landed drawing point always agree. Returns the snapped
     *  PIXEL y (nearest OHLC projected through priceToCoordinate) or null
     *  when nothing is in range (raw cursor wins). */
    _magnetSnapY(x, y) {
      const pane = this.pane;
      try {
        const mode = App.magnetMode;
        if (!mode || mode === 'off') return null;
        const l = this._lOf(x);
        if (l == null) return null;
        /* ROUND90: the bar under the cursor via the session-consistent
           time funnel (nearestIndex over the compact bars) — the raw LWC
           logical would index pane.bars 3 bars off per crossed boundary */
        const li = U.nearestIndex(pane.barTimes, this._tOf(x));
        if (li < 0 || li >= pane.bars.length) return null;
        const b = pane.bars[li];
        if (!b) return null;
        const R = magnetRadius(mode);
        let best = null, bd = Infinity;
        for (const v of [b.open, b.high, b.low, b.close]) {
          if (v == null || !isFinite(v)) continue;
          const yv = pane.series.priceToCoordinate(v);
          if (yv == null || !isFinite(yv)) continue;
          const d = Math.abs(yv - y);
          if (d < bd) { bd = d; best = yv; }
        }
        return (best != null && bd <= R) ? best : null;
      } catch (e) { return null; }
    }

    /* ---------- events ---------- */
    _bind() {
      const cv = this.canvas;
      const rel = (e) => {
        const r = cv.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      };
      cv.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const p = rel(e);
        this.mouse = { x: p.x, y: p.y, inside: true };
        this.down(p.x, p.y);
      });
      cv.addEventListener('mousemove', (e) => {
        const p = rel(e);
        this.mouse = { x: p.x, y: p.y, inside: true };
        this._lastMouseMove = performance.now(); /* ROUND58: freshness for the sync sub */
        this.move(p.x, p.y);
      });
      cv.addEventListener('mouseleave', (e) => {
        /* ROUND50 (user report): the pointer merely stepped onto pane UI —
           the (+) button, the price-scale strip (LWC's own axis elements are
           pane-root children too), the pill — keep the ENTIRE hover state
           alive (crosshair state, pills, lines, engine.mouse) so the pair
           survives every render while the user aims at it; it used to die
           mid-approach and the menu could never be opened. Everything below
           runs only when the pointer has truly left the pane. */
        const rt50 = e && e.relatedTarget;
        if (rt50 && this.pane.root && this.pane.root.contains(rt50)) return;
        this.mouse.inside = false;
        /* BUG-C/R25: leaving the pane must kill the live crosshair bubble —
           LWC does not always re-notify on clearCrosshairPosition */
        this._cross = { on: false, x: -1 };
        /* ROUND58: deadman stamp — absorb the deferred LWC echo of the clear
           below (it would re-run the sync-clear with stale event data) */
        this.pane._xsyncUntil = performance.now() + 100;
        this._paxLastY = null; /* ROUND50: no pin after a true leave */
        if (this.pane.taxLive) this.pane.taxLive.style.display = 'none';
        /* ROUND49: the price pill + (+) button die with the hover — unless
           the (+) menu is open (frozen) */
        if (this.pane.paxLive && this.pane.paxLive.style.display !== 'none' && !this.pane._paxFrozen) this.pane.paxLive.style.display = 'none';
        if (this.pane.paxAdd && this.pane.paxAdd.style.display !== 'none' && !this.pane._paxFrozen) this.pane.paxAdd.style.display = 'none';
        try { this.pane.chart.clearCrosshairPosition(); } catch (e) {}
        /* round 32: indicator sub-panes drop their horzLines too */
        this._clearSubCross();
        if (Manager.syncCrossClear) Manager.syncCrossClear(this.pane);
      });
      cv.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const p = rel(e);
        this.dbl(p.x, p.y, e);
      });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const p = rel(e);
        this.wheel(p.x, p.y, e);
      }, { passive: false });
      cv.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        /* ROUND246 (TV parity): a right-click aborts the in-progress drawing
           instead of opening the chart menu — the tool stays armed. */
        if (this.temp) {
          this.cancelCreate();
          if (UI.onToolDone) UI.onToolDone();
          return;
        }
        /* ROUND39: chart-position info for the context menu (Add Alert at
           price / Add Time Alert at bar / manage near an existing mark) */
        let info = null;
        try {
          const r = cv.getBoundingClientRect();
          const x = e.clientX - r.left, y = e.clientY - r.top;
          const v = this._view || null;
          let price = null;
          try { price = this.pane.series.coordinateToPrice(y); } catch (er) { price = null; }
          info = {
            x, y, pane: this.pane,
            t: this._tOf(x),
            price: (price != null && isFinite(price)) ? price : null,
            inPlot: !!(v && y <= (v.mainH || v.ph)),
          };
        } catch (er) { info = null; }
        if (UI.openChartMenu) UI.openChartMenu(e.clientX, e.clientY, info);
      });
      /* ROUND126 (perf/memory): the handler is a NAMED instance method now
         plus a destroy() — every Engine used to pin an anonymous window-level
         mouseup listener forever, and layout/tab switches replace panes
         without releasing it, so dead engines accumulated on the window. */
      this._onWinUp = (e) => {
        /* gesture scratch state is cleared BEFORE the early return — the old
           order leaked a stale _tz/_pz into the next press (round 21) */
        this._axisDrag = null;
        this._pz = null;
        this._tz = null;
        this._panLastY = null;
        if (this.mode === 'idle' && !this.temp) return;
        const r = cv.getBoundingClientRect();
        this.up(e.clientX - r.left, e.clientY - r.top);
      };
      window.addEventListener('mouseup', this._onWinUp);
    }

    /* ROUND126: release the window-level listeners when the pane dies
       (called from Manager.destroyPanes; a missing method is simply not
       called, so older teardown paths stay compatible). */
    destroy() {
      try { if (this._onWinUp) { window.removeEventListener('mouseup', this._onWinUp); } } catch (e) { Log.debug('drawing', 'window listener cleanup failed', e) }
      this._onWinUp = null;
    }

    /* ---------- lightweight-charts event forwarding (axes) ----------
       LWC binds its axis drag/hover/dblclick handlers on the LAST <canvas> inside
       the axis <td> (its mouse-capture layer) — synthetic events must target THAT.
       round 32: with indicator sub-panes the chart element is picked by the
       cursor Y (the price/pane gesture belongs to the chart under it); the
       time strip always belongs to the LAST chart. */
    _chartElAt(y) {
      const pane = this.pane;
      if (y != null && pane._subRects) {
        for (const r of pane._subRects) {
          if (y >= r.top && y < r.top + r.h && r.chartEl) return r.chartEl;
        }
      }
      if (pane.mainWrap) {
        const el = pane.mainWrap.querySelector('.tv-lightweight-charts');
        if (el) return el;
      }
      return pane.host.querySelector('.tv-lightweight-charts');
    }
    _lwcEl(reg, y) {
      if (reg) {
        const chartEl = this._chartElAt(y);
        if (chartEl) {
          const tds = chartEl.querySelectorAll('td');
          const td = reg === 'price' ? tds[2] : reg === 'pane' ? tds[1] : tds[4];
          if (td) {
            const canvases = td.querySelectorAll('canvas');
            if (canvases.length) return canvases[canvases.length - 1];
          }
          return chartEl;
        }
      }
      return this.pane.host.firstElementChild || this.pane.host;
    }
    _fwd(type, x, y, srcEv, extra, reg) {
      try {
        const el = this._lwcEl(reg, y);
        const hr = this.pane.host.getBoundingClientRect();
        const opts = Object.assign({
          clientX: hr.left + x, clientY: hr.top + y,
          button: 0, buttons: 1, bubbles: true, cancelable: true, view: window,
        }, extra || {});
        const ev = type === 'wheel'
          ? new WheelEvent('wheel', Object.assign({ deltaX: 0, deltaY: 0, deltaMode: 0 }, opts))
          : new MouseEvent(type, opts);
        el.dispatchEvent(ev);
      } catch (e) { Log.debug('drawing', 'virtual event dispatch failed', e) }
    }
    /* TV: wheel over the price scale zooms it vertically. The lib's own price-axis
       gesture is inert in this build, so the zoom is done with scale margins
       (public API): growing both margins equally magnifies about the centre. */
    _margins() {
      try {
        const m = this.pane.chart.priceScale('right').options().scaleMargins;
        if (m && isFinite(m.top) && isFinite(m.bottom)) return { top: m.top, bottom: m.bottom };
      } catch (e) { Log.debug('drawing', 'scale margin read failed', e) }
      return { top: 0.2, bottom: 0.15 };
    }
    _applyMargins(t, b) {
      t = U.clamp(t, 0.01, 0.6);
      b = U.clamp(b, 0.01, 0.6);
      try { this.pane.chart.priceScale('right').applyOptions({ scaleMargins: { top: t, bottom: b } }); } catch (e) {}
    }
    /* ---------- deep price-axis zoom (TV) ----------
       The zoomed window is stored on pane.pz {active, center, span} and every
       series reports it via autoscaleInfoProvider (manager.js) — the price
       range itself is zoomed, so the depth is unlimited (margins only add the
       settings padding INSIDE the window). */
    _pzClamp() {
      const pz = this.pane.pz;
      if (!pz) return;
      const mag = Math.max(Math.abs(pz.center), 1e-6);
      pz.span = U.clamp(pz.span, mag * 1e-9, mag * 1e9);
    }
    _priceWindow() {
      const pane = this.pane;
      /* round 32: the price window maps the PRICE pane's plot, not the whole
         overlay (which now includes indicator sub-panes) */
      const h = pane._mainPlotH > 0 ? pane._mainPlotH : this.canvas.clientHeight;
      const p1 = pane.series.coordinateToPrice(0), p2 = pane.series.coordinateToPrice(Math.max(2, h));
      if (p1 == null || p2 == null || !isFinite(p1) || !isFinite(p2)) return null;
      return { center: (p1 + p2) / 2, span: Math.abs(p1 - p2) };
    }
    /* factor > 1 = zoom in, about anchorPrice (or the window centre) */
    priceZoom(factor, anchorPrice) {
      const pane = this.pane;
      if (!pane.pz) pane.pz = { active: false, center: 0, span: 0, at: 0 };
      const pz = pane.pz;
      if (!pz.active) {
        const win = this._priceWindow();
        if (!win) return;
        pz.active = true; pz.center = win.center; pz.span = win.span;
        pz.at = Date.now(); /* BUG-E/R25: era stamp — a window older than the
          last data reload belongs to a previous symbol/interval and is
          reset by the manager's axis guard */
        /* round 20: any manual price-scale change puts the chart into
           Free Transform so it can then be moved freely in both directions */
        if (!App.freeTransform) {
          App.freeTransform = true;
          U.lsSet('mt5_free_tf', true);
          const fb = document.getElementById('free-btn');
          if (fb) fb.classList.add('on');
        }
      }
      const a = (anchorPrice != null && isFinite(anchorPrice)) ? anchorPrice : pz.center;
      pz.center = a + (pz.center - a) * factor;
      pz.span *= factor;
      this._pzClamp();
      try { pane.chart.priceScale('right').applyOptions({ autoScale: true }); } catch (e) {}
    }
    priceZoomReset() {
      const pane = this.pane;
      if (pane.pz) pane.pz.active = false;
      try {
        const dm = (Manager.defaultPriceMargins)
          ? Manager.defaultPriceMargins() : { top: 0.2, bottom: 0.15 };
        pane.chart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: dm });
      } catch (e) {}
    }
    _priceZoomDrag(y) {
      const pz = this._pz;
      if (!pz) return;
      /* incremental exponential zoom — TV direction: drag DOWN = zoom in,
         drag UP = zoom out (was inverted before round 19) */
      const f = Math.exp((y - pz.lastY) * 0.005);
      pz.lastY = y;
      this.priceZoom(f, null);
    }
    _axisRegion(x, y) {
      const cv = this.canvas;
      const w = cv.clientWidth, h = cv.clientHeight;
      let axisW = 62, timeH = 26;
      try {
        axisW = this.pane.chart.priceScale('right').width() || axisW;
        timeH = this.pane.chart.timeScale().height() || timeH;
      } catch (e) {}
      if (x > w - axisW && y <= h - timeH) return 'price';
      if (y > h - timeH) return 'time';
      return null;
    }

    setTool(id) {
      this.cancelCreate();
      App.tool = id;
    }

    /* Sync in Layout: show the crosshair at the same time on the other charts.
       (LWC's setCrosshairPosition suppresses its own event, so subscribeCrosshairMove
       never fires for our overlay-driven hover — we propagate here instead.) */
    _syncCross(t) {
      if (Manager.syncCrossMove) Manager.syncCrossMove(this.pane, t);
    }

    /* ROUND53 (user report): the crosshair visuals must follow the cursor
       DURING a click-drag pan — the highlights (time pill, price pill/(+))
       in every cursor mode, plus the dashed vert/horz lines in Cross mode.
       Runs on every pan move AFTER the chart shift, so price/time read the
       fresh chart state — exactly what a plain hover mousemove does. */
    _panTrack(x, y) {
      const td = App.tool ? TOOLS[App.tool] : null;
      const bare = !!(td && td.cursorTool && !td.crosshair);
      const v = this.view();
      const t = this._tOf(x);
      if (!bare) {
        this._setCrossXY(v, x, y, t); // native horzLine + price label (Cross / drawing tools)
        this._syncCross(t);           // synced panes
      }
      try { this._updateCrossBubble(v); } catch (e) {} // time pill + price pill/(+) per event
    }

    cancelCreate() {
      this.temp = null;
      this.mode = 'idle';
      this.bodyDrag = null;
      this._polyPress = null; /* ROUND69: Path/Polyline bend scratch */
    }

    /* ROUND246 (TV parity): staged Escape — a poly tool drops its last anchor
       first; otherwise the in-progress drawing dies but the tool STAYS armed
       for the next one (TV). Returns true when anything was consumed, so the
       toolbar only exits the tool on an idle second Esc. */
    escStep() {
      const t = this.temp;
      if (!t) return false;
      const def = TOOLS[t.type];
      if (def && def.polyFinish && t.points.length > 1) {
        t.points.pop();
        this._polyPress = null;
        return true;
      }
      this.cancelCreate();
      return true;
    }

    /* ROUND69: Enter / double-click finish for the multi-point TV tools
       (Path, Polyline). Drops the duplicate tail a double-click leaves
       behind; too few points just cancels. Returns false when no poly tool
       is mid-creation (Toolbar.onKey then keeps its old behaviour). */
    finishPoly() {
      if (!this.temp) return false;
      const def = TOOLS[this.temp.type];
      if (!def || !def.polyFinish) return false;
      this._polyDedupe();
      if (this.temp.points.length >= 2) this._finish();
      else this.cancelCreate();
      return true;
    }
    _polyDedupe() {
      const pts = this.temp.points;
      while (pts.length >= 2) {
        const a = pts[pts.length - 1], b = pts[pts.length - 2];
        if (Math.abs(a.t - b.t) < 1e-9 && Math.abs(a.p - b.p) < 1e-12) pts.pop();
        else break;
      }
    }

    /* freehand tools (Brush / Highlighter): sample while the button is down */
    _freehandMove(x, y) {
      const v = this.view();
      const pt = this.snap(x, y);
      const pts = this.temp.points;
      const last = pts[pts.length - 1];
      if (last) {
        const lx = v.xOf(last.t), ly = v.yOf(last.p);
        if (Math.hypot(x - lx, y - ly) < 2.2) return;
      }
      pts.push(pt);
    }
    _freehandFinish() {
      const t = this.temp;
      this.temp = null;
      this.mode = 'idle';
      if (!t || t.points.length < 2) { App.tool = null; if (UI.onToolDone) UI.onToolDone(); return; }
      // reject a dot: bounding box must exceed a few pixels
      const v = this.view();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of t.points) {
        const px = v.xOf(p.t), py = v.yOf(p.p);
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
      }
      if ((x1 - x0) + (y1 - y0) < 4) { App.tool = null; if (UI.onToolDone) UI.onToolDone(); return; }
      /* ROUND251: one-shot default (stay lock keeps it armed). */
      if (!App.stayDraw) App.tool = null;
      if (UI.onToolDone) UI.onToolDone();
      App.drawings.add(this.pane.symbol, t);
      if (App.undo) App.undo.push({ kind: 'add', symbol: this.pane.symbol, d: t });
      App.selection = { pane: this.pane, d: t };
      if (UI.onSelectionChanged) UI.onSelectionChanged();
    }

    down(x, y) {
      const pane = this.pane;
      if (UI.setActivePane) UI.setActivePane(pane);
      this.mouse = { x, y, inside: true };
      this._iaToken = (this._iaToken || 0) + 1; // cancel inertia
      if (this.replayPick) { const f = this.replayPick; this.replayPick = null; f(x, y); return; }

      // axis strips: TV lets you scale by dragging them — hand the gesture to lightweight-charts
      const areg = this._axisRegion(x, y);
      if (areg) {
        this._axisDrag = areg;
        this.canvas.style.cursor = areg === 'price' ? 'ns-resize' : 'ew-resize';
        if (areg === 'price') {
          // TV: dragging the price scale zooms the price window (deep zoom, no cap)
          /* round 32: only the PRICE pane's axis deep-zooms the price window;
             over an indicator sub-pane's axis there is nothing to zoom (its
             scale auto-fits its oscillator) */
          const vMainH = pane._mainPlotH > 0 ? pane._mainPlotH : Infinity;
          if (y <= vMainH) this._pz = { lastY: y };
        } else if (areg === 'time') {
          /* TV time-scale drag (round 21): the factor is CUMULATIVE like the
             price-axis drag — _tz.span carries the accumulated window, each
             move multiplies it by the per-move step. Drag LEFT = zoom OUT
             (span grows, more history fits), drag RIGHT = zoom IN (span
             shrinks). The logical index under the cursor stays anchored. */
          const lr = pane.chart.timeScale().getVisibleLogicalRange();
          if (lr) {
            const anchorL = this._lOf(x);
            const frac = U.clamp((anchorL - lr.from) / Math.max(1e-6, lr.to - lr.from), 0, 1);
            this._tz = { lastX: x, from: lr.from, span: lr.to - lr.from, frac };
          }
        } else if (areg === 'pane') {
          // NOTE: dispatch deferred to a clean task — Chromium drops LWC's drag state
          // when a synthetic event is nested inside another mouse event's handler.
          setTimeout(() => this._fwd('mousedown', x, y, null, { buttons: 1 }, areg), 0);
        }
        return;
      }

      if (App.tool) {
        const def = TOOLS[App.tool];
        if (!def) { App.tool = null; }
        else if (!def.cursorTool) {
          /* round 32 (TV parity): drawings are a PRICE-pane tool — over an
             indicator sub-pane the tool never starts (the price mapping
             would be meaningless on an oscillator scale) */
          const vHere = this.view();
          if (y > vHere.mainH) { /* fall through to pan/select */ }
          else {
            const pt = this.snap(x, y);
            if (!this.temp) {
              this.temp = { type: App.tool, points: [pt], opts: App.drawings.defaultOpts(App.tool) };
              /* ROUND69 (TV Brush/Highlighter): freehand tools DRAW while the
                 button is down — the engine's freehand mode was wired for
                 them but never armed, so a click only planted an invisible
                 one-point stroke. Arm it here (release finishes). */
              if (def.freehand) { this.mode = 'freehand'; return; }
              /* ROUND69 (TV Path/Polyline): remember the press so dragging
                 BEFORE releasing can bend the segment being placed */
              if (def.polyFinish) this._polyPress = { x, y, seg: 0, bent: false };
              if (def.pts === 1) {
                if (App.tool === 'text' || App.tool === 'note') {
                  /* TV: clicking with the Text tool places it and opens its settings dialog */
                  const tool = App.tool;
                  this.temp = null;
                  const d = { type: tool, points: [pt], opts: App.drawings.defaultOpts(tool) };
                  d.opts.temp = true; // not committed until the dialog is Ok'd
                  if (tool === 'text' && !d.opts.text) d.opts.text = 'Text';
                  App.drawings.add(pane.symbol, d);
                  App.selection = { pane, d };
                  if (UI.onSelectionChanged) UI.onSelectionChanged();
                  if (DrawSettings) DrawSettings.open(pane, d, { tab: 'text' });
                  App.tool = null;
                  if (UI.onToolDone) UI.onToolDone();
                  return;
                }
                this._finish();
              }
            } else {
              this.temp.points.push(pt);
              if (def.polyFinish) { this._polyPress = { x, y, seg: this.temp.points.length - 1, bent: false }; }
              else if (this.temp.points.length >= def.pts) this._finish();
            }
          }
          return;
        }
        // cursorTool (cross/arrow/dot): no drawing — falls through to select/pan
      }

      const hit = this._hitTest(x, y);
      if (hit) {
        const d = hit.d;
        App.selection = { pane, d };
        Alerts.selected = null; /* ROUND51: one selection at a time */
        if (UI.onSelectionChanged) UI.onSelectionChanged();
        if (d.locked || App.lockAll) { this.mode = 'idle'; return; }
        this.downPt = { x, y }; this.moved = false;
        if (hit.type === 'handle') {
          this.mode = 'handle';
          this.handleIdx = hit.idx;
        } else {
          this.mode = 'body';
          this._beginBodyDrag(d, x, y);
        }
        /* undo: remember the pre-drag state, committed on mouseup if moved */
        this._dragUndo = App.undo ? {
          kind: 'modify', symbol: pane.symbol, id: d.id,
          before: JSON.parse(JSON.stringify({ points: d.points, opts: d.opts })),
        } : null;
        return;
      }

      /* ROUND51 (user request): price alerts are first-class chart objects —
         click = select (a floating delete chip appears on the line), drag =
         move the level. Time alerts keep their existing right-click flow. */
      const alHit = Alerts.alertAt ? Alerts.alertAt(pane, x, y) : null;
      if (alHit && alHit.kind !== 'time') {
        Alerts.selected = alHit.id;
        if (Manager.applyPriceLines) Manager.applyPriceLines(pane);
        this.mode = 'alertdrag';
        this._alDrag = { id: alHit.id, moved: false };
        this.downPt = { x, y }; this.moved = false;
        this.canvas.style.cursor = 'ns-resize';
        return;
      }

      // empty area: deselect + pan (TV: the chart glides both horizontally and,
      // when auto-scale is off, vertically — the vertical gesture is handed to
      // lightweight-charts by forwarding a drag onto the price axis)
      if (Alerts.selected != null) Alerts.selected = null; /* ROUND51: click-away deselects */
      if (App.selection) {
        const sd = App.selection.d;
        if (sd && sd.opts && sd.opts.temp) App.drawings.remove(sd.symbol, sd.id);
        App.selection = null;
        if (UI.onSelectionChanged) UI.onSelectionChanged();
      }
      const r = pane.chart.timeScale().getVisibleLogicalRange();
      this.pan = r ? { x0: x, range: { from: r.from, to: r.to } } : null;
      this.mode = 'pan';
      this.downPt = { x, y }; this.moved = false;
      this._panLastY = y;
      this.canvas.style.cursor = 'grabbing';
      /* ROUND53 (user report): REVERSED the ROUND51 behavior — the crosshair
         visuals must now SURVIVE a click-drag pan and follow the cursor:
         the highlights (time + price pills/(+)) and, in Cross mode, the
         dashed vert/horz lines used to die on pan-down and pop back on
         release. The hover state (_cross, pills, native horzLine) is left
         untouched here, and every pan move() re-drives it (_panTrack), so
         nothing disappears OR freezes while the chart slides. */
      // free vertical panning (TV: move the chart up/down with auto-scale off).
      // The whole gesture is handed to lightweight-charts (pressedMouseMove),
      // which glides the chart on BOTH axes natively.
      this._vpan = false;
      try {
        /* round 32: only when the gesture STARTS on the price pane (a drag
           over an indicator sub-pane pans TIME only, like TV) */
        const vStart = this.view();
        if (y <= vStart.mainH && pane.chart.priceScale('right').options().autoScale === false) {
          this._vpan = true;
          const vx = x, vy = y;
          setTimeout(() => {
            if (this.mode === 'pan' && this._vpan) this._fwd('mousedown', vx, vy, null, { buttons: 1 }, 'pane');
          }, 0);
        }
      } catch (e) {}
    }

    move(x, y) {
      const pane = this.pane;
      /* ROUND132 (TV Bar Replay parity): while the replay START-PICK is
         armed this pane is a picker, not a chart — the cursor reads as a
         crosshair, the native crosshair/pills stay out of the way (the
         blue pick line painted by _drawReplayPick replaces them) and no
         drawing/pan/hover gesture may start under the armed state. */
      if (this.replayPick) {
        this.mouse = { x, y, inside: true };
        this.canvas.style.cursor = 'crosshair';
        this._cross = { on: false, x: -1 };
        try { pane.chart.clearCrosshairPosition(); } catch (e) {}
        if (pane.taxLive) pane.taxLive.style.display = 'none';
        return;
      }
      /* ROUND80 (user request — crosshair magnet): with Magnet Mode on, the
         crosshair's PRICE half snaps to the hovered bar's O/H/L/C while the
         pointer moves over the plot — the vertical line and the time pill
         keep following the cursor 1:1 (TV behaviour), everything price-side
         (native horzLine + axis label, the DOM pill, the (+) button price)
         rides the snapped y because they all read it downstream. Hover-only:
         never during pan/drag gestures (mode !== 'idle' there), never over
         the axes, price pane only (sub-pane scales have no OHLC), Alt
         bypasses. Drawing points keep snapping through snap() on down —
         same radius, so preview == landed result. */
      if (this.mode === 'idle' && !this.downPt && App.magnetMode && App.magnetMode !== 'off' && !App.altDown) {
        if (!this._axisRegion(x, y)) {
          try {
            const v0 = this.view();
            if (y <= v0.mainH) {
              const my = this._magnetSnapY(x, y);
              if (my != null) y = my;
            }
          } catch (e) {}
        }
      }
      if (this.downPt && Math.hypot(x - this.downPt.x, y - this.downPt.y) > 3) this.moved = true;
      /* round 31: the RAW cursor drives the crosshair visuals (custom vertical
         line + time pill). LWC's own crosshair x cannot express "the mouse is
         40px right of the live bar" — it clamps future times to the last bar
         — so the visuals read the pointer position directly. TV parity: the
         crosshair tracks the cursor 1:1 everywhere in the plot (future margin
         included), disappears over the price scale and while panning, and
         keeps following the x while hovering the time scale (the pill rides
         the axis strip, like TV). */
      {
        const areg = this._axisRegion(x, y);
        /* ROUND39 (TV parity): Arrow/Dot cursor tools show NO crosshair and
           NO time pill — only the Cross tool (and drawing tools) do */
        const tdC = App.tool ? TOOLS[App.tool] : null;
        const bareCursor = !!(tdC && tdC.cursorTool && !tdC.crosshair);
        if (this.mode === 'pan') {
          /* ROUND53 (user report): during a click-drag pan the highlights AND
             (Cross mode) the dashed crosshair lines must FOLLOW the cursor —
             they used to be zeroed here on every drag frame and only came
             back on release. Mirror the hover state each frame instead; the
             actual pill/line refresh runs in the pan branch below AFTER the
             chart shift, so price/time read the post-pan chart (zero lag,
             never frozen, never hidden). */
          this._cross = { on: true, x, y, bare: bareCursor };
        } else if (areg === 'price') {
          /* ROUND50 pin zone (plain price-scale hover, NOT dragging) keeps
             its ROUND51 semantics: the crosshair zero on the strip while the
             ROUND50 pin below rides the pill pair with the cursor. */
          this._cross = { on: false, x: -1, y: -1 };
          if (this.pane.taxLive && this.pane.taxLive.style.display !== 'none') this.pane.taxLive.style.display = 'none';
        } else if (bareCursor) {
          /* ROUND49 (TV): Arrow/Dot keep the SCALE highlights — the time pill
             here, the price pill + (+) button in _updatePax — while the LINES
             stay hidden (native horzLine off via ui.js activateTool, the
             painted vertical gated by bareCursor in render). `bare` marks the
             state so the pills track without ever drawing a line. */
          this._cross = { on: true, x, y, bare: true };
        } else {
          this._cross = { on: true, x, y };
          if (areg === 'time') {
            // the axis branch below early-returns — keep the pill zero-lag there too
            try { this._updateCrossBubble(this.view()); } catch (e) {}
          }
        }
      }
      if (this.mode === 'freehand' && this.temp) { this._freehandMove(x, y); return; }
      /* ROUND69 (TV Path): pressing on the NEXT point and dragging bends the
         segment being placed into a quadratic curve (a plain click leaves
         it straight; Polyline never bends). Live preview re-renders it. */
      if (this._polyPress && this.temp) {
        const pdef = TOOLS[this.temp.type];
        if (pdef && pdef.polyFinish && pdef.polyCurves && this._polyPress.seg >= 1) {
          if (this._polyPress.bent || Math.hypot(x - this._polyPress.x, y - this._polyPress.y) > 4) {
            this._polyPress.bent = true;
            const cpt = this.snap(x, y);
            const ctrls = this.temp.opts.ctrls || (this.temp.opts.ctrls = []);
            ctrls[this._polyPress.seg - 1] = { t: cpt.t, p: cpt.p };
            return;
          }
        }
      }
      if (this.mode === 'pan') {
        // record pointer samples for release inertia
        const now = performance.now();
        const pts = this._panPts || (this._panPts = []);
        pts.push({ t: now, x, y });
        if (pts.length > 24) pts.shift();
      }
      // axis hover (TV): price scale = ns-resize, time scale = ew-resize, LWC shows its axis labels
      if (this.mode === 'idle' && !this.temp) {
        if (this._axisDrag) {
          // real mousemove events bubble to LWC's document-level drag handler — don't double-send
          const reg = this._axisRegion(x, y);
          this.canvas.style.cursor = reg === 'price' ? 'ns-resize' : 'ew-resize';
          if (this._axisDrag === 'price' && this._pz) this._priceZoomDrag(y);
          else if (this._axisDrag === 'time' && this._tz) {
            /* round 21 fix + direction: the span must ACCUMULATE (writing the
               baseline-span/f every move killed the gesture — the first tiny
               step was re-applied forever, so the drag felt dead). LEFT =
               zoom out (span grows), RIGHT = zoom in (span shrinks). */
            const f = Math.exp((x - this._tz.lastX) * 0.004);
            this._tz.lastX = x;
            this._tz.span = U.clamp(this._tz.span / f, 2.5, Math.max(30, pane.barTimes.length * 1.6));
            const mid = this._tz.from + this._tz.span * this._tz.frac;
            pane.chart.timeScale().setVisibleLogicalRange({
              from: mid - this._tz.span * this._tz.frac,
              to: mid + this._tz.span * (1 - this._tz.frac),
            });
          }
          /* ROUND51 (user report): pills track during axis zoom drags too —
             the price pill rides via the ROUND50 pin, the time pill follows
             on the strip; nothing freezes under the gesture. */
          try { this._updateCrossBubble(this.view()); } catch (e) {}
          return;
        }
        const reg = this._axisRegion(x, y);
        if (reg) {
          this.canvas.style.cursor = reg === 'price' ? 'ns-resize' : 'ew-resize';
          this._fwd('mousemove', x, y, null, { buttons: 0 }, reg);
          /* ROUND50: zero-lag pair update on the scales (mirrors the time-axis
             branch below) — the price pill + (+) must track/pin while the user
             slides toward them on the price scale, not wait for the next
             data-tick render */
          try { this._updateCrossBubble(this.view()); } catch (e) {}
          return;
        }
      }
      const v = this.view();

      if (this.mode === 'handle' && App.selection && App.selection.pane === pane) {
        const d = App.selection.d;
        const pt = this.snap(x, y);
        try { TOOLS[d.type].dragHandle(v, d, this.handleIdx, pt); } catch (e) {}
        App.drawings.save();
        return;
      }
      if (this.mode === 'body' && this.bodyDrag && App.selection && App.selection.pane === pane) {
        const d = App.selection.d;
        const l = this._lOf(x);
        const p = pane.series.coordinateToPrice(y);
        if (l == null || p == null) return;
        const shift = l - this.bodyDrag.l0;
        const dp = p - this.bodyDrag.p0;
        this.bodyDrag.orig.forEach((o, i) => {
          d.points[i].t = U.logicalToTime(this._timeArr(), o.l + shift);
          d.points[i].p = o.p + dp;
        });
        /* ROUND249: bend controls follow the same shift (absolute from the
           drag-start snapshot). */
        if (this.bodyDrag.ctrls && Array.isArray(d.opts.ctrls) &&
            d.opts.ctrls.length === this.bodyDrag.ctrls.length) {
          const arr = this._timeArr();
          d.opts.ctrls = this.bodyDrag.ctrls.map((o) => (o
            ? { t: U.logicalToTime(arr, o.l + shift), p: o.p + dp }
            : o));
        }
        /* ROUND246: tools with off-point state (position target price) ride
           the same price delta so ratios survive a body move. */
        try {
          const bd = TOOLS[d.type];
          if (bd && bd.onBodyDrag) bd.onBodyDrag(d, dp, this.bodyDrag.extra);
        } catch (e) {}
        App.drawings.save();
        return;
      }
      /* ROUND51 (user request): alert drag — the level follows the cursor's
         price 1:1 while the button is down; committed on release. */
      if (this.mode === 'alertdrag' && this._alDrag) {
        const a = Alerts.list ? Alerts.list.find((x) => x.id === this._alDrag.id) : null;
        if (!a) { this.mode = 'idle'; this._alDrag = null; return; }
        this._alDrag.moved = true;
        let p = null;
        try { p = pane.series.coordinateToPrice(y); } catch (e) {}
        if (p != null && isFinite(p) && p > 0) a.price = p;
        if (Manager.applyPriceLines) Manager.applyPriceLines(pane);
        return;
      }
      if (this.mode === 'pan' && this.pan && this.pan.range) {
        if (this._vpan) {
          /* ROUND53: native two-axis drag — the pills/lines still track the
             cursor on every event (nothing freezes under the gesture) */
          this._panTrack(x, y);
          return;
        }
        const ts = pane.chart.timeScale();
        const spacing = ts.options().barSpacing || 8;
        const shift = (x - this.pan.x0) / spacing;
        ts.setVisibleLogicalRange({ from: this.pan.range.from - shift, to: this.pan.range.to - shift });
        // vertical glide while a manual price-zoom window is active (TV), or
        // ALWAYS when Free Transform is on: the first vertical move pins the
        // price window so the chart can be moved freely in BOTH directions
        const pzH = Math.max(60, v.mainH || (this.canvas.clientHeight - 30));
        const dy = this._panLastY != null ? y - this._panLastY : 0;
        if (pane.pz && !pane.pz.active && App.freeTransform && dy !== 0) {
          const win = this._priceWindow();
          if (win) {
            pane.pz.active = true; pane.pz.center = win.center; pane.pz.span = win.span;
            pane.pz.at = Date.now(); // BUG-E/R25: era stamp (see priceZoom)
            try { pane.chart.priceScale('right').applyOptions({ autoScale: true }); } catch (e) {}
          }
        }
        if (pane.pz && pane.pz.active && dy !== 0) {
          /* Free Transform (round 21): the chart FOLLOWS the cursor — drag
             DOWN moves the chart down, drag UP moves it up (was inverted) */
          pane.pz.center += dy * (pane.pz.span / pzH);
          this._pzClamp();
        }
        this._panLastY = y;
        this._panTrack(x, y); /* ROUND53: highlights + crosshair follow the cursor during the drag */
        return;
      }

      // hover: crosshair + legend + cursor
      const td = App.tool ? TOOLS[App.tool] : null;
      if (td && td.cursorTool) {
        this.canvas.style.cursor = td.cursor();
        if (App.tool !== 'arrowcur') {
          const t = this._tOf(x);
          this._setCrossXY(v, x, y, t);
          this._syncCross(t);
          if (Manager.updateLegend) Manager.updateLegend(pane, t);
          try { this._updateCrossBubble(this.view()); } catch (e) {} // round 31: zero-lag pill
        }
        /* ROUND49: Arrow skipped the block above — its scale highlights must
           still track 1:1, so drive the pills here too */
        try { this._updateCrossBubble(this.view()); } catch (e) {}
        return;
      }
      if (td) {
        this.canvas.style.cursor = 'crosshair';
        const t = this._tOf(x);
        this._setCrossXY(v, x, y, t);
        this._syncCross(t);
        if (Manager.updateLegend) Manager.updateLegend(pane, t);
        try { this._updateCrossBubble(this.view()); } catch (e) {} // round 31: zero-lag pill
        return;
      }
      const hit = this._hitTest(x, y);
      /* ROUND51 (user request): an alert line under the cursor reads as
         grabbable — ns-resize, same affordance TV gives its alert lines */
      const alNear = !hit && Alerts.alertAt ? Alerts.alertAt(pane, x, y) : null;
      this.canvas.style.cursor = hit ? this._hitCursor(hit)
        : (alNear && alNear.kind !== 'time' ? 'ns-resize' : 'default');
      const t = this._tOf(x);
      this._setCrossXY(v, x, y, t);
      this._syncCross(t);
      if (Manager.updateLegend) Manager.updateLegend(pane, t);
      try { this._updateCrossBubble(this.view()); } catch (e) {} // round 31: zero-lag pill
    }

    up(x, y) {
      /* ROUND69: freehand strokes commit on release (Brush / Highlighter) */
      if (this.mode === 'freehand') {
        this._axisDrag = null; this._pz = null; this._tz = null; this._panLastY = null;
        this._polyPress = null;
        this._freehandFinish();
        this.canvas.style.cursor = 'default';
        return;
      }
      this._polyPress = null;
      this._axisDrag = null;
      this._pz = null;
      this._tz = null;
      this._panLastY = null;
      const wasPan = this.mode === 'pan';
      const wasVpan = wasPan && this._vpan;
      this._vpan = false;
      if ((this.mode === 'body' || this.mode === 'handle') && this._dragUndo && App.undo) {
        const du = this._dragUndo;
        if (this.moved) {
          const d = (App.drawings.list(du.symbol) || []).find((x2) => x2.id === du.id);
          if (d) du.after = JSON.parse(JSON.stringify({ points: d.points, opts: d.opts }));
          if (du.after) App.undo.push(du);
        }
      }
      /* ROUND51 (user request): alert drag/commit — persist the dropped level
         once, refresh the panel; a plain click just leaves it selected. */
      if (this.mode === 'alertdrag' && this._alDrag) {
        const a = Alerts.list ? Alerts.list.find((x) => x.id === this._alDrag.id) : null;
        if (a && this._alDrag.moved) { Alerts.persist(); Alerts.render(); }
        this._alDrag = null;
      }
      this._dragUndo = null;
      if (this.mode === 'body' || this.mode === 'handle') App.drawings.save();
      this.mode = 'idle';
      /* ROUND80 (latent bug surfaced by the hover magnet): up() never cleared
         downPt — after the FIRST pan the stale press point lived on forever
         while mode returned to 'idle'. Nothing read it in hover before, but
         the ROUND80 crosshair magnet gates on !downPt (magnet is hover-only),
         so it silently stayed dead after any drag. The press state belongs
         to the gesture — release it with the gesture. */
      this.downPt = null;
      this.moved = false;
      this.bodyDrag = null;
      this.handleIdx = -1;
      this.canvas.style.cursor = 'default';
      if (wasVpan) {
        // release the forwarded native drag that powered the free pan
        setTimeout(() => this._fwd('mouseup', x, y, null, { buttons: 0 }, 'pane'), 0);
      }
      if (wasPan && !wasVpan) this._inertia(); // native drag handles its own glide
    }

    /* TV-style momentum glide after a pan release.
       We accumulate the position ourselves — reading LWC every frame races its
       async repaint and swallows most of the glide. */
    _inertia() {
      const pts = this._panPts || [];
      this._panPts = null;
      if (pts.length < 2) return;
      const now = pts[pts.length - 1].t;
      const recent = pts.filter((p) => now - p.t <= 110);
      if (recent.length < 2) return;
      const a = recent[0], b = recent[recent.length - 1];
      const dt = (b.t - a.t) / 1000;
      if (dt <= 0.004) return;
      let vx = (b.x - a.x) / dt; // px/s, positive = dragging right
      if (Math.abs(vx) < 140) return;
      const ts = this.pane.chart.timeScale();
      let sp = 8;
      try { sp = ts.options().barSpacing || 8; } catch (e) {}
      let vL = vx / sp; // logical bars per second
      const token = this._iaToken = (this._iaToken || 0) + 1;
      this._base = null;
      let last = performance.now();
      let settled = 0;
      const step = (now2) => {
        if (token !== this._iaToken) return; // interrupted by new input
        const d = Math.min(0.05, (now2 - last) / 1000);
        last = now2;
        if (settled < 2) { settled++; requestAnimationFrame(step); return; } // let LWC flush its pending range
        if (!this._base) {
          let lr = null;
          try { lr = ts.getVisibleLogicalRange(); } catch (e) { return; }
          if (!lr) return;
          this._base = { from: lr.from, to: lr.to };
        }
        const shift = vL * d;
        vL *= Math.pow(0.002, d); // exponential decay
        if (Math.abs(vL) < 10) { this._base = null; return; }
        this._base.from -= shift;
        this._base.to -= shift;
        ts.setVisibleLogicalRange({ from: this._base.from, to: this._base.to });
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }

    dbl(x, y, srcEv) {
      const pane = this.pane;
      const reg = this._axisRegion(x, y);
      if (reg) {
        if (reg === 'time') {
          /* round 32: the visible time strip belongs to the LAST sub-chart,
             but the reset must hit the MAIN time scale — every sub-pane mirrors
             it through the range-sync subscription (native forward removed) */
          try {
            pane.chart.timeScale().resetTimeScale();
            if (pane.pz) pane.pz.active = false;
            const dm = (Manager.defaultPriceMargins)
              ? Manager.defaultPriceMargins() : { top: 0.2, bottom: 0.15 };
            pane.chart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: dm });
          } catch (e) {}
          return;
        }
        /* price axis: reset the manual price-zoom window only when the
           gesture is on the PRICE pane's own axis */
        const vMainH = pane._mainPlotH > 0 ? pane._mainPlotH : Infinity;
        if (y <= vMainH) {
          this._fwd('dblclick', x, y, srcEv, { buttons: 0 }, reg); // LWC resets that axis
          this.priceZoomReset();
        }
        return;
      }
      /* ROUND69: a double-click while a multi-point tool (Path / Polyline)
         is mid-creation FINISHES it — TV behaviour. The duplicate tail the
         second press leaves is dropped; a stray single point cancels. */
      if (this.temp) {
        const tdef = TOOLS[this.temp.type];
        if (tdef && tdef.polyFinish) {
          this._polyDedupe();
          if (this.temp.points.length >= 2) this._finish();
          else this.cancelCreate();
          return;
        }
      }
      const hit = this._hitTest(x, y);
      if (hit) {
        /* TV: double-click on a drawing opens its settings dialog
           (Text/Note open straight on the Text tab) */
        App.selection = { pane, d: hit.d };
        if (UI.onSelectionChanged) UI.onSelectionChanged();
        if (DrawSettings) DrawSettings.open(pane, hit.d, { tab: hit.d.type === 'text' || hit.d.type === 'note' ? 'text' : 'style' });
        return;
      }
      try {
        pane.chart.timeScale().resetTimeScale();
        if (pane.pz) pane.pz.active = false; // full reset: back to auto-scale
        const dm = (Manager.defaultPriceMargins)
          ? Manager.defaultPriceMargins() : { top: 0.2, bottom: 0.15 };
        pane.chart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: dm });
      } catch (e) {}
    }

    wheel(x, y, srcEv) {
      this._iaToken = (this._iaToken || 0) + 1; // cancel glide
      const reg = this._axisRegion(x, y);
      if (reg === 'price') {
        // TV: vertical zoom of the price scale, anchored at the cursor
        /* round 32: only the PRICE pane's axis zooms the price window */
        const vMainH = this.pane._mainPlotH > 0 ? this.pane._mainPlotH : Infinity;
        if (y > vMainH) return;
        const anchor = this.pane.series.coordinateToPrice(y);
        const f = ((srcEv && srcEv.deltaY) || -100) < 0 ? 0.85 : 1 / 0.85;
        this.priceZoom(f, anchor);
        return;
      }
      // pane + time scale: zoom time scale anchored at cursor (TV behaviour)
      const ts = this.pane.chart.timeScale();
      const lr = ts.getVisibleLogicalRange();
      if (!lr) return;
      const w = this.canvas.clientWidth;
      const deltaY = (srcEv && srcEv.deltaY) || 100;
      const px = U.clamp(x / Math.max(1, w), 0, 1);
      const span = lr.to - lr.from;
      const anchorL = lr.from + span * px;
      const f = deltaY < 0 ? 0.82 : 1 / 0.82;
      const maxSpan = Math.max(30, this.pane.barTimes.length * 1.6);
      const span2 = U.clamp(span * f, 2.5, maxSpan);
      ts.setVisibleLogicalRange({ from: anchorL - span2 * px, to: anchorL + span2 * (1 - px) });
    }

    /* ---------- internals ---------- */
    _finish() {
      const d = this.temp;
      this.temp = null;
      const def = TOOLS[d.type];
      if (def.special === 'zoom') {
        const pane = this.pane;
        /* ROUND90: LWC's visible range lives in the GAP-inclusive frame on
           session panes — convert through the same array the frames count */
        const l1 = U.timeToLogical(this._timeArr(), d.points[0].t);
        const l2 = U.timeToLogical(this._timeArr(), d.points[1].t);
        if (Math.abs(l2 - l1) >= 2) pane.chart.timeScale().setVisibleLogicalRange({ from: Math.min(l1, l2), to: Math.max(l1, l2) });
        App.tool = null;
        if (UI.onToolDone) UI.onToolDone();
        return;
      }
      // reject zero-size drawings
      let valid = true;
      if (d.points.length >= 2) {
        const p0 = d.points[0], p1 = d.points[1];
        if (Math.abs(p0.t - p1.t) < 1e-9 && Math.abs(p0.p - p1.p) < 1e-12) valid = false;
      }
      /* ROUND251 (TV parity — user report): one-shot is the default (repeat
         drawing needs the Stay-in-drawing-mode lock). R246's always-sticky
         trapped users: every click after a creation drew again instead of
         selecting. Zoom + the text/note dialog flow stay one-shot. */
      if (!App.stayDraw) App.tool = null;
      if (UI.onToolDone) UI.onToolDone();
      if (!valid) return;
      try { if (def.afterFinish) def.afterFinish(d); } catch (e) { Log.debug('drawing', 'tool finish hook failed', e) }
      App.drawings.add(this.pane.symbol, d);
      /* ROUND243 (TV parity): creation never pushed an undo step (freehand
         did, engine.js:599) — Ctrl+Z left a fresh trend/channel/fork on the
         chart. Same {kind:'add'} shape the stack already replays. */
      if (App.undo) App.undo.push({ kind: 'add', symbol: this.pane.symbol, d: U.deepCopy(d) });
      App.selection = { pane: this.pane, d };
      if (UI.onSelectionChanged) UI.onSelectionChanged();
    }

    _beginBodyDrag(d, x, y) {
      const pane = this.pane;
      const l0 = this._lOf(x);
      const p0 = pane.series.coordinateToPrice(y);
      /* ROUND246: tools with off-point state snapshot it here so the move
         hook below stays absolute (like orig), never accumulating. */
      let extra = null;
      try {
        const bd = TOOLS[d.type];
        if (bd && bd.bodyDragState) extra = bd.bodyDragState(d);
      } catch (e) {}
      /* ROUND249: path/polyline bend controls (opts.ctrls, same {t,p} shape
         as points) snapshot with their logical so bends ride body moves. */
      let ctrls = null;
      try {
        const arr = this._timeArr();
        if (Array.isArray(d.opts.ctrls) && d.opts.ctrls.length) {
          ctrls = d.opts.ctrls.map((c) => (c ? { t: c.t, p: c.p, l: U.timeToLogical(arr, c.t) } : null));
        }
      } catch (e) { ctrls = null; }
      this.bodyDrag = {
        l0: l0 == null ? 0 : l0,
        p0: p0 == null ? 0 : p0,
        orig: d.points.map((pt) => ({ t: pt.t, p: pt.p, l: U.timeToLogical(this._timeArr(), pt.t) })),
        extra,
        ctrls,
      };
    }

    _hitTest(x, y) {
      const v = this.view();
      const items = App.drawings.list(this.pane.symbol);
      // selected drawing handles first
      if (App.selection && App.selection.pane === this.pane) {
        const sd = App.selection.d;
        if (items.includes(sd)) {
          let hs = [];
          try { hs = TOOLS[sd.type].handles(v, sd) || []; } catch (e) {}
          for (let i = 0; i < hs.length; i++) {
            if (Math.hypot(x - hs[i][0], y - hs[i][1]) < HIT) return { d: sd, type: 'handle', idx: i };
          }
        }
      }
      for (let k = items.length - 1; k >= 0; k--) {
        const d = items[k];
        if (d.hidden) continue;
        const def = TOOLS[d.type];
        if (!def) continue;
        let hs = [];
        try { hs = def.handles ? def.handles(v, d) || [] : []; } catch (e) {}
        for (let i = 0; i < hs.length; i++) {
          if (Math.hypot(x - hs[i][0], y - hs[i][1]) < HIT) return { d, type: 'handle', idx: i };
        }
        let body = false;
        try { body = def.hitBody(v, d)(x, y); } catch (e) {}
        if (body) return { d, type: 'body' };
      }
      return null;
    }

    /* round 22: TV hover feedback — the cursor announces WHAT is grabbable:
       directional resize cursors on the shape's handles, move on a selected
       body, pointer on an unselected one (like the axis strips announce
       their own scale gestures) */
    _hitCursor(hit) {
      if (!hit) return 'default';
      if (hit.type === 'body') {
        const sel = !!(App.selection && App.selection.d === hit.d);
        return sel ? 'move' : 'pointer';
      }
      const v = this.view();
      const d = hit.d;
      let hs = [];
      try { hs = TOOLS[d.type].handles ? TOOLS[d.type].handles(v, d) || [] : []; } catch (e) {}
      const h = hs[hit.idx];
      if (!h) return 'pointer';
      let cx = 0, cy = 0;
      for (const p of hs) { cx += p[0]; cy += p[1]; }
      cx /= hs.length; cy /= hs.length;
      const dx = h[0] - cx, dy = h[1] - cy;
      if (Math.abs(dx) > Math.abs(dy) * 2.2) return 'ew-resize';
      if (Math.abs(dy) > Math.abs(dx) * 2.2) return 'ns-resize';
      return (dx * dy > 0) ? 'nwse-resize' : 'nesw-resize';
    }

    /* ---------- render (called every frame by Manager) ---------- */
    _drawPeriodSep(v) {
      const S = Settings ? Settings.conf : {};
      const mode = S.periodSep || 'hidden';
      if (mode === 'hidden' || !v.bars || v.bars.length < 2) return;
      const off = (App.feed && App.feed.serverOff) || 0;
      // period id of a bar time (server-day / server-week / server-month)
      const perId = (t) => {
        const s = t - off;
        if (mode === 'day') return Math.floor(s / 86400);
        if (mode === 'week') return Math.floor((Math.floor(s / 86400) + 4) / 7);
        const d = new Date(s * 1000);
        return d.getUTCFullYear() * 12 + d.getUTCMonth();
      };
      const ctx = v.ctx;
      ctx.save();
      ctx.strokeStyle = this._th('periodSep', 'rgba(120,123,134,.42)'); // AUD-001
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      const lr = (() => { try { return this.pane.chart.timeScale().getVisibleLogicalRange(); } catch (e) { return null; } })();
      if (!lr) { ctx.restore(); return; }
      const i0 = Math.max(1, Math.floor(lr.from)), i1 = Math.min(v.bars.length - 1, Math.ceil(lr.to));
      for (let i = i0; i <= i1; i++) {
        if (perId(v.bars[i].time) === perId(v.bars[i - 1].time)) continue;
        const x = Math.round(v.xOf(v.bars[i].time)) + 0.5;
        if (x < -2 || x > v.pw + 2) continue;
        ctx.beginPath();
        ctx.moveTo(x, 0); ctx.lineTo(x, v.ph);
        ctx.stroke();
      }
      ctx.restore();
    }

    /* ---------- BUG-002: ONE uniform time axis (labels + vertical grid) ----------
       lightweight-charts picks its tick marks per INDEX (min pixel gap) and
       RESTARTS the run at every day boundary, and it never labels the
       right-offset (future) area at all — the axis ended up as a patchwork
       (~90 min in the data area, a shorter step at the day restart, ~45 min in
       the future margin). This overlay now labels the ENTIRE strip — past,
       data and future — from ONE nice cadence chosen from the live bar
       spacing, snapped to natural boundaries of that cadence in the chart's
       SERVER time base (the same base the bars are anchored in), with
       day/month/year rollover ticks showing the date (TV behavior). The same
       positions are stored on this._taxGrid and painted as the vertical grid
       lines in render() (the native vertical grid is off — see manager.js).
       Everything derives from barTimes + the time scale — no series data is
       touched, so ticks, drawings, replay and autoscale stay exactly as they
       were. The live candle's own time label is preserved (round 23). */
    _updateTaxExt(v) {
      const el = this.pane.tax;
      if (!el) return;
      const pane = this.pane;
      /* ROUND90: on Custom Session panes the axis lives on the GAP-INCLUSIVE
         frame (whitespace slots between the day regions) — labels, grid and
         the live pill must all read times through that frame */
      const sessArr = this._timeArr();
      const useSess = sessArr !== pane.barTimes;
      const times = useSess ? sessArr : pane.barTimes;
      const n = times.length;
      const ts = pane.chart.timeScale();
      if (!n || !ts) { if (el.style.display !== 'none') { el.style.display = 'none'; el._k = ''; } this._taxGrid = null; return; }
      let lr = null;
      try { lr = ts.getVisibleLogicalRange(); } catch (e) {}
      if (!lr) { if (el.style.display !== 'none') { el.style.display = 'none'; el._k = ''; } this._taxGrid = null; return; }
      const tfSec = v.tfSec;
      /* BUG-002/R25: the cadence MUST derive from the REAL average pixels per
         bar of the CURRENT view — visible width / visible logical span. The
         old source (timeScale options barSpacing, clamped at 4px) diverged
         from reality at deep zoom-out (real spacing 0.5px while the ladder
         assumed 4px) -> every cadence tick got a label and the whole axis
         crammed into 7-8px columns (user round-25 report). */
      const spanLr = Math.max(0.001, (lr.to - lr.from));
      const bs = Math.max(0.05, v.pw / spanLr);
      const off = (App.feed && App.feed.serverOff) || 0;
      const lastT = times[n - 1];
      const dowOn = Settings ? Settings.conf.dayOfWeek !== false : true;
      const isSec = tfSec < 60, isIntra = tfSec < 86400;

      /* ROUND40 (user report — screenshot): ticks at UNIFORM BAR STRIDES.
         The old nice-TIME cadence (every 2h snapped to :00 boundaries) met
         a different BAR count whenever a session break or weekend sat
         between two boundaries, so label spacing AND the vertical grid both
         looked irregular (Fri->Thu six calendar days but few trading bars).
         TradingView spaces the time axis by BAR COUNT instead: a nice N
         chosen from the live pixels-per-bar, one tick every Nth bar counted
         back from the live bar (so the future margin keeps the same grid),
         each tick labelled with its OWN bar time (date text at day
         changes). Spacing in pixels = N * barSpacing — constant everywhere,
         session holes included. */
      const niceSteps = [1, 2, 3, 5, 10, 15, 20, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 8000];
      const MIN_STEP = 46; // "hh:mm" fits; wider day labels win their cell via the overlap guard (TV)
      let N = niceSteps[niceSteps.length - 1];
      for (const c of niceSteps) { if (c * bs >= MIN_STEP) { N = c; break; } }

      /* label text — intraday: hh:mm (date at the day rollover); D/W/M:
         "03 Sep" with month/year rollovers collapsing to "Sep"/"2026".
         ROUND41 (user report + TV screenshots): a day-rollover label that
         did not FIT its cell used to be dropped entirely — the axis was
         left with a BLANK gap around every day start/end. TradingView
         degrades the label instead: zoomed IN (enough room) it writes the
         full date, zoomed OUT only the day NUMBER ("2", "26"), the month
         name at a month rollover ("Sep") and the year at a year rollover.
         labelFor now returns { full, short }; the placement loop tries
         full first and falls back to short. */
      const dayIdx = (t) => Math.floor((t - off) / 86400);
      const labelFor = (t, prevT) => {
        if (isIntra) {
          if (prevT != null && dayIdx(t) !== dayIdx(prevT)) {
            const p = TZ.parts(App.tz, t);
            const pp = TZ.parts(App.tz, prevT);
            let short = String(parseInt(p.day, 10));              // TV: "2", "26"
            if (p.year !== pp.year) short = p.year;               // year rolls over -> "2026"
            else if (p.month !== pp.month) short = p.monthShort;  // month rolls over -> "Sep"
            return { full: TZ.tickLabel(App.tz, t, 2, dowOn), short };
          }
          const tm = TZ.tickLabel(App.tz, t, 3, false);
          return { full: tm, short: tm };
        }
        /* TZ.parts (NOT ymd — it lacks monthShort): full y/m/d + names */
        const p = TZ.parts(App.tz, t);
        const pp = prevT != null ? TZ.parts(App.tz, prevT) : null;
        if (pp && p.year !== pp.year) { const y = p.year; return { full: y, short: y }; }
        if (pp && p.month !== pp.month) { const m = p.monthShort; return { full: m, short: m }; }
        return { full: TZ.tickLabel(App.tz, t, 2, dowOn), short: String(parseInt(p.day, 10)) };
      };

      /* cheap recompute guard — the heavy pass (label DOM) only reruns when
         the view, zoom, stride, tz or broker offset change. ROUND90: the
         session token (axis length + the active cfg) also re-cuts the axis
         when the user edits the window/dates with an unchanged bar count. */
      const hook = App.sessionHook;
      const sessKey = useSess
        ? 'S' + times.length + '|' + JSON.stringify((hook && hook.cfg) ? hook.cfg() : null)
        : '';
      const key = [n, lastT, +lr.from.toFixed(2), +lr.to.toFixed(2), Math.round(v.pw),
        Math.round(v.axisW), Math.round(v.timeH), N, App.tz, off, tfSec, sessKey,
        Settings ? Settings.conf.dayOfWeek : true].join('|');
      if (el._k === key) return;
      el._k = key;

      const items = []; // { x, txt, grid, anchor }
      const gridXs = []; // the vertical grid rides the SAME uniform ticks
      const chain = [];
      const chainStarts = new Set(); // ROUND91: chain indices that are a region's FIRST tick
      const chainEnds = new Set();   // ROUND91: chain indices that are a region's LAST tick
      if (useSess) {
        /* ROUND90 — the user's ask: «نوار زمان باید با توجه به محدوده‌های
           انتخابی بریده بریده باشه و فقط اون زمان‌هایی که انتخاب شده رو
           نمایش بده». Every day region gets its OWN tick run anchored at
           the REGION START — identical in-window times under every region
           — and the gap columns between the regions plus both margins stay
           BLANK: no label, no grid line, no extrapolated time. The cadence
           N is the same bar-stride ladder the normal axis uses.
           ROUND91 — the user's follow-up, verbatim: «هر ناحیه رو زمانِ خودش
           رو دقیقا زیر خودِ ناحیه قرار بده» — the region's OWN start AND
           end times must both be printed under it. The region-start tick
           now always renders as its TIME (the day/date pill used to displace
           exactly that slot — the user saw "8" where 04:30 belonged), and
           the region's LAST bar is force-appended so the window's end edge
           (the user's 07:30-style bound) is labelled at the region's right
           edge — the pure stride used to stop short of it (07:15). */
        let regions = pane._sessRegions;
        if (!regions || pane._sessRegionsSrc !== times) {
          regions = sessionRegions(times, pane._sessGapIdx);
          pane._sessRegions = regions;
          pane._sessRegionsSrc = times;
        }
        const visLo = Math.max(0, Math.floor(lr.from) - 1);
        const visHi = Math.min(times.length - 1, Math.ceil(lr.to) + 1);
        for (let r = 0; r < regions.length; r++) {
          const rg = regions[r];
          if (rg.b < visLo || rg.a > visHi) continue;   // region fully off-screen
          chainStarts.add(chain.length);
          for (let j = rg.a; j <= rg.b; j += N) chain.push(times[j]);
          if ((rg.b - rg.a) % N !== 0) chain.push(times[rg.b]);
          chainEnds.add(chain.length - 1); // the region's own END time — always ticked
        }
      } else {
        const iLast = n - 1;
        const kFrom = Math.ceil((lr.from - iLast) / N) - 1;
        const kTo = Math.ceil((lr.to - iLast) / N) + 1;
        for (let k = kFrom; k <= kTo; k++) {
          const L = iLast + k * N;
          if (L < 0) continue;
          chain.push(U.logicalToTime(times, L));
        }
      }
      const texts = chain.map((t, i) => {
        /* ROUND91: a region's FIRST tick prints the REGION'S OWN START TIME —
           the day/date pill must never displace that slot (the user's ask:
           the region's time goes UNDER its own region). TV-style date pills
           survive only for a day rollover INSIDE a region (midnight-
           straddling windows). */
        if (chainStarts.has(i)) {
          const tm = TZ.tickLabel(App.tz, t, isSec ? 4 : (isIntra ? 3 : 2), false);
          return { full: tm, short: tm };
        }
        return labelFor(t, i ? chain[i - 1] : null);
      });
      /* ROUND91 placement — the user's required slots (a region's FIRST and
         LAST tick) are placed FIRST and EDGE-ANCHORED INSIDE their own
         region: the start text hangs RIGHT off the region's left edge, the
         end text hangs LEFT off the region's right edge. Two consequences
         the user was actually seeing before this: the next region's 04:30
         could be dropped for overlapping the previous region's 07:29 pill
         (only ~GAP_BARS slots apart), and a region ending near the right
         viewport edge lost its end label to the edge clip. Edge anchoring
         makes both impossible — the two labels live on opposite sides of
         the boundary, both INSIDE their own region. Interior stride labels
         then flow between them under the classic centered guard. */
      let li = 0;
      /* grid BEFORE label filters — every in-view chain tick keeps its grid
         line, exactly like the pre-ROUND91 single loop */
      for (let i = 0; i < chain.length; i++) {
        const gx = this._xOf(chain[i]);
        if (isFinite(gx) && gx >= 0 && gx <= v.pw) gridXs.push(Math.round(gx) + 0.5);
      }
      const placed = []; // {left, right} of every placed label
      const fits = (left, right) => {
        if (left < 0 || right > v.pw - 2) return false;   // never clipped at the edges (as before)
        for (let p = 0; p < placed.length; p++) {
          if (left < placed[p].right + 4 && right > placed[p].left - 4) return false;
        }
        return true;
      };
      const emit = (i, txt, x, anchor) => {
        items[li++] = { x, txt, grid: false, t: chain[i], anchor };
        const w = txt.length * 6.4 + 6;
        const left = anchor === 'l' ? x : (anchor === 'r' ? x - w : x - w / 2);
        placed.push({ left, right: left + w });
      };
      /* pass 1 — the required region edges (start = left-anchored, end = right-anchored) */
      for (let i = 0; i < chain.length; i++) {
        if (!chainStarts.has(i) && !chainEnds.has(i)) continue;
        const x = this._xOf(chain[i]);
        if (!isFinite(x) || x < -2 || x > v.pw + 2) continue;
        const lab = texts[i];
        if (!lab || typeof lab.full !== 'string') { try { Log.warn('drawing', 'tax-ext non-string label', { index: i, label: lab, tz: App.tz, count: N }); } catch (e) {} continue; }
        emit(i, lab.full, x, chainStarts.has(i) ? 'l' : 'r');
      }
      /* pass 2 — interior stride labels, centered, overlap-guarded (the
         ROUND41 degrade full→short is kept) */
      for (let i = 0; i < chain.length; i++) {
        if (chainStarts.has(i) || chainEnds.has(i)) continue;
        const x = this._xOf(chain[i]);
        if (!isFinite(x) || x < -2 || x > v.pw + 2) continue;
        const lab = texts[i];
        if (!lab || typeof lab.full !== 'string') { try { Log.warn('drawing', 'tax-ext non-string label', { index: i, label: lab, tz: App.tz, count: N }); } catch (e) {} continue; }
        const tryPlace = (txt) => {
          const w = txt.length * 6.4 + 6;
          if (!fits(x - w / 2, x + w / 2)) return false;
          emit(i, txt, x, 'c');
          return true;
        };
        if (tryPlace(lab.full)) continue;
        if (typeof lab.short === 'string' && lab.short !== lab.full) tryPlace(lab.short);
      }
      items.length = li;
      /* the live candle's own time whenever it is on screen — its TEXT wins
         over any grid label that would overlap it (round 23 behaviour kept).
         BUG-B/R25: the GRID stays purely cadence-aligned (TV) — the line at a
         spliced cadence position remains UNDER the live pill (grid continuity,
         no double-wide gap) and the live x is never added as a second, 8px
         neighbour line. */
      const xN = this._xOf(lastT);
      if (isFinite(xN) && xN >= 0 && xN <= v.pw) {
        const liveTxt = TZ.tickLabel(App.tz, lastT, isSec ? 4 : (isIntra ? 3 : 2), false);
        const minGap = Math.max(30, liveTxt.length * 6.4);
        for (let i = items.length - 1; i >= 0; i--) {
          if (Math.abs(items[i].x - xN) < minGap) items.splice(i, 1);
        }
        items.push({ x: xN, txt: liveTxt, grid: false });
      }
      this._taxGrid = gridXs.sort((a, b) => a - b)
        .filter((gx, i) => i === 0 || gx - gridXs[i - 1] > 1.5); // R25: the live tick can duplicate a cadence tick — dedupe
      el.style.height = v.timeH + 'px';
      el.style.right = v.axisW + 'px';
      el.innerHTML = items.map((p) => `<span>${p.txt}</span>`).join('');
      // round 81 CSP hardening: positions set via CSSOM (el.style.left = ...),
      // not the style="" string attribute, so style-src no longer needs 'unsafe-inline'.
      const spans = el.children;
      for (let i = 0; i < spans.length; i++) {
        spans[i].style.left = Math.round(items[i].x) + 'px';
        /* ROUND91: region-edge labels anchor INSIDE their region — the start
           pill grows right off the region's left edge, the end pill grows
           left off the region's right edge (see the placement comment) */
        const a = items[i].anchor;
        spans[i].style.transform = a === 'l' ? 'translate(0, -50%)'
          : (a === 'r' ? 'translate(-100%, -50%)' : 'translate(-50%, -50%)');
      }
      el.style.display = items.length ? 'block' : 'none';
    }

    /* ---------- BUG-C/R25 → round 31/32: live crosshair time bubble (topmost layer) ----------
       Replaces the native vertLine label (disabled in chartOptions) with a DOM
       pill rendered ABOVE the static .tax-ext labels. Round 31: the position
       comes from the RAW cursor (this._cross.x) — continuous TV-parity
       tracking; the label shows the interpolated time UNDER the cursor
       (logicalToTime also extrapolates into the future margin, right of the
       live bar). Synced panes carry t (the source time) — _xOf extrapolates
       it the same way, so sync works beyond the live bar too.
       ROUND 32 (user report): the pill used to set BOTH `left` AND `right`
       on an absolutely-positioned element with no width — the box then
       STRETCHED between the two edges (huge when the cursor was on the left,
       tiny on the right) and translateX(-50%) shifted it by half of that
       stretched width. The pill is now a compact TV-style label: width hugs
       its text (max-content, measured once per text), only `left` is set and
       the box is centered on the cursor x, clamped to the plot area. */
    _updateCrossBubble(v) {
      try { this._updatePax(v); } catch (e) {} /* ROUND49: price pill + (+) */
      const el = this.pane.taxLive;
      if (!el) return;
      const setOn = !Settings || Settings.conf.crosshair !== false;
      const c = this._cross;
      if (!c || !c.on || !setOn) {
        /* ROUND50: pinned in the (+) zone — hold the time pill where it was
           instead of erasing it mid-approach (crosshair-off still hides) */
        if (setOn && this._paxPin && this._paxPin()) return;
        if (el.style.display !== 'none') { el.style.display = 'none'; }
        return;
      }
      const pane = this.pane;
      /* ROUND93 (user report): the mouse crosshair pill showed the WRONG
         time on Custom Session charts — the static axis (_xOf/_updateTaxExt)
         already reads through the GAP-INCLUSIVE frame (this._timeArr(),
         pane._sessWithGapTimes) so day-region boundaries line up, but this
         non-synced branch mapped the cursor's logical index straight through
         pane.barTimes — the COMPACT, gap-FREE array. The chart's own logical
         coordinate space (what coordinateToLogical returns) counts the
         whitespace gap rows the series was actually fed, so past the first
         day boundary every index landed GAP_BARS slots into the wrong bar
         (same frame mismatch round-87 fixed for _xOf/Pine drawings — this
         one spot was missed). Reading through this._timeArr() puts the
         crosshair on the exact same frame as everything else. */
      const timeArr = this._timeArr();
      const n = timeArr.length;
      if (!n) { el.style.display = 'none'; return; }
      let t, x;
      if (c.t != null && isFinite(c.t)) {
        /* synced crosshair: the SOURCE pane's time drives the position —
           works across timeframes and in the future margin (extrapolation) */
        t = c.t;
        x = this._xOf(t);
      } else {
        x = c.x;
        const l = this._lOf(x);
        if (l == null) { el.style.display = 'none'; return; }
        t = U.logicalToTime(timeArr, l); // continuous time under the cursor
      }
      if (!isFinite(t) || !isFinite(x)) { el.style.display = 'none'; return; }
      const isSec = v.tfSec < 60;
      /* round 34: TV-parity pill — date rides next to the time
         ("Mon 07 Sep '26  12:51"); D/W/M charts show the date only */
      const txt = TZ.crossLabel(App.tz, t, isSec, v.tfSec >= 86400);
      if (el._txt !== txt) { el.textContent = txt; el._txt = txt; }
      el.style.display = 'block';
      el.style.right = 'auto';      // round 32: never stretch between left+right
      el.style.width = 'max-content';
      el.style.height = 'auto';
      /* measure the REAL pill width (text changed -> one forced reflow, cached
         per text); the estimate is only a fallback before the first paint */
      let w = (txt.length * 6.6 + 12);
      if (el._txt === txt && el.offsetWidth > 0) w = el.offsetWidth;
      const hw = w / 2;
      el.style.left = Math.round(U.clamp(x, Math.min(hw + 1, v.pw / 2), Math.max(v.pw - hw - 1, v.pw / 2))) + 'px';
      el.style.bottom = Math.max(2, Math.round((v.timeH - 19) / 2)) + 'px';
    }

    /* ROUND49 (TV): the price-scale hover highlight pill + the (+) action
       button locked next to it. Shown only for the BARE cursor tools
       (Arrow/Dot) — in Cross mode the NATIVE horzLine label plays this role
       (no double chip). While the (+) menu is open (pane._paxFrozen) the pair
       pins to the frozen price even when the pointer leaves the pane. */
    _updatePax(v) {
      const pane = this.pane;
      const pl = pane.paxLive, pa = pane.paxAdd;
      if (!pl || !pa) return;
      const hide = () => {
        if (pl.style.display !== 'none') pl.style.display = 'none';
        if (pa.style.display !== 'none') pa.style.display = 'none';
      };
      const setOn = !Settings || Settings.conf.crosshair !== false;
      const c = this._cross;
      const frozen = !!(pane._paxFrozen && pane._paxFrozenPrice != null);
      /* ROUND50 (user report): sticky pin — while the pointer is in the (+)
         zone (over the price-scale strip, or sitting on the (+) button) the
         pair must NEVER be erased by a render, or it dies mid-approach and
         the button cannot be clicked. On the scale the pair rides the
         cursor's Y live (TV axis hover); on the button it holds the last
         tracked price. */
      const pin = (!frozen && setOn) ? this._paxPin() : null;
      let y = null;
      if (frozen) {
        try {
          const py = pane.series.priceToCoordinate(pane._paxFrozenPrice);
          if (py != null && isFinite(py)) y = py;
        } catch (e) {}
      } else if (c && c.on && setOn && c.y != null && c.y >= 0) {
        /* every cursor mode tracks the (+) button — the DOM PILL is for the
           bare tools only (Cross keeps the native horzLine label) */
        y = c.y;
      } else if (pin) {
        const m = this.mouse;
        if (pin.axis && m && m.inside && m.y != null && m.y >= 0) y = m.y;
        else if (this._paxLastY != null) y = this._paxLastY;
      }
      if (y == null) { this._paxLastY = null; hide(); return; }
      let price = frozen ? pane._paxFrozenPrice : null;
      if (price == null || !isFinite(price)) {
        price = null;
        try {
          const sub = this._subAt(y);
          if (sub && sub.first) price = sub.first.coordinateToPrice(y - sub.top);
          else price = pane.series.coordinateToPrice(y);
        } catch (e) {}
      }
      if (price == null || !isFinite(price)) { hide(); return; }
      pane._paxPrice = price;
      const txt = U.fmtPrice(price, pane.digits != null ? pane.digits : 5);
      if (pl._txt !== txt) { pl.textContent = txt; pl._txt = txt; }
      const ax = (v && v.axisW) ? v.axisW : 62;
      const ph = (v && v.ph) ? v.ph : this.canvas.clientHeight;
      const top = U.clamp(Math.round(y), 10, Math.max(10, ph - 10)) - 10;
      /* the pill: bare tools, frozen, or pinned in the (+) zone (Cross owns
         the native label over the plot; over the scale/button the native
         label is gone or covered — the chip must stay, all three modes) */
      if (frozen || (c && c.bare) || pin) {
        if (pl.style.display !== 'block') pl.style.display = 'block';
        pl.style.right = '0px';
        if (pl._w !== ax) { pl.style.width = ax + 'px'; pl._w = ax; }
        pl.style.top = top + 'px';
      } else if (pl.style.display !== 'none') pl.style.display = 'none';
      if (pa.style.display !== 'flex') pa.style.display = 'flex';
      pa.style.right = (ax + 6) + 'px';
      pa.style.top = top + 'px';
      this._paxLastY = y; /* ROUND50: remember for the pin */
    }

    /* ROUND51 (user request): selected price-alert chrome — a small delete
       chip that rides the selected alert's line next to the price scale;
       clicking it removes the alert right from the chart (no panel trip).
       Hidden whenever nothing (or no local alert) is selected. */
    _updateAlertSel(v) {
      const pane = this.pane;
      const chip = pane.alertDel;
      if (!chip) return;
      const id = Alerts.selected;
      const a = (id != null && Alerts.list)
        ? Alerts.list.find((x) => x.id === id && x.kind !== 'time' && x.symbol === pane.symbol)
        : null;
      if (!a || a.price == null || !isFinite(a.price) || pane._paxFrozen) {
        if (chip.style.display !== 'none') chip.style.display = 'none';
        return;
      }
      let y = null;
      try { y = pane.series.priceToCoordinate(a.price); } catch (e) {}
      const ph = (v && v.ph) ? v.ph : this.canvas.clientHeight;
      if (y == null || !isFinite(y) || y < 10 || y > ph - 6) {
        if (chip.style.display !== 'none') chip.style.display = 'none';
        return;
      }
      if (chip.style.display !== 'flex') chip.style.display = 'flex';
      chip.style.right = (((v && v.axisW) ? v.axisW : 62) + 8) + 'px';
      chip.style.top = (Math.round(y) - 10) + 'px';
    }

    /* ROUND50 (user report): the (+) PIN ZONE. Sliding toward the (+) used to
       erase everything — the engine zeroed the cross on the price-scale strip
       and on the canvas mouseleave, and the next data-tick render hid the
       pill + button before the click could land. While the pointer hovers the
       price scale or the (+) button itself, the pair survives every render. */
    _paxPin() {
      if (this.mode === 'pan') return null;
      const m = this.mouse;
      if (m && m.inside && m.x != null && m.y != null && this._axisRegion(m.x, m.y) === 'price') return { axis: true };
      try {
        const pa = this.pane.paxAdd;
        if (pa && pa.style.display !== 'none' && pa.matches(':hover')) return { btn: true };
      } catch (e) {}
      return null;
    }

    /* round 31: dash array for the engine-drawn vertical crosshair line
       (Settings > Canvas > Crosshair style) — mirrors the native LWC look */
    _crossDash() {
      const s = Settings ? Settings.conf.crossStyle : 'largedashed';
      /* ROUND51 (user report): the painted vertical and the native horzLine
         must share ONE pattern — these now mirror LWC's own styleToDash
         arrays 1:1 (lineWidth 1: Dotted=[1,1] Dashed=[2,2] LargeDashed=[6,6]),
         so both crosshair lines are pixel-identical dashes. */
      return { solid: [], dotted: [1, 1], dashed: [2, 2], largedashed: [6, 6] }[s] || [6, 6];
    }

    /* ROUND132: the Bar Replay pick graphic (see panels/replay.toggle).
       Runs while engine.replayPick is armed and the cursor is over THIS
       pane — theme-aware veil, TV-blue line + badge + date pill. */
    _drawReplayPick(v) {
      const x = this.mouse.x;
      if (!(x >= 0) || x > v.pw) return;
      const ctx = this.ctx;
      const light = document.body.classList.contains('theme-light');
      /* veil over the region a click will cut away (right of the line) */
      ctx.save();
      ctx.fillStyle = light ? 'rgba(60,65,80,.13)' : 'rgba(131,139,153,.20)';
      ctx.fillRect(x, 0, Math.max(0, v.pw - x), v.ph);
      ctx.restore();
      /* the pick line (TV blue) */
      const xl = Math.round(x) + 0.5;
      ctx.save();
      ctx.strokeStyle = '#2962ff';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(xl, 0);
      ctx.lineTo(xl, v.ph);
      ctx.stroke();
      ctx.restore();
      /* circled-play badge riding the top of the line (TV's start marker) */
      const by = 20;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, by, 11, 0, Math.PI * 2);
      ctx.fillStyle = '#2962ff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = light ? '#ffffff' : '#131722';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 2.6, by - 4.6);
      ctx.lineTo(x + 5, by);
      ctx.lineTo(x - 2.6, by + 4.6);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();
      /* date pill: the bar under the cursor would become the replay start */
      try {
        const t = U.nearestIndex(this.pane.barTimes, this._tOf(x));
        const bt = this.pane.barTimes[t];
        if (bt != null) {
          const sec = App.tfById[this.pane.tf] ? App.tfById[this.pane.tf].sec : 60;
          const txt = TZ.crossLabel(App.tz, bt, sec < 60, sec >= 86400);
          ctx.save();
          ctx.font = '600 11px "Segoe UI", Roboto, -apple-system, sans-serif';
          const tw = ctx.measureText(txt).width;
          const pw = tw + 16, phh = 20, px = x + 16, py = 10;
          const flip = px + pw > v.pw;
          const rx = flip ? x - 16 - pw : px;
          ctx.beginPath();
          const rr = 4;
          ctx.moveTo(rx + rr, py);
          ctx.arcTo(rx + pw, py, rx + pw, py + phh, rr);
          ctx.arcTo(rx + pw, py + phh, rx, py + phh, rr);
          ctx.arcTo(rx, py + phh, rx, py, rr);
          ctx.arcTo(rx, py, rx + pw, py, rr);
          ctx.closePath();
          ctx.fillStyle = '#2962ff';
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.textBaseline = 'middle';
          ctx.fillText(txt, rx + 8, py + phh / 2 + 0.5);
          ctx.restore();
        }
      } catch (e) {}
    }

    render() {
      const cv = this.canvas;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      const W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      /* ROUND41: the grid UNDERLAY (pane.gridCv, behind the chart canvas)
         rides the same DPR sizing and is cleared every frame BEFORE any
         early return below — a data switch or a vGrid toggle never leaves
         stale grid lines behind. The grid itself is painted after
         _updateTaxExt (same cadence as the axis labels). */
      if (this.pane.gridCv) {
        const g = this.pane.gridCv;
        const GW = Math.round(w * dpr), GH = Math.round(h * dpr);
        if (g.width !== GW || g.height !== GH) { g.width = GW; g.height = GH; }
        const gctx = g.getContext('2d');
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        gctx.clearRect(0, 0, w, h);
      }
      const pane = this.pane;
      /* round 33 FIX: the watermark and the brand wordmark belong to the PRICE
         pane (TV) — their anchor is the price pane's geometry, NOT a lift from
         the host bottom. The old `bottom = axis + subLift` collapsed the wm
         box to zero height (CSS top:0 fought the inline bottom) and pushed
         the brand ABOVE the host (invisible = "watermark removed" report).
         Now: wm box spans the price pane exactly; brand sits 8px above the
         price pane's bottom edge (the sub-pane boundary when panes exist). */
      {
        let aw = 62;
        try { aw = pane.chart.priceScale('right').width() || aw; } catch (e) {}
        const hostH = pane.host ? pane.host.clientHeight : 0;
        const mainH = (pane._mainPlotH && pane._mainPlotH > 0)
          ? pane._mainPlotH
          : Math.max(0, hostH - (pane._subs && pane._subs.size ? 0 : 26));
        if (pane.wm) {
          const key = aw + '|' + mainH;
          if (pane.wm._k !== key) {
            pane.wm._k = key;
            pane.wm.style.top = '0px';
            pane.wm.style.height = mainH + 'px';
            pane.wm.style.bottom = 'auto';  // never fight `top` (height collapsed to 0 before)
            pane.wm.style.right = aw + 'px';
          }
        }
        /* BUG-012 keeps the breathing room: 8px above the price pane's bottom */
        if (pane.brand) {
          const bkey = 'b' + hostH + '|' + mainH;
          if (pane.brand._k !== bkey) {
            pane.brand._k = bkey;
            pane.brand.style.bottom = Math.max(8, hostH - mainH + 8) + 'px';
          }
        }
      }
      if (!pane.barTimes.length) {
        // data switching over: never leave stale future labels behind
        if (pane.tax && pane.tax.style.display !== 'none') { pane.tax.style.display = 'none'; pane.tax._k = ''; }
        if (pane.taxLive && pane.taxLive.style.display !== 'none') pane.taxLive.style.display = 'none';
        /* ROUND66: nor stale highlight tags */
        if (pane.taxTags && pane.taxTags.firstChild) pane.taxTags.innerHTML = '';
        this._taxGrid = null;
        return;
      }
      let v;
      try { v = this.view(); } catch (e) { return; }
      this._view = v; // ROUND39: last geometry for the context-menu (alert price/time under cursor)

      /* ROUND66: the time-axis highlight layer (.tax-tags) — geometry matches
         .tax-ext (plot width only, right edge = the price axis) and it is
         rebuilt EVERY frame BEFORE the drawings/painters append this frame's
         tags, so pan/zoom/deletion can never leave a stale pill behind */
      if (pane.taxTags) {
        const tt = pane.taxTags;
        tt.style.width = v.pw + 'px';
        tt.style.height = v.timeH + 'px';
        tt.style.right = v.axisW + 'px';
        if (tt.firstChild) tt.innerHTML = '';
        tt._placed = null;
      }

      /* "Scroll to the most recent bar" (TV): visible only when the view has
         been scrolled away from the live bar; sits just left of the price bar */
      if (pane.goLive) {
        let lr = null;
        try { lr = pane.chart.timeScale().getVisibleLogicalRange(); } catch (e) {}
        const n = pane.barTimes.length;
        const away = !!(lr && n && lr.to < n - 0.6);
        if (away !== pane.goLive._shown) {
          pane.goLive._shown = away;
          pane.goLive.style.display = away ? '' : 'none';
        }
        if (away) {
          pane.goLive.style.right = (v.axisW + 10) + 'px';
          pane.goLive.style.bottom = (v.timeH + 10) + 'px';
        }
      }

      /* future time labels + live-candle time on the time axis (round 23) */
      this._updateTaxExt(v);

      /* BUG-C/R25: crosshair time bubble as the TOPMOST axis layer */
      this._updateCrossBubble(v);

      /* ROUND51 (user request): the selected alert's floating delete chip
         rides its level every frame */
      this._updateAlertSel(v);

      /* BUG-002 + ROUND41: vertical grid lines at the ONE uniform axis
         cadence — the same positions the labels sit on (the native vertical
         grid is off, see manager.js chartOptions). They now paint on the
         pane's UNDERLAY canvas (pane.gridCv, z 0 — BEHIND the chart canvas,
         user report: the grid must sit under the candles, never over them);
         the overlay canvas (z 10) stays for separators / drawings / the
         crosshair. The Canvas tab's "Vertical grid lines" toggle + grid
         color still drive this painter. */
      {
        const S = Settings ? Settings.conf : {};
        const gctx = pane.gridCv ? pane.gridCv.getContext('2d') : null;
        if (gctx && this._taxGrid && this._taxGrid.length && S.vGrid !== false) {
          gctx.save();
          gctx.strokeStyle = S.gridColor || 'rgba(42,46,57,.55)';
          gctx.lineWidth = 1;
          gctx.beginPath();
          for (const gx of this._taxGrid) {
            if (gx < 0 || gx > v.pw) continue;
            gctx.moveTo(gx, 0);
            gctx.lineTo(gx, v.ph);
          }
          gctx.stroke();
          gctx.restore();
        }
      }

      /* Period separators (MT5): dashed verticals where the day/week/month rolls.
         Boundaries are computed in SERVER time (the chart time base) so they
         land exactly on the broker's session days. */
      this._drawPeriodSep(v);

      /* TV: drawings pass UNDER the price bar / time bar — every drawing is
         clipped to the plot area; the axis tags collected by priceTag/timeTag
         are flushed after the clip is popped (they belong ON the axis).
         round 32: drawings clip to the PRICE pane's plot (mainH) — they are
         anchored to prices and must never paint over indicator sub-panes.
         round 37 EXCEPTION: the VERTICAL LINE spans the whole pane stack
         (fullStack clip -> v.ph), exactly like the crosshair vertical —
         TV parity the user asked for. */
      const clipPlot = (fullStack) => {
        ctx.beginPath();
        ctx.rect(0, 0, v.pw, fullStack ? v.ph : (v.mainH || v.ph));
        ctx.clip();
      };

      if (!App.hideAll) {
        const items = App.drawings.list(pane.symbol);
        for (const d of items) {
          const def = TOOLS[d.type];
          if (!def) continue;
          if (d.hidden) continue; // Object Tree eye
          if (DrawSettings && !DrawSettings.isVisible(d, v.tfSec)) continue; // Visibility tab
          const sel = !!(App.selection && App.selection.pane === pane && App.selection.d === d);
          ctx.save();
          ctx.globalAlpha = 1;
          clipPlot(d.type === 'vline');
          try { def.draw(v, d, sel); } catch (e) {}
          if (sel) {
            let hs = [];
            try { hs = def.handles ? def.handles(v, d) || [] : []; } catch (e) {}
            hs.forEach((hxy, i) => {
              ctx.save();
              ctx.setLineDash([]);
              ctx.beginPath();
              ctx.arc(hxy[0], hxy[1], 5.5, 0, Math.PI * 2);
              ctx.fillStyle = this._th('handleFill', '#ffffff');
              ctx.fill();
              ctx.lineWidth = 1.6;
              ctx.strokeStyle = (this.mode === 'handle' && this.handleIdx === i) ? '#2962ff' : this._th('handleStroke', '#9598a1');
              ctx.stroke();
              ctx.restore();
            });
          }
          ctx.restore();
        }
      }

      /* ROUND39: vertical overlay marks (Economic News flags, time-based
         alerts). Registered as painters on App.overlayMarkPainters so the
         engine stays generic; each painter draws with the FULL-STACK clip
         (spans price pane + indicator sub-panes, like the cross/vline).
         The render loop repaints every frame, so pan/zoom/ticks never leave
         stale marks. Runs even when App.hideAll (marks are not drawings). */
      {
        const painters = App.overlayMarkPainters;
        if (painters && painters.length && pane.barTimes && pane.barTimes.length) {
          for (const f of painters) {
            ctx.save();
            clipPlot(true);
            try { f(pane, v, ctx); } catch (e) {}
            ctx.restore();
          }
        }
      }

      // creation preview (also under the axis bars)
      if (this.temp) {
        const def = TOOLS[this.temp.type];
        if (def) {
          ctx.save();
          ctx.globalAlpha = 1;
          clipPlot(this.temp.type === 'vline'); // round 37: vline previews full-stack too
          try {
            /* ROUND69: multi-point tools (Path/Polyline) always preview the
               cursor as the next point, whatever their minimum point count */
            if ((this.temp.points.length < def.pts || def.polyFinish) && this.mouse.inside) {
              const pt = this.snap(this.mouse.x, this.mouse.y);
              def.draw(v, { type: this.temp.type, points: this.temp.points.concat([pt]), opts: this.temp.opts }, false);
            } else {
              def.draw(v, this.temp, false);
            }
          } catch (e) {}
          ctx.restore();
        }
      }

      /* round 31: TV cross mode — the VERTICAL line is painted HERE on the
         overlay at the RAW cursor x: continuous 1:1 tracking (no bar snapping
         while it moves) and it keeps moving into the future margin, right of
         the live bar. The native vertLine is disabled (manager.chartOptions /
         Settings.applyPane) because LWC clamps its crosshair index to the
         last bar for future times (timeToIndex findNearest) — that native
         clamp is what pinned the crosshair at the live market. The horizontal
         line + its price-axis label stay native (they track the raw mouse
         price correctly). Synced panes draw it from the source time (t). */
      {
        const S = Settings ? Settings.conf : {};
        const cx = this._cross ? this._cross.x : -1;
        /* ROUND39 (TV parity): bare cursor tools (Arrow/Dot) never paint the
           vertical crosshair — matches the hidden native horzLine */
        const tdP = App.tool ? TOOLS[App.tool] : null;
        const bareCursor = !!(tdP && tdP.cursorTool && !tdP.crosshair);
        if (!bareCursor && this._cross && this._cross.on && S.crosshair !== false && cx >= 0 && cx <= v.pw) {
          ctx.save();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = S.crossColor || '#758696';
          ctx.lineWidth = 1;
          ctx.setLineDash(this._crossDash());
          const xLine = Math.round(cx) + 0.5;
          ctx.beginPath();
          ctx.moveTo(xLine, 0);
          ctx.lineTo(xLine, v.ph);
          ctx.stroke();
          ctx.restore();
        }
      }

      /* ROUND132: Bar Replay ARMED pick (TV parity) — the chart shows what a
         click will do: TV-blue line at the cursor, circled-play badge, the
         candidate start-date pill, and a veil over the region a click will
         cut away (everything RIGHT of the line). Painted late so it sits
         above drawings/marks, still under the axis-tag flush. */
      if (this.replayPick && this.mouse.inside) {
        try { this._drawReplayPick(v); } catch (e) {}
      }

      // flush axis tags (hline/crossline PRICE labels) — drawn ON the axis strips
      // (ROUND66: the TIME tags moved to the .tax-tags DOM layer above the numbers)
      if (v.axisQueue.length) {
        ctx.save();
        ctx.globalAlpha = 1;
        for (const f of v.axisQueue) { try { f(); } catch (e) {} }
        ctx.restore();
      }
    }
  }

export { Engine };
