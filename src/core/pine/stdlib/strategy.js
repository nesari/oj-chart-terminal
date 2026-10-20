/**
 * Pine strategy backtester core — order mechanics (round 171, phase 2a).
 *
 * Neted single position (long XOR short), FIFO lots, pyramiding cap.
 * All fills use the NEXT bar after the signal bar (TV historical fills);
 * market fills at next open. Stop/limit levels follow TV's assumed
 * intrabar path (round 191: open→high→low→close, else open→low→high→close;
 * stop-limit needs stop activation first; first touch wins; gap-crossed
 * stops fill at the open). Bracket profit/loss keeps loss-first.
 * profit/loss exits take TICKS (via env.mintick). qty is contracts;
 * default from strategy() default_qty_value (default 1). Opposite entries
 * reverse (close-all at market, open new). OCA cancels siblings on fill.
 * trail_* exits arrive in round 2b (loud, never silent).
 * ROUND185: order() nets signed quantities (TV — no reverse sizing, no
 * pyramiding gate); pyramiding N allows up to N same-direction entries
 * (default 1).
 *
 * Series getters (position_size[1] etc.) need no extra machinery: they read
 * live broker state and the interpreter's general expression-history buffer
 * records them per bar automatically.
 *
 * @module core/pine/stdlib/strategy
 */

import { NA, isNA } from '../types.js';
import { runtimeError } from '../errors.js';

function brokerInit(rt) {
  const s = (rt.meta && rt.meta.strategy) || {};
  /* ROUND175 (strategy Properties tab): dialog-level overrides ride in
     opts.strategyProps and win over the static declaration literals. */
  const p = (rt.opts && rt.opts.strategyProps) || {};
  const mv = (k) => (p[k] !== undefined && p[k] !== null && p[k] !== '' ? p[k] : s[k]);
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const str = (v) => (typeof v === 'string' ? v : null);
  const qtyMode = str(mv('default_qty_type')) || 'fixed';
  const commType = str(mv('commission_type')) || 'percent';
  const cap = num(mv('initial_capital'), 1000000);
  const qv = num(mv('default_qty_value'), 1);
  /* ROUND185 (TV parity): pyramiding N allows up to N successive same-
     direction entries. ROUND225: the default is 0 like TV (single entry,
     no adds) — the gate floors at max(1, N), so 0 and 1 behave alike. */
  const pyr = num(mv('pyramiding'), 0);
  const cv = num(mv('commission_value'), 0);
  rt.broker = {
    cfg: {
      qty: qv > 0 ? qv : 1,
      qtyMode: (qtyMode === 'cash' || qtyMode === 'percent') ? qtyMode : 'fixed',
      qtyValue: qv,
      pyramiding: Math.max(0, Math.floor(pyr) || 0),
      capital: cap > 0 ? cap : 1000000,
      currency: str(mv('currency')) || str(s.currency) || 'USD',
      /* ROUND187 (TV parity): close_entries_rule — FIFO (default) exits
         oldest-first even when the exit names another entry (sized by the
         named lots); ANY exits the named lots first. Unknown -> FIFO. */
      closeRule: (() => {
        const r = mv('close_entries_rule');
        const v = (typeof r === 'string' ? r : str(r) || '').toLowerCase();
        return v === 'any' ? 'any' : 'fifo';
      })(),
      commType: (commType === 'cash_per_contract' || commType === 'cash_per_order') ? commType : 'percent',
      commValue: Math.max(0, cv),
      /* ROUND212 (TV parity): process_orders_on_close — market orders fill
         at the signal bar's close (same-bar due) instead of the next bar's
         open. Dialog Properties overrides the declaration like the rest. */
      closeFill: !!mv('process_orders_on_close'),
      /* ROUND213 (TV parity): margin requirement as % of notional per side
         (default 100). Under-margined entries/orders are dropped silently
         (risk-guard precedent); equity below maintenance triggers a margin
         call (flat at close, counted, no latch). Dialog overrides like rest. */
      marginLong: Math.max(0, num(mv('margin_long'), 100)),
      marginShort: Math.max(0, num(mv('margin_short'), 100)),
    },
    qty: 0,            // signed open contracts
    avg: 0,            // qty-weighted entry price
    entries: [],       // open lots [{id, dir, qty, price, bar}]
    pending: [],       // working orders (see place())
    trades: [],        // closed portions [{entryId, exitId, dir, qty, entryBar, entryPrice, exitBar, exitPrice, profit}]
    /* ROUND223 (TV parity): TV trims closed trades past 9000 (no halt);
       firstDropped counts the trimmed head for closedtrades.first_index. */
    firstDropped: 0,
    closedN: 0,        // lots fully closed
    realized: 0,       // net of commissions
    fees: 0,           // commissions paid
    equity: [],        // per-bar equity (indexed by barIndex, rollback-safe)
    /* ROUND180: signed open contracts per bar — feeds the tester position
       bar (long/short/flat segments, TV bottom strip). One number per bar. */
    qtyTape: [],
    /* ROUND189 (TV parity: strategy.risk.* guards). All JSON-safe so
       snapshot/rollback covers them: cfg-like rules, per-UTC-day buckets,
       finalized day nets (cap 1000), and latches. Days are UTC (house rule;
       TV uses the chart timezone). */
    peak: -Infinity,   // all-time equity peak (max_drawdown anchor)
    risk: {},          // allowDir/maxDD/maxFills/maxILoss/maxPos/maxConsDays
    marginCalls: 0,    // ROUND213: maintenance margin-call count (rollback-safe)
    day: null,         // {key, startEq, peak, fills, blocked} current UTC day
    dayHist: [],       // finalized {key, net} days, oldest-first
    riskTrip: null,    // latched whole-strategy stop (rule name)
  };
}

function brokerClone(st) {
  return JSON.parse(JSON.stringify(st));
}

const dirOf = (v) => {
  if (v && v.__pineEnum) return v.payload === 'short' ? -1 : v.payload === 'long' ? 1 : 0;
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (s === 'short') return -1;
    if (s === 'long') return 1;
  }
  return 0;
};

/* ROUND188 (TV parity): oca_type — strategy.oca.cancel (default: a fill
   cancels the group's working orders) vs strategy.oca.reduce (a fill
   shrinks siblings' explicit quantities). Accepts the enum or a string;
   anything else falls back to cancel (house leniency, like close_rule). */
const ocaOf = (v) => {
  if (v && v.__pineEnum) return v.payload === 'reduce' ? 'reduce' : 'cancel';
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (s === 'reduce') return 'reduce';
    if (s === 'cancel') return 'cancel';
  }
  return null;
};

const numOrNull = (v) => (!isNA(v) && typeof v === 'number' && isFinite(v) ? v : null);

function argsOf(site, positional, names) {
  // named-first (round-159 method/named discipline), positional fallback
  const out = {};
  const named = (site && site.named) || [];
  for (const n of names) {
    const f = named.find((x) => x.name === n.name);
    if (f) out[n.name] = f.value;
    else if (n.idx != null && positional.length > n.idx) out[n.name] = positional[n.idx];
    else out[n.name] = undefined;
  }
  return out;
}

function needStrategy(rt, what) {
  if (!rt.meta || !rt.meta.isStrategy) {
    throw runtimeError(`strategy.${what}() only in strategy scripts — declare strategy() instead of indicator()`);
  }
  if (rt.dry) return false;
  return true;
}

/* place a working order (signal bar N, fillable from N+1) */
function place(rt, o) {
  const b = rt.broker;
  /* ROUND232 (TV parity): same-id pending orders are REPLACED (modify) —
     entry/order (pre-existing) and now exit too: "if unfilled exit orders
     with the same id exist, calls to this command modify those orders".
     Trail peak/refAvg ride the new record (modify resets the trail state).
     Kind groups stay separate (an exit never replaces an entry). */
  const sameWork = (p) => p.id === o.id &&
    ((p.kind === 'exit' && o.kind === 'exit') ||
     ((p.kind === 'entry' || p.kind === 'order') && (o.kind === 'entry' || o.kind === 'order')));
  b.pending = b.pending.filter((p) => !sameWork(p));
  b.pending.push(Object.assign({ signalBar: rt.barIndex }, o));
}

