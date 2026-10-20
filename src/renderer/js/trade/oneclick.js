/**
 * ROUND108→111 — the chart-side trading panel (the MT5 one-click widget,
 * evolved into the full "Trade" panel the user designed):
 *
 * HISTORY
 *   108  classic MT5 widget (SELL at Bid | lots | BUY at Ask) under the legend
 *   109  v2 redesign: slim row, hover chrome, drag-anywhere, position pin
 *   110  the volume cell became a real editable field (+ preset menu)
 *   111  THIS ROUND — the user's money-management panel (the mock-up):
 *        "میخوام یک بخش مدیریت سرمایه به همین بخشی که الان اصلاحش کردی اضافه کنم"
 *
 * THE v3 PANEL (per the user's picture, top to bottom)
 *   ┌──────────────────────────────────────────┐
 *   │ Trade            EURUSD   1.08345/1.08360│  ← title row (live bid/ask)
 *   │ Risk  [−] [ 0.01 ] [+]        [%] [$] [Lot]│  ← risk value + 3 modes
 *   │ [ Buy ]  [ Sell ]                [ Set › ]│
 *   │ [Pend. Buy] [Pend. Sell]         [Cancel] │
 *   │  Vol 0.37 · SL -$100.00 · TP +$200.00    │  ← live status strip (armed)
 *   │ Open Positions                [%] [$]  ∨  │  ← collapsible section
 *   │  XAUUSD B 0.37   +$12.34 +0.52%  ½ 🛡 ×  │  ← per-position actions
 *   └──────────────────────────────────────────┘
 *
 * RISK (three modes, MT5 money management):
 *   · Lot  — the volume is typed directly ("0.05 lots"). The Risk number IS
 *            the volume (the round-110 editable volume entry lives here).
 *   · $    — a fixed dollar risk ("risk $100"): the app sizes the volume from
 *            the SL distance via the MT5 formula (lotForRisk).
 *   · %    — a percent of the account ("risk 1%"): money = pct/100 × equity,
 *            then the volume sizes itself from the SL distance so that hitting
 *            the user's stop loses exactly that percent.
 *   The number is typed (Enter/blur commits, Esc reverts, ↑/↓ steps) or
 *   nudged with the −/+ steppers; step = vol_step (Lot), $1 ($), 0.1% (%).
 *   Everything persists per mode and syncs across every pane.
 *
 * DRAFT ORDER FLOW (nothing is sent until Set):
 *   · Buy / Sell  → arm a MARKET draft: three dashed lines appear on the
 *     chart — the entry LOCKED to the live market price (ask for BUY, bid for
 *     SELL, it follows every tick), a draggable red SL line and a draggable
 *     green TP line. Both stop lines carry a LIVE on-chart tag: the dollar
 *     amount the level locks (computed for the risk-resolved volume) and its
 *     points distance from the entry — recalculated with the market.
 *   · Pend. Buy / Pend. Sell → the same three lines, but the entry line is
 *     draggable too (the order price is the user's). The order kind follows
 *     the drop side automatically: beyond the market → BUY/SELL STOP,
 *     behind it → BUY/SELL LIMIT (broker stops_level respected).
 *   · Set → opens the order for real (market or pending) with the draft's
 *     volume + SL + TP. ROUND113 (user request): the confirm step is GONE —
 *     the first click on Set sends the order AT ONCE ("همینکه کاربر گزینهٔ
 *     Set رو میزنه معامله باید گرفته بشه"); the padlock chrome button was
 *     removed with it (its only job was arming CONFIRM SET).
 *   · Cancel → removes the three lines and forgets the draft (Esc does the
 *     same on every pane). A rejected order KEEPS the draft for adjustment.
 *   · Dragging a draft line clamps to the legal zone: SL stays on the loss
 *     side, TP on the profit side, both outside the broker's stops_level;
 *     a pending entry is pushed out of the dead zone around the market.
 *
 * OPEN POSITIONS (the bottom section, collapsible):
 *   every position the user set, one row each: symbol · side badge · volume ·
 *   the live P/L in the ONE unit the user picked with the %/$ header buttons
 *   (ROUND113 — exclusive: % shows only the percent, $ only the dollars) ·
 *   and three actions per row: close half (½), RISK-FREE (shield —
 *   the SL jumps to the entry price, break-even) and close (×).
 *   ROUND113: a Total row under the list carries the NET P/L of everything
 *   open, in the same single unit.
 *
 * KEPT FROM v2 (the user approved these): hover chrome (grip · pin ·
 * minimize — the confirm-lock padlock retired with ROUND113), drag-anywhere with persisted fractions shared by
 * every pane, the minimized bolt pill, the floating spread chip, one panel
 * per pane (WeakMap) that follows symbol changes, theme tokens everywhere.
 *
 * ROUND124 (user report): the panel now ALSO boots in DETACHED (undocked)
 * windows — app.js solo branch — under the SAME per-symbol rule: within a
 * window only the FIRST pane holding a symbol shows the panel/pill
 * (_designated), so same-symbol tabs share one panel and a different
 * symbol always gets its own; across windows each window shows the panels
 * of ITS OWN charts. The shared demo ledger stays consistent through the
 * merging saveAcct (trade/replaytrade.js).
 *
 * ROUND112 — THREE TRADING MODES (the merged Trading tab's Demo/Live
 * switch, trade/route.js): the panel now routes through the TradeRoute
 * facade, so the SAME panel works on
 *   1. the LIVE broker account (orders → MetaTrader via the bridge),
 *   2. the DEMO account on the LIVE MARKET (orders → the demo broker,
 *      prices = the live tick stream),
 *   3. the DEMO account on BAR REPLAY (orders → the demo broker, prices
 *      = the replay chart — backtest).
 * The title row carries a LIVE/DEMO badge; the Open Positions section lists
 * the ACTIVE account's positions; guards (bridge offline / AutoTrading /
 * no quote / closed market) come from TradeRoute.canTrade().
 *
 * ROUND113 — THE USER'S FOUR PANEL FIXES:
 *   1. Set sends AT ONCE — the "CONFIRM SET" arm step and its padlock
 *      chrome button are gone (first click = the order is out).
 *   2. The % / $ header buttons are EXCLUSIVE — a row shows ONLY the
 *      selected unit (percent OR dollars), never both stacked.
 *   3. A Total row under the Open Positions list carries the net P/L of
 *      every open position, in the same single unit.
 *
 * VISIBILITY NOTE (round-107 lesson): every show/hide toggles the .oc-hidden
 * class — NEVER an inline display:''.
 *
 * @module trade/oneclick
 */
import { App } from '../../../core/state.js';
import { U } from '../core/util.js';
import { UI } from '../drawing/ui.js';
import { icon } from '../ui/icons.js';
import { Trade, OT, OT_NAME } from './state.js';
import { TradeRoute } from './route.js';
import { Log } from '../../../core/logger.js';

const K = {
  min: 'mt5_oct_min',        // minimized (global, persisted)
  vol: 'mt5_oct_vol',        // legacy lot (round108/110) — still seeds the Risk lot value
  dev: 'mt5_tr_dev',         // deviation — shared with the ticket's setting
  pos: 'mt5_oct_pos',        // legacy position {fx, fy} (fractions of the pane) — kept as the
                             // migration fallback for symbols without their own entry
  posMap: 'mt5_oct_pos_map', // ROUND120 per-SYMBOL positions { [symbol]: {fx, fy} }
  pin: 'mt5_oct_pin',        // ROUND109 position pin (true = dragging blocked)
  rmode: 'mt5_oct_risk_mode',  // ROUND111 risk mode: 'lot' | 'money' | 'pct'
  rval: 'mt5_oct_risk_val',    // ROUND111 risk values JSON {lot, money, pct}
  plunit: 'mt5_oct_pl_unit',   // ROUND113 positions P/L unit ('pct'|'usd') — ONLY this one shows
  collapsed: 'mt5_oct_pos_collapsed', // ROUND111 Open Positions section collapsed
};

const SYNC_MS = 900;       // structural sync (new panes, symbol changes)
const TICK_MS = 200;       // live bid/ask/spread/draft refresh
const DRAG_TPX = 4;        // px of travel before a press counts as a widget drag
const HIT_PX = 9;          // drag/hover hit radius around a draft line

/* draft line colours — the overlay's own trade palette (entry/SL/TP) */
const C = { entry: '#2962ff', sl: '#f23645', tp: '#089981' };

function _bool(v, def) {
  if (v === true || v === 'true' || v === '1') return true;
  if (v === false || v === 'false' || v === '0') return false;
  return !!def;
}

/* ---------- ROUND109 pure placement math (kept verbatim) ---------- */

/* pixels → fractions of the free span (0..1), guarded against degenerate panes */
function _frac(x, y, pw, ph, w, h) {
  const spanX = Math.max(1, pw - w);
  const spanY = Math.max(1, ph - h);
  return {
    fx: Math.min(1, Math.max(0, x / spanX)),
    fy: Math.min(1, Math.max(0, y / spanY)),
  };
}

/* fractions → clamped pixels. The panel keeps a 10px top floor so the
   floating spread chip never pokes out of the pane; the pill floors at 2. */
