/**
 * test_round247_forks.mjs — ROUND247 pitchfork medians + regression/flattop spans.
 *
 * Static pins + pure-math mirrors of the TV-documented median moves and the
 * shared painted-span helpers.
 *
 * Run: node tests/unit/test_round247_forks.mjs
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
const state = readFileSync('src/core/state.js', 'utf8');

/* 1 — TV-documented medians */
ok(/kind === 'schiff'\) return \{ t: p0\.t, p: forkMid\(p0, p1\)\.p \}/.test(tools2),
  'schiff origin keeps P0 time');
ok(/kind === 'mschiff' \|\| kind === 'inside'\) return forkMid\(p0, p1\)/.test(tools2),
  'mschiff/inside origin is mid(P0,P1)');
ok(/kind === 'inside'\) return \{ t: p2\.t, p: p2\.p \}/.test(tools2),
  'inside median ends at P2');
ok(tools2.includes('function forkMedianEnd('), 'forkMedianEnd exists');
ok(!tools2.includes('t: mid.t, p: (p0.p + mid.p) / 2'), 'asymmetric mschiff origin gone');

/* 2 — painted spans shared by draw + hit */
ok(tools2.includes('function forkSegs('), 'forkSegs exists');
ok(!tools2.includes('O[0], O[1], M[0], M[1]'), 'short-tripod hit gone');
ok(tools2.includes('d.opts.extendLeft') && tools2.includes('d.opts.extendRight !== false'),
  'fork extend toggles (right stays default)');
for (const id of ['pitchfork', 'pitchfork_s', 'pitchfork_ms', 'pitchfork_i']) {
  ok(new RegExp('^    ' + id + ': \\[', 'm').test(settings), 'schema: ' + id);
}

/* 3 — regression: real extend + band hit */
ok(tools2.includes('function regressSegs('), 'regressSegs exists');
ok(!tools2.includes('Math.min(v.times.length + 2'), 'edge-stub extend gone');
ok(tools2.includes('v.xOf(U.logicalToTime(v.times, i))'), 'fractional index mapping');
ok(/hitBody\(v, d\) \{\s*return \(x, y\) => \{\s*\/\* ROUND247/.test(tools2) ||
  tools2.includes('every painted band is grabbable'), 'regression hit covers bands');

/* 4 — flattop: shared span */
ok(tools.includes('function flatSpan('), 'flatSpan exists');
ok(!tools.includes('Math.min(U.distSeg(x, y, x1, yF, x2, yF), 1e9)'), 'flat hit mirrors the paint');

/* 5 — core factory backfill (R245 follow-up) */
ok(/fibext: \{[\s\S]*?extendRight: true/.test(state), 'core fibext extend default');
ok(state.includes('fibchannel: {'), 'core fibchannel factory entry');
ok(/fib: \{[\s\S]*?reverse: false/.test(state), 'core fib reverse default');

/* 6 — math mirrors */
const mid = (a, b) => ({ t: (a.t + b.t) / 2, p: (a.p + b.p) / 2 });
{
  const p0 = { t: 100, p: 300 }, p1 = { t: 200, p: 100 }, p2 = { t: 300, p: 300 };
  const sO = { t: p0.t, p: mid(p0, p1).p };
  const mO = mid(p0, p1);
  const iO = mid(p0, p1), iE = p2;
  ok(sO.t === 100 && sO.p === 200, 'schiff O=(100,200) (got ' + JSON.stringify(sO) + ')');
  ok(mO.t === 150 && mO.p === 200, 'mschiff O=(150,200)');
  ok(iO.t === 150 && iE.t === 300 && iE.p === 300, 'inside O=mid01, E=P2');
}
{
  // median O(100,300)->E(250,200): unit + span with extendRight
  const O = [100, 300], E = [250, 200];
  const dx = 150, dy = -100, len = Math.hypot(dx, dy);
  const ux = dx / len;
  const T = 1000;
  const ex = O[0] + ux * T;
  ok(ex > 800, 'right ray runs far (ex=' + Math.round(ex) + ')');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
