/**
 * test_round211_session_flags.mjs — ROUND211 request.* session + flag parity.
 *
 * ticker.new(..., session) filters source bars before bucketing (GMT wall);
 * ignore_invalid_symbol=true turns missing data into na; ta.variance takes
 * biased (L vs L-1) incl. the named form.
 *
 * Run: node tests/unit/test_round211_session_flags.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

/* Monday 2026-10-05, 08:00..17:45 UTC, 15m bars, rising closes. */
const T0 = Date.UTC(2026, 9, 5, 8, 0, 0) / 1000;
const BARS = Array.from({ length: 40 }, (_, i) => ({
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
const hist = (rt, name) => rt.globals.get(name).hist.a.slice();
const isNAv = (v) => v && v.__pineNA === true;

/* ---------- ticker.new session filter ---------- */
{
  const f = runIt('t = ticker.new("X", syminfo.tickerid, "0900-1600")\nr = request.security(t, "60", close)\nplot(r)\n');
  const u = runIt('r = request.security(syminfo.tickerid, "60", close)\nplot(r)\n');
  ok(!f.error && !u.error, 'session ticker runs' + (f.error ? ' -> ' + f.error : ''));
  if (!f.error && !u.error) {
    const fh = hist(f.rt, 'r'), uh = hist(u.rt, 'r');
    ok(isNAv(fh[2]) && !isNAv(uh[2]), '08:30 bar: filtered na, unfiltered numeric');
    /* Same rules both sides: 09:00 is the filtered series' FIRST bucket, so
       bar 6 takes the first-bucket edge rule (own-bucket final, close[7]);
       unfiltered reads the previous closed bucket (close[3]). */
    ok(fh[6] === 100 + 7 + 0.5 && uh[6] === 100 + 3 + 0.5,
      '09:30 bar: filtered first-bucket edge, unfiltered prev-closed (got ' + JSON.stringify(fh[6]) + '/' + JSON.stringify(uh[6]) + ')');
  }
}
{
  // daily destination: filtered day ends at the last in-session bar
  const f = runIt('t = ticker.new("X", syminfo.tickerid, "0900-1600")\nr = request.security(t, "D", close)\nplot(r)\n');
  const u = runIt('r = request.security(syminfo.tickerid, "D", close)\nplot(r)\n');
  ok(!f.error && !u.error, 'daily session runs');
  if (!f.error && !u.error) {
    const fh = hist(f.rt, 'r'), uh = hist(u.rt, 'r');
    ok(fh[39] === 100 + 31 + 0.5 && uh[39] === 100 + 39 + 0.5,
      'filtered day ends 15:45, unfiltered 17:45 (got ' + JSON.stringify(fh[39]) + '/' + JSON.stringify(uh[39]) + ')');
  }
}
{
  const r = runIt('t = ticker.new("X", syminfo.tickerid, na, "0900-1600")\nplot(request.security(t, "60", close))\n');
  ok(!r.error, 'session_regular filters when session empty' + (r.error ? ' -> ' + r.error : ''));
}
{
  const r = runIt('t = ticker.new("X", "T", "blah")\nplot(1)\n');
  ok(!!r.error && /session/.test(r.error), 'garbage session loud at creation' + (r.error ? ' -> ' + r.error.slice(0, 90) : ''));
}
{
  // all bars outside the session -> na, not a crash
  const r = runIt('t = ticker.new("X", syminfo.tickerid, "0000-0100")\nr = request.security(t, "60", close)\nplot(r)\n');
  ok(!r.error && hist(r.rt, 'r').every(isNAv), 'fully-excluded session reads na');
}

/* ---------- ignore_invalid_symbol ---------- */
{
  const r = runIt('r = request.security("NOPE/XYZ", "60", close, ignore_invalid_symbol=true)\nplot(r)\n');
  ok(!r.error && hist(r.rt, 'r').every(isNAv), 'invalid symbol -> na with flag');
}
{
  const r = runIt('r = request.security("NOPE/XYZ", "60", close)\nplot(r)\n');
  ok(!!r.error && /no history for/.test(r.error), 'invalid symbol still loud without flag');
}

/* ---------- variance biased ---------- */
{
  // step-1 closes, L=5: biased var 2, unbiased 2.5
  const b = runIt('v = ta.variance(close, 5)\nplot(v)\n');
  const u = runIt('v = ta.variance(close, 5, false)\nplot(v)\n');
  ok(!b.error && !u.error, 'variance runs');
  if (!b.error && !u.error) {
    const hb = hist(b.rt, 'v'), hu = hist(u.rt, 'v');
    ok(hb[11] === 2 && hu[11] === 2.5, 'biased 2 vs unbiased 2.5 (got ' + hb[11] + '/' + hu[11] + ')');
  }
}
{
  const r = runIt('v = ta.variance(source=close, length=5, biased=false)\nplot(v)\n');
  ok(!r.error && hist(r.rt, 'v')[11] === 2.5, 'variance all-named');
}

console.log('\nROUND211: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
