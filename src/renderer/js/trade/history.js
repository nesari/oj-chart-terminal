/**
 * ROUND98 (user request) — trade history ON the chart, MetaTrader-style.
 *
 * The account's deals (provider `history` op -> mt5 history_deals_get /
 * demo _t_deals) are drawn on every chart of their symbol:
 *   - entry deal  (DEAL_ENTRY_IN) : arrow in the deal's direction AT THE
 *     EXACT fill point (time + price), text "B 0.10" / "S 0.10".
 *   - close deal  (OUT/INOUT/OUT_BY): ring marker at the exact fill point,
 *     labelled with the NET money (profit + commission + swap).
 *   - every close is joined to its position's entry with the MT5-style
 *     DASHED connector, colored by the close's net money.
 *   - OPEN positions have no close deal -> entry point only. The moment
 *     the position closes (any way) the state watcher refetches the deals
 *     and the exit + connector appear immediately.
 *
 * ROUND100 (user request) — precision + lock + hover:
 *   - the WHOLE layer is a lightweight-charts SERIES PRIMITIVE
 *     (series.attachPrimitive, LWC v4.2): it renders inside the chart's
 *     own draw pass, so pan / zoom / autoscale can never displace it —
 *     the old overlay canvas repainted on timers and visibly drifted.
 *   - EXACT coordinates: horizontal = the bar that contains the deal
 *     (ROUND127: the mark sits at the candle CENTER on every timeframe —
 *     the old intra-bar interpolation drifted right of center and the
 *     offset grew with the timeframe), vertical = the exact fill price.
 *   - HOVER on a closed trade (line or endpoints): the pair is
 *     HIGHLIGHTED (thick line, bright, everything else dims) and an
 *     MT5-format box appears near the cursor:
 *         [comment ]#<in> -> #<out>, profit <net>, <SYMBOL>
 *         <price at cursor>
 *     It closes after 10s (user spec); hovering again re-opens it.
 *
 * The old setMarkers path stays registered but returns [] — the primitive
 * owns the drawing (one owner, no double markers); the manager/session
 * merge points are untouched.
 *
 * @module trade/history
 */
import { App } from '../../../core/state.js';
import { U } from '../core/util.js';
import { Trade } from './state.js';
import { TradeRoute } from './route.js';
import { TZ } from '../../../core/timezone.js';
import { Manager } from '../chart/manager.js';
import { Log } from '../../../core/logger.js';

const K_ON = 'mt5_th_on';
const REAPPLY_MS = 2000;    // re-apply cadence (attach prims on new panes etc.)
const REFRESH_MS = 60000;   // deals re-fetch cadence
const HIT_PX = 8;           // hover hit radius (segment 7 / endpoints 9)
const DWELL_MS = 250;       // anti fly-over: hover must rest briefly
const TTL_MS = 10000;       // ROUND100 (user): the highlight closes after 10s

/* net money of a close deal -> color tier (markers + connector lines share
   the exact same thresholds so a label and its line always agree) */
function netCol(d) {
  const net = (d.profit || 0) + (d.commission || 0) + (d.swap || 0);
  return net >= 0.005 ? '#089981' : (net <= -0.005 ? '#f23645' : '#787b86');
}

function netText(d) {
  const net = (d.profit || 0) + (d.commission || 0) + (d.swap || 0);
  return (net > 0 ? '+$' : (net < 0 ? '-$' : '$')) + Math.abs(net).toFixed(2);
}

/* ROUND102 ROOT FIX — the array LWC's LOGICAL frame really indexes.
   On Custom-Session panes the series carries whitespace gap rows between
   day regions and LWC counts them, so mapping a deal through the COMPACT
   pane.barTimes put every mark left of its true bar (and bunched them at
   the window edge once the offset exceeded the loaded range). This is the
   same axis the drawing engine uses (engine._timeArr) — one time axis for
   the whole app. */
