/**
 * Pine interpreter (round 74 — roadmap phases 3+4+5)
 *
 * Bar-by-bar execution of the parsed AST, engineered for the app's
 * incremental feed (rounds 70–72 discipline):
 *   - runAll(bars): one pass over the whole loaded history
 *   - updateForming(bar): ROLLBACK to the end-of-confirmed-history snapshot
 *     and re-run ONLY the last bar — never a full re-run per tick
 *   - pushBar(bar): a new live bar arrived (state carries forward)
 *
 * The engine reuses the batch kernels of stdlib/ta.js (which the built-in
 * indicators share) through the incremental ta.* forms, so SMA/EMA/RSI/...
 * produce values identical to core/indicators.js.
 *
 * ZERO DOM / window references — core-layer only.
 *
 * @module core/pine/interpreter
 */

import {
  NA, isNA, truthy, num, pineNum, PineColor, toColor, colorNew,
  makeEnumConst, isEnumConst, enumPayload,
} from './types.js';
import { SeriesBuf } from './scope.js';
import { PineError, runtimeError, loopError } from './errors.js';
import { PineArray, isArray, arrNew, arrFrom, keyOf } from './stdlib/array.js';
import { PineMatrix, isMatrix, matNew } from './stdlib/matrix.js';
import { PineMap, isMap, mapNew } from './stdlib/map.js';
import { taFns, taVars, cloneSite } from './stdlib/ta.js';
import { mathFns, MATH_CONSTS, strFns } from './stdlib/math.js';
import { colorFns, colorConsts } from './stdlib/color.js';
import { VisualStore, lineNew, boxNew, labelNew, polylineNew, linefillNew, mergeArgs, SIZE_MAP, sizeOf, tableNew, tableCell, tableClear, tableMerge, tablePos, tableSetBgcolor, tableSetBorderColor, tableSetBorderWidth, tableSetFrameColor, tableSetFrameWidth } from './stdlib/objects.js';
import { securityLowerTf, tfSeconds } from './stdlib/request.js';
import { securityHigherTf } from './stdlib/request-security.js';
import { sessionFns, timeInSession } from './stdlib/session.js';
import { tickerNew, tickerHeikinashi, tickerRenko, tickerLinebreak, tickerKagi, tickerPointfigure, isTicker, haTransform } from './stdlib/ticker.js';

/* ROUND207: ticker kinds whose request.security call substitutes synthetic
   formation bars (renko/linebreak/kagi/pointfigure). Plain + heikinashi keep
   their existing paths. */
const SYNTH_TICKER = { renko: 1, linebreak: 1, kagi: 1, pointfigure: 1 };

/* ROUND230 (TV parity): currency-code normalization for the FX-feed stubs
   (plain string or currency.* enum const) — 'USD', currency.USD -> 'USD'. */
function normCurrency(v) {
  const p = enumPayload(v);
  const s = p != null ? p : (typeof v === 'string' ? v : '');
  return String(s || '').trim().toUpperCase();
}

/* ROUND208 (named-args parity): TV canonical parameter names per namespace
   function, for the dispatcher merge (named fills empty positional slots;
   unknown names are loud like TV's compile error). Only families WITHOUT
   their own named readers are listed (input/strategy/table/line-box-label
   factories and method forms keep their paths). Variadic builtins
   (math.min/max/sum/avg, no-arg ta.* kernels) are intentionally absent:
   TV documents no named form for them. Pivot entries carry the 2-arg
   (leftbars, rightbars) overload compaction. */
const NS_PARAMS = {
  'ta.sma': ['source', 'length'], 'ta.ema': ['source', 'length'],
  'ta.rma': ['source', 'length'], 'ta.wma': ['source', 'length'],
  'ta.hma': ['source', 'length'], 'ta.rsi': ['source', 'length'],
  'ta.change': ['source', 'length'], 'ta.mom': ['source', 'length'],
  'ta.roc': ['source', 'length'], 'ta.cum': ['source'],
  'ta.rising': ['source', 'length'], 'ta.falling': ['source', 'length'],
  'ta.tr': ['handle_na'], 'ta.atr': ['length'],
  'ta.stdev': ['source', 'length', 'biased'], 'ta.dev': ['source', 'length'],
  'ta.bb': ['source', 'length', 'mult'], 'ta.bbw': ['source', 'length', 'mult'],
  'ta.macd': ['source', 'fastlength', 'slowlength', 'signallength'],
  'ta.supertrend': ['factor', 'atr_length'],
  'ta.cci': ['source', 'length'],
  'ta.stoch': ['source', 'high', 'low', 'length'],
  'ta.wpr': ['length'], 'ta.mfi': ['series', 'length'],
  'ta.highest': ['source', 'length'], 'ta.lowest': ['source', 'length'],
  'ta.highestbars': ['source', 'length'], 'ta.lowestbars': ['source', 'length'],
  'ta.crossover': ['source1', 'source2'], 'ta.crossunder': ['source1', 'source2'],
  'ta.cross': ['source1', 'source2'],
  'ta.barssince': ['condition'],
  'ta.valuewhen': ['condition', 'source', 'occurrence'],
  'ta.pivothigh': { p: ['source', 'leftbars', 'rightbars'], pivot: true },
  'ta.pivotlow': { p: ['source', 'leftbars', 'rightbars'], pivot: true },
  'ta.linreg': ['source', 'length', 'offset'],
  'ta.sar': ['start', 'increment', 'max'],
  'ta.vwap': ['source'],
  'ta.alma': ['source', 'length', 'offset', 'sigma'],
  'ta.cmo': ['source', 'length'], 'ta.cog': ['source', 'length'],
  'ta.correlation': ['source1', 'source2', 'length'],
  'ta.median': ['source', 'length'], 'ta.mode': ['source', 'length'],
  'ta.variance': ['source', 'length', 'biased'], 'ta.rci': ['source', 'length'],
  /* ROUND237 (TV parity): ta.range named form (source=/length=); without an
     entry the named args fell through to the argless branch silently. */
  'ta.range': ['source', 'length'],
  'ta.swma': ['source'],
  'ta.percentile_linear_interpolation': ['source', 'percentage'],
  'ta.percentile_nearest_rank': ['source', 'percentage'],
  'ta.percentrank': ['source', 'length'],
  'ta.dmi': ['di_length', 'adx_length'],
  'ta.kc': ['source', 'length', 'mult'], 'ta.kcw': ['source', 'length', 'mult'],
  'ta.tsi': ['source', 'short_length', 'long_length'],
  'ta.vwma': ['source', 'volume', 'length'],
  'math.round': ['number', 'precision'],
  'math.pow': ['base', 'exponent'],
  'math.random': ['min', 'max'],
  'math.round_to_mintick': ['number'],
  /* Variadic / no-arg builtins document no named form in TV — an empty list
     keeps positional behavior identical while unknown names go loud. */
  'math.min': [], 'math.max': [], 'math.sum': [], 'math.avg': [],
  'ta.obv': [], 'ta.pvt': [], 'ta.wad': [], 'ta.wvad': [], 'ta.accdist': [],
  'ta.nvi': [], 'ta.pvi': [], 'ta.iii': [],
  'str.tostring': ['value', 'format'], 'str.tonumber': ['string'],
  'str.split': ['string', 'separator'], 'str.format': ['format'],
  'str.format_time': ['time', 'format', 'timezone'],
  'color.new': ['color', 'transp'],
  'color.rgb': ['red', 'green', 'blue', 'transparency'],
  'color.r': ['color'], 'color.g': ['color'], 'color.b': ['color'], 'color.t': ['color'],
  'color.gradient': ['c1', 'c2', 'step'],
  'color.from_gradient': ['value', 'bottom', 'top', 'c0', 'c1'],
  'ticker.new': ['prefix', 'ticker', 'session', 'session_regular', 'adjustment'],
  'ticker.heikinashi': ['symbol'],
  'ticker.renko': ['symbol', 'timeframe', 'brick_size'],
  'ticker.linebreak': ['symbol', 'timeframe', 'line_number'],
  'ticker.kagi': ['symbol', 'timeframe', 'reversal_amount'],
  'ticker.pointfigure': ['symbol', 'timeframe', 'box_size', 'reversal_size'],
  'request.security_lower_tf': ['symbol', 'timeframe', 'expression', 'ignore_invalid_symbol', 'currency', 'ignore_invalid_timeframe', 'calc_bars_count'],
  /* ROUND230 (TV parity): request.currency_rate named form (from=/to=/ignore_invalid_currency=). */
  'request.currency_rate': ['from', 'to', 'ignore_invalid_currency'],
  /* ROUND209 (method-forms + collections): the same canonical names serve
     the value-method path (arr.get(index=...), ln.set_x1(x=...)) — the
     receiver is implicit there, so the method merger strips slot 0.
     TV-name guesses on exotic setters are documented per-family; positional
     calls are unaffected either way, and a miss goes loud, never silent. */
  'array.new': ['size', 'initial_value'],
  'array.new_int': ['size', 'initial_value'], 'array.new_float': ['size', 'initial_value'],
  'array.new_bool': ['size', 'initial_value'], 'array.new_string': ['size', 'initial_value'],
  'array.new_color': ['size', 'initial_value'], 'array.new_line': ['size', 'initial_value'],
  'array.new_box': ['size', 'initial_value'], 'array.new_label': ['size', 'initial_value'],
  'array.copy': ['id'], 'array.get': ['id', 'index'], 'array.set': ['id', 'index', 'value'],
  'array.size': ['id'], 'array.push': ['id', 'value'], 'array.pop': ['id'],
  'array.shift': ['id'], 'array.unshift': ['id', 'value'],
  'array.insert': ['id', 'index', 'value'], 'array.remove': ['id', 'index'],
  'array.clear': ['id'], 'array.first': ['id'], 'array.last': ['id'],
  'array.join': ['id', 'separator'], 'array.slice': ['id', 'start_index', 'end_index'],
  'array.sort': ['id', 'order', 'sort_field'], 'array.sort_indices': ['id', 'order', 'sort_field'],
  'array.reverse': ['id'], 'array.indexof': ['id', 'value'],
  'array.lastindexof': ['id', 'value'], 'array.includes': ['id', 'value'],
  'array.concat': ['id', 'id2'],
  'array.fill': ['id', 'value', 'index_from', 'index_to'],
  'array.sum': ['id'], 'array.avg': ['id'], 'array.min': ['id'], 'array.max': ['id'],
  'array.median': ['id'], 'array.mode': ['id'], 'array.range': ['id'],
  'array.variance': ['id', 'biased'], 'array.stdev': ['id', 'biased'], 'array.standardize': ['id'],
  'array.percentrank': ['id', 'index'],
  'array.binary_search': ['id', 'value', 'sort_field'],
  'array.binary_search_leftmost': ['id', 'value', 'sort_field'],
  'array.binary_search_rightmost': ['id', 'value', 'sort_field'],
  'matrix.new': ['rows', 'columns', 'initial_value'],
  'matrix.new_int': ['rows', 'columns', 'initial_value'],
  'matrix.new_float': ['rows', 'columns', 'initial_value'],
  'matrix.new_bool': ['rows', 'columns', 'initial_value'],
  'matrix.new_string': ['rows', 'columns', 'initial_value'],
  'matrix.copy': ['id'], 'matrix.get': ['id', 'row', 'column'],
  'matrix.set': ['id', 'row', 'column', 'value'],
  'matrix.rows': ['id'], 'matrix.columns': ['id'],
  'matrix.fill': ['id', 'value', 'from_row', 'from_column', 'to_row', 'to_column'],
  'matrix.add_row': ['id', 'values'], 'matrix.add_col': ['id', 'values'],
  'matrix.remove_row': ['id', 'index'], 'matrix.remove_col': ['id', 'index'],
  'matrix.submatrix': ['id', 'from_row', 'from_column', 'to_row', 'to_column'],
  'matrix.transpose': ['id'], 'matrix.reshape': ['id', 'rows', 'columns'],
  'matrix.sort': ['id', 'column', 'order'],
  'matrix.sum': ['id'], 'matrix.avg': ['id'], 'matrix.min': ['id'], 'matrix.max': ['id'],
  'map.new': [], 'map.copy': ['id'], 'map.put': ['id', 'key', 'value'],
  'map.get': ['id', 'key'], 'map.contains': ['id', 'key'], 'map.remove': ['id', 'key'],
  'map.clear': ['id'], 'map.keys': ['id'], 'map.values': ['id'], 'map.size': ['id'],
  'line.delete': ['line'],
  'line.get_x1': ['line'], 'line.get_y1': ['line'], 'line.get_x2': ['line'], 'line.get_y2': ['line'],
  'line.set_x1': ['line', 'x'], 'line.set_x2': ['line', 'x'],
  'line.set_y1': ['line', 'y'], 'line.set_y2': ['line', 'y'],
  'line.copy': ['line'],
  'line.set_xy1': ['line', 'x', 'y'], 'line.set_xy2': ['line', 'x', 'y'],
  'line.set_color': ['line', 'color'], 'line.set_style': ['line', 'style'],
  'line.set_width': ['line', 'width'], 'line.set_extend': ['line', 'extend'],
  'line.set_xloc': ['line', 'x1', 'x2', 'xloc'],
  'line.get_price': ['line', 'x'],
  'line.set_first_point': ['line', 'point'], 'line.set_second_point': ['line', 'point'],
  'box.delete': ['box'],
  'box.get_left': ['box'], 'box.get_right': ['box'], 'box.get_top': ['box'], 'box.get_bottom': ['box'],
  'box.set_lefttop': ['box', 'left', 'top'], 'box.set_rightbottom': ['box', 'right', 'bottom'],
  'box.set_left': ['box', 'left'], 'box.set_right': ['box', 'right'],
  'box.set_top': ['box', 'top'], 'box.set_bottom': ['box', 'bottom'],
  'box.set_bgcolor': ['box', 'color'], 'box.set_border_color': ['box', 'color'],
  'box.set_border_width': ['box', 'width'], 'box.set_border_style': ['box', 'style'],
  'box.set_extend': ['box', 'extend'], 'box.set_text': ['box', 'text'],
  'box.set_text_color': ['box', 'color'],
  'box.set_xloc': ['box', 'left', 'right', 'xloc'],
  'box.set_text_halign': ['box', 'halign'], 'box.set_text_valign': ['box', 'valign'],
  'box.set_text_wrap': ['box', 'wrap'],
  'box.set_text_font_family': ['box', 'font_family'],
  'box.set_text_formatting': ['box', 'formatting'],
  'box.set_text_size': ['box', 'size'],
  'box.set_top_left_point': ['box', 'point'], 'box.set_bottom_right_point': ['box', 'point'],
  'box.set_first_point': ['box', 'point'], 'box.set_second_point': ['box', 'point'],
  'box.copy': ['box'],
  'label.delete': ['label'],
  'label.get_text': ['label'], 'label.get_x': ['label'], 'label.get_y': ['label'],
  'label.set_xy': ['label', 'x', 'y'],
  'label.set_x': ['label', 'x'], 'label.set_y': ['label', 'y'],
  'label.set_yloc': ['label', 'yloc'], 'label.set_textalign': ['label', 'textalign'],
  'label.set_text_font_family': ['label', 'font_family'],
  'label.set_text_formatting': ['label', 'formatting'],
  'label.set_text': ['label', 'text'], 'label.set_textcolor': ['label', 'textcolor'],
  'label.set_color': ['label', 'color'], 'label.set_style': ['label', 'style'],
  'label.set_size': ['label', 'size'], 'label.set_tooltip': ['label', 'tooltip'],
  'label.set_xloc': ['label', 'x', 'xloc'], 'label.set_point': ['label', 'point'],
  'label.copy': ['label'],
  'linefill.delete': ['linefill'], 'linefill.set_color': ['linefill', 'color'],
  'linefill.get_line1': ['linefill'], 'linefill.get_line2': ['linefill'],
  'polyline.delete': ['polyline'],
  'chart.point.new': ['time', 'index', 'price'], 'chart.point.copy': ['point'],
  'chart.point.from_index': ['index', 'price'], 'chart.point.from_time': ['time', 'price'],
  'chart.point.now': ['price'],
  'timeframe.in_seconds': ['timeframe'], 'timeframe.change': ['timeframe'],
};
function mergeNsArgs(ns, fnName, positional, named) {
  const spec = NS_PARAMS[ns + '.' + fnName];
  if (!spec) return positional;
  const params = spec.p || spec;
  const merged = positional.slice();
  for (let i = 0; i < params.length; i++) {
    if (merged[i] === undefined) {
      const hit = named.find((x) => x.name === params[i]);
      if (hit) merged[i] = hit.value;
    }
  }
  if (spec.pivot && merged[0] === undefined && (merged[1] !== undefined || merged[2] !== undefined)) {
    merged.shift(); // 2-arg (leftbars, rightbars) overload, implicit high/low
  }
  for (const nm of named) {
    if (params.indexOf(nm.name) < 0) throw runtimeError(`${ns}.${fnName}(): unknown argument '${nm.name}'`);
  }
  return merged;
}
/* ROUND209: value-method merge (arr.get(index=...), ln.set_x1(x=...)). The
   receiver is implicit in method form, so slot 0 of the table is skipped.
   Unlisted methods keep the old behavior (named ignored, like round 208's
   non-table families). */
function mergeMethodArgs(kind, fnName, self, positional, named) {
  const spec = NS_PARAMS[kind + '.' + fnName];
  if (!spec) return [self, ...positional];
  const params = (spec.p || spec).slice(1);
  const tail = positional.slice();
  for (let i = 0; i < params.length; i++) {
    if (tail[i] === undefined) {
      const hit = named.find((x) => x.name === params[i]);
      if (hit) tail[i] = hit.value;
    }
  }
  for (const nm of named) {
    if (params.indexOf(nm.name) < 0) throw runtimeError(`${kind}.${fnName}(): unknown argument '${nm.name}'`);
  }
  return [self, ...tail];
}
import { brokerInit, brokerClone, brokerFills, brokerGet, strategyTradeField, pushBrokerBar, brokerStats, strategyFns } from './stdlib/strategy.js';
import { makeInputFn, strInput, sourceInput, BUILTIN_SOURCES } from './stdlib/inputs.js';
import {
  tzParts, exParts, daysInMonth, timestamp, timenow,
} from './stdlib/time.js';

