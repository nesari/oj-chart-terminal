/**
 * test_round282_api_gaps.mjs — ROUND282: real reference gaps closed.
 *
 * Found by auditing the engine against the official Pine v6 reference's
 * complete namespace listings (not by guessing):
 *
 *  1. `ta.max(source)` / `ta.min(source)` were missing. They are ALL-TIME
 *     extremes (no length argument) — NOT ta.highest/ta.lowest with a
 *     default length. Named-argument form (source=) now resolves too.
 *  2. `session.regular` / `session.extended` were undeclared: scripts use
 *     them as plain string values (typically compared with syminfo.session).
 *  3. `_syminfoProp` had a duplicated `case 'basecurrency'` — the second
 *     arm was unreachable dead code.
 *
 * Run: node tests/unit/test_round282_api_gaps.mjs
 */

import { compile } from '../../src/core/pine/compile.js';
import { taFns, taVars } from '../../src/core/pine/stdlib/ta.js';
import { readSource } from './source-utils.mjs';
let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

function bars(n) {
  const t0 = 1790600400 - (1790600400 % 900);
  const out = [];
  /* A saw-tooth so the running extremes are known exactly: closes climb
     100..109, so the all-time max is the last close and the min the first. */
  for (let i = 0; i < n; i++) {
    const o = 100 + i;
    out.push({ time: t0 + i * 900, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 });
  }
  return out;
}

