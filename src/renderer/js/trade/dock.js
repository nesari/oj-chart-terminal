/**
 * ROUND85c — bottom Trading dock: live account bar + Positions / Orders /
 * History tables with full trade management.
 *
 * Positions rows: live P/L (client-computed from the tick stream between
 * provider polls), inline SL/TP editor, full/partial close (50%), close all.
 * Orders rows: pending limit/stop/stop-limit with inline price+SL/TP editor
 * and cancel. History: date-range chips, grouped by position (MT5 deals IN +
 * OUT), summary (trades / win rate / net P/L / best / worst).
 *
 * ROUND85c (user requests): the dock has its own header ICON, a proper
 * open/close pair (the × button hides it; a Trading toggle stays in the
 * bottom toolbar to bring it back), a chart-P/L toggle chip, and the
 * tables adapt to the app window width (columns fold away on narrow
 * windows instead of overflowing).
 *
 * The dock is collapsible (header-only) and resizable from its top edge,
 * both persisted.
 *
 * ROUND113 — THE HISTORY TAB BECAME THE METATRADER GRID (user request,
 * with the terminal screenshot):
 *   · every trade row carries the terminal's columns — Time · Symbol ·
 *     Ticket · Type · Volume · Price · S/L · T.P. · Time · Price · Value ·
 *     Commission · Fee · Swap · Profit · Change · Magic · Comment —
 *     separated by real GRID lines (vertical rules + row rules).
 *   · RIGHT-CLICK anywhere in the history section opens the column on/off
 *     menu; toggling items keeps the menu OPEN (multi-toggle without
 *     re-opening); any press OUTSIDE the menu closes it. Hidden columns
 *     persist (mt5_tr_hist_cols).
 *   · a trade closed by STOP shows its S/L cell painted RED; closed by
 *     TAKE-PROFIT shows the T.P. cell GREEN (deal reason 4/5 — the demo
 *     provider stamps it, the MT5 bridge passes the terminal's own).
 *   · the sticky TOTAL bar under the table: "Profit … Credit … Deposit …
 *     Withdrawal … Balance …" on the left and the Commission/Fee/Swap/
 *     Profit sums aligned under their columns on the right.
 *
 * @module trade/dock
 */
import { App } from '../../../core/state.js';
import { U } from '../core/util.js';
import { UI } from '../drawing/ui.js';
import { icon } from '../ui/icons.js';
import { Trade, OT_NAME } from './state.js';
import { TradeRoute } from './route.js';
import { TradeModify } from './modify.js';
import { GoToDate } from '../panels/gotodate.js';
import { TZ } from '../../../core/timezone.js';

const K = { vis: 'mt5_tr_dock', h: 'mt5_tr_dock_h', tab: 'mt5_tr_dock_tab', range: 'mt5_tr_hist_range',
  sortP: 'mt5_tr_sort_pos', sortH: 'mt5_tr_sort_hist', sortO: 'mt5_tr_sort_ord',
  hcols: 'mt5_tr_hist_cols', pcols: 'mt5_tr_pos_cols', ocols: 'mt5_tr_ord_cols' };
const RANGES = [
  ['today', 'Today'], ['d3', '3 days'], ['week', 'Week'], ['month', 'Month'], ['all', 'All'],
];

/* ROUND113 — the MetaTrader-style History columns (order = the terminal's).
   The user right-clicks the history grid and toggles each one; hidden ids
   persist under K.hcols (store HIDDEN ids so future columns default ON). */
const HIST_COLS = [
  { id: 'time',    label: 'Time (open)',  head: 'Time',      w: 122, num: false },
  { id: 'symbol',  label: 'Symbol',       head: 'Symbol',    w: 66,  num: false },
  { id: 'ticket',  label: 'Ticket',       head: 'Ticket',    w: 78,  num: true  },
  { id: 'type',    label: 'Type',         head: 'Type',      w: 46,  num: false },
  { id: 'volume',  label: 'Volume',       head: 'Volume',    w: 52,  num: true  },
  { id: 'oprice',  label: 'Price (open)', head: 'Price',     w: 74,  num: true  },
  { id: 'sl',      label: 'S / L',        head: 'S / L',     w: 74,  num: true  },
  { id: 'tp',      label: 'T. P.',        head: 'T. P.',     w: 74,  num: true  },
  { id: 'ctime',   label: 'Time (close)', head: 'Time',      w: 122, num: false },
  { id: 'cprice',  label: 'Price (close)',head: 'Price',     w: 74,  num: true  },
  { id: 'value',   label: 'Value',        head: 'Value',     w: 66,  num: true  },
  { id: 'comm',    label: 'Commission',   head: 'Commission',w: 78,  num: true  },
  { id: 'fee',     label: 'Fee',          head: 'Fee',       w: 52,  num: true  },
  { id: 'swap',    label: 'Swap',         head: 'Swap',      w: 56,  num: true  },
  { id: 'profit',  label: 'Profit',       head: 'Profit',    w: 66,  num: true  },
  { id: 'change',  label: 'Change',       head: 'Change',    w: 62,  num: true  },
  { id: 'magic',   label: 'Magic',        head: 'Magic',     w: 64,  num: true  },
  { id: 'comment', label: 'Comment',      head: 'Comment',   w: 110, num: false },
];

function fmtMoney(v) {
  if (v == null || !isFinite(v)) return '—';
  const r = Math.round(v * 100) / 100;
  return (r > 0 ? '+' : '') + r.toFixed(2);
}

/* ROUND113 helpers — MT5 number/text shapes for the history grid */
function fmtPlain(v) {                 /* "-6.44" / "0.00" — no plus sign */
  return (v == null || !isFinite(v)) ? '—' : (Math.round(v * 100) / 100).toFixed(2);
}
function fmtChg(v) {                   /* "-0.07%" / "0.27%" — no plus */
  return (v == null || !isFinite(v)) ? '—' : (Math.round(v * 100) / 100).toFixed(2) + '%';
}
function signCls(v) {
  return v > 0.004 ? 'pos' : (v < -0.004 ? 'neg' : '');
}
/* ROUND113b: classList.add('') throws "The token provided must not be empty"
   whenever the value is zero (fee/swap on real accounts) — every dynamic
   class token must go through this guard, never straight into classList */
function addCls(el, cls) {
  if (cls) el.classList.add(cls);
}

/* column id -> the trade row field its sort reads (kept in ONE place) */
const HIST_SORT = {
  time: 'openT', symbol: 'symbol', ticket: 'pid', type: 'dir', volume: 'vol',
  oprice: 'open', sl: 'sl', tp: 'tp', ctime: 'closeT', cprice: 'close',
  value: 'value', comm: 'comm', fee: 'fee', swap: 'swap', profit: 'profit',
  change: 'change', magic: 'magic', comment: 'comment',
};

/* ROUND114 — the Positions tab became the SAME MetaTrader grid as History
   (user request): every History column that exists on an OPEN position,
   plus the app's Manage buttons as their own toggleable column. An open
   position has no commission/fee/close-time/magic, so those History columns
   are not offered here. 'cprice' is the LIVE price (history: close price). */
const POS_COLS = [
  { id: 'time',    label: 'Time (open)',   head: 'Time',    w: 122, num: false },
  { id: 'symbol',  label: 'Symbol',        head: 'Symbol',  w: 70,  num: false },
  { id: 'ticket',  label: 'Ticket',        head: 'Ticket',  w: 78,  num: true  },
  { id: 'type',    label: 'Type',          head: 'Type',    w: 50,  num: false },
  { id: 'volume',  label: 'Volume',        head: 'Volume',  w: 56,  num: true  },
  { id: 'oprice',  label: 'Open Price',    head: 'Open',    w: 76,  num: true  },
  { id: 'sl',      label: 'S / L',         head: 'S / L',   w: 76,  num: true  },
  { id: 'tp',      label: 'T. P.',         head: 'T. P.',   w: 76,  num: true  },
  { id: 'cprice',  label: 'Current Price', head: 'Price',   w: 76,  num: true  },
  { id: 'value',   label: 'Value',         head: 'Value',   w: 70,  num: true  },
  { id: 'swap',    label: 'Swap',          head: 'Swap',    w: 56,  num: true  },
  { id: 'profit',  label: 'Profit',        head: 'Profit',  w: 70,  num: true  },
  { id: 'change',  label: 'Change',        head: 'Change',  w: 62,  num: true  },
  { id: 'comment', label: 'Comment',       head: 'Comment', w: 100, num: false },
  { id: 'manage',  label: 'Manage',        head: 'Manage',  w: 130, num: false },
];

/* column id -> the position view-model field its sort reads */
const POS_SORT = {
  time: 'openT', symbol: 'symbol', ticket: 'ticket', type: 'dir', volume: 'vol',
  oprice: 'open', sl: 'sl', tp: 'tp', cprice: 'cur', value: 'value',
  swap: 'swap', profit: 'pl', change: 'change', comment: 'comment',
};

/* ROUND119 (user request) — the Orders tab became the SAME MetaTrader grid
   as Positions / History: the pending-order columns, sticky sortable header,
   grid lines, right-click column menu, dynamic width split and a Total bar.
   An order has no commission/magic/close price, and no floating P/L while it
   rests — so those History columns are not offered here. */
const ORD_COLS = [
  { id: 'time',    label: 'Placed',        head: 'Time',    w: 122, num: false },
  { id: 'symbol',  label: 'Symbol',        head: 'Symbol',  w: 70,  num: false },
  { id: 'ticket',  label: 'Ticket',        head: 'Ticket',  w: 78,  num: true  },
  { id: 'type',    label: 'Order Type',    head: 'Type',    w: 76,  num: false },
  { id: 'volume',  label: 'Volume',        head: 'Volume',  w: 56,  num: true  },
  { id: 'oprice',  label: 'Order Price',   head: 'Price',   w: 76,  num: true  },
  { id: 'sl',      label: 'S / L',         head: 'S / L',   w: 76,  num: true  },
  { id: 'tp',      label: 'T. P.',         head: 'T. P.',   w: 76,  num: true  },
  { id: 'cprice',  label: 'Current Price', head: 'Current', w: 76,  num: true  },
  { id: 'exp',     label: 'Expiry',        head: 'Expiry',  w: 116, num: false },
  { id: 'comment', label: 'Comment',       head: 'Comment', w: 90,  num: false },
  { id: 'manage',  label: 'Manage',        head: 'Manage',  w: 96,  num: false },
];

