/**
 * test_round196_matrix_map.mjs — ROUND196 matrix.* + map.* collections.
 *
 * Creation/typing (generics + shorthands), get/set, structural edits,
 * transpose/reshape/sort, aggregations, for...in, persistence + rollback,
 * and loud misconfigurations. Pure (hand-authored bars).
 *
 * Run: node tests/unit/test_round196_matrix_map.mjs
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
const BARS = bars(10);
const HEAD = `//@version=5
indicator("T", overlay=true)
`;

function runIt(body, opts) {
  const c = compile(HEAD + body);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 240) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 1 }, opts || {}));
    rt.runAll(BARS);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 240) }; }
}
const G = (r, name) => (!r.error && r.rt.globals.get(name) ? r.rt.globals.get(name).value : undefined);
function plotVals(r, idx) {
  if (r.error) return null;
  const key = r.rt.out.plotsOrder[idx || 0];
  return r.rt.out.plots.get(key).values.slice();
}

/* ---- matrix basics ---- */
{
  const r = runIt('m = matrix.new<float>(2, 3, 1.5)\nmatrix.set(m, 1, 2, 9)\nv = matrix.get(m, 1, 2)\nplot(v)\nplot(matrix.rows(m) * 10 + matrix.columns(m))\n');
  ok(!r.error, 'new/get/set/rows/columns' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(plotVals(r, 0)[9] === 9, 'set sticks');
    ok(plotVals(r, 1)[9] === 23, '2 rows 3 cols');
    ok(G(r, 'm').get(0, 0) === 1.5, 'initial fill');
  }
}
{
  const r = runIt('m = matrix.new(2, 2)\nmatrix.set(m, 0, 0, "s")\nplot(1)\n');
  ok(!r.error, 'untyped matrix takes strings');
  const r2 = runIt('m = matrix.new_int(2, 2, 0)\nmatrix.set(m, 0, 0, 4)\nplot(matrix.get(m, 0, 0))\n');
  ok(!r2.error && plotVals(r2, 0)[9] === 4, 'new_int shorthand');
  const r3 = runIt('m = matrix.new<float>(1, 1, 0)\nmatrix.set(m, 0, 0, "s")\nplot(1)\n');
  ok(!!r3.error && /expects a number/.test(r3.error), 'float type violation is loud');
  const r4 = runIt('m = matrix.new<float>(1, 1, 0)\nx = matrix.get(m, 5, 0)\nplot(1)\n');
  ok(!!r4.error && /out of bounds/.test(r4.error), 'oob get is loud');
  const r5 = runIt('m = matrix.new<box>(1, 1)\nplot(1)\n');
  ok(!!r5.error && /not supported/.test(r5.error), 'object matrices stay loud');
  const r6 = runIt('m = matrix.new<float>(-1, 2, 0)\nplot(1)\n');
  ok(!!r6.error && /non-negative/.test(r6.error), 'negative dims rejected');
  const r7 = runIt('matrix<float> m = matrix.new<float>(1, 1, 2)\nplot(m.get(0, 0))\n');
  ok(!r7.error && plotVals(r7, 0)[9] === 2, 'typed decl + method form');
  const r8 = runIt('m = matrix.new<float>(1, 1, 0)\nplot(m.nope())\n');
  ok(!!r8.error && /Unknown matrix method/.test(r8.error), 'unknown method is loud');
  const r9 = runIt('m = matrix.new<float>(1, 1, 0)\nplot(matrix.nope(m))\n');
  ok(!!r9.error && /Unknown function matrix\.nope/.test(r9.error), 'unknown ns fn is loud');
}
/* ---- structural edits (AT-index house rule) ---- */
{
  const r = runIt('m = matrix.new<float>(2, 2, 0)\nmatrix.set(m, 0, 0, 1)\nmatrix.set(m, 1, 1, 2)\n'
    + 'm.add_row(1)\nm.add_col(0)\nr = m.remove_row(0)\nc = m.remove_col(2)\n'
    + 'plot(matrix.rows(m) * 10 + matrix.columns(m))\nplot(r.get(1) * 100 + c.get(0) * 10 + c.get(1))\n');
  ok(!r.error, 'add/remove chain runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    // 2x2 -> add_row -> 3x2 -> add_col -> 3x3 -> remove_row -> 2x3 -> remove_col -> 2x2
    ok(plotVals(r, 0)[9] === 22, 'shape back to 2x2');
    // removed row 0 = [na, 1, 0] (na col inserted at 0); removed col 2 of the rest
    const m = G(r, 'm');
    ok(m.nRows() === 2 && m.nCols() === 2, 'live shape 2x2');
  }
}
{
  const r = runIt('m = matrix.new<float>(2, 3, 0)\nfor i = 0 to 5\n    matrix.set(m, math.floor(i / 3), i % 3, i + 1)\n'
    + 't = m.transpose()\nplot(t.get(2, 1))\nplot(t.rows(m) * 0 + t.rows(t) * 10 + t.columns(t))\n');
  ok(!r.error, 'transpose runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(plotVals(r, 0)[9] === 6, 'transposed cell (2,1)=6');
    ok(plotVals(r, 1)[9] === 32, 'transposed shape 3x2');
  }
  const r2 = runIt('m = matrix.new<float>(2, 3, 1)\nm.reshape(3, 2)\nplot(matrix.rows(m) * 10 + matrix.columns(m))\n');
  ok(!r2.error && plotVals(r2, 0)[9] === 32, 'reshape 2x3->3x2');
  const r3 = runIt('m = matrix.new<float>(2, 3, 1)\nm.reshape(2, 2)\nplot(1)\n');
  ok(!!r3.error && /needs 4 cells/.test(r3.error), 'reshape mismatch is loud');
}
/* ---- sort + aggregations ---- */
{
  const r = runIt('m = matrix.new<float>(3, 2, 0)\nmatrix.set(m, 0, 0, 30)\nmatrix.set(m, 1, 0, 10)\nmatrix.set(m, 2, 0, 20)\n'
    + 's = m.sort(0, order.ascending)\nplot(s.get(0, 0) * 100 + s.get(1, 0) * 10 + s.get(2, 0) + matrix.get(m, 0, 0) * 0.001)\n'
    + 'plot(m.sum() + m.avg() + m.min() + m.max())\n');
  ok(!r.error, 'sort + aggs run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(plotVals(r, 0)[9] === 10 * 100 + 20 * 10 + 30 + 0.03, 'sorted 10/20/30, original untouched');
    ok(near(plotVals(r, 1)[9], 60 + 10 + 0 + 30), 'sum 60 avg 10 min 0 max 30');
  }
  const r2 = runIt('m = matrix.new<float>(0, 0)\nplot(1)\n');
  ok(!r2.error, 'empty matrix ok');
  const r3 = runIt('m = matrix.new<float>(2, 2)\nplot(m.sum())\n');
  ok(!r3.error && (plotVals(r3, 0)[9] == null), 'all-na sum is na');
}
/* ---- fill ranges ---- */
{
  const r = runIt('m = matrix.new<float>(3, 3, 0)\nm.fill(5, 1, 1, 3, 3)\nplot(m.get(0, 0) + m.get(1, 1) + m.get(2, 2))\n');
  ok(!r.error && plotVals(r, 0)[9] === 10, 'ranged fill hits the 2x2 corner only');
}
/* ---- math.* + tostring + forin ---- */
{
  const r = runIt('m = matrix.new<float>(2, 2, 0)\nmatrix.set(m, 0, 0, 4)\nmatrix.set(m, 1, 1, 8)\n'
    + 'plot(math.sum(m) + math.avg(m) + math.min(m) + math.max(m))\n');
  ok(!r.error && near(plotVals(r, 0)[9], 12 + 3 + 0 + 8), 'math.* flatten matrices (sum 12 avg 3 min 0 max 8)');
  const r2 = runIt('m = matrix.new<float>(1, 2, 0)\nmatrix.set(m, 0, 1, 3)\ns = str.tostring(m)\nplot(str.contains(s, "0, 3") ? 1 : 0)\n');
  ok(!r2.error && plotVals(r2, 0)[9] === 1, 'tostring renders rows');
  const r3 = runIt('m = matrix.new<float>(2, 2, 1)\ntot = 0.0\nfor row in m\n    tot := tot + row.sum()\nplot(tot)\n');
  ok(!r3.error && plotVals(r3, 0)[9] === 4, 'forin yields rows');
}
/* ---- persistence + rollback ---- */
{
  const r = runIt('var m = matrix.new<float>(1, 1, 0)\nmatrix.set(m, 0, 0, matrix.get(m, 0, 0) + 1)\nplot(matrix.get(m, 0, 0))\n');
  ok(!r.error, 'var matrix accumulates' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const before = plotVals(r, 0).slice();
    ok(before[9] === 10, 'counter reaches 10');
    try {
      r.rt.updateForming(BARS);
      const after = plotVals(r, 0);
      ok(before.every((v, i) => v === after[i]), 'forming re-run keeps matrix state');
    } catch (e) { ok(false, 'updateForming threw: ' + String((e && e.message) || e).slice(0, 100)); }
  }
}
/* ---- maps ---- */
{
  const r = runIt('map<string, float> m = map.new<string, float>()\nm.put("a", 1.5)\nm.put("b", 2.5)\n'
    + 'plot(m.get("a") + m.get("b") + m.size())\nplot(m.contains("a") ? 10 : 0)\n');
  ok(!r.error, 'typed map put/get/contains/size' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(near(plotVals(r, 0)[9], 6), '1.5+2.5+size2');
    ok(plotVals(r, 1)[9] === 10, 'contains true');
  }
  const r2 = runIt('m = map.new<string, float>()\nplot(m.get("zz"))\n');
  ok(!r2.error && plotVals(r2, 0)[9] == null, 'missing key is na');
  const r3 = runIt('m = map.new<string, float>()\nm.put("a", 5)\ngone = m.remove("a")\nplot(gone + m.size(m))\n');
  ok(!r3.error, 'remove runs' + (r3.error ? ' -> ' + r3.error : ''));
  if (!r3.error) ok(plotVals(r, 0) && plotVals(r3, 0)[9] === 5, 'remove returns value, size 0');
  const r4 = runIt('m = map.new<string, float>()\nm.put("b", 1)\nm.put("a", 2)\nk = m.keys()\nplot(k.get(0) == "b" and k.get(1) == "a" ? 1 : 0)\n');
  ok(!r4.error && plotVals(r4, 0)[9] === 1, 'keys keep insertion order');
  const r5 = runIt('m = map.new<string, float>()\nm.put("a", 1)\nc = m.copy()\nc.put("a", 9)\nplot(m.get("a") + c.get("a"))\n');
  ok(!r5.error && plotVals(r5, 0)[9] === 10, 'copy is independent');
  const r6 = runIt('m = map.new<string, float>()\nm.put("a", "s")\nplot(1)\n');
  ok(!!r6.error && /expects a number/.test(r6.error), 'value type violation is loud');
  const r7 = runIt('m = map.new<string, float>()\nm.put(na, 1)\nplot(1)\n');
  ok(!!r7.error && /cannot be na/.test(r7.error), 'na key rejected');
  const r8 = runIt('m = map.new<string, float>()\nm.put("a", 1)\nplot(m.get(42))\n');
  ok(!!r8.error && /expects a string/.test(r8.error), 'wrong key type is loud');
  const r9 = runIt('m = map.new()\nm.put(1, "x")\nplot(m.size())\n');
  ok(!r9.error && plotVals(r9, 0)[9] === 1, 'untyped map accepts anything');
  const r10 = runIt('m = map.new<box, float>()\nplot(1)\n');
  ok(!!r10.error && /not supported/.test(r10.error), 'object keys stay loud');
  const r11 = runIt('m = map.new<string, float>()\nm.put("a", 1)\ns = str.tostring(m)\nplot(str.contains(s, "a=1") ? 1 : 0)\n');
  ok(!r11.error && plotVals(r11, 0)[9] === 1, 'tostring renders pairs');
  const r12 = runIt('m = map.new<string, float>()\nm.put("a", 3)\ntot = 0.0\nfor k in m\n    tot := tot + m.get(k)\nplot(tot)\n');
  ok(!r12.error && plotVals(r12, 0)[9] === 3, 'forin yields keys');
  const r13 = runIt('m = map.new<string, float>()\nm.put("a", 3)\ns = 0\nfor [k, v] in m\n    s := v\nplot(s)\n');
  ok(!r13.error && plotVals(r13, 0)[9] === 3, 'forin [k, v] pairs');
  const r14 = runIt('var m = map.new<string, int>()\nm.put("n", 1)\nplot(m.get("n"))\n');
  ok(!r14.error, 'var map persists' + (r14.error ? ' -> ' + r14.error : ''));
  if (!r14.error) ok(plotVals(r14, 0)[9] === 1, 'map value stable across bars');
}

console.log('\nROUND196: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
