/**
 * test_round152_varip.mjs — ROUND152 real varip + v6 bool gate + version threading
 *
 * Run: node scripts/test_round152_varip.mjs
 *
 * 1) //@version=N threads parser -> meta -> runtime (house default 5).
 * 2) varip survives the forming-bar rollback (per-tick accumulation);
 *    plain var rolls back to the confirmed snapshot. Discriminator: after
 *    runAll + 2x updateForming on the same bars, varip == N+2, var == N.
 * 3) v6 bool strictness: int/float/string in if/?:/and/or/not/while/bare-switch
 *    throws with a migration hint; na and bool pass; pre-v6 stays loose.
 */

import { compile } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function makeBars(n) {
  const bars = [];
  const t0 = 1790600400 - (1790600400 % 900);
  let px = 100;
  for (let i = 0; i < n; i++) {
    const o = px, cl = o + (i % 2 === 0 ? 1 : -1);
    bars.push({ time: t0 + i * 900, open: o, high: Math.max(o, cl) + 0.3,
      low: Math.min(o, cl) - 0.3, close: cl, volume: 10 });
    px = cl;
  }
  return bars;
}

/* 1) version threading */
{
  const v6 = compile('//@version=6\nindicator("a", overlay=true)\nplot(close, title="c")');
  ok(v6.ok && v6.meta.version === 6, 'v6 header -> meta.version 6 (got ' + (v6.meta && v6.meta.version) + ')');
  const rt6 = v6.createInstance({ tfSec: 900, symbol: 'T' });
  ok(rt6.version === 6, 'runtime carries version 6 (got ' + rt6.version + ')');
  const noH = compile('indicator("b", overlay=true)\nplot(close, title="c")');
  ok(noH.ok && noH.meta.version === 5 && noH.createInstance({}).version === 5, 'no header -> house default 5');
  const bad = compile('//@version=9\nindicator("c", overlay=true)\nplot(close, title="c")');
  ok(bad.ok && bad.meta.version === 5, 'out-of-range header clamps to 5');
  const v4 = compile('//@version=4\nstudy("d", overlay=true)\nplot(close, title="c")');
  ok(v4.meta && v4.meta.version === 4, 'v4 header threads (got ' + (v4.meta && v4.meta.version) + ')');
}

/* 2) varip vs var across tick re-runs */
{
  const src = '//@version=6\nindicator("t", overlay=true)\n'
    + 'varip tip = 0\nvar v = 0\ntip := tip + 1\nv := v + 1\n'
    + 'plot(tip, title="tip")\nplot(v, title="v")';
  const c = compile(src);
  ok(c.ok, 'varip script compiles');
  const bars = makeBars(10);
  const rt = c.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 0 });
  rt.runAll(bars);
  const val = (t) => rt.out.plots.get(rt.out.plotsOrder.find((k) => rt.out.plots.get(k).title === t)).values[9];
  ok(val('tip') === 10 && val('v') === 10, 'after runAll both are 10 (got ' + val('tip') + '/' + val('v') + ')');
  rt.updateForming(bars);
  rt.updateForming(bars);
  ok(val('tip') === 12, 'varip accumulates across ticks (got ' + val('tip') + ', want 12)');
  ok(val('v') === 10, 'plain var rolls back to confirmed (got ' + val('v') + ', want 10)');
}

/* 3) v6 bool gate */
function throwsV6(src, label) {
  const c = compile('//@version=6\nindicator("g", overlay=true)\n' + src);
  if (!c.ok) { ok(false, label + ' (compile failed)'); return; }
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
    rt.runAll(makeBars(5));
    ok(false, label + ' (no throw)');
  } catch (e) {
    ok(/bool/.test(String((e && e.message) || e)), label + ' (-> ' + String((e && e.message) || e).slice(0, 80) + ')');
  }
}
function runsFine(src, label, version) {
  const c = compile((version ? '//@version=' + version + '\n' : '') + 'indicator("g", overlay=true)\n' + src);
  if (!c.ok) { ok(false, label + ' (compile failed)'); return; }
  try {
    c.createInstance({ tfSec: 900, symbol: 'T' }).runAll(makeBars(5));
    ok(true, label);
  } catch (e) {
    ok(false, label + ' (threw ' + String((e && e.message) || e).slice(0, 80) + ')');
  }
}
throwsV6('x = 0\nif x\n    x := 1\nplot(x, title="x")', 'v6: if <int> throws');
runsFine('plot(1 == 1 ? close : open, title="a")\nplot(close > open ? 1 : 0, title="b")\ny = 1\ny := 2\nplot(y > 1 ? 1 : 0, title="c")', 'v6: sane bools pass (control)', 6);
runsFine('x = 0\nif x\n    x := 1\nplot(x, title="x")', 'v5: if <int> stays loose', 5);
runsFine('x = 0\nif x\n    x := 1\nplot(x, title="x")', 'default (v5): if <int> stays loose');
throwsV6('a = 1 and true\nplot(a ? 1 : 0, title="a")', 'v6: <int> and <bool> throws');
throwsV6('a = true and 2\nplot(close, title="c")', 'v6: <bool> and <int> throws');
throwsV6('a = not 0\nplot(close, title="c")', 'v6: not <int> throws');
runsFine('i = 0\nwhile i < 1\n    i := 5\nplot(close, title="c")', 'v6: while <comparison> passes (control bool)', 6);
runsFine('a = true and close > open\nplot(close, title="c")', 'v6: bool and/or runs', 6);
runsFine('x = na(close[100])\nif x\n    x := 1\nplot(na(x) ? 0 : 1, title="x")', 'v6: na condition passes (falsy)', 6);
throwsV6('s = "a"\nif s\n    s := "b"\nplot(close, title="c")', 'v6: if <string> throws');

console.log('\nROUND152: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
