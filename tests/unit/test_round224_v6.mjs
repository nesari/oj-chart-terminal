/**
 * test_round224_v6.mjs — ROUND224 v6 features.
 *
 * """ multiline strings, once first-bar block, negative array indices,
 * sort_field UDT sorting (+binary search), text_formatting + int point
 * sizes on label/box/table.
 *
 * Run: node tests/unit/test_round224_v6.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
const BARS = [];
for (let i = 0; i < 10; i++) {
  BARS.push({ time: 1700000000 + i * 60, open: 1, high: 1, low: 1, close: 1 + i * 0.01, volume: 10 });
}
function runAll(src, bars) {
  const c = compile(src);
  if (!c.ok) return { err: 'COMPILE: ' + ((c.errors[0] || {}).message || '?') };
  try {
    const rt = c.createInstance({ tfSec: 60, symbol: 'T', mintick: 0.01 });
    rt.runAll(bars || BARS);
    return { rt };
  } catch (e) { return { err: 'RUNTIME: ' + (e.message || e) }; }
}
const g = (r, n) => { const rec = r.rt && r.rt.globals.get(n); return rec ? rec.value : '<missing>'; };
const H6 = '//@version=6\nindicator("T", overlay=true)\n';

// 1-4: triple-quoted strings
{
  const r = runAll(H6 + 'x = """line1\nline2\nline3"""\nplot(1)\n');
  ok(!r.err && g(r, 'x') === 'line1\nline2\nline3', 'triple-double multiline');
  const r2 = runAll(H6 + "x = '''a\nb'''\nplot(1)\n");
  ok(!r2.err && g(r2, 'x') === 'a\nb', 'triple-single multiline');
  const r3 = runAll(H6 + 'x = """a\\nb"""\nplot(1)\n');
  ok(!r3.err && g(r3, 'x') === 'a\nb', 'escapes inside triple quotes');
  const c4 = compile(H6 + 'x = """abc\nplot(1)\n');
  ok(!c4.ok, 'unterminated triple quote stays loud');
}
// 5-6: once block
{
  const r = runAll(H6 + 'var n = 0\nonce\n    n := n + 1\nplot(1)\n');
  ok(!r.err && g(r, 'n') === 1, 'once body runs on first bar only (got ' + g(r, 'n') + ')');
  const r2 = runAll(H6 + 'once\n    var m = 42\nplot(1)\n');
  ok(!r2.err, 'var decl inside once accepted');
}
// 7-10: negative indices
{
  const r = runAll(H6 + 'a = array.from(10, 20, 30)\nx = a.get(-1)\ny = a.get(-3)\na.set(-1, 99)\nz = a.get(2)\nw = array.from(1, 2, 3)\nw.remove(-1)\nq = w.size()\nplot(1)\n');
  ok(!r.err && g(r, 'x') === 30 && g(r, 'y') === 10 && g(r, 'z') === 99 && g(r, 'q') === 2, 'get/set/remove negatives');
  const r2 = runAll(H6 + 'a = array.from(1, 2, 3)\na.insert(-1, 9)\nx = a.get(1) + a.get(2) * 10\nplot(1)\n');
  /* [1,2,3] + insert(-1,9) -> [1,2,9,3]: get(1)=2, get(2)=9. */
  ok(!r2.err && g(r2, 'x') === 92, 'insert(-1) lands before last (got ' + g(r2, 'x') + ')');
  const r3 = runAll(H6 + 'a = array.from(1)\nx = a.get(-99)\nplot(1)\n');
  ok(r3.err && /out of bounds/.test(r3.err), 'far-negative still OOB-loud');
}
// 11-14: sort_field UDT sorting
{
  const UDT = 'type P\n    int v = 0\n';
  const mk = 'a = array.new<P>()\narray.push(a, P.new(3))\narray.push(a, P.new(1))\narray.push(a, P.new(2))\n';
  const r = runAll('//@version=6\nindicator("T")\n' + UDT + mk + 'array.sort(a, order.ascending, "v")\nx = a.get(0).v + a.get(1).v * 10 + a.get(2).v * 100\nplot(1)\n');
  ok(!r.err && g(r, 'x') === 321, 'sort by string field (got ' + g(r, 'x') + ')');
  const r2 = runAll('//@version=6\nindicator("T")\n' + UDT + mk + 'array.sort(a, order.ascending, 0)\nx = a.get(0).v + a.get(1).v * 10 + a.get(2).v * 100\nplot(1)\n');
  ok(!r2.err && g(r2, 'x') === 321, 'sort by int field index (got ' + g(r2, 'x') + ')');
  const r3 = runAll('//@version=6\nindicator("T")\n' + UDT + mk + 'i = a.sort_indices(order.ascending, "v")\nx = i.get(0) + i.get(1) * 10 + i.get(2) * 100\nplot(1)\n');
  /* values [3,1,2] at idx 0,1,2 -> sorted idx order 1,2,0. */
  ok(!r3.err && g(r3, 'x') === 21, 'sort_indices by field (got ' + g(r3, 'x') + ')');
  const r4 = runAll('//@version=6\nindicator("T")\n' + UDT + mk + 'array.sort(a, order.ascending, "v")\nx = a.binary_search(2, "v")\nplot(1)\n');
  ok(!r4.err && g(r4, 'x') === 1, 'binary_search by field (got ' + g(r4, 'x') + ')');
}
// 15-17: text_formatting + int sizes stored
{
  const r = runAll(H6 + 'l = label.new(bar_index, high, "t", text_formatting=text.format_bold, size=16)\nb = box.new(bar_index, high, bar_index, low, text="x", text_size=20, text_formatting=text.format_italic)\nplot(1)\n');
  const lb = [...r.rt.store.label.values()][0], bx = [...r.rt.store.box.values()][0];
  ok(!r.err && lb.text_formatting === 'bold' && lb.size === 16, 'label formatting + int size');
  ok(!r.err && bx.text_formatting === 'italic' && bx.text_size === 20, 'box formatting + int size');
  const r2 = runAll(H6 + 't = table.new(position.top_right, 2, 2)\ntable.cell(t, 0, 0, "a", text_size=size.large, text_formatting=text.format_bold)\ntable.cell(t, 1, 0, "b", text_size=18)\nplot(1)\n');
  const cells = [...r2.rt.store.table.values()][0].cells;
  ok(!r2.err && cells.get('0,0').text_size === 'large' && cells.get('0,0').text_formatting === 'bold' && cells.get('1,0').text_size === 18, 'cell size names + int + formatting');
}
// 18: setters take int sizes
{
  const r = runAll(H6 + 'b = box.new(bar_index, high, bar_index, low)\nbox.set_text_size(b, 22)\nl = label.new(bar_index, high, "t")\nl.set_size(14)\nplot(1)\n');
  const bx = [...r.rt.store.box.values()][0], lb = [...r.rt.store.label.values()][0];
  ok(!r.err && bx.text_size === 22 && lb.size === 14, 'set_text_size/set_size int');
}

console.log('\nROUND224: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
