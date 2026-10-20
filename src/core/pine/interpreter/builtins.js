/**
 * Pine interpreter â€” builtin namespace/function registration (_initBuiltins.._fnLog).
 *
 * Split out of core/pine/interpreter.js in F4.3. Method bodies are moved
 * verbatim and attached to PineRuntime.prototype by interpreter.js; no
 * logic changes.
 *
 * @module core/pine/interpreter/builtins
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

const builtins = {
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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  _polylineFns() {
    const rt = this;
    return {
      new: (...a) => rt._nsObjNew('polyline', a, polylineNew),
      delete: (site, v) => { if (v && !isNA(v)) rt.store.del('polyline', v); },
    };
  },

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
  },

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
  },

  _nsObjNew(kind, callArgs, factory) {
    // callArgs = [site, ...positional]; named args were stashed on site.named
    const site = callArgs[0] || {};
    // chart.point positional args carry {time, index, price} — unpack into
    // (x, y) pairs so line.new(p1, p2) / box.new(p1, p2) behave like TV
    const merged = [];
    const named = (site.named || []).map(({ name, value }) => ({ name, value: this._unpackPoint(value) }));
    const positional = callArgs.slice(1).map((v) => this._unpackPoint(v));
    return factory(this.store, positional, named, { barIndex: this.barIndex, bars: this.bars });
  },

  _unpackPoint(v) {
    if (v && v.__pineObj && v.kind === 'point') {
      const x = v.time != null ? v.time : v.index;
      return { __pointXY: true, x, y: v.price };
    }
    return v;
  },

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
  },

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
  },

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
  },

  _checkPlotCap() {
    let n = this.out.shapes.size + this.out.alertconds.length;
    for (const pl of this.out.plots.values()) if (!pl.hiddenHline) n++;
    if (n > 64) throw runtimeError('The script has too many plots: at most 64 plot*() calls / alertcondition() are allowed');
  },

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
  },

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
  },

  _optInt(v, dflt) {
    if (v == null || isNA(v) || typeof v !== 'number' || !isFinite(v)) return dflt;
    /* ROUND135: TV accepts linewidth=0 (invisible plot, e.g. Supertrend's
       mPlot that only anchors a fill). Clamp to [0,5], not [1,5]. */
    return Math.max(0, Math.min(5, Math.round(v)));
  },

  _shapeSite(key) {
    let s = this.out.shapes.get(key);
    if (!s) {
      s = { key, title: null, style: 'cross', size: 'small', colors: [], texts: [], ys: [] };
      this.out.shapes.set(key, s);
    }
    return s;
  },

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
  },

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
  },

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
  },

  _fnBarcolor([positional, named, node]) {
    if (this.dry) return undefined;
    const cn = named.find((n) => n.name === 'color');
    const c = positional[0] !== undefined ? positional[0] : (cn ? cn.value : undefined);
    const tp = named.find((n) => n.name === 'transp');
    const cc = this._transp(c, tp ? tp.value : undefined);
    this.out.barcolor[this.barIndex] = cc instanceof PineColor ? cc : null;
    this.out._pushed.add('barcolor');
    return undefined;
  },

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
  },

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
  },

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
  },

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
  },

  _fnAlert([positional, named, node]) {
    // MVP stub (roadmap phase 7 → next round): collect the message, no firing
    const message = positional[0] != null && !isNA(positional[0]) ? String(positional[0]) : '';
    if (message) this.out.alerts.push({ message, at: Date.now(), bar: this.barIndex });
    return undefined;
  },

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
  },
};

export { builtins };
