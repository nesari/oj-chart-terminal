/**
 * test_round210_xsym_ticker.mjs — ROUND210 static ticker prefetch + stdev biased.
 *
 * Engine side: ta.stdev biased flag (sample vs population) incl. named form;
 * cross-symbol errors carry the retry-loop message. The pine-ui scanner
 * itself (regex over literal ticker handles) is pinned live by
 * e2e_round210_xsym_ticker.py via the xsymPairs debug probe.
 *
 * Run: node tests/unit/test_round210_xsym_ticker.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const T0 = 1790600400 - (1790600400 % 900);
const BARS = Array.from({ length: 12 }, (_, i) => ({
  time: T0 + i * 900, open: 100 + i, high: 100 + i + 0.6, low: 100 + i - 0.6,
  close: 100 + i + 0.5, volume: 10,
}));
const HEAD = '//@version=5\nindicator("T", overlay=true)\n';
function runIt(body, bars) {
  const c = compile(HEAD + body);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', mintick: 0.01 });
    rt.runAll(bars || BARS);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 300) }; }
}
const last = (rt, name) => {
  const r = rt.globals.get(name);
  return r && r.hist ? r.hist.a[r.hist.a.length - 1] : 'missing';
};

/* ---------- stdev biased ---------- */
{
  // closes 100.5..111.5 step 1, L=5: biased sqrt(2), unbiased sqrt(2.5)
  const b = runIt('v = ta.stdev(close, 5)\nplot(v)\n');
  const u = runIt('v = ta.stdev(close, 5, false)\nplot(v)\n');
  const t = runIt('v = ta.stdev(close, 5, true)\nplot(v)\n');
  ok(!b.error && !u.error && !t.error, 'stdev runs all forms' + ([b.error, u.error, t.error].filter(Boolean).join(' / ') || ''));
  if (!b.error && !u.error && !t.error) {
    const vb = last(b.rt, 'v'), vu = last(u.rt, 'v'), vt = last(t.rt, 'v');
    ok(Math.abs(vb - Math.SQRT2) < 1e-9, 'biased default sqrt(2) (got ' + vb + ')');
    ok(Math.abs(vu - Math.sqrt(2.5)) < 1e-9, 'unbiased sqrt(2.5) (got ' + vu + ')');
    ok(vt === vb, 'explicit true == default');
  }
}
{
  const r = runIt('v = ta.stdev(source=close, length=5, biased=false)\nplot(v)\n');
  ok(!r.error && Math.abs(last(r.rt, 'v') - Math.sqrt(2.5)) < 1e-9, 'stdev all-named with biased');
}
{
  // L=1 edge: unbiased would divide by zero -> falls back safely, no throw/Inf
  const r = runIt('v = ta.stdev(close, 1, false)\nplot(na(v) ? -1 : v)\n');
  ok(!r.error && isFinite(last(r.rt, 'v')), 'stdev L=1 unbiased safe');
}

/* ---------- cross-symbol error message (retry-loop wording) ---------- */
{
  const r = runIt('t = ticker.renko("NOPE/XYZ", "60", 2)\nplot(request.security(t, "", close))\n');
  ok(!!r.error && /no history for "NOPE\/XYZ"/.test(r.error) && /retried/.test(r.error),
    'synth missing-data message' + (r.error ? ' -> ' + r.error.slice(0, 120) : ''));
}
{
  const r = runIt('plot(request.security("NOPE/XYZ", "60", close))\n');
  ok(!!r.error && /no history for/.test(r.error) && /retried/.test(r.error),
    'plain missing-data message reworded' + (r.error ? ' -> ' + r.error.slice(0, 120) : ''));
}

console.log('\nROUND210: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
