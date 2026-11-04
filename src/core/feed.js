/**
 * WebSocket client for the local MT5 provider
 *
 * Protocol: every message {type, req_id, ...}; responses matched by type.
 * Round 16: carries the provider-measured broker server-tz offset ("off") —
 * every display formatter converts through TZ with it; onBrokerOff fires when
 * the offset changes so the UI can repaint.
 *
 * @module core/feed
 */

import { Log } from './logger.js';

/* the single live feed instance (set by the constructor) — read by the
   module-level priceDigits() helper below */
let activeFeed = null;

/**
 * Central digit-count helper (parity with the reference platform): the
 * PROVIDER's real digit count (digitsBySym — rides on every tick and bars
 * response) always wins; the legacy regex heuristic is only the fallback
 * until the first tick/bars of that symbol arrives. Every panel (Watchlist
 * Last column, Alerts, ...) routes through this ONE helper so a broker-
 * specific digits value (e.g. 6-digit fractional EURUSD) can never be
 * misprinted by a per-panel heuristic again.
 * (Phase 2: moved here from core/util.js — util stays dependency-free.)
 *
 * @param {string} sym - symbol code (e.g. 'EURUSD')
 * @returns {number} decimal digits for price formatting
 */
export function priceDigits(sym) {
  const f = activeFeed;
  if (sym && f && f.digitsBySym && f.digitsBySym[sym] != null && isFinite(f.digitsBySym[sym])) {
    return f.digitsBySym[sym];
  }
  if (/JPY/.test(sym)) return 3;
  if (/^(XAU|BTC|ETH|US30|NAS100|GER40|UK100|JP225|HK50)/.test(sym)) return 2;
  if (/^(XAG|SPX500|USOIL|UKOIL)/.test(sym)) return 3;
  return 5;
}

