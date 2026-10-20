/**
 * ROUND85E — Trading alerts (user request): the Alerts panel gains a
 * "Trading alerts" section that notifies the user about THEIR trades:
 *
 *   - a PENDING order was activated (filled) by the market
 *     ("معامله پندینگ شما توسط مارکت فعال شد")
 *   - a trade's STOP LOSS was hit
 *   - a trade's TAKE PROFIT was hit
 *
 * Everything is user-managed from the Alerts panel:
 *   - one master switch (off = the feature stays completely silent)
 *   - three alert-type switches (apply to new AND running trades)
 *   - a live list with a per-trade toggle per alert type
 *
 * Detection (client-side, zero provider changes):
 *   - structure diffs on the 1.2s 'state' poll: order gone + matching
 *     position -> filled (cancellations go through Trade.cancelOrder and
 *     are marked expected, so they never fire); new position -> armed.
 *   - SL/TP TOUCH fires at the exact moment the broker acts: the tick
 *     stream is checked with MT5 semantics (BUY closes on BID, SELL on
 *     ASK) — identical to the provider engines. Manual closes go through
 *     Trade.closePosition/closeAll and are marked expected as well.
 *
 * Ephemeral by design: armed monitors live per session (tickets die with
 * the session); only the config persists (mt5_tralert_cfg). On boot every
 * running trade is armed automatically per the saved switches — the
 * feature works without the user having to configure anything, but every
 * part can be switched off.
 *
 * ROUND129: the persistent notification list now ages out on its own —
 * a once-a-day automatic purge drops events older than 24 h (rolling
 * retention, persisted last-purge stamp, 30-min re-check + pre-store
 * gate), while per-row delete and Clear all stay user-controlled.
 *
 * @module trade/alerts
 */
import { App } from '../../../core/state.js';
import { U } from '../core/util.js';
import { Trade, OT_NAME } from './state.js';
import { TradeRoute } from './route.js';

const K_CFG = 'mt5_tralert_cfg';
const K_NLOG = 'mt5_trnotify_log';
const LOG_MAX = 40;
/* ROUND128 (user request): the in-app trade notifications (trade set /
   SL-TP changed / activated / hit / closed …) get their own PERSISTENT,
   user-manageable list in the Alerts panel — default OFF. */
const NLOG_MAX = 200;
/* ROUND129 (user request): the notification list must never grow unbounded
   "cache". The app purges it AUTOMATICALLY once a day — a rolling 24 h
   retention pass that drops every event older than a day. The pass is
   self-gated by a persisted timestamp (mt5_trnotify_purge): it runs at
   boot, on a 30-min interval and right before each new event is stored,
   but the heavy sweep executes AT MOST once per 24 h. The user keeps the
   manual levers too: per-row delete + Clear all (panels/alerts.js). */
const K_PURGE = 'mt5_trnotify_purge';
const NLOG_TTL = 24 * 60 * 60 * 1000;   /* events older than 24 h expire */
const PURGE_EVERY_MS = 30 * 60 * 1000;  /* gate CHECK every 30 minutes */

