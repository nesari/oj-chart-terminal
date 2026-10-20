/**
 * Chart manager — layout concern.
 *
 * Moved verbatim out of chart/manager.js in F4.3 (pure move: functions and
 * their Manager.* assignments only; no logic changes).
 *
 * @module chart/manager/layout
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
import { seriesOptions, setPaneData, styleName } from './data.js';
import { PV_H, lastTickAt, onTick, tickBA, updateCountdown } from './render.js';
import { serverOff } from './history.js';

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

export { updateWatermark, applySeriesFormat, updateLegendTitle, updateMarketChip, updateLegend, updateSpreadChip, prevDayInfo, hexA, setPLine, INVIS, updateSymChip };
