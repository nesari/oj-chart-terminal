/**
 * Pine interpreter â€” expression evaluation and calls (_tick.._runUserFn).
 *
 * Split out of core/pine/interpreter.js in F4.3. Method bodies are moved
 * verbatim and attached to PineRuntime.prototype by interpreter.js; no
 * logic changes.
 *
 * @module core/pine/interpreter/expressions
 */
import {
  NA, isNA, truthy, num, pineNum, PineColor, toColor, colorNew,
  makeEnumConst, isEnumConst, enumPayload,
} from '../types.js';
import { SeriesBuf } from '../scope.js';
import { PineError, runtimeError, loopError } from '../errors.js';
import { PineArray, isArray, arrNew, arrFrom, keyOf } from '../stdlib/array.js';
import { PineMatrix, isMatrix, matNew } from '../stdlib/matrix.js';
import { PineMap, isMap, mapNew } from '../stdlib/map.js';
import { taFns, taVars, cloneSite } from '../stdlib/ta.js';
import { mathFns, MATH_CONSTS, strFns } from '../stdlib/math.js';
import { colorFns, colorConsts } from '../stdlib/color.js';
import { VisualStore, lineNew, boxNew, labelNew, polylineNew, linefillNew, mergeArgs, SIZE_MAP, sizeOf, tableNew, tableCell, tableClear, tableMerge, tablePos, tableSetBgcolor, tableSetBorderColor, tableSetBorderWidth, tableSetFrameColor, tableSetFrameWidth } from '../stdlib/objects.js';
import { securityLowerTf, tfSeconds } from '../stdlib/request.js';
import { securityHigherTf } from '../stdlib/request-security.js';
import { sessionFns, timeInSession } from '../stdlib/session.js';
import { tickerNew, tickerHeikinashi, tickerRenko, tickerLinebreak, tickerKagi, tickerPointfigure, isTicker, haTransform } from '../stdlib/ticker.js';
import { brokerInit, brokerClone, brokerFills, brokerGet, strategyTradeField, pushBrokerBar, brokerStats, strategyFns } from '../stdlib/strategy.js';
import { makeInputFn, strInput, sourceInput, BUILTIN_SOURCES } from '../stdlib/inputs.js';
import {
  tzParts, exParts, daysInMonth, timestamp, timenow,
} from '../stdlib/time.js';
import {
  SYNTH_TICKER, normCurrency, NS_PARAMS, mergeNsArgs, mergeMethodArgs,
  recordMissing, MAX_BARS_BACK, isoWeek, BREAK, CONTINUE, OHLCV_BARS_BACK,
  HTF_BUILTINS, srcHandle, LIB_BANNED_IDENTS, LIB_BANNED_NS,
} from './common.js';