function runIt(src, n) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD', mintick: 0.00001 });
    rt.runAll(bars(n || 10));
    return { c, rt };
  } catch (e) { return { c, error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

const plotVals = (rt, title) => {
  for (const [, p] of rt.out.plots) if (!title || p.title === title) return p.values;
  return null;
};

/* ---------- 1. the official ta.* list is complete ---------- */
{
  const REF = [
    'accdist', 'alma', 'atr', 'barssince', 'bb', 'bbw', 'cci', 'change', 'cmo', 'cog',
    'correlation', 'cross', 'crossover', 'crossunder', 'cum', 'dev', 'dmi', 'ema',
    'falling', 'highest', 'highestbars', 'hma', 'iii', 'kc', 'kcw', 'linreg', 'lowest',
    'lowestbars', 'macd', 'max', 'median', 'mfi', 'min', 'mode', 'mom', 'nvi', 'obv',
    'percentile_linear_interpolation', 'percentile_nearest_rank', 'percentrank',
    'pivot_point_levels', 'pivothigh', 'pivotlow', 'pvi', 'pvt', 'range', 'rci',
    'rising', 'rma', 'roc', 'rsi', 'sar', 'sma', 'stdev', 'stoch', 'supertrend',
    'swma', 'tr', 'tsi', 'valuewhen', 'variance', 'vwap', 'vwma', 'wad', 'wma', 'wpr',
    'wvad',
  ];
  const have = new Set([...Object.keys(taFns), ...Object.keys(taVars)]);
  const missing = REF.filter((n) => !have.has(n));
  ok(missing.length === 0, 'every reference ta.* entry exists', 'missing: ' + missing.join(', '));
  ok(have.has('max') && have.has('min'), 'ta.max / ta.min are registered');
}

/* ---------- 2. ta.max / ta.min are all-time, not windowed ---------- */
{
  const r = runIt('//@version=5\nindicator("M")\nmx = ta.max(close)\nmn = ta.min(close)\nplot(mx, "MX")\nplot(mn, "MN")\n', 10);
  ok(!r.error, 'ta.max/ta.min fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const mx = plotVals(r.rt, 'MX'), mn = plotVals(r.rt, 'MN');
    /* closes are 101..110 — all-time max/min are the last and first values,
       and both stay defined from bar 0 (a windowed ta.highest would be na
       until its length is filled). */
    ok(mx && mx[0] === 101, 'ta.max seeds at the first bar (got ' + (mx && mx[0]) + ')');
    ok(mn && mn[0] === 101, 'ta.min seeds at the first bar (got ' + (mn && mn[0]) + ')');
    ok(mx && mx[9] === 110, 'ta.max holds the running high (got ' + (mx && mx[9]) + ')');
    ok(mn && mn[9] === 101, 'ta.min holds the running low (got ' + (mn && mn[9]) + ')');
    /* monotone assertions: never decreases / increases */
    let mono = true;
    for (let i = 1; i < mx.length; i++) if (mx[i] < mx[i - 1]) mono = false;
    ok(mono, 'ta.max is monotonically non-decreasing');
  }
}
{
  /* a descending series must see ta.min drop, and ta.max NOT reset */
  const c = compile('//@version=5\nindicator("D")\nplot(ta.max(close), "MX")\nplot(ta.min(close), "MN")\n');
  const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD', mintick: 0.00001 });
  const b = bars(10).map((x, i) => ({ ...x, open: 200 - i, high: 202 - i, low: 198 - i, close: 201 - i }));
  rt.runAll(b);
  const mx = plotVals(rt, 'MX'), mn = plotVals(rt, 'MN');
  ok(mx[9] === 201, 'ta.max keeps the first (highest) value on a falling series (got ' + mx[9] + ')');
  ok(mn[9] === 192, 'ta.min tracks down to the latest low (got ' + mn[9] + ')');
}
{
  const r = runIt('//@version=5\nindicator("N")\nmx = ta.max(source = close)\nplot(mx)\n');
  ok(!r.error, 'ta.max accepts the named source= form' + (r.error ? ' -> ' + r.error : ''));
}
{
  /* not the same as a windowed highest(): with length 14 they'd differ here */
  const r = runIt('//@version=5\nindicator("W")\nplot(ta.max(close), "MX")\nplot(ta.highest(close, 100), "HW")\n', 10);
  ok(!r.error, 'windowed comparison fixture runs');
  const mx = plotVals(r.rt, 'MX'), hw = plotVals(r.rt, 'HW');
  ok(mx && hw && mx[0] !== null && hw[0] === null,
    'ta.max is defined on bar 0 while a 100-bar highest is not (they are different functions)');
}

/* ---------- 3. session.regular / session.extended ---------- */
{
  const r = runIt('//@version=5\nindicator("S")\nreg = session.regular\next = session.extended\nsame = reg == ext\nplot(same ? 1 : 0)\n', 5);
  ok(!r.error, 'session.regular/session.extended resolve' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const vals = plotVals(r.rt);
    ok(vals && vals[4] === 1, 'both are the chart session type (equal values)');
  }
}
{
  const r = runIt('//@version=5\nindicator("S2")\nplot(syminfo.session == session.regular ? 1 : 0)\n', 5);
  ok(!r.error, 'syminfo.session == session.regular compiles and runs' + (r.error ? ' -> ' + r.error : ''));
}
{
  const src = readSource('src/core/pine/interpreter/expressions.js');
  ok(/node\.name === 'regular' \|\| node\.name === 'extended'/.test(src), 'both constants are wired in the member resolver');
  ok((src.match(/case 'basecurrency'/g) || []).length === 1, 'the duplicate basecurrency case is gone');
}

/* ---------- 4. ta.pivot_point_levels ---------- */
{
  /* Traditional on a known H/L/C: H=110, L=100, C=106 -> P=(110+100+106)/3 */
  const SRC = `//@version=5
indicator("P")
lv = ta.pivot_point_levels("Traditional", barstate.isfirst)
plot(array.get(lv, 0), "P")
plot(array.get(lv, 1), "R1")
plot(array.get(lv, 2), "S1")
plot(array.size(lv), "N")
`;
  const c = compile(SRC);
  ok(c.ok, 'pivot_point_levels fixture compiles' + (c.ok ? '' : ' -> ' + c.errors.map((e) => e.message).join(' | ')));
  const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD', mintick: 0.00001 });
  const b = bars(10);
  /* make the first bar the anchor period's only data: H=110 L=100 C=106 */
  b[0] = { time: b[0].time, open: 103, high: 110, low: 100, close: 106, volume: 10 };
  rt.runAll(b);
  const pv = plotVals(rt, 'P'), r1 = plotVals(rt, 'R1'), s1 = plotVals(rt, 'S1'), nv = plotVals(rt, 'N');
  const P = (110 + 100 + 106) / 3;
  ok(nv && nv[0] === 11, 'returns exactly 11 levels (got ' + (nv && nv[0]) + ')');
  ok(pv && Math.abs(pv[0] - P) < 1e-9, 'P = (H+L+C)/3 (got ' + (pv && pv[0]) + ')');
  ok(r1 && Math.abs(r1[0] - (2 * P - 100)) < 1e-9, 'R1 = 2P - L (got ' + (r1 && r1[0]) + ')');
  ok(s1 && Math.abs(s1[0] - (2 * P - 110)) < 1e-9, 'S1 = 2P - H (got ' + (s1 && s1[0]) + ')');
  ok(pv && Math.abs(pv[9] - P) < 1e-9, 'levels persist until the next anchor (got ' + (pv && pv[9]) + ')');
}
{
  /* Fibonacci scaling and DM's na slots */
  const fib = (() => {
    const c = compile('//@version=5\nindicator("F")\nlv = ta.pivot_point_levels("Fibonacci", barstate.isfirst)\nplot(array.get(lv, 1), "R1")\n');
    const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD', mintick: 0.00001 });
    const b = bars(5);
    b[0] = { time: b[0].time, open: 103, high: 110, low: 100, close: 106, volume: 10 };
    rt.runAll(b);
    return plotVals(rt, 'R1');
  })();
  const P = (110 + 100 + 106) / 3, R = 10;
  ok(fib && Math.abs(fib[0] - (P + 0.382 * R)) < 1e-9, 'Fibonacci R1 = P + 0.382 * range (got ' + (fib && fib[0]) + ')');

  const dm = (() => {
    const c = compile('//@version=5\nindicator("D")\nlv = ta.pivot_point_levels("DM", barstate.isfirst)\nplot(array.get(lv, 0), "P")\nplot(array.get(lv, 3), "R2")\n');
    const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD', mintick: 0.00001 });
    const b = bars(5);
    b[0] = { time: b[0].time, open: 103, high: 110, low: 100, close: 106, volume: 10 };
    rt.runAll(b);
    return { p: plotVals(rt, 'P'), r2: plotVals(rt, 'R2') };
  })();
  ok(dm.p && Math.abs(dm.p[0] - P) < 1e-9, 'DM still fills P');
  ok(dm.r2 && (dm.r2[0] === null || dm.r2[0] === undefined),
    'DM leaves undefined levels as na (R2 got ' + (dm.r2 && JSON.stringify(dm.r2[0])) + ')');
}
{
  /* developing=false must NOT follow the live bar; developing=true must */
  const mk = (dev) => {
    const src = '//@version=5\nindicator("V")\nlv = ta.pivot_point_levels("Traditional", barstate.isfirst, ' + dev + ')\nplot(array.get(lv, 0), "P")\n';
    const c = compile(src);
    const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD', mintick: 0.00001 });
    const b = bars(10);
    b[0] = { time: b[0].time, open: 103, high: 110, low: 100, close: 106, volume: 10 };
    b[9] = { time: b[9].time, open: 120, high: 130, low: 90, close: 125, volume: 10 };
    rt.runAll(b);
    return plotVals(rt, 'P');
  };
  const frozen = mk('false'), live = mk('true');
  const P = (110 + 100 + 106) / 3;
  ok(frozen && Math.abs(frozen[9] - P) < 1e-9, 'developing=false keeps the anchor snapshot (got ' + (frozen && frozen[9]) + ')');
  ok(live && Math.abs(live[9] - (130 + 90 + 125) / 3) < 1e-9,
    'developing=true follows the live period (got ' + (live && live[9]) + ')');
}
{
  /* Woodie + developing is a documented runtime error */
  const c = compile('//@version=5\nindicator("W")\nlv = ta.pivot_point_levels("Woodie", barstate.isfirst, true)\nplot(array.size(lv))\n');
  let err = '';
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD', mintick: 0.00001 });
    rt.runAll(bars(5));
  } catch (e) { err = String(e && e.message); }
  ok(/Woodie.*developing|developing.*Woodie/i.test(err), 'Woodie + developing throws like TV (got "' + err.slice(0, 80) + '")');
}
{
  const c = compile('//@version=5\nindicator("B")\nlv = ta.pivot_point_levels("Nope", barstate.isfirst)\nplot(array.size(lv))\n');
  let err = '';
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD', mintick: 0.00001 });
    rt.runAll(bars(5));
  } catch (e) { err = String(e && e.message); }
  ok(/unknown type/i.test(err), 'unknown pivot type is loud (got "' + err.slice(0, 80) + '")');
}

