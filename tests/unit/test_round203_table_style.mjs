/**
 * test_round203_table_style.mjs — ROUND203 table style setters (TV parity).
 *
 * set_bgcolor/border_color/border_width/frame_color/frame_width mutate live
 * tables (ns + method forms), bump store.version, and stay loud on garbage.
 *
 * Run: node tests/unit/test_round203_table_style.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const BARS = Array.from({ length: 5 }, (_, i) => {
  const t0 = 1790600400 - (1790600400 % 900);
  const o = 100 + i;
  return { time: t0 + i * 900, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 };
});
const HEAD = `//@version=5
indicator("T", overlay=true)
`;
function runIt(body) {
  const c = compile(HEAD + body);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', mintick: 1 });
    rt.runAll(BARS);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
const tables = (r) => (!r.error ? [...r.rt.store.table.values()] : []);

{
  const r = runIt('var t = table.new(position.bottom_right, 2, 2)\n'
    + 'table.set_bgcolor(t, color.red)\n'
    + 'table.set_border_color(t, color.blue)\n'
    + 'table.set_border_width(t, 3)\n'
    + 'table.set_frame_color(t, color.green)\n'
    + 'table.set_frame_width(t, 2)\n'
    + 'plot(1)\n');
  ok(!r.error, 'ns setters run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const t = tables(r)[0];
    ok(t && t.bgcolor && t.bgcolor.css() === 'rgba(255,82,82,1)', 'bgcolor red');
    ok(t && t.border_color && t.border_color.css() === 'rgba(41,98,255,1)', 'border_color blue');
    ok(t && t.border_width === 3, 'border_width 3');
    ok(t && t.frame_color && t.frame_color.css() === 'rgba(76,175,80,1)', 'frame_color green');
    ok(t && t.frame_width === 2, 'frame_width 2');
  }
}
{
  const r = runIt('var t = table.new(position.bottom_right, 1, 1)\n'
    + 't.set_bgcolor(color.yellow)\n'
    + 't.set_frame_width(4)\n'
    + 'plot(1)\n');
  ok(!r.error, 'method form runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const t = tables(r)[0];
    ok(t && t.bgcolor && t.bgcolor.css() === 'rgba(255,235,59,1)', 'method bgcolor yellow');
    ok(t && t.frame_width === 4, 'method frame_width 4');
  }
}
{
  const r = runIt('var t = table.new(position.bottom_right, 1, 1)\n'
    + 'v0 = 1\n'
    + 'table.set_bgcolor(t, color.red)\n'
    + 'plot(1)\n');
  ok(!r.error, 'version probe runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) ok(r.rt.store.version > 0, 'setters bump store.version (' + r.rt.store.version + ')');
}
{
  /* ROUND205 (TV parity): store.del flags .deleted, so operating a deleted
     object is loud — the old silent-orphan leniency is gone. */
  const rDel = runIt('t = table.new(position.bottom_right, 1, 1)\ntable.delete(t)\ntable.set_bgcolor(t, color.red)\nplot(1)\n');
  ok(!!rDel.error && /was deleted/.test(rDel.error), 'deleted table op throws' + (rDel.error ? ' -> ' + rDel.error : ''));
  const r2 = runIt('var t = table.new(position.bottom_right, 1, 1)\ntable.set_bgcolor(t, "nope-not-a-color")\nplot(1)\n');
  ok(!!r2.error && /expected a color/.test(r2.error), 'garbage color loud');
  const r3 = runIt('var t = table.new(position.bottom_right, 1, 1)\ntable.set_border_width(t, "wide")\nplot(1)\n');
  ok(!r3.error && tables(r3)[0].border_width === 1, 'garbage width falls back like table.new');
  const r4 = runIt('var t = table.new(position.bottom_right, 1, 1)\ntable.set_bgcolor(t, color.new(color.red, 50))\nplot(1)\n');
  ok(!r4.error && tables(r4)[0].bgcolor.a === 0.5, 'transparent colors kept');
}

console.log('\nROUND203: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