function _placeXY(fx, fy, pw, ph, w, h, kind) {
  const minX = 2;
  const minY = kind === 'panel' ? 10 : 2;
  const maxX = Math.max(minX, pw - w - 2);
  const maxY = Math.max(minY, ph - h - 2);
  return {
    x: Math.round(Math.min(Math.max(minX, fx * (pw - w)), maxX)),
    y: Math.round(Math.min(Math.max(minY, fy * (ph - h)), maxY)),
  };
}

/* persisted position loader — anything corrupt/out-of-range falls back to null
   (the round-108 auto anchor below the legend) instead of wedging the widget */
function _posLoad(get) {
  let o = null;
  try { o = JSON.parse(get('null')); } catch (e) { return null; }
  if (!o || typeof o !== 'object') return null;
  const fx = +o.fx, fy = +o.fy;
  if (!isFinite(fx) || !isFinite(fy)) return null;
  return { fx: Math.min(1, Math.max(0, fx)), fy: Math.min(1, Math.max(0, fy)) };
}

/* ---------- round-110 helpers (kept: the Risk field is the volume entry) ---------- */

/* ROUND110 — manual number parser: "0.37" / "0,37" / " .5 " / "2." all parse;
   anything else ("abc", "1.2.3", "1e3", "-1", "", "0") returns null and the
   draft silently reverts. Serves the Risk field in every mode. */
function _volParse(txt) {
  if (typeof txt !== 'string') return null;
  const t = txt.trim().replace(',', '.');
  if (!/^\d*\.?\d*$/.test(t) || !/\d/.test(t)) return null;
  const v = Math.round(parseFloat(t) * 1000) / 1000;   // kill float noise, cap at 3 dp
  if (!isFinite(v) || v <= 0) return null;
  return v;
}

/* format a lot the way the spec's step wants (0.001-step brokers get 3 dp) */
function _volTxt(v, s) {
  const dp = (s && s.vol_step > 0 && s.vol_step < 0.01) ? 3 : 2;
  return Number(v).toFixed(dp);
}

/* price text for a side — spec digits, falling back to the pane's own */
function _fmtPx(symbol, px, pane) {
  if (!(px > 0)) return '—';
  const s = Trade.specSync(symbol);
  const dg = (s && s.digits != null) ? s.digits : ((pane && pane.digits) || 5);
  try { return px.toFixed(dg); } catch (e) { return '—'; }
}

/* default anchor top: below the REAL legend, clamped inside small panes */
function _placeTop(pane) {
  let lh = 60;
  try { lh = (pane.legend && pane.legend.offsetHeight) || 60; } catch (e) {}
  const rh = (pane.root && pane.root.clientHeight) || 400;
  return Math.max(4, Math.round(Math.min(lh + 10, Math.max(40, rh - 130))));
}

/* deviation shared with the order ticket */
function _deviation() {
  return parseInt(U.lsGet(K.dev, '20'), 10) || 20;
}

/* ---------- ROUND111 pure money-management math (mirrored by the tests) ---------- */

/* signed money text — "+$12.34" / "-$12.34" / "$0.00" (the overlay's format) */
function fmtMoney(v) {
  if (v == null || !isFinite(v)) return '—';
  const r = Math.round(v * 100) / 100;
  return (r > 0 ? '+$' : (r < 0 ? '-$' : '$')) + Math.abs(r).toFixed(2);
}

/* signed percent text — "+0.52%" (the positions rows) */
function fmtPct(v) {
  if (v == null || !isFinite(v)) return '—';
  const r = Math.round(v * 100) / 100;
  return (r > 0 ? '+' : (r < 0 ? '-' : '')) + Math.abs(r).toFixed(2) + '%';
}

/* spec-aware volume clamp (mirror of Trade.clampVolume, kept pure for tests) */
function _clampVolSpec(spec, v) {
  if (v < (spec.vol_min || 0.01)) v = spec.vol_min || 0.01;
  if (v > (spec.vol_max || 100)) v = spec.vol_max || 100;
  const st = spec.vol_step > 0 ? spec.vol_step : 0.01;
  return Math.round(Math.round(v / st) * st * 1e8) / 1e8;
}

/* the Risk stepper unit per mode: Lot → the symbol's own vol_step,
   $ → 1 dollar, % → 0.1 percent */
function _riskStepFor(mode, spec) {
  if (mode === 'lot') return (spec && spec.vol_step > 0) ? spec.vol_step : 0.01;
  if (mode === 'money') return 1;
  return 0.1;
}

/* THE RISK RESOLVER — turns (mode, risk value, SL distance) into the order
 * volume + the money that the SL actually risks:
 *   lot   → the value IS the volume (clamped to the spec); money = what the
 *           SL distance costs for that volume.
 *   money → volume = $risk / per-lot cost of the SL distance (MT5 formula),
 *           clamped to the symbol's vol_min/step; the money is recomputed
 *           for the clamped volume (never faked).
 *   pct   → the $ target is pct/100 × equity, then the money path runs.
 * Returns { vol, risk }; vol = 0 means "cannot size yet" (no spec, no SL,
 * or the risk is smaller than one lot step). */
function _resolveVol(spec, mode, val, slDist, equity) {
  const out = { vol: 0, risk: 0 };
  if (!spec || !(spec.tick_value > 0) || !(spec.tick_size > 0)) return out;
  if (mode === 'lot') {
    if (!(val > 0)) return out;
    out.vol = _clampVolSpec(spec, val);
    out.risk = slDist > 0 ? (slDist / spec.tick_size) * spec.tick_value * out.vol : 0;
    return out;
  }
  if (!(slDist > 0) || !(val > 0)) return out;
  const target = mode === 'money' ? val : (equity > 0 ? (val / 100) * equity : 0);
  if (!(target > 0)) return out;
  const perLot = (slDist / spec.tick_size) * spec.tick_value;
  if (!(perLot > 0)) return out;
  out.vol = _clampVolSpec(spec, target / perLot);
  out.risk = perLot * out.vol;
  return out;
}

/* the pending order kind an entry price becomes, given the live market:
 * BUY  → px beyond ask+stops = BUY_STOP, behind ask−stops = BUY_LIMIT
 * SELL → px beyond bid−stops = SELL_STOP, behind bid+stops = SELL_LIMIT
 * inside the dead zone (or without quotes) → null (Set refuses, the draft
 * stays so the user can move the line). */
function _pendType(side, px, bid, ask, stopsPts, point) {
  if (!(px > 0) || !(bid > 0) || !(ask > 0)) return null;
  const min = (stopsPts > 0 ? stopsPts : 0) * (point > 0 ? point : 0);
  if (side === 0) {
    if (px > ask && px >= ask + min) return OT.BUY_STOP;
    if (px < ask && px <= ask - min) return OT.BUY_LIMIT;
    return null;
  }
  if (px < bid && px <= bid - min) return OT.SELL_STOP;
  if (px > bid && px >= bid + min) return OT.SELL_LIMIT;
  return null;
}

/* clamp a dragged draft level to its legal zone (digits-rounded):
 *   sl        → stays on the LOSS side of the anchor, outside stops_level
 *   tp        → stays on the PROFIT side of the anchor, outside stops_level
 *   e (entry) → pending only: pushed out of the dead zone around the LIVE
 *               market (either side — stop/limit is decided at Set time)
 * anchor = the live close-out price (bid for BUY / ask for SELL) for market
 * drafts, the entry (fill) price for pending drafts. */
function _clampLevel(kind, side, pend, px, ref, spec) {
  const dg = (spec && spec.digits != null) ? spec.digits : 5;
  const point = (spec && spec.point > 0) ? spec.point : Math.pow(10, -dg);
  const stops = ((spec && spec.stops_level > 0) ? spec.stops_level : 0) * point;
  const gap = Math.max(stops, point);
  let p = Number(px.toFixed(dg));
  if (kind === 'e') {
    const mkt = side === 0 ? ref.ask : ref.bid;
    if (mkt > 0 && stops > 0 && Math.abs(p - mkt) < stops) {
      p = p >= mkt ? mkt + stops : mkt - stops;
    }
  } else {
    const anchor = pend ? ref.entry : (side === 0 ? ref.bid : ref.ask);
    if (kind === 'sl') {
      if (side === 0 && anchor > 0 && p > anchor - gap) p = anchor - gap;
      if (side === 1 && anchor > 0 && p < anchor + gap) p = anchor + gap;
    } else if (kind === 'tp') {
      if (side === 0 && anchor > 0 && p < anchor + gap) p = anchor + gap;
      if (side === 1 && anchor > 0 && p > anchor - gap) p = anchor - gap;
    }
  }
  return Number(p.toFixed(dg));
}

/* the three default draft levels right after arming: the entry at the live
 * market (ask for BUY / bid for SELL), the SL ~10% of the visible price span
 * below/above it and the TP ~20% (a 1:2 shape), both clamped outside the
 * broker's minimum stop distance. span = 0 (unmeasurable) → 150/300 points. */
