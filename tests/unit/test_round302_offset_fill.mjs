/**
 * test_round302_offset_fill.mjs — a fill() over OFFSET plots is coloured on the
 * slot its plots occupy, and the built-in Ichimoku matches TradingView.
 *
 * THE BUG (user report, reproduced with TV's own Ichimoku script):
 *   "the cloud is one colour, the red/green switches are detected wrong, and
 *   the cloud stops at the last candle instead of running 26 bars into the
 *   future".
 *
 *   `plot(series, offset = n)` stores its value at slot bar+n (that is how the
 *   painter finds it), but `fill(p1, p2, color)` wrote its colour at the plain
 *   bar index. For Ichimoku (offset = 25) every bar was coloured with the
 *   span values of a bar 25 slots away, and the whole projected region — the
 *   26 future slots that carry the values — had NO colour at all. The painter
 *   then falls back to "last colour wins", so the cloud read as one colour.
 *
 * This suite pins:
 *   1. a fill's colours live in the same slot space as its plots;
 *   2. forward slots carry their colours too (the projected cloud);
 *   3. the built-in Ichimoku's cloud actually switches colour with the trend;
 *   4. the built-in uses TV's displacement (displacement - 1), not the full
 *      displacement, and the lagging span is close shifted by -(displacement-1).
 *
 * Run: node tests/unit/test_round302_offset_fill.mjs
 */

import { BUILTIN_BY_TYPE } from '../../src/core/pine/builtins-catalog.js';
import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' - ' + JSON.stringify(extra) : '')); }
};

/* a tape with a clear uptrend/downtrend swing so the cloud really flips */
function makeBars(n) {
  const out = [];
  let seed = 11, px = 1.1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  const t0 = 1790600400 - (1790600400 % 3600);
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = o + Math.sin(i / 23) * 0.006 + rnd() * 0.0012;
    const h = Math.max(o, c) + Math.abs(rnd()) * 0.0006;
    const l = Math.min(o, c) - Math.abs(rnd()) * 0.0006;
    out.push({ time: t0 + i * 3600, open: o, high: h, low: l, close: c, volume: 100 + ((i * 29) % 137) });
    px = c;
  }
  return out;
}
const BARS = makeBars(500);
const N = BARS.length;

function run(src) {
  const c = compile(src);
  if (!c.ok) throw new Error(c.errors.map((e) => e.message).join(' | '));
  const rt = c.createInstance({ tfSec: 3600, symbol: 'EURUSD', mintick: 0.00001, serverOffSec: 0 });
  rt.runAll(BARS);
  const byTitle = new Map();
  for (const k of rt.out.plotsOrder) {
    const p = rt.out.plots.get(k);
    if (!p.hiddenHline && p.display !== 'none') byTitle.set(p.title || k, p);
  }
  return { rt, plots: byTitle };
}

/* ---------- 1. colours follow the offset slots ---------- */
console.log('\n[1] a fill over offset plots is coloured in the plots\' own slot space');
{
  const src = `//@version=6
indicator("off", overlay = true)
a = plot(high, "A", offset = 10)
b = plot(low, "B", offset = 10)
fill(a, b, color = close > open ? color.green : color.red, title = "F")
`;
  const { rt, plots } = run(src);
  const fill = (rt.out.fills || [])[0];
  const A = plots.get('A'), B = plots.get('B');
  ok(!!fill, 'the fill exists');
  ok(!!A && !!B && A.offset === 10 && B.offset === 10, 'both plots carry offset = 10', { a: A && A.offset, b: B && B.offset });

  const lastA = A.values.length - 1;
  const lastCol = lastA >= 0 ? fill.colors[lastA] : null;
  ok(!!lastCol && !!lastCol.css, 'the LAST slot has a colour (the projected tail)', lastCol && lastCol.css && lastCol.css());
  /* the pre-fix behaviour: colours filled 0..N-1 and the projected tail had
     nothing, so slot N-1+10 was colourless */
  ok(fill.colors.length > N, 'the colour array reaches into the projected slots',
    { colors: fill.colors.length, bars: N });

  /* every coloured slot must sit on a slot where BOTH plots have a value */
  let mismatched = 0, checked = 0;
  for (let i = 0; i < fill.colors.length; i++) {
    const c = fill.colors[i];
    if (!c) continue;
    checked++;
    if (A.values[i] == null || B.values[i] == null) mismatched++;
  }
  ok(checked > 0 && mismatched === 0, 'no colour sits on a slot the plots do not occupy',
    { checked, mismatched });

  /* the colour must equal the CONDITION of the bar whose values landed here */
  let wrong = 0, sampled = 0;
  for (let i = 0; i + 10 < N; i++) {
    const c = fill.colors[i + 10];
    if (!c || !c.css) continue;
    sampled++;
    const want = BARS[i].close > BARS[i].open ? 'g' : 'r';
    const got = c.g > c.r ? 'g' : 'r';
    if (want !== got) wrong++;
  }
  ok(sampled > 100 && wrong === 0, 'each slot keeps the colour of ITS bar (not one 10 bars away)',
    { sampled, wrong });
}

