/**
 * test_round298_indicator_parity.mjs — ROUND298 built-in indicator + Pine
 * kernel parity.
 *
 * WHY: a differential audit (native `Indicators.compute` vs the Pine engine
 * running the equivalent script on the same bars) found 10 of 27 built-ins
 * disagreeing with the engine, and 5 of those disagreements were defects on
 * ONE side or the other. Each check below pins one confirmed defect with an
 * independent expectation written here (no engine on the native side, no
 * native on the engine side), so the two implementations can never silently
 * drift apart again.
 *
 * The audit's own numbers are quoted in the assertions so a future reader can
 * see what "wrong" looked like (e.g. Momentum 101.12 vs 0.0123).
 *
 * Run: node tests/unit/test_round298_indicator_parity.mjs
 */

import { Indicators } from '../../src/core/indicators.js';
import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' - ' + JSON.stringify(extra) : '')); }
};

/* deterministic tape with a real trend, wavy swing and varying volume */
function makeBars(n) {
  const out = [];
  let seed = 7, px = 1.1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  const t0 = 1790600400 - (1790600400 % 3600);
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = o + Math.sin(i / 9) * 0.002 + rnd() * 0.0009;
    const h = Math.max(o, c) + Math.abs(rnd()) * 0.0004;
    const l = Math.min(o, c) - Math.abs(rnd()) * 0.0004;
    out.push({ time: t0 + i * 3600, open: o, high: h, low: l, close: c, volume: 100 + ((i * 37) % 211) });
    px = c;
  }
  return out;
}
const BARS = makeBars(400);
const inst = (type, params) => ({ type, params: params || {}, colors: {} });
const native = (type, params) => Indicators.compute(inst(type, params), BARS);
const eq = (a, b) => a.length === b.length &&
  a.every((v, i) => (v == null && b[i] == null) || (v != null && b[i] != null && Math.abs(v - b[i]) < 1e-9));

/* run a Pine script over BARS and return its plots by title */
function pine(src, bars) {
  const c = compile(src);
  if (!c.ok) throw new Error('compile: ' + c.errors.map((e) => e.message).join(' | '));
  const rt = c.createInstance({ tfSec: 3600, symbol: 'EURUSD', mintick: 0.00001, serverOffSec: 0 });
  rt.runAll(bars || BARS);
  const out = new Map();
  for (const k of rt.out.plotsOrder) {
    const p = rt.out.plots.get(k);
    if (!p.hiddenHline) out.set(p.title || k, p);
  }
  return { rt, plots: out };
}
const H = '//@version=6\nindicator("t")\n';

/* ---------- 1. Momentum is a price DIFFERENCE, not a ratio ---------- */
console.log('\n[1] Momentum semantics (TV = close - close[n])');
{
  const got = native('momentum', { length: 10 }).lines[0].values;
  const ref = BARS.map((b, i) => (i >= 10 ? b.close - BARS[i - 10].close : null));
  ok(eq(got, ref), 'Momentum is close - close[10] (was close/close[10]*100)');
  ok(got[10] != null && Math.abs(got[10]) < 0.05,
    'value is a price delta, not a ~101 index', got[10]);
  /* the ratio form still exists under its own name */
  const roc = native('roc', { length: 10 }).lines[0].values;
  ok(roc[10] != null && Math.abs(roc[10]) < 5,
    'Rate of Change keeps the percentage form', roc[10]);
  /* engine agreement */
  const p = pine(H + 'plot(ta.mom(close, 10), "m")');
  ok(eq(got, p.plots.get('m').values), 'native Momentum == ta.mom');
}

/* ---------- 2. A/D includes bar 0 ---------- */
console.log('\n[2] Accumulation/Distribution includes the first bar');
{
  const got = native('adline').lines[0].values;
  const clv = (b) => {
    const r = b.high - b.low;
    return r === 0 ? 0 : ((b.close - b.low) - (b.high - b.close)) / r;
  };
  /* asymmetric bar: close near the high, so bar 0's flow is clearly non-zero */
  const one = [{ time: 1790600400, open: 1.0, high: 1.2, low: 1.0, close: 1.19, volume: 100 }];
  const oneOut = Indicators.compute(inst('adline'), one).lines[0].values;
  ok(Math.abs(oneOut[0] - clv(one[0]) * 100) < 1e-9,
    'bar 0 contributes its own CLV*volume (was a 0 seed)', oneOut[0]);
  ok(Math.abs(oneOut[0]) > 1, 'the first value is not the old zero seed');
  const p = pine(H + 'plot(ta.accdist, "ad")');
  ok(eq(got, p.plots.get('ad').values), 'native A/D == ta.accdist');
}

