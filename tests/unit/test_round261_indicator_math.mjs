/**
 * ROUND261 - built-in indicator math / parameter hygiene.
 *
 * Pins the defects confirmed by source review:
 *  1. Awesome Oscillator suppressed its FIRST valid value (index 33, when the
 *     34-period SMA gets a full window); the histogram now starts at the same
 *     bar as the reference AO series.
 *  2. MFI counted an UNCHANGED typical price as negative money flow, so a
 *     flat window reported 0 (extreme oversold). Flat bars now feed neither
 *     sum, and a window with no directional flow at all reports NA instead
 *     of a fabricated 0/100.
 *  3. OBV / A-D returned one value for an EMPTY bar array. Output is now
 *     aligned with the input (length 0).
 *  4. Fractional / zero / garbage periods (settings dialog accepts any
 *     number) used to reach the kernels raw: fractional windows indexed
 *     bars[19.5] -> throw -> compute()'s catch returned a blank indicator,
 *     and sma(src, 20.5) divided a 21-value sum by 20.5. Periods are now
 *     rounded and clamped once at the compute() boundary.
 *
 * Run: node tests/unit/test_round261_indicator_math.mjs
 */
import { Indicators } from '../../src/core/indicators.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' - ' + JSON.stringify(extra) : '')); }
};

/* deterministic pseudo-random bars; every 11th close repeats (flat hl2) */
function makeBars(n) {
  const bars = [];
  let seed = 4242, px = 100;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    if (i % 11 === 5) { px = bars[i - 1].close; }
    else px = px + rnd() * 2;
    const o = i ? bars[i - 1].close : px;
    const h = Math.max(o, px) + 0.5;
    const l = Math.min(o, px) - 0.5;
    bars.push({ time: 1790600400 + i * 60, open: o, high: h, low: l, close: px, volume: 10 + (i % 7) });
  }
  return bars;
}
const bars = makeBars(120);
const inst = (type, params) => ({ type, params: params || {}, colors: {} });
const eqClose = (a, b) => a.length === b.length &&
  a.every((v, i) => (v == null && b[i] == null) || (v != null && b[i] != null && Math.abs(v - b[i]) < 1e-9));

