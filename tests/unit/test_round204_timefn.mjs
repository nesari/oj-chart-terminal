/**
 * test_round204_timefn.mjs — ROUND204 time(timeframe, session[, tz]) overload.
 *
 * The session filter (was hijacked by bare input.time): in/out, overnight,
 * default exchange wall, HTF buckets, and the legacy input.time paths kept
 * working (namespaced + bare-numeric).
 *
 * Run: node tests/unit/test_round204_timefn.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const T0 = 1790600400 - (1790600400 % 900);
function bars(n, step) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 100 + i;
    out.push({ time: T0 + i * (step || 900), open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 });
  }
  return out;
}
const BARS = bars(10);
function runIt(src, bb, opts) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 1 }, opts || {}));
    rt.runAll(bb || BARS);
    return { c, rt };
  } catch (e) { return { c, error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
function plotVals(r, idx) {
  if (r.error) return null;
  const key = r.rt.out.plotsOrder[idx || 0];
  return r.rt.out.plots.get(key).values.slice();
}
const HEAD = `//@version=5
indicator("T", overlay=true)
`;
/* Wednesday Oct 7 2026 anchors, serverOffSec=0 (UTC feed) */
const T = (h, m) => Date.UTC(2026, 9, 7, h, m || 0);
const dayBars = () => {
  const out = [];
  const midnight = Date.UTC(2026, 9, 7, 0, 0) / 1000; // chart stamps are SECONDS
  for (let k = 0; k < 96; k++) {
    const t = midnight + k * 900;
    out.push({ time: t, open: 100, high: 101, low: 99, close: 100.5, volume: 10 });
  }
  return out;
};

{
  const bb = dayBars();
  const r = runIt(HEAD
    + 'a = time("15", "0930-1600", "America/New_York")\n'
    + 'plot(na(a) ? 0 : 1, title="flag")\n'
    + 'plot(na(a) ? 0 : a, title="ms")\n', bb);
  ok(!r.error, 'session filter runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const f = plotVals(r, 0), m = plotVals(r, 1);
    /* NY 09:30-16:00 ET Oct 7 (EDT) = 13:30-20:00 UTC = M15 idx 54..80 */
    ok(f[0] === 0 && f[53] === 0, 'pre-session na');
    ok(f[54] === 1 && f[79] === 1, 'session bars carry time');
    ok(f[80] === 0, '16:00 ET excluded');
    ok(m[54] === T(13, 30), 'returned ms is the bar open (got ' + m[54] + ')');
  }
}
{
  /* default tz = exchange wall (serverOffSec=7200 -> UTC+2 wall).
     Feed stamps are WALL (trueUtc+off), like the real feed. */
  const bb = dayBars().map((b) => Object.assign({}, b, { time: b.time + 7200 }));
  const r = runIt(HEAD + 'a = time("15", "0930-1600")\nplot(na(a) ? 0 : 1, title="f")\n', bb, { serverOffSec: 7200 });
  ok(!r.error, 'default-tz run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const f = plotVals(r, 0);
    /* wall 09:30 = idx 30; wall 16:00 = idx 56 (bars wall-anchored) */
    ok(f[29] === 0 && f[30] === 1 && f[55] === 1 && f[56] === 0, 'exchange-wall session window');
  }
}
{
  /* HTF form: hourly buckets of a 0930-1600 ET day */
  const bb = dayBars();
  const r = runIt(HEAD + 'a = time("60", "0930-1600", "America/New_York")\nplot(na(a) ? 0 : a, title="ms")\n', bb);
  ok(!r.error, 'HTF form runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const m = plotVals(r, 0);
    /* Rule pinned here: the BUCKET OPEN decides (13:00 UTC = 09:00 ET is out,
       14:00 UTC = 10:00 ET is in). Pre-session buckets na. */
    ok(m[0] === 0 && m[51] === 0, 'pre-session na');
    ok(m[52] === 0, 'straddling bucket judged by its open (out)');
    ok(m[56] === T(14), 'in-session bucket carries its open (got ' + m[56] + ')');
  }
}
{
  /* overnight session form */
  const bb = dayBars();
  const r = runIt(HEAD + 'a = time("15", "2000-0800", "America/New_York")\nplot(na(a) ? 0 : 1, title="f")\n', bb);
  ok(!r.error, 'overnight form runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const f = plotVals(r, 0);
    /* 20:00 ET Oct 6 (idx 0) starts the evening leg; 00:00-08:00 ET Oct 7
       (idx 16..47) is the morning tail; 08:00 ET (idx 48) is out. */
    ok(f[0] === 1 && f[15] === 1 && f[16] === 1 && f[47] === 1 && f[48] === 0, 'overnight legs in, edges exact');
  }
}
{
  /* legacy paths untouched: namespaced input.time + bare numeric input.time */
  const r = runIt(HEAD + 'x = input.time(1690000000000, "Pick")\nplot(1)\n');
  ok(!r.error, 'namespaced input.time still an input' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const has = r.c.collectInputs({}) .ok;
    ok(has, 'collectInputs works');
    ok(r.rt.inputDefs.some((d) => d.kind === 'int' || d.title === 'Pick'), 'input def registered');
  }
  const r2 = runIt(HEAD + 'x = time("D", "oops-no-dash")\nplot(1)\n');
  ok(!!r2.error && /bad session/.test(r2.error), 'bad session string loud');
  const r3 = runIt(HEAD + 'x = time("1", "0930-1600", "GMT")\nplot(1)\n');
  ok(!!r3.error && /lower-timeframe/.test(r3.error), 'sub-chart TF stays loud');
}
/* ROUND204b: function-parameter series history (TV inline semantics) —
   `x[k]` on an ident-valued param reads the source's own history, so edge
   detectors inside functions fire exactly like their inlined form. */
{
  const bb = BARS;
  const r = runIt(HEAD
    + 'edge(bool x) => x and not x[1]\n'
    + 'v = bar_index > 4\n'
    + 'plot(edge(v) ? 1 : 0, title="e")\n'
    + 'plot(v and not v[1] ? 1 : 0, title="g")\n', bb);
  ok(!r.error, 'param edge runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const e = plotVals(r, 0), g = plotVals(r, 1);
    ok(e[4] === 0 && e[5] === 1 && e[6] === 0, 'param edge fires once at the flip');
    ok(e.every((v, i) => v === g[i]), 'param form identical to inlined form');
  }
  const r2 = runIt(HEAD
    + 'dbl(bool x) => x[2]\n'
    + 'v = bar_index > 4\n'
    + 'plot(dbl(v) ? 1 : 0, title="e")\n', bb);
  ok(!r2.error && plotVals(r2, 0)[7] === 1 && plotVals(r2, 0)[6] === 0, 'param [2] history depth');
  const r3 = runIt(HEAD
    + 'f(int n) => n[1]\n'
    + 'plot(f(7))\n', bb);
  ok(!r3.error && plotVals(r3, 0)[9] === 7, 'literal-arg param history reads steady value');
}

console.log('\nROUND204: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
