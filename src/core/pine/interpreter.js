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
import { brokerInit, brokerClone, brokerFills, brokerGet, strategyTradeField, pushBrokerBar, brokerStats, strategyFns } from './stdlib/strategy.js';
import { makeInputFn, strInput, sourceInput, BUILTIN_SOURCES } from './stdlib/inputs.js';
import {
  tzParts, exParts, daysInMonth, timestamp, timenow,
} from './stdlib/time.js';
import {
  SYNTH_TICKER, normCurrency, NS_PARAMS, mergeNsArgs, mergeMethodArgs,
  recordMissing, MAX_BARS_BACK, isoWeek, BREAK, CONTINUE, OHLCV_BARS_BACK,
  HTF_BUILTINS, srcHandle, LIB_BANNED_IDENTS, LIB_BANNED_NS,
} from './interpreter/common.js';
import { builtins } from './interpreter/builtins.js';
import { series } from './interpreter/series.js';
import { statements } from './interpreter/statements.js';
import { expressions } from './interpreter/expressions.js';
import { state } from './interpreter/state.js';

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
}

/* F4.3: the engine is one runtime object; execution concerns live in
   sibling modules and are mixed onto the prototype (no logic change). */
Object.assign(PineRuntime.prototype, builtins, series, statements, expressions, state);

export { PineRuntime };
