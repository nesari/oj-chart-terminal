/**
 * test_round231_period.mjs — ROUND231 request-context timeframe.
 *
 * v6 reference §timeframe.period: inside a request.*() expression the value
 * is the REQUESTED dataset's TF; outside it is the main TF. main_period
 * never follows (same reference). Covers the HTF bucket path, the
 * same-TF fast path and the lower-TF intrabar path.
 *
 * Run: node tests/unit/test_round231_period.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
function runAll(src, bars, opts) {
  const c = compile(src);
  if (!c.ok) return { err: 'COMPILE: ' + ((c.errors[0] || {}).message || '?') };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 3600, symbol: 'T', mintick: 1 }, opts));
    rt.runAll(bars);
    return { rt };
  } catch (e) { return { err: 'RUNTIME: ' + (e.message || e) }; }
}
const g = (r, n) => { const rec = r.rt && r.rt.globals.get(n); return rec ? rec.value : '<missing>'; };
// 50 hourly bars across ~2 days (D buckets form)
const B = [];
for (let i = 0; i < 50; i++) {
  B.push({ time: 1700000000 + i * 3600, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 10 });
}

// 1-2: HTF period follows context (v6 "1D", chart "60")
{
  const r = runAll('//@version=6\nindicator("T")\npi = request.security(syminfo.tickerid, "D", timeframe.period)\npo = timeframe.period\nplot(1)\n', B);
  ok(!r.err && g(r, 'pi') === '1D' && g(r, 'po') === '60', 'v6 period in/out (got ' + g(r, 'pi') + '/' + g(r, 'po') + ')');
}
// 3: v5 bare-unit form inside, minutes outside
{
  const r = runAll('//@version=5\nindicator("T")\npi = request.security(syminfo.tickerid, "D", timeframe.period)\npo = timeframe.period\nplot(1)\n', B);
  ok(!r.err && g(r, 'pi') === 'D' && g(r, 'po') === '60', 'v5 period in/out (got ' + g(r, 'pi') + '/' + g(r, 'po') + ')');
}
// 4-5: main_period pinned to the run TF on both sides
{
  const r = runAll('//@version=6\nindicator("T")\nmi = request.security(syminfo.tickerid, "D", timeframe.main_period)\nmo = timeframe.main_period\nplot(1)\n', B);
  ok(!r.err && g(r, 'mi') === '60' && g(r, 'mo') === '60', 'main_period pinned (got ' + g(r, 'mi') + '/' + g(r, 'mo') + ')');
}
// 6-7: in_seconds("") + multiplier follow context
{
  const r = runAll('//@version=6\nindicator("T")\nsi = request.security(syminfo.tickerid, "D", timeframe.in_seconds(""))\nso = timeframe.in_seconds("")\nmu = request.security(syminfo.tickerid, "D", timeframe.multiplier)\nplot(1)\n', B);
  ok(!r.err && g(r, 'si') === 86400 && g(r, 'so') === 3600 && g(r, 'mu') === 1, 'in_seconds/multiplier (got ' + g(r, 'si') + '/' + g(r, 'so') + '/' + g(r, 'mu') + ')');
}
// 8: is* flags follow context
{
  const r = runAll('//@version=6\nindicator("T")\ndi = request.security(syminfo.tickerid, "D", timeframe.isdaily)\nii = request.security(syminfo.tickerid, "D", timeframe.isintraday)\nio = timeframe.isintraday\nplot(1)\n', B);
  ok(!r.err && g(r, 'di') === true && g(r, 'ii') === false && g(r, 'io') === true, 'isdaily/isintraday context');
}
// 9: same-TF fast path unchanged
{
  const r = runAll('//@version=6\nindicator("T")\npi = request.security(syminfo.tickerid, "60", timeframe.period)\nplot(1)\n', B);
  ok(!r.err && g(r, 'pi') === '60', 'same-TF period (got ' + g(r, 'pi') + ')');
}
// 10: session time() agrees inside/outside on the last bar
{
  const src = '//@version=6\nindicator("T")\ntin = request.security(syminfo.tickerid, "D", time("D", "0000-2359"))\ntout = time("D", "0000-2359")\nplot(1)\n';
  const r = runAll(src, B);
  ok(!r.err && g(r, 'tin') === g(r, 'tout') && typeof g(r, 'tin') === 'number', 'time(D) in==out (got ' + g(r, 'tin') + '/' + g(r, 'tout') + ')');
}
// 11-12: lower-TF path (intrabar context "15", main pinned "60")
{
  const intra = {};
  for (let i = 0; i < B.length; i++) {
    intra[i] = [0, 1].map((k) => ({ time: (B[i].time + k * 900) * 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 5 }));
  }
  const r = runAll('//@version=6\nindicator("T")\npa = request.security_lower_tf(syminfo.tickerid, "15", timeframe.period)\nma = request.security_lower_tf(syminfo.tickerid, "15", timeframe.main_period)\nplot(1)\n', B, { intrabars: intra });
  const aval = (n) => { const v = g(r, n); return v && v.items ? v.items : null; };
  const p = aval('pa'), m = aval('ma');
  ok(!r.err && p && p.length === 2 && p.every((v) => v === '15'), 'LTF period context (got ' + JSON.stringify(p) + ')');
  ok(!r.err && m && m.length === 2 && m.every((v) => v === '60'), 'LTF main pinned (got ' + JSON.stringify(m) + ')');
}

console.log('\nROUND231: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
