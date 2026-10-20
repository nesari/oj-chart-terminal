/**
 * Chart manager — history concern.
 *
 * Moved verbatim out of chart/manager.js in F4.3 (pure move: functions and
 * their Manager.* assignments only; no logic changes).
 *
 * @module chart/manager/history
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

/* ---------- time buckets (native + custom timeframes) ---------- */
/* Server-time note (ROUND84): MT5 history bars AND provider tick stamps
   are both in the BROKER's server-label frame (server-wall pseudo-UTC —
   mt5.py stamps ticks with server_now()). Buckets therefore anchor at
   SERVER-wall boundaries by flooring the stamp directly (same rule as
   provider_common.bucket_start) — matching MT5 bar opens on every broker
   timezone and every timeframe. serverOff() itself stays in use for the
   display-side freshness checks below (histTruthCheck / countdown staleness). */

import { applySeriesFormat, updateLegend } from './layout.js';
import { sanitizeBars, setPaneData } from './data.js';
import { applySymbol, lastTickAt, onTick, resetPriceZoom, scheduleStaleReload, tickPx } from './render.js';

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
      try { App.sessionHook.loadPane(pane); } catch (e) { Log.warn('chart', 'session restore for pane failed', e) }
      return;
    }
    /* ROUND80 (perf on TF switch): kick the Pine lower-TF (M1) prefetch NOW,
       in parallel with the chart-bars fetch below — scripts using
       request.security_lower_tf (786 Zones) used to wait for BOTH round-trips
       back-to-back before their first bar ran. Fire-and-forget: runFull's own
       ensureM1Cache stays the authority and reuses whatever landed. */
    try { Manager.prefetchPine && Manager.prefetchPine(pane); } catch (e) { Log.debug('pine', 'pine prefetch failed', e) }
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
        try { Log.warn('data', 'setPaneData failed, retrying sanitized', { symbol: pane.symbol, tf: pane.tf, error: feedErr }); } catch (e) {}
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
            try { Log.warn('data', 'series/legend divergence', { symbol: pane.symbol, tf: pane.tf, series: sc, legend: last.close }); } catch (e) {}
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
      try { Log.warn('data', 'loadOlder failed', { symbol: pane.symbol, tf: pane.tf, error: e }); } catch (er) {}
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

export { serverOff, bucketStartFor, pickBaseTf, aggregateBars, setPaneLoading, loadBars, loadOlder, histTruthCheck };