/* ROUND226 (dynamic requests): provisional-NA collection. Records the
   pair WITHOUT throwing so one discovery pass learns the FULL missing set
   (deduped — the same pair recurs every bar). The app fetches everything
   at once and re-runs clean; unfetchable pairs keep the loud error below. */
function recordMissing(rt, rec) {
  const a = rt.missingSymBars || (rt.missingSymBars = []);
  if (!a.some((m) => m.sym === rec.sym && m.sec === rec.sec)) a.push(rec);
}

const MAX_BARS_BACK = 5000;

/* ROUND223 (TV parity): ISO-8601 week number from calendar fields —
   Monday-first, week 1 holds the year's first Thursday (1..53). */
function isoWeek(y, m, d) {
  if (![y, m, d].every((v) => typeof v === 'number' && isFinite(v))) return NA;
  const dt = new Date(Date.UTC(Math.trunc(y), Math.trunc(m) - 1, Math.trunc(d)));
  if (isNaN(dt.getTime())) return NA;
  const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const fday = (first.getUTCDay() + 6) % 7;
  first.setUTCDate(first.getUTCDate() - fday + 3);
  return 1 + Math.round((dt.getTime() - first.getTime()) / 604800000);
}
const BREAK = { __sig: 'break' };
const CONTINUE = { __sig: 'continue' };
/* ROUND156 (TV parity): core OHLCV/time series keep 10000 bars of history
   (TV keeps 10000 for OHLCV/time, 5000 for the rest). */
const OHLCV_BARS_BACK = 10000;
/* ROUND160: builtin OHLCV names readable from the HTF bucket tape. */
const HTF_BUILTINS = new Set(['open', 'high', 'low', 'close', 'volume', 'time',
  'hl2', 'hlc3', 'ohlc4', 'hlcc4']);

/* series-cast handle for input.source */
const srcHandle = (name) => ({ __src: name });

/* ROUND195 (library/import): libraries are computation-only — these belong
   to the importing indicator/strategy (TV parity, loud errors). */
const LIB_BANNED_IDENTS = new Set(['plot', 'plotshape', 'plotchar', 'plotarrow',
  'fill', 'hline', 'bgcolor', 'barcolor', 'plotcandle', 'plotbar',
  'alert', 'alertcondition', 'input']);
const LIB_BANNED_NS = new Set(['strategy', 'input', 'line', 'box', 'label',
  'table', 'polyline', 'linefill']);

/* ------------------------------------------------------------------ */

class PineRuntime {
  constructor(ast, meta, opts) {
    this.ast = ast;
    this.meta = meta || {};
    this.opts = opts || {};
    this.env = {
      timeScale: 1000,             // chart stamps (s) -> Pine times (ms)
      serverOffSec: this.opts.serverOffSec || 0,
      tfSec: this.opts.tfSec || 60,
      mintick: this.opts.mintick || 0.00001,
      symbol: this.opts.symbol || 'UNKNOWN',
      slippageTicks: this.opts.slippageTicks
        || ((this.opts.strategyProps && +this.opts.strategyProps.slippage_ticks) || 0), // ROUND172/phase-2b: adverse fill shift (ticks); ROUND175: also from dialog Properties
      intrabars: this.opts.intrabars || null, // [per-bar M1 arrays] from the renderer
      bar: null,
      barIndex: 0,
      barTimeMs: 0,
      /* ROUND216: live chart theme colors (wired by the renderer; TV parity
         for chart.fg_color / chart.bg_color). */
      chartFg: this.opts.chartFg || null,
      chartBg: this.opts.chartBg || null,
    };
    /* ROUND78 (timezone): the feed stamps bars in the BROKER SERVER wall
     * clock stored as-if-UTC (trueUtc + serverOffSec — the same offset the
     * chart axis uses). Pine's time/timenow/timestamp("GMT",...) live in TRUE
     * UTC (TV parity), so the engine now shifts the script-visible series by
     * -serverOffSec and the render adapter shifts drawing x-times back by
     * +serverOffSec. Session math like 786 Zones (timestamp("GMT") vs M1
     * bar time) then lands boxes at the right wall-clock hour for EVERY
     * broker, not just UTC-anchored feeds. */
    this.disablePureMemo = !!this.opts.disablePureMemo; // bench/A-B flag
    this._gwEpoch = 0;          // global-write epoch (memo invalidation)
    this._memoBarIdx = -1;
    this._userMemo = new Map(); // pure-fn per-bar memo
    this._memoHits = 0;
    this.dry = !!this.opts.dry;
    this.maxBarsBack = this.opts.maxBarsBack || MAX_BARS_BACK;
    /* ROUND198 (tick model): recalculate on every realtime tick, or only at
       bar close (fills still evaluate per tick). Default by declaration:
       strategies false, indicators true (TV parity). */
    this.calcEveryTick = (this.meta && this.meta.calcEveryTick !== undefined)
      ? !!this.meta.calcEveryTick
      : !(this.meta && this.meta.isStrategy);
    /* ROUND152: //@version threading (compile() resolved it from the header;
       house default 5 — TV's own default is v1 but this engine's baseline is
       v5-ish). Gates version-specific semantics (v6 bool strictness). */
    const mv = parseInt(this.meta && this.meta.version, 10);
    this.version = mv >= 1 && mv <= 6 ? mv : 5;
    /* ROUND222a: version rides env so stdlib session parsing (no-days
       default differs v4 vs v5+) can gate without signature churn. */
    this.env.pineVersion = this.version;
    this.maxOpsPerBar = this.opts.maxOpsPerBar || 400000;
    this.maxLoopIter = this.opts.maxLoopIter || 200000;

    this.bars = [];
    this.barIndex = 0;
    this.totalBars = 0;
    this.isForming = false;

    this.globals = new Map();     // name -> { value, kind, hist }
    this.funcs = new Map();       // name -> funcdecl node
    this.sites = new Map();       // siteKey -> persistent state object
    this.histBufs = new Map();    // general expr-history buffers
    this.funcInsts = new Map();   // instanceId -> { scopes, hists, active }
    /* ROUND160: persistent slots for `var`/`varip` declared in TRANSIENT
       scopes (function bodies, if/for/while/switch blocks). _execBlock mints
       a fresh Map per execution, so block/function vars re-initialized on
       every call — LuxAlgo-style `var label x = label.new(...)` inside a
       function then spawned a NEW object per bar (500-cap churn, repeated
       labels). TV initializes such declarations once; keyed by declaration
       node (stable ids), reset only on full recalc. */
    this._varSlots = new Map(); // slotKey -> rec (rollback-participating)
    this.activeFuncs = new Set(); // recursion guard
    this.inputDefs = [];
    this.inputDefIds = new Set();
    this.inputValues = this.opts.inputValues || {};
    this.store = new VisualStore(this.meta.maxCounts || {});
    this.errors = [];
    this.steps = 0;
    this._pointSeq = 0; // ROUND215: unique chart.point ids (reference `==`)

    this.out = this._createOutput();
    this._histPushed = new Set();
    this._htfActiveSite = null; // ROUND160: security call-site owning bucket history reads
    brokerInit(this); // ROUND171/phase-2a: backtester order state (fresh per runtime; reset per full run)
    this._initBuiltins();
    this._registerFunctions();
    /* ROUND195 (library/import, dual-runtime model): one child runtime per
       imported library — the library keeps its own globals/series/sites, so
       two importers (or two call sites) never share state. The market/time
       context is SHARED (same env object: symbol, TF, symBars, offsets). */
    this.isLibrary = !!this.opts.isLibrary;
    this.libs = new Map();
    const libUnits = this.opts.libUnits;
    if (libUnits && typeof libUnits.forEach === 'function') {
      for (const [alias, unit] of libUnits) {
        const child = new PineRuntime(unit.script, unit.meta || {},
          Object.assign({}, this.opts, {
            isLibrary: true, libUnits: unit.units, inputValues: {},
          }));
        child.env = this.env;
        this.libs.set(alias, { alias, title: (unit && unit.title) || alias, rt: child, exports: (unit && unit.exports) || new Map() });
      }
    }
  }

  /* ============================== OUTPUT =============================== */

  _createOutput() {
    return {
      plots: new Map(),       // key -> { key, title, style, linewidth, linestyle, values[], colors[] }
      plotsOrder: [],
      shapes: new Map(),      // key -> { key, style, size, colors[], texts[], ys[] }
      candles: [],            // per-bar plotcandle record { open, high, low, close, color, wickcolor, bordercolor } | null
      /* ROUND166: plotcandle/plotbar descriptor for the Style tab (TV shows
         a "PlotCandle" row). Single slot like TV's per-call outputs — the
         last plotcandle/plotbar call on a bar owns it; title/editable/
         display read from its named args (defaults: title '', editable
         true, display all). */
      candleMeta: null,         // { title, editable, display } | null
      fills: [],              // { p1, p2, colors[], title }
      bgcolor: [],            // per-bar PineColor|null
      barcolor: [],           // per-bar PineColor|null
      hlines: [],
      alertconds: [],         // { title, message }
      alerts: [],
      _pushed: new Set(),     // site keys that pushed on the current bar
      nextId: 1,
    };
  }

  _site(key, init) {
    let s = this.sites.get(key);
    if (!s) { s = init || {}; s.nid = key; this.sites.set(key, s); }
    return s;
  }

  _frameKey(frame) { return frame ? frame.id : 'g'; }

  /* ============================== BUILTINS ============================= */

  _initBuiltins() {
    const G = this.globals;
    const mk = (name, kind) => {
      const rec = { value: NA, kind, hist: new SeriesBuf(this.maxBarsBack) };
      G.set(name, rec);
      return rec;
    };
    for (const s of ['open', 'high', 'low', 'close', 'volume', 'time', 'time_close',
      'hl2', 'hlc3', 'ohlc4', 'hlcc4']) {
      const rec = { value: NA, kind: 'plain', hist: new SeriesBuf(OHLCV_BARS_BACK) };
      G.set(s, rec);
    }
    mk('bar_index', 'plain');
    this._consts = {
      na: NA, true: true, false: false,
      'xloc.bar_index': makeEnumConst('bar_index', 'xloc'),
      'xloc.bar_time': makeEnumConst('bar_time', 'xloc'),
      'plot.style_line': makeEnumConst('line', 'plotstyle'),
      'plot.style_linebr': makeEnumConst('linebr', 'plotstyle'),
      'plot.style_histogram': makeEnumConst('histogram', 'plotstyle'),
      'plot.style_area': makeEnumConst('area', 'plotstyle'),
      'plot.style_areabr': makeEnumConst('areabr', 'plotstyle'),
      'plot.style_columns': makeEnumConst('columns', 'plotstyle'),
      'plot.style_circles': makeEnumConst('circles', 'plotstyle'),
      'plot.style_stepline': makeEnumConst('stepline', 'plotstyle'),
      'plot.style_steplinebr': makeEnumConst('steplinebr', 'plotstyle'),
      'plot.style_stepline_diamond': makeEnumConst('stepline_diamond', 'plotstyle'),
      'plot.style_cross': makeEnumConst('cross', 'plotstyle'),
      /* ROUND171 (phase 2a: backtester): order direction constants. */
      'strategy.long': makeEnumConst('long', 'direction'),
      'strategy.short': makeEnumConst('short', 'direction'),
      /* ROUND189: allow_entry_in directions. */
      'strategy.direction.all': makeEnumConst('all', 'direction'),
      'strategy.direction.long': makeEnumConst('long', 'direction'),
      'strategy.direction.short': makeEnumConst('short', 'direction'),
      /* ROUND172 (phase 2b: account): qty/commission type constants. */
      'strategy.fixed': makeEnumConst('fixed', 'qtytype'),
      'strategy.cash': makeEnumConst('cash', 'qtytype'),
      'strategy.percent_of_equity': makeEnumConst('percent', 'qtytype'),
      'strategy.commission.percent': makeEnumConst('percent', 'commtype'),
      'strategy.commission.cash_per_contract': makeEnumConst('cash_per_contract', 'commtype'),
      'strategy.commission.cash_per_order': makeEnumConst('cash_per_order', 'commtype'),
      /* ROUND188: OCA group types (entry/order/exit oca_type) */
      'strategy.oca.cancel': makeEnumConst('cancel', 'ocatype'),
      'strategy.oca.reduce': makeEnumConst('reduce', 'ocatype'),
      'plot.linestyle_solid': makeEnumConst('solid', 'linestyle'),
      'plot.linestyle_dotted': makeEnumConst('dotted', 'linestyle'),
      'plot.linestyle_dashed': makeEnumConst('dashed', 'linestyle'),
      'line.style_solid': makeEnumConst('solid', 'linestyle'),
      'line.style_dotted': makeEnumConst('dotted', 'linestyle'),
      'line.style_dashed': makeEnumConst('dashed', 'linestyle'),
      'line.style_arrow_left': makeEnumConst('arrow_left', 'linestyle'),
      'line.style_arrow_right': makeEnumConst('arrow_right', 'linestyle'),
      'line.style_arrow_both': makeEnumConst('arrow_both', 'linestyle'),
      'hline.style_solid': makeEnumConst('solid', 'linestyle'),
      'hline.style_dotted': makeEnumConst('dotted', 'linestyle'),
      'hline.style_dashed': makeEnumConst('dashed', 'linestyle'),
      'hline.style_arrow_left': makeEnumConst('arrow_left', 'linestyle'),
      'hline.style_arrow_right': makeEnumConst('arrow_right', 'linestyle'),
      'hline.style_arrow_both': makeEnumConst('arrow_both', 'linestyle'),
      'box.style_solid': makeEnumConst('solid', 'linestyle'),
      'box.style_dotted': makeEnumConst('dotted', 'linestyle'),
      'box.style_dashed': makeEnumConst('dashed', 'linestyle'),
      'label.style_none': makeEnumConst('none', 'labelstyle'),
      'label.style_label_up': makeEnumConst('label_up', 'labelstyle'),
      'label.style_label_down': makeEnumConst('label_down', 'labelstyle'),
      'label.style_label_left': makeEnumConst('label_left', 'labelstyle'),
      'label.style_label_right': makeEnumConst('label_right', 'labelstyle'),
      'label.style_label_center': makeEnumConst('label_center', 'labelstyle'),
      'label.style_label_lower_left': makeEnumConst('label_lower_left', 'labelstyle'),
      'label.style_label_lower_right': makeEnumConst('label_lower_right', 'labelstyle'),
      'label.style_label_upper_left': makeEnumConst('label_upper_left', 'labelstyle'),
      'label.style_label_upper_right': makeEnumConst('label_upper_right', 'labelstyle'),
      'label.style_labelup': makeEnumConst('label_up', 'labelstyle'),
      'label.style_labeldown': makeEnumConst('label_down', 'labelstyle'),
      'label.style_text_outline': makeEnumConst('label_center', 'labelstyle'),
      'label.style_circle': makeEnumConst('label_center', 'labelstyle'),
      'label.style_arrowup': makeEnumConst('label_up', 'labelstyle'),
      'label.style_arrowdown': makeEnumConst('label_down', 'labelstyle'),
      'size.auto': makeEnumConst('auto', 'size'),
      'size.tiny': makeEnumConst('tiny', 'size'),
      'size.small': makeEnumConst('small', 'size'),
      'size.normal': makeEnumConst('normal', 'size'),
      'size.large': makeEnumConst('large', 'size'),
      'size.huge': makeEnumConst('huge', 'size'),
      'shape.xcross': makeEnumConst('xcross', 'shape'),
      'shape.cross': makeEnumConst('cross', 'shape'),
      'shape.circle': makeEnumConst('circle', 'shape'),
      'shape.triangleup': makeEnumConst('triangleup', 'shape'),
      'shape.triangledown': makeEnumConst('triangledown', 'shape'),
      'shape.flag': makeEnumConst('flag', 'shape'),
      'shape.square': makeEnumConst('square', 'shape'),
      'shape.diamond': makeEnumConst('diamond', 'shape'),
      'shape.arrowup': makeEnumConst('arrowup', 'shape'),
      'shape.arrowdown': makeEnumConst('arrowdown', 'shape'),
      'shape.labelup': makeEnumConst('labelup', 'shape'),
      'shape.labeldown': makeEnumConst('labeldown', 'shape'),
      'shape.triangleleft': makeEnumConst('triangleleft', 'shape'),
      'shape.triangleright': makeEnumConst('triangleright', 'shape'),
      'shape.arrowleft': makeEnumConst('arrowleft', 'shape'),
      'shape.arrowright': makeEnumConst('arrowright', 'shape'),
      'shape.squareleft': makeEnumConst('squareleft', 'shape'),
      'shape.squareright': makeEnumConst('squareright', 'shape'),
      'location.abovebar': makeEnumConst('abovebar', 'location'),
      'location.belowbar': makeEnumConst('belowbar', 'location'),
      'location.top': makeEnumConst('top', 'location'),
      'location.bottom': makeEnumConst('bottom', 'location'),
      'location.absolute': makeEnumConst('absolute', 'location'),
      'extend.none': makeEnumConst('none', 'extend'),
      'extend.left': makeEnumConst('left', 'extend'),
      'extend.right': makeEnumConst('right', 'extend'),
      'extend.both': makeEnumConst('both', 'extend'),
      'format.price': makeEnumConst('price', 'format'),
      'format.volume': makeEnumConst('volume', 'format'),
      'format.inherit': makeEnumConst('inherit', 'format'),
      /* ROUND140: constants listed in the v6 visuals docs that were missing */
      'yloc.price': makeEnumConst('price', 'yloc'),
      'yloc.abovebar': makeEnumConst('abovebar', 'yloc'),
      'yloc.belowbar': makeEnumConst('belowbar', 'yloc'),
      'display.pane': makeEnumConst('pane', 'display'),
      'format.percent': makeEnumConst('percent', 'format'),
      'text.wrap_auto': makeEnumConst('auto', 'textwrap'),
      'text.wrap_none': makeEnumConst('none', 'textwrap'),
      'text.format_none': makeEnumConst('none', 'textformat'),
      'text.format_bold': makeEnumConst('bold', 'textformat'),
      'text.format_italic': makeEnumConst('italic', 'textformat'),
      'font.family_default': makeEnumConst('default', 'font'),
      'font.family_monospace': makeEnumConst('monospace', 'font'),
      /* shape-type label styles: real style names — drawn as glyphs by the renderer */
      'label.style_xcross': makeEnumConst('xcross', 'labelstyle'),
      /* ROUND151: sort order (array.sort(arr, order.*) — AlgoAlpha et al.) */
      'order.ascending': makeEnumConst('ascending', 'order'),
      'order.descending': makeEnumConst('descending', 'order'),
      'label.style_cross': makeEnumConst('cross', 'labelstyle'),
      'label.style_square': makeEnumConst('square', 'labelstyle'),
      'label.style_diamond': makeEnumConst('diamond', 'labelstyle'),
      'label.style_flag': makeEnumConst('flag', 'labelstyle'),
      'label.style_triangleup': makeEnumConst('triangleup', 'labelstyle'),
      'label.style_triangledown': makeEnumConst('triangledown', 'labelstyle'),
      'display.all': makeEnumConst('all', 'display'),
      'display.none': makeEnumConst('none', 'display'),
      'display.data_window': makeEnumConst('data_window', 'display'),
      'display.price_scale': makeEnumConst('price_scale', 'display'),
      'display.status_line': makeEnumConst('status_line', 'display'),
      'scale.right': makeEnumConst('right', 'scale'),
      'scale.left': makeEnumConst('left', 'scale'),
      'scale.none': makeEnumConst('none', 'scale'),
      /* ROUND151: table positions + mintick format (LuxAlgo dashboards) */
      'position.top_left': makeEnumConst('top_left', 'position'),
      'position.top_center': makeEnumConst('top_center', 'position'),
      'position.top_right': makeEnumConst('top_right', 'position'),
      'position.middle_left': makeEnumConst('middle_left', 'position'),
      'position.middle_center': makeEnumConst('middle_center', 'position'),
      'position.middle_right': makeEnumConst('middle_right', 'position'),
      'position.bottom_left': makeEnumConst('bottom_left', 'position'),
      'position.bottom_center': makeEnumConst('bottom_center', 'position'),
      'position.bottom_right': makeEnumConst('bottom_right', 'position'),
      'format.mintick': makeEnumConst('mintick', 'format'),
      'text.align_center': makeEnumConst('center', 'textalign'),
      'text.align_left': makeEnumConst('left', 'textalign'),
      'text.align_right': makeEnumConst('right', 'textalign'),
      'text.align_top': makeEnumConst('top', 'textvalign'),
      'text.align_bottom': makeEnumConst('bottom', 'textvalign'),
      'adjustment.none': makeEnumConst('none', 'adjustment'),
      'adjustment.split': makeEnumConst('split', 'adjustment'),
      'adjustment.dividends': makeEnumConst('dividends', 'adjustment'),
      /* ROUND206 (TV parity): the full currency.* roster (was USD/EUR/NONE
         only, so strategy(currency=currency.GBP) failed name resolution).
         The account currency rides the declaration into broker cfg (folded in
         compile.js) and surfaces via strategy.account_currency + the tester. */
      'currency.AED': makeEnumConst('AED', 'currency'),
      'currency.ARS': makeEnumConst('ARS', 'currency'),
      'currency.AUD': makeEnumConst('AUD', 'currency'),
      'currency.BDT': makeEnumConst('BDT', 'currency'),
      'currency.BHD': makeEnumConst('BHD', 'currency'),
      'currency.BMD': makeEnumConst('BMD', 'currency'),
      'currency.BRL': makeEnumConst('BRL', 'currency'),
      'currency.CAD': makeEnumConst('CAD', 'currency'),
      'currency.CHF': makeEnumConst('CHF', 'currency'),
      'currency.CLP': makeEnumConst('CLP', 'currency'),
      'currency.CNY': makeEnumConst('CNY', 'currency'),
      'currency.COP': makeEnumConst('COP', 'currency'),
      'currency.CZK': makeEnumConst('CZK', 'currency'),
      'currency.DKK': makeEnumConst('DKK', 'currency'),
      'currency.EGP': makeEnumConst('EGP', 'currency'),
      'currency.EUR': makeEnumConst('EUR', 'currency'),
      'currency.GBP': makeEnumConst('GBP', 'currency'),
      'currency.HKD': makeEnumConst('HKD', 'currency'),
      'currency.HUF': makeEnumConst('HUF', 'currency'),
      'currency.IDR': makeEnumConst('IDR', 'currency'),
      'currency.ILS': makeEnumConst('ILS', 'currency'),
      'currency.INR': makeEnumConst('INR', 'currency'),
      'currency.JPY': makeEnumConst('JPY', 'currency'),
      'currency.KRW': makeEnumConst('KRW', 'currency'),
      'currency.KWD': makeEnumConst('KWD', 'currency'),
      'currency.LKR': makeEnumConst('LKR', 'currency'),
      'currency.MMK': makeEnumConst('MMK', 'currency'),
      'currency.MXN': makeEnumConst('MXN', 'currency'),
      'currency.MYR': makeEnumConst('MYR', 'currency'),
      'currency.NGN': makeEnumConst('NGN', 'currency'),
      'currency.NOK': makeEnumConst('NOK', 'currency'),
      'currency.NZD': makeEnumConst('NZD', 'currency'),
      'currency.PEN': makeEnumConst('PEN', 'currency'),
      'currency.PHP': makeEnumConst('PHP', 'currency'),
      'currency.PKR': makeEnumConst('PKR', 'currency'),
      'currency.PLN': makeEnumConst('PLN', 'currency'),
      'currency.QAR': makeEnumConst('QAR', 'currency'),
      'currency.RON': makeEnumConst('RON', 'currency'),
      'currency.RUB': makeEnumConst('RUB', 'currency'),
      'currency.SAR': makeEnumConst('SAR', 'currency'),
      'currency.SEK': makeEnumConst('SEK', 'currency'),
      'currency.SGD': makeEnumConst('SGD', 'currency'),
      'currency.THB': makeEnumConst('THB', 'currency'),
      'currency.TRY': makeEnumConst('TRY', 'currency'),
      'currency.TWD': makeEnumConst('TWD', 'currency'),
      'currency.USD': makeEnumConst('USD', 'currency'),
      'currency.VND': makeEnumConst('VND', 'currency'),
      'currency.ZAR': makeEnumConst('ZAR', 'currency'),
      'currency.NONE': makeEnumConst('NONE', 'currency'),
      'barmerge.gaps_off': makeEnumConst('gaps_off', 'barmerge'),
      'barmerge.gaps_on': makeEnumConst('gaps_on', 'barmerge'),
      'barmerge.lookahead_off': makeEnumConst('lookahead_off', 'barmerge'),
      'barmerge.lookahead_on': makeEnumConst('lookahead_on', 'barmerge'),
      /* ROUND216 (TV parity): alert() frequency constants. The engine
         collects alert messages without firing (out.alerts), so these are
         accepted values; unqualified use stays loud via the ident path. */
      'alert.freq_once_per_bar': makeEnumConst('once_per_bar', 'alertfreq'),
      'alert.freq_once_per_bar_close': makeEnumConst('once_per_bar_close', 'alertfreq'),
      'alert.freq_all': makeEnumConst('all', 'alertfreq'),
      /* ===== v4 legacy BARE style/location/shape constants (no namespace) =====
         v4 scripts write style=histogram, location=location.absolute (v4 has
         no dotted namespaces on some names), shape labels bare, etc. */
      histogram: makeEnumConst('histogram', 'plotstyle'),
      linebr: makeEnumConst('linebr', 'plotstyle'),
      cross: makeEnumConst('cross', 'plotstyle'),
      circles: makeEnumConst('circles', 'plotstyle'),
      solid: makeEnumConst('solid', 'linestyle'),
      dashed: makeEnumConst('dashed', 'linestyle'),
      dotted: makeEnumConst('dotted', 'linestyle'),
      labelup: makeEnumConst('labelup', 'shape'),
      labeldown: makeEnumConst('labeldown', 'shape'),
      'location.absolute': makeEnumConst('absolute', 'location'),
    };
    for (const k of Object.keys(this._consts)) G.set(k, { value: this._consts[k], kind: 'plain', hist: null });
  }