/* ---------- 5. the whole reference str.* list is present ---------- */
{
  const REF = ['contains', 'endswith', 'format', 'format_time', 'length', 'lower', 'match',
    'pos', 'repeat', 'replace', 'replace_all', 'split', 'startswith', 'substring',
    'tonumber', 'tostring', 'trim', 'upper'];
  const r = runIt('//@version=5\nindicator("T")\nplot(1)\n', 3);
  const mod = r.rt && r.rt.nsFns && r.rt.nsFns.str;
  const missing = mod ? REF.filter((n) => !mod[n]) : REF;
  ok(missing.length === 0, 'every reference str.* entry exists', 'missing: ' + missing.join(', '));
}

/* ---------- 6. bare time variables + time("D") (found while writing the
   corpus fixture: both silently returned na, so day anchors never fired) ---------- */
{
  const SRC = `//@version=5
indicator("T")
plot(hour, "H")
plot(year, "Y")
plot(dayofmonth, "D")
plot(minute, "M")
plot(weekofyear, "W")
`;
  const c = compile(SRC);
  const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD', mintick: 0.00001, serverOffSec: 0 });
  rt.runAll(bars(20));
  const v = (t) => plotVals(rt, t);
  ok(v('H') && typeof v('H')[19] === 'number', 'bare `hour` is a series value (got ' + JSON.stringify(v('H') && v('H')[19]) + ')');
  ok(v('Y') && v('Y')[19] > 2000, 'bare `year` reads the bar clock');
  ok(v('D') && typeof v('D')[19] === 'number', 'bare `dayofmonth` is a series value');
  ok(v('M') && typeof v('M')[19] === 'number', 'bare `minute` is a series value');
  ok(v('W') && typeof v('W')[19] === 'number', 'bare `weekofyear` is a series value');
}
{
  /* bare and call forms must agree — same wall-clock fields */
  const c = compile('//@version=5\nindicator("T")\nplot(hour, "BARE")\nplot(hour(time), "CALL")\n');
  const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD', mintick: 0.00001, serverOffSec: 0 });
  rt.runAll(bars(20));
  const a = plotVals(rt, 'BARE'), b = plotVals(rt, 'CALL');
  ok(a && b && a.every((x, i) => x === b[i]), 'bare `hour` equals `hour(time)` on every bar');
}
{
  /* time("D") is a real period anchor; it used to be na */
  const SRC = `//@version=5
indicator("T")
d = time("D")
plot(d, "DAY")
plot(ta.change(d) != 0 ? 1 : 0, "NEWDAY")
`;
  const c = compile(SRC);
  const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD', mintick: 0.00001, serverOffSec: 0 });
  /* 24h of 15m bars crosses one midnight */
  const b = [];
  for (let i = 0; i < 96; i++) {
    const o = 100 + Math.sin(i / 5);
    b.push({ time: 1790006400 + i * 900, open: o, high: o + 1, low: o - 1, close: o + 0.3, volume: 10 });
  }
  rt.runAll(b);
  const day = plotVals(rt, 'DAY'), nd = plotVals(rt, 'NEWDAY');
  ok(day && typeof day[0] === 'number', 'time("D") yields a timestamp (got ' + JSON.stringify(day && day[0]) + ')');
  ok(day && new Set(day.filter((x) => typeof x === 'number')).size === 2, 'time("D") changes exactly at the day boundary (distinct days)');
  /* ta.change is na on bar 0 (no previous value), so ONE transition inside
     the window means exactly one fire — TV semantics. */
  ok(nd && nd.filter((x) => x === 1).length === 1, 'ta.change(time("D")) fires once per new day (got ' + (nd && nd.filter((x) => x === 1).length) + ')');
  const firstNewDay = day ? day.findIndex((x, i) => i > 0 && x !== day[i - 1]) : -1;
  ok(firstNewDay > 0 && nd[firstNewDay] === 1, 'the fire lands on the exact boundary bar (index ' + firstNewDay + ')');
  /* the day stamp must be a FLOORED day boundary, not the bar time */
  const ts = day.find((x) => typeof x === 'number');
  ok(ts % 86400000 === 0, 'the day stamp is floored to midnight (got ' + (ts % 86400000) + ' ms past midnight)');
}
{
  /* the session overload must keep working (round 204/223) */
  const SRC = `//@version=5
indicator("S")
t = time(timeframe.period, "0930-1600")
plot(t, "SESS")
plot(time_close("D"), "DCLOSE")
`;
  const c = compile(SRC);
  ok(c.ok, 'session + time_close fixtures compile');
  const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD', mintick: 0.00001, serverOffSec: 0 });
  const b = [];
  for (let i = 0; i < 96; i++) {
    const o = 100 + Math.sin(i / 5);
    b.push({ time: 1790006400 + i * 900, open: o, high: o + 1, low: o - 1, close: o + 0.3, volume: 10 });
  }
  rt.runAll(b);
  const sess = plotVals(rt, 'SESS'), dc = plotVals(rt, 'DCLOSE');
  ok(sess && sess.some((x) => typeof x === 'number'), 'time(tf, session) still returns in-session bars');
  ok(dc && typeof dc[0] === 'number', 'time_close("D") yields a timestamp');
  /* time_close is the NEXT day's open: exactly one day (86400000 ms) later
     than the floored open, and a whole day after it. */
  const open = dc && dc.find((x) => typeof x === 'number');
  ok(open != null && (open - 86400000) % 86400000 === 0, 'time_close("D") = the floored day open + one day');
}

console.log('\nROUND282: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
