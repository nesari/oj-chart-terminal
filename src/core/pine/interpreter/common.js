/**
 * Pine interpreter â€” shared constants and argument-merge helpers.
 *
 * Moved verbatim out of core/pine/interpreter.js in F4.3.
 *
 * @module core/pine/interpreter/common
 */
import { NA, enumPayload } from '../types.js';
import { runtimeError } from '../errors.js';

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
  /* ROUND282: all-time extremes take exactly one argument (no length). */
  'ta.max': ['source'], 'ta.min': ['source'],
  'ta.pivot_point_levels': ['type', 'anchor', 'developing'],
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
import { brokerInit, brokerClone, brokerFills, brokerGet, strategyTradeField, pushBrokerBar, brokerStats, strategyFns } from '../stdlib/strategy.js';
import { makeInputFn, strInput, sourceInput, BUILTIN_SOURCES } from '../stdlib/inputs.js';
import {
  tzParts, exParts, daysInMonth, timestamp, timenow,
} from '../stdlib/time.js';

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

export {
  SYNTH_TICKER, normCurrency, NS_PARAMS, mergeNsArgs, mergeMethodArgs,
  recordMissing, MAX_BARS_BACK, isoWeek, BREAK, CONTINUE, OHLCV_BARS_BACK,
  HTF_BUILTINS, srcHandle, LIB_BANNED_IDENTS, LIB_BANNED_NS,
};
