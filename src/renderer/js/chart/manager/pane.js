/**
 * Chart manager — pane concern.
 *
 * Moved verbatim out of chart/manager.js in F4.3 (pure move: functions and
 * their Manager.* assignments only; no logic changes).
 *
 * @module chart/manager/pane
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
import { applySeriesFormat, updateLegend, updateLegendTitle, updateWatermark } from './layout.js';
import { chartOptions, makeSeries } from './data.js';
import { destroyPanes, initTimeSync, persistPanes, setActive, subs } from './render.js';
import { started } from './shell.js';
import { loadBars, loadOlder } from './history.js';

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

export { createPane, AXIS_H, subChartOptions, SUB_MIN_H, MAIN_MIN_H, computeSubHeights, sortedSubs, layoutSubPanes, syncSubRanges, layoutSubSplitters, startSubPaneDrag, syncAxisWidths, removeSubPane };
