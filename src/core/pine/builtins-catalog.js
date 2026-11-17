/**
 * Built-in indicators as Pine scripts (ROUND299).
 *
 * The 27 indicators that used to be hand-written JavaScript in
 * `core/indicators.js` now ship as REAL Pine scripts, so there is exactly ONE
 * implementation of each formula in the app: the same engine that runs the
 * user's own scripts and the TradingView samples.
 *
 * Why this replaced the JS versions: the differential audit (R298) had to
 * maintain a second implementation and compare it against the engine; several
 * bugs existed only because the two drifted. With one engine there is nothing
 * to drift.
 *
 * Conventions
 *  - `id`      stable script id, also the persistence key (`builtin:<type>`).
 *  - `type`    the legacy indicator registry key, kept so old layouts and the
 *              public `IndicatorsUI.add(pane, 'rsi')` API keep working.
 *  - `group`   the Indicators dialog section (same four as before).
 *  - `params`  legacy param key -> Pine input title, so a saved
 *              `{ length: 50 }` still lands on the right input after upgrade.
 *  - `source`  the script. Titles are explicit because the Style tab and the
 *              per-plot color overrides key on them.
 *
 * Every script declares `overlay` to decide main chart vs sub-pane, and every
 * input keeps the TradingView default, so a fresh add looks like TV.
 *
 * @module core/pine/builtins-catalog
 */

const SRC = (s) => s.replace(/^\n/, '');

