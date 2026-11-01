/**
 * ROUND85c — chart trade overlay: entry / SL / TP / pending-order price
 * lines drawn ON the chart, with the full MT5-style interaction set.
 *
 * Lines & tags (user round 85c):
 *   - entry line : blue dashed, on-chart tag "BUY 0.10 · +12.34" (live P/L,
 *                  toggleable via Trade.setPlTag) — the ONLY line that keeps
 *                  an info tag. DRAG it vertically MT5-style: up/down sets
 *                  TP or SL depending on the position side (BUY: up=TP,
 *                  down=SL — mirrored for SELL) with a live P/L preview.
 *   - SL line    : red dashed, NO on-chart tag — only its price chip
 *                  highlighted on the price scale. DRAGGABLE vertically.
 *   - TP line    : green dashed, same rules as SL.
 *   - pending    : orange dotted, small type tag, DRAGGABLE (re-prices).
 *
 * ROUND105 (user request — MT5 parity on the SL/TP hover tag + drag):
 *   - the hover tag now names the SYMBOL next to the level (entry, SL/TP
 *     and pending-order tooltips) and SL/TP tags carry the trade context
 *     row (side · volume → open) plus a "drag to move" hint
 *   - the money row no longer depends on a cached spec: the spec is
 *     fetched on first hover and the SAME box repaints when it lands
 *   - dragging an SL/TP (position or pending order) shows the MONEY the
 *     level would lock + its points/pips distance from the open, on a
 *     red/green chip with the stops-level "too close" warning; the
 *     entry-drag chip gained the same distance readout
 *
 * ROUND106 (user follow-up: "the hover tag still does not show"):
 *   - the ROUND100 350ms dwell + its 10s TTL are deleted. The tag shows the
 *     INSTANT the pointer touches a line (at the cursor, MT5-style), slides
 *     along the line, and closes the moment the pointer leaves it.
 *   - the spec is PREFETCHED when trade lines are built (_syncPane) and an
 *     incomplete cached spec is dropped+refetched (_ensureSpec), so the
 *     money row is ready on frame one of the very first hover
 *
 * ROUND107 (user photo report: STILL no tag — cursor shows ns-resize on the
 *   dashed line yet zero tooltip). The REAL root cause, proven by booting
 *   the app in headless chromium with a live demo broker and parking the
 *   mouse on the SL line:
 *   the whole chain FIRED (probe: _onHover 12x, _showTip 4x, tag HTML built
 *   with the money row) — but the tag still had a 0x0 bounding rect.
 *   _showTip did `tip.style.display = ''` to show the box — that only
 *   CLEARS the inline override, and the `.trade-hover-tip` CSS class
 *   itself defaults to `display: none` (round 100), so the COMPUTED
 *   display stayed `none` forever. The tag was "shown" into a hidden
 *   element, every round since the tooltip existed. The drag chip never
 *   had this trap because `.trade-drag-chip` carries no display:none —
 *   exactly matching the user's reports (drag chip visible, hover tag not).
 *   - FIX: showing now sets an EXPLICIT winning value — `display:'block'`
 *     (inline block beats the class's none; hide keeps 'none').
 *   - the SAME trap killed the trade-history hover box (.th-hist-tip also
 *     defaults to display:none and history.js also toggled '') — fixed
 *     there too (closed-trade profit box is visible again).
 *
 * ROUND127 (user request) — click vs drag separation:
 *   - a SINGLE CLICK on an entry/SL/TP/pending line does NOTHING: the
 *     press only starts a CANDIDATE drag; the drag ARMS after the pointer
 *     really travels DRAG_ARM_PX (6px) — the classic Click+drag&drop.
 *     (Before, the mousedown itself re-priced the line toward the clicked
 *     Y and a few pixels of jitter on release SENT the modify order.)
 *   - the right-click trade menu (ROUND102) and the hover tag (ROUND116
 *     hold) are untouched.
 *
 * Hover anywhere on a line (user round 85c):
 *   - the cursor changes (ns-resize / grab) — even though the drawing
 *     canvas sits on top, we win with an !important inline cursor and
 *     hand control back to the engine on leave
 *   - a tooltip shows what the line is: ticket, side, volume and the
 *     money P/L at that level (SL -> the loss it would lock, TP -> the
 *     profit it would lock, entry -> the live floating P/L)
 *   - the whole position FAMILY (entry + its SL + its TP) lights up and
 *     the other lines fade — so with many trades it is always clear
 *     which SL/TP belongs to which position
 *
 * Dropping a dragged line sends the matching MT5 action
 * (TRADE_ACTION_SLTP / TRADE_ACTION_MODIFY through the provider bridge);
 * a failure snaps the line back via the next state refresh.
 *
 * Lines live in a WeakMap keyed by pane — no changes to manager.js: the
 * sync loop re-reads App.panes every cycle, rebuilds on symbol change and
 * removes everything when the trades go away.
 *
 * @module trade/overlay
 */
import { App } from '../../../core/state.js';
import { U } from '../core/util.js';
import { UI } from '../drawing/ui.js';
import { Trade, OT_NAME } from './state.js';
import { TradeRoute } from './route.js';
import { TradeModify } from './modify.js';
import { clampStopPrice } from '../../../core/demo-math.js';

const HIT_PX = 9;          // drag/hover hit radius around a line
const DRAG_ARM_PX = 6;     /* ROUND127: pointer travel required to ARM a drag —
                              a bare CLICK (press + release under the threshold)
                              does NOTHING: no line move, no ghost/chip, no
                              order. Only Click+drag&drop moves the lines. */
const SYNC_MS = 700;       // structural sync interval
/* ROUND116 (user request): the hover TAG comes back behind a HOLD — the
   pointer must rest on the line for this long before the tag renders.
   Crossing the lines while sweeping the chart must NOT flash the tags.
   (ROUND106 removed the old 350ms dwell because its fire-time re-verify
   died on live charts — this dwell does NOT re-verify the pointer: once
   the hold is earned, the tag shows at the parked cursor even if a tick
   re-fit moved the line's Y; the next real mouse move re-judges.) */