function fns(rt) {
  const S = {
    entry: (site, ...positional) => {
      if (!needStrategy(rt, 'entry')) return undefined;
      /* ROUND189: stopped days/latched trips place no new exposure. */
      if (riskBlocked(rt)) return undefined;
      const a = argsOf(site, positional, [{ name: 'id', idx: 0 }, { name: 'direction', idx: 1 }, { name: 'qty', idx: 2 }, { name: 'limit', idx: 3 }, { name: 'stop', idx: 4 }, { name: 'oca_name' }, { name: 'oca_type' }, { name: 'comment' }, { name: 'alert_message' }]);
      const dir = dirOf(a.direction);
      if (!a.id || !dir) throw runtimeError('strategy.entry: id and direction (strategy.long/short) are required');
      const ot = ocaOf(a.oca_type);
      if (a.oca_type != null && !isNA(a.oca_type) && ot == null) throw runtimeError('strategy.entry: oca_type must be strategy.oca.cancel or strategy.oca.reduce');
      const q = numOrNull(a.qty);
      if (q != null && q <= 0) throw runtimeError('strategy.entry: qty must be positive');
      /* ROUND172: without explicit qty the declaration's qty mode applies
         (fixed contracts | cash value | percent of equity) — resolved at
         fill time when the price is known. */
      const spec = q != null ? { mode: 'fixed', value: q }
        : { mode: rt.broker.cfg.qtyMode, value: rt.broker.cfg.qtyValue };
      /* ROUND213: margin gate at placement (silent drop, risk precedent). */
      if (marginBlocked(rt, dir, spec, barCloseNow(rt))) return undefined;
      place(rt, { kind: 'entry', id: String(a.id), dir, qty: null, qtySpec: spec,
        limit: numOrNull(a.limit), stop: numOrNull(a.stop),
        oca: a.oca_name != null && !isNA(a.oca_name) ? String(a.oca_name) : null,
        ocaType: ot || 'cancel',
        comment: a.comment != null && !isNA(a.comment) ? String(a.comment) : '',
        /* ROUND223 (TV parity): alert_message rides the working order (no
           fill-alert firing infra yet — recorded, not fired; documented). */
        alert: a.alert_message != null && !isNA(a.alert_message) ? String(a.alert_message) : '' });
      return undefined;
    },
    order: (site, ...positional) => {
      /* ROUND185 (TV parity): order() is NOT entry() — it nets signed
         quantities (no auto-reverse sizing, no pyramiding gate). */
      if (!needStrategy(rt, 'order')) return undefined;
      /* ROUND189: stopped days/latched trips place no new exposure. */
      if (riskBlocked(rt)) return undefined;
      const a = argsOf(site, positional, [{ name: 'id', idx: 0 }, { name: 'direction', idx: 1 }, { name: 'qty', idx: 2 }, { name: 'limit', idx: 3 }, { name: 'stop', idx: 4 }, { name: 'oca_name' }, { name: 'oca_type' }, { name: 'comment' }, { name: 'alert_message' }]);
      const dir = dirOf(a.direction);
      if (!a.id || !dir) throw runtimeError('strategy.order: id and direction (strategy.long/short) are required');
      const ot = ocaOf(a.oca_type);
      if (a.oca_type != null && !isNA(a.oca_type) && ot == null) throw runtimeError('strategy.order: oca_type must be strategy.oca.cancel or strategy.oca.reduce');
      const q = numOrNull(a.qty);
      if (q != null && q <= 0) throw runtimeError('strategy.order: qty must be positive');
      const spec = q != null ? { mode: 'fixed', value: q }
        : { mode: rt.broker.cfg.qtyMode, value: rt.broker.cfg.qtyValue };
      /* ROUND213: margin gate at placement (silent drop, risk precedent). */
      if (marginBlocked(rt, dir, spec, barCloseNow(rt))) return undefined;
      place(rt, { kind: 'order', id: String(a.id), dir, qty: null, qtySpec: spec,
        limit: numOrNull(a.limit), stop: numOrNull(a.stop),
        oca: a.oca_name != null && !isNA(a.oca_name) ? String(a.oca_name) : null,
        ocaType: ot || 'cancel',
        comment: a.comment != null && !isNA(a.comment) ? String(a.comment) : '',
        alert: a.alert_message != null && !isNA(a.alert_message) ? String(a.alert_message) : '' }); // ROUND223: recorded, not fired
      return undefined;
    },
    exit: (site, ...positional) => {
      if (!needStrategy(rt, 'exit')) return undefined;
      const a = argsOf(site, positional, [{ name: 'id', idx: 0 }, { name: 'from_entry', idx: 1 }, { name: 'qty', idx: 2 }, { name: 'qty_percent', idx: 3 }, { name: 'profit', idx: 4 }, { name: 'loss', idx: 5 }, { name: 'stop', idx: 6 }, { name: 'limit', idx: 7 }, { name: 'oca_name' }, { name: 'oca_type' }, { name: 'comment' }, { name: 'alert_message' }, { name: 'trail_price' }, { name: 'trail_points' }, { name: 'trail_offset' }]);
      if (!a.id) throw runtimeError('strategy.exit: id is required');
      /* ROUND172 (phase 2b): trailing exits. trail_offset (ticks) required;
         trail_price activates on touch (none = active immediately);
         trail_points = min favorable excursion from the position avg at
         placement before activation (none = no excursion gate). */
      let trail = null;
      if (a.trail_offset != null && !isNA(a.trail_offset)) {
        const off = numOrNull(a.trail_offset);
        if (off == null || off <= 0) throw runtimeError('strategy.exit: trail_offset must be positive');
        trail = { offset: off,
          price: numOrNull(a.trail_price),
          points: numOrNull(a.trail_points),
          refAvg: rt.broker.avg, peak: null, stop: null, active: a.trail_price == null || isNA(a.trail_price) };
      } else if ((a.trail_price != null && !isNA(a.trail_price)) || (a.trail_points != null && !isNA(a.trail_points))) {
        throw runtimeError('strategy.exit: trail_price/trail_points need trail_offset');
      }
      const q = numOrNull(a.qty);
      if (q != null && q <= 0) throw runtimeError('strategy.exit: qty must be positive');
      const otx = ocaOf(a.oca_type);
      if (a.oca_type != null && !isNA(a.oca_type) && otx == null) throw runtimeError('strategy.exit: oca_type must be strategy.oca.cancel or strategy.oca.reduce');
      place(rt, { kind: 'exit', id: String(a.id),
        fromEntry: a.from_entry != null && !isNA(a.from_entry) ? String(a.from_entry) : null,
        qty: q, qtyPct: numOrNull(a.qty_percent),
        profit: numOrNull(a.profit), loss: numOrNull(a.loss),
        stop: numOrNull(a.stop), limit: numOrNull(a.limit),
        oca: a.oca_name != null && !isNA(a.oca_name) ? String(a.oca_name) : null,
        ocaType: otx || 'cancel',
        comment: a.comment != null && !isNA(a.comment) ? String(a.comment) : '',
        alert: a.alert_message != null && !isNA(a.alert_message) ? String(a.alert_message) : '', // ROUND223: recorded, not fired
        trail });
      return undefined;
    },
    close: (site, ...positional) => {
      if (!needStrategy(rt, 'close')) return undefined;
      const a = argsOf(site, positional, [{ name: 'id', idx: 0 }, { name: 'qty', idx: 1 }, { name: 'qty_percent', idx: 2 }, { name: 'comment' }]);
      place(rt, { kind: 'close', id: a.id != null && !isNA(a.id) ? String(a.id) : '',
        qty: numOrNull(a.qty), qtyPct: numOrNull(a.qty_percent),
        comment: a.comment != null && !isNA(a.comment) ? String(a.comment) : '' });
      return undefined;
    },
    close_all: (site) => {
      if (!needStrategy(rt, 'close_all')) return undefined;
      place(rt, { kind: 'close', id: '', qty: null, qtyPct: null, comment: '' });
      return undefined;
    },
    cancel: (site, ...positional) => {
      if (!needStrategy(rt, 'cancel')) return undefined;
      const a = argsOf(site, positional, [{ name: 'id', idx: 0 }]);
      if (a.id == null || isNA(a.id)) throw runtimeError('strategy.cancel: id is required');
      const id = String(a.id);
      rt.broker.pending = rt.broker.pending.filter((p) => p.id !== id);
      return undefined;
    },
    cancel_all: (site) => {
      if (!needStrategy(rt, 'cancel_all')) return undefined;
      rt.broker.pending = [];
      return undefined;
    },
    /* ROUND230 (TV parity): account/symbol conversion is the identity while
       both sides quote the same currency (this offline feed quotes USD, and
       the declaration default is USD). Anything else needs a daily FX feed —
       loud, never a silent 1:1. na passes through. */
    convert_to_account: (site, ...positional) => {
      if (!needStrategy(rt, 'convert_to_account')) return undefined;
      const a = argsOf(site, positional, [{ name: 'value', idx: 0 }]);
      if (a.value == null || isNA(a.value)) return NA;
      const acct = String((rt.broker && rt.broker.cfg && rt.broker.cfg.currency) || 'USD').toUpperCase();
      if (acct === 'USD') return a.value;
      throw runtimeError(`strategy.convert_to_account(): USD->${acct} conversion needs a daily FX feed this offline engine does not have`);
    },
    convert_to_symbol: (site, ...positional) => {
      if (!needStrategy(rt, 'convert_to_symbol')) return undefined;
      const a = argsOf(site, positional, [{ name: 'value', idx: 0 }]);
      if (a.value == null || isNA(a.value)) return NA;
      const acct = String((rt.broker && rt.broker.cfg && rt.broker.cfg.currency) || 'USD').toUpperCase();
      if (acct === 'USD') return a.value;
      throw runtimeError(`strategy.convert_to_symbol(): ${acct}->USD conversion needs a daily FX feed this offline engine does not have`);
    },
    /* ROUND189 (TV parity): strategy.risk.* guards. All configure-and-return
       (last call wins); enforcement lives in placement (riskBlocked), fills
       (allowDir/maxPos) and pushBrokerBar (trips). Days are UTC. */
    risk: {
      allow_entry_in: (site, ...positional) => {
        if (!needStrategy(rt, 'risk.allow_entry_in')) return undefined;
        const a = argsOf(site, positional, [{ name: 'value', idx: 0 }]);
        const d = dirAllOf(a.value);
        if (d == null) throw runtimeError('strategy.risk.allow_entry_in: value must be strategy.direction.long, strategy.direction.short or strategy.direction.all');
        rt.broker.risk.allowDir = d === 'all' ? 0 : d;
        return undefined;
      },
      max_drawdown: (site, ...positional) => {
        if (!needStrategy(rt, 'risk.max_drawdown')) return undefined;
        const a = argsOf(site, positional, [{ name: 'value', idx: 0 }, { name: 'type', idx: 1 }]);
        const v = numOrNull(a.value);
        if (v == null || v <= 0) throw runtimeError('strategy.risk.max_drawdown: value must be positive');
        rt.broker.risk.maxDD = { v, mode: cashPctOf(a.type) };
        return undefined;
      },
      max_intraday_filled_orders: (site, ...positional) => {
        if (!needStrategy(rt, 'risk.max_intraday_filled_orders')) return undefined;
        const a = argsOf(site, positional, [{ name: 'value', idx: 0 }]);
        const v = numOrNull(a.value);
        if (v == null || Math.floor(v) <= 0) throw runtimeError('strategy.risk.max_intraday_filled_orders: value must be a positive int');
        rt.broker.risk.maxFills = Math.floor(v);
        return undefined;
      },
      max_intraday_loss: (site, ...positional) => {
        if (!needStrategy(rt, 'risk.max_intraday_loss')) return undefined;
        const a = argsOf(site, positional, [{ name: 'value', idx: 0 }, { name: 'type', idx: 1 }]);
        const v = numOrNull(a.value);
        if (v == null || v <= 0) throw runtimeError('strategy.risk.max_intraday_loss: value must be positive');
        rt.broker.risk.maxILoss = { v, mode: cashPctOf(a.type) };
        return undefined;
      },
      max_position_size: (site, ...positional) => {
        if (!needStrategy(rt, 'risk.max_position_size')) return undefined;
        const a = argsOf(site, positional, [{ name: 'value', idx: 0 }]);
        const v = numOrNull(a.value);
        if (v == null || v <= 0) throw runtimeError('strategy.risk.max_position_size: value must be positive');
        rt.broker.risk.maxPos = v;
        return undefined;
      },
      max_cons_loss_days: (site, ...positional) => {
        if (!needStrategy(rt, 'risk.max_cons_loss_days')) return undefined;
        const a = argsOf(site, positional, [{ name: 'value', idx: 0 }]);
        const v = numOrNull(a.value);
        if (v == null || Math.floor(v) <= 0) throw runtimeError('strategy.risk.max_cons_loss_days: value must be a positive int');
        rt.broker.risk.maxConsDays = Math.floor(v);
        return undefined;
      },
    },
  };
  return S;
}

/* direction incl. strategy.direction.all (allow_entry_in); leniently also
   accepts strategy.long/short and plain strings. 0 = all/any. */
function dirAllOf(v) {
  if (v && v.__pineEnum) {
    if (v.payload === 'long') return 1;
    if (v.payload === 'short') return -1;
    if (v.payload === 'all') return 'all';
    return null;
  }
  if (typeof v === 'string') {
    const s = v.toLowerCase();
    if (s === 'long') return 1;
    if (s === 'short') return -1;
    if (s === 'all') return 'all';
  }
  return null;
}

/* cash vs percent_of_equity bucket (risk value types reuse the qty-type
   consts: strategy.cash / strategy.percent_of_equity). Default cash. */
function cashPctOf(v) {
  if (v && v.__pineEnum) return v.payload === 'percent' ? 'percent' : 'cash';
  if (typeof v === 'string' && v.toLowerCase() === 'percent_of_equity') return 'percent';
  return 'cash';
}

/* ---------- fills (next-bar-open model, before the bar body) ---------- */

const fin = (v) => typeof v === 'number' && isFinite(v);

function brokerFills(rt) {
  const b = rt.broker;
  if (!b || rt.dry) return;
  const i = rt.barIndex;
  const bar = rt.bars[i];
  if (!bar || !fin(bar.open) || !fin(bar.high) || !fin(bar.low)) return;
  /* ROUND189: rollover FIRST — placement gates in the bar body must read
     the current UTC day, even on bars with no due orders. */
  dayRollover(rt, bar);
  if (!b.pending.length) return;
  /* ROUND212: with process_orders_on_close the signal bar itself is due
     (fills price at its close — see resolveFill); otherwise next-bar-open
     model (signalBar strictly before). */
  const closeFill = !!(b.cfg && b.cfg.closeFill);
  const due = b.pending.filter((p) => closeFill ? p.signalBar <= i : p.signalBar < i);
  if (!due.length) return;
  b.pending = b.pending.filter((p) => closeFill ? p.signalBar > i : p.signalBar >= i);
  for (let di = 0; di < due.length; di++) {
    const o = due[di];
    if (o.ocaDead) continue; // ROUND188: cancelled by an earlier same-bar OCA fill
    /* ROUND189: stopped days drop new exposure silently (exits/closes to
       flat always pass — a stopped strategy must still flatten). */
    if ((o.kind === 'entry' || o.kind === 'order') && riskBlocked(rt)) continue;
    /* ROUND213: working entries/orders re-check margin at fill time (the
       price moved since placement) — dropped like at placement. */
    if ((o.kind === 'entry' || o.kind === 'order') && marginBlocked(rt, o.dir, o, barCloseNow(rt))) continue;
    /* ROUND191: gap-aware fills need the previous close (no intrabars in
       the prev-close→open gap — a stop crossed there fills at the open). */
    const prev = rt.bars[i - 1];
    const prevClose = prev && typeof prev.close === 'number' && isFinite(prev.close) ? prev.close : null;
    let px = resolveFill(rt, bar, o, prevClose, i);
    if (px == null) { b.pending.push(o); continue; } // still working
    /* ROUND172: slippage (env.slippageTicks, default 0) shifts the fill
       against the trader. Exits sell (long) / buy (short). */
    const slip = (rt.env && rt.env.slippageTicks) || 0;
    if (slip > 0) {
      const d = (o.kind === 'entry' || o.kind === 'order') ? o.dir : (b.qty > 0 ? -1 : b.qty < 0 ? 1 : 0);
      const mt = (rt.env && rt.env.mintick) || 0.00001;
      px += d * slip * mt;
    }
    applyFill(rt, o, px, i, due, di);
  }
}

