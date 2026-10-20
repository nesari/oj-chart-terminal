/**
 * ROUND128 (user request) — the Modify-position / Modify-order MODAL.
 *
 * "روی هر معامله که کاربر بازمیکنه در بخش Toolbox و همچنین روی خود خط چین
 *  معامله روی چارت اگر دابل کلیک کنه یک Modal باز بشه که توش کاربر قابلیت
 *  پارشیال اگزیت و همچنین تغییر استاپ لاس و تی پی داشته باشه … و اگر کاربر
 *  روی خود چارت روی خود معامله راست کلیک کنه هم یک گزینه به اسم
 *  Modify position قرار بده که وقتی کاربر روی اون بزنه همون modal باز بشه."
 *
 * ONE modal serves every entry point:
 *   · double-click on a Positions/Orders row in the Tool Box (dock.js)
 *   · double-click on the trade's line on the chart (overlay.js + the demo
 *     overlay in replaytrade.js)
 *   · the right-click trade menu's "Modify position" / "Modify order" item
 *
 * Everything routes through TradeRoute, so the SAME modal works on the
 * LIVE broker account AND the demo account (live market + Bar Replay).
 * Position variant: partial exit of ANY volume (step-clamped, with quick
 * % chips), full close, SL/TP edit. Order variant: price + SL/TP edit,
 * cancel. The card self-refreshes on a 500ms timer — a position that
 * closes externally (SL/TP hit) dismisses the modal gracefully.
 *
 * @module trade/modify
 */
import { U } from '../core/util.js';
import { UI } from '../drawing/ui.js';
import { Trade, OT_NAME } from './state.js';
import { TradeRoute } from './route.js';