const TradeAlerts = {
  /* persisted switches — the Alerts panel renders/edits these.
     ROUND128: notifyLog (the trade-notification LIST) defaults OFF. */
  cfg: Object.assign({ enabled: true, onFill: true, onSL: true, onTP: true, notifyLog: false }, U.lsGet(K_CFG, {}) || {}),
  /* armed monitors:
     ord row: { kind:'ord', ticket, symbol, type, vol, fill }
     pos row: { kind:'pos', ticket, symbol, type, vol, sl, tp, slFired, tpFired } */
  items: [],
  /* fired events, newest first (introspection + tests) */
  log: [],
  /* ROUND130: the first state poll only BASELINES the book (arms the
     per-trade switches for running positions/orders) — it must not log
     fake "opened/placed" events for trades that predate the session */
  _bootstrapped: false,
  /* ROUND128: the persistent notification list (user-deletable, default-off
     capture) — survives restarts via localStorage */
  nlog: (function () { const a = U.lsGet(K_NLOG, []); return Array.isArray(a) ? a : []; })(),
  /* notifier hooks (panels/alerts.js: toast + OS notification + sound) */
  onFire: [],
  /* UI re-render hooks */
  onChange: [],
  _prevP: new Map(),
  _prevO: new Map(),
  _expCancel: new Set(),
  _expClose: new Set(),
  /* ROUND85e FIX: a pending that fills FASTER than one 'state' poll
     (1.2s) never appears in orders[] — it goes straight to a position.
     placeOrder remembers pending tickets; a NEW position carrying such a
     ticket IS the activation. _fillDone dedupes against the slow path. */
  _recentPend: new Map(),
  _fillDone: new Set(),
  /* ROUND128: ticket -> ms of the last SL/TP hit fire (dedupes the close row) */
  _hitAt: new Map(),
  _ready: false,

  init() {
    if (this._ready) return;
    this._ready = true;
    /* user-initiated departures must never fire an alert — mark them.
       (Monkey-patched here so dock/ticket callers need zero changes.) */
    const cO = Trade.cancelOrder.bind(Trade);
    Trade.cancelOrder = (t) => { this._expCancel.add(Number(t)); return cO(t); };
    const cP = Trade.closePosition.bind(Trade);
    Trade.closePosition = (t, v) => { this._expClose.add(Number(t)); return cP(t, v); };
    const cA = Trade.closeAll.bind(Trade);
    Trade.closeAll = (s) => {
      for (const p of Trade.positions) this._expClose.add(Number(p.ticket));
      return cA(s);
    };
    /* remember pending-order tickets for the fast-fill detection above */
    const pO = Trade.placeOrder.bind(Trade);
    Trade.placeOrder = (o) => pO(o).then((d) => {
      try {
        if (o && Number(o.orderType) >= 2 && d && d.order)
          this._recentPend.set(Number(d.order), { at: Date.now() });
      } catch (e) {}
      return d;
    });
    /* structure diff after every state poll */
    Trade.onChange.push(() => { try { this._diff(); } catch (e) {} });
    /* ROUND129: the daily purge — run once at boot, then re-check on the
       30-min interval (the gate keeps the actual sweep to once per day;
       _logEvent re-checks before every store so a throttled interval can
       never let the list grow unbounded) */
    try { this.purgeNlog(); } catch (e) {}
    if (!this._purgeTimer) {
      this._purgeTimer = setInterval(() => {
        try { this.purgeNlog(); } catch (e) {}
      }, PURGE_EVERY_MS);
    }
    /* SL/TP touch monitor on the live tick stream.
       NOTE: App.onTickHooks is copied into the feed EARLY in boot, so a
       hook registered later must attach to the feed directly as well. */
    const hook = (sym) => { try { this._onTick(sym); } catch (e) {} };
    (App.onTickHooks = App.onTickHooks || []).push(hook);
    if (App.feed && App.feed.onTick && !App.feed.onTick.includes(hook)) App.feed.onTick.push(hook);
  },

  setCfg(k, v) {
    this.cfg[k] = !!v;
    U.lsSet(K_CFG, this.cfg);
    this._emit();
  },

  /* ---------- ROUND128: the user-manageable notification list ---------- */
  /* capture is gated ONLY by cfg.notifyLog (default OFF) — the per-type
     sound switches keep governing the toast/sound path exactly as before */
  _logEvent(ev) {
    if (this.cfg.notifyLog !== true) return;
    try { this.purgeNlog(); } catch (e) {}   /* ROUND129: self-gated daily sweep */
    this.nlog.unshift({
      id: ev.at + '-' + Math.random().toString(36).slice(2, 8),
      type: ev.type, msg: ev.msg, at: ev.at,
    });
    if (this.nlog.length > NLOG_MAX) this.nlog.length = NLOG_MAX;
    try { U.lsSet(K_NLOG, this.nlog); } catch (e) {}
  },
  removeNlog(id) {
    this.nlog = this.nlog.filter((r) => r.id !== id);
    try { U.lsSet(K_NLOG, this.nlog); } catch (e) {}
    this._emit();
  },
  clearNlog() {
    this.nlog = [];
    try { U.lsSet(K_NLOG, this.nlog); } catch (e) {}
    this._emit();
  },

  /* ---------- ROUND129: the daily automatic purge ----------
     Dropping every event older than NLOG_TTL (24 h) — at most ONE sweep
     per day (a persisted last-purge stamp gates it). force=true runs the
     sweep regardless of the gate (tests + the stamp-less first boot).
     Returns the number of rows removed (introspection + tests). */
  purgeNlog(force) {
    const now = Date.now();
    if (force !== true) {
      const last = Number(U.lsGet(K_PURGE, 0)) || 0;
      if (last > 0 && now - last < NLOG_TTL) return 0;   /* daily gate */
    }
    const before = this.nlog.length;
    this.nlog = this.nlog.filter((r) =>
      r && Number(r.at || 0) > 0 && now - Number(r.at) < NLOG_TTL);
    /* never persist a falsy stamp — 0 would re-arm the gate every tick */
    try { U.lsSet(K_PURGE, now); } catch (e) {}
    if (this.nlog.length !== before) {
      try { U.lsSet(K_NLOG, this.nlog); } catch (e) {}
      this._emit();
    }
    return before - this.nlog.length;
  },
  /* minutes left until the NEXT automatic sweep (panel status line) */
  purgeInMin() {
    const last = Number(U.lsGet(K_PURGE, 0)) || 0;
    if (!last) return 0;
    return Math.max(0, Math.ceil((last + NLOG_TTL - Date.now()) / 60000));
  },

  /* per-trade toggle from the Alerts panel list */
  setItem(ticket, field, v) {
    const it = this.items.find((i) => i.ticket === Number(ticket));
    if (!it) return;
    if (field === 'fill') it.fill = !!v;
    if (field === 'sl') { it.sl = !!v; if (v) it.slFired = false; }
    if (field === 'tp') { it.tp = !!v; if (v) it.tpFired = false; }
    this._emit();
  },

  _emit() { for (const f of this.onChange) { try { f(); } catch (e) {} } },

  _armOrd(o) {
    if (this.items.some((i) => i.kind === 'ord' && i.ticket === Number(o.ticket))) return;
    this.items.push({ kind: 'ord', ticket: Number(o.ticket), symbol: o.symbol, type: o.type, vol: o.volume, price: o.price, fill: true });
  },
  _armPos(p) {
    let it = this.items.find((i) => i.kind === 'pos' && i.ticket === Number(p.ticket));
    if (!it) {
      it = { kind: 'pos', ticket: Number(p.ticket), symbol: p.symbol, type: p.type, vol: p.volume, sl: true, tp: true, slFired: false, tpFired: false };
      this.items.push(it);
    }
    it.vol = p.volume; it.type = p.type; it.symbol = p.symbol;
  },
  _unarm(kind, ticket) {
    this.items = this.items.filter((i) => !(i.kind === kind && i.ticket === Number(ticket)));
  },

  /* ---------- structure diff (runs after every state poll) ---------- */
  /* ROUND128: the diff reads the ACTIVE account through the TradeRoute
     facade — the notification list + alerts now work in DEMO mode too
     (demo rows used to be invisible here: this module only ever watched
     the live wire). Live mode behaves exactly as before.
     ROUND130: the FIRST diff of a session BOOTSTRAPS the baseline —
     positions/orders that already exist when the app starts are armed for
     the per-trade switches but stay SILENT in the notification list (a
     restart must never spam fake "Position opened" rows for trades the
     user set days ago). */
  _diff() {
    const pos = (TradeRoute.isDemo() ? (TradeRoute.positions() || []) : (Trade.positions || []));
    const ord = (TradeRoute.isDemo() ? (TradeRoute.orders() || []) : (Trade.orders || []));
    const nowP = new Map(pos.map((p) => [Number(p.ticket), p]));
    const nowO = new Map(ord.map((o) => [Number(o.ticket), o]));
    const prevP = this._prevP;
    const prevO = this._prevO;
    const boot = !this._bootstrapped;   /* ROUND130: first poll = baseline only */

    /* new pending orders -> arm the activation alert */
    for (const [t, o] of nowO) if (!prevO.has(t)) {
      this._armOrd(o);
      /* ROUND128: trade SET -> notification list (silent — no toast/sound) */
      if (!boot) this._fire('place', { symbol: o.symbol, ordType: o.type, vol: o.volume, price: o.price, ticket: t }, { silent: true });
    }

    /* orders gone: user cancel = silent; otherwise the market filled it
       (position with the SAME ticket — both demo.py and MT5 hedging keep
       the opening order's ticket — or a fresh matching position) */
    for (const [t, o] of prevO) {
      if (nowO.has(t)) continue;
      this._unarm('ord', t);
      if (this._expCancel.has(t)) { this._expCancel.delete(t); continue; }
      const filled = nowP.has(t) || pos.some((p) => !prevP.has(Number(p.ticket)) &&
        p.symbol === o.symbol && p.type === o.type && Math.abs(p.volume - o.volume) < 1e-8);
      if (filled && !this._fillDone.has(t)) {
        this._fillDone.add(t);
        this._recentPend.delete(t);
        /* ordType (NOT type): the event's `type` must stay 'fill' */
        this._fire('fill', { symbol: o.symbol, ordType: o.type, vol: o.volume, price: o.price, ticket: t });
      }
    }
    this._expCancel.forEach((t) => { if (!nowO.has(t)) this._expCancel.delete(t); });

    /* new positions (market fills + activated pendings) -> arm SL/TP.
       A position whose ticket is a RECENTLY placed pending order is a
       FAST fill — the order never lived long enough to be polled. */
    for (const [t, p] of nowP) {
      if (!prevP.has(t)) {
        this._armPos(p);
        const rp = this._recentPend.get(t);
        if (rp && !this._fillDone.has(t)) {
          this._fillDone.add(t);
          this._recentPend.delete(t);
          this._fire('fill', { symbol: p.symbol, ordType: p.type, vol: p.volume, price: p.open, ticket: t });
        } else if (!this._fillDone.has(t) && !boot) {
          /* ROUND128: a MARKET position opened (no pending behind it) —
             the notification list records the trade being set. The
             _fillDone guard keeps a pending ACTIVATION from also showing
             here as an "open" (the orders-gone loop already fired 'fill').
             ROUND130: NOT on the boot baseline (see the diff header). */
          this._fire('open', { symbol: p.symbol, side: p.type === 0 ? 'BUY' : 'SELL', vol: p.volume, price: p.open, ticket: t }, { silent: true });
        }
      } else {
        /* ROUND128: SL/TP modifications + partial closes on the LIVE book */
        const pv = prevP.get(t);
        if (Number(pv.sl || 0) !== Number(p.sl || 0)) {
          this._fire('slmod', { symbol: p.symbol, ticket: t, px: p.sl || 0, prev: pv.sl || 0 }, { silent: true });
        }
        if (Number(pv.tp || 0) !== Number(p.tp || 0)) {
          this._fire('tpmod', { symbol: p.symbol, ticket: t, px: p.tp || 0, prev: pv.tp || 0 }, { silent: true });
        }
        if (Number(p.volume) < Number(pv.volume) - 1e-9) {
          this._fire('partial', { symbol: p.symbol, side: p.type === 0 ? 'BUY' : 'SELL', ticket: t,
            vol: Number((pv.volume - p.volume).toFixed(8)), vol0: pv.volume }, { silent: true });
        }
      }
    }
    for (const [t, rp] of this._recentPend) if (Date.now() - rp.at > 600000) this._recentPend.delete(t);

    /* positions gone: manual close = marked expected; SL/TP closes were
       already announced by the tick monitor — either way, disarm.
       ROUND128: every departure also lands in the notification list (a
       close right after an SL/TP hit is skipped — the hit row already
       tells that story). */
    for (const [t] of prevP) {
      if (nowP.has(t)) continue;
      this._expClose.delete(t);
      this._fillDone.delete(t);
      this._unarm('pos', t);
      const hit = this._hitAt.get(t);
      if (!(hit && Date.now() - hit < 5000)) {
        const p0 = prevP.get(t);
        this._fire('close', { symbol: p0 ? p0.symbol : '', side: p0 ? (p0.type === 0 ? 'BUY' : 'SELL') : '',
          vol: p0 ? p0.volume : 0, ticket: t }, { silent: true });
      }
      this._hitAt.delete(t);
    }
    this._expClose.forEach((t) => { if (!nowP.has(t)) this._expClose.delete(t); });

    /* keep the armed rows in sync with the live book */
    for (const it of this.items.slice()) {
      if (it.kind === 'pos') {
        const p = nowP.get(it.ticket);
        if (p) { it.vol = p.volume; it.type = p.type; it.symbol = p.symbol; }
        else this._unarm('pos', it.ticket);
      } else if (!nowO.has(it.ticket)) {
        this._unarm('ord', it.ticket);
      }
    }

    this._prevP = nowP;
    this._prevO = nowO;
    this._bootstrapped = true;   /* ROUND130: from the next poll on, diffs fire */
    this._emit();
  },

  /* ---------- SL/TP touch monitor (every provider tick) ---------- */
  /* MT5 semantics, identical to the provider engines:
     BUY closes on BID (SL: bid<=sl, TP: bid>=tp)
     SELL closes on ASK (SL: ask>=sl, TP: ask<=tp) */
  _onTick(sym) {
    const q = (TradeRoute.isDemo() ? TradeRoute.quote(sym) : Trade.quotes[sym]);
    if (!q) return;
    const book = (TradeRoute.isDemo() ? TradeRoute.positions() : Trade.positions) || [];
    for (const it of this.items.slice()) {
      if (it.kind !== 'pos' || it.symbol !== sym) continue;
      const p = book.find((x) => Number(x.ticket) === it.ticket);
      if (!p) continue;
      const buy = p.type === 0;
      if (!it.slFired && it.sl && this.cfg.enabled && p.sl > 0 &&
          (buy ? (q.bid <= p.sl) : (q.ask >= p.sl))) {
        it.slFired = true;
        this._hitAt.set(it.ticket, Date.now());
        if (this.cfg.onSL) this._fire('sl', { symbol: p.symbol, side: buy ? 'BUY' : 'SELL', vol: p.volume, px: p.sl, ticket: p.ticket });
        else this._fire('sl', { symbol: p.symbol, side: buy ? 'BUY' : 'SELL', vol: p.volume, px: p.sl, ticket: p.ticket }, { silent: true });
      } else if (!it.tpFired && it.tp && this.cfg.enabled && p.tp > 0 &&
          (buy ? (q.bid >= p.tp) : (q.ask <= p.tp))) {
        it.tpFired = true;
        this._hitAt.set(it.ticket, Date.now());
        if (this.cfg.onTP) this._fire('tp', { symbol: p.symbol, side: buy ? 'BUY' : 'SELL', vol: p.volume, px: p.tp, ticket: p.ticket });
        else this._fire('tp', { symbol: p.symbol, side: buy ? 'BUY' : 'SELL', vol: p.volume, px: p.tp, ticket: p.ticket }, { silent: true });
      }
    }
  },

  /* ---------- fire ---------- */
  /* opts.silent (ROUND128): record + repaint but NO toast/sound — the
     informational event types (open/place/modify/partial/close) must not
     ring the alert sound; they live in the notification list instead. */
  _fire(type, info, opts) {
    /* info can never clobber the reserved `type`/`at` keys */
    const ev = Object.assign({}, info, { type, at: Date.now() });
    if (type === 'fill') {
      ev.msg = 'Your pending order was activated by the market — ' + ev.symbol + ' ' +
        (OT_NAME[info.ordType] || '') + ' ' + info.vol + (info.price ? ' @ ' + info.price : '') + ' (#' + info.ticket + ')';
    } else if (type === 'sl' || type === 'tp') {
      ev.msg = (type === 'sl' ? 'Stop loss hit' : 'Take profit hit') + ' — ' + ev.symbol + ' ' +
        ev.side + ' ' + ev.vol + ' @ ' + ev.px + ' (#' + ev.ticket + ')';
    } else if (type === 'open') {
      ev.msg = 'Position opened — ' + ev.symbol + ' ' + ev.side + ' ' + ev.vol +
        (ev.price ? ' @ ' + ev.price : '') + ' (#' + ev.ticket + ')';
    } else if (type === 'place') {
      ev.msg = 'Pending order placed — ' + ev.symbol + ' ' + (OT_NAME[info.ordType] || '') + ' ' +
        ev.vol + (ev.price ? ' @ ' + ev.price : '') + ' (#' + ev.ticket + ')';
    } else if (type === 'slmod' || type === 'tpmod') {
      ev.msg = (type === 'slmod' ? 'Stop loss changed' : 'Take profit changed') + ' — ' + ev.symbol +
        ' #' + ev.ticket + (ev.px > 0 ? (' → ' + ev.px) : ' → removed');
    } else if (type === 'partial') {
      ev.msg = 'Partial close — ' + ev.symbol + ' ' + ev.side + ' ' + ev.vol + ' of ' + ev.vol0 +
        ' lots (#' + ev.ticket + ')';
    } else if (type === 'close') {
      ev.msg = 'Position closed — ' + ev.symbol + ' ' + ev.side + ' ' + ev.vol + ' (#' + ev.ticket + ')';
    }
    this.log.unshift(ev);
    if (this.log.length > LOG_MAX) this.log.length = LOG_MAX;
    this._logEvent(ev);   /* ROUND128: the persistent, user-managed list */
    if (!(opts && opts.silent)) for (const f of this.onFire) { try { f(ev); } catch (e) {} }
    this._emit();
  },
};

export { TradeAlerts };