/* column id -> the order view-model field its sort reads */
const ORD_SORT = {
  time: 'openT', symbol: 'symbol', ticket: 'ticket', type: 'type', volume: 'vol',
  oprice: 'open', sl: 'sl', tp: 'tp', cprice: 'cur', exp: 'expT', comment: 'comment',
};

const TradeDock = {
  els: {},
  _tab: 'positions',
  _range: 'week',
  _sortP: null,          // {col,dir} for the Positions table
  _sortH: null,          // {col,dir} for the History table
  _sortO: null,          // ROUND119: {col,dir} for the Orders grid
  _deals: null,          // history cache
  _dealsMode: null,      // ROUND120: which account the deals cache belongs to
  _dealSum: null,
  _liveTick: null,
  _collapsed: false,
  _histHidden: null,     // ROUND113: Set of hidden HIST_COLS ids (persisted)
  _histMenu: null,       // ROUND113: the column-toggle context menu element
  _posHidden: null,      // ROUND114: Set of hidden POS_COLS ids (persisted)
  _ordHidden: null,      // ROUND119: Set of hidden ORD_COLS ids (persisted)
  _posSig: null,         // ROUND128: open-position signature (history staleness)

  init() {
    if (this.els.root) return;
    const root = document.getElementById('trade-dock');
    if (!root) return;
    this.els.root = root;
    this._build();
    this._bind();
    Trade.onChange.push(() => { this._checkHistStale(); this._render(); });
    /* ROUND117: the grids list the ACTIVE account — demo state changes
       (place/activate/cancel/modify) arrive through this passthrough.
       ROUND120: a mode flip (or any demo/live data change) also invalidates
       the per-mode history cache — the History tab must never show the
       other account's closed trades. */
    TradeRoute.onChange.push(() => {
      if (this._dealsMode !== TradeRoute.mode) { this._deals = null; this._dealSum = null; }
      this._checkHistStale();
      this._render();
    });
    this._liveTick = setInterval(() => this._updateLive(), 600);
    const vis = U.lsGet(K.vis, 'open');
    this._installBottomToggle();
    if (vis !== 'hidden') this.show(true); else this._syncToggle();
    this._tab = U.lsGet(K.tab, 'positions');
    this._range = U.lsGet(K.range, 'week');
    try { this._sortP = JSON.parse(U.lsGet(K.sortP, '') || 'null'); } catch (e) { this._sortP = null; }
    try { this._sortH = JSON.parse(U.lsGet(K.sortH, '') || 'null'); } catch (e) { this._sortH = null; }
    this._histLoad();
    this._posLoad();
    this._render();
    this._installWidthWatch();
  },

  show(force) {
    const root = this.els.root;
    root.classList.remove('hidden');
    U.lsSet(K.vis, 'open');
    if (force) this._collapsed = false;
    this._applyState();
    this._render();
    this._syncToggle();
  },
  close() {
    const root = this.els.root;
    root.classList.add('hidden');
    U.lsSet(K.vis, 'hidden');
    this._syncToggle();
  },
  toggle() {
    const root = this.els.root;
    if (root.classList.contains('hidden')) { this.show(); return; }
    this.close();
  },
  /* ROUND85c: the bottom-toolbar Trading button — the always-visible way
     to reopen the dock after the × close (and to hide it again) */
  _installBottomToggle() {
    if (this.els.toggle) return;
    const bar = document.getElementById('bottom-toolbar');
    if (!bar) return;
    const spacer = bar.querySelector('.flex-spacer');
    const b = document.createElement('button');
    b.className = 'bt-btn';
    b.id = 'td-toggle-btn';
    /* ROUND119: the dock is the "Tool Box" now (user request) — new name +
       new icon on the bottom-bar toggle too */
    b.title = 'Tool Box — positions, orders, history';
    b.innerHTML = icon('toolbox');
    b.addEventListener('click', () => this.toggle());
    if (spacer && spacer.parentNode === bar) bar.insertBefore(b, spacer.nextSibling);
    else bar.appendChild(b);
    this.els.toggle = b;
  },
  _syncToggle() {
    if (this.els.toggle) {
      this.els.toggle.classList.toggle('on', !this.els.root.classList.contains('hidden'));
      this.els.toggle.title = this.els.root.classList.contains('hidden') ?
        'Show the Tool Box' : 'Hide the Tool Box';
    }
  },
  /* ROUND85c: fold table columns away as the app window narrows — the
     tables stay readable instead of scrolling sideways */
  _installWidthWatch() {
    const apply = (w) => {
      const root = this.els.root;
      root.classList.toggle('td-narrow', w > 0 && w < 940);
      root.classList.toggle('td-xnarrow', w > 0 && w < 700);
    };
    apply(this.els.root.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver((entries) => {
        apply(Math.round(entries[0].contentRect.width));
      });
      this._ro.observe(this.els.root);
      /* ROUND103: height cap follows the window, not just the width classes */
      window.addEventListener('resize', () => {
        if (!this.els.root.classList.contains('hidden')) this._applyState();
      });
    } else {
      window.addEventListener('resize', () => apply(window.innerWidth));
    }
  },
  _applyState() {
    const root = this.els.root;
    /* ROUND102 BUGFIX: the resize handler persisted the BODY height while
       this read it back as the ROOT height — so every hide/show cycle shrank
       the dock by one header (~28px) until it collapsed to the minimum. Both
       ends speak ROOT height now, and a legacy body-height value is migrated
       on first read instead of being mis-applied. */
    const h = Number(U.lsGet(K.h, 220)) || 220;
    /* ROUND103: same rule as the right panel — the dock may never take more
       than half the window height, or a tall saved dock on a short screen
       leaves a sliver of chart and pushes its own resize edge out of reach. */
    const cap = Math.max(140, Math.min(480, Math.round(window.innerHeight * 0.5)));
    /* ROUND104: clearing the inline height fell back to the stylesheet's
       `height: 220px`, so "collapsed" left a full-height empty slab. The
       class drives the collapsed size (header only); the inline height is
       cleared so it cannot fight the class. */
    root.classList.toggle('td-collapsed', this._collapsed);
    root.style.height = this._collapsed ? '' : Math.max(140, Math.min(cap, h)) + 'px';
    this.els.body.style.display = this._collapsed ? 'none' : '';
    this.els.collapse.textContent = this._collapsed ? '▲' : '▼';
    this.els.collapse.title = this._collapsed ? 'Expand' : 'Collapse';
  },

  /* ---------- ROUND128 (user request): the History tab refreshes ITSELF ----------
     "هیستوری معاملات باید به ازای هر معامله ای که بسته میشود بصورت خودکار
     رفرش بشود" — the deals cache is invalidated the moment the open-
     position signature changes: a position CLOSED, PARTIALLY closed or a
     new one appearing (its IN deal joins the ledger). Both state streams
     (live poll + demo engine) run through the same check, so the grid
     repaints with the fresh deals without any manual ↻ press. */
  _checkHistStale() {
    let sig = '';
    try { for (const p of TradeRoute.positions()) sig += p.ticket + ':' + p.volume + ';'; } catch (e) {}
    if (sig !== this._posSig) {
      this._posSig = sig;
      this._deals = null;
      this._dealSum = null;
    }
  },

  /* ---------- build ---------- */
  _build() {
    const root = this.els.root;
    root.innerHTML = `
      <div id="td-resize" title="Drag to resize — double-click to reset"></div>
      <div id="td-head">
        <span id="td-ic"></span>
        <span id="td-title">Tool Box</span>
        <span class="td-kpi"><label>Balance</label><b id="td-balance">—</b></span>
        <span class="td-kpi td-k-margin"><label>Equity</label><b id="td-equity">—</b></span>
        <span class="td-kpi td-k-float"><label>Floating P/L</label><b id="td-float">—</b></span>
        <span class="td-kpi td-k-free"><label>Margin</label><b id="td-margin">—</b></span>
        <span class="td-kpi td-k-free"><label>Free</label><b id="td-free">—</b></span>
        <span class="td-kpi td-k-level"><label>Level</label><b id="td-level">—</b></span>
        <span id="td-status" title="Trading bridge status"></span>
        <span class="flex-spacer"></span>
        <button class="td-mini td-plbtn" id="td-pltag" title="Show the live P/L on the chart trade lines">P/L</button>
        <button class="td-mini td-volbtn" id="td-voltag" title="Show the trade volume on the chart trade lines">VOL</button>
        <button class="td-mini td-danger" id="td-closeall" title="Close every open position">Close all</button>
        <button class="td-mini" id="td-collapse">▼</button>
        <button class="td-mini td-x" id="td-closebtn" title="Close panel">×</button>
      </div>
      <div id="td-body">
        <div id="td-tabs">
          <button class="td-tab" data-t="positions">Positions</button>
          <button class="td-tab" data-t="orders">Orders</button>
          <button class="td-tab" data-t="history">History</button>
          <span class="flex-spacer"></span>
          <span id="td-summary"></span>
        </div>
        <div id="td-scroller">
          <div class="td-table" id="td-pos"></div>
          <div class="td-table hidden" id="td-ord"></div>
          <div class="td-table hidden" id="td-hist"></div>
        </div>
      </div>
    `;
    const g = (id) => root.querySelector('#' + id);
    this.els = Object.assign(this.els, {
      resize: g('td-resize'), head: g('td-head'), body: g('td-body'),
      ic: g('td-ic'), balance: g('td-balance'), equity: g('td-equity'), float: g('td-float'),
      margin: g('td-margin'), free: g('td-free'), level: g('td-level'),
      status: g('td-status'), closeAll: g('td-closeall'), collapse: g('td-collapse'),
      closeBtn: g('td-closebtn'), plTag: g('td-pltag'), volTag: g('td-voltag'),
      tabs: g('td-tabs'), summary: g('td-summary'), scroller: g('td-scroller'),
      pos: g('td-pos'), ord: g('td-ord'), hist: g('td-hist'),
    });
    if (this.els.ic) this.els.ic.innerHTML = icon('toolbox');
  },

  _bind() {
    const e = this.els;
    /* ROUND113/114 (user request): right-click anywhere in the History or
       the Positions section opens the column on/off menu (each section its
       own column list, same behavior). Toggling items must NOT close it —
       only a click OUTSIDE the menu (or Esc) does. The section hosts survive
       the re-renders (only their innerHTML is rebuilt), so one listener each
       is enough. */
    this._ensureHistMenu();
    e.hist.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._openColMenu(ev.clientX, ev.clientY, 'hist');
    });
    e.pos.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._openColMenu(ev.clientX, ev.clientY, 'pos');
    });
    /* ROUND119: the Orders grid joins the column-menu family */
    e.ord.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._openColMenu(ev.clientX, ev.clientY, 'ord');
    });
    e.tabs.addEventListener('click', (ev) => {
      const b = ev.target.closest('.td-tab');
      if (!b) return;
      this._tab = b.dataset.t;
      U.lsSet(K.tab, this._tab);
      this._render();
    });
    e.closeAll.addEventListener('click', () => {
      /* ROUND120: close ALL works on the ACTIVE account (demo engine or the
         live bridge) — the button must never close the opposite account */
      const pos = TradeRoute.positions();
      const n = pos.length;
      if (!n) { UI.toast('No open positions to close'); return; }
      /* ROUND102: window.confirm() froze the whole renderer — ticks, chart
         and the P/L you were deciding on all stopped until you answered.
         The toast confirm keeps the market moving behind it. */
      const pl = pos.reduce((a, p) => a + TradeRoute.profitOf(p), 0);
      UI.toast('Close ALL ' + n + ' open position(s)? Net ' + fmtMoney(pl), 'warn', {
        actionLabel: 'Close all',
        onAction: () => {
          TradeRoute.closeAll().then((d) => {
            UI.toast('Closed ' + ((d && (d.closed || d.ok)) ? (d.closed || 'all') : 'all') + ' position(s)', 'ok');
          }).catch((err) => {
            UI.toast('Close all failed: ' + (err.message || ''), '');
          });
        },
      });
    });
    e.collapse.addEventListener('click', () => {
      this._collapsed = !this._collapsed;
      this._applyState();
    });
    e.closeBtn.addEventListener('click', () => this.close());
    /* ROUND85c: chart P/L tag toggle — same persisted flag as the ticket */
    e.plTag.classList.toggle('on', Trade.plTag);
    e.plTag.addEventListener('click', () => Trade.setPlTag(!Trade.plTag));
    /* ROUND85d: chart VOLUME tag toggle — same persisted flag as the ticket */
    e.volTag.classList.toggle('on', Trade.volTag);
    e.volTag.addEventListener('click', () => Trade.setVolTag(!Trade.volTag));
    /* top-edge resize (like the right panel's rp-split) */
    e.resize.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const startY = ev.clientY;
      const startH = e.scroller.getBoundingClientRect().height;
      const move = (m) => {
        const h = Math.max(60, Math.min(440, Math.round(startH + (startY - m.clientY))));
        e.root.style.height = (e.root.getBoundingClientRect().height - e.scroller.getBoundingClientRect().height + h) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        document.body.style.cursor = '';
        /* ROUND102: persist the ROOT height — the same number _applyState
           writes back. (Was the body height, so the dock shrank each cycle.) */
        U.lsSet(K.h, Math.round(e.root.getBoundingClientRect().height));
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
      document.body.style.cursor = 'row-resize';
    });
    e.resize.addEventListener('dblclick', () => { U.lsSet(K.h, 220); this._applyState(); });
  },

  /* ---------- live updates ---------- */
  _updateAccountBar() {
    const e = this.els;
    /* ROUND117: the bar shows the ACTIVE account — demo rows in the grid
       must not sit under a live balance. TradeRoute.account() maps the demo
       engine's row into the live wire's shape (margin_free/level names). */
    const acc = TradeRoute.account();
    if (!acc) {
      e.status.textContent = Trade.lastErr ? 'offline' : 'connecting…';
      e.status.className = Trade.lastErr ? 'td-off' : 'td-wait';
      return;
    }
    const eq = acc.demo ? acc.equity : Trade.liveEquity();
    const fl = acc.demo ? (acc.profit || 0) : (eq - acc.balance);
    e.balance.textContent = acc.balance.toFixed(2);
    e.equity.textContent = eq.toFixed(2);
    e.float.textContent = fmtMoney(fl);
    e.float.className = fl > 0.004 ? 'pos' : (fl < -0.004 ? 'neg' : '');
    e.margin.textContent = (acc.margin || 0).toFixed(2);
    e.free.textContent = (acc.margin_free != null ? acc.margin_free : 0).toFixed(2);
    const lv = acc.margin_level || 0;
    e.level.textContent = lv > 0 ? lv.toFixed(1) + '%' : '—';
    e.level.className = (lv > 0 && lv < 200) ? 'neg' : '';
    /* round85b: surface the terminal's Algo Trading switch — the #1 reason
       orders silently fail against a real broker while everything else looks
       healthy. Persistent red chip + tooltip (demo mode always true). */
    if (acc.trade_allowed === false) {
      e.status.textContent = 'AutoTrading OFF';
      e.status.className = 'td-autooff';
      e.status.title = 'MetaTrader blocks order sending — click the "Algo Trading" button in the MetaTrader toolbar, then retry';
    } else {
      e.status.textContent = acc.demo ? 'demo' : (Trade.online ? 'live' : '…');
      e.status.className = (acc.demo || Trade.online) ? 'td-on' : 'td-wait';
      e.status.title = acc.demo ? 'Demo account — the Trading switch is on DEMO' : '';
    }
  },

  /* cheap per-tick update: only money cells, no DOM rebuild */
  _updateLive() {
    if (!this.els.root || this.els.root.classList.contains('hidden')) return;
    this._updateAccountBar();
    /* ROUND119: the Orders grid's live Current column rides the same pass */
    if (this._tab === 'orders') {
      for (const row of this.els.ord.querySelectorAll('[data-ticket]')) {
        const ord = TradeRoute.orders().find((o) => o.ticket === Number(row.dataset.ticket));
        if (!ord) continue;
        const dir = (ord.type >= 2) ? (ord.type % 2 === 0 ? 0 : 1) : (ord.type === 0 ? 0 : 1);
        const q = TradeRoute.quote(ord.symbol) || {};
        const cur = Number(dir === 0 ? (q.bid || ord.current) : (q.ask || ord.current)) || ord.current || ord.price || 0;
        const cell = row.querySelector('.td-cur');
        if (cell) {
          const s = Trade.specSync(ord.symbol);
          cell.textContent = Number(cur).toFixed(s ? s.digits : 5);
        }
      }
      return;
    }
    if (this._tab !== 'positions') return;
    for (const row of this.els.pos.querySelectorAll('[data-ticket]')) {
      const t = Number(row.dataset.ticket);
      const pos = TradeRoute.positions().find((p) => p.ticket === t);
      if (!pos) {
        /* ROUND116: PENDING rows stay live too — Current price + the Change
           distance ride the quote stream; Profit stays an honest '—' */
        if (row.dataset.pending !== '1') continue;
        const ord = TradeRoute.orders().find((o) => o.ticket === t);
        if (!ord) continue;
        const odir = (ord.type >= 2) ? (ord.type % 2 === 0 ? 0 : 1) : (ord.type === 0 ? 0 : 1);
        const oq = TradeRoute.quote(ord.symbol) || {};
        const ocur = Number(odir === 0 ? (oq.bid || ord.current) : (oq.ask || ord.current)) || ord.current || ord.price || 0;
        const curCell2 = row.querySelector('.td-cur');
        if (curCell2) {
          const s2 = Trade.specSync(ord.symbol);
          curCell2.textContent = Number(ocur).toFixed(s2 ? s2.digits : 5);
        }
        const chgCell2 = row.querySelector('.td-chg');
        if (chgCell2) {
          const chg2 = (ord.price > 0 && ocur > 0) ? ((ocur - ord.price) / ord.price) * 100 * (odir === 0 ? 1 : -1) : 0;
          chgCell2.textContent = fmtChg(chg2);
          chgCell2.className = 'td-h2c ta-r td-chg ' + (chg2 > 0.004 ? 'pos' : (chg2 < -0.004 ? 'neg' : ''));
        }
        continue;
      }
      /* ROUND114: the grid cells keep their td-h2c/ta-r classes — the old
         className overwrite stripped them and broke the cell layout */
      const cell = row.querySelector('.td-profit');
      if (cell) {
        const v = TradeRoute.profitOf(pos);
        cell.textContent = fmtPlain(v);
        cell.className = 'td-h2c ta-r td-profit ' + (v > 0.004 ? 'pos' : (v < -0.004 ? 'neg' : ''));
      }
      const dir = pos.type === 0 ? 0 : 1;
      const q = TradeRoute.quote(pos.symbol) || {};
      const cur = Number(dir === 0 ? (q.bid || pos.current) : (q.ask || pos.current)) || pos.current || 0;
      const curCell = row.querySelector('.td-cur');
      if (curCell) {
        const s = Trade.specSync(pos.symbol);
        const d = s ? s.digits : 5;
        curCell.textContent = Number(cur).toFixed(d);
      }
      /* Change rides the same live quote (price Δ% × direction) */
      const chgCell = row.querySelector('.td-chg');
      if (chgCell) {
        const chg = (pos.open > 0 && cur > 0) ? ((cur - pos.open) / pos.open) * 100 * (dir === 0 ? 1 : -1) : 0;
        chgCell.textContent = fmtChg(chg);
        chgCell.className = 'td-h2c ta-r td-chg ' + (chg > 0.004 ? 'pos' : (chg < -0.004 ? 'neg' : ''));
      }
    }
    /* ROUND120 (user report — the Total bar lagged behind the rows): the
       rollup + the Volume/Swap/Profit sums refresh on the SAME 600ms pass
       as the row cells, instead of freezing until the next 1.2s re-render. */
    this._updateTotalLive();
  },

  _updateTotalLive() {
    const tot = this.els.pos && this.els.pos.querySelector('.td-h2total');
    if (!tot) return;
    const posRows = TradeRoute.positions();
    let sv = 0, ss = 0, sp = 0;
    for (const p of posRows) {
      sv += p.volume || 0;
      ss += (p.swap || 0);
      sp += TradeRoute.profitOf(p);
    }
    const roll = tot.querySelector('[data-role="rollup"]');
    if (roll) roll.textContent = 'Total · ' + posRows.length + '   Volume: ' + fmtPlain(sv) +
      '   Floating: ' + fmtMoney(sp);
    const vcell = tot.querySelector('[data-sum="volume"]');
    if (vcell) vcell.textContent = fmtPlain(sv);
    const scell = tot.querySelector('[data-sum="swap"]');
    if (scell) {
      scell.textContent = fmtPlain(ss);
      scell.className = 'td-h2c ta-r td-h2-sum ' + signCls(ss);
    }
    const pcell = tot.querySelector('[data-sum="profit"]');
    if (pcell) {
      pcell.textContent = fmtPlain(sp);
      pcell.className = 'td-h2c ta-r td-h2-sum ' + signCls(sp);
    }
  },

  /* ---------- tables ---------- */
  _render() {
    if (!this.els.root) return;
    this._updateAccountBar();
    if (this.els.plTag) this.els.plTag.classList.toggle('on', Trade.plTag);
    if (this.els.volTag) this.els.volTag.classList.toggle('on', Trade.volTag);
    /* ROUND102: the tab labels carry their own counts, so an open position
       or a resting order is visible without switching tabs first */
    for (const b of this.els.tabs.querySelectorAll('.td-tab')) {
      b.classList.toggle('active', b.dataset.t === this._tab);
      const n = b.dataset.t === 'positions' ? TradeRoute.positions().length
        : b.dataset.t === 'orders' ? TradeRoute.orders().length : 0;
      b.textContent = (b.dataset.t === 'positions' ? 'Positions'
        : b.dataset.t === 'orders' ? 'Orders' : 'History') + (n ? ' (' + n + ')' : '');
    }
    this.els.pos.classList.toggle('hidden', this._tab !== 'positions');
    this.els.ord.classList.toggle('hidden', this._tab !== 'orders');
    this.els.hist.classList.toggle('hidden', this._tab !== 'history');
    if (this._tab === 'positions') this._renderPositions();
    else if (this._tab === 'orders') this._renderOrders();
    else this._renderHistory();
  },

  _fmtP(sym, v) {
    const s = Trade.specSync(sym);
    return (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(s ? s.digits : 5);
  },
  _fmtT(sec) {
    if (!sec) return '—';
    /* ROUND120 (user request): trade times display in the app's OWN
       timezone — the same funnel the chart axis uses. Deal/order epochs
       are BROKER wall stamps (the chart time base), so the numeric parts
       funnel converts stamp → true UTC → the selected zone. The dock now
       always agrees with the chart's clock, whatever zone the user picked. */
    const p = TZ.partsNum(App.tz, sec);
    return p.month + '/' + p.day + ' ' + p.hour + ':' + p.minute;
  },

  /* ROUND102: click a column header to sort. With a dozen positions open,
     "which one is bleeding" or "what did I open last" was a manual scan of
     an arbitrarily ordered list. Click again to reverse, a third time to
     go back to the broker's own order. */
  _sortRows(rows, sort, pick) {
    if (!sort || !sort.col) return rows;
    const out = rows.slice();
    out.sort((a, b) => {
      const x = pick(a, sort.col), y = pick(b, sort.col);
      let c;
      if (typeof x === 'number' && typeof y === 'number') c = x - y;
      else c = String(x == null ? '' : x).localeCompare(String(y == null ? '' : y));
      return sort.dir < 0 ? -c : c;
    });
    return out;
  },

  _wireSort(headRow, which) {
    const cur = which === 'pos' ? this._sortP : which === 'ord' ? this._sortO : this._sortH;
    for (const cell of headRow.querySelectorAll('[data-sort]')) {
      const col = cell.dataset.sort;
      cell.classList.add('td-sortable');
      if (cur && cur.col === col) {
        cell.classList.add('on');
        cell.textContent = cell.textContent + (cur.dir < 0 ? ' ↓' : ' ↑');
      }
      cell.addEventListener('click', () => {
        let next;
        if (!cur || cur.col !== col) next = { col, dir: 1 };
        else if (cur.dir > 0) next = { col, dir: -1 };
        else next = null;                       /* third click = broker order */
        if (which === 'pos') { this._sortP = next; U.lsSet(K.sortP, JSON.stringify(next)); }
        else if (which === 'ord') { this._sortO = next; U.lsSet(K.sortO, JSON.stringify(next)); }
        else { this._sortH = next; U.lsSet(K.sortH, JSON.stringify(next)); }
        this._render();
      });
    }
  },

  /* one position view-model — the fields the grid cells and the sorter read
     (mirrors _histTrade's role for open positions; cur rides the live quote) */
  _posVm(p) {
    const dir = p.type === 0 ? 0 : 1;
    const q = TradeRoute.quote(p.symbol) || {};
    const cur = Number(dir === 0 ? (q.bid || p.current) : (q.ask || p.current)) || p.current || 0;
    return {
      p, ticket: p.ticket, symbol: p.symbol, dir, vol: p.volume,
      open: p.open, openT: p.time, cur, sl: p.sl, tp: p.tp,
      swap: p.swap || 0, pl: TradeRoute.profitOf(p), comment: p.comment || '',
      value: (dir === 0 ? 1 : -1) * (p.open || 0) * (p.volume || 0),
      change: (p.open > 0 && cur > 0) ? ((cur - p.open) / p.open) * 100 * (dir === 0 ? 1 : -1) : 0,
    };
  },

  /* ROUND116 (user request): a PENDING order rides the SAME Positions grid
     until the market activates it — then the state poll swaps it for a real
     position row and it "changes nature" into a market trade. The vm keeps
     the _posVm shape the cells/sorter already read; pl/swap stay null (a
     resting order has no floating P/L) and `type` keeps the MT5 order type
     so the Type cell can name it (buy limit / sell stop ...). */
  _orderVm(o) {
    const dir = (o.type >= 2) ? (o.type % 2 === 0 ? 0 : 1) : (o.type === 0 ? 0 : 1);
    const q = TradeRoute.quote(o.symbol) || {};
    const cur = Number(dir === 0 ? (q.bid || o.current) : (q.ask || o.current)) || o.current || o.price || 0;
    return {
      pending: true, p: null, ticket: o.ticket, symbol: o.symbol, dir,
      type: o.type, vol: o.volume, open: o.price, openT: o.time, cur,
      sl: o.sl || 0, tp: o.tp || 0, expT: o.expiration || 0,
      swap: null, pl: null, comment: o.comment || '',
      value: (dir === 0 ? 1 : -1) * (o.price || 0) * (o.volume || 0),
      change: (o.price > 0 && cur > 0) ? ((cur - o.price) / o.price) * 100 * (dir === 0 ? 1 : -1) : 0,
    };
  },

  /* ROUND114 — the Positions tab became the SAME MetaTrader grid as History
     (user request): the terminal columns, real grid lines, a sticky sortable
     header, the sticky Total bar, the right-click column menu and the same
     dynamic width split. The app's own Manage buttons (SL/TP editor, close
     half, close) survive as their own toggleable column, and the row click
     still focuses the symbol. */
  _renderPositions() {
    const host = this.els.pos;
    /* an open inline SL/TP editor must survive the 1.2s poll — rebuild
       would wipe the inputs mid-edit */
    if (host.querySelector('[data-editing]')) return;
    host.innerHTML = '';
    /* ROUND116: the summary chip names both populations — resting pendings
       are visible here before the market turns them into positions */
    /* ROUND117: the grid lists the ACTIVE account — live wire rows in live
       mode, the demo engine's rows in demo mode. A pending set on the
       floating panel in demo mode must sit HERE exactly like a live one. */
    const posRows = TradeRoute.positions();
    const ordRows = TradeRoute.orders();
    const counts = [posRows.length ? posRows.length + ' position(s)' : '',
      ordRows.length ? ordRows.length + ' pending' : ''].filter(Boolean).join(' · ');
    this.els.summary.textContent = counts;
    if (!posRows.length && !ordRows.length) {
      host.innerHTML = '<div class="td-empty">No open positions.<br>' +
        '<span class="td-empty-sub">Open the Trading tab on the right to place an order, ' +
        'or right-click any trade line on the chart to manage it.</span></div>';
      return;
    }
    const vis = this._posVisible();
    const total = this._gridMin(vis);
    const tpl = this._gridTracks(vis);
    const grid = U.el('div', 'td-hgrid', host);

    /* header — sticky, sortable, MT5 labels */
    const head = U.el('div', 'td-h2row td-h2head', grid);
    head.style.gridTemplateColumns = tpl;
    head.style.minWidth = total + 'px';
    for (const c of vis) {
      const cell = U.el('span', 'td-h2c' + (c.num ? ' ta-r' : ''), head);
      cell.textContent = c.head;
      cell.title = c.label;
      if (c.id in POS_SORT) cell.dataset.sort = c.id;
    }
    this._wireSort(head, 'pos');
    /* ROUND116: the grid lists POSITIONS first, then the resting PENDING
       orders — one table, the same columns, exactly the MT5 Trade tab */
    const vms = this._sortRows(
      posRows.map((p) => this._posVm(p)).concat(ordRows.map((o) => this._orderVm(o))),
      this._sortP, (t, c) => {
        const k = POS_SORT[c] || c;
        return (k === 'symbol' || k === 'comment') ? String(t[k] == null ? '' : t[k]) : Number(t[k]);
      });

    /* data rows — click still jumps to the symbol's chart pane (kept);
       ROUND128 (user request): DOUBLE-CLICK opens the Modify modal
       (partial exit + SL/TP) — the same dialog the chart line's
       double-click and the "Modify position" menu item open. */
    for (const t of vms) {
      const row = U.el('div', 'td-h2row td-h2item td-clickable', grid);
      row.style.gridTemplateColumns = tpl;
      row.style.minWidth = total + 'px';
      row.dataset.ticket = t.ticket;
      if (t.pending) row.dataset.pending = '1';
      row.title = (t.pending
        ? 'Pending order — click to bring this symbol up on the chart · double-click to modify'
        : 'Click to bring this symbol up on the chart · double-click to modify (partial exit / SL / TP)');
      row.addEventListener('click', () => this._focusSymbol(t.symbol));
      row.addEventListener('dblclick', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        TradeModify.open(t.pending ? 'ord' : 'pos', t.ticket);
      });
      for (const c of vis) {
        const cell = U.el('span', 'td-h2c' + (c.num ? ' ta-r' : ''), row);
        switch (c.id) {
          case 'time': cell.textContent = this._fmtT5(t.openT); cell.classList.add('td-dim'); break;
          case 'symbol': cell.textContent = t.symbol; break;
          case 'ticket': cell.textContent = t.ticket; cell.classList.add('td-dim'); break;
          case 'type':
            if (t.pending) {
              /* ROUND116: the pending keeps its MT5 order name, in the same
                 orange the chart's dotted pending line uses */
              cell.textContent = (OT_NAME[t.type] || 'pending').toLowerCase();
              cell.classList.add('td-pend');
            } else {
              cell.textContent = t.dir === 0 ? 'buy' : 'sell';
              cell.classList.add(t.dir === 0 ? 'td-buy' : 'td-sell');
            }
            break;
          case 'volume': cell.textContent = t.vol; break;
          case 'oprice': cell.textContent = this._fmtP(t.symbol, t.open); break;
          case 'sl': cell.textContent = t.sl > 0 ? this._fmtP(t.symbol, t.sl) : '—'; cell.classList.add('td-sl'); break;
          case 'tp': cell.textContent = t.tp > 0 ? this._fmtP(t.symbol, t.tp) : '—'; cell.classList.add('td-tp'); break;
          /* live cells carry .td-cur / .td-profit / .td-chg for _updateLive */
          case 'cprice': cell.textContent = this._fmtP(t.symbol, t.cur); cell.classList.add('td-cur'); break;
          case 'value': cell.textContent = fmtPlain(t.value); addCls(cell, signCls(t.value)); break;
          case 'swap': cell.textContent = t.swap == null ? '—' : fmtPlain(t.swap); if (t.swap != null) addCls(cell, signCls(t.swap)); break;
          case 'profit':
            /* a resting order has no floating P/L — an honest dash until the
               market activates it and the row becomes a real position */
            cell.textContent = t.pl == null ? '—' : fmtPlain(t.pl);
            cell.className = 'td-h2c ta-r td-profit' + (t.pl != null ? ' ' + (t.pl > 0.004 ? 'pos' : (t.pl < -0.004 ? 'neg' : '')) : '');
            break;
          case 'change': cell.textContent = fmtChg(t.change); cell.classList.add('td-chg'); addCls(cell, signCls(t.change)); break;
          case 'comment': cell.textContent = t.comment || ''; cell.classList.add('td-dim'); break;
          case 'manage': {
            cell.classList.add('td-manage');
            if (t.pending) this._cancelButton(t, cell);
            else this._manageButtons(t.p, row, cell);
            break;
          }
          default: cell.textContent = '';
        }
      }
    }

    /* the Total bar — MT5 rollup left, Volume / Swap / Profit sums under
       their own columns */
    const sums = { volume: 0, swap: 0, profit: 0 };
    for (const p of posRows) {
      sums.volume += p.volume;
      sums.swap += (p.swap || 0);
      sums.profit += TradeRoute.profitOf(p);
    }
    const rollup = 'Total · ' + posRows.length + '   Volume: ' + fmtPlain(sums.volume) +
      '   Floating: ' + fmtMoney(sums.profit);
    const tot = U.el('div', 'td-h2row td-h2total', grid);
    tot.style.gridTemplateColumns = tpl;
    tot.style.minWidth = total + 'px';
    /* ROUND115: every total cell is pinned to its OWN grid track. The rollup
       spans the leading columns, so any cell left to auto-placement slid
       right by firstSum tracks — the profit total landed under Manage
       instead of exactly under Profit (user report). Explicit tracks keep
       each sum under its own column for every visible-column combination. */
    const firstSum = vis.findIndex((c) => c.id === 'volume' || c.id === 'swap' || c.id === 'profit');
    for (let i = 0; i < vis.length; i++) {
      const c = vis[i];
      if (i === 0) {
        const cell = U.el('span', 'td-h2c td-h2-rollup', tot);
        cell.textContent = rollup;
        cell.dataset.role = 'rollup';          /* ROUND120: live 600ms refresh hook */
        /* the rollup text flows over the cells before the first sum column */
        cell.style.gridColumn = '1 / ' + (firstSum < 0 ? vis.length + 1 : Math.max(firstSum + 1, 2));
        continue;
      }
      if (firstSum < 0 || i < firstSum) continue;   /* covered by the rollup span */
      const cell = U.el('span', 'td-h2c', tot);
      cell.style.gridColumn = String(i + 1);
      if (c.id === 'volume') {
        cell.className = 'td-h2c ta-r td-h2-sum';
        cell.textContent = fmtPlain(sums.volume);
        cell.dataset.sum = 'volume';           /* ROUND120: live refresh hook */
      } else if (c.id === 'swap' || c.id === 'profit') {
        cell.className = 'td-h2c ta-r td-h2-sum ' + (sums[c.id] > 0.004 ? 'pos' : (sums[c.id] < -0.004 ? 'neg' : ''));
        cell.textContent = fmtPlain(sums[c.id]);
        cell.dataset.sum = c.id;               /* ROUND120: live refresh hook */
      }
    }
  },

  /* ROUND116: the Manage cell of a PENDING row — one honest action until the
     market activates the order: cancel it (inline confirm, same pattern as
     the destructive close button) */
  _cancelButton(t, cell) {
    const b = U.el('button', 'td-mini', cell);
    b.textContent = '×';
    b.title = 'Cancel pending order';
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      UI.toast('Cancel ' + (OT_NAME[t.type] || 'pending') + ' ' + t.vol + ' ' + t.symbol +
        ' (#' + t.ticket + ') at ' + this._fmtP(t.symbol, t.open) + '?', 'warn', {
        actionLabel: 'Cancel order',
        onAction: () => TradeRoute.cancel(t.ticket).then((r) => {
          if (r && r.ok === false) UI.toast('Cancel failed: ' + (r.error || ''), '');
        }).catch((err) => {
          UI.toast('Cancel failed: ' + (err.message || ''), '');
        }),
      });
    });
    return b;
  },

  /* the Manage column — the app's own position controls, kept from the old
     table (inline SL/TP editor, close half, close) */
  _manageButtons(p, row, cell) {
    const mkBtn = (label, title, fn, cls) => {
      const b = U.el('button', 'td-mini ' + (cls || ''), cell);
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
      return b;
    };
    mkBtn('SL/TP', 'Edit stop-loss / take-profit', () => this._editSltp(p, row));
    mkBtn('50%', 'Close half the volume', () => {
      const s = Trade.specSync(p.symbol);
      const half = Math.max((s && s.vol_min) || 0.01, Math.round((p.volume / 2) / ((s && s.vol_step) || 0.01)) * ((s && s.vol_step) || 0.01));
      TradeRoute.close(p.ticket, Math.min(half, p.volume)).catch((err) => {
        UI.toast('Close failed: ' + (err.message || ''), '');
      });
    });
    mkBtn('×', 'Close position', () => {
      /* ROUND102: destructive and one pixel from the 50% button — confirm
         inline (non-blocking) instead of firing on a mis-click */
      UI.toast('Close ' + (p.type === 0 ? 'BUY' : 'SELL') + ' ' + p.volume + ' ' + p.symbol +
        ' (#' + p.ticket + ') at ' + fmtMoney(TradeRoute.profitOf(p)) + '?', 'warn', {
        actionLabel: 'Close',
        onAction: () => TradeRoute.close(p.ticket, 0).catch((err) => {
          UI.toast('Close failed: ' + (err.message || ''), '');
        }),
      });
    }, 'td-danger');
  },

  /* ROUND102: bring a row's symbol up on a chart pane (the tables and the
     chart were two disconnected worlds) */
  _focusSymbol(sym) {
    if (!sym) return;
    const pane = App.panes.find((p) => p.symbol === sym);
    if (pane) {
      App.activePane = pane;
      try { pane.root.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      return;
    }
    UI.toast(sym + ' is not open on a chart — switch the symbol from the chart header to see its trades', '');
  },

  /* inline SL/TP editor for a position row */
  _editSltp(p, row) {
    const cells = row.querySelectorAll('span');
    const slCell = row.querySelector('.td-sl');
    const tpCell = row.querySelector('.td-tp');
    const manage = row.querySelector('.td-manage');
    if (row.dataset.editing) { return; }
    row.dataset.editing = '1';
    const mkInput = (val) => {
      const i = document.createElement('input');
      i.type = 'text';
      i.value = val ? this._fmtP(p.symbol, val) : '';
      i.placeholder = '—';
      i.spellcheck = false;
      i.className = 'td-inline-input';
      i.addEventListener('mousedown', (ev) => ev.stopPropagation());
      return i;
    };
    const slIn = mkInput(p.sl);
    const tpIn = mkInput(p.tp);
    const oldSl = slCell.innerHTML;
    const oldTp = tpCell.innerHTML;
    slCell.innerHTML = '';
    tpCell.innerHTML = '';
    slCell.appendChild(slIn);
    tpCell.appendChild(tpIn);
    manage.innerHTML = '';
    const save = () => {
      const s = Trade.specSync(p.symbol);
      const d = s ? s.digits : 5;
      const sl = parseFloat(slIn.value);
      const tp = parseFloat(tpIn.value);
      const sl2 = isFinite(sl) && sl > 0 ? Number(sl.toFixed(d)) : 0;
      const tp2 = isFinite(tp) && tp > 0 ? Number(tp.toFixed(d)) : 0;
      delete row.dataset.editing;
      TradeRoute.modifySLTP(p.ticket, sl2, tp2).then((res) => {
        UI.toast('SL/TP updated — ' + ((res && res.comment) || 'done'),
          (res && (res.retcode === 10009 || res.ok)) ? 'ok' : '');
      }).catch((err) => {
        UI.toast('SL/TP failed: ' + (err.message || ''), '');
        this._render();
      });
    };
    const cancel = () => {
      delete row.dataset.editing;
      slCell.innerHTML = oldSl;
      tpCell.innerHTML = oldTp;
      this._render();
    };
    const okB = U.el('button', 'td-mini td-ok', manage); okB.textContent = '✓'; okB.title = 'Save';
    const noB = U.el('button', 'td-mini', manage); noB.textContent = '✕'; noB.title = 'Cancel';
    okB.addEventListener('click', (ev) => { ev.stopPropagation(); save(); });
    noB.addEventListener('click', (ev) => { ev.stopPropagation(); cancel(); });
    slIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
    void cells;
  },

  /* ROUND119 (user request) — the Orders tab became the SAME MetaTrader
     grid as Positions / History: sticky sortable header, grid lines, the
     right-click column menu, the dynamic width split and a Total bar. The
     inline price/SL/TP editor (_editOrder) survives unchanged — the cells
     keep the .td-opx / .td-sl / .td-tp / .td-manage hooks it binds to. */
  _renderOrders() {
    const host = this.els.ord;
    if (host.querySelector('[data-editing]')) return; // inline editor open
    host.innerHTML = '';
    const ords = TradeRoute.orders();
    this.els.summary.textContent = ords.length ? (ords.length + ' pending order(s)') : '';
    if (!ords.length) {
      host.innerHTML = '<div class="td-empty">No pending orders.<br>' +
        '<span class="td-empty-sub">Place one from the Trading tab on the right, ' +
        'or right-click the chart price scale.</span></div>';
      return;
    }
    const vis = this._ordVisible();
    const total = this._gridMin(vis);
    const tpl = this._gridTracks(vis);
    const grid = U.el('div', 'td-hgrid', host);

    /* header — sticky, sortable, MT5 labels */
    const head = U.el('div', 'td-h2row td-h2head', grid);
    head.style.gridTemplateColumns = tpl;
    head.style.minWidth = total + 'px';
    for (const c of vis) {
      const cell = U.el('span', 'td-h2c' + (c.num ? ' ta-r' : ''), head);
      cell.textContent = c.head;
      cell.title = c.label;
      if (c.id in ORD_SORT) cell.dataset.sort = c.id;
    }
    this._wireSort(head, 'ord');
    const vms = this._sortRows(ords.map((o) => this._orderVm(o)), this._sortO, (t, c) => {
      const k = ORD_SORT[c] || c;
      return (k === 'symbol' || k === 'comment') ? String(t[k] == null ? '' : t[k]) : Number(t[k]);
    });

    /* data rows — click still jumps to the symbol's chart pane */
    for (const t of vms) {
      const row = U.el('div', 'td-h2row td-h2item td-clickable', grid);
      row.style.gridTemplateColumns = tpl;
      row.style.minWidth = total + 'px';
      row.dataset.ticket = t.ticket;
      row.dataset.pending = '1';
      row.title = 'Pending order — click to bring this symbol up on the chart';
      row.addEventListener('click', () => this._focusSymbol(t.symbol));
      for (const c of vis) {
        const cell = U.el('span', 'td-h2c' + (c.num ? ' ta-r' : ''), row);
        switch (c.id) {
          case 'time': cell.textContent = this._fmtT5(t.openT); cell.classList.add('td-dim'); break;
          case 'symbol': cell.textContent = t.symbol; break;
          case 'ticket': cell.textContent = t.ticket; cell.classList.add('td-dim'); break;
          /* the full MT5 order name, colored by side like the terminal */
          case 'type':
            cell.textContent = (OT_NAME[t.type] || 'pending').toLowerCase();
            cell.classList.add(t.dir === 0 ? 'td-buy' : 'td-sell');
            break;
          case 'volume': cell.textContent = t.vol; break;
          case 'oprice': cell.textContent = this._fmtP(t.symbol, t.open); cell.classList.add('td-opx'); break;
          case 'sl': cell.textContent = t.sl > 0 ? this._fmtP(t.symbol, t.sl) : '—'; cell.classList.add('td-sl'); break;
          case 'tp': cell.textContent = t.tp > 0 ? this._fmtP(t.symbol, t.tp) : '—'; cell.classList.add('td-tp'); break;
          /* live cell — _updateLocal rides the quote stream (600ms) */
          case 'cprice': cell.textContent = this._fmtP(t.symbol, t.cur); cell.classList.add('td-cur'); break;
          case 'exp': cell.textContent = t.expT ? this._fmtT5(t.expT) : 'GTC'; cell.classList.add('td-dim'); break;
          case 'comment': cell.textContent = t.comment || ''; cell.classList.add('td-dim'); break;
          case 'manage': {
            cell.classList.add('td-manage');
            const editB = U.el('button', 'td-mini', cell);
            editB.textContent = 'Edit';
            editB.title = 'Modify price / SL / TP';
            const ord = ords.find((x) => x.ticket === t.ticket);
            editB.addEventListener('click', (ev) => { ev.stopPropagation(); if (ord) this._editOrder(ord, row); });
            const noB = U.el('button', 'td-mini td-danger', cell);
            noB.textContent = '×';
            noB.title = 'Cancel order';
            noB.addEventListener('click', (ev) => {
              ev.stopPropagation();
              TradeRoute.cancel(t.ticket).then((r) => {
                if (r && r.ok === false) UI.toast('Cancel failed: ' + (r.error || ''), '');
              }).catch((err) => {
                UI.toast('Cancel failed: ' + (err.message || ''), '');
              });
            });
            break;
          }
          default: cell.textContent = '';
        }
      }
    }

    /* the Total bar — pending count + volume sum under the Volume column */
    const volSum = ords.reduce((s, o) => s + (o.volume || 0), 0);
    const rollup = 'Total · ' + ords.length + ' pending   Volume: ' + fmtPlain(volSum);
    const tot = U.el('div', 'td-h2row td-h2total', grid);
    tot.style.gridTemplateColumns = tpl;
    tot.style.minWidth = total + 'px';
    /* same explicit-track pinning as the other Total bars (ROUND115) */
    const firstSum = vis.findIndex((c) => c.id === 'volume');
    for (let i = 0; i < vis.length; i++) {
      const c = vis[i];
      if (i === 0) {
        const cell = U.el('span', 'td-h2c td-h2-rollup', tot);
        cell.textContent = rollup;
        cell.style.gridColumn = '1 / ' + (firstSum < 0 ? vis.length + 1 : Math.max(firstSum + 1, 2));
        continue;
      }
      if (firstSum < 0 || i < firstSum) continue;   /* covered by the rollup span */
      const cell = U.el('span', 'td-h2c', tot);
      cell.style.gridColumn = String(i + 1);
      if (c.id === 'volume') {
        cell.className = 'td-h2c ta-r td-h2-sum';
        cell.textContent = fmtPlain(volSum);
      }
    }
  },

  _editOrder(o, row) {
    if (row.dataset.editing) return;
    row.dataset.editing = '1';
    const mkInput = (val) => {
      const i = document.createElement('input');
      i.type = 'text';
      i.value = val ? this._fmtP(o.symbol, val) : '';
      i.placeholder = '—';
      i.spellcheck = false;
      i.className = 'td-inline-input';
      i.addEventListener('mousedown', (ev) => ev.stopPropagation());
      return i;
    };
    const pxC = row.querySelector('.td-opx');
    const slC = row.querySelector('.td-sl');
    const tpC = row.querySelector('.td-tp');
    const mg = row.querySelector('.td-manage');
    const pxIn = mkInput(o.price);
    const slIn = mkInput(o.sl);
    const tpIn = mkInput(o.tp);
    const old = { px: pxC.innerHTML, sl: slC.innerHTML, tp: tpC.innerHTML };
    pxC.innerHTML = ''; pxC.appendChild(pxIn);
    slC.innerHTML = ''; slC.appendChild(slIn);
    tpC.innerHTML = ''; tpC.appendChild(tpIn);
    mg.innerHTML = '';
    const save = () => {
      const s = Trade.specSync(o.symbol);
      const d = s ? s.digits : 5;
      const px = parseFloat(pxIn.value);
      const sl = parseFloat(slIn.value);
      const tp = parseFloat(tpIn.value);
      if (!(px > 0)) { cancel(); return; }
      delete row.dataset.editing;
      TradeRoute.modifyOrder(o.ticket, Number(px.toFixed(d)),
        isFinite(sl) && sl > 0 ? Number(sl.toFixed(d)) : 0,
        isFinite(tp) && tp > 0 ? Number(tp.toFixed(d)) : 0)
        .then((res) => {
          UI.toast('Order modified — ' + ((res && res.comment) || 'done'),
            (res && (res.retcode === 10009 || res.ok)) ? 'ok' : '');
        }).catch((err) => {
          UI.toast('Modify failed: ' + (err.message || ''), '');
          this._render();
        });
    };
    const cancel = () => { delete row.dataset.editing; this._render(); };
    const okB = U.el('button', 'td-mini td-ok', mg); okB.textContent = '✓'; okB.title = 'Save';
    const noB = U.el('button', 'td-mini', mg); noB.textContent = '✕'; noB.title = 'Cancel';
    okB.addEventListener('click', (ev) => { ev.stopPropagation(); save(); });
    noB.addEventListener('click', (ev) => { ev.stopPropagation(); cancel(); });
    pxIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
  },

  /* ---------- history ---------- */
  _rangeFrom() {
    const now = Math.floor(Date.now() / 1000);
    const day = 86400;
    /* ROUND128: the d3/week/month windows ride the CHART (broker) time base
       too — the demo deal stamps now carry the same base as the chart axis
       (see nowT() in replaytrade.js), so the boundaries must match or a
       server-offset shifted the window by hours. */
    const offC = (App.feed && App.feed.serverOff) || 0;
    const nowChart = now + offC;
    if (this._range === 'today') {
      /* ROUND120 (user request): "Today" starts at midnight in the app's
         OWN timezone — computed over the chart (broker) time base, then
         handed to the provider as a true-UTC boundary. The provider shifts
         it back into the broker base, so the window opens exactly at the
         midnight the user's clock (and the chart axis) shows. */
      const off = offC;
      const p = TZ.partsNum(App.tz, nowChart);
      const secOfDay = (+p.hour) * 3600 + (+p.minute) * 60 + (+p.second);
      return nowChart - secOfDay - off;      // true-UTC epoch of the zone's midnight
    }
    if (this._range === 'd3') return nowChart - 3 * day;
    if (this._range === 'week') return nowChart - 7 * day;
    if (this._range === 'month') return nowChart - 30 * day;
    return 0;
  },

  /* ---------- ROUND113: MT5-style history grid + column menu ---------- */

  /* MT5 time shape: "2026.09.22 10:38:02" — ROUND120: rendered in the
     app's selected timezone through the chart-stamp funnel (TZ.parts),
     so the History/Positions hours always match the chart axis. */
  _fmtT5(sec) {
    if (!sec) return '—';
    const p = TZ.partsNum(App.tz, sec);
    return p.year + '.' + p.month + '.' + p.day + ' ' +
      p.hour + ':' + p.minute + ':' + p.second;
  },

  _histLoad() {
    let arr = null;
    try { arr = JSON.parse(U.lsGet(K.hcols, '[]') || '[]'); } catch (e) { arr = null; }
    this._histHidden = new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  },

  _histSave() {
    U.lsSet(K.hcols, JSON.stringify(Array.from(this._histHidden || [])));
  },

  /* the columns the table currently shows (HIST_COLS order preserved) */
  _histVisible() {
    if (!this._histHidden) this._histLoad();
    return HIST_COLS.filter((c) => !this._histHidden.has(c.id));
  },

  /* ROUND114: the same column-state trio for the Positions grid */
  _posLoad() {
    let arr = null;
    try { arr = JSON.parse(U.lsGet(K.pcols, '[]') || '[]'); } catch (e) { arr = null; }
    this._posHidden = new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  },

  _posSave() {
    U.lsSet(K.pcols, JSON.stringify(Array.from(this._posHidden || [])));
  },

  _posVisible() {
    if (!this._posHidden) this._posLoad();
    return POS_COLS.filter((c) => !this._posHidden.has(c.id));
  },

  /* ROUND119: the same column-state trio for the Orders grid */
  _ordLoad() {
    let arr = null;
    try { arr = JSON.parse(U.lsGet(K.ocols, '[]') || '[]'); } catch (e) { arr = null; }
    this._ordHidden = new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : []);
  },

  _ordSave() {
    U.lsSet(K.ocols, JSON.stringify(Array.from(this._ordHidden || [])));
  },

  _ordVisible() {
    if (!this._ordHidden) this._ordLoad();
    return ORD_COLS.filter((c) => !this._ordHidden.has(c.id));
  },

  /* ROUND114: DYNAMIC width split (user request) — the visible columns share
     the FULL panel width with no dead space: each track is
     minmax(natural px, natural fr) so a wide dock stretches every visible
     column proportionally (its natural width is the weight), and a narrow
     dock scrolls horizontally at the natural sum (the rows keep
     min-width = Σw). Toggling a column off/on re-derives the track list,
     so the split redistributes itself automatically. */
  _gridTracks(vis) {
    return vis.map((c) => 'minmax(' + c.w + 'px,' + c.w + 'fr)').join(' ');
  },
  _gridMin(vis) {
    return vis.reduce((s, c) => s + c.w, 0);
  },

  /* the toggle menu — built once, lives on document.body so history
     re-renders can never destroy it while it is open */
  _ensureHistMenu() {
    if (this._histMenu) return;
    const menu = document.createElement('div');
    menu.className = 'td-hmenu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
    this._histMenu = menu;
    /* every item toggles its column IN PLACE — the menu stays open until a
       click lands outside it (the exact behavior the user asked for) */
    menu.addEventListener('click', (ev) => {
      const item = ev.target.closest('.td-hmenu-item');
      if (!item) return;
      ev.stopPropagation();
      const id = item.dataset.col;
      const target = menu.dataset.target;
      const pos = target === 'pos';
      const ord = target === 'ord';
      const hidden = pos ? this._posHidden : ord ? this._ordHidden : this._histHidden;
      if (!hidden) return;
      if (hidden.has(id)) hidden.delete(id);
      else hidden.add(id);
      if (pos) this._posSave(); else if (ord) this._ordSave(); else this._histSave();
      item.classList.toggle('off', hidden.has(id));
      if (pos && this._tab === 'positions') this._renderPositions();   // table only — menu survives
      if (ord && this._tab === 'orders') this._renderOrders();         // table only — menu survives
      if (!pos && !ord && this._tab === 'history') this._renderHistory(); // table only — menu survives
    });
    /* a right-click INSIDE the menu keeps it open (no native menu either) */
    menu.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); });
    /* ANY press outside the menu closes it — left or right, per the spec */
    document.addEventListener('pointerdown', (ev) => {
      if (menu.style.display === 'none') return;
      if (!menu.contains(ev.target)) this._closeHistMenu();
    }, true);
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this._closeHistMenu();
    });
  },

  /* ROUND114: the toggle menu now serves ALL THREE grids — target
     'hist' | 'pos' | 'ord' picks the column list and the persistence set
     the items act on (ROUND119 added the Orders grid) */
  _openColMenu(x, y, target) {
    const menu = this._histMenu;
    if (!menu) return;
    const cols = target === 'pos' ? POS_COLS : target === 'ord' ? ORD_COLS : HIST_COLS;
    const hidden = target === 'pos'
      ? (this._posHidden || (this._posLoad(), this._posHidden))
      : target === 'ord'
        ? (this._ordHidden || (this._ordLoad(), this._ordHidden))
        : (this._histHidden || (this._histLoad(), this._histHidden));
    menu.dataset.target = target;
    /* rebuild the items each open so the checkmarks always match the state */
    U.clear(menu);
    for (const c of cols) {
      const it = U.el('div', 'td-hmenu-item' + (hidden.has(c.id) ? ' off' : ''), menu);
      it.dataset.col = c.id;
      it.innerHTML = '<span class="td-hmenu-chk">' + (hidden.has(c.id) ? '' : '✓') + '</span>' +
        '<span class="td-hmenu-lbl">' + U.esc(c.label) + '</span>';
    }
    menu.style.display = 'block';
    const w = menu.offsetWidth || 170, h = menu.offsetHeight || 200;
    let mx = x + 2, my = y + 2;
    if (mx + w > window.innerWidth - 8) mx = Math.max(8, x - w - 2);
    if (my + h > window.innerHeight - 8) my = Math.max(8, y - h - 2);
    menu.style.left = mx + 'px';
    menu.style.top = my + 'px';
  },

  _closeHistMenu() {
    if (this._histMenu && this._histMenu.style.display !== 'none') {
      this._histMenu.style.display = 'none';
    }
  },

  /* ROUND127 (user request) — MT5 position parity: ONE history row per
     closed POSITION, no matter how many partial exits it took. The partials
     are all the SAME trade whose volume was closed step by step — the
     terminal never lists them separately: Volume = the total closed
     volume, Close Price = the volume-weighted average of the closing
     deals, Profit/Commission/Fee/Swap = the sums (the entry deal's fees
     ride the single row, so the grid totals still equal the account's).
     SL/TP-hit detection reads every fragment's reason. */
  _histRows(pid, g) {
    let vol = 0, profit = 0, vx = 0, comm = 0, fee = 0, swap = 0;
    let closeT = 0, slHit = false, tpHit = false, slPx = 0, tpPx = 0, outComment = '';
    for (const o of g.outs) {
      vol += o.volume || 0;
      profit += o.profit || 0;
      vx += (o.price || 0) * (o.volume || 0);
      comm += o.commission || 0; fee += o.fee || 0; swap += o.swap || 0;
      if ((o.time || 0) > closeT) closeT = o.time;
      if (o.reason === 4) { slHit = true; if (!slPx) slPx = o.price; }
      if (o.reason === 5) { tpHit = true; if (!tpPx) tpPx = o.price; }
      if (!outComment && (o.comment || '').trim()) outComment = o.comment.trim();
    }
    const dir = g.in.type === 0 ? 0 : 1;
    const close = vol > 0 ? vx / vol : (g.outs.length ? (g.outs[g.outs.length - 1].price || 0) : 0);
    const slVal = (g.in.sl > 0) ? g.in.sl : (slHit ? slPx : 0);
    const tpVal = (g.in.tp > 0) ? g.in.tp : (tpHit ? tpPx : 0);
    const value = (dir === 0 ? 1 : -1) * (g.in.price || 0) * vol;
    const change = (g.in.price > 0 && close > 0)
      ? ((close - g.in.price) / g.in.price) * 100 * (dir === 0 ? 1 : -1) : 0;
    const inComm = g.in.commission || 0, inFee = g.in.fee || 0, inSwap = g.in.swap || 0;
    /* ROUND128 (user request): the partial-exit volume display — the Volume
       cell shows "initial total / closed so far" while fragments of the
       position are still closing (1.00 lots opened + 0.30 closed -> 1/0.30;
       another 0.50 closed -> 1/0.80). A FULLY closed trade keeps the plain
       closed volume (the terminal's shape). Sorting still reads the numeric
       `vol`; `volTxt` is display-only. */
    const vol0 = Number(g.in.volume || 0);
    const volNum = Number(vol.toFixed(8));
    const volTxt = (vol0 > 0 && volNum < vol0 - 1e-9)
      ? (vol0 + '/' + volNum)
      : String(volNum);
    return [{
      pid, ticket: g.in.ticket, symbol: g.in.symbol, dir,
      vol: volNum, volTxt, vol0, open: g.in.price, openT: g.in.time,
      close, closeT, closedVol: volNum,
      profit, comm: comm + inComm, fee: fee + inFee, swap: swap + inSwap,
      value, change, sl: slVal, tp: tpVal, slHit, tpHit,
      magic: g.in.magic || 0,
      comment: (g.in.comment || '').trim() || outComment,
      net: (profit + comm + fee + swap) + (inComm + inFee + inSwap),
      parts: g.outs.length,
    }];
  },

  _renderHistory() {
    const host = this.els.hist;
    host.innerHTML = '';
    /* range chips */
    const chips = U.el('div', 'td-hist-chips', host);
    for (const [id, label] of RANGES) {
      const b = U.el('button', 'td-chip' + (this._range === id ? ' on' : ''), chips);
      b.textContent = label;
      b.addEventListener('click', () => {
        this._range = id;
        U.lsSet(K.range, id);
        this._deals = null;
        this._renderHistory();
      });
    }
    /* ROUND102: an explicit refresh — the deals cache was only refetched on
       a range change, so a trade closed while you watched the tab never
       appeared until you clicked a chip twice */
    const rf = U.el('button', 'td-chip td-hist-refresh', chips);
    rf.textContent = '↻';
    rf.title = 'Reload closed trades from the broker';
    rf.addEventListener('click', () => { this._deals = null; this._renderHistory(); });
    /* ROUND120: the cache is per-ACCOUNT (demo vs live) — a stale cache of
       the other account can never be rendered (the mode-change listener in
       init() also drops it, this is the boot/refresh-path guard). */
    if (this._deals && this._dealsMode !== TradeRoute.mode) { this._deals = null; this._dealSum = null; }
    if (!this._deals) {
      host.appendChild(chips);
      const loading = U.el('div', 'td-empty', host);
      loading.textContent = 'Loading history…';
      /* ROUND120 (user request): the HISTORY TAB shows the ACTIVE account —
         demo trades (previously only in the demo side panel) live here now;
         live trades come from the bridge as before. */
      this._dealsMode = TradeRoute.mode;
      TradeRoute.history(this._rangeFrom(), 0).then((h) => {
        this._deals = h.deals || [];
        this._dealSum = h.summary || null;
        if (this._tab === 'history') this._renderHistory();
      }).catch(() => {
        loading.textContent = 'History unavailable';
      });
      return;
    }
    host.appendChild(chips);
    /* group deals by position_id: IN + OUT(s) -> trade rows.
       ROUND120 (user report — history did not match MetaTrader): closing
       deals now include DEAL_ENTRY_INOUT (2) and DEAL_ENTRY_OUT_BY (3),
       not just plain OUT (1) — close-by / reversal exits were dropped
       before, so trade counts diverged from the terminal. */
    const byPos = new Map();
    for (const d of this._deals) {
      if (!byPos.has(d.position_id)) byPos.set(d.position_id, { in: null, outs: [] });
      const g = byPos.get(d.position_id);
      if (d.entry === 0 && d.type !== 2 && d.type !== 3) { if (!g.in) g.in = d; } // 2/3 = balance ops excluded
      else if (d.entry === 1 || d.entry === 2 || d.entry === 3) g.outs.push(d);
    }
    /* ROUND127: one row per POSITION (the partial fragments are merged by
       _histRows — the MT5 terminal never lists partial exits separately),
       with the trade-count summary computed per POSITION as before. */
    const trades = [];
    const groupNets = [];
    for (const [pid, g] of byPos) {
      if (!g.in || !g.outs.length) continue;
      g.outs.sort((a, b) => a.time - b.time);
      let gn = 0;
      for (const row of this._histRows(pid, g)) { gn += row.net; trades.push(row); }
      groupNets.push(gn);
    }
    trades.sort((a, b) => b.closeT - a.closeT);
    const net = groupNets.reduce((s, v) => s + v, 0);
    const wins = groupNets.filter((v) => v > 0).length;
    const nTrades = groupNets.length;
    let bestNet = null, worstNet = null;
    for (const v of groupNets) {
      if (bestNet == null || v > bestNet) bestNet = v;
      if (worstNet == null || v < worstNet) worstNet = v;
    }
    this.els.summary.textContent = nTrades ?
      (nTrades + ' trades · win ' + Math.round(wins * 100 / nTrades) + '%' +
        ' · net ' + fmtMoney(net) +
        (bestNet != null ? ' · best ' + fmtMoney(bestNet) : '') +
        (worstNet != null ? ' · worst ' + fmtMoney(worstNet) : '')) : '';
    if (!trades.length) {
      U.el('div', 'td-empty', host).innerHTML = 'No closed trades in this range.<br>' +
        '<span class="td-empty-sub">Try a wider range above · right-click for the columns.</span>';
      void this._dealSum;
      return;
    }

    /* ---- ROUND113: the MT5-style grid (visible columns, gridlines, sticky
       header + the Total bar) ------------------------------------------ */
    const vis = this._histVisible();
    /* ROUND114: dynamic width split (user request) — the visible columns
       share the FULL dock width; toggling columns redistributes it */
    const total = this._gridMin(vis);
    const tpl = this._gridTracks(vis);
    const money = { comm: 0, fee: 0, swap: 0, profit: 0 };
    for (const t of trades) {
      money.comm += t.comm; money.fee += t.fee; money.swap += t.swap; money.profit += t.profit;
    }
    const grid = U.el('div', 'td-hgrid', host);

    /* header — sticky, sortable, MT5 labels */
    const head = U.el('div', 'td-h2row td-h2head', grid);
    head.style.gridTemplateColumns = tpl;
    head.style.minWidth = total + 'px';
    for (const c of vis) {
      const cell = U.el('span', 'td-h2c' + (c.num ? ' ta-r' : ''), head);
      cell.textContent = c.head;
      cell.title = c.label;
      if (['time', 'symbol', 'ticket', 'type', 'volume', 'oprice', 'sl', 'tp',
        'ctime', 'cprice', 'value', 'comm', 'fee', 'swap', 'profit', 'change', 'magic', 'comment'].includes(c.id)) {
        cell.dataset.sort = c.id;
      }
    }
    this._wireSort(head, 'hist');
    const sorted = this._sortRows(trades, this._sortH, (t, c) => {
      const k = HIST_SORT[c] || c;
      return (k === 'symbol' || k === 'comment') ? String(t[k] == null ? '' : t[k]) : Number(t[k]);
    });

    /* data rows — click still jumps the chart to the trade (ROUND102 kept) */
    for (const t of sorted.slice(0, 200)) {
      const row = U.el('div', 'td-h2row td-h2item td-clickable', grid);
      row.style.gridTemplateColumns = tpl;
      row.style.minWidth = total + 'px';
      row.title = 'Click to show this trade on the chart' +
        (t.parts > 1 ? (' — closed in ' + t.parts + ' parts (one MT5 position)') : '');
      row.addEventListener('click', () => this._showTrade(t));
      for (const c of vis) {
        const cell = U.el('span', 'td-h2c' + (c.num ? ' ta-r' : ''), row);
        let hitCls = '';
        switch (c.id) {
          case 'time': cell.textContent = this._fmtT5(t.openT); cell.classList.add('td-dim'); break;
          case 'symbol': cell.textContent = t.symbol; break;
          case 'ticket': cell.textContent = t.pid; cell.classList.add('td-dim'); break;
          case 'type':
            cell.textContent = t.dir === 0 ? 'buy' : 'sell';
            cell.classList.add(t.dir === 0 ? 'td-buy' : 'td-sell');
            break;
          case 'volume': cell.textContent = t.volTxt || t.vol; cell.title = t.volTxt && t.volTxt.indexOf('/') >= 0 ? 'Closed so far / initial volume' : ''; break;
          case 'oprice': cell.textContent = this._fmtP(t.symbol, t.open); break;
          case 'sl':
            cell.textContent = t.sl > 0 ? this._fmtP(t.symbol, t.sl) : '—';
            hitCls = t.slHit ? 'td-hl-sl' : '';
            if (hitCls) cell.classList.add(hitCls);
            break;
          case 'tp':
            cell.textContent = t.tp > 0 ? this._fmtP(t.symbol, t.tp) : '—';
            hitCls = t.tpHit ? 'td-hl-tp' : '';
            if (hitCls) cell.classList.add(hitCls);
            break;
          case 'ctime': cell.textContent = this._fmtT5(t.closeT); cell.classList.add('td-dim'); break;
          case 'cprice': cell.textContent = this._fmtP(t.symbol, t.close); break;
          case 'value': cell.textContent = fmtPlain(t.value); addCls(cell, signCls(t.value)); break;
          case 'comm': cell.textContent = fmtPlain(t.comm); addCls(cell, signCls(t.comm)); break;
          case 'fee': cell.textContent = fmtPlain(t.fee); addCls(cell, signCls(t.fee)); break;
          case 'swap': cell.textContent = fmtPlain(t.swap); addCls(cell, signCls(t.swap)); break;
          case 'profit': cell.textContent = fmtPlain(t.profit); addCls(cell, signCls(t.profit)); break;
          case 'change': cell.textContent = fmtChg(t.change); addCls(cell, signCls(t.change)); break;
          case 'magic': cell.textContent = t.magic ? t.magic : ''; cell.classList.add('td-dim'); break;
          case 'comment': cell.textContent = t.comment || ''; cell.classList.add('td-dim'); break;
          default: cell.textContent = '';
        }
      }
    }

    /* the MT5 Total bar — left: the account rollup, right: the money sums
       aligned under their own columns. ROUND120: the rollup reads the
       ACTIVE account (demo engine in demo mode, the bridge in live). */
    const acc = TradeRoute.account();
    let deposit = 0, withdrawal = 0;
    for (const d of this._deals) {
      if (d.type !== 2) continue;                       // DEAL_TYPE_BALANCE
      if ((d.profit || 0) > 0) deposit += d.profit;
      else withdrawal += Math.abs(d.profit || 0);
    }
    const balance = acc && isFinite(acc.balance) ? acc.balance : (deposit - withdrawal + net);
    const rollup = 'Profit: ' + fmtPlain(net) + '   Credit: 0.00   Deposit: ' + fmtPlain(deposit) +
      '   Withdrawal: ' + fmtPlain(withdrawal) + '   Balance: ' + fmtPlain(balance);
    const tot = U.el('div', 'td-h2row td-h2total', grid);
    tot.style.gridTemplateColumns = tpl;
    tot.style.minWidth = total + 'px';
    /* ROUND115: same explicit-track pinning as the Positions Total bar —
       cells left to auto-placement after the spanning rollup slid right, so
       the money sums (incl. the profit total) never sat under their own
       columns. Every cell now lands exactly on its own grid track. */
    const firstMoney = vis.findIndex((c) => c.id in money);
    for (let i = 0; i < vis.length; i++) {
      const c = vis[i];
      if (i === 0) {
        const cell = U.el('span', 'td-h2c td-h2-rollup', tot);
        cell.textContent = rollup;
        /* the rollup text flows over the cells before the first money column */
        cell.style.gridColumn = '1 / ' + (firstMoney < 0 ? vis.length + 1 : Math.max(firstMoney + 1, 2));
        continue;
      }
      if (firstMoney < 0 || i < firstMoney) continue;   /* covered by the rollup span */
      const cell = U.el('span', 'td-h2c', tot);
      cell.style.gridColumn = String(i + 1);
      if (c.id in money) {
        cell.className = 'td-h2c ta-r td-h2-sum ' + signCls(money[c.id]);
        cell.textContent = fmtPlain(money[c.id]);
      }
    }
    void this._dealSum;
  },

  /* ROUND102: jump the charts to a closed trade (and pull its symbol up if
     it is already open) — the dock row and the on-chart history layer stop
     being two unrelated views of the same fill */
  _showTrade(t) {
    this._focusSymbol(t.symbol);
    const mid = Math.floor((t.openT + t.closeT) / 2) || t.openT;
    try { GoToDate.jump(mid); } catch (e) {
      UI.toast('Could not move the chart to ' + new Date(mid * 1000).toISOString().slice(0, 10), '');
    }
  },
};

export { TradeDock };