function Feed(url) {
    activeFeed = this;
    this.url = url || 'ws://127.0.0.1:8777'; // injectable for web shell / tests
    this.ws = null;
    this._req = 0;
    this._pending = new Map();
    this.onTick = [];
    this.onBars = [];
    this.onClose = [];
    this.onStatus = [];
    this.onLogin = [];
    this.onBrokerOff = [];
    this.serverOff = 0; // seconds to ADD to a true-UTC stamp -> broker wall time
    this.connected = false;
    this._tickQueue = [];
    this.digitsBySym = {}; // BUG-F/R25: symbol -> provider digits (rides on ticks)
    /* BUG-004/013: subscribe/unsubscribe issued while the socket is not open
       (boot: chart panes + a restored-open watchlist panel subscribe BEFORE
       the user logs in) used to be silently dropped — only symbols subscribed
       AFTER login ever ticked. They now queue and flush on open.
       AUDIT FIX (reconnect): this is the DESIRED set, not a one-shot queue —
       the provider keeps subscriptions per WebSocket connection, so a new
       socket starts empty. Keeping the set here and replaying it on every
       open restores charts/watchlist/position ticks after any reconnect
       (including symbols subscribed outside Manager, e.g. Pine/trade). */
    this._desiredSubs = new Set();
    /* ROUND274 — owner-tagged subscriptions. A plain subscribe()/unsubscribe()
       pair keeps the historical single-symbol semantics (the '*' owner), so
       every existing caller behaves exactly as before. Long-lived extra
       consumers (the trade bridge's open-position symbols) pass their own
       owner id: they can be released independently without cutting the
       chart/watchlist feed for the same symbol. */
    this._subOwners = new Map(); // symbol -> Set<owner>
    this._connectSeq = 0;
    this._connectPromise = null;
    this._reconnectTimer = null;
    /* ROUND174 (user log: trade + bars_req timeouts together, chart stuck
       loading — the provider loop froze with the socket OPEN, so nothing
       ever fired onclose and the app waited forever): app-level ping/pong
       stall detection. A healthy provider answers pings even on weekends
       (no ticks needed), so silence after OUR ping means a stalled loop. */
    this._lastMsgAt = 0;
    this._lastPongAt = 0;
    this._pingAt = 0;
    this._stallTimer = null;
  }

  Feed.prototype.connect = function () {
    // Never create two live sockets for the same Feed. Concurrent reconnects
    // used to race and an old socket's onclose could mark a newer socket
    // offline.
    if (this.connected && this.ws && this.ws.readyState === 1) return Promise.resolve();
    if (this._connectPromise) return this._connectPromise;

    const seq = ++this._connectSeq;
    this._connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        this._connectPromise = null;
        fn(value);
      };
      const to = setTimeout(() => {
        try { ws.close(); } catch (e) {}
        try { Log && Log.error('feed', 'feed connect timeout (4s)'); } catch (e) {}
        finish(reject, new Error('timeout'));
      }, 4000);

      ws.onopen = () => {
        if (seq !== this._connectSeq || this.ws !== ws) {
          try { ws.close(); } catch (e) {}
          return;
        }
        this.connected = true;
        this._wasConnected = true;
        this._pingAt = 0; // ROUND174: fresh socket, fresh stall-watchdog state
        try { this._lastPongAt = Date.now(); } catch (e) {}
        this.startStallWatchdog();
        const wanted = this._replaySubs();
        try { Log && Log.info('feed', 'feed connected', { resubscribed: wanted }); } catch (e) {}
        finish(resolve);
      };
      ws.onclose = () => {
        const current = this.ws === ws && seq === this._connectSeq;
        if (!current) return;
        const was = !!this._wasConnected;
        this.connected = false;
        this._wasConnected = false;
        // Requests belonging to this dead socket can never receive a reply.
        // Reject and clear them immediately instead of waiting for 20–45s.
        this._rejectPendingForSocket(ws);
        if (!settled) finish(reject, new Error('closed'));
        try { Log && Log[was ? 'warn' : 'debug']('feed', was ? 'feed connection closed' : 'feed closed before connect'); } catch (e) {}
        for (const f of this.onClose) { try { f(); } catch (e) { Log.debug('feed', 'close hook failed', e) } }
      };
      ws.onerror = () => {};
      ws.onmessage = (ev) => {
        if (this.ws !== ws || seq !== this._connectSeq) return;
        let m = null;
        try { m = JSON.parse(ev.data); } catch (e) { try { Log && Log.warn('feed', 'protocol: non-JSON message dropped'); } catch (er) {} return; }
        try { this._lastMsgAt = Date.now(); } catch (e) {}
        this._handle(m);
      };
    });
    return this._connectPromise;
  };

  /* ROUND174: app-level ping/pong stall watchdog (see constructor note).
     A healthy provider answers pings even with zero ticks (weekends), so a
     missing pong 15s after OUR ping means its loop is frozen — close the
     socket so onclose -> pending rejects -> the app reconnect loop heals.
     Pure decision in _stallCheck(now) for testability. */
  Feed.prototype._stallCheck = function (now) {
    if (!this.connected) return false;
    if (!this._pingAt) return false;
    if (now - this._pingAt <= 15000) return false;
    return (this._lastPongAt || 0) < this._pingAt;
  };

  Feed.prototype._stallTick = function () {
    try {
      if (!this.connected) return;
      const ws = this.ws;
      if (ws && ws.readyState === 1 && !this._pingAt) {
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) { return; }
        this._pingAt = Date.now();
      }
      if (this._stallCheck(Date.now())) {
        try { Log && Log.warn('feed', 'provider stalled (no pong) — closing to reconnect'); } catch (e) {}
        this._pingAt = 0;
        try { ws.close(); } catch (e) {}
      }
    } catch (e) { Log.warn('feed', 'stall watchdog tick failed', e) }
  };

  Feed.prototype.startStallWatchdog = function () {
    if (this._stallTimer) return;
    const self = this;
    this._stallTimer = setInterval(() => self._stallTick(), 20000);
    if (this._stallTimer.unref) { try { this._stallTimer.unref(); } catch (e) {} }
  };

  Feed.prototype._send = function (obj) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('not connected'));
    const req_id = ++this._req;
    return new Promise((resolve, reject) => {
      this._pending.set(req_id, { resolve, reject, type: obj.type, ws });
      try {
        ws.send(JSON.stringify(Object.assign({ req_id }, obj)));
      } catch (e) {
        this._pending.delete(req_id);
        reject(e);
        try { ws.close(); } catch (e) { Log.debug('feed', 'socket close after send failure failed', e) }
        return;
      }
      /* ROUND86C: the bars branch keyed on 'bars' but the request type is
         'bars_req' — the 45s history timeout NEVER matched and every bars
         request (chart load, Go to Date, Custom Session, older-pages) died
         at the generic 20s while a real terminal was still syncing its
         archive (the user's "Request timeout: bars-req"). Both spellings
         now get the intended 45s. */
      const timeout = obj.type === 'login' ? 40000
        : (obj.type === 'bars' || obj.type === 'bars_req') ? 45000
        : 20000;
      setTimeout(() => {
        if (this._pending.has(req_id)) {
          const p = this._pending.get(req_id);
          this._pending.delete(req_id);
          try { Log && Log.warn('feed', 'request timeout: ' + p.type); } catch (e) {}
          p.reject(new Error(p.type + ' timeout'));
        }
      }, timeout);
    });
  };

  Feed.prototype._rejectPendingForSocket = function (ws) {
    for (const [rid, p] of this._pending) {
      if (p.ws !== ws) continue;
      this._pending.delete(rid);
      try { p.reject(new Error('feed connection closed')); } catch (e) { Log.debug('feed', 'pending request reject failed', e) }
    }
  };

  /* the provider measured a (new) broker offset — guard + propagate */
  Feed.prototype._setOff = function (off) {
    off = Math.round(Number(off) || 0);
    if (!isFinite(off) || Math.abs(off) > 14 * 3600) return; // plausibility guard
    if (off === this.serverOff) return;
    this.serverOff = off;
    for (const f of this.onBrokerOff) { try { f(off); } catch (e) {} }
  };

  Feed.prototype._handle = function (m) {
    if (m.req_id && this._pending.has(m.req_id)) {
      const p = this._pending.get(m.req_id);
      this._pending.delete(m.req_id);
      if (m.ok === false) {
        /* ROUND85b: broker-level rejections arrive as
           {'ok':false,'data':{'retcode':N,'comment':'…'}} (both providers) —
           surface the REAL reason instead of a generic "<type> failed" */
        const d = m.data || {};
        p.reject(new Error(m.error || d.error ||
          (d.comment ? (d.retcode ? 'retcode ' + d.retcode + ': ' + d.comment : d.comment) : (p.type + ' failed'))));
      }
      else p.resolve(m);
      if (p.type === 'login' && m.off != null) this._setOff(m.off);
      return;
    }
    /* responses WITHOUT req_id (login_ok / login_failed) match the oldest
       pending request of the same type */
    if (m.type === 'login_ok' || m.type === 'login_failed') {
      for (const [rid, p] of this._pending) {
        if (p.type !== 'login') continue;
        this._pending.delete(rid);
        if (m.type === 'login_failed') p.reject(new Error(m.error || 'Login failed'));
        else {
          p.resolve(m);
          if (m.off != null) this._setOff(m.off);
        }
        return;
      }
    }
    switch (m.type) {
      case 'pong': {
        /* ROUND174: app-level pong (see startStallWatchdog). Provider pong
           carries no req_id, so it lands here, not in _pending. */
        try { this._lastPongAt = Date.now(); this._pingAt = 0; } catch (e) {}
        break;
      }
      case 'tick': {
        if (m.off != null) this._setOff(m.off);
        /* BUG-F/R25: the provider's real digit count rides on every tick —
           the authoritative point size for spreads-in-points (Watchlist);
           falls back to the legacy heuristic until the first tick arrives */
        if (m.digits != null && isFinite(m.digits)) this.digitsBySym[m.symbol] = m.digits;
        this._tickQueue.push(m);
        if (this._tickQueue.length > 64) {
          const batch = this._tickQueue.splice(0, this._tickQueue.length);
          for (const t of batch) {
            if (t.digits != null && isFinite(t.digits)) this.digitsBySym[t.symbol] = t.digits;
            for (const f of this.onTick) { try { f(t.symbol, t.price, t.time, t.volume, t.bid, t.ask); } catch (e) {} }
          }
        } else {
          setTimeout(() => {
            const batch = this._tickQueue.splice(0, this._tickQueue.length);
            for (const t of batch) {
              if (t.digits != null && isFinite(t.digits)) this.digitsBySym[t.symbol] = t.digits;
              for (const f of this.onTick) { try { f(t.symbol, t.price, t.time, t.volume, t.bid, t.ask); } catch (e) {} }
            }
          }, 40);
        }
        break;
      }
      case 'bars': {
        if (m.off != null) this._setOff(m.off);
        /* price-bar parity fix: the bars response carries the provider's
           authoritative digit count too — record it so the Watchlist/Alerts
           format correctly even BEFORE the first tick of a symbol arrives. */
        if (m.digits != null && isFinite(m.digits) && m.symbol) this.digitsBySym[m.symbol] = m.digits;
        for (const f of this.onBars) { try { f(m); } catch (e) {} }
        break;
      }
      case 'mt5_status': {
        for (const f of this.onStatus) { try { f(m); } catch (e) {} }
        break;
      }
      default: break;
    }
  };

  Feed.prototype.login = function (mode, acc) {
    const msg = { type: 'login', mode };
    if (mode === 'mt5') {
      msg.login = acc.login;
      msg.password = acc.password;
      msg.server = acc.server;
      if (acc.path) msg.path = acc.path;
    }
    return this._send(msg);
  };
  Feed.prototype.bars = function (symbol, tf, count, to) {
    /* provider protocol: type 'bars_req', timeframe field. `to` (optional,
       exclusive epoch seconds) asks for OLDER history ending strictly before
       it — the "Load older bars" pagination (parity with the reference
       platform). */
    const msg = { type: 'bars_req', symbol, timeframe: tf, count };
    if (to != null && isFinite(to)) msg.to = Math.floor(to);
    return this._send(msg);
  };
  /* AUDIT FIX (reconnect): replay the desired set on every socket open.
     Separate from onopen so tests can drive it without a real WebSocket. */
  Feed.prototype._replaySubs = function () {
    const wanted = Array.from(this._desiredSubs);
    for (const sym of wanted) {
      /* Send the frame directly: subscribe() is idempotent per owner now and
         would skip the replay that a fresh provider connection needs. */
      try { this._send({ type: 'subscribe', symbol: sym }).catch(() => {}); }
      catch (e) { Log.debug('feed', 'resubscribe failed', e) }
    }
    return wanted.length;
  };
  Feed.prototype.subscribe = function (symbol, owner) {
    if (!symbol) return Promise.resolve();
    const who = owner || '*';
    let owners = this._subOwners.get(symbol);
    if (owners && owners.has(who)) return Promise.resolve(); // already held by this owner
    if (!owners) { owners = new Set(); this._subOwners.set(symbol, owners); }
    const first = owners.size === 0;
    owners.add(who);
    this._desiredSubs.add(symbol);
    if (!first) return Promise.resolve(); // another owner already keeps it live
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.resolve(); // queued — replayed on open (BUG-004/013)
    }
    return this._send({ type: 'subscribe', symbol }).catch(() => {});
  };
  Feed.prototype.unsubscribe = function (symbol, owner) {
    if (!symbol) return Promise.resolve();
    const who = owner || '*';
    const owners = this._subOwners.get(symbol);
    if (owners) {
      if (!owners.has(who)) return Promise.resolve(); // this owner never held it
      owners.delete(who);
      if (owners.size) return Promise.resolve(); // another owner still needs ticks
      this._subOwners.delete(symbol);
    }
    this._desiredSubs.delete(symbol);
    if (!this.ws || this.ws.readyState !== 1) return Promise.resolve();
    return this._send({ type: 'unsubscribe', symbol }).catch(() => {});
  };
  Feed.prototype.search = function (q) {
    /* ROUND36: resolves {symbols, total} — 'total' is the provider's EXACT
       match count ('symbols' is wire-capped at 400 on big brokers) so the
       Symbol Search dialog can show a truthful "N symbols" footer. */
    return this._send({ type: 'symbol_search', query: q }).then((r) => {
      const syms = r.symbols || [];
      return { symbols: syms, total: r.total != null ? r.total : syms.length };
    });
  };
  Feed.prototype.news = function () {
    /* ROUND39: economic calendar for the Economic News panel + chart marks.
       Event: {time (epoch SEC), currency, impact 'high'|'med'|'low', name,
               forecast, previous, actual?}. */
    return this._send({ type: 'news' }).then((r) => r.news || []);
  };
  Feed.prototype.refreshRate = function (value) {
    /* get/set the provider's tick_loop poll interval (seconds). Omit value
       to just read the current setting. This is a local polling knob, NOT
       network ping to the broker's server — see provider_common.py. */
    const msg = { type: 'refresh_rate' };
    if (value != null) msg.value = value;
    return this._send(msg);
  };
  Feed.prototype.close = function () {
    ++this._connectSeq;
    this._connectPromise = null;
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws) {
      this._rejectPendingForSocket(ws);
      try { ws.close(); } catch (e) { Log.debug('feed', 'feed destroy close failed', e) }
    }
  };

export { Feed };
