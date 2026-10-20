/**
 * ROUND85 — Order Ticket (right-panel "Trading" tab).
 *
 * One place to enter AND manage risk before every order:
 *   - live account strip (balance / equity / floating P/L / margin / level)
 *   - volume box with step chips (driven by the symbol's volume_step)
 *   - SL/TP with per-side input modes: Price | Points | Money | Risk% (SL)
 *     and Price | Points | Money | R:R (TP) — every mode recomputes the
 *     absolute price + money at risk/reward live
 *   - "Auto lot": sizes the position from the SL distance + risk target
 *     (MT5 tick_value/tick_size formula — broker-accurate)
 *   - all MT5 order routes: Market / Limit / Stop / Stop-Limit (+ expiry
 *     GTC / Day / Specified), deviation + comment, one-click trading
 *
 * ROUND120 (user requests 6+7) — THE UNIFIED TICKET: the SAME ticket now
 * serves the demo AND the live account — identical structure, identical
 * look, only the Demo/Live switch (and the mode chip on the account strip)
 * tells them apart. Every read/send goes through the TradeRoute facade:
 *   account strip → TradeRoute.account()/equity(), quotes →
 *   TradeRoute.quote(), orders → TradeRoute.sendOrder() with the
 *   canTrade() gate; the ticket element is RE-HOMED between #tr-live and
 *   #tr-demo by route._paintUI on every mode flip. Stop-Limit (unsupported
 *   by the demo engine) hides while Demo is selected.
 *
 * @module trade/ticket
 */
import { App } from '../../../core/state.js';
import { U } from '../core/util.js';
import { UI } from '../drawing/ui.js';
import { RightPanel } from '../ui/rightpanel.js';
import { icon } from '../ui/icons.js';
import { Trade, OT } from './state.js';
import { TradeRoute } from './route.js';

const K = {
  vol: 'mt5_tr_volume', slOn: 'mt5_tr_slon', tpOn: 'mt5_tr_tpon',
  slMode: 'mt5_tr_slmode', tpMode: 'mt5_tr_tpmode', slVal: 'mt5_tr_slval',
  tpVal: 'mt5_tr_tpval', riskPct: 'mt5_tr_riskpct', oneClick: 'mt5_tr_oneclick',
  deviation: 'mt5_tr_dev', type: 'mt5_tr_type', expiry: 'mt5_tr_expiry',
  follow: 'mt5_tr_follow', slMoney: 'mt5_tr_slmoney', tpMoney: 'mt5_tr_tpmoney',
};

const MODES_SL = [['price', 'Price'], ['points', 'Points'], ['money', 'Money'], ['risk', 'Risk %']];
const MODES_TP = [['price', 'Price'], ['points', 'Points'], ['money', 'Money'], ['rr', 'R:R']];
const TYPES = [
  ['market', 'Market'], ['limit', 'Limit'], ['stop', 'Stop'], ['stoplimit', 'Stop-Limit'],
];