function _draftDefaults(side, bid, ask, span, spec) {
  const dg = (spec && spec.digits != null) ? spec.digits : 5;
  const point = (spec && spec.point > 0) ? spec.point : Math.pow(10, -dg);
  const stops = ((spec && spec.stops_level > 0) ? spec.stops_level : 0) * point;
  const minD = Math.max(stops * 2, 10 * point);
  let slD = span > 0 ? span * 0.10 : 150 * point;
  let tpD = span > 0 ? span * 0.20 : 300 * point;
  slD = Math.max(slD, minD);
  tpD = Math.max(tpD, minD);
  const entry = side === 0 ? ask : bid;
  return side === 0
    ? { entry, sl: Number((entry - slD).toFixed(dg)), tp: Number((entry + tpD).toFixed(dg)) }
    : { entry, sl: Number((entry + slD).toFixed(dg)), tp: Number((entry - tpD).toFixed(dg)) };
}

/* points text for a price distance — "150 points" (trimmed like the overlay) */
function _ptsTxt(dist, spec) {
  const point = (spec && spec.point > 0) ? spec.point : 0;
  if (!(point > 0) || !(dist > 0)) return '';
  const pts = dist / point;
  const v = Math.abs(pts - Math.round(pts)) < 0.05 ? String(Math.round(pts)) : pts.toFixed(1);
  return v + ' points';
}

