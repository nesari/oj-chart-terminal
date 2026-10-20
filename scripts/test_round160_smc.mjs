/**
 * test_round160_smc.mjs — ROUND160 SMC correctness (HTF tape + var slots + points)
 *
 * Run: node scripts/test_round160_smc.mjs
 *
 * Three class-A fixes behind LuxAlgo SMC parity:
 * 1) HTF bucket tape: builtin history inside request.security() reads the
 *    HTF frame (close[1] = previous HTF close, not chart close).
 * 2) Persistent `var` in transient scopes: `var label x = label.new(...)`
 *    inside a function initializes ONCE (was: a new object per bar — 500-cap
 *    churn with hundreds of duplicate labels on 300 bars).
 * 3) chart.point call form: label.new(point, text, ...) maps text/colors
 *    correctly (was: text read the xloc enum -> "[object Object]").
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compile } from '../src/core/pine/compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function makeBars(n, step) {
  const bars = [];
  const t0 = 1790600400 - (1790600400 % 900);
  let px = 4000, seed = 5;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    const o = px, cl = o + Math.sin(i / 11) * 8 + rnd() * 3;
    bars.push({ time: t0 + i * (step || 900), open: o, high: Math.max(o, cl) + 2,
      low: Math.min(o, cl) - 2, close: cl, volume: 100 });
    px = cl;
  }
  return bars;
}

/* 1) HTF bucket tape over two H1 buckets (4 M15 bars each) */
{
  const T0 = 1790600400 - (1790600400 % 3600);
  const bars = [];
  for (let i = 0; i < 8; i++) {
    const base = i < 4 ? 100 : 500;
    const o = base + i, cl = o + 1;
    bars.push({ time: T0 + i * 900, open: o, high: cl + 0.5, low: o - 0.5, close: cl, volume: 10 });
  }
  const run = (expr) => {
    const c = compile('//@version=6\nindicator("s", overlay=true)\nplot(' + expr + ', title="v")');
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 0 });
    rt.runAll(bars);
    return rt.out.plots.get(rt.out.plotsOrder[0]).values;
  };
  // bar 5 sits in bucket[4-7]; repaint-free rule shows bucket[0-3] (close 104)
  ok(run('request.security(syminfo.tickerid, "60", close[1])')[5] === 104, 'HTF close[1] = previous HTF close (104, not chart 505)');
  ok(run('request.security(syminfo.tickerid, "60", close[1])')[1] == null, 'HTF close[1] na before anything closed');
  ok(run('request.security(syminfo.tickerid, "60", hl2[1])')[5] === 102, 'HTF hl2[1] on the committed bucket');
  ok(run('request.security(syminfo.tickerid, "60", close + open)')[5] === 204, 'complex exprs read the aggregate frame');
  // tick idempotence: re-running the forming bar neither duplicates commits nor drifts values
  const c = compile('//@version=6\nindicator("s", overlay=true)\nplot(request.security(syminfo.tickerid, "60", close[1]), title="v")');
  const rt = c.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 0 });
  rt.runAll(bars);
  const before = rt.out.plots.get(rt.out.plotsOrder[0]).values.slice();
  rt.updateForming(bars);
  rt.updateForming(bars);
  const after = rt.out.plots.get(rt.out.plotsOrder[0]).values;
  ok(before.every((v, i) => (v == null && after[i] == null) || v === after[i]), 'tick re-runs leave the tape untouched');
}

/* 2) persistent var in functions + blocks */
{
  const src = '//@version=6\nindicator("t", overlay=true)\n'
    + 'mk() =>\n    var label L = label.new(bar_index, close, text="x")\n    label.set_x(L, bar_index)\n    L\n'
    + 'l = mk()\nplot(bar_index, title="b")';
  const c = compile(src);
  const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
  rt.runAll(makeBars(20));
  ok(rt.store.count('label') === 1, 'function-scope var: one object across 20 bars (got ' + rt.store.count('label') + ')');
  // rollback keeps it one object, value from the re-run
  rt.updateForming(makeBars(20));
  ok(rt.store.count('label') === 1, 'forming re-run does not duplicate function-var objects');
}
{
  const src = '//@version=6\nindicator("t", overlay=true)\n'
    + 'var int m = 0\nif true\n    var int n = 0\n    n := n + 1\n    m := n\nplot(m, title="m")';
  const c = compile(src);
  const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
  rt.runAll(makeBars(10));
  const vals = rt.out.plots.get(rt.out.plotsOrder[0]).values;
  ok(vals[9] === 10, 'block-scope var accumulates across bars (got ' + vals[9] + ')');
}

/* 3) chart.point call form maps every param (text/colors/xloc, not shifted) */
{
  const src = '//@version=6\nindicator("t", overlay=true)\n'
    + 'p = chart.point.new(time, bar_index, close)\n'
    + 'label.new(p, "hello", xloc.bar_time, color=color.red, textcolor=color.white)\n'
    + 'plot(close, title="c")';
  const c = compile(src);
  ok(c.ok, 'point-form label compiles');
  const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
  rt.runAll(makeBars(10));
  const lb = [...rt.store.label.values()][0];
  ok(lb && lb.text === 'hello', 'point-form text lands on text (got ' + JSON.stringify(lb && lb.text) + ')');
  ok(lb && lb.xloc === 'bar_time', 'point-form xloc lands on xloc (got ' + (lb && lb.xloc) + ')');
  ok(lb && lb.color && lb.color.css() === 'rgba(242,54,69,1)', 'point-form color lands on color (TV red)');
  ok(lb && typeof lb.x === 'number' && typeof lb.y === 'number', 'point unpacks to x/y numbers');
}

/* 4) SMC sparsity on 300 synthetic bars (was: 500-cap churn, Weak High x215) */
{
  const src = readFileSync(join(HERE, 'pine-fixtures', 'corpus', 'smartmoney.pine'), 'utf8');
  const c = compile(src);
  ok(c.ok, 'SMC compiles');
  const rt = c.createInstance({ tfSec: 900, symbol: 'XAUUSD', serverOffSec: 0 });
  const t0 = Date.now();
  rt.runAll(makeBars(300));
  const ms = Date.now() - t0;
  const nL = rt.store.count('label'), nN = rt.store.count('line'), nB = rt.store.count('box');
  console.log('    … SMC 300 bars in ' + ms + 'ms (labels ' + nL + ', lines ' + nN + ', boxes ' + nB + ')');
  ok(nL < 100 && nN < 100, 'no object churn (labels ' + nL + ', lines ' + nN + ')');
  let weakHigh = 0, objObj = 0;
  for (const lb of rt.store.label.values()) {
    if (lb.text === 'Weak High') weakHigh++;
    if (/\[object Object\]/.test(String(lb.text))) objObj++;
  }
  ok(weakHigh < 10, 'no per-bar label refire (Weak High x' + weakHigh + ')');
  ok(objObj === 0, 'no [object Object] label texts');
  ok(ms < 30000, 'SMC 300-bar pass within budget');
}

console.log('\nROUND160: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
