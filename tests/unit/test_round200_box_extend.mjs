/**
 * test_round200_box_extend.mjs — ROUND200 box extend (TV parity).
 *
 * box.new() keeps the extend argument (was hardcoded 'none'); set_extend
 * mutates; invalid values fall back to none; the mode survives rollback.
 *
 * Run: node tests/unit/test_round200_box_extend.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const BARS = Array.from({ length: 10 }, (_, i) => {
  const t0 = 1790600400 - (1790600400 % 900);
  const o = 100 + i;
  return { time: t0 + i * 900, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 };
});
const HEAD = `//@version=5
indicator("T", overlay=true)
`;

function runIt(body, opts) {
  const c = compile(HEAD + body);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 1 }, opts || {}));
    rt.runAll(BARS);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
const boxes = (r) => (!r.error ? [...r.rt.store.box.values()] : []);

{
  const r = runIt('b = box.new(1, 10, 5, 9, color.red, 1, line.style_solid, extend.right)\nplot(1)\n');
  ok(!r.error, 'positional extend runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) ok(boxes(r).length === 10 && boxes(r).every((b) => b.extend === 'right'), 'extend.right stored on all 10');
}
{
  const r = runIt('b = box.new(1, 10, 5, 9, extend=extend.left, bgcolor=color.blue)\nplot(1)\n');
  ok(!r.error && boxes(r).every((b) => b.extend === 'left'), 'named extend.left stored');
}
{
  const r = runIt('b = box.new(1, 10, 5, 9)\nplot(1)\n');
  ok(!r.error && boxes(r).every((b) => b.extend === 'none'), 'default stays none');
}
{
  const r = runIt('b = box.new(1, 10, 5, 9, extend="sideways")\nplot(1)\n');
  ok(!r.error && boxes(r).every((b) => b.extend === 'none'), 'garbage extend falls back to none');
}
{
  const r = runIt('b = box.new(1, 10, 5, 9)\nbox.set_extend(b, extend.both)\nplot(1)\n');
  ok(!r.error && boxes(r).every((b) => b.extend === 'both'), 'set_extend flips to both');
}
{
  const r = runIt('var b = box.new(1, 10, 5, 9, extend=extend.right)\nplot(1)\n');
  ok(!r.error, 'var box runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(boxes(r).length === 1 && boxes(r)[0].extend === 'right', 'single var box keeps right');
    try {
      r.rt.updateForming(BARS);
      ok(boxes(r).length === 1 && boxes(r)[0].extend === 'right', 'extend survives forming rollback');
    } catch (e) { ok(false, 'updateForming threw: ' + String((e && e.message) || e).slice(0, 100)); }
  }
}
{
  const r = runIt('l = line.new(1, 10, 5, 9, extend=extend.right)\nplot(1)\n');
  ok(!r.error, 'line extend untouched' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const ls = [...r.rt.store.line.values()];
    ok(ls.length === 10 && ls.every((l) => l.extend === 'right'), 'line extend still stored');
  }
}

console.log('\nROUND200: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
