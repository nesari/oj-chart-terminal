/**
 * test_round234_offset.mjs — ROUND234 offset() == [] parity.
 *
 * v4 offset(source, n) is source[n], including the engine's serial-n
 * leniency (current bar's k, adaptive buffer — same as _evalIndex).
 * Negative n is na on both spellings (was clamped to 0 in offset);
 * na n reads current; short history is na; v6 stays loud (removed in v5).
 *
 * Run: node scripts/test_round234_offset.mjs
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
    const rt = c.createInstance(Object.assign({ tfSec: 60, symbol: 'T', mintick: 1 }, opts));
    rt.runAll(bars);
    return { rt };
  } catch (e) { return { err: 'RUNTIME: ' + (e.message || e) }; }
}
const g = (r, n) => { const rec = r.rt && r.rt.globals.get(n); return rec ? rec.value : '<missing>'; };
const isNAv = (v) => v && v.__pineNA;
const B = [];
for (let i = 0; i < 6; i++) B.push({ time: 1700000000 + i * 60, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10 });
const H4 = '//@version=4\nstudy("T", overlay=true)\n';

// 1: const-n parity (last bar: close 105, [2] -> 103)
{
  const r = runAll(H4 + 'o = offset(close, 2)\ne = close[2]\nplot(1)\n', B);
  ok(!r.err && g(r, 'o') === 103 && g(r, 'e') === 103, 'const parity (got ' + g(r, 'o') + '/' + g(r, 'e') + ')');
}
// 2: serial n parity (bar5: 5%3=2 -> 103 on both)
{
  const r = runAll(H4 + 'o = offset(close, bar_index % 3)\ne = close[bar_index % 3]\nplot(1)\n', B);
  ok(!r.err && g(r, 'o') === 103 && g(r, 'e') === 103, 'serial parity (got ' + g(r, 'o') + '/' + g(r, 'e') + ')');
}
// 3-4: negative is na on both spellings
{
  const r = runAll(H4 + 'o = offset(close, -1)\ne = close[-1]\nplot(1)\n', B);
  ok(!r.err && isNAv(g(r, 'o')) && isNAv(g(r, 'e')), 'negative na both');
}
// 5: na n reads current (== close 105)
{
  const r = runAll(H4 + 'o = offset(close, na)\nplot(1)\n', B);
  ok(!r.err && g(r, 'o') === 105, 'na n current (got ' + g(r, 'o') + ')');
}
// 6: float n truncates (2.9 -> [2] -> 103)
{
  const r = runAll(H4 + 'o = offset(close, 2.9)\nplot(1)\n', B);
  ok(!r.err && g(r, 'o') === 103, 'float trunc (got ' + g(r, 'o') + ')');
}
// 7: short history is na
{
  const r = runAll(H4 + 'o = offset(close, 2)\nplot(1)\n', B.slice(0, 1));
  ok(!r.err && isNAv(g(r, 'o')), 'short history na');
}
// 8: v6 loud (removed in v5)
{
  const r = runAll('//@version=6\nindicator("T")\no = offset(close, 1)\nplot(1)\n', B);
  ok(!!r.err && r.err.indexOf('removed') >= 0, 'v6 loud (' + r.err + ')');
}

console.log('\nROUND234: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
