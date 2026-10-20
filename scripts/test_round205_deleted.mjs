/**
 * test_round205_deleted.mjs — ROUND205 .deleted flag + rollback resurrection.
 *
 * TV parity: line/box/label/table/linefill.delete flags the object, so any
 * later getter or setter on it throws "the X was deleted" (guards were dead
 * — store.del never set the flag and scripts silently mutated orphans).
 * Double delete stays silent. A confirmed object deleted by the forming run
 * comes back on rollback (same identity, so var-held refs reunite).
 *
 * Run: node scripts/test_round205_deleted.mjs
 */

import { compile } from '../src/core/pine/compile.js';

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
function runIt(body, bars) {
  const c = compile(HEAD + body);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', mintick: 1 });
    rt.runAll(bars || BARS);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

/* 1-5: guards throw after delete (ns form) */
{
  const r = runIt('l = line.new(bar_index, high, bar_index + 1, low)\nline.delete(l)\nline.get_x1(l)\nplot(1)\n');
  ok(!!r.error && /line.*was deleted/.test(r.error), 'line guard throws' + (r.error ? ' -> ' + r.error : ''));
}
{
  const r = runIt('b = box.new(bar_index, high, bar_index + 1, low)\nbox.delete(b)\nb.set_top(high)\nplot(1)\n');
  ok(!!r.error && /box.*was deleted/.test(r.error), 'box method guard throws' + (r.error ? ' -> ' + r.error : ''));
}
{
  const r = runIt('lb = label.new(bar_index, high, "x")\nlabel.delete(lb)\nlabel.get_text(lb)\nplot(1)\n');
  ok(!!r.error && /label.*was deleted/.test(r.error), 'label guard throws' + (r.error ? ' -> ' + r.error : ''));
}
{
  const r = runIt('t = table.new(position.bottom_right, 1, 1)\ntable.delete(t)\ntable.cell(t, 0, 0, "x")\nplot(1)\n');
  ok(!!r.error && /table.*was deleted/.test(r.error), 'table guard throws' + (r.error ? ' -> ' + r.error : ''));
}
{
  const r = runIt('a = line.new(bar_index, high, bar_index + 1, high)\nb = line.new(bar_index, low, bar_index + 1, low)\nf = linefill.new(a, b, color.red)\nlinefill.delete(f)\nlinefill.set_color(f, color.blue)\nplot(1)\n');
  ok(!!r.error && /linefill.*was deleted/.test(r.error), 'linefill guard throws' + (r.error ? ' -> ' + r.error : ''));
}
/* 6: double delete stays silent */
{
  const r = runIt('l = line.new(bar_index, high, bar_index + 1, low)\nline.delete(l)\nline.delete(l)\nplot(1)\n');
  ok(!r.error, 'double delete silent' + (r.error ? ' -> ' + r.error : ''));
}
/* 7: delete flags the ref and empties the store */
{
  const r = runIt('var l = line.new(bar_index, high, bar_index + 1, low)\nline.delete(l)\nplot(1)\n');
  ok(!r.error, 'delete run ok' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const ref = r.rt.globals.get('l').value;
    ok(ref && ref.deleted === true, 'held ref flagged deleted');
    ok(r.rt.store.line.size === 0, 'store empty after delete');
  }
}
/* 8-10: snapshot/restore resurrects with identity */
{
  const r = runIt('var l = line.new(bar_index, high, bar_index + 1, low)\nplot(1)\n');
  ok(!r.error, 'setup run ok' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const rt = r.rt;
    const ref = rt.globals.get('l').value;
    const id = ref.id;
    const snap = rt.snapshot();
    rt.store.del('line', ref);
    ok(ref.deleted === true && rt.store.line.size === 0, 'deleted after snapshot');
    rt.restore(snap);
    const back = rt.store.line.get(id);
    ok(back === ref, 'same identity resurrected');
    ok(back && back.deleted === false, 'flag cleared on resurrect');
  }
}
/* 11-13: end-to-end through updateForming (varip once-flag) */
{
  const body = 'varip fired = false\n'
    + 'var l = line.new(bar_index, high, bar_index + 1, low)\n'
    + 'if barstate.islast and not fired\n'
    + '    line.delete(l)\n'
    + '    fired := true\n'
    + 'plot(1)\n';
  const c = compile(HEAD + body);
  ok(c.ok, 'forming script compiles');
  if (c.ok) {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', mintick: 1 });
    rt.runAll(BARS);
    ok(rt.store.line.size === 0, 'forming run deleted the line');
    rt.updateForming(BARS);
    const ref = rt.globals.get('l').value;
    ok(rt.store.line.size === 1, 'tick rollback resurrected (store 1)');
    ok(ref && ref.deleted === false, 'resurrected ref usable, flag false');
    rt.updateForming(BARS);
    ok(rt.store.line.size === 1 && ref.deleted === false, 'second tick stable');
  }
}
/* 14: unrelated objects survive the rollback untouched */
{
  const r = runIt('var a = line.new(bar_index, high, bar_index + 1, low)\nvar b = line.new(bar_index, low, bar_index + 1, high)\nline.delete(a)\nplot(1)\n');
  ok(!r.error, 'two-line run ok' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const snap = r.rt.snapshot();
    ok(r.rt.store.line.size === 1, 'only survivor live');
    r.rt.restore(snap);
    ok(r.rt.store.line.size === 1, 'restore keeps survivor count');
  }
}

console.log('\nROUND205: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