const TradeModify = {
  _root: null,      // the backdrop element
  _ctx: null,       // { kind:'pos'|'ord', ticket }
  _tick: null,      // live refresh timer

  isOpen() { return !!this._root; },

  open(kind, ticket) {
    ticket = Number(ticket);
    const pos = kind === 'ord'
      ? null
      : (TradeRoute.positions() || []).find((p) => Number(p.ticket) === ticket);
    const ord = kind === 'ord'
      ? (TradeRoute.orders() || []).find((o) => Number(o.ticket) === ticket)
      : null;
    if (!pos && !ord) {
      UI.toast('Trade not found — it may already be closed', '');
      return;
    }
    /* ROUND128 FIX: tear the previous dialog down BEFORE capturing the new
       context — _build used to call close() itself, which nulled _ctx and
       silently killed the 500ms live-refresh timer (current price / P/L
       never painted). */
    this.close();
    this._ctx = { kind: pos ? 'pos' : 'ord', ticket };
    this._build(pos, ord);
    if (this._tick) clearInterval(this._tick);
    this._tick = setInterval(() => this._liveRefresh(), 500);
  },

  close() {
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    if (this._root) { try { this._root.remove(); } catch (e) {} this._root = null; }
    this._offDoc && this._offDoc();
    this._offDoc = null;
    this._ctx = null;
  },

  /* ---------- helpers ---------- */
  _spec(symbol) { return Trade.specSync(symbol) || {}; },
  _digits(symbol) { const s = this._spec(symbol); return (s.digits != null) ? s.digits : 5; },

  _clampVol(symbol, want, have) {
    const s = this._spec(symbol);
    const step = (s.vol_step > 0) ? s.vol_step : 0.01;
    const vmin = (s.vol_min > 0) ? s.vol_min : 0.01;
    let v = Math.round(want / step) * step;
    v = Math.min(v, Math.round(have / step) * step);
    v = Number(v.toFixed(8));
    if (!(v >= vmin)) v = (have >= vmin) ? vmin : have;   // tiny positions: close what exists
    return Number(v.toFixed(8));
  },

  _pct(pos, p) {
    return () => {
      const inp = this._root && this._root.querySelector('#tm-vol');
      if (!inp) return;
      inp.value = String(Number(this._clampVol(pos.symbol, pos.volume * p, pos.volume).toFixed(8)));
      this._paintRemain(pos);
    };
  },

  _paintRemain(pos) {
    if (!this._root) return;
    const inp = this._root.querySelector('#tm-vol');
    const out = this._root.querySelector('#tm-remain');
    if (!inp || !out) return;
    const v = this._clampVol(pos.symbol, parseFloat(String(inp.value).replace(',', '.')) || 0, pos.volume);
    const rest = Number((pos.volume - v).toFixed(8));
    out.textContent = rest > 0
      ? ('Remaining after close: ' + rest + ' lots')
      : 'Closes the WHOLE position';
  },

  /* ---------- build ---------- */
  _build(pos, ord) {
    /* NOTE: no close() here — open() owns the teardown so the live-refresh
       timer + context survive the rebuild. */
    const root = U.el('div', 'tm-backdrop', document.body);
    this._root = root;
    const card = U.el('div', 'tm-card', root);
    const isDemo = TradeRoute.isDemo();
    const dg = (p) => this._digits(p ? pos.symbol : ord.symbol);

    if (pos) {
      const side = pos.type === 0 ? 'BUY' : 'SELL';
      card.innerHTML = `
        <div class="tm-head">
          <span class="tm-side ${pos.type === 0 ? 'buy' : 'sell'}">${side}</span>
          <b class="tm-sym">${U.esc(pos.symbol)}</b>
          <span class="tm-vol-tag">${pos.volume} lots</span>
          <span class="tm-chip">${isDemo ? 'DEMO' : 'LIVE'}</span>
          <span class="tm-t">#${pos.ticket}</span>
          <button class="tm-x" title="Close (Esc)">×</button>
        </div>
        <div class="tm-info">
          <span>Open <b>${Number(pos.open).toFixed(dg(pos))}</b></span>
          <span>Current <b class="tm-cur">—</b></span>
          <span>P/L <b class="tm-pl">—</b></span>
        </div>

        <div class="tm-sec">
          <div class="tm-sec-title">Partial exit — close any volume you want</div>
          <div class="tm-row">
            <input type="text" id="tm-vol" inputmode="decimal" spellcheck="false" title="Volume to close (lots)">
            <span class="tm-unit">lots</span>
          </div>
          <div class="tm-chips">
            <button class="tm-chip-b" data-p="0.25">25%</button>
            <button class="tm-chip-b" data-p="0.50">50%</button>
            <button class="tm-chip-b" data-p="0.75">75%</button>
            <button class="tm-chip-b" data-p="1">Max</button>
          </div>
          <div class="tm-hint" id="tm-remain"></div>
          <div class="tm-actions">
            <button class="tm-btn" id="tm-closepart">Close partial</button>
            <button class="tm-btn danger" id="tm-closeall">Close all</button>
          </div>
        </div>

        <div class="tm-sec">
          <div class="tm-sec-title">Stop loss / Take profit</div>
          <div class="tm-row"><label class="tm-lbl sl">SL</label>
            <input type="text" id="tm-sl" inputmode="decimal" spellcheck="false" placeholder="none"></div>
          <div class="tm-row"><label class="tm-lbl tp">TP</label>
            <input type="text" id="tm-tp" inputmode="decimal" spellcheck="false" placeholder="none"></div>
          <div class="tm-actions">
            <button class="tm-btn" id="tm-apply-sltp">Apply SL / TP</button>
          </div>
        </div>`;
    } else {
      card.innerHTML = `
        <div class="tm-head">
          <span class="tm-side ord">${OT_NAME[ord.type] || 'Order'}</span>
          <b class="tm-sym">${U.esc(ord.symbol)}</b>
          <span class="tm-vol-tag">${ord.volume} lots</span>
          <span class="tm-chip">${isDemo ? 'DEMO' : 'LIVE'}</span>
          <span class="tm-t">#${ord.ticket}</span>
          <button class="tm-x" title="Close (Esc)">×</button>
        </div>
        <div class="tm-info">
          <span>Order price <b>${Number(ord.price).toFixed(dg(ord))}</b></span>
          <span>Current <b class="tm-cur">—</b></span>
        </div>

        <div class="tm-sec">
          <div class="tm-sec-title">Order price</div>
          <div class="tm-row">
            <input type="text" id="tm-price" inputmode="decimal" spellcheck="false"
              value="${Number(ord.price).toFixed(dg(ord))}">
          </div>
        </div>

        <div class="tm-sec">
          <div class="tm-sec-title">Stop loss / Take profit</div>
          <div class="tm-row"><label class="tm-lbl sl">SL</label>
            <input type="text" id="tm-sl" inputmode="decimal" spellcheck="false" placeholder="none"></div>
          <div class="tm-row"><label class="tm-lbl tp">TP</label>
            <input type="text" id="tm-tp" inputmode="decimal" spellcheck="false" placeholder="none"></div>
          <div class="tm-actions">
            <button class="tm-btn" id="tm-apply-order">Apply changes</button>
            <button class="tm-btn danger" id="tm-cancel-ord">Cancel order</button>
          </div>
        </div>`;
    }

    /* ---- wire the common parts ---- */
    card.querySelector('.tm-x').addEventListener('click', () => this.close());
    root.addEventListener('mousedown', (ev) => { if (ev.target === root) this.close(); });
    this._offDoc = (() => {
      const key = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); this.close(); } };
      document.addEventListener('keydown', key, true);
      return () => document.removeEventListener('keydown', key, true);
    })();

    if (pos) this._wirePos(pos); else this._wireOrd(ord);
    this._liveRefresh();
  },

  _wirePos(pos) {
    const root = this._root;
    const d = this._digits(pos.symbol);
    const vol = root.querySelector('#tm-vol');
    const sl = root.querySelector('#tm-sl');
    const tp = root.querySelector('#tm-tp');
    vol.value = String(pos.volume);
    sl.value = pos.sl > 0 ? Number(pos.sl).toFixed(d) : '';
    tp.value = pos.tp > 0 ? Number(pos.tp).toFixed(d) : '';
    this._paintRemain(pos);
    vol.addEventListener('input', () => this._paintRemain(pos));
    for (const b of root.querySelectorAll('.tm-chip-b')) {
      b.addEventListener('click', (this._pct(pos, parseFloat(b.dataset.p))));
    }
    const num = (inp) => {
      const v = parseFloat(String(inp.value).replace(',', '.'));
      return isFinite(v) && v > 0 ? Number(v.toFixed(d)) : 0;
    };
    root.querySelector('#tm-closepart').addEventListener('click', () => {
      const v = this._clampVol(pos.symbol, parseFloat(String(vol.value).replace(',', '.')) || 0, pos.volume);
      if (!(v > 0)) { UI.toast('Enter the volume to close', ''); return; }
      TradeRoute.close(pos.ticket, v).then(() => {
        UI.toast('Partial close sent — ' + v + ' lots of #' + pos.ticket, 'ok');
      }).catch((err) => UI.toast('Partial close rejected: ' + (err.message || ''), ''));
    });
    root.querySelector('#tm-closeall').addEventListener('click', () => {
      TradeRoute.close(pos.ticket, 0).then(() => {
        UI.toast('Close sent — #' + pos.ticket, 'ok');
        this.close();
      }).catch((err) => UI.toast('Close rejected: ' + (err.message || ''), ''));
    });
    root.querySelector('#tm-apply-sltp').addEventListener('click', () => {
      const s2 = num(sl), t2 = num(tp);
      TradeRoute.modifySLTP(pos.ticket, s2, t2).then(() => {
        UI.toast('SL/TP applied — #' + pos.ticket, 'ok');
      }).catch((err) => UI.toast('Modify rejected: ' + (err.message || ''), ''));
    });
  },

  _wireOrd(ord) {
    const root = this._root;
    const d = this._digits(ord.symbol);
    const px = root.querySelector('#tm-price');
    const sl = root.querySelector('#tm-sl');
    const tp = root.querySelector('#tm-tp');
    sl.value = ord.sl > 0 ? Number(ord.sl).toFixed(d) : '';
    tp.value = ord.tp > 0 ? Number(ord.tp).toFixed(d) : '';
    const num = (inp) => {
      const v = parseFloat(String(inp.value).replace(',', '.'));
      return isFinite(v) && v > 0 ? Number(v.toFixed(d)) : 0;
    };
    root.querySelector('#tm-apply-order').addEventListener('click', () => {
      const p2 = num(px), s2 = num(sl), t2 = num(tp);
      if (!(p2 > 0)) { UI.toast('Enter a valid order price', ''); return; }
      TradeRoute.modifyOrder(ord.ticket, p2, s2, t2).then(() => {
        UI.toast('Order modified — #' + ord.ticket, 'ok');
      }).catch((err) => UI.toast('Modify rejected: ' + (err.message || ''), ''));
    });
    root.querySelector('#tm-cancel-ord').addEventListener('click', () => {
      TradeRoute.cancel(ord.ticket).then(() => {
        UI.toast('Order cancelled — #' + ord.ticket, 'ok');
        this.close();
      }).catch((err) => UI.toast('Cancel rejected: ' + (err.message || ''), ''));
    });
  },

  /* ---------- 500ms live refresh (current price / P/L / state) ---------- */
  _liveRefresh() {
    if (!this._root || !this._ctx) return;
    if (this._ctx.kind === 'pos') {
      const pos = (TradeRoute.positions() || []).find((p) => Number(p.ticket) === Number(this._ctx.ticket));
      if (!pos) {
        const { symbol, ticket } = this._ctx;
        this.close();
        UI.toast('Position #' + ticket + ' (' + symbol + ') is closed', 'ok');
        return;
      }
      const q = TradeRoute.quote(pos.symbol) || {};
      const cur = (pos.type === 0 ? q.bid : q.ask) || pos.current || 0;
      const dg = this._digits(pos.symbol);
      const curEl = this._root.querySelector('.tm-cur');
      const plEl = this._root.querySelector('.tm-pl');
      if (curEl && cur > 0) curEl.textContent = Number(cur).toFixed(dg);
      if (plEl) {
        const pl = TradeRoute.profitOf(pos);
        plEl.textContent = (pl > 0 ? '+$' : (pl < 0 ? '-$' : '$')) + Math.abs(pl).toFixed(2);
        plEl.className = 'tm-pl ' + (pl > 0.004 ? 'pos' : (pl < -0.004 ? 'neg' : ''));
      }
      /* the volume chips + remain line + head tag follow the (possibly
         partially closed) live volume — the input never loses focus */
      const tag = this._root.querySelector('.tm-vol-tag');
      if (tag && String(pos.volume) !== tag.textContent.replace(' lots', '')) {
        tag.textContent = pos.volume + ' lots';
      }
      const inp = this._root.querySelector('#tm-vol');
      if (inp && document.activeElement !== inp) {
        const shown = String(pos.volume);
        if (inp.value !== shown) { inp.value = shown; }
      }
      this._paintRemain(pos);
    } else {
      const ord = (TradeRoute.orders() || []).find((o) => Number(o.ticket) === Number(this._ctx.ticket));
      if (!ord) {
        const { symbol, ticket } = this._ctx;
        this.close();
        UI.toast('Order #' + ticket + ' (' + symbol + ') is gone — filled or cancelled', 'ok');
        return;
      }
      const q = TradeRoute.quote(ord.symbol) || {};
      const curEl = this._root.querySelector('.tm-cur');
      if (curEl && q.bid > 0) curEl.textContent = Number(q.bid).toFixed(this._digits(ord.symbol));
    }
  },
};

export { TradeModify };
