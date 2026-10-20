/**
 * test_round226_dynamic.mjs — ROUND226 dynamic requests + declaration timeframe.
 *
 * declMeta records raw timeframe= (renderer resolves + runs HTF buckets);
 * series symbol/TF args, local-scope calls (if/for/function), library
 * runtimes (shared env) and the collectMissing discovery contract.
 *
 * Run: node tests/unit/test_round226_dynamic.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
function mkGrid(n, step, base, t0) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ time: t0 + i * step, open: base + i, high: base + i + 1, low: base + i - 1, close: base + i, volume: 10 });
  return out;
}
const T0 = 1700000000 - (1700000000 % 3600);
const CHART = mkGrid(24, 900, 100, T0);
const AAA15 = mkGrid(24, 900, 1000, T0);
const BBB15 = mkGrid(24, 900, 2000, T0);
const AAA60 = mkGrid(6, 3600, 5000, T0);
function runIt(src, symBars, opts, libs) {
  const c = compile(src, libs ? { libraries: libs } : undefined);
  if (!c.ok) return { err: 'COMPILE: ' + ((c.errors[0] || {}).message || '?') };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'CHART', mintick: 0.01 }, opts));
    if (symBars) rt.env.symBars = symBars;
    rt.runAll(CHART);
    return { c, rt };
  } catch (e) { return { err: 'RUNTIME: ' + (e.message || e) }; }
}
const g = (r, n) => { const rec = r.rt && r.rt.globals.get(n); return rec ? rec.value : '<missing>'; };

// 1-3: declaration timeframe= contract (renderer runs the buckets; node pins meta)
{
  const c = compile('//@version=6\nindicator("T", timeframe="D")\nplot(1)\n');
  ok(c.ok && c.meta.timeframe === 'D' && !c.meta.ignoredParams.includes('timeframe'), 'timeframe= consumed raw into meta');
  const c2 = compile('//@version=6\nindicator("T", timeframe="", timeframe_gaps=true)\nplot(1)\n');
  ok(c2.ok && c2.meta.timeframe === null && c2.meta.ignoredParams.includes('timeframe_gaps'), 'empty timeframe = chart, gaps still ignored');
  const c3 = compile('//@version=6\nindicator("T", timeframe="XYZ")\nplot(1)\n');
  ok(c3.ok && c3.meta.timeframe === 'XYZ', 'unresolvable TF recorded raw (renderer falls back + logs)');
}
// 4: series symbol
{
  const r = runIt('//@version=6\nindicator("T")\ns = bar_index % 2 == 0 ? "AAA" : "BBB"\nx = request.security(s, "15", close)\nplot(x)\n',
    { 'AAA|900': AAA15, 'BBB|900': BBB15 });
  const exp = CHART.map((b, i) => (i % 2 === 0 ? 1000 + i : 2000 + i));
  const got = r.rt.out.plots.get(r.rt.out.plotsOrder[0]).values;
  ok(!r.err && got.every((v, i) => v === exp[i]), 'series symbol resolves per bar');
}
// 5: series timeframe
{
  const r = runIt('//@version=6\nindicator("T")\nt = bar_index % 2 == 0 ? "15" : "60"\nx = request.security("AAA", t, close)\nplot(x)\n',
    { 'AAA|900': AAA15, 'AAA|3600': AAA60 });
  const vals = r.rt.out.plots.get(r.rt.out.plotsOrder[0]).values;
  // even bars: AAA15 same-index close; odd bars: last AAA60 bucket at-or-before
  let good = !r.err;
  for (let i = 0; i < CHART.length && good; i++) {
    const want = i % 2 === 0 ? 1000 + i
      : (() => { let bi = -1; for (let k = 0; k < AAA60.length; k++) if (AAA60[k].time <= CHART[i].time) bi = k; return bi < 0 ? null : 5000 + bi; })();
    const v = vals[i];
    if (want == null ? (v != null && typeof v !== 'object') : v !== want) good = false;
  }
  ok(good, 'series timeframe buckets per bar');
}
// 6: local scopes (if / for / user function) with data present
{
  const src = '//@version=6\nindicator("T")\nvar x = 0.0\nif bar_index > 5\n    x := request.security("AAA", "15", close)\nfor i = 0 to 0\n    y = request.security("AAA", "15", open)\nf(s) => request.security(s, "15", high)\nz = f("AAA")\nplot(1)\n';
  const r = runIt(src, { 'AAA|900': AAA15 });
  ok(!r.err && g(r, 'x') === 1000 + 23 && g(r, 'z') === 1001 + 23, 'local-scope + function security (got ' + g(r, 'x') + '/' + g(r, 'z') + ')');
}
// 7: library runtime shares env (sees importer symBars)
{
  const LIB = '//@version=5\nlibrary("DynLib")\nexport f(sym) => request.security(sym, "15", close)\n';
  const src = '//@version=5\nindicator("T")\nimport Me/DynLib/1 as D\nx = D.f("AAA")\nplot(1)\n';
  const r = runIt(src, { 'AAA|900': AAA15 }, null, { DynLib: LIB });
  ok(!r.err && g(r, 'x') === 1000 + 23, 'library security via shared env (got ' + g(r, 'x') + ')');
}
// 8-9: collectMissing discovery vs throw mode
{
  const src = '//@version=6\nindicator("T")\ns = bar_index % 2 == 0 ? "AAA" : "BBB"\nx = request.security(s, "15", close)\nplot(1)\n';
  const c = compile(src);
  const rt = c.createInstance({ tfSec: 900, symbol: 'CHART', mintick: 0.01 });
  rt.env.collectMissing = true;
  let threw = false;
  try { rt.runAll(CHART); } catch (e) { threw = true; }
  const ms = rt.missingSymBars || [];
  ok(!threw && ms.length === 2, 'discovery completes, deduped set (got ' + JSON.stringify(ms) + ')');
  const rt2 = c.createInstance({ tfSec: 900, symbol: 'CHART', mintick: 0.01 });
  let err = '';
  try { rt2.runAll(CHART); } catch (e) { err = e.message || String(e); }
  ok(/no history for/.test(err), 'throw mode still loud without data');
}

console.log('\nROUND226: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
