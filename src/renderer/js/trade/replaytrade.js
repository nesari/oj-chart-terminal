/**
 * ROUND86 (user request) — Replay demo trading. ROUND112 — the SAME demo
 * engine now also trades the LIVE MARKET (demo account on live prices),
 * selected by the merged Trading tab's Demo/Live switch (trade/route.js).
 *
 * A fully CLIENT-SIDE simulated broker so the user can take and manage
 * trades with a demo account whose balance and leverage are user-
 * configurable. It works on BOTH data sources (broker history and the
 * demo-server history) because it prices off the chart's own replay data
 * when Bar Replay drives the charts, and off the live tick stream when it
 * does not. The real trading bridge (trade/*) is NOT touched: this module
 * keeps its own account, positions, orders and history.
 *
 * ROUND112 additions:
 *   · LIVE-MARKET SOURCE — with the switch on Demo and Bar Replay off, the
 *     bid/ask come from the live tick stream (Trade.quotes) and the engine
 *     evaluates on a 300ms timer (replay still drives it frame-by-frame).
 *   · CASH HISTORY — every balance edit is recorded as a DEPOSIT or a
 *     WITHDRAWAL row ("Cash" tab) so performance can be reported later;
 *     the account snapshot (balance · tx · closed history · tickets)
 *     persists in localStorage and survives restarts.
 *   · ROUTE DELEGATE — quoteOf/positions/profitOf/equity/available plus
 *     placeMarketOrder/placePendingOrder power trade/route.js, so the
 *     chart "Trade" panel works in all three modes (live broker, demo on
 *     live market, demo on Bar Replay).
 *
 * Feature parity with the real mode (user: "دقیقا مثل ویژگی های حالت Real
 * بروکر"): market orders with optional SL/TP, the four pending types with
 * MT5 trigger sides, stop-out on margin level, partial close, close all,
 * SL/TP + order re-price, chart Entry/SL/TP/pending price lines with the
 * 1s-dwell money tooltip and full drag support (entry drag = MT5 rule:
 * BUY up=TP / down=SL, mirrored for SELL).
 *
 * Pricing: bid = the replay price of the symbol's chart pane (forming
 * candle close, else last completed close); ask = bid + spread points
 * (configurable, default 0). P/L uses the exact MT5 formula via the
 * symbol spec (tick_value/tick_size) cached by the real bridge.
 *
 * The engine evaluates on every replay frame (App.replayTradeHook.onFrame,
 * called by panels/replay.js) and additionally checks every freshly
 * COMPLETED bar's high/low so intrabar SL/TP touches between frames are
 * never missed (SL fires first when both levels sit in one bar).
 *
 * @module trade/replaytrade
 */
import { App } from '../../../core/state.js';
import { U } from '../core/util.js';
import { UI } from '../drawing/ui.js';
import { icon } from '../ui/icons.js';
import { Replay } from '../panels/replay.js';
import { Trade, OT, OT_NAME } from './state.js';
import { TradeRoute } from './route.js';
import { TradeModify } from './modify.js';
import {
  mround, clampVol, demoProfit, demoMargin, baseUsdRate,
  pendingTriggered, barStopsHit, priceStopsHit, stopsCheck,
} from '../../../core/demo-math.js';

const HIT_PX = 9;
const SYNC_MS = 700;
const LIVE_EVAL_MS = 300;    // ROUND112: engine pace when live market drives the prices
const TIP_DELAY = 1000;      // same 1s dwell rule as the real overlay (ROUND85E)
const K_CFG = 'mt5_rp_demo_cfg';
const K_ACCT = 'mt5_rp_demo_acct';   // ROUND112: persisted account snapshot
const C = {
  entry: '#2962ff', sl: '#f23645', tp: '#089981', order: '#ff9800',
  dragBg: 'rgba(41,98,255,.92)',
};

