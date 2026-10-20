/**
 * test_round138_pine_render.mjs — ROUND138 Pine render parity (TV)
 *
 * Run: node scripts/test_round138_pine_render.mjs
 *
 * 1) Ident-history parity: during bar N, `x[1]` must be bar N-1's FINAL value
 *    (was: N-2 — every Buy/Sell fired TWICE on adjacent bars).
 *    Covers user vars (x := nz(x[1],0)+1) AND built-ins (close[1]).
 * 2) Supertrend single-fire: on clean synthetic trends each flip emits
 *    exactly ONE Buy / ONE Sell (was: pairs on adjacent bars).
 * 3) mPlot contract: Supertrend's fill-anchor plot (style=circles,
 *    linewidth=0) must parse as linewidth 0 — the render adapter hides
 *    linewidth-0 plots (was: thousands of blue dots over the candles).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compile } from '../src/core/pine/compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ST = readFileSync(join(HERE, 'pine-fixtures', 'sample-Supertrend.pine'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

/* deterministic synthetic bars: 150 up / 150 down / 150 up (M15 stamps) */
function makeBars() {
  const bars = [];
  let px = 4000; const t0 = 1790600000;
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < 450; i++) {
    const drift = i < 150 ? 0.6 : i < 300 ? -0.9 : 0.7;
    const o = px, cl = o + drift + rnd() * 0.4;
    const h = Math.max(o, cl) + Math.abs(rnd()) * 0.5;
    const l = Math.min(o, cl) - Math.abs(rnd()) * 0.5;
    bars.push({ time: t0 + i * 900, open: o, high: h, low: l, close: cl, volume: 100 });
    px = cl;
  }
  return bars;
}

/* 1) user-var history: x := nz(x[1],0)+1 lags bar_index by exactly 1 (the
   bar-0 seed), i.e. plot(x - bar_index) is CONSTANT 1 on every bar */
{
  const c = compile('study("t", overlay=true)\nx = 0\nx := nz(x[1], 0) + 1\nplot(x - bar_index, title="d")');
  ok(c.ok, 'history micro-script compiles');
  const bars = makeBars().slice(0, 60);
  const rt = c.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 0 });
  rt.runAll(bars);
  const vals = rt.out.plots.get(rt.out.plotsOrder[0]).values;
  ok(vals.length === bars.length && vals.every((v) => v === 1), 'x[1] reads N-1 final (diff constant 1, no 2-bar lag)');
}

/* 2) built-in history: close[1][i] === bars[i-1].close, na on bar 0 */
{
  const c = compile('study("t", overlay=true)\nplot(close[1], title="c1")');
  ok(c.ok, 'close[1] script compiles');
  const bars = makeBars().slice(0, 60);
  const rt = c.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 10800 });
  rt.runAll(bars);
  const vals = rt.out.plots.get(rt.out.plotsOrder[0]).values;
  let good = vals[0] == null;
  for (let i = 1; i < bars.length && good; i++) {
    if (Math.abs(vals[i] - bars[i - 1].close) > 1e-9) good = false;
  }
  ok(good, 'close[1] is the previous bar close (offset independent)');
}

/* 3) Supertrend: one Buy + one Sell total, never on adjacent bars */
{
  const c = compile(SRC_ST);
  ok(c.ok, 'Supertrend compiles');
  const bars = makeBars();
  const rt = c.createInstance({ tfSec: 900, symbol: 'XAUUSD', serverOffSec: 10800 });
  rt.runAll(bars);
  const fires = {};
  for (const [, sh] of rt.out.shapes) {
    const idx = [];
    for (let i = 0; i < bars.length; i++) if (sh.ys[i] != null) idx.push(i);
    (fires[sh.style + ':' + (sh.texts[idx[0]] || '')] = idx);
  }
  const buys = fires['labelup:Buy'] || [], sells = fires['labeldown:Sell'] || [];
  const noAdj = (a) => a.every((v, k) => k === 0 || v - a[k - 1] > 1);
  ok(buys.length === 1 && sells.length === 1, 'exactly one Buy and one Sell (got ' + buys.length + '/' + sells.length + ')');
  ok(noAdj(buys) && noAdj(sells), 'no adjacent-bar double-fire ' + JSON.stringify({ buys, sells }));
  /* ROUND147: stacked circle markers removed from the sample — shapes are
     label-only now (no 'circle:' sites at all). */
  ok(!Object.keys(fires).some((k) => k.startsWith('circle:')), 'no circle shapes (label-only signals)');
  /* ROUND146: shapes carry script location + flag for the Style location row */
  let locOk = true, titlesOk = true;
  for (const [, sh] of rt.out.shapes) {
    if (sh.loc !== 'absolute' || sh.hasLoc !== true) locOk = false;
    if (sh.texts.some(Boolean) && !sh.title) titlesOk = false;
  }
  ok(locOk, 'plotshape sites store loc=absolute + hasLoc');
  ok(titlesOk, 'label shapes keep titles for Style rows');
}

/* 4) mPlot anchor contract for the adapter's linewidth-0 invisibility rule */
{
  const c = compile(SRC_ST);
  const bars = makeBars().slice(0, 20);
  const rt = c.createInstance({ tfSec: 900, symbol: 'XAUUSD', serverOffSec: 0 });
  rt.runAll(bars);
  let anchor = null;
  for (const k of rt.out.plotsOrder) {
    const p = rt.out.plots.get(k);
    if (p.style === 'circles' && p.linewidth === 0) anchor = k;
  }
  ok(!!anchor, 'fill-anchor plot present as circles/linewidth-0 (adapter hides it, no blue dots)');
}

/* 5) ROUND142: v4 `input(hl2, "Source")` is a SOURCE input (dropdown),
   not a float constant — def kind/defval/title, per-bar values, override */
{
  const c = compile('study("t", overlay=true)\nsrc = input(hl2, title="Source")\nplot(src, title="s")');
  ok(c.ok, 'v4 source script compiles');
  const ci = c.collectInputs({ tfSec: 900, symbol: 'T' });
  const def = ci.inputs.find((d) => d.title === 'Source');
  ok(!!def && def.kind === 'source' && def.defval === 'hl2', 'source def registers (kind/title/defval)');
  const bars = makeBars().slice(0, 60);
  const rt = c.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 0 });
  rt.runAll(bars);
  const vals = rt.out.plots.get(rt.out.plotsOrder[0]).values;
  ok(vals.every((v, i) => Math.abs(v - (bars[i].high + bars[i].low) / 2) < 1e-9), 'runtime resolves hl2 per bar');
  const rt2 = c.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 0, inputValues: { [def.id]: 'close' } });
  rt2.runAll(bars);
  const vals2 = rt2.out.plots.get(rt2.out.plotsOrder[0]).values;
  ok(vals2.every((v, i) => Math.abs(v - bars[i].close) < 1e-9), 'source override switches series');
}

console.log('\nROUND138: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