export const BUILTIN_INDICATORS = [
  /* ------------------------------- Trend (main) ------------------------ */
  {
    type: 'sma', id: 'builtin:sma', label: 'Moving Average (SMA)', group: 'Trend', overlay: true,
    params: { length: 'Length' },
    source: SRC(`
//@version=6
indicator("Moving Average (SMA)", overlay = true)
length = input.int(20, "Length", minval = 1)
plot(ta.sma(close, length), "SMA", color = #2962ff, linewidth = 2)
`),
  },
  {
    type: 'ema', id: 'builtin:ema', label: 'Moving Average (EMA)', group: 'Trend', overlay: true,
    params: { length: 'Length' },
    source: SRC(`
//@version=6
indicator("Moving Average (EMA)", overlay = true)
length = input.int(20, "Length", minval = 1)
plot(ta.ema(close, length), "EMA", color = #ff9800, linewidth = 2)
`),
  },
  {
    type: 'wma', id: 'builtin:wma', label: 'Moving Average (WMA)', group: 'Trend', overlay: true,
    params: { length: 'Length' },
    source: SRC(`
//@version=6
indicator("Moving Average (WMA)", overlay = true)
length = input.int(20, "Length", minval = 1)
plot(ta.wma(close, length), "WMA", color = #ab47bc, linewidth = 2)
`),
  },
  {
    type: 'hma', id: 'builtin:hma', label: 'Hull Moving Average', group: 'Trend', overlay: true,
    params: { length: 'Length' },
    source: SRC(`
//@version=6
indicator("Hull Moving Average", overlay = true)
length = input.int(21, "Length", minval = 1)
plot(ta.hma(close, length), "HMA", color = #00bcd4, linewidth = 2)
`),
  },
  {
    type: 'bollinger', id: 'builtin:bollinger', label: 'Bollinger Bands', group: 'Trend', overlay: true,
    params: { length: 'Length', mult: 'StdDev' },
    source: SRC(`
//@version=6
indicator("Bollinger Bands", overlay = true)
length = input.int(20, "Length", minval = 1)
mult   = input.float(2.0, "StdDev", minval = 0.5, maxval = 6.0, step = 0.1)
basis  = ta.sma(close, length)
dev    = mult * ta.stdev(close, length)
upper  = basis + dev
lower  = basis - dev
pU = plot(upper, "Upper", color = #2962ff, linewidth = 1)
pL = plot(lower, "Lower", color = #2962ff, linewidth = 1)
plot(basis, "Basis", color = #2962ff, linewidth = 1)
fill(pU, pL, color.new(#2962ff, 94), "Background")
`),
  },
  {
    type: 'donchian', id: 'builtin:donchian', label: 'Donchian Channels', group: 'Trend', overlay: true,
    params: { length: 'Length' },
    source: SRC(`
//@version=6
indicator("Donchian Channels", overlay = true)
length = input.int(20, "Length", minval = 1)
upper = ta.highest(high, length)
lower = ta.lowest(low, length)
basis = (upper + lower) / 2
pU = plot(upper, "Upper", color = #00bcd4, linewidth = 1)
pL = plot(lower, "Lower", color = #00bcd4, linewidth = 1)
plot(basis, "Basis", color = #00bcd4, linewidth = 1, style = plot.style_linebr)
fill(pU, pL, color.new(#00bcd4, 95), "Background")
`),
  },
  {
    type: 'keltner', id: 'builtin:keltner', label: 'Keltner Channels', group: 'Trend', overlay: true,
    params: { length: 'Length', mult: 'Multiplier' },
    source: SRC(`
//@version=6
indicator("Keltner Channels", overlay = true)
length = input.int(20, "Length", minval = 1)
mult   = input.float(2.0, "Multiplier", minval = 0.5, maxval = 6.0, step = 0.1)
// TradingView's Keltner basis is an EMA, not an SMA.
basis  = ta.ema(close, length)
atrLen = ta.atr(length)
upper  = basis + mult * atrLen
lower  = basis - mult * atrLen
pU = plot(upper, "Upper", color = #ffd54f, linewidth = 1)
pL = plot(lower, "Lower", color = #ffd54f, linewidth = 1)
plot(basis, "Basis", color = #ffd54f, linewidth = 1)
fill(pU, pL, color.new(#ffd54f, 95), "Background")
`),
  },
  {
    type: 'envelopes', id: 'builtin:envelopes', label: 'Moving Average Envelopes', group: 'Trend', overlay: true,
    params: { length: 'Length', percent: 'Percent' },
    source: SRC(`
//@version=6
indicator("Moving Average Envelopes", overlay = true)
length  = input.int(20, "Length", minval = 1)
percent = input.float(2.0, "Percent", minval = 0.1, maxval = 20.0, step = 0.1)
basis = ta.sma(close, length)
k     = percent / 100
plot(basis * (1 + k), "Upper", color = #2962ff, linewidth = 1)
plot(basis, "Basis", color = #2962ff, linewidth = 1)
plot(basis * (1 - k), "Lower", color = #2962ff, linewidth = 1)
`),
  },
  {
    type: 'vwap', id: 'builtin:vwap', label: 'VWAP (Session)', group: 'Volume', overlay: true,
    params: {},
    source: SRC(`
//@version=6
indicator("VWAP (Session)", overlay = true)
plot(ta.vwap, "VWAP", color = #ff9800, linewidth = 2)
`),
  },
  {
    /* TV's Parabolic SAR takes ACCELERATION FRACTIONS (0.02 / 0.02 / 0.2).
       The old JS dialog showed percentages (2 / 2 / 20) and divided by 100,
       so the same numbers produced different curves than TV. The inputs now
       match TV exactly. */
    type: 'sar', id: 'builtin:sar', label: 'Parabolic SAR', group: 'Trend', overlay: true,
    params: { start: 'Start', inc: 'Increment', max: 'Max' },
    source: SRC(`
//@version=6
indicator("Parabolic SAR", overlay = true)
start = input.float(0.02, "Start", minval = 0.001, maxval = 0.1, step = 0.001)
inc   = input.float(0.02, "Increment", minval = 0.001, maxval = 0.1, step = 0.001)
maxv  = input.float(0.2, "Max", minval = 0.01, maxval = 0.5, step = 0.01)
sar = ta.sar(start, inc, maxv)
plot(sar, "Parabolic SAR", style = plot.style_circles, linewidth = 2, color = sar < close ? #26a69a : #ef5350)
`),
  },
  {
    type: 'supertrend', id: 'builtin:supertrend', label: 'SuperTrend', group: 'Trend', overlay: true,
    params: { length: 'ATR Length', mult: 'Factor' },
    source: SRC(`
//@version=6
indicator("SuperTrend", overlay = true)
atrLen = input.int(10, "ATR Length", minval = 1)
factor = input.float(3.0, "Factor", minval = 0.5, maxval = 10.0, step = 0.1)
[st, dir] = ta.supertrend(factor, atrLen)
// dir: -1 = uptrend (line under price), +1 = downtrend
plot(dir < 0 ? st : na, "Up Trend", color = #26a69a, linewidth = 2, style = plot.style_linebr)
plot(dir > 0 ? st : na, "Down Trend", color = #ef5350, linewidth = 2, style = plot.style_linebr)
`),
  },
  {
    type: 'ichimoku', id: 'builtin:ichimoku', label: 'Ichimoku Cloud', group: 'Trend', overlay: true,
    params: { conv: 'Conversion', base: 'Base', spanB: 'Span B' },
    source: SRC(`
//@version=6
indicator("Ichimoku Cloud", overlay = true)
convLen  = input.int(9, "Conversion", minval = 1)
baseLen  = input.int(26, "Base", minval = 1)
spanBLen = input.int(52, "Span B", minval = 1)
displace = input.int(26, "Displacement", minval = 1)

mid(len) =>
    (ta.highest(high, len) + ta.lowest(low, len)) / 2

conv  = mid(convLen)
base  = mid(baseLen)
spanA = (conv + base) / 2
spanB = mid(spanBLen)

// TradingView: the leading spans are plotted at displacement - 1 and the
// lagging span at -(displacement - 1), so the cloud that ends at the current
// candle is the one the script computed 26 bars ago. (It used to shift by the
// full displacement, putting every line one bar off TV.)
plot(conv, "Conversion", color = #2962ff, linewidth = 1)
plot(base, "Base", color = #b71c1c, linewidth = 1)
plot(close, "Lagging Span", color = #43a047, linewidth = 1, offset = -displace + 1)
pA = plot(spanA, "Span A", color = #a5d6a7, linewidth = 1, offset = displace - 1)
pB = plot(spanB, "Span B", color = #ef9a9a, linewidth = 1, offset = displace - 1)
// TV's cloud is GREEN when Span A is above Span B and RED when it is below —
// one conditional fill colour per bar, not one colour for the whole band.
fill(pA, pB, color = spanA > spanB ? color.rgb(67, 160, 71, 90) : color.rgb(244, 67, 54, 90), title = "Cloud")
`),
  },

  /* ----------------------------- Oscillators (sub) --------------------- */
  {
    type: 'rsi', id: 'builtin:rsi', label: 'Relative Strength Index', group: 'Oscillators', overlay: false,
    params: { length: 'Length' },
    source: SRC(`
//@version=6
indicator("Relative Strength Index", overlay = false)
length = input.int(14, "Length", minval = 1)
r = ta.rsi(close, length)
plot(r, "RSI", color = #ab47bc, linewidth = 2)
hline(70, "Overbought", color = color.new(#b2b5be, 60), linestyle = hline.style_dashed)
hline(50, "Middle", color = color.new(#b2b5be, 75), linestyle = hline.style_dashed)
hline(30, "Oversold", color = color.new(#b2b5be, 60), linestyle = hline.style_dashed)
`),
  },
  {
    type: 'macd', id: 'builtin:macd', label: 'MACD', group: 'Oscillators', overlay: false,
    params: { fast: 'Fast', slow: 'Slow', signal: 'Signal' },
    source: SRC(`
//@version=6
indicator("MACD", overlay = false)
fast   = input.int(12, "Fast", minval = 1)
slow   = input.int(26, "Slow", minval = 1)
signal = input.int(9, "Signal", minval = 1)
[macdLine, signalLine, histLine] = ta.macd(close, fast, slow, signal)
// TV colors the histogram by SIGN vs zero, not by whether it rose.
plot(histLine, "Histogram", style = plot.style_columns, color = histLine >= 0 ? color.new(#26a69a, 50) : color.new(#ef5350, 50))
plot(macdLine, "MACD", color = #2962ff, linewidth = 2)
plot(signalLine, "Signal", color = #ff9800, linewidth = 2)
hline(0, "Zero", color = color.new(#b2b5be, 70), linestyle = hline.style_dashed)
`),
  },
  {
    type: 'stochastic', id: 'builtin:stochastic', label: 'Stochastic', group: 'Oscillators', overlay: false,
    params: { k: '%K Length', d: '%D Smoothing' },
    source: SRC(`
//@version=6
indicator("Stochastic", overlay = false)
kLen = input.int(14, "%K Length", minval = 1)
dLen = input.int(3, "%D Smoothing", minval = 1)
k = ta.stoch(close, high, low, kLen)
plot(k, "%K", color = #2962ff, linewidth = 2)
plot(ta.sma(k, dLen), "%D", color = #ff9800, linewidth = 2)
hline(80, "Overbought", color = color.new(#b2b5be, 60), linestyle = hline.style_dashed)
hline(20, "Oversold", color = color.new(#b2b5be, 60), linestyle = hline.style_dashed)
`),
  },
  {
    type: 'stochrsi', id: 'builtin:stochrsi', label: 'Stochastic RSI', group: 'Oscillators', overlay: false,
    params: { length: 'RSI Length', stoch: 'Stoch Length' },
    source: SRC(`
//@version=6
indicator("Stochastic RSI", overlay = false)
rsiLen   = input.int(14, "RSI Length", minval = 1)
stochLen = input.int(14, "Stoch Length", minval = 1)
r = ta.rsi(close, rsiLen)
k = ta.stoch(r, r, r, stochLen)
plot(k, "%K", color = #2962ff, linewidth = 2)
plot(ta.sma(k, 3), "%D", color = #ff9800, linewidth = 2)
hline(80, "Overbought", color = color.new(#b2b5be, 60), linestyle = hline.style_dashed)
hline(20, "Oversold", color = color.new(#b2b5be, 60), linestyle = hline.style_dashed)
`),
  },
  {
    type: 'willr', id: 'builtin:willr', label: 'Williams %R', group: 'Oscillators', overlay: false,
    params: { length: 'Length' },
    source: SRC(`
//@version=6
indicator("Williams %R", overlay = false)
length = input.int(14, "Length", minval = 1)
plot(ta.wpr(length), "Williams %R", color = #ffd54f, linewidth = 2)
hline(-20, "Overbought", color = color.new(#b2b5be, 60), linestyle = hline.style_dashed)
hline(-80, "Oversold", color = color.new(#b2b5be, 60), linestyle = hline.style_dashed)
`),
  },
  {
    type: 'cci', id: 'builtin:cci', label: 'Commodity Channel Index', group: 'Oscillators', overlay: false,
    params: { length: 'Length' },
    source: SRC(`
//@version=6
indicator("Commodity Channel Index", overlay = false)
length = input.int(20, "Length", minval = 1)
plot(ta.cci(hlc3, length), "CCI", color = #2962ff, linewidth = 2)
hline(100, "Overbought", color = color.new(#b2b5be, 60), linestyle = hline.style_dashed)
hline(-100, "Oversold", color = color.new(#b2b5be, 60), linestyle = hline.style_dashed)
`),
  },
  {
    /* TV's Momentum is the price DIFFERENCE (ta.mom), not a ratio. */
    type: 'momentum', id: 'builtin:momentum', label: 'Momentum', group: 'Oscillators', overlay: false,
    params: { length: 'Length' },
    source: SRC(`
//@version=6
indicator("Momentum", overlay = false)
length = input.int(10, "Length", minval = 1)
plot(ta.mom(close, length), "Momentum", color = #2962ff, linewidth = 2)
hline(0, "Zero", color = color.new(#b2b5be, 70), linestyle = hline.style_dashed)
`),
  },
  {
    type: 'roc', id: 'builtin:roc', label: 'Rate of Change', group: 'Oscillators', overlay: false,
    params: { length: 'Length' },
    source: SRC(`
//@version=6
indicator("Rate of Change", overlay = false)
length = input.int(9, "Length", minval = 1)
plot(ta.roc(close, length), "Rate of Change", color = #ff9800, linewidth = 2)
hline(0, "Zero", color = color.new(#b2b5be, 70), linestyle = hline.style_dashed)
`),
  },
  {
    /* TV colors AO by comparison with the PREVIOUS bar (a shrinking positive
       bar is red), which plot() with a per-bar color reproduces exactly. */
    type: 'awesome', id: 'builtin:awesome', label: 'Awesome Oscillator', group: 'Oscillators', overlay: false,
    params: {},
    source: SRC(`
//@version=6
indicator("Awesome Oscillator", overlay = false)
ao = ta.sma(hl2, 5) - ta.sma(hl2, 34)
rising = na(ao[1]) ? true : ao >= ao[1]
plot(ao, "AO", style = plot.style_columns,
     color = rising ? color.new(#26a69a, 50) : color.new(#ef5350, 50))
hline(0, "Zero", color = color.new(#b2b5be, 70), linestyle = hline.style_dashed)
`),
  },

  /* -------------------------------- Volume ----------------------------- */
  {
    /* TV colors volume by the CANDLE direction (close vs open). */
    type: 'volume', id: 'builtin:volume', label: 'Volume', group: 'Volume', overlay: false,
    params: { ma: 'MA Length' },
    source: SRC(`
//@version=6
indicator("Volume", overlay = false)
maLen = input.int(20, "MA Length", minval = 1)
up = close >= open
plot(volume, "Volume", style = plot.style_columns,
     color = up ? color.new(#26a69a, 40) : color.new(#ef5350, 40))
plot(ta.sma(volume, maLen), "Volume MA", color = #2962ff, linewidth = 1)
`),
  },
  {
    type: 'obv', id: 'builtin:obv', label: 'On Balance Volume', group: 'Volume', overlay: false,
    params: {},
    source: SRC(`
//@version=6
indicator("On Balance Volume", overlay = false)
plot(ta.obv, "OBV", color = #2962ff, linewidth = 2)
`),
  },
  {
    type: 'mfi', id: 'builtin:mfi', label: 'Money Flow Index', group: 'Volume', overlay: false,
    params: { length: 'Length' },
    source: SRC(`
//@version=6
indicator("Money Flow Index", overlay = false)
length = input.int(14, "Length", minval = 1)
plot(ta.mfi(hlc3, length), "MFI", color = #ab47bc, linewidth = 2)
hline(80, "Overbought", color = color.new(#b2b5be, 60), linestyle = hline.style_dashed)
hline(20, "Oversold", color = color.new(#b2b5be, 60), linestyle = hline.style_dashed)
`),
  },
  {
    type: 'adline', id: 'builtin:adline', label: 'Accumulation / Distribution', group: 'Volume', overlay: false,
    params: {},
    source: SRC(`
//@version=6
indicator("Accumulation / Distribution", overlay = false)
plot(ta.accdist, "A/D", color = #ff9800, linewidth = 2)
`),
  },

  /* ------------------------------ Volatility --------------------------- */
  {
    type: 'atr', id: 'builtin:atr', label: 'Average True Range', group: 'Volatility', overlay: false,
    params: { length: 'Length' },
    source: SRC(`
//@version=6
indicator("Average True Range", overlay = false)
length = input.int(14, "Length", minval = 1)
plot(ta.atr(length), "ATR", color = #e91e63, linewidth = 2)
`),
  },
  {
    type: 'stddev', id: 'builtin:stddev', label: 'Standard Deviation', group: 'Volatility', overlay: false,
    params: { length: 'Length' },
    source: SRC(`
//@version=6
indicator("Standard Deviation", overlay = false)
length = input.int(20, "Length", minval = 1)
plot(ta.stdev(close, length), "StdDev", color = #00bcd4, linewidth = 2)
`),
  },
];

/** type -> definition (dialog, legacy API, migration) */
export const BUILTIN_BY_TYPE = (() => {
  const m = new Map();
  for (const d of BUILTIN_INDICATORS) m.set(d.type, d);
  return m;
})();

/** scriptId -> definition */
export const BUILTIN_BY_ID = (() => {
  const m = new Map();
  for (const d of BUILTIN_INDICATORS) m.set(d.id, d);
  return m;
})();

/**
 * Migrate a legacy `pane.indicators` record ({type, params}) into Pine
 * `inputs` keyed by input id. `inputDefs` comes from the compiled script, and
 * `params` uses the legacy key names in the definition's `params` map.
 * Unknown keys are dropped rather than guessed.
 */
export function legacyParamsToInputs(def, params, inputDefs) {
  const out = {};
  if (!def || !params || typeof params !== 'object') return out;
  const byTitle = new Map();
  for (const d of inputDefs || []) if (d.title) byTitle.set(d.title, d);
  for (const key of Object.keys(def.params || {})) {
    if (params[key] == null) continue;
    const d = byTitle.get(def.params[key]);
    if (d) out[d.id] = params[key];
  }
  return out;
}