  /** resolve a dotted constant/namespace path like 'plot.linestyle_solid' */
  _constPath(base, name) {
    if (base === 'color' && colorConsts[name]) {
      /* ROUND225 (TV parity): v6 re-toned red/teal/yellow (migration guide);
         older versions keep the v5 hexes. */
      const tones = (this.version || 5) >= 6
        ? { red: '#f23645', teal: '#089981', yellow: '#fdd835' }
        : { red: '#ff5252', teal: '#00897b', yellow: '#ffeb3b' };
      if (tones[name]) return toColor(tones[name]);
      return colorConsts[name];
    }
    return this._consts[base + '.' + name] || undefined;
  }

  _registerFunctions() {
    const rt = this;
    this.nsFns = {
      ta: taFns,
      math: mathFns,
      str: strFns,
      color: colorFns,
      array: this._arrayFns(),
      line: this._lineFns(),
      box: this._boxFns(),
      label: this._labelFns(),
      polyline: this._polylineFns(),
      linefill: this._linefillFns(),
      table: this._tableFns(),
      matrix: this._matrixFns(), // ROUND196: real 2-D collections (was a stub)
      map: this._mapFns(), // ROUND196: real key-value maps (was a stub)
      ticker: this._tickerFns(), // ROUND202 new/heikinashi + ROUND207 renko-family (all real)
      session: sessionFns, // ROUND201: market/pre/post session predicates (was a stub)
      strategy: strategyFns(this), // ROUND171/phase-2a: real order engine (was a stub)
      request: this._stubNs('request'),
      footprint: this._stubNs('footprint'), // ROUND230: loud per-function (tick feed + Premium)
      volume_row: this._stubNs('volume_row'), // ROUND230: loud per-function (tick feed + Premium)
      chart: {
        new: () => { throw runtimeError('internal: chart.new is not a function'); },
        point: {
          /* ROUND215: points carry a unique id so `==` is reference equality
             (like line/box/label) instead of undefined===undefined (always
             true). copy() mints a fresh id, like line.copy(). */
          new: (site, timeV, indexV, priceV) => ({
            __pineObj: true, kind: 'point', id: 'pt' + (++this._pointSeq),
            time: isNA(timeV) ? null : timeV,
            index: isNA(indexV) ? null : indexV,
            price: isNA(priceV) ? null : priceV,
          }),
          copy: (site, p) => ({ __pineObj: true, kind: 'point', id: 'pt' + (++this._pointSeq), time: p && p.time, index: p && p.index, price: p && p.price }),
          /* ROUND140: the three documented constructors */
          from_index: (site, idx, price) => ({ __pineObj: true, kind: 'point', id: 'pt' + (++this._pointSeq), time: null, index: isNA(idx) ? null : Math.trunc(idx), price: isNA(price) ? null : price }),
          from_time: (site, t, price) => ({ __pineObj: true, kind: 'point', id: 'pt' + (++this._pointSeq), time: isNA(t) ? null : t, index: null, price: isNA(price) ? null : price }),
          now: (site, price) => ({ __pineObj: true, kind: 'point', id: 'pt' + (++this._pointSeq), time: this.env.barTimeMs != null ? this.env.barTimeMs : null, index: this.barIndex, price: isNA(price) ? null : price }),
        },
      },
    };
    this.plainFns = {
      na: (site, ...args) => (args.length ? args.some((a) => isNA(a)) : NA),
      nz: (site, x, repl) => (isNA(x) ? (repl === undefined ? 0 : repl) : x),
      fixnan: function (site, x) { if (!isNA(x)) site.last = x; return site.last == null ? NA : site.last; },
      /* ROUND225 (TV parity): iff()/offset() were REMOVED in v5 — loud for
         v6 scripts (impossible on TV); v5 and older stay lenient because
         headerless legacy scripts (SQZMOM) run at the house default 5. */
      iff: (site, c, a, b) => {
        if (rt.version >= 6) throw runtimeError('iff() was removed in Pine v5 — use the ?: operator instead');
        return truthy(c) ? a : b;
      },      timestamp: (site, ...args) => timestamp(this.env, ...args),
      timenow: () => timenow(),
      year: this._timeGetter((p) => p.year),
      month: this._timeGetter((p) => p.month),
      dayofmonth: this._timeGetter((p) => p.day),
      dayofweek: this._timeGetter((p) => p.dow + 1), // ROUND199: Pine counts Sunday=1..Saturday=7 (getUTCDay gives 0..6)
      hour: this._timeGetter((p) => p.hour),
      minute: this._timeGetter((p) => p.minute),
      second: this._timeGetter((p) => p.second),
      /* ROUND223 (TV parity): ISO-8601 week number (Monday-first, week 1
         holds the first Thursday). Wall-calendar fields, like the siblings. */
      weekofyear: this._timeGetter((p) => isoWeek(p.year, p.month, p.day)),
      /* ROUND223: bid/ask need a quote feed this app does not have (trade
         ticks only) — na, like TV on history. Loud->na turns dead scripts
         into degraded ones (R222 principle). */
      bid: () => NA,
      ask: () => NA,
      /* ROUND223: max_bars_back() is a buffer-sizing declaration; engine
         buffers are already 10k (OHLCV) / 5k deep, so accept-and-ignore
         (return na — no known script consumes the return value). */
      max_bars_back: (site, ...a) => NA,
      int: (site, x) => (isNA(x) ? NA : (typeof x === 'boolean' ? (x ? 1 : 0) : (typeof x === 'number' ? (isFinite(x) ? Math.trunc(x) : NA) : NA))),
      float: (site, x) => (isNA(x) ? NA : (typeof x === 'number' ? pineNum(x) : (typeof x === 'boolean' ? (x ? 1 : 0) : NA))),
      /* ROUND233 (TV parity, reference §bool verbatim): "Returns false if x
         is na, false, or an int/float value equal to 0. Returns true for all
         other possible values." truthy() is exactly that mapping (na-safe),
         so bool() output is NEVER na. nz() stays lenient (passthrough incl.
         strings/colors — TV compile-rejects those, but passing them through
         can never corrupt a backtest; documented engine contract). */
      bool: (site, x) => truthy(x),
      string: (site, x) => (isNA(x) ? NA : (x && x.css ? x.css() : String(x))),
      color: (site, x) => { const c = toColor(x); return c || NA; },
      /* ===== legacy v4 bare-function aliases (pre-namespace scripts) =====
         v4 scripts (still widely copied on TV) call sma()/ema()/... without
         the ta. prefix and use tr/atr()/barcolor constants bare. The same
         kernels back both forms, so aliasing here keeps ONE source of truth. */
      sma: (site, s, l) => taFns.sma(site, s, l),
      ema: (site, s, l) => taFns.ema(site, s, l),
      rma: (site, s, l) => taFns.rma(site, s, l),
      wma: (site, s, l) => taFns.wma(site, s, l),
      vwma: (site, s, v, l) => taFns.vwma(site, s, v, l),
      hma: (site, s, l) => taFns.hma(site, s, l),
      /* ROUND222a (v4 parity): rsi(x, float-len) is the REMOVED v4 second
         overload (MFI-style formula per the v4→v5 guide), not a long length.
         Gate on value (non-integer len) for version<5; v5+ keeps ta.rsi. */
      rsi: (site, s, l) => {
        const lv = num(l);
        if (rt.version < 5 && isFinite(lv) && Math.trunc(lv) !== lv) {
          const a = num(s);
          if (!isFinite(a) || lv === 0) return NA;
          return pineNum(100 - 100 / (1 + a / lv));
        }
        return taFns.rsi(site, s, l);
      },
      atr: (site, l) => taFns.atr(site, l),
      tr: (site, h) => taFns.tr(site, h),
      stdev: (site, ...a) => taFns.stdev(site, ...a),
      dev: (site, s, l) => taFns.dev(site, s, l),
      macd: (site, s, f, sl, sig) => taFns.macd(site, s, f, sl, sig),
      linreg: (site, s, l, o) => taFns.linreg(site, s, l, o),
      highest: (site, s, l) => taFns.highest(site, s, l),
      lowest: (site, s, l) => taFns.lowest(site, s, l),
      change: (site, s) => taFns.change(site, s),
      mom: (site, s, l) => taFns.mom(site, s, l),
      roc: (site, s, l) => taFns.roc(site, s, l),
      crossover: (site, a, b) => taFns.crossover(site, a, b),
      crossunder: (site, a, b) => taFns.crossunder(site, a, b),
      cross: (site, a, b) => taFns.cross(site, a, b),
      cum: (site, s) => taFns.cum(site, s),
      /* ROUND227 (TV parity): v4 bare range() (migration-list rename). */
      range: (site, ...a) => taFns.range(site, ...a),
      pivothigh: (site, ...a) => taFns.pivothigh(site, ...a),
      pivotlow: (site, ...a) => taFns.pivotlow(site, ...a),
      valuewhen: (site, ...a) => taFns.valuewhen(site, ...a),
      barssince: (site, c) => taFns.barssince(site, c),
      falling: (site, s, l) => taFns.falling(site, s, l),
      rising: (site, s, l) => taFns.rising(site, s, l),
      sar: (site, ...a) => taFns.sar(site, ...a),
      stoch: (site, ...a) => taFns.stoch(site, ...a),
      cci: (site, s, l) => taFns.cci(site, s, l),
      mfi: (site, s, l) => taFns.mfi(site, s, l),
      wpr: (site, l) => taFns.wpr(site, l),
      bb: (site, s, l, m) => taFns.bb(site, s, l, m),
      bbw: (site, s, l, m) => taFns.bbw(site, s, l, m),
      supertrend: (site, f, l) => taFns.supertrend(site, f, l),
      vwap: (site, s) => taFns.vwap(site, s),
      obv: (site, v) => taFns.obv(site, v),
      /* ROUND222a (v4 parity): complete the bare-alias table to the official
         v4→v5 rename list — each forwards to the same kernel as its
         namespaced form (one source of truth). ta.range() is NOT included:
         its TV semantics could not be verified offline, so it stays loud
         intentionally (audit §A). */
      alma: (site, s, l, o, g) => taFns.alma(site, s, l, o, g),
      cmo: (site, s, l) => taFns.cmo(site, s, l),
      cog: (site, s, l) => taFns.cog(site, s, l),
      correlation: (site, x, y, l) => taFns.correlation(site, x, y, l),
      dmi: (site, a, b) => taFns.dmi(site, a, b),
      kc: (site, s, l, m) => taFns.kc(site, s, l, m),
      kcw: (site, s, l, m) => taFns.kcw(site, s, l, m),
      median: (site, s, l) => taFns.median(site, s, l),
      mode: (site, s, l) => taFns.mode(site, s, l),
      percentile_linear_interpolation: (site, s, p) => taFns.percentile_linear_interpolation(site, s, p),
      percentile_nearest_rank: (site, s, p) => taFns.percentile_nearest_rank(site, s, p),
      percentrank: (site, s, l) => taFns.percentrank(site, s, l),
      rci: (site, s, l) => taFns.rci(site, s, l),
      swma: (site, s) => taFns.swma(site, s),
      tsi: (site, s, a, b) => taFns.tsi(site, s, a, b),
      variance: (site, ...a) => taFns.variance(site, ...a),
      /* ROUND222a: v4 offset(source, n) == source[n] — per-site trailing
         buffer (same snapshot/rollback semantics as the ta Win helpers).
         Buffer keeps max-k-ever-seen + 1 values: exact for any k path.
         ROUND234 (parity with the [] operator, same file): negative n is na
         (was clamped to 0); na n reads current like [k] does. Series n keeps
         working (adaptive buffer) — consistent with _evalIndex, which reads
         the current bar's k the same way. */
      /* ROUND225: offset() was removed in v5 — loud for v6 (see iff). */
      offset: (site, src, n) => {
        if (rt.version >= 6) throw runtimeError('offset() was removed in Pine v5 — use the [] operator instead');
        if (isNA(n)) n = 0;
        const k = Math.trunc(num(n));
        if (!isFinite(k) || k < 0) return NA;
        if (!site.obuf) { site.obuf = []; site.omax = 0; }
        if (k > site.omax) site.omax = k;
        site.obuf.push(src);
        if (site.obuf.length > site.omax + 1) site.obuf.splice(0, site.obuf.length - site.omax - 1);
        if (site.obuf.length <= k) return NA;
        const v = site.obuf[site.obuf.length - 1 - k];
        return v === undefined ? NA : v;
      },
      /* legacy built-in variable FUNCTIONS (v4): atr(Periods) style */
      avg: (site, ...a) => {
        // v4 avg(...) == math.avg — fold to mathFns
        return mathFns.avg(site, ...a);
      },
      min: (site, ...a) => mathFns.min(site, ...a),
      max: (site, ...a) => mathFns.max(site, ...a),
      round: (site, x, p) => mathFns.round(site, x, p),
      abs: (site, x) => mathFns.abs(site, x),
      /* ROUND222a (v4 parity): remaining bare math names from the v4→v5 list. */
      acos: (site, x) => mathFns.acos(site, x),
      asin: (site, x) => mathFns.asin(site, x),
      atan: (site, x) => mathFns.atan(site, x),
      cos: (site, x) => mathFns.cos(site, x),
      sin: (site, x) => mathFns.sin(site, x),
      tan: (site, x) => mathFns.tan(site, x),
      log10: (site, x) => mathFns.log10(site, x),
      random: (site, ...a) => mathFns.random(site, ...a),
      round_to_mintick: (site, x) => mathFns.round_to_mintick(site, x),
      sum: (site, ...a) => mathFns.sum(site, ...a),
      todegrees: (site, x) => mathFns.todegrees(site, x),
      toradians: (site, x) => mathFns.toradians(site, x),
      /* ROUND222a (v4 parity): bare ticker constructors (v4→v5 renames). */
      heikinashi: (site, s) => tickerHeikinashi(s),
      renko: (site, s, t, b) => tickerRenko(s, t, b),
      kagi: (site, s, t, r) => tickerKagi(s, t, r),
      linebreak: (site, s, t, n) => tickerLinebreak(s, t, n),
      pointfigure: (site, s, t, b, r) => tickerPointfigure(s, t, b, r),
      ceil: (site, x) => mathFns.ceil(site, x),
      floor: (site, x) => mathFns.floor(site, x),
      sqrt: (site, x) => mathFns.sqrt(site, x),
      pow: (site, x, y) => mathFns.pow(site, x, y),
      exp: (site, x) => mathFns.exp(site, x),
      log: (site, x) => mathFns.log(site, x),
      sign: (site, x) => mathFns.sign(site, x),
      tostring: (site, ...a) => strFns.tostring(site, ...a),
      tonumber: (site, ...a) => strFns.tonumber(site, ...a),
      /* ROUND222a (v4 parity): bare tickerid() call (v4→ticker.new rename). */
      tickerid: (site) => rt._syminfoProp('tickerid'),
      syminfo: null, // handled via consts
    };
    this.inputFns = {
      bool: (site, defval, title, rest) => this._input(site, 'bool', defval, title, rest),
      int: (site, defval, title, rest) => this._input(site, 'int', defval, title, rest),
      float: (site, defval, title, rest) => this._input(site, 'float', defval, title, rest),
      string: (site, defval, title, rest) => strInput(this, site, defval, title, rest),
      color: (site, defval, title, rest) => this._input(site, 'color', defval, title, rest),
      source: (site, defval, title, rest) => sourceInput(this, site, defval, title, rest),
      price: (site, defval, title, rest) => this._input(site, 'float', defval, title, rest),
      text_area: (site, defval, title, rest) => this._input(site, 'textarea', defval, title, rest),
      /* ROUND190: TV spells it input.textarea (multiline text input, §11). */
      /* ROUND220: kind 'textarea' (was 'string') so the settings dialog
         renders a multiline box like TV; engine value flow is identical. */
      textarea: (site, defval, title, rest) => this._input(site, 'textarea', defval, title, rest),
      time: (site, defval, title, rest) => this._input(site, 'int', defval, title, rest),
      enum: (site, defval, title, rest) => this._input(site, 'string', defval, title, rest),
      /* timeframe/symbol/session resolve to plain strings — the chart's own
         symbol/TF stay the real data source (security() ignores a different
         symbol request until the provider-side feed lands) */
      timeframe: (site, defval, title, rest) => this._input(site, 'string', defval, title, rest),
      symbol: (site, defval, title, rest) => this._input(site, 'string', defval, title, rest),
      session: (site, defval, title, rest) => this._input(site, 'string', defval, title, rest),
    };
    this.visualFns = {
      plot: (a) => this._fnPlot(a),
      plotshape: (a) => this._fnPlotshape(a),
      plotchar: (a) => this._fnPlotshape(a, true),
      plotarrow: (a) => this._fnPlotarrow(a),
      plotcandle: (a) => this._fnPlotcandle(a),
      plotbar: (a) => this._fnPlotcandle(a),
      bgcolor: (a) => this._fnBgcolor(a),
      barcolor: (a) => this._fnBarcolor(a),
      fill: (a) => this._fnFill(a),
      hline: (a) => this._fnHline(a),
      alertcondition: (a) => this._fnAlertcondition(a),
      alert: (a) => this._fnAlert(a),
    };
    this.requestFns = {
      security: (positional, named, node, frame) => {
        /* round 133: same-symbol higher-TF resampling (offline, from the
           chart's own bars). ROUND168 (phase 1a): a DIFFERENT symbol runs
           the same machinery over prefetched bars (env.symBars) instead
           of throwing.
           ROUND208 (named-args parity): symbol=/timeframe=/expression=
           fill the positional slots (a named timeframe= used to be dropped,
           silently reading the chart TF instead of the bucket TF). Gaps +
           lookahead keep their path; calc_bars_count/ignore_invalid_symbol
           are accepted-ignored (full history is always computed); anything
           else named is loud like TV. */
        const nm = (n) => { const h = (named || []).find((x) => x.name === n); return h ? h.value : undefined; };
        const pos = positional.slice();
        for (const [i, pname] of [[0, 'symbol'], [1, 'timeframe'], [2, 'expression']]) {
          if (pos[i] === undefined) { const v = nm(pname); if (v !== undefined) pos[i] = v; }
        }
        for (const h of (named || [])) {
          if (['symbol', 'timeframe', 'expression', 'gaps', 'lookahead', 'ignore_invalid_symbol', 'calc_bars_count', 'currency'].indexOf(h.name) < 0) {
            throw runtimeError(`request.security(): unknown argument '${h.name}'`);
          }
        }
        /* ROUND230 (TV parity): currency= conversion needs a daily FX feed.
           Same-as-chart (syminfo.currency, USD on this offline feed) is a
           no-op; anything else is loud, never a silent unconverted value. */
        const curH = (named || []).find((x) => x.name === 'currency');
        const cur230s = (curH && curH.value != null && !isNA(curH.value)) ? normCurrency(curH.value) : '';
        if (cur230s !== '' && cur230s !== 'USD') throw runtimeError(`request.security(): currency='${cur230s}' conversion needs a daily FX feed this offline engine does not have`);
        const sym = pos[0];
        /* ROUND202: ticker handles — ticker.new() passes its symbol through;
           ticker.heikinashi() runs the same machinery over HA-transformed
           OHLC (times/volumes untouched).
           ROUND207: synthetic chart-type tickers (renko/linebreak/kagi/
           pointfigure) resolve their base timeframe here and ride x.synth;
           request-security substitutes the formation bars, then buckets them
           at the destination TF. Base < chart TF is loud (sub-chart data
           doesn't exist offline); cross-symbol needs prefetched base-TF bars
           (recorded for the app retry loop, round-170 pattern). */
        const tick = isTicker(sym) ? sym : null;
        const symStr = tick ? tick.sym : (isNA(sym) ? '' : String(sym == null ? '' : sym));
        const haMode = !!tick && tick.kind === 'heikinashi';
        /* ROUND211: ticker.new session filter rides x.session (filtered
           before bucketing in request-security); ignore_invalid_symbol=true
           turns missing cross-symbol data into na (TV parity) instead of
           the loud missing-data error (the retry loop keys on that error,
           so it only applies after prefetch+retry found nothing — here that
           means symBars lookup missed). */
        const tickSession = (tick && tick.session) || '';
        const ignoreBad = nm('ignore_invalid_symbol') === true;
        const synthTick = tick && SYNTH_TICKER[tick.kind] ? tick : null;
        const synthSpec = (() => {
          if (!synthTick) return null;
          const tfs = (!synthTick.tf || synthTick.tf === '') ? (this.env.tfSec || 60) : tfSeconds(synthTick.tf);
          if (!tfs || tfs <= 0) throw runtimeError(`request.security: ticker.${synthTick.kind} timeframe is not usable`);
          if (tfs < (this.env.tfSec || 60)) {
            throw runtimeError(`request.security: ticker.${synthTick.kind}("${synthTick.tf}") is lower than the chart's timeframe — synthetic chart types need base data at or above the chart TF`);
          }
          const params = {};
          if (synthTick.kind === 'renko') params.brick = synthTick.brick;
          else if (synthTick.kind === 'linebreak') params.lines = synthTick.lines;
          else if (synthTick.kind === 'kagi') params.reversal = synthTick.reversal;
          else { params.box = synthTick.box; params.revBoxes = synthTick.revBoxes; }
          return { kind: synthTick.kind, baseSec: tfs,
            pstr: JSON.stringify(params), params };
        })();
        const cur = this.env.symbol || '';
        const symBare = symStr.replace(/^[A-Z]+:/, '');
        const sameSym = !symStr || !symBare || !cur || cur.includes(symBare) || symStr.includes(cur);
        /* The expression's RAW AST (named expression= maps to the same
           slot — node.args order is call order, not parameter order). */
        const exprWrap = (node.args || []).find((a) => a && a.name === 'expression') ||
          (node.args || [])[2] || null;
        const exprNode = exprWrap ? exprWrap.value : null;
        /* ROUND160: per-call-site key for the HTF bucket tape (builtin
           history inside security expressions). Stable across bars. */
        const siteKey = this._frameKey(frame) + ':sec:' + node.id;
        if (!sameSym) {
          /* Cross-symbol history: the app prefetches literal security()
             pairs into env.symBars['SYM|sec'] (§12, same strip rule as
             symBare above). Time-aligned (last bar at-or-before chart time
             — no future leak); [k] history rides the same bucket tape.
             ROUND170 (phase 1c): records missing pairs for the app's
             fetch-and-retry loop + forwards the live tick (if newer than the
             aligned bar) for the running aggregate. */
          const reqSec = tfSeconds(pos[1]) || this.env.tfSec || 60;
          const key = symBare + '|' + reqSec;
          const ob = this.env.symBars && this.env.symBars[key];
          if (!ob || !ob.length) {
            /* Dry input-collection has no bars at all — stay silent so the
               settings dialog still lists the script's inputs. */
            if (this.dry) return NA;
            /* ROUND211: ignore_invalid_symbol=true turns missing data into
               na (TV parity) instead of the loud error. */
            if (ignoreBad) return NA;
            /* ROUND226: NA-provisional discovery (see recordMissing). */
            if (this.env.collectMissing) { recordMissing(this, { sym: symBare, sec: reqSec }); return NA; }
            recordMissing(this, { sym: symBare, sec: reqSec });
            throw runtimeError(`request.security: no history for "${symBare}" — the app prefetches literal security() symbol/timeframe pairs before the run (dynamic symbols are fetched and retried automatically)`);
          }
          const cb = this.bars && this.bars[this.barIndex];
          if (!cb) return NA;
          let oi = -1, lo = 0, hi = ob.length - 1;
          while (lo <= hi) {
            const m = (lo + hi) >> 1;
            if (ob[m].time <= cb.time) { oi = m; lo = m + 1; } else hi = m - 1;
          }
          if (oi < 0) return NA;
          const tick = this.env.symTicks && this.env.symTicks[key];
          const xBase = { sym: key, bars: ob, idx: oi, tick: (tick && isFinite(tick.price)) ? tick : null, ha: haMode, session: tickSession || undefined };
          /* ROUND207: synthetic cross-symbol rides the prefetched BASE-TF
             bars (re-resolved here — the dest-TF key above is wrong for
             formations). Missing base data records + loud (app retry loop). */
          if (synthSpec) {
            const bkey = symBare + '|' + synthSpec.baseSec;
            const bb = this.env.symBars && this.env.symBars[bkey];
            if (!bb || !bb.length) {
              if (this.dry) return NA;
              if (ignoreBad) return NA; // ROUND211 (see above)
              /* ROUND226: NA-provisional discovery (see recordMissing). */
              if (this.env.collectMissing) { recordMissing(this, { sym: symBare, sec: synthSpec.baseSec }); return NA; }
              recordMissing(this, { sym: symBare, sec: synthSpec.baseSec });
              throw runtimeError(`request.security: no history for "${symBare}" at the ticker base timeframe — the app prefetches it before the run`);
            }
            const cb2 = this.bars && this.bars[this.barIndex];
            if (!cb2) return NA;
            let bi2 = -1, lo2 = 0, hi2 = bb.length - 1;
            while (lo2 <= hi2) {
              const m = (lo2 + hi2) >> 1;
              if (bb[m].time <= cb2.time) { bi2 = m; lo2 = m + 1; } else hi2 = m - 1;
            }
            if (bi2 < 0) return NA;
            return securityHigherTf(this, pos, named, (expr) => this.eval(expr, frame), exprNode, siteKey,
              { sym: bkey, bars: bb, idx: bi2, tick: null, ha: false, synth: synthSpec, cross: true });
          }
          return securityHigherTf(this, pos, named, (expr) => this.eval(expr, frame), exprNode, siteKey, xBase);
        }
        /* ROUND202: an HA ticker must run the bucket machinery even at the
           chart TF (the identity fast path inside would read plain OHLC).
           ROUND207: same for synthetic tickers (formation bars differ from
           chart bars even 1:1).
           ROUND211: a ticker.new session also forces the machinery (the
           fast path cannot filter). Plain same-sym tickers without one keep
           the fast path. */
        if (haMode) {
          return securityHigherTf(this, pos, named, (expr) => this.eval(expr, frame), exprNode, siteKey,
            { sym: '', bars: this.bars, idx: this.barIndex, ha: true });
        }
        if (synthSpec) {
          return securityHigherTf(this, pos, named, (expr) => this.eval(expr, frame), exprNode, siteKey,
            { sym: '', bars: this.bars, idx: this.barIndex, ha: false, synth: synthSpec });
        }
        if (tickSession) {
          return securityHigherTf(this, pos, named, (expr) => this.eval(expr, frame), exprNode, siteKey,
            { sym: '', bars: this.bars, idx: this.barIndex, ha: false, session: tickSession });
        }
        return securityHigherTf(this, pos, named, (expr) => this.eval(expr, frame), exprNode, siteKey);
      },
      security_lower_tf: () => {
        // raw AST access for the expression argument — special-cased in _evalCall
        throw runtimeError('request.security_lower_tf must be handled by the interpreter');
      },
    };
  }