/* ---------- 3. ta.mfi takes the SOURCE, not volume ---------- */
console.log('\n[3] ta.mfi(series, length) argument meaning');
{
  const mfiNative = native('mfi', { length: 14 }).lines[0].values;
  const p = pine(H + 'plot(ta.mfi(hlc3, 14), "mf")');
  ok(eq(mfiNative, p.plots.get('mf').values),
    'ta.mfi(hlc3,14) == native MFI (was hlc3*hlc3*volume)');
  /* independent reference, written without the engine */
  const tp = BARS.map((b) => (b.high + b.low + b.close) / 3);
  const ref = new Array(BARS.length).fill(null);
  for (let i = 14; i < BARS.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - 13; j <= i; j++) {
      const flow = tp[j] * BARS[j].volume;
      if (tp[j] > tp[j - 1]) pos += flow; else if (tp[j] < tp[j - 1]) neg += flow;
    }
    ref[i] = (pos === 0 && neg === 0) ? null : (neg === 0 ? 100 : 100 - 100 / (1 + pos / neg));
  }
  ok(eq(mfiNative, ref), 'native MFI matches the independent reference');
  ok(Math.abs(mfiNative[27] - 91.2856432075) < 1e-6,
    'reading at index 27 matches the audited correct value (92.77 was wrong)', mfiNative[27]);
}

/* ---------- 4. NA propagation: wma / hma ---------- */
console.log('\n[4] na poisons a window (no fabricated zeros)');
{
  const p = pine(H + 'plot(ta.wma(close, 5), "w")\nplot(ta.hma(close, 21), "h")');
  const w = p.plots.get('w').values, h = p.plots.get('h').values;
  ok(w[3] == null && w[4] != null, 'ta.wma starts at index 4 (length-1)', [w[3], w[4]]);

  /* a source with leading na must not be treated as zero */
  const pna = pine(H + 'src = bar_index < 10 ? na : close\nplot(ta.wma(src, 5), "w")');
  const wna = pna.plots.get('w').values;
  let fakeZero = false;
  for (let i = 0; i < 14; i++) if (wna[i] != null && wna[i] === 0) fakeZero = true;
  ok(!fakeZero, 'na inside a wma window yields na, never 0');

  const hmaNative = native('hma', { length: 21 }).lines[0].values;
  ok(eq(hmaNative, h), 'native HMA == ta.hma');
  ok(hmaNative[4] == null, 'HMA no longer paints a fake 0 line before warm-up', hmaNative[4]);
  ok(hmaNative[23] == null && hmaNative[24] != null,
    'HMA first real value at index 24', [hmaNative[23], hmaNative[24]]);
  ok(hmaNative.every((v) => v == null || v !== 0),
    'HMA never reports an exact 0.0 (the old fake-zero signature)');
}

/* ---------- 5. zero-range oscillators are NA, not 50 / -50 ---------- */
console.log('\n[5] zero-range oscillators report na');
{
  const flat = BARS.map((b) => ({ time: b.time, open: 100, high: 100, low: 100, close: 100, volume: b.volume }));
  for (const [type, params, old] of [['stochastic', { k: 14, d: 3 }, 50], ['willr', { length: 14 }, -50]]) {
    const v = Indicators.compute(inst(type, params), flat).lines[0].values;
    ok(v.every((x) => x == null), type + ': flat tape -> all null (was ' + old + ')',
      v.filter((x) => x != null).slice(0, 3));
  }
  const p = pine(H + 'plot(ta.stoch(close, high, low, 14), "k")\nplot(ta.wpr(14), "wr")', flat);
  ok(p.plots.get('k').values.every((x) => x == null), 'ta.stoch flat -> na');
  ok(p.plots.get('wr').values.every((x) => x == null), 'ta.wpr flat -> na');

  /* StochRSI must wait for a FULL rsi+stoch warm-up, never report 50 */
  const sr = native('stochrsi', { length: 14, stoch: 14 }).lines[0].values;
  ok(sr.slice(0, 27).every((x) => x == null),
    'StochRSI is blank until the full window exists (was 50 from index 14)',
    sr.slice(0, 27).filter((x) => x != null).length);
  ok(sr[27] != null, 'StochRSI starts producing at index 27', sr[27]);
  const fifty = sr.slice(0, 27).filter((x) => x === 50).length;
  ok(fifty === 0, 'no 50 placeholder in the warm-up region', fifty);
  const psr = pine(H + 'r = ta.rsi(close,14)\nplot(ta.stoch(r,r,r,14), "k")');
  ok(eq(sr, psr.plots.get('k').values), 'native StochRSI == engine ta.stoch over ta.rsi');
}

/* ---------- 6. bare ta.vwap is a series, not a function object ---------- */
console.log('\n[6] bare ta.vwap reads a value');
{
  const p = pine(H + 'plot(ta.vwap, "vw")');
  const v = p.plots.get('vw').values;
  ok(v.every((x) => x != null && isFinite(x)), 'ta.vwap (no call) plots a number on every bar');
  ok(eq(native('vwap').lines[0].values, v), 'native VWAP == bare ta.vwap');
  /* the call form still works and is identical by default */
  const pc = pine(H + 'plot(ta.vwap(hlc3), "vw")');
  ok(eq(v, pc.plots.get('vw').values), 'bare ta.vwap == ta.vwap(hlc3)');
}