/* fill price at bar `bar` (null = no touch, keep working). Market fills at
   the open; limit/stop fill on touch at touch-or-better; same-bar stop+limit
   fills the stop first; exit brackets (profit/loss, in ticks) check loss
   before profit (conservative). All documented house rules. */
/* ROUND191 (TV parity: broker-emulator intrabar assumptions) — touch order
   along the ASSUMED path, not bar extremes. TV: open closer to the high
   than the low -> open→high→low→close, else open→low→high→close (ties take
   the second path). Consequences: (a) stop-limit activates only after the
   stop is touched, and fills only if the limit is touched AFTER activation
   (a stop touch alone no longer fills); (b) when both stop and limit are
   touched, the FIRST touch along the path wins (replaces stop-first-always
   for entries/orders/plain exit levels). Marketable levels (long limit >=
   open, long stop <= open, mirrored short) still fill at the open, as does
   a stop crossed inside the prev-close→open gap (TV: no intrabars in gaps).
   Bracket profit/loss keeps the documented loss-first rule (round 172). */
function crossed(a, b, level) {
  if (!isFinite(a) || !isFinite(b) || !isFinite(level) || a === b) return false;
  return (a - level) * (b - level) <= 0;
}

function assumePath(op, hi, lo, cl) {
  const highFirst = (hi - op) < (op - lo);
  return highFirst ? [op, hi, lo, cl] : [op, lo, hi, cl];
}

/* Fill price for stop/limit levels (null = no touch, keep working).
   stopOnly/limitOnly select the order shape; both set = stop-limit. */
function touchFill(dir, op, hi, lo, cl, prevClose, stop, limit) {
  const gapStop = stop != null && prevClose != null && isFinite(prevClose) &&
    ((prevClose - stop) * (op - stop) < 0);
  if (gapStop) return op; // crossed inside the gap: fill at the open
  if (dir > 0) {
    if (limit != null && limit >= op) return op; // marketable long limit
    if (stop != null && stop <= op && limit == null) return op; // active long stop
  } else {
    if (limit != null && limit <= op) return op; // marketable short limit
    if (stop != null && stop >= op && limit == null) return op; // active short stop
  }
  const path = assumePath(op, hi, lo, cl);
  /* A stop already touched at the open is active from the start (the
     limit leg still needs its own touch after this point). */
  let active = stop == null || ((dir > 0 && stop <= op) || (dir < 0 && stop >= op));
  for (let k = 0; k + 1 < path.length; k++) {
    const a = path[k], b = path[k + 1];
    if (!active && stop != null && crossed(a, b, stop)) {
      active = true;
      if (limit == null) return stop; // stop order triggers to market at touch
      /* stop-limit: the rest of THIS segment (stop -> b) can already touch
         the limit — same continuous move, TV fills. Later segments check
         normally below. */
      if (crossed(stop, b, limit)) return limit;
      continue;
    }
    if (active && limit != null && crossed(a, b, limit)) {
      /* limit-only keeps the legacy touch-or-better rule (pinned); a
         stop-limit activated earlier fills at the limit touch itself. */
      if (stop == null) return dir > 0 ? Math.min(limit, op) : Math.max(limit, op);
      return limit;
    }
  }
  return null;
}

/* ROUND192 (TV parity: Bar Magnifier) — when the strategy declares
   use_bar_magnifier and the renderer supplied M1 intrabars for this bar,
   stop/limit touches (and bracket excursions) evaluate against REAL
   sub-bar ranges in time order instead of the assumed OHLC path. No
   coverage for a bar -> the assumed path (round 191) applies. TV caps
   lower-TF history; uncovered initial bars behave exactly like that.
   Returns the M1 sub-array or null. */
function magnifierSubs(rt, barIdx) {
  try {
    const p = rt.opts && rt.opts.strategyProps;
    const flag = (p && p.use_bar_magnifier != null) ? !!p.use_bar_magnifier
      : !!((rt.meta && rt.meta.strategy && rt.meta.strategy.use_bar_magnifier) || false);
    if (!flag) return null;
    const ib = rt.env && rt.env.intrabars;
    const subs = ib && ib[barIdx];
    if (!Array.isArray(subs) || !subs.length) return null;
    return subs;
  } catch (e) { return null; }
}

const inRng = (level, lo, hi) => isFinite(level) && isFinite(lo) && isFinite(hi) && level >= lo && level <= hi;

/* ROUND225 (TV parity, v6): strategy.exit() evaluates relative+absolute
   PAIRS and takes the level the market triggers FIRST (v5 always let the
   absolute level win and ignored the relative one). Levels ride one walk
   over the assumed OHLC path (or one magnifier sub-bar): take-profit (profit
   ticks / limit price), stop-loss (loss ticks / stop price). A stop-limit
   absolute pair keeps its activation (limit counts after the stop touch);
   same-point ties break loss-first (the old conservative rule). Returns the
   fill price or null (untouched).
   lv is a plain {dir,hasStop,hasLimit,actInit} control record; levels ride
   the separate `levels` array. */
function exitTouchOrder(segs, levels, lv, op) {
  // levels: [{key:'tp'|'sl'|'lim'|'stop', price}], op = bar open (limit-only better-price rule)
  const prio = { sl: 0, stop: 1, tp: 2, lim: 3 };
  const touches = [];
  for (let si = 0; si + 1 < segs.length; si++) {
    const a = segs[si], b = segs[si + 1];
    if (!isFinite(a) || !isFinite(b) || a === b) continue;
    for (const L of levels) {
      if (!isFinite(L.price)) continue;
      if (!crossed(a, b, L.price)) continue;
      touches.push({ si, t: (L.price - a) / (b - a), L });
    }
  }
  if (!touches.length) return null;
  /* stop-limit activation: the limit leg counts from the stop's touch point
     on (pre-activated by a marketable/gap stop at the open). */
  let stopAt = lv.actInit ? { si: -1, t: -1 } : null;
  for (const tc of touches) {
    if (tc.L.key === 'stop' && (!stopAt || tc.si < stopAt.si || (tc.si === stopAt.si && tc.t < stopAt.t))) {
      stopAt = { si: tc.si, t: tc.t };
    }
  }
  let best = null;
  for (const tc of touches) {
    if (tc.L.key === 'lim' && lv.hasStop) {
      if (!stopAt) continue;
      if (tc.si < stopAt.si || (tc.si === stopAt.si && tc.t < stopAt.t - 1e-9)) continue;
    }
    if (!best || tc.si < best.si || (tc.si === best.si && (tc.t < best.t - 1e-9 ||
      (Math.abs(tc.t - best.t) <= 1e-9 && prio[tc.L.key] < prio[best.L.key])))) {
      best = tc;
    }
  }
  if (!best) return null;
  const W = best.L, dir = lv.dir;
  /* stop-only triggers to market at touch; limit-only keeps touch-or-better
     (the legacy touchFill price rules); pairs fill at the level. */
  if (W.key === 'stop' && !lv.hasLimit) return W.price;
  /* ROUND235 (TV parity): limit-only fills at touch-or-better on the CLOSING
     side — a long exit sells (better = higher: max), a short exit buys. */
  if (W.key === 'lim' && !lv.hasStop) return dir > 0 ? Math.max(W.price, op) : Math.min(W.price, op);
  return W.price;
}

/* Entry/order/close + plain exit levels against M1 sub-bars (time order).
   Same contract as touchFill: marketable/gap resolved by the caller first
   (chart-level open/prev-close); here only range touches in time order.
   stop-limit needs activation before the limit counts (same sub-bar counts,
   mirroring the assumed-path leniency). Brackets keep loss-first per bar. */
function magnifyLevels(dir, subs, stop, limit, activeInit) {
  let active = stop == null || !!activeInit;
  for (const s of subs) {
    if (!s || !isFinite(s.high) || !isFinite(s.low)) continue;
    if (!active && stop != null && inRng(stop, s.low, s.high)) {
      active = true;
      if (limit == null) return stop;
    }
    if (active && limit != null && inRng(limit, s.low, s.high)) {
      if (stop == null) return limit; // limit-only on real ranges fills at touch
      return limit;
    }
  }
  return null;
}

function resolveFill(rt, bar, o, prevClose, barIdx) {
  const mt = (rt.env && rt.env.mintick) || 0.00001;
  const dir = (o.kind === 'entry' || o.kind === 'order') ? o.dir : (rt.broker.qty > 0 ? 1 : rt.broker.qty < 0 ? -1 : 0);
  if (!dir) return null;
  const op = bar.open, hi = bar.high, lo = bar.low, cl = bar.close;
  /* ROUND192: Magnifier sub-bars for this bar (null without coverage). */
  const subs = magnifierSubs(rt, barIdx);
  if (o.kind === 'entry' || o.kind === 'order' || o.kind === 'close') {
    /* ROUND212: no-level market orders fill at the close under
       process_orders_on_close, at the open otherwise. Level immediates
       (marketable/gap, below) stay at the open — the price was there. */
    if (o.limit == null && o.stop == null) return (rt.broker.cfg && rt.broker.cfg.closeFill) ? cl : op;
    if (subs) {
      /* chart-level immediates first (marketable levels + gap-crossed
         stops — same rules as touchFill's pre-checks, then real ranges). */
      const st = o.stop, lm = o.limit;
      if (st != null && prevClose != null && isFinite(prevClose) && ((prevClose - st) * (op - st) < 0)) return op;
      if (dir > 0) {
        if (lm != null && lm >= op) return op;
        if (st != null && st <= op && lm == null) return op;
      } else {
        if (lm != null && lm <= op) return op;
        if (st != null && st >= op && lm == null) return op;
      }
      /* A stop already touched at the open activates immediately (the
         limit leg still needs its own touch on the sub-bars). */
      const actInit = st != null && ((dir > 0 && st <= op) || (dir < 0 && st >= op));
      return magnifyLevels(dir, subs, st, lm, actInit);
    }
    /* ROUND191: assumed-path touch order (stop-limit needs activation). */
    return touchFill(dir, op, hi, lo, cl, prevClose, o.stop, o.limit);
  }
  // exit: brackets against position avg, then plain stop/limit levels
  const b = rt.broker;
  /* ROUND172 trailing exit: stateful per order (peak/trailStop ride the
     pending record — snapshot-covered like everything else). */
  if (o.trail) {
    const t = trailFill(rt, bar, o, dir);
    if (t != null) return t;
    if (o.stop == null && o.limit == null && o.profit == null && o.loss == null) return null;
  }
  /* ROUND225 (TV parity): v5 lets an absolute level SHADOW its relative
     pair (limit>profit, stop>loss — the relative side is ignored); v6
     evaluates both and takes the first trigger (exitTouchOrder). */
  const v6exit = (rt.version || 5) >= 6;
  let profit = o.profit, loss = o.loss;
  if (!v6exit) {
    if (o.limit != null) profit = null;
    if (o.stop != null) loss = null;
  }
  if (b.qty !== 0 && (profit != null || loss != null || o.stop != null || o.limit != null)) {
    const s = b.qty > 0 ? 1 : -1;
    if (v6exit) {
      const mt6 = (rt.env && rt.env.mintick) || 0.00001;
      const lv = { dir: s, hasStop: o.stop != null, hasLimit: o.limit != null, actInit: false };
      const levels = [];
      if (profit != null) levels.push({ key: 'tp', price: b.avg + s * profit * mt6 });
      if (loss != null) levels.push({ key: 'sl', price: b.avg - s * loss * mt6 });
      if (o.limit != null) levels.push({ key: 'lim', price: o.limit });
      if (o.stop != null) levels.push({ key: 'stop', price: o.stop });
      /* marketable/gap immediates first (same rules as the legacy path).
         ROUND235 (TV parity, reference §strategy.exit: TP fills "or better
         (higher for long, lower for short)", SL "or worse"): the CLOSING
         side is mirrored — a long exit sells (marketable limit at/below the
         open, marketable stop at/above it), a short exit buys. Stop legs
         were already on the right side; limit legs were entry-sided. */
      const st = o.stop, lm = o.limit;
      if (st != null && prevClose != null && isFinite(prevClose) && ((prevClose - st) * (op - st) < 0)) return op;
      if (s > 0) {
        if (lm != null && lm <= op) return op;
        if (st != null && st >= op && lm == null) return op;
        if (st != null && st >= op) lv.actInit = true;
      } else {
        if (lm != null && lm >= op) return op;
        if (st != null && st <= op && lm == null) return op;
        if (st != null && st <= op) lv.actInit = true;
      }
      /* ROUND192 magnifier: sub-bars in time order, each walked on its own
         assumed path (first trigger wins across the bar). */
      if (subs) {
        for (const sb of subs) {
          if (!sb || !isFinite(sb.high) || !isFinite(sb.low)) continue;
          const so = isFinite(sb.open) ? sb.open : (s > 0 ? sb.low : sb.high);
          const sc = isFinite(sb.close) ? sb.close : (s > 0 ? sb.high : sb.low);
          const hit = exitTouchOrder(assumePath(so, sb.high, sb.low, sc), levels, lv, op);
          if (hit != null) return hit;
        }
        return null;
      }
      const hit = exitTouchOrder(assumePath(op, hi, lo, cl), levels, lv, op);
      if (hit != null) return hit;
      return null;
    }
    /* ROUND192: with Magnifier coverage the brackets ride sub-bar extremes
       in time order (loss still checked before profit inside each bar). */
    if (subs) {
      for (const sb of subs) {
        if (!sb || !isFinite(sb.high) || !isFinite(sb.low)) continue;
        if (loss != null) {
          const sl = b.avg - s * loss * mt;
          if ((s > 0 && sb.low <= sl) || (s < 0 && sb.high >= sl)) return sl;
        }
        if (profit != null) {
          const tp = b.avg + s * profit * mt;
          if ((s > 0 && sb.high >= tp) || (s < 0 && sb.low <= tp)) return tp;
        }
      }
    } else {
      if (loss != null) {
        const sl = b.avg - s * loss * mt;
        if ((s > 0 && lo <= sl) || (s < 0 && hi >= sl)) return sl;
      }
      if (profit != null) {
        const tp = b.avg + s * profit * mt;
        if ((s > 0 && hi >= tp) || (s < 0 && lo <= tp)) return tp;
      }
    }
    if (o.stop == null && o.limit == null) return null;
  }
  if (subs) {
    /* ROUND235 (TV parity): plain exit levels ride the CLOSING side (xd):
       same mirror as the v6 immediates above (was entry-sided). */
    const xd = -dir;
    const st = o.stop, lm = o.limit;
    if (st != null && prevClose != null && isFinite(prevClose) && ((prevClose - st) * (op - st) < 0)) return op;
    if (xd > 0) {
      if (lm != null && lm >= op) return op;
      if (st != null && st <= op && lm == null) return op;
    } else {
      if (lm != null && lm <= op) return op;
      if (st != null && st >= op && lm == null) return op;
    }
    const actInit = st != null && ((xd > 0 && st <= op) || (xd < 0 && st >= op));
    return magnifyLevels(xd, subs, st, lm, actInit);
  }
  /* ROUND191: plain stop/limit levels ride the same assumed path — on the
     closing side for exits (ROUND235 mirror). */
  return touchFill(-dir, op, hi, lo, cl, prevClose, o.stop, o.limit);
}