  /* ROUND202: ticker.* — new/heikinashi handles. ROUND207: the synthetic
     chart-type family (renko/linebreak/kagi/pointfigure) builds handles;
     request.security substitutes their formation bars. */
  _tickerFns() {
    const T = {
      new: (site, prefix, ticker, session, sessionRegular, adjustment) =>
        tickerNew(prefix, ticker, session, sessionRegular, adjustment),
      heikinashi: (site, sym) => tickerHeikinashi(sym),
      renko: (site, sym, tf, brick) => tickerRenko(sym, tf, brick),
      linebreak: (site, sym, tf, n) => tickerLinebreak(sym, tf, n),
      kagi: (site, sym, tf, rev) => tickerKagi(sym, tf, rev),
      pointfigure: (site, sym, tf, box, rev) => tickerPointfigure(sym, tf, box, rev),
    };
    return T;
  }

  _stubNs(name) {
    if (name === 'request') {
      const rt = this;
      /* ROUND230 (TV parity): vendor-feed request.* calls are loud with a
         feed-specific message instead of the generic stub. Signatures pin
         the positional ignore_invalid_symbol slot per the v6 reference;
         ignore_invalid_symbol=true degrades to na (cross-symbol security
         precedent); dry input-collection stays silent so the settings
         dialog still lists the script's inputs. */
      const feedStub = (fnName, ignorePos, msg) => (site, ...a) => {
        if (rt.dry) return NA;
        const named = (site && site.named) || [];
        const nh = named.find((x) => x.name === 'ignore_invalid_symbol');
        const ig = nh ? nh.value : a[ignorePos];
        if (ig === true) return NA;
        throw runtimeError(`request.${fnName}(): ${msg}`);
      };
      const noFeed = 'needs a vendor data feed this offline engine does not have (pass ignore_invalid_symbol=true to degrade to na)';
      return {
        security: () => { throw runtimeError('request.security() is not available in this context (the interpreter routes security/security_lower_tf through their own paths)'); },
        security_lower_tf: () => { throw runtimeError('request.security_lower_tf must be handled by the interpreter'); },
        /* ROUND230 (TV parity): request.currency_rate(from, to[, ignore_invalid_currency]).
           Same-currency pairs return 1 (pinned reference behavior); anything
           else needs a daily FX feed — invalid codes are loud on their own,
           unavailable rates degrade to na only with ignore_invalid_currency=true. */
        currency_rate: (site, ...a) => {
          if (rt.dry) return NA;
          const named = (site && site.named) || [];
          const pick = (i, n) => {
            if (a[i] !== undefined) return a[i];
            const h = named.find((x) => x.name === n);
            return h ? h.value : undefined;
          };
          const fv = pick(0, 'from'), tv = pick(1, 'to');
          const igh = named.find((x) => x.name === 'ignore_invalid_currency');
          const ig = igh ? igh.value : a[2];
          if (fv == null || isNA(fv) || tv == null || isNA(tv)) {
            if (ig === true) return NA;
            throw runtimeError('request.currency_rate(): from/to currencies are required');
          }
          const from = normCurrency(fv), to = normCurrency(tv);
          if (from === to) return 1;
          const valid = (c) => /^[A-Z]{3,4}$/.test(c);
          if (!valid(from) || !valid(to)) {
            if (ig === true) return NA;
            throw runtimeError(`request.currency_rate(): invalid currency '${!valid(from) ? from : to}' (expected a 3-letter code or currency.*)`);
          }
          if (ig === true) return NA;
          throw runtimeError(`request.currency_rate(): ${from}/${to} needs a daily FX feed this offline engine does not have (same-currency pairs return 1)`);
        },
        dividends: feedStub('dividends', 4, `dividend data ${noFeed}`),
        splits: feedStub('splits', 4, `split data ${noFeed}`),
        earnings: feedStub('earnings', 4, `earnings data ${noFeed}`),
        financial: feedStub('financial', 4, `FactSet financial data ${noFeed}`),
        /* ROUND230: request.quandl is DEPRECATED upstream (NASDAQ Data Link
           API change — "requests for QUANDL symbols return a runtime error"). */
        quandl: feedStub('quandl', 3, 'deprecated upstream (NASDAQ Data Link API change) — requests for QUANDL symbols return a runtime error; look for the series on BCHAIN/FRED instead'),
        seed: feedStub('seed', 3, `GitHub Pine Seeds data ${noFeed}`),
        economic: feedStub('economic', 3, `economic/industry data ${noFeed}`),
        /* ROUND230: volume footprint needs tick-level data and a Premium
           plan — the signature has no ignore flag, so it is always loud. */
        footprint: (site, ...a) => {
          if (rt.dry) return NA;
          throw runtimeError('request.footprint(): volume-footprint data needs a tick-level feed and a Premium plan this offline engine does not have');
        },
      };
    }
    /* ROUND230 (TV parity): footprint.* / volume_row.* need the same
       tick-level footprint feed — loud per function, not "unknown namespace". */
    if (name === 'footprint' || name === 'volume_row') {
      const rt = this;
      return new Proxy({}, {
        get: (t, p) => {
          if (typeof p !== 'string') return undefined;
          return () => {
            if (rt.dry) return NA;
            throw runtimeError(`${name}.${p}() needs a volume-footprint tick feed (Premium) this offline engine does not have`);
          };
        },
      });
    }
    return new Proxy({}, {
      get: () => () => { throw runtimeError(`${name}.* functions are not supported in this engine version yet`); },
    });
  }

