/**
 * test_round245_fibs.mjs — ROUND245 Fibs/Cycles/Sine geometry.
 *
 * Static pins (bug shapes gone, fixed shapes present) + pure-math mirrors
 * of the rebuilt formulas (speed-fan endpoint, sine price, cyclic family).
 *
 * Run: node tests/unit/test_round245_fibs.mjs
 */

import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const tools = readFileSync('src/renderer/js/drawing/tools.js', 'utf8');
const tools2 = readFileSync('src/renderer/js/drawing/tools2.js', 'utf8');
const settings = readFileSync('src/renderer/js/drawing/settings.js', 'utf8');

/* 1 — fib extension: full level set + two-sided extend */
for (const r of ['0.236', '0.382', '0.786', '1.272', '2,', '3.618']) {
  ok(tools.includes(r), 'FIBEXT_LEVELS has ' + r.replace(',', ''));
}
ok(tools.includes('d.opts.extendLeft ? 0 : x3'), 'fibext extendLeft');
ok(tools.includes('d.opts.extendRight !== false ? v.pw : x3'), 'fibext extendRight (default on)');
ok(tools.includes('levelsOf(d, FIBEXT_LEVELS.map'), 'fibext hit uses the drawn level set');

/* 2 — fib retracement reverse */
ok(tools.includes('d.opts.reverse ? 1 - r : r'), 'levelPrice mirrors on reverse');
ok(/fib: \[[\s\S]*?key: 'reverse'/.test(settings), 'fib schema has Reverse');

/* 3 — fib channel two-sided */
ok(tools2.includes('function fibChanSpan('), 'fibChanSpan helper exists');
ok(!tools2.includes('bx + vx * 400'), 'one-sided channel ray gone');
ok(/fibchannel: \[[\s\S]*?key: 'extendLeft'/.test(settings), 'fibchannel schema has extend toggles');

/* 4 — speed fan rebuilt from A (no mirrors) */
ok(tools2.includes('function speedFanRay('), 'speedFanRay helper exists');
{
  const i = tools2.indexOf('TOOLS.fibspeedfan = {');
  const blk = tools2.slice(i, tools2.indexOf('dragHandle(v, d, i, pt) { d.points[i]', i));
  ok(!blk.includes('[1, -1]'), 'no mirrored rays in speedfan');
  ok(blk.includes('FIBFAN_LEVELS'), 'speedfan uses FIBFAN_LEVELS');
}
ok(tools2.includes('const FIBFAN_LEVELS = [0, 1 / 3,'), 'fan defaults carry thirds');

/* 5 — cyclic lines: single family */
ok(!tools2.includes('v.xOf(t2 +'), 't2-based duplicate family gone');
ok(tools2.includes('kMin') && tools2.includes('kMax'), 'one k-range for base + extends');

/* 6 — sine in data space */
ok(tools2.includes('function sineWave(') && tools2.includes('function sinePrice('), 'sine helpers exist');
ok(tools2.includes('v.pOf(0)'), 'sine amplitude falls back via pOf');
{
  const i = tools2.indexOf('TOOLS.sineline = {');
  const blk = tools2.slice(i, tools2.indexOf('/* ---------------- ROUND 69', i));
  ok(!/[^a-zA-Z]1e5[^0-9]/.test(blk.replace(/1e5px/g, '')), '±1e5px hack gone from sineline');
}

/* 7 — math mirrors */
const fanEnd = (a, b, k) => [b[0], a[1] + (b[1] - a[1]) * k];
{
  const e = fanEnd([100, 500], [300, 100], 0.5);
  ok(e[0] === 300 && e[1] === 300, 'fan k=0.5 crosses the B-vertical at mid (got ' + e + ')');
}
const sineP = (A, B, amp, coeff, t) => A.p + ((B.p - A.p) / (B.t - A.t)) * (t - A.t) +
  amp * Math.sin(((t - A.t) / ((B.t - A.t) / coeff)) * Math.PI * 2);
{
  const A = { t: 0, p: 100 }, B = { t: 100, p: 200 };
  ok(Math.abs(sineP(A, B, 100, 1, 25) - 225) < 1e-9, 'sine locked to time (t=25 -> 225)');
}
{
  const t1 = 0, dt = 100, n = 3, xs = [];
  for (let k = 0; k < n; k++) xs.push(t1 + dt * k);
  ok(JSON.stringify(xs) === '[0,100,200]', 'cyclic base positions');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
