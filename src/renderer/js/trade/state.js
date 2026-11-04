/**
 * ROUND85 — Trading bridge: state store + RPC over the provider WebSocket.
 *
 * The provider (demo.py simulated broker / mt5.py real MetaTrader5 bridge)
 * answers {'type':'trade', op, ok, data|error} messages; feed._send already
 * resolves/rejects on ok, so every op is a plain promise here.
 *
 * Live model:
 *   - 'state' poll (1.2s) refreshes account + positions + orders in ONE
 *     round trip (the provider batches account_info/positions_get/orders_get).
 *   - Between polls the floating P/L is recomputed CLIENT-SIDE from the tick
 *     stream (bid/ask) + the symbol spec (tick_value/tick_size), exactly the
 *     MT5 formula: profit = (close-open)/tick_size * tick_value * volume.
 *   - Specs are cached per symbol (60s TTL) — volume limits, stops level,
 *     contract size, tick value … power the risk calculator and the ticket.
 *
 * @module trade/state
 */
import { App } from '../../../core/state.js';
import { Log } from '../../../core/logger.js';

const POLL_MS = 1200;
const SPEC_TTL = 60 * 1000;

/* MT5 numeric order types (wire contract of both providers) */
export const OT = {
  BUY: 0, SELL: 1,
  BUY_LIMIT: 2, SELL_LIMIT: 3,
  BUY_STOP: 4, SELL_STOP: 5,
  BUY_STOP_LIMIT: 6, SELL_STOP_LIMIT: 7,
};
export const OT_NAME = {
  0: 'Buy', 1: 'Sell', 2: 'Buy Limit', 3: 'Sell Limit',
  4: 'Buy Stop', 5: 'Sell Stop', 6: 'Buy Stop Limit', 7: 'Sell Stop Limit',
};

function mround(v, step) {
  if (!(step > 0)) step = 0.01;
  return Math.round(Math.round(v / step) * step * 1e8) / 1e8;
}

const K_PLTAG = 'mt5_tr_pltag';
const K_VOLTAG = 'mt5_tr_voltag';