  _timeGetter(pick) {
    const rt = this;
    return function (site, ...args) {
      let ms, tz = null;
      if (args.length === 0) ms = rt.env.barTimeMs;
      else if (args.length === 1) ms = args[0];
      else { ms = args[0]; tz = String(args[1]); }
      if (isNA(ms) || ms == null || typeof ms !== 'number' || !isFinite(ms)) return NA;
      const p = tz ? tzParts(ms, tz) : exParts(ms, rt.env);
      return pick(p);
    };
  }

  /* ROUND204: time(timeframe, session[, timezone]) — the bar's open time
     (ms) when it belongs to the session, na otherwise. Chart TF reads the
     current bar; HTF reads the containing bucket's open (server-wall
     buckets, true-UTC ms out). Lower TFs stay loud (no LTF plumbing here).
     No-tz means the exchange wall clock (serverOffSec-shifted GMT). */
  _timeSession(positional, forClose) {
    const tfA = positional[0], specA = positional[1];
    const tzA = positional.length > 2 ? positional[2] : null;
    const chartSec = this.env.tfSec || 60;
    const sec = (typeof tfA === 'string' && tfA !== '' && tfSeconds(tfA) > 0) ? tfSeconds(tfA) : chartSec;
    if (sec < chartSec) {
      throw runtimeError('time(): a timeframe below the chart needs lower-timeframe data (not supported here)');
    }
    const spec = (specA == null || isNA(specA)) ? null : String(specA);
    const tz = (tzA == null || isNA(tzA)) ? null : String(tzA);
    const offMs = (this.env.serverOffSec || 0) * 1000;
    /* ROUND222a: v4 day-less session strings default Mon–Fri (v5+: all). */
    const dd = this.version < 5 ? [2, 3, 4, 5, 6] : null;
    /* ROUND223: time_close() yields the bar END (open + span) with the same
       membership rule as time(). */
    const spanMs = sec * 1000;
    if (sec === chartSec) {
      /* ROUND231: inside a request.* evaluation context the "current bar" is
         the context bar — the HTF aggregate's time (feed seconds) or the LTF
         sub-bar's wall-ms time — not the chart bar. Frames mirror the
         chart path (no-tz = exchange wall, tz = true UTC). */
      const ht = this._htfOverride;
      const ib = this._intrabarOverride;
      let ms;
      if (ht && typeof ht.time === 'number' && isFinite(ht.time)) {
        /* Context bucket OPEN on the request grid (floor — the same grid
           the security buckets use), not the first constituent bar's time:
           an H1 chart's first bar inside a D bucket opens after midnight. */
        const bs = (sec > 0) ? Math.floor(ht.time / sec) * sec : Math.floor(ht.time);
        ms = tz ? bs * 1000 - offMs : bs * 1000;
      } else if (ib && typeof ib.time === 'number' && isFinite(ib.time)) {
        ms = tz ? ib.time - offMs : ib.time;
      } else {
        ms = tz ? this.env.barTimeMs : this.env.barTimeMs + offMs;
      }
      const hit = timeInSession(ms, spec, tz || 'GMT', dd);
      if (isNA(hit)) return NA;
      return forClose ? ms + spanMs : hit;
    }
    const barSec = this.env.barTimeMs / 1000 + (this.env.serverOffSec || 0);
    const bs = Math.floor(barSec / sec) * sec;
    const ms = tz ? (bs - (this.env.serverOffSec || 0)) * 1000 : bs * 1000;
    const hit = timeInSession(ms, spec, tz || 'GMT', dd);
    if (isNA(hit)) return NA;
    return forClose ? ms + spanMs : hit;
  }

  _input(site, kind, defval, title, opts) {
    opts = opts || {};
    site.n = (site.n || 0) + 1;
    const id = 'i' + site.nid + '_' + site.n;
    if (!this.inputDefIds.has(id)) {
      this.inputDefIds.add(id);
      this.inputDefs.push({
        id, kind,
        defval: kind === 'color' ? (defval && defval.css ? defval.css() : defval) : defval,
        title: title == null || isNA(title) ? '' : String(title),
        options: (opts && opts.options) || null,
        min: (opts && (opts.minval != null || opts.min != null)) ? (opts.minval != null ? opts.minval : opts.min) : null,
        max: (opts && (opts.maxval != null || opts.max != null)) ? (opts.maxval != null ? opts.maxval : opts.max) : null,
        step: (opts && (opts.step != null)) ? opts.step : null,
        group: (opts && opts.group) ? String(opts.group) : '',
        inline: (opts && opts.inline) ? String(opts.inline) : '',
        tooltip: (opts && opts.tooltip) ? String(opts.tooltip) : '',
        /* ROUND222 (TV forward-compat): input.* active= (Jul 2025) is
           accepted and recorded; the dialog does not hide inactive inputs
           yet (cosmetic deviation, documented). */
        active: !(opts && opts.active === false),
      });
    }
    const val = (this.inputValues && this.inputValues[id] != null) ? this.inputValues[id] : defval;
    if (kind === 'color') { const c = toColor(val); return c || NA; }
    return val;
  }

  /** input.source — defval is a series reference; the CURRENT bar's value of
   *  the chosen series flows through (re-evaluated every bar, intrabar-aware) */
  _inputSource(site, node, positional, restObj, frame) {
    const defName = node.args[0] && node.args[0].value.kind === 'ident' ? node.args[0].value.name : null;
    const defval = defName || 'close';
    site.n = (site.n || 0) + 1;
    const id = 'i' + site.nid + '_' + site.n;
    if (!this.inputDefIds.has(id)) {
      this.inputDefIds.add(id);
      /* ROUND142: v4 often passes the title as a named arg
         (input(hl2, title="Source")) — the parser folds it into restObj,
         so positional[1] is empty; check both like the legacy branch. */
      const tRaw = (positional[1] != null && !isNA(positional[1])) ? positional[1]
        : (restObj.title != null && !isNA(restObj.title) ? restObj.title : '');
      this.inputDefs.push({
        id, kind: 'source', defval,
        title: String(tRaw || ''),
        options: BUILTIN_SOURCES.slice(),
        min: null, max: null, step: null,
        group: restObj.group ? String(restObj.group) : '',
        inline: restObj.inline ? String(restObj.inline) : '',
        tooltip: restObj.tooltip ? String(restObj.tooltip) : '',
        active: !(restObj.active === false), // ROUND222: input.* active=
      });
    }
    const chosen = (this.inputValues && this.inputValues[id] != null) ? String(this.inputValues[id]) : defval;
    // resolve the chosen series at the CURRENT bar (intrabar override aware)
    const ov = this._intrabarOverride;
    if (ov) {
      switch (chosen) {
        case 'open': return ov.open; case 'high': return ov.high;
        case 'low': return ov.low; case 'close': return ov.close;
        case 'volume': return ov.volume;
        /* ROUND78 (timezone): true-UTC ms, same as _evalIdent */
        case 'time': return ov.time - this.env.serverOffSec * 1000;
        case 'hl2': return (ov.high + ov.low) / 2;
        case 'hlc3': return (ov.high + ov.low + ov.close) / 3;
        case 'ohlc4': return (ov.open + ov.high + ov.low + ov.close) / 4;
      }
    }
    return this.eval({ kind: 'ident', name: chosen, line: node.line }, frame);
  }

  /** ROUND154: input.enum — defval is an enum member (`Mode.Fast`). The member
   *  VALUE (number) flows into the script so `mode == Mode.Fast` compares;
   *  the dialog gets kind 'enum' + member names + the value map. The enum is
   *  recovered from the RAW defval AST (values alone can't name their type).
   *  Non-member defval degrades to a plain string input (lenient, logged). */
  _inputEnum(site, node, positional, restObj) {
    const defArg = node.args[0] && node.args[0].value;
    let enumName = null, members = null;
    if (defArg && defArg.kind === 'member' && defArg.base && defArg.base.kind === 'ident') {
      const rec = this._lookup({ scopes: [this.globals] }, defArg.base.name);
      if (rec && rec.value && rec.value.__enumType && this.enums) {
        enumName = rec.value.__enumType;
        members = this.enums.get(enumName);
      }
    }
    const title = positional[1] != null && !isNA(positional[1]) ? positional[1]
      : (restObj.title != null && !isNA(restObj.title) ? restObj.title : '');
    const defval = positional[0];
    site.n = (site.n || 0) + 1;
    const id = 'i' + site.nid + '_' + site.n;
    if (!this.inputDefIds.has(id)) {
      this.inputDefIds.add(id);
      const names = members ? Object.keys(members) : null;
      const map = members ? Object.assign({}, members) : null;
      this.inputDefs.push({
        id, kind: 'enum', defval,
        title: String(title || ''),
        options: names,
        enumType: enumName, enumMap: map,
        min: null, max: null, step: null,
        group: restObj.group ? String(restObj.group) : '',
        inline: restObj.inline ? String(restObj.inline) : '',
        tooltip: restObj.tooltip ? String(restObj.tooltip) : '',
        active: !(restObj.active === false), // ROUND222: input.* active=
      });
    }
    const val = (this.inputValues && this.inputValues[id] != null) ? this.inputValues[id] : defval;
    if (members) {
      // snap stray values to a valid member (same official rule as options=)
      const ok = Object.keys(members).some((k) => members[k] === val);
      if (!ok) return members[Object.keys(members)[0]];
    }
    return val;
  }

  /* ------------------------------ arrays ------------------------------- */

  _arrayFns() {
    const A = {
      new: (site, size, initial, ...rest) => {
        // generic type arrives via the parser-erased form; element type is
        // carried in site.elType (stamped by the caller from the AST)
        return arrNew(site.elType || 'any', size, initial);
      },
      /* ROUND151: v6 typed shorthands array.new_<T>(size, initial) — real
         scripts (AlgoAlpha et al.) use new_int/new_bool pervasively. */
      new_int: (site, size, initial) => arrNew('int', size, initial),
      new_float: (site, size, initial) => arrNew('float', size, initial),
      new_bool: (site, size, initial) => arrNew('bool', size, initial),
      new_string: (site, size, initial) => arrNew('string', size, initial),
      new_color: (site, size, initial) => arrNew('color', size, initial),
      new_line: (site, size, initial) => arrNew('line', size, initial),
      new_box: (site, size, initial) => arrNew('box', size, initial),
      new_label: (site, size, initial) => arrNew('label', size, initial),
      from: (site, ...args) => arrFrom(...args),
      copy: (site, src) => src.copy(),
      get: (site, arr, i) => arr.get(i),
      set: (site, arr, i, v) => { arr.set(i, v); return v; },
      size: (site, arr) => arr.size(),
      push: (site, arr, v) => { arr.push(v); return arr; },
      pop: (site, arr) => arr.pop(),
      shift: (site, arr) => arr.shift(),
      unshift: (site, arr, v) => arr.unshift(v),
      insert: (site, arr, i, v) => arr.insert(i, v),
      remove: (site, arr, i) => arr.remove(i),
      clear: (site, arr) => { arr.clear(); return arr; },
      first: (site, arr) => arr.first(),
      last: (site, arr) => arr.last(),
      join: (site, arr, sep) => arr.join(sep),
      slice: (site, arr, a, b) => arr.slice(a, b),
      sort: (site, arr, order, sf) => arr.sort(order, sf),
      sort_indices: (site, arr, order, sf) => arr.sortIndices(order, sf),
      reverse: (site, arr) => arr.reverse(),
      indexof: (site, arr, v) => arr.indexOf(v),
      lastindexof: (site, arr, v) => arr.lastIndexOf(v),
      includes: (site, arr, v) => arr.includes(v),
      concat: (site, arr, other) => arr.concat(other),
      fill: (site, arr, v, a, b) => { arr.fill(v, a, b); return arr; },
      sum: (site, arr) => arr.sum(),
      avg: (site, arr) => arr.avg(),
      min: (site, arr) => arr.min(),
      max: (site, arr) => arr.max(),
      median: (site, arr) => arr.median(),
      mode: (site, arr) => arr.mode(),
      range: (site, arr) => arr.range(),
      variance: (site, arr, biased) => arr.variance(biased),
      stdev: (site, arr, biased) => arr.stdev(biased),
      standardize: (site, arr) => arr.standardize(),
      percentrank: (site, arr, n) => arr.percentrank(n),
      binary_search: (site, arr, v, sf) => {
        /* TV: exact-match index over the array as-is, -1 when missing. (The
           old code searched a NA-filtered copy, returning shifted indices
           whenever the array held na.) */
        const items = arr.items;
        /* ROUND224: sort_field compares UDT field keys (Aug 2026) — numeric
           equality on keys; the plain path below is byte-identical. */
        if (sf != null && !isNA(sf)) {
          const vn = num(v);
          let lo = 0, hi = items.length - 1;
          while (lo <= hi) {
            const m = (lo + hi) >> 1, xn = num(keyOf(items[m], sf));
            if (!isFinite(xn) || !isFinite(vn)) return -1;
            if (xn < vn) lo = m + 1; else if (xn > vn) hi = m - 1; else return m;
          }
          return -1;
        }
        let lo = 0, hi = items.length - 1;
        while (lo <= hi) {
          const m = (lo + hi) >> 1, x = items[m];
          if (x === v) return m;
          const xn = num(x), vn = num(v);
          if (!isFinite(xn) || !isFinite(vn)) return -1; // na breaks the sorted contract
          if (xn < vn) lo = m + 1; else hi = m - 1;
        }
        return -1;
      },
      /* ROUND165 (SMC daily/weekly/monthly levels threw "Unknown array
         method"): lower_bound / upper_bound-1 over the raw items. Edges:
         leftmost -> size when value exceeds all, rightmost -> -1 when value
         is below all (official behaviour). */
      binary_search_leftmost: (site, arr, v, sf) => {
        const items = arr.items, vn = num(v);
        let lo = 0, hi = items.length;
        while (lo < hi) {
          const m = (lo + hi) >> 1, xn = num(sf != null && !isNA(sf) ? keyOf(items[m], sf) : items[m]);
          if (!isFinite(xn) || !isFinite(vn)) break;
          if (xn < vn) lo = m + 1; else hi = m;
        }
        return lo;
      },
      binary_search_rightmost: (site, arr, v, sf) => {
        const items = arr.items, vn = num(v);
        let lo = 0, hi = items.length;
        while (lo < hi) {
          const m = (lo + hi) >> 1, xn = num(sf != null && !isNA(sf) ? keyOf(items[m], sf) : items[m]);
          if (!isFinite(xn) || !isFinite(vn)) return -1;
          if (xn <= vn) lo = m + 1; else hi = m;
        }
        return lo - 1;
      },
    };
    return A;
  }

