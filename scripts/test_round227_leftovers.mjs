/**
 * test_round227_leftovers.mjs — ROUND227 leftovers (audit row B/C tail).
 *
 * ta.range (v6 reference §ta.range), matrix.submatrix, timeframe.main_period
 * (v6 reference §timeframe.main_period), plot/shape force_overlay storage.
 * Paint-level proof lives in e2e_round227_leftovers.py.
 *
 * Run: node scripts/test_round227_leftovers.mjs
 */

import { compile } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
function mkBars(n, step, base, t0) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ time: t0 + i * step, open: base + i, high: base + i + 2, low: base + i - 1, close: base + i + 1, volume: 10 });
  return out;
}
const BARS = mkBars(30, 60, 100, 1700000000);
function runAll(src, bars, opts) {
  const c = compile(src);
  if (!c.ok) return { err: 'COMPILE: ' + ((c.errors[0] || {}).message || '?') };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 60, symbol: 'T', mintick: 0.01 }, opts));
    rt.runAll(bars || BARS);
    return { rt };
  } catch (e) { return { err: 'RUNTIME: ' + (e.message || e) }; }
}
const g = (r, n) => { const rec = r.rt && r.rt.globals.get(n); return rec ? rec.value : '<missing>'; };
const H6 = '//@version=6\nindicator("T", overlay=true)\n';

// 1-3: ta.range
{
  const r = runAll(H6 + 'x = ta.range(close, 5)\nplot(1)\n');
  // last 5 closes: 125..129 -> 129-125 = 4
  ok(!r.err && g(r, 'x') === 4, 'ta.range window max-min (got ' + g(r, 'x') + ')');
  const r2 = runAll('//@version=5\nindicator("T")\nx = ta.range()\nplot(1)\n');
  /* ROUND237: argless is v6-loud (reference defines only (source, length));
     older versions keep the lenient branch. */
  ok(!r2.err && g(r2, 'x') === 3, 'argless range = high-low pre-v6 (got ' + g(r2, 'x') + ')');
  const r3 = runAll('//@version=4\nstudy("T")\nx = range(close, 5)\nplot(1)\n');
  ok(!r3.err && g(r3, 'x') === 4, 'bare v4 range forwards');
}
// 4-5: matrix.submatrix
{
  const r = runAll(H6 + 'm = matrix.new<float>(3, 3, 0)\nmatrix.set(m, 1, 1, 7)\ns = m.submatrix(1, 1, 3, 3)\nx = s.get(0, 0) + s.rows() * 10 + s.columns() * 100\nplot(1)\n');
  ok(!r.err && g(r, 'x') === 7 + 20 + 200, 'submatrix values + shape (got ' + g(r, 'x') + ')');
  const r2 = runAll(H6 + 'm = matrix.new<int>(2, 2, 1)\ns = matrix.submatrix(m, 0, 0, 1, 1)\nx = s.get(0, 0)\nplot(1)\n');
  ok(!r2.err && g(r2, 'x') === 1, 'ns-form submatrix');
  const r3 = runAll(H6 + 'm = matrix.new<int>(2, 2, 1)\ns = m.submatrix(1, 1, 0, 0)\nplot(1)\n');
  ok(r3.err && /at or after/.test(r3.err), 'reversed submatrix loud');
}
// 6-7: main_period (unversioned, canonical run TF)
{
  const t = (sec, ver) => runAll('//@version=' + ver + '\nindicator("T")\nx = timeframe.main_period\nplot(1)\n', mkBars(4, sec, 1, 1700000000), { tfSec: sec });
  /* "10S" seconds, "30" minutes, "240" four hours, "1D" — hours in minutes. */
  ok(g(t(15, 6), 'x') === '15S' && g(t(900, 6), 'x') === '15' && g(t(14400, 6), 'x') === '240', 'main_period intraday forms');
  ok(g(t(86400, 6), 'x') === '1D' && g(t(604800, 6), 'x') === '1W' && g(t(86400, 5), 'x') === '1D', 'main_period D/W (+v5 same)');
}
// 8-9: force_overlay stored on plots + shapes
{
  const r = runAll('//@version=6\nindicator("T", overlay=false)\nplot(close, force_overlay=true)\nplot(open)\nplotshape(close > open, force_overlay=true)\nplot(1)\n');
  const plots = [...r.rt.out.plots.values()];
  const fo = plots.filter((p) => p.force_overlay);
  ok(!r.err && fo.length === 1, 'one forced plot stored (got ' + fo.length + '/' + plots.length + ')');
  const sh = [...r.rt.out.shapes.values()];
  ok(!r.err && sh.length === 1 && sh[0].force_overlay === true, 'shape force_overlay stored');
}

console.log('\nROUND227: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
