/**
 * test_round236_dynamicflag.mjs — ROUND236 dynamic_requests observability.
 *
 * dynamic_requests lands in meta.dynamicRequests (explicit bool only, no
 * invented defaults); request.* calls in local scope are counted in
 * meta.localRequests (never a compile error — the engine stays lenient and
 * runs them, TV rejects with explicit false). The renderer Log.debug's the
 * deviation (e2e).
 *
 * Run: node tests/unit/test_round236_dynamicflag.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
function runAll(src, bars, opts) {
  const c = compile(src);
  if (!c.ok) return { err: 'COMPILE: ' + ((c.errors[0] || {}).message || '?'), meta: c.meta };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 3600, symbol: 'T', mintick: 1 }, opts));
    rt.runAll(bars);
    return { rt, meta: c.meta };
  } catch (e) { return { err: 'RUNTIME: ' + (e.message || e), meta: c.meta }; }
}
const g = (r, n) => { const rec = r.rt && r.rt.globals.get(n); return rec ? rec.value : '<missing>'; };
const B = [];
for (let i = 0; i < 50; i++) B.push({ time: 1700000000 + i * 3600, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10 });

// 1-3: meta.dynamicRequests true/false/absent
{
  const t = runAll('//@version=6\nindicator("T", dynamic_requests=true)\nplot(1)\n', B);
  const f = runAll('//@version=6\nindicator("T", dynamic_requests=false)\nplot(1)\n', B);
  const a = runAll('//@version=6\nindicator("T")\nplot(1)\n', B);
  const v5 = runAll('//@version=5\nindicator("T")\nplot(1)\n', B);
  ok(t.meta.dynamicRequests === true && f.meta.dynamicRequests === false, 'explicit true/false recorded');
  ok(a.meta.dynamicRequests === undefined && v5.meta.dynamicRequests === undefined, 'absent stays undefined (no invented defaults)');
}
// 4-7: local-scope counting (global 0, if/for/func/ternary)
{
  const q = (body) => runAll('//@version=6\nindicator("T", dynamic_requests=false)\n' + body + '\nplot(1)\n', B).meta.localRequests;
  ok(q('g = request.security(syminfo.tickerid, "D", close)') === 0, 'global call counts 0');
  ok(q('d = 0.0\nif bar_index > 1\n    d := request.security(syminfo.tickerid, "D", close)') === 1, 'if-block counts 1');
  ok(q('s = 0.0\nfor i = 0 to 2\n    s := request.security(syminfo.tickerid, "D", close)') === 1, 'loop counts 1');
  ok(q('f() => request.security(syminfo.tickerid, "D", close)\nv = f()') === 1, 'user-func counts 1');
}
// 8: ternary branch + bare v4 security count
{
  const q = (body) => runAll('//@version=5\nindicator("T", dynamic_requests=false)\n' + body + '\nplot(1)\n', B).meta.localRequests;
  ok(q('v = bar_index > 1 ? request.security(syminfo.tickerid, "D", close) : 0') === 1, 'ternary branch counts 1');
}
// 9: lenient execution still value-correct with explicit false
{
  const r = runAll('//@version=6\nindicator("T", dynamic_requests=false)\nd = 0.0\nif bar_index > 10\n    d := request.security(syminfo.tickerid, "D", close)\ng = request.security(syminfo.tickerid, "D", close)\nplot(1)\n', B);
  ok(!r.err && r.meta.localRequests === 1 && g(r, 'd') === g(r, 'g') && typeof g(r, 'd') === 'number',
    'local runs, values match global (got ' + g(r, 'd') + '/' + g(r, 'g') + ')');
}

console.log('\nROUND236: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
