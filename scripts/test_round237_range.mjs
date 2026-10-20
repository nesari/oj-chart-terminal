/**
 * test_round237_range.mjs — ROUND237 ta.range arity contract.
 *
 * Reference §ta.range: exactly ta.range(source, length). Other arities are
 * loud in v6 (TV rejects at compile); older versions keep the lenient
 * branches (argless = bar high-low, single-arg = window over high).
 * Named source=/length= fills positionally (was silently argless).
 *
 * Run: node scripts/test_round237_range.mjs
 */

import { compile } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
function runAll(src, bars, opts) {
  const c = compile(src);
  if (!c.ok) return { err: 'COMPILE: ' + ((c.errors[0] || {}).message || '?') };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 60, symbol: 'T', mintick: 0.01 }, opts));
    rt.runAll(bars || BARS);
    return { rt };
  } catch (e) { return { err: 'RUNTIME: ' + (e.message || e) }; }
};
function mkBars(n, step, base, t0) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ time: t0 + i * step, open: base + i, high: base + i + 2, low: base + i - 1, close: base + i + 1, volume: 10 });
  return out;
}
const BARS = mkBars(30, 60, 100, 1700000000);
const g = (r, n) => { const rec = r.rt && r.rt.globals.get(n); return rec ? rec.value : '<missing>'; };
const H6 = '//@version=6\nindicator("T", overlay=true)\n';

// 1: v6 two-arg values (last 5 closes 125..129 -> 4)
{
  const r = runAll(H6 + 'x = ta.range(close, 5)\nplot(1)\n');
  ok(!r.err && g(r, 'x') === 4, 'v6 two-arg window (got ' + g(r, 'x') + ')');
}
// 2-3: v6 argless + single-arg loud
{
  const r = runAll(H6 + 'x = ta.range()\nplot(1)\n');
  ok(!!r.err && r.err.indexOf('ta.range()') >= 0, 'v6 argless loud (' + r.err + ')');
  const r2 = runAll(H6 + 'x = ta.range(5)\nplot(1)\n');
  ok(!!r2.err && r2.err.indexOf('ta.range()') >= 0, 'v6 single-arg loud (' + r2.err + ')');
}
// 4-5: pre-v6 lenient branches intact
{
  const r = runAll('//@version=5\nindicator("T")\nx = ta.range()\nplot(1)\n');
  ok(!r.err && g(r, 'x') === 3, 'v5 argless high-low (got ' + g(r, 'x') + ')');
  const r2 = runAll('//@version=5\nindicator("T")\nx = ta.range(5)\nplot(1)\n');
  // last 5 highs 127..131 -> 131-127 = 4
  ok(!r2.err && g(r2, 'x') === 4, 'v5 single-arg high window (got ' + g(r2, 'x') + ')');
}
// 6: named form fills positionally (was silently argless = 3)
{
  const r = runAll(H6 + 'x = ta.range(source=close, length=5)\nplot(1)\n');
  ok(!r.err && g(r, 'x') === 4, 'named form (got ' + g(r, 'x') + ')');
}
// 7: na-heavy window ignores na (single finite -> 0 range... no finite -> na)
{
  const bars = mkBars(6, 60, 100, 1700000000);
  const r = runAll(H6 + 'x = ta.range(close, 50)\nplot(1)\n', bars);
  // window never fills over 6 bars -> na
  const v = g(r, 'x');
  ok(!r.err && v && v.__pineNA, 'short history na');
}

console.log('\nROUND237: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