function dim(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

function fmtMoney(v) {
  if (v == null || !isFinite(v)) return '—';
  const r = Math.round(v * 100) / 100;
  return (r > 0 ? '+$' : (r < 0 ? '-$' : '$')) + Math.abs(r).toFixed(2);
}

/* compact account-currency format for the narrow KPI chips — cents only
   below 1000 so "$10000" never truncates into a misleading "$1,000…" */
function fmtUsd(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  const body = a >= 1000 ? a.toFixed(0) : a.toFixed(2);
  return (v < 0 ? '-$' : '$') + body;
}

/* ---------- state ---------- */

const D = {
  cfg: null,             // {deposit, leverage, spreadPts, stopOutPct, volume}
  balance: 0,
  positions: [],         // {ticket, symbol, type, volume, open, time, sl, tp}
  orders: [],            // {ticket, symbol, type, volume, price, time, sl, tp}
  history: [],           // {ticket, symbol, type, volume, open, close, profit, time, reason}
  tx: [],                // ROUND112: {kind:'dep'|'with', amount, at, balance, replay}
  seq: 500001,
  live: false,           // Bar Replay currently drives the prices
  tab: 'pos',
  lastBar: {},           // symbol -> last seen completed-bar time
  onChange: [],
  _map: new WeakMap(),   // pane -> overlay line state
  _drag: null,
  _lastEval: 0,
  _saveT: null,          // ROUND112: debounced account snapshot writer
  _autoSw: false,        // ROUND112: replay auto-switch toast fired once
  /* ROUND124 — multi-window ledger state:
     _shadowBal  the on-disk balance THIS engine last contributed to; the
                 next save applies (balance - _shadowBal) as MY delta on top
                 of the CURRENT on-disk balance, so concurrent closes in two
                 windows (host + detached) both survive
     _forceSave  the next write REPLACES the snapshot absolutely (account
                 reset / fresh ledger) instead of merging */
  _shadowBal: 0,
  _forceSave: false,
};

/* the wall/chart clock a new record is stamped with: replay time when the
   replay drives the charts (backtest reporting), wall clock otherwise.
   ROUND128 (user report — the on-chart history marked trades on the WRONG
   candles): the chart's candles are stamped in BROKER SERVER wall time
   (true-UTC + feed.serverOff), while this clock returned raw device
   Date.now()/1000 — a broker offset of +2h/+3h shifted every demo deal by
   dozens of bars, so the entry/exit markers landed on other candles than
   the ones the user actually traded. The stamp now rides the SAME base the
   chart axis uses (replay time already was a chart stamp and is kept). */
function nowT() {
  if (Replay.isActive()) return Math.floor(Replay.cursor() || 0);
  const off = (App.feed && App.feed.serverOff) || 0;
  return Math.floor(Date.now() / 1000) + off;
}

function loadCfg() {
  const def = { deposit: 10000, leverage: 100, spreadPts: 0, stopOutPct: 50, volume: 0.10 };
  let c = null;
  try { c = U.lsGet(K_CFG, null); } catch (e) {}
  D.cfg = Object.assign(def, c && typeof c === 'object' ? c : {});
  D.cfg.deposit = num(D.cfg.deposit, 10000, 1, 1e9);
  D.cfg.leverage = num(D.cfg.leverage, 100, 1, 100000);
  D.cfg.spreadPts = num(D.cfg.spreadPts, 0, 0, 1e6);
  D.cfg.stopOutPct = num(D.cfg.stopOutPct, 50, 1, 100);
  D.cfg.volume = num(D.cfg.volume, 0.1, 0.0001, 1e6);
  loadAcct();
}
function num(v, def, min, max) {
  v = Number(v);
  if (!isFinite(v)) return def;
  return Math.max(min, Math.min(max, v));
}
function saveCfg() {
  try { U.lsSet(K_CFG, D.cfg); } catch (e) {}
}

/* ---------- ROUND112 account snapshot persistence ----------
 * balance + cash tx + closed history + the ticket counter survive
 * restarts, so the demo account is a real ledger for later performance
 * reports (the user: "برای مرحله بعد که گزارش گیری از عملکردش باشه"). */
function loadAcct() {
  let a = null;
  try { a = JSON.parse(U.lsGet(K_ACCT, 'null')); } catch (e) { a = null; }
  if (a && typeof a === 'object') {
    D.balance = num(a.balance, D.cfg.deposit, 0, 1e12);
    D.seq = num(a.seq, 500001, 500001, 1e9);
    D.tx = Array.isArray(a.tx) ? a.tx.slice(-500) : [];
    if (Array.isArray(a.history)) D.history = a.history.slice(0, 200);
  } else {
    D.balance = D.cfg.deposit;   // fresh account starts at the deposit
  }
  /* ROUND124: the merge baseline starts at whatever we just loaded */
  D._shadowBal = D.balance;
}

function saveAcct() {
  if (D._saveT) return;
  D._saveT = setTimeout(() => {
    D._saveT = null;
    try {
      /* ROUND124 — the snapshot write became a MERGE (multi-window ledger).
         A detached window runs its OWN demo engine on the SAME localStorage
         ledger (the float Trade panel boots there now). A blind write would
         stomp the other window's newer balance/history/tx with this
         window's older in-memory copy — e.g. a +$50 close in the main
         window erased by a +$30 close saved from a detached window that
         still held the pre-close balance. The rules now:
           · balance = CURRENT on-disk balance + MY delta since my last
             write (D.balance - D._shadowBal) — additive, so concurrent
             closes in two windows both survive;
           · history = union by ticket (my new rows appended, newest first);
           · tx      = union by identity (wall + amount);
           · seq     = max(mine, on-disk);
         A FORCED write (reset) replaces absolutely and re-bases the shadow. */
      let cur = null;
      try { cur = JSON.parse(U.lsGet(K_ACCT, 'null')); } catch (e) { cur = null; }
      if (D._forceSave || !cur || typeof cur !== 'object' || !isFinite(Number(cur.balance))) {
        U.lsSet(K_ACCT, JSON.stringify({
          balance: D.balance, seq: D.seq, tx: D.tx.slice(-500), history: D.history.slice(0, 200),
        }));
        D._shadowBal = D.balance;
        D._forceSave = false;
        return;
      }
      const hist = Array.isArray(cur.history) ? cur.history.slice(0, 200) : [];
      const seen = new Set(hist.map((h) => String(h && h.ticket)));
      for (const h of D.history) {
        const id = String(h && h.ticket);
        if (seen.has(id)) continue;
        seen.add(id);
        hist.push(h);
      }
      hist.sort((a, b) => ((b && b.time) || 0) - ((a && a.time) || 0));
      const txs = Array.isArray(cur.tx) ? cur.tx.slice(-500) : [];
      const tseen = new Set(txs.map((t) => ((t && t.wall) || 0) + '|' + ((t && t.amount) || 0)));
      for (const t of D.tx) {
        const id = ((t && t.wall) || 0) + '|' + ((t && t.amount) || 0);
        if (tseen.has(id)) continue;
        tseen.add(id);
        txs.push(t);
      }
      txs.sort((a, b) => ((a && a.wall) || 0) - ((b && b.wall) || 0));
      const myDelta = Math.round((D.balance - (isFinite(D._shadowBal) ? D._shadowBal : D.balance)) * 100) / 100;
      const mergedBal = Math.round((Number(cur.balance) + myDelta) * 100) / 100;
      const mergedSeq = Math.max(Number(cur.seq) || 0, D.seq);
      U.lsSet(K_ACCT, JSON.stringify({
        balance: mergedBal, seq: mergedSeq, tx: txs.slice(-500), history: hist.slice(0, 200),
      }));
      D._shadowBal = mergedBal;
      if (mergedSeq > D.seq) D.seq = mergedSeq;
    } catch (e) {}
  }, 400);
}

/* record a deposit (+) / withdrawal (−) — the balance was ALREADY moved */
function recordTx(delta) {
  const kind = delta > 0 ? 'dep' : 'with';
  D.tx.push({
    kind, amount: Math.round(Math.abs(delta) * 100) / 100,
    at: nowT(), wall: Date.now(), balance: Math.round(D.balance * 100) / 100,
    replay: Replay.isActive(),
  });
  if (D.tx.length > 500) D.tx.length = 500;
  saveAcct();
}

function changed() {
  for (const f of D.onChange) { try { f(); } catch (e) {} }
  try { ReplayTrade.sync(); } catch (e) {}
  try { renderPanel(); } catch (e) {}
}

function notify(msg, kind) {
  UI.toast('Replay Trading: ' + msg, kind === 'warn' ? 'warn' : (kind === 'err' ? 'err' : 'ok'));
  try {
    if (window.electronAPI && window.electronAPI.notify) window.electronAPI.notify('Replay Trading', msg);
  } catch (e) {}
}

/* ---------- pricing ----------
 * ROUND112: two sources. Bar Replay active → the replay chart price (as
 * before, with the optional synthetic spread). Bar Replay off → the LIVE
 * tick stream's real bid/ask (demo on live market); if a symbol carries no
 * tick quote the chart's last close still works as a fallback. */

function chartPriceOf(symbol) {
  for (const pane of App.panes) {
    if (pane.symbol !== symbol) continue;
    if (pane._lastPartialClose != null && isFinite(pane._lastPartialClose)) return pane._lastPartialClose;
    const b = pane.bars && pane.bars[pane.bars.length - 1];
    if (b && isFinite(b.close)) return b.close;
  }
  return null;
}

function priceOf(symbol) {
  if (!Replay.isActive()) {
    const q = Trade.quote(symbol);
    if (q && q.bid > 0) return q.bid;
  }
  return chartPriceOf(symbol);
}

function spreadOf(symbol) {
  if (!Replay.isActive()) return 0;   // live quotes already carry the real spread
  const s = Trade.specSync(symbol);
  const pt = s && s.point > 0 ? s.point : 0;
  const cfgPts = Number(D.cfg.spreadPts) || 0;
  if (cfgPts > 0 && pt > 0) return cfgPts * pt;
  return 0;   // chart price by default; the user can add synthetic spread
}

function quoteOf(symbol) {
  if (!Replay.isActive()) {
    const q = Trade.quote(symbol);
    if (q && q.bid > 0 && q.ask > 0) return { bid: q.bid, ask: q.ask };
  }
  const p = chartPriceOf(symbol);
  if (!(p > 0)) return null;
  return { bid: p, ask: p + spreadOf(symbol) };
}

/* which source feeds the prices right now: 'replay' | 'live' | null */
function sourceOf() {
  if (Replay.isActive()) return 'replay';
  const pane = App.activePane;
  const q = Trade.quote(pane ? pane.symbol : '');
  if (q && q.bid > 0) return 'live';
  return null;
}

/* can the demo account accept an order right now? (route delegate guard) */
function available() {
  if (!TradeRoute.isDemo()) return { ok: false, reason: 'Demo trading is off — switch the Trading panel to Demo' };
  if (Replay.isActive()) return { ok: true };
  const pane = App.activePane;
  const q = Trade.quote(pane ? pane.symbol : '');
  if (q && q.bid > 0 && q.ask > 0) return { ok: true };
  return { ok: false, reason: 'No price source — start Bar Replay or wait for live quotes' };
}

function fmtP(symbol, v) {
  const s = Trade.specSync(symbol);
  let dg = s && s.digits != null ? s.digits : null;
  if (dg == null) {
    const pane = App.panes.find((p) => p.symbol === symbol);
    dg = pane && pane.digits != null ? pane.digits : 5;
  }
  return Number(v).toFixed(dg);
}

function ensureSpecs() {
  const syms = new Set();
  for (const p of D.positions) syms.add(p.symbol);
  for (const o of D.orders) syms.add(o.symbol);
  const pane = App.activePane;
  if (pane) syms.add(pane.symbol);
  for (const s of syms) {
    if (!Trade.specSync(s)) { try { Trade.spec(s).catch(() => {}); } catch (e) {} }
  }
}

function marginForPos(symbol, pos) {
  const spec = Trade.specSync(symbol);
  const rate = baseUsdRate(symbol, priceOf(symbol) || (spec && spec.bid > 0 ? spec.bid : 0), (s) => {
    const x = Trade.specSync(s);
    return x && x.bid > 0 ? x : null;
  });
  return demoMargin(spec, pos, D.cfg.leverage, rate);
}

function floatingOf(pos) {
  const q = quoteOf(pos.symbol);
  if (!q) return 0;
  return demoProfit(Trade.specSync(pos.symbol), pos, pos.type === 0 ? q.bid : q.ask);
}

function account() {
  let float = 0, margin = 0;
  for (const pos of D.positions) {
    float += floatingOf(pos);
    margin += marginForPos(pos.symbol, pos);
  }
  const equity = D.balance + float;
  return {
    balance: D.balance, equity, margin, floating: float,
    free: equity - margin,
    level: margin > 0 ? (equity / margin) * 100 : 0,
  };
}

/* ---------- engine ---------- */

/* a fresh COMPLETED bar entered pane.bars -> check its high/low against the
   symbol's positions (catches intrabar touches between replay frames) */
function checkBarStops(pane) {
  const bars = pane.bars;
  if (!bars || !bars.length) return;
  const last = bars[bars.length - 1];
  const seen = D.lastBar[pane.symbol] || 0;
  if (last.time === seen) return;
  D.lastBar[pane.symbol] = last.time;
  if (!seen) return;                       // first sight = baseline only
  let n = 0;
  for (let i = bars.length - 1; i >= 0 && n < 60; i--, n++) {
    const b = bars[i];
    if (b.time <= seen) break;
    for (const pos of D.positions.slice()) {
      if (pos.symbol !== pane.symbol) continue;
      const hit = barStopsHit(pos, b);
      if (hit.sl) closePos(pos, pos.volume, 'sl', pos.sl);
      else if (hit.tp) closePos(pos, pos.volume, 'tp', pos.tp);
    }
  }
}

function activateOrder(o, q, t) {
  const buy = o.type === OT.BUY_LIMIT || o.type === OT.BUY_STOP;
  const posType = buy ? 0 : 1;
  const fill = (o.type === OT.BUY_LIMIT || o.type === OT.SELL_LIMIT) ? o.price : (buy ? q.ask : q.bid);
  const need = marginForPos(o.symbol, { volume: o.volume, open: fill });
  const a = account();
  if (need > a.free + 1e-9) {
    D.orders = D.orders.filter((x) => x.ticket !== o.ticket);
    notify('Order #' + o.ticket + ' deleted at activation — not enough money', 'warn');
    changed();
    return;
  }
  D.orders = D.orders.filter((x) => x.ticket !== o.ticket);
  D.positions.push({
    ticket: o.ticket, symbol: o.symbol, type: posType, volume: o.volume,
    open: fill, time: t, sl: o.sl || 0, tp: o.tp || 0,
  });
  notify('Pending order activated: ' + OT_NAME[o.type] + ' ' + o.symbol + ' ' + o.volume + ' @ ' + fmtP(o.symbol, fill), 'ok');
  changed();
}

function checkStopOut() {
  let guard = 0;
  while (guard++ < 20) {
    if (!D.positions.length) break;
    const a = account();
    if (!(a.margin > 0) || a.level > D.cfg.stopOutPct) break;
    let worst = null;
    for (const pos of D.positions) {
      const fl = floatingOf(pos);
      if (!worst || fl < worst.fl) worst = { pos, fl };
    }
    if (!worst) break;
    closePos(worst.pos, worst.pos.volume, 'stop-out');
    notify('STOP OUT — position #' + worst.pos.ticket + ' closed at ' + D.cfg.stopOutPct + '% margin level', 'warn');
  }
}

function evaluate() {
  ensureSpecs();
  for (const pane of App.panes) { try { checkBarStops(pane); } catch (e) {} }
  const t = nowT();
  for (const o of D.orders.slice()) {
    const q = quoteOf(o.symbol);
    if (q && pendingTriggered(o, q.bid, q.ask)) activateOrder(o, q, t);
  }
  for (const pos of D.positions.slice()) {
    const q = quoteOf(pos.symbol);
    if (!q) continue;
    const hit = priceStopsHit(pos, q.bid, q.ask);
    if (hit.sl) closePos(pos, pos.volume, 'sl', pos.sl);
    else if (hit.tp) closePos(pos, pos.volume, 'tp', pos.tp);
  }
  checkStopOut();
}

/* ---------- actions (all return {ok, ...|error}) ---------- */

function activeSymbol() {
  if (App.activePane) return App.activePane.symbol;
  const p = App.panes[0];
  return p ? p.symbol : null;
}

function market(symbol, type, volume, sl, tp) {
  const av = available();
  if (!av.ok) return { ok: false, error: av.reason };
  const q = quoteOf(symbol);
  if (!q) return { ok: false, error: 'No price for ' + symbol + ' yet' };
  const spec = Trade.specSync(symbol);
  const v = clampVol(spec, volume);
  if (!(v > 0)) return { ok: false, error: 'Invalid volume' };
  const fill = type === 0 ? q.ask : q.bid;
  const err = stopsCheck(spec, type, fill, sl || 0, tp || 0);
  if (err) return { ok: false, error: err };
  const need = marginForPos(symbol, { volume: v, open: fill });
  const a = account();
  if (need > a.free + 1e-9) {
    return { ok: false, error: 'Not enough money (need $' + need.toFixed(2) + ', free $' + a.free.toFixed(2) + ')' };
  }
  syncSeqFromDisk();   /* ROUND124: unique ticket across windows */
  const pos = {
    ticket: D.seq++, symbol, type, volume: v, open: fill,
    time: nowT(), sl: sl || 0, tp: tp || 0,
  };
  D.positions.push(pos);
  changed();
  return { ok: true, ticket: pos.ticket, price: fill };
}

function placePending(symbol, type, volume, price, sl, tp) {
  const av = available();
  if (!av.ok) return { ok: false, error: av.reason };
  if (![OT.BUY_LIMIT, OT.SELL_LIMIT, OT.BUY_STOP, OT.SELL_STOP].includes(type)) {
    return { ok: false, error: 'Unsupported pending type' };
  }
  const spec = Trade.specSync(symbol);
  const v = clampVol(spec, volume);
  if (!(v > 0)) return { ok: false, error: 'Invalid volume' };
  if (!(price > 0)) return { ok: false, error: 'Invalid price' };
  const err = stopsCheck(spec, type, price, sl || 0, tp || 0);
  if (err) return { ok: false, error: err };
  syncSeqFromDisk();   /* ROUND124: unique ticket across windows */
  const o = {
    ticket: D.seq++, symbol, type, volume: v, price,
    time: nowT(), sl: sl || 0, tp: tp || 0,
  };
  D.orders.push(o);
  changed();
  return { ok: true, ticket: o.ticket };
}

function closePos(pos, vol, reason, forcedPrice) {
  const q = quoteOf(pos.symbol);
  const price = forcedPrice != null && forcedPrice > 0
    ? forcedPrice
    : (q ? (pos.type === 0 ? q.bid : q.ask) : null);
  if (!(price > 0)) return false;
  const spec = Trade.specSync(pos.symbol);
  const v = Math.min(vol, pos.volume);
  const profit = demoProfit(spec, pos, price, v);
  D.balance += profit;
  /* ROUND120: the ledger row carries the position's OPEN time + the
     pre-close volume + the SL/TP of the moment, so the ToolBox History
     grid (and the chart layer) can show demo fragments exactly like the
     terminal: Time(open) · Volume(closed fragment) · S/L · T/P … */
  D.history.unshift({
    ticket: pos.ticket, symbol: pos.symbol, type: pos.type, volume: v,
    vol0: pos.volume, otime: pos.time, open: pos.open, close: price, profit,
    sl: pos.sl || 0, tp: pos.tp || 0,
    time: nowT(), reason: reason || 'manual',
  });
  if (D.history.length > 200) D.history.length = 200;
  saveAcct();
  const rest = mround(pos.volume - v, (spec && spec.vol_step > 0) ? spec.vol_step : 0.01);
  if (rest <= 0) D.positions = D.positions.filter((x) => x.ticket !== pos.ticket);
  else pos.volume = rest;
  if (reason === 'sl') notify('Stop loss hit — ' + pos.symbol + ' #' + pos.ticket + '  ' + fmtMoney(profit), profit >= 0 ? 'ok' : 'warn');
  else if (reason === 'tp') notify('Take profit hit — ' + pos.symbol + ' #' + pos.ticket + '  ' + fmtMoney(profit), 'ok');
  changed();
  return true;
}

function halfClose(pos) {
  const spec = Trade.specSync(pos.symbol);
  const step = spec && spec.vol_step > 0 ? spec.vol_step : 0.01;
  const min = spec && spec.vol_min > 0 ? spec.vol_min : 0.01;
  let v = mround(pos.volume / 2, step);
  if (v < min || pos.volume - v < min) v = pos.volume;
  closePos(pos, v, 'manual');
}

function closeAll(symbol) {
  for (const pos of D.positions.slice()) {
    if (symbol && pos.symbol !== symbol) continue;
    closePos(pos, pos.volume, 'close-all');
  }
}

function modifySLTP(ticket, sl, tp, opts) {
  const pos = D.positions.find((p) => p.ticket === ticket);
  if (!pos) return { ok: false, error: 'Position not found' };
  const spec = Trade.specSync(pos.symbol);
  const q = quoteOf(pos.symbol);
  const ref = q ? (pos.type === 0 ? q.bid : q.ask) : pos.open;
  let err = stopsCheck(spec, pos.type, ref, sl || 0, tp || 0);
  /* ROUND112 — break-even snap: the risk-free action targets the OPEN price,
     which on a spread-carrying quote sits on the illegal side of the close
     price (BUY SL at open=ask > bid). With opts.be (the 🛡 action) the SL
     snaps to the nearest LEGAL point (ref ∓ stops_level+1pt) no matter the
     spread — the simulator honours the intent; other callers get a small
     3pt courtesy window. */
  let slReq = sl || 0;
  const pt = spec && spec.point > 0 ? spec.point : 0;
  const stopsGap = (spec && spec.stops_level > 0 && pt > 0) ? spec.stops_level * pt : 0;
  /* the nearest LEGAL point — one point BEYOND stops_level: landing EXACTLY
     on stops_level races the binary representation (ref−gap can round a hair
     inside minDist → "SL too close") */
  const gap = stopsGap > 0 ? stopsGap + pt : pt;
  const beMode = !!(opts && opts.be);
  if (err && slReq > 0 && pt > 0 && ref > 0 &&
      (beMode || Math.abs(slReq - ref) <= pt * 3)) {
    slReq = Number((pos.type === 0 ? ref - gap : ref + gap).toFixed(spec.digits != null ? spec.digits : 5));
    err = stopsCheck(spec, pos.type, ref, slReq, tp || 0);
  }
  if (err) return { ok: false, error: err };
  pos.sl = slReq || 0;
  pos.tp = tp || 0;
  changed();
  return { ok: true };
}

function modifyOrder(ticket, price, sl, tp) {
  const o = D.orders.find((x) => x.ticket === ticket);
  if (!o) return { ok: false, error: 'Order not found' };
  const spec = Trade.specSync(o.symbol);
  if (!(price > 0)) return { ok: false, error: 'Invalid price' };
  const err = stopsCheck(spec, o.type, price, sl || 0, tp || 0);
  if (err) return { ok: false, error: err };
  o.price = price;
  o.sl = sl || 0;
  o.tp = tp || 0;
  changed();
  return { ok: true };
}

function cancelOrder(ticket) {
  const before = D.orders.length;
  D.orders = D.orders.filter((x) => x.ticket !== ticket);
  if (D.orders.length !== before) changed();
  return { ok: D.orders.length !== before };
}

function reset() {
  D.positions = [];
  D.orders = [];
  D.history = [];
  D.tx = [];
  D.seq = 500001;
  D.lastBar = {};
  D.balance = D.cfg.deposit;
  D._forceSave = true;   /* ROUND124: a reset REPLACES the shared ledger */
  saveAcct();
  changed();
}

/* ROUND124 — adopt the on-disk ticket counter before allocating one. Two
   windows share the ledger; each loads seq at boot, so a trade opened in
   the OTHER window (saved after this one booted) may have moved the counter
   forward. One cheap re-read per user action keeps tickets unique. */
function syncSeqFromDisk() {
  try {
    const a = JSON.parse(U.lsGet(K_ACCT, 'null'));
    if (a && typeof a === 'object' && isFinite(Number(a.seq)) && Number(a.seq) > D.seq) {
      D.seq = Number(a.seq);
    }
  } catch (e) {}
}

/* ---------- engine hook (called by panels/replay.js every frame) ---------- */

function onFrame() {
  const active = Replay.isActive();
  if (!active) {
    if (D.live) { D.live = false; changed(); }
    return;
  }
  if (!D.live) { D.live = true; changed(); }
  const now = performance.now();
  if (now - D._lastEval < 120) return;
  D._lastEval = now;
  try { evaluate(); } catch (e) {}
}

/* ======================================================================
 * chart overlay — Entry / SL / TP / pending price lines for the DEMO
 * positions (own WeakMap, adapted from trade/overlay.js; the real trade
 * overlay is untouched — both can coexist on the same chart).
 * ==================================================================== */

const ReplayTrade = {
  /* ROUND112 FIX (latent since ROUND86): the per-pane overlay state lived on
     D (where the engine keeps its own state) while every overlay method read
     this._map — undefined, so _syncPane threw at its first line and sync()'s
     try/catch silently swallowed it: the DEMO chart lines / hover tooltip /
     drag NEVER rendered. The engine tables worked; the chart half did not. */
  _map: new WeakMap(),   // pane -> overlay line state

  init() {
    if (this._syncTimer) return;
    loadCfg();
    this._syncTimer = setInterval(() => { try { this.sync(); } catch (e) {} }, SYNC_MS);
    setInterval(() => { try { this._updateTitles(); } catch (e) {} }, 900);
    setInterval(() => { try { this._updateLive(); } catch (e) {} }, 500);
    /* ROUND112: when Bar Replay is OFF the live tick stream drives the demo
       account — evaluate on a timer so SL/TP/pending/stop-out still fire
       (the replay path keeps its own frame hook below) */
    setInterval(() => {
      try {
        if (Replay.isActive()) return;                    // frame hook owns it
        if (!TradeRoute.isDemo()) return;                 // demo mode is off
        if (!D.positions.length && !D.orders.length) return;
        const now = performance.now();
        if (now - D._lastEval < LIVE_EVAL_MS) return;
        D._lastEval = now;
        evaluate();
      } catch (e) {}
    }, 120);
    document.addEventListener('mousemove', this._onMove.bind(this), true);
    document.addEventListener('mouseup', this._onUp.bind(this), true);
    buildPanel();
    renderPanel();
    /* panels/replay.js calls this on every replay frame (paused included) */
    App.replayTradeHook = { onFrame };
  },

  sync() {
    for (const pane of App.panes) {
      try { this._syncPane(pane); } catch (e) {}
    }
  },

  _state(pane) {
    let st = this._map.get(pane);
    if (!st) {
      /* ROUND117: `series` joins the state — the chart-type switch replaces
         pane.series and every price line dies with the old series (the same
         root cause ROUND116 fixed in trade/overlay.js; this overlay needed
         the identical self-heal: without it the DEMO pending/entry lines
         vanished on line/renko and never came back, even on candle). */
      st = { symbol: null, series: null, key: '', lines: [], dragReady: false, hlTicket: null };
      this._map.set(pane, st);
    }
    return st;
  },

  _clear(pane, st) {
    for (const l of st.lines) {
      /* ROUND128: remove through the OWNING series (same ghost-line fix as
         trade/overlay.js — after a series swap the old handles belong to
         the detached series and the pane.series removal silently no-oped). */
      const owner = l.ser || pane.series;
      try { owner.removePriceLine(l.pl); } catch (e) {
        try { pane.series.removePriceLine(l.pl); } catch (e2) {}
      }
    }
    st.lines = [];
    const tip = pane._rtdTip;
    if (tip) tip.style.display = 'none';
    const chip = pane._rtdChip;
    if (chip) chip.style.display = 'none';
  },

  _syncPane(pane) {
    if (!pane || !pane.series || !pane.series.createPriceLine) return;
    const st = this._state(pane);
    if (st.symbol !== pane.symbol) {
      this._clear(pane, st);
      st.symbol = pane.symbol;
      st.key = '';
    }
    /* ROUND117: a replaced series (any chart-type switch) must force a full
       rebuild on the NEW series — the structural key alone never changes, so
       the stale key left the pane with dead lines forever. */
    if (st.series !== pane.series) {
      st.series = pane.series;
      st.key = '';
    }
    /* ROUND112: the lines live while the DEMO MODE is on — over replay
       prices (backtest) or over the live chart (demo on live market).
       Frozen demo lines in LIVE mode would be misleading. */
    if (!TradeRoute.isDemo()) {
      if (st.lines.length) { this._clear(pane, st); st.key = ''; }
      return;
    }
    const positions = D.positions.filter((p) => p.symbol === pane.symbol);
    const orders = D.orders.filter((o) => o.symbol === pane.symbol);
    /* ROUND128 BELT+BRACES: no demo trades on this symbol -> no lines, ever */
    if (!positions.length && !orders.length && st.lines.length) {
      this._clear(pane, st);
      st.key = JSON.stringify([[], []]);
      return;
    }
    const key = JSON.stringify([positions.map(lightPos), orders.map(lightOrd)]);
    if (key === st.key) return;
    st.key = key;
    this._clear(pane, st);
    st.hlTicket = null;
    const L = LightweightCharts.LineStyle;
    const mk = (price, opts) => {
      const { _kind, _ticket, _ref, _ser, ...rest } = opts;
      try {
        const pl = pane.series.createPriceLine(Object.assign({
          price, lineWidth: 1, axisLabelVisible: true,
          lineStyle: L.Dashed, title: '',
        }, rest));
        st.lines.push({
          pl, price, kind: _kind, ticket: _ticket, ref: _ref, ser: _ser || pane.series,
          base: rest.color, axBase: rest.axisLabelColor || null,
        });
      } catch (e) {}
    };
    for (const p of positions) {
      const side = p.type === 0 ? 'BUY' : 'SELL';
      mk(p.open, {
        color: C.entry, lineStyle: L.Dashed,
        axisLabelVisible: true, axisLabelColor: C.entry, axisLabelTextColor: '#fff',
        title: this._entryTitle(p), _kind: 'entry', _ticket: p.ticket, _ref: p, _ser: pane.series,
      });
      if (p.sl > 0) mk(p.sl, {
        color: C.sl, title: '', axisLabelColor: C.sl, axisLabelTextColor: '#fff',
        _kind: 'sl', _ticket: p.ticket, _ref: p, _ser: pane.series,
      });
      if (p.tp > 0) mk(p.tp, {
        color: C.tp, title: '', axisLabelColor: C.tp, axisLabelTextColor: '#fff',
        _kind: 'tp', _ticket: p.ticket, _ref: p, _ser: pane.series,
      });
    }
    for (const o of orders) {
      mk(o.price, {
        color: C.order, lineStyle: L.Dotted,
        axisLabelColor: C.order, axisLabelTextColor: '#fff',
        title: (OT_NAME[o.type] || '') + ' ' + o.volume,
        _kind: 'order', _ticket: o.ticket, _ref: o, _ser: pane.series,
      });
    }
    this._ensureDragHandlers(pane, st);
  },

  _entryTitle(pos) {
    return (pos.type === 0 ? 'BUY' : 'SELL') + ' ' + pos.volume + '  ' + fmtMoney(floatingOf(pos));
  },

  _updateTitles() {
    for (const pane of App.panes) {
      const st = this._map.get(pane);
      if (!st || !st.lines) continue;
      for (const l of st.lines) {
        if (l.kind !== 'entry') continue;
        const pos = D.positions.find((p) => p.ticket === l.ticket);
        if (!pos) continue;
        try { l.pl.applyOptions({ title: this._entryTitle(pos) }); } catch (e) {}
      }
    }
  },

  /* ---------- cursor / 1s-dwell tooltip / family highlight ---------- */
  _setCursor(pane, cur) {
    const st = this._map.get(pane);
    const cv = pane.overlay;
    if (cur) {
      if (cv && cv.style) cv.style.cursor = cur;
      if (pane.root && pane.root.style) pane.root.style.cursor = cur;
      st.curOn = true;
    } else if (st.curOn) {
      if (cv && cv.style) cv.style.removeProperty('cursor');
      if (pane.root && pane.root.style) pane.root.style.removeProperty('cursor');
      st.curOn = false;
    }
  },

  _cursorSync(e, pane) {
    if (this._drag) return;
    const st = this._map.get(pane);
    if (!st) return;
    const hit = this._hit(pane, e.clientY);
    this._setCursor(pane, hit ? (hit.line.kind === 'entry' ? 'grab' : 'ns-resize') : null);
  },

  _tip(pane) {
    let tip = pane._rtdTip;
    if (!tip) {
      tip = U.el('div', 'trade-hover-tip', pane.root);
      tip.style.display = 'none';
      pane._rtdTip = tip;
    }
    return tip;
  },

  _lineMoney(l) {
    const pos = D.positions.find((p) => p.ticket === l.ticket);
    if (!pos) return null;
    if (l.kind === 'entry') return floatingOf(pos);
    if (l.kind === 'sl' || l.kind === 'tp') return demoProfit(Trade.specSync(pos.symbol), pos, l.price);
    return null;
  },

  _showTip(pane, st, l, y) {
    const tip = this._tip(pane);
    const pos = D.positions.find((p) => p.ticket === l.ticket);
    let dg = 5;
    const s = Trade.specSync(st.symbol);
    if (s && s.digits != null) dg = s.digits;
    let html = '';
    if (l.kind === 'entry' && pos) {
      const v = floatingOf(pos);
      html = '<div class="tht-row"><b>DEMO ' + (pos.type === 0 ? 'BUY' : 'SELL') + ' ' + pos.volume +
        '</b><span class="tht-dim">#' + pos.ticket + '</span></div>' +
        '<div class="tht-row tht-money ' + (v > 0.004 ? 'pos' : (v < -0.004 ? 'neg' : '')) + '">' +
        fmtMoney(v) + '</div>' +
        '<div class="tht-hint">↕ drag to set ' + (pos.type === 0 ? 'TP (up) / SL (down)' : 'SL (up) / TP (down)') + '</div>';
    } else if (l.kind === 'sl' || l.kind === 'tp') {
      const v = this._lineMoney(l);
      html = '<div class="tht-row"><b class="' + (l.kind === 'sl' ? 'tht-sl' : 'tht-tp') + '">DEMO ' +
        l.kind.toUpperCase() + ' ' + Number(l.price).toFixed(dg) + '</b>' +
        (pos ? '<span class="tht-dim">#' + pos.ticket + '</span>' : '') + '</div>' +
        (v != null ? '<div class="tht-row tht-money ' + (v > 0.004 ? 'pos' : (v < -0.004 ? 'neg' : '')) + '">' +
          fmtMoney(v) + '</div>' : '');
    } else if (l.kind === 'order') {
      const o = D.orders.find((x) => x.ticket === l.ticket);
      html = '<div class="tht-row"><b class="tht-ord">DEMO ' + (o ? (OT_NAME[o.type] || '') + ' ' + o.volume : 'Order') +
        '</b>' + (o ? '<span class="tht-dim">#' + o.ticket + '</span>' : '') + '</div>' +
        '<div class="tht-row tht-dim">' + Number(l.price).toFixed(dg) + '</div>';
    }
    tip.innerHTML = html;
    tip.className = 'trade-hover-tip tht-' + l.kind;
    tip.style.display = html ? '' : 'none';
    tip.style.top = (y + (pane.mainWrap ? pane.mainWrap.offsetTop : 0)) + 'px';
    this._highlight(pane, st, l.ticket);
  },

  _hideTip(pane, st) {
    const tip = pane._rtdTip;
    if (tip) tip.style.display = 'none';
    this._highlight(pane, st, null);
  },

  _clearDwell(pane, st) {
    if (st.dwell) { clearTimeout(st.dwell.timer); st.dwell = null; }
    this._hideTip(pane, st);
  },

  _highlight(pane, st, ticket) {
    if (st.hlTicket === ticket) return;
    st.hlTicket = ticket;
    for (const l of st.lines) {
      const on = ticket != null && l.ticket === ticket;
      const faded = ticket != null && !on;
      try {
        const o = faded
          ? { color: dim(l.base, .30) }
          : { color: l.base, lineWidth: on ? 2 : 1 };
        if (l.axBase) o.axisLabelColor = faded ? dim(l.axBase, .30) : l.axBase;
        l.pl.applyOptions(o);
      } catch (e) {}
    }
  },

  /* ---------- drag & hover ---------- */
  _ensureDragHandlers(pane, st) {
    if (st.dragReady) return;
    st.dragReady = true;
    const root = pane.root;
    root.addEventListener('mousedown', (e) => this._onDown(e, pane), true);
    root.addEventListener('mousemove', (e) => this._onHover(e, pane), true);
    /* ROUND128 (UI parity with the live overlay): right-click ON a demo
       trade line opens the SAME trade menu (Modify position · close ·
       break-even …) and DOUBLE-CLICK opens the SAME Modify modal — the
       demo account must feel identical to the live one. */
    root.addEventListener('contextmenu', (e) => this._onCtx(e, pane), true);
    root.addEventListener('dblclick', (e) => this._onDbl(e, pane), true);
    /* cursor arbiter on the engine canvas — registered AFTER the engine's
       and the real overlay's listeners, so the last write wins when a DEMO
       line is hit; silent no-op otherwise (per-state curOn guard) */
    if (pane.overlay) pane.overlay.addEventListener('mousemove', (e) => this._cursorSync(e, pane));
    root.addEventListener('mouseleave', () => {
      if (this._drag && this._drag.pane === pane) return;
      this._setCursor(pane, null);
      this._clearDwell(pane, st);
    });
  },

  /* ---------- ROUND128: demo trade menu + double-click (live parity) ------
     The demo overlay had NO trade context menu at all — right-clicking a
     demo trade line fell through to the chart menu, and there was no way
     into the Modify modal from the chart. Both now mirror trade/overlay.js,
     routed through TradeRoute so every action lands on the demo engine. */
  _closeMenu() {
    if (this._menu) { try { this._menu.remove(); } catch (e) {} this._menu = null; }
    if (this._menuOff) { this._menuOff(); this._menuOff = null; }
  },

  _onCtx(e, pane) {
    const st = this._map.get(pane);
    if (!st || !st.lines.length) return;
    const hit = this._hit(pane, e.clientY);
    if (!hit) return;                       /* not on a line -> chart menu */
    e.preventDefault();
    e.stopPropagation();
    this._clearDwell(pane, st);
    this._openMenu(e.clientX, e.clientY, pane, st, hit.line);
  },

  _onDbl(e, pane) {
    const st = this._map.get(pane);
    if (!st || !st.lines.length) return;
    const hit = this._hit(pane, e.clientY);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    this._clearDwell(pane, st);
    this._closeMenu();
    TradeModify.open(hit.line.kind === 'order' ? 'ord' : 'pos', hit.line.ticket);
  },

  _openMenu(cx, cy, pane, st, line) {
    this._closeMenu();
    const pos = D.positions.find((p) => p.ticket === line.ticket);
    const ord = pos ? null : D.orders.find((o) => o.ticket === line.ticket);
    if (!pos && !ord) return;
    const s = Trade.specSync(pane.symbol);
    const dg = s ? s.digits : 5;
    const items = [];
    const fail = (what) => (err) => {
      UI.toast(what + ' rejected: ' + ((err && err.message) || ''), '');
      this.sync();
    };
    if (pos) {
      const side = pos.type === 0 ? 'BUY' : 'SELL';
      items.push({ head: side + ' ' + pos.volume + ' ' + pos.symbol + '  ·  #' + pos.ticket });
      items.push({ label: 'Modify position', run: () => TradeModify.open('pos', pos.ticket) });
      items.push({
        label: 'Close position (' + fmtMoney(floatingOf(pos)) + ')', danger: true,
        run: () => TradeRoute.close(pos.ticket, 0)
          .then(() => UI.toast('Close sent — #' + pos.ticket, 'ok'))
          .catch(fail('Close')),
      });
      const step = (s && s.vol_step) || 0.01;
      const vmin = (s && s.vol_min) || 0.01;
      const half = Math.max(vmin, Math.round((pos.volume / 2) / step) * step);
      if (half < pos.volume) {
        items.push({
          label: 'Close half (' + Number(half.toFixed(2)) + ' lots)',
          run: () => TradeRoute.close(pos.ticket, Number(half.toFixed(2)))
            .then(() => UI.toast('Partial close sent — #' + pos.ticket, 'ok'))
            .catch(fail('Partial close')),
        });
      }
      const be = Number(pos.open.toFixed(dg));
      const beDone = pos.sl > 0 && Math.abs(pos.sl - be) < (s ? s.point / 2 : 1e-9);
      items.push({
        label: 'Stop loss to break-even (' + be.toFixed(dg) + ')', disabled: beDone,
        run: () => TradeRoute.modifySLTP(pos.ticket, be, pos.tp || 0)
          .then(() => UI.toast('SL moved to break-even', 'ok'))
          .catch(fail('SL')),
      });
      if (pos.sl > 0) {
        items.push({
          label: 'Remove stop loss',
          run: () => TradeRoute.modifySLTP(pos.ticket, 0, pos.tp || 0)
            .then(() => UI.toast('SL removed', 'ok')).catch(fail('SL')),
        });
      }
      if (pos.tp > 0) {
        items.push({
          label: 'Remove take profit',
          run: () => TradeRoute.modifySLTP(pos.ticket, pos.sl || 0, 0)
            .then(() => UI.toast('TP removed', 'ok')).catch(fail('TP')),
        });
      }
    } else {
      items.push({ head: (OT_NAME[ord.type] || 'Order') + ' ' + ord.volume + ' ' + ord.symbol + '  ·  #' + ord.ticket });
      items.push({ label: 'Modify order', run: () => TradeModify.open('ord', ord.ticket) });
      items.push({
        label: 'Cancel order', danger: true,
        run: () => TradeRoute.cancel(ord.ticket)
          .then(() => UI.toast('Cancel sent — #' + ord.ticket, 'ok'))
          .catch(fail('Cancel')),
      });
    }
    const menu = U.el('div', 'trade-ctx', document.body);
    for (const it of items) {
      if (it.head) {
        const h = U.el('div', 'trade-ctx-head', menu);
        h.textContent = it.head;
        continue;
      }
      const b = U.el('button', 'trade-ctx-item' + (it.danger ? ' danger' : ''), menu);
      b.textContent = it.label;
      if (it.disabled) { b.disabled = true; continue; }
      b.addEventListener('click', () => { this._closeMenu(); try { it.run(); } catch (er) {} });
    }
    this._menu = menu;
    const w = menu.offsetWidth || 190, h = menu.offsetHeight || 120;
    menu.style.left = Math.max(8, Math.min(cx, window.innerWidth - w - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(cy, window.innerHeight - h - 8)) + 'px';
    this._highlight(pane, st, line.ticket);
    const off = (ev) => {
      if (ev && ev.type === 'keydown' && ev.key !== 'Escape') return;
      if (ev && ev.type === 'mousedown' && menu.contains(ev.target)) return;
      this._closeMenu();
      this._highlight(pane, st, null);
    };
    setTimeout(() => {
      document.addEventListener('mousedown', off, true);
      document.addEventListener('keydown', off, true);
      window.addEventListener('blur', off);
    }, 0);
    this._menuOff = () => {
      document.removeEventListener('mousedown', off, true);
      document.removeEventListener('keydown', off, true);
      window.removeEventListener('blur', off);
    };
  },

  _mainY(pane, clientY) {
    const r = pane.mainWrap.getBoundingClientRect();
    return clientY - r.top;
  },

  _hit(pane, clientY) {
    const st = this._map.get(pane);
    if (!st || !st.lines || !st.lines.length) return null;
    const y = this._mainY(pane, clientY);
    let best = null;
    for (const l of st.lines) {
      let ly = null;
      try { ly = pane.series.priceToCoordinate(l.price); } catch (e) { ly = null; }
      if (ly == null || !isFinite(ly)) continue;
      const d = Math.abs(ly - y);
      if (d <= HIT_PX && (!best || d < best.d)) best = { line: l, d, y: ly };
    }
    return best;
  },

  _onHover(e, pane) {
    if (this._drag) return;
    const st = this._map.get(pane);
    if (!st) return;
    const hit = this._hit(pane, e.clientY);
    if (!hit) {
      if (st.dwell) this._clearDwell(pane, st);
      return;
    }
    const key = hit.line.kind + '#' + hit.line.ticket;
    if (st.dwell && st.dwell.key === key) {
      st.dwell.cy = e.clientY;
      const tip = pane._rtdTip;
      if (tip && tip.style.display !== 'none') {
        tip.style.top = (hit.y + (pane.mainWrap ? pane.mainWrap.offsetTop : 0)) + 'px';
      }
      return;
    }
    this._clearDwell(pane, st);
    st.dwell = { key, cy: e.clientY, timer: setTimeout(() => this._dwellFire(pane, st, key), TIP_DELAY) };
  },

  _dwellFire(pane, st, key) {
    if (this._drag || !st.dwell || st.dwell.key !== key) return;
    const hit = this._hit(pane, st.dwell.cy);
    if (!hit || hit.line.kind + '#' + hit.line.ticket !== key) { this._clearDwell(pane, st); return; }
    this._showTip(pane, st, hit.line, hit.y);
  },

  _onDown(e, pane) {
    if (e.button !== 0 || e.altKey) return;
    const st = this._map.get(pane);
    const hit = this._hit(pane, e.clientY);
    if (!hit || !st) return;
    e.preventDefault();
    e.stopPropagation();
    this._clearDwell(pane, st);
    /* ROUND128: clean up a stale drag first (missed mouseup) — never leak
       the previous drag's ghost/chip when this._drag is overwritten */
    if (this._drag) this._cancelDrag();
    const { line } = hit;
    let saved = null;
    try {
      const co = pane.chart.options();
      saved = { hs: co.handleScroll, hsc: co.handleScale };
      pane.chart.applyOptions({ handleScroll: false, handleScale: false });
    } catch (er) { saved = null; }
    this._drag = {
      pane, st, line, kind: line.kind, ticket: line.ticket,
      origPrice: line.price, saved,
      chip: this._chip(pane),
      ghost: null, target: null,
    };
    this._setCursor(pane, line.kind === 'entry' ? 'grabbing' : 'ns-resize');
    this._highlight(pane, st, line.ticket);
    this._onMove(e);
  },

  _chip(pane) {
    let chip = pane._rtdChip;
    if (!chip) {
      chip = U.el('div', 'trade-drag-chip', pane.root);
      chip.style.display = 'none';
      pane._rtdChip = chip;
    }
    return chip;
  },

  _entryTarget(pos, price) {
    const above = price >= pos.open;
    return pos.type === 0 ? (above ? 'tp' : 'sl') : (above ? 'sl' : 'tp');
  },

  _onMove(e) {
    const d = this._drag;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const pane = d.pane;
    let price = null;
    try { price = pane.series.coordinateToPrice(this._mainY(pane, e.clientY)); } catch (er) { price = null; }
    if (price == null || !isFinite(price)) return;
    const s = Trade.specSync(pane.symbol);
    const dg = s && s.digits != null ? s.digits : 5;
    price = Number(price.toFixed(dg));
    d.price = price;

    if (d.kind === 'entry') {
      const pos = D.positions.find((p) => p.ticket === d.ticket);
      if (!pos) { this._cancelDrag(); return; }
      const target = this._entryTarget(pos, price);
      d.target = target;
      const col = target === 'sl' ? C.sl : C.tp;
      if (!d.ghost) {
        try {
          d.ghost = pane.series.createPriceLine({
            price, color: col, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted,
            axisLabelVisible: true, axisLabelColor: col, axisLabelTextColor: '#fff', title: '',
          });
        } catch (er) { d.ghost = null; }
      } else {
        try { d.ghost.applyOptions({ price, color: col, axisLabelColor: col }); } catch (er) {}
      }
      const money = demoProfit(Trade.specSync(pos.symbol), pos, price);
      const label = target.toUpperCase() + ' ' + price.toFixed(dg) + '  ' + fmtMoney(money);
      if (d.chip) {
        d.chip.className = 'trade-drag-chip tdc-' + target;
        d.chip.textContent = 'DEMO ' + label;
      }
    } else {
      try { d.line.pl.applyOptions({ price }); } catch (er) {}
      const label = (d.kind === 'sl' ? 'SL' : d.kind === 'tp' ? 'TP' : 'Order') + ' → ' + price.toFixed(dg);
      if (d.chip) {
        d.chip.className = 'trade-drag-chip';
        d.chip.textContent = 'DEMO ' + label;
      }
    }
    let y = null;
    try { y = pane.series.priceToCoordinate(price); } catch (er) { y = null; }
    if (d.chip) {
      d.chip.style.display = y != null && isFinite(y) ? '' : 'none';
      d.chip.style.top = (y + (pane.mainWrap ? pane.mainWrap.offsetTop : 0)) + 'px';
    }
  },

  _cancelDrag() {
    const d = this._drag;
    if (!d) return;
    try {
      if (d.saved) d.pane.chart.applyOptions({ handleScroll: d.saved.hs, handleScale: d.saved.hsc });
    } catch (er) {}
    if (d.ghost) { try { d.pane.series.removePriceLine(d.ghost); } catch (er) {} }
    if (d.chip) d.chip.style.display = 'none';
    this._setCursor(d.pane, null);
    this._highlight(d.pane, d.st, null);
    this._drag = null;
  },

  _onUp(e) {
    const d = this._drag;
    if (!d) return;
    e.preventDefault();
    try {
      if (d.saved) d.pane.chart.applyOptions({ handleScroll: d.saved.hs, handleScale: d.saved.hsc });
    } catch (er) {}
    if (d.ghost) { try { d.pane.series.removePriceLine(d.ghost); } catch (er) {} }
    if (d.chip) d.chip.style.display = 'none';
    this._setCursor(d.pane, null);
    this._highlight(d.pane, d.st, null);
    this._drag = null;
    const pane = d.pane;
    const s = Trade.specSync(pane.symbol);
    const dg = s && s.digits != null ? s.digits : 5;
    const price = d.price != null ? d.price : d.origPrice;

    if (d.kind === 'entry') {
      const pos = D.positions.find((p) => p.ticket === d.ticket);
      if (!pos || d.target == null) { this.sync(); return; }
      const minMove = (s && s.point > 0) ? s.point / 2 : 1e-9;
      if (Math.abs(price - pos.open) < minMove) return;   // click, not a move
      const px = Number(price.toFixed(dg));
      const sl = d.target === 'sl' ? px : (pos.sl || 0);
      const tp = d.target === 'tp' ? px : (pos.tp || 0);
      const r = modifySLTP(pos.ticket, sl, tp);
      if (r.ok) UI.toast('DEMO ' + d.target.toUpperCase() + ' set to ' + px.toFixed(dg), 'ok');
      else { UI.toast('DEMO ' + d.target.toUpperCase() + ' rejected: ' + r.error, ''); this.sync(); }
      return;
    }

    if (Math.abs(price - d.origPrice) < 1e-12) return;   // click, not a move
    const px = Number(price.toFixed(dg));
    if (d.kind === 'sl' || d.kind === 'tp') {
      const pos = D.positions.find((p) => p.ticket === d.ticket);
      if (!pos) { this.sync(); return; }
      const sl = d.kind === 'sl' ? px : (pos.sl || 0);
      const tp = d.kind === 'tp' ? px : (pos.tp || 0);
      const r = modifySLTP(pos.ticket, sl, tp);
      if (r.ok) UI.toast('DEMO ' + (d.kind === 'sl' ? 'SL' : 'TP') + ' moved to ' + px.toFixed(dg), 'ok');
      else { UI.toast('DEMO ' + d.kind.toUpperCase() + ' rejected: ' + r.error, ''); this.sync(); }
    } else if (d.kind === 'order') {
      const ord = D.orders.find((o) => o.ticket === d.ticket);
      if (!ord) { this.sync(); return; }
      const r = modifyOrder(ord.ticket, px, ord.sl || 0, ord.tp || 0);
      if (r.ok) UI.toast('DEMO order re-priced to ' + px.toFixed(dg), 'ok');
      else { UI.toast('DEMO order rejected: ' + r.error, ''); this.sync(); }
    }
  },
};

function lightPos(p) { return [p.ticket, p.type, p.volume, p.open, p.sl, p.tp]; }
function lightOrd(o) { return [o.ticket, o.type, o.volume, o.price, o.sl, o.tp]; }

/* ======================================================================
 * right-panel UI — ROUND120 (user requests 6+7): the demo side panel was
 * REBUILT. The Trading tab now carries ONE unified order ticket
 * (trade/ticket.js, mode-aware via TradeRoute) for BOTH accounts, and the
 * Tool Box lists the ACTIVE account's positions / orders / history — the
 * demo history moved OUT of this panel into the Tool Box. What remains here
 * is the demo-specific part only: the account settings (gear) + the cash
 * ledger + the price-source status line.
 * ==================================================================== */

let E = {};

function buildPanel() {
  /* host: the demo extras block inside #tr-demo — the unified ticket is
     re-homed ABOVE it by TradeRoute._paintUI on every mode flip */
  let host = document.getElementById('tr-demo-extra');
  if (!host) {
    const tab = document.getElementById('tr-demo');
    if (!tab) return;
    host = document.createElement('div');
    host.id = 'tr-demo-extra';
    tab.appendChild(host);
  }
  if (host.dataset.built) return;
  host.dataset.built = '1';

  let levOpts = '';
  for (const l of [10, 20, 25, 33, 50, 100, 200, 500, 1000]) {
    levOpts += '<option value="' + l + '"' + (l === D.cfg.leverage ? ' selected' : '') + '>1:' + l + '</option>';
  }

  host.innerHTML =
    '<div class="rtt-status" id="rtt-status"><span class="dot"></span><span id="rtt-status-txt"></span></div>' +
    '<div class="rtt-sec hidden" id="rtt-cfg">' +
    '  <div class="rtt-sec-title">Demo account</div>' +
    '  <div class="rtt-row">' +
    '    <label class="rtt-lbl">Balance ($)<input type="number" id="rtt-balance" step="any" min="0" title="Edit and Apply — a higher value records a DEPOSIT, a lower one a WITHDRAWAL"></label>' +
    '    <label class="rtt-lbl">Leverage<select id="rtt-lev">' + levOpts + '</select></label>' +
    '  </div>' +
    '  <div class="rtt-row">' +
    '    <label class="rtt-lbl">Spread (points)<input type="number" id="rtt-spread" step="1" min="0"></label>' +
    '    <label class="rtt-lbl">Stop-out (%)<input type="number" id="rtt-stopout" step="1" min="1" max="100"></label>' +
    '  </div>' +
    '  <div class="rtt-row">' +
    '    <button class="rtt-mini" id="rtt-apply">Apply</button>' +
    '    <button class="rtt-mini danger" id="rtt-reset">Reset account</button>' +
    '  </div>' +
    '  <div class="rtt-hint">Balance edits are recorded as DEPOSIT / WITHDRAWAL in the cash ledger below (performance ledger, survives restarts). Leverage scales the required margin (1:500 needs 5× less than 1:100). Spread adds synthetic points in Bar Replay only — live prices carry their own. Positions, orders and the closed-trade history of this demo account live in the Tool Box at the bottom.</div>' +
    '</div>' +
    '<div class="rtt-sec" id="rtt-cash-sec">' +
    '  <div class="rtt-sec-title">Cash ledger</div>' +
    '  <div id="rtt-cash"></div>' +
    '</div>';

  E = {
    host,
    status: host.querySelector('#rtt-status'),
    statusTxt: host.querySelector('#rtt-status-txt'),
    cfgSec: host.querySelector('#rtt-cfg'),
    balance: host.querySelector('#rtt-balance'),
    lev: host.querySelector('#rtt-lev'),
    spread: host.querySelector('#rtt-spread'),
    stopout: host.querySelector('#rtt-stopout'),
    apply: host.querySelector('#rtt-apply'),
    reset: host.querySelector('#rtt-reset'),
    cash: host.querySelector('#rtt-cash'),
  };

  E.balance.value = String(Math.round(D.balance * 100) / 100);
  E.spread.value = String(D.cfg.spreadPts);
  E.stopout.value = String(D.cfg.stopOutPct);

  E.apply.addEventListener('click', () => {
    /* ROUND112 — a balance edit IS a cash movement: a higher value records a
       deposit, a lower one a withdrawal (the performance ledger) */
    const nb = num(E.balance.value, D.balance, 0, 1e12);
    const delta = Math.round((nb - D.balance) * 100) / 100;
    if (delta !== 0) {
      D.balance = Math.round((D.balance + delta) * 100) / 100;
      recordTx(delta);
      notify((delta > 0 ? 'Deposit' : 'Withdrawal') + ' ' + fmtMoney(delta) +
        ' — balance ' + fmtUsd(D.balance), 'ok');
    }
    D.cfg.leverage = num(E.lev.value, D.cfg.leverage, 1, 100000);
    D.cfg.spreadPts = num(E.spread.value, D.cfg.spreadPts, 0, 1e6);
    D.cfg.stopOutPct = num(E.stopout.value, D.cfg.stopOutPct, 1, 100);
    saveCfg();
    E.balance.value = String(Math.round(D.balance * 100) / 100);
    changed();
    UI.toast('Demo account settings applied', 'ok');
  });
  E.reset.addEventListener('click', () => {
    if (!window.confirm('Reset the demo account? Positions, orders, closed history and the cash ledger will be cleared.')) return;
    reset();
    E.balance.value = String(Math.round(D.balance * 100) / 100);
    UI.toast('Demo account reset — balance $' + D.balance.toFixed(2), 'ok');
  });

  /* gear button in the panel header toggles the account-settings section */
  const gear = document.getElementById('rtt-gear');
  if (gear && !gear.dataset.rttWired) {
    gear.dataset.rttWired = '1';
    gear.innerHTML = icon('gear');
    gear.title = 'Demo account settings (balance / leverage / spread / stop-out)';
    gear.addEventListener('click', () => E.cfgSec.classList.toggle('hidden'));
  }
}

/* the wall-clock variant of the record time (cash ledger rows) */
function fmtWall(ms) {
  if (!(ms > 0)) return '—';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

const TX_TAG = { dep: 'DEPOSIT', with: 'WITHDRAW' };

/* the status line — which source feeds the demo prices right now
   (painted by renderPanel AND by the 500ms refresh, so a mode/source flip
   is visible instantly, not only on the next engine event) */
function renderStatus() {
  if (!E.status) return;
  const src = sourceOf();
  E.status.classList.toggle('live', !!src);
  const txt =
    src === 'replay' ? 'REPLAY — demo prices follow the Bar Replay cursor'
      : src === 'live' ? 'LIVE MARKET — demo account on live prices'
        : (TradeRoute.isDemo() ? 'No price source — start Bar Replay or wait for live quotes'
          : 'Demo trading is off — switch to Demo above');
  if (E.statusTxt.textContent !== txt) E.statusTxt.textContent = txt;
}

function renderPanel() {
  if (!E.status) return;
  renderStatus();
  /* ROUND120: the demo extras now paint the settings + the cash ledger
     only — positions/orders/history live in the Tool Box (the dock lists
     the ACTIVE account through TradeRoute). */
  if (document.activeElement !== E.balance) {
    const bv = String(Math.round(D.balance * 100) / 100);
    if (E.balance.value !== bv) E.balance.value = bv;
  }
  let dep = 0, with_ = 0;
  for (const t of D.tx) { if (t.kind === 'dep') dep += t.amount; else with_ += t.amount; }
  let html;
  if (!D.tx.length) html = '<div class="rtt-empty">No deposits or withdrawals yet — edit the balance in the account settings (gear).</div>';
  else {
    html = '<div class="rtt-sum">deposits <b class="pos">+' + fmtUsd(dep) + '</b> · withdrawals <b class="neg">-' +
      fmtUsd(with_) + '</b> · balance <b>' + fmtUsd(D.balance) + '</b></div>';
    for (const t of D.tx.slice().reverse().slice(0, 80)) {
      html += '<div class="rtt-prow"><div class="rtt-l1">' +
        '<span class="rtt-reason">' + (TX_TAG[t.kind] || 'TX') + '</span>' +
        '<span class="rtt-pl ' + (t.kind === 'dep' ? 'pos' : 'neg') + '">' + (t.kind === 'dep' ? '+' : '-') + fmtUsd(t.amount) + '</span>' +
        '<span class="rtt-vol">bal ' + fmtUsd(t.balance) + '</span>' +
        '</div>' +
        '<div class="rtt-sub"><span>' + fmtWall(t.wall) + '</span>' +
        (t.replay ? '<span>Bar Replay</span>' : '<span>Live market</span>') + '</div></div>';
    }
  }
  if (E.cash) E.cash.innerHTML = html;
}

/* cheap per-500ms refresh: status line + the balance field (no rebuild) */
function updateLive() {
  if (!E.status) return;
  renderStatus();   // the source label follows the mode/replay instantly
  /* ROUND112 — Bar Replay is a BACKTEST: it always belongs to the demo
     account. Starting the replay while Live is selected flips the merged
     tab to Demo automatically (once per replay session, with a toast). */
  if (Replay.isActive() && !TradeRoute.isDemo()) {
    TradeRoute.set('demo', true);           // silent — our own toast explains
    if (!D._autoSw) {
      D._autoSw = true;
      UI.toast('Bar Replay — switched to Demo trading (backtest account)', 'ok');
    }
  } else if (!Replay.isActive() && D._autoSw) {
    D._autoSw = false;
  }
  /* the Balance field tracks the live balance (closed trades move it) —
     never while the user is editing it */
  if (document.activeElement !== E.balance) {
    const bv = String(Math.round(D.balance * 100) / 100);
    if (E.balance.value !== bv) E.balance.value = bv;
  }
}

ReplayTrade._updateLive = updateLive;

/* ---------- test/debug facade (window.__app.ReplayTrade) ---------- */
ReplayTrade.market = (symbol, type, volume, sl, tp) => market(symbol, type, volume, sl, tp);
ReplayTrade.placePending = (symbol, type, volume, price, sl, tp) => placePending(symbol, type, volume, price, sl, tp);

/* ---------- ROUND112 route-delegate API (trade/route.js) ---------- */
ReplayTrade.quoteOf = (symbol) => quoteOf(symbol);
ReplayTrade.positions = () => D.positions.slice();
ReplayTrade.orders = () => D.orders.slice();
ReplayTrade.profitOf = (pos) => floatingOf(pos);
ReplayTrade.equity = () => account().equity;
ReplayTrade.available = () => available();
ReplayTrade.placeMarketOrder = (p) =>
  market(p.symbol, p.orderType, p.volume, p.sl || 0, p.tp || 0);
ReplayTrade.placePendingOrder = (p) =>
  placePending(p.symbol, p.orderType, p.volume, p.price, p.sl || 0, p.tp || 0);
ReplayTrade.sourceOf = () => sourceOf();
ReplayTrade.closePosition = (ticket, volume) => {
  const p = D.positions.find((x) => x.ticket === ticket);
  return p ? { ok: closePos(p, volume || p.volume, 'manual') } : { ok: false, error: 'Position not found' };
};
ReplayTrade.closeAll = (symbol) => { closeAll(symbol); return { ok: true }; };
ReplayTrade.modifySLTP = (ticket, sl, tp, opts) => modifySLTP(ticket, sl, tp, opts);
ReplayTrade.modifyOrder = (ticket, price, sl, tp) => modifyOrder(ticket, price, sl, tp);
ReplayTrade.cancelOrder = (ticket) => cancelOrder(ticket);
/* ROUND117: route.js subscribes its onChange passthrough here, so demo
   state changes (place/activate/cancel/modify/close) reach the dock */
ReplayTrade.onEngineChange = (fn) => { D.onChange.push(fn); };
ReplayTrade.reset = () => { reset(); return { ok: true }; };
ReplayTrade.account = () => account();
ReplayTrade.state = () => ({
  positions: D.positions.slice(), orders: D.orders.slice(), history: D.history.slice(),
  tx: D.tx.slice(),
  balance: D.balance, live: D.live, cfg: Object.assign({}, D.cfg),
});
ReplayTrade.setCfg = (patch) => { Object.assign(D.cfg, patch || {}); saveCfg(); };

/* ---------- ROUND120: the demo ledger as MT5 deal rows (user requests 6+8)
   The Tool Box History tab and the chart history layer read the SAME
   deal-row shape the live bridge emits (provider _deal_row). Each demo
   close record synthesizes an IN + an OUT deal; partial closes already
   produce one close record per fragment, so the terminal's deal-level
   partial-exit display falls out naturally — on the grid (one row per
   fragment) AND on the chart (one connector per fragment). */
function demoDeals() {
  const rows = [];
  for (const h of D.history) {
    const otime = h.otime || h.time;
    const vol0 = h.vol0 || h.volume;
    rows.push({
      ticket: h.ticket, order: h.ticket, time: otime, type: h.type, entry: 0,
      position_id: h.ticket, volume: vol0, price: h.open,
      commission: 0, swap: 0, profit: 0, fee: 0,
      symbol: h.symbol, comment: '', magic: 0, reason: 0,
      sl: h.sl || 0, tp: h.tp || 0,
    });
    rows.push({
      ticket: h.ticket, order: h.ticket, time: h.time,
      type: h.type === 0 ? 1 : 0, entry: 1,
      position_id: h.ticket, volume: h.volume, price: h.close,
      commission: 0, swap: 0, profit: h.profit, fee: 0,
      symbol: h.symbol, comment: h.reason || '', magic: 0,
      reason: h.reason === 'sl' ? 4 : (h.reason === 'tp' ? 5 : 0),
      sl: h.sl || 0, tp: h.tp || 0,
    });
  }
  return rows;
}
ReplayTrade.deals = () => demoDeals();

export { ReplayTrade };
