/**
 * test_round195_library.mjs — ROUND195 library/import (TV parity, local store).
 *
 * Dual-runtime model: calls + var reads, per-call-site series isolation,
 * nested libs, loud misconfigurations, library-mode gates, rollback parity.
 * Pure (inline `libraries` map — no store needed).
 *
 * Run: node tests/unit/test_round195_library.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

function bars(n) {
  const t0 = 1790600400 - (1790600400 % 900);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 100 + i;
    out.push({ time: t0 + i * 900, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 });
  }
  return out;
}
const BARS = bars(30);
const CLOSE = BARS.map((b) => b.close);
const sma = (arr, i, len) => {
  if (i < len - 1) return NaN;
  let s = 0;
  for (let k = i - len + 1; k <= i; k++) s += arr[k];
  return s / len;
};

function runIt(src, libs, opts) {
  const c = compile(src, { libraries: libs || {} });
  if (!c.ok) return { c, error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 220) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 1 }, opts || {}));
    rt.runAll(BARS);
    return { c, rt };
  } catch (e) { return { c, error: 'run: ' + String((e && e.message) || e).slice(0, 220) }; }
}
function plotVals(r, idx) {
  if (r.error) return null;
  const key = r.rt.out.plotsOrder[idx || 0];
  return r.rt.out.plots.get(key).values.slice();
}

const LIB = `//@version=5
library("MyLib")
export add(a, b) => a + b
export K = 41
`;
const HEAD = (imp) => `//@version=5
indicator("T", overlay=true)
${imp}
`;

/* 1. basic call + const read */
{
  const r = runIt(HEAD('import Me/MyLib/1 as M') + 'v = M.add(close, 1)\nplot(v)\nplot(M.K)\n', { MyLib: LIB });
  ok(!r.error, 'basic runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const v = plotVals(r, 0), k = plotVals(r, 1);
    ok(v[0] === CLOSE[0] + 1 && v[29] === CLOSE[29] + 1, 'lib fn values follow bars');
    ok(k.every((x) => x === 41), 'exported const reads 41 every bar');
  }
}
/* 2-3. default namespace + version advisory */
{
  const r = runIt(HEAD('import Me/MyLib/9') + 'plot(MyLib.add(1, 2))\n', { MyLib: LIB });
  ok(!r.error, 'no-alias namespace = lib segment' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) ok(plotVals(r, 0).every((x) => x === 3), 'version segment ignored, call works');
}
/* 4. library top-level series visible inside exported fns */
{
  const lib = `//@version=5
library("TopLib")
base = ta.sma(close, 3)
export f(x) => x + base
`;
  const r = runIt(HEAD('import Me/TopLib/1 as T') + 'plot(T.f(close))\n', { TopLib: lib });
  ok(!r.error, 'lib top-level series runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const v = plotVals(r, 0);
    ok(near(v[2], CLOSE[2] + sma(CLOSE, 2, 3)) && near(v[29], CLOSE[29] + sma(CLOSE, 29, 3)), 'lib sma(3) correct at bars 2,29');
  }
}
/* 5. per-call-site series isolation inside the library */
{
  const lib = `//@version=5
library("IsoLib")
export m(x, len) => ta.sma(x, len)
`;
  const r = runIt(HEAD('import Me/IsoLib/1 as I') + 'a = I.m(close, 2)\nb = I.m(close, 4)\nplot(a)\nplot(b)\n', { IsoLib: lib });
  ok(!r.error, 'two lib call sites run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const a = plotVals(r, 0), b = plotVals(r, 1);
    ok(near(a[29], sma(CLOSE, 29, 2)) && near(b[29], sma(CLOSE, 29, 4)) && !near(a[29], b[29]), 'sites isolated (2 vs 4)');
  }
}
/* 6. exported series var + history on top */
{
  const lib = `//@version=5
library("VarLib")
export c = close
`;
  const r = runIt(HEAD('import Me/VarLib/1 as V') + 'plot(V.c)\nplot(V.c[1])\n', { VarLib: lib });
  ok(!r.error, 'exported series reads run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const now = plotVals(r, 0), prev = plotVals(r, 1);
    ok(now[10] === CLOSE[10] && prev[10] === CLOSE[9], 'V.c now + [1] history');
  }
}
/* 7. nested library (lib imports lib) */
{
  const libA = `//@version=5
library("LibA")
export two(x) => x * 2
`;
  const libB = `//@version=5
library("LibB")
import Me/LibA/1 as A
export four(x) => A.two(A.two(x))
`;
  const r = runIt(HEAD('import Me/LibB/1 as B') + 'plot(B.four(3))\n', { LibA: libA, LibB: libB });
  ok(!r.error, 'nested lib runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) ok(plotVals(r, 0).every((x) => x === 12), 'LibB->LibA chains to 12');
}
/* 8. unresolvable import names the shelf */
{
  const r = runIt(HEAD('import Me/Nope/1 as N') + 'plot(1)\n', { MyLib: LIB });
  ok(!!r.error && /no matching library/i.test(r.error) && /MyLib/.test(r.error), 'missing lib is loud + lists shelf');
}
/* 9-11. unknown export / kind mismatches */
{
  const r = runIt(HEAD('import Me/MyLib/1 as M') + 'plot(M.nope(1))\n', { MyLib: LIB });
  ok(!!r.error && /Unknown import 'M\.nope'/.test(r.error) && /exports: add, K/.test(r.error), 'unknown export lists exports');
  const r2 = runIt(HEAD('import Me/MyLib/1 as M') + 'plot(M.K(1))\n', { MyLib: LIB });
  ok(!!r2.error && /not a function/.test(r2.error), 'calling a var is loud');
  const r3 = runIt(HEAD('import Me/MyLib/1 as M') + 'plot(M.add)\n', { MyLib: LIB });
  ok(!!r3.error && /call it/.test(r3.error), 'reading a fn as value is loud');
}
/* 12-13. alias collision + reserved alias */
{
  const r = runIt(HEAD('import Me/MyLib/1 as M') + 'M = 5\nplot(M)\n', { MyLib: LIB });
  ok(!!r.error && /already declared/.test(r.error), 'alias collision is a compile error');
  const r2 = runIt(HEAD('import Me/MyLib/1 as ta') + 'plot(1)\n', { MyLib: LIB });
  ok(!!r2.error && /reserved/.test(r2.error), 'reserved alias rejected');
}
/* 14-16. export outside library / v4 / nested import */
{
  const r = runIt(`//@version=5
indicator("T")
export f(x) => x
plot(1)
`, {});
  ok(!!r.error && /only allowed in library/.test(r.error), 'export in indicator rejected');
  const r2 = runIt(`//@version=4
indicator("T")
import Me/MyLib/1 as M
plot(M.K)
`, { MyLib: LIB });
  ok(!!r2.error && /version=5/.test(r2.error), 'v4 import rejected');
  const r3 = runIt(HEAD('if true\n    import Me/MyLib/1 as M\nplot(1)\n'), { MyLib: LIB });
  ok(!!r3.error && /global scope/.test(r3.error), 'nested import rejected');
}
/* 17-18. cycles + non-library import */
{
  const libA = `//@version=5
library("LibA")
import Me/LibB/1 as B
export a(x) => B.b(x)
`;
  const libB = `//@version=5
library("LibB")
import Me/LibA/1 as A
export b(x) => A.a(x)
`;
  const r = runIt(HEAD('import Me/LibA/1 as A') + 'plot(1)\n', { LibA: libA, LibB: libB });
  ok(!!r.error && /Circular import/.test(r.error), 'A<->B cycle is loud');
  const ind = `//@version=5
indicator("NotALib")
plot(close)
`;
  const r2 = runIt(HEAD('import Me/NotALib/1 as N') + 'plot(1)\n', { NotALib: ind });
  ok(!!r2.error && /only library\(\)/.test(r2.error), 'indicator import rejected');
}
/* 19-21. library-mode gates */
{
  const mk = (body) => `//@version=5
library("GateLib")
${body}
`;
  const r = runIt(HEAD('import Me/GateLib/1 as G') + 'plot(G.f(close))\n',
    { GateLib: mk('export f(x) => x\nmyP = plot(x)\n') });
  ok(!!r.error && /cannot be used in a library/.test(r.error), 'plot in lib is loud');
  const r2 = runIt(HEAD('import Me/GateLib/1 as G') + 'plot(G.f(close))\n',
    { GateLib: mk('n = input.int(5, "N")\nexport f(x) => x + n\n') });
  ok(!!r2.error && /cannot be used in a library/.test(r2.error), 'input in lib is loud');
  const r3 = runIt(HEAD('import Me/GateLib/1 as G') + 'plot(G.f(close))\n',
    { GateLib: mk('export f(x) => strategy.position_size + x\n') });
  ok(!!r3.error && /cannot be used in a library/.test(r3.error), 'strategy.* in lib is loud');
}
/* 22. rollback parity: forming re-run must not double-advance lib state */
{
  const lib = `//@version=5
library("CntLib")
export n = bar_index
export e(x) => ta.ema(x, 5)
`;
  const r = runIt(HEAD('import Me/CntLib/1 as C') + 'plot(C.n)\nplot(C.e(close))\n', { CntLib: lib });
  ok(!r.error, 'rollback fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const before = [plotVals(r, 0).slice(), plotVals(r, 1).slice()];
    try {
      r.rt.updateForming(BARS);
      const after = [plotVals(r, 0), plotVals(r, 1)];
      const same = before[0].every((v, i) => v === after[0][i]) && before[1].every((v, i) => (v === after[1][i] || (v == null && after[1][i] == null)));
      ok(same, 'updateForming keeps lib-driven plots identical');
    } catch (e) { ok(false, 'updateForming threw: ' + String((e && e.message) || e).slice(0, 120)); }
  }
}
/* 23-24. duplicate alias + non-identifier namespace needs `as` */
{
  const r = runIt(HEAD('import Me/MyLib/1 as M\nimport Me/MyLib/2 as M') + 'plot(1)\n', { MyLib: LIB });
  ok(!!r.error && /Duplicate import alias/.test(r.error), 'duplicate alias rejected');
  const r2 = runIt(HEAD('import Me/123/1') + 'plot(1)\n', { MyLib: LIB });
  ok(!!r2.error && /needs an identifier alias/.test(r2.error), 'numeric namespace needs `as`');
  const r3 = runIt(HEAD('import Me/My Lib/1') + 'plot(1)\n', { MyLib: LIB });
  ok(!!r3.error, 'spaced path fails loud (parse-level)');
}
/* 25. lib top-level steps every bar */
{
  const lib = `//@version=5
library("StepLib")
export s = bar_index * 10
`;
  const r = runIt(HEAD('import Me/StepLib/1 as S') + 'plot(S.s)\n', { StepLib: lib });
  ok(!r.error, 'bar_index lib runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const v = plotVals(r, 0);
    ok(v[0] === 0 && v[29] === 290, 'lib top-level stepped all 30 bars');
  }
}
/* 26-27. named args + defaults across the boundary */
{
  const lib = `//@version=5
library("ArgLib")
export d(a, b=10) => a + b
`;
  const r = runIt(HEAD('import Me/ArgLib/1 as A') + 'x = A.d(a=1, b=2)\ny = A.d(1)\nplot(x)\nplot(y)\n', { ArgLib: lib });
  ok(!r.error, 'named/default args run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) ok(plotVals(r, 0).every((v) => v === 3) && plotVals(r, 1).every((v) => v === 11), 'named=3 default=11');
}
/* 28. dry collectInputs works with imports (no lib inputs) */
{
  const c = compile(HEAD('import Me/MyLib/1 as M') + 'n = input.int(7, "N")\nplot(M.add(n, 1))\n', { libraries: { MyLib: LIB } });
  ok(c.ok, 'importer compiles for dry');
  if (c.ok) {
    const ci = c.collectInputs({ dry: true });
    ok(ci.ok && ci.inputs.length === 1, 'dry pass collects importer input through lib (' + (ci.ok ? ci.inputs.length : JSON.stringify(ci.error).slice(0, 80)) + ')');
  }
}

console.log('\nROUND195: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
