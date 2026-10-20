/**
 * test_round209_named_methods.mjs — ROUND209 named args for method forms +
 * collections (TV parity; round-208 follow-up).
 *
 * Canonical names fill empty slots in both call shapes:
 *   array.get(id=a, index=1)  ==  a.get(index=1)  ==  array.get(a, 1)
 *   ln.set_x1(x=...)          ==  line.set_x1(ln, x=...)
 * Unknown names are loud. Positional behavior unchanged (full suite pins).
 *
 * Run: node scripts/test_round209_named_methods.mjs
 */

import { compile } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const T0 = 1790600400 - (1790600400 % 900);
const BARS = Array.from({ length: 8 }, (_, i) => ({
  time: T0 + i * 900, open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i, volume: 10,
}));
const HEAD = '//@version=5\nindicator("T", overlay=true)\n';
function runIt(body, bars) {
  const c = compile(HEAD + body);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', mintick: 0.01 });
    rt.runAll(bars || BARS);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
const last = (rt, name) => {
  const r = rt.globals.get(name);
  return r && r.hist ? r.hist.a[r.hist.a.length - 1] : 'missing';
};
/* ns-form vs method-form vs positional must agree */
function trio(nsCall, mCall, posCall, plotExpr, want) {
  const mk = (call) => runIt(call + '\nplot(' + plotExpr + ')\n');
  const a = mk(nsCall), b = mk(mCall), p = mk(posCall);
  if (a.error || b.error || p.error) {
    ok(false, plotExpr + ' runs' + [a.error, b.error, p.error].filter(Boolean).map((e) => ' -> ' + e.slice(0, 90)).join(' / '));
    return;
  }
  const va = last(a.rt, 'v'), vb = last(b.rt, 'v'), vp = last(p.rt, 'v');
  ok(va === want && vb === want && vp === want,
    plotExpr + ' ns/method/positional agree (got ' + JSON.stringify([va, vb, vp]) + ')');
}

/* ---------- arrays ---------- */
trio('a = array.from(10, 20, 30)\nv = array.get(id=a, index=1)',
  'a = array.from(10, 20, 30)\nv = a.get(index=1)',
  'a = array.from(10, 20, 30)\nv = array.get(a, 1)', 'v', 20);
trio('a = array.from(10, 20, 30)\narray.set(id=a, index=0, value=99)\nv = a.get(0)',
  'a = array.from(10, 20, 30)\na.set(index=0, value=99)\nv = a.get(0)',
  'a = array.from(10, 20, 30)\narray.set(a, 0, 99)\nv = a.get(0)', 'v', 99);
{
  const r = runIt('a = array.new_int(3, 5)\narray.push(id=a, value=7)\nv = array.size(a)\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 4, 'array.push/size named');
}
{
  const r = runIt('a = array.from(3, 1, 2)\narray.sort(id=a, order=order.ascending)\nv = a.get(0)\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 1, 'array.sort named order');
}
{
  const r = runIt('a = array.from(10, 20, 30)\nv = a.slice(start_index=0, end_index=2)\nw = array.size(v)\nplot(w)\n');
  ok(!r.error && last(r.rt, 'w') === 2, 'array.slice named range');
}
{
  const r = runIt('a = array.from(1)\nv = a.get(idx=0)\nplot(v)\n');
  ok(!!r.error && /unknown argument 'idx'/.test(r.error), 'array method unknown loud' + (r.error ? ' -> ' + r.error.slice(0, 80) : ''));
}
{
  const r = runIt('v = array.new(size=3, initial_value=1)\nw = array.size(v)\nplot(w)\n');
  ok(!r.error && last(r.rt, 'w') === 3, 'array.new named');
}

/* ---------- maps ---------- */
trio('m = map.new<int, float>()\nmap.put(id=m, key=1, value=2.5)\nv = map.get(id=m, key=1)',
  'm = map.new<int, float>()\nm.put(key=1, value=2.5)\nv = m.get(key=1)',
  'm = map.new<int, float>()\nmap.put(m, 1, 2.5)\nv = map.get(m, 1)', 'v', 2.5);
{
  const r = runIt('m = map.new<string, string>()\nm.put("k", "v")\nv = m.contains(key="k")\nplot(v ? 1 : 0)\n');
  ok(!r.error && last(r.rt, 'v') === true, 'map.contains named');
}
{
  const r = runIt('m = map.new<int, int>()\nv = m.put(k=1, v=2)\nplot(1)\n');
  ok(!!r.error && /unknown argument/.test(r.error), 'map method unknown loud' + (r.error ? ' -> ' + r.error.slice(0, 80) : ''));
}

/* ---------- matrices ---------- */
trio('m = matrix.new<float>(2, 2, 1.5)\nv = matrix.get(id=m, row=0, column=1)',
  'm = matrix.new<float>(2, 2, 1.5)\nv = m.get(row=1, column=0)',
  'm = matrix.new<float>(2, 2, 1.5)\nv = matrix.get(m, 0, 1)', 'v', 1.5);
{
  const r = runIt('m = matrix.new<int>(2, 2, 0)\nmatrix.set(id=m, row=1, column=1, value=9)\nv = m.get(1, 1)\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 9, 'matrix.set named');
}
{
  const r = runIt('m = matrix.new<int>(2, 3, 0)\nw = m.reshape(rows=3, columns=2)\nv = m.rows()\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 3, 'matrix.reshape named');
}

/* ---------- drawings (both shapes) ---------- */
trio('l = line.new(bar_index, high, bar_index + 1, low)\nline.set_x1(line=l, x=bar_index + 5)\nv = line.get_x1(l)',
  'l = line.new(bar_index, high, bar_index + 1, low)\nl.set_x1(x=bar_index + 5)\nv = l.get_x1()',
  'l = line.new(bar_index, high, bar_index + 1, low)\nline.set_x1(l, bar_index + 5)\nv = line.get_x1(l)', 'v', 12);
{
  const r = runIt('b = box.new(bar_index, high, bar_index + 1, low)\nb.set_top(top=999)\nv = box.get_top(box=b)\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 999, 'box.set_top + ns get with named receiver');
}
{
  const r = runIt('lb = label.new(bar_index, high, "a")\nlabel.set_text(label=lb, text="b")\nv = label.get_text(lb)\nplot(1)\n');
  ok(!r.error && last(r.rt, 'v') === 'b', 'label.set_text named');
}
{
  const r = runIt('l = line.new(bar_index, high, bar_index + 1, low)\nl.set_x1(y=5)\nplot(1)\n');
  ok(!!r.error && /unknown argument 'y'/.test(r.error), 'line method unknown loud' + (r.error ? ' -> ' + r.error.slice(0, 80) : ''));
}
{
  const r = runIt('a = line.new(bar_index, high, bar_index + 1, low)\nb = line.new(bar_index, low, bar_index + 1, high)\nf = linefill.new(a, b, color.red)\nlinefill.set_color(linefill=f, color=color.blue)\nplot(1)\n');
  ok(!r.error, 'linefill.set_color named');
}

/* ---------- chart.point factories (verified through consumers: point
   field reads are opaque na by design, line.new unpacks the values) ---------- */
{
  const r = runIt('p1 = chart.point.new(time=time, index=bar_index, price=high)\np2 = chart.point.new(time=time, index=bar_index + 1, price=low)\nl = line.new(p1, p2)\nv = l.get_y1(l)\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 109, 'chart.point.new named feeds line.new (got ' + (!r.error ? JSON.stringify(last(r.rt, 'v')) : r.error) + ')');
}
{
  const r = runIt('p = chart.point.from_index(index=3, price=100)\nl = line.new(p, chart.point.from_index(4, 101))\nv = l.get_x1(l)\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 3, 'chart.point.from_index named');
}

console.log('\nROUND209: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