function timeAxis(pane) {
  const hook = App.sessionHook;
  if (hook && hook.active && hook.active() && pane._sessWithGapTimes &&
      pane._sessGapIdx && pane._sessGapIdx.length === pane._sessWithGapTimes.length) {
    return pane._sessWithGapTimes;
  }
  /* ROUND128 belt+braces (the "marks on the wrong candle" report): the live
     tick path appends to pane.bars / the series; if barTimes ever lags
     behind (a stale rebuild between appends), derive the axis from pane.bars
     — for every style except renko the mapping is 1:1, so the newer array
     IS the series' true row times. barTimes stays the axis for renko. */
  if (Array.isArray(pane.bars) && Array.isArray(pane.barTimes) &&
      pane.style !== 'renko' && pane.bars.length > pane.barTimes.length) {
    return pane.bars.map((b) => b.time);
  }
  return pane.barTimes;
}

/* ---------- pure geometry: deal time -> bar index -------------------------
   `times` = the pane's bar-open times (seconds). The deal lands on the bar
   CONTAINING it (binary search). ROUND127 (user request): the on-chart
   marks must sit at the CENTER of that candle — the same left/right spot
   on EVERY timeframe — so the intra-bar fraction is no longer used for the
   x coordinate (the old `idx + frac` interpolation pushed the mark toward
   the bar's right edge and the offset changed with the timeframe, which is
   exactly the drift the user reported). `frac` is kept in the return for
   callers/tests that reason about containment. */
function timeSpec(times, t, tfSec) {
  if (!t || !times || !times.length) return null;
  if (t < times[0]) return null; /* older than the loaded window */
  let lo = 0, hi = times.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (idx < 0) return null;
  const step = tfSec > 0 ? tfSec : 60;
  let frac = (t - times[idx]) / step;
  if (!(frac >= 0)) frac = 0;
  if (frac > 0.999) frac = 0.999;
  return { idx, frac };
}

/* ---------- pure: deals -> entry/exit pairs (ROUND99 semantics) -----------
   group by position_id; every OUT/INOUT/OUT_BY pairs with the entry fills
   before it; the connector starts at the FIRST entry fill's time at the
   volume-weighted average open price (MT5 position-open semantics). */
function pairsOf(deals, symbol) {
  const groups = new Map();
  for (const d of deals) {
    if (d.symbol !== symbol || !d.position_id) continue;
    let g = groups.get(d.position_id);
    if (!g) { g = { ins: [], outs: [] }; groups.set(d.position_id, g); }
    if (d.entry === 0) g.ins.push(d); else g.outs.push(d);
  }
  const out = [];
  for (const g of groups.values()) {
    g.ins.sort((a, b) => a.time - b.time);
    for (const od of g.outs) {
      let vwap = 0, vol = 0, start = null, firstPrice = 0;
      for (const id of g.ins) {
        if (id.time > od.time) break;
        const v = id.volume > 0 ? id.volume : 0;
        vwap += (id.price || 0) * v; vol += v;
        if (start == null) { start = id.time; firstPrice = id.price || 0; }
      }
      if (start == null) continue; /* entry outside the loaded window */
      const aPrice = vol > 0 ? vwap / vol : firstPrice;
      const col = netCol(od);
      out.push({
        key: 'p' + g.ins[0].ticket + '-' + od.ticket,
        inDeal: g.ins[0], outDeal: od,
        a: { time: start, price: aPrice },
        b: { time: od.time, price: od.price },
        aCol: g.ins[0].type === 0 ? '#2962ff' : '#f23645', /* entry dot = side */
        bCol: col,                                         /* exit dot = net  */
        col,
      });
    }
  }
  out.sort((x, y) => x.a.time - y.a.time);
  return out;
}

/* ---------- pure: MT5 hover box first line (matches the terminal's box:
   "autotrade #102891493 -> #102897988, profit 21.30, XAUUSD") ------------- */
function tipLine(inDeal, outDeal, symbol) {
  const net = (outDeal.profit || 0) + (outDeal.commission || 0) + (outDeal.swap || 0);
  const c = (inDeal.comment || '').trim();
  return (c ? U.esc(c) + ' ' : '') + '#' + U.esc(inDeal.ticket) + ' -> #' + U.esc(outDeal.ticket) +
    ', profit ' + (net >= 0 ? '' : '-') + Math.abs(net).toFixed(2) + ', ' + U.esc(symbol);
}

