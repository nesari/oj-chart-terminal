/**
 * test_round166_sar_style.mjs — ROUND166 PSAR kernel + Style-tab engine records.
 *
 * 1. ta.sar was all-na (prevBar never written + /100 on fractions): rewritten
 *    to the Wilder/TV kernel. Pinned bar-by-bar against an independent batch
 *    reference (trend + chop + reversal, early-bar na, custom params).
 * 2. plotcandle records a Style-tab descriptor (title/editable/display).
 * 3. hline records carry titles.
 * 4. drawKindOn defaults (graphic-object master toggles).
 *
 * Run: node scripts/test_round166_sar_style.mjs
 */

import { compile } from '../src/core/pine/compile.js';
import { drawKindOn } from '../src/core/pine/stdlib/objects.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function gen(n, seed, mode) {
  const t0 = 1790600400 - (1790600400 % 900);
  let px = 100, s = seed;
  const bars = [];
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    const o = px;
    let cl;
    if (mode === 'up') cl = o + Math.abs(rnd()) * 1.2 + 0.3;
    else if (mode === 'flip') cl = o + (i < n / 2 ? 0.8 : -0.8) + rnd() * 0.6;
    else cl = o + rnd() * 2.4;
    const w = Math.abs(rnd()) * 0.5 + 0.1;
    bars.push({ time: t0 + i * 900, open: o, high: Math.max(o, cl) + w, low: Math.min(o, cl) - w, close: cl, volume: 10 });
    px = cl;
  }
  return bars;
}

/* independent Wilder SAR reference (no engine) */
function sarRef(bars, st, stp, mx) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < 2) return out;
  let up = bars[1].close >= bars[0].close;
  let ep = up ? bars[1].high : bars[1].low;
  let sar = up ? bars[0].low : bars[0].high;
  let af = st;
  out[1] = sar;
  for (let i = 2; i < bars.length; i++) {
    const b = bars[i], p1 = bars[i - 1], p2 = bars[i - 2];
    let s = sar + af * (ep - sar);
    if (up) {
      s = Math.min(s, p1.low, p2.low);
      if (b.low < s) { up = false; s = ep; ep = b.low; af = st; }
      else if (b.high > ep) { ep = b.high; af = Math.min(af + stp, mx); }
      sar = s;
    } else {
      s = Math.max(s, p1.high, p2.high);
      if (b.high > s) { up = true; s = ep; ep = b.high; af = st; }
      else if (b.low < ep) { ep = b.low; af = Math.min(af + stp, mx); }
      sar = s;
    }
    out[i] = sar;
  }
  return out;
}

{
  const src = `//@version=6
indicator("sar166", overlay=true)
out = ta.sar(0.02, 0.02, 0.2)
out2 = ta.sar(0.05, 0.05, 0.3)
plot(out, title="s")
plot(out2, title="s2")
`;
  const c = compile(src);
  ok(c.ok, 'sar probe compiles');
  if (c.ok) {
    for (const mode of ['up', 'flip', 'chop']) {
      const bars = gen(300, 7, mode);
      const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
      rt.runAll(bars);
      const V = rt.out.plots.get(rt.out.plotsOrder[0]).values;
      const V2 = rt.out.plots.get(rt.out.plotsOrder[1]).values;
      const R = sarRef(bars, 0.02, 0.02, 0.2);
      const R2 = sarRef(bars, 0.05, 0.05, 0.3);
      let bad = 0, bad2 = 0, fin = 0;
      for (let i = 0; i < bars.length; i++) {
        const g = V[i], e = R[i];
        if (e == null) { if (g != null && !(typeof g === 'object')) bad++; continue; }
        fin++;
        if (typeof g !== 'number' || Math.abs(g - e) > 1e-9) bad++;
        const g2 = V2[i], e2 = R2[i];
        if (e2 != null && (typeof g2 !== 'number' || Math.abs(g2 - e2) > 1e-9)) bad2++;
      }
      ok(bad === 0 && fin > 250, mode + ': sar matches reference on 300 bars (diffs=' + bad + ' finite=' + fin + ')');
      ok(bad2 === 0, mode + ': custom params match (diffs=' + bad2 + ')');
    }
    // early bars na
    const bars = gen(10, 7, 'chop');
    const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
    rt.runAll(bars);
    const V = rt.out.plots.get(rt.out.plotsOrder[0]).values;
    ok(V[0] == null || typeof V[0] === 'object', 'bar 0 sar is na');
  }
}

/* plotcandle descriptor + hline titles */
{
  const src = `//@version=5
indicator("cd166", overlay=true)
plotcandle(open, high, low, close, title="MyCandles", color=color.red)
hline(150, title="Cap", color=color.blue)
plot(close, title="c")
`;
  const c = compile(src);
  ok(c.ok, 'candle/hline probe compiles');
  if (c.ok) {
    const bars = gen(50, 3, 'chop');
    const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
    rt.runAll(bars);
    const m = rt.out.candleMeta;
    ok(!!m && m.title === 'MyCandles' && m.editable === true, 'candleMeta recorded (got ' + JSON.stringify(m) + ')');
    ok(rt.out.hlines.length === 1 && rt.out.hlines[0].title === 'Cap', 'hline carries title');
    const someCandles = rt.out.candles.some((r) => !!r);
    ok(someCandles, 'candle records painted per bar');
  }
  const src2 = `//@version=5
indicator("cd2166", overlay=true)
plotcandle(open, high, low, close, editable=false)
plot(close)
`;
  const c2 = compile(src2);
  if (c2.ok) {
    const bars = gen(20, 3, 'chop');
    const rt = c2.createInstance({ tfSec: 900, symbol: 'T' });
    rt.runAll(bars);
    ok(rt.out.candleMeta && rt.out.candleMeta.editable === false && rt.out.candleMeta.title === '',
      'untitled non-editable candleMeta (got ' + JSON.stringify(rt.out.candleMeta) + ')');
  } else ok(false, 'non-editable candle probe compiles');
}

/* drawKindOn */
{
  ok(drawKindOn(null, 'boxes') === true && drawKindOn({}, 'lines') === true, 'no style -> all on');
  ok(drawKindOn({ objects: { boxes: false } }, 'boxes') === false, 'boxes off');
  ok(drawKindOn({ objects: { boxes: false } }, 'lines') === true, 'lines stay on');
  ok(drawKindOn({ objects: { labels: false } }, 'labels') === false, 'labels off');
}

console.log('\nROUND166: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
