/**
 * Pine interpreter â€” bar-series execution loop (runBar.._finalizeBarOutputs).
 *
 * Split out of core/pine/interpreter.js in F4.3. Method bodies are moved
 * verbatim and attached to PineRuntime.prototype by interpreter.js; no
 * logic changes.
 *
 * @module core/pine/interpreter/series
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

const series = {
  runBar(i, isForming) {
    const b = this.bars[i];
    if (!b) return;
    this.barIndex = i;
    this.isForming = !!isForming;
    this.env.bar = b;
    this.env.barIndex = i;
    /* ROUND78 (timezone): script `time` is TRUE UTC ms — strip the broker
       wall-clock shift the chart stamps carry (see env note above) */
    this.env.barTimeMs = (b.time - this.env.serverOffSec) * this.env.timeScale;
    this.steps = 0;
    /* ROUND78 perf: pure-function memo is scoped to ONE bar run */
    if (this._memoBarIdx !== i) { this._userMemo.clear(); this._memoBarIdx = i; }
    /* ROUND77 (BUG-76-D): the input-call id embeds a per-site counter
       ('i' + siteKey + '_' + n). Without a per-bar reset the counter drifted
       (site.n kept growing bar after bar), so from bar 1 on the id no longer
       matched the one the settings dialog keyed its values by (the BAR-0
       id, also what inputDefs reported) — user input overrides silently
       fell back to defaults (786 Zones' "Days Back" stayed 1). n is used
       ONLY for input id numbering, so a per-bar reset is safe. */
    for (const [, s] of this.sites) { if (s.n) s.n = 0; }
    this.out._pushed.clear();
    this._histPushed.clear();
    /* ROUND195: imported libraries step first — their globals/series lead the
       importer's reads by construction (same bar, shared env). */
    if (this.libs && this.libs.size) {
      for (const [, lib] of this.libs) lib.rt._runLibBar(this.bars, this.totalBars, i, isForming);
    }
    this._pushBuiltinValues();
    /* ROUND171 (phase 2a: backtester): working orders fill at THIS bar's
       open/range before the body runs (next-bar fills for signals). */
    if (this.broker) brokerFills(this);
    try {
      this._execBlockTop(this.ast.body);
    } catch (e) {
      if (e === BREAK || e === CONTINUE) { /* stray break/continue: ignore */ }
      else throw e;
    }
    /* ROUND172 (phase 2b: account): per-bar equity AFTER the body (uses the
       bar's close for mark-to-market). Indexed by bar — overwrite-safe on
       forming re-runs, rollback-safe inside the broker clone. */
    /* ROUND212 (process_orders_on_close): a second fills pass AFTER the
       body, so orders this bar's script just placed fill at this bar's
       close (the pre-body pass cannot see them yet). Older working orders
       re-evaluate deterministically against the same closed bar (untouched
       stay working — idempotent). Runs only with the flag: default timing
       is byte-identical to before. */
    if (this.broker && this.broker.cfg && this.broker.cfg.closeFill) brokerFills(this);
    if (this.broker && this.meta.isStrategy && !this.dry) pushBrokerBar(this);
    this._finalizeBarOutputs(i);
  },

  _runLibBar(bars, total, i, isForming) {
    this.bars = bars;
    this.totalBars = total;
    const b = bars[i];
    if (!b) return;
    this.barIndex = i;
    this.isForming = !!isForming;
    this.env.bar = b;
    this.env.barIndex = i;
    this.env.barTimeMs = (b.time - this.env.serverOffSec) * this.env.timeScale;
    this.steps = 0;
    if (this._memoBarIdx !== i) { this._userMemo.clear(); this._memoBarIdx = i; }
    for (const [, s] of this.sites) { if (s.n) s.n = 0; }
    this.out._pushed.clear();
    this._histPushed.clear();
    this._pushBuiltinValues();
    try {
      this._execBlockTop(this.ast.body);
    } catch (e) {
      if (e === BREAK || e === CONTINUE) { /* stray break/continue: ignore */ }
      else throw e;
    }
    this._finalizeBarOutputs(i);
  },

  runAll(bars) {
    this.bars = bars;
    this.env.bars = bars; // ROUND229: session.isfirstbar/islastbar neighbor reads
    this.totalBars = bars.length;
    this.env.lastBarIndex = bars.length - 1; // ROUND184b: last_bar_index is the final bar (was never set — fell back to the current bar, so `bar_index == last_bar_index - N` never fired)
    this._preFormSnap = null;
    this._resetForFullRun();
    this._alertFloor = bars.length - 1; // ROUND279: only the final (live) bar may emit (after reset)
    for (let i = 0; i < bars.length; i++) {
      if (i === bars.length - 1) this._preFormSnap = this.snapshot();
      this.runBar(i, i === bars.length - 1);
    }
  },

  _resetForFullRun() {
    this.store.clearAll();
    /* ROUND160: var slots reset with everything else (TV full recalc). */
    this._varSlots.clear();
    for (const [, rec] of this.globals) {
      rec.initialized = false;
      rec.value = NA;
      /* ROUND156: preserve each record's own cap (core OHLCV runs 10000 deep;
         a blanket maxBarsBack here silently re-capped them to 5000). */
      if (rec.hist) rec.hist = new SeriesBuf(rec.hist.cap || this.maxBarsBack);
    }
    this.sites = new Map();
    this.funcInsts = new Map();
    this.histBufs = new Map();
    this._histPushed = new Set();
    this._userMemo.clear();
    this._memoBarIdx = -1;
    this._gwEpoch++;
    brokerInit(this); // ROUND171/phase-2a: full recalc restarts the backtest
    /* ROUND279: a full recalc replays history — clear the live alert tape and
       re-arm the per-condition per-bar guards. `_alertSeq` deliberately keeps
       counting: the renderer cursor is a high-water mark, so a restarted
       sequence would make every later live event look "already seen". */
    this._alertFloor = Infinity;
    this._alertMsgBar = -1;
    this._alertMsgSet.clear();
    this.out.pineAlerts.length = 0;
    this.out.alerts.length = 0;
    for (const a of this.out.alertconds) a.lastFiredBar = -1;
    /* ROUND195: libraries reset with the host (fresh globals/series/sites). */
    if (this.libs) for (const [, lib] of this.libs) lib.rt._resetForFullRun();
  },

  async runChunked(bars, chunk) {
    const CH = Math.max(100, chunk || 400);
    const BUDGET_MS = 12; // ROUND80: one slice ≈ one frame
    this.bars = bars;
    this.env.bars = bars; // ROUND229 (see runAll)
    this.totalBars = bars.length;
    this.env.lastBarIndex = bars.length - 1; // ROUND184b (see runAll)
    this._preFormSnap = null;
    /* ROUND87: TV full-recalc semantics — every complete re-run starts from
       an empty drawing store and FRESH var state (see _resetForFullRun) */
    this._resetForFullRun();
    this._alertFloor = bars.length - 1; // ROUND279 (see runAll; after reset)
    const n = bars.length;
    let sliceStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const nowMs = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
    for (let i = 0; i < n; i++) {
      if (i === n - 1) this._preFormSnap = this.snapshot();
      this.runBar(i, i === n - 1);
      if (i < n - 1 && (i % CH === CH - 1 || nowMs() - sliceStart >= BUDGET_MS)) {
        await new Promise((r) => setTimeout(r, 0));
        sliceStart = nowMs();
      }
    }
  },

  updateForming(bars) {
    if (!bars || !bars.length) return;
    this.bars = bars;
    this.env.bars = bars; // ROUND229 (see runAll)
    this.totalBars = bars.length;
    this.env.lastBarIndex = bars.length - 1; // ROUND184b (see runAll)
    this._alertFloor = Math.min(this._alertFloor, bars.length - 1); // ROUND279
    if (!this._preFormSnap) this._preFormSnap = this.snapshot();
    this.restore(this._preFormSnap);
    // visuals born during the PREVIOUS forming run die with the rollback
    // (official behaviour: objects created on the realtime bar are removed
    // before the script re-executes on that bar)
    this.dropObjectsBornAfter(bars.length - 1);
    if (!this.calcEveryTick && !this.dry) this._tickFillsOnly(bars.length - 1);
    else this.runBar(bars.length - 1, true);
  },

  _tickFillsOnly(i) {
    const b = this.bars[i];
    if (!b) return;
    this.barIndex = i;
    this.isForming = true;
    this.env.bar = b;
    this.env.barIndex = i;
    this.env.barTimeMs = (b.time - this.env.serverOffSec) * this.env.timeScale;
    this.steps = 0;
    if (this.broker) brokerFills(this);
    if (this.broker && this.meta.isStrategy && !this.dry) pushBrokerBar(this);
  },

  pushNewBar(bars) {
    if (!bars || !bars.length) return;
    this.bars = bars;
    this.env.bars = bars; // ROUND229 (see runAll)
    this.totalBars = bars.length;
    this.env.lastBarIndex = bars.length - 1; // ROUND184b (see runAll)
    this._alertFloor = Math.min(this._alertFloor, bars.length - 1); // ROUND279
    this._preFormSnap = this.snapshot();
    this.runBar(bars.length - 1, true);
  },

  _pushBuiltinValues() {
    const b = this.env.bar;
    const push = (name, v) => {
      const rec = this.globals.get(name);
      /* ROUND-FIX: do NOT push into rec.hist here. Built-ins used to record
         their history BEFORE the bar body ran, while every script-declared
         variable records its history AFTER the bar body runs (see the
         end-of-bar sweep in _finalizeBarOutputs). That mismatch made
         `close[1]` correct but `up[1]`/`trend[1]`/`dn1` (and any user
         variable reassigned with `:=`) read the value from TWO bars ago
         instead of one, silently corrupting every indicator that ratchets
         a persistent variable against its own previous value (Supertrend,
         Smart Money Concepts, etc). Leaving the push to the same
         end-of-bar sweep for every global — built-in or user — makes the
         `[]` history operator consistent everywhere. */
      if (rec) { rec.value = v; }
    };
    const t = this.env.barTimeMs;
    /* ROUND78 (timezone): time_close follows `time` into true UTC */
    const tc = (b.time + this.env.tfSec - this.env.serverOffSec) * this.env.timeScale;
    /* ROUND158 (ingest normalization): the feed sends null/NaN for missing
       OHLCV (never the NA singleton), and raw nulls used to flow into math
       where `null` coerces to 0 — e.g. hl2 of a missing bar read as
       (null+5)/2 = 2.5, and nz(null) returned null instead of the
       replacement. Non-finite OHLCV now becomes NA at ingest (so isNA/nz/na
       work on real feed holes); volume keeps its 0-fill; time stays numeric. */
    const px = (v) => (typeof v === 'number' && isFinite(v) ? v : NA);
    const o = px(b.open), h = px(b.high), l = px(b.low), cl = px(b.close);
    push('open', o); push('high', h); push('low', l); push('close', cl);
    push('volume', (typeof b.volume === 'number' && isFinite(b.volume)) ? b.volume : 0);
    push('time', t); push('time_close', tc);
    push('hl2', (h === NA || l === NA) ? NA : (h + l) / 2);
    push('hlc3', (h === NA || l === NA || cl === NA) ? NA : (h + l + cl) / 3);
    push('ohlc4', (o === NA || h === NA || l === NA || cl === NA) ? NA : (o + h + l + cl) / 4);
    push('hlcc4', (h === NA || l === NA || cl === NA) ? NA : (h + l + 2 * cl) / 4);
    push('bar_index', this.barIndex);
  },

  _finalizeBarOutputs(i) {
    if (this.dry) return;
    // every plot/shape site must hold exactly one value per bar
    for (const [key, p] of this.out.plots) {
      if (p.values[i] === undefined) { p.values[i] = null; p.colors[i] = null; }
    }
    for (const [, s] of this.out.shapes) {
      if (s.ys[i] === undefined) { s.ys[i] = null; s.colors[i] = null; s.texts[i] = null; }
    }
    if (this.out.bgcolor[i] === undefined) this.out.bgcolor[i] = null;
    if (this.out.barcolor[i] === undefined) this.out.barcolor[i] = null;
    for (const f of this.out.fills) if (f.colors[i] === undefined) f.colors[i] = null;
    // end-of-bar history sweep: every global's FINAL value lands in its
    // history buffer exactly once per bar (Pine x[k] = end-of-bar values)
    for (const [name, rec] of this.globals) {
      if (rec.hist && !this._histPushed.has(name)) { rec.hist.push(rec.value); this._histPushed.add(name); }
    }
  },
};

export { series };