  /* ROUND196: matrix.* — 2-D collections. Same dispatch shape as arrays:
     the ns table serves `matrix.get(m, ...)` and the value-method path serves
     `m.get(...)` (self arrives as the first value arg). */
  _matrixFns() {
    const chk = (m) => { if (!isMatrix(m)) throw runtimeError('matrix.* expects a matrix'); return m; };
    return {
      new: (site, rows, cols, initial) => matNew(site.elType || 'any', rows, cols, initial),
      /* v6 typed shorthands (array.new_* parity) */
      new_int: (site, rows, cols, initial) => matNew('int', rows, cols, initial),
      new_float: (site, rows, cols, initial) => matNew('float', rows, cols, initial),
      new_bool: (site, rows, cols, initial) => matNew('bool', rows, cols, initial),
      new_string: (site, rows, cols, initial) => matNew('string', rows, cols, initial),
      copy: (site, m) => chk(m).copy(),
      get: (site, m, r, c) => chk(m).get(r, c),
      set: (site, m, r, c, v) => chk(m).set(r, c, v),
      rows: (site, m) => chk(m).nRows(),
      columns: (site, m) => chk(m).nCols(),
      fill: (site, m, v, r0, c0, r1, c1) => chk(m).fill(v, r0, c0, r1, c1),
      add_row: (site, m, r) => chk(m).addRow(r),
      add_col: (site, m, c) => chk(m).addCol(c),
      remove_row: (site, m, r) => chk(m).removeRow(r),
      remove_col: (site, m, c) => chk(m).removeCol(c),
      /* ROUND227 (TV parity): matrix.submatrix/… (see PineMatrix). */
      submatrix: (site, m, fr, fc, tr, tc) => chk(m).submatrix(fr, fc, tr, tc),
      transpose: (site, m) => chk(m).transpose(),
      reshape: (site, m, nr, nc) => chk(m).reshape(nr, nc),
      sort: (site, m, col, order) => chk(m).sort(col, order),
      sum: (site, m) => chk(m).sum(),
      avg: (site, m) => chk(m).avg(),
      min: (site, m) => chk(m).min(),
      max: (site, m) => chk(m).max(),
    };
  }

  /* ROUND196: map.* — key-value collections (same dispatch shape). */
  _mapFns() {
    const chk = (m) => { if (!isMap(m)) throw runtimeError('map.* expects a map'); return m; };
    return {
      new: (site) => {
        const t = site.elTypes || null;
        return mapNew(t && t[0] ? t[0] : 'any', t && t[1] ? t[1] : 'any');
      },
      copy: (site, m) => chk(m).copy(),
      put: (site, m, k, v) => chk(m).put(k, v),
      get: (site, m, k) => chk(m).get(k),
      contains: (site, m, k) => chk(m).contains(k),
      remove: (site, m, k) => chk(m).remove(k),
      clear: (site, m) => chk(m).clear(),
      keys: (site, m) => chk(m).keys(),
      values: (site, m) => chk(m).values(),
      size: (site, m) => chk(m).size(),
    };
  }

  /* --------------------------- drawing objects ------------------------- */

  _lineFns() {
    const rt = this;
    const get = (v, what) => {
      if (!v || !v.__pineObj || v.kind !== 'line') throw runtimeError(`line.${what}: expected a line object`);
      if (v.deleted) throw runtimeError(`line.${what}: the line was deleted`);
      return v;
    };
    return {
      new: (...a) => rt._nsObjNew('line', a, lineNew),
      delete: (site, v) => { if (v && !isNA(v)) rt.store.del('line', v); },
      get_x1: (site, v) => get(v, 'get_x1').x1,
      get_y1: (site, v) => get(v, 'get_y1').y1,
      get_x2: (site, v) => get(v, 'get_x2').x2,
      get_y2: (site, v) => get(v, 'get_y2').y2,
      /* ROUND141: the four single-coordinate setters + copy */
      set_x1: (site, v, x) => { get(v, 'set_x1').x1 = num(x); },
      set_x2: (site, v, x) => { get(v, 'set_x2').x2 = num(x); },
      set_y1: (site, v, y) => { get(v, 'set_y1').y1 = num(y); },
      set_y2: (site, v, y) => { get(v, 'set_y2').y2 = num(y); },
      copy: (site, v) => { const o = get(v, 'copy'); return rt.store.add('line', new (Object.getPrototypeOf(o).constructor)({ ...o, id: undefined, bornBar: rt.barIndex })); },
      set_xy1: (site, v, x, y) => { const o = get(v, 'set_xy1'); o.x1 = num(x); o.y1 = num(y); },
      set_xy2: (site, v, x, y) => { const o = get(v, 'set_xy2'); o.x2 = num(x); o.y2 = num(y); },
      set_color: (site, v, c) => { get(v, 'set_color').color = c; },
      set_style: (site, v, s) => { const p = enumPayload(s); if (!p) throw runtimeError('line.set_style: expected a line.style_* constant'); get(v, 'set_style').style = p; },
      set_width: (site, v, w) => { get(v, 'set_width').width = Math.max(1, Math.round(num(w))); },
      set_extend: (site, v, e) => { const p = enumPayload(e); get(v, 'set_extend').extend = p || 'none'; },
      set_xloc: (site, v, x1, x2, xl) => { const o = get(v, 'set_xloc'); const p = enumPayload(xl); if (p) o.xloc = p; o.x1 = num(x1); o.x2 = num(x2); },
      get_price: (site, v, x) => { const o = get(v, 'get_price'); if (o.x2 === o.x1) return o.y1; const t = (num(x) - o.x1) / (o.x2 - o.x1); return pineNum(o.y1 + t * (o.y2 - o.y1)); },
      get_x: () => { throw runtimeError('line.get_x is not supported'); },
      /* v5/v6 chart.point setters — unpack a point value into (x, y) */
      set_first_point: (site, v, p) => {
        const o = get(v, 'set_first_point');
        if (p && p.kind === 'point') { o.x1 = p.time != null ? p.time : p.index; o.y1 = p.price; }
        else if (p && p.__pineObj && p.kind === 'point') { o.x1 = p.time != null ? p.time : p.index; o.y1 = p.price; }
      },
      set_second_point: (site, v, p) => {
        const o = get(v, 'set_second_point');
        if (p && p.__pineObj && p.kind === 'point') { o.x2 = p.time != null ? p.time : p.index; o.y2 = p.price; }
      },
    };
  }

  _boxFns() {
    const rt = this;
    const get = (v, what) => {
      if (!v || !v.__pineObj || v.kind !== 'box') throw runtimeError(`box.${what}: expected a box object`);
      if (v.deleted) throw runtimeError(`box.${what}: the box was deleted`);
      return v;
    };
    return {
      new: (...a) => rt._nsObjNew('box', a, boxNew),
      delete: (site, v) => { if (v && !isNA(v)) rt.store.del('box', v); },
      get_left: (site, v) => get(v, 'get_left').left,
      get_right: (site, v) => get(v, 'get_right').right,
      get_top: (site, v) => get(v, 'get_top').top,
      get_bottom: (site, v) => get(v, 'get_bottom').bottom,
      set_lefttop: (site, v, l, t) => { const o = get(v, 'set_lefttop'); o.left = num(l); o.top = num(t); },
      set_rightbottom: (site, v, r, b) => { const o = get(v, 'set_rightbottom'); o.right = num(r); o.bottom = num(b); },
      set_left: (site, v, l) => { get(v, 'set_left').left = num(l); },
      set_right: (site, v, r) => { get(v, 'set_right').right = num(r); },
      set_top: (site, v, t) => { get(v, 'set_top').top = num(t); },
      set_bottom: (site, v, b) => { get(v, 'set_bottom').bottom = num(b); },
      set_bgcolor: (site, v, c) => { get(v, 'set_bgcolor').bgcolor = c; },
      set_border_color: (site, v, c) => { get(v, 'set_border_color').border_color = c; },
      set_border_width: (site, v, w) => { get(v, 'set_border_width').border_width = Math.max(1, Math.round(num(w))); },
      set_border_style: (site, v, s) => { const p = enumPayload(s); if (!p) throw runtimeError('box.set_border_style: expected a line.style_* constant'); get(v, 'set_border_style').border_style = p; },
      set_extend: (site, v, e) => { const p = enumPayload(e); get(v, 'set_extend').extend = p || 'none'; },
      set_text: (site, v, t) => { get(v, 'set_text').text = String(isNA(t) ? '' : t); },
      set_text_color: (site, v, c) => { get(v, 'set_text_color').text_color = c; },
      /* ROUND141 */
      set_xloc: (site, v, l, r, xl) => { const o = get(v, 'set_xloc'); const p = enumPayload(xl); if (p) o.xloc = p; o.left = num(l); o.right = num(r); },
      set_text_halign: (site, v, h) => { const p = enumPayload(h); if (p) get(v, 'set_text_halign').text_halign = p; },
      set_text_valign: (site, v, h) => { const p = enumPayload(h); if (p) get(v, 'set_text_valign').text_valign = p; },
      set_text_wrap: (site, v, w) => { const p = enumPayload(w); if (p) get(v, 'set_text_wrap').text_wrap = p; },
      set_text_font_family: (site, v, f) => { const p = enumPayload(f); if (p) get(v, 'set_text_font_family').text_font_family = p; },
      set_text_formatting: (site, v, f) => { const p = enumPayload(f); if (p) get(v, 'set_text_formatting').text_formatting = p; },
      set_text_size: (site, v, s) => { get(v, 'set_text_size').text_size = sizeOf(s, 'normal'); },
      /* chart.point setters (SMC builds boxes from points) */
      set_top_left_point: (site, v, p) => { const o = get(v, 'set_top_left_point'); if (p && p.__pineObj && p.kind === 'point') { if (p.time != null || p.index != null) o.left = (p.time != null ? p.time : p.index); if (p.price != null) o.top = p.price; } },
      set_bottom_right_point: (site, v, p) => { const o = get(v, 'set_bottom_right_point'); if (p && p.__pineObj && p.kind === 'point') { if (p.time != null || p.index != null) o.right = (p.time != null ? p.time : p.index); if (p.price != null) o.bottom = p.price; } },
      /* alias spellings TV also accepts (no-op entries would break dispatch — removed) */
      /* line.set_first_point / set_second_point / label.set_point (SMC) */
      set_first_point: (site, v, p) => { const o = get(v, 'set_first_point'); if (p && p.__pineObj && p.kind === 'point') { if (p.time != null || p.index != null) o.x1 = (p.time != null ? p.time : p.index); if (p.price != null) o.y1 = p.price; } },
      set_second_point: (site, v, p) => { const o = get(v, 'set_second_point'); if (p && p.__pineObj && p.kind === 'point') { if (p.time != null || p.index != null) o.x2 = (p.time != null ? p.time : p.index); if (p.price != null) o.y2 = p.price; } },
      copy: (site, v) => { const o = get(v, 'copy'); return rt.store.add('box', new (Object.getPrototypeOf(o).constructor)({ ...o, id: undefined, bornBar: rt.barIndex })); },
    };
  }

  _labelFns() {
    const rt = this;
    const get = (v, what) => {
      if (!v || !v.__pineObj || v.kind !== 'label') throw runtimeError(`label.${what}: expected a label object`);
      if (v.deleted) throw runtimeError(`label.${what}: the label was deleted`);
      return v;
    };
    return {
      new: (...a) => rt._nsObjNew('label', a, labelNew),
      delete: (site, v) => { if (v && !isNA(v)) rt.store.del('label', v); },
      get_text: (site, v) => get(v, 'get_text').text,
      get_x: (site, v) => get(v, 'get_x').x,
      get_y: (site, v) => get(v, 'get_y').y,
      set_xy: (site, v, x, y) => { const o = get(v, 'set_xy'); o.x = num(x); o.y = num(y); },
      /* ROUND141 */
      set_x: (site, v, x) => { get(v, 'set_x').x = num(x); },
      set_y: (site, v, y) => { get(v, 'set_y').y = num(y); },
      set_yloc: (site, v, yl) => { const p = enumPayload(yl); if (p) get(v, 'set_yloc').yloc = p; },
      set_textalign: (site, v, a) => { const p = enumPayload(a); if (p) get(v, 'set_textalign').textalign = p; },
      set_text_font_family: (site, v, f) => { const p = enumPayload(f); if (p) get(v, 'set_text_font_family').text_font_family = p; },
      set_text_formatting: (site, v, f) => { const p = enumPayload(f); if (p) get(v, 'set_text_formatting').text_formatting = p; },
      set_text: (site, v, t) => { get(v, 'set_text').text = String(isNA(t) ? '' : t); },
      set_textcolor: (site, v, c) => { get(v, 'set_textcolor').textcolor = c; },
      set_color: (site, v, c) => { get(v, 'set_color').color = c; },
      set_style: (site, v, s) => { const p = enumPayload(s); if (p) get(v, 'set_style').style = p; },
      set_size: (site, v, s) => { const o = get(v, 'set_size'); const nv = sizeOf(s, null); if (nv != null) o.size = nv; },
      set_tooltip: (site, v, t) => { get(v, 'set_tooltip').tooltip = String(t); },
      set_xloc: (site, v, x, xl) => { const o = get(v, 'set_xloc'); const p = enumPayload(xl); if (p) o.xloc = p; o.x = num(x); },
      /* v5/v6 chart.point setter */
      set_point: (site, v, p) => {
        const o = get(v, 'set_point');
        if (p && p.__pineObj && p.kind === 'point') { o.x = p.time != null ? p.time : p.index; o.y = p.price; }
      },
      copy: (site, v) => { const o = get(v, 'copy'); return rt.store.add('label', new (Object.getPrototypeOf(o).constructor)({ ...o, id: undefined, bornBar: rt.barIndex })); },
    };
  }

  _polylineFns() {
    const rt = this;
    return {
      new: (...a) => rt._nsObjNew('polyline', a, polylineNew),
      delete: (site, v) => { if (v && !isNA(v)) rt.store.del('polyline', v); },
    };
  }

  _linefillFns() {
    const rt = this;
    const get = (v, what) => {
      if (!v || !v.__pineObj || v.kind !== 'linefill') throw runtimeError(`linefill.${what}: expected a linefill object`);
      if (v.deleted) throw runtimeError(`linefill.${what}: the linefill was deleted`);
      return v;
    };
    return {
      new: (...a) => rt._nsObjNew('linefill', a, linefillNew),
      delete: (site, v) => { if (v && !isNA(v)) rt.store.del('linefill', v); },
      set_color: (site, v, c) => { get(v, 'set_color').color = c; },
      get_line1: (site, v) => get(v, 'get_line1').line1,
      get_line2: (site, v) => get(v, 'get_line2').line2,
    };
  }

  /* ROUND151: table MVP (engine-side; render arrives in phase E). Mirrors
     the line/box/label tables: new/cell/clear/delete/set_position. ROUND155:
     entries take (site, self, ...rest) so the NAMESPACE form
     table.cell(t, ...) and the METHOD form t.cell(...) share one shape;
     merge_cells added (LuxAlgo merged headers). */
  _tableFns() {
    const rt = this;
    const get = (v, what) => {
      if (!v || !v.__pineObj || v.kind !== 'table') throw runtimeError(`table.${what}: expected a table object`);
      if (v.deleted) throw runtimeError(`table.${what}: the table was deleted`);
      return v;
    };
    return {
      new: (...a) => rt._nsObjNew('table', a, tableNew),
      delete: (site, v) => { if (v && !isNA(v)) rt.store.del('table', v); },
      cell: (site, self, ...rest) => tableCell(rt.store, [self, ...rest], site.named || []),
      clear: (site, self, ...rest) => tableClear(rt.store, [self, ...rest], site.named || []),
      set_position: (site, v, pos) => { get(v, 'set_position').pos = tablePos(pos); rt.store.version++; },
      merge_cells: (site, self, ...rest) => tableMerge(rt.store, [self, ...rest], site.named || []),
      /* ROUND203: table style setters (ns + method forms share one shape). */
      set_bgcolor: (site, self, ...rest) => tableSetBgcolor(rt.store, [self, ...rest], site.named || []),
      set_border_color: (site, self, ...rest) => tableSetBorderColor(rt.store, [self, ...rest], site.named || []),
      set_border_width: (site, self, ...rest) => tableSetBorderWidth(rt.store, [self, ...rest], site.named || []),
      set_frame_color: (site, self, ...rest) => tableSetFrameColor(rt.store, [self, ...rest], site.named || []),
      set_frame_width: (site, self, ...rest) => tableSetFrameWidth(rt.store, [self, ...rest], site.named || []),
    };
  }

  _nsObjNew(kind, callArgs, factory) {
    // callArgs = [site, ...positional]; named args were stashed on site.named
    const site = callArgs[0] || {};
    // chart.point positional args carry {time, index, price} — unpack into
    // (x, y) pairs so line.new(p1, p2) / box.new(p1, p2) behave like TV
    const merged = [];
    const named = (site.named || []).map(({ name, value }) => ({ name, value: this._unpackPoint(value) }));
    const positional = callArgs.slice(1).map((v) => this._unpackPoint(v));
    return factory(this.store, positional, named, { barIndex: this.barIndex, bars: this.bars });
  }

  _unpackPoint(v) {
    if (v && v.__pineObj && v.kind === 'point') {
      const x = v.time != null ? v.time : v.index;
      return { __pointXY: true, x, y: v.price };
    }
    return v;
  }

  /* ========================= VISUAL FUNCTIONS ========================== */

  _mergeCallArgs(node, frame) {
    // positional: evaluated in order; named: [{name, value}]
    const positional = [];
    const named = [];
    /* ROUND208 (TV parity): a positional argument after a named one is a
       compile error in TV ("positional argument cannot follow named") — the
       old silent acceptance scrambled slots (e.g. close landed in the
       timeframe slot while expression stayed empty). Loud, universally. */
    let seenNamed = false;
    for (const a of node.args) {
      if (a.name) seenNamed = true;
      else if (seenNamed) throw runtimeError('positional argument cannot follow a named argument (move it before the named ones)');
      const v = this.eval(a.value, frame);
      if (a.name) named.push({ name: a.name, value: v });
      else positional.push(v);
    }
    return { positional, named };
  }

  _plotSite(key, node) {
    const rt = this;
    let p = rt.out.plots.get(key);
    if (!p) {
      const styleV = node.styleV ? enumPayload(node.styleV) : 'line';
      p = {
        key,
        title: node.title || 'Plot',
        style: styleV || 'line',
        linewidth: node.linewidth != null ? node.linewidth : 1,
        linestyle: node.linestyle ? enumPayload(node.linestyle) || 'solid' : 'solid',
        values: [],
        colors: [],
        display: node.display ? enumPayload(node.display) : 'all',
        editable: node.editable !== false,
        show_last: node.show_last || null,
      };
      rt.out.plots.set(key, p);
      rt.out.plotsOrder.push(key);
    }
    return p;
  }

