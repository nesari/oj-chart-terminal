/**
 * test_round238_udtfield.mjs — ROUND238 direct UDT-field history gate.
 *
 * v6 bans [] directly on UDT fields (migration: (obj[k]).field, which rides
 * rec.hist); chart.point field history stays legal (R215); array-valued
 * fields keep element indexing; older versions keep the generic buffer.
 *
 * Run: node scripts/test_round238_udtfield.mjs
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
for (let i = 0; i < 6; i++) B.push({ time: 1700000000 + i * 60, open: 1, high: 1, low: 1, close: 1, volume: 1 });
const H6 = '//@version=6\nindicator("T")\n';
const UDT = 'type T\n    float a\n    float b\nt = T.new(bar_index, bar_index * 10)\n';

// 1: v6 direct UDT-field history loud with the migration hint
{
  const r = runAll(H6 + UDT + 'x = t.a[1]\nplot(1)\n', B);
  ok(!!r.err && r.err.indexOf('(obj[k]).field') >= 0, 'v6 direct field loud (' + r.err + ')');
}
// 2: v6 migration form works ((t[1]).a == 4 on the last bar)
{
  const r = runAll(H6 + UDT + 'x = (t[1]).a\nplot(1)\n', B);
  ok(!r.err && g(r, 'x') === 4, 'migration form works (got ' + g(r, 'x') + ')');
}
// 3: v6 point-field history untouched (R215)
{
  const r = runAll(H6 + 'p = chart.point.now(close)\nv = p.price[1]\nplot(1)\n', B);
  ok(!r.err && g(r, 'v') === 1, 'point history legal (got ' + g(r, 'v') + ')');
}
// 4: v5 direct field history stays lenient (== 4)
{
  const r = runAll('//@version=5\nindicator("T")\n' + UDT + 'x = t.a[1]\nplot(1)\n', B);
  ok(!r.err && g(r, 'x') === 4, 'v5 lenient works (got ' + g(r, 'x') + ')');
}
// 5: v6 array-valued field keeps element indexing (not history)
{
  const r = runAll(H6 + 'type A\n    int[] xs\nt = A.new(array.from(7, 8))\nx = t.xs[0]\ny = t.xs[1]\nplot(1)\n', B);
  ok(!r.err && g(r, 'x') === 7 && g(r, 'y') === 8, 'array field elements (got ' + g(r, 'x') + '/' + g(r, 'y') + ')');
}
// 6: v6 chained member on UDT also loud
{
  const r = runAll(H6 + 'type I\n    int v\ntype O\n    I inner\nt = O.new(I.new(9))\nx = t.inner.v[1]\nplot(1)\n', B);
  ok(!!r.err && r.err.indexOf('(obj[k]).field') >= 0, 'chained field loud (' + r.err + ')');
}

console.log('\nROUND238: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
