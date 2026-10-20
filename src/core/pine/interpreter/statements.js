/**
 * Pine interpreter â€” statement execution and scopes (_execBlockTop.._execForIn).
 *
 * Split out of core/pine/interpreter.js in F4.3. Method bodies are moved
 * verbatim and attached to PineRuntime.prototype by interpreter.js; no
 * logic changes.
 *
 * @module core/pine/interpreter/statements
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

const statements = {
  _execBlockTop(stmts) {
    this._execStmts(stmts, { id: 'g', scopes: [this.globals], fnBase: 0 });
  },

  _lookup(frame, name) {
    for (let k = frame.scopes.length - 1; k >= 0; k--) {
      const sc = frame.scopes[k];
      const rec = sc instanceof Map ? sc.get(name) : undefined;
      if (rec !== undefined) return rec;
    }
    return null;
  },

  _fnBase(frame) { return (frame && typeof frame.fnBase === 'number') ? frame.fnBase : 0; },

  _scopeLookup(frame, name) {
    const base = this._fnBase(frame);
    for (let k = frame.scopes.length - 1; k >= base; k--) {
      const sc = frame.scopes[k];
      const rec = sc instanceof Map ? sc.get(name) : undefined;
      if (rec !== undefined) return rec;
    }
    return null;
  },

  _declare(frame, name, value, kind) {
    const sc = frame.scopes[frame.scopes.length - 1];
    let rec = sc.get(name);
    if (!rec) {
      rec = { value: NA, kind, hist: new SeriesBuf(this.maxBarsBack) };
      sc.set(name, rec);
    }
    rec.kind = kind;
    return rec;
  },

  _varSlot(frame, st, name, kind, suffix) {
    const key = 'vs:' + this._frameKey(frame) + ':' + (st.id != null ? st.id : name + '@' + st.line) + (suffix || '');
    let rec = this._varSlots.get(key);
    if (!rec) {
      rec = { value: NA, kind, hist: new SeriesBuf(this.maxBarsBack), slotKey: key, initialized: false };
      this._varSlots.set(key, rec);
    }
    rec.kind = kind;
    return rec;
  },

  _isGlobalFrame(frame) {
    return frame.scopes.length === 1 && frame.scopes[0] === this.globals;
  },

  _linkSlot(frame, name, rec) {
    frame.scopes[frame.scopes.length - 1].set(name, rec);
    return rec;
  },

  _execStmts(stmts, frame) {
    for (const st of stmts) this._execStmt(st, frame);
  },

  _execStmt(st, frame) {
    this._tick();
    switch (st.kind) {
      case 'decl': {
        const transientVar = (st.kw === 'var' || st.kw === 'varip') && !this._isGlobalFrame(frame);
        /* ROUND160: transient-scope var/varip resolves to its persistent slot
           (checked FIRST — a same-named global must not capture it). */
        /* ROUND199: plain/typed declarations resolve function-privately
           (_scopeLookup) — a callee never captures caller scopes. */
        const rec = transientVar
          ? this._linkSlot(frame, st.name, this._varSlot(frame, st, st.name, st.kw, ''))
          : (this._scopeLookup(frame, st.name) || this._declare(frame, st.name, NA, st.kw || 'plain'));
        if (st.kw === 'var' || st.kw === 'varip') {
          // persist: initialize once, then keep. ROUND152: var rolls back to
          // the confirmed snapshot on tick re-runs, varip survives (see
          // restore()) — TV intrabar-persist parity.
          if (!rec.initialized) {
            rec.value = this.eval(st.value, frame);
            rec.initialized = true;
            if (this.globals.get(st.name) === rec || rec.slotKey) this._gwEpoch++; // ROUND78 memo epoch (+slots)
          }
        } else {
          rec.value = this.eval(st.value, frame);
          /* ROUND78 perf: a top-level (re)assignment invalidates the
             pure-fn memo — the epoch check makes the bump O(1) and skips
             loop-local decls (their records never land in `globals`) */
          if (this.globals.get(st.name) === rec || rec.slotKey) this._gwEpoch++;
        }
        return;
      }
      case 'tupledecl': {
        const vals = this.eval(st.value, frame);
        const arr = Array.isArray(vals) ? vals : (isArray(vals) ? vals.items : [vals]);
        for (let k = 0; k < st.names.length; k++) {
          // names may be raw lexer tokens ({t:'ident',v:...}) or strings — normalize
          const nmTok = st.names[k];
          const nm = (nmTok && typeof nmTok === 'object') ? nmTok.v : nmTok;
          /* ROUND160: transient-scope var/varip destructuring targets share
             the per-name persistent slots (suffix #k). */
          const transientVar = (st.kw === 'var' || st.kw === 'varip') && !this._isGlobalFrame(frame);
          const rec = transientVar
            ? this._linkSlot(frame, nm, this._varSlot(frame, st, nm, st.kw, '#' + k))
            /* ROUND199: tuple targets resolve function-privately too. */
            : (this._scopeLookup(frame, nm) || this._declare(frame, nm, NA, st.kw || 'plain'));
          if (st.kw === 'var' || st.kw === 'varip') {
            if (!rec.initialized) { rec.value = arr[k] !== undefined ? arr[k] : NA; rec.initialized = true; }
          } else rec.value = arr[k] !== undefined ? arr[k] : NA;
          if (this.globals.get(nm) === rec || rec.slotKey) this._gwEpoch++; // ROUND78 memo epoch (+slots)
        }
        return;
      }
      case 'assign': {
        /* ROUND199: a plain `=` declares function-privately (_scopeLookup) —
           it never captures caller scopes or globals. `:=`/ops keep the
           whole-chain lookup (lenient; TV rejects cross-scope `:=`). */
        let rec = st.reassign ? this._lookup(frame, st.name) : this._scopeLookup(frame, st.name);
        if (!rec) {
          if (st.reassign) throw runtimeError(`Cannot assign to undeclared variable '${st.name}'`);
          // Pine: `x = expr` at any scope DECLARES x (first assignment)
          rec = this._declare(frame, st.name, NA, 'plain');
        }
        let v = this.eval(st.value, frame);
        if (st.reassign) {
          const op = st.op;
          const cur = rec.value;
          if (op === '+') v = this._binop('+', cur, v);
          else if (op === '-') v = this._binop('-', cur, v);
          else if (op === '*') v = this._binop('*', cur, v);
          /* ROUND197: `/=` truncates under the same legacy stamp. */
          else if (op === '/') v = this._binop('/', cur, v, st.legacyTrunc ? st : null);
          else if (op === '%') v = this._binop('%', cur, v);
        }
        rec.value = v;
        /* ROUND78 perf: `:=` through a GLOBAL record invalidates the memo */
        if (this.globals.get(st.name) === rec || rec.slotKey) this._gwEpoch++;
        return;
      }
      case 'expr': this.eval(st.expr, frame); return;
      case 'block': this._execStmts(st.body, frame); return; /* v4 comma-statement group */
      case 'typedecl': this._registerUDT(st); return;
      case 'enumdecl': this._registerEnum(st); return;
      case 'fieldassign': {
        // UDT field write: path = [obj, field] or [a, b, c] (nested)
        const baseRec = this._lookup(frame, st.path[0]);
        if (!baseRec) throw runtimeError(`Cannot assign to undeclared variable '${st.path[0]}'`);
        let obj = baseRec.value;
        for (let k = 1; k < st.path.length - 1; k++) {
          if (!obj || !obj.__pineObj || !obj.__udt) throw runtimeError(`'${st.path[k]}' is not a user-defined object`);
          obj = obj.fields[st.path[k]];
        }
        /* ROUND215 (TV parity): chart.point fields are directly writable
           (`p.price := ...` — the docs mutate secondPoint.price/topLeft.price
           in loops). na clears the slot; index truncates like from_index. */
        if (obj && obj.__pineObj && !obj.__udt && obj.kind === 'point' && st.path.length === 2) {
          const leaf = st.path[st.path.length - 1];
          if (leaf !== 'time' && leaf !== 'index' && leaf !== 'price') throw runtimeError(`Unknown chart.point field '${leaf}' (expected time, index or price)`);
          let wv = this.eval(st.value, frame);
          /* ROUND216: compound field assignment (`p.price += x`). */
          if (st.op) wv = this._binop(st.op, obj[leaf] == null ? NA : obj[leaf], wv);
          obj[leaf] = isNA(wv) ? null : (leaf === 'index' ? Math.trunc(wv) : wv);
          return;
        }
        if (!obj || !obj.__pineObj || !obj.__udt) throw runtimeError(`'${st.path[st.path.length - 2]}' is not a user-defined object`);
        const leaf = st.path[st.path.length - 1];
        if (!(leaf in obj.fields)) throw runtimeError(`Unknown field '${leaf}' for type '${obj.__udt}'`);
        let wv = this.eval(st.value, frame);
        /* ROUND216: compound field assignment (`t._total += 1`). */
        if (st.op) wv = this._binop(st.op, obj.fields[leaf] === undefined ? NA : obj.fields[leaf], wv);
        obj.fields[leaf] = wv;
        return;
      }
      case 'if': {
        const c = this.eval(st.cond, frame);
        if (this._cond(c, "'if'")) this._execBlock(st.then, frame);
        else if (st.els) this._execBlock(st.els, frame);
        return;
      }
      case 'for': this._execFor(st, frame); return;
      case 'forin': this._execForIn(st, frame); return;
      /* ROUND224 (TV parity): the once block executes on the first bar only
         (later bars skip it; full recalcs re-run bar 0 like everything). */
      case 'once': if (this.barIndex === 0) this._execBlock(st.body, frame); return;
      case 'while': this._execWhile(st, frame); return;
      case 'switch': this.eval(st, frame); return;
      case 'funcdecl':
        /* UDT methods (`method f(Zone x, ...) => ...`): the FIRST param's
           annotation names the receiver type — register under
           'Type.method' so obj.f(...) resolves it (plain name kept too). */
        if (st.method && st.params && st.params[0] && st.params[0].annot && !['int','float','bool','string','color','line','box','label','table','array','matrix','map'].includes(st.params[0].annot) && !st.params[0].annot.includes('[') && !st.params[0].annot.includes('<')) {
          this.funcs.set(st.params[0].annot + '.' + st.name, st);
        }
        this.funcs.set(st.name, st);
        /* ROUND78 perf: annotate purity once per function node — the node
           object is stable across bars, so the analysis runs exactly once */
        if (st._pure === undefined) st._pure = this._pureFnCheck(st);
        return;
      case 'break': throw BREAK;
      case 'continue': throw CONTINUE;
      /* ROUND195: imports resolve at compile time — runtime no-op. */
      case 'import': return;
      default: this.eval(st, frame);
    }
  },

  _execBlock(block, frame) {
    frame.scopes.push(new Map());
    try { this._execStmts(block.stmts, frame); }
    finally { frame.scopes.pop(); }
  },

  _blockValue(block, frame) {
    frame.scopes.push(new Map());
    let last = NA;
    try {
      for (const st of block.stmts) {
        if (st.kind === 'expr') last = this.eval(st.expr, frame);
        else if (st.kind === 'decl') { this._execStmt(st, frame); last = (this._lookup(frame, st.name) || {}).value; }
        else if (st.kind === 'assign') { this._execStmt(st, frame); last = (this._lookup(frame, st.name) || {}).value; }
        else if (st.kind === 'if' && st.asExpr) { last = this.eval(st, frame); }
        else if (st.kind === 'switch') { last = this.eval(st, frame); }
        else this._execStmt(st, frame);
      }
    } finally { frame.scopes.pop(); }
    return last;
  },

  _execFor(st, frame) {
    const from = num(this.eval(st.from, frame));
    const to = num(this.eval(st.to, frame));
    const by = st.by ? num(this.eval(st.by, frame)) : 1;
    if (!isFinite(from)) return;
    if (!isFinite(to)) {
      // official quirk: na `to` executes the body ONCE
      frame.scopes.push(new Map());
      try {
        frame.scopes[frame.scopes.length - 1].set(st.name, { value: from, kind: 'loopvar', hist: null });
        this._execBlock(st.body, { id: frame.id, scopes: frame.scopes, fnBase: frame.fnBase });
      } catch (e) { if (e !== BREAK && e !== CONTINUE) throw e; }
      finally { frame.scopes.pop(); }
      return;
    }
    const step = isFinite(by) && by !== 0 ? by : 1;
    const dir = step > 0 ? 1 : -1;
    let iters = 0;
    for (let v = from; ; v += step) {
      /* ROUND225 (TV parity): v6 re-evaluates the END boundary before every
         iteration (mutating it in-loop shortens/extends the run); v5 and
         older freeze the entry value. na end keeps the run-once quirk only
         on the first pass, then terminates. */
      const lim = (this.version >= 6 && iters > 0) ? num(this.eval(st.to, frame)) : to;
      if (!isFinite(lim)) {
        if (iters > 0) break;
      } else if (dir > 0 ? v > lim : v < lim) break;
      if (++iters > this.maxLoopIter) throw loopError(`for loop exceeded ${this.maxLoopIter} iterations`);
      this._tick();
      frame.scopes.push(new Map());
      try {
        frame.scopes[frame.scopes.length - 1].set(st.name, { value: v, kind: 'loopvar', hist: null });
        this._execBlock(st.body, { id: frame.id, scopes: frame.scopes, fnBase: frame.fnBase });
      } catch (e) {
        if (e === BREAK) return;
        if (e !== CONTINUE) throw e;
      } finally {
        frame.scopes.pop();
      }
    }
  },

  _execWhile(st, frame) {
    let iters = 0;
    for (;;) {
      if (++iters > this.maxLoopIter) throw loopError(`while loop exceeded ${this.maxLoopIter} iterations`);
      this._tick();
      const c = this.eval(st.cond, frame);
      if (!this._cond(c, "'while'")) return;
      frame.scopes.push(new Map());
      try { this._execBlock(st.body, { id: frame.id, scopes: frame.scopes, fnBase: frame.fnBase }); }
      catch (e) {
        if (e === BREAK) return;
        if (e !== CONTINUE) throw e;
      } finally {
        frame.scopes.pop();
      }
    }
  },

  _execForIn(st, frame) {
    const col = this.eval(st.iter, frame);
    let items = null; // [key, value] pairs
    if (isArray(col)) {      const arr = col.items;
      for (let i = 0; i < arr.length; i++) {
        if (++this._forinIter > this.maxLoopIter) throw loopError(`for...in loop exceeded ${this.maxLoopIter} iterations`);
        this._tick();
        const pair = st.names.length >= 2 ? [i, arr[i]] : [arr[i]];
        frame.scopes.push(new Map());
        try {
          for (let k = 0; k < st.names.length; k++) frame.scopes[frame.scopes.length - 1].set(st.names[k], { value: pair[k] !== undefined ? pair[k] : NA, kind: 'loopvar', hist: null });
          this._execBlock(st.body, { id: frame.id, scopes: frame.scopes, fnBase: frame.fnBase });
        } catch (e) {
          if (e === BREAK) return;
          if (e !== CONTINUE) throw e;
        } finally { frame.scopes.pop(); }
      }
      return;
    }
    if (typeof col === 'string') {
      for (let i = 0; i < col.length; i++) {
        if (++this._forinIter > this.maxLoopIter) throw loopError(`for...in loop exceeded ${this.maxLoopIter} iterations`);
        this._tick();
        frame.scopes.push(new Map());
        try {
          frame.scopes[frame.scopes.length - 1].set(st.names[0], { value: col[i], kind: 'loopvar', hist: null });
          this._execBlock(st.body, { id: frame.id, scopes: frame.scopes, fnBase: frame.fnBase });
        } catch (e) {
          if (e === BREAK) return;
          if (e !== CONTINUE) throw e;
        } finally { frame.scopes.pop(); }
      }
      return;
    }
    /* ROUND196: for...in over a matrix yields its rows (PineArrays, with the
       index when two names given); over a map it yields keys ([k] / [k, v]). */
    if (isMatrix(col) || isMap(col)) {
      const pairs = isMatrix(col)
        ? col.data.map((row, i) => [i, new PineArray(col.elType, row.slice())])
        : [...col.data.entries()];
      for (const pair of pairs) {
        if (++this._forinIter > this.maxLoopIter) throw loopError(`for...in loop exceeded ${this.maxLoopIter} iterations`);
        this._tick();
        const vals = st.names.length >= 2 ? pair : [pair[isMatrix(col) ? 1 : 0]];
        frame.scopes.push(new Map());
        try {
          for (let k = 0; k < st.names.length; k++) frame.scopes[frame.scopes.length - 1].set(st.names[k], { value: vals[k] !== undefined ? vals[k] : NA, kind: 'loopvar', hist: null });
          this._execBlock(st.body, { id: frame.id, scopes: frame.scopes, fnBase: frame.fnBase });
        } catch (e) {
          if (e === BREAK) return;
          if (e !== CONTINUE) throw e;
        } finally { frame.scopes.pop(); }
      }
      return;
    }
    // maps (PineMap proxy {__pineMap}) when they arrive — otherwise na iterates zero times
    if (isNA(col) || col == null) return;
    throw runtimeError(`for...in expects an array/map, got '${typeof col}'`);
  },
};

export { statements };