const OneClick = {
  _map: new WeakMap(),   // pane -> widget state
  _timer: null,
  _tickTimer: null,
  _min: false,
  _pin: false,           // ROUND109: position pin (dragging blocked while set)
  _pos: null,            // legacy position {fx, fy} — migration fallback for every symbol
  _posBySym: {},         // ROUND120: per-symbol positions { [symbol]: {fx, fy}|null }
  _drag: null,           // ROUND109: active widget drag session
  _rmode: 'lot',         // ROUND111: 'lot' | 'money' | 'pct'
  _rvals: { lot: 0.01, money: 100, pct: 1 },  // ROUND111: the three risk values
  _plunit: 'pct',        // ROUND111: positions P/L leading unit
  _collapsed: false,     // ROUND111: Open Positions section collapsed

  init() {
    if (this._timer) return;
    this._min = _bool(U.lsGet(K.min, false), false);
    this._pin = _bool(U.lsGet(K.pin, false), false);
    this._pos = _posLoad((d) => U.lsGet(K.pos, d));
    /* ROUND120: load the per-symbol position map (legacy key migrates as
       the fallback — an existing user keeps their position on every symbol
       until they drag that symbol's panel somewhere else) */
    let m = null;
    try { m = JSON.parse(U.lsGet(K.posMap, '{}')); } catch (e) { m = null; }
    this._posBySym = (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
    this._loadRisk();
    this._plunit = U.lsGet(K.plunit, 'pct') === 'usd' ? 'usd' : 'pct';
    this._collapsed = _bool(U.lsGet(K.collapsed, false), false);
    this.sync();
    this._timer = setInterval(() => this.sync(), SYNC_MS);
    this._tickTimer = setInterval(() => this._tick(), TICK_MS);
    /* drag sessions live on the document — capture, like trade/overlay */
    document.addEventListener('mousemove', (e) => this._dragMove(e), true);
    document.addEventListener('mouseup', (e) => this._dragUp(e), true);
    /* draft-line drags ride the same document capture pattern */
    document.addEventListener('mousemove', (e) => this._lineMove(e), true);
    document.addEventListener('mouseup', (e) => this._lineUp(e), true);
    /* Esc cancels every draft on every pane (the Set confirm is gone) */
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (U.isTyping(e.target)) return;      // the Risk field reverts itself
        this._draftCancelAll();
      }
    }, true);
    /* ROUND112: the Demo/Live switch (merged Trading tab / replay) repaints
       the badge, drops the stale draft and swaps the positions list */
    TradeRoute.onChange.push(() => { try { this._onRouteChange(); } catch (e) {} });
    /* a press anywhere outside the panel's own rows is the chart's business */
  },

  /* ---------- structural sync: one widget per pane ---------- */
  sync() {
    for (const pane of App.panes) {
      try { if (!this._map.get(pane)) this._build(pane); } catch (e) {}
    }
    /* panes that left the layout die with their DOM subtree; the WeakMap
       entry follows — nothing to clean up by hand */
  },

  _st(pane) { return this._map.get(pane) || null; },

  /* ---------- ROUND120: ONE panel per SYMBOL in multi-chart ----------
     The widget is still built per pane, but only the FIRST pane holding a
     symbol (App.panes order = layout order) shows the panel/pill. Two
     charts of gold → one Trade panel; gold + euro → one panel each.
     Single-chart layouts are always designated, so the panel is always
     there; switching layouts never destroys anything — the per-pane widget
     rebuilds (sync) and the per-symbol position map re-anchors it. */
  _designated(pane) {
    const sym = pane && pane.symbol;
    if (!sym) return false;
    const first = App.panes.find((p) => p.symbol === sym);
    return first === pane;
  },

  /* paint the designation-gated visibility of a pane's panel + pill.
     visible panel = designated && !min;  visible pill = designated && min. */
  _visPaint(st) {
    const desig = this._designated(st.pane);
    if (st.desig !== desig) {
      st.desig = desig;
      st.lastKey = null;                 /* the freshly visible half re-anchors */
      if (!desig && st.draft) { try { this._draftCancel(st); } catch (e) {} }
    }
    const panelOn = desig && !this._min;
    const pillOn = desig && this._min;
    st.panel.classList.toggle('oc-hidden', !panelOn);
    st.pill.classList.toggle('oc-hidden', !pillOn);
  },

  /* ---------- build (v3: the full Trade panel) ---------- */
  _build(pane) {
    const panel = U.el('div', 'oc-panel' + (this._min ? ' oc-hidden' : ''), pane.root);

    /* hover chrome — grip chip (left) · tools chip (right), floating on the
       top border. pointer-events only on the chips (the strip itself is
       click-through). KEPT from v2 verbatim (the user approved it). */
    const chrome = U.el('div', 'oc-chrome', panel);
    const grip = U.el('span', 'oc-grip', chrome);
    grip.innerHTML = icon('gripdot');
    grip.title = this._pin ? 'Pinned — click the pin to move again' : 'Drag to move the widget';
    const tools = U.el('span', 'oc-tools', chrome);
    const pinBtn = U.el('button', 'oc-cbtn oc-pinb' + (this._pin ? ' oc-on' : ''), tools);
    const minBtn = U.el('button', 'oc-cbtn oc-minb', tools);

    /* floating spread chip — overlaps the top border, costs no height */
    const spread = U.el('span', 'oc-spread oc-hidden', panel);

    /* title row — "Trade" + mode badge + symbol + the live bid/ask */
    const title = U.el('div', 'oc-title', panel);
    U.el('b', '', title).textContent = 'Trade';
    const modeBadge = U.el('span', 'oc-mbadge', title);
    const titleSym = U.el('span', 'oc-tsym', title);
    const titlePx = U.el('span', 'oc-tpx', title);

    /* risk row — label + [−] value [+] + the three mode buttons (% $ Lot) */
    const risk = U.el('div', 'oc-risk', panel);
    U.el('span', 'oc-rlbl', risk).textContent = 'Risk';
    const stepBox = U.el('div', 'oc-step', risk);
    const minusBtn = U.el('button', 'oc-sbtn', stepBox);
    minusBtn.type = 'button';
    minusBtn.textContent = '−';
    minusBtn.title = 'Decrease the risk value';
    const rin = U.el('input', 'oc-rin', stepBox);
    rin.type = 'text';
    rin.setAttribute('inputmode', 'decimal');
    rin.autocomplete = 'off';
    rin.spellcheck = false;
    rin.maxLength = 9;
    rin.title = 'Type the risk value and press Enter — ↑/↓ steps';
    const plusBtn = U.el('button', 'oc-sbtn', stepBox);
    plusBtn.type = 'button';
    plusBtn.textContent = '+';
    plusBtn.title = 'Increase the risk value';
    const modes = U.el('div', 'oc-modes', risk);
    const mkMode = (m, label, tip) => {
      const b = U.el('button', 'oc-modeb', modes);
      b.type = 'button';
      b.dataset.m = m;
      b.textContent = label;
      b.title = tip;
      return b;
    };
    const modePct = mkMode('pct', '%', 'Risk a percent of the account — the volume sizes itself from the SL');
    const modeUsd = mkMode('money', '$', 'Risk a fixed dollar amount — the volume sizes itself from the SL');
    const modeLot = mkMode('lot', 'Lot', 'The Risk value is the lot size directly');

    /* order grid — Buy | Sell | Set› / Pend.Buy | Pend.Sell | Cancel */
    const grid = U.el('div', 'oc-grid', panel);
    const buyBtn = U.el('button', 'oc-side oc-buy', grid);
    buyBtn.type = 'button';
    buyBtn.innerHTML = '<span class="oc-lbl">Buy</span>';
    const sellBtn = U.el('button', 'oc-side oc-sell', grid);
    sellBtn.type = 'button';
    sellBtn.innerHTML = '<span class="oc-lbl">Sell</span>';
    const setBtn = U.el('button', 'oc-exec oc-set', grid);
    setBtn.type = 'button';
    setBtn.innerHTML = 'Set ' + icon('chevR');
    const pendBuyBtn = U.el('button', 'oc-side oc-pendbuy', grid);
    pendBuyBtn.type = 'button';
    pendBuyBtn.innerHTML = '<span class="oc-lbl">Pend. Buy</span>';
    const pendSellBtn = U.el('button', 'oc-side oc-pendsell', grid);
    pendSellBtn.type = 'button';
    pendSellBtn.innerHTML = '<span class="oc-lbl">Pend. Sell</span>';
    const cancelBtn = U.el('button', 'oc-exec oc-cancel', grid);
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';

    /* live status strip — visible while a draft is armed */
    const status = U.el('div', 'oc-status oc-hidden', panel);

    /* open positions — header (% / $ units + collapse) + the rows */
    const posHead = U.el('div', 'oc-poshead', panel);
    U.el('span', 'oc-poslabel', posHead).textContent = 'Open Positions';
    const unitPct = U.el('button', 'oc-unitb', posHead);
    unitPct.type = 'button';
    unitPct.dataset.u = 'pct';
    unitPct.textContent = '%';
    unitPct.title = 'Show the profit/loss in percent (only %)';
    const unitUsd = U.el('button', 'oc-unitb', posHead);
    unitUsd.type = 'button';
    unitUsd.dataset.u = 'usd';
    unitUsd.textContent = '$';
    unitUsd.title = 'Show the profit/loss in dollars (only $)';
    const collBtn = U.el('button', 'oc-coll' + (this._collapsed ? ' oc-closed' : ''), posHead);
    collBtn.type = 'button';
    collBtn.innerHTML = icon('chevdown');
    collBtn.title = 'Collapse / expand the open positions';
    const posList = U.el('div', 'oc-poslist' + (this._collapsed ? ' oc-hidden' : ''), panel);

    const pill = U.el('button', 'oc-pill' + (this._min ? '' : ' oc-hidden'), pane.root);

    pinBtn.innerHTML = icon('pin');
    pinBtn.title = this._pin
      ? 'Position pinned — click to unpin and drag freely'
      : 'Pin the widget here (blocks dragging)';
    minBtn.innerHTML = icon('minus');
    minBtn.title = 'Minimize the trade panel';
    pill.innerHTML = icon('bolt');
    pill.title = 'Trade panel — click to open · drag to move';

    buyBtn.title = 'BUY ' + pane.symbol + ' — draw the entry/SL/TP draft on the chart';
    sellBtn.title = 'SELL ' + pane.symbol + ' — draw the entry/SL/TP draft on the chart';

    const st = {
      pane, panel, pill, chrome, grip, tools, pinBtn, minBtn, spread,
      titleSym, titlePx, modeBadge, rin, minusBtn, plusBtn, modePct, modeUsd, modeLot,
      buyBtn, sellBtn, setBtn, pendBuyBtn, pendSellBtn, cancelBtn, status,
      posHead, unitPct, unitUsd, collBtn, posList, posTotal: null,
      sym: pane.symbol, draft: null, lineDrag: null, curOn: false,
      posSig: '', posRows: [],
      lastKey: null, specTryAt: 0, desig: null,
    };
    this._map.set(pane, st);

    /* the widget never reaches the chart engine underneath it */
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    pill.addEventListener('mousedown', (e) => e.stopPropagation());

    /* ROUND109 drag: the grip starts it; the pill is draggable too */
    chrome.addEventListener('mousedown', (e) => {
      if (e.target.closest('.oc-cbtn')) return;    // pin/lock/minus stay buttons
      this._dragStart(e, st, 'panel');
    });
    pill.addEventListener('mousedown', (e) => this._dragStart(e, st, 'pill'));
    /* keyboard open on the pill (mouse open is handled by _dragUp's click test) */
    pill.addEventListener('click', (e) => { if (e.detail === 0) { e.stopPropagation(); this._setMin(false); } });

    pinBtn.addEventListener('click', (e) => { e.stopPropagation(); this._setPin(!this._pin); });
    minBtn.addEventListener('click', (e) => { e.stopPropagation(); this._setMin(true); });

    /* order flow */
    buyBtn.addEventListener('click', (e) => { e.stopPropagation(); this._onSide(pane, st, 0, false); });
    sellBtn.addEventListener('click', (e) => { e.stopPropagation(); this._onSide(pane, st, 1, false); });
    pendBuyBtn.addEventListener('click', (e) => { e.stopPropagation(); this._onSide(pane, st, 0, true); });
    pendSellBtn.addEventListener('click', (e) => { e.stopPropagation(); this._onSide(pane, st, 1, true); });
    setBtn.addEventListener('click', (e) => { e.stopPropagation(); this._onSet(pane, st); });
    cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); this._onCancel(pane, st); });

    /* ROUND111 risk field — the round-110 entry rules, per mode: focus
       selects the whole value; Enter/blur commit, Esc reverts, ↑/↓ step;
       the −/+ buttons step too; the mode buttons switch lot/$/% globally */
    rin.addEventListener('focus', () => { try { rin.select(); } catch (e) {} });
    rin.addEventListener('blur', () => { this._riskCommit(st); });
    rin.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._riskCommit(st);
        rin.blur();
      } else if (e.key === 'Escape') {
        this._riskPaint(st, true);         // revert the draft — nothing stored
        rin.blur();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        this._riskStep(st, e.key === 'ArrowUp' ? 1 : -1);
      }
    });
    rin.addEventListener('mousedown', (e) => e.stopPropagation());
    minusBtn.addEventListener('click', (e) => { e.stopPropagation(); this._riskStep(st, -1); });
    plusBtn.addEventListener('click', (e) => { e.stopPropagation(); this._riskStep(st, 1); });
    modePct.addEventListener('click', (e) => { e.stopPropagation(); this._riskModeAll('pct'); });
    modeUsd.addEventListener('click', (e) => { e.stopPropagation(); this._riskModeAll('money'); });
    modeLot.addEventListener('click', (e) => { e.stopPropagation(); this._riskModeAll('lot'); });

    /* open-positions header controls */
    unitPct.addEventListener('click', (e) => { e.stopPropagation(); this._setPlUnit('pct'); });
    unitUsd.addEventListener('click', (e) => { e.stopPropagation(); this._setPlUnit('usd'); });
    collBtn.addEventListener('click', (e) => { e.stopPropagation(); this._setCollapsed(!this._collapsed); });

    /* draft-line drag + cursor arbiter (registered AFTER the overlay's own
       canvas listener — the last cursor write of every event wins) */
    pane.root.addEventListener('mousedown', (e) => this._lineDown(e, pane), true);
    if (pane.overlay) pane.overlay.addEventListener('mousemove', (e) => this._lineCursor(e, pane));

    this._visPaint(st);
    this._position(st);
  },

  /* ---------- ROUND112 mode switch (live ↔ demo) ---------- */
  /* the draft belongs to the previous market context — cancel it; rows and
     the badge repaint from the route on the next tick anyway */
  _onRouteChange() {
    this._draftCancelAll();
    for (const pane of App.panes) {
      const st = this._st(pane);
      if (st) st.posSig = '';        // the positions list follows the account
    }
  },

  /* ---------- ROUND111 risk value (per-mode, persisted, shared) ---------- */

  /* storage shape: JSON {lot, money, pct}; the lot value seeds from the
     legacy round-108/110 volume so an existing user keeps their lot */
  _loadRisk() {
    let o = null;
    try { o = JSON.parse(U.lsGet(K.rval, 'null')); } catch (e) { o = null; }
    const legacy = parseFloat(U.lsGet(K.vol, 0.01));
    this._rvals = {
      lot: (o && o.lot > 0) ? o.lot : (isFinite(legacy) && legacy > 0 ? legacy : 0.01),
      money: (o && o.money > 0) ? o.money : 100,
      pct: (o && o.pct > 0) ? o.pct : 1,
    };
    const m = U.lsGet(K.rmode, 'lot');
    this._rmode = (m === 'money' || m === 'pct') ? m : 'lot';
  },

  _saveRisk() { U.lsSet(K.rval, JSON.stringify(this._rvals)); },

  _riskCur() { return this._rvals[this._rmode] || 0; },

  /* mirror the stored value into a pane's field. A live draft (focused field)
     is NEVER stomped by the 200ms tick unless forced. */
  _riskPaint(st, force) {
    const inp = st.rin;
    if (!force && document.activeElement === inp) return;
    const v = this._riskCur();
    const shown = this._rmode === 'lot'
      ? _volTxt(Trade.clampVolume(st.sym, v), Trade.specSync(st.sym))
      : String(Math.round(v * 100) / 100);
    if (inp.value !== shown) inp.value = shown;
  },

  _riskRefreshAll() {
    for (const pane of App.panes) {
      const s2 = this._st(pane);
      if (s2) { try { this._riskPaint(s2); } catch (e) {} }
    }
  },

  /* commit a manual draft (blur / Enter / before Set): a valid value is
     clamped (Lot) or rounded ($ / %), stored per-mode and synced everywhere;
     an invalid one silently reverts — it can never reach the send path */
  _riskCommit(st) {
    const v = _volParse(st.rin.value);
    if (v == null) { this._riskPaint(st, true); return false; }
    if (this._rmode === 'lot') this._rvals.lot = Trade.clampVolume(st.sym, v);
    else if (this._rmode === 'money') this._rvals.money = Math.round(v * 100) / 100;
    else this._rvals.pct = Math.round(v * 100) / 100;
    this._saveRisk();
    this._riskRefreshAll();
    return true;
  },

  /* − / + / ArrowUp / ArrowDown — step by the mode's unit (clamped) */
  _riskStep(st, dir) {
    const spec = Trade.specSync(st.sym);
    const draft = _volParse(st.rin.value);
    const base = (draft != null) ? draft : this._riskCur();
    const stepv = _riskStepFor(this._rmode, spec);
    let v = base + dir * stepv;
    if (this._rmode === 'lot') {
      v = Trade.clampVolume(st.sym, v);
      if (!(v > 0)) return;
    } else if (this._rmode === 'money') {
      v = Math.max(1, Math.round(v * 100) / 100);
    } else {
      v = Math.max(0.1, Math.round(v * 10) / 10);
    }
    this._rvals[this._rmode] = v;
    this._saveRisk();
    this._riskRefreshAll();
    this._riskPaint(st, true);
    /* a value change re-sizes an armed draft at once */
    if (st.draft) { try { this._draftPaint(st.pane, st); this._statusPaint(st); } catch (e) {} }
  },

  /* switch the risk mode on every pane (the value set is per-mode) */
  _riskModeAll(m) {
    if (m !== 'lot' && m !== 'money' && m !== 'pct') return;
    this._rmode = m;
    U.lsSet(K.rmode, m);
    for (const pane of App.panes) {
      const s2 = this._st(pane);
      if (!s2) continue;
      try {
        this._riskModePaint(s2);
        this._riskPaint(s2, true);
        if (s2.draft) { this._draftPaint(pane, s2); this._statusPaint(s2); }
      } catch (e) {}
    }
  },

  _riskModePaint(st) {
    const on = { pct: false, money: false, lot: false };
    on[this._rmode] = true;
    st.modePct.classList.toggle('oc-on', on.pct);
    st.modeUsd.classList.toggle('oc-on', on.money);
    st.modeLot.classList.toggle('oc-on', on.lot);
  },

  /* the positions P/L lead unit — painted on boot + on every tick so a
     fresh pane always shows the persisted choice (round-111 repro catch) */
  _unitPaint(st) {
    st.unitPct.classList.toggle('oc-on', this._plunit === 'pct');
    st.unitUsd.classList.toggle('oc-on', this._plunit === 'usd');
  },

  /* ---------- ROUND111 the draft order flow (nothing is sent until Set) ---------- */

  /* Buy / Sell / Pend.Buy / Pend.Sell — arm (or re-arm) the draft */
  _onSide(pane, st, side, pend) {
    const q = TradeRoute.quote(st.sym);
    if (!q || !(q.bid > 0) || !(q.ask > 0)) {
      UI.toast('No live quote for ' + st.sym + ' yet', '');
      return;
    }
    if (!Trade.specSync(st.sym)) {
      try { Trade.spec(st.sym).catch(() => {}); } catch (e) {}
      UI.toast('Loading symbol specs — try again in a second', '');
      return;
    }
    this._draftArm(pane, st, side, pend);
  },

  _draftArm(pane, st, side, pend) {
    const q = TradeRoute.quote(st.sym);
    const spec = Trade.specSync(st.sym);
    this._draftCancel(st);          // re-arming replaces the old draft cleanly
    const def = _draftDefaults(side, q.bid, q.ask, this._visibleSpan(pane), spec);
    st.draft = {
      pend: !!pend, side,
      entry: def.entry, sl: def.sl, tp: def.tp,
      lines: { e: null, s: null, t: null },
    };
    this._armVisual(st);
    this._draftPaint(pane, st);
    this._statusPaint(st);
  },

  /* light up the button that owns the draft (and only it) */
  _armVisual(st) {
    const d = st.draft;
    const hot = d ? (d.pend ? (d.side === 0 ? st.pendBuyBtn : st.pendSellBtn)
      : (d.side === 0 ? st.buyBtn : st.sellBtn)) : null;
    for (const b of [st.buyBtn, st.sellBtn, st.pendBuyBtn, st.pendSellBtn]) {
      b.classList.toggle('oc-armed', b === hot);
    }
  },

  /* Cancel / Esc — remove the three lines and forget the draft */
  _draftCancel(st) {
    const d = st.draft;
    if (d) {
      for (const k of ['e', 's', 't']) {
        if (d.lines && d.lines[k]) {
          try { st.pane.series.removePriceLine(d.lines[k]); } catch (e) {}
          d.lines[k] = null;
        }
      }
    }
    st.draft = null;
    this._armVisual(st);
    st.status.classList.add('oc-hidden');
  },

  _draftCancelAll() {
    for (const pane of App.panes) {
      const st = this._st(pane);
      if (st && st.draft) this._draftCancel(st);
    }
  },

  _onCancel(pane, st) {
    this._draftCancel(st);
  },

  /* the visible price span (for the default SL/TP distances) — 0 when the
     chart cannot be measured yet */
  _visibleSpan(pane) {
    try {
      const h = (pane.root && pane.root.clientHeight) || 0;
      if (h > 40 && pane.series && pane.series.coordinateToPrice) {
        const a = pane.series.coordinateToPrice(10);
        const b = pane.series.coordinateToPrice(Math.round(h * 0.9));
        if (a != null && b != null && isFinite(a) && isFinite(b)) return Math.abs(a - b);
      }
    } catch (e) {}
    return 0;
  },

  /* repaint the three draft lines — prices, live money tags, self-healing
     (a dead line object, e.g. after a series swap, is recreated at once).
     MARKET mode: the entry line is LOCKED to the live price and follows
     every tick; PENDING mode: the entry stays where the user dropped it. */
  _draftPaint(pane, st) {
    const d = st.draft;
    if (!d) return;
    const spec = Trade.specSync(st.sym);
    const dg = (spec && spec.digits != null) ? spec.digits : 5;
    const q = TradeRoute.quote(st.sym) || {};
    if (!d.pend && q.bid > 0 && q.ask > 0) {
      d.entry = d.side === 0 ? q.ask : q.bid;      // locked to the live market
    }
    const slDist = Math.abs(d.entry - d.sl);
    const tpDist = Math.abs(d.tp - d.entry);
    const r = _resolveVol(spec, this._rmode, this._riskCur(), slDist, TradeRoute.equity());
    const tpMoney = (r.vol > 0 && tpDist > 0 && spec && spec.tick_value > 0 && spec.tick_size > 0)
      ? (tpDist / spec.tick_size) * spec.tick_value * r.vol : 0;
    const ep = Number(d.entry.toFixed(dg));
    const titles = {
      e: d.pend
        ? ((this._pendName(st, d, spec) || (d.side === 0 ? 'BUY' : 'SELL') + ' entry') + ' ' + ep.toFixed(dg))
        : (d.side === 0 ? 'BUY @ ' : 'SELL @ ') + ep.toFixed(dg),
      s: (r.vol > 0 && slDist > 0)
        ? 'SL ' + fmtMoney(-r.risk) + ' · ' + _ptsTxt(slDist, spec)
        : 'SL ' + Number(d.sl.toFixed(dg)),
      t: (r.vol > 0 && tpDist > 0)
        ? 'TP ' + fmtMoney(tpMoney) + ' · ' + _ptsTxt(tpDist, spec)
        : 'TP ' + Number(d.tp.toFixed(dg)),
    };
    const L = LightweightCharts.LineStyle;
    const ensure = (key, price, color, title) => {
      if (d.lines[key]) {
        try { d.lines[key].applyOptions({ price, title }); return; }
        catch (e) { d.lines[key] = null; }         // dead line → recreate below
      }
      if (!pane.series || !pane.series.createPriceLine) return;
      try {
        d.lines[key] = pane.series.createPriceLine({
          price, color, lineWidth: 1, lineStyle: L.Dashed,
          axisLabelVisible: true, axisLabelColor: color, axisLabelTextColor: '#fff', title,
        });
      } catch (e) { d.lines[key] = null; }
    };
    ensure('e', d.entry, C.entry, titles.e);
    ensure('s', d.sl, C.sl, titles.s);
    ensure('t', d.tp, C.tp, titles.t);
  },

  /* the pending order name the entry would become (for the entry-line tag) */
  _pendName(st, d, spec) {
    const q = TradeRoute.quote(st.sym) || {};
    const t = _pendType(d.side, d.entry, q.bid, q.ask, spec ? spec.stops_level : 0, spec ? spec.point : 0);
    return t == null ? null : (OT_NAME[t] || '');
  },

  /* the live status strip under the buttons — what WILL be sent */
  _statusPaint(st) {
    const d = st.draft;
    if (!d) { st.status.classList.add('oc-hidden'); return; }
    const spec = Trade.specSync(st.sym);
    let txt;
    if (!spec) {
      txt = 'Loading symbol specs…';
    } else {
      const q = TradeRoute.quote(st.sym) || {};
      const slDist = Math.abs(d.entry - d.sl);
      const r = _resolveVol(spec, this._rmode, this._riskCur(), slDist, TradeRoute.equity());
      const tpDist = Math.abs(d.tp - d.entry);
      const tpMoney = (r.vol > 0 && tpDist > 0 && spec.tick_value > 0 && spec.tick_size > 0)
        ? (tpDist / spec.tick_size) * spec.tick_value * r.vol : 0;
      if (!(r.vol > 0)) {
        txt = this._rmode === 'lot'
          ? 'Enter the lot size…'
          : 'Risk too small for one lot step — raise the Risk or tighten the SL';
      } else if (d.pend) {
        const t = _pendType(d.side, d.entry, q.bid, q.ask, spec.stops_level, spec.point);
        txt = t == null
          ? 'Move the entry line away from the market (min stop distance)'
          : (OT_NAME[t] || 'Pending') + ' ' + _volTxt(r.vol, spec) +
            ' · SL ' + fmtMoney(-r.risk) + ' · TP ' + fmtMoney(tpMoney);
      } else {
        txt = 'Vol ' + _volTxt(r.vol, spec) + ' · SL ' + fmtMoney(-r.risk) + ' · TP ' + fmtMoney(tpMoney);
      }
    }
    if (st.status.textContent !== txt) st.status.textContent = txt;
    st.status.classList.remove('oc-hidden');
  },

  /* ---------- draft-line drag (SL/TP always; entry when pending) ---------- */

  /* same screen-space origin rule as trade/overlay (round-100 lesson): the
     hit-test measures against the LWC chart element, not the pane wrapper */
  _lwcRect(pane) {
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

  _mainY(pane, clientY) {
    const r = this._lwcRect(pane);
    return clientY - r.top;
  },

  _lineHit(pane, st, clientY) {
    const d = st.draft;
    if (!d) return null;
    const y = this._mainY(pane, clientY);
    const kinds = d.pend ? ['e', 's', 't'] : ['s', 't'];   // market entry is locked
    let best = null;
    for (const k of kinds) {
      const price = k === 'e' ? d.entry : (k === 's' ? d.sl : d.tp);
      let ly = null;
      try { ly = pane.series.priceToCoordinate(price); } catch (e) { ly = null; }
      if (ly == null || !isFinite(ly)) continue;
      const dist = Math.abs(ly - y);
      if (dist <= HIT_PX && (!best || dist < best.dist)) best = { kind: k, dist };
    }
    return best;
  },

  _lineDown(e, pane) {
    const st = this._map.get(pane);
    if (!st || !st.draft || this._min) return;
    if (e.button !== 0) return;
    if (st.panel.contains(e.target) || st.pill.contains(e.target)) return;  // the panel owns its clicks
    const hit = this._lineHit(pane, st, e.clientY);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    /* freeze chart gestures while a draft line is dragged (overlay pattern) */
    let saved = null;
    try {
      const co = pane.chart.options();
      saved = { hs: co.handleScroll, hsc: co.handleScale };
      pane.chart.applyOptions({ handleScroll: false, handleScale: false });
    } catch (er) { saved = null; }
    st.lineDrag = { kind: hit.kind, saved };
    this._cursorSet(pane, st, hit.kind === 'e' ? 'grabbing' : 'ns-resize');
  },

  _lineMove(e) {
    for (const pane of App.panes) {
      const st = this._map.get(pane);
      if (!st || !st.lineDrag) continue;
      const d = st.draft;
      if (!d) { st.lineDrag = null; continue; }
      e.preventDefault();
      let price = null;
      try { price = pane.series.coordinateToPrice(this._mainY(pane, e.clientY)); } catch (er) { price = null; }
      if (price == null || !isFinite(price)) continue;
      const spec = Trade.specSync(st.sym);
      const q = TradeRoute.quote(st.sym) || {};
      const clamped = _clampLevel(st.lineDrag.kind, d.side, d.pend, price,
        { bid: q.bid, ask: q.ask, entry: d.entry }, spec);
      if (st.lineDrag.kind === 'e') d.entry = clamped;
      else if (st.lineDrag.kind === 's') d.sl = clamped;
      else d.tp = clamped;
      this._draftPaint(pane, st);
      this._statusPaint(st);
    }
  },

  _lineUp() {
    for (const pane of App.panes) {
      const st = this._map.get(pane);
      if (!st || !st.lineDrag) continue;
      try {
        if (st.lineDrag.saved) pane.chart.applyOptions({ handleScroll: st.lineDrag.saved.hs, handleScale: st.lineDrag.saved.hsc });
      } catch (er) {}
      st.lineDrag = null;
      this._cursorSet(pane, st, null);
    }
  },

  /* hover cursor over a draft line — private curOn flag so it never fights
     the overlay's own arbiter (each side only clears what it set) */
  _lineCursor(e, pane) {
    const st = this._map.get(pane);
    if (!st || st.lineDrag) return;
    const hit = st.draft ? this._lineHit(pane, st, e.clientY) : null;
    this._cursorSet(pane, st, hit ? (hit.kind === 'e' ? 'grab' : 'ns-resize') : null);
  },

  _cursorSet(pane, st, cur) {
    if (cur) {
      try { if (pane.overlay && pane.overlay.style) pane.overlay.style.cursor = cur; } catch (e) {}
      try { if (pane.root && pane.root.style) pane.root.style.cursor = cur; } catch (e) {}
      st.curOn = true;
    } else if (st.curOn) {
      try { if (pane.overlay && pane.overlay.style) pane.overlay.style.removeProperty('cursor'); } catch (e) {}
      try { if (pane.root && pane.root.style) pane.root.style.removeProperty('cursor'); } catch (e) {}
      st.curOn = false;
    }
  },

  /* ---------- Set — the order goes live AT ONCE (ROUND113) ----------
     The user asked to remove the "CONFIRM SET" second step entirely:
     the first click on Set sends the order. The old confirm-lock padlock
     (the only consumer of the armed state) was removed with it. */

  _onSet(pane, st) {
    if (!st.draft) return;
    this._sendDraft(pane, st);
  },

  /* the real order — market or pending, with the draft's volume + SL + TP.
     ROUND112: it goes to the ACTIVE account (live broker or demo) via the
     TradeRoute facade; the guards are the route's canTrade(). */
  _sendDraft(pane, st) {
    const d = st.draft;
    if (!d) return;
    const sym = st.sym;
    const gate = TradeRoute.canTrade();
    if (!gate.ok) {
      UI.toast(gate.reason, '');
      this._flash(st, d.side, true);
      return;
    }
    const q = TradeRoute.quote(sym);
    if (!q || !(q.bid > 0) || !(q.ask > 0)) {
      UI.toast('No live quote for ' + sym + ' yet', '');
      this._flash(st, d.side, true);
      return;
    }
    this._riskCommit(st);                      // flush a pending risk draft
    const spec = Trade.specSync(sym);
    if (!spec) {
      UI.toast('Symbol specs are still loading — try again in a second', '');
      this._flash(st, d.side, true);
      return;
    }
    const slDist = Math.abs(d.entry - d.sl);
    const r = _resolveVol(spec, this._rmode, this._riskCur(), slDist, TradeRoute.equity());
    if (!(r.vol > 0)) {
      UI.toast(this._rmode === 'lot' ? 'Invalid volume' :
        'Risk too small for one lot step — raise the Risk or tighten the SL', '');
      this._flash(st, d.side, true);
      return;
    }
    const dg = (spec.digits != null) ? spec.digits : 5;
    const sl = Number(d.sl.toFixed(dg));
    const tp = Number(d.tp.toFixed(dg));
    let orderType, price = 0, desc;
    if (d.pend) {
      orderType = _pendType(d.side, d.entry, q.bid, q.ask, spec.stops_level, spec.point);
      if (orderType == null) {
        UI.toast('Move the entry line away from the market — the broker needs a minimum stop distance', '');
        return;                                // the draft stays for adjustment
      }
      price = Number(d.entry.toFixed(dg));
      desc = (OT_NAME[orderType] || 'Pending') + ' ' + r.vol + ' ' + sym + ' @ ' + price.toFixed(dg);
    } else {
      orderType = d.side === 0 ? OT.BUY : OT.SELL;
      desc = (d.side === 0 ? 'BUY ' : 'SELL ') + r.vol + ' ' + sym + ' @ market';
    }
    desc += ' · SL ' + sl.toFixed(dg) + ' / TP ' + tp.toFixed(dg);
    const tag = TradeRoute.isDemo() ? 'DEMO ' : '';
    TradeRoute.sendOrder({
      symbol: sym, orderType, volume: r.vol, price, sl, tp,
      pend: !!d.pend, deviation: _deviation(), comment: '',
    }).then((res) => {
      const bad = !(res && res.ok);
      const rc = bad && res.retcode ? ' [retcode ' + res.retcode + ']' : '';
      UI.toast(tag + desc + ' — ' + ((res && (res.comment || res.error)) || 'done') + rc, bad ? '' : 'ok');
      this._flash(st, d.side, bad);
      if (!bad) this._draftCancel(st);         // success: the real lines take over
    }).catch((err) => {
      /* err.message carries the broker's retcode + comment (feed.js) */
      UI.toast('Order failed: ' + ((err && err.message) || ''), '');
      this._flash(st, d.side, true);           // the draft survives — adjust and Set again
    });
  },

  /* brief green/red ring on the side button that fired */
  _flash(st, side, bad) {
    const btn = side === 0 ? st.buyBtn : st.sellBtn;
    btn.classList.remove('flash-ok', 'flash-bad');
    void btn.offsetWidth;                    // restart the animation
    btn.classList.add(bad ? 'flash-bad' : 'flash-ok');
    setTimeout(() => { btn.classList.remove('flash-ok', 'flash-bad'); }, 950);
  },

  /* ---------- ROUND111 Open Positions ---------- */

  _setPlUnit(u) {
    this._plunit = u === 'usd' ? 'usd' : 'pct';
    U.lsSet(K.plunit, this._plunit);
    for (const pane of App.panes) {
      const st = this._st(pane);
      if (!st) continue;
      st.unitPct.classList.toggle('oc-on', this._plunit === 'pct');
      st.unitUsd.classList.toggle('oc-on', this._plunit === 'usd');
      st.posSig = '';                        // rebuild with the new lead unit
    }
  },

  _setCollapsed(v) {
    this._collapsed = !!v;
    U.lsSet(K.collapsed, this._collapsed);
    for (const pane of App.panes) {
      const st = this._st(pane);
      if (!st) continue;
      st.collBtn.classList.toggle('oc-closed', this._collapsed);
      st.posList.classList.toggle('oc-hidden', this._collapsed);
      st.posSig = '';
    }
  },

  /* rows rebuild on any STRUCTURAL change (ticket/vol/SL/TP/symbol/unit/
     collapse/route-mode); the floating P/L rides the 200ms tick without a
     rebuild. ROUND112: the rows list the ACTIVE account (live or demo).
     ROUND113: a Total row under the list shows the NET P/L of everything
     open, in the SAME single unit the rows use; and each row shows ONLY
     the chosen unit — % or $, never both at once (user request). */
  _posRefresh(st) {
    if (this._collapsed) return;
    const positions = TradeRoute.positions();
    const sig = TradeRoute.mode + '#' + positions.map((p) => [p.ticket, p.type, p.volume, p.open, p.sl, p.tp, p.symbol].join(':')).join('|') +
      '#' + this._plunit;
    if (sig !== st.posSig) {
      st.posSig = sig;
      const list = st.posList;
      U.clear(list);
      st.posRows = [];
      st.posTotal = null;
      if (!positions.length) {
        U.el('div', 'oc-pos-empty', list).textContent =
          'No open positions' + (TradeRoute.isDemo() ? ' — demo account' : '');
        return;
      }
      for (const p of positions) {
        const row = U.el('div', 'oc-pos-row', list);
        row.dataset.ticket = p.ticket;
        const name = U.el('span', 'oc-pos-name', row);
        name.innerHTML = '<b>' + U.esc(p.symbol) + '</b><i class="oc-psd ' + (p.type === 0 ? 'b' : 's') + '">' +
          (p.type === 0 ? 'B' : 'S') + '</i>' + p.volume;
        const pl = U.el('span', 'oc-pos-pl', row);
        const acts = U.el('span', 'oc-pos-acts', row);
        const halfBtn = U.el('button', 'oc-pact oc-half', acts);
        halfBtn.type = 'button';
        halfBtn.textContent = '½';
        halfBtn.title = 'Close half the position';
        const rfBtn = U.el('button', 'oc-pact oc-rf', acts);
        rfBtn.type = 'button';
        rfBtn.innerHTML = icon('shield');
        rfBtn.title = 'Risk-free: move the SL to the entry (break-even)';
        const xBtn = U.el('button', 'oc-pact oc-x', acts);
        xBtn.type = 'button';
        xBtn.innerHTML = icon('x');
        xBtn.title = 'Close the position';
        const spec = Trade.specSync(p.symbol);
        const step = (spec && spec.vol_step > 0) ? spec.vol_step : 0.01;
        const vmin = (spec && spec.vol_min > 0) ? spec.vol_min : 0.01;
        const half = Math.round((p.volume / 2) / step) * step;
        if (!(half >= vmin && half < p.volume)) halfBtn.disabled = true;
        const be = (spec && spec.point > 0) ? spec.point / 2 : 1e-9;
        if (p.sl > 0 && Math.abs(p.sl - p.open) < be) rfBtn.disabled = true;
        const halfV = Number(half.toFixed(3));
        halfBtn.addEventListener('click', (e) => { e.stopPropagation(); this._posHalf(p.ticket, halfV); });
        rfBtn.addEventListener('click', (e) => { e.stopPropagation(); this._posRiskFree(p); });
        xBtn.addEventListener('click', (e) => { e.stopPropagation(); this._posClose(p.ticket); });
        st.posRows.push({ ticket: p.ticket, pl });
      }
      /* ROUND113: the Total row — net P/L of every open position, kept
         outside the posRows loop and refreshed by the same live pass */
      const tot = U.el('div', 'oc-pos-total', list);
      U.el('span', 'oc-pt-label', tot).textContent = 'Total · ' + positions.length;
      st.posTotal = U.el('span', 'oc-pt-val', tot);
      /* fall through: the fresh rows get their P/L at once — they never sit
         empty for a tick (the round-111 repro caught the blank row) */
    }
    /* live P/L pass — percent of the ACTIVE account's equity, dollars
       absolute. ROUND113: the % / $ header buttons are now EXCLUSIVE —
       the row shows only the selected unit, never both. */
    const eq = TradeRoute.equity();
    let totProfit = 0;
    for (const rr of st.posRows) {
      const p = TradeRoute.positions().find((x) => x.ticket === rr.ticket);
      if (!p) continue;
      const profit = TradeRoute.profitOf(p);
      totProfit += profit;
      rr.pl.innerHTML = this._plHtml(profit, eq, true);
    }
    /* Total row — same single unit as the rows (user request) */
    if (st.posTotal) st.posTotal.innerHTML = this._plHtml(totProfit, eq, false);
  },

  /* one P/L cell in the ACTIVE unit only: usd → "+$12.34", pct → "+0.52%"
     (a missing equity falls back to dollars so a value is always shown).
     big = the row/total emphasis (b vs span — same styling either way). */
  _plHtml(profit, eq, big) {
    void big;
    if (this._plunit === 'pct' && eq > 0) {
      const pct = (profit / eq) * 100;
      return '<b class="' + (pct >= 0 ? 'pos' : 'neg') + '">' + fmtPct(pct) + '</b>';
    }
    return '<b class="' + (profit >= 0 ? 'pos' : 'neg') + '">' + fmtMoney(profit) + '</b>';
  },

  _posClose(ticket) {
    TradeRoute.close(ticket, 0)
      .then(() => UI.toast('Close sent — #' + ticket, 'ok'))
      .catch((err) => UI.toast('Close rejected: ' + ((err && err.message) || ''), ''));
  },

  _posHalf(ticket, vol) {
    if (!(vol > 0)) return;
    TradeRoute.close(ticket, vol)
      .then(() => UI.toast('Partial close sent (' + vol + ' lots) — #' + ticket, 'ok'))
      .catch((err) => UI.toast('Partial close rejected: ' + ((err && err.message) || ''), ''));
  },

  _posRiskFree(p) {
    const spec = Trade.specSync(p.symbol);
    const dg = (spec && spec.digits != null) ? spec.digits : 5;
    const be = Number(p.open.toFixed(dg));
    /* opts.be: the demo broker snaps an illegal break-even SL (open sits on
       the far side of the spread) to the nearest legal point */
    TradeRoute.modifySLTP(p.ticket, be, p.tp || 0, { be: true })
      .then(() => UI.toast('Risk-free — SL moved to break-even (' + be.toFixed(dg) + ')', 'ok'))
      .catch((err) => UI.toast('Risk-free rejected: ' + ((err && err.message) || ''), ''));
  },

  /* ---------- live refresh (200ms, all panes) ---------- */
  _tick() {
    for (const pane of App.panes) {
      const st = this._st(pane);
      if (!st) continue;
      try { this._tickPane(pane, st); } catch (e) {}
    }
  },

  _tickPane(pane, st) {
    /* symbol changed under the widget (watchlist / sync / symbol search):
       the draft lines belong to the old symbol — cancel them first */
    if (st.sym !== pane.symbol) {
      this._draftCancel(st);
      st.sym = pane.symbol;
      st.posSig = '';            // the positions list may name the new symbol too
      st.lastKey = null;         /* ROUND120: re-anchor to the new symbol's saved position */
      st.buyBtn.title = 'BUY ' + st.sym + ' — draw the entry/SL/TP draft on the chart';
      st.sellBtn.title = 'SELL ' + st.sym + ' — draw the entry/SL/TP draft on the chart';
    }
    /* ROUND120: only the designated pane (the first holding this symbol)
       runs the live widget — the others stay hidden and idle. Recompute
       the designation EVERY tick: a layout/symbol change re-homes the
       panel without destroying it (multi → single and back). */
    this._visPaint(st);
    if (!st.desig) return;
    /* spec prefetch, throttled to one try / 2s until it lands: the widget is
       born at app boot when the WS may not be up yet (panes exist before
       login), the first Trade.spec rejects with 'not connected' and the
       single-flight map clears on failure — so the retry lives in the tick.
       Without it the panel shows 5-dp fallback prices and an unclamped lot
       forever (the round-106 prefetch lesson, one step deeper). */
    if (!Trade.specSync(st.sym)) {
      const now = Date.now();
      if (now - st.specTryAt > 2000) {
        st.specTryAt = now;
        Trade.spec(st.sym).catch(() => {});
      }
    }
    /* ROUND112: mode-aware quote + trading gate.
       live  → the bridge must be online, quotes live, market not closed;
       demo  → the route provides the quote (live ticks or replay prices);
               the market-closed chip only matters on the live source. */
    const demo = TradeRoute.isDemo();
    const q = TradeRoute.quote(st.sym);
    const haveQ = !!(q && q.bid > 0 && q.ask > 0);
    const mkt = pane.els && pane.els.lgMkt;
    const closed = !!(mkt && mkt.classList.contains('closed'));
    const replayOn = demo && TradeRoute.demo && TradeRoute.demo.sourceOf && TradeRoute.demo.sourceOf() === 'replay';
    const on = demo
      ? !!(haveQ && (replayOn || !closed))
      : !!(Trade.online && haveQ && !closed);
    st.buyBtn.disabled = !on;
    st.sellBtn.disabled = !on;
    st.pendBuyBtn.disabled = !on;
    st.pendSellBtn.disabled = !on;
    st.setBtn.disabled = !st.draft;
    st.cancelBtn.disabled = !st.draft;

    /* the LIVE / DEMO badge in the title row */
    const badgeTxt = demo ? 'DEMO' : 'LIVE';
    if (st.modeBadge.textContent !== badgeTxt) st.modeBadge.textContent = badgeTxt;
    st.modeBadge.classList.toggle('demo', demo);

    /* title row — symbol + the live bid/ask */
    if (st.titleSym.textContent !== st.sym) st.titleSym.textContent = st.sym;
    const tpx = haveQ ? (_fmtPx(st.sym, q.bid, pane) + ' / ' + _fmtPx(st.sym, q.ask, pane)) : '—';
    if (st.titlePx.textContent !== tpx) st.titlePx.textContent = tpx;

    /* floating spread chip (round-108 kept) */
    const sp = on ? Trade.spreadPts(st.sym) : 0;
    if (sp > 0) { st.spread.textContent = sp + ' pts'; st.spread.classList.remove('oc-hidden'); }
    else { st.spread.textContent = ''; st.spread.classList.add('oc-hidden'); }

    /* risk field + mode buttons + the P/L unit buttons (multi-pane sync) */
    this._riskPaint(st);
    this._riskModePaint(st);
    this._unitPaint(st);

    /* the armed draft: live entry (market mode), money tags, status strip */
    if (st.draft) {
      this._draftPaint(pane, st);
      this._statusPaint(st);
    }

    /* open positions rows */
    this._posRefresh(st);

    this._position(st);
  },

  /* ---------- placement (ROUND109 fractions; ROUND120 per-symbol) ----------
     Each symbol's panel keeps its OWN position: dragging one symbol's
     panel never moves another symbol's panel, and the place survives
     single ↔ multi-chart switches. */
  _posFor(sym) {
    const p = this._posBySym[sym];
    if (p && isFinite(p.fx) && isFinite(p.fy)) {
      return { fx: Math.min(1, Math.max(0, +p.fx)), fy: Math.min(1, Math.max(0, +p.fy)) };
    }
    return this._pos;          /* legacy migration fallback */
  },

  _posSaveFor(sym, pos) {
    if (!sym) return;
    this._posBySym[sym] = pos ? { fx: pos.fx, fy: pos.fy } : null;
    try { U.lsSet(K.posMap, JSON.stringify(this._posBySym)); } catch (e) { Log.warn('trade', 'one-click position map save failed', e) }
    /* keep the legacy key mirrored (older builds / tests read it) */
    if (pos) { try { U.lsSet(K.pos, JSON.stringify(pos)); } catch (e) { Log.warn('trade', 'one-click position save failed', e) } }
  },

  _position(st) {
    const pw = (st.pane.root && st.pane.root.clientWidth) || 0;
    const ph = (st.pane.root && st.pane.root.clientHeight) || 0;
    const el = this._min ? st.pill : st.panel;         // only the visible half
    if (!el || !el.offsetWidth) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = 8, y;
    const pos = this._posFor(st.sym);
    if (pos) {
      const xy = _placeXY(pos.fx, pos.fy, pw, ph, w, h, this._min ? 'pill' : 'panel');
      x = xy.x; y = xy.y;
    } else {
      y = _placeTop(st.pane);
    }
    const key = x + '|' + y;
    if (key === st.lastKey) return;
    st.lastKey = key;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  },

  _positionAll() {
    for (const pane of App.panes) {
      const st = this._st(pane);
      if (st) { try { this._position(st); } catch (e) {} }
    }
  },

  /* ---------- ROUND109 widget drag (grip on the chrome, or the whole pill) ---------- */
  _dragStart(e, st, kind) {
    if (e.button !== 0) return;
    if (this._pin) {
      /* ROUND114 (user bug): pinned blocks MOVING the widget — never the
         pill's click-to-open. The old early-return left pinned+minimized
         widgets permanently dead: no _drag record meant _dragUp could not
         see the clean press, so clicking the pill did nothing. */
      if (kind === 'pill') {
        e.preventDefault();
        e.stopPropagation();
        this._drag = { kind, st, moved: false, frozen: true };
      }
      return;
    }
    e.preventDefault();                    // no text selection while dragging
    e.stopPropagation();
    const el = kind === 'pill' ? st.pill : st.panel;
    this._drag = {
      kind, st,
      sx: e.clientX, sy: e.clientY,
      bx: el.offsetLeft, by: el.offsetTop,
      moved: false,
    };
  },

  _dragMove(e) {
    const d = this._drag;
    if (!d || d.frozen) return;            // frozen = pinned pill press (cannot move)
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (!d.moved) {
      if (Math.abs(dx) + Math.abs(dy) < DRAG_TPX) return;   // still a press, not a drag
      d.moved = true;
      document.body.classList.add('oc-dragging');
    }
    const st = d.st;
    const el = d.kind === 'pill' ? st.pill : st.panel;
    const pw = (st.pane.root && st.pane.root.clientWidth) || 0;
    const ph = (st.pane.root && st.pane.root.clientHeight) || 0;
    const w = el.offsetWidth || 40, h = el.offsetHeight || 24;
    this._pos = _frac(d.bx + dx, d.by + dy, pw, ph, w, h);
    /* ROUND120: the drag moves ONLY the dragged pane's widget — panels of
       other symbols (and other panes of the same symbol) never follow */
    this._position(st);
  },

  _dragUp() {
    const d = this._drag;
    if (!d) return;
    this._drag = null;
    document.body.classList.remove('oc-dragging');
    if (d.moved && !d.frozen) {
      /* ROUND120: persist under the DRAGGED symbol's key — each symbol's
         panel keeps its own place across restarts and layout switches */
      this._posSaveFor(d.st.sym, this._pos);                    // survives restarts
    } else if (d.kind === 'pill') {
      this._setMin(false);                 // a clean press on the pill restores
    }
  },

  /* ---------- minimize / pin / confirm-lock (global, persisted) ----------
     ROUND120: visibility is designation-gated too — a pane that does not
     own its symbol's panel stays hidden no matter the minimize state. */
  _setMin(v) {
    this._min = !!v;
    U.lsSet(K.min, this._min);
    for (const pane of App.panes) {
      const st = this._st(pane);
      if (!st) continue;
      this._visPaint(st);
      st.lastKey = null;                   // the newly visible half needs a place
    }
    this._positionAll();
  },

  _setPin(v) {
    this._pin = !!v;
    U.lsSet(K.pin, this._pin);
    for (const pane of App.panes) {
      const st = this._st(pane);
      if (!st) continue;
      st.pinBtn.classList.toggle('oc-on', this._pin);
      st.pinBtn.title = this._pin
        ? 'Position pinned — click to unpin and drag freely'
        : 'Pin the widget here (blocks dragging)';
      st.grip.title = this._pin ? 'Pinned — click the pin to move again' : 'Drag to move the widget';
    }
  },

  /* ---------- test hook (the sanctioned debug facade) ---------- */
  /* a plain snapshot of the per-pane draft state — the E2E repro reads this
     instead of poking at LWC internals. setArmed stays in the shape (always
     false) so older harnesses keep parsing the snapshot. */
  _dbg(pane) {
    const st = this._map.get(pane);
    if (!st) return null;
    const d = st.draft;
    return {
      sym: st.sym,
      mode: this._rmode,
      route: TradeRoute.mode,
      vals: Object.assign({}, this._rvals),
      plunit: this._plunit,
      collapsed: this._collapsed,
      setArmed: false,
      draft: d ? {
        pend: d.pend, side: d.side, entry: d.entry, sl: d.sl, tp: d.tp,
        lines: { e: !!d.lines.e, s: !!d.lines.s, t: !!d.lines.t },
      } : null,
    };
  },
};

export { OneClick };
