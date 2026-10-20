/**
 * test_round222a_v4.mjs — ROUND222a v4 bundle.
 *
 * offset() == [k] parity; completed bare-alias table (v4→v5 rename list)
 * forwards to the same kernels (value parity vs namespaced forms); bare
 * series vars read through taVars (were silent-NA); v4 rsi(x, float-len)
 * uses the removed-overload MFI formula; day-less session strings default
 * Mon–Fri for version<5 (all days for v5+).
 *
 * Run: node scripts/test_round222a_v4.mjs
 */

import { compile } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
const BARS = [];
for (let i = 0; i < 40; i++) {
  BARS.push({ time: 1700000000 + i * 3600, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000 + i * 7 });
}
function runGet(src, name) {
  const c = compile(src);
  if (!c.ok) return { err: 'COMPILE: ' + ((c.errors[0] || {}).message || '?') };
  try {
    const rt = c.createInstance({ tfSec: 3600, symbol: 'T', mintick: 0.01 });
    rt.runAll(BARS);
    const g = rt.globals.get(name);
    return { v: g ? g.value : '<missing>' };
  } catch (e) { return { err: 'RUNTIME: ' + (e.message || e) }; }
}
const H4 = '//@version=4\nstudy("T", overlay=true)\n';

// 1-3: offset() parity with []
{
  const a = runGet(H4 + 'x = offset(close, 1)\ny = close[1]\nplot(1)\n', 'x');
  const b = runGet(H4 + 'x = offset(close, 1)\ny = close[1]\nplot(1)\n', 'y');
  ok(!a.err && !b.err && a.v === b.v && a.v === 138, 'offset(close,1) == close[1] (got ' + a.v + ')');
  const z = runGet(H4 + 'z = offset(close, 0)\nplot(1)\n', 'z');
  ok(!z.err && z.v === 139, 'offset(close,0) == close (got ' + z.v + ')');
  const e = runGet('//@version=4\nstudy("T", overlay=true)\nw = offset(close, 99)\ne = na(w)\nplot(1)\n', 'e');
  ok(!e.err && e.v === true, 'offset beyond history is na');
}
// 4-8: bare ta aliases == namespaced (last-bar values)
{
  const pairs = [
    ['alma(close,9,0.85,6)', 'ta.alma(close,9,0.85,6)'],
    ['tsi(close,13,25)', 'ta.tsi(close,13,25)'],
    ['median(close,14)', 'ta.median(close,14)'],
    ['percentrank(close,14)', 'ta.percentrank(close,14)'],
    ['variance(close,14)', 'ta.variance(close,14)'],
    ['cmo(close,14)', 'ta.cmo(close,14)'],
    ['swma(close)', 'ta.swma(close)'],
    ['rci(close,9)', 'ta.rci(close,9)'],
  ];
  let n = 0;
  for (const [bare, ns] of pairs) {
    const a = runGet(H4 + 'x = ' + bare + '\nplot(1)\n', 'x');
    const b = runGet(H4 + 'x = ' + ns + '\nplot(1)\n', 'x');
    if (!a.err && !b.err && a.v === b.v) n++;
    else console.log('    mismatch ' + bare + ': ' + (a.err || a.v) + ' vs ' + (b.err || b.v));
  }
  ok(n === pairs.length, 'bare ta aliases equal namespaced (' + n + '/' + pairs.length + ')');
}
// 9: bare math aliases
{
  const a = runGet(H4 + 'x = acos(0) + sin(0) + sum(1, 2, 3) + todegrees(1)\nplot(1)\n', 'x');
  const b = runGet(H4 + 'x = math.acos(0) + math.sin(0) + math.sum(1, 2, 3) + math.todegrees(1)\nplot(1)\n', 'x');
  ok(!a.err && !b.err && a.v === b.v, 'bare math aliases equal math.* (got ' + a.v + ')');
}
// 10: bare tickerid() call
{
  const a = runGet(H4 + 'x = tickerid()\nplot(1)\n', 'x');
  const b = runGet(H4 + 'x = syminfo.tickerid\nplot(1)\n', 'x');
  ok(!a.err && !b.err && a.v === b.v, 'bare tickerid() == syminfo.tickerid');
}
// 11-12: bare series vars (were silent-NA)
{
  const a = runGet(H4 + 'x = accdist\nplot(1)\n', 'x');
  const b = runGet(H4 + 'x = ta.accdist\nplot(1)\n', 'x');
  ok(!a.err && !b.err && typeof a.v === 'number' && a.v === b.v, 'bare accdist == ta.accdist (got ' + a.v + ')');
  const c = runGet(H4 + 'x = obv\nplot(1)\n', 'x');
  const d = runGet(H4 + 'x = ta.obv\nplot(1)\n', 'x');
  ok(!c.err && !d.err && typeof c.v === 'number' && c.v === d.v, 'bare obv == ta.obv (got ' + c.v + ')');
}
// 13-14: v4 rsi float-len overload (MFI formula); v6 keeps ta.rsi
{
  const last = 139, L = 14.5;
  const expect = 100 - 100 / (1 + last / L);
  const a = runGet(H4 + 'x = rsi(close, 14.5)\nplot(1)\n', 'x');
  ok(!a.err && typeof a.v === 'number' && Math.abs(a.v - expect) < 1e-9, 'v4 rsi(close,14.5) uses removed-overload formula (got ' + a.v + ')');
  const b = runGet('//@version=6\nindicator("T", overlay=true)\nx = rsi(close, 14)\nplot(1)\n', 'x');
  ok(!b.err && typeof b.v === 'number' && b.v === 100, 'v6 rsi(close,14) normal path (all-up window reads 100)');
}
// 15-16: session day default — Saturday bar 2023-11-18
{
  const SAT = [{ time: 1700265600, open: 1, high: 1, low: 1, close: 1, volume: 10 }];
  const run1 = (src) => {
    const c = compile(src);
    if (!c.ok) return { err: 'COMPILE' };
    try {
      const rt = c.createInstance({ tfSec: 86400, symbol: 'T', mintick: 0.01 });
      rt.runAll(SAT);
      return { v: rt.globals.get('x').value };
    } catch (e) { return { err: String(e.message || e) }; }
  };
  const v4 = run1('//@version=4\nstudy("T")\nx = session.ismarket(time, "0000-2400", "GMT")\nplot(1)\n');
  const v6 = run1('//@version=6\nindicator("T")\nx = session.ismarket(time, "0000-2400", "GMT")\nplot(1)\n');
  ok(!v4.err && v4.v === false, 'v4 day-less session excludes Saturday (got ' + v4.v + ')');
  ok(!v6.err && v6.v === true, 'v6 day-less session includes Saturday (got ' + v6.v + ')');
}

console.log('\nROUND222a: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
