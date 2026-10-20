/**
 * ROUND112 (user request) — the trading MODE switch: Demo ↔ Live.
 *
 * "توی نوار سمت راست دوتا بخش دارم به اسم Replay Trading و Trading … این دو
 *  تا بخش رو یکی کنی و یک سوئیچ بذاری که کاربر بتونه بین دمو تریدینگ و لایو
 *  تریدینگ روی حساب خودش سوئیچ کنه"
 *
 * One merged right-panel tab ("Trading") with a segmented Demo/Live switch.
 * The mode decides where EVERY order goes and which account the panel reads:
 *
 *   live  → the real broker bridge (trade/state.js — MetaTrader / provider)
 *   demo  → the client-side demo broker (trade/replaytrade.js), which itself
 *           works on TWO price sources:
 *             · Bar Replay active  → the replay chart prices (backtest)
 *             · Bar Replay off     → the LIVE market tick stream (demo on
 *               live market) — new in this round
 *
 * The switch is persisted (mt5_trade_mode) and shared by:
 *   · the merged right-panel tab (this module wires the segmented control)
 *   · the chart-side "Trade" panel (oneclick.js) — its badge, its guards and
 *     its send path all go through the facade below
 *
 * The demo side is a DELEGATE (ReplayTrade) injected at boot — route.js never
 * imports replaytrade.js, so there is no import cycle; OneClick imports ONLY
 * this module + state.js.
 *
 * @module trade/route
 */
import { U } from '../core/util.js';
import { UI } from '../drawing/ui.js';
import { Trade } from './state.js';
import { Log } from '../../../core/logger.js';

const K_MODE = 'mt5_trade_mode';

/* retcodes Trade.placeOrder treats as success (10009 filled, 10008 placed,
   10010 partial) — mirrors the round-111 check in oneclick.js */
const RC_OK = [10008, 10009, 10010];