function trailFill(rt, bar, o, dir) {
  const mt = (rt.env && rt.env.mintick) || 0.00001;
  const t = o.trail;
  const hi = bar.high, lo = bar.low;
  // track the favorable extreme
  if (dir > 0) t.peak = t.peak == null ? hi : Math.max(t.peak, hi);
  else t.peak = t.peak == null ? lo : Math.min(t.peak, lo);
  // activation: touch of trail_price, or excursion gate, or immediate
  if (!t.active) {
    if (t.price != null) {
      if ((dir > 0 && hi >= t.price) || (dir < 0 && lo <= t.price)) t.active = true;
      else return null;
    } else if (t.points != null) {
      const ref = (t.refAvg != null && isFinite(t.refAvg)) ? t.refAvg : (dir > 0 ? lo : hi);
      const exc = dir > 0 ? t.peak - ref : ref - t.peak;
      if (!(exc >= t.points * mt)) return null;
      t.active = true;
    } else t.active = true;
  }
  const stop = dir > 0 ? t.peak - t.offset * mt : t.peak + t.offset * mt;
  t.stop = stop;
  if ((dir > 0 && lo <= stop) || (dir < 0 && hi >= stop)) return stop;
  return null;
}

/* ROUND172: qty resolution at fill time. Explicit qty = contracts.
   Declaration modes: fixed contracts | cash value | percent of equity
   (pre-trade equity at the fill bar). Fractional shares allowed. */
function resolveQty(rt, o, price) {
  const b = rt.broker;
  const spec = o.qtySpec;
  if (!spec || spec.mode === 'fixed') {
    const v = spec ? spec.value : b.cfg.qty;
    return v > 0 ? v : 0;
  }
  if (!(price > 0)) return 0;
  if (spec.mode === 'cash') {
    return spec.value > 0 ? spec.value / price : 0;
  }
  // percent of pre-trade equity
  const eq = brokerEquityNow(rt);
  return spec.value > 0 && eq > 0 ? (eq * spec.value / 100) / price : 0;
}

function brokerEquityNow(rt) {
  const b = rt.broker;
  const bar = rt.bars[rt.barIndex];
  const cl = bar && typeof bar.close === 'number' && isFinite(bar.close) ? bar.close : NaN;
  const open = b.qty !== 0 && isFinite(cl) ? (cl - b.avg) * b.qty : 0;
  return b.cfg.capital + b.realized + open;
}
/* Current-bar close or NaN (placement/fill price estimates). */
function barCloseNow(rt) {
  const bar = rt.bars && rt.bars[rt.barIndex];
  const cl = bar && typeof bar.close === 'number' && isFinite(bar.close) ? bar.close : NaN;
  return cl;
}

/* ROUND172: commission per fill (both sides). percent = % of fill value;
   cash_per_contract = value x qty; cash_per_order = value once. */
function chargeFill(rt, price, qty) {
  const b = rt.broker;
  const v = b.cfg.commValue;
  if (!(v > 0) || !(qty > 0) || !(price > 0)) return;
  let fee = 0;
  if (b.cfg.commType === 'cash_per_contract') fee = v * qty;
  else if (b.cfg.commType === 'cash_per_order') fee = v;
  else fee = (v / 100) * price * qty;
  b.realized -= fee;
  b.fees += fee;
}

/* ROUND186 (script-side account getters, TV parity): net/gross/wins/
   losses/evens/max-drawdown, memoized per bar (scripts often read several
   getters per bar; the tape scans would otherwise go quadratic). */
function brokerAccount(rt) {
  const b = rt.broker;
  const memo = rt._acctMemo;
  if (memo && memo.bar === rt.barIndex && memo.n === (b.trades || []).length) return memo.out;
  const st = brokerStats(b);
  let losses = 0, evens = 0;
  for (const t of (b.trades || [])) {
    if (t.profit < 0) losses++;
    else if (!(t.profit > 0)) evens++;
  }
  const out = {
    netprofit: st.netProfit, grossprofit: st.grossProfit, grossloss: st.grossLoss,
    wintrades: st.wins, losstrades: losses, eventrades: evens,
    max_drawdown: st.maxDD,
    /* ROUND229 (TV parity, verified against the v6 reference): per-trade
       averages over closed portions (percent base = entry notional, na-safe)
       + account run-up + capital percents + max held contracts. */
    avg_trade: 0, avg_trade_percent: 0,
    avg_winning_trade: 0, avg_winning_trade_percent: 0,
    avg_losing_trade: 0, avg_losing_trade_percent: 0,
    max_runup: 0, max_runup_percent: 0,
    grossprofit_percent: 0, grossloss_percent: 0, netprofit_percent: 0,
    max_contracts_held_all: 0, max_contracts_held_long: 0, max_contracts_held_short: 0,
  };
  {
    const tr = b.trades || [];
    const cap = (typeof b.cfg.capital === 'number' && b.cfg.capital !== 0) ? b.cfg.capital : NaN;
    /* engine na (not NaN — na() must see these) for empty/undefined sets. */
    const fin = (v) => (typeof v === 'number' && isFinite(v) ? v : NA);
    const pct = (p, notion) => ((typeof p === 'number' && isFinite(p) && notion > 0) ? p / notion * 100 : NaN);
    const notional = (t) => ((typeof t.entryPrice === 'number' && typeof t.qty === 'number') ? Math.abs(t.entryPrice * t.qty) : NaN);
    let wSum = 0, wPct = 0, wN = 0, lSum = 0, lPct = 0, lN = 0, aSum = 0, aPct = 0;
    let trough = Infinity, maxRU = 0, maxRUPct = 0;
    let mcAll = 0, mcLong = 0, mcShort = 0;
    for (const t of tr) {
      const p = (typeof t.profit === 'number' && isFinite(t.profit)) ? t.profit : NaN;
      const pp = pct(p, notional(t));
      if (isFinite(p)) { aSum += p; if (isFinite(pp)) aPct += pp; }
      if (p > 0) { wSum += p; if (isFinite(pp)) wPct += pp; wN++; }
      else if (p < 0) { lSum += p; if (isFinite(pp)) lPct += pp; lN++; }
      const q = (typeof t.qty === 'number' && isFinite(t.qty)) ? Math.abs(t.qty) : 0;
      if (q > mcAll) mcAll = q;
      if ((t.dir || 0) > 0 && q > mcLong) mcLong = q;
      if ((t.dir || 0) < 0 && q > mcShort) mcShort = q;
    }
    const n = tr.length;
    const div = (s, k) => (k > 0 ? s / k : NaN);
    out.avg_trade = n > 0 ? fin(aSum / n) : NA;
    out.avg_trade_percent = n > 0 ? fin(aPct / n) : NA;
    out.avg_winning_trade = fin(div(wSum, wN));
    out.avg_winning_trade_percent = fin(div(wPct, wN));
    out.avg_losing_trade = fin(div(lSum, lN));
    out.avg_losing_trade_percent = fin(div(lPct, lN));
    for (const v of (b.equity || [])) {
      if (typeof v !== 'number' || !isFinite(v)) continue;
      if (v < trough) trough = v;
      if (v - trough > maxRU) maxRU = v - trough;
      if (trough > 0 && (v - trough) / trough * 100 > maxRUPct) maxRUPct = (v - trough) / trough * 100;
    }
    /* run-up anchors at the first equity print (mirror of the maxDD loop). */
    out.max_runup = fin(maxRU);
    out.max_runup_percent = fin(maxRUPct);
    if (isFinite(cap)) {
      out.grossprofit_percent = st.grossProfit / cap * 100;
      out.grossloss_percent = st.grossLoss / cap * 100;
      out.netprofit_percent = st.netProfit / cap * 100;
    } else {
      out.grossprofit_percent = NA; out.grossloss_percent = NA; out.netprofit_percent = NA;
    }
    /* max held contracts: closed portions + live lots (TV counts the whole
       range; qtyTape already tracks open size per bar — see pine-ui). */
    for (const e of (b.entries || [])) {
      const q = (typeof e.qty === 'number' && isFinite(e.qty)) ? Math.abs(e.qty) : 0;
      if (q > mcAll) mcAll = q;
      if ((e.dir || 0) > 0 && q > mcLong) mcLong = q;
      if ((e.dir || 0) < 0 && q > mcShort) mcShort = q;
    }
    out.max_contracts_held_all = mcAll;
    out.max_contracts_held_long = mcLong;
    out.max_contracts_held_short = mcShort;
  }
  rt._acctMemo = { bar: rt.barIndex, n: (b.trades || []).length, out };
  return out;
}

/* ROUND186 (TV parity): per-trade fields — strategy.opentrades.*(num) over
   FIFO open lots, strategy.closedtrades.*(num) over closed trades (both
   oldest-first, TV numbering). Out-of-range num -> na (house rule).
   Times are epoch ms, like the `time` builtin. */