const TradeTicket = {
  els: {},
  _sym: null,       // locked symbol (follow off)
  _tick: null,

  init() {
    if (this._tick) return;
    /* ROUND120: ONE ticket element for both modes — created once and
       re-homed between #tr-live / #tr-demo by TradeRoute._paintUI */
    let host = document.getElementById('trade-ticket');
    if (!host) {
      host = document.createElement('div');
      host.id = 'trade-ticket';
      const dest = document.getElementById('tr-live') || document.getElementById('tr-demo');
      if (dest) dest.insertBefore(host, dest.firstChild);
    }
    if (!host || this._tick) return;
    this._build(host);
    this._bind();
    Trade.onChange.push(() => this._refreshFast());
    TradeRoute.onChange.push(() => this._refreshFast());
    this._tick = setInterval(() => this._refreshFast(), 500);
    this._refreshAll();
  },

  /* ---------- current symbol ---------- */
  currentSymbol() {
    if (U.lsGet(K.follow, true) === false) return this._sym || this._paneSymbol();
    return this._paneSymbol();
  },
  _paneSymbol() {
    return (App.activePane && App.activePane.symbol) ||
      (App.panes[0] && App.panes[0].symbol) || 'EURUSD';
  },
  _setSymbol(sym) {
    this._sym = sym;
    if (this._specAsked) delete this._specAsked[sym];
    Trade.spec(sym).then(() => this._refreshAll()).catch(() => {});
    this._refreshAll();
  },

  /* ---------- DOM ---------- */
  _build(host) {
    host.innerHTML = '';
    const wrap = U.el('div', 'tt-wrap', host);
    wrap.innerHTML = `
      <div class="tt-acc">
        <div class="tt-acc-top">
          <div class="tt-acc-name" id="tt-acc-name">—</div>
          <span class="tt-modechip" id="tt-modechip">LIVE</span>
        </div>
        <div class="tt-acc-grid" id="tt-acc-grid">
          <div class="tt-acc-kpi"><span>Balance</span><b id="tt-balance">—</b></div>
          <div class="tt-acc-kpi"><span>Equity</span><b id="tt-equity">—</b></div>
          <div class="tt-acc-kpi"><span>Floating P/L</span><b id="tt-float">—</b></div>
          <div class="tt-acc-kpi"><span>Margin</span><b id="tt-margin">—</b></div>
          <div class="tt-acc-kpi"><span>Free Margin</span><b id="tt-free">—</b></div>
          <div class="tt-acc-kpi"><span>Margin Level</span><b id="tt-level">—</b></div>
        </div>
      </div>

      <div class="tt-row tt-symrow">
        <select id="tt-symbol" spellcheck="false" title="Trading symbol (charts open in the app)"></select>
        <button class="tt-gear-btn" id="tt-gear" title="Ticket display options" aria-haspopup="true" aria-expanded="false"></button>
        <div class="tt-gear-menu hidden" id="tt-gear-menu">
          <div class="tt-gear-title">Ticket options</div>
          <label class="tt-follow"><input type="checkbox" id="tt-follow"> Follow chart symbol</label>
          <label class="tt-follow" title="Show the live profit/loss on the entry lines drawn on the chart">
            <input type="checkbox" id="tt-pltag"> P/L on chart lines
          </label>
          <label class="tt-follow" title="Show the trade volume (lots) on the entry lines drawn on the chart">
            <input type="checkbox" id="tt-voltag"> Volume on chart lines
          </label>
        </div>
      </div>

      <div class="tt-sec">
        <div class="tt-sec-title">Volume (lots)</div>
        <div class="tt-row tt-volrow">
          <button class="tt-step" id="tt-vol-minus" title="Decrease volume">−</button>
          <input type="text" id="tt-volume" inputmode="decimal" spellcheck="false">
          <button class="tt-step" id="tt-vol-plus" title="Increase volume">+</button>
        </div>
        <div class="tt-chips" id="tt-vol-chips"></div>
      </div>

      <!-- ROUND131 (user request): the Order section AND the SELL/BUY
           execution buttons moved UP, directly under the volume picker —
           the fastest path (symbol -> volume -> order -> execute) is now
           the first thing the eye meets; risk management follows below. -->
      <div class="tt-sec">
        <div class="tt-sec-title">Order</div>
        <div class="tt-row">
          <select id="tt-type"></select>
          <input type="text" id="tt-dev" inputmode="numeric" title="Max slippage (points, market orders)" spellcheck="false">
        </div>
        <div class="tt-row tt-pend" id="tt-price-row">
          <input type="text" id="tt-price" inputmode="decimal" spellcheck="false" placeholder="Price">
        </div>
        <div class="tt-row tt-pend" id="tt-stoplimit-row">
          <input type="text" id="tt-stoplimit" inputmode="decimal" spellcheck="false" placeholder="Limit price">
        </div>
        <div class="tt-row tt-pend" id="tt-expiry-row">
          <select id="tt-expiry">
            <option value="gtc">Good till canceled</option>
            <option value="day">Good till day end</option>
            <option value="specified">Expiry…</option>
          </select>
          <input type="datetime-local" id="tt-expiry-at" spellcheck="false">
        </div>
        <div class="tt-row">
          <input type="text" id="tt-comment" maxlength="26" spellcheck="false" placeholder="Comment (optional)">
        </div>
        <label class="tt-oneclick"><input type="checkbox" id="tt-oneclick"> One-click trading (place immediately)</label>
      </div>

      <div class="tt-exect">
        <button class="tt-exec tt-sell" id="tt-sell"><span class="tt-exec-side">SELL</span><span class="tt-exec-px" id="tt-bid">—</span></button>
        <button class="tt-exec tt-buy" id="tt-buy"><span class="tt-exec-side">BUY</span><span class="tt-exec-px" id="tt-ask">—</span></button>
      </div>
      <div class="tt-mkt-info" id="tt-spread"></div>

      <div class="tt-sec">
        <div class="tt-sec-title">Risk management</div>
        <div class="tt-sltp">
          <div class="tt-sltp-row">
            <label class="tt-switch"><input type="checkbox" id="tt-sl-on"> <b class="tt-sl-c">SL</b></label>
            <select id="tt-sl-mode"></select>
            <input type="text" id="tt-sl-val" inputmode="decimal" spellcheck="false" placeholder="—">
          </div>
          <div class="tt-sltp-info" id="tt-sl-info"></div>
          <div class="tt-sltp-row">
            <label class="tt-switch"><input type="checkbox" id="tt-tp-on"> <b class="tt-tp-c">TP</b></label>
            <select id="tt-tp-mode"></select>
            <input type="text" id="tt-tp-val" inputmode="decimal" spellcheck="false" placeholder="—">
          </div>
          <div class="tt-sltp-info" id="tt-tp-info"></div>
          <div class="tt-riskrow">
            <span>Risk</span><input type="text" id="tt-risk-pct" inputmode="decimal" spellcheck="false"><span>% of equity</span>
            <button class="tt-mini" id="tt-autolot" title="Set volume so that hitting the SL loses exactly the risk target">Auto lot</button>
          </div>
          <div class="tt-sltp-info" id="tt-rr-info"></div>
        </div>
      </div>

      <div class="tt-status" id="tt-status"></div>
    `;
    const g = (id) => wrap.querySelector('#' + id);
    this.els = {
      wrap, accName: g('tt-acc-name'), modechip: g('tt-modechip'), balance: g('tt-balance'), equity: g('tt-equity'),
      float: g('tt-float'), margin: g('tt-margin'), free: g('tt-free'), level: g('tt-level'),
      gear: g('tt-gear'), gearMenu: g('tt-gear-menu'),
      follow: g('tt-follow'), symbol: g('tt-symbol'), plTag: g('tt-pltag'),
      volTag: g('tt-voltag'),
      volMinus: g('tt-vol-minus'), volPlus: g('tt-vol-plus'), volume: g('tt-volume'),
      volChips: g('tt-vol-chips'),
      slOn: g('tt-sl-on'), slMode: g('tt-sl-mode'), slVal: g('tt-sl-val'), slInfo: g('tt-sl-info'),
      tpOn: g('tt-tp-on'), tpMode: g('tt-tp-mode'), tpVal: g('tt-tp-val'), tpInfo: g('tt-tp-info'),
      riskPct: g('tt-risk-pct'), autolot: g('tt-autolot'), rrInfo: g('tt-rr-info'),
      type: g('tt-type'), dev: g('tt-dev'),
      priceRow: g('tt-price-row'), price: g('tt-price'),
      slRow: g('tt-stoplimit-row'), stoplimit: g('tt-stoplimit'),
      expRow: g('tt-expiry-row'), expiry: g('tt-expiry'), expiryAt: g('tt-expiry-at'),
      comment: g('tt-comment'), oneClick: g('tt-oneclick'),
      sell: g('tt-sell'), buy: g('tt-buy'), bid: g('tt-bid'), ask: g('tt-ask'),
      spread: g('tt-spread'), status: g('tt-status'),
    };
    /* select options */
    const fillSel = (sel, items) => {
      sel.innerHTML = '';
      for (const [v, label] of items) {
        const o = document.createElement('option');
        o.value = v; o.textContent = label;
        sel.appendChild(o);
      }
    };
    fillSel(this.els.slMode, MODES_SL);
    fillSel(this.els.tpMode, MODES_TP);
    fillSel(this.els.type, TYPES);
    /* restore persisted state */
    this.els.volume.value = U.lsGet(K.vol, '0.10');
    this.els.slOn.checked = U.lsGet(K.slOn, true) !== false;
    this.els.tpOn.checked = U.lsGet(K.tpOn, true) !== false;
    this.els.slMode.value = U.lsGet(K.slMode, 'points');
    this.els.tpMode.value = U.lsGet(K.tpMode, 'rr');
    this.els.slVal.value = U.lsGet(K.slVal, '500');
    this.els.tpVal.value = U.lsGet(K.tpVal, '2');
    /* ROUND102 BUGFIX: a leftover line re-applied the long-dead `slMoney`
       key over the restored SL value, so the SL box came back holding a
       stale MONEY figure interpreted in whatever mode was active (a saved
       "50" money value read as 50 POINTS). The key is not written anywhere
       any more — the line is gone. */
    this.els.riskPct.value = U.lsGet(K.riskPct, '1');
    this.els.oneClick.checked = U.lsGet(K.oneClick, false) === true;
    this.els.dev.value = U.lsGet(K.deviation, '20');
    this.els.type.value = U.lsGet(K.type, 'market');
    this.els.expiry.value = U.lsGet(K.expiry, 'gtc');
    this.els.follow.checked = U.lsGet(K.follow, true) !== false;
    this.els.plTag.checked = Trade.plTag;
    this.els.volTag.checked = Trade.volTag;
  },

  _bind() {
    const e = this.els;
    const save = (key, val) => U.lsSet(key, val);
    /* ROUND128 (user request): the three display toggles (Follow chart /
       P/L on chart lines / Volume on chart lines) live in a gear dropdown
       next to the symbol select — TradingView-style options menu. One
       document-level closer; toggling a checkbox never closes the menu. */
    if (e.gear && e.gearMenu) {
      e.gear.innerHTML = icon('gear');
      const closeMenu = () => {
        e.gearMenu.classList.add('hidden');
        e.gearMenu.style.position = '';
        e.gearMenu.style.top = '';
        e.gearMenu.style.left = '';
        e.gearMenu.style.right = '';
        e.gear.setAttribute('aria-expanded', 'false');
      };
      /* ROUND128: the menu is rendered FIXED (positioned from the button's
         screen rect) — an absolute card inside the scrollable ticket body was
         clipped by the panel's overflow on short panels. */
      const openMenu = () => {
        const r = e.gear.getBoundingClientRect();
        e.gearMenu.style.position = 'fixed';
        e.gearMenu.classList.remove('hidden');
        e.gear.setAttribute('aria-expanded', 'true');
        const mw = e.gearMenu.offsetWidth || 200, mh = e.gearMenu.offsetHeight || 96;
        let top = r.bottom + 5;
        let left = Math.min(Math.max(8, r.right - mw), window.innerWidth - mw - 8);
        if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 5);
        e.gearMenu.style.top = top + 'px';
        e.gearMenu.style.left = left + 'px';
        e.gearMenu.style.right = 'auto';
      };
      e.gear.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (e.gearMenu.classList.contains('hidden')) openMenu(); else closeMenu();
      });
      e.gearMenu.addEventListener('click', (ev) => ev.stopPropagation());
      document.addEventListener('mousedown', (ev) => {
        if (e.gearMenu.classList.contains('hidden')) return;
        if (e.gearMenu.contains(ev.target) || e.gear.contains(ev.target)) return;
        closeMenu();
      }, true);
      document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && !e.gearMenu.classList.contains('hidden')) closeMenu();
      }, true);
      this._closeGearMenu = closeMenu;
    }
    e.follow.addEventListener('change', () => { save(K.follow, e.follow.checked); this._refreshAll(); });
    /* ROUND85c: chart P/L tag toggle — same persisted flag the dock chip uses */
    e.plTag.addEventListener('change', () => Trade.setPlTag(e.plTag.checked));
    /* ROUND85d: chart VOLUME tag toggle — same persisted flag the dock chip uses */
    e.volTag.addEventListener('change', () => Trade.setVolTag(e.volTag.checked));
    e.symbol.addEventListener('change', () => this._setSymbol(e.symbol.value));
    e.volMinus.addEventListener('click', () => this._bumpVolume(-1));
    e.volPlus.addEventListener('click', () => this._bumpVolume(1));
    e.volume.addEventListener('change', () => { save(K.vol, e.volume.value); this._refreshFast(); });
    e.slOn.addEventListener('change', () => { save(K.slOn, e.slOn.checked); this._refreshFast(); });
    e.tpOn.addEventListener('change', () => { save(K.tpOn, e.tpOn.checked); this._refreshFast(); });
    e.slMode.addEventListener('change', () => { save(K.slMode, e.slMode.value); this._refreshFast(); });
    e.tpMode.addEventListener('change', () => { save(K.tpMode, e.tpMode.value); this._refreshFast(); });
    const valSave = (input, key) => () => { save(key, input.value); this._refreshFast(); };
    e.slVal.addEventListener('change', valSave(e.slVal, K.slVal));
    e.tpVal.addEventListener('change', valSave(e.tpVal, K.tpVal));
    e.riskPct.addEventListener('change', valSave(e.riskPct, K.riskPct));
    e.autolot.addEventListener('click', () => this._autoLot());
    e.type.addEventListener('change', () => { save(K.type, e.type.value); this._refreshAll(); });
    e.dev.addEventListener('change', valSave(e.dev, K.deviation));
    e.expiry.addEventListener('change', valSave(e.expiry, K.expiry));
    e.oneClick.addEventListener('change', valSave(e.oneClick, K.oneClick));
    e.sell.addEventListener('click', () => this._place(1));
    e.buy.addEventListener('click', () => this._place(0));
    /* ROUND102: hovering an execute button previews the ACTUAL geometry of
       that side — the entry, the stop and the target are drawn on the chart
       before a single lot is committed. Everything about the order was text
       in a side panel while the decision is made on the chart. */
    const hoverOn = (side) => () => { this._hoverSide = side; this._preview(side); this._refreshFast(); };
    const hoverOff = () => {
      this._hoverSide = null;
      if (this._armedSide == null) this._preview(null);
      this._refreshFast();
    };
    e.buy.addEventListener('mouseenter', hoverOn(0));
    e.sell.addEventListener('mouseenter', hoverOn(1));
    e.buy.addEventListener('mouseleave', hoverOff);
    e.sell.addEventListener('mouseleave', hoverOff);
  },

  /* ---------- ROUND102: chart preview of the order about to be sent ------
     Dotted entry / SL / TP lines on the pane showing this symbol. They are
     OURS alone (kept in _prev) and are torn down on every state change, so
     they can never be confused with a real position's lines. */
  _prevPane() {
    const sym = this.currentSymbol();
    if (App.activePane && App.activePane.symbol === sym) return App.activePane;
    return App.panes.find((p) => p.symbol === sym) || null;
  },

  _clearPreview() {
    const pv = this._prev;
    if (!pv) return;
    for (const l of pv.lines) { try { pv.pane.series.removePriceLine(l); } catch (e) {} }
    this._prev = null;
  },

  _preview(side) {
    this._clearPreview();
    if (side == null) return;
    const pane = this._prevPane();
    if (!pane || !pane.series || !pane.series.createPriceLine) return;
    const type = this.els.type.value;
    const sym = this.currentSymbol();
    const s = this._spec();
    if (!s) return;
    const g = this._riskGeom(side, type);
    const entry = this._entryRef(side, type);
    const L = (typeof LightweightCharts === 'object' && LightweightCharts.LineStyle) || null;
    const dotted = L ? L.Dotted : 1;
    const lines = [];
    const mk = (price, color, title) => {
      if (!(price > 0)) return;
      try {
        lines.push(pane.series.createPriceLine({
          price: Number(price.toFixed(s.digits)), color, lineWidth: 1, lineStyle: dotted,
          axisLabelVisible: true, axisLabelColor: color, axisLabelTextColor: '#fff', title,
        }));
      } catch (e) {}
    };
    const sideName = side === 0 ? 'BUY' : 'SELL';
    mk(entry, '#2962ff', sideName + ' ' + this._volume() + ' ?');
    if (this.els.slOn.checked) mk(g.slPrice, '#f23645', 'SL ' + this._fmtMoney(-Math.abs(g.slMoney)));
    if (this.els.tpOn.checked) mk(g.tpPrice, '#089981', 'TP ' + this._fmtMoney(Math.abs(g.tpMoney)));
    if (lines.length) this._prev = { pane, lines };
  },

  /* ---------- helpers ---------- */
  _spec() { return Trade.specSync(this.currentSymbol()) || null; },
  _fmtP(sym, v) {
    const s = Trade.specSync(sym);
    const d = s ? s.digits : 5;
    return (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d);
  },
  _fmtMoney(v) {
    if (v == null || !isFinite(v)) return '—';
    const r = Math.round(v * 100) / 100;
    return (r > 0 ? '+' : '') + r.toFixed(2);
  },
  _volume() {
    const v = parseFloat(this.els.volume.value);
    const c = Trade.clampVolume(this.currentSymbol(), isFinite(v) ? v : 0);
    if (isFinite(v) && c !== v) this.els.volume.value = c;
    return c;
  },
  _bumpVolume(dir) {
    const s = this._spec();
    const step = (s && s.vol_step) || 0.01;
    const v = Trade.clampVolume(this.currentSymbol(), (parseFloat(this.els.volume.value) || 0) + dir * step);
    this.els.volume.value = v;
    U.lsSet(K.vol, String(v));
    this._refreshFast();
  },
  _entryRef(side, type) {
    /* price the SL/TP geometry hangs off */
    const sym = this.currentSymbol();
    const q = TradeRoute.quote(sym);
    const s = this._spec();
    if (type === 'market') {
      const fallback = s ? { bid: s.bid, ask: s.ask } : { bid: 0, ask: 0 };
      const bid = (q && q.bid) || fallback.bid;
      const ask = (q && q.ask) || fallback.ask;
      return side === 0 ? (ask || bid) : (bid || ask);
    }
    return parseFloat(this.els.price.value) || 0;
  },

  /* SL/TP geometry -> {slPrice, slDist, tpPrice, tpDist, slMoney, tpMoney} */
  _riskGeom(side, type) {
    const sym = this.currentSymbol();
    const s = this._spec();
    const vol = this._volume();
    const out = { slPrice: 0, slDist: 0, slMoney: 0, tpPrice: 0, tpDist: 0, tpMoney: 0 };
    if (!s || !(s.point > 0)) return out;
    const entry = this._entryRef(side, type);
    if (!(entry > 0)) return out;
    const dir = side === 0 ? 1 : -1;                 // buy: SL below, TP above
    const eq = TradeRoute.equity() || (TradeRoute.account() ? TradeRoute.account().balance : 0);
    const perPt = (s.tick_value > 0 && s.tick_size > 0) ? s.tick_value / s.tick_size * vol : 0;
    const slMode = this.els.slMode.value;
    let slRaw = parseFloat(this.els.slVal.value);
    if (this.els.slOn.checked && isFinite(slRaw)) {
      if (slMode === 'price' && slRaw > 0) {
        out.slPrice = slRaw;
        out.slDist = Math.abs(entry - slRaw);
      } else if (slMode === 'points' && slRaw > 0) {
        out.slDist = slRaw * s.point;
        out.slPrice = entry - dir * out.slDist;
      } else if (slMode === 'money' && slRaw > 0 && perPt > 0) {
        out.slMoney = slRaw;
        out.slDist = slRaw / perPt;
        out.slPrice = entry - dir * out.slDist;
      } else if (slMode === 'risk') {
        const pct = parseFloat(this.els.riskPct.value);
        if (isFinite(pct) && pct > 0 && perPt > 0) {
          out.slMoney = eq * pct / 100;
          out.slDist = out.slMoney / perPt;
          out.slPrice = entry - dir * out.slDist;
        }
      }
    }
    const tpMode = this.els.tpMode.value;
    const tpRaw = parseFloat(this.els.tpVal.value);
    if (this.els.tpOn.checked && isFinite(tpRaw)) {
      if (tpMode === 'price' && tpRaw > 0) {
        out.tpPrice = tpRaw;
        out.tpDist = Math.abs(tpRaw - entry);
      } else if (tpMode === 'points' && tpRaw > 0) {
        out.tpDist = tpRaw * s.point;
        out.tpPrice = entry + dir * out.tpDist;
      } else if (tpMode === 'money' && tpRaw > 0 && perPt > 0) {
        out.tpMoney = tpRaw;
        out.tpDist = tpRaw / perPt;
        out.tpPrice = entry + dir * out.tpDist;
      } else if (tpMode === 'rr' && tpRaw > 0 && out.slDist > 0) {
        out.tpDist = out.slDist * tpRaw;
        out.tpPrice = entry + dir * out.tpDist;
      }
      out.tpMoney = (out.tpDist > 0 && perPt > 0) ? out.tpDist * perPt : out.tpMoney;
    }
    out.slMoney = (out.slDist > 0 && perPt > 0) ? out.slDist * perPt : out.slMoney;
    return out;
  },

  _autoLot() {
    const sym = this.currentSymbol();
    const s = this._spec();
    if (!s) return;
    const side = 0; // geometry direction doesn't change the distance
    const type = this.els.type.value;
    const g = this._riskGeom(side, type);
    if (!(g.slDist > 0)) {
      this._status('Set an SL first (Points / Money / Risk % modes) — Auto lot sizes from the SL distance', true);
      return;
    }
    let money = g.slMoney;
    if (this.els.slMode.value === 'risk') {
      const pct = parseFloat(this.els.riskPct.value);
      const acc2 = TradeRoute.account();
      const eq = TradeRoute.equity() || (acc2 ? acc2.balance : 0);
      if (isFinite(pct) && pct > 0) money = eq * pct / 100;
    }
    if (!(money > 0)) { this._status('Risk target is 0 — nothing to size', true); return; }
    const lot = Trade.lotForRisk(sym, money, g.slDist);
    if (!(lot > 0)) { this._status('Risk target too small for one minimum lot', true); return; }
    this.els.volume.value = Trade.clampVolume(sym, lot);
    U.lsSet(K.vol, this.els.volume.value);
    this._status('Volume set to ' + this.els.volume.value + ' lots for a ' + this._fmtMoney(money) + ' risk');
    this._refreshFast();
  },

  _status(msg, isErr) {
    this.els.status.textContent = msg || '';
    this.els.status.classList.toggle('err', !!isErr);
    this.els.status.classList.toggle('ok', !isErr && !!msg);
  },

  /* ---------- rendering ---------- */
  _refreshSymbolOptions() {
    const sel = this.els.symbol;
    const syms = [];
    for (const p of App.panes) if (p.symbol && !syms.includes(p.symbol)) syms.push(p.symbol);
    const cur = this.currentSymbol();
    if (!syms.includes(cur)) syms.unshift(cur);
    const prev = sel.value;
    sel.innerHTML = '';
    for (const s of syms) {
      const o = document.createElement('option');
      o.value = s; o.textContent = s;
      sel.appendChild(o);
    }
    sel.value = (prev && syms.includes(prev)) ? prev : cur;
  },

  _refreshChips() {
    const s = this._spec();
    const step = (s && s.vol_step) || 0.01;
    const chips = [step, step * 10, step * 50, step * 100];
    const host = this.els.volChips;
    host.innerHTML = '';
    for (const c of chips) {
      const b = U.el('button', 'tt-chip', host);
      const v = Trade.clampVolume(this.currentSymbol(), c);
      b.textContent = v;
      b.title = 'Volume ' + v;
      b.addEventListener('click', () => {
        this.els.volume.value = v;
        U.lsSet(K.vol, String(v));
        this._refreshFast();
      });
    }
  },

  _refreshAll() {
    if (!this.els.wrap) return;
    this._refreshSymbolOptions();
    this._refreshChips();
    const type = this.els.type.value;
    const pend = type !== 'market';
    this.els.priceRow.style.display = pend ? '' : 'none';
    this.els.slRow.style.display = type === 'stoplimit' ? '' : 'none';
    this.els.expRow.style.display = pend ? '' : 'none';
    this.els.dev.style.display = type === 'market' ? '' : 'none';
    /* ROUND120: Stop-Limit needs order types 6/7, which the demo engine
       does not simulate — the option hides (and self-corrects) in Demo */
    const slOpt = this.els.type.querySelector('option[value="stoplimit"]');
    if (slOpt) {
      slOpt.disabled = TradeRoute.isDemo();
      slOpt.hidden = TradeRoute.isDemo();
      if (TradeRoute.isDemo() && this.els.type.value === 'stoplimit') {
        this.els.type.value = 'limit';
        U.lsSet(K.type, 'limit');
      }
    }
    this._refreshFast(true);
  },

  _refreshFast(full) {
    if (!this.els.wrap || !this.els.wrap.offsetParent) {
      /* ROUND102: a hidden ticket must not leave preview lines behind */
      if (this._prev) this._clearPreview();
      return; // panel hidden
    }
    /* keep the chart-P/L checkbox in sync when toggled from the dock chip */
    if (this.els.plTag && this.els.plTag.checked !== Trade.plTag) this.els.plTag.checked = Trade.plTag;
    if (this.els.volTag && this.els.volTag.checked !== Trade.volTag) this.els.volTag.checked = Trade.volTag;
    /* make sure the CURRENT symbol's specs are here (volume step, stops
       level, tick value power the risk block). Retried from this 500ms
       tick until it lands — covers boot-before-login and reconnects. */
    const sym0 = this.currentSymbol();
    if (!this._specAsked) this._specAsked = {};
    if (!this._specAsked[sym0]) {
      this._specAsked[sym0] = true;
      Trade.spec(sym0).then(() => this._refreshAll()).catch(() => { delete this._specAsked[sym0]; });
    }
    const e = this.els;
    /* account strip — ROUND120: the ACTIVE account (demo engine or the live
       bridge) through the route; the mode chip names which one it is */
    const demo = TradeRoute.isDemo();
    if (e.modechip) {
      const mtxt = demo ? 'DEMO' : 'LIVE';
      if (e.modechip.textContent !== mtxt) e.modechip.textContent = mtxt;
      e.modechip.classList.toggle('demo', demo);
    }
    const acc = TradeRoute.account();
    if (acc) {
      e.accName.textContent = (acc.demo
        ? 'Demo account'
        : ((acc.name || acc.server || 'Account') + (acc.login ? ' · #' + acc.login : ''))) +
        ' · ' + (acc.currency || 'USD');
      const eq = acc.demo ? acc.equity : TradeRoute.equity();
      const fl = acc.demo ? (acc.profit || 0) : (eq - acc.balance);
      e.balance.textContent = acc.balance.toFixed(2);
      e.equity.textContent = eq.toFixed(2);
      e.float.textContent = this._fmtMoney(fl);
      e.float.className = fl > 0.004 ? 'pos' : (fl < -0.004 ? 'neg' : '');
      e.margin.textContent = (acc.margin || 0).toFixed(2);
      e.free.textContent = (acc.margin_free != null ? acc.margin_free : 0).toFixed(2);
      const lv = acc.margin_level || 0;
      e.level.textContent = lv > 0 ? lv.toFixed(1) + '%' : '—';
      e.level.className = (lv > 0 && lv < 200) ? 'neg' : '';
    } else if (demo) {
      e.accName.textContent = 'Demo account';
    } else if (Trade.lastErr) {
      e.accName.textContent = 'Trading bridge: ' + Trade.lastErr;
    }
    /* symbol price header */
    const sym = this.currentSymbol();
    const s = this._spec();
    const q = TradeRoute.quote(sym);
    const type = e.type.value;
    const bid = (q && q.bid) || (s && s.bid) || 0;
    const ask = (q && q.ask) || (s && s.ask) || 0;
    e.bid.textContent = type === 'market' ? this._fmtP(sym, bid) : e.bid.textContent;
    e.ask.textContent = type === 'market' ? this._fmtP(sym, ask) : e.ask.textContent;
    if (type !== 'market') {
      e.bid.textContent = this._fmtP(sym, parseFloat(e.price.value) || bid);
      e.ask.textContent = this._fmtP(sym, parseFloat(e.price.value) || ask);
    }
    e.spread.textContent = (s && bid > 0) ?
      ('Spread ' + Trade.spreadPts(sym) + ' pts · stops level ' + (s.stops_level || 0) + ' pts · vol ' + (s.vol_min || 0) + '–' + (s.vol_max || 0)) : '';

    /* prefill pending price from the market (once per symbol/type switch) */
    if (full && type !== 'market' && !(parseFloat(e.price.value) > 0)) {
      e.price.value = this._fmtP(sym, type === 'limit' ? bid : ask);
    }

    /* risk geometry.
       ROUND102 CORRECTNESS FIX: this preview was hard-wired to side 0 (buy),
       so in every relative mode (Points / Money / Risk% / R:R) it printed the
       BUY stop price while you were about to SELL — the number under the
       SELL button was the mirror image of the order that would actually be
       sent. The armed side (hover / confirm) drives it now, and with no side
       armed both are shown so nothing is silently wrong. */
    const armed = this._armedSide != null ? this._armedSide : this._hoverSide;
    const g = this._riskGeom(armed != null ? armed : 0, type);
    const gS = armed == null ? this._riskGeom(1, type) : null;
    const px2 = (buyP, sellP) => (armed != null
      ? this._fmtP(sym, buyP)
      : 'buy ' + this._fmtP(sym, buyP) + ' / sell ' + this._fmtP(sym, sellP));
    if (e.slOn.checked) {
      e.slVal.disabled = e.slMode.value === 'risk';
      const dist = g.slDist;
      e.slInfo.textContent = (g.slPrice > 0 && dist > 0) ?
        ('SL ' + px2(g.slPrice, gS ? gS.slPrice : g.slPrice) + '  ·  ' +
          Math.round(dist / (s.point || 1e-5)) + ' pts  ·  risk ' + this._fmtMoney(g.slMoney)) : '—';
    } else {
      e.slVal.disabled = true;
      e.slInfo.textContent = 'SL disabled';
      g.slDist = 0;
    }
    if (e.tpOn.checked) {
      e.tpVal.disabled = false;
      e.tpInfo.textContent = (g.tpPrice > 0 && g.tpDist > 0) ?
        ('TP ' + px2(g.tpPrice, gS ? gS.tpPrice : g.tpPrice) + '  ·  ' +
          Math.round(g.tpDist / (s.point || 1e-5)) + ' pts  ·  reward ' + this._fmtMoney(g.tpMoney)) : '—';
    } else {
      e.tpVal.disabled = true;
      e.tpInfo.textContent = 'TP disabled';
      g.tpDist = 0;
    }
    if (g.slDist > 0 && g.tpDist > 0) {
      e.rrInfo.textContent = 'R:R  1 : ' + (g.tpDist / g.slDist).toFixed(2);
    } else if (g.slDist > 0) {
      e.rrInfo.textContent = 'Risk ' + this._fmtMoney(g.slMoney) + ' · volume ' + this._volume() + ' lots';
    } else {
      e.rrInfo.textContent = '';
    }
  },

  /* ---------- order placement ---------- */
  _orderTypeNum(type, side) {
    if (type === 'market') return side === 0 ? OT.BUY : OT.SELL;
    if (type === 'limit') return side === 0 ? OT.BUY_LIMIT : OT.SELL_LIMIT;
    if (type === 'stop') return side === 0 ? OT.BUY_STOP : OT.SELL_STOP;
    return side === 0 ? OT.BUY_STOP_LIMIT : OT.SELL_STOP_LIMIT;
  },

  _place(side) {
    const e = this.els;
    const sym = this.currentSymbol();
    const s = this._spec();
    const type = e.type.value;
    const vol = this._volume();
    if (!(vol > 0)) { this._status('Invalid volume', true); return; }
    if (!s) { this._status('Symbol specs not loaded yet — try again', true); Trade.spec(sym).then(() => this._refreshAll()); return; }
    const sideName = side === 0 ? 'BUY' : 'SELL';
    const g = this._riskGeom(side, type);
    const sl = e.slOn.checked && g.slPrice > 0 ? Number(g.slPrice.toFixed(s.digits)) : 0;
    const tp = e.tpOn.checked && g.tpPrice > 0 ? Number(g.tpPrice.toFixed(s.digits)) : 0;
    const dev = parseInt(e.dev.value, 10) || 20;
    const price = type === 'market' ? 0 : (parseFloat(e.price.value) || 0);
    const stoplimit = type === 'stoplimit' ? (parseFloat(e.stoplimit.value) || 0) : 0;
    if (type !== 'market' && !(price > 0)) { this._status('Enter the order price', true); return; }
    if (type === 'stoplimit' && !(stoplimit > 0)) { this._status('Enter the limit price for the stop-limit', true); return; }
    /* client-side stops-distance pre-check (server re-validates).
       MT5 semantics: the ENTRY must sit >= stops_level from the CURRENT
       market price; SL/TP must sit >= stops_level from their ENTRY
       (market price for market orders, the order price for pendings). */
    const q = TradeRoute.quote(sym) || { bid: s.bid, ask: s.ask };
    const mktRef = side === 0 ? (s.ask || q.ask) : (s.bid || q.bid);
    const entryRef = type === 'market' ? mktRef : price;
    const minPts = s.stops_level || 0;
    if (minPts > 0 && mktRef > 0 && entryRef > 0) {
      const pts = (p, ref) => Math.abs(p - ref) / s.point;
      if ((type !== 'market' && pts(price, mktRef) < minPts) ||
          (sl > 0 && pts(sl, entryRef) < minPts) ||
          (tp > 0 && pts(tp, entryRef) < minPts)) {
        this._status('SL/TP/entry too close to the market (min ' + minPts + ' pts)', true);
        return;
      }
    }
    let typeTime = 'gtc', expiration = 0;
    if (type !== 'market') {
      typeTime = e.expiry.value;
      if (typeTime === 'specified') {
        const t = e.expiryAt.value ? new Date(e.expiryAt.value).getTime() / 1000 : 0;
        if (!(t > 0)) { this._status('Pick the expiry date/time', true); return; }
        expiration = Math.floor(t);
      }
    }
    const desc = sideName + ' ' + vol + ' ' + sym +
      (type !== 'market' ? ' ' + type.toUpperCase() + ' @ ' + this._fmtP(sym, price) : ' @ market') +
      (sl > 0 ? ' · SL ' + this._fmtP(sym, sl) : '') + (tp > 0 ? ' · TP ' + this._fmtP(sym, tp) : '');
    /* ROUND120: the route gate covers BOTH modes — the live AutoTrading
       check AND the demo engine's availability (price source, replay) */
    const gate = TradeRoute.canTrade();
    if (!gate.ok) {
      this._status(gate.reason, true);
      UI.toast(gate.reason, '');
      return;
    }
    const send = () => {
      this._status('Sending ' + desc + '…');
      /* ROUND120: unified send path — demo → the demo broker, live → the
         MetaTrader bridge, decided by the mode switch */
      TradeRoute.sendOrder({
        symbol: sym, orderType: this._orderTypeNum(type, side), volume: vol,
        price, stoplimit, sl, tp, pend: type !== 'market', deviation: dev,
        comment: e.comment.value || '', typeTime, expiration,
      }).then((res) => {
        const bad = !(res && res.ok);
        const rc = bad && res.retcode ? ' [retcode ' + res.retcode + ']' : '';
        this._status(desc + '  →  ' + ((res && (res.comment || res.error)) || 'done') + rc, bad);
        UI.toast((TradeRoute.isDemo() ? 'DEMO ' : '') + desc + ' — ' +
          ((res && (res.comment || res.error)) || 'done') + rc, bad ? '' : 'ok');
      }).catch((err) => {
        /* err.message now carries the broker's retcode + comment (feed.js) */
        this._status(desc + '  →  ' + (err.message || 'failed'), true);
        UI.toast('Order failed: ' + (err.message || ''), '');
      });
    };
    if (e.oneClick.checked) { send(); return; }
    /* ROUND102: window.confirm() is a MODAL native dialog — it froze the
       renderer, so quotes, the chart and the very P/L you were judging the
       entry on all stopped until you answered, and the price you confirmed
       was already stale. Replaced with an ARM-then-confirm on the button
       itself: the first click arms it (and pins the chart preview of the
       exact entry / SL / TP), the second click inside 5s sends it. Esc or
       any other click disarms. Nothing blocks, nothing is hidden. */
    if (this._armedSide === side) { this._disarm(); send(); return; }
    this._arm(side, desc);
  },

  _arm(side, desc) {
    this._disarm();
    const btn = side === 0 ? this.els.buy : this.els.sell;
    this._armedSide = side;
    this._armPrev = btn.innerHTML;
    btn.classList.add('tt-armed');
    btn.innerHTML = '<span class="tt-exec-side">CONFIRM ' + (side === 0 ? 'BUY' : 'SELL') +
      '</span><span class="tt-exec-px">click again</span>';
    this._status(desc + ' — click again to send (Esc cancels)');
    this._preview(side);
    this._refreshFast();
    this._armKey = (ev) => { if (ev.key === 'Escape') { this._disarm(); this._status(''); } };
    document.addEventListener('keydown', this._armKey, true);
    this._armTimer = setTimeout(() => { this._disarm(); this._status('Order not sent — confirmation timed out'); }, 5000);
  },

  _disarm() {
    if (this._armTimer) { clearTimeout(this._armTimer); this._armTimer = null; }
    if (this._armKey) { document.removeEventListener('keydown', this._armKey, true); this._armKey = null; }
    if (this._armedSide != null) {
      const btn = this._armedSide === 0 ? this.els.buy : this.els.sell;
      btn.classList.remove('tt-armed');
      if (this._armPrev != null) btn.innerHTML = this._armPrev;
      /* the price spans were replaced wholesale — re-resolve them */
      this.els.bid = this.els.wrap.querySelector('#tt-bid');
      this.els.ask = this.els.wrap.querySelector('#tt-ask');
      this._armPrev = null;
      this._armedSide = null;
    }
    if (this._hoverSide == null) this._preview(null);
    this._refreshFast();
  },

  /* ---------- ROUND85: real order ticket for the chart (+) price menu ----
     (the demo stub that used to own Toolbar.openOrderTicket is overridden
     in app.js — this is the TV-style entry point from the price axis) */
  openTicket(pane, presetPrice, preset) {
    try { RightPanel.showTab('trade'); } catch (e) {}
    if (pane && pane.symbol) this._sym = pane.symbol; // ticket targets the clicked chart
    if (preset && preset.type) {
      this.els.type.value = preset.type;
      U.lsSet(K.type, preset.type);
    }
    if (presetPrice != null && isFinite(presetPrice)) {
      this.els.type.value = this.els.type.value === 'market' ? 'limit' : this.els.type.value;
      this.els.price.value = String(presetPrice);
      U.lsSet(K.type, this.els.type.value);
    }
    this._refreshAll();
  },
};

export { TradeTicket };
