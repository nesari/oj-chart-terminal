/**
 * test_round197_intdiv.mjs — ROUND197 legacy integer division (TV parity).
 *
 * v3–v5 `int / int` truncates toward zero (7/2=3, -7/2=-3); v6 always
 * floats. Static int-typing (inttype.js) stamps truncating `/` nodes —
 * conservative: unknown stays float (today's behaviour).
 *
 * Run: node scripts/test_round197_intdiv.mjs
 */

import { compile } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};
const near = (a, b) => (a == null && b == null) || Math.abs(a - b) < 1e-9;

function bars(n) {
  const t0 = 1790600400 - (1790600400 % 900);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 100 + i;
    out.push({ time: t0 + i * 900, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 });
  }
  return out;
}
const BARS = bars(10);

function runIt(src, opts) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 1 }, opts || {}));
    rt.runAll(BARS);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
function plotVals(r, idx) {
  if (r.error) return null;
  const key = r.rt.out.plotsOrder[idx || 0];
  return r.rt.out.plots.get(key).values.slice();
}
const V5 = (body) => `//@version=5\nindicator("T", overlay=true)\n` + body;
const V6 = (body) => `//@version=6\nindicator("T", overlay=true)\n` + body;

/* core: legacy truncates, v6 floats */
{
  const r = runIt(V5('plot(7 / 2)\nplot(-7 / 2)\n'));
  ok(!r.error, 'v5 literals run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(plotVals(r, 0)[9] === 3, 'v5 7/2=3');
    ok(plotVals(r, 1)[9] === -3, 'v5 -7/2=-3 (trunc toward zero)');
  }
  const r6 = runIt(V6('plot(7 / 2)\n'));
  ok(!r6.error && near(plotVals(r6, 0)[9], 3.5), 'v6 7/2=3.5 (unchanged)');
  const r0 = runIt('indicator("T")\nplot(7 / 2)\n');
  ok(!r0.error && plotVals(r0, 0)[9] === 3, 'headerless (default v5) truncates');
  const r4 = runIt('//@version=4\nstudy("S", overlay=true)\nplot(7 / 2)\n');
  ok(!r4.error && plotVals(r4, 0)[9] === 3, 'v4 study() truncates');
}
/* float operands never truncate */
{
  const r = runIt(V5('plot(7.0 / 2)\nplot(7 / 2.0)\nplot(7.5 / 2)\n'));
  ok(!r.error, 'float literals run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(near(plotVals(r, 0)[9], 3.5), '7.0/2 stays float');
    ok(near(plotVals(r, 1)[9], 3.5), '7/2.0 stays float');
    ok(near(plotVals(r, 2)[9], 3.75), '7.5/2 stays float');
  }
}
/* variables: declared type flows */
{
  const r = runIt(V5('n = 7\nm = 7.5\nplot(n / 2)\nplot(m / 2)\n'));
  ok(!r.error, 'var div runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(plotVals(r, 0)[9] === 3, 'int var truncates');
    ok(near(plotVals(r, 1)[9], 3.75), 'float var floats');
  }
  const r2 = runIt(V5('int n = 9\nplot(n / 2)\n'));
  ok(!r2.error && plotVals(r2, 0)[9] === 4, 'int-annotated decl truncates');
  const r3 = runIt(V5('n = 7\nn := 7.5\nplot(n / 2)\n'));
  ok(!r3.error && near(plotVals(r3, 0)[9], 3.75), 'float reassignment turns off truncation');
  const r4 = runIt(V5('n = 7\nn /= 2\nplot(n)\n'));
  ok(!r4.error && plotVals(r4, 0)[9] === 3, '/= truncates on int var');
  const r5 = runIt(V5('n = 7.0\nn /= 2\nplot(n)\n'));
  ok(!r5.error && near(plotVals(r5, 0)[9], 3.5), '/= floats on float var');
}
/* arithmetic chains keep int-ness */
{
  const r = runIt(V5('plot((8 + 2) / 4)\nplot((7 % 3) / 2)\nplot(-(7 / 2))\n'));
  ok(!r.error, 'chains run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(plotVals(r, 0)[9] === 2, '(8+2)/4=2');
    ok(plotVals(r, 1)[9] === 0, '(7%3)/2=0 legacy (v6 gives 0.5)');
    ok(plotVals(r, 2)[9] === -3, 'unary minus preserves truncation');
  }
  const r6 = runIt(V6('plot((7 % 3) / 2)\n'));
  ok(!r6.error && near(plotVals(r6, 0)[9], 0.5), 'v6 chain floats');
}
/* builtins: input.int, bar_index, array.size, history */
{
  const r = runIt(V5('len = input.int(7, "L")\nplot(len / 2)\n'));
  ok(!r.error && plotVals(r, 0)[9] === 3, 'input.int truncates');
  const r2 = runIt(V5('plot(bar_index / 2)\n'));
  ok(!r2.error && plotVals(r2, 0)[5] === 2 && plotVals(r2, 0)[6] === 3, 'bar_index truncates per bar');
  const r3 = runIt(V5('a = array.new_int(5, 1)\nplot(array.size(a) / 2)\n'));
  ok(!r3.error && plotVals(r3, 0)[9] === 2, 'array.size truncates');
  const r4 = runIt(V5('n = 7\nplot(n[1] / 2)\n'));
  ok(!r4.error && plotVals(r4, 0)[9] === 3, 'history of int stays int');
  const r5 = runIt(V5('plot(close / 2)\n'));
  ok(!r5.error && near(plotVals(r5, 0)[9], (100 + 9 + 1) / 2), 'float series never truncates');
}
/* functions: int params truncate, unknown stays float (documented) */
{
  const r = runIt(V5('f(int x) => x / 2\nplot(f(7))\n'));
  ok(!r.error && plotVals(r, 0)[9] === 3, 'int param truncates');
  const r2 = runIt(V5('f(x) => x / 2\nplot(f(7))\n'));
  ok(!r2.error && near(plotVals(r2, 0)[9], 3.5), 'untyped param stays float (documented miss)');
  const r3 = runIt(V5('f() => 7\nplot(f() / 2)\n'));
  ok(!r3.error && near(plotVals(r3, 0)[9], 3.5), 'unknown call type stays float (documented miss)');
}
/* branches: int-only ternaries truncate */
{
  const r = runIt(V5('x = (1 == 1 ? 7 : 8)\nplot(x / 2)\n'));
  ok(!r.error && plotVals(r, 0)[9] === 3, 'int ternary truncates');
  const r2 = runIt(V5('x = (1 == 1 ? 7 : 8.5)\nplot(x / 2)\n'));
  ok(!r2.error && near(plotVals(r2, 0)[9], 3.5), 'mixed ternary floats');
}
/* % and div-by-zero keep prior semantics */
{
  const r = runIt(V5('plot(7 % 2)\nplot(-7 % 2)\n'));
  ok(!r.error && plotVals(r, 0)[9] === 1 && plotVals(r, 1)[9] === -1, '% untouched (1, -1)');
  const r2 = runIt(V5('plot(7 / 0)\n'));
  ok(!r2.error && plotVals(r2, 0)[9] == null, 'div-by-zero is na');
}
/* library units get the same treatment */
{
  const lib = `//@version=5
library("DivLib")
export half(int x) => x / 2
`;
  const src = V5('import Me/DivLib/1 as D\nplot(D.half(7))\n');
  const c = compile(src, { libraries: { DivLib: lib } });
  let okRun = false;
  if (c.ok) {
    try {
      const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
      rt.runAll(BARS);
      okRun = rt.out.plots.get(rt.out.plotsOrder[0]).values[9] === 3;
    } catch (e) { okRun = false; }
  }
  ok(c.ok && okRun, 'v5 library int-div truncates through the boundary');
}

console.log('\nROUND197: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