function strategyTradeField(rt, sub, field, num) {
  const b = rt.broker;
  if (!b || !rt.meta || !rt.meta.isStrategy) {
    throw runtimeError('strategy.' + (sub === 'open' ? 'opentrades' : 'closedtrades') + '.' + field +
      '() only in strategy scripts — declare strategy() instead of indicator()');
  }
  if (rt.dry) return NA;
  const i = (typeof num === 'number' && isFinite(num)) ? Math.floor(num) : -1;
  const barMs = (bi) => {
    const bar = rt.bars && rt.bars[bi];
    return (bar && bar.time != null && isFinite(bar.time)) ? bar.time * 1000 : NA;
  };
  if (sub === 'open') {
    const e = (i >= 0 && b.entries[i]) || null;
    if (!e) return NA;
    switch (field) {
      case 'entry_price': return e.price;
      case 'entry_bar_index': return e.bar;
      case 'entry_time': return barMs(e.bar);
      case 'entry_id': return e.id;
      case 'size': return e.qty;
      case 'profit': {
        const bar = rt.bars[rt.barIndex];
        const cl = bar && typeof bar.close === 'number' && isFinite(bar.close) ? bar.close : NaN;
        if (!isFinite(cl)) return NA;
        return (cl - e.price) * e.dir * e.qty;
      }
      /* ROUND223 (TV parity): absolute excursions on open lots (the percents
         already existed since R189). */
      case 'max_runup': return (typeof e.mfe === 'number' && isFinite(e.mfe)) ? e.mfe : 0;
      case 'max_drawdown': return (typeof e.mae === 'number' && isFinite(e.mae)) ? e.mae : 0;
      /* ROUND189 (TV parity): live excursion percents over entry notional. */
      case 'max_runup_percent':
      case 'max_drawdown_percent': {
        const notion = (typeof e.price === 'number' && typeof e.qty === 'number') ? Math.abs(e.price * e.qty) : NaN;
        if (!(notion > 0)) return NA;
        const v = field === 'max_runup_percent' ? (e.mfe || 0) : (e.mae || 0);
        return (typeof v === 'number' && isFinite(v)) ? v / notion * 100 : 0;
      }
      default: throw runtimeError(`Unknown strategy.opentrades field '${field}'`);
    }
  }
  const t = (i >= 0 && b.trades[i]) || null;
  /* ROUND223 (TV parity): first_index is the trimmed-head count, not a
     trade slot — answer before the slot lookup (takes no index). */
  if (field === 'first_index') return b.firstDropped || 0;
  if (!t) return NA;
  switch (field) {
    case 'entry_price': return t.entryPrice;
    case 'exit_price': return t.exitPrice;
    case 'entry_bar_index': return t.entryBar;
    case 'exit_bar_index': return t.exitBar;
    case 'entry_time': return barMs(t.entryBar);
    case 'exit_time': return barMs(t.exitBar);
    case 'entry_id': return t.entryId;
    case 'exit_id': return t.exitId;
    case 'size': return t.qty;
    case 'profit': return t.profit;
    case 'max_runup': return (typeof t.mfe === 'number' && isFinite(t.mfe)) ? t.mfe : 0;
    case 'max_drawdown': return (typeof t.mae === 'number' && isFinite(t.mae)) ? t.mae : 0;
    /* ROUND189 (TV parity): excursion percents over entry notional. */
    case 'max_runup_percent':
    case 'max_drawdown_percent': {
      const notion = (typeof t.entryPrice === 'number' && typeof t.qty === 'number') ? Math.abs(t.entryPrice * t.qty) : NaN;
      if (!(notion > 0)) return NA;
      const v = field === 'max_runup_percent' ? (t.mfe || 0) : (t.mae || 0);
      return (typeof v === 'number' && isFinite(v)) ? v / notion * 100 : 0;
    }
    default: throw runtimeError(`Unknown strategy.closedtrades field '${field}'`);
  }
}
function pushBrokerBar(rt) {
  const b = rt.broker;
  if (!b) return;
  const bar = rt.bars[rt.barIndex];
  dayRollover(rt, bar); // finalize the previous UTC day first (idempotent)
  b.equity[rt.barIndex] = brokerEquityNow(rt);
  b.qtyTape[rt.barIndex] = b.qty || 0; // ROUND180: position sign per bar
  const eq = b.equity[rt.barIndex];
  if (typeof eq === 'number' && isFinite(eq)) {
    if (eq > b.peak) b.peak = eq;
    if (b.day && eq > b.day.peak) b.day.peak = eq;
  }
  /* ROUND181: per-lot favorable/adverse excursion — unrealized extremes of
     each open lot at every close (rollback-safe plain fields). */
  const cl = bar && typeof bar.close === 'number' && isFinite(bar.close) ? bar.close : NaN;
  if (isFinite(cl)) {
    for (const e of b.entries) {
      if (!(e.qty > 0)) continue;
      if (e.mfe == null) { e.mfe = 0; e.mae = 0; }
      const u = (cl - e.price) * e.dir * e.qty;
      if (u > e.mfe) e.mfe = u;
      if (u < e.mae) e.mae = u;
    }
  }
  riskTripEval(rt, bar); // ROUND189: flatten + latch/block when a rule trips
  /* ROUND213: maintenance margin call — an open position whose notional
     requirement exceeds marked equity flattens at the close (counted, no
     latch — the strategy keeps trading). Working orders die with it.
     Runs after the risk trips (they win ties); equity/tape re-marked. */
  if (!rt.dry && b.qty !== 0) {
    const cl = bar && typeof bar.close === 'number' && isFinite(bar.close) ? bar.close : NaN;
    const eq = b.equity[rt.barIndex];
    if (isFinite(cl) && typeof eq === 'number' && isFinite(eq)) {
      const dir = b.qty > 0 ? 1 : -1;
      if (marginReq(rt, Math.abs(b.qty), cl, dir) > eq) {
        b.pending = [];
        b.marginCalls = (b.marginCalls || 0) + 1;
        closePosition(rt, cl, rt.barIndex, 'MarginCall');
        b.equity[rt.barIndex] = brokerEquityNow(rt);
        b.qtyTape[rt.barIndex] = b.qty || 0;
      }
    }
  }
}

/* ROUND189: UTC-day bookkeeping. Finalizes the previous day's net (last
   equity print minus day-start equity) and opens a fresh bucket. Runs at
   the top of brokerFills (before fills) and pushBrokerBar (idempotent —
   same key twice is a no-op), so fills always land in the right bucket
   even across forming-bar re-runs (rollback restores the buckets). */
function dayKeyOf(t) { return Math.floor(t / 86400); }

function dayRollover(rt, bar) {
  const b = rt.broker;
  if (!b || !bar || bar.time == null || !isFinite(bar.time)) return;
  const key = dayKeyOf(bar.time);
  if (!b.day) {
    const eq = brokerEquityNow(rt);
    b.day = { key, startEq: eq, peak: eq, fills: 0, blocked: false, closed: 0 };
    return;
  }
  if (b.day.key === key) return;
  /* A day's net is its CLOSED realized profit (entry-only/hold days are 0
     and break loss streaks — a day is a "loss day" when it closed red). */
  b.dayHist.push({ key: b.day.key, net: b.day.closed || 0 });
  if (b.dayHist.length > 1000) b.dayHist.splice(0, b.dayHist.length - 1000);
  const eq = brokerEquityNow(rt);
  b.day = { key, startEq: eq, peak: eq, fills: 0, blocked: false, closed: 0 };
  /* consecutive-loss-days latch (whole-strategy stop). */
  const n = (b.risk && b.risk.maxConsDays) || 0;
  if (n > 0) {
    let run = 0;
    for (let i = b.dayHist.length - 1; i >= 0; i--) {
      if (b.dayHist[i].net < 0) run++;
      else break;
    }
    if (run >= n) riskFlatten(rt, bar, 'max_cons_loss_days', true);
  }
}

/* Flatten + cancel + latch/block. Price = the live bar close (documented
   house rule — risk stops act immediately, not next-bar). Latch stops the
   whole strategy; day blocks only gate entries/orders till the UTC day ends
   (exits/closes to flat stay allowed, TV parity). */
function riskFlatten(rt, bar, why, latch) {
  const b = rt.broker;
  if (!b) return;
  b.pending = [];
  const px = bar && typeof bar.close === 'number' && isFinite(bar.close) ? bar.close : NaN;
  if (b.qty !== 0 && isFinite(px)) closePosition(rt, px, rt.barIndex, 'risk:' + why);
  if (latch) b.riskTrip = why;
  else if (b.day) b.day.blocked = true;
  b.equity[rt.barIndex] = brokerEquityNow(rt);
  b.qtyTape[rt.barIndex] = b.qty || 0;
}

/* Whole-strategy gate for NEW exposure (entry/order). Exits/closes always
   pass — a stopped strategy must still be able to flatten (TV parity). */
function riskBlocked(rt) {
  const b = rt.broker;
  if (!b) return false;
  if (b.riskTrip) return true;
  return !!(b.day && b.day.blocked);
}

/* ROUND213 (TV parity): margin requirement as % of notional. available =
   marked equity (capital + realized + open at the current close); required
   for an order = |contracts x price| x side-% / 100. Under-margined NEW
   exposure is dropped silently (risk-guard precedent); exits/closes always
   pass (closing frees margin). */
function marginPct(rt, dir) {
  const b = rt.broker;
  const v = dir > 0 ? b.cfg.marginLong : b.cfg.marginShort;
  return (typeof v === 'number' && isFinite(v) && v >= 0) ? v : 100;
}
function marginReq(rt, qty, price, dir) {
  if (!(qty > 0) || !(price > 0)) return 0;
  return Math.abs(qty * price) * marginPct(rt, dir) / 100;
}
/* Would this entry/order's contracts clear the requirement at price? */
function marginBlocked(rt, dir, qtySpec, price) {
  const b = rt.broker;
  if (!b || rt.dry) return false;
  const q = resolveQty(rt, { qtySpec }, price);
  if (!(q > 0)) return false; // zero-size resolves downstream (ignored-no-qty)
  if (!(price > 0)) return false;
  return marginReq(rt, q, price, dir) > brokerEquityNow(rt);
}

/* Per-bar rule evaluation (after peaks are fresh). Intraday loss trips on
   day-peak drawdown; max_drawdown trips on the all-time peak and latches. */
function riskTripEval(rt, bar) {
  const b = rt.broker;
  if (!b || rt.dry) return;
  const eq = b.equity[rt.barIndex];
  if (typeof eq !== 'number' || !isFinite(eq)) return;
  const r = b.risk || {};
  if (!b.riskTrip && r.maxDD && r.maxDD.v > 0 && isFinite(b.peak) && b.peak > 0) {
    const th = r.maxDD.mode === 'percent' ? r.maxDD.v / 100 * b.peak : r.maxDD.v;
    if (b.peak - eq >= th) { riskFlatten(rt, bar, 'max_drawdown', true); return; }
  }
  if (b.day && !b.day.blocked && r.maxILoss && r.maxILoss.v > 0 && isFinite(b.day.peak)) {
    const th = r.maxILoss.mode === 'percent' ? r.maxILoss.v / 100 * b.day.peak : r.maxILoss.v;
    if (b.day.peak - eq >= th) riskFlatten(rt, bar, 'max_intraday_loss', false);
  }
}

/* ROUND172: report stats (pure — the 2c panel consumes this). */
function brokerStats(b) {
  const trades = (b.trades || []).length;
  let wins = 0, grossP = 0, grossL = 0;
  for (const t of (b.trades || [])) {
    if (t.profit > 0) { wins++; grossP += t.profit; }
    else if (t.profit < 0) { grossL += -t.profit; }
  }
  const eq = b.equity || [];
  let peak = -Infinity, maxDD = 0, maxDDPct = 0;
  for (const v of eq) {
    if (typeof v !== 'number' || !isFinite(v)) continue;
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDD) maxDD = dd;
    if (peak > 0 && dd / peak > maxDDPct) maxDDPct = dd / peak;
  }
  return {
    trades, wins, losses: trades - wins,
    winRate: trades ? wins / trades : 0,
    grossProfit: grossP, grossLoss: grossL,
    profitFactor: grossL > 0 ? grossP / grossL : (grossP > 0 ? Infinity : 0),
    netProfit: b.realized || 0, fees: b.fees || 0,
    expectancy: trades ? (b.realized || 0) / trades : 0,
    maxDD, maxDDPct,
  };
}

