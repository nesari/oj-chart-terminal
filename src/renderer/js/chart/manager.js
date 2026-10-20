/**
 * Chart manager: panes, layouts (resizable), data, ticks, legend, countdown, render loop
 *
 * @module chart/manager
 */

import { U } from '../core/util.js';
import { Log } from '../../../core/logger.js';
import { AppErr } from '../../../core/errors.js';
import { icon } from '../ui/icons.js';
import { TZ } from '../../../core/timezone.js';
import { Theme } from '../core/theme.js';
import { App } from '../../../core/state.js';
import { Settings } from './settings.js';
import { Engine } from '../drawing/engine.js';
import { Indicators } from '../../../core/indicators.js';
import { IndicatorsUI, recompute as indRecompute, tickRecompute as indTickRecompute, updateIndicatorRows as indUpdateRows, dropPane as indDropPane } from './indicators-ui.js';
import { PineUI } from './pine-ui.js';
import { Toolbar } from './toolbar.js';
import { UI } from '../drawing/ui.js';
import { Watchlist } from '../panels/watchlist.js';
import { Alerts } from '../panels/alerts.js';
import { DataWindow } from '../panels/datawindow.js';
import { ObjectTree } from '../panels/objects.js';
import { Replay } from '../panels/replay.js';

const LWC = window.LightweightCharts;

  const Manager = {};

  function chartOptions(pane) {
    const tf = App.tfById[pane.tf];
    const isSec = tf.sec < 60;
    const isIntraday = tf.sec < 86400;
    const S = Settings ? Settings.conf : {};
    /* ROUND40: the map MUST follow LWC's LineStyle enum (Solid=0, Dotted=1,
       Dashed=2, LargeDashed=3, SparseDotted=4). The old dotted:3/largedashed:4
       rendered the horzLine as sparse dots while the engine-painted vertLine
       dashed — the user's "vertical one style, horizontal another" report. */
    const crossStyle = { solid: 0, dotted: 1, dashed: 2, largedashed: 3 }[S.crossStyle] ?? 3;
    return {
      // transparent canvas so the watermark layer (behind the chart) shows through;
      // the user background lives on the host element (see Settings.applyPane)
      layout: { background: { type: 'solid', color: 'rgba(0,0,0,0)' }, textColor: S.scaleText || '#d1d4dc', fontSize: S.scaleFont || 11, fontFamily: "'Segoe UI', Arial, sans-serif", attributionLogo: false },
      grid: {
        /* BUG-002: vertical grid is drawn by the engine at the ONE uniform
           axis cadence (Engine.render, from the same tick positions as the
           labels) — the native vertical lines follow lightweight-charts'
           index-based ticks and would no longer match the labels */
        vertLines: { color: S.gridColor || 'rgba(42,46,57,.55)', visible: false },
        horzLines: { color: S.gridColor || 'rgba(42,46,57,.55)', visible: S.hGrid !== false },
      },
      rightPriceScale: { borderColor: S.scaleLines || '#2a2e39', visible: true, scaleMargins: priceMargins() },
      leftPriceScale: { borderColor: S.scaleLines || '#2a2e39', visible: false, scaleMargins: priceMargins() },
      timeScale: chartTimeScaleOpts(pane),
      crosshair: {
        /* Normal = the horzLine follows the RAW mouse price (Magnet — the lib
           default — would snap it to bar values). Round 31: the native
           vertLine is DISABLED. It painted on the lib canvas UNDER the
           .tax-ext DOM strip (covered by the static labels), and — the
           round-31 report — LWC clamps its crosshair index to the LAST BAR
           for future times (timeToIndex findNearest), so the line got pinned
           at the live market and could not follow the cursor into the future
           margin. The engine now owns the whole vertical: line (raw cursor x)
           + .tax-live pill (Engine._updateCrossBubble). The horzLine + its
           price label stay native — they track the raw mouse price on the
           price axis correctly. */
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: S.crossColor || '#758696', width: 1, style: crossStyle, labelBackgroundColor: '#363a45', labelVisible: false, visible: false },
        horzLine: { color: S.crossColor || '#758696', width: 1, style: crossStyle, labelBackgroundColor: '#363a45', visible: S.crosshair !== false },
      },
      localization: {
        locale: 'en',
        /* round 34: crosshair time label carries the date too (TV parity) —
           "Mon 07 Sep '26  12:51"; date-only on D/W/M charts */
        timeFormatter: (time) => TZ.crossLabel(App.tz, time, isSec, !isIntraday),
      },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: false, vertTouchDrag: false },
      // pressedMouseMove lets LWC pan the chart on BOTH axes natively — the engine
      // forwards the initial body-drag mousedown when auto-scale is off (free pan);
      // price-axis drag/zoom is implemented in the engine (margins) because the
      // lib's own price-axis gesture chain is inert in this build
      // price-axis drag-zoom (used synthetically for TV-like wheel-over-price-scale)
      handleScale: {
        mouseWheel: false, pinch: false,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
      autoSize: false,
    };
  }

  /* time-scale options (shared by chartOptions and Settings.applyPane) */
  function chartTimeScaleOpts(pane) {
    const tf = App.tfById[pane.tf];
    const isSec = tf.sec < 60;
    const isIntraday = tf.sec < 86400;
    const S = Settings ? Settings.conf : {};
    return {
      borderColor: S.scaleLines || '#2a2e39', rightOffset: U.clamp(S.marginRight != null ? S.marginRight : 10, 0, 100), barSpacing: 8,
      timeVisible: isIntraday, secondsVisible: isSec,
      /* BUG-002: native tick TEXT is suppressed. lightweight-charts picks its
         ticks per index and RESTARTS the run at every day boundary, and never
         labels the right-offset (future) area — the axis ended up with three
         different steps (90 / 60 / 45 min in the report). The engine now owns
         the WHOLE strip with one uniform, grid-aligned cadence
         (Engine._updateTaxExt); the native labels would only double-print
         over it. Crosshair bubble / timeFormatter above are untouched. */
      tickMarkFormatter: () => '',
    };
  }
  Manager.chartTimeScaleOpts = chartTimeScaleOpts;
  Manager.defaultPriceMargins = priceMargins;

  /* price-scale margins from the Canvas > Margins settings (%) */
  function priceMargins() {
    const S = Settings ? Settings.conf : {};
    const t = U.clamp((S.marginTop != null ? S.marginTop : 8) / 100, 0, 0.6);
    const b = U.clamp((S.marginBottom != null ? S.marginBottom : 8) / 100, 0, 0.6);
    return { top: t, bottom: Math.min(b, 1 - t - 0.05) };
  }
  Manager.priceMargins = priceMargins;

  /* candle/bar colors + toggles from the Symbol settings */
  function styleColors() {
    const S = Settings ? Settings.conf : {};
    const single = S.colorPrevClose === false; // one color for every bar
    return {
      up: S.upColor || '#089981',
      down: single ? (S.upColor || '#089981') : (S.downColor || '#f23645'),
      borderUp: single ? (S.upColor || '#089981') : (S.borderUpColor || '#089981'),
      borderDown: single ? (S.upColor || '#089981') : (S.borderDownColor || '#f23645'),
      wickUp: single ? (S.upColor || '#089981') : (S.wickUpColor || '#089981'),
      wickDown: single ? (S.upColor || '#089981') : (S.wickDownColor || '#f23645'),
      borders: S.bordersOn !== false,
      body: S.bodyOn !== false,
      wick: S.wickOn !== false,
    };
  }

  function seriesOptions() {
    const c = styleColors();
    return {
      upColor: c.body ? c.up : 'rgba(0,0,0,0)',
      downColor: c.body ? c.down : 'rgba(0,0,0,0)',
      wickUpColor: c.wick ? c.wickUp : 'rgba(0,0,0,0)',
      wickDownColor: c.wick ? c.wickDown : 'rgba(0,0,0,0)',
      borderUpColor: c.borders ? c.borderUp : 'rgba(0,0,0,0)',
      borderDownColor: c.borders ? c.borderDown : 'rgba(0,0,0,0)',
      borderVisible: c.borders,
    };
  }

  /* ---------- style engine (TV chart types) ---------- */
  /* Deep price-axis zoom (TV): the engine zooms the price window about an anchor
     and every series of the pane reports that window through its
     autoscaleInfoProvider — the scale then renders EXACTLY the zoomed window
     (margins from the settings still apply inside it). No margins-based cap. */
  Manager.priceZoomProvider = function (pane) {
    return function (base) {
      const pz = pane && pane.pz;
      if (pz && pz.active && isFinite(pz.span) && pz.span > 0 && isFinite(pz.center)) {
        /* LWC AutoscaleInfo contract: { priceRange: {minValue, maxValue}, margins? } */
        return { priceRange: { minValue: pz.center - pz.span / 2, maxValue: pz.center + pz.span / 2 } };
      }
      return base ? base() : null;
    };
  };
  function makeSeries(chart, style, pane) {
    const so = seriesOptions();
    const prov = pane ? Manager.priceZoomProvider(pane) : null;
    const opt = (o) => (prov ? Object.assign({ autoscaleInfoProvider: prov }, o) : o);
    if (style === 'line' || style === 'linemarkers') return chart.addLineSeries(opt({ color: '#2962ff', lineWidth: 2, priceLineVisible: true, lastValueVisible: true }));
    if (style === 'step') return chart.addLineSeries(opt({ color: '#2962ff', lineWidth: 2, lineType: LightweightCharts.LineType.WithSteps }));
    if (style === 'area') return chart.addAreaSeries(opt({ lineColor: '#2962ff', topColor: 'rgba(41,98,255,.35)', bottomColor: 'rgba(41,98,255,0)', lineWidth: 2 }));
    if (style === 'baseline') {
      return chart.addBaselineSeries(opt({
        baseValue: 0,
        topLineColor: '#2962ff', topFillColor1: 'rgba(41,98,255,.28)', topFillColor2: 'rgba(41,98,255,.03)',
        bottomLineColor: '#f23645', bottomFillColor1: 'rgba(242,54,69,.03)', bottomFillColor2: 'rgba(242,54,69,.28)',
      }));
    }
    if (style === 'bars') return chart.addBarSeries(opt({ upColor: so.upColor, downColor: so.downColor, openVisible: true, thinLineWidth: 2 }));
    if (style === 'highlow') return chart.addBarSeries(opt({ upColor: so.upColor, downColor: so.downColor, openVisible: true, thinLineWidth: 1 }));
    return chart.addCandlestickSeries(opt(so)); // candles / hollow / heikin / renko
  }

  function transformData(style, bars) {
    if (style === 'line' || style === 'area' || style === 'step' || style === 'linemarkers' || style === 'baseline') {
      return bars.map((b) => ({ time: b.time, value: b.close }));
    }
    if (style === 'hollow') {
      const c = styleColors();
      const upB = c.wick ? c.borderUp : 'rgba(0,0,0,0)';
      const dnB = c.wick ? c.borderDown : 'rgba(0,0,0,0)';
      return bars.map((b) => {
        const up = b.close >= b.open;
        return {
          time: b.time, open: b.open, high: b.high, low: b.low, close: b.close,
          color: up ? 'rgba(0,0,0,0)' : (c.body ? c.borderDown : 'rgba(0,0,0,0)'),
          borderColor: up ? upB : dnB,
          wickColor: up ? upB : dnB,
        };
      });
    }
    if (style === 'heikin') {
      const out = [];
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const hc = (b.open + b.high + b.low + b.close) / 4;
        const ho = i ? (out[i - 1].open + out[i - 1].close) / 2 : (b.open + b.close) / 2;
        out.push({ time: b.time, open: ho, close: hc, high: Math.max(b.high, ho, hc), low: Math.min(b.low, ho, hc) });
      }
      return out;
    }
    return bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
  }

  /* ----- renko ----- */
  function snapNice(a) {
    if (!(a > 0)) return 0;
    const p = Math.pow(10, Math.floor(Math.log10(a)));
    const r = a / p;
    return (r >= 5 ? 5 : r >= 2.5 ? 2.5 : r >= 2 ? 2 : 1) * p;
  }
  function atrBrickSize(bars, digits) {
    const n = Math.min(bars.length - 1, 120);
    if (n < 2) return 0;
    let sum = 0, cnt = 0;
    for (let i = bars.length - n; i < bars.length; i++) {
      const b = bars[i], p = bars[i - 1];
      if (!p) continue;
      sum += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
      cnt++;
    }
    if (!cnt) return 0;
    return snapNice(sum / cnt);
  }
  function renkoSizeFor(pane) {
    const manual = Settings && Settings.conf.renkoBrick ? parseFloat(Settings.conf.renkoBrick) : 0;
    if (manual > 0) return manual;
    if (!pane._renkoSize) pane._renkoSize = atrBrickSize(pane.bars, pane.digits) || U.pointSize(pane.digits || 5) * 20;
    return pane._renkoSize;
  }
  function renkoBricks(bars, size, stepSec) {
    const out = [];
    if (!bars.length || !(size > 0)) return out;
    let base = bars[0].open;
    for (const b of bars) {
      let guard = 0;
      while (b.close >= base + size && guard++ < 5000) {
        out.push({ open: base, close: base + size, up: true });
        base += size;
      }
      guard = 0;
      while (b.close <= base - size && guard++ < 5000) {
        out.push({ open: base, close: base - size, up: false });
        base -= size;
      }
    }
    // even spacing (TV-like): bricks are placed by index, ending at the last bar time
    const step = Math.max(1, stepSec || 60);
    const endT = bars[bars.length - 1].time;
    const nb = out.length;
    for (let i = 0; i < nb; i++) {
      const bk = out[i];
      const t = endT - (nb - 1 - i) * step;
      bk.time = t;
      bk.high = Math.max(bk.open, bk.close);
      bk.low = Math.min(bk.open, bk.close);
    }
    return out;
  }

  /* ---------- data feeding (single entry point) ---------- */
  /* BUG-007 root-cause guard: the series (price scale) and pane.bars (legend)
     must NEVER diverge. A payload with non-finite OHLC or non-ascending /
     duplicate timestamps makes lightweight-charts setData/update throw, which
     used to leave the OLD series data on screen (a previous symbol's scale —
     e.g. a ~2.0 cross deep-zoomed into a degenerate window) while the legend
     already showed the new symbol: the axis then rendered one constant value
     (~1.99998) for every level. Sanitize BEFORE feeding, retry once after a
     failed setData, and reset the stale deep-zoom window on every reload. */
  /* AUDIT FIX (bug root cause): the previous guard used isFinite(b.open) etc.
     to reject bad bars, but isFinite(null) === true in JS (null coerces to
     0), so a bar with a literal null OHLC field — which is exactly what a
     provider sends mid-reconnect when a bar arrives with a field still
     unset — sailed straight through this guard and reached
     lightweight-charts, which throws "Value is null" and aborts the paint.
     finiteNum() closes that loophole with an explicit typeof check. */
  function finiteNum(v) { return typeof v === 'number' && isFinite(v); }

  function sanitizeBars(bars, symbol, tfId) {
    if (!Array.isArray(bars)) return [];
    const out = [];
    let dropped = 0, merged = 0;
    for (const b of bars) {
      if (!b || !finiteNum(b.time) || !finiteNum(b.open) || !finiteNum(b.high) ||
          !finiteNum(b.low) || !finiteNum(b.close)) { dropped++; continue; }
      const prev = out[out.length - 1];
      if (prev && b.time < prev.time) { dropped++; continue; } // never reorder history
      if (prev && b.time === prev.time) {
        // duplicate stamp: fold into the previous bar (real data kept, merged)
        prev.high = Math.max(prev.high, b.high);
        prev.low = Math.min(prev.low, b.low);
        prev.close = b.close;
        prev.volume = (prev.volume || 0) + (b.volume || 0);
        merged++;
        continue;
      }
      out.push({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
    }
    if (dropped || merged) console.warn(`[data-guard] ${symbol} ${tfId}: dropped=${dropped} merged=${merged}`);
    return out;
  }
  Manager.sanitizeBars = sanitizeBars;

  /* ROUND145 (hunt for the "Value is null" spam): last-line gate before
     every write to the MAIN series. LWC throws "Value is null" on a
     null/NaN OHLC field and the throw used to surface only as a vendor
     stack with zero app context (55 identical log lines, no pane identity).
     The gate logs symbol/tf/style + op + the offending row, then the caller
     SKIPS the write (same discipline as sanitizeBars: never poison the
     series). U.firstBadRow mirrors exactly what LWC accepts, so valid
     traffic can never trip it. */
  function seriesWriteOk(pane, op, rows) {
    let bad = -1;
    try { bad = U.firstBadRow(rows); } catch (e) { bad = -2; }
    if (bad < 0) return true;
    try {
      const row = Array.isArray(rows) ? rows[bad] : null;
      let dump = '';
      try { dump = JSON.stringify(row).slice(0, 300); } catch (e) { dump = String(row).slice(0, 300); }
      if (Log) Log.error('data', 'series write blocked: bad row would throw in LWC', {
        symbol: pane && pane.symbol, tf: pane && pane.tf, style: pane && pane.style,
        op, idx: bad, rows: Array.isArray(rows) ? rows.length : -1, row: dump,
      });
    } catch (e) {}
    return false;
  }
  Manager.seriesWriteOk = seriesWriteOk;

  /* ROUND184: marker-only refresh — the same merge as setPaneData without
     rewriting series data. Strategy rebuilds/removals and the dock toggle
     call this; data loads go through setPaneData (which calls it too). */
  function applyPaneMarkers(pane) {
    if (!pane || !pane.series || !pane.bars) return;
    try {
      const style = pane.style || 'candles';
      const mkBase = style === 'linemarkers'
        ? pane.bars.map((b) => ({ time: b.time, position: 'inBar', shape: 'circle', color: '#2962ff', size: 1 }))
        : [];
      const mkHist = (Manager.tradeHistoryMarkers ? Manager.tradeHistoryMarkers(pane) : []);
      const mkStrat = (Manager.strategyMarkers ? Manager.strategyMarkers(pane) : []);
      if (pane.series.setMarkers) pane.series.setMarkers(mkBase.concat(mkHist, mkStrat));
    } catch (e) {}
  }
  Manager.applyPaneMarkers = applyPaneMarkers;

  function setPaneData(pane, bars) {
    const style = pane.style || 'candles';
    if (style === 'renko') {
      const size = renkoSizeFor(pane);
      const bricks = renkoBricks(bars, size, App.tfById[pane.tf].sec);
      const rows = bricks.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
      seriesWriteOk(pane, 'renko-setData', rows); // ROUND145: logs context on poison, never blocks
      try { pane.series.setData(rows); } catch (e) {}
      pane.barTimes = bricks.map((b) => b.time);
      return;
    }
    const rows = transformData(style, bars);
    seriesWriteOk(pane, 'setData', rows); // ROUND145: logs context on poison, never blocks
    try { pane.series.setData(rows); } catch (e) {}
    pane.barTimes = bars.map((b) => b.time);
    /* ROUND98: markers = style base (linemarkers circles) + the trade-history
       markers registered by trade/history.js (Manager.tradeHistoryMarkers,
       empty until that module boots / when its toggle is off). One merge
       point so the two providers can never fight over setMarkers.
       ROUND184: strategy trade markers join the same merge. */
    Manager.applyPaneMarkers(pane);
    if (style === 'baseline') {
      try { pane.series.applyOptions({ baseValue: pane.baseVal != null ? pane.baseVal : (bars.length ? bars[0].close : 0) }); } catch (e) {}
    }
    if (style === 'heikin') {
      const hd = transformData('heikin', bars);
      pane._haLast = hd.length ? { open: hd[hd.length - 1].open, close: hd[hd.length - 1].close } : null;
    }
  }
  Manager.setPaneData = setPaneData;

  /* legacy single-bar transform (used by tick updates) */
  function seriesDataFor(style, bars) {
    return transformData(style, bars);
  }

  function styleName(id) {
    const s = App.STYLES.find((x) => x.id === id);
    return s ? s.name : id;
  }

  function createPane(container, symbol, tfId, style) {
    const root = U.el('div', 'pane-root', container);
    const legend = U.el('div', 'pane-legend', root);
    const lgRow1 = U.el('div', 'lg-row1', legend);
    const lgLogo = U.el('span', 'lg-logo', lgRow1);
    const lgSym = U.el('span', 'lg-sym', lgRow1);
    const lgMkt = U.el('span', 'lg-mkt', lgRow1);
    const lgTf = U.el('span', 'lg-tf', lgRow1);
    const lgChg = U.el('span', 'lg-chg', lgRow1);
    const lgOhlc = U.el('div', 'lg-ohlc', legend);
    /* ROUND98 (user request): live spread chip — ONE persistent span that
       updateLegend re-appends after rebuilding the OHLC row's HTML and the
       400ms countdown cadence refreshes with the latest tick's ask-bid */
    const lgSpread = U.el('span', 'lg-spread', legend);
    lgSpread.style.display = 'none';

    const host = U.el('div', 'pane-chart-host', root);
    const wm = U.el('div', 'pane-wm', host); // watermark layer sits BEHIND the chart canvas
    /* ROUND41: vertical-grid UNDERLAY — the engine paints the time-axis grid
       lines on THIS canvas (z 0, behind the chart canvas z 1, above the
       watermark) so the grid sits UNDER the candles, never over them
       (user report). Same geometry as the overlay (inset 0 of the host,
       DPR-sized + cleared every frame in Engine.render); the LWC canvas
       above is transparent, so the grid shows through for the price pane
       AND every indicator sub-pane — the same full-stack extent it had
       when it was painted on the overlay. */
    const gridCv = U.el('canvas', 'pane-grid-underlay', host);
    /* ROUND80 (TV parity): the price VALUE label + the countdown are ONE
       stacked unit on the price scale now — the native LWC last-value label
       is hidden (applyPriceLines) and both rows live in .pv-stack so they
       always share one width, flush rows, one shadow (user report: they
       used to read as two separate boxes). [NAME chip] stays its own element
       (it flips sides); the stack holds [VALUE][COUNTDOWN]. */
    const pvStack = U.el('div', 'pv-stack', root);
    const pv = U.el('div', 'pv-label', pvStack);
    const cd = U.el('div', 'cd-label', pvStack); // countdown-to-bar-close row
    pv.style.display = 'none'; cd.style.display = 'none'; pvStack.style.display = 'none';
    const chip = U.el('div', 'sym-chip', root); // price-scale symbol chip (TV)
    chip.style.display = 'none';
    /* product logo at the pane's bottom-left (round 20): replaces the
       lightweight-charts attribution mark that used to sit there.
       Round 23: theme-aware wordmark — the white mark sits on the dark chart,
       the dark mark on the light chart (assets swapped on theme switch). */
    const brand = U.el('img', 'pane-brand', root);
    brand.src = (Theme && Theme.mode === 'light') ? 'assets/logo-dark.png' : 'assets/logo-light.png';
    brand.alt = 'OJ Chart';
    brand.draggable = false;
    /* "Scroll to the most recent bar" (TV): bottom-right arrow, appears only
       when the view has been scrolled away from the live bar (engine.render
       drives its position/visibility); one per chart — works in every layout */
    const goLive = U.el('button', 'go-live-btn', root);
    goLive.title = 'Scroll to the most recent bar';
    goLive.innerHTML = icon('gotolive');
    goLive.style.display = 'none';
    goLive.addEventListener('mousedown', (e) => e.stopPropagation());
    goLive.addEventListener('click', (e) => {
      e.stopPropagation();
      try { pane.chart.timeScale().scrollToRealTime(); } catch (err) {}
    });
    /* "Load older bars" pill (history-depth parity, round 27): bottom-left,
       manual page + auto-load when the leftmost visible index < 8 (the
       reference platform's older-bars pagination). Hidden when the provider
       runs dry (pane._olderDone) or during replay. */
    const olderPill = U.el('button', 'older-pill', root);
    olderPill.textContent = 'Load older bars';
    olderPill.title = 'Load 1000 older bars (scrolling to the left edge also auto-loads)';
    olderPill.style.display = 'none';
    olderPill.addEventListener('mousedown', (e) => e.stopPropagation());
    olderPill.addEventListener('click', (e) => { e.stopPropagation(); Manager.loadOlder(pane); });
    /* honest empty state: history really arrived EMPTY (unsynced symbol /
       market closed / dead symbol) — never a silent blank chart (parity:
       reference platform's "No data" overlay) */
    const nodataEl = U.el('div', 'pane-nodata hidden', root);
    nodataEl.innerHTML = '<div class="nd-box">No data for this symbol / interval</div>';
    /* "Loading data…" overlay (round 22): shown while bars are being fetched
       (symbol/interval switch, reconnect refresh) so a slow feed never reads
       as a frozen app; animated spinner + label, auto-hides on arrival */
    const loadingEl = U.el('div', 'pane-loading hidden', root);
    loadingEl.innerHTML = '<span class="pl-spin"></span><span class="pl-txt">Loading data\u2026</span>';
    /* ROUND 29 — history/live truth banner: shown when the provider's HISTORY
       last close disagrees with the LIVE tick after >= 2 consecutive loads.
       Until now the app re-requested the same poisoned history forever and
       painted a confidently wrong chart (the "axis stuck at ~2.0 while the
       watchlist ticks 1.16" report). The banner names BOTH numbers and hands
       the user a manual Reload that resets the strike counter. */
    const histEl = U.el('div', 'pane-hist-warn hidden', root);
    histEl.innerHTML = '<div class="hw-box"><span class="hw-ic">⚠</span><span class="hw-txt"></span>' +
      '<button class="hw-retry" title="Request history again">Reload</button></div>';
    histEl.addEventListener('mousedown', (e) => e.stopPropagation());
    /* future time labels on the time axis (round 23): lightweight-charts only
       labels REAL bars, so the region right of the live candle stays blank;
       this overlay renders the forward times (per interval) + the live bar's
       own time — labels are plain text, the strip never intercepts the mouse */
    const tax = U.el('div', 'tax-ext', root);
    tax.style.display = 'none';
    /* ROUND66 (user report): the drawn-vline/crossline TIME highlight used to
       paint on the overlay canvas UNDER the .tax-ext DOM strip — the static
       numbers rendered ON TOP of the highlight (screenshot: "10:45" ghosting
       through the blue tag). ROOT fix: a dedicated DOM layer ABOVE the
       numbers (.tax-tags, z 7 > .tax-ext 6) — the same mechanism as .tax-live
       below, which never overlapped. Engine.render rebuilds it every frame;
       tools' timeTag() and the news axis pills append into it. Declared
       BEFORE .tax-live so the live crosshair pill keeps painting above the
       static tags on the shared z level (later DOM order wins). */
    const taxTags = U.el('div', 'tax-tags', root);
    /* BUG-C/R25: live crosshair time bubble — DOM pill ABOVE the static
       labels (the native canvas bubble sat UNDER the .tax-ext strip and was
       covered). Driven by Engine._updateCrossBubble every frame. */
    const taxLive = U.el('div', 'tax-live', root);
    taxLive.style.display = 'none';
    /* ROUND49 (TV): price-scale hover highlight pill + the (+) button locked
       next to it (Arrow/Dot cursor tools; Cross keeps the native label). (+)
       opens UI.openPriceAddMenu at the pill's price. While that menu is open
       the pair FREEZES to the price (_paxFrozen) even off-hover. */
    const paxLive = U.el('div', 'pax-live', root);
    paxLive.style.display = 'none';
    const paxAdd = U.el('button', 'pax-add', root);
    paxAdd.style.display = 'none';
    paxAdd.innerHTML = icon('plus');
    paxAdd.title = 'Trade / alert at this price';
    paxAdd.addEventListener('mousedown', (e) => e.stopPropagation());
    paxAdd.addEventListener('click', (e) => {
      e.stopPropagation();
      const price = pane._paxPrice;
      if (price == null || !isFinite(price) || !UI.openPriceAddMenu) return;
      pane._paxFrozen = true; pane._paxFrozenPrice = price;
      pane._paxTok = (pane._paxTok || 0) + 1;
      const tok = pane._paxTok;
      try { UI.openPriceAddMenu(pane, price, paxAdd); } catch (er) { pane._paxFrozen = false; return; }
      /* release the freeze when the menu dismisses (any mousedown — the
         popup's own outside-close runs on the same event); a NEW freeze bumps
         _paxTok so a stale release never kills it (re-click on (+)) */
      const rel = () => {
        document.removeEventListener('mousedown', rel, true);
        setTimeout(() => {
          if (pane._paxTok !== tok) return;
          pane._paxFrozen = false; pane._paxFrozenPrice = null;
          if (!pane.engine || !pane.engine.mouse || !pane.engine.mouse.inside) {
            paxLive.style.display = 'none'; paxAdd.style.display = 'none';
          }
        }, 0);
      };
      document.addEventListener('mousedown', rel, true);
    });
    /* ROUND51 (user request): the selected price alert's floating delete
       chip — rides the line (engine._updateAlertSel every frame); clicking
       it removes the alert right from the chart. */
    const alertDel = U.el('button', 'alert-del', root);
    alertDel.style.display = 'none';
    alertDel.innerHTML = icon('trash');
    alertDel.title = 'Delete alert';
    alertDel.addEventListener('mousedown', (e) => e.stopPropagation());
    alertDel.addEventListener('click', (e) => {
      e.stopPropagation();
      if (Alerts.selected == null) return;
      const id = Alerts.selected;
      Alerts.selected = null;
      Alerts.remove(id);
    });
    // per-chart mini toolbar (TV): maximize stays; the chart-style icon was
    // removed in round 22 (the top bar owns chart styles)
    const mini = U.el('div', 'pane-mini-tb', root);
    const maxBtn = U.el('button', 'pmt-btn pane-max-btn', mini); // maximize (multi-chart only, CSS-gated)
    const pane = {
      root, legend, host, wm, gridCv, cd, chip, pvStack, pv, mini, maxBtn, goLive, brand, loadingEl, tax, taxTags, taxLive,
      paxLive, paxAdd, alertDel, _paxPrice: null, _paxFrozen: false, _paxFrozenPrice: null, _paxTok: 0,
      olderPill, nodataEl, histEl,
      symbol, tf: tfId, digits: 5,
      style: style || App.style || 'candles',
      bars: [], barTimes: [],
      chart: null, series: null,
      overlay: null, engine: null,
      replay: null,
      loading: false,
      indicators: [], // round 27: per-chart indicator instances (indicators-ui)
      /* round 29: history/live truth state — strike counter per consecutive
         mismatching load, snapshot for the banner, poisoned-at timestamp
         (pauses the futile auto-reload loop for 10 minutes) */
      _histStrike: 0, _histMismatch: null, _histPoisonedAt: 0,
      /* manual price-axis zoom window (engine writes it; provider above reads it) */
      pz: { active: false, center: 0, span: 0 },
      _shown: -1, _haLast: null, _renkoSize: null, _plines: {}, _bidLine: null, _askLine: null,
      els: { lgLogo, lgSym, lgMkt, lgTf, lgChg, lgOhlc, lgSpread },
    };
    /* round 32 (TV parity): the price chart lives in the MAIN sub-pane; every
       'separate' indicator (MACD, RSI, Volume, ...) gets its OWN sub-pane
       below it, stacked inside the same host (see layoutSubPanes). */
    const mainWrap = U.el('div', 'sub-pane sub-main', host);
    const chart = LWC.createChart(mainWrap, chartOptions(pane));
    pane.chart = chart;
    pane.mainWrap = mainWrap;
    pane._subs = null;          // instId -> sub-pane (created by indicators-ui)
    pane._subRects = [];        // [{top, h, plotH, chart, chartEl, first}] for the engine
    pane._subTotalH = 0;        // visible height of all sub-panes (watermark lift)
    pane._mainPlotH = 0;        // main plot height (0 = no subs -> h - timeH)
    pane.series = makeSeries(chart, pane.style, pane);
    applySeriesFormat(pane);
    const overlay = U.el('canvas', 'pane-overlay', root);
    pane.overlay = overlay;
    pane.engine = new Engine(pane);
    /* ROUND126 (perf): any visible-range change on the main chart (user pan,
       programmatic fit/scroll after loads, replay follow, older-page shifts)
       must be followed by an overlay repaint — marking activity makes the
       render loop paint on the very next frame instead of waiting up to one
       idle heartbeat. The handler is a no-op while the loop is not started. */
    try {
      chart.timeScale().subscribeVisibleLogicalRangeChanged(() => { if (Manager.markChartActivity) Manager.markChartActivity(); });
    } catch (e) {}
    maxBtn.innerHTML = icon('maximize');
    maxBtn.title = 'Maximize chart';
    maxBtn.addEventListener('mousedown', (e) => e.stopPropagation());
    maxBtn.addEventListener('dblclick', (e) => e.stopPropagation());
    maxBtn.addEventListener('click', () => Manager.toggleMaximize(pane));
    /* round 29: manual retry from the truth banner — resets the strike
       counter so the next mismatching load can re-raise it (user-driven) */
    histEl.querySelector('.hw-retry').addEventListener('mousedown', (e) => e.stopPropagation());
    histEl.querySelector('.hw-retry').addEventListener('click', (e) => {
      e.stopPropagation();
      pane._histStrike = 0; pane._histMismatch = null; pane._histPoisonedAt = 0;
      Manager.updateHistWarn(pane);
      try { Log && Log.info('data', 'manual history retry from banner', { symbol: pane.symbol, tf: pane.tf }); } catch (er) {}
      /* ROUND 35 (compare fix): internal reloads MUST go through
         Manager.loadBars — compare.js wraps THAT property to re-align its
         series after every reload. The plain local call used to bypass the
         wrapper, so after a symbol/TF switch the compare line kept the OLD
         symbol/TF timestamps and the chart broke. */
      Manager.loadBars(pane);
    });

    /* TV crosshair sync: vertical line at the same time on every pane.
       ROUND58 (user report): in multi-chart mode the OTHER chart jumped on
       every hover and sometimes lost the highlight + dashed line in Cross
       mode. Root cause: this subscription ran a SECOND sync path next to the
       engine's (Engine.move -> _syncCross -> Manager.syncCrossMove) — and
       LWC ALSO fires this handler for OUR OWN programmatic
       setCrosshairPosition/clear calls, DEFERRED to after the synchronous
       _xsync window (probe: 1 mousemove -> 3 setCrosshairPosition calls on
       the receiver). The late event re-drove the panes with param.time =
       LWC's bar-SNAPPED time (in the future margin: clamped to the LAST
       bar), so the receiver flip-flopped between the continuous engine
       position and the snapped one = the jump; on the axis strips the old
       path moved only the native lines and left the custom line + pill
       stale/hidden = the missing highlight. ONE path now owns the sync:
       this handler DELEGATES to Manager.syncCrossMove/syncCrossClear (full
       custom visuals, sub-panes included) and only covers the AXIS strips —
       the body hover stays engine-driven; a 100ms deadman window
       (pane._xsyncUntil, stamped by the same functions) absorbs the
       deferred programmatic echoes, and the handler only runs when the
       pointer is genuinely inside the pane (engine.mouse.inside) so tick /
       echo events on the other charts can never re-drive the layout. */
    chart.subscribeCrosshairMove((param) => {
      if (pane._xsync || (pane._xsyncUntil && performance.now() < pane._xsyncUntil)) return;
      /* ROUND58: react only when the pointer is REALLY inside this pane AND
         just moved — LWC re-fires this handler for our own programmatic
         crosshair calls and on data ticks; those arrive without fresh
         pointer activity (often on the NON-hovered panes' charts) and would
         re-drive the layout from bar-snapped/clamped times (= the jump). */
      if (!(pane.engine && pane.engine.mouse && pane.engine.mouse.inside)) return;
      if (!(pane.engine._lastMouseMove && performance.now() - pane.engine._lastMouseMove <= 150)) return;
      /* ROUND120: the sync runs while EITHER crosshair toggle is on — the
         per-destination symbol gating lives inside syncCrossMove/Clear
         (same-symbol panes follow 'crosshair', different-symbol panes
         follow 'crossX'). */
      if (!App.sync || !(App.sync.crosshair || App.sync.crossX) || App.panes.length < 2) return;
      const t = param && param.time;
      if (t == null) { if (Manager.syncCrossClear) Manager.syncCrossClear(pane); return; }
      if (Manager.syncCrossMove) Manager.syncCrossMove(pane, t);
    });

    initTimeSync(pane);

    /* round 32: sub-pane time sync — the MAIN chart drives, every indicator
       sub-pane mirrors the same visible logical range (all gestures stay on
       the main chart; sub-charts are range-slaves, exactly like TV panes) */
    chart.timeScale().subscribeVisibleLogicalRangeChange((lr) => {
      if (!lr || !pane._subs || pane._subs.size === 0 || pane._subSync) return;
      pane._subSync = true;
      try {
        for (const sub of pane._subs.values()) {
          try { sub.chart.timeScale().setVisibleLogicalRange({ from: lr.from, to: lr.to }); } catch (e) {}
        }
      } catch (e) {}
      pane._subSync = false;
    });

    /* older-bars AUTO-LOAD (round 27): scrolling to the left edge pages in
       older history (parity with the reference platform). Throttled by
       _olderLoading; manual clicks go through the pill. */
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (!r || pane._olderLoading || pane.loading) return;
      if (r.from < 8) Manager.loadOlder(pane);
    });

    const ro = new ResizeObserver(() => {
      try {
        /* skip zero sizes (hidden panes while another is maximized) */
        if (host.clientWidth && host.clientHeight) Manager.layoutSubPanes(pane);
      } catch (e) {}
    });
    ro.observe(host);
    pane._ro = ro;

    root.addEventListener('mousedown', () => setActive(pane), true);

    lgSym.textContent = symbol;
    lgTf.textContent = App.tfById[tfId].label;
    updateLegendTitle(pane);
    updateWatermark(pane);
    if (Settings) Settings.applyPane(pane); // background/margins/price lines for the fresh pane
    return pane;
  }

  /* ---------- round 32: TRUE indicator sub-panes (TradingView parity) ----------
     Every 'separate' indicator (MACD, RSI, Stochastic, ATR, Volume, ...) gets
     its OWN LWC chart stacked BELOW the price chart inside pane.host:
       .pane-chart-host
         .sub-pane.sub-main    <- price chart (native time axis hidden when
                                  sub-panes exist: canvas grows +AXIS_H and is
                                  clipped by the wrapper)
         .sub-pane.sub-ind     <- one per separate indicator, own price scale,
                                  own axis labels, own legend row; the LAST
                                  one owns the visible time-axis strip (the
                                  DOM .tax-ext overlays it, as before)
     Geometry lives in layoutSubPanes; the engine reads pane._subRects to
     route the crosshair and to restrict drawings to the price pane. */

  const AXIS_H = 26; // native lightweight-charts time-axis strip height

  /* options for an indicator sub-chart: same skin as the main chart, but no
     gestures of its own (the main chart drives the range) and a live price
     scale with its own axis labels */
  function subChartOptions(pane) {
    const o = chartOptions(pane);
    o.handleScroll = { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false };
    o.handleScale = { mouseWheel: false, pinch: false,
      axisPressedMouseMove: { time: false, price: false },
      axisDoubleClickReset: { time: false, price: false } };
    o.rightPriceScale = { borderColor: o.rightPriceScale.borderColor, visible: true,
      scaleMargins: { top: 0.1, bottom: 0.1 } };
    o.leftPriceScale = { visible: false, borderColor: o.rightPriceScale.borderColor };
    return o;
  }
  Manager.subChartOptions = subChartOptions;

  /* (re)compute the sub-pane stack geometry: heights, chart canvas sizes,
     engine rects and cross-chart axis width alignment.
     ROUND 33: pane heights are USER-RESIZABLE — each separate indicator
     instance may carry `frac` (its share of the plot area, written by the
     drag splitter); instances without frac keep the auto equal split. */
  const SUB_MIN_H = 40;    // smallest indicator pane (px)
  const MAIN_MIN_H = 72;   // smallest price pane (px)

  function computeSubHeights(pane, subs, plotTotal) {
    const n = subs.length;
    const defH = () => U.clamp(Math.round(plotTotal / (n + 3.2)), 56, 220);
    /* ROUND 74: pine script instances carry `frac` too (their sub-panes are
       first-class residents of the stack since round-74 sub-pane parity) */
    const instFrac = (id) => {
      const i = (pane.indicators || []).find((z) => z.id === id);
      if (i) return Number(i.frac);
      const p = (pane.pineScripts || []).find((z) => z.id === id);
      return p ? Number(p.frac) : undefined;
    };
    const subHs = subs.map((sub) => {
      const f = instFrac(sub.instId);
      return (f && isFinite(f) && f > 0) ? U.clamp(Math.round(f * plotTotal), SUB_MIN_H, plotTotal - MAIN_MIN_H) : defH();
    });
    let mainH = plotTotal - subHs.reduce((a, b) => a + b, 0);
    if (n && mainH < MAIN_MIN_H) {
      /* keep the price pane usable: shrink the subs proportionally */
      const sum = subHs.reduce((a, b) => a + b, 0);
      const target = sum - (MAIN_MIN_H - mainH);
      for (let k = 0; k < n; k++) subHs[k] = Math.max(SUB_MIN_H, Math.floor(subHs[k] * target / sum));
      mainH = plotTotal - subHs.reduce((a, b) => a + b, 0);
    }
    return { subHs, mainH: Math.max(MAIN_MIN_H, mainH) };
  }

  /* sorted sub-pane list — DOM + geometry order follows the indicator list (TV) */
  function sortedSubs(pane) {
    const subs = pane._subs ? Array.from(pane._subs.values()) : [];
    const order = (pane.indicators || []).map((i) => i.id);
    subs.sort((a, b) => {
      const ia = order.indexOf(a.instId), ib = order.indexOf(b.instId);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    });
    return subs;
  }

  function layoutSubPanes(pane) {
    if (!pane || !pane.host || !pane.mainWrap) return;
    const host = pane.host;
    const W = host.clientWidth, H = host.clientHeight;
    if (!W || !H) return;
    const subs = sortedSubs(pane);
    for (const sub of subs) { try { host.appendChild(sub.host); } catch (e) {} } // keep main first
    const n = subs.length;
    const plotTotal = Math.max(80, H - AXIS_H);
    const { subHs, mainH } = computeSubHeights(pane, subs, plotTotal);
    /* main wrapper: with sub-panes the canvas grows +AXIS_H so the native
       axis strip hides under the first sub-pane (wrapper clips it) */
    pane.mainWrap.style.top = '0px';
    pane.mainWrap.style.height = (n ? mainH : H) + 'px';
    try { pane.chart.applyOptions({ width: W, height: n ? mainH + AXIS_H : H }); } catch (e) {}
    const rects = [];
    let y = n ? mainH : 0;
    for (let k = 0; k < n; k++) {
      const sub = subs[k];
      const isLast = k === n - 1;
      const wrapH = subHs[k] + (isLast ? AXIS_H : 0); // the LAST one owns the visible axis strip
      sub.host.style.top = y + 'px';
      sub.host.style.height = wrapH + 'px';
      try { sub.chart.applyOptions({ width: W, height: subHs[k] + AXIS_H }); } catch (e) {}
      rects.push({ top: y, h: wrapH, plotH: subHs[k], chart: sub.chart,
        chartEl: sub.chartEl, first: sub.firstSeries || null });
      y += wrapH;
    }
    pane._subRects = rects;
    pane._subTotalH = n ? (y - AXIS_H) : 0;
    pane._mainPlotH = n ? mainH : (H - AXIS_H);
    layoutSubSplitters(pane, subs, rects);
    syncAxisWidths(pane);
  }
  Manager.layoutSubPanes = layoutSubPanes;

  /* ---------- ROUND104 ROOT FIX: indicator panes drifting out of alignment
     Every sub-chart is a range SLAVE of the price chart, kept in step by the
     subscribeVisibleLogicalRangeChange handler above. That handler only fires
     when the MAIN range changes - it cannot see a sub-chart moving on its own.
     And a sub-chart DOES move on its own: `series.setData()` makes
     lightweight-charts auto-fit that chart to the full dataset on the NEXT
     frame. So on every timeframe switch and every older-history page:

       1. indicators recompute  -> sub setData -> sub auto-fit ARMED
       2. recompute() pins the subs to the main range   (synchronous)
       3. loadBars' setTimeout(0) moves the main chart to the last ~150 bars
       4. the armed auto-fit lands AFTER both - each sub snaps back to
          "show everything", while the price chart shows 150 bars

     The result is an indicator whose plot no longer lines up with the candles
     above it, and which never corrects itself until the user pans (which
     finally fires the main range-change subscription). The pin in step 2 was
     simply too early to win.

     This re-asserts the main chart's range on every sub across TWO animation
     frames, so it lands after the library's own deferred auto-fit whichever
     frame that fell on. Cheap and idempotent: setting a range a sub-chart
     already has is a no-op inside LWC. */
  function syncSubRanges(pane) {
    if (!pane || !pane._subs || !pane._subs.size) return;
    const apply = () => {
      if (!App.panes.includes(pane) || !pane._subs || !pane._subs.size) return;
      let lr = null;
      try { lr = pane.chart.timeScale().getVisibleLogicalRange(); } catch (e) { return; }
      if (!lr) return;
      pane._subSync = true;
      for (const sub of pane._subs.values()) {
        try { sub.chart.timeScale().setVisibleLogicalRange({ from: lr.from, to: lr.to }); } catch (e) {}
      }
      pane._subSync = false;
    };
    apply();
    /* ROUND126 (perf): the follow-up used to be a PERPETUAL rAF chain spawned
       on EVERY syncSubRanges call (loadBars, loadOlder, sub-pane add/remove)
       — the chains ACCUMULATED (N loads -> N 60fps loops per pane), each one
       polling get/setVisibleLogicalRange for every sub forever. The sub
       ranges only ever need to follow the MAIN pane's range, so the chain is
       replaced by LWC's own visibleLogicalRangeChanged event, bound ONCE per
       pane (the chart instance dies with the pane, so the subscription dies
       with it). A guarded rAF fallback stays for engines without the event,
       capped at ONE chain per pane (pane._lrRaf, cleared in destroyPanes). */
    if (pane._lrBound) return;
    pane._lrBound = true;
    try {
      pane.chart.timeScale().subscribeVisibleLogicalRangeChanged(() => {
        if (Manager.markChartActivity) try { Manager.markChartActivity(); } catch (e) {}
        apply();
      });
      return;
    } catch (e) {}
    if (!pane._lrRaf) {
      pane._lrRaf = true;
      const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : ((f) => setTimeout(f, 16));
      const step = () => { if (!pane._lrRaf) return; apply(); raf(step); };
      raf(step);
    }
  }
  Manager.syncSubRanges = syncSubRanges;

  /* ---------- round 33: drag splitters between the price pane and every
     indicator sub-pane (TV pane resize). One 7px hit-strip sits on each
     boundary; dragging shifts height between the two ADJACENT panes and
     stores it as `frac` on the indicator instances (persisted, and copied
     to other charts by the layout switch like the rest of the instance). */
  function layoutSubSplitters(pane, subs, rects) {
    const host = pane.host;
    if (!pane._splits) pane._splits = [];
    while (pane._splits.length < subs.length) {
      const sp = U.el('div', 'pane-split', host);
      sp.addEventListener('mousedown', (e) => startSubPaneDrag(pane, sp, e));
      pane._splits.push(sp);
    }
    for (let k = 0; k < pane._splits.length; k++) {
      const sp = pane._splits[k];
      if (k >= subs.length || !rects[k]) { sp.style.display = 'none'; continue; }
      sp.style.display = '';
      sp.style.top = (rects[k].top - 3) + 'px';
    }
  }

  function startSubPaneDrag(pane, sp, e) {
    if (e.button !== 0) return;
    const subs = sortedSubs(pane);
    const k = pane._splits ? pane._splits.indexOf(sp) : -1;
    if (k < 0 || k >= subs.length) return;
    e.preventDefault(); e.stopPropagation();
    const H = pane.host.clientHeight;
    const plotTotal = Math.max(80, H - AXIS_H);
    const { subHs, mainH } = computeSubHeights(pane, subs, plotTotal);
    const heights = [mainH].concat(subHs); // [price, s0, s1, ...]
    const startY = e.clientY;
    sp.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    const instOf = (id) => (pane.indicators || []).find((i) => i.id === id)
      || (pane.pineScripts || []).find((i) => i.id === id); // ROUND 74: pine panes resize too
    const move = (ev) => {
      const dy = ev.clientY - startY;
      const below = heights[k + 1], above = heights[k];
      const minAbove = k === 0 ? MAIN_MIN_H : SUB_MIN_H;
      const nb = U.clamp(below - dy, SUB_MIN_H, below + above - minAbove);
      const na = above + (below - nb);
      const instK = instOf(subs[k].instId);
      if (instK) instK.frac = nb / plotTotal;
      if (k > 0) {
        const instA = instOf(subs[k - 1].instId);
        if (instA) instA.frac = na / plotTotal;
      }
      layoutSubPanes(pane);
      try { if (pane.engine) pane.engine.render(); } catch (er) {}
    };
    const up = () => {
      sp.classList.remove('dragging');
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      persistPanes();
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  }

  /* all panes of one chart share the widest price-scale width (TV look).
     Round 33: also driven from the render loop (self-healing) — axis widths
     change outside layout events (crosshair labels, last-value labels,
     first paint) and a sync that ran during a transient narrow state used
     to pin the WRONG width until the next unrelated layout. */
  function syncAxisWidths(pane) {
    try {
      let maxW = pane.chart.priceScale('right').width() || 0;
      const subs = pane._subs ? Array.from(pane._subs.values()) : [];
      for (const sub of subs) maxW = Math.max(maxW, sub.chart.priceScale('right').width() || 0);
      if (maxW < 40) return;
      if (pane._lastAxisW !== maxW) {
        pane._lastAxisW = maxW;
        pane.chart.applyOptions({ rightPriceScale: { minimumWidth: maxW } });
        for (const sub of subs) sub.chart.applyOptions({ rightPriceScale: { minimumWidth: maxW } });
      }
    } catch (e) {}
  }
  Manager.syncAxisWidths = syncAxisWidths;

  /* round 33: sub-pane (re)builds create a FRESH LWC chart without the synced
     `minimumWidth` — the `_lastAxisW` guard would skip re-applying it (the
     max width did not change), leaving the new pane misaligned. Invalidating
     the guard forces the next sync to re-apply the width everywhere. */
  Manager.invalidateAxisSync = function (pane) { try { pane._lastAxisW = null; } catch (e) {} };

  /* remove one indicator sub-pane (indicator removed / instance rebuilt) */
  function removeSubPane(pane, instId) {
    if (!pane || !pane._subs) return;
    const sub = pane._subs.get(instId);
    if (!sub) return;
    pane._subs.delete(instId);
    try { sub.chart.remove(); } catch (e) {}
    try { sub.host.remove(); } catch (e) {}
    pane._lastAxisW = null; // rebuilt/remaining subs re-sync on the next layout
    layoutSubPanes(pane);
  }
  Manager.removeSubPane = removeSubPane;

  /* layout teardown: release every sub-chart of a pane */
  Manager.destroyPaneSubs = function (pane) {
    if (!pane) return;
    if (pane._subs) for (const sub of pane._subs.values()) { try { sub.chart.remove(); } catch (e) {} }
    if (pane._splits) for (const sp of pane._splits) { try { sp.remove(); } catch (e) {} }
    pane._subs = null; pane._subRects = []; pane._subTotalH = 0; pane._mainPlotH = 0; pane._splits = [];
  };

  /* keep sub-chart skin in sync with the Settings dialog (theme/colors) */
  Manager.applySubPaneSettings = function (pane) {
    if (!pane || !pane._subs) return;
    const scaleId = pane._scaleId || 'right';
    for (const sub of pane._subs.values()) {
      try {
        sub.chart.applyOptions(subChartOptions(pane));
        sub.chart.applyOptions({ leftPriceScale: { visible: scaleId === 'left' }, rightPriceScale: { visible: scaleId === 'right' } });
      } catch (e) {}
    }
    layoutSubPanes(pane);
  };

  function updateWatermark(pane) {
    if (!pane.wm) return;
    const S = Settings ? Settings.conf : {};
    const mode = S.wmContent || (S.watermark === false ? 'hidden' : 'ticker_interval_desc');
    const show = S.watermark !== false && mode !== 'hidden';
    pane.wm.classList.toggle('off', !show);
    if (!show) return;
    const partsW = [];
    if (mode.indexOf('ticker') >= 0) partsW.push(pane.symbol);
    if (mode.indexOf('interval') >= 0) partsW.push(App.tfById[pane.tf].label);
    if (mode.indexOf('desc') >= 0 && App.symbolDescs[pane.symbol]) partsW.push(App.symbolDescs[pane.symbol]);
    const hasSym = S.wmSymbol !== false && mode.indexOf('ticker') >= 0;
    const hasTf = S.wmTf !== false && mode.indexOf('interval') >= 0;
    pane.wm.innerHTML =
      (hasSym ? `<div class="wm-sym">${partsW[0] || ''}</div>` : '') +
      (hasTf ? `<div class="wm-tf">${partsW[hasSym ? 1 : 0] || ''}</div>` : '') +
      (!hasSym && !hasTf && partsW.length ? `<div class="wm-sym">${partsW.join(' · ')}</div>` : '');
    const size = S.wmSize || 44;
    const op = S.wmOpacity != null ? S.wmOpacity : 0.12;
    pane.wm.style.setProperty('--wm-size', size + 'px');
    pane.wm.style.setProperty('--wm-opacity', op);
    if (S.wmColor) pane.wm.style.setProperty('--wm-color', S.wmColor);
  }
  Manager.updateWatermark = updateWatermark;

  function applySeriesFormat(pane) {
    const S = Settings ? Settings.conf : {};
    const pre = S.precision;
    let digits = pane.digits;
    if (pre !== undefined && pre !== null && pre !== '' && pre !== 'default') {
      digits = U.clamp(parseInt(pre, 10) || 0, 0, 8);
    }
    pane.series.applyOptions({
      priceFormat: { type: 'price', precision: digits, minMove: U.pointSize(digits) },
    });
  }
  Manager.applySeriesFormat = applySeriesFormat;

  /* live-apply the Symbol-tab look to an existing series */
  Manager.applySeriesLook = function (pane) {
    if (!pane.series || !pane.series.applyOptions) return;
    const style = pane.style || 'candles';
    if (style === 'candles' || style === 'heikin' || style === 'renko') {
      pane.series.applyOptions(seriesOptions());
    } else if (style === 'bars' || style === 'highlow') {
      const so = seriesOptions();
      pane.series.applyOptions({ upColor: so.upColor, downColor: so.downColor });
    } else if (style === 'hollow' && pane.bars && pane.bars.length) {
      setPaneData(pane, pane.bars); // hollow colors are baked into the data
    }
  };

  function updateLegendTitle(pane) {
    const S = Settings ? Settings.conf : {};
    const els = pane.els;
    /* logo: chart-style icon */
    if (els.lgLogo) {
      const st = App.STYLES.find((x) => x.id === pane.style);
      els.lgLogo.innerHTML = icon(st ? st.icon || 'candles' : 'candles');
      els.lgLogo.style.display = S.stLogo !== false ? '' : 'none';
    }
    /* title: name / ticker / description */
    const titleOn = S.stTitle !== false;
    els.lgSym.style.display = titleOn ? '' : 'none';
    if (titleOn) {
      const mode = S.stTitleMode || 'name';
      els.lgSym.textContent = mode === 'desc' ? (App.symbolDescs[pane.symbol] || pane.symbol) : pane.symbol;
    }
    /* open-market chip */
    if (els.lgMkt) {
      els.lgMkt.style.display = S.stMarket !== false ? '' : 'none';
      updateMarketChip(pane);
    }
    els.lgTf.textContent = App.tfById[pane.tf].label;
    els.lgChg.textContent = styleName(pane.style);
    els.lgChg.className = 'lg-chg';
  }

  /* Open/Closed chip: a symbol is open when its ticks are fresh
     (tick time base = server time, so compare against the estimated server clock) */
  function updateMarketChip(pane) {
    const el = pane.els.lgMkt;
    if (!el || el.style.display === 'none') return;
    const lt = lastTickAt[pane.symbol];
    if (lt == null) {
      /* ROUND72: no tick has EVER arrived (e.g. the app was opened on a
         weekend/holiday — the provider now stays silent for closed symbols
         instead of feeding frozen quotes). Infer the state from the chart
         itself: a market whose newest bar is stale against the SERVER clock
         is closed -> badge immediately at app open. Before any bar loads,
         stay idle (unknown). */
      const bars = pane.bars, tf = App.tfById[pane.tf];
      if (bars && bars.length && tf) {
        const ageB = Date.now() / 1000 + ((App.feed && App.feed.serverOff) || 0) - bars[bars.length - 1].time;
        if (ageB > 180 + tf.sec) {
          el.className = 'lg-mkt closed'; el.textContent = 'Market closed'; return;
        }
      }
      el.className = 'lg-mkt idle'; el.textContent = ''; return;
    }
    const serverNow = Date.now() / 1000 + ((App.feed && App.feed.serverOff) || 0);
    const age = serverNow - lt;
    const open = age >= -5 && age < 180;
    el.className = 'lg-mkt ' + (open ? 'open' : 'closed');
    el.textContent = open ? 'Market open' : 'Market closed';
  }
  Manager.updateMarketChips = function () { for (const p of App.panes) updateMarketChip(p); };

  function updateLegend(pane, hoverTime) {
    let b = null;
    if (hoverTime != null && pane.barTimes.length) {
      const i = U.nearestIndex(pane.barTimes, hoverTime);
      b = pane.bars[i];
    }
    if (!b) b = pane.bars[pane.bars.length - 1];
    if (!b) { pane.els.lgOhlc.innerHTML = ''; return; }
    const S = Settings ? Settings.conf : {};
    const f = (v) => U.fmtPrice(v, pane.digits);
    const out = [];
    /* round 27 (TV legend parity): the SELECTED candle's date+time in the
       display timezone leads the OHLC row; OHLC values + change are colored
       by bar direction like TV. `tstDate`/`tstTime` toggles in Settings
       (default on) let users hide each part. */
    const dirCls = b.close >= b.open ? 'up' : 'down';
    if (S.stBarTime !== false) {
      const p = TZ.parts(App.tz, b.time);
      const isSec = App.tfById[pane.tf] && App.tfById[pane.tf].sec < 60;
      const t = isSec ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
      out.push(`<span class="lg-bartime"><b>${p.dow ? p.dow + ' ' : ''}${p.day} ${p.monthShort} ${p.year}</b>  ${t}</span>`);
    }
    if (S.stValues !== false) {
      out.push(`<span class="lg-dir-${dirCls}"><span>O <b>${f(b.open)}</b></span><span>H <b>${f(b.high)}</b></span>` +
        `<span>L <b>${f(b.low)}</b></span><span>C <b>${f(b.close)}</b></span></span>`);
    }
    if (S.stBarChange !== false) {
      const chg = b.close - b.open;
      const pct = b.open ? (chg / b.open) * 100 : 0;
      out.push(`<span class="lg-chg ${dirCls}" class="u-ml2">${chg >= 0 ? '+' : ''}${f(chg)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>`);
    }
    if (S.stVolume) {
      out.push(`<span>V <b>${U.fmtVol ? U.fmtVol(b.volume) : b.volume}</b></span>`);
    }
    if (S.stLastDayChange) {
      const pd = prevDayInfo(pane);
      if (pd && pd.close) {
        const chg = b.close - pd.close;
        const pct = pd.close ? (chg / pd.close) * 100 : 0;
        out.push(`<span class="${chg >= 0 ? 'lg-chg up' : 'lg-chg down'}">D ${chg >= 0 ? '+' : ''}${f(chg)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>`);
      }
    }
    pane.els.lgOhlc.innerHTML = out.join('');
    if (pane.els.lgSpread) pane.els.lgOhlc.appendChild(pane.els.lgSpread); /* ROUND98: persistent live node */
    updateSpreadChip(pane);
    if (typeof DataWindow !== 'undefined') DataWindow.update(pane, b);
    /* round 27: indicator legend rows follow the same crosshair anchor */
    if (typeof Manager.updateIndicatorRows === 'function') Manager.updateIndicatorRows(pane, hoverTime);
    /* ROUND 74: Pine legend rows follow it too */
    if (typeof Manager.updatePineRows === 'function') Manager.updatePineRows(pane, hoverTime);
  }

  Manager.updateLegend = updateLegend;
  Manager.updateLegendTitle = updateLegendTitle;

  /* ---------- ROUND98 (user request): live spread chip ----------
     ask-bid of the latest tick in POINTS (watchlist parity: spreads are
     point-based integers), “—” when the provider truly has no bid/ask.
     Toggle: Settings -> Status line -> "Spread" (stSpread, default on).
     Refresh paths: updateLegend (data/crosshair/applyAll) + the 400ms
     updateCountdowns cadence, so every open chart tracks its own symbol. */
  function updateSpreadChip(pane) {
    const el = pane.els && pane.els.lgSpread;
    if (!el) return;
    const S = Settings ? Settings.conf : {};
    if (S.stSpread === false || !pane.bars || !pane.bars.length) { el.style.display = 'none'; return; }
    const ba = tickBA[pane.symbol];
    el.style.display = '';
    if (!ba || !(ba.bid > 0) || !(ba.ask > ba.bid)) {
      el.textContent = 'Spread \u2014';
      el.title = 'bid/ask not available from the provider';
      return;
    }
    const pt = U.pointSize ? U.pointSize(pane.digits) : Math.pow(10, -pane.digits);
    const pts = Math.max(1, Math.round((ba.ask - ba.bid) / pt));
    el.innerHTML = 'Spread <b>' + pts + '</b>';
    el.title = 'spread in points (' + (ba.ask - ba.bid).toFixed(pane.digits) + ')';
  }
  Manager.updateSpreadChip = updateSpreadChip;

  /* ---------- previous-day stats (server-day aware, from pane bars) ---------- */
  function prevDayInfo(pane) {
    const bars = pane.bars;
    if (!bars || bars.length < 2) return null;
    const off = serverOff();
    const dayOf = (t) => Math.floor((t - off) / 86400);
    const lastDay = dayOf(bars[bars.length - 1].time);
    let i = bars.length - 1;
    while (i >= 0 && dayOf(bars[i].time) === lastDay) i--;
    if (i < 0) return null;
    const pd = dayOf(bars[i].time);
    let j = i;
    while (j - 1 >= 0 && dayOf(bars[j - 1].time) === pd) j--;
    let hi = -Infinity, lo = Infinity;
    for (let k = j; k <= i; k++) {
      if (bars[k].high > hi) hi = bars[k].high;
      if (bars[k].low < lo) lo = bars[k].low;
    }
    return { close: bars[i].close, high: hi, low: lo };
  }
  Manager.prevDayInfo = prevDayInfo;

  /* ---------- price lines (prev day / high-low / bid-ask / alerts) ---------- */
  function hexA(hex, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function setPLine(pane, id, opts) {
    if (!pane._plines) pane._plines = {};
    const cur = pane._plines[id];
    if (cur) { try { pane.series.removePriceLine(cur); } catch (e) {} pane._plines[id] = null; }
    if (!opts) return null;
    try {
      const pl = pane.series.createPriceLine({
        price: opts.price,
        color: opts.color,
        lineWidth: opts.width || 1,
        lineStyle: opts.style != null ? opts.style : LightweightCharts.LineStyle.Dashed,
        axisLabelVisible: !!opts.label,
        title: opts.title || '',
      });
      pane._plines[id] = pl;
      return pl;
    } catch (e) { return null; }
  }

  const INVIS = 'rgba(0,0,0,0)';

  Manager.applyPriceLines = function (pane) {
    if (!pane.series || !pane.series.createPriceLine) return;
    const S = Settings ? Settings.conf : {};
    const L = LightweightCharts.LineStyle;
    /* price line / label visibility follows the Symbol chip mode (TV);
       'line' shows ONLY the line, 'line_value' shows the line + axis label.
       ROUND80: the last-value AXIS label is ALWAYS rendered by the app's own
       .pv-label row now (the TV-style [VALUE][COUNTDOWN] stack) — the native
       LWC label is retired so both rows share one width/geometry. The
       visibility of the DOM label is driven per frame by updateCountdown()
       from the same mode. */
    const mode = S.symLabel || 'name_value_line';
    try {
      pane.series.applyOptions({
        priceLineVisible: mode.indexOf('line') >= 0,
        lastValueVisible: false, // ROUND80: replaced by the .pv-stack value row
      });
    } catch (e) {}
    /* previous day close */
    const pd = prevDayInfo(pane);
    const pdc = S.prevDayClose || 'hidden';
    if (pd && pdc !== 'hidden') {
      setPLine(pane, 'pdc', {
        price: pd.close, color: pdc.indexOf('line') >= 0 ? S.prevDayCloseColor : INVIS,
        label: pdc.indexOf('value') >= 0, title: '', style: L.Dashed,
      });
    } else setPLine(pane, 'pdc', null);
    /* high & low of the previous day */
    const hl = S.highLow || 'hidden';
    if (pd && hl !== 'hidden') {
      const col = hl.indexOf('line') >= 0 ? S.highLowColor : INVIS;
      setPLine(pane, 'pdh', { price: pd.high, color: col, label: hl.indexOf('value') >= 0, title: 'High', style: L.Dotted });
      setPLine(pane, 'pdl', { price: pd.low, color: col, label: hl.indexOf('value') >= 0, title: 'Low', style: L.Dotted });
    } else { setPLine(pane, 'pdh', null); setPLine(pane, 'pdl', null); }
    /* bid & ask (only when the provider sends bid/ask ticks) */
    const ba = S.bidAsk || 'hidden';
    const bb = tickBA[pane.symbol];
    if (ba !== 'hidden' && bb && bb.bid > 0 && bb.ask > 0) {
      const opt = (price, color, label, title) => ({
        price, color, label: ba === 'value_line' && label, title,
        style: L.Solid, width: 1,
      });
      pane._bidLine = setPLine(pane, 'bid', opt(bb.bid, S.bidColor, true, 'Bid')) || pane._bidLine;
      pane._askLine = setPLine(pane, 'ask', opt(bb.ask, S.askColor, true, 'Ask')) || pane._askLine;
      /* keep direct refs for per-tick price updates */
      pane._bidLine = pane._plines['bid']; pane._askLine = pane._plines['ask'];
    } else {
      setPLine(pane, 'bid', null); setPLine(pane, 'ask', null);
      pane._bidLine = null; pane._askLine = null;
    }
    /* ROUND99 (user request): the SPREAD line — MT5 parity. The chart series
       is bid-based; a DASHED ask line above it makes the spread visible as
       the gap, and the live spread in POINTS rides in the axis title
       ("ask · 12 pt"). Driven by the Status line -> Spread toggle (S.stSpread).
       ROUND101 FIX (user report): this used to also require Bid&Ask ==
       'hidden' — so with Bid&Ask set to 'line'/'value_line' the Spread
       checkbox silently did nothing, which is exactly what was reported.
       The checkbox now controls this line on its own. Per-tick refresh
       (and lazy first creation) in onTick. */
    if (S.stSpread !== false && bb && bb.ask > 0 && bb.bid > 0) {
      const pts = Math.max(1, Math.round((bb.ask - bb.bid) /
        (U.pointSize ? U.pointSize(pane.digits) : Math.pow(10, -pane.digits))));
      setPLine(pane, 'sprd', {
        price: bb.ask, color: '#b2b5be', label: true,
        title: 'ask \u00b7 ' + pts + ' pt', style: L.Dashed, width: 1,
      });
      pane._spreadLine = pane._plines['sprd'];
      pane._spreadTitle = 'ask \u00b7 ' + pts + ' pt';
    } else {
      setPLine(pane, 'sprd', null);
      pane._spreadLine = null; pane._spreadTitle = '';
    }
    /* alert lines (price alerts only — time alerts draw as vertical overlay marks) */
    ['al0','al1','al2','al3','al4','al5','al6','al7','al8','al9','al10','al11'].forEach((id) => setPLine(pane, id, null));
    if (S.alertLines !== false && Alerts.list) {
      const mine = Alerts.list.filter((a) => a.symbol === pane.symbol && a.kind !== 'time').slice(-12);
      mine.forEach((a, i) => {
        const isActive = a.active && !a.fired;
        if (!isActive && S.alertOnlyActive !== false) return;
        setPLine(pane, 'al' + i, {
          price: a.price,
          color: isActive ? S.alertColor : hexA(S.alertColor || '#f7c948', 0.45),
          label: true, title: '',
          /* ROUND 62 (user request): the style is ALWAYS dashed and the width
             must NOT follow the selection any more — dragging the line used to
             thicken it (selection-driven 2px) and it stayed thick after the
             move. Constant 1px + Dashed for active AND inactive alike; the
             inactive ones stay visually quieter via the faded colour above. */
          style: L.Dashed,
          width: 1,
        });
      });
    }
  };

  /* ---------- price-scale symbol chip (TV: Name, value, line) ---------- */
  /* BUG-A/R25: the chip is the NAME tag of the price-tag stack now — it shows
     ONLY the symbol name and sits DIRECTLY ABOVE the native last-price label
     (stack top->bottom: [NAME] [PRICE] [COUNTDOWN]). The old build rendered a
     separate label BELOW the stack holding "NAME + live price" — the user
     report: the name must move UP next to the price tag + countdown, and the
     price must not be duplicated in a second label. 'value'/'line' parts of
     the mode keep driving the NATIVE label/line exactly as before. */
  function updateSymChip(pane) {
    const el = pane.chip;
    if (!el) return;
    const S = Settings ? Settings.conf : {};
    const mode = S.symLabel || 'name_value_line';
    if (mode === 'hidden' || mode.indexOf('name') < 0 || !pane.bars.length || pane.replay) { el.style.display = 'none'; return; }
    const price = pane.bars[pane.bars.length - 1].close;
    let y = null;
    try { y = pane.series.priceToCoordinate(price); } catch (e) {}
    if (y == null || !isFinite(y)) { el.style.display = 'none'; return; }
    if (el.textContent !== pane.symbol) el.textContent = pane.symbol; /* R54: guarded (per-frame syncCdPos) */
    el.style.display = 'flex';
    /* ROUND80: the chip sits ABOVE the [VALUE][COUNTDOWN] stack now (the
       value row is centred on the price at y-9..y+9, the countdown hangs to
       y+22). One row above the whole unit; flip BELOW it when the price label
       hugs the top edge (same rule as before, new geometry). */
    const hostH = pane.host ? pane.host.clientHeight : 9999;
    const cdOn = S.countdown !== false && mode.indexOf('value') >= 0;
    const stackH = cdOn ? 31 : 18; // keep in sync with PV_H/CD_H in updateCountdown
    const stackTop = y - 9;
    let top;
    if (stackTop >= 40) top = stackTop - 21;
    else top = stackTop + stackH + 4;
    el.style.top = Math.round(U.clamp(top, 10, hostH - 12)) + 'px';
    const col = S.symLabelColor || '#d1d4dc'; /* R54: guarded (per-frame syncCdPos) */
    if (el.style.getPropertyValue('--sc-color') !== col) el.style.setProperty('--sc-color', col);
  }
  Manager.updateSymChips = function () { for (const p of App.panes) updateSymChip(p); };

  /* ---------- time buckets (native + custom timeframes) ---------- */
  /* Server-time note (ROUND84): MT5 history bars AND provider tick stamps
     are both in the BROKER's server-label frame (server-wall pseudo-UTC —
     mt5.py stamps ticks with server_now()). Buckets therefore anchor at
     SERVER-wall boundaries by flooring the stamp directly (same rule as
     provider_common.bucket_start) — matching MT5 bar opens on every broker
     timezone and every timeframe. serverOff() itself stays in use for the
     display-side freshness checks below (histTruthCheck / countdown staleness). */
  function serverOff() { return (App.feed && App.feed.serverOff) || 0; }

  function bucketStartFor(tf, t) {
    /* ROUND84 ROOT FIX (live candle "reopens" + wrong close countdown on H2
       and above — user report, XAUUSD H2: app 1:45:19 vs MT5 00:45:17):
       t is ALREADY in the broker SERVER-LABEL frame — MT5 history bar times
       are server-wall pseudo-UTC and the provider stamps every tick with
       server_now() = local + SRV_OFF (same frame, see mt5.py). Buckets must
       therefore anchor at SERVER-wall boundaries (00:00 server time), the
       exact way MT5 builds its bars. The old `s = t - off` dance re-anchored
       the buckets at UTC boundaries — equivalent ONLY when off % tf.sec == 0,
       so on a GMT+3 broker every timeframe from H2 up (H2/H4/H6/H8/H12 and
       D1/W1/MN) shifted by off % tf.sec: each tick landed in a phantom
       "freshly opened" bar instead of the real forming one and the countdown
       ran (off % tf.sec) long. Flooring the stamp directly matches the
       provider's own bucket_start() (provider_common.py) for every broker
       offset and every timeframe. */
    if (!tf.custom) {
      if (tf.id === 'D1') return t - (((t % 86400) + 86400) % 86400);
      if (tf.id === 'W1') { const day = (Math.floor(t / 86400) + 4) % 7; return (Math.floor(t / 86400) - day) * 86400; }
      if (tf.id.startsWith('MN')) {
        const d = new Date(t * 1000);
        let m = d.getUTCMonth();
        if (tf.id === 'MN3') m -= m % 3;
        else if (tf.id === 'MN6') m -= m % 6;
        else if (tf.id === 'MN12') m = 0;
        return Math.floor(Date.UTC(d.getUTCFullYear(), m, 1) / 1000);
      }
      return t - (((t % tf.sec) + tf.sec) % tf.sec);
    }
    const n = tf.n;
    if (tf.unit === 'mo') {
      const d = new Date(t * 1000);
      const mi = d.getUTCFullYear() * 12 + d.getUTCMonth();
      const m0 = mi - (mi % n);
      return Math.floor(Date.UTC(Math.floor(m0 / 12), m0 % 12, 1) / 1000);
    }
    if (tf.unit === 'w') {
      const wi = Math.floor(t / 86400) - ((Math.floor(t / 86400) + 4) % 7);
      return (wi - (wi % n)) * 86400;
    }
    if (tf.unit === 'd') {
      const di = Math.floor(t / 86400);
      return (di - (di % n)) * 86400;
    }
    // intraday custom: anchored to the start of the day (TV behavior for odd intervals)
    const ds = t - (((t % 86400) + 86400) % 86400);
    return ds + Math.floor((t - ds) / tf.sec) * tf.sec;
  }
  Manager.bucketStartFor = bucketStartFor;

  /* round 27 indicator hooks — the real implementations live in
     chart/indicators-ui.js and are delegated here (Phase 2: instead of
     indicators-ui overwriting these stubs at load time, manager imports and
     forwards — ES-module-cycle safe, same Manager.* call sites). */
  Manager.recomputeIndicators = function (pane) { return indRecompute(pane); };
  Manager.tickIndicators = function (pane) { return indTickRecompute(pane); };
  Manager.updateIndicatorRows = function (pane, hoverTime) { return indUpdateRows(pane, hoverTime); };
  /* ROUND 74 (Pine engine): same delegation pattern for the Pine script
     instances (pine-ui.js) — recompute on (re)load, forming-bar only on tick */
  Manager.recomputePine = function (pane) { return PineUI.recomputePine(pane); };
  Manager.tickPine = function (pane) { return PineUI.onTickPane(pane); };
  /* ROUND80: parallel lower-TF prefetch — fired at the START of loadBars so
     the M1 fetch overlaps the chart-bars fetch instead of serializing */
  Manager.prefetchPine = function (pane) { return PineUI.prefetchM1(pane); };
  Manager.framePine = function (pane) { return PineUI.framePane(pane); };
  /* ROUND140: post-LWC settle for gestures that never fire a time-range
     event (vertical pan/zoom touches the price scale only) */
  Manager.settlePine = function (pane) { return PineUI.settlePane(pane); };
  Manager.updatePineRows = function (pane, hoverTime) { return PineUI.updateHover(pane, hoverTime); };
  Manager.serializePine = function (pane) { return PineUI.serialize(pane); };
  Manager.restorePine = function (pane, recs) { return PineUI.restoreInto(pane, recs); };
  /* ROUND84 (My scripts in the Indicators dialog): same delegation pattern —
     the dialog adds a user script by id without importing pine-ui directly */
  Manager.addPine = function (pane, scriptId) { return PineUI.add(pane, scriptId); };

  /* ---------- data loading ---------- */
  function pickBaseTf(tf) {
    const natives = App.tf.filter((t) => !t.custom);
    let best = null;
    for (const nt of natives) {
      if (tf.sec % nt.sec === 0) {
        const ratio = tf.sec / nt.sec;
        if (ratio >= 1 && ratio <= 90 && (!best || nt.sec > best.sec)) best = nt;
      }
    }
    if (!best) {
      const below = natives.filter((t) => t.sec < tf.sec);
      best = below.length ? below[below.length - 1] : natives[0];
    }
    return best;
  }

  function aggregateBars(bars, tf) {
    const out = [];
    let cur = null, curB = -1;
    for (const b of bars) {
      const bs = bucketStartFor(tf, b.time);
      if (!cur || bs !== curB) {
        if (cur) out.push(cur);
        cur = { time: bs, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
        curB = bs;
      } else {
        if (b.high > cur.high) cur.high = b.high;
        if (b.low < cur.low) cur.low = b.low;
        cur.close = b.close;
        cur.volume += b.volume || 0;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  function setPaneLoading(pane, on) {
    if (pane.loadingEl) pane.loadingEl.classList.toggle('hidden', !on);
  }

  async function loadBars(pane) {
    if (!App.feed || !App.feed.connected) return;
    /* ROUND86 (user request): Custom Session mode owns the data pipeline
       while it is active — TF switches, symbol switches, new layout panes
       and reconnects all funnel through loadBars, and each must rebuild the
       stitched series instead of fetching plain provider bars. */
    if (App.sessionHook && App.sessionHook.active && App.sessionHook.active()) {
      try { App.sessionHook.loadPane(pane); } catch (e) {}
      return;
    }
    /* ROUND80 (perf on TF switch): kick the Pine lower-TF (M1) prefetch NOW,
       in parallel with the chart-bars fetch below — scripts using
       request.security_lower_tf (786 Zones) used to wait for BOTH round-trips
       back-to-back before their first bar ran. Fire-and-forget: runFull's own
       ensureM1Cache stays the authority and reuses whatever landed. */
    try { Manager.prefetchPine && Manager.prefetchPine(pane); } catch (e) {}
    pane.loading = true;
    pane._loadStartedAt = Date.now(); // F4/R26: stuck-loading watchdog anchor
    setPaneLoading(pane, true);
    const seq = (pane._seq = (pane._seq || 0) + 1);
    try {
      const tf = App.tfById[pane.tf];
      let bars = [], digits = null, resp = null;
      if (tf.custom) {
        const base = pickBaseTf(tf);
        const ratio = Math.max(1, Math.round(tf.sec / base.sec));
        const count = Math.min(App.COUNT_FOR[base.id] || 1500, 1200 * ratio + ratio);
        // empty response retry: right after login the terminal may not have
        // synced history for this timeframe yet (returns None -> []) — poll
        // briefly instead of freezing the chart forever
        for (let attempt = 0; attempt < 4; attempt++) {
          resp = await App.feed.bars(pane.symbol, base.id, count);
          if (seq !== pane._seq || String(resp.symbol).toLowerCase() !== String(pane.symbol).toLowerCase()) return; // stale
          if (resp.digits != null) digits = resp.digits;
          bars = aggregateBars(resp.bars || [], tf);
          if (bars.length) break;
          if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
        }
      } else {
        const count = App.COUNT_FOR[pane.tf] || 1500;
        for (let attempt = 0; attempt < 4; attempt++) {
          resp = await App.feed.bars(pane.symbol, pane.tf, count);
          if (seq !== pane._seq || String(resp.symbol).toLowerCase() !== String(pane.symbol).toLowerCase() || resp.timeframe !== pane.tf) return; // stale
          if (resp.digits != null) digits = resp.digits;
          bars = resp.bars || [];
          if (bars.length) break;
          if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (digits != null) { pane.digits = digits; applySeriesFormat(pane); }
      bars = sanitizeBars(bars, pane.symbol, pane.tf);
      /* R26 (real-broker hole): history never arrived after all retries (cold
         terminal / unsynced symbol / market closed). applySymbol does NOT clear
         the series on purpose (TV keeps the old chart while loading), but with
         NO data ever coming the previous symbol's candles, axis and price tag
         stayed on screen FOREVER while the name chip + watchlist already showed
         the new symbol — the "axis shows wrong prices vs a correct watchlist"
         report. The stale series must never masquerade as this symbol's chart:
         clear it; the pane becomes honestly empty and self-heals via ticks
         (onTick -> scheduleStaleReload -> loadBars) once history syncs. */
      if (!bars.length) {
        console.warn(`[data-guard] ${pane.symbol} ${pane.tf}: no history after retries — clearing the stale series (R26)`);
        try { Log && Log.warn('chart', 'no history after retries — stale series cleared', { symbol: pane.symbol, tf: pane.tf }); } catch (e) {} // round 28
        resetPriceZoom(pane);
        pane.bars = []; pane.barTimes = [];
        try { pane.series.setData([]); } catch (e) {}
        pane._shown = 0;
        pane._loadedAt = Date.now();
        pane._olderDone = false;
        const sid0 = pane._scaleId || 'right';
        try { pane.chart.priceScale(sid0).applyOptions({ mode: pane.logScale ? 1 : (pane.pctScale ? 2 : 0) }); } catch (e) {}
        updateLegend(pane, null);
        pane.nodataEl.classList.remove('hidden'); // honest empty state (round 27)
        Manager.updateOlderPill(pane);
        Manager.recomputeIndicators(pane); // clears indicator series too
        return; // finally clears the loading flag for the current seq
      }
      pane.nodataEl.classList.add('hidden');
      pane._olderDone = false;
      /* BUG-007: a deep-zoom window from the PREVIOUS symbol/interval must
         never constrain the fresh series — reset it with the reload
         (R25: resetPriceZoom also re-arms autoScale on the active scale) */
      resetPriceZoom(pane);
      pane._renkoSize = null;
      pane.baseVal = bars.length ? bars[0].close : 0;
      try {
        setPaneData(pane, bars);
      } catch (feedErr) {
        // last-resort retry with a re-sanitized copy; if even this fails the
        // pane keeps its previous series (no legend/series divergence)
        console.warn('setPaneData failed, retrying sanitized:', feedErr);
        bars = sanitizeBars(bars, pane.symbol, pane.tf);
        setPaneData(pane, bars);
      }
      pane.bars = bars; // assigned AFTER the series accepted the data (BUG-007)
      pane._shown = bars.length;
      pane._loadedAt = Date.now();
      /* round 29: every history payload lands in the Diagnostics log —
         symbol/tf/depth/edges/last-close. When a user reports a wrong chart,
         the Export answers "what EXACTLY did the provider return" in seconds
         (demo-perfect charts here, poisoned terminal history there, ...). */
      try {
        Log && Log.info('data', 'history loaded', {
          symbol: pane.symbol, tf: pane.tf, bars: bars.length,
          firstTime: bars[0].time, lastTime: bars[bars.length - 1].time,
          lastClose: bars[bars.length - 1].close, digits: pane.digits,
          olderDone: !!pane._olderDone,
        });
      } catch (e) {}
      histTruthCheck(pane, bars); // round 29: history vs fresh live tick
      /* BUG-007 consistency probe: the series and the legend must hold the
         same last close — a mismatch means the scale would disagree with the
         legend (the constant-axis class). Surfaced for diagnostics (F-04). */
      try {
        const sd = pane.series.data ? pane.series.data() : null;
        const last = bars[bars.length - 1];
        if (sd && sd.length && last) {
          const sc = sd[sd.length - 1].close;
          if (isFinite(sc) && isFinite(last.close) && Math.abs(sc - last.close) > 1e-9) {
            console.warn(`[data-guard] ${pane.symbol} series/legend divergence: series=${sc} legend=${last.close}`);
          }
        }
      } catch (e) {}
      const sid = pane._scaleId || 'right';
      pane.chart.priceScale(sid).applyOptions({ mode: pane.logScale ? 1 : (pane.pctScale ? 2 : 0) });
      Manager.applyPriceLines(pane); // prev-day / high-low / alerts for the fresh data
      Manager.recomputeIndicators(pane); // round 27: indicator series follow the data
      Manager.recomputePine(pane); // ROUND 74: Pine scripts re-run on the fresh history
      Manager.updateOlderPill(pane);
      // show last ~150 bars (deferred so it wins over lib auto-fit)
      setTimeout(() => {
        try {
          const n = pane.barTimes.length;
          if (n > 150) pane.chart.timeScale().setVisibleLogicalRange({ from: n - 150, to: n + 10 });
          else pane.chart.timeScale().fitContent();
        } catch (e) {}
        /* ROUND104: the indicator panes follow the window the price chart
           just took - this must run AFTER the range above, not before */
        Manager.syncSubRanges(pane);
      }, 0);
      updateLegend(pane, null);
      Watchlist.highlightActive();
    } catch (e) {
      console.warn('loadBars failed', e);
      try { if (Log) { AppErr ? AppErr.wrap(e, 'UNKNOWN', { where: 'loadBars', symbol: pane.symbol, tf: pane.tf }).log() : Log.fromError(e, 'chart', { symbol: pane.symbol, tf: pane.tf }); } } catch (er) {} // round 28
    } finally {
      if (seq === pane._seq) {
        pane.loading = false;
        setPaneLoading(pane, false);
      }
    }
  }
  Manager.loadBars = loadBars;

  /* ---------- older-history pagination (round 27) ----------
     One page = App.OLDER_CHUNK bars ending strictly before the oldest bar
     currently on the chart (provider protocol: bars_req{to}). The provider
     runs dry -> pane._olderDone hides the pill; the 25k on-chart cap bounds
     memory. Viewport stays put: the visible logical range is shifted right
     by the number of prepended bars after setData. */
  async function loadOlder(pane) {
    if (!App.feed || !App.feed.connected || !pane || !App.panes.includes(pane)) return;
    if (pane.loading || pane._olderLoading || pane.replay) return;
    if (Replay && Replay.isActive()) return;
    if (App.sessionHook && App.sessionHook.active && App.sessionHook.active()) return; // ROUND86: stitched history is finite by design
    const cur = pane.bars;
    if (!cur || cur.length < 10) return;
    if (pane._olderDone || cur.length >= (App.MAX_CHART_BARS || 25000)) { Manager.updateOlderPill(pane); return; }
    pane._olderLoading = true;
    Manager.updateOlderPill(pane);
    const tf = App.tfById[pane.tf];
    const to = cur[0].time; // request anchor captured BEFORE the await
    try {
      const chunk = App.OLDER_CHUNK || 1000;
      let older = [], digits = null;
      if (tf.custom) {
        const base = pickBaseTf(tf);
        const ratio = Math.max(1, Math.round(tf.sec / base.sec));
        const count = Math.min(chunk * ratio + ratio, App.COUNT_FOR[base.id] || 1500);
        const resp = await App.feed.bars(pane.symbol, base.id, count, to);
        if (!App.panes.includes(pane) || pane.tf !== tf.id || pane.bars[0]?.time !== to) return;
        if (resp.digits != null) digits = resp.digits;
        older = aggregateBars(resp.bars || [], tf);
      } else {
        const resp = await App.feed.bars(pane.symbol, pane.tf, chunk, to);
        if (!App.panes.includes(pane) || pane.tf !== tf.id || pane.bars[0]?.time !== to) return;
        if (resp.digits != null) digits = resp.digits;
        older = resp.bars || [];
      }
      if (digits != null && digits !== pane.digits) { pane.digits = digits; applySeriesFormat(pane); }
      older = sanitizeBars(older, pane.symbol, pane.tf).filter((b) => b.time < to);
      if (!older.length) { pane._olderDone = true; return; } // provider ran dry
      const added = older.length;
      let vr = null;
      try { vr = pane.chart.timeScale().getVisibleLogicalRange(); } catch (e) {}
      pane.bars = older.concat(pane.bars);
      setPaneData(pane, pane.bars);
      pane._shown = pane.bars.length;
      if (vr) {
        setTimeout(() => {
          try { pane.chart.timeScale().setVisibleLogicalRange({ from: vr.from + added, to: vr.to + added }); } catch (e) {}
          /* ROUND104: prepending history shifts every logical index by
             `added`; the sub-panes must be re-pinned to the SHIFTED range,
             and only once that shift has actually been applied */
          Manager.syncSubRanges(pane);
        }, 0);
      }
      Manager.recomputeIndicators(pane); // no-op until indicators are on the chart
      Manager.recomputePine(pane); // ROUND 74: Pine follows the deeper history
      Manager.applyPriceLines(pane);
      updateLegend(pane, null);
      if (added < chunk) pane._olderDone = true; // short page = end of provider history
    } catch (e) {
      console.warn('loadOlder failed', e);
    } finally {
      pane._olderLoading = false;
      Manager.updateOlderPill(pane);
    }
  }
  Manager.loadOlder = loadOlder;

  Manager.updateOlderPill = function (pane) {
    const el = pane.olderPill;
    if (!el) return;
    const show = pane.bars.length >= 10 && !pane._olderDone &&
      pane.bars.length < (App.MAX_CHART_BARS || 25000) && !pane.replay;
    el.style.display = show ? 'flex' : 'none';
    el.textContent = pane._olderLoading ? 'Loading…' : 'Load older bars';
    el.classList.toggle('busy', !!pane._olderLoading);
  };

  /* ---------- round 29: history/live truth banner ----------
     The pane must never present a chart confidently when its HISTORY and its
     LIVE TICK disagree by more than float noise — that disagreement is the
     exact "axis shows another price universe while the watchlist is right"
     report. One mismatching load may be a gap-crossing jitter; two or more
     consecutive ones mean the history SOURCE is wrong (corrupt terminal
     cache / broken broker series / cross-wired feed) and reloading it again
     cannot heal — so the banner names both numbers and the futile
     auto-reload loop pauses (see scheduleStaleReload). */
  Manager.updateHistWarn = function (pane) {
    const el = pane.histEl;
    if (!el) return;
    const m = pane._histMismatch;
    if (!m) { el.classList.add('hidden'); return; }
    const d = pane.digits || 5;
    const fmt = (v) => (isFinite(v) ? v.toFixed(d) : String(v));
    const txt = el.querySelector('.hw-txt');
    if (txt) txt.textContent = 'Data warning: history last close ' + fmt(m.hist) +
      ' does not match the live price ' + fmt(m.live) +
      ' — the broker history for this symbol looks wrong. Chart keeps the loaded history; live values use the tick feed.';
    el.classList.remove('hidden');
  };

  /* round 29: history/live truth check — called by loadBars after every
     successful load. Fresh tick (<=90s) vs the history's last close; a gap
     bigger than max(50 points, 0.5%) counts as a strike. Two consecutive
     strikes flip the pane into live-truth mode (banner + reload pause). */
  function histTruthCheck(pane, bars) {
    try {
      const px = tickPx[pane.symbol];
      const pxAt = lastTickAt[pane.symbol];
      const nowS = Date.now() / 1000 + serverOff();
      if (!(px > 0) || !pxAt || nowS - pxAt > 90) { // no fresh tick -> no verdict
        return;
      }
      const point = U.pointSize(pane.digits || 5);
      const tol = Math.max(point * 50, Math.abs(px) * 0.005);
      const lc = bars[bars.length - 1].close;
      if (Math.abs(lc - px) > tol) {
        pane._histStrike = (pane._histStrike || 0) + 1;
        pane._histMismatch = { hist: lc, live: px, at: Date.now(), loads: pane._histStrike };
        try { Log && Log.warn('data', 'history/live mismatch (strike ' + pane._histStrike + ')', { symbol: pane.symbol, tf: pane.tf, histLastClose: lc, liveTick: px }); } catch (e) {}
        if (pane._histStrike >= 2 && !pane._histPoisonedAt) {
          pane._histPoisonedAt = Date.now();
          try { Log && Log.error('data', 'history source poisoned — live-truth mode (auto history reload paused 10 min)', { symbol: pane.symbol, tf: pane.tf, hist: lc, live: px }); } catch (e) {}
        }
      } else if (pane._histStrike || pane._histMismatch || pane._histPoisonedAt) {
        // the source healed itself (terminal finished syncing) — full reset
        try { Log && Log.info('data', 'history/live agreement restored', { symbol: pane.symbol, tf: pane.tf, histLastClose: lc, liveTick: px }); } catch (e) {}
        pane._histStrike = 0; pane._histMismatch = null; pane._histPoisonedAt = 0;
      }
    } catch (e) {}
    Manager.updateHistWarn(pane);
  }
  Manager.histTruthCheck = histTruthCheck;

  /* tick -> live bar update.
     Time-base note: history bars come from MT5 in SERVER time and the provider
     now also stamps ticks in server time (mt5.py server_now). We additionally
     tolerate small skew and self-heal a stale series so every chart of the
     same symbol shows identical data. */
  const lastTickAt = {}; // symbol -> epoch of the latest tick (provider time base)
  const tickBA = {};     // symbol -> { bid, ask } of the latest tick (when provided)
  /* R26: symbol -> the latest tick PRICE — the exact number the Watchlist's
     Last column shows. The axis guard anchors on it so a chart can never keep
     painting another symbol's price level while the watchlist is right. */
  const tickPx = {};
  /* BUG-004: exported so the Watchlist (and diagnostics) can read the latest
     bid/ask directly; ticks also carry bid/ask through the onTick hooks */
  Manager.tickBA = tickBA;
  Manager.lastTickAt = lastTickAt;
  Manager.tickPx = tickPx; // R26: live-price anchor for the axis guard + tests

  function scheduleStaleReload(pane) {
    /* round 29: a history source already proven poisoned (2 consecutive
       history/live mismatches) must not be re-requested in a loop — the old
       behaviour re-fetched the same corrupt bars every 30s forever and the
       chart stayed confidently wrong. The banner owns it now; the pause
       auto-expires after 10 minutes so a terminal that finishes syncing
       history gets picked up again. */
    if (pane._histPoisonedAt && Date.now() - pane._histPoisonedAt < 600000) {
      Manager.updateHistWarn(pane);
      return;
    }
    const now = Date.now();
    if (pane._staleReloadAt && now - pane._staleReloadAt < 30000) return;
    pane._staleReloadAt = now;
    setTimeout(() => {
      if (!App.panes.includes(pane) || pane.loading || pane.replay) return;
      // keep the user's viewport while the data is refreshed
      let vr = null;
      try { vr = pane.chart.timeScale().getVisibleLogicalRange(); } catch (e) {}
      Manager.loadBars(pane); // ROUND 35: wrapper-aware (compare re-align)
      if (vr) setTimeout(() => { try { pane.chart.timeScale().setVisibleLogicalRange(vr); } catch (e) {} }, 60);
    }, 30);
  }

  function onTick(symbol, price, time, volume, bid, ask) {
    /* AUDIT FIX (root cause, network-drop hardening): a tick that arrives
       with a missing/invalid price — which is exactly what a reconnecting
       feed can emit mid-handshake — used to fall straight into the bar
       builder below. bt2>last.time built a brand-new bar directly from
       `price` (Math.max/min(last.close, price)) with no validation, so a
       null/NaN price produced a bar with a null/NaN OHLC field that reached
       lightweight-charts and threw "Value is null" downstream (the same bug
       class fixed in sanitizeBars above, but on the live-tick path instead
       of the history-load path). A tick without a usable price carries no
       information for bar-building, so it is dropped here before it can
       corrupt pane.bars. */
    if (price == null || typeof price !== 'number' || !isFinite(price) || price <= 0) return;
    /* ROUND126 (perf): a tick that reaches a VISIBLE pane keeps the render
       loop at full rate; ticks for background symbols (watchlist-only) must
       not force 60fps overlay repaints of quiet charts. */
    let touched = false;
    /* PRICE-BAR FIX (round 27): the fallback "now" must be anchored to the
       SAME time base as the provider ticks (server clock = local + serverOff).
       Mixing the local clock here shifts tick buckets by the broker offset on
       real brokers (GMT+2/+3 vs a UTC+3:30 wall clock) and was one of the
       paths that pushed live bars away from the history's time base. */
    const t = time || Math.floor(Date.now() / 1000 + serverOff());
    lastTickAt[symbol] = t;
    if (price != null && isFinite(price) && price > 0) tickPx[symbol] = price; // R26 live-price anchor
    if (bid != null || ask != null) tickBA[symbol] = { bid: bid || 0, ask: ask || 0 };
    for (const pane of App.panes) {
      if (pane.symbol !== symbol || pane.replay) continue;
      touched = true;
      const tf = App.tfById[pane.tf];
      const bt = bucketStartFor(tf, t);
      const last = pane.bars[pane.bars.length - 1];
      if (!last) { scheduleStaleReload(pane); continue; } // history not synced yet -> self-heal
      let bt2 = bt;
      if (bt > last.time) {
        // provider offset-estimate jitter: snap tiny forward drift to the
        // forming bar instead of creating a phantom micro-bar
        const snap = Math.min(120, tf.sec / 2);
        if (bt - last.time <= snap) bt2 = last.time;
      }
      let changed = null;
      if (bt2 > last.time) {
        // huge gap -> the series went stale (long disconnect, clock drift,
        // market reopen): quietly refresh from the provider, viewport kept
        if (bt2 - last.time >= Math.max(300, tf.sec * 10)) {
          /* ROUND71 ROOT FIX (the "chart periodically refreshes and jumps
             instead of building candles live" regression): this branch used
             to PUSH a far-future phantom bar FIRST (series.update with a
             timestamp minutes/hours beyond the history — a visible JUMP)
             and only then schedule the reload. When the provider's tick
             clock drifted away from the history time base (weekend: the
             offset estimate died with the closed forex symbols), EVERY
             tick landed here -> jump + full history reload on a loop, and
             the chart never streamed. Per the user's directive the chart
             must NEVER jump suddenly: the stale refresh is scheduled
             WITHOUT painting the phantom; the reload (viewport kept)
             heals the series and the tick stream resumes on a correct
             time base. The real fix for the drift itself lives in the
             provider (mt5.py _newest_forming_m1 samples SUBSCRIBED/live
             symbols first now). */
          scheduleStaleReload(pane);
        } else {
          const nb = { time: bt2, open: last.close, high: Math.max(last.close, price), low: Math.min(last.close, price), close: price, volume: volume || 1 };
          pane.bars.push(nb);
          /* ROUND128 BUGFIX (the "history marks on the WRONG candle" report,
             part 2): barTimes only rebuilt on full loads, so the live tail
             appended rows to pane.bars / the series WITHOUT extending
             barTimes — the axis lagged N bars behind and every deal that
             happened after the last reload (open AND close) binary-searched
             to the STALE last candle. Keep the 1:1 axis in step with the
             series rows here (renko rebuilds via setPaneData above). */
          if (pane.style !== 'renko' && Array.isArray(pane.barTimes)) pane.barTimes.push(nb.time);
          changed = nb;
        }
      } else if (bt2 === last.time || last.time - bt2 <= tf.sec) {
        // equal bucket, or a skewed tick in the bucket right before it: fold
        // into the forming bar so no live price is ever dropped
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
        last.volume += volume || 0;
        changed = last;
      }
      if (changed) {
        if (pane.style === 'renko') {
          setPaneData(pane, pane.bars);
        } else {
          /* ROUND145: gated single-row write — a poisoned forming bar used
             to throw inside LWC on every tick (caught, but context-free) */
          const urow = transformData(pane.style, [changed])[0];
          if (seriesWriteOk(pane, 'tick-update', [urow])) {
            try { pane.series.update(urow); } catch (e) {}
          }
        }
        Manager.tickIndicators(pane); // round 27: throttled last-bar refresh (stub until indicators-ui loads)
        Manager.tickPine(pane); // ROUND 74: Pine forming-bar rollback + re-run (throttled inside)
      }
      /* live bid/ask lines + day-roll refresh of prev-day lines */
      if (pane._bidLine && tickBA[symbol]) {
        try { pane._bidLine.applyOptions({ price: tickBA[symbol].bid }); } catch (e) {}
      }
      if (pane._askLine && tickBA[symbol]) {
        try { pane._askLine.applyOptions({ price: tickBA[symbol].ask }); } catch (e) {}
      }
      /* ROUND99: live SPREAD dashed line (the ask) — lazily created on the
         first bid/ask tick (applyPriceLines may have run before the provider
         sent any), then only the price/title follow the stream. Title is
         cached so the axis text is rewritten only when the spread changes. */
      {
        const s99 = Settings ? Settings.conf : {};
        const b99 = tickBA[symbol];
        /* ROUND101 FIX: no longer gated on bidAsk === 'hidden' (see
           applyPriceLines) — the Spread checkbox now works on its own. */
        const want99 = s99.stSpread !== false && b99 && b99.ask > 0 && b99.bid > 0;
        if (want99) {
          const pts = Math.max(1, Math.round((b99.ask - b99.bid) /
            (U.pointSize ? U.pointSize(pane.digits) : Math.pow(10, -pane.digits))));
          const ti = 'ask \u00b7 ' + pts + ' pt';
          if (!pane._spreadLine) {
            pane._spreadLine = setPLine(pane, 'sprd', {
              price: b99.ask, color: '#b2b5be', label: true, title: ti,
              style: LightweightCharts.LineStyle.Dashed, width: 1,
            });
            pane._spreadTitle = ti;
          } else {
            try { pane._spreadLine.applyOptions({ price: b99.ask }); } catch (e) {}
            if (ti !== pane._spreadTitle) {
              pane._spreadTitle = ti;
              try { pane._spreadLine.applyOptions({ title: ti }); } catch (e) {}
            }
          }
        } else if (pane._spreadLine) {
          setPLine(pane, 'sprd', null);
          pane._spreadLine = null; pane._spreadTitle = '';
        }
      }
      if (changed === pane.bars[pane.bars.length - 1] && pane.bars.length > 1 &&
          pane.bars[pane.bars.length - 1].time !== pane.bars[pane.bars.length - 2].time &&
          Math.floor((pane.bars[pane.bars.length - 1].time - serverOff()) / 86400) !==
          Math.floor((pane.bars[pane.bars.length - 2].time - serverOff()) / 86400)) {
        Manager.applyPriceLines(pane); // new server-day: prev-day close/high/low moved
      }
      if (pane === App.activePane) updateLegend(pane, null);
    }
    if (touched && Manager.markChartActivity) Manager.markChartActivity();
    Manager.updateCountdowns();
  }

  /* ---------- countdown to bar close (price scale label) ---------- */
  /* BUG-011: TV format — zero-padded mm:ss (h:mm:ss past one hour).
     ROUND80 (user request): EVERY timeframe carries the countdown now —
     D1/W1/MN included. Remaining >= one day renders as "Nd h:mm:ss" (weekly
     and monthly closes are days away; the label just stretches). The
     close-time base itself moved to bucketEndFor() so monthly buckets are
     calendar-accurate (30d arithmetic would drift the MN close by days). */
  function fmtRemain(sec) {
    sec = Math.max(0, Math.round(sec));
    const p2 = (n) => String(n).padStart(2, '0');
    if (sec >= 86400) {
      const d = Math.floor(sec / 86400), r = sec % 86400;
      const h = Math.floor(r / 3600), m = Math.floor((r % 3600) / 60), s = r % 60;
      return d + 'd ' + h + ':' + p2(m) + ':' + p2(s);
    }
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return h + ':' + p2(m) + ':' + p2(s);
    return p2(m) + ':' + p2(s);
  }

  /* ROUND80: END of the bucket containing t (server-label time, same anchor
     rules as bucketStartFor). For intraday/daily/weekly buckets this is just
     bucketStart + tf.sec; MONTHLY buckets end at the next block boundary in
     CALENDAR time (month lengths vary), so the countdown-to-close and the
     broker's own bar closes agree on every timeframe (user report).
     ROUND84: the monthly math now runs on the stamp directly (server-label
     frame) — same root fix as bucketStartFor above. */
  function bucketEndFor(tf, t) {
    if (tf.custom && tf.unit === 'mo') {
      const d = new Date(t * 1000);
      const mi = d.getUTCFullYear() * 12 + d.getUTCMonth();
      const m0 = mi - (mi % tf.n);
      return Math.floor(Date.UTC(Math.floor((m0 + tf.n) / 12), (m0 + tf.n) % 12, 1) / 1000);
    }
    if (!tf.custom && tf.id && tf.id.indexOf('MN') === 0) {
      const d = new Date(t * 1000);
      let m = d.getUTCMonth();
      if (tf.id === 'MN3') m = m - (m % 3) + 3;
      else if (tf.id === 'MN6') m = m - (m % 6) + 6;
      else if (tf.id === 'MN12') m = 12;
      else m = m + 1;
      return Math.floor(Date.UTC(d.getUTCFullYear(), m, 1) / 1000);
    }
    return bucketStartFor(tf, t) + tf.sec;
  }
  Manager.bucketEndFor = bucketEndFor; // tests (e2e close-time parity)

  /* ROUND80 (TV parity): the value label + countdown are ONE stacked unit
     (.pv-stack). Semantics per Symbol mode (Settings → Scales and lines):
       value rows   — modes containing 'value' (the native LWC label is OFF,
                      applyPriceLines — this DOM label replaces it 1:1)
       countdown row — Countdown setting on AND the value row shown (TV ties
                      the countdown to the value label)
     The stale-tick rule now hides ONLY the countdown row (a closed market
     still shows its last price label, like TV). Positioning is
     change-guarded — syncCdPos() re-runs this every drag frame. */
  const PV_H = 18, CD_H = 13; // row heights (match the CSS box model)

  function updateCountdown(pane) {
    const S = Settings ? Settings.conf : {};
    const stack = pane.pvStack, pv = pane.pv, cd = pane.cd;
    if (!stack || !pv || !cd) return;
    const mode = S.symLabel || 'name_value_line';
    const pvOn = mode.indexOf('value') >= 0 && pane.series && pane.bars.length;
    if (!pvOn) {
      if (stack.style.display !== 'none') stack.style.display = 'none';
      return;
    }
    const b2 = pane.bars[pane.bars.length - 1];
    const tf = App.tfById[pane.tf];
    let price = b2.close, rem = null;
    const live = !pane.replay || !Replay || !Replay.isActive();
    if (live) {
      price = b2.close;
      // use the provider time base (last tick) so the countdown stays aligned
      // with bar times even when the broker server clock differs from local;
      // ROUND84: the pre-first-tick fallback gets the same server-label frame
      const t = lastTickAt[pane.symbol] || Math.floor(Date.now() / 1000 + serverOff());
      rem = tf ? bucketEndFor(tf, t) - t : 0;
    } else {
      const cur = Replay.cursor();
      price = Replay.priceFor(pane);
      rem = tf ? bucketEndFor(tf, Math.floor(cur)) - cur : 0;
    }
    if (price == null || !isFinite(price)) {
      if (stack.style.display !== 'none') stack.style.display = 'none';
      return;
    }
    let y = null;
    try { y = pane.series.priceToCoordinate(price); } catch (e) {}
    if (y == null || !isFinite(y)) {
      if (stack.style.display !== 'none') stack.style.display = 'none';
      return;
    }
    /* value row — same series-coloured background the native label had */
    const lineish = pane.style === 'line' || pane.style === 'area' || pane.style === 'step' || pane.style === 'linemarkers' || pane.style === 'baseline';
    let bg = '#2962ff';
    try {
      const c = styleColors();
      bg = lineish ? '#2962ff' : (b2.close >= b2.open ? c.up : c.down);
    } catch (e) {}
    const pvTxt = U.fmtPrice(price, pane.digits != null ? pane.digits : 5);
    if (pv.textContent !== pvTxt) pv.textContent = pvTxt;
    if (pv.style.background !== bg) pv.style.background = bg;
    pv.style.display = 'block';
    /* countdown row — visible only with fresh ticks (round-27 clock rule:
       tick stamps are SERVER time, age measured against the SERVER clock) */
    let cdShow = false;
    if (S.countdown !== false && tf) {
      const lt = lastTickAt[pane.symbol];
      const stale = live && lt && Date.now() / 1000 + serverOff() - lt > 180;
      if (!stale && rem != null) {
        const txt = fmtRemain(rem);
        if (cd.textContent !== txt) cd.textContent = txt;
        if (cd.style.background !== bg) cd.style.background = bg;
        cdShow = true;
      }
    }
    cd.style.display = cdShow ? 'block' : 'none';
    stack.classList.toggle('no-cd', !cdShow);
    if (stack.style.display !== 'flex') stack.style.display = 'flex';
    /* the PRICE row is vertically centred on the price (TV); the countdown
       hangs below; the whole unit clamps inside the pane */
    const hostH = pane.host ? pane.host.clientHeight : 9999;
    const stackH = cdShow ? PV_H + CD_H : PV_H;
    stack.style.top = Math.round(U.clamp(y - PV_H / 2, 2, Math.max(2, hostH - stackH - 2))) + 'px';
  }

  Manager.updateCountdowns = function () {
    for (const p of App.panes) {
      updateCountdown(p);
      updateSymChip(p);
      updateSpreadChip(p); /* ROUND98: live spread per chart */
    }
    Manager.updateMarketChips();
  };

  /* ROUND54 (zero-lag drag): the price-axis value+countdown stack and the
     symbol chip are positioned from priceToCoordinate(last close), which
     changes EVERY frame of a click-drag (the two-axis pan moves the price
     scale). They were only repositioned by the throttled updateCountdowns()
     (400ms), so during a drag both visibly lagged the mouse and caught up on
     release. syncCdPos() re-runs the SAME two updaters — every hide rule,
     the replay price source, the clamp logic: all reused, nothing duplicated
     — but only for labels that are currently visible, so the steady-state
     cost is ~2 priceToCoordinate reads per pane per frame. updateCountdowns()
     keeps its 400ms cadence for the rest (market chips, stale-tick sweep). */
  Manager.syncCdPos = function () {
    for (const p of App.panes) {
      if (p.pvStack && p.pvStack.style.display !== 'none') updateCountdown(p);
      if (p.chip && p.chip.style.display !== 'none') updateSymChip(p);
    }
  };

  /* ---------- symbol / tf / style (per chart + Sync in Layout) ---------- */
  const subs = new Map(); // symbol -> refcount

  function acquireSub(symbol) {
    subs.set(symbol, (subs.get(symbol) || 0) + 1);
    App.feed.subscribe(symbol);
  }
  function releaseSub(symbol) {
    const c = (subs.get(symbol) || 1) - 1;
    if (c <= 0) { subs.delete(symbol); App.feed.unsubscribe(symbol); }
    else subs.set(symbol, c);
  }
  /* BUG-013: shared ref-counted subscription bookkeeping — the Watchlist
     acquires one ref per listed symbol while its panel is open, so a chart
     symbol switch (release+acquire) can never drop a row's data flow */
  Manager.acquireSub = acquireSub;
  Manager.releaseSub = releaseSub;

  /* BUG-E/R25 hardening: a manual price-zoom window belongs to ONE symbol's
     price level. The reload path (loadBars) already resets pane.pz, but every
     path that swaps the DATA must — a window captured on the previous symbol
     (e.g. a ~2.0 cross) otherwise survives and pins the axis to prices the new
     series never reaches (the "axis shows another symbol's numbers" report). */
  function resetPriceZoom(pane) {
    pane.pz = { active: false, center: 0, span: 0, at: 0 };
    try {
      const sid = pane._scaleId || 'right';
      pane.chart.priceScale(sid).applyOptions({ autoScale: true });
    } catch (e) {}
  }

  function applySymbol(pane, symbol) {
    if (pane.symbol === symbol) return;
    releaseSub(pane.symbol);
    pane.symbol = symbol;
    pane.bars = []; pane.barTimes = [];
    pane._renkoSize = null;
    /* round 29: the truth state belongs to ONE (symbol, tf, source) triple —
       a new symbol is a new history source and starts unjudged */
    pane._histStrike = 0; pane._histMismatch = null; pane._histPoisonedAt = 0;
    Manager.updateHistWarn(pane);
    resetPriceZoom(pane); // BUG-E/R25: the old symbol's window must never survive
    clearPriceLines(pane);
    pane.els.lgOhlc.innerHTML = '';
    acquireSub(symbol);
    updateLegendTitle(pane);
    updateWatermark(pane);
    persistPanes();
    Manager.loadBars(pane); // ROUND 35: wrapper-aware (compare re-align)
    /* round 23: keep the top-bar symbol label in sync with the active chart */
    if (pane === App.activePane && typeof Toolbar !== 'undefined') {
      try { Toolbar.refreshActive(); } catch (e) {}
    }
  }

  function applyTf(pane, tfId) {
    if (pane.tf === tfId) return;
    pane.tf = tfId;
    pane.bars = []; pane.barTimes = [];
    pane._renkoSize = null;
    pane._histStrike = 0; pane._histMismatch = null; pane._histPoisonedAt = 0; // round 29: new source
    Manager.updateHistWarn(pane);
    resetPriceZoom(pane); // BUG-E/R25: same rule as the symbol switch
    clearPriceLines(pane);
    pane.els.lgOhlc.innerHTML = '';
    updateLegendTitle(pane);
    updateWatermark(pane);
    persistPanes();
    Manager.loadBars(pane); // ROUND 35: wrapper-aware (compare re-align)
    /* round 23: the top bar must re-highlight the new interval immediately
       (the fav bar marks the ACTIVE chart's interval in colour) */
    if (pane === App.activePane && typeof Toolbar !== 'undefined') {
      try { Toolbar.refreshActive(); } catch (e) {}
    }
  }

  /* drop every price-line of a pane (used before data reloads / style swaps) */
  function clearPriceLines(pane) {
    if (!pane._plines) pane._plines = {};
    for (const id of Object.keys(pane._plines)) setPLine(pane, id, null);
    pane._bidLine = null; pane._askLine = null;
  }

  Manager.setSymbol = function (pane, symbol) {
    if (!pane) pane = App.activePane;
    if (!pane) return;
    if (Replay && Replay.isActive()) Replay.stop();
    applySymbol(pane, symbol);
    Watchlist.highlightActive();
    // Sync in Layout: propagate the symbol to every other chart
    if (App.sync.symbol && App.panes.length > 1) {
      for (const p of App.panes) if (p !== pane) applySymbol(p, symbol);
    }
  };

  Manager.setTf = function (pane, tfId) {
    if (!pane) pane = App.activePane;
    if (!pane) return;
    if (Replay && Replay.isActive()) Replay.stop();
    applyTf(pane, tfId);
    // Sync in Layout: propagate the interval to every other chart
    if (App.sync.interval && App.panes.length > 1) {
      for (const p of App.panes) if (p !== pane) applyTf(p, tfId);
    }
  };

  function persistStyles() {
    U.lsSet('mt5_styles_' + App.layout, App.panes.map((p) => p.style));
  }

  /* last charts state (per pane symbol/tf/style) — restored on boot, written by
     Save Layout on load; TV-like "reopen the app where you left off".
     Autosave (Save Layout menu) can turn this automatic persistence off. */
  function persistPanes() {
    if (!App.panes.length) return;
    if (Toolbar.autosaveOn && !Toolbar.autosaveOn()) return;
    U.lsSet('mt5_boot_panes', {
      layout: App.layout,
      /* round 27: the per-chart indicator instances persist with the layout
         (round 31: the per-instance style overrides ride along too) */
      panes: App.panes.map((p) => ({ symbol: p.symbol, tf: p.tf, style: p.style,
        indicators: (p.indicators || []).map((i) => ({ type: i.type, params: i.params, colors: i.colors,
          style: (i.style && typeof i.style === 'object') ? i.style : undefined,
          /* round 33: the user-resized pane height rides along */
          frac: (typeof i.frac === 'number' && isFinite(i.frac) && i.frac > 0) ? i.frac : undefined,
          visible: i.visible !== false })),
        /* ROUND 74: Pine script instances persist with the layout */
        pineScripts: Manager.serializePine ? Manager.serializePine(p) : undefined })),
    });
  }
  Manager.persistPanes = persistPanes;

  function refreshStyleUI(pane) {
    const s = App.STYLES.find((x) => x.id === pane.style);
    if (pane === App.activePane) {
      App.style = pane.style;
      U.lsSet('mt5_style', pane.style);
      const btn = document.getElementById('style-btn');
      if (btn && s) btn.innerHTML = icon(s.icon);
      Toolbar.renderStyleQuick();
    }
  }

  /* per-chart chart style (TV): changes apply to the given chart only.
     Legacy form setStyle('candles') applies to the active chart. */
  Manager.setStyle = function (pane, style) {
    if (typeof pane === 'string') { style = pane; pane = App.activePane; }
    if (!pane) pane = App.activePane;
    if (!pane || !App.STYLES.some((s) => s.id === style)) return;
    if (pane.style === style) { refreshStyleUI(pane); return; }
    pane.style = style;
    pane._renkoSize = null;
    resetPriceZoom(pane); // BUG-E/R25: renko/heikin windows don't transfer either
    try { pane.chart.removeSeries(pane.series); } catch (e) {}
    pane.series = makeSeries(pane.chart, style, pane);
    applySeriesFormat(pane);
    pane._plines = {}; pane._bidLine = null; pane._askLine = null; // old lines died with the old series
    setPaneData(pane, pane.bars);
    pane._shown = pane.bars.length;
    Manager.applyPriceLines(pane);
    updateLegendTitle(pane);
    persistStyles();
    persistPanes();
    refreshStyleUI(pane);
    Manager.updateCountdowns();
  };

  /* keeps pane.style values in sync after settings-driven rebuilds */
  Manager.ensureStyles = function () {
    for (const p of App.panes) {
      if (!p.style) p.style = App.style;
    }
  };

  Manager.applyTimezone = function () {
    for (const pane of App.panes) {
      pane.chart.timeScale().applyOptions(chartOptions(pane).timeScale);
      pane.chart.applyOptions({ localization: chartOptions(pane).localization });
    }
    const btn = document.getElementById('tz-label');
    if (btn) btn.textContent = TZ.shortLabel(App.tz);
    U.lsSet('mt5_tz', App.tz);
    /* ROUND88: the Custom Session window lives in the CHART timezone — a
       switch must re-stitch (new shift -> different bars per day) */
    if (App.sessionHook && App.sessionHook.onTzChange) {
      try { App.sessionHook.onTzChange(); } catch (e) {}
    }
  };

  /* round 23: swap every chart's brand wordmark on a dark/light theme switch
     (white mark on the dark chart, dark mark on the light chart) */
  Manager.applyBrandTheme = function () {
    const src = (Theme && Theme.mode === 'light') ? 'assets/logo-dark.png' : 'assets/logo-light.png';
    for (const p of App.panes) if (p.brand) p.brand.src = src;
  };

  /* BUG-008: the WHOLE snapshot compositor palette derives from the ACTIVE
     theme (via the settings the theme engine keeps migrated) — no hardcoded
     dark colors. Unit-testable: Manager.getSnapshotPalette('light'|'dark').
     (Phase 2: lives in manager.js now — toolbar.js only CALLS it; attaching
     it from there at module-evaluation time is TDZ-unsafe in a cycle.) */
  Manager.getSnapshotPalette = function (mode) {
    const want = mode || null;
    const active = (Theme ? Theme.mode : 'dark');
    const dark = (want ? want : active) !== 'light';
    const S = Settings ? Settings.conf : {};
    /* the user's colour picks belong to the ACTIVE theme — for a unit-test
       probe of the OTHER theme fall back to that theme's factory defaults */
    const useUser = !want || want === active;
    const defs = (Theme && Theme.chartDefaults) ? Theme.chartDefaults(dark ? 'dark' : 'light') : {};
    const pick = (key, fb) => (useUser && S[key]) || defs[key] || fb;
    return {
      mode: dark ? 'dark' : 'light',
      bg1: pick('bg1', dark ? '#0f0f0f' : '#ffffff'), /* round 44: TV dark */
      bg2: pick('bg2', dark ? '#0a0a0a' : '#f0f3fa'),
      gradient: useUser ? S.bgMode !== 'solid' : false,
      text: pick('scaleText', dark ? '#d1d4dc' : '#131722'),
      dim: dark ? '#787b86' : '#6a6d78',
      up: pick('upColor', '#089981'),
      down: (useUser && S.colorPrevClose === false) ? pick('upColor', '#089981') : pick('downColor', '#f23645'),
      frame: pick('scaleLines', dark ? '#2a2e39' : '#c9cdd6'),
      /* same brand mapping as Manager.applyBrandTheme (white mark on dark) */
      logo: dark ? 'assets/logo-light.png' : 'assets/logo-dark.png',
    };
  };

  /* ---------- layouts (TV catalog: tile grid + draggable boundaries) ---------- */
  function destroyPanes() {
    for (const p of App.panes) {
      try { if (p._ro) p._ro.disconnect(); } catch (e) {}
      /* ROUND126 (perf/memory): stop the legacy rAF sub-range fallback chain
         and release the engine's window-level listeners (dead panes used to
         pin both forever) */
      try { if (p._lrRaf != null) p._lrRaf = false; } catch (e) {}
      try { if (p.engine && p.engine.destroy) p.engine.destroy(); } catch (e) {}
      /* round 32: release indicator sub-charts BEFORE the main chart */
      try { Manager.destroyPaneSubs(p); } catch (e) {}
      /* ROUND 74: release Pine canvases/series before the chart dies */
      try { if (PineUI) PineUI.dropPane(p); } catch (e) {}
      try { p.chart.remove(); } catch (e) {}
      /* round 31: release the per-pane indicator render state (series map) —
         dead pane objects used to leak in the indicators-ui registry */
      try { if (indDropPane) indDropPane(p); } catch (e) {}
    }
    App.panes = [];
    App.selection = null;
    if (UI.onSelectionChanged) UI.onSelectionChanged();
    U.clear(document.getElementById('charts-grid'));
  }

  const GAP = 5;
  function layoutSpec(id) {
    return App.layoutById(id || App.layout);
  }
  function defaultRatios(spec) {
    return { cols: Array(spec.C).fill(1), rows: Array(spec.R).fill(1) };
  }
  function validRatios(r, spec) {
    if (!r || !Array.isArray(r.cols) || !Array.isArray(r.rows)) return null;
    if (r.cols.length !== spec.C || r.rows.length !== spec.R) return null;
    const ok = (a) => a.every((f) => isFinite(f) && f > 0.001);
    return ok(r.cols) && ok(r.rows) ? { cols: r.cols.slice(), rows: r.rows.slice() } : null;
  }

  /* pixel rects of every tile for the current grid size */
  function paneRects(spec, W, H, r) {
    const freeW = W - (spec.C - 1) * GAP, freeH = H - (spec.R - 1) * GAP;
    const tc = r.cols.reduce((a, b) => a + b, 0) || 1;
    const tr = r.rows.reduce((a, b) => a + b, 0) || 1;
    const cw = r.cols.map((f) => (freeW * f) / tc);
    const rh = r.rows.map((f) => (freeH * f) / tr);
    const xat = (i) => { let s = 0; for (let k = 0; k < i; k++) s += cw[k] + GAP; return s; };
    const yat = (i) => { let s = 0; for (let k = 0; k < i; k++) s += rh[k] + GAP; return s; };
    return spec.tiles.map((t) => ({
      x: xat(t[0]), y: yat(t[1]),
      w: cw.slice(t[0], t[0] + t[2]).reduce((a, b) => a + b, 0) + (t[2] - 1) * GAP,
      h: rh.slice(t[1], t[1] + t[3]).reduce((a, b) => a + b, 0) + (t[3] - 1) * GAP,
    }));
  }
  /* px position of the grid line between index i and i+1 on an axis */
  function linePos(ratios, i, free) {
    const tot = ratios.reduce((a, b) => a + b, 0) || 1;
    let s = 0;
    for (let k = 0; k <= i; k++) s += ratios[k];
    return (free * s) / tot + i * GAP + GAP; // left/top of the cell AFTER the line
  }

  /* where a grid boundary is a real edge between tiles (merged px intervals, grid units) */
  function edgeIntervals(tiles, axis, idx) {
    const line = idx + 1;
    const ivs = [];
    for (const A of tiles) {
      for (const B of tiles) {
        if (axis === 'v') {
          if (A[0] + A[2] === line && B[0] === line) {
            const y0 = Math.max(A[1], B[1]), y1 = Math.min(A[1] + A[3], B[1] + B[3]);
            if (y1 > y0) ivs.push([y0, y1]);
          }
        } else if (A[1] + A[3] === line && B[1] === line) {
          const x0 = Math.max(A[0], B[0]), x1 = Math.min(A[0] + A[2], B[0] + B[2]);
          if (x1 > x0) ivs.push([x0, x1]);
        }
      }
    }
    ivs.sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const iv of ivs) {
      const l = out[out.length - 1];
      if (l && iv[0] <= l[1]) l[1] = Math.max(l[1], iv[1]);
      else out.push([iv[0], iv[1]]);
    }
    return out;
  }

  let splitterEls = [];

  function buildSplitters(grid) {
    for (const el of splitterEls) el.remove();
    splitterEls = [];
    const spec = layoutSpec();
    const mk = (axis, arrName, idx, g0, g1) => {
      const el = U.el('div', 'grid-splitter ' + axis, grid);
      el._arr = arrName; el._idx = idx; el._g0 = g0; el._g1 = g1;
      el.addEventListener('mousedown', (e) => startSplitDrag(e, el));
      el.addEventListener('dblclick', () => {
        App._ratios = defaultRatios(spec);
        layoutPanes(); persistRatios();
      });
      splitterEls.push(el);
    };
    for (let i = 0; i < spec.C - 1; i++) {
      for (const [g0, g1] of edgeIntervals(spec.tiles, 'v', i)) mk('v', 'cols', i, g0, g1);
    }
    for (let i = 0; i < spec.R - 1; i++) {
      for (const [g0, g1] of edgeIntervals(spec.tiles, 'h', i)) mk('h', 'rows', i, g0, g1);
    }
    positionSplitters();
  }

  function positionSplitters() {
    const grid = document.getElementById('charts-grid');
    const spec = layoutSpec();
    const W = grid.clientWidth, H = grid.clientHeight;
    if (!W || !H) return;
    const r = App._ratios;
    const freeW = W - (spec.C - 1) * GAP, freeH = H - (spec.R - 1) * GAP;
    const gx = (i) => linePos(r.cols, i - 1, freeW); // start of cell i
    const gy = (i) => linePos(r.rows, i - 1, freeH);
    for (const el of splitterEls) {
      const arr = r[el._arr];
      if (!arr) continue;
      if (el._arr === 'cols') {
        el.style.left = U.clamp(linePos(arr, el._idx, freeW) - GAP, 0, W) + 'px';
        el.style.width = GAP + 'px';
        el.style.top = gy(el._g0) + 'px';
        el.style.height = Math.max(0, gy(el._g1) - GAP - gy(el._g0)) + 'px';
      } else {
        el.style.top = U.clamp(linePos(arr, el._idx, freeH) - GAP, 0, H) + 'px';
        el.style.height = GAP + 'px';
        el.style.left = gx(el._g0) + 'px';
        el.style.width = Math.max(0, gx(el._g1) - GAP - gx(el._g0)) + 'px';
      }
    }
  }

  function layoutPanes() {
    const grid = document.getElementById('charts-grid');
    const W = grid.clientWidth, H = grid.clientHeight;
    if (!W || !H || !App.panes.length) return;
    /* maximized chart (TV): fills the whole grid while the others stay hidden */
    const mp = App._maxPane;
    if (mp && App.panes.includes(mp)) {
      mp.root.style.left = '0px';
      mp.root.style.top = '0px';
      mp.root.style.width = W + 'px';
      mp.root.style.height = H + 'px';
      for (const el of splitterEls) el.style.display = 'none';
      return;
    }
    for (const el of splitterEls) el.style.display = '';
    const spec = layoutSpec();
    const rects = paneRects(spec, W, H, App._ratios);
    App.panes.forEach((p, i) => {
      const rc = rects[i] || rects[rects.length - 1];
      p.root.style.left = Math.round(rc.x) + 'px';
      p.root.style.top = Math.round(rc.y) + 'px';
      p.root.style.width = Math.round(rc.w) + 'px';
      p.root.style.height = Math.round(rc.h) + 'px';
    });
    positionSplitters();
  }
  Manager.layoutPanes = layoutPanes;

  /* ---- per-chart maximize / restore (TV multi-chart) ---- */
  Manager.toggleMaximize = function (pane) {
    Manager.setMaximized(App._maxPane === pane ? null : pane);
  };

  Manager.setMaximized = function (pane) {
    App._maxPane = pane || null;
    for (const p of App.panes) {
      const on = p === App._maxPane;
      p.root.classList.toggle('maximized', on);
      p.root.style.display = (!App._maxPane || on) ? '' : 'none';
      if (p.maxBtn) {
        p.maxBtn.innerHTML = icon(on ? 'restore' : 'maximize');
        p.maxBtn.title = on ? 'Restore chart' : 'Maximize chart';
        p.maxBtn.classList.toggle('on', on);
      }
    }
    layoutPanes();
    if (App._maxPane) setActive(App._maxPane);
  };

  Manager.exitMaximized = function () {
    if (App._maxPane) { Manager.setMaximized(null); return true; }
    return false;
  };

  function persistRatios() {
    U.lsSet('mt5_split_' + App.layout, App._ratios);
  }

  function startSplitDrag(e, el) {
    e.preventDefault();
    e.stopPropagation();
    const grid = document.getElementById('charts-grid');
    const rect = grid.getBoundingClientRect();
    const spec = layoutSpec();
    const arrName = el._arr;
    const idx = el._idx;
    const startArr = App._ratios[arrName].slice();
    const horiz = arrName === 'cols';
    const startPos = horiz ? e.clientX : e.clientY;
    const free = (horiz ? rect.width : rect.height) - (horiz ? spec.C : spec.R) * GAP + GAP;
    const tot = startArr.reduce((a, b) => a + b, 0) || 1;

    const onMove = (ev) => {
      const pos = horiz ? ev.clientX : ev.clientY;
      const df = ((pos - startPos) / (free || 1)) * tot;
      const arr = App._ratios[arrName];
      const lo = 0.06;
      arr[idx] = U.clamp(startArr[idx] + df, lo, startArr[idx] + startArr[idx + 1] - lo);
      arr[idx + 1] = startArr[idx] + startArr[idx + 1] - arr[idx];
      layoutPanes();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persistRatios();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /* ---------- Sync in Layout: Time (scroll) / Date range (zoom) ---------- */
  function syncGuardOk(p) {
    return p.barTimes.length > 1 && !p.loading && Date.now() - (p._loadedAt || 0) > 1000;
  }

  function syncTimeTo(src, lr) {
    if (App.panes.length < 2) return;
    if (Replay && Replay.isActive()) return;
    if (!syncGuardOk(src)) return;
    const srcTf = (App.tfById[src.tf] || {}).sec || 60;
    const t1 = U.logicalToTime(src.barTimes, lr.from);
    const t2 = U.logicalToTime(src.barTimes, lr.to);
    const spanSrc = lr.to - lr.from;
    for (const p of App.panes) {
      if (p === src || p._tsync || !syncGuardOk(p)) continue;
      const pTf = (App.tfById[p.tf] || {}).sec || 60;
      p._tsync = true;
      try {
        const ts = p.chart.timeScale();
        const pr = ts.getVisibleLogicalRange();
        let from, to;
        if (App.sync.time && App.sync.daterange) {
          from = U.timeToLogical(p.barTimes, t1);
          to = U.timeToLogical(p.barTimes, t2);
        } else if (App.sync.time) {
          // scroll sync: keep this chart's own zoom, align the right edge time
          to = U.timeToLogical(p.barTimes, t2);
          const curSpan = pr ? pr.to - pr.from : 150;
          from = to - curSpan;
        } else {
          // date-range sync: keep this chart's position, match the zoom.
          // source span (bars) × source interval = time width; ÷ this interval → bars here
          to = pr ? pr.to : U.timeToLogical(p.barTimes, t2);
          from = to - spanSrc * (srcTf / pTf);
        }
        if (to - from > 0.5) {
          p._lastSyncKey = Math.round(from * 2) + '|' + Math.round(to * 2);
          ts.setVisibleLogicalRange({ from, to });
        }
      } catch (e) {}
      p._tsync = false;
    }
  }

  function initTimeSync(pane) {
    pane.chart.timeScale().subscribeVisibleLogicalRangeChange((lr) => {
      if (!lr || pane._tsync) return;
      if (!App.sync || (!App.sync.time && !App.sync.daterange)) return;
      const key = Math.round(lr.from * 2) + '|' + Math.round(lr.to * 2);
      if (pane._lastSyncKey === key) return; // this range was just applied by the sync itself
      pane._lastSyncKey = key;
      syncTimeTo(pane, lr);
    });
  }
  Manager.syncTimeKick = function () {
    // called right after the user enables Time / Date range sync
    if (!App.sync || (!App.sync.time && !App.sync.daterange)) return;
    const src = App.activePane;
    if (!src) return;
    try {
      const lr = src.chart.timeScale().getVisibleLogicalRange();
      if (lr) syncTimeTo(src, lr);
    } catch (e) {}
  };

  /* ROUND121: the third parameter is the chart-TABS restore path — an EXPLICIT
     array of pane records (the exact keep-shape of round 31/74). Tabs.js hands
     the target tab's saved panes here, so a tab switch rebuilds THAT tab's
     charts instead of whatever mt5_boot_panes happens to hold (records of the
     previously active tab would otherwise leak across the switch). Everything
     else about the rebuild is byte-identical to a normal layout switch. */
  Manager.setLayout = function (layoutId, keepSymbols, explicitPanes) {
    if (Replay && Replay.isActive()) Replay.stop();
    App._maxPane = null; // rebuilding the grid clears any maximized chart
    const grid = document.getElementById('charts-grid');
    const spec = layoutSpec(layoutId);
    /* round 31: carry the FULL pane state across the layout switch — the old
       mapping (symbol/tf/style only) silently DROPPED every indicator when
       the user switched single chart -> multi chart (reported in round 31) */
    const prev = App.panes.map((p) => ({ symbol: p.symbol, tf: p.tf, style: p.style,
      indicators: (p.indicators || []).map((i) => ({ type: i.type, params: i.params, colors: i.colors,
        style: (i.style && typeof i.style === 'object') ? i.style : undefined,
        frac: (typeof i.frac === 'number' && isFinite(i.frac) && i.frac > 0) ? i.frac : undefined,
        visible: i.visible !== false })),
      pineScripts: Manager.serializePine ? Manager.serializePine(p) : undefined }));
    destroyPanes();
    App.layout = spec.id;
    U.lsSet('mt5_layout', spec.id);
    grid.dataset.layout = spec.id;
    App._ratios = validRatios(U.lsGet('mt5_split_' + spec.id, null), spec) || defaultRatios(spec);
    const savedStyles = U.lsGet('mt5_styles_' + spec.id, null);
    /* boot restore: last charts of THIS layout (written by persistPanes / Save Layout);
       ROUND121: an explicit pane array (tab restore) takes precedence over it */
    const boot = !keepSymbols
      ? (Array.isArray(explicitPanes) && explicitPanes.length
        ? { layout: spec.id, panes: explicitPanes }
        : U.lsGet('mt5_boot_panes', null))
      : null;
    const bootArr = boot && boot.layout === spec.id && Array.isArray(boot.panes) ? boot.panes : null;
    for (let i = 0; i < spec.tiles.length; i++) {
      let keep = keepSymbols && prev[i] ? prev[i] : null;
      if (!keep && bootArr) {
        const b = bootArr[i];
        if (b && b.symbol && App.tfById[b.tf]) keep = b;
      }
      const symbol = keep ? keep.symbol : (prev[0] ? prev[0].symbol : 'EURUSD');
      const tf = keep ? keep.tf : (prev[0] ? prev[0].tf : 'M1');
      const style = savedStyles && App.STYLES.some((s) => s.id === savedStyles[i])
        ? savedStyles[i]
        : (keep && keep.style && App.STYLES.some((s) => s.id === keep.style) ? keep.style : App.style);
      const pane = createPane(grid, symbol, tf, style);
      /* round 27: restore this chart's indicator instances (validated against
         the registry in indicators-ui when the data arrives) */
      if (keep && Array.isArray(keep.indicators)) {
        pane.indicators = keep.indicators
          .filter((i) => i && Indicators && Indicators.def(i.type))
          .map((i, k) => ({ id: Date.now() + k, type: String(i.type),
            params: (i.params && typeof i.params === 'object') ? i.params : {},
            colors: (i.colors && typeof i.colors === 'object') ? i.colors : {},
            style: (i.style && typeof i.style === 'object') ? i.style : undefined,
            frac: (typeof i.frac === 'number' && isFinite(i.frac) && i.frac > 0) ? i.frac : undefined,
            visible: i.visible !== false }));
      }
      /* ROUND 74: restore this chart's Pine script instances */
      if (keep && Array.isArray(keep.pineScripts) && keep.pineScripts.length) {
        Manager.restorePine(pane, keep.pineScripts);
      } else if (!keep && !bootArr && prev[0] && Array.isArray(prev[0].indicators) &&
                 prev[0].indicators.length && symbol === prev[0].symbol) {
        /* round 32 (user report): switching single chart -> multi chart must
           carry the SOURCE chart's indicators onto every NEW chart that
           inherits the same symbol (e.g. RSI/MACD on gold, then 2v layout ->
           the second gold chart opens with the same set). From here on every
           chart manages its own copies INDEPENDENTLY (add/remove/settings are
           per-pane; nothing propagates back). */
        pane.indicators = prev[0].indicators
          .filter((i) => i && Indicators && Indicators.def(i.type))
          .map((i, k) => ({ id: Date.now() + k + Math.floor(Math.random() * 999), type: String(i.type),
            params: JSON.parse(JSON.stringify(i.params || {})),
            colors: JSON.parse(JSON.stringify(i.colors || {})),
            style: (i.style && typeof i.style === 'object') ? JSON.parse(JSON.stringify(i.style)) : undefined,
            frac: (typeof i.frac === 'number' && isFinite(i.frac) && i.frac > 0) ? i.frac : undefined,
            visible: i.visible !== false }));
      }
      App.panes.push(pane);
      acquireSub(symbol);
    }
    persistStyles();
    persistPanes();
    layoutPanes();
    buildSplitters(grid);
    setActive(App.panes[0]);
    for (const p of App.panes) Manager.loadBars(p); // ROUND 35: wrapper-aware
    Toolbar.renderTfFavs();
  };

  function setActive(pane) {
    if (App.activePane === pane) return;
    App.activePane = pane;
    for (const p of App.panes) p.root.classList.toggle('active-pane', p === pane);
    if (typeof Toolbar !== 'undefined') Toolbar.refreshActive();
    if (typeof Watchlist !== 'undefined') Watchlist.highlightActive();
    if (ObjectTree.refresh) ObjectTree.refresh();
  }
  Manager.setActive = setActive;

  /* ROUND120 (user request): per-destination symbol gating for the
     crosshair sync — panes holding the SAME symbol as the source follow
     the plain 'Crosshair' toggle; panes holding a DIFFERENT symbol follow
     the new 'Crosshair on different symbols' ('crossX') toggle instead.
     One decision point for both syncCrossMove and syncCrossClear. */
  function crossSyncOk(src, dst) {
    if (!App.sync) return false;
    const sameSym = src && dst && src.symbol === dst.symbol;
    return sameSym ? !!App.sync.crosshair : !!App.sync.crossX;
  }
  Manager.crossSyncOk = crossSyncOk;   /* test hook */

  /* crosshair leave: clear the synced crosshair on the other charts.
     ROUND58: every stamped pane also gets a 100ms deadman window
     (_xsyncUntil) — LWC fires subscribeCrosshairMove DEFERRED for our own
     programmatic crosshair calls, after the synchronous _xsync window has
     closed; the stamp absorbs that late echo (see the subscription above). */
  Manager.syncCrossClear = function (src) {
    if (!App.sync || !(App.sync.crosshair || App.sync.crossX)) return;
    const now = performance.now();
    if (src) src._xsyncUntil = now + 100;
    for (const p of App.panes) {
      if (p === src) continue;
      if (!crossSyncOk(src, p)) continue;   /* ROUND120: symbol-pair gating */
      p._xsync = true;
      p._xsyncUntil = now + 100;
      /* BUG-C/R25: synced panes drop their live time bubble too */
      if (p.engine) { p.engine._cross = { on: false, x: -1, y: -1 }; }
      if (p.taxLive) p.taxLive.style.display = 'none';
      try { p.chart.clearCrosshairPosition(); } catch (e) {}
      /* round 32: drop the indicator sub-panes' horzLines too */
      if (p._subs) for (const sub of p._subs.values()) { try { sub.chart.clearCrosshairPosition(); } catch (e) {} }
      p._xsync = false;
    }
  };

  /* crosshair move: show it at the same time on the other charts (TV Sync in Layout).
     Round 31: the synced panes' custom vertical line + pill are driven with
     the SOURCE time (t) — engine._xOf extrapolates beyond the last bar, so
     sync now works in the future margin too (the native setCrosshairPosition
     only accepts in-data times: its timeToIndex clamps future times to the
     last bar, which would pin the synced line at the live market). */
  Manager.syncCrossMove = function (src, t) {
    if (!App.sync || !(App.sync.crosshair || App.sync.crossX) || App.panes.length < 2) return;
    /* ROUND58: deadman stamps — src absorbs the deferred echo of its OWN
       programmatic native set, receivers the echo of the one below. */
    const now = performance.now();
    if (src) src._xsyncUntil = now + 100;
    for (const p of App.panes) {
      if (p === src) continue;
      if (!crossSyncOk(src, p)) continue;   /* ROUND120: symbol-pair gating */
      p._xsync = true;
      p._xsyncUntil = now + 100;
      try {
        const i = U.nearestIndex(p.barTimes, t);
        const b = p.bars[i];
        const tol = Math.max(1, (App.tfById[p.tf] ? App.tfById[p.tf].sec : 60) / 2);
        if (b && Math.abs(b.time - t) <= tol) {
          p.chart.setCrosshairPosition(b.close, t, p.series);
        } else {
          /* the time sits outside THIS chart's data (the source is in its
             future margin, or a session hole): native horzLine off, the
             custom vertical still follows the extrapolated position */
          p.chart.clearCrosshairPosition();
        }
        if (p.engine && p.barTimes.length) {
          const x = p.engine._xOf(t);
          p.engine._cross = { on: true, x, y: -1, t };
          try { p.engine._updateCrossBubble(p.engine.view()); } catch (e) {}
        } else if (p.engine) {
          p.engine._cross = { on: false, x: -1, y: -1 };
          if (p.taxLive) p.taxLive.style.display = 'none';
        }
        /* round 32: the synced pane's indicator sub-panes never carry a
           stale horzLine — clear them (the engine's vertical line still
           spans every sub-pane) */
        if (p._subs) for (const sub of p._subs.values()) { try { sub.chart.clearCrosshairPosition(); } catch (e) {} }
      } catch (e) {}
      p._xsync = false;
    }
  };

  /* ---------- BUG-E/R25: self-healing price-axis guard ----------
     The user report (real MT5 broker): after opening some symbols the price
     axis kept showing the PREVIOUS symbol's numbers while the candles/legend
     were correct — a series/axis/scale disagreement that demo-mode switching
     could not reproduce. Every provable stale-window path now resets pane.pz
     (applySymbol / applyTf / setStyle / loadBars), and this guard catches any
     remaining path on the live broker:
       1) series vs legend divergence (the series still holds old data while
          pane.bars already holds the new symbol) -> re-feed + rebuild;
       2) a price-zoom window older than the last data reload (era check via
          pz.at) -> reset the window;
       3) the series' live price mapping outside the axis' visible window
          while the window is stale -> reset + rebuild.
     It never fights a legitimate user zoom: windows stamped AFTER the last
     reload are left alone (Free Transform may park the view away from price
     on purpose). Transformed styles (heikin/renko) skip check 1 — their
     series values legitimately differ from pane.bars. */
  Manager.axisGuard = function () {
    /* PRICE-BAR FIX (round 27 — the actual root cause of the reported bug):
       tick stamps (lastTickAt) are SERVER-stamped (provider server_now) while
       this guard compared them against the LOCAL clock. For a real broker the
       two differ by the broker tz offset (GMT+2/+3); a Tehran user on such a
       broker measured a constant skew of 90+ minutes, so the freshness check
       `nowS - pxAt <= 90` NEVER passed, the live-tick anchor (F1b) was INERT,
       and any poisoned/stale history froze the price bar at a wrong level
       while the Watchlist (server-aware) kept ticking correctly. The guard
       now measures tick age against the estimated SERVER clock — one time
       base end-to-end, exactly like the reference platform normalizes
       everything to a single clock. */
    const nowS = Date.now() / 1000 + serverOff();
    for (const pane of App.panes) {
      if (!pane.series || pane.replay) continue;
      /* F4/R26: a pane stuck in loading forever would be invisible to every
         guard below — force-release after 60s (worst legit path is the 45s
         bars_req timeout, which releases the flag by itself) */
      if (pane.loading) {
        if (pane._loadStartedAt && Date.now() - pane._loadStartedAt > 60000) {
          console.warn(`[axis-guard] ${pane.symbol}: loading flag stuck >60s — releasing (R26)`);
          pane.loading = false;
          setPaneLoading(pane, false);
        } else continue;
      }
      /* F2/R26: bars empty but the series still paints — the stale chart of
         ANOTHER symbol (the applySymbol window where history never arrives).
         The old guard skipped bars-empty panes, so this class never healed. */
      if (!pane.bars.length) {
        let n = 0;
        try { const sd = pane.series.data ? pane.series.data() : null; n = sd ? sd.length : 0; } catch (e) {}
        if (n > 0) {
          console.warn(`[axis-guard] ${pane.symbol}: series holds ${n} bars while pane.bars is empty — clearing (R26)`);
          try { pane.series.setData([]); } catch (e) {}
          pane.barTimes = [];
        }
        continue;
      }
      const style = pane.style || 'candles';
      const transformed = style === 'heikin' || style === 'renko';
      /* ROUND145 (hunt for the "Value is null" spam): if OUR store holds a
         poisoned bar, the provider fed it through a path that bypassed
         sanitizeBars (or mutated it after) — log the hole with the row */
      try {
        const tail = pane.bars.slice(-3);
        const bi = U.firstBadRow(tail);
        if (bi >= 0 && Log) {
          let dump = '';
          try { dump = JSON.stringify(tail[bi]).slice(0, 300); } catch (e) { dump = String(tail[bi]).slice(0, 300); }
          Log.error('data', 'poisoned bar in pane store (sanitize bypass?)', {
            symbol: pane.symbol, tf: pane.tf, style, at: pane.bars.length - 3 + bi, row: dump,
          });
        }
      } catch (e) {}
      let sl = null;
      try {
        const sd = pane.series.data ? pane.series.data() : null;
        if (sd && sd.length) sl = sd[sd.length - 1].close != null ? sd[sd.length - 1].close : sd[sd.length - 1].value;
      } catch (e) {}
      const bl = pane.bars[pane.bars.length - 1].close;
      const point = U.pointSize(pane.digits || 5);
      /* 1) series/legend divergence — never legitimate */
      if (!transformed && sl != null && isFinite(sl) && Math.abs(sl - bl) > point / 2) {
        console.warn(`[axis-guard] ${pane.symbol}: series(${sl}) vs legend(${bl}) — re-feeding (BUG-E class)`);
        resetPriceZoom(pane);
        try { setPaneData(pane, pane.bars); } catch (e) {}
        Manager.applyPriceLines(pane);
        updateLegend(pane, null);
        continue;
      }
      /* 1b/R26: LIVE-TICK ANCHOR — the same number the Watchlist shows. If the
         tick is fresh (<=90s) and the series/legend disagrees with it, the
         chart is painting another symbol's price level:
           - legend wrong too  -> the HISTORY itself is stale/wrong -> reload
           - only series wrong -> re-feed the series from pane.bars
         Two consecutive guard hits (3s) are required — a single volatile tick
         or a dropped skewed tick must never trigger a reload on its own. */
      if (!transformed) {
        const px = tickPx[pane.symbol];
        const pxAt = lastTickAt[pane.symbol];
        let pxBad = false;
        if (px > 0 && pxAt && nowS - pxAt <= 90) {
          const tol = Math.max(point * 2, Math.abs(px) * 1e-4); // float noise vs wrong-symbol gap
          const sBad = sl != null && isFinite(sl) && Math.abs(sl - px) > tol;
          const bBad = Math.abs(bl - px) > tol;
          pxBad = sBad || bBad;
          if (pxBad) {
            pane._pxStrike = (pane._pxStrike || 0) + 1;
            if (pane._pxStrike >= 2) {
              if (bBad) {
                /* round 29: keep the mismatch snapshot fresh while the source
                   is known-poisoned (the guard sees it every 1.5s) — the
                   reload itself is choked inside scheduleStaleReload */
                if (pane._histPoisonedAt && Date.now() - pane._histPoisonedAt < 600000) {
                  pane._histMismatch = { hist: bl, live: px, at: Date.now(), loads: pane._histStrike };
                  Manager.updateHistWarn(pane);
                } else {
                  console.warn(`[axis-guard] ${pane.symbol}: legend(${bl}) vs live tick(${px}) — reloading history (R26)`);
                  scheduleStaleReload(pane);
                }
              } else {
                console.warn(`[axis-guard] ${pane.symbol}: series(${sl}) vs live tick(${px}) — re-feeding (R26)`);
                resetPriceZoom(pane);
                try { setPaneData(pane, pane.bars); } catch (e) {}
                Manager.applyPriceLines(pane);
                updateLegend(pane, null);
              }
              pane._pxStrike = 0;
              continue;
            }
          }
        }
        if (!pxBad) pane._pxStrike = 0;
      }
      /* 2) stale-era manual window (belt & braces for unknown paths) */
      if (pane.pz && pane.pz.active && pane.pz.at && pane._loadedAt && pane.pz.at < pane._loadedAt) {
        console.warn(`[axis-guard] ${pane.symbol}: stale price-zoom window from before the reload — reset`);
        resetPriceZoom(pane);
      }
      /* 3) axis window excludes the live price while the window predates the
         reload — the frozen-axis symptom */
      if (pane.pz && pane.pz.active && pane.pz.at && pane._loadedAt && pane.pz.at < pane._loadedAt) {
        let y = null;
        try { y = pane.series.priceToCoordinate(bl); } catch (e) {}
        const h = pane.host ? pane.host.clientHeight : 800;
        if (y == null || !isFinite(y) || y < -h || y > 2 * h) {
          resetPriceZoom(pane);
          try { setPaneData(pane, pane.bars); } catch (e) {}
        }
      }
    }
  };

  /* ---------- render loop ----------
     ROUND126 (perf): the loop used to repaint EVERY pane's overlay canvas at
     full display refresh (60fps+) FOREVER, in every window, even when
     nothing changed — the single largest CPU/RAM consumer of the app (each
     engine.render() clears + repaints a full canvas and rebuilds the
     time-axis DOM strips, per pane, per frame). A repaint is only meaningful
     when something changed: the cursor moved, a chart gesture ran, new data
     landed, the window was resized — otherwise an idle heartbeat (4fps)
     keeps the bar-close countdown / go-live pill / axis fresh. Windows that
     lost focus (tiled solo windows nobody is watching) always ride the
     heartbeat. Behaviour is unchanged: every interaction or visible tick
     still repaints on the VERY NEXT frame (activity window 1.3s). */
  let started = false;
  let _lastAct = 0;
  let _lastPaint = 0;
  const ACT_WINDOW = 1300; // ms of "recently interactive" after an event/tick
  const IDLE_FLOOR = 250;  // idle heartbeat — max ~4 overlay repaints/s
  Manager.markChartActivity = function () { _lastAct = performance.now(); };
  Manager.startLoop = function () {
    if (started) return;
    started = true;
    let lastCd = 0;
    let lastGuard = 0;
    const mark = () => { _lastAct = performance.now(); };
    /* one passive capture set per WINDOW (not per pane) — marks cursor/
       keyboard/gesture activity so the very next frame repaints */
    document.addEventListener('pointermove', mark, { capture: true, passive: true });
    document.addEventListener('pointerdown', mark, { capture: true, passive: true });
    document.addEventListener('wheel', mark, { capture: true, passive: true });
    document.addEventListener('touchmove', mark, { capture: true, passive: true });
    document.addEventListener('keydown', mark, { capture: true });
    window.addEventListener('resize', mark);
    const loop = (ts) => {
      const fresh = (performance.now() - _lastAct) < ACT_WINDOW;
      let focused = true;
      try { focused = document.hasFocus(); } catch (e) {}
      /* focused + recent activity -> full rate; otherwise the heartbeat floor
         (covers countdown seconds, go-live pill, programmatic chart moves) */
      const paint = (fresh && focused) || (ts - _lastPaint >= IDLE_FLOOR);
      if (paint) {
        _lastPaint = ts;
        for (const p of App.panes) {
          if (p.engine) p.engine.render();
          /* ROUND 74: repaint the Pine overlay canvases (script visuals) */
          if (p.pineScripts && p.pineScripts.length) { try { Manager.framePine(p); } catch (e) {} }
          /* ROUND140: vertical pans/zooms never fire a time-range event, so
             the ROUND139 settle never runs for them — while a gesture is
             active, converge the overlay after LWC's redraw every frame
             (coalesced + key-deduped inside; idle frames never reach here) */
          if (p.pineScripts && p.pineScripts.length && p.engine && (p.engine.mode !== 'idle' || p.engine._axisDrag)) {
            try { Manager.settlePine(p); } catch (e) {}
          }
          /* round 33: keep every pane's price-scale width locked to the widest
             one at ALL times (guarded, ~O(1) per frame when nothing changed) */
          if (p._subs && p._subs.size) { try { syncAxisWidths(p); } catch (e) {} }
        }
        /* ROUND54: per-frame position sync so the countdown + symbol chip
           track drags 1:1 (see syncCdPos above); the throttled full refresh
           below stays for everything else */
        Manager.syncCdPos();
        if (UI.tickFrame) UI.tickFrame();
      }
      if (ts - lastCd > 400) {
        lastCd = ts;
        Manager.updateCountdowns();
      }
      if (ts - lastGuard > 1500) { // BUG-E/R25: self-healing watchdog
        lastGuard = ts;
        try { Manager.axisGuard(); } catch (e) {}
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  };

  /* ---------- init ---------- */
  Manager.init = function () {
    App.feed.onTick.push(onTick);
    App.feed.onClose.push(() => {
      const el = document.getElementById('conn-label');
      const dot = document.querySelector('#conn-status .dot');
      if (el) el.textContent = 'Reconnecting…';
      if (dot) dot.className = 'dot yellow';
    });
    Manager.setLayout(App.layout || '1', false);
    // keep pane rects in sync with the window size
    const grid = document.getElementById('charts-grid');
    new ResizeObserver(() => layoutPanes()).observe(grid);
    Manager.startLoop();
  };

  Manager.seriesDataFor = seriesDataFor;
  Manager.lastTickAt = lastTickAt;
export { Manager };
