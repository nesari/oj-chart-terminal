/**
 * Chart manager — shell concern.
 *
 * Moved verbatim out of chart/manager.js in F4.3 (pure move: functions and
 * their Manager.* assignments only; no logic changes).
 *
 * @module chart/manager/shell
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
import { applySymbol, applyTf, lastTickAt, layoutPanes, onTick, resetPriceZoom, scheduleStaleReload, tickPx } from './render.js';
import { loadBars, serverOff, setPaneLoading } from './history.js';
import { sanitizeBars, seriesDataFor, setPaneData } from './data.js';
import { updateLegend } from './layout.js';
import { syncAxisWidths } from './pane.js';

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
          try { Log.warn('chart', 'axis-guard: loading flag stuck >60s - releasing', { symbol: pane.symbol, tf: pane.tf }); } catch (e) {}
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
          try { Log.warn('chart', 'axis-guard: series holds bars while pane.bars is empty - clearing', { symbol: pane.symbol, tf: pane.tf, seriesBars: n }); } catch (e) {}
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
        try { Log.warn('chart', 'axis-guard: series/legend divergence - re-feeding', { symbol: pane.symbol, tf: pane.tf, series: sl, legend: bl }); } catch (e) {}
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
                  try { Log.warn('chart', 'axis-guard: legend/live tick divergence - reloading history', { symbol: pane.symbol, tf: pane.tf, legend: bl, tick: px }); } catch (e) {}
                  scheduleStaleReload(pane);
                }
              } else {
                try { Log.warn('chart', 'axis-guard: series/live tick divergence - re-feeding', { symbol: pane.symbol, tf: pane.tf, series: sl, tick: px }); } catch (e) {}
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
        try { Log.warn('chart', 'axis-guard: stale price-zoom window - reset', { symbol: pane.symbol, tf: pane.tf }); } catch (e) {}
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

export { crossSyncOk, started, _lastAct, _lastPaint, ACT_WINDOW, IDLE_FLOOR };
