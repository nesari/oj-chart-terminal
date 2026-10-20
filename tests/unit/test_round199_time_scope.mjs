/**
 * test_round199_time_scope.mjs — ROUND199 calendar + scope + HTF time unit.
 *
 * dayofweek Pine convention (Sun=1..Sat=7), EU DST boundaries through the
 * 786-style sundayOfMonth chain, function-scope write isolation (no caller
 * capture for `=`/decl/tuple), and HTF `time` in epoch ms (chart parity).
 *
 * Run: node tests/unit/test_round199_time_scope.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function bars(n, t0, step) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 100 + (i % 50);
    out.push({ time: t0 + i * step, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 });
  }
  return out;
}
function runIt(src, bb, opts) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 1 }, opts || {}));
    rt.runAll(bb);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
function plotVals(r, idx) {
  if (r.error) return null;
  const key = r.rt.out.plotsOrder[idx || 0];
  return r.rt.out.plots.get(key).values.slice();
}
const ONE = [{ time: 1790600400, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
const HEAD = `//@version=5
indicator("T", overlay=true)
`;

/* 1. dayofweek convention: Sun=1 .. Sat=7 (Oct 2026 reference week) */
{
  const r = runIt(HEAD
    + 'plot(dayofweek(timestamp("GMT", 2026, 10, 4, 0, 0), "GMT"), title="sun")\n'
    + 'plot(dayofweek(timestamp("GMT", 2026, 10, 7, 0, 0), "GMT"), title="wed")\n'
    + 'plot(dayofweek(timestamp("GMT", 2026, 10, 1, 0, 0), "GMT"), title="thu")\n'
    + 'plot(dayofweek(timestamp("GMT", 2026, 10, 3, 0, 0), "GMT"), title="sat")\n'
    + 'plot(dayofweek(timestamp("GMT", 2026, 10, 7, 0, 0), "Europe/Berlin"), title="bert")\n', ONE);
  ok(!r.error, 'dow probe runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(plotVals(r, 0)[0] === 1, 'Sunday=1');
    ok(plotVals(r, 1)[0] === 4, 'Wednesday=4');
    ok(plotVals(r, 2)[0] === 5, 'Thursday=5');
    ok(plotVals(r, 3)[0] === 7, 'Saturday=7');
    ok(plotVals(r, 4)[0] === 4, 'named-tz weekday maps too (Berlin Wed=4)');
  }
}
/* 2. EU DST boundaries through the 786-style chain (2026: Mar 29 / Oct 25) */
{
  const SUN = [
    'sundayOfMonth(yr, mo, week) =>',
    '    firstDay = timestamp("GMT", yr, mo, 1, 0, 0)',
    '    dow = dayofweek(firstDay, "GMT")',
    /* fixture-faithful chain (dow == 1 is Sunday in Pine convention) */
    '    daysToFirstSun = dow == 1 ? 0 : (8 - dow)',
    '    firstSunDay = 1 + daysToFirstSun',
    '    result = 0',
    '    if week == -1',
    '        d = firstSunDay + 21',
    '        while d + 7 <= 31',
    '            d := d + 7',
    '        result := d',
    '    else',
    '        result := firstSunDay + (week - 1) * 7',
    '    result',
  ].join('\n') + '\n';
  const DST = [
    'isEU(y, mo, d) =>',
    '    res = false',
    '    if mo < 3 or mo > 10',
    '        res := false',
    '    else if mo > 3 and mo < 10',
    '        res := true',
    '    else',
    '        lastMar = sundayOfMonth(y, 3, -1)',
    '        lastOct = sundayOfMonth(y, 10, -1)',
    '        if mo == 3',
    '            res := d >= lastMar',
    '        else if mo == 10',
    '            res := d < lastOct',
    '    res',
  ].join('\n') + '\n';
  const r = runIt(HEAD + SUN + DST
    + 'plot(sundayOfMonth(2026, 10, -1), title="lastOct")\n'
    + 'plot(sundayOfMonth(2026, 3, -1), title="lastMar")\n'
    + 'plot(isEU(2026, 10, 7) ? 1 : 0, title="oct7")\n'
    + 'plot(isEU(2026, 10, 26) ? 1 : 0, title="oct26")\n'
    + 'plot(isEU(2026, 3, 29) ? 1 : 0, title="mar29")\n'
    + 'plot(isEU(2026, 3, 28) ? 1 : 0, title="mar28")\n', ONE);
  ok(!r.error, 'DST chain runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(plotVals(r, 0)[0] === 25, 'last Sunday of Oct 2026 = 25 (got ' + plotVals(r, 0)[0] + ')');
    ok(plotVals(r, 1)[0] === 29, 'last Sunday of Mar 2026 = 29 (got ' + plotVals(r, 1)[0] + ')');
    ok(plotVals(r, 2)[0] === 1, 'Oct 7 in DST');
    ok(plotVals(r, 3)[0] === 0, 'Oct 26 out of DST');
    ok(plotVals(r, 4)[0] === 1, 'Mar 29 in DST');
    ok(plotVals(r, 5)[0] === 0, 'Mar 28 out of DST');
  }
}
/* 3. function-scope writes never capture caller scopes */
{
  const r = runIt(HEAD
    + 'inner(int d) =>\n    d = d + 100\n    d\n'
    + 'x = 7\na = inner(1)\nplot(x)\nplot(a)\n', ONE);
  ok(!r.error, 'param shadowing runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(plotVals(r, 0)[0] === 7, 'caller global untouched by callee decl');
    ok(plotVals(r, 1)[0] === 101, 'callee computes on its own local');
  }
  const r2 = runIt(HEAD
    + 'g = 5\nf() =>\n    g = 50\n    g\n'
    + 'fv = f()\nplot(g)\nplot(fv)\n', ONE);
  ok(!r2.error, 'global shadowing runs' + (r2.error ? ' -> ' + r2.error : ''));
  if (!r2.error) {
    ok(plotVals(r2, 0)[0] === 5, 'global keeps its value');
    ok(plotVals(r2, 1)[0] === 50, 'function sees its own local');
  }
  const r3 = runIt(HEAD
    + 'g(int d) =>\n    int d2 = d + 1\n    d2\n'
    + 'h(int d) =>\n    t = g(d)\n    d\n'
    + 'plot(h(7))\n', ONE);
  ok(!r3.error && plotVals(r3, 0)[0] === 7, 'nested calls keep every param intact');
  const r4 = runIt(HEAD
    + 'f(int n) =>\n    [a, b] = [n, n + 1]\n    a + b\n'
    + 'n = 100\nplot(f(1) + n)\n', ONE);
  ok(!r4.error && plotVals(r4, 0)[0] === 103, 'tupledecl stays function-local (1+2+100)');
  const r5 = runIt(HEAD
    + 'tot = 0\nfor i = 0 to 3\n    d = i * 10\n    tot := tot + d\nplot(tot)\n', ONE);
  ok(!r5.error && plotVals(r5, 0)[0] === 60, 'top-level loop decls still work (0+10+20+30)');
  const r6 = runIt(HEAD
    + 'g = 0\ng := 5\nf() =>\n    g\nplot(f() + g)\n', ONE);
  ok(!r6.error && plotVals(r6, 0)[0] === 10, 'functions still read globals');
}
/* 4. HTF `time` is epoch ms (chart parity), incl. history */
{
  const t0 = 1790600400 - (1790600400 % 86400);
  const bb = bars(200, t0, 900); // M15 over ~2 days
  const r = runIt(`//@version=5
indicator("T", overlay=true)
ht = request.security(syminfo.tickerid, "D", time)
plot(ht, title="ht")
plot(ht[1], title="ht1")
plot(time, title="ct")
`, bb, { symbol: 'T', tfSec: 900 });
  ok(!r.error, 'HTF time probe runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const i = bb.length - 1;
    const dayStart = Math.floor(bb[i].time / 86400) * 86400;
    ok(plotVals(r, 0)[i] === dayStart * 1000, 'security D time = day open in ms (got ' + plotVals(r, 0)[i] + ')');
    ok(plotVals(r, 2)[i] === bb[i].time * 1000, 'chart time stays ms');
    const h1 = plotVals(r, 1)[i];
    ok(h1 == null || (typeof h1 === 'number' && h1 % 1000 === 0 && h1 < plotVals(r, 0)[i]), 'time[1] is ms of an earlier bucket (' + h1 + ')');
  }
}

console.log('\nROUND199: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