  /** plot(series, title, color, linewidth, style, ...) — args merged */
  _fnPlot([positional, named, node]) {
    if (this.dry) return { __plotRef: 'p' + this.out.nextId++ };
    const key = this._frameKey(null) + ':' + node.id;
    const merged = this._mergePlotOpts(named, positional);
    // register static options on first sight
    if (!this.out.plots.has(key)) {
      const st = this._plotSite(key, {
        title: merged.title, linewidth: merged.linewidth,
        linestyle: merged.linestyle, styleV: merged.styleV, display: merged.display,
      });
      st.title = merged.title || st.title;
      if (merged.linewidth != null) st.linewidth = merged.linewidth;
      if (merged.linestyle != null) st.linestyle = merged.linestyle;
      if (merged.styleV != null) st.style = enumPayload(merged.styleV) || st.style;
      /* ROUND142: remaining documented static options */
      st.trackprice = merged.trackprice === true;
      st.join = merged.join === true;
      st.histbase = (typeof merged.histbase === 'number' && isFinite(merged.histbase)) ? merged.histbase : 0;
      st.show_last = (typeof merged.show_last === 'number' && merged.show_last > 0) ? Math.floor(merged.show_last) : null;
      st.format = merged.format ? (enumPayload(merged.format) || null) : null;
      st.precision = (typeof merged.precision === 'number' && merged.precision >= 0 && merged.precision <= 16) ? Math.floor(merged.precision) : null;
      st.force_overlay = merged.force_overlay === true;
      this._checkPlotCap();
    }
    const st = this.out.plots.get(key);
    const v = positional[0];
    if (typeof v === 'boolean') throw runtimeError('plot() expects a series int/float; a bool cannot be plotted (use x ? 1 : 0)');
    /* ROUND140: offset shifts the plot in time (negative = into the past). The
       value computed on bar i is drawn on bar i+offset; future slots (> last bar)
       have no candle to sit on and are simply not drawn. */
    const off = (typeof merged.offset === 'number' && isFinite(merged.offset)) ? Math.round(merged.offset) : 0;
    if (off !== 0) st.offset = off;
    const wi = this.barIndex + off;
    if (wi < 0) { this.out._pushed.add(key); return { __plotRef: key }; }
    st.values[wi] = isNA(v) ? null : (typeof v === 'number' ? v : NA);
    /* ROUND139: colour=na (or transp 100) must HIDE the plot on that bar. na and
       "no colour argument" both used to store null, and null paints the default
       blue — so hidden segments were drawn. An explicit na is now transparent. */
    st.colors[wi] = merged.color instanceof PineColor
      ? merged.color
      : (merged.color === NA ? new PineColor(0, 0, 0, 0) : null);
    this.out._pushed.add(key);
    return { __plotRef: key };
  }

  /* docs: at most 64 plot count — every plot*() call and alertcondition counts;
     a const colour costs 1, a dynamic (series) colour costs 2 (approximated by
     +1 for plots whose colour arrives as a series value). */
  _checkPlotCap() {
    let n = this.out.shapes.size + this.out.alertconds.length;
    for (const pl of this.out.plots.values()) if (!pl.hiddenHline) n++;
    if (n > 64) throw runtimeError('The script has too many plots: at most 64 plot*() calls / alertcondition() are allowed');
  }

  _mergePlotOpts(named, positional) {
    const get = (name, idx) => {
      const f = named.find((n) => n.name === name);
      if (f) return f.value;
      return idx != null && positional.length > idx ? positional[idx] : undefined;
    };
    const color = get('color', 2);
    const titleV = get('title', 1);
    return {
      color: this._transp(color, get('transp', undefined)),
      title: (titleV == null || isNA(titleV)) ? undefined : String(titleV),
      linewidth: this._optInt(get('linewidth', 3), 1),
      style: get('style', 4),
      styleV: get('style', 4),
      trackprice: get('trackprice', 5),
      histbase: get('histbase', 6),
      offset: get('offset', 7),
      join: get('join', 8),
      format: get('format', 12),
      precision: get('precision', 13),
      force_overlay: get('force_overlay', 14),
      linestyle: get('linestyle', 15),
      display: get('display', 11),
      editable: get('editable', 9),
      show_last: get('show_last', 10),
    };
  }

  /** ROUND154: v4 `transp=0..100` (removed in v5 in favour of color.new) maps
   *  onto alpha: 0 = opaque, 100 = invisible. Multiplies any existing alpha
   *  (composable with color.new); non-colors and absent/na transp pass through. */
  _transp(colorVal, transpVal, what) {
    const t = (typeof transpVal === 'number' && isFinite(transpVal)) ? transpVal : null;
    /* ROUND225 (TV parity): transp= was REMOVED in v6 (use color.new/rgb) —
       loud with a migration hint whenever it is EXPLICITLY passed (even
       without a color — the old code returned early for non-PineColor);
       v5 and older keep the R154 mapping. */
    if (t != null && (this.version || 5) >= 6) {
      throw runtimeError(`transp= was removed in Pine v6 — pass transparency via color.new()/color.rgb() instead${what ? ' (' + what + ')' : ''}`);
    }
    if (!(colorVal instanceof PineColor)) return colorVal;
    if (t == null) return colorVal;
    const a = Math.min(1, Math.max(0, (100 - t) / 100)) * colorVal.a;
    return new PineColor(colorVal.r, colorVal.g, colorVal.b, Math.round(a * 1000) / 1000);
  }

  _optInt(v, dflt) {
    if (v == null || isNA(v) || typeof v !== 'number' || !isFinite(v)) return dflt;
    /* ROUND135: TV accepts linewidth=0 (invisible plot, e.g. Supertrend's
       mPlot that only anchors a fill). Clamp to [0,5], not [1,5]. */
    return Math.max(0, Math.min(5, Math.round(v)));
  }

  _shapeSite(key) {
    let s = this.out.shapes.get(key);
    if (!s) {
      s = { key, title: null, style: 'cross', size: 'small', colors: [], texts: [], ys: [] };
      this.out.shapes.set(key, s);
    }
    return s;
  }

  _fnPlotshape([positional, named, node], isChar) {
    if (this.dry) return undefined;
    const key = 'g:' + node.id;
    const get = (name, idx) => {
      const f = named.find((n) => n.name === name);
      if (f) return f.value;
      return idx != null && positional.length > idx ? positional[idx] : undefined;
    };
    // official signature: plotshape(series, title, style, location, color,
    //   offset, text, textcolor, editable, size, show_last, display)
    const cond = positional[0];
    const st = this._shapeSite(key);
    /* ROUND143: Style-tab rows need display titles — plotshape(title=) was
       never stored (only the per-bar text= was). Keep the first explicit one. */
    const titleV = get('title', 1);
    if ((st.title == null || st.title === '') && titleV != null && !isNA(titleV)) st.title = String(titleV);
    st.style = enumPayload(get('style', 2)) || st.style;
    const sizeP = enumPayload(get('size', 9));
    if (sizeP && SIZE_MAP[sizeP] != null) st.size = sizeP;
    const loc = enumPayload(get('location', 3)) || 'absolute';
    /* ROUND146: Style-tab location editing needs the script location +
       a flag (plotarrow has none — TV shows no location row for it). */
    st.loc = loc;
    st.hasLoc = true;
    /* ROUND227 (TV parity): plotshape force_overlay (slot 14) rides the
       shape site so sub-pane markers can paint on the main chart. */
    st.force_overlay = get('force_overlay', 14) === true;
    const textV = get('text', 6);
    const shown = truthy(cond);
    /* ROUND154: v4 transp= maps onto the shape color (see _transp). */
    const color = this._transp(get('color', 4), get('transp', undefined));
    // ROUND134: plotshape() with no text= must NOT emit the literal 'undefined'
    // string (TV shows nothing); only explicit text is drawn
    const textIsExplicit = named.some((n) => n.name === 'text') || (positional.length > 6);
    this._shapeText = (textV != null && textIsExplicit) ? String(textV) : null;
    let y = null;
    if (shown) {
      if (loc === 'absolute') {
        const sv = positional[0];
        y = (!isNA(sv) && typeof sv === 'number' && isFinite(sv)) ? sv : null;
      } else if (loc === 'abovebar') y = this.env.bar ? this.env.bar.high : null;
      else if (loc === 'belowbar') y = this.env.bar ? this.env.bar.low : null;
      else if (loc === 'top') y = 'top';
      else if (loc === 'bottom') y = 'bottom';
    }
    st.colors[this.barIndex] = shown ? (color instanceof PineColor ? color : null) : null;
    st.ys[this.barIndex] = shown ? (y == null ? 'above' : y) : null;
    st.texts[this.barIndex] = shown ? this._shapeText : null;
    this.out._pushed.add(key);
    return undefined;
  }

  _fnPlotarrow([positional, named, node]) {
    if (this.dry) return undefined;
    const key = 'g:' + node.id;
    const get = (name, idx) => {
      const f = named.find((n) => n.name === name);
      if (f) return f.value;
      return idx != null && positional.length > idx ? positional[idx] : undefined;
    };
    // official signature: plotarrow(series, title, colorup, colordown,
    //   offset, minheight, maxheight, editable, show_last, display, format)
    const v = positional[0];
    const st = this._shapeSite(key);
    /* ROUND148 (plotarrow never painted): the old code stored the 'above'/
       'below' sentinels in ys (which the adapter skips) and null in colors,
       and one site-level style for a site that mixes up+down arrows. Store a
       real bar anchor like plotshape's abovebar/belowbar — up arrows on the
       bar low, down arrows on the bar high — plus a per-bar direction and
       the colorup/colordown colors. (Title stored for the Style-tab row.) */
    const titleV = get('title', 1);
    if ((st.title == null || st.title === '') && titleV != null && !isNA(titleV)) st.title = String(titleV);
    const shown = !isNA(v) && typeof v === 'number' && isFinite(v) && v !== 0;
    const up = shown && v > 0;
    const col = up ? get('colorup', 2) : get('colordown', 3);
    let y = null;
    if (shown) y = this.env.bar ? (up ? this.env.bar.low : this.env.bar.high) : null;
    st.isArrow = true;
    if (!st.dirs) st.dirs = [];
    /* ROUND149: value-proportional height — minheight/maxheight (px) bound
       the arrow; the magnitude series normalizes in the adapter over the
       full run (stable, no pan flicker). Params are typically const so a
       per-bar scalar assign is exact; a series input resolves last-wins. */
    const numOrNull149 = (x) => (typeof x === 'number' && isFinite(x) ? x : null);
    st.minH = numOrNull149(get('minheight', 5));
    st.maxH = numOrNull149(get('maxheight', 6));
    /* ROUND227 (TV parity): plotarrow force_overlay (slot 12). */
    st.force_overlay = get('force_overlay', 12) === true;
    if (!st.mags) st.mags = [];
    st.colors[this.barIndex] = shown ? (col instanceof PineColor ? col : null) : null;
    st.ys[this.barIndex] = shown ? y : null;
    st.dirs[this.barIndex] = shown ? (up ? 'up' : 'down') : null;
    st.mags[this.barIndex] = shown ? Math.abs(v) : null;
    st.texts[this.barIndex] = null;
    this.out._pushed.add(key);
    return undefined;
  }

  _fnBgcolor([positional, named, node]) {
    if (this.dry) return undefined;
    /* ROUND154: color= also arrives NAMED (bgcolor(color=..., transp=...)) —
       positional-only reading silently dropped it. */
    const cn = named.find((n) => n.name === 'color');
    const c = positional[0] !== undefined ? positional[0] : (cn ? cn.value : undefined);
    const tp = named.find((n) => n.name === 'transp');
    const cc = this._transp(c, tp ? tp.value : undefined);
    this.out.bgcolor[this.barIndex] = cc instanceof PineColor ? cc : null;
    this.out._pushed.add('bgcolor');
    return undefined;
  }

  _fnBarcolor([positional, named, node]) {
    if (this.dry) return undefined;
    const cn = named.find((n) => n.name === 'color');
    const c = positional[0] !== undefined ? positional[0] : (cn ? cn.value : undefined);
    const tp = named.find((n) => n.name === 'transp');
    const cc = this._transp(c, tp ? tp.value : undefined);
    this.out.barcolor[this.barIndex] = cc instanceof PineColor ? cc : null;
    this.out._pushed.add('barcolor');
    return undefined;
  }

  /* plotcandle(open, high, low, close, title, color, wickcolor, editable,
     show_last, bordercolor, display) — per-bar synthetic candle. All four
     series must be na-capable; a bar renders only when ALL are finite. */
  _fnPlotcandle([positional, named, node]) {
    if (this.dry) return undefined;
    const get = (name, idx) => {
      const f = named.find((n) => n.name === name);
      if (f) return f.value;
      return idx != null && positional.length > idx ? positional[idx] : undefined;
    };
    const numOrNull = (v) => (!isNA(v) && typeof v === 'number' && isFinite(v)) ? v : null;
    const colOrNull = (v) => (v instanceof PineColor ? v : null);
    /* ROUND154: v4 transp= on the candle colors (see _transp). */
    const tp = named.find((n) => n.name === 'transp');
    const tpv = tp ? tp.value : undefined;
    const rec = {
      open: numOrNull(get('open', 0)),
      high: numOrNull(get('high', 1)),
      low: numOrNull(get('low', 2)),
      close: numOrNull(get('close', 3)),
      color: colOrNull(this._transp(get('color', 5), tpv)),
      wickcolor: colOrNull(this._transp(get('wickcolor', 6), tpv)),
      bordercolor: colOrNull(this._transp(get('bordercolor', 9), tpv)),
    };
    this.out.candles[this.barIndex] = (rec.open != null && rec.high != null && rec.low != null && rec.close != null) ? rec : null;
    this.out._pushed.add('candles');
    /* ROUND166: Style-tab descriptor (TV "PlotCandle" row). Idempotent —
       every bar carries the same named args. */
    if (!this.dry) {
      const t = get('title', 4);
      const ed = get('editable', 7);
      const dp = get('display', 10);
      this.out.candleMeta = {
        title: t != null && !isNA(t) ? String(t) : '',
        editable: !(ed === false || ed === 0),
        display: dp && dp.__pineEnum ? dp.payload : (typeof dp === 'string' ? dp : 'all'),
      };
    }
    return undefined;
  }

  _fnFill([positional, named, node]) {
    if (this.dry) return undefined;
    let p1 = positional[0] && positional[0].__plotRef ? positional[0].__plotRef : null;
    let p2 = positional[1] && positional[1].__plotRef ? positional[1].__plotRef : null;
    /* ROUND142: fill(hline1, hline2, color) — the second documented overload.
       Each hline becomes a hidden constant plot so the ordinary fill painter
       (which reads plot values per bar) can draw the band. Mixing an hline
       with a plot is an error, as in TradingView. */
    const h1 = positional[0] && positional[0].__hlineRef ? positional[0] : null;
    const h2 = positional[1] && positional[1].__hlineRef ? positional[1] : null;
    if ((h1 && p2) || (p1 && h2)) throw runtimeError('fill() cannot mix a plot and an hline — use two plots or two hlines');
    if (h1 && h2) {
      const hidden = (h) => {
        const k = 'hl:' + h.price;
        let pl = this.out.plots.get(k);
        if (!pl) {
          pl = { key: k, title: '', style: 'line', linewidth: 0, linestyle: 'solid', values: [], colors: [], display: 'none', editable: false, show_last: null, hiddenHline: true };
          this.out.plots.set(k, pl);
          this.out.plotsOrder.push(k);
        }
        pl.values[this.barIndex] = h.price; pl.colors[this.barIndex] = null;
        return k;
      };
      p1 = hidden(h1); p2 = hidden(h2);
    }
    if (!p1 || !p2) {
      // official v6 also supports fill(top_value, bottom_value, ...) — out of MVP
      throw runtimeError('fill() expects two plot references returned by plot()');
    }
    let f = this.out.fills.find((x) => x.p1 === p1 && x.p2 === p2);
    if (!f) {
      f = { p1, p2, colors: [], title: '' };
      this.out.fills.push(f);
    }
    /* ROUND138: TV's extended/"gradient" fill() overload —
       fill(plot1, plot2, top_value, bottom_value, top_color, bottom_color,
       title, display). Distinguished from the flat form by having a 3rd
       positional argument (top_value) that is NOT itself a plot ref. The
       fill color for the bar is top_color/bottom_color interpolated by
       where the current price sits between bottom_value and top_value —
       "less transparent near price", same as TradingView. */
    const topValue = positional[2];
    const bottomValue = positional[3];
    const isGradientForm = topValue != null && !isNA(topValue) && typeof topValue === 'number'
      && bottomValue != null && !isNA(bottomValue) && typeof bottomValue === 'number';
    if (isGradientForm) {
      const topColor = toColor(positional[4]);
      const bottomColor = toColor(positional[5]);
      if (topColor && bottomColor) {
        let t = 0.5;
        if (topValue !== bottomValue) {
          const price = this.env.bar.close;
          t = (price - bottomValue) / (topValue - bottomValue);
          t = Math.min(1, Math.max(0, t));
        }
        const lerp = (a, b) => a + (b - a) * t;
        f.colors[this.barIndex] = new PineColor(
          lerp(bottomColor.r, topColor.r),
          lerp(bottomColor.g, topColor.g),
          lerp(bottomColor.b, topColor.b),
          lerp(bottomColor.a, topColor.a),
        );
        this.out._pushed.add('fill:' + p1 + ':' + p2);
        return undefined;
      }
    }
    /* ROUND139: TV's canonical form is fill(p1, p2, COLOR, title, ...) — the
       colour is the 3rd POSITIONAL argument. Only named `color=` used to be
       read, so every fill written the documented way had no colour at all. */
    const colorArg = named.find((n) => n.name === 'color');
    const transpArg = named.find((n) => n.name === 'transp');
    let c = colorArg ? colorArg.value : positional[2];
    if (c === NA || isNA(c)) c = new PineColor(0, 0, 0, 0); // explicit na colour = hidden fill
    c = this._transp(c, transpArg ? transpArg.value : undefined); // ROUND154: v4 transp=
    f.colors[this.barIndex] = c instanceof PineColor ? c : null;
    this.out._pushed.add('fill:' + p1 + ':' + p2);
    return undefined;
  }