const Trade = {
  account: null,
  positions: [],          // rows: {ticket,time,type,volume,open,sl,tp,current,swap,profit,symbol,comment}
  orders: [],
  specs: {},              // symbol -> spec row (TTL)
  quotes: {},             // symbol -> {bid, ask, t} from the live tick stream
  online: false,          // trading bridge answered at least once
  lastErr: '',
  onChange: [],           // fn() after any account/positions/orders refresh
  /* ROUND85c (user request): live P/L on the chart's entry lines can be
     switched off — persisted, read by trade/overlay, toggled from the
     ticket checkbox and the dock header chip */
  plTag: true,
  /* ROUND85d (user request): the trade VOLUME on the entry-line tag gets
     its own on/off switch too — same mechanics as plTag */
  volTag: true,
  _pollTimer: null,
  _pollBusy: false,
  _specReq: {},           // symbol -> Promise (single flight)
  _errOnce: false,

  setPlTag(v) {
    this.plTag = !!v;
    try { localStorage.setItem(K_PLTAG, this.plTag ? '1' : '0'); } catch (e) { Log.warn('trade', 'P/L tag pref save failed', e) }
    for (const f of this.onChange) { try { f(); } catch (er) {} }
  },

  setVolTag(v) {
    this.volTag = !!v;
    try { localStorage.setItem(K_VOLTAG, this.volTag ? '1' : '0'); } catch (e) { Log.warn('trade', 'volume tag pref save failed', e) }
    for (const f of this.onChange) { try { f(); } catch (er) {} }
  },

  /* ---------- transport ---------- */
  rpc(op, payload) {
    const feed = App.feed;
    if (!feed || !feed.connected) return Promise.reject(new Error('not connected'));
    return feed._send(Object.assign({ type: 'trade', op }, payload || {}));
  },

  /* ---------- lifecycle ---------- */
  init() {
    if (this._pollTimer) return;
    try { this.plTag = localStorage.getItem(K_PLTAG) !== '0'; } catch (e) { Log.debug('trade', 'P/L tag pref load failed', e) }
    try { this.volTag = localStorage.getItem(K_VOLTAG) !== '0'; } catch (e) { Log.debug('trade', 'volume tag pref load failed', e) }
    this._pollTimer = setInterval(() => { this.refresh(); }, POLL_MS);
    /* every provider tick refreshes the quote map the live P/L uses */
    App.feed.onTick.push((sym, price, time, vol, bid, ask) => {
      if (bid > 0 && ask > 0) this.quotes[sym] = { bid, ask, t: time };
      else this.quotes[sym] = { bid: price, ask: price, t: time };
    });
    this.refresh();
    try { Log && Log.info('trade', 'trading bridge init'); } catch (e) {}
  },

  /* ---------- polling ---------- */
  refresh() {
    if (this._pollBusy) return Promise.resolve();
    this._pollBusy = true;
    return this.rpc('state').then((m) => {
      const d = m.data || {};
      this.account = d.account || this.account;
      this.positions = d.positions || [];
      this.orders = d.orders || [];
      this.online = true;
      this.lastErr = '';
      this._errOnce = false;
      /* keep the P/L of traded symbols live even with no chart open.
         ROUND274 — owner-tagged: each symbol is held under the 'trade' owner
         while a position needs it, and released as soon as the last position
         in that symbol closes. A chart/watchlist holding the same symbol keeps
         its own owner, so neither side cuts the other off. */
      const want = new Set();
      for (const p of this.positions) if (p && p.symbol) want.add(p.symbol);
      if (!this._subs) this._subs = new Set();
      for (const sym of Array.from(this._subs)) {
        if (want.has(sym)) continue;
        this._subs.delete(sym);
        if (App.feed) App.feed.unsubscribe(sym, 'trade');
      }
      for (const sym of want) {
        if (this._subs.has(sym)) continue;
        this._subs.add(sym);
        if (App.feed) App.feed.subscribe(sym, 'trade');
      }
      for (const f of this.onChange) { try { f(); } catch (e) {} }
    }).catch((e) => {
      this.lastErr = String(e && e.message || e);
      if (!this._errOnce) {
        this._errOnce = true;
        try { Log && Log.warn('trade', 'state poll failed', { error: this.lastErr }); } catch (er) {}
      }
    }).finally(() => { this._pollBusy = false; });
  },

  /* ---------- specs (cached) ---------- */
  spec(symbol) {
    const c = this.specs[symbol];
    const now = Date.now();
    if (c && now - c._at < SPEC_TTL && !this._specReq[symbol]) return Promise.resolve(c);
    if (this._specReq[symbol]) return this._specReq[symbol];
    this._specReq[symbol] = this.rpc('spec', { symbol }).then((m) => {
      const s = m.data || {};
      s._at = Date.now();
      this.specs[symbol] = s;
      delete this._specReq[symbol];
      return s;
    }).catch((e) => {
      delete this._specReq[symbol];
      throw e;
    });
    return this._specReq[symbol];
  },
  specSync(symbol) { return this.specs[symbol] || null; },

  /* ---------- math (MT5 formulas) ---------- */
  /* floating P/L of one position, refreshed from the live quote stream */
  profitOf(pos) {
    const s = this.specs[pos.symbol];
    const q = this.quotes[pos.symbol];
    if (!s || !q || !(s.tick_value > 0) || !(s.tick_size > 0)) {
      return (typeof pos.profit === 'number') ? pos.profit + (pos.swap || 0) : 0;
    }
    return this.profitAt(pos, pos.type === 0 ? q.bid : q.ask);
  },
  /* P/L the position would show if it closed at `price` — powers the
     SL/TP hover tooltips and the entry-line drag preview (ROUND85c) */
  profitAt(pos, price) {
    const s = this.specs[pos.symbol];
    if (!s || !(s.tick_value > 0) || !(s.tick_size > 0) || !(price > 0)) {
      return (typeof pos.profit === 'number') ? pos.profit + (pos.swap || 0) : 0;
    }
    const diff = (price - pos.open) * (pos.type === 0 ? 1 : -1);
    return (diff / s.tick_size) * s.tick_value * pos.volume + (pos.swap || 0);
  },
  liveEquity() {
    if (!this.account) return 0;
    let eq = this.account.balance;
    for (const p of this.positions) eq += this.profitOf(p);
    return eq;
  },
  /* money risked when `slDist` (price units) is hit, for `volume` lots */
  riskMoney(symbol, slDist, volume) {
    const s = this.specs[symbol];
    if (!s || !(s.tick_value > 0) || !(s.tick_size > 0) || !(slDist > 0)) return 0;
    return (slDist / s.tick_size) * s.tick_value * volume;
  },
  /* lot size so that hitting `slDist` loses exactly `riskMoney` */
  lotForRisk(symbol, riskMoney, slDist) {
    const s = this.specs[symbol];
    if (!s || !(s.tick_value > 0) || !(s.tick_size > 0) || !(slDist > 0) || !(riskMoney > 0)) return 0;
    const perLot = (slDist / s.tick_size) * s.tick_value;
    return mround(riskMoney / perLot, s.vol_step || 0.01);
  },
  clampVolume(symbol, v) {
    const s = this.specs[symbol];
    if (!s) return v;
    if (v < (s.vol_min || 0.01)) v = s.vol_min || 0.01;
    if (v > (s.vol_max || 100)) v = s.vol_max || 100;
    return mround(v, s.vol_step || 0.01);
  },
  quote(symbol) {
    return this.quotes[symbol] || null;
  },
  spreadPts(symbol) {
    const s = this.specs[symbol];
    const q = this.quotes[symbol];
    if (!s || !q || !(s.point > 0)) return 0;
    return Math.round((q.ask - q.bid) / s.point);
  },

  /* ---------- actions (all resolve {retcode, comment, ...}) ---------- */
  placeOrder(o) {
    return this.rpc('order_send', {
      symbol: o.symbol, order_type: o.orderType, volume: o.volume,
      price: o.price, stoplimit: o.stoplimit, sl: o.sl || 0, tp: o.tp || 0,
      deviation: o.deviation, comment: o.comment || '',
      type_time: o.typeTime || 'gtc', expiration: o.expiration || 0,
    }).then((m) => { this.refresh(); return m.data; });
  },
  closePosition(ticket, volume) {
    const p = { ticket };
    if (volume > 0) p.volume = volume;
    return this.rpc('close', p).then((m) => { this.refresh(); return m.data; });
  },
  closeAll(symbol) {
    return this.rpc('close_all', symbol ? { symbol } : {}).then((m) => { this.refresh(); return m.data; });
  },
  modifySLTP(ticket, sl, tp) {
    return this.rpc('modify_sltp', { ticket, sl: sl || 0, tp: tp || 0 })
      .then((m) => { this.refresh(); return m.data; });
  },
  modifyOrder(ticket, price, sl, tp, typeTime, expiration) {
    const p = { ticket, price, sl: sl || 0, tp: tp || 0 };
    if (typeTime) { p.type_time = typeTime; p.expiration = expiration || 0; }
    return this.rpc('order_modify', p).then((m) => { this.refresh(); return m.data; });
  },
  cancelOrder(ticket) {
    return this.rpc('order_cancel', { ticket }).then((m) => { this.refresh(); return m.data; });
  },
  history(from, to) {
    return this.rpc('history', { from: from || 0, to: to || 0 }).then((m) => m.data || {});
  },
};

export { Trade };