/* ---------- 2. the built-in Ichimoku cloud flips colour ---------- */
console.log('\n[2] built-in Ichimoku: the cloud switches green/red with the trend');
{
  const def = BUILTIN_BY_TYPE.get('ichimoku');
  ok(!!def, 'the built-in exists');
  const { rt, plots } = run(def.source);
  const A = plots.get('Span A'), B = plots.get('Span B');
  ok(!!A && !!B, 'Span A / Span B plots exist');
  ok(A.offset === 25 && B.offset === 25,
    'spans are plotted at displacement - 1 = 25 (TV), not the full 26',
    { a: A.offset, b: B.offset });

  const fill = (rt.out.fills || [])[0];
  ok(!!fill, 'the cloud is a fill()');
  let green = 0, red = 0, transparent = 0, colored = 0;
  for (const c of fill.colors || []) {
    if (!c) continue;
    colored++;
    if (c.a === 0) transparent++;
    else if (c.g > c.r) green++;
    else if (c.r > c.g) red++;
  }
  ok(green > 20 && red > 20, 'the cloud has BOTH colours (it used to be one)',
    { green, red, colored });
  ok(green + red > colored * 0.9, 'colours are real rgba values, not na', { colored, transparent });

  /* and the colour must match spanA vs spanB on the SAME slot */
  let wrong = 0, sampled = 0;
  for (let i = 0; i < fill.colors.length; i++) {
    const c = fill.colors[i];
    if (!c || c.a === 0) continue;
    const a = A.values[i], b = B.values[i];
    if (a == null || b == null) continue;
    sampled++;
    const wantGreen = a > b;
    const isGreen = c.g > c.r;
    if (wantGreen !== isGreen) wrong++;
  }
  ok(sampled > 100 && wrong === 0, 'every slot is green exactly when Span A is above Span B',
    { sampled, wrong });

  /* forward projection: the last 25 slots are the part TV draws past the
     last candle — they must exist AND carry values + colours */
  let fwdVals = 0, fwdCols = 0;
  for (let i = N; i < Math.max(A.values.length, fill.colors.length); i++) {
    if (A.values[i] != null && B.values[i] != null) fwdVals++;
    if (fill.colors[i]) fwdCols++;
  }
  ok(fwdVals === 25, 'the cloud carries 25 projected slots past the last bar', fwdVals);
  ok(fwdCols === 25, 'those projected slots are coloured (TV draws them forward)', fwdCols);
}

/* ---------- 3. the lagging span sits on close shifted back ---------- */
console.log('\n[3] lagging span = close at -(displacement - 1)');
{
  const def = BUILTIN_BY_TYPE.get('ichimoku');
  const { plots } = run(def.source);
  const lag = plots.get('Lagging Span');
  ok(!!lag, 'the lagging span plot exists');
  ok(lag.offset === -25, 'it is offset by -(displacement - 1) = -25', lag.offset);
  let wrong = 0, sampled = 0;
  for (let i = 0; i < N; i++) {
    const v = lag.values[i];
    if (v == null) continue;
    const src = i + 25; // value at slot i came from bar i+25
    if (src >= N) continue;
    sampled++;
    if (Math.abs(v - BARS[src].close) > 1e-9) wrong++;
  }
  ok(sampled > 100 && wrong === 0, 'slot i holds close of bar i + 25', { sampled, wrong });
}

/* ---------- 4. conversion/base lines are TV's donchian mid ---------- */
console.log('\n[4] conversion and base lines are (highest + lowest) / 2');
{
  const def = BUILTIN_BY_TYPE.get('ichimoku');
  const { plots } = run(def.source);
  const conv = plots.get('Conversion'), base = plots.get('Base');
  const mid = (len, i) => {
    if (i < len - 1) return null;
    let hi = -Infinity, lo = Infinity;
    for (let k = i - len + 1; k <= i; k++) { hi = Math.max(hi, BARS[k].high); lo = Math.min(lo, BARS[k].low); }
    return (hi + lo) / 2;
  };
  let bad = 0;
  for (let i = 20; i < 80; i++) {
    if (Math.abs(conv.values[i] - mid(9, i)) > 1e-9) bad++;
    if (Math.abs(base.values[i] - mid(26, i)) > 1e-9) bad++;
  }
  ok(bad === 0, 'conversion = mid(9), base = mid(26)', { bad });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
