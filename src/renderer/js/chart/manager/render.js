/**
 * Chart manager — render concern.
 *
 * Moved verbatim out of chart/manager.js in F4.3 (pure move: functions and
 * their Manager.* assignments only; no logic changes).
 *
 * @module chart/manager/render
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
import { chartOptions, makeSeries, sanitizeBars, seriesWriteOk, setPaneData, styleColors, transformData } from './data.js';
import { bucketStartFor, loadBars, serverOff } from './history.js';
import { applySeriesFormat, setPLine, updateLegend, updateLegendTitle, updateSpreadChip, updateSymChip, updateWatermark } from './layout.js';
import { createPane } from './pane.js';

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
  /* AUDIT FIX (reconnect): the provider's subscription buckets live on the
     WebSocket connection, so a reconnect starts with ZERO subscriptions while
     this ref-count map still believes every symbol is live. Re-issuing the
     subscribe frame per still-held ref restores chart ticks (Feed also
     replays its own desired set, covering non-Manager subscribers). */
  function resubscribeAll() {
    let n = 0;
    for (const [symbol, count] of subs) {
      if (!symbol || count <= 0) continue;
      try { App.feed.subscribe(symbol); n++; } catch (e) { Log.debug('feed', 'resubscribe failed', e) }
    }
    return n;
  }
  Manager.resubscribeAll = resubscribeAll;

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
    /* ROUND286 (hardening): a pane's interval can arrive from a SAVED layout
       (mt5_boot_panes) or an external caller, and a custom interval may have
       been deleted since it was saved. The whole render path dereferences
       App.tfById[pane.tf].label unguarded, so an unknown id used to throw
       inside updateLegendTitle and leave the chart half-switched. Reject an
       unknown interval up front (a loud no-op beats a broken chart). */
    if (tfId != null && !App.tfById[tfId]) {
      try {
        Log.warn('chart', 'ignoring unknown timeframe id "' + tfId + '" (not in App.tfById)');
      } catch (e) {}
      return;
    }
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
    } catch (e) { Log.debug('chart', 'time sync init failed', e) }
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

export { lastTickAt, tickBA, tickPx, scheduleStaleReload, onTick, fmtRemain, bucketEndFor, PV_H, updateCountdown, subs, acquireSub, releaseSub, resubscribeAll, resetPriceZoom, applySymbol, applyTf, clearPriceLines, persistStyles, persistPanes, refreshStyleUI, destroyPanes, GAP, layoutSpec, defaultRatios, validRatios, paneRects, linePos, edgeIntervals, splitterEls, buildSplitters, positionSplitters, layoutPanes, persistRatios, startSplitDrag, syncGuardOk, syncTimeTo, initTimeSync, setActive };
