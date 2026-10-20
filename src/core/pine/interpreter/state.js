/**
 * Pine interpreter â€” snapshot/restore serialization.
 *
 * Split out of core/pine/interpreter.js in F4.3. Method bodies are moved
 * verbatim and attached to PineRuntime.prototype by interpreter.js; no
 * logic changes.
 *
 * @module core/pine/interpreter/state
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

const state = {
  snapshot() {
    /* ROUND205: prune the drawing graveyard. Graves predate this snapshot
       exactly when their objects are NOT live in it, so no restore() from
       this snapshot forward can ever resurrect them (single-slot _preFormSnap
       discipline) — keeping them would only leak refs across long histories. */
    if (this.store && this.store.graves) this.store.graves.clear();
    const globals = [];
    const snapGlobals = (m, out) => {
      for (const [name, rec] of m) {
        out.push([name, {
          value: this._cloneVal(rec.value),
          kind: rec.kind, initialized: !!rec.initialized,
          hist: rec.hist ? rec.hist.snap() : null,
        }]);
      }
    };
    const gSnap = [];
    snapGlobals(this.globals, gSnap);
    /* ROUND160: var-slot records ride the same snapshot/restore machinery
       (values + initialized + hist), so forming-bar re-runs revert them
       exactly like globals — except varip slots, which survive (see below). */
    const sSnap = [];
    snapGlobals(this._varSlots, sSnap);
    const insts = [];
    for (const [id, inst] of this.funcInsts) {
      // function-local scopes live on frame.scopes copies — the scopes arrays
      // are transient; persistent per-instance state lives in sites/histBufs
      insts.push(id);
    }
    const sites = [];
    for (const [key, s] of this.sites) sites.push([key, cloneSite(s)]);
    const hists = [];
    /* ROUND151 (BUG: any `(expr)[k]` non-ident history crashed snapshot with
       `buf.snap is not a function`): general-expression buffers are plain
       [{b, v}] arrays, not SeriesBuf — clone element-wise here ... */
    for (const [key, buf] of this.histBufs) {
      hists.push([key, Array.isArray(buf) ? buf.map((e) => ({ b: e.b, v: this._cloneVal(e.v) })) : buf.snap()]);
    }
    // visual objects: snapshot every live object's fields (identity kept).
    // ROUND151: tables clone their cells Map (per-bar cell mutation must roll
    // back; a shared Map would alias the snapshot like ROUND77's arrays).
    // ROUND155: merges array cloned for the same reason.
    const objs = [];
    const snapKind = (kind) => {
      for (const [id, o] of this.store[kind]) {
        objs.push([kind, id, kind === 'table' ? { ...o, cells: new Map(o.cells), merges: o.merges.slice() } : { ...o }]);
      }
    };
    snapKind('line'); snapKind('box'); snapKind('label'); snapKind('table');
    /* ROUND205: polyline/linefill join the snapshot set (their deletes set
       .deleted now, so a forming-run delete must roll back like the rest). */
    snapKind('polyline'); snapKind('linefill');
    /* ROUND171 (phase 2a: backtester): order/position/trade state rolls back
       with the forming bar, or tick re-runs would double-fill. Plain data —
       JSON-cloned both ways (same aliasing class as ROUND77 arrays). */
    const broker = this.broker ? brokerClone(this.broker) : null;
    /* ROUND195: library runtimes snapshot with the host, or forming-bar
       re-runs would double-advance library series state. */
    const libSnaps = [];
    if (this.libs) for (const [alias, lib] of this.libs) libSnaps.push([alias, lib.rt.snapshot()]);
    return { globals: gSnap, slots: sSnap, sites, hists, objs, broker, libs: libSnaps };
  },

  _cloneVal(v) {
    if (v && v.__pineArray) return v.snapshotClone();
    /* ROUND196: matrices/maps snapshot like arrays (reference types). */
    if (v && (v.__pineMatrix || v.__pineMap)) return v.snapshotClone();
    return v; // primitives, colors (immutable), object refs (stable), refs
  },

  restore(snap) {
    const restoreRec = (cur, rec) => {
      /* ROUND152 (TV parity): real varip — intrabar-persistent variables
         SURVIVE the forming-bar rollback (per-tick accumulation is the whole
         point: tick counters, realtime alerts). Only plain/var roll back to
         the confirmed snapshot; varip keeps its live value, hist and flag. */
      if (cur.kind === 'varip') return;
      /* ROUND77 (BUG-76-A): copy-OUT semantics. The snapshot's cloned
         PineArray used to be handed to the LIVE state by reference, so the
         very next `array.set()` (786 Zones keeps box/label refs in var
         arrays) mutated THE SNAPSHOT ITSELF — every later rollback restored
         refs to objects that dropObjectsBornAfter had already deleted and
         the script then only mutated dead objects (box.set_* on refs whose
         store entry was gone): objects were created once, then vanished,
         NOTHING painted on the chart. Re-clone on the way out; drawing-object
         identity inside arrays stays stable (official contract). The single
         use case (one updateForming) masked this — the verify suite only
         ever rolled back once. */
      cur.value = this._cloneVal(rec.value);
      cur.kind = rec.kind;
      cur.initialized = rec.initialized;
      if (cur.hist && rec.hist) cur.hist.restore(rec.hist);
    };
    for (const [name, rec] of snap.globals) {
      const cur = this.globals.get(name);
      if (!cur) continue;
      restoreRec(cur, rec);
    }
    /* ROUND160: var slots restore identically (same varip rule). A slot that
       vanished (full recalc between snapshot and restore) is skipped. */
    if (snap.slots) {
      for (const [key, rec] of snap.slots) {
        const cur = this._varSlots.get(key);
        if (!cur) continue;
        restoreRec(cur, rec);
      }
    }
    this.sites = new Map();
    /* ROUND77 (BUG-76-A): same aliasing class for per-site state — the
       snapshot's site clones were previously adopted by reference; a live
       run then wrote site state straight into the snapshot */
    for (const [key, s] of snap.sites) this.sites.set(key, cloneSite(s));
    this.histBufs = new Map();
    for (const [key, arr] of snap.hists) {
      /* ROUND151: ... and rebuild the same shape on restore (plain arrays
         stay plain arrays — SeriesBuf.restore would misread {b,v} entries) */
      if (Array.isArray(arr)) {
        this.histBufs.set(key, arr.map((e) => ({ b: e.b, v: this._cloneVal(e.v) })));
        continue;
      }
      const buf = new SeriesBuf(this.maxBarsBack);
      buf.restore(arr);
      this.histBufs.set(key, buf);
    }
    // reapply visual object fields (mutations during the forming run revert)
    for (const [kind, id, fields] of snap.objs) {
      const o = this.store[kind].get(id);
      if (!o) {
        /* ROUND205: the forming run DELETED a confirmed object — resurrect the
           SAME grave ref (var-held identity reunites with the store entry).
           Before this, deletes survived the rollback: the next tick's script
           kept throwing "was deleted" (or silently painted nothing) for an
           object TV would have alive again. No grave (full recalc in between)
           means the slot is genuinely gone — skip like before. */
        if (this.store.resurrect) this.store.resurrect(kind, id, fields);
        continue;
      }
      Object.assign(o, fields);
      /* ROUND151: re-clone the table cell map on the way out (see snapshot).
         ROUND155: merges array likewise. */
      if (kind === 'table' && fields.cells) {
        o.cells = new Map(fields.cells);
        o.merges = (fields.merges || []).slice();
      }
    }
    /* ROUND171 (phase 2a: backtester): re-clone on the way out so later
       fills never mutate the snapshot (ROUND77 aliasing class). */
    if (snap.broker) this.broker = brokerClone(snap.broker);
    /* ROUND195: restore library runtimes with the host (see snapshot). */
    if (snap.libs && this.libs) {
      for (const [alias, ls] of snap.libs) {
        const lib = this.libs.get(alias);
        if (lib) lib.rt.restore(ls);
      }
    }
  },

  dropObjectsBornAfter(barIdx) {
    /* ROUND151: tables join the rollback set (var tables are born once;
       forming-bar tables must not survive a tick re-run) */
    /* ROUND216 (TV parity): var/global-held drawings survive ticks. A `var tbl
       = table.new()` inside `if barstate.islast` is born on the forming bar,
       so the blind bornBar>=barIdx cut deleted it on EVERY tick while its
       slot still held the (now-flagged) ref — the next table.cell threw "was
       deleted" although TV keeps the table alive across ticks. Objects still
       reachable from persistent slots/globals (directly, via arrays, or via
       UDT fields) are exempt from the forming-run purge; everything else
       (fresh-per-tick lines/labels/boxes) drops and is recreated by the
       re-run exactly as before. Explicit script deletes stay loud/dead:
       only the rollback purge is scoped, del() itself is untouched. */
    const prot = new Set();
    const scanRef = (v, depth) => {
      if (v == null || depth > 2) return;
      if (v.__pineObj && v.kind && v.id != null && !v.__udt) { prot.add(v.kind + ':' + v.id); return; }
      if (v.__pineArray && Array.isArray(v.items)) { for (const it of v.items) scanRef(it, depth + 1); return; }
      if (v.__pineObj && v.__udt && v.fields) { for (const k of Object.keys(v.fields)) scanRef(v.fields[k], depth + 1); }
    };
    for (const [, rec] of this.globals) scanRef(rec.value, 0);
    if (this._varSlots) for (const [, rec] of this._varSlots) scanRef(rec.value, 0);
    for (const kind of ['line', 'box', 'label', 'table', 'polyline', 'linefill']) {
      for (const [id, o] of Array.from(this.store[kind])) {
        if (o.bornBar != null && o.bornBar >= barIdx && !prot.has(kind + ':' + id)) this.store.del(kind, o);
      }
    }
    /* ROUND205: graves of the rolled-back run are garbage too (their ids were
       never live in _preFormSnap, so no future restore can resurrect them). */
    if (this.store.graves) {
      for (const [gk, o] of Array.from(this.store.graves)) {
        if (o && o.bornBar != null && o.bornBar >= barIdx) this.store.graves.delete(gk);
      }
    }
  },
};

export { state };