  _fnHline([positional, named, node]) {
    const price = positional[0];
    if (isNA(price) || typeof price !== 'number') return undefined;
    const get = (name, idx) => {
      const f = named.find((n) => n.name === name);
      return f ? f.value : (idx != null && positional.length > idx ? positional[idx] : undefined);
    };
    const hlineCol = this._transp(get('color', 1), get('transp', undefined)); // ROUND154: v4 transp=
    const rec = {
      price,
      color: hlineCol instanceof PineColor ? hlineCol : null,
      linestyle: enumPayload(get('linestyle', 2)) || 'dashed',
      linewidth: this._optInt(get('linewidth', 3), 1),
      title: get('title', 4) != null ? String(get('title', 4)) : '',
    };
    // hline is a const-level declaration: register once (first bar sees it)
    const exists = this.out.hlines.some((h) => h.price === rec.price && h.title === rec.title);
    if (!exists && !this.dry) this.out.hlines.push(rec);
    return { __hlineRef: true, price };
  }

  _fnAlertcondition([positional, named, node]) {
    /* ROUND225 (TV parity): alertcondition() is rejected in strategies —
       use alert() there (the 64-plot accounting below still counts it). */
    if (this.meta && this.meta.isStrategy) {
      throw runtimeError("alertcondition() cannot be used in strategy scripts — use alert() instead");
    }
    const cond = positional[0];
    const title = positional[1] != null && !isNA(positional[1]) ? String(positional[1]) : '';
    const message = positional[2] != null && !isNA(positional[2]) ? String(positional[2]) : '';
    let a = this.out.alertconds.find((x) => x.title === title);
    if (!a) { a = { title, message }; this.out.alertconds.push(a); }
    a.lastCond = truthy(cond);
    return undefined;
  }

  _fnAlert([positional, named, node]) {
    // MVP stub (roadmap phase 7 → next round): collect the message, no firing
    const message = positional[0] != null && !isNA(positional[0]) ? String(positional[0]) : '';
    if (message) this.out.alerts.push({ message, at: Date.now(), bar: this.barIndex });
    return undefined;
  }

  /* ROUND190: log.info/warning/error(format, ...) — formats like str.format,
     RETURNS the formatted string (TV parity), and collects {level, msg, bar}
     into out.pineLogs (cap 200; same-bar+same-msg dupes from forming re-runs
     collapse). A Pine Logs viewer panel is the follow-up; the data is here. */
  _fnLog(level, node, frame) {
    const { positional } = this._mergeCallArgs(node, frame);
    const site = { env: this.env };
    let msg;
    try {
      msg = strFns.format(site, positional[0], ...positional.slice(1));
    } catch (e) {
      msg = positional[0] != null ? String(positional[0]) : 'NaN';
    }
    const text = (msg == null || (typeof msg === 'object' && isNA(msg))) ? 'NaN' : String(msg);
    this.out.pineLogs = this.out.pineLogs || [];
    const log = this.out.pineLogs;
    const last = log.length ? log[log.length - 1] : null;
    if (!this.dry && !(last && last.bar === this.barIndex && last.msg === text && last.level === level)) {
      log.push({ level, msg: text, bar: this.barIndex });
      while (log.length > 200) log.shift();
    }
    return text;
  }

  /* ============================ EXECUTION ============================== */

  /** execute a single bar at index i (must NOT be re-run for the same bar
   *  without restore(preFormSnap) — see updateForming) */
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
  }

  /* ROUND195: one library step — the importer's runBar drives this before its
     own body. No broker fills (strategy.* is gated in libraries), no equity
     tape; series builtins + the end-of-bar history sweep keep `[][k]`
     consistent with the host runtime. */
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
  }

  /** full pass over the loaded history; the LAST bar runs as the forming one
   *  and a pre-forming snapshot is kept for the per-tick rollback */
  runAll(bars) {
    this.bars = bars;
    this.env.bars = bars; // ROUND229: session.isfirstbar/islastbar neighbor reads
    this.totalBars = bars.length;
    this.env.lastBarIndex = bars.length - 1; // ROUND184b: last_bar_index is the final bar (was never set — fell back to the current bar, so `bar_index == last_bar_index - N` never fired)
    this._preFormSnap = null;
    this._resetForFullRun();
    for (let i = 0; i < bars.length; i++) {
      if (i === bars.length - 1) this._preFormSnap = this.snapshot();
      this.runBar(i, i === bars.length - 1);
    }
  }

  /**
   * Same as runAll but yields to the event loop so a heavy script (the
   * roadmap's own benchmark: 786 Zones) never blocks the UI thread for
   * seconds — phase 8's soft-safety requirement.
   * ROUND80 (user report: indicator reload feels heavy on TF switches): the
   * fixed every-400-bars yield let ONE chunk take 50ms+ on dense histories
   * (each chunk runs synchronously), so the chart visibly janked between
   * freezes. The yield now fires on a TIME BUDGET (~12ms per slice, one
   * frame) OR the bar cap, whichever comes first — every slice stays inside
   * a frame budget and the same total work is spread smoothly. The per-bar
   * performance.now() read is noise next to runBar's own cost.
   */
  /** ROUND87: TV full-recalculation semantics — a complete re-run (history
   *  reload, session re-stitch, input change on the SAME runtime) is a FRESH
   *  script execution: `var` declarations re-initialize, drawing objects
   *  start from an empty store, series histories rebuild. Without this the
   *  var-held object arrays (786 Zones' `var box[] zoneBoxes`) kept
   *  referencing store objects wiped by the previous clear — the script then
   *  silently mutated ORPHANS and nothing painted after a re-run. */
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
    /* ROUND195: libraries reset with the host (fresh globals/series/sites). */
    if (this.libs) for (const [, lib] of this.libs) lib.rt._resetForFullRun();
  }

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
  }

  /** tick update: roll back to the confirmed-history state and re-run ONLY
   *  the forming bar — the rounds-71/72 incremental discipline.
   *  ROUND198 (tick model): with calc_on_every_tick=false the body does NOT
   *  re-execute on ticks (TV parity) — only working orders fill against the
   *  developing bar (plus the strategy equity mark). */
  updateForming(bars) {
    if (!bars || !bars.length) return;
    this.bars = bars;
    this.env.bars = bars; // ROUND229 (see runAll)
    this.totalBars = bars.length;
    this.env.lastBarIndex = bars.length - 1; // ROUND184b (see runAll)
    if (!this._preFormSnap) this._preFormSnap = this.snapshot();
    this.restore(this._preFormSnap);
    // visuals born during the PREVIOUS forming run die with the rollback
    // (official behaviour: objects created on the realtime bar are removed
    // before the script re-executes on that bar)
    this.dropObjectsBornAfter(bars.length - 1);
    if (!this.calcEveryTick && !this.dry) this._tickFillsOnly(bars.length - 1);
    else this.runBar(bars.length - 1, true);
  }

  /* ROUND198: fills-only realtime tick (calc_on_every_tick=false). No body
     execution — no new signals, no plot writes, no history pollution (the
     end-of-bar sweep is deliberately skipped); the broker evaluates working
     orders against the developing bar and marks equity, exactly like TV's
     intrabar fills with a close-only calculation. Libraries don't advance
     either (their top-level is part of the calculation). */
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
  }

  /** a new live bar arrived: previous forming bar becomes confirmed —
   *  snapshot the current state, then run the new bar */
  pushNewBar(bars) {
    if (!bars || !bars.length) return;
    this.bars = bars;
    this.env.bars = bars; // ROUND229 (see runAll)
    this.totalBars = bars.length;
    this.env.lastBarIndex = bars.length - 1; // ROUND184b (see runAll)
    this._preFormSnap = this.snapshot();
    this.runBar(bars.length - 1, true);
  }

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
  }

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
  }

  /* ------------------------------ scopes ------------------------------- */

  _execBlockTop(stmts) {
    this._execStmts(stmts, { id: 'g', scopes: [this.globals], fnBase: 0 });
  }

  _lookup(frame, name) {
    for (let k = frame.scopes.length - 1; k >= 0; k--) {
      const sc = frame.scopes[k];
      const rec = sc instanceof Map ? sc.get(name) : undefined;
      if (rec !== undefined) return rec;
    }
    return null;
  }

  /* ROUND199 (function-scope writes, TV parity): a plain `=`/declaration
     inside a function body resolves ONLY within the function's own scopes
     (params/locals/blocks) — never in caller frames or globals. Before this,
     `d = ...` inside a callee captured a same-named caller variable (786
     Zones' sundayOfMonth clobbered its caller's `d`, shifting EU sessions by
     an hour). Reads keep the concatenated visibility (lenient); `:=` keeps
     the global lookup (TV rejects cross-scope `:=`, we stay lenient). */
  _fnBase(frame) { return (frame && typeof frame.fnBase === 'number') ? frame.fnBase : 0; }

  _scopeLookup(frame, name) {
    const base = this._fnBase(frame);
    for (let k = frame.scopes.length - 1; k >= base; k--) {
      const sc = frame.scopes[k];
      const rec = sc instanceof Map ? sc.get(name) : undefined;
      if (rec !== undefined) return rec;
    }
    return null;
  }

  _declare(frame, name, value, kind) {
    const sc = frame.scopes[frame.scopes.length - 1];
    let rec = sc.get(name);
    if (!rec) {
      rec = { value: NA, kind, hist: new SeriesBuf(this.maxBarsBack) };
      sc.set(name, rec);
    }
    rec.kind = kind;
    return rec;
  }

  /* ROUND160: one persistent slot per `var`/`varip` declaration in a
     transient scope (see _varSlots). The slot rec is ALSO linked into the
     current transient scope so same-execution reads/assigns resolve by name;
     the link evaporates with the scope, the slot persists.
     ROUND164 (BUG: function-local `var` was shared across call SITES —
     `leg(50)/leg(5)/leg(3)` in SMC overwrote one slot and polluted each
     other's ta.change history, spraying structure lines): the key now
     carries the call-site frame id. Function instances are already
     per-call-site (`_callUser` instId), and Pine inlines user functions, so
     each static call location owns its persistent `var` state — exactly
     like TV. Same-declaration re-execution (loops) still shares one slot. */
  _varSlot(frame, st, name, kind, suffix) {
    const key = 'vs:' + this._frameKey(frame) + ':' + (st.id != null ? st.id : name + '@' + st.line) + (suffix || '');
    let rec = this._varSlots.get(key);
    if (!rec) {
      rec = { value: NA, kind, hist: new SeriesBuf(this.maxBarsBack), slotKey: key, initialized: false };
      this._varSlots.set(key, rec);
    }
    rec.kind = kind;
    return rec;
  }

  /* global-frame statements run with scopes === [globals]; anything deeper
     (blocks, function bodies) is transient for `var` purposes. */
  _isGlobalFrame(frame) {
    return frame.scopes.length === 1 && frame.scopes[0] === this.globals;
  }

  /* link a persistent slot rec into the current transient scope (name
     resolution for the rest of this execution). */
  _linkSlot(frame, name, rec) {
    frame.scopes[frame.scopes.length - 1].set(name, rec);
    return rec;
  }

  _execStmts(stmts, frame) {
    for (const st of stmts) this._execStmt(st, frame);
  }

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
  }

  _execBlock(block, frame) {
    frame.scopes.push(new Map());
    try { this._execStmts(block.stmts, frame); }
    finally { frame.scopes.pop(); }
  }

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
  }

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
  }

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
  }

  /* for-in: iterate arrays (with optional [index, value] pair), strings and maps.
     Removing from the iterated array mid-loop is allowed (official quirk) —
     we snapshot the length each turn. */
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
  }

  _tick() {
    if (++this.steps > this.maxOpsPerBar) {
      throw loopError(`script exceeded the per-bar execution budget (${this.maxOpsPerBar} steps)`);
    }
  }

  /* ------------------------------ eval --------------------------------- */

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
  }

  /* ROUND158: request.security HTF aggregate reads. Returns undefined for
     non-builtin names (caller falls through to scope lookup — user variables
     stay visible inside security() expressions, TV parity). Raw feed holes
     (null/NaN) normalize to NA here, like the ingest path below. */
  /* ROUND160: HTF bucket-tape read for builtin history (close[1] = previous
     HTF close). off=0 is the running aggregate (same as _htfBuiltin); off>=1
     walks committed (closed) buckets, newest last. Short tape -> na (TV has
     no HTF history there yet). Non-builtins and missing sites fall through
     (undefined) to the normal chart-frame paths. */
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
  }

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
  }

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
  }

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
  }

  _evalUnary(node, frame) {
    const v = this.eval(node.a, frame);
    if (node.op === '-') return isNA(v) ? NA : (typeof v === 'number' ? -v : NA);
    if (node.op === '+') return v;
    if (node.op === 'not') {
      if (isNA(v)) return NA;
      return !this._cond(v, "'not' operand");
    }
    return NA;
  }

  /* ROUND152 (TV parity): v6 bool strictness — no int/float/string auto-coercion
     in bool contexts (if/?:/and/or/not/while/bare-switch). na passes through
     (falsy, as before); bool passes; anything else throws with a migration
     hint. Pre-v6 scripts keep the legacy loose truthiness. */
  _cond(v, where) {
    if (this.version >= 6 && !isNA(v) && typeof v !== 'boolean') {
      const got = v && v.css ? 'color' : (v && v.__pineArray ? 'array' : (v && v.__pineMatrix ? 'matrix' : (v && v.__pineMap ? 'map' : (v && v.__pineObj ? v.kind : typeof v))));
      throw runtimeError(`v6: ${where} needs a bool value (got ${got}); use an explicit comparison or bool()`);
    }
    return truthy(v);
  }

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
  }

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
  }

  _cmp(op, a, b) {
    if (isNA(a) || isNA(b)) return NA;
    if (typeof a === 'string' && typeof b === 'string') {
      switch (op) { case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b; }
    }
    const x = num(a), y = num(b);
    if (!isFinite(x) || !isFinite(y)) return NA;
    switch (op) { case '<': return x < y; case '<=': return x <= y; case '>': return x > y; case '>=': return x >= y; }
    return NA;
  }

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
  }

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
  }

  _evalIf(node, frame) {
    const c = this.eval(node.cond, frame);
    if (this._cond(c, "'if'")) return this._blockValue(node.then, frame);
    if (node.els) return this._blockValue(node.els, frame);
    return NA;
  }

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
  }

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
  }

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
  }

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
  }

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
  }

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
  }

  _tfMonthStart(tSec, n) {
    // first-of-month 00:00 UTC, stepping n months (1M/3M/12M)
    const d = new Date(tSec * 1000);
    const months = d.getUTCFullYear() * 12 + d.getUTCMonth();
    const base = Math.floor(months / n) * n;
    return Date.UTC(Math.floor(base / 12), base % 12, 1, 0, 0, 0) / 1000;
  }

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
  }

  /* ====================== UDT (type) & enum support ====================== */

  /* A UDT value is a plain object with __udt (type name) + fields map.
     Field reads go through .field member access on the value; methods are
     user functions whose first param receives the instance. */
  _registerUDT(st) {
    if (!this.udts) this.udts = new Map();
    this.udts.set(st.name, st);
    // global TypeName.new(...) constructor — resolved in _evalCall
    this.globals.set(st.name, { value: { __udtType: st.name }, kind: 'plain', hist: null });
    this._gwEpoch++;
  }

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
  }

  /** constant-fold an AST node at registration time (enums/defaults) */
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
  }

  /** build a UDT instance from a TypeName.new(...) call */
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
  }

  /* ------------------------------- calls ------------------------------- */

  /**
   * ROUND78 perf — conservative static purity analysis (runs ONCE per user
   * function node). A function is "pure" when its body can only produce a
   * value from its arguments + per-bar constants:
   *   allowed: literals, ident reads, arithmetic/logic/ternary/if/for/while,
   *            local decls and `:=` to LOCALS only, calls to other PURE user
   *            functions, the math / str / color namespaces and a whitelist
   *            of stateless builtins (timestamp/timenow/year/.../int/float/),
   *            member reads of syminfo./timeframe. (per-run constants).
   * rejected: ta.* (series site state), request.*, input.*, every visual fn,
   *           array.* (mutation/identity), line/box/label.*, history indexing
   *           `x[...]`, method calls, nested funcdecls, switch (AST shape not
   *           audited here), ANY `:=` to a non-local (global write).
   * Ident reads of globals remain allowed at ANALYSIS level because the
   * runtime memo key carries this._gwEpoch — any global (re)write bumps the
   * epoch and invalidates every memo entry of the bar (see _execStmt).
   * Pure calls are memoized per (call-site, args, epoch) within one runBar —
   * 786 Zones' session/DST chain (sessionZoneStart -> sundayOfMonth ->
   * is*_DST -> zoneGMTMinutes) repeats identical calls dozens of times per
   * intrabar; the memo turns each into a Map lookup.
   */
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
  }

  /** memo signature for a call argument — null when not memoizable */
  _memoSig(v) {
    if (v === NA) return '~';
    const t = typeof v;
    if (t === 'number') return isFinite(v) ? String(v) : null;
    if (t === 'boolean') return v ? '1' : '0';
    if (t === 'string') return 's' + JSON.stringify(v);
    if (v && v.css) return 'c' + v.css();
    if (v && v.__pineEnum) return 'e' + v.payload;
    return null; // arrays / drawing objects / proxies — never memoized
  }

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
  }

  /* obj.method(...) dispatch shared by the member-call path and the
     user-variable-with-method path above */
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
  }

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
  }

  /* ROUND195: library-mode gate — plots/inputs/orders/drawings stay loud. */
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
  }

  /* ROUND195: `Alias.fn(...)` — merge args in the importer's frame, then run
     the library function inside the library runtime (own series state). */
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
  }

  /* ROUND195: `Alias.VAR` — the library global's current-bar value. */
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
  }

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
  }

  /* Shared body runner for local calls (_callUser) and library calls
     (_callLib via the library runtime): per-site instance, recursion guard,
     pure-function per-bar memo, param binding, statement execution. */
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
  }

  /* ======================= SNAPSHOT / ROLLBACK ========================= */

  /** capture variable state (for the forming-bar rollback) */
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
  }

  _cloneVal(v) {
    if (v && v.__pineArray) return v.snapshotClone();
    /* ROUND196: matrices/maps snapshot like arrays (reference types). */
    if (v && (v.__pineMatrix || v.__pineMap)) return v.snapshotClone();
    return v; // primitives, colors (immutable), object refs (stable), refs
  }

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
  }

  /** objects born on (or after) a bar — used to drop visuals of a rolled-back run */
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
  }
}

export { PineRuntime };