const TradeHistory = {
  on: true,               // persisted flag (localStorage mt5_th_on, default ON)
  deals: [],              // account deal rows (all symbols, provider-shaped)
  _prim: new WeakMap(),   // pane -> attached primitive
  _scene: new WeakMap(),  // pane -> { ver, symbol, tf, scene } draw cache
  _hov: new WeakMap(),    // pane -> hover state { key, arm, ttl, cool }
  _tip: null,             // global fixed-position hover box (ROUND100)
  _fetchBusy: false,
  _refetch: false,        // a fetch was requested while one was in flight
  _openSig: '',           // live position ticket:volume signature (close watcher)
  _ver: 0,                // bumped on every deals change (cache invalidation)

  init() {
    try { this.on = localStorage.getItem(K_ON) !== '0'; } catch (e) { Log.debug('trade', 'history pref load failed', e) }
    this._openSig = '';
    /* a state-poll change (position opened/closed) usually means a new deal */
    Trade.onChange.push(() => {
      this._dirty = true;
      /* the moment a position appears, closes or is partially closed
         (ticket/volume signature changes) the deals table has changed —
         refetch IMMEDIATELY so the exit point + its connector show up
         right away instead of on the next 60s cadence.
         ROUND120: the signature follows the ACTIVE account (demo engine or
         the live wire) so demo partial closes repaint the chart too. */
      let sig = '';
      for (const p of TradeRoute.positions()) sig += p.ticket + ':' + p.volume + ';';
      if (sig !== this._openSig) { this._openSig = sig; this.refresh(); }
    });
    /* ROUND120: demo engine changes (place/close/activate/modify) ride the
       route passthrough — demo exits appear on the chart the moment they
       happen, same contract the live wire has always had */
    TradeRoute.onChange.push(() => { this._dirty = true; this.refresh(); });
    /* the setMarkers merge stays wired but yields [] — the primitive owns
       the drawing now (manager.setPaneData / session merge sites untouched) */
    Manager.tradeHistoryMarkers = (pane) => this.markersFor(pane);
    Manager.tradeHistoryApply = () => this.applyAll();
    Manager.tradeHistoryOn = () => this.on;
    Manager.tradeHistoryToggle = () => this.toggle();
    setInterval(() => this._cycle(), REAPPLY_MS);
    setInterval(() => this.refresh(), REFRESH_MS);
    /* ROUND100: one document-level hover driver for the whole layer */
    document.addEventListener('mousemove', this._onDocMove.bind(this), true);
    this.refresh();
  },

  toggle() {
    this.on = !this.on;
    try { localStorage.setItem(K_ON, this.on ? '1' : '0'); } catch (e) { Log.warn('trade', 'history pref save failed', e) }
    if (this._tip) this._tip.style.display = 'none'; /* no frozen hover box */
    this._dirty = true;
    this.applyAll();
  },

  /* ---------- data ---------- */
  refresh() {
    if (this._fetchBusy) { this._refetch = true; return; }
    if (!App.feed || !App.feed.connected) return;
    this._fetchBusy = true;
    /* from/to 0 -> the provider's default window (last 30 days).
       ROUND120 (user request): the layer reads the ACTIVE account — demo
       mode draws the demo engine's closed trades (synthesized deal rows),
       live mode the broker's — same funnel, same visuals. */
    return TradeRoute.history(0, 0).then((d) => {
      this.deals = Array.isArray(d && d.deals) ? d.deals : [];
      this._ver++;
      this._dirty = true;
      this.applyAll(); /* paint immediately, not on the next 2s cycle */
    }).catch(() => {}).finally(() => {
      this._fetchBusy = false;
      if (this._refetch) { this._refetch = false; this.refresh(); }
    });
  },

  /* ---------- markers (kept for the merge API; the primitive draws) ------ */
  markersFor(pane) {
    return []; /* ROUND100: the series primitive owns every history mark */
  },

  /* ---------- scene (per-pane draw payload, cached) ---------------------- */
  _sceneOf(pane) {
    const tf = (App.tfById && App.tfById[pane.tf] && App.tfById[pane.tf].sec) || 60;
    let st = this._scene.get(pane);
    if (st && st.ver === this._ver && st.symbol === pane.symbol && st.tf === tf &&
        st.on === this.on &&
        st.nBars === (timeAxis(pane) ? timeAxis(pane).length : 0)) return st.scene;
    const scene = { pairs: [], entries: [] };
    if (this.on && pane.symbol && !pane.replay && this.deals.length &&
        pane.barTimes && pane.barTimes.length) {
      scene.pairs = pairsOf(this.deals, pane.symbol);
      for (const d of this.deals) {
        if (d.symbol !== pane.symbol || d.entry !== 0) continue; /* IN deals */
        const buy = d.type === 0;
        scene.entries.push({
          t: d.time, price: d.price, buy, vol: d.volume,
          text: (buy ? 'B ' : 'S ') + d.volume,
        });
      }
    }
    this._scene.set(pane, { ver: this._ver, symbol: pane.symbol, tf, scene,
      on: this.on, nBars: timeAxis(pane) ? timeAxis(pane).length : 0 });
    return scene;
  },

  /* ---------- the series primitive (renders INSIDE the chart draw pass) --- */
  _ensurePrim(pane) {
    let p = this._prim.get(pane);
    if (p) return p;
    if (!pane || !pane.series || typeof pane.series.attachPrimitive !== 'function') return null;
    const self = this;
    const view = {
      renderer() {
        return { draw(target) { try { self._draw(pane, target); } catch (e) {} } };
      },
    };
    p = {
      _hl: null, /* hovered pair key (highlight) */
      _req: null,
      attached(param) { p._req = (param && param.requestUpdate) || null; },
      detached() { p._req = null; },
      paneViews() { return [view]; },
    };
    try {
      pane.series.attachPrimitive(p);
      this._prim.set(pane, p);
      return p;
    } catch (e) { return null; }
  },

  _invalidate(pane) {
    const p = this._prim.get(pane);
    if (p && p._req) { try { p._req(); } catch (e) {} }
  },

  /* x of a deal time — the CENTER of the candle that contains it.
     ROUND127 (user request): history marks must sit mid-candle (where the
     shadows are) on EVERY timeframe. In this LWC build logicalToCoordinate
     already resolves the bar's CENTER (the vendor math is
     `(idx + .5) * barSpacing`), so the old ROUND102 fractional shift
     (`+ barSpacing * frac`) is what pushed every mark right of center by
     an amount that grew with the timeframe — dropped entirely. The
     containing bar still comes from the gap-inclusive ROUND102 axis, so
     session panes stay aligned too. */
  _xOf(pane, ts, t) {
    const tf = (App.tfById && App.tfById[pane.tf] && App.tfById[pane.tf].sec) || 60;
    const s = timeSpec(timeAxis(pane), t, tf);
    if (!s) return null;
    let a = null;
    try { a = ts.logicalToCoordinate(s.idx); } catch (e) { a = null; }
    return (a != null && isFinite(a)) ? a : null;
  },

  _yOf(pane, price) {
    if (!(price > 0) || !pane.series || !pane.series.priceToCoordinate) return null;
    try { return pane.series.priceToCoordinate(price); } catch (e) { return null; }
  },

  /* the whole visual layer — one pass, media (CSS px) space */
  _draw(pane, target) {
    target.useMediaCoordinateSpace((scope) => {
      const ctx = scope.context;
      const W = scope.mediaSize.width, H = scope.mediaSize.height;
      /* ROUND101 FIX: a series primitive's 'normal' z-order layer is the
         SAME physical canvas the candlestick series itself paints on —
         calling clearRect(0,0,W,H) here wiped out the candles the series
         had just drawn for that frame (this is why turning Trade History
         ON blanked the whole chart and left only stray marker fragments:
         the chart's own top-level clear-per-frame is all that's needed;
         a primitive must never clear the shared canvas itself). */
      const scene = this._sceneOf(pane);
      if (!scene || (!scene.pairs.length && !scene.entries.length)) return;
      const ts = (() => { try { return pane.chart.timeScale(); } catch (e) { return null; } })();
      if (!ts) return;
      const hl = this._prim.get(pane) ? this._prim.get(pane)._hl : null;
      const dimA = hl != null ? 0.32 : 1.0; /* others dim while one is hovered */
      /* ROUND102: everything off-screen is skipped before it is drawn —
         a month of deals used to be fully rasterised on every frame */
      const PAD = 60;
      const onScreen = (x) => x != null && x > -PAD && x < W + PAD;
      let barSp = 0;
      try { barSp = ts.options().barSpacing; } catch (e) { barSp = 0; }

      /* ---- pass 1: dashed connectors ---- */
      ctx.save();
      ctx.lineCap = 'round';
      for (const pr of scene.pairs) {
        const x1 = this._xOf(pane, ts, pr.a.time), y1 = this._yOf(pane, pr.a.price);
        const x2 = this._xOf(pane, ts, pr.b.time), y2 = this._yOf(pane, pr.b.price);
        if (x1 == null || x2 == null || y1 == null || y2 == null) { pr._p = null; continue; }
        if (!onScreen(x1) && !onScreen(x2) && !((x1 < 0) !== (x2 < 0))) { pr._p = null; continue; }
        pr._p = { x1, y1, x2, y2 }; /* screen cache for the hover hit-test */
        const on = hl != null && hl === pr.key;
        ctx.globalAlpha = on ? 1 : dimA;
        ctx.strokeStyle = pr.col;
        ctx.lineWidth = on ? 2.5 : 1.2;
        ctx.setLineDash(on ? [] : [5, 4]);
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      ctx.setLineDash([]);
      /* ---- pass 2: exact deal-point dots at BOTH endpoints ---- */
      for (const pr of scene.pairs) {
        const P = pr._p; if (!P) continue;
        const on = hl != null && hl === pr.key;
        ctx.globalAlpha = on ? 1 : dimA;
        for (const pt of [[P.x1, P.y1, pr.aCol], [P.x2, P.y2, pr.bCol]]) {
          const r = on ? 4.6 : 3.2;
          ctx.fillStyle = pt[2];
          ctx.beginPath(); ctx.arc(pt[0], pt[1], r, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,.65)';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(pt[0], pt[1], r, 0, Math.PI * 2); ctx.stroke();
        }
      }
      /* ---- pass 3: entry arrows + labels ---- */
      ctx.globalAlpha = 1;
      ctx.font = '600 10px -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
      /* ROUND102 declutter: at tight zoom the "B 0.10" labels of adjacent
         fills overprint into an unreadable smear (MetaTrader drops them the
         same way). Labels need room AND a minimum bar spacing; the arrows
         themselves always stay. */
      const labelRows = [];
      const labelsAllowed = barSp >= 5;
      for (const en of scene.entries) {
        const x = this._xOf(pane, ts, en.t), y = this._yOf(pane, en.price);
        if (x == null || y == null || !onScreen(x)) continue;
        const col = en.buy ? '#2962ff' : '#f23645';
        const up = en.buy; /* buy arrow points up, sell arrow points down */
        const r = 5;
        ctx.fillStyle = col;
        ctx.strokeStyle = 'rgba(255,255,255,.75)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (up) { ctx.moveTo(x, y - r); ctx.lineTo(x - r * 0.9, y + r * 0.7); ctx.lineTo(x + r * 0.9, y + r * 0.7); }
        else { ctx.moveTo(x, y + r); ctx.lineTo(x - r * 0.9, y - r * 0.7); ctx.lineTo(x + r * 0.9, y - r * 0.7); }
        ctx.closePath(); ctx.fill(); ctx.stroke();
        if (!labelsAllowed) continue;
        const ty = up ? y + r + 11 : y - r - 4;
        ctx.textAlign = 'left';
        const tw = ctx.measureText(en.text).width;
        const tx = (x + 8 + tw > W - 4) ? x - 8 - tw : x + 8;
        const lyy = up ? ty : ty + 3;
        let clash = false;
        for (const q of labelRows) {
          if (Math.abs(q.y - lyy) < 11 && tx < q.x2 + 4 && tx + tw > q.x1 - 4) { clash = true; break; }
        }
        if (clash) continue;
        labelRows.push({ x1: tx, x2: tx + tw, y: lyy });
        ctx.fillStyle = col;
        ctx.fillText(en.text, tx, lyy);
      }
      for (const pr of scene.pairs) {
        const P = pr._p; if (!P || !onScreen(P.x2)) continue;
        const on = hl != null && hl === pr.key;
        ctx.globalAlpha = on ? 1 : dimA;
        const x = P.x2, y = P.y2;
        ctx.strokeStyle = pr.bCol;
        ctx.fillStyle = 'rgba(0,0,0,.25)';
        ctx.lineWidth = on ? 2.4 : 1.8;
        ctx.beginPath(); ctx.arc(x, y, on ? 5.4 : 4.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        /* ROUND101 (user request): the $ profit/loss no longer prints
           permanently next to every closed trade — MT5 shows it only in
           the hover box (see _showTip below), which already includes it.
           A ring at the exact exit point is all that stays on the chart. */
      }
      ctx.restore();
    });
  },

  /* ---------- ROUND100 hover: highlight + MT5 info box (10s) ------------- */
  /* the EXACT same origin the primitive draws in: the LWC chart element
     (.tv-lightweight-charts). Measuring against anything else (wrapper,
     host) shifts the hit-test and the hover dies silently. */
  _rect(pane) {
    let el = pane._lwcEl;
    if (!el || !el.isConnected) {
      el = null;
      try {
        el = pane.mainWrap ? pane.mainWrap.querySelector(':scope > .tv-lightweight-charts') : null;
      } catch (e) { el = null; }
      if (!el) el = pane.mainWrap;
      pane._lwcEl = el;
    }
    return el.getBoundingClientRect();
  },

  _tipEl() {
    if (this._tip) return this._tip;
    const el = document.createElement('div');
    el.className = 'th-hist-tip';
    el.style.display = 'none';
    document.body.appendChild(el);
    this._tip = el;
    return el;
  },

  _onDocMove(e) {
    if (e.buttons) return; /* panning / dragging — hover stays frozen */
    for (const pane of App.panes) {
      const prim = this._prim.get(pane);
      if (!prim) continue;
      const st = this._hov.get(pane);
      const inside = pane.root && pane.root.contains(e.target);
      if (!inside) {
        if (st && (st.arm || st.key != null || st.cool)) {
          this._hoverOff(pane, st, prim);
          st.cool = null; /* leaving the pane fully re-arms the hover */
        }
        continue;
      }
      this._hoverScan(e, pane, prim);
    }
  },

  /* distance from point to the pair's segment + endpoints (screen px) */
  _pairDist(pr, px, py) {
    const P = pr._p; if (!P) return Infinity;
    const d1 = Math.hypot(px - P.x1, py - P.y1);
    const d2 = Math.hypot(px - P.x2, py - P.y2);
    let dseg = Infinity;
    const vx = P.x2 - P.x1, vy = P.y2 - P.y1;
    const len2 = vx * vx + vy * vy;
    if (len2 > 0) {
      let u = ((px - P.x1) * vx + (py - P.y1) * vy) / len2;
      u = Math.max(0, Math.min(1, u));
      dseg = Math.hypot(px - (P.x1 + u * vx), py - (P.y1 + u * vy));
    }
    return Math.min(d1 - 1.5, d2 - 1.5, dseg); /* endpoints weigh a bit more */
  },

  _hoverScan(e, pane, prim) {
    const st = this._hov.get(pane) || { key: null, arm: 0, ttl: 0, cool: null };
    this._hov.set(pane, st);
    /* screen-space hit-test against each pair's cached segment */
    const rect = pane.mainWrap ? this._rect(pane) : null;
    if (!rect) return;
    const scene = this._sceneOf(pane);
    let best = null;
    if (rect.width && scene.pairs.length) {
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      for (const pr of scene.pairs) {
        const d = this._pairDist(pr, px, py);
        if (d <= HIT_PX && (!best || d < best.d)) best = { pr, d };
      }
    }
    if (!best) {
      /* only a PENDING arm cancels on leave; a VISIBLE box lives its 10s.
         Leaving the line also clears the post-TTL cooldown, so hovering
         the same trade again re-opens the box (user spec). */
      if (st.arm && !st.key) { clearTimeout(st.arm); st.arm = 0; }
      return;
    }
    const key = best.pr.key;
    if (st.key === key) return;               /* already showing this pair */
    if (st.arm) clearTimeout(st.arm);
    st.arm = setTimeout(() => {
      st.arm = 0;
      if (st.key) clearTimeout(st.ttl);       /* switching pairs: restart TTL */
      st.key = key;
      st.cool = null;
      prim._hl = key;
      this._invalidate(pane);
      this._showTip(pane, best.pr, e);
      st.ttl = setTimeout(() => {             /* closes after 10s (user spec) */
        this._hoverOff(pane, st, prim);
      }, TTL_MS);
    }, DWELL_MS);
  },

  _showTip(pane, pr, e) {
    const tip = this._tipEl();
    const dg = (Trade.specSync(pane.symbol) || {}).digits || 5;
    let cursorPrice = null;
    const rect = pane.mainWrap ? this._rect(pane) : null;
    if (rect && pane.series && pane.series.coordinateToPrice) {
      try { cursorPrice = pane.series.coordinateToPrice(e.clientY - rect.top); } catch (er) {}
    }
    const fmtT = (t) => {
      /* ROUND120 (user request): hover times follow the app's timezone —
         the deal epochs are broker wall stamps (the chart time base) */
      const p = TZ.partsNum(App.tz, t);
      return p.hour + ':' + p.minute + ':' + p.second;
    };
    const od = pr.outDeal, idl = pr.inDeal;
    let html = '<div class="tht-row"><b>' + tipLine(idl, od, pane.symbol) + '</b></div>';
    if (cursorPrice != null && isFinite(cursorPrice)) {
      html += '<div class="tht-row">' + Number(cursorPrice).toFixed(dg) + '</div>';
    }
    html += '<div class="tht-row tht-dim">' + U.esc(od.volume) + ' &middot; ' +
      fmtT(idl.time) + ' &rarr; ' + fmtT(od.time) + '</div>';
    tip.innerHTML = html;
    /* ROUND107 ROOT FIX: '' only clears the inline display — the class rule
       `.th-hist-tip { display:none }` kept the computed value at none and
       the closed-trade hover box never rendered (same trap as the SL/TP
       hover tag, fixed in overlay.js this round). 'block' BEATS the class. */
    tip.style.display = 'block';
    const w = tip.offsetWidth || 180, h = tip.offsetHeight || 60;
    let x = e.clientX + 16, y = e.clientY + 14;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - 12;
    if (y + h > window.innerHeight - 8) y = e.clientY - h - 12;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  },

  _hoverOff(pane, st, prim) {
    if (st.arm) { clearTimeout(st.arm); st.arm = 0; }
    if (st.ttl) { clearTimeout(st.ttl); st.ttl = 0; }
    st.key = null;
    if (prim && prim._hl != null) { prim._hl = null; this._invalidate(pane); }
    if (this._tip) this._tip.style.display = 'none';
  },

  /* ---------- application ---------- */
  applyPane(pane) {
    if (!this.on || !pane || pane.replay || !pane.symbol) {
      const p = this._prim.get(pane);
      if (p) {
        try { pane.series.detachPrimitive(p); } catch (e) {}
        this._prim.delete(pane);
        if (this._tip) this._tip.style.display = 'none';
      }
      return;
    }
    this._ensurePrim(pane);
    this._invalidate(pane); /* deals may have changed -> repaint if attached */
  },

  applyAll() {
    for (const pane of App.panes) {
      try { this.applyPane(pane); } catch (e) { Log.debug('trade', 'history overlay apply failed', e) }
    }
  },

  _cycle() {
    if (!this._dirty) return;
    this._dirty = false;
    this.applyAll();
  },
};

export { TradeHistory };
