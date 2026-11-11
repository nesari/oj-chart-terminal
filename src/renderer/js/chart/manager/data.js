/**
 * Chart manager — data concern.
 *
 * Moved verbatim out of chart/manager.js in F4.3 (pure move: functions and
 * their Manager.* assignments only; no logic changes).
 *
 * @module chart/manager/data
 */
import { U } from '../../core/util.js';
import { Log } from '../../../../core/logger.js';
import { AppErr } from '../../../../core/errors.js';
import { icon } from '../../ui/icons.js';
import { TZ } from '../../../../core/timezone.js';
import { Theme } from '../../core/theme.js';
import { App } from '../../../../core/state.js';
import { Settings } from '../settings.js';
import { Engine } from '../../drawing/engine.js';
import { Indicators } from '../../../../core/indicators.js';
import { IndicatorsUI, recompute as indRecompute, tickRecompute as indTickRecompute, updateIndicatorRows as indUpdateRows, dropPane as indDropPane } from '../indicators-ui.js';
import { PineUI } from '../pine-ui.js';
import { Toolbar } from '../toolbar.js';
import { UI } from '../../drawing/ui.js';
import { Watchlist } from '../../panels/watchlist.js';
import { Alerts } from '../../panels/alerts.js';
import { DataWindow } from '../../panels/datawindow.js';
import { ObjectTree } from '../../panels/objects.js';
import { Replay } from '../../panels/replay.js';
import { Manager, LWC } from './shared.js';
import { insertDayGaps } from '../../../../core/session-math.js';

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
    if (dropped || merged) { try { Log.warn('data', 'data-guard: sanitized bars', { symbol, tf: tfId, dropped, merged }); } catch (e) {} }
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
    } catch (e) { Log.debug('chart', 'pane markers apply failed', e) }
  }
  Manager.applyPaneMarkers = applyPaneMarkers;

  /* ROUND288: is the "Session breaks" setting on? Read from Settings.conf so
     the value survives reloads and follows the dialog live. */
  function breaksEnabled() {
    try {
      const c = (Settings && Settings.conf) || {};
      return c.sessionBreaks !== false;
    } catch (e) { return true; }
  }

  /* ROUND288: build the series rows for a chart WITH session breaks. Two
     whitespace slots are inserted at each calendar-day boundary, exactly like
     TV's "Session breaks". The gap-inclusive time axis is stored on the pane
     (`_sessWithGapTimes` + `_sessGapIdx`) because the drawing engine, the Pine
     adapter and trade history all map time→pixel through it. */
  function sessionBreaksRows(pane, bars) {
    const style = pane.style || 'candles';
    const gapBars = 3;
    const { bars: withGaps, gaps } = insertDayGaps(bars, gapBars, null);
    if (!gaps) {
      /* a single day segment: nothing to break, fall through to plain data */
      pane._sessWithGapTimes = null;
      pane._sessGapIdx = null;
      return false;
    }
    const mapped = transformData(style, bars);
    const rows = [];
    let i = 0;
    for (const r of withGaps) {
      if (Object.keys(r).length === 1) rows.push({ time: r.time });
      else rows.push(mapped[i++]);
    }
    seriesWriteOk(pane, 'breaks-setData', rows);
    try { pane.series.setData(rows); } catch (e) {}
    pane._sessWithGapTimes = withGaps.map((r) => r.time);
    const gapIdx = new Uint8Array(withGaps.length);
    for (let k = 0; k < withGaps.length; k++) if (Object.keys(withGaps[k]).length === 1) gapIdx[k] = 1;
    pane._sessGapIdx = gapIdx;
    pane._sessBreaksOnly = true;
    pane.barTimes = bars.map((b) => b.time);
    Manager.applyPaneMarkers(pane);
    if (style === 'baseline') {
      try { pane.series.applyOptions({ baseValue: pane.baseVal != null ? pane.baseVal : (bars.length ? bars[0].close : 0) }); } catch (e) {}
    }
    if (style === 'heikin') {
      const hd = transformData('heikin', bars);
      pane._haLast = hd.length ? { open: hd[hd.length - 1].open, close: hd[hd.length - 1].close } : null;
    }
    return true;
  }

  function setPaneData(pane, bars) {
    const style = pane.style || 'candles';
    if (style === 'renko') {
      const size = renkoSizeFor(pane);
      const bricks = renkoBricks(bars, size, App.tfById[pane.tf].sec);
      const rows = bricks.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
      seriesWriteOk(pane, 'renko-setData', rows); // ROUND145: logs context on poison, never blocks
      try { pane.series.setData(rows); } catch (e) {}
      pane.barTimes = bricks.map((b) => b.time);
      /* ROUND288: renko has no continuous time axis — no day breaks */
      pane._sessWithGapTimes = null;
      pane._sessGapIdx = null;
      return;
    }
    /* ROUND288 (TV parity): Session breaks. When the setting is on, the same
       whitespace-row pipeline the Replay/Custom-Session mode already used is
       applied to the plain series, so bars after a day boundary get a small
       visual gap. Custom Session keeps priority (it owns the series when
       active), and a single-day loading window simply falls through. */
    const hook = (typeof App !== 'undefined' && App.sessionHook) || null;
    const customSessionOn = !!(hook && hook.active && hook.active());
    if (!customSessionOn && breaksEnabled()) {
      try {
        if (sessionBreaksRows(pane, bars)) return;
      } catch (e) { Log.debug('chart', 'session breaks skipped', e); }
    }
    /* ROUND288: the plain path must also CLEAR any gap axis a previous breaks
       pass published — otherwise the drawing engine keeps mapping time→pixel
       through a stale gap-inclusive axis after the user turns the setting off
       (and `_sessBreaksOnly` would keep the pane marked as broken). */
    pane._sessWithGapTimes = null;
    pane._sessGapIdx = null;
    pane._sessBreaksOnly = false;
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

export { chartOptions, chartTimeScaleOpts, priceMargins, styleColors, seriesOptions, makeSeries, transformData, snapNice, atrBrickSize, renkoSizeFor, renkoBricks, finiteNum, sanitizeBars, seriesWriteOk, applyPaneMarkers, setPaneData, seriesDataFor, styleName };