function applyFill(rt, o, price, barIdx, due, di) {
  const b = rt.broker;
  let filledQty = 0; // contracts filled here (drives oca.reduce sibling cuts)
  if (o.kind === 'entry') {
    /* ROUND172: qty from the order spec (explicit contracts | cash |
       percent-of-equity resolved at the fill price). */
    let q = resolveQty(rt, o, price);
    if (!(q > 0)) return 'ignored-no-qty';
    /* ROUND189 (TV parity: risk guards). allow_entry_in — an opposite-side
       entry only closes, never reverses (and is ignored when flat).
       max_position_size — new exposure capped so the total never exceeds it
       (order dropped when nothing fits). */
    const allow = (b.risk && b.risk.allowDir) || 0;
    const mp = (b.risk && b.risk.maxPos) || 0;
    if (allow !== 0 && o.dir !== allow) {
      if (b.qty === 0) return 'ignored-risk-direction';
      const beforeAbs = Math.abs(b.qty);
      closePosition(rt, price, barIdx, o.id);
      refreshPosition(b);
      filledQty = Math.max(0, beforeAbs - Math.abs(b.qty));
    } else if (b.qty === 0) {
      if (mp > 0) { q = Math.min(q, mp); if (!(q > 0)) return 'ignored-risk-size'; }
      b.entries.push({ id: o.id, dir: o.dir, qty: q, price, bar: barIdx, mfe: 0, mae: 0 });
      chargeFill(rt, price, q);
      refreshPosition(b);
      filledQty = q;
    } else if ((b.qty > 0 ? 1 : -1) === o.dir) {
      /* ROUND185 (TV parity): pyramiding N allows up to N successive same-
         direction entries (ROUND225: default 0 like TV — the gate floors
         at max(1, N), so adds still need explicit pyramiding). */
      const sameN = b.entries.filter((e) => e.dir === o.dir).length;
      if (sameN >= Math.max(1, b.cfg.pyramiding)) return 'ignored-pyramiding';
      if (mp > 0) { q = Math.min(q, mp - Math.abs(b.qty)); if (!(q > 0)) return 'ignored-risk-size'; }
      b.entries.push({ id: o.id, dir: o.dir, qty: q, price, bar: barIdx, mfe: 0, mae: 0 });
      chargeFill(rt, price, q);
      refreshPosition(b);
      filledQty = q;
    } else {
      closePosition(rt, price, barIdx, o.id); // reverse: flatten first
      let nq = q;
      if (mp > 0) nq = Math.min(q, mp);
      if (nq > 0) {
        b.entries.push({ id: o.id, dir: o.dir, qty: nq, price, bar: barIdx, mfe: 0, mae: 0 });
        chargeFill(rt, price, nq);
      }
      refreshPosition(b);
      filledQty = q;
    }
  } else if (o.kind === 'order') {
    /* ROUND185 (TV parity): order() nets signed quantities — no
       auto-reverse sizing, no pyramiding gate. Long 15 then three short
       5s walks 15→10→5→0 and never goes short. */
    const q = resolveQty(rt, o, price);
    if (!(q > 0)) return 'ignored-no-qty';
    const signed = o.dir * q;
    const cur = b.qty;
    if (cur === 0 || (cur > 0) === (signed > 0)) {
      b.entries.push({ id: o.id, dir: o.dir, qty: q, price, bar: barIdx, mfe: 0, mae: 0 });
      chargeFill(rt, price, q);
    } else {
      const shut = Math.min(Math.abs(cur), q);
      closePosition(rt, price, barIdx, o.id, shut);
      const rest = q - shut;
      if (rest > 0) {
        b.entries.push({ id: o.id, dir: o.dir, qty: rest, price, bar: barIdx, mfe: 0, mae: 0 });
        chargeFill(rt, price, rest);
      }
    }
    refreshPosition(b);
    filledQty = q;
  } else {
    // exit / close: match lots (from_entry or FIFO), optional partial qty
    /* ROUND187 (TV parity: close_entries_rule) — FIFO (default) always
       exits oldest-first, even when from_entry/id names another trade; the
       fill size is then capped by the named lots' quantity. ANY exits the
       named lots first. Lenient corners (TV reality): close("Out") with no
       "Out" lot open still closes everything (MATrend pattern); exit() with
       a from_entry that has no open lot stays ignored (brackets need it).
       NOTE (documented simplification): a partial fill consumes the working
       order; TV keeps uncovered remainder working. */
    const rule = b.cfg.closeRule === 'any' ? 'any' : 'fifo';
    const isExit = o.kind === 'exit';
    const key = isExit ? o.fromEntry : (o.id || null);
    let lots;
    let cap = Infinity;
    if (!key) {
      lots = b.entries.slice();
    } else {
      const named = b.entries.filter((e) => e.id === key);
      if (!named.length) {
        if (isExit) return 'ignored-no-position';
        lots = b.entries.slice();
      } else if (rule === 'any') {
        lots = named.concat(b.entries.filter((e) => e.id !== key));
      } else {
        lots = b.entries.slice();
        cap = named.reduce((a, e) => a + Math.max(0, e.qty), 0);
      }
    }
    if (!lots.length) return 'ignored-no-position';
    let want = o.qty != null ? Math.min(o.qty, Math.abs(b.qty)) : Math.abs(b.qty);
    if (o.qtyPct != null) want = Math.min(want, Math.abs(b.qty) * o.qtyPct / 100);
    want = Math.min(want, cap);
    if (!(want > 0)) return 'ignored-no-qty';
    const beforeAbs = Math.abs(b.qty);
    closePosition(rt, price, barIdx, o.id, want, lots);
    filledQty = Math.max(0, beforeAbs - Math.abs(b.qty));
  }
  /* ROUND189: intraday fill counting (max_intraday_filled_orders trips the
     moment the cap is reached: cancel pending, flatten at this price, block
     new exposure till the UTC day ends). */
  if (b.day) {
    b.day.fills++;
    const mf = (b.risk && b.risk.maxFills) || 0;
    if (mf > 0 && b.day.fills >= mf && !b.day.blocked) {
      b.pending = [];
      if (b.qty !== 0) closePosition(rt, price, barIdx, 'risk:max_intraday_filled_orders');
      b.day.blocked = true;
    }
  }
  if (o.oca) ocaResolve(rt, o, filledQty, due, di);
  /* ROUND225 (TV parity): order-fill alert_message fires into the same
     collection as alert() (no external firing infra — recorded with the
     fill bar, like alert() entries). */
  if (filledQty > 0 && o.alert != null && o.alert !== '' && rt.out && Array.isArray(rt.out.alerts)) {
    rt.out.alerts.push({ message: String(o.alert), at: Date.now(), bar: barIdx, fill: true, id: o.id || '' });
  }
  return 'filled';
}

function closePosition(rt, price, barIdx, exitId, qty, lots) {
  const b = rt.broker;
  if (!b.qty) return;
  let want = qty != null ? Math.min(qty, Math.abs(b.qty)) : Math.abs(b.qty);
  let closedValue = 0, closedQty = 0;
  for (const e of (lots || b.entries)) {
    if (want <= 0) break;
    if (e.qty <= 0) continue;
    const shut = Math.min(e.qty, want);
    const profit = (price - e.price) * e.dir * shut;
    if (b.day) b.day.closed = (b.day.closed || 0) + profit; // ROUND189: realized leg of the day bucket
    b.trades.push({ entryId: e.id, exitId: exitId || '', dir: e.dir, qty: shut,
      entryBar: e.bar, entryPrice: e.price, exitBar: barIdx, exitPrice: price, profit,
      /* ROUND181: favorable/adverse excursion (TV hover tooltip) — the lot's
         unrealized extremes while open; partial closes share the lot's
         extremes (documented approximation). */
      mfe: (typeof e.mfe === 'number' && isFinite(e.mfe)) ? e.mfe : 0,
      mae: (typeof e.mae === 'number' && isFinite(e.mae)) ? e.mae : 0 });
    b.realized += profit;
    closedValue += price * shut;
    closedQty += shut;
    e.qty -= shut;
    want -= shut;
    if (e.qty <= 0) b.closedN++;
  }
  /* ROUND172: commission on the exit fill (entry side charged at entry). */
  if (closedValue > 0) {
    const cv = b.cfg.commValue;
    let fee = 0;
    if (cv > 0) {
      if (b.cfg.commType === 'cash_per_order') fee = cv;
      else if (b.cfg.commType === 'cash_per_contract') fee = cv * closedQty;
      else fee = (cv / 100) * closedValue;
    }
    if (fee > 0) { b.realized -= fee; b.fees += fee; }
  }
  b.entries = b.entries.filter((e) => e.qty > 0);
  /* ROUND223: 9000-trade trim (TV parity, no halt) — oldest portions fall
     off; firstDropped feeds strategy.closedtrades.first_index. */
  if (b.trades.length > 9000) {
    const drop = b.trades.length - 9000;
    b.trades.splice(0, drop);
    b.firstDropped = (b.firstDropped || 0) + drop;
  }
  refreshPosition(b);
}

function refreshPosition(b) {
  let q = 0, w = 0;
  for (const e of b.entries) { q += e.dir * e.qty; w += e.price * e.qty; }
  b.qty = q;
  b.avg = q !== 0 ? w / Math.abs(q) : 0;
}

/* ROUND188 (TV parity): OCA group resolution on every fill. cancel (the
   default when oca_name is set): siblings die. reduce: siblings' explicit
   quantities shrink by the filled amount (to zero = cancelled); siblings
   with declaration-driven (non-fixed) sizing can't shrink, so they cancel.
   Same-bar siblings later in the due queue are covered too (marked dead);
   the one-merge-point rule of brokerFills keeps this race-free. */
function ocaResolve(rt, filled, fq, due, di) {
  const b = rt.broker;
  if (!filled || !filled.oca) return;
  const shrink = (s) => {
    if ((s.ocaType || 'cancel') !== 'reduce' || !(fq > 0)) return 'cancel';
    if (s.kind === 'exit' && s.qty != null) {
      s.qty -= fq;
      return s.qty > 0 ? 'keep' : 'cancel';
    }
    if ((s.kind === 'entry' || s.kind === 'order') && s.qtySpec && s.qtySpec.mode === 'fixed') {
      s.qtySpec.value -= fq;
      return s.qtySpec.value > 0 ? 'keep' : 'cancel';
    }
    return 'cancel';
  };
  for (const s of b.pending.filter((p) => p.oca === filled.oca)) {
    if (shrink(s) === 'cancel') b.pending = b.pending.filter((p) => p !== s);
  }
  if (Array.isArray(due) && di != null) {
    for (let k = di + 1; k < due.length; k++) {
      const s = due[k];
      if (!s || s === filled || s.oca !== filled.oca) continue;
      if (shrink(s) === 'cancel') s.ocaDead = true;
    }
  }
}

/* ---------- getters ---------- */

/* ROUND229 (TV parity, v6 reference §strategy.margin_liquidation_price):
   the price where the maintenance rule would liquidate. Maintenance trips
   when requirement > marked equity: |q|*P*f > C+R+(P-a)*q, linear in P.
   Solve for P; na when flat, unmargined, or no loss-side solution (the live
   engine would already have flattened a currently-broken position). */
function brokerLiqPrice(rt) {
  const b = rt.broker;
  if (!b || !rt.meta || !rt.meta.isStrategy) return NA;
  if (rt.dry) return NA;
  const q = b.qty;
  if (!(q > 0) && !(q < 0)) return NA;
  const mL = (rt.meta && rt.meta.strategy && rt.meta.strategy.margin_long) || 0;
  const mS = (rt.meta && rt.meta.strategy && rt.meta.strategy.margin_short) || 0;
  if (mL <= 0 && mS <= 0) return NA;
  const f = (q > 0 ? (mL > 0 ? mL : mS) : (mS > 0 ? mS : mL)) / 100;
  if (!(f > 0)) return NA;
  const C = b.cfg.capital || 0, R = b.realized || 0, a = b.avg || 0;
  const K = Math.abs(q) * f - q;
  const RHS = C + R - a * q;
  let liq = NaN;
  if (K > 0) liq = RHS / K;       // trips when P rises past liq
  else if (K < 0) liq = RHS / K;  // trips when P falls past liq
  else return NA;                 // requirement tracks equity (f=100% long): never
  if (!isFinite(liq) || liq <= 0) return NA;
  const bar = rt.bars[rt.barIndex];
  const cl = bar && typeof bar.close === 'number' && isFinite(bar.close) ? bar.close : NaN;
  if (!isFinite(cl)) return liq;
  /* only the loss side is meaningful (a gain-side "solution" means the
     position is already broken — the engine would have flattened it). */
  if (q > 0 && liq >= cl) return NA;
  if (q < 0 && liq <= cl) return NA;
  return liq;
}