const expressions = {
  _tick() {
    if (++this.steps > this.maxOpsPerBar) {
      throw loopError(`script exceeded the per-bar execution budget (${this.maxOpsPerBar} steps)`);
    }
  },

  eval(node, frame) {
    switch (node.kind) {
      case 'num': return node.v;
      case 'str': return node.v;
      case 'colorlit': { const c = toColor(node.v); return c || NA; }
      case 'bool': return node.v;
      case 'na': return NA;
      case 'paren': return this.eval(node.expr, frame);
      case 'arraylit': return new PineArray('any', node.items.map((it) => this.eval(it, frame)));
      case 'ident': return this._evalIdent(node, frame);
      case 'un': return this._evalUnary(node, frame);
      case 'bin': return this._evalBinary(node, frame);
      case 'ternary': return this._evalTernary(node, frame);
      case 'index': return this._evalIndex(node, frame);
      case 'member': return this._evalMember(node, frame);
      case 'call': return this._evalCall(node, frame);
      case 'if': return this._evalIf(node, frame);
      case 'switch': return this._evalSwitch(node, frame);
      default:
        throw runtimeError(`internal: cannot evaluate node kind '${node.kind}'`);
    }
  },

  _htfBucketRead(name, off) {
    const site = this._htfActiveSite ? this.sites.get(this._htfActiveSite) : null;
    const tape = site && site.tape;
    if (!tape || off < 1 || off > tape.length) return NA;
    const b = tape[tape.length - off];
    if (!b) return NA;
    switch (name) {
      case 'open': case 'high': case 'low': case 'close': case 'volume':
        return (typeof b[name] === 'number' && isFinite(b[name])) ? b[name] : NA;
      /* ROUND199 (HTF time unit): bucket tapes store chart-feed SECONDS —
         script `time` is epoch ms (TV parity with the chart frame). */
      case 'time':
        return (typeof b.time === 'number' && isFinite(b.time)) ? b.time * 1000 : NA;
      case 'hl2': return (isFinite(b.high) && isFinite(b.low)) ? (b.high + b.low) / 2 : NA;
      case 'hlc3': return (isFinite(b.high) && isFinite(b.low) && isFinite(b.close)) ? (b.high + b.low + b.close) / 3 : NA;
      case 'ohlc4': return (isFinite(b.open) && isFinite(b.high) && isFinite(b.low) && isFinite(b.close)) ? (b.open + b.high + b.low + b.close) / 4 : NA;
      case 'hlcc4': return (isFinite(b.high) && isFinite(b.low) && isFinite(b.close)) ? (b.high + b.low + 2 * b.close) / 4 : NA;
      default: return undefined;
    }
  },

  _htfBuiltin(name) {
    const htf = this._htfOverride;
    if (!htf) return undefined;
    const f = (v) => (typeof v === 'number' && isFinite(v) ? v : NA);
    switch (name) {
      case 'open': case 'high': case 'low': case 'close': case 'volume':
        return f(htf[name]);
      /* ROUND199 (HTF time unit): the aggregate carries chart-feed SECONDS —
         script `time` is epoch ms (TV parity with the chart frame). */
      case 'time':
        return (typeof htf.time === 'number' && isFinite(htf.time)) ? htf.time * 1000 : NA;
      case 'hl2': return (isFinite(htf.high) && isFinite(htf.low)) ? (htf.high + htf.low) / 2 : NA;
      case 'hlc3': return (isFinite(htf.high) && isFinite(htf.low) && isFinite(htf.close)) ? (htf.high + htf.low + htf.close) / 3 : NA;
      case 'ohlc4': return (isFinite(htf.open) && isFinite(htf.high) && isFinite(htf.low) && isFinite(htf.close)) ? (htf.open + htf.high + htf.low + htf.close) / 4 : NA;
      case 'hlcc4': return (isFinite(htf.high) && isFinite(htf.low) && isFinite(htf.close)) ? (htf.high + htf.low + 2 * htf.close) / 4 : NA;
      default: return undefined;
    }
  },

  _evalIdent(node, frame) {
    const name = node.name;
    // intrabar override (request.security_lower_tf evaluation context)
    const ov = this._intrabarOverride;
    if (ov) {
      switch (name) {
        case 'open': return ov.open; case 'high': return ov.high;
        case 'low': return ov.low; case 'close': return ov.close;
        case 'volume': return ov.volume;
        /* ROUND78 (timezone): intrabar times are fed in the broker wall
           clock (ms) — shift to true UTC exactly like the chart series */
        case 'time': return ov.time - this.env.serverOffSec * 1000;
        case 'hl2': return (ov.high + ov.low) / 2;
        case 'hlc3': return (ov.high + ov.low + ov.close) / 3;
        case 'ohlc4': return (ov.open + ov.high + ov.low + ov.close) / 4;
      }
    }
    /* request.security HTF evaluation context: the 12 builtin series read
       the aggregate bar — BEFORE the globals lookup (builtins always own
       global recs; a post-lookup check silently evaluated complex
       security() expressions in the CHART frame). */
    const htfVal = this._htfBuiltin(name);
    if (htfVal !== undefined) return htfVal;
    const rec = this._lookup(frame, name);
    if (rec) return rec.value;
    if (name === 'barstate') return this._barstateProxy();
    if (name === 'timenow') return timenow();
    /* last-bar constants (v5/v6): known only at the last bar of loaded history */
    if (name === 'last_bar_index') return this.env.lastBarIndex != null ? this.env.lastBarIndex : this.barIndex;
    /* TV parity: last_bar_time is the OPEN time of the LAST historical bar in
       MILLISECONDS (same frame as `time`) — env.bar.time is the raw feed
       stamp in seconds, so scale it like barTimeMs (round78 server offset). */
    if (name === 'last_bar_time') {
      if (this.env.lastBarTime != null) return this.env.lastBarTime;
      return this.env.bar ? (this.env.bar.time - this.env.serverOffSec) * this.env.timeScale : NA;
    }
    // bare time getters (year, hour, ...) without a call — bar-time forms
    /* ROUND222a (v4 parity): bare series vars (plot(accdist)) read through
       taVars with a per-node site, like the ta.* member path. They used to
       fall into the plainFns-NA branch below (silent blank plot). taVars
       wins over plainFns here: an ident READ is a series value, while
       plainFns only serve CALLS (dispatched separately). */
    if (taVars[name]) {
      const site = this._site(this._frameKey(frame) + ':tav:' + node.id, {});
      if (!site.env) site.env = this.env;
      return taVars[name](site);
    }
    if (this.plainFns[name]) return NA; // function referenced as value
    // bare color names (v4 legacy): lime, maroon, aqua, ... — same palette as color.*
    if (colorConsts[name]) {
      /* ROUND225: v6 re-tones ride the same gate as color.* (see _constPath). */
      const tones = (this.version || 5) >= 6
        ? { red: '#f23645', teal: '#089981', yellow: '#fdd835' }
        : { red: '#ff5252', teal: '#00897b', yellow: '#ffeb3b' };
      if (tones[name]) return toColor(tones[name]);
      return colorConsts[name];
    }
    // v4 bare style word `style=line` (also `histogram`, `cross` in _consts)
    if (name === 'line') return makeEnumConst('line', 'plotstyle');
    /* v4 legacy bare TYPE TAGS used as values (`type=resolution`) — they only
       matter as markers inside input(...) and eval before the handler runs. */
    if (name === 'resolution' || name === 'period') return { __nsTag: 'input.resolution' };
    /* v4 bare `tickerid` (== syminfo.tickerid) and chart-TF `period` string */
    if (name === 'tickerid') return this._syminfoProp('tickerid');
    throw runtimeError(`Undeclared identifier '${name}'`);
  },

  _barstateProxy() {
    const rt = this;
    if (!rt._bs) {
      rt._bs = {};
    }
    const i = rt.barIndex, n = rt.totalBars;
    rt._bs.isfirst = n ? i === 0 : true;
    rt._bs.islast = n ? i === n - 1 : true;
    rt._bs.ishistory = !rt.isForming;
    rt._bs.isrealtime = rt.isForming;
    rt._bs.isnew = rt.isForming;
    rt._bs.islastconfirmedhistory = n ? (i === n - 1 && !rt.isForming) : false;
    rt._bs.isconfirmed = !rt.isForming;
    return rt._bs;
  },

  _evalUnary(node, frame) {
    const v = this.eval(node.a, frame);
    if (node.op === '-') return isNA(v) ? NA : (typeof v === 'number' ? -v : NA);
    if (node.op === '+') return v;
    if (node.op === 'not') {
      if (isNA(v)) return NA;
      return !this._cond(v, "'not' operand");
    }
    return NA;
  },

  _cond(v, where) {
    if (this.version >= 6 && !isNA(v) && typeof v !== 'boolean') {
      const got = v && v.css ? 'color' : (v && v.__pineArray ? 'array' : (v && v.__pineMatrix ? 'matrix' : (v && v.__pineMap ? 'map' : (v && v.__pineObj ? v.kind : typeof v))));
      throw runtimeError(`v6: ${where} needs a bool value (got ${got}); use an explicit comparison or bool()`);
    }
    return truthy(v);
  },

  _evalBinary(node, frame) {
    const op = node.op;
    if (op === 'and' || op === 'or') {
      /* ROUND150 (TV parity): short-circuit with Kleene na-logic. A decisive
         plain operand settles the result WITHOUT evaluating the other side
         (TV skips it — ta.* inside must not advance, guarded throws must not
         fire). na propagates only when nothing decisive was seen:
         false-and-na -> false, true-or-na -> true, na-and-na -> na. */
      const a = this.eval(node.a, frame);
      if (op === 'and') {
        this._cond(a, "'and' operand"); // ROUND152: v6 bool gate (na passes)
        if (!isNA(a) && !truthy(a)) return false; // decisive: b never runs
        const b = this.eval(node.b, frame);
        this._cond(b, "'and' operand");
        if (!isNA(a) && !isNA(b)) return truthy(a) && truthy(b);
        // na involved: plain false dominates, else na
        if ((!isNA(a) && !truthy(a)) || (!isNA(b) && !truthy(b))) return false;
        return NA;
      }
      this._cond(a, "'or' operand"); // ROUND152: v6 bool gate (na passes)
      if (!isNA(a) && truthy(a)) return true; // decisive: b never runs
      const b = this.eval(node.b, frame);
      this._cond(b, "'or' operand");
      if (!isNA(a) && !isNA(b)) return truthy(a) || truthy(b);
      // na involved: plain true dominates, else na
      if ((!isNA(a) && truthy(a)) || (!isNA(b) && truthy(b))) return true;
      return NA;
    }
    const a = this.eval(node.a, frame);
    const b = this.eval(node.b, frame);
    switch (op) {
      case '==': return this._eq(a, b);
      case '!=': return !this._eq(a, b);
      case '<': case '<=': case '>': case '>=': return this._cmp(op, a, b);
      default: return this._binop(op, a, b, node);
    }
  },

  _eq(a, b) {
    if (isNA(a) || isNA(b)) return NA;
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b);
    if (typeof a === 'string' && typeof b === 'string') return a === b;
    if (a && a.css && b && b.css) return a.eq(b);
    if (isEnumConst(a) || isEnumConst(b)) {
      /* ROUND165: a dialog-persisted input.string(size.tiny,...) comes back
         as the payload string 'tiny' — TV compares it equal to size.tiny. */
      if (isEnumConst(a) && typeof b === 'string') return enumPayload(a) === b;
      if (isEnumConst(b) && typeof a === 'string') return enumPayload(b) === a;
      return enumPayload(a) === enumPayload(b) && (a && a.kind) === (b && b.kind);
    }
    if (a && a.__pineObj && b && b.__pineObj) return a.id === b.id;
    if (isArray(a) && isArray(b)) return a === b;
    return a === b;
  },

  _cmp(op, a, b) {
    if (isNA(a) || isNA(b)) return NA;
    if (typeof a === 'string' && typeof b === 'string') {
      switch (op) { case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b; }
    }
    const x = num(a), y = num(b);
    if (!isFinite(x) || !isFinite(y)) return NA;
    switch (op) { case '<': return x < y; case '<=': return x <= y; case '>': return x > y; case '>=': return x >= y; }
    return NA;
  },

  _binop(op, a, b, node) {
    /* ROUND151: display-flag arithmetic (`display.all - display.status_line`,
       used by LuxAlgo Sessions). TV display constants behave as numbers;
       house bit rule: none=0, data_window=1, price_scale=2, status_line=4,
       pane=8, all=15. Only arithmetic results carry numeric payloads —
       existing string payloads are untouched. */
    if ((op === '+' || op === '-') && isEnumConst(a) && isEnumConst(b) && a.kind === 'display' && b.kind === 'display') {
      const bits = { none: 0, data_window: 1, price_scale: 2, status_line: 4, pane: 8, all: 15 };
      const x = bits[a.payload], y = bits[b.payload];
      if (x == null || y == null) return NA;
      return makeEnumConst(op === '+' ? x + y : x - y, 'display');
    }
    if (op === '+' && (typeof a === 'string' || typeof b === 'string')) {
      if (isNA(a) || isNA(b)) return NA;
      const sa = a && a.css ? a.css() : String(a);
      const sb = b && b.css ? b.css() : String(b);
      return sa + sb;
    }
    const x = num(a), y = num(b);
    if (!isFinite(x) || !isFinite(y)) return NA;
    switch (op) {
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      /* ROUND197 (legacy int-div): v<6 `int / int` truncates toward zero
         (7/2=3, -7/2=-3); v6 always floats. The stamp comes from the
         compile-time int-typing pass (inttype.js) — unstamped nodes (v6,
         unknown types) keep float division. */
      case '/': {
        if (y === 0) return NA;
        const q = x / y;
        if (node && node.legacyTrunc && this.version < 6) return Math.trunc(q);
        return q;
      }
      case '%': return y === 0 ? NA : x % y;
    }
    return NA;
  },

  _evalTernary(node, frame) {
    /* ROUND150 (TV parity): LAZY — the condition runs first and only the
       taken branch executes. The old code ran both branches (and even ran
       them BEFORE the condition), so ta.* calls inside an untaken branch
       still advanced their history — silently different numbers from TV,
       where the official v4->v5 guide says to hoist ta.* out of ?: exactly
       because untaken branches never run. */
    const c = this.eval(node.cond, frame);
    // na condition behaves as false (same as if/truthy and TradingView) —
    // it must NOT poison the result, or self-referential ratchets never start.
    return this._cond(c, "'?:' condition") ? this.eval(node.a, frame) : this.eval(node.b, frame);
  },

  _evalIf(node, frame) {
    const c = this.eval(node.cond, frame);
    if (this._cond(c, "'if'")) return this._blockValue(node.then, frame);
    if (node.els) return this._blockValue(node.els, frame);
    return NA;
  },

  _evalSwitch(node, frame) {
    let subject = null;
    if (node.subject) subject = this.eval(node.subject, frame);
    for (const cs of node.cases) {
      if (cs.cond.kind === 'default') return this._blockValue(cs.value, frame);
      const cv = this.eval(cs.cond, frame);
      const hit = node.subject ? this._eq(subject, cv) : this._cond(cv, "'switch' case");
      if (hit === true) return this._blockValue(cs.value, frame);
    }
    return NA;
  },

  _evalIndex(node, frame) {
    const base = this.eval(node.base, frame);
    const idx = this.eval(node.idx, frame);
    if (isArray(base)) {
      if (isNA(idx) || typeof idx !== 'number') return NA;
      return base.get(idx);
    }
    // history operator
    const off = isNA(idx) ? 0 : Math.trunc(num(idx));
    if (off < 0) return NA;
    /* ROUND238 (TV parity): v6 bans [] DIRECTLY on UDT fields — the history
       must go on the object ((obj[k]).field, which rides rec.hist). The
       parser cannot tell a UDT instance from a chart.point (R215 pins
       p.price[1]), so the gate lives HERE at runtime: root the member chain
       to its leftmost ident and check the live value — UDT instances carry
       __pineObj+__udt, points carry kind 'point'. Array-valued fields keep
       the element path above (legal indexing, not history); non-ident roots
       (calls, parens) stay lenient; older versions keep the generic buffer. */
    if (node.base.kind === 'member' && (this.version || 5) >= 6 && !isArray(base)) {
      let root = node.base;
      while (root && root.kind === 'member' && root.base) root = root.base;
      if (root && root.kind === 'ident') {
        const rrec = this._lookup(frame, root.name);
        const rv = rrec && rrec.value;
        if (rv && rv.__pineObj && rv.__udt) {
          throw runtimeError('History ([]) cannot reference UDT fields directly in v6 — use (obj[k]).field instead');
        }
      }
    }
    if (node.base.kind === 'ident') {
      /* ROUND160: inside request.security, builtin OHLCV history reads the
         HTF bucket tape (close[1] = previous HTF close), and [0] is the
         running aggregate — never the chart frame. Non-builtins keep the
         chart-frame behavior (documented leniency). */
      if (this._htfOverride && this._htfActiveSite && HTF_BUILTINS.has(node.base.name)) {
        if (off === 0) return this._htfBuiltin(node.base.name);
        return this._htfBucketRead(node.base.name, off);
      }
      const rec = this._lookup(frame, node.base.name);
      if (rec) {
        if (off === 0) return rec.value; // x[0] == current (partial) value
        /* ROUND138 (BUG: every Buy/Sell fired TWICE): rec.hist holds
           end-of-bar finals pushed in _finalizeBarOutputs, so DURING bar N
           it ends at bar N-1 — x[1] is hist.get(0), x[k] is get(k-1).
           The old get(off) read N-2 for [1]: trend[1]/up[1]/dn1 (and even
           close[1]) all lagged one extra bar, so each flip condition stayed
           true for two consecutive bars and plotshape double-fired. */
        if (rec.hist) return rec.hist.get(off - 1);
        /* ROUND204: idents WITHOUT a SeriesBuf (function params, loop vars)
           used to read na for any [k>0] — edge detectors like
           `x and not x[1]` on parameters never fired (sessions.pine drew
           nothing). First delegate along ident-valued params (TV inlines
           calls, so `x[k]` is the SOURCE's history); chains resolve with a
           visited set. Whatever remains uses the general per-site buffer. */
        let cur = rec, seen = null;
        while (cur && !cur.hist && cur.srcIdent) {
          if (!seen) seen = new Set();
          if (seen.has(cur)) break;
          seen.add(cur);
          const s = this._lookup(frame, cur.srcIdent);
          cur = (s && s !== cur) ? s : null;
        }
        if (cur && cur.hist) return cur.hist.get(off - 1);
      } else {
        return NA;
      }
    }
    // general expression history: per-(frame,node) buffer of {bar, val}
    const key = this._frameKey(frame) + ':' + node.base.id + ':h';
    let buf = this.histBufs.get(key);
    if (!buf) { buf = []; this.histBufs.set(key, buf); }
    if (!buf.length || buf[buf.length - 1].b !== this.barIndex) {
      buf.push({ b: this.barIndex, v: base });
      if (buf.length > this.maxBarsBack) buf.shift();
    } else {
      buf[buf.length - 1].v = base; // last evaluation this bar wins
    }
    const target = this.barIndex - off;
    for (let k = buf.length - 1; k >= 0; k--) {
      if (buf[k].b === target) return buf[k].v;
      if (buf[k].b < target) break;
    }
    return NA;
  },

  _evalMember(node, frame) {
    // dotted access: namespace constants, color.white, barstate.islast, object props
    if (node.base.kind === 'ident') {
      const base = node.base.name;
      /* ROUND195: library-mode read gate (strategy.* getters are reads, not
         calls — the _evalCall gate never sees them). */
      if (this.isLibrary && LIB_BANNED_NS.has(base)) {
        throw runtimeError(`'${base}.${node.name}' cannot be used in a library ('${(this.meta && this.meta.title) || 'library'}') — move it to the importing indicator/strategy`);
      }
      /* ROUND195: imported-library variable — `Alias.CONST` reads the library
         global's current-bar value (the `[k]` history operator applies on top
         through the standard expression buffers). */
      const lib = this.libs ? this.libs.get(base) : null;
      if (lib) return this._readLib(lib, base, node.name, node);
      const cst = this._constPath(base, node.name);
      if (cst !== undefined) return cst;
      if (base === 'barstate') {
        const bs = this._barstateProxy();
        return bs[node.name];
      }
      if (base === 'syminfo') return this._syminfoProp(node.name);
      if (base === 'timeframe') return this._timeframeProp(node.name);
      /* ROUND229 (TV parity): session.isfirstbar/islastbar(+_regular) read
         as VARIABLES (no call) — each member node owns a site like taVars. */
      if (base === 'session' && sessionFns[node.name] &&
          (node.name === 'isfirstbar' || node.name === 'islastbar' ||
           node.name === 'isfirstbar_regular' || node.name === 'islastbar_regular')) {
        const site = this._site(this._frameKey(frame) + ':sess:' + node.id, {});
        if (!site.env) site.env = this.env;
        return sessionFns[node.name](site);
      }
      /* ROUND171 (phase 2a: backtester): strategy.* live getters. Constants
         (strategy.long/short) resolved above via _constPath. Unknown names
         fall through to the __nsTag marker (loud on call, as before). */
      if (base === 'strategy') {
        if (node.name === 'risk') {
          throw runtimeError('strategy.risk is a function namespace, not a value — call strategy.risk.allow_entry_in/max_drawdown/... instead');
        }
        const gv = brokerGet(this, node.name);
        if (gv !== undefined) {
          if (!this.meta.isStrategy) throw runtimeError(`strategy.${node.name} only in strategy scripts`);
          return gv;
        }
      }
      /* chart.point — the v5/v6 point object referenced as `chart.point.new(...)`:
         the member base 'chart' + name 'point' resolves to the point factory. */
      /* ROUND140: line.all / box.all / label.all — read-only snapshot of the live
         objects (oldest first), as in the docs. */
      if (node.name === 'all' && (base === 'line' || base === 'box' || base === 'label' || base === 'polyline' || base === 'linefill')) {
        return new PineArray(base, [...this.store[base].values()]);
      }
      if (base === 'chart' && node.name === 'point') {
        return this.nsFns.chart.point;
      }
      if (base === 'chart') {
        if (node.name === 'is_standard') return true;
        if (node.name === 'is_heikinashi') return this.opts.symbol && false;
        /* ROUND216 (TV parity): chart theme colors. The renderer wires the
           live theme through env (pine-ui createInstance opts); the engine
           fallbacks match the dark factory theme. */
        if (node.name === 'fg_color') return toColor(this.env.chartFg || '#d1d4dc') || NA;
        if (node.name === 'bg_color') return toColor(this.env.chartBg || '#0f0f0f') || NA;
        return NA;
      }
      if (base === 'math' && MATH_CONSTS[node.name] != null) return MATH_CONSTS[node.name];
      /* namespace itself referenced as a value (v6 series tags like bare
         `ta.tr` in a ternary branch): hand back a CALLABLE marker — the
         interpreter resolves `ta.<fn>` again at call sites, so for series
         reads we surface the ta function mapped to this property. */
      /* ROUND154: cumulative ta.* series variables (obv/pvt/wad/wvad/accdist)
         read as member VALUES (`ta.obv`, no call). Each member node owns its
         site (independent yet identical accumulators); plain-number state
         snapshots/rolls back with the standard machinery. */
      if (base === 'ta' && taVars[node.name]) {
        const site = this._site(this._frameKey(frame) + ':tav:' + node.id, {});
        if (!site.env) site.env = this.env;
        return taVars[node.name](site);
      }
      if (base === 'ta' && taFns[node.name]) return taFns[node.name];
      if (base === 'input' || base === 'strategy' || base === 'plot') {
        // `input.float` / `input.integer` / bare `resolution` type tag (v4) —
        // a namespaced TYPE tag used as a value; hand back a plain marker the
        // input-handler understands.
        return { __nsTag: base + '.' + node.name };
      }
      if (node.name === 'resolution' && base === 'resolution') return { __nsTag: 'input.resolution' };
      /* enum member access: Mode.A — the base is an __enumType global */
      const baseRec = this._lookup(frame, base);
      if (baseRec && baseRec.value && baseRec.value.__enumType) {
        const vals = this.enums && this.enums.get(baseRec.value.__enumType);
        if (vals && node.name in vals) return vals[node.name];
        throw runtimeError(`Unknown enum member '${base}.${node.name}'`);
      }
      /* UDT static member (rare) — fall through */
    }
    // value property access (rare in practice)
    /* ROUND172 (phase 2b): nested strategy constants (strategy.commission.*)
       — the ident fast path above only covers one level. */
    if (node.base.kind === 'member' && node.base.base && node.base.base.kind === 'ident' && node.base.base.name === 'strategy') {
      const cst2 = this._consts['strategy.' + node.base.name + '.' + node.name];
      if (cst2 !== undefined) return cst2;
      /* ROUND223 (TV parity): the argless v6 accessor
         `strategy.closedtrades.first_index` reads as a VALUE (no call) —
         route like the call form with no index. */
      if (node.base.name === 'closedtrades' && node.name === 'first_index') {
        return strategyTradeField(this, 'closed', 'first_index', undefined);
      }
      /* ROUND229 (TV parity): strategy.opentrades.capital_held reads as a
         VALUE (v6 reference) — same guard as the other strategy getters. */
      if (node.base.name === 'opentrades' && node.name === 'capital_held') {
        if (!this.meta.isStrategy) throw runtimeError('strategy.opentrades.capital_held only in strategy scripts — declare strategy() instead of indicator()');
        if (this.dry) return NA;
        return brokerGet(this, 'opentrades.capital_held');
      }
    }
    const baseV = this.eval(node.base, frame);
    if (baseV && baseV.__pineObj) {
      if (baseV.__udt) return baseV.fields[node.name] !== undefined ? baseV.fields[node.name] : NA; // UDT field read
      /* ROUND215 (TV parity): chart.point fields are directly readable
         (`closePoint.price > openPoint.price` in the official docs). An
         unset slot (from_index has no time) reads na; unknown names are
         loud like the named-arg discipline (rounds 208-209). */
      if (baseV.kind === 'point') {
        if (node.name === 'time' || node.name === 'index' || node.name === 'price') {
          const pv = baseV[node.name];
          return pv == null ? NA : pv;
        }
        throw runtimeError(`Unknown chart.point field '${node.name}' (expected time, index or price)`);
      }
      return NA; // drawing-object field reads go through get_* functions
    }
    // enum member via evaluated base (e.g. alias)
    if (baseV && baseV.__enumType) {
      const vals = this.enums && this.enums.get(baseV.__enumType);
      if (vals && node.name in vals) return vals[node.name];
    }
    return NA;
  },

  _syminfoProp(name) {
    const env = this.env;
    switch (name) {
      case 'ticker': case 'tickerid': return env.symbol;
      case 'mintick': return env.mintick;
      case 'type': return 'forex';
      case 'currency': return 'USD';
      case 'description': return env.symbol;
      case 'session': return '0000-0000';
      case 'timezone': return 'GMT';
      case 'minmove': return 1;
      case 'pricescale': return Math.round(1 / env.mintick);
      case 'pointvalue': return 1;
      case 'root': return env.symbol;
      /* ROUND223 (TV parity): main_tickerid is the chart symbol here (no
         futures continuous-contract machinery); basecurrency parses classic
         6-letter forex names (EURUSD->EUR), else na. prefix/mincontract/
         current_contract/isin need exchange metadata this feed has not —
         documented na. */
      case 'main_tickerid': return env.symbol;
      case 'basecurrency': {
        const s = String(env.symbol || '').replace(/^[A-Z]+:/, '');
        const m = /^([A-Z]{3})([A-Z]{3})([./-].*)?$/.exec(s);
        return m ? m[1] : NA;
      }
      case 'basecurrency': return NA;
      case 'prefix': return NA;
      case 'limit': return NA;
      default: return NA;
    }
  },

  _timeframeProp(name) {
    const sec = this.env.tfSec;
    switch (name) {
      /* ROUND206 (TV parity): seconds charts ("15S"), week/month multiples
         ("2W", "3M") and day multiples ("2D") — the old code printed "0" for
         sub-minute charts and "M" for any 2W+ chart, and multiplier divided
         everything by 86400 (1M -> 30). */
      case 'period':
        if (sec < 60) return sec + 'S';
        /* ROUND225 (TV parity): v6 period always carries the multiplier
           ("1D", not "D"); older versions keep the bare unit. */
        if ((this.version || 5) >= 6) {
          if (sec % 2592000 === 0) return (sec / 2592000) + 'M';
          if (sec % 604800 === 0) return (sec / 604800) + 'W';
          if (sec % 86400 === 0) return (sec / 86400) + 'D';
          return String(Math.round(sec / 60));
        }
        if (sec % 2592000 === 0) { const m = sec / 2592000; return m === 1 ? 'M' : m + 'M'; }
        if (sec % 604800 === 0) { const w = sec / 604800; return w === 1 ? 'W' : w + 'W'; }
        if (sec % 86400 === 0) { const d = sec / 86400; return d === 1 ? 'D' : d + 'D'; }
        return String(Math.round(sec / 60));
      case 'multiplier':
        if (sec < 60) return sec;
        if (sec % 2592000 === 0) return sec / 2592000;
        if (sec % 604800 === 0) return sec / 604800;
        if (sec % 86400 === 0) return sec / 86400;
        return Math.round(sec / 60);
      /* ROUND227 (TV parity, verified against the v6 reference): main_period
         is the script's MAIN timeframe in "<quantity>[<unit>]" form ("10S",
         "30", "240", "1D", "2W", "3M" — no unit for minutes, hours in
         minutes). Unlike period it never follows request.* contexts, so it
         reads the RUN tf (ROUND231 _runTfSec pin) instead of env.tfSec. */
      case 'main_period': {
        const rs = (this._runTfSec != null) ? this._runTfSec : sec;
        if (rs < 60) return rs + 'S';
        if (rs % 2592000 === 0) return (rs / 2592000) + 'M';
        if (rs % 604800 === 0) return (rs / 604800) + 'W';
        if (rs % 86400 === 0) return (rs / 86400) + 'D';
        return String(Math.round(rs / 60));
      }
      case 'isintraday': return sec < 86400;
      case 'isminutes': return sec >= 60 && sec < 3600 || (sec < 60);
      case 'isseconds': return sec < 60;
      case 'isdwm': return sec >= 86400;
      case 'isdaily': return sec === 86400;
      case 'isweekly': return sec === 604800;
      case 'ismonthly': return sec >= 2592000;
      case 'in_seconds': return sec;
      default: return NA;
    }
  },

  _tfPeriodStart(tSec, tfArg) {
    /* Period-start (feed seconds) of the TF bucket containing bar time tSec
       — the `time(tf)` series timeframe.change() watches. Intraday TFs use
       the same epoch-floor grid as the security buckets; D/W/M use calendar
       grids in UTC (the engine's house timezone: syminfo.timezone is GMT).
       Multiples: nD day-grid, nW Monday-anchored week-grid, nM month-grid. */
    const str = String(tfArg == null ? '' : tfArg).trim();
    if (str === '') return tSec; // "" = chart TF: every bar is a new period
    const secSfx = /^(\d+)S$/i.exec(str);
    if (secSfx) { const s = parseInt(secSfx[1], 10); return s > 0 ? Math.floor(tSec / s) * s : tSec; }
    if (/^\d+$/.test(str)) { const s = parseInt(str, 10) * 60; return Math.floor(tSec / s) * s; }
    const m = /^(\d*)([MHDW])/i.exec(str);
    if (!m) return null; // unparseable: caller falls back to string compare
    const n = m[1] ? parseInt(m[1], 10) : 1;
    const u = m[2].toUpperCase();
    /* NOTE: bare digits and H are minutes/hours; "M" is MONTHS in TV (there
       is no minute-M suffix — minutes are bare numbers). This differs from
       the shared tfSeconds() helper (M=minutes, pre-existing); change() is
       fixed locally to stay regression-free. */
    if (u === 'H') return Math.floor(tSec / (n * 3600)) * (n * 3600);
    if (u === 'D') { const s = n * 86400; return Math.floor(tSec / s) * s; }
    if (u === 'M') return this._tfMonthStart(tSec, n);
    if (u === 'W') {
      // Monday 00:00 UTC grid (1970-01-05 was a Monday)
      const anchor = 4 * 86400, s = n * 604800;
      return anchor + Math.floor((tSec - anchor) / s) * s;
    }
    return null;
  },

  _tfMonthStart(tSec, n) {
    // first-of-month 00:00 UTC, stepping n months (1M/3M/12M)
    const d = new Date(tSec * 1000);
    const months = d.getUTCFullYear() * 12 + d.getUTCMonth();
    const base = Math.floor(months / n) * n;
    return Date.UTC(Math.floor(base / 12), base % 12, 1, 0, 0, 0) / 1000;
  },

  _timeframeChange(node, frame) {
    /* Call args ride as {name, value} wrappers (see _mergeCallArgs).
       ROUND208: the timeframe= named form maps to the same slot. */
    const wraps = node.args || [];
    for (const w of wraps) {
      if (w && w.name && w.name !== 'timeframe') throw runtimeError(`timeframe.change(): unknown argument '${w.name}'`);
    }
    const namedW = wraps.find((w) => w && w.name === 'timeframe');
    const aw = namedW || wraps[0];
    const a = aw && aw.value;
    /* No argument: the chart TF never changes mid-run (a switch is a full
       recalc), so this is constantly false — lenient, documented. */
    if (!a) return false;
    const cur = this.eval(a, frame);
    /* ROUND216 (TV parity): timeframe.change(tf) detects the TF period
       rolling over — `time(tf) != time(tf)[1]` (the docs' monthly detector
       is timeframe.change("1M"); KZP/SMC track D/W/M sessions with it).
       A literal "D" never changes as a STRING, so the old arg!=arg[1]
       compare was constantly false and whole indicators went dead. The
       period-start of the CURRENT arg value is compared against the
       previous bar's (so an alternating D/W series still flips every bar,
       and steady inputs stay false). Unparseable TFs keep the old string
       compare (lenient); na stays false. */
    const barT = (this.bars && this.bars[this.barIndex] && typeof this.bars[this.barIndex].time === 'number')
      ? this.bars[this.barIndex].time
      : Math.floor((this.env.barTimeMs || 0) / 1000);
    let curKey = null, useStr = false;
    if (isNA(cur)) return false;
    const ps = this._tfPeriodStart(barT, cur);
    if (ps == null) { curKey = 's:' + String(cur); useStr = true; }
    else curKey = 'p:' + String(cur) + ':' + ps;
    /* Own history lane for the argument (same {b, v} shape + snapshot cover
       as the general [k] buffers; ':chg' key keeps TF-switch tracking apart
       from expression history). Last evaluation this bar wins. */
    const key = this._frameKey(frame) + ':' + (a.id != null ? a.id : 'lit') + ':chg';
    let buf = this.histBufs.get(key);
    if (!buf) { buf = []; this.histBufs.set(key, buf); }
    if (!buf.length || buf[buf.length - 1].b !== this.barIndex) {
      buf.push({ b: this.barIndex, v: curKey });
      if (buf.length > 4) buf.shift();
    } else {
      buf[buf.length - 1].v = curKey;
    }
    let prev = null;
    for (let k = buf.length - 1; k >= 0; k--) {
      if (buf[k].b === this.barIndex - 1) { prev = buf[k].v; break; }
      if (buf[k].b < this.barIndex - 1) break;
    }
    /* Exactly `arg != arg[1]` (user-written form goes through _eq too, so
       na-handling matches by construction: no previous value -> false). */
    if (prev == null) return false;
    if (useStr || (typeof prev === 'string' && prev.charAt(0) === 's')) return curKey !== prev;
    return curKey !== prev;
  },

  _registerUDT(st) {
    if (!this.udts) this.udts = new Map();
    this.udts.set(st.name, st);
    // global TypeName.new(...) constructor — resolved in _evalCall
    this.globals.set(st.name, { value: { __udtType: st.name }, kind: 'plain', hist: null });
    this._gwEpoch++;
  },

  _registerEnum(st) {
    if (!this.enums) this.enums = new Map();
    // auto member values: 0,1,2,... unless explicitly assigned
    let next = 0;
    const vals = {};
    for (const m of st.members) {
      if (m.value != null) {
        const v = this._constEval(m.value);
        vals[m.name] = typeof v === 'number' ? v : next;
        next = (typeof v === 'number' ? v : next) + 1;
      } else {
        vals[m.name] = next++;
      }
    }
    this.enums.set(st.name, vals);
    this.globals.set(st.name, { value: { __enumType: st.name }, kind: 'plain', hist: null });
    this._gwEpoch++;
  },

  _constEval(node) {
    if (!node) return null;
    switch (node.kind) {
      case 'num': return node.v;
      case 'str': return node.v;
      case 'bool': return node.v;
      case 'un': {
        const v = this._constEval(node.operand);
        if (typeof v !== 'number') return null;
        return node.op === '-' ? -v : node.op === 'not' ? (v ? 0 : 1) : v;
      }
      default: return null;
    }
  },

  _udtNew(typeName, node, frame) {
    const decl = this.udts && this.udts.get(typeName);
    if (!decl) throw runtimeError(`Unknown type '${typeName}'`);
    const obj = { __pineObj: true, __udt: typeName, kind: 'udt', fields: {} };
    for (const f of decl.fields) {
      obj.fields[f.name] = (f.def != null) ? this.eval(f.def, frame) : NA;
    }
    // positional args fill fields in declaration order; named override after
    let idx = 0;
    const { positional, named } = this._mergeCallArgs(node, frame);
    for (const v of positional) {
      const f = decl.fields[idx++];
      if (!f) throw runtimeError(`Too many arguments for ${typeName}.new()`);
      obj.fields[f.name] = v;
    }
    for (const nm of named) {
      if (!(nm.name in obj.fields)) throw runtimeError(`Unknown field '${nm.name}' for type '${typeName}'`);
      obj.fields[nm.name] = nm.value;
    }
    return obj;
  },

  _pureFnCheck(fnNode) {
    const PURE_PLAIN = new Set(['na', 'nz', 'iff', 'int', 'float', 'bool', 'string', 'color',
      'timestamp', 'timenow', 'year', 'month', 'dayofmonth', 'dayofweek', 'hour', 'minute', 'second']);
    const PURE_NS = new Set(['math', 'str', 'color']);
    const SAFE_MEMBER = new Set(['syminfo', 'timeframe']);
    const locals = new Set((fnNode.params || []).map((p) => p.name));
    let ok = true;
    const walkExpr = (n) => {
      if (!ok || n == null) return;
      switch (n.kind) {
        case 'num': case 'str': case 'bool': case 'na': case 'colorlit': break;
        case 'paren': walkExpr(n.expr); break;
        case 'ident': break; // globals allowed — guarded at runtime by _gwEpoch
        case 'un': walkExpr(n.a); break;
        case 'bin': walkExpr(n.a); walkExpr(n.b); break;
        case 'ternary': walkExpr(n.cond); walkExpr(n.a); walkExpr(n.b); break;
        case 'member':
          if (!(n.base && n.base.kind === 'ident' && SAFE_MEMBER.has(n.base.name))) ok = false;
          break;
        case 'call': {
          const c = n.callee;
          if (c.kind === 'ident') {
            const uf = this.funcs.get(c.name);
            if (uf) { if (uf._pure !== true) ok = false; } // incl. recursion (not yet true)
            else if (!PURE_PLAIN.has(c.name)) ok = false;
          } else if (c.kind === 'member' && c.base && c.base.kind === 'ident') {
            if (!PURE_NS.has(c.base.name)) ok = false;
          } else ok = false;
          for (const a of (n.args || [])) walkExpr(a.value);
          break;
        }
        default: ok = false; // index (history operator), arraylit, method calls, ...
      }
    };
    const walkBlock = (blk) => {
      if (!ok || !blk || !blk.stmts) return;
      for (const st of blk.stmts) walkStmt(st);
    };
    const walkStmt = (st) => {
      if (!ok || st == null) return;
      switch (st.kind) {
        case 'decl':
          locals.add(st.name); walkExpr(st.value); break;
        case 'tupledecl':
          for (const nm of st.names) locals.add(nm);
          walkExpr(st.value); break;
        case 'assign':
          if (st.reassign && !locals.has(st.name)) { ok = false; return; } // := to non-local
          if (!st.reassign) locals.add(st.name); // `x = ...` declares a local
          walkExpr(st.value); break;
        case 'expr': walkExpr(st.expr); break;
        case 'if':
          walkExpr(st.cond); walkBlock(st.then);
          if (st.els) walkBlock(st.els);
          break;
        case 'for':
          walkExpr(st.from); walkExpr(st.to); if (st.by) walkExpr(st.by);
          walkBlock(st.body); break;
        case 'while':
          walkExpr(st.cond); walkBlock(st.body); break;
        case 'break': case 'continue': break;
        default: ok = false; // funcdecl, switch, anything unaudited
      }
    };
    walkBlock(fnNode.body);
    return ok;
  },

  _memoSig(v) {
    if (v === NA) return '~';
    const t = typeof v;
    if (t === 'number') return isFinite(v) ? String(v) : null;
    if (t === 'boolean') return v ? '1' : '0';
    if (t === 'string') return 's' + JSON.stringify(v);
    if (v && v.css) return 'c' + v.css();
    if (v && v.__pineEnum) return 'e' + v.payload;
    return null; // arrays / drawing objects / proxies — never memoized
  },

  _evalCall(node, frame) {
    this._tick();
    const callee = node.callee;
    /* ROUND195: libraries are computation-only (TV parity — loud, never
       silent). Plots/inputs/orders/drawings belong to the importing script. */
    if (this.isLibrary) this._gateLibCall(callee);

    // UDT constructor: TypeName.new(...) — TypeName resolves to a __udtType global
    if (callee.kind === 'member' && callee.base.kind === 'ident' && callee.name === 'new') {
      const baseRec = this._lookup(frame, callee.base.name);
      if (baseRec && baseRec.value && baseRec.value.__udtType) {
        return this._udtNew(baseRec.value.__udtType, node, frame);
      }
    }

    // namespaced function: ta.sma(...) — callee is a member of an ident
    /* ROUND186 (TV parity): strategy.opentrades.*(n) / strategy.closedtrades.*(n)
       per-trade fields — callee is a member of a member. risk.* stays loud. */
    if (callee.kind === 'member' && callee.base && callee.base.kind === 'member' &&
        callee.base.base && callee.base.base.kind === 'ident' && callee.base.base.name === 'strategy') {
      const sub = callee.base.name;
      if (sub === 'risk') {
        /* ROUND189: strategy.risk.* guards are implemented (see strategy.js
           risk table); misconfigurations stay loud, indicator use guarded. */
        if (!this.meta.isStrategy) throw runtimeError(`strategy.risk.${callee.name}() only in strategy scripts`);
        const { positional } = this._mergeCallArgs(node, frame);
        const site = this._site(this._frameKey(frame) + ':' + node.id, {});
        site.named = [];
        if (!site.env) site.env = this.env;
        const rtbl = strategyFns(this).risk || {};
        const rfn = rtbl[callee.name];
        if (!rfn) throw runtimeError(`Unknown function strategy.risk.${callee.name}()`);
        return rfn.call(null, site, ...positional);
      }
      if (sub === 'opentrades' || sub === 'closedtrades') {
        if (!this.meta.isStrategy) throw runtimeError(`strategy.${sub}.${callee.name}() only in strategy scripts`);
        const { positional } = this._mergeCallArgs(node, frame);
        return strategyTradeField(this, sub === 'opentrades' ? 'open' : 'closed', callee.name, positional[0]);
      }
    }
    if (callee.kind === 'member' && callee.base.kind === 'ident') {
      const ns = callee.base.name;
      const fnName = callee.name;
      /* FIRST: if the base is a USER VARIABLE (holds an array / UDT / drawing
         object), this is a value-method call `arr.push(...)`, NOT a namespace
         call — route to the method dispatch instead of the ns tables. */
      const baseRec = this._lookup(frame, ns);
      if (baseRec && baseRec.value != null && !(baseRec.value.__udtType || baseRec.value.__enumType)) {
        const self = baseRec.value;
        /* ROUND196: matrices/maps get the value-method path like arrays. */
        if (isArray(self) || isMatrix(self) || isMap(self) || (self && self.__pineObj)) {
          return this._methodCall(self, fnName, node, frame);
        }
      }
      /* ROUND195: imported-library namespace — `Alias.fn(...)` runs the
         library's function inside the library runtime (own series state,
         per-importer-call-site isolation). */
      const lib = this.libs ? this.libs.get(ns) : null;
      if (lib) return this._callLib(lib, fnName, node, frame);
      // special: request.security_lower_tf needs the RAW expression AST
      if (ns === 'request' && fnName === 'security_lower_tf') {
        return this._callLowerTf(node, frame);
      }
      /* ROUND223 (TV parity): request.security_heikinashi(sym, tf, expr,
         ...) — same validation as security, run over an HA ticker handle
         (the haMode machinery already exists, R202). */
      if (ns === 'request' && fnName === 'security_heikinashi') {
        const { positional, named } = this._mergeCallArgs(node, frame);
        const s0 = positional.length ? positional[0] : ((named.find((x) => x.name === 'symbol') || {}).value);
        const symStr = isNA(s0) ? '' : String(s0 == null ? '' : s0);
        const tick = isTicker(s0) ? s0 : tickerHeikinashi(symStr);
        const pos = positional.slice();
        pos[0] = tick;
        return this.requestFns.security(pos, named, node, frame);
      }
      /* ROUND156 (BUG: member-form request.security() ALWAYS threw): the ns
         table for 'request' is a stub, so every request.security(sym, tf,
         expr) died with "not supported" while the real implementation in
         requestFns.security sat unwired (only bare security() and lower_tf
         worked; corpus MTF calls survived purely inside untaken branches).
         Same-symbol HTF now executes for real; cross-symbol still throws
         loudly inside requestFns.security. */
      if (ns === 'request' && fnName === 'security') {
        const { positional, named } = this._mergeCallArgs(node, frame);
        return this.requestFns.security(positional, named, node, frame);
      }
      /* ROUND190: log.info/warning/error — Pine Logs collection (TV parity:
         formats + returns the string, collects per bar). */
      if (ns === 'log' && (fnName === 'info' || fnName === 'warning' || fnName === 'error')) {
        return this._fnLog(fnName, node, frame);
      }
      // input.* also needs its raw node for options= (already evaluated — fine)
      /* ROUND156 (migration error, TV parity): `when=` was removed from ALL
         strategy.* calls in v5 — gate it before the stub so v4 strategies
         get a migration hint instead of a generic "not supported". */
      if (ns === 'strategy' && node.args && node.args.some((a) => a.name === 'when')) {
        throw runtimeError(`strategy.${fnName}(): 'when' was removed in Pine v5 — move the condition into an enclosing 'if' block`);
      }
      const nsTable = this.nsFns[ns];
      if (nsTable) {
        const fn = nsTable[fnName];
        if (!fn) throw runtimeError(`Unknown function ${ns}.${fnName}()`);
        const { positional, named } = this._mergeCallArgs(node, frame);
        const site = this._site(this._frameKey(frame) + ':' + node.id, {});
        site.named = named; // named args ride on the site (object factories read them)
        if (!site.env) site.env = this.env; // ta fns read the current bar through it
        if (ns === 'array' && fnName === 'new') {
          // array.new<T>(...) — element type recovered from the source text
          site.elType = node.elType || 'any';
        }
        /* ROUND196: matrix.new<T> same single-type stamping; map.new<K, V>
           carries the pair (node.elTypes, stamped by the parser). */
        if (ns === 'matrix' && fnName === 'new') {
          site.elType = node.elType || 'any';
        }
        if (ns === 'map' && fnName === 'new') {
          site.elTypes = node.elTypes || null;
        }
        /* ROUND208 (named-args parity): fns listed in NS_PARAMS accept TV's
           canonical argument names (ta.sma(source=..., length=...),
           math.pow(base=..., exponent=...), ticker.renko(brick_size=...)).
           Named values fill positional slots the caller left empty; unknown
           names are loud (TV rejects them at compile — silent ignore used
           to compute wrong values, e.g. timeframe= dropped from security or
           source= dropped from ta.sma). Families with their own named
           readers (input/strategy/table/line-box-label factories, methods)
           are not listed and behave exactly as before. */
        const merged = mergeNsArgs(ns, fnName, positional, named);
        return fn.call(null, site, ...merged);
      }
      if (ns === 'input') {
        const fn = this.inputFns[fnName];
        if (!fn) throw runtimeError(`Unknown input function input.${fnName}()`);
        const site = this._site(this._frameKey(frame) + ':' + node.id, {});
        const { positional, named } = this._mergeCallArgs(node, frame);
        const restObj = {};
        for (const nm of named) restObj[nm.name] = nm.value;
        if (fnName === 'source') {
          return this._inputSource(site, node, positional, restObj, frame);
        }
        if (fnName === 'enum') {
          return this._inputEnum(site, node, positional, restObj);
        }
        const args = positional.slice();
        while (args.length < 2) args.push(undefined);
        args.push(restObj);
        return fn(site, args[0], args[1], args[2]);
      }
      // dynamic namespaces
      if (ns === 'syminfo') return this._syminfoProp(fnName); // syminfo.ticker as call? no — fallthrough
      /* ROUND165: timeframe.in_seconds() takes an optional timeframe string
         (SMC higherTimeframe('D')). Without it: chart TF; with it: parsed
         ('D'->86400, '15'->900). The arg used to be ignored, so e.g. a W1
         chart never skipped daily levels. */
      if (ns === 'timeframe' && (fnName === 'change' || typeof this._timeframeProp(fnName) !== 'undefined')) {
        /* ROUND206 (TV parity): timeframe.change(tf) — true when the argument
           differs from its previous-bar value (SMC FVG detects input-TF
           switches with it). Exactly `arg != arg[1]`: the arg's own history
           buffer (own key suffix, rollback-safe like the [k] buffers), Pine
           != semantics (na-safe via _eq). Used to fall into _timeframeProp's
           default and silently return na, so TF-switch resets never fired. */
        if (fnName === 'change') return this._timeframeChange(node, frame);
        /* ROUND223 (TV parity): timeframe.from_seconds(s) is the inverse of
           in_seconds — canonical shortest form (300->"5", 3600->"60",
           86400->"1D", 604800->"1W", 2592000->"1M", 15->"15S").
           ROUND225: v6 period always carries the multiplier ("1D"), older
           versions keep the bare unit ("D") — same split as period. */
        if (fnName === 'from_seconds') {
          const mg = this._mergeCallArgs(node, frame);
          const v = mg.positional.length ? mg.positional[0] : (mg.named.find((x) => x.name === 'seconds') || {}).value;
          const s = (typeof v === 'number' && isFinite(v)) ? Math.round(v) : -1;
          if (s <= 0) return NA;
          const v6 = (this.version || 5) >= 6;
          if (s % 2592000 === 0) { const m = s / 2592000; return (v6 || m !== 1) ? m + 'M' : 'M'; }
          if (s % 604800 === 0) { const w = s / 604800; return (v6 || w !== 1) ? w + 'W' : 'W'; }
          if (s % 86400 === 0) { const d = s / 86400; return (v6 || d !== 1) ? d + 'D' : 'D'; }
          if (s % 3600 === 0) return String(s / 60);
          if (s % 60 === 0) return String(s / 60);
          if (s < 60) return s + 'S';
          return NA;
        }
        if (fnName === 'in_seconds') {
          const mg = this._mergeCallArgs(node, frame);
          /* ROUND208: timeframe= named form. */
          const pos = mergeNsArgs('timeframe', 'in_seconds', mg.positional, mg.named);
          /* ROUND216: "" (and na/no-arg) mean the chart TF — KZP gates its
             whole body on timeframe.in_seconds("") <= timeframe.in_seconds(..)
             and TV resolves the empty string to the chart (like time()). */
          if (!pos.length || pos[0] == null || isNA(pos[0]) || String(pos[0]).trim() === '') {
            return this.env.tfSec || 60;
          }
          const s = tfSeconds(pos[0]);
          return s > 0 ? s : NA;
        }
        return this._timeframeProp(fnName);
      }
      throw runtimeError(`Unknown namespace '${ns}'`);
    }

    // plain function call
    if (callee.kind === 'ident') {
      const name = callee.name;
      const userFn = this.funcs.get(name);
      if (userFn) return this._callUser(userFn, node, frame);
      /* ROUND156: v4 bare security(symbol, resolution, expression[, lookahead,
         gaps]) — every v4 MTF script uses it. Aliased onto request.security:
         positional lookahead/gaps bools become the barmerge enums. */
      if (name === 'security') {
        const { positional, named } = this._mergeCallArgs(node, frame);
        const site = this._site(this._frameKey(frame) + ':' + node.id, {});
        if (!site.env) site.env = this.env;
        const withV4 = named.slice();
        const hasNamed = (n) => withV4.some((x) => x.name === n);
        if (positional.length > 3 && !hasNamed('lookahead') && typeof positional[3] === 'boolean') {
          withV4.push({ name: 'lookahead', value: makeEnumConst(positional[3] ? 'lookahead_on' : 'lookahead_off', 'barmerge'), line: node.line });
        }
        if (positional.length > 4 && !hasNamed('gaps') && typeof positional[4] === 'boolean') {
          withV4.push({ name: 'gaps', value: makeEnumConst(positional[4] ? 'gaps_on' : 'gaps_off', 'barmerge'), line: node.line });
        }
        return this.requestFns.security(positional.slice(0, 3), withV4, node, frame);
      }
      if (this.plainFns[name]) {
        const { positional } = this._mergeCallArgs(node, frame);
        const site = this._site(this._frameKey(frame) + ':' + node.id, {});
        if (!site.env) site.env = this.env; // ta kernels read the current bar through it
        return this.plainFns[name](site, ...positional);
      }
      if (name === 'time' && node.args && node.args.length >= 2) {
        /* ROUND204: bare time(timeframe, session[, tz]) is the SESSION
           overload (session-filtered bar time or na) — NOT the input.time
           picker. Route it here on (timeframe-like, session-like) shapes;
           anything else keeps the legacy bare-input tolerance below. */
        const { positional: tpos } = this._mergeCallArgs(node, frame);
        const tfA = tpos[0], sessA = tpos[1];
        const looksTf = tfA === '' || (typeof tfA === 'string' && tfSeconds(tfA) > 0);
        const looksSess = typeof sessA === 'string' && sessA.indexOf('-') >= 0;
        if (looksTf && looksSess) return this._timeSession(tpos);
      }
      /* ROUND223 (TV parity): time_close(timeframe, session[, tz]) mirrors
         time() but yields the bar's CLOSE time (open + TF span) when the bar
         belongs to the session, else na. */
      if (name === 'time_close' && node.args && node.args.length >= 2) {
        const { positional: cpos } = this._mergeCallArgs(node, frame);
        const tfC = cpos[0], sessC = cpos[1];
        const looksTf = tfC === '' || (typeof tfC === 'string' && tfSeconds(tfC) > 0);
        const looksSess = typeof sessC === 'string' && sessC.indexOf('-') >= 0;
        if (looksTf && looksSess) return this._timeSession(cpos, true);
      }
      if (this.inputFns[name]) { // input.* called WITHOUT namespace (unofficial but tolerated)
        const { positional, named } = this._mergeCallArgs(node, frame);
        const site = this._site(this._frameKey(frame) + ':' + node.id, {});
        const restObj = {};
        for (const nm of named) restObj[nm.name] = nm.value;
        const args = positional.slice();
        while (args.length < 2) args.push(undefined);
        args.push(restObj);
        return this.inputFns[name](site, args[0], args[1], args[2]);
      }
      if (name === 'input') { // legacy v4 bare `input(defval, title, type=..., defval=...)` — normalize to inputFns
        const { positional, named } = this._mergeCallArgs(node, frame);
        const site = this._site(this._frameKey(frame) + ':' + node.id, {});
        const restObj = {};
        for (const nm of named) restObj[nm.name] = nm.value;
        // v4: defval may come positionally OR via `defval=` named arg; `type=` decides the kind
        let defval = positional.length ? positional[0] : restObj.defval;
        const title = positional.length > 1 ? positional[1] : restObj.title;
        const tv = restObj.type;
        let kind = null;
        if (tv != null && !isNA(tv)) {
          // type=input.integer | type=bool | type=float | type=string | type=resolution | type=color ...
          const p = enumPayload(tv);
          kind = p || (typeof tv === 'string' ? tv : null);
        }
        if (kind == null) {
          /* ROUND142 (BUG: v4 `input(hl2, "Source")` showed a number box
             with "0"): the evaluated defval is just the current bar's hl2
             NUMBER, so kind inferred to float — the dialog showed the dry
             pass's 0 and any user edit pinned a dead constant. When the
             defval AST is a builtin source ident and no explicit type= was
             given, this is a SOURCE input (TV parity): route to
             _inputSource, which registers kind 'source' (dropdown) and
             resolves the chosen series per bar. */
          const defNode = node.args && node.args[0] && node.args[0].value;
          if (defNode && defNode.kind === 'ident' && BUILTIN_SOURCES.includes(defNode.name)) {
            return this._inputSource(site, node, positional, restObj, frame);
          }
          // infer from the defval value
          if (typeof defval === 'boolean') kind = 'bool';
          else if (typeof defval === 'number') kind = Number.isInteger(defval) ? 'int' : 'float';
          else if (defval && defval.css) kind = 'color';
          else kind = 'string';
        }
        // v4 `resolution` input behaves like a timeframe string
        if (kind === 'resolution') kind = 'string';
        // strip the v4-only named args the interpreter already consumed
        delete restObj.type; delete restObj.defval; delete restObj.title;
        const args = [defval, title];
        while (args.length < 2) args.push(undefined);
        args.push(restObj);
        const fn = this.inputFns[kind] || this.inputFns.string;
        return fn(site, args[0], args[1], args[2]);
      }
      if (this.visualFns[name]) {
        const { positional, named } = this._mergeCallArgs(node, frame);
        return this.visualFns[name]([positional, named, node]);
      }
      if (this.requestFns[name]) {
        const { positional, named } = this._mergeCallArgs(node, frame);
        return this.requestFns[name](positional, named, node, frame);
      }
      // type-cast style calls already covered; object constructor calls (UDT) not in MVP
      throw runtimeError(`Unknown function '${name}()'`);
    }

    // method-style call: obj.method(...)
    if (callee.kind === 'member') {
      const self = this.eval(callee.base, frame);
      return this._methodCall(self, callee.name, node, frame);
    }

    throw runtimeError('Unsupported call form');
  },

  _methodCall(self, methodName, node, frame) {
    const { positional, named } = this._mergeCallArgs(node, frame);
    {
      if (isArray(self)) {
        const fn = this._arrayFns()[methodName];
        if (!fn) throw runtimeError(`Unknown array method .${methodName}()`);
        const site = this._site(this._frameKey(frame) + ':' + node.id, {});
        site.named = named; // ROUND158-sweep: method-form named args (t.cell(text_color=...)) rode nowhere — factories saw []
        if (!site.env) site.env = this.env;
        /* ROUND209: canonical names fill empty slots (arr.get(index=...)). */
        const mArr = mergeMethodArgs('array', methodName, self, positional, named);
        return fn.call(null, site, ...mArr);
      }
      /* ROUND196: matrix/map value methods reuse the ns tables. */
      if (isMatrix(self)) {
        const fn = this._matrixFns()[methodName];
        if (!fn) throw runtimeError(`Unknown matrix method .${methodName}()`);
        const site = this._site(this._frameKey(frame) + ':' + node.id, {});
        site.named = named;
        if (!site.env) site.env = this.env;
        /* ROUND209 (see array branch). */
        const mMat = mergeMethodArgs('matrix', methodName, self, positional, named);
        return fn.call(null, site, ...mMat);
      }
      if (isMap(self)) {
        const fn = this._mapFns()[methodName];
        if (!fn) throw runtimeError(`Unknown map method .${methodName}()`);
        const site = this._site(this._frameKey(frame) + ':' + node.id, {});
        site.named = named;
        if (!site.env) site.env = this.env;
        /* ROUND209 (see array branch). */
        const mMap = mergeMethodArgs('map', methodName, self, positional, named);
        return fn.call(null, site, ...mMap);
      }
      if (self && self.__pineObj) {
        const nsTable = self.kind === 'line' ? this._lineFns() : self.kind === 'box' ? this._boxFns() : self.kind === 'table' ? this._tableFns() : self.kind === 'polyline' ? this._polylineFns() : self.kind === 'linefill' ? this._linefillFns() : self.kind === 'udt' ? null : this._labelFns();
        if (nsTable) {
          const fn = nsTable[methodName];
          if (!fn) throw runtimeError(`Unknown ${self.kind} method .${methodName}()`);
          const site = this._site(this._frameKey(frame) + ':' + node.id, {});
          site.named = named; // same as above
          if (!site.env) site.env = this.env;
          /* ROUND209: drawing setters take named values (ln.set_x1(x=...)).
             table.* has its own named reader and no table entry — untouched. */
          const mObj = mergeMethodArgs(self.kind, methodName, self, positional, named);
          return fn.call(null, site, ...mObj);
        }
        // UDT method call: methods are registered under 'Type.method'
        const mKey = self.__udt + '.' + methodName;
        const fnNode = this.funcs.get(mKey);
        if (fnNode) return this._callUser(fnNode, node, frame, self);
        throw runtimeError(`Unknown ${self.kind} method .${methodName}()`);
      }
      if (self && !self.__pineObj && methodName === 'new' && self.__udtType) {
        return this._udtNew(self.__udtType, node, frame);
      }
      /* nested namespace factories (chart.point.new / chart.point.copy):
         eval(member base) already resolved to the {new, copy} table */
      if (self && typeof self[methodName] === 'function' && ['new', 'copy', 'from_index', 'from_time', 'now'].indexOf(methodName) >= 0) {
        const site = this._site(this._frameKey(frame) + ':' + node.id, {});
        if (!site.env) site.env = this.env;
        /* ROUND209: chart.point factories take named values (time=/price=). */
        const merged = mergeNsArgs('chart.point', methodName, positional, named);
        return self[methodName](site, ...merged);
      }
      if (isNA(self)) throw runtimeError(`Cannot call .${methodName}() on na`);
      throw runtimeError(`Cannot call .${methodName}() on this value`);
    }
  },

  _callLowerTf(node, frame) {
    const { positional, named } = this._mergeCallArgs(node, frame);
    /* ROUND208: symbol=/timeframe= named fill (expression= likewise). */
    const pos = mergeNsArgs('request', 'security_lower_tf', positional, named);
    // positional[2] is the evaluated expression — but we need the RAW AST.
    // Re-fetch the raw AST node for the expression argument:
    const wraps = node.args || [];
    const exprWrap = wraps.find((a) => a && a.name === 'expression') || wraps[2] || null;
    const rawExpr = exprWrap ? exprWrap.value : null;
    /* ROUND230 (TV parity): currency= needs the daily FX feed — same-as-chart
       (USD here) is a no-op, anything else is loud. ignore_invalid_symbol /
       ignore_invalid_timeframe / calc_bars_count ride accepted-ignored. */
    const cur230 = (pos[4] != null && !isNA(pos[4])) ? normCurrency(pos[4]) : '';
    if (cur230 !== '' && cur230 !== 'USD') throw runtimeError(`request.security_lower_tf(): currency='${cur230}' conversion needs a daily FX feed this offline engine does not have`);
    return securityLowerTf(this, [pos[0], pos[1], rawExpr], [], (expr) => this.eval(expr, frame));
  },

  _gateLibCall(callee) {
    let head = null, dotted = null;
    if (callee.kind === 'ident') { head = callee.name; dotted = callee.name; }
    else if (callee.kind === 'member' && callee.base && callee.base.kind === 'ident') {
      head = callee.base.name;
      dotted = callee.base.name + '.' + callee.name;
    }
    if (!head) return;
    if (LIB_BANNED_IDENTS.has(dotted) || LIB_BANNED_NS.has(head)) {
      throw runtimeError(`'${dotted}' cannot be used in a library ('${(this.meta && this.meta.title) || 'library'}') — move it to the importing indicator/strategy`);
    }
  },

  _callLib(lib, name, node, frame) {
    const ex = lib.exports ? lib.exports.get(name) : null;
    if (!ex) {
      const avail = lib.exports ? [...lib.exports.keys()].join(', ') : '';
      throw runtimeError(`Unknown import '${lib.alias}.${name}'` +
        (avail ? ` — '${lib.title}' exports: ${avail}` : ` — '${lib.title}' exports nothing`));
    }
    if (ex.kind !== 'func' || !ex.node) {
      throw runtimeError(`'${lib.alias}.${name}' is a variable, not a function`);
    }
    const { positional, named } = this._mergeCallArgs(node, frame);
    return lib.rt._runUserFn(ex.node, positional, named, 'imp:' + this._frameKey(frame) + ':f' + node.id);
  },

  _readLib(lib, base, name, node) {
    const ex = lib.exports ? lib.exports.get(name) : null;
    if (!ex) {
      const avail = lib.exports ? [...lib.exports.keys()].join(', ') : '';
      throw runtimeError(`Unknown import '${base}.${name}'` +
        (avail ? ` — '${lib.title}' exports: ${avail}` : ` — '${lib.title}' exports nothing`));
    }
    if (ex.kind !== 'var') {
      throw runtimeError(`'${base}.${name}' is a function — call it with '${base}.${name}(...)'`);
    }
    const rec = lib.rt.globals.get(ex.name);
    return rec ? rec.value : NA;
  },

  _callUser(fnNode, callNode, frame, selfVal) {
    // one instance per call site (series state isolation)
    const instId = this._frameKey(frame) + ':f' + callNode.id;
    let { positional, named } = this._mergeCallArgs(callNode, frame);
    if (selfVal !== undefined) positional = [selfVal, ...positional]; // UDT method: receiver first
    /* ROUND204 (param series history): remember which params arrived as bare
       idents — `x[k]` on such a param reads the source's own history (TV
       inlines calls, so this is exactly the reference semantics). */
    const unnamed = (callNode.args || []).filter((a) => !a.name);
    const srcNames = (fnNode.params || []).map((p, k) => {
      const byName = (callNode.args || []).find((a) => a.name === p.name);
      const anode = byName ? byName.value : (unnamed[k] || {}).value;
      return anode && anode.kind === 'ident' ? anode.name : null;
    });
    if (selfVal !== undefined) srcNames.unshift(null); // receiver slot
    return this._runUserFn(fnNode, positional, named, instId, frame.scopes, srcNames);
  },

  _runUserFn(fnNode, positional, named, instId, baseScopes, srcNames) {
    // one instance per call site (series state isolation)
    let inst = this.funcInsts.get(instId);
    if (!inst) {
      inst = { id: instId, scopes: [], hists: new Map() };
      this.funcInsts.set(instId, inst);
    }
    if (this.activeFuncs.has(instId)) {
      throw runtimeError(`Function '${fnNode.name}' calls itself (recursion is not allowed in Pine Script)`);
    }
    /* ROUND78 perf: pure-function per-bar memo. Key = (call site, argument
       signature, global-write epoch). Evaluated ONCE per distinct combination
       inside a runBar; 786 Zones repeats its DST/session chain for every
       intrabar x session x day, so this collapses thousands of AST walks
       into Map lookups without touching observable behaviour (the analysis
       is conservative; verify_pine78.mjs proves memo-on/off parity). */
    let mKey = null;
    if (fnNode._pure === true && !this.disablePureMemo) {
      if (this._memoBarIdx !== this.barIndex) { this._userMemo.clear(); this._memoBarIdx = this.barIndex; }
      let sig = '';
      for (let k = 0; k < positional.length; k++) {
        const s = this._memoSig(positional[k]);
        if (s === null) { sig = null; break; }
        sig += k + ':' + s + ';';
      }
      if (sig !== null) {
        for (const nm of named) {
          const s = this._memoSig(nm.value);
          if (s === null) { sig = null; break; }
          sig += nm.name + ':' + s + ';';
        }
      }
      if (sig !== null) {
        mKey = instId + '|' + this._gwEpoch + '|' + sig;
        const hit = this._userMemo.get(mKey);
        if (hit !== undefined) { this._memoHits++; return hit; }
      }
    }
    this.activeFuncs.add(instId);
    try {
      const scope = new Map();
      /* Default args evaluate against the library/host globals when the
         call arrives without a caller frame (ROUND195 cross-runtime call). */
      const defFrame = { id: instId, scopes: baseScopes || [this.globals] };
      for (let k = 0; k < fnNode.params.length; k++) {
        const p = fnNode.params[k];
        let v;
        const byName = named.find((nm) => nm.name === p.name);
        if (byName) v = byName.value;
        else if (k < positional.length) v = positional[k];
        else if (p.def) v = this.eval(p.def, defFrame);
        else if (p.def === null && positional.length <= k) v = NA;
        scope.set(p.name, { value: v !== undefined ? v : NA, kind: 'param', hist: null,
          srcIdent: (srcNames && srcNames[k]) || null });
      }
      const localFrame = { id: instId, scopes: (baseScopes || [this.globals]).concat([scope]), fnBase: (baseScopes ? baseScopes.length : 1) };
      // body: statements; value = last expression (function form)
      let last = NA;
      const body = fnNode.body;
      for (let k = 0; k < body.stmts.length; k++) {
        const st = body.stmts[k];
        if (st.kind === 'expr') last = this.eval(st.expr, localFrame);
        else if (st.kind === 'if' && st.asExpr) last = this.eval(st, localFrame);
        else if (st.kind === 'switch') last = this.eval(st, localFrame);
        else { this._execStmt(st, localFrame); }
      }
      if (mKey !== null) {
        if (this._userMemo.size > 8192) this._userMemo.clear();
        this._userMemo.set(mKey, last);
      }
      return last;
    } finally {
      this.activeFuncs.delete(instId);
    }
  },
};

export { expressions };