const TIP_DWELL_MS = 2000;
/* ROUND106: TIP_DELAY (350ms dwell) and TIP_TTL (10s auto-close) are GONE.
   The user kept reporting "the SL/TP hover tag never shows". Root cause:
   on a LIVE chart the price scale re-fits on every tick, so the line's
   `priceToCoordinate` Y shifts away from a parked cursor — the dwell's
   re-verify then killed the tip before it ever rendered (the drag path
   has no such re-verify, which is exactly why dragging always worked).
   MT5 parity the user asked for three rounds running: the tag shows the
   MOMENT the pointer touches the line and closes the moment it leaves
   (hide-on-leave already shipped in round 102). */
const C = {
  entry: '#2962ff', sl: '#f23645', tp: '#089981', order: '#ff9800',
  dragBg: 'rgba(41,98,255,.92)',
};

/* hex -> rgba string at `a` alpha (family dimming) */
function dim(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

function fmtMoney(v) {
  if (v == null || !isFinite(v)) return '—';
  const r = Math.round(v * 100) / 100;
  /* ROUND85d: the user asked for the DOLLAR amount on the entry tag —
     "+$12.34" / "-$12.34" / "$0.00" (used by tag, tooltip, drag chip) */
  return (r > 0 ? '+$' : (r < 0 ? '-$' : '$')) + Math.abs(r).toFixed(2);
}

const TradeOverlay = {
  _map: new WeakMap(),
  _syncTimer: null,
  _drag: null,

  init() {
    if (this._syncTimer) return;
    this._syncTimer = setInterval(() => this.sync(), SYNC_MS);
    Trade.onChange.push(() => { this.sync(); this._updateTitles(); });
    /* live P/L in the entry-line titles — cheap, no rebuild */
    setInterval(() => this._updateTitles(), 900);
    document.addEventListener('mousemove', this._onMove.bind(this), true);
    document.addEventListener('mouseup', this._onUp.bind(this), true);
    /* ROUND128: a drag that never saw its mouseup (released OUTSIDE the
       window, focus stolen mid-drag) used to leave the ghost line + frozen
       chart gestures behind — the ghost is a dotted SL/TP-looking line that
       survives with NO positions (the "stuck line" report). Blur cancels. */
    window.addEventListener('blur', () => { try { this._cancelDrag(); } catch (e) {} });
    /* ROUND99: the HOVER path moves to ONE document-level capture listener
       that resolves the pane from the event target. The old per-pane
       mousemove registration (inside _ensureDragHandlers) depended on the
       first line build of every pane — any missed/skipped registration
       silently killed the SL/TP dwell tooltip. This path cannot miss: it
       works for every pane, with or without lines, from app start. */
    document.addEventListener('mousemove', this._onDocMove.bind(this), true);
  },

  /* ---------- line management ---------- */
  sync() {
    for (const pane of App.panes) {
      try { this._syncPane(pane); } catch (e) {}
    }
  },

  _state(pane) {
    let st = this._map.get(pane);
    if (!st) {
      st = { symbol: null, key: '', lines: [], dragReady: false, curOn: false, hlTicket: null,
        tipKey: null, series: null, dwell: null, lastX: 0, lastY: 0 };
      this._map.set(pane, st);
    }
    return st;
  },

  _clear(pane, st) {
    for (const l of st.lines) {
      /* ROUND128: remove through the series that OWNS the line. After a
         series swap the old handles belong to the detached series — calling
         pane.series.removePriceLine with them silently no-oped and left
         orphaned SL/TP lines painted on the live series (the ghost-lines
         report: lines visible with NO positions, fixed by a theme flip that
         rebuilt the pane). */
      const owner = l.ser || pane.series;
      try { owner.removePriceLine(l.pl); } catch (e) {
        try { pane.series.removePriceLine(l.pl); } catch (e2) {}
      }
    }
    st.lines = [];
  },

  _syncPane(pane) {
    if (!pane || !pane.series || !pane.series.createPriceLine) return;
    const st = this._state(pane);
    /* ROUND116 (user report): Manager.setStyle REPLACES pane.series and the
       old price lines die with the old series ("old lines died with the old
       series") — the structural key below did not change, so the overlay
       never rebuilt and entry/SL/TP/pending lines stayed gone through every
       chart type (line, renko, bars...) AND after switching back. Rebuild
       whenever the series INSTANCE changed, whatever replaced it. */
    if (st.symbol !== pane.symbol || st.series !== pane.series) {
      this._clear(pane, st);
      st.symbol = pane.symbol;
      st.series = pane.series;
      st.key = '';
    }
    /* ROUND128 (user report): STALE LIVE lines in demo mode. The overlay
       draws the LIVE account's trades — while the user is trading the DEMO
       account (or with the bridge offline and a stale last poll) those rows
       kept painting ghost entry/SL/TP lines that belong to no live trade.
       Mirror the demo overlay's mode guard: in DEMO mode this overlay is
       always empty. */
    if (TradeRoute.isDemo()) {
      if (st.lines.length || st.key !== '') { this._clear(pane, st); st.key = ''; }
      return;
    }
    const positions = Trade.positions.filter((p) => p.symbol === pane.symbol);
    const orders = Trade.orders.filter((o) => o.symbol === pane.symbol);
    /* ROUND128 BELT+BRACES (the exact reported symptom): with NO positions
       AND no orders on this symbol there must be NO lines — force the clear
       even if the structural key somehow matches stale state. */
    if (!positions.length && !orders.length && st.lines.length) {
      this._clear(pane, st);
      st.key = JSON.stringify([[], []]);
      this._clearDwell(pane, st);
      return;
    }
    /* ROUND99 ROOT FIX: the key used to stringify the WHOLE rows — the live
       `profit`/`current` fields change on every 1.2s state poll, so ALL
       lines were torn down and rebuilt every poll. That churn reset the
       family highlight, flickered the lines under the cursor and could
       interrupt a running dwell. Only the STRUCTURAL fields belong in the
       rebuild key; live P/L rides on _updateTitles() instead. */
    const key = JSON.stringify([
      positions.map((p) => [p.ticket, p.type, p.volume, p.open, p.sl, p.tp]),
      orders.map((o) => [o.ticket, o.type, o.volume, o.price, o.sl, o.tp]),
    ]);
    if (key === st.key) return;
    st.key = key;
    this._clear(pane, st);
    st.hlTicket = null; // lines are rebuilt fresh — re-evaluate the highlight
    /* ROUND100: a structural rebuild (SL/TP modified, position closed)
       invalidates any visible tip — its line may be gone */
    this._clearDwell(pane, st);
    const L = LightweightCharts.LineStyle;
    const mk = (price, opts) => {
      /* private keys (_kind/_ticket/_ref/_ser) must never reach LWC's option merge */
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
        return pl;
      } catch (e) { return null; }
    };
    for (const p of positions) {
      const side = p.type === 0 ? 'BUY' : 'SELL';
      /* entry: the ONLY tagged line — "BUY 0.10  +$12.34".
         ROUND85d ROOT FIX: in this LWC build the price-line title is
         rendered by the AXIS view only, and that view bails out early
         when axisLabelVisible is false — the previous axisLabelVisible:false
         silently killed the whole tag (no side, no volume, no P/L).
         true = the tag renders (chip on the scale + title next to it). */
      mk(p.open, {
        color: C.entry, lineStyle: L.Dashed,
        axisLabelVisible: true, axisLabelColor: C.entry, axisLabelTextColor: '#fff',
        title: this._entryTitle(p), _kind: 'entry', _ticket: p.ticket, _ref: p, _ser: pane.series,
      });
      /* SL/TP: NO on-chart tag — only the colored price chip on the scale */
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
      /* ROUND98 (user request): pending orders with an SL/TP get the SAME
         red/green dashed lines as positions — the hover tooltip (money +
         pips/points from the ORDER's price) and drag-to-modify work on
         them exactly like on position lines */
      if (o.sl > 0) mk(o.sl, {
        color: C.sl, title: '', axisLabelColor: C.sl, axisLabelTextColor: '#fff',
        _kind: 'sl', _ticket: o.ticket, _ref: o, _ser: pane.series,
      });
      if (o.tp > 0) mk(o.tp, {
        color: C.tp, title: '', axisLabelColor: C.tp, axisLabelTextColor: '#fff',
        _kind: 'tp', _ticket: o.ticket, _ref: o, _ser: pane.series,
      });
    }
    this._ensureDragHandlers(pane, st);
    this._updateTitles();
    /* ROUND106: prefetch the spec the moment trade lines exist, so the
       FIRST hover already has tick_value/tick_size and the money row of
       the tag renders on frame one (the hover-time _ensureSpec stays as
       a safety net for rejected/failed fetches) */
    if (positions.length || orders.length) this._ensureSpec(st);
  },

  /* entry tag = side + (volume per Trade.volTag) + (live $ P/L per
     Trade.plTag); rebuilt live by _updateTitles every ~900ms */
  _entryTitle(pos) {
    return (pos.type === 0 ? 'BUY' : 'SELL') +
      (Trade.volTag ? ' ' + pos.volume : '') +
      (Trade.plTag ? '  ' + fmtMoney(Trade.profitOf(pos)) : '');
  },

  _updateTitles() {
    for (const pane of App.panes) {
      const st = this._map.get(pane);
      if (!st || !st.lines) continue;
      for (const l of st.lines) {
        if (l.kind !== 'entry') continue;
        const pos = Trade.positions.find((p) => p.ticket === l.ticket);
        if (!pos) continue;
        try { l.pl.applyOptions({ title: this._entryTitle(pos) }); } catch (e) {}
      }
    }
  },

  /* ---------- cursor / tooltip / family highlight ---------- */
  /* The drawing canvas (.pane-overlay) IS the engine's canvas and the
     engine rewrites its cursor on every mousemove — and a later normal
     write REPLACES even an !important inline declaration (Chromium CSSOM).
     So the cursor is written by the canvas-level arbiter below, which is
     registered AFTER the engine's listener and therefore runs after it on
     every event: we only speak when a trade line is under the pointer and
     hand control straight back the moment there is none. */
  _setCursor(pane, cur) {
    const st = this._state(pane);
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

  /* runs after the engine's own mousemove (same target, later registration):
     the last cursor write of this event — ours when a line is hit */
  _cursorSync(e, pane) {
    if (this._drag) return; // drag owns the cursor until it ends
    const st = this._map.get(pane);
    if (!st) return;
    const hit = this._hit(pane, e.clientY);
    this._setCursor(pane, hit ? (hit.line.kind === 'entry' ? 'grab' : 'ns-resize') : null);
  },

  /* ROUND99: document-level hover driver (see init) — resolves which pane
     the pointer is over, runs the dwell/hover path for it and clears the
     tooltip/cursor on every pane the pointer has LEFT. Runs for every
     mousemove on the page, so each branch is guarded and cheap.
     ROUND100: the whole pipeline is exception-proof — one swallowed error
     used to be enough to silently kill the SL/TP tooltip forever. */
  _onDocMove(e) {
    if (this._drag) return;
    if (!(e.target instanceof Node)) return;
    /* ROUND116 (user request): the floating trade-management panel and its
       minimize pill live INSIDE pane.root — with a Y-only line hit the app
       read a SL/TP/entry line passing BEHIND the widget as hovered. While
       the pointer is on one of those widgets the hover path must see
       "off-chart": the existing !over branch then drops cursor, tag and
       dwell on every pane. */
    const onFloat = !!(e.target.closest && e.target.closest('.oc-panel, .oc-pill'));
    /* ROUND102: hover hit-testing is throttled to ~60Hz. It runs for every
       pane on every mousemove and each pass costs a priceToCoordinate per
       line — unthrottled it competed with the chart's own render loop. */
    const now = (typeof performance === 'object' && performance.now) ? performance.now() : Date.now();
    if (this._hoverAt && now - this._hoverAt < 16) return;
    this._hoverAt = now;
    for (const pane of App.panes) {
      const st = this._map.get(pane);
      if (!st) continue;
      const over = !onFloat && pane.root && pane.root.contains(e.target);
      if (!over) {
        const tip = pane._tradeTip;
        if (st.curOn || (tip && tip.style.display !== 'none')) {
          this._setCursor(pane, null);
          this._clearDwell(pane, st);
        }
        continue;
      }
      try { this._onHover(e, pane); } catch (er) {}
    }
  },

  _tip(pane) {
    let tip = pane._tradeTip;
    if (!tip) {
      tip = U.el('div', 'trade-hover-tip', pane.root);
      tip.style.display = 'none';
      pane._tradeTip = tip;
    }
    return tip;
  },

  /* ROUND98: a pending order's SL/TP lines need position-shaped math —
     synthesize the WOULD-BE position (fill at the order price; buy side
     for types 2/4/6, sell side for 3/5/7) so profitAt works unchanged */
  _orderPos(o) {
    return { symbol: o.symbol, type: o.type >= 2 ? (o.type % 2 === 0 ? 0 : 1) : o.type,
      open: o.price, volume: o.volume, swap: 0 };
  },

  /* ROUND105: shared points/pips readout — the distance a level sits from
     the trade's open (pending orders measure from their own fill price).
     Powers BOTH the SL/TP hover tag and the drag chip. 5/3-digit symbols:
     1 pip = 10 points. Returns null when the point size is unknown. */
  _dist(symbol, open, price) {
    const s = Trade.specSync(symbol);
    const dg = (s && s.digits) || 5;
    const pt = (s && s.point > 0) ? s.point : (U.pointSize ? U.pointSize(dg) : Math.pow(10, -dg));
    if (!(pt > 0) || !(open > 0) || !(price > 0)) return null;
    const pts = Math.abs(price - open) / pt;
    const isFrac = (dg === 3 || dg === 5); /* 5/3-digit: 1 pip = 10 points */
    const pips = isFrac ? pts / 10 : null;
    const f1 = (x) => (Math.abs(x - Math.round(x)) < 0.05 ? String(Math.round(x)) : x.toFixed(1));
    return { pts, pips,
      txt: f1(pts) + ' points' + (isFrac ? ' · ' + f1(pips) + ' pips' : '') };
  },

  /* ROUND105: the stops-level guard the entry drag already had — a level
     dropped inside the broker's minimum stop distance gets rejected, so
     the chip/tag warns instead of letting the user discover it on drop */
  _stopsWarn(pane, s, pos, price) {
    if (!s || !(s.stops_level > 0) || !(s.point > 0) || !pos) return '';
    const q = Trade.quote(pane.symbol) || {};
    const px = pos.type === 0 ? (q.bid || s.bid) : (q.ask || s.ask);
    if (!(px > 0) || Math.abs(price - px) >= s.stops_level * s.point) return '';
    return ' · too close';
  },

  /* ROUND268: a dragged SL/TP may not cross its own reference price.
     Positions hang off their CLOSE-OUT price (bid for a buy, ask for a sell),
     pending orders off their own order price. Without this a drop on the
     wrong side sent `modifySLTP`/`modifyOrder` with an inverted stop and the
     broker refused it — MT5 simply sticks the line at the legal boundary. */
  _clampStop(pane, pos, kind, price, order) {
    const s = Trade.specSync(pane.symbol);
    const q = Trade.quote(pane.symbol) || {};
    const ref = order ? (order.price || 0)
      : (pos && pos.type === 0 ? (q.bid || (s && s.bid) || 0)
        : (q.ask || (s && s.ask) || 0));
    return clampStopPrice(s, pos ? pos.type : 0, ref, kind, price);
  },

  _lineMoney(l) {
    /* money P/L at the line's level (null = not applicable).
       ROUND99 guard: without a loaded spec, profitAt falls back to the
       position's CURRENT profit — showing today's floating P/L as "the
       money the SL locks" is WRONG, so SL/TP return null instead. */
    const pos = Trade.positions.find((p) => p.ticket === l.ticket);
    if (pos) {
      if (l.kind === 'entry') return Trade.profitOf(pos);
      if (l.kind === 'sl' || l.kind === 'tp') {
        const s = Trade.specSync(pos.symbol);
        return (s && s.tick_value > 0 && s.tick_size > 0) ? Trade.profitAt(pos, l.price) : null;
      }
      return null;
    }
    /* ROUND98: SL/TP lines of PENDING orders */
    const o = Trade.orders.find((x) => x.ticket === l.ticket);
    if (o && (l.kind === 'sl' || l.kind === 'tp')) {
      const s = Trade.specSync(o.symbol);
      return (s && s.tick_value > 0 && s.tick_size > 0)
        ? Trade.profitAt(this._orderPos(o), l.price) : null;
    }
    return null;
  },

  /* ROUND105: the tag content in ONE builder — every kind names the SYMBOL
     (user round 105: money + points + symbol, like MetaTrader). SL/TP tags
     also show the trade context row (side · volume → open) and a drag
     hint; the money/points numbers come from the shared _dist/_lineMoney
     helpers so the hover tag and the drag chip can never disagree. */
  _tipHtml(pane, st, l) {
    const dg = (Trade.specSync(st.symbol) || {}).digits || 5;
    const sym = U.esc(st.symbol || pane.symbol || '');
    const money = (v) => '<div class="tht-row tht-money ' +
      (v > 0.004 ? 'pos' : (v < -0.004 ? 'neg' : '')) + '">' + fmtMoney(v) + '</div>';
    if (l.kind === 'entry') {
      const pos = Trade.positions.find((p) => p.ticket === l.ticket);
      if (!pos) return '';
      const v = Trade.profitOf(pos);
      return '<div class="tht-row"><b>' + (pos.type === 0 ? 'BUY' : 'SELL') + ' ' + U.esc(pos.volume) +
        ' · ' + sym + '</b><span class="tht-dim">#' + U.esc(pos.ticket) + '</span></div>' +
        money(v) +
        '<div class="tht-hint">↕ drag to set ' + (pos.type === 0 ? 'TP (up) / SL (down)' : 'SL (up) / TP (down)') + '</div>';
    }
    if (l.kind === 'sl' || l.kind === 'tp') {
      const v = this._lineMoney(l);
      /* ROUND98: MT5 parity — the distance the line sits from the trade's
         open (points + pips) next to the money it locks. Pending orders
         measure from their own fill price. */
      const pos = Trade.positions.find((p) => p.ticket === l.ticket);
      const ord = pos ? null : Trade.orders.find((x) => x.ticket === l.ticket);
      const ref = pos || (ord ? this._orderPos(ord) : null);
      const d = ref ? this._dist(st.symbol, ref.open, l.price) : null;
      const ctx = pos
        ? '<div class="tht-row tht-dim">' + (pos.type === 0 ? 'BUY' : 'SELL') + ' ' + U.esc(pos.volume) +
          ' → ' + Number(pos.open).toFixed(dg) + '</div>'
        : (ord ? '<div class="tht-row tht-dim">' + (OT_NAME[ord.type] || 'Order') + ' ' + U.esc(ord.volume) +
          ' → ' + Number(ord.price).toFixed(dg) + '</div>' : '');
      return '<div class="tht-row"><b class="' + (l.kind === 'sl' ? 'tht-sl' : 'tht-tp') + '">' +
        l.kind.toUpperCase() + ' ' + Number(l.price).toFixed(dg) + ' · ' + sym + '</b>' +
        (pos ? '<span class="tht-dim">#' + U.esc(pos.ticket) + '</span>' : '<span class="tht-dim">pending</span>') + '</div>' +
        (v != null ? money(v) : '') +
        (d ? '<div class="tht-row tht-dim">' + d.txt + '</div>' : '') +
        ctx +
        '<div class="tht-hint">↕ drag to move</div>';
    }
    if (l.kind === 'order') {
      const o = Trade.orders.find((x) => x.ticket === l.ticket);
      return '<div class="tht-row"><b class="tht-ord">' + (o ? (OT_NAME[o.type] || '') + ' ' + U.esc(o.volume) : 'Order') +
        ' · ' + sym + '</b>' + (o ? '<span class="tht-dim">#' + U.esc(o.ticket) + '</span>' : '') + '</div>' +
        '<div class="tht-row tht-dim">' + Number(l.price).toFixed(dg) + '</div>';
    }
    return '';
  },

  /* ROUND106: the money row of the SL/TP tag needs tick_value/tick_size.
     Returns true when a COMPLETE spec is cached; otherwise fires the fetch
     (dropping an incomplete cached row — an empty/failed answer would
     otherwise block refetch for its whole 60s TTL). Single-flight is
     Trade.spec's own, so this is safe to call from hover and sync alike. */
  _ensureSpec(st) {
    const s = Trade.specSync(st.symbol);
    if (s && s.tick_value > 0 && s.tick_size > 0) return true;
    try { delete Trade.specs[st.symbol]; } catch (e) {}
    try { Trade.spec(st.symbol).catch(() => {}); } catch (e) {}
    return false;
  },

  _showTip(pane, st, l, y, cx, cy) {
    const tip = this._tip(pane);
    const html = this._tipHtml(pane, st, l);
    tip.innerHTML = html;
    tip.className = 'trade-hover-tip tht-' + l.kind;
    /* ROUND107 ROOT FIX: '' only CLEARS the inline display — the class rule
       `.trade-hover-tip { display:none }` then keeps the computed value at
       none and the tag never renders (0x0 rect, proven in the round-107
       repro). An explicit 'block' BEATS the class; 'none' still hides. */
    tip.style.display = html ? 'block' : 'none';
    if (html) {
      /* ROUND106: if the spec is missing/incomplete the money row stays
         hidden (_lineMoney refuses to fake it with today's floating P/L) —
         fetch it and repaint the SAME visible box when it lands */
      if (!this._ensureSpec(st)) {
        const key0 = l.kind + '#' + l.ticket;
        Trade.spec(st.symbol).then(() => {
          if (st.tipKey !== key0) return;
          const t = pane._tradeTip;
          if (!t || t.style.display === 'none') return;
          try { t.innerHTML = this._tipHtml(pane, st, l); } catch (e) {}
        }).catch(() => {});
      }
      /* the tip is FIXED-positioned at the cursor (screen space, like MT5's
         trade box) — immune to any offsetParent/scroll context, clamped to
         the viewport so it can never render half-off-screen */
      const px = (cx != null) ? cx : (pane.root ? pane.root.getBoundingClientRect().left + 40 : 40);
      const py = (cy != null) ? cy : (pane.root ? pane.root.getBoundingClientRect().top + (y || 40) : 40);
      const w = tip.offsetWidth || 170, h = tip.offsetHeight || 64;
      let x = px + 16, yy = py + 14;
      if (x + w > window.innerWidth - 8) x = px - w - 12;
      if (yy + h > window.innerHeight - 8) yy = py - h - 12;
      if (x < 8) x = 8;
      if (yy < 8) yy = 8;
      tip.style.left = x + 'px';
      tip.style.top = yy + 'px';
    }
    this._highlight(pane, st, l.ticket);
  },

  _hideTip(pane, st) {
    const tip = pane._tradeTip;
    if (tip) tip.style.display = 'none';
    this._highlight(pane, st, null);
  },

  /* ROUND85E: close the tag + highlight + the ROUND116 hold timer — used on
     leave / drag start / moving off the lines. ROUND106 renamed this from
     the old dwell teardown; the name survived so every call site stays. */
  _clearDwell(pane, st) {
    if (st.dwell) { try { clearTimeout(st.dwell.timer); } catch (e) {} st.dwell = null; }
    st.tipKey = null;
    this._hideTip(pane, st);
  },

  /* family highlight: the hovered position's entry+SL+TP stay strong, the
     rest of the chart's trade lines fade (which SL/TP belongs to which trade) */
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
    /* ROUND99: only the DRAG (mousedown) stays here — the hover path is
       the document-level _onDocMove driver registered once in init() */
    root.addEventListener('mousedown', (e) => this._onDown(e, pane), true);
    /* ROUND102: right-click ON a trade line opens the trade menu instead of
       the chart menu (MetaTrader parity). Capture phase on the pane root
       runs BEFORE the drawing canvas' own contextmenu handler, and we only
       swallow the event when a line is actually under the cursor. */
    root.addEventListener('contextmenu', (e) => this._onCtx(e, pane), true);
    /* ROUND128 (user request): DOUBLE-CLICK on the trade's line on the
       chart opens the Modify modal (partial exit + SL/TP) — the SAME dialog
       the Tool Box double-click and the "Modify position" menu item open.
       Capture phase, and only when a line is hit, so the drawings' own
       double-click (tool settings) keeps working everywhere else. */
    root.addEventListener('dblclick', (e) => this._onDbl(e, pane), true);
    /* cursor arbitration on the ENGINE's canvas, registered after its own
       mousemove — this listener runs LAST for every event over the chart */
    if (pane.overlay) pane.overlay.addEventListener('mousemove', (e) => this._cursorSync(e, pane));
    root.addEventListener('mouseleave', () => {
      if (this._drag && this._drag.pane === pane) return;
      this._setCursor(pane, null);
      this._clearDwell(pane, st);
    });
  },

  /* ---------- ROUND102: on-chart trade menu ----------
     Closing a position, halving it, pulling an SL to break-even or dropping
     an SL/TP used to mean: find the dock, find the row, find the button.
     Everything is now one right-click away on the line itself. */
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

  /* ROUND128 (user request): double-click on a chart trade line opens the
     SAME Modify modal as the Tool Box double-click and the menu item. */
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
    const pos = Trade.positions.find((p) => p.ticket === line.ticket);
    const ord = pos ? null : Trade.orders.find((o) => o.ticket === line.ticket);
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
      /* ROUND128 (user request): "Modify position" — the SAME modal the
         Tool Box double-click and the chart-line double-click open. */
      items.push({
        label: 'Modify position',
        run: () => TradeModify.open('pos', pos.ticket),
      });
      items.push({
        label: 'Close position (' + fmtMoney(Trade.profitOf(pos)) + ')', danger: true,
        run: () => Trade.closePosition(pos.ticket, 0)
          .then(() => UI.toast('Close sent — #' + pos.ticket, 'ok'))
          .catch(fail('Close')),
      });
      const step = (s && s.vol_step) || 0.01;
      const vmin = (s && s.vol_min) || 0.01;
      const half = Math.max(vmin, Math.round((pos.volume / 2) / step) * step);
      if (half < pos.volume) {
        items.push({
          label: 'Close half (' + Number(half.toFixed(2)) + ' lots)',
          run: () => Trade.closePosition(pos.ticket, Number(half.toFixed(2)))
            .then(() => UI.toast('Partial close sent — #' + pos.ticket, 'ok'))
            .catch(fail('Partial close')),
        });
      }
      const be = Number(pos.open.toFixed(dg));
      const beDone = pos.sl > 0 && Math.abs(pos.sl - be) < (s ? s.point / 2 : 1e-9);
      const q0 = Trade.quote(pane.symbol) || {};
      const beRef = pos.type === 0 ? (q0.bid || (s && s.bid) || 0) : (q0.ask || (s && s.ask) || 0);
      /* ROUND268: the broker only takes a break-even stop once the market is
         past the entry — disable the row instead of sending a rejected one */
      const beIllegal = clampStopPrice(s, pos.type, beRef, 'sl', be) !== be;
      items.push({
        label: 'Stop loss to break-even (' + be.toFixed(dg) + ')' + (beIllegal ? ' — market not past the entry' : ''),
        disabled: beDone || beIllegal,
        run: () => Trade.modifySLTP(pos.ticket, be, pos.tp || 0)
          .then(() => UI.toast('SL moved to break-even', 'ok'))
          .catch(fail('SL')),
      });
      if (pos.sl > 0) {
        items.push({
          label: 'Remove stop loss',
          run: () => Trade.modifySLTP(pos.ticket, 0, pos.tp || 0)
            .then(() => UI.toast('SL removed', 'ok')).catch(fail('SL')),
        });
      }
      if (pos.tp > 0) {
        items.push({
          label: 'Remove take profit',
          run: () => Trade.modifySLTP(pos.ticket, pos.sl || 0, 0)
            .then(() => UI.toast('TP removed', 'ok')).catch(fail('TP')),
        });
      }
    } else {
      items.push({ head: (OT_NAME[ord.type] || 'Order') + ' ' + ord.volume + ' ' + ord.symbol + '  ·  #' + ord.ticket });
      /* ROUND128: "Modify order" — the same modal, order variant. */
      items.push({
        label: 'Modify order',
        run: () => TradeModify.open('ord', ord.ticket),
      });
      items.push({
        label: 'Cancel order', danger: true,
        run: () => Trade.cancelOrder(ord.ticket)
          .then(() => UI.toast('Cancel sent — #' + ord.ticket, 'ok'))
          .catch(fail('Cancel')),
      });
      if (ord.sl > 0) {
        items.push({
          label: 'Remove stop loss',
          run: () => Trade.modifyOrder(ord.ticket, ord.price, 0, ord.tp || 0)
            .then(() => UI.toast('SL removed', 'ok')).catch(fail('SL')),
        });
      }
      if (ord.tp > 0) {
        items.push({
          label: 'Remove take profit',
          run: () => Trade.modifyOrder(ord.ticket, ord.price, ord.sl || 0, 0)
            .then(() => UI.toast('TP removed', 'ok')).catch(fail('TP')),
        });
      }
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
    /* clamp into the viewport */
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
    const r = this._lwcRect(pane);
    return clientY - r.top;
  },

  /* ROUND100 ROOT FIX: the hover hit-test MUST measure against the same
     origin `series.priceToCoordinate` reports — the LWC chart element
     itself (.tv-lightweight-charts), NOT the sub-pane wrapper around it.
     Any wrapper offset (legend strip, sub-pane stacking, layout rounding)
     shifted the comparison by a constant and the hit NEVER matched — the
     SL/TP tooltip the user kept asking for silently never fired. All
     measurements now share one screen-space origin. */
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
      /* ROUND102/106: the moment the pointer is off the line the box closes
         — the tag lives ON the line, exactly like MetaTrader */
      this._clearDwell(pane, st);
      return;
    }
    const key = hit.line.kind + '#' + hit.line.ticket;
    st.lastX = e.clientX;                     // remembered for the dwell fire —
    st.lastY = e.clientY;                     // the tag opens at the parked cursor
    if (st.tipKey === key) {
      const tip = pane._tradeTip;
      if (tip && tip.style.display !== 'none') {
        tip.style.left = (e.clientX + 16) + 'px';
        tip.style.top = (e.clientY + 14) + 'px';
      }
      return;
    }
    /* ROUND116 (user request): NO tag on the touch — the pointer must HOLD
       on the line for TIP_DWELL_MS. Sweeping across the lines keeps hitting
       each line for a few frames, which never completes a hold, so nothing
       flashes any more. A tag that is already visible closes the moment the
       pointer reaches a DIFFERENT line (its own hold starts from zero). */
    const tip = pane._tradeTip;
    if (st.tipKey && (!tip || tip.style.display !== 'none')) {
      st.tipKey = null;
      this._hideTip(pane, st);
    }
    this._armDwell(pane, st, key);
  },

  /* ROUND116: one hold timer per pane — re-arming for the SAME line keeps
     the running timer (the hold survives the 60Hz hit jitter), any other
     key (or a clear) restarts from zero. */
  _armDwell(pane, st, key) {
    if (st.dwell && st.dwell.key === key) return;
    if (st.dwell) { try { clearTimeout(st.dwell.timer); } catch (e) {} }
    st.dwell = {
      key,
      timer: setTimeout(() => { this._fireDwell(pane, st, key); }, TIP_DWELL_MS),
    };
  },

  /* the hold completed — show the tag. Deliberately NO pointer re-verify:
     the ROUND106 lesson was that live scale re-fits move the line's Y away
     from a parked cursor, and a fire-time hit-test then killed the tag
     before it ever rendered. The hold was earned on the line; the next
     real mouse move re-judges (a miss closes everything). */
  _fireDwell(pane, st, key) {
    st.dwell = null;
    if (this._drag || (this._menu && this._menu.style.display !== 'none')) return;
    const l = st.lines.find((x) => x.kind + '#' + x.ticket === key);
    if (!l) return;
    let y = null;
    try { y = pane.series.priceToCoordinate(l.price); } catch (e) { y = null; }
    this._showTip(pane, st, l, y, st.lastX, st.lastY);
    st.tipKey = key;
  },

  _onDown(e, pane) {
    if (e.button !== 0 || e.altKey) return;
    const st = this._map.get(pane);
    const hit = this._hit(pane, e.clientY);
    if (!hit || !st) return;
    e.preventDefault();
    e.stopPropagation();
    this._clearDwell(pane, st);
    this._closeMenu();
    /* ROUND128: a press while an OLD drag is still active (its mouseup was
       missed — released outside the window) OVERWROTE this._drag and leaked
       the old drag's ghost line + frozen gestures. Always clean up first. */
    if (this._drag) this._cancelDrag();
    const { line } = hit;
    /* ROUND127 (user request): a press alone starts only a CANDIDATE drag.
       Nothing happens — the line stays put, no ghost/chip, gestures stay
       live — until the pointer actually TRAVELS DRAG_ARM_PX pixels. A bare
       click (press+release, or press with a jitter under the threshold)
       ends in _onUp with armed=false and does NOTHING at all (previously
       the mousedown itself re-priced the line toward the clicked Y and a
       couple pixels of jitter sent the modify order on release). */
    this._drag = {
      pane, st, line, kind: line.kind, ticket: line.ticket,
      origPrice: line.price, saved: null,
      sx: e.clientX, sy: e.clientY, armed: false,
      chip: null, ghost: null, target: null,
    };
  },

  /* the drag ARMS on real travel — from here on it behaves like the old
     drag session: frozen gestures, spec prefetch, family highlight, ghost
     + chip for the entry line */
  _armDrag(e, d) {
    d.armed = true;
    const pane = d.pane, st = d.st, line = d.line;
    /* ROUND105: the drag chip's money preview needs tick_value/tick_size —
       make sure the spec is around (cached 60s, so at most one request) */
    if (!Trade.specSync(pane.symbol)) {
      try { Trade.spec(pane.symbol).catch(() => {}); } catch (er) {}
    }
    try {
      const co = pane.chart.options();
      d.saved = { hs: co.handleScroll, hsc: co.handleScale };
      pane.chart.applyOptions({ handleScroll: false, handleScale: false });
    } catch (er) { d.saved = null; }
    d.chip = this._chip(pane);
    this._setCursor(pane, line.kind === 'entry' ? 'grabbing' : 'ns-resize');
    this._highlight(pane, st, line.ticket);
  },

  _chip(pane) {
    let chip = pane._tradeChip;
    if (!chip) {
      chip = U.el('div', 'trade-drag-chip', pane.root);
      chip.style.display = 'none';
      pane._tradeChip = chip;
    }
    return chip;
  },

  /* MT5 semantics: dragging FROM the entry line — BUY: up = TP, down = SL;
     SELL: up = SL, down = TP. The predicted side follows the drag live. */
  _entryTarget(pos, price) {
    const above = price >= pos.open;
    return pos.type === 0 ? (above ? 'tp' : 'sl') : (above ? 'sl' : 'tp');
  },

  _onMove(e) {
    const d = this._drag;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    /* ROUND127: a candidate drag only ARMS once the pointer really travels
       (Click+drag&drop). Under the threshold nothing moves — the click
       alone must do nothing. */
    if (!d.armed) {
      const travel = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
      if (!(travel >= DRAG_ARM_PX)) return;
      this._armDrag(e, d);
    }
    const pane = d.pane;
    let price = null;
    try { price = pane.series.coordinateToPrice(this._mainY(pane, e.clientY)); } catch (er) { price = null; }
    if (price == null || !isFinite(price)) return;
    const s = Trade.specSync(pane.symbol);
    const dg = s ? s.digits : 5;
    price = Number(price.toFixed(dg));
    d.price = price;

    /* --- ROUND85c item 6: drag from the ENTRY line sets SL or TP --- */
    if (d.kind === 'entry') {
      const pos = Trade.positions.find((p) => p.ticket === d.ticket);
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
      /* preview chip: level + the money it locks + the distance from the
         open (ROUND105); warn inside the broker's stops level */
      const money = Trade.profitAt(pos, price);
      const warn = this._stopsWarn(pane, s, pos, price);
      const dist = this._dist(pane.symbol, pos.open, price);
      const label = target.toUpperCase() + ' ' + price.toFixed(dg) + '  ' + fmtMoney(money) +
        (dist ? '  ·  ' + dist.txt : '') + warn;
      if (d.chip) {
        d.chip.className = 'trade-drag-chip tdc-' + target + (warn ? ' tdc-warn' : '');
        d.chip.textContent = label;
      }
    } else {
      /* ROUND268: keep a dragged stop on its legal side while it moves, so the
         ghost line and chip show exactly what a drop will send. */
      if (d.kind === 'sl' || d.kind === 'tp') {
        const pos = Trade.positions.find((p) => p.ticket === d.ticket);
        const o = pos ? null : Trade.orders.find((x) => x.ticket === d.ticket);
        if (pos) price = this._clampStop(pane, pos, d.kind, price);
        else if (o) price = this._clampStop(pane, this._orderPos(o), d.kind, price, o);
        d.price = price;
      }
      try { d.line.pl.applyOptions({ price }); } catch (er) {}
      /* ROUND105 (user request): while an SL/TP is being dragged the chip
         shows the MONEY the level would lock + its points/pips distance
         from the trade's open — the user decides in dollars, not by
         squinting at the price scale. Pending orders measure from their
         own fill price. Without a cached spec the money is OMITTED rather
         than showing today's floating P/L in its place (ROUND99 rule). */
      let label = 'Order → ' + price.toFixed(dg);
      if (d.kind === 'sl' || d.kind === 'tp') {
        const ref = Trade.positions.find((p) => p.ticket === d.ticket) || (() => {
          const o = Trade.orders.find((x) => x.ticket === d.ticket);
          return o ? this._orderPos(o) : null;
        })();
        const m = (ref && s && s.tick_value > 0 && s.tick_size > 0)
          ? Trade.profitAt(ref, price) : null;
        const dist = ref ? this._dist(pane.symbol, ref.open, price) : null;
        const warn = this._stopsWarn(pane, s, ref, price);
        label = (d.kind === 'sl' ? 'SL' : 'TP') + ' ' + price.toFixed(dg) +
          (m != null ? '  ' + fmtMoney(m) : '') +
          (dist ? '  ·  ' + dist.txt : '') + warn;
        if (d.chip) d.chip.className = 'trade-drag-chip tdc-' + d.kind + (warn ? ' tdc-warn' : '');
      } else if (d.chip) {
        d.chip.className = 'trade-drag-chip';
      }
      if (d.chip) d.chip.textContent = label;
    }
    /* chip follows the line */
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
    /* ROUND127 (user request): a bare CLICK (never armed) does NOTHING —
       no order, no toast, no cursor/highlight churn (nothing was frozen:
       the arm never happened). Only a real Click+drag&drop reaches the
       modify path below. */
    if (!d.armed) { this._drag = null; return; }
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
    const dg = s ? s.digits : 5;
    const done = (what) => {
      UI.toast(what + ' — sent', 'ok');
    };
    const fail = (what, err) => {
      UI.toast(what + ' rejected: ' + (err && err.message || ''), '');
      this.sync();
    };

    if (d.kind === 'entry') {
      /* MT5-style: drop position's entry drag -> apply the previewed SL/TP */
      const pos = Trade.positions.find((p) => p.ticket === d.ticket);
      if (!pos || d.target == null) { this.sync(); return; }
      const price = d.price != null ? d.price : d.origPrice;
      const minMove = (s && s.point > 0) ? s.point / 2 : 1e-9;
      if (Math.abs(price - pos.open) < minMove) return; // click, not a move
      const px = Number(price.toFixed(dg));
      const sl = d.target === 'sl' ? px : (pos.sl || 0);
      const tp = d.target === 'tp' ? px : (pos.tp || 0);
      Trade.modifySLTP(pos.ticket, sl, tp)
        .then(() => done(d.target.toUpperCase() + ' set to ' + px.toFixed(dg)))
        .catch((err) => fail(d.target.toUpperCase(), err));
      return;
    }

    const price = d.price != null ? d.price : d.origPrice;
    if (Math.abs(price - d.origPrice) < 1e-12) return; // click, not a move
    const px = Number(price.toFixed(dg));
    if (d.kind === 'sl' || d.kind === 'tp') {
      const pos = Trade.positions.find((p) => p.ticket === d.ticket);
      if (pos) {
        /* ROUND268: a stale drag price (the market moved after the last
           move event) is clamped again before it becomes an order */
        const sl = d.kind === 'sl' ? Number(this._clampStop(pane, pos, 'sl', px).toFixed(dg)) : (pos.sl || 0);
        const tp = d.kind === 'tp' ? Number(this._clampStop(pane, pos, 'tp', px).toFixed(dg)) : (pos.tp || 0);
        const sent = d.kind === 'sl' ? sl : tp;
        Trade.modifySLTP(pos.ticket, sl, tp)
          .then(() => done((d.kind === 'sl' ? 'SL' : 'TP') + ' moved to ' + sent.toFixed(dg)))
          .catch((err) => fail(d.kind.toUpperCase(), err));
      } else {
        /* ROUND98: the dragged line belonged to a PENDING order */
        const o = Trade.orders.find((x) => x.ticket === d.ticket);
        if (!o) { this.sync(); return; }
        const op = this._orderPos(o);
        const sl = d.kind === 'sl' ? Number(this._clampStop(pane, op, 'sl', px, o).toFixed(dg)) : (o.sl || 0);
        const tp = d.kind === 'tp' ? Number(this._clampStop(pane, op, 'tp', px, o).toFixed(dg)) : (o.tp || 0);
        const sent = d.kind === 'sl' ? sl : tp;
        Trade.modifyOrder(o.ticket, o.price, sl, tp)
          .then(() => done((d.kind === 'sl' ? 'SL' : 'TP') + ' moved to ' + sent.toFixed(dg)))
          .catch((err) => fail(d.kind.toUpperCase(), err));
      }
    } else if (d.kind === 'order') {
      const ord = Trade.orders.find((o) => o.ticket === d.ticket);
      if (!ord) { this.sync(); return; }
      Trade.modifyOrder(ord.ticket, px, ord.sl || 0, ord.tp || 0)
        .then(() => done('Order re-priced to ' + px.toFixed(dg)))
        .catch((err) => fail('Order', err));
    }
  },
};

export { TradeOverlay };