/* ---------- 7. ta.supertrend returns its documented tuple ---------- */
console.log('\n[7] ta.supertrend tuple return');
{
  const p = pine(H + '[st, dir] = ta.supertrend(3, 10)\nplot(st, "st")\nplot(dir, "dir")');
  const dir = p.plots.get('dir').values, st = p.plots.get('st').values;
  const dirVals = dir.filter((v) => v != null);
  ok(dirVals.length > 0, 'destructured direction is populated (was na on every bar)');
  ok(dirVals.every((v) => v === 1 || v === -1), 'direction is only ever +1 / -1', dirVals.slice(0, 5));
  ok(dirVals.includes(1) && dirVals.includes(-1), 'both directions occur on a two-sided tape');
  /* -1 = uptrend (line below price), +1 = downtrend */
  let consistent = true;
  for (let i = 0; i < BARS.length; i++) {
    if (dir[i] == null || st[i] == null) continue;
    if (dir[i] === -1 && !(st[i] <= BARS[i].close + 1e-9)) consistent = false;
    if (dir[i] === 1 && !(st[i] >= BARS[i].close - 1e-9)) consistent = false;
  }
  ok(consistent, '-1 = uptrend (line below price), +1 = downtrend (line above)');
  /* the line still matches the built-in indicator */
  const nat = native('supertrend', { length: 10, mult: 3 });
  const merged = nat.lines[0].values.map((v, i) => (v != null ? v : nat.lines[1].values[i]));
  ok(eq(merged, st), 'engine supertrend line == native indicator');
}

/* ---------- 8. Parabolic SAR is bounded and starts at bar 1 ---------- */
console.log('\n[8] Parabolic SAR');
{
  const d = native('sar', { start: 2, inc: 2, max: 20 });
  const dots = d.lines[0].values.map((v, i) => (v != null ? v : d.lines[1].values[i]));
  const up = d.lines[0].values;
  ok(dots[0] == null, 'index 0 is blank (needs a prior bar)');
  ok(dots[1] != null, 'first dot at index 1', dots[1]);

  /* uptrend dots must never sit above the LOW of the two prior bars */
  let violated = 0;
  for (let i = 2; i < BARS.length; i++) {
    if (up[i] == null) continue;
    const bound = Math.min(BARS[i - 1].low, BARS[i - 2].low);
    if (up[i] > bound + 1e-12) violated++;
  }
  ok(violated === 0, 'uptrend dots stay <= min(prior two lows) (TV clamp)', violated);

  const p = pine(H + 'plot(ta.sar(0.02,0.02,0.2), "s")');
  ok(eq(dots, p.plots.get('s').values), 'native SAR == ta.sar(0.02,0.02,0.2)');
}

/* ---------- 9. histogram coloring metadata ---------- */
console.log('\n[9] histogram color modes');
{
  const macd = native('macd');
  ok(macd.hist.colorMode === 'sign', 'MACD histogram is colored by SIGN vs zero', macd.hist.colorMode);
  const ao = native('awesome');
  ok(ao.hist.colorMode === 'prev', 'Awesome Oscillator compares with the previous bar', ao.hist.colorMode);
  const vol = native('volume', { ma: 20 });
  ok(vol.hist.colorMode === 'explicit', 'Volume colors by candle direction', vol.hist.colorMode);
  ok(Array.isArray(vol.hist.colors) && vol.hist.colors.length === BARS.length,
    'Volume supplies one color per bar');
  const up = vol.hist.colors.filter((c, i) => c === vol.hist.colorUp).length;
  ok(up > 0 && up < BARS.length, 'both up and down candle colors appear', up);
  /* MACD hist sign coloring actually separates positives and negatives */
  const h = macd.hist.values;
  ok(h.some((v) => v > 0) && h.some((v) => v < 0), 'MACD histogram has both signs to color');
}

/* ---------- 10. band fill metadata for the channel indicators ---------- */
console.log('\n[10] channel band fill');
{
  for (const [type, params] of [
    ['bollinger', { length: 20, mult: 2 }],
    ['donchian', { length: 20 }],
    ['keltner', { length: 20, mult: 2 }],
  ]) {
    const out = Indicators.compute(inst(type, params), BARS);
    ok(!!(out.band && out.band.upper && out.band.lower),
      type + ': compute() exposes band.upper/lower for the fill painter');
    ok(typeof out.band.fill === 'string' && out.band.fill.length > 0,
      type + ': band carries a fill color', out.band.fill);
    ok(out.band.upper.length === BARS.length && out.band.lower.length === BARS.length,
      type + ': band arrays are bar-aligned');
  }
}

console.log('\nROUND298: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