const TradeRoute = {
  mode: 'live',          // 'live' | 'demo'
  demo: null,            // the demo delegate (ReplayTrade) — set at boot
  onChange: [],          // fn() after the mode flips (panels repaint)

  init() {
    let m = 'live';
    try { m = U.lsGet(K_MODE, 'live'); } catch (e) { Log.debug('trade', 'route mode load failed', e) }
    this.mode = m === 'demo' ? 'demo' : 'live';
    this._wireUI();
    this._paintUI();
  },

  /* app.js hands the demo broker in right after its init. ROUND117: the
     dock (and any other listener) must hear about DEMO state changes too —
     the engine's own changed() only knew its panel — so the delegate's
     change list gets one passthrough into this.onChange. */
  setDemoDelegate(d) {
    this.demo = d || null;
    try { if (d && d.onEngineChange) d.onEngineChange(() => this._fireChange()); } catch (e) {}
    this._paintUI();
  },

  _fireChange() {
    for (const f of this.onChange) { try { f(); } catch (e) {} }
  },

  isDemo() { return this.mode === 'demo'; },
  isLive() { return this.mode === 'live'; },
  label() { return this.mode === 'demo' ? 'DEMO' : 'LIVE'; },

  set(mode, silent) {
    const m = mode === 'demo' ? 'demo' : 'live';
    if (m === this.mode) return;
    this.mode = m;
    try { U.lsSet(K_MODE, m); } catch (e) { Log.warn('trade', 'route mode save failed', e) }
    this._paintUI();
    for (const f of this.onChange) { try { f(); } catch (e) {} }
    if (!silent) {
      try {
        UI.toast(m === 'demo'
          ? 'Demo trading — orders now go to the demo account (live market & Bar Replay)'
          : 'Live trading — orders now go to your broker account',
          m === 'demo' ? 'ok' : '');
      } catch (e) {}
    }
  },

  toggle() { this.set(this.isDemo() ? 'live' : 'demo'); },

  /* ROUND124 (detached windows): the persisted switch is GLOBAL — when the
     user flips Demo/Live in the MAIN window, a detached window's copy must
     follow or its float panel would badge/list the wrong account until
     reboot. app.js calls this on a slow timer in solo windows only: it
     re-reads the key and adopts a real change SILENTLY (no toast — the flip
     did not happen here). Same-window flips still go through set(). */
  refreshMode() {
    let m = this.mode;
    try { m = U.lsGet(K_MODE, this.mode); } catch (e) { return; }
    const next = m === 'demo' ? 'demo' : 'live';
    if (next === this.mode) return;
    this.mode = next;
    this._paintUI();
    for (const f of this.onChange) { try { f(); } catch (e) {} }
  },

  /* ======================================================================
   * unified facade — the chart panel + merged tab read THROUGH here, so
   * the same UI serves both accounts with zero conditionals of its own
   * ==================================================================== */

  /* best {bid, ask} for the active mode (demo: replay or live-market prices) */
  quote(symbol) {
    if (this.isDemo() && this.demo) {
      try { const q = this.demo.quoteOf(symbol); if (q) return q; } catch (e) {}
      return null;
    }
    return Trade.quote(symbol);
  },

  /* account equity in the active mode (drives the % risk mode + P/L %) */
  equity() {
    if (this.isDemo() && this.demo) {
      try { return this.demo.equity() || 0; } catch (e) { return 0; }
    }
    return Trade.liveEquity();
  },

  /* the open positions of the ACTIVE account */
  positions() {
    if (this.isDemo() && this.demo) {
      try { return this.demo.positions() || []; } catch (e) { return []; }
    }
    return Trade.positions;
  },

  /* ROUND117: the RESTING PENDING orders of the ACTIVE account — the same
     rule the positions() facade already follows. Before this, every consumer
     except the floating panel read Trade.orders directly (the live wire), so
     a pending set in DEMO mode existed only inside the demo engine and was
     invisible everywhere else (user report: pendings neither on the chart's
     dock grid nor anywhere while resting). Row shapes match the live wire:
     demo rows carry ticket/time/type/volume/price/sl/tp/symbol (+current and
     comment may be absent — consumers already fall back). */
  orders() {
    if (this.isDemo() && this.demo) {
      try { return this.demo.orders() || []; } catch (e) { return []; }
    }
    return Trade.orders;
  },

  /* the account row of the ACTIVE account, in the live wire's shape —
     the demo delegate's account() uses free/level names; map them once here */
  account() {
    if (this.isDemo() && this.demo) {
      try {
        const a = this.demo.account() || {};
        return {
          balance: a.balance || 0, equity: a.equity || 0, profit: a.floating || 0,
          margin: a.margin || 0, margin_free: a.free, margin_level: a.level,
          trade_allowed: true, currency: 'USD', demo: true,
        };
      } catch (e) { return null; }
    }
    return Trade.account;
  },

  profitOf(pos) {
    if (this.isDemo() && this.demo) {
      try { return this.demo.profitOf(pos); } catch (e) { return 0; }
    }
    return Trade.profitOf(pos);
  },

  /* can the active mode accept an order right now? {ok, reason} */
  history(from, to) {
    /* ROUND120 (user request): the history facade — the ToolBox History tab
       and the chart history layer read the ACTIVE account through here.
       demo → the demo engine's closed-trade ledger synthesized into the
       live wire's deal-row shape (IN + OUT per close, position_id = ticket);
       live → the broker bridge's history_deals_get. */
    if (this.isDemo() && this.demo) {
      let rows = [];
      try { rows = (this.demo.deals && this.demo.deals()) || []; } catch (e) { rows = []; }
      /* ROUND128: honor the History tab's range window for demo rows too —
         the demo ledger arrives unfiltered (the live bridge pre-filters in
         history_deals_get). The position's IN deal is kept even when it
         opened before the window, mirroring the bridge's backfill, so
         partial groups still render. */
      const f = Number(from) || 0;
      if (f > 0 && rows.length) {
        const kept = rows.filter((d) => !d.time || d.time >= f);
        const pids = new Set(kept.map((d) => d.position_id));
        for (const d of rows) {
          if (d.time && d.time < f && d.entry === 0 && pids.has(d.position_id)) kept.push(d);
        }
        rows = kept.sort((a, b) => (a.time || 0) - (b.time || 0));
      }
      return Promise.resolve({ deals: rows, summary: null });
    }
    return Trade.history(from, to);
  },

  /* ROUND120: close ALL on the ACTIVE account (the dock's Close-all button
     used to hard-wire Trade.closeAll — the live account — even in demo). */
  closeAll(symbol) {
    if (this.isDemo() && this.demo) {
      let r = null;
      try { r = this.demo.closeAll(symbol); } catch (e) { r = null; }
      return (r && r.ok)
        ? Promise.resolve({ ok: true })
        : Promise.reject(new Error((r && r.error) || 'Close all failed'));
    }
    return Trade.closeAll(symbol);
  },

  canTrade() {
    if (this.isDemo()) {
      if (!this.demo) return { ok: false, reason: 'The demo engine is not ready yet' };
      try { return this.demo.available(); } catch (e) {
        return { ok: false, reason: 'The demo engine is not ready yet' };
      }
    }
    if (!Trade.online) {
      return { ok: false, reason: 'Trading bridge is offline — cannot send the order' };
    }
    if (Trade.account && Trade.account.trade_allowed === false) {
      return { ok: false, reason: 'AutoTrading is OFF in MetaTrader — click the "Algo Trading" button in its toolbar, then try again' };
    }
    return { ok: true };
  },

  /* send a finished order — market (orderType 0/1) or pending (2..5).
   * Resolves {ok, comment?, retcode?, price?, ticket?}; REJECTS only on a
   * transport failure (the live path), exactly like the old oneclick flow.
   * ROUND120: typeTime/expiration pass through to the live pending path
   * (the unified ticket places pendings in both modes; the demo engine
   * keeps its own GTC semantics). */
  sendOrder(p) {
    if (this.isDemo() && this.demo) {
      let r = null;
      try {
        r = p.pend
          ? this.demo.placePendingOrder(p)
          : this.demo.placeMarketOrder(p);
      } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
      if (r && r.ok) {
        return Promise.resolve({ ok: true, comment: r.comment || 'done', ticket: r.ticket, price: r.price });
      }
      return Promise.resolve({ ok: false, error: (r && r.error) || 'rejected' });
    }
    return Trade.placeOrder({
      symbol: p.symbol, orderType: p.orderType, volume: p.volume,
      price: p.price, stoplimit: p.stoplimit || 0, sl: p.sl || 0, tp: p.tp || 0,
      deviation: p.deviation || 20, comment: p.comment || '',
      typeTime: p.typeTime, expiration: p.expiration || 0,
    }).then((data) => {
      const good = !(data && data.retcode && !RC_OK.includes(data.retcode));
      return { ok: good, retcode: data && data.retcode, comment: data && data.comment };
    });
  },

  close(ticket, volume) {
    if (this.isDemo() && this.demo) {
      let r = null;
      try { r = this.demo.closePosition(ticket, volume || 0); } catch (e) { r = null; }
      return (r && r.ok)
        ? Promise.resolve({ ok: true })
        : Promise.reject(new Error((r && r.error) || 'Close rejected'));
    }
    return Trade.closePosition(ticket, volume || 0);
  },

  /* ROUND117: cancel a resting pending on the ACTIVE account (live: the
     broker's order_cancel; demo: the engine's own cancelOrder) */
  cancel(ticket) {
    if (this.isDemo() && this.demo) {
      let r = null;
      try { r = this.demo.cancelOrder(ticket); } catch (e) { r = null; }
      return (r && r.ok)
        ? Promise.resolve({ ok: true })
        : Promise.reject(new Error((r && r.error) || 'Cancel rejected'));
    }
    return Trade.cancelOrder(ticket);
  },

  /* ROUND117: re-price / edit a pending on the ACTIVE account (the dock's
     Orders-tab editor works in demo mode too now) */
  modifyOrder(ticket, price, sl, tp, typeTime, expiration) {
    if (this.isDemo() && this.demo) {
      let r = null;
      try { r = this.demo.modifyOrder(ticket, price, sl, tp); } catch (e) { r = null; }
      return (r && r.ok)
        ? Promise.resolve({ ok: true, comment: 'done' })
        : Promise.reject(new Error((r && r.error) || 'Modify rejected'));
    }
    return Trade.modifyOrder(ticket, price, sl, tp, typeTime, expiration);
  },

  /* opts.be (ROUND112): the risk-free action — the demo broker snaps the
     SL to the nearest legal point of the break-even request */
  modifySLTP(ticket, sl, tp, opts) {
    if (this.isDemo() && this.demo) {
      let r = null;
      try { r = this.demo.modifySLTP(ticket, sl, tp, opts); } catch (e) { r = null; }
      return (r && r.ok)
        ? Promise.resolve({ ok: true })
        : Promise.reject(new Error((r && r.error) || 'Modify rejected'));
    }
    return Trade.modifySLTP(ticket, sl, tp);
  },

  /* ======================================================================
   * merged-tab UI — the segmented Demo/Live control in the "Trading" header
   * ==================================================================== */
  _wireUI() {
    const wrap = document.getElementById('tr-mode');
    if (!wrap || wrap.dataset.wired) return;
    wrap.dataset.wired = '1';
    for (const b of wrap.querySelectorAll('.tr-modeb[data-m]')) {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.set(b.dataset.m);
      });
    }
  },

  _paintUI() {
    const wrap = document.getElementById('tr-mode');
    if (wrap) {
      for (const b of wrap.querySelectorAll('.tr-modeb[data-m]')) {
        b.classList.toggle('on', b.dataset.m === this.mode);
      }
    }
    /* ROUND120 (user requests 6+7): ONE unified order ticket serves BOTH
       modes — the same #trade-ticket element is RE-HOMED into the active
       body on every mode flip. The demo body additionally carries the demo
       account settings + cash ledger (built by replaytrade.js). */
    const host = document.getElementById('trade-ticket');
    if (host) {
      const dest = this.isDemo()
        ? document.getElementById('tr-demo')
        : document.getElementById('tr-live');
      if (dest && host.parentNode !== dest) dest.insertBefore(host, dest.firstChild);
    }
    const live = document.getElementById('tr-live');
    const demo = document.getElementById('tr-demo');
    if (live) live.classList.toggle('hidden', this.mode !== 'live');
    if (demo) demo.classList.toggle('hidden', this.mode !== 'demo');
    /* the demo-settings gear belongs to the demo side only */
    const gear = document.getElementById('rtt-gear');
    if (gear) gear.classList.toggle('hidden', this.mode !== 'demo');
  },
};

export { TradeRoute };