/* ---------- independent batch references ---------- */
function smaRef(src, len) {
  const out = new Array(src.length).fill(null);
  for (let i = len - 1; i < src.length; i++) {
    let s = 0, bad = false;
    for (let j = 0; j < len; j++) { const v = src[i - j]; if (v == null) { bad = true; break; } s += v; }
    if (!bad) out[i] = s / len;
  }
  return out;
}
function mfiRef(list, len) {
  const tp = list.map((b) => (b.high + b.low + b.close) / 3);
  const out = new Array(list.length).fill(null);
  for (let i = len; i < list.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - len + 1; j <= i; j++) {
      const flow = tp[j] * list[j].volume;
      if (tp[j] > tp[j - 1]) pos += flow;
      else if (tp[j] < tp[j - 1]) neg += flow;
    }
    if (pos === 0 && neg === 0) out[i] = null;
    else out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

/* ---------- 1. Awesome Oscillator ---------- */
console.log('\n[1] Awesome Oscillator');
{
  const ao = Indicators.compute(inst('awesome'), bars).hist.values;
  const hl2 = bars.map((b) => (b.high + b.low) / 2);
  const fast = smaRef(hl2, 5), slow = smaRef(hl2, 34);
  const ref = fast.map((v, i) => (v != null && slow[i] != null ? v - slow[i] : null));
  ok(ao.findIndex((v) => v != null) === 33, 'first AO value is index 33 (bar 34)', ao.findIndex((v) => v != null));
  ok(eqClose(ao, ref), 'every AO histogram value matches SMA(5)-SMA(34)');
}

/* ---------- 2. MFI flat-flow handling ---------- */
console.log('\n[2] Money Flow Index');
{
  const got = Indicators.compute(inst('mfi', { length: 14 }), bars).lines[0].values;
  ok(eqClose(got, mfiRef(bars, 14)), 'MFI matches the ignore-flat reference on a mixed tape');
  ok(got.some((v) => v != null), 'MFI actually produces readings on the fixture');

  const flat = bars.map((b) => ({ time: b.time, open: 100, high: 100, low: 100, close: 100, volume: b.volume }));
  const fv = Indicators.compute(inst('mfi', { length: 14 }), flat).lines[0].values;
  ok(fv.every((v) => v == null), 'a completely flat tape reports NA (not 0)', fv.filter((v) => v != null).slice(0, 3));

  const rising = bars.map((b, i) => ({ time: b.time, open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 5 }));
  const rv = Indicators.compute(inst('mfi', { length: 5 }), rising).lines[0].values;
  ok(rv[5] === 100, 'all-up window is 100', rv[5]);
  const falling = bars.map((b, i) => ({ time: b.time, open: 300 - i, high: 300 - i, low: 300 - i, close: 300 - i, volume: 5 }));
  const dv = Indicators.compute(inst('mfi', { length: 5 }), falling).lines[0].values;
  ok(dv[5] === 0, 'all-down window is 0', dv[5]);
}

/* ---------- 3. empty-history alignment ---------- */
console.log('\n[3] empty history alignment');
{
  for (const type of ['obv', 'adline']) {
    const out = Indicators.compute(inst(type), []);
    ok(out.lines[0].values.length === 0, type + ': zero bars -> zero values', out.lines[0].values);
    const one = Indicators.compute(inst(type), bars.slice(0, 1));
    ok(one.lines[0].values.length === 1 && one.lines[0].values[0] === 0, type + ': one bar -> [0]', one.lines[0].values);
    const many = Indicators.compute(inst(type), bars);
    ok(many.lines[0].values.length === bars.length, type + ': values aligned with bars');
  }
}

/* ---------- 4. integer period normalization ---------- */
console.log('\n[4] period normalization');
{
  const d205 = Indicators.compute(inst('donchian', { length: 20.5 }), bars);
  const d21 = Indicators.compute(inst('donchian', { length: 21 }), bars);
  ok(d205.lines[0].values.some((v) => v != null), 'donchian 20.5 is not silently blank');
  ok(eqClose(d205.lines[0].values, d21.lines[0].values), 'donchian 20.5 runs as 21');

  const s205 = Indicators.compute(inst('sma', { length: 20.5 }), bars).lines[0].values;
  const s21 = Indicators.compute(inst('sma', { length: 21 }), bars).lines[0].values;
  const s20 = Indicators.compute(inst('sma', { length: 20 }), bars).lines[0].values;
  ok(eqClose(s205, s21), 'sma 20.5 runs as 21 (not a 21-value sum / 20.5)');
  ok(!eqClose(s205, s20), 'sma 20.5 is not silently treated as 20');

  const r0 = Indicators.compute(inst('rsi', { length: 0 }), bars).lines[0].values;
  const r1 = Indicators.compute(inst('rsi', { length: 1 }), bars).lines[0].values;
  ok(eqClose(r0, r1), 'rsi 0 clamps to 1');
  ok(r0.some((v) => v != null), 'rsi 0 still produces readings');

  const st = Indicators.compute(inst('stochastic', { k: 14.5, d: 3.4 }), bars);
  const stRef = Indicators.compute(inst('stochastic', { k: 15, d: 3 }), bars);
  ok(eqClose(st.lines[0].values, stRef.lines[0].values), 'stochastic rounds K and D');
  ok(eqClose(st.lines[1].values, stRef.lines[1].values), 'stochastic %D rounds too');

  ok(Indicators.title(inst('donchian', { length: 20.5 })) === 'Donchian Channels (21)',
    'legend title shows the normalized period', Indicators.title(inst('donchian', { length: 20.5 })));

  const bad = Indicators.compute(inst('mfi', { length: 'oops' }), bars).lines[0].values;
  const def = Indicators.compute(inst('mfi', {}), bars).lines[0].values;
  ok(eqClose(bad, def), 'non-numeric period falls back to the definition default');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