function brokerGet(rt, name) {
  const b = rt.broker;
  if (!b) return NA;
  switch (name) {
    case 'position_size': return b.qty;
    case 'position_avg_price': return b.qty !== 0 ? b.avg : NA;
    case 'opentrades': return b.entries.length;
    case 'openprofit': {
      if (!b.qty) return 0;
      const bar = rt.bars[rt.barIndex];
      const cl = bar && typeof bar.close === 'number' && isFinite(bar.close) ? bar.close : NaN;
      if (!isFinite(cl)) return NA;
      return (cl - b.avg) * b.qty;
    }
    case 'closedtrades': return b.closedN;
    /* ROUND229 (TV parity, verified against the v6 reference). */
    case 'avg_trade': return brokerAccount(rt).avg_trade;
    case 'avg_trade_percent': return brokerAccount(rt).avg_trade_percent;
    case 'avg_winning_trade': return brokerAccount(rt).avg_winning_trade;
    case 'avg_winning_trade_percent': return brokerAccount(rt).avg_winning_trade_percent;
    case 'avg_losing_trade': return brokerAccount(rt).avg_losing_trade;
    case 'avg_losing_trade_percent': return brokerAccount(rt).avg_losing_trade_percent;
    case 'max_runup': return brokerAccount(rt).max_runup;
    case 'max_runup_percent': return brokerAccount(rt).max_runup_percent;
    case 'grossprofit_percent': return brokerAccount(rt).grossprofit_percent;
    case 'grossloss_percent': return brokerAccount(rt).grossloss_percent;
    case 'netprofit_percent': return brokerAccount(rt).netprofit_percent;
    case 'max_contracts_held_all': return brokerAccount(rt).max_contracts_held_all;
    case 'max_contracts_held_long': return brokerAccount(rt).max_contracts_held_long;
    case 'max_contracts_held_short': return brokerAccount(rt).max_contracts_held_short;
    case 'openprofit_percent': {
      if (!b.qty) return 0;
      const bar = rt.bars[rt.barIndex];
      const cl = bar && typeof bar.close === 'number' && isFinite(bar.close) ? bar.close : NaN;
      const req = b.cfg.capital + (b.realized || 0);
      if (!isFinite(cl) || !(req > 0)) return NA;
      return (cl - b.avg) * b.qty / req * 100;
    }
    case 'position_entry_name': {
      const e = (b.entries || []).find((x) => x && x.qty > 0);
      return e ? e.id : NA;
    }
    case 'opentrades.capital_held': {
      /* na unless the declaration carries nonzero margin (v6 reference);
         else the side's margin requirement on the open notional. */
      const mL = (rt.meta && rt.meta.strategy && rt.meta.strategy.margin_long) || 0;
      const mS = (rt.meta && rt.meta.strategy && rt.meta.strategy.margin_short) || 0;
      if (!b.qty || (mL <= 0 && mS <= 0)) return NA;
      const m = b.qty > 0 ? mL : mS;
      if (!(m > 0)) return NA;
      const bar = rt.bars[rt.barIndex];
      const cl = bar && typeof bar.close === 'number' && isFinite(bar.close) ? bar.close : NaN;
      if (!isFinite(cl)) return NA;
      return Math.abs(b.qty) * cl * m / 100;
    }
    case 'margin_liquidation_price': return brokerLiqPrice(rt);
    /* ROUND172 (phase 2b: account). */
    case 'initial_capital': return b.cfg.capital;
    case 'account_currency': return b.cfg.currency || 'USD'; // ROUND186
    /* ROUND186 (TV parity: script-side account getters, memoized per bar). */
    case 'netprofit': return brokerAccount(rt).netprofit;
    case 'grossprofit': return brokerAccount(rt).grossprofit;
    case 'grossloss': return brokerAccount(rt).grossloss;
    case 'wintrades': return brokerAccount(rt).wintrades;
    case 'losstrades': return brokerAccount(rt).losstrades;
    case 'eventrades': return brokerAccount(rt).eventrades;
    case 'max_drawdown': return brokerAccount(rt).max_drawdown;
    case 'max_drawdown_percent': { // ROUND189 (TV parity)
      const b2 = rt.broker;
      let peak = -Infinity, maxPct = 0;
      for (const v of (b2.equity || [])) {
        if (typeof v !== 'number' || !isFinite(v)) continue;
        if (v > peak) peak = v;
        if (peak > 0) maxPct = Math.max(maxPct, (peak - v) / peak * 100);
      }
      return maxPct;
    }
    case 'equity': {
      const eq = b.equity[rt.barIndex];
      return typeof eq === 'number' && isFinite(eq) ? eq : b.cfg.capital + b.realized;
    }
    default: return undefined;
  }
}

/* ROUND176 (tester Performance chart): stride downsampling for the equity /
   buy&hold series (pure — capped points, endpoints preserved, na dropped). */
function downsample(rows, maxN) {
  const clean = [];
  for (const r of (rows || [])) {
    if (r && typeof r.t === 'number' && isFinite(r.t) &&
        typeof r.v === 'number' && isFinite(r.v)) clean.push(r);
  }
  const n = Math.max(2, Math.floor(maxN) || 2);
  if (clean.length <= n) return clean;
  const out = [];
  const step = (clean.length - 1) / (n - 1);
  for (let k = 0; k < n; k++) out.push(clean[Math.round(k * step)]);
  return out;
}

/* ROUND177 (tester "Profits and losses" + CSV export): pure grouping and
   serialization over closed trades — no DOM, node-testable. */
function tradeGroups(trades) {
  const bySignal = new Map();
  const sides = { Long: { name: 'Long', profit: 0, n: 0 }, Short: { name: 'Short', profit: 0, n: 0 } };
  for (const t of (trades || [])) {
    const p = (typeof t.profit === 'number' && isFinite(t.profit)) ? t.profit : 0;
    const sig = (t.entryId != null && t.entryId !== '') ? String(t.entryId) : '(no signal)';
    if (!bySignal.has(sig)) bySignal.set(sig, { name: sig, profit: 0, n: 0 });
    const g = bySignal.get(sig);
    g.profit += p; g.n++;
    const s = t.dir < 0 ? sides.Short : sides.Long;
    s.profit += p; s.n++;
  }
  const sigs = [...bySignal.values()].sort((a, b) => b.profit - a.profit);
  const total = sigs.reduce((a, g) => a + g.profit, 0);
  return { bySignal: sigs, bySide: [sides.Long, sides.Short].filter((s) => s.n > 0), total };
}

