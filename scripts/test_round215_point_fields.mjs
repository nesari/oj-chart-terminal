/**
 * test_round215_point_fields.mjs — ROUND215 chart.point field reads/writes.
 *
 * TV parity (official lines-and-boxes docs): chart.point fields are directly
 * readable AND writable — `closePoint.price > openPoint.price`,
 * `secondPoint.price := 2.0 * barValue - firstPoint.price`,
 * `topLeft.price := hl2 + newRange`. Previously every read was silent na and
 * every `:=` threw "'p' is not a user-defined object"; `var chart.point x`
 * did not even parse. Unset slots (from_index time) read na; unknown field
 * names are loud. Verified against
 * https://www.tradingview.com/pine-script-docs/visuals/lines-and-boxes/
 *
 * Run: node scripts/test_round215_point_fields.mjs
 */

import { compile } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const T0 = 1790600400 - (1790600400 % 900);
const BARS = Array.from({ length: 8 }, (_, i) => ({
  time: T0 + i * 900, open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i, volume: 10,
}));
const HEAD5 = '//@version=5\nindicator("T", overlay=true)\n';
const HEAD6 = '//@version=6\nindicator("T", overlay=true)\n';
function runIt(body, bars, head) {
  const c = compile((head || HEAD5) + body);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', mintick: 0.01 });
    rt.runAll(bars || BARS);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
const isNAv = (v) => v != null && typeof v === 'object' && v.__pineNA === true;
const last = (rt, name) => {
  const r = rt.globals.get(name);
  return r && r.hist ? r.hist.a[r.hist.a.length - 1] : 'missing';
};
const plotLast = (body, head) => {
  const r = runIt(body + '\nplot(v)\n', undefined, head);
  if (r.error) return { error: r.error };
  return { v: last(r.rt, 'v') };
};

/* ---------- reads ---------- */
{
  const r = plotLast('p = chart.point.new(time, bar_index, close)\nv = p.price');
  ok(!r.error && r.v === 108, 'new: p.price reads close (got ' + JSON.stringify(r.v) + ')');
}
{
  const r = plotLast('p = chart.point.new(time, bar_index, close)\nv = p.index');
  ok(!r.error && r.v === 7, 'new: p.index reads bar_index (got ' + JSON.stringify(r.v) + ')');
}
{
  const r = plotLast('p = chart.point.new(time, bar_index, close)\nv = p.time');
  ok(!r.error && r.v === (T0 + 7 * 900) * 1000, 'new: p.time reads ms (got ' + JSON.stringify(r.v) + ')');
}
{
  const r = plotLast('p = chart.point.from_index(3, 100.5)\nv = p.price');
  ok(!r.error && r.v === 100.5, 'from_index: price readable');
}
{
  const r = plotLast('p = chart.point.from_index(3, 100.5)\nv = p.time');
  ok(!r.error && isNAv(r.v), 'from_index: missing time reads na');
}
{
  const r = plotLast('p = chart.point.from_time(time, 42.0)\nv = p.index');
  ok(!r.error && isNAv(r.v), 'from_time: missing index reads na');
}
{
  const r = plotLast('p = chart.point.now(open)\nv = p.price');
  ok(!r.error && r.v === 107, 'now: price readable (got ' + JSON.stringify(r.v) + ')');
}
{
  const r = plotLast('p = chart.point.new(time, bar_index, close)\nq = chart.point.copy(p)\nv = q.price');
  ok(!r.error && r.v === 108, 'copy: fields survive copy');
}

/* ---------- writes (TV docs fan pattern) ---------- */
{
  const r = plotLast('p = chart.point.now(open)\np.price := 999.0\nv = p.price');
  ok(!r.error && r.v === 999, 'write: p.price := sticks');
}
{
  const r = plotLast('p = chart.point.from_index(1, 10.0)\np.price := 2.0 * 30.0 - p.price\nv = p.price');
  ok(!r.error && r.v === 50, 'write: read-modify-write like the docs fan (got ' + JSON.stringify(r.v) + ')');
}
{
  const r = plotLast('p = chart.point.now(open)\np.price := na\nv = na(p.price) ? 1 : 0');
  ok(!r.error && r.v === 1, 'write: na clears the slot');
}
{
  const r = plotLast('p = chart.point.from_index(1, 10.0)\np.index := 3.9\nv = p.index');
  ok(!r.error && r.v === 3, 'write: index truncates like from_index (got ' + JSON.stringify(r.v) + ')');
}
{
  const r = plotLast('p = chart.point.from_index(1, 10.0)\np.time := time\nv = p.time');
  ok(!r.error && r.v === (T0 + 7 * 900) * 1000, 'write: time slot settable');
}
{
  // copy() is a value snapshot: mutating the original must not move the copy
  const r = runIt('p = chart.point.now(open)\nq = chart.point.copy(p)\np.price := -1.0\nv = q.price\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 107, 'copy independence after write');
}

/* ---------- docs comparison pattern drives a consumer ---------- */
{
  const r = runIt(
    'var chart.point openPoint = chart.point.now(open)\n' +
    'var chart.point closePoint = chart.point.now(close)\n' +
    'closePoint := chart.point.now(close)\n' +
    'up = closePoint.price > openPoint.price\n' +
    'l = line.new(openPoint, closePoint)\n' +
    'v = l.get_y2(l) - l.get_y1(l)\nplot(v)\nplot(up ? 1 : 0)\n', undefined, HEAD6);
  ok(!r.error && last(r.rt, 'v') === 8, 'docs pattern: line from var-openPoint to live close spans 8 (got ' + (!r.error ? JSON.stringify(last(r.rt, 'v')) : r.error) + ')');
}
{
  // consumer parity: mutated point == explicit coordinates
  const r = runIt(
    'p1 = chart.point.from_index(bar_index - 1, 100.0)\n' +
    'p2 = chart.point.from_index(bar_index, 101.0)\n' +
    'p2.price := 102.0\n' +
    'l = line.new(p1, p2)\n' +
    'v = l.get_y2(l)\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 102, 'consumer sees the written price');
}

/* ---------- declarations ---------- */
{
  const r = runIt('var chart.point openPoint = chart.point.now(open)\nv = openPoint.price\nplot(v)\n', undefined, HEAD6);
  ok(!r.error && last(r.rt, 'v') === 100, 'var chart.point decl parses + reads (var pins bar-0 open)');
}
{
  const r = runIt('chart.point bare = chart.point.from_index(2, 55.0)\nv = bare.price\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 55, 'bare chart.point decl parses + reads');
}

/* ---------- unknown fields are loud ---------- */
{
  const r = plotLast('p = chart.point.new(time, bar_index, close)\nv = p.bogus');
  ok(!!r.error && r.error.indexOf('Unknown chart.point field') >= 0, 'unknown read is loud (got ' + (r.error || JSON.stringify(r.v)) + ')');
}
{
  const r = runIt('p = chart.point.new(time, bar_index, close)\np.bogus := 1.0\nplot(1)\n');
  ok(!!r.error && r.error.indexOf('Unknown chart.point field') >= 0, 'unknown write is loud');
}

/* ---------- drawing objects keep the old opaque contract ---------- */
{
  const r = plotLast('l = line.new(bar_index, high, bar_index + 1, low)\nv = l.x1');
  ok(!r.error && isNAv(r.v), 'line field reads stay opaque/na (get_* path untouched)');
}

/* ---------- reference identity (TV: objects compare by reference) ---------- */
{
  const r = runIt('a = chart.point.now(open)\nb = chart.point.now(open)\nv = a == b ? 1 : 0\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 0, 'distinct points are unequal (was always-true via undefined id)');
}
{
  const r = runIt('a = chart.point.now(open)\nb = a\nv = a == b ? 1 : 0\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 1, 'same reference is equal');
}
{
  const r = runIt('a = chart.point.now(open)\nq = chart.point.copy(a)\nv = a == q ? 1 : 0\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 0, 'copy() mints a fresh identity (like line.copy)');
}

/* ---------- series + na + collection parity ---------- */
{
  const r = plotLast('p = chart.point.now(close)\nv = p.price[1]');
  ok(!r.error && r.v === 107, 'field history p.price[1] rides the series (got ' + JSON.stringify(r.v) + ')');
}
{
  const r = plotLast('p = chart.point.from_index(1, 10.0)\np.price := 2.0 * 30.0 - p.price\nv = p.price[1]');
  ok(!r.error && r.v === 50, 'history sees the previous bar post-write value');
}
{
  const r = runIt('var chart.point p = na\nv = na(p.price) ? 1 : 0\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 1, 'na point field read is na-safe');
}
{
  const r = runIt('var arr = array.new<chart.point>()\narray.push(arr, chart.point.now(close))\nq = array.get(arr, array.size(arr) - 1)\nv = q.price\nplot(v)\n', undefined, HEAD6);
  ok(!r.error && last(r.rt, 'v') === 108, 'array<chart.point> round-trips fields');
}

console.log('\nROUND215: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