/* One row per closed trade, full-precision numbers (the panel rounds). */
function tradesCsv(trades, cur) {
  const q = (v) => {
    const s = String(v == null ? '' : v);
    return (/[",\n]/.test(s)) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const iso = (sec) => (sec == null || !isFinite(sec) ? '' : new Date(sec * 1000).toISOString());
  const lines = ['Trade,Side,Qty,Entry time,Entry price,Exit time,Exit price,Net PnL'
    + (cur ? ' (' + cur + ')' : '') + ',Return %'];
  (trades || []).forEach((t, k) => {
    let ret = '';
    const notion = (typeof t.entryPrice === 'number' && typeof t.qty === 'number') ? t.entryPrice * t.qty : NaN;
    if (isFinite(notion) && notion !== 0 && isFinite(t.profit)) {
      ret = (t.profit / Math.abs(notion) * 100).toFixed(4);
    }
    lines.push([k + 1, t.dir < 0 ? 'Short' : 'Long', t.qty, iso(t.entryTime), t.entryPrice,
      iso(t.exitTime), t.exitPrice,
      (typeof t.profit === 'number' && isFinite(t.profit)) ? Math.round(t.profit * 100) / 100 : '',
      ret].map(q).join(','));
  });
  return lines.join('\n');
}

/* ROUND179 (strategy bottom dock): time-range filtering of a finished report.
   Pure — keeps trades whose EXIT lands in [fromSec, toSec] and recomputes
   stats + slices the perf series over the same window. Fees cannot be
   attributed per trade, so a filtered report shows fees as unknown. */
function filterReport(rep, fromSec, toSec) {
  const inR = (t) => t != null && isFinite(t) &&
    (fromSec == null || t >= fromSec) && (toSec == null || t <= toSec);
  const trades = ((rep && rep.trades) || []).filter((tr) => inR(tr.exitTime));
  const eq = [], bh = [], eqVals = [];
  let realized = 0;
  for (const tr of trades) {
    if (typeof tr.profit === 'number' && isFinite(tr.profit)) realized += tr.profit;
  }
  try {
    for (const p of ((rep && rep.perf && rep.perf.equity) || [])) {
      if (p && inR(p.t)) { eq.push(p); eqVals.push(p.v); }
    }
    for (const p of ((rep && rep.perf && rep.perf.buyHold) || [])) {
      if (p && inR(p.t)) bh.push(p);
    }
  } catch (e) {}
  /* brokerStats reads net/expectancy off broker.realized (not re-summed),
     so the slice carries its own realized total. */
  const stats = brokerStats({ trades, equity: eqVals, realized });
  stats.fees = undefined; // not attributable per trade — panel shows '—'
  return {
    trades,
    stats,
    perf: { capital: (rep && rep.initialCapital) || 0, equity: eq, buyHold: bh },
    ranged: true,
  };
}

/* ROUND180: pagination slice for the full trade list (newest-first page).
   Pure — total rows, zero-based page, page size. */
function paginate(total, page, size) {
  const n = Math.max(0, Math.floor(total) || 0);
  const s = Math.max(1, Math.floor(size) || 1);
  const pages = Math.max(1, Math.ceil(n / s));
  const p = Math.min(pages - 1, Math.max(0, Math.floor(page) || 0));
  return { pages, page: p, start: p * s, end: Math.min(n, p * s + s), count: n };
}

/* ROUND182 (Performance extras): per-trade excursion spikes for the chart —
   one green 0→mfe and one red 0→mae spike per closed trade, at its exit.
   Pure. */
function excursionSpikes(trades) {
  const out = [];
  for (const t of (trades || [])) {
    if (t == null || t.exitTime == null || !isFinite(t.exitTime)) continue;
    const fav = (typeof t.mfe === 'number' && isFinite(t.mfe)) ? t.mfe : 0;
    const adv = (typeof t.mae === 'number' && isFinite(t.mae)) ? t.mae : 0;
    if (fav === 0 && adv === 0) continue;
    out.push({ t: t.exitTime, fav, adv });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/* ROUND182: run-up (green, value minus running trough) and drawdown (red,
   value minus running peak) over a relative-PnL series. Pure. */
function runupDrawdown(rows) {
  const out = [];
  let peak = -Infinity, trough = Infinity;
  for (const p of (rows || [])) {
    if (!p || !isFinite(p.t) || typeof p.v !== 'number' || !isFinite(p.v)) continue;
    if (p.v > peak) peak = p.v;
    if (p.v < trough) trough = p.v;
    out.push({ t: p.t, ru: p.v - trough, dd: p.v - peak });
  }
  return out;
}

/* ROUND183 (Trades analysis section): everything the Distribution / Streaks /
   Time-patterns tabs need, computed purely from closed trades + capital.
   Return % matches the List-of-trades column (profit over entry notional).
   Outlier = |p - mean| > 2σ (population); its % and the expectancy/largest
   % are all over initial capital (TV parity). */
function tradeReturn(t) {
  const notion = (typeof t.entryPrice === 'number' && typeof t.qty === 'number') ? t.entryPrice * t.qty : NaN;
  if (!isFinite(notion) || notion === 0 || !isFinite(t.profit)) return NaN;
  return t.profit / Math.abs(notion) * 100;
}

function tradesAnalysis(trades, capital) {
  const list = Array.isArray(trades) ? trades : [];
  const cap = (typeof capital === 'number' && isFinite(capital) && capital > 0) ? capital : 0;
  const pct = (v) => (cap > 0 && isFinite(v) ? v / cap * 100 : 0);
  const n = list.length;
  let net = 0, wins = 0, losses = 0;
  const rets = [];
  for (const t of list) {
    const p = (t && typeof t.profit === 'number' && isFinite(t.profit)) ? t.profit : 0;
    net += p;
    if (p > 0) wins++;
    else if (p < 0) losses++;
    rets.push(tradeReturn(t || {}));
  }
  const evens = n - wins - losses;
  const mean = n ? net / n : 0;
  let sd = 0;
  for (const t of list) {
    const p = (t && typeof t.profit === 'number' && isFinite(t.profit)) ? t.profit : 0;
    sd += (p - mean) * (p - mean);
  }
  sd = n ? Math.sqrt(sd / n) : 0;
  let outSum = 0;
  const finite = rets.filter((r) => isFinite(r));
  if (sd > 0) {
    for (const t of list) {
      const p = (t && typeof t.profit === 'number' && isFinite(t.profit)) ? t.profit : 0;
      if (Math.abs(p - mean) > 2 * sd) outSum += p;
    }
  }
  let lw = null, ll = null;
  for (const t of list) {
    const p = (t && typeof t.profit === 'number' && isFinite(t.profit)) ? t.profit : 0;
    if (lw == null || p > lw.profit) lw = { profit: p };
    if (ll == null || p < ll.profit) ll = { profit: p };
  }
  /* histogram over return % */
  const NB = 30;
  let bins = [];
  if (finite.length) {
    let lo = Math.min(...finite), hi = Math.max(...finite);
    if (!(hi > lo)) { hi = lo + 1; }
    const w = (hi - lo) / NB;
    bins = [];
    for (let i = 0; i < NB; i++) bins.push({ lo: lo + i * w, hi: lo + (i + 1) * w, w: 0, l: 0 });
    list.forEach((t) => {
      const r = tradeReturn(t || {});
      if (!isFinite(r)) return;
      const p = t.profit;
      const b = bins[Math.min(NB - 1, Math.max(0, Math.floor((r - lo) / w)))];
      if (p > 0) b.w++;
      else if (p < 0) b.l++;
    });
    bins = bins.filter((b) => b.w + b.l > 0);
  }
  let avgW = NaN, avgL = NaN;
  {
    let sw = 0, nw = 0, sl = 0, nl = 0;
    list.forEach((t, i) => {
      const r = rets[i];
      if (!isFinite(r)) return;
      if (t.profit > 0) { sw += r; nw++; }
      else if (t.profit < 0) { sl += r; nl++; }
    });
    if (nw) avgW = sw / nw;
    if (nl) avgL = sl / nl;
  }
  /* streaks (chronological; breakeven breaks both runs) */
  const runs = [];
  let curD = 0, curN = 0;
  const flush = () => { if (curD !== 0 && curN > 0) runs.push({ dir: curD, n: curN }); curD = 0; curN = 0; };
  for (const t of list) {
    const p = (t && typeof t.profit === 'number' && isFinite(t.profit)) ? t.profit : 0;
    const d = p > 0 ? 1 : p < 0 ? -1 : 0;
    if (d === 0) { flush(); continue; }
    if (d === curD) curN++;
    else { flush(); curD = d; curN = 1; }
  }
  flush();
  let maxW = 0, maxL = 0, sumW = 0, cntW = 0, sumL = 0, cntL = 0;
  for (const r of runs) {
    if (r.dir > 0) { maxW = Math.max(maxW, r.n); sumW += r.n; cntW++; }
    else { maxL = Math.max(maxL, r.n); sumL += r.n; cntL++; }
  }
  const lastRun = runs.length ? runs[runs.length - 1] : null;
  /* weekday patterns (exit time, UTC; Mon-first like TV) */
  const wd = [];
  for (let i = 0; i < 7; i++) wd.push({ d: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i], n: 0, net: 0 });
  for (const t of list) {
    if (!t || t.exitTime == null || !isFinite(t.exitTime)) continue;
    const p = (typeof t.profit === 'number' && isFinite(t.profit)) ? t.profit : 0;
    const wday = (new Date(t.exitTime * 1000).getUTCDay() + 6) % 7;
    wd[wday].n++;
    wd[wday].net += p;
  }
  return {
    n, wins, losses, evens, net,
    expectancy: n ? net / n : 0, expectancyPct: pct(n ? net / n : 0),
    outliers: outSum, outliersPct: pct(outSum),
    largestWin: lw ? lw.profit : 0, largestWinPct: pct(lw ? lw.profit : 0),
    largestLoss: ll ? ll.profit : 0, largestLossPct: pct(ll ? ll.profit : 0),
    bins, avgWinRet: avgW, avgLossRet: avgL,
    donut: {
      total: n,
      win: wins, loss: losses, even: evens,
      winPct: n ? wins / n * 100 : 0, lossPct: n ? losses / n * 100 : 0, evenPct: n ? evens / n * 100 : 0,
    },
    streaks: {
      runs,
      maxWin: maxW, maxLoss: maxL,
      avgWin: cntW ? sumW / cntW : 0, avgLoss: cntL ? sumL / cntL : 0,
      current: lastRun ? { dir: lastRun.dir, n: lastRun.n } : { dir: 0, n: 0 },
    },
    weekdays: wd,
  };
}

/* ROUND194 (Performance Summary, TV parity): All/Long/Short split of every
   trade-based metric plus the equity-shared ones (run-up/drawdown, buy&hold,
   fees/open/max-held). Pure — the tester panel renders it, node-testable.
   Conventions: percents over initial capital (except drawdown %, which is of
   the running peak, like brokerStats.maxDDPct); Sharpe = mean/sd and Sortino
   = mean/downside-sd over per-trade net profits (trade-based approximation —
   TV's bar-based version needs the return series we don't store); bars =
   exitBar-entryBar where both are known; margin calls ride o.marginCalls (live broker count; 0 when absent). */
function perfSummary(trades, o) {
  o = o || {};
  const cap = (typeof o.capital === 'number' && isFinite(o.capital) && o.capital > 0) ? o.capital : 0;
  const pct = (v) => (cap > 0 && typeof v === 'number' && isFinite(v) ? v / cap * 100 : 0);
  const list = Array.isArray(trades) ? trades : [];
  const P = (t) => (t && typeof t.profit === 'number' && isFinite(t.profit)) ? t.profit : 0;
  const B = (t) => (t && typeof t.entryBar === 'number' && typeof t.exitBar === 'number' &&
    isFinite(t.entryBar) && isFinite(t.exitBar)) ? t.exitBar - t.entryBar : NaN;
  function side(arr) {
    const n = arr.length;
    let wins = 0, losses = 0, grossP = 0, grossL = 0, net = 0;
    let lw = null, ll = null, sw = 0, nw = 0, sl = 0, nl = 0;
    let bSum = 0, bN = 0, wbSum = 0, wbN = 0, lbSum = 0, lbN = 0;
    for (const t of arr) {
      const p = P(t);
      net += p;
      if (p > 0) { wins++; grossP += p; sw += p; nw++; }
      else if (p < 0) { losses++; grossL += -p; sl += p; nl++; }
      if (lw == null || p > lw) lw = p;
      if (ll == null || p < ll) ll = p;
      const b = B(t);
      if (isFinite(b)) {
        bSum += b; bN++;
        if (p > 0) { wbSum += b; wbN++; }
        else if (p < 0) { lbSum += b; lbN++; }
      }
    }
    const mean = n ? net / n : 0;
    let sd = 0;
    for (const t of arr) { const d = P(t) - mean; sd += d * d; }
    sd = n ? Math.sqrt(sd / n) : 0;
    let down = 0;
    for (const t of arr) { const d = Math.min(0, P(t)); down += d * d; }
    down = n ? Math.sqrt(down / n) : 0;
    const aw = nw ? sw / nw : NaN, al = nl ? sl / nl : NaN;
    return {
      n, wins, losses, evens: n - wins - losses, net, netPct: pct(net),
      grossP, grossL,
      profitFactor: grossL > 0 ? grossP / grossL : (grossP > 0 ? Infinity : 0),
      winPct: n ? wins / n * 100 : 0,
      avg: mean, avgPct: pct(mean), avgW: aw, avgL: al,
      ratio: (nw && nl) ? aw / -al : (nw ? Infinity : 0),
      largestW: lw == null ? 0 : lw, largestWPct: pct(lw == null ? 0 : lw),
      largestL: ll == null ? 0 : ll, largestLPct: pct(ll == null ? 0 : ll),
      avgBars: bN ? bSum / bN : NaN,
      avgWBars: wbN ? wbSum / wbN : NaN,
      avgLBars: lbN ? lbSum / lbN : NaN,
      sharpe: sd > 0 ? mean / sd : 0,
      sortino: down > 0 ? mean / down : 0,
    };
  }
  const all = side(list);
  const longs = list.filter((t) => !(t && t.dir < 0));
  const shorts = list.filter((t) => t && t.dir < 0);
  /* equity-shared (absolute values; a filtered slice yields slice drawdown) */
  const eq = [];
  for (const v of (o.equity || [])) {
    if (typeof v === 'number' && isFinite(v)) eq.push(v);
  }
  let peak = -Infinity, maxDD = 0, trough = Infinity, maxRU = 0;
  for (const v of eq) {
    if (v > peak) peak = v;
    if (peak !== -Infinity && peak - v > maxDD) maxDD = peak - v;
    if (v < trough) trough = v;
    if (trough !== Infinity && v - trough > maxRU) maxRU = v - trough;
  }
  if (peak === -Infinity) peak = 0;
  const bh = [];
  for (const p of (o.buyHold || [])) {
    if (p && typeof p.v === 'number' && isFinite(p.v)) bh.push(p.v);
  }
  const bhNet = bh.length > 1 ? bh[bh.length - 1] - bh[0] : 0;
  return {
    all, long: side(longs), short: side(shorts),
    shared: {
      maxDD, maxDDPct: peak > 0 ? maxDD / peak * 100 : 0,
      maxRU, maxRUPct: pct(maxRU),
      bhNet, bhPct: pct(bhNet),
      fees: o.fees, openPL: o.openPL, openTrades: o.openTrades,
      maxLong: o.maxLong, maxShort: o.maxShort,
      marginCalls: (typeof o.marginCalls === 'number' && isFinite(o.marginCalls)) ? Math.max(0, Math.floor(o.marginCalls)) : 0,
    },
  };
}

/* ROUND184 (chart trade markers, TV parity): entry/exit markers for closed
   trades. timeOf maps a bar index to epoch seconds (null = skip that end).
   Newest 1000 trades max (2000 markers) so giant histories can't stall the
   chart. Markers sort ascending — LWC requires time order. */
function tradeMarkers(trades, timeOf) {
  const list = Array.isArray(trades) ? trades : [];
  const out = [];
  const tail = list.length > 1000 ? list.slice(list.length - 1000) : list;
  for (const tr of tail) {
    if (!tr || typeof timeOf !== 'function') continue;
    const et = timeOf(tr.entryBar);
    if (et == null) continue;
    const xt = timeOf(tr.exitBar);
    if (tr.dir < 0) {
      out.push({ time: et, position: 'aboveBar', shape: 'arrowDown', color: '#F23645', text: 'Sell' });
      if (xt != null) out.push({ time: xt, position: 'belowBar', shape: 'arrowUp', color: '#787B86', text: 'Exit' });
    } else {
      out.push({ time: et, position: 'belowBar', shape: 'arrowUp', color: '#2962FF', text: 'Buy' });
      if (xt != null) out.push({ time: xt, position: 'aboveBar', shape: 'arrowDown', color: '#787B86', text: 'Exit' });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

export { brokerInit, brokerClone, brokerFills, brokerGet, brokerAccount, strategyTradeField, pushBrokerBar, brokerStats, downsample, tradeGroups, tradesCsv, filterReport, paginate, excursionSpikes, runupDrawdown, tradeReturn, tradesAnalysis, perfSummary, tradeMarkers, fns as strategyFns };
