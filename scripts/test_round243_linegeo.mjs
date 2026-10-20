/**
 * test_round243_linegeo.mjs — ROUND243 Lines/Channels geometry + creation undo.
 *
 * Static pins (the exact bug shapes must be gone) + pure-math checks of the
 * fixed formulas (disjoint parallel offset, unclamped channel width,
 * extend-both spanning both viewport edges).
 *
 * Run: node scripts/test_round243_linegeo.mjs
 */

import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const tools = readFileSync('src/renderer/js/drawing/tools.js', 'utf8');
const engine = readFileSync('src/renderer/js/drawing/engine.js', 'utf8');

/* 1 — segWithExtend: one clip over the full span (extend-both keeps both edges) */
ok(tools.includes('eL ? x1 - ux * T : x1') && tools.includes('eR ? x2 + ux * T : x2'),
  'extend clips one span from the left edge to the right edge');
ok(!tools.includes('xa = c[2]'), 'extend-both overwrite (xa = c[2]) is gone');

/* 2 — disjoint line 2 carries the normal offset (shared helper, draw + hit) */
ok(tools.includes('function disjP2(g)'), 'disjP2 helper exists');
ok(tools.includes('const [P2a, P2b] = disjP2(g);'), 'draw + hitBody share disjP2');
ok(!tools.includes('g.A[0] + g.ux * g.s,'), 'offset-less P2a is gone');
ok(tools.includes('Math.min(g.len, g.s + g.len)'), 'overlap end is min(len, s+len)');
ok(!tools.includes('Math.max(g.s, 0) + g.len'), 'over-fill o1 is gone');

/* 3 — parallel channel: unclamped projection to the infinite line */
ok(!tools.includes('U.clamp(((x3 - x1)'), 'draw projection unclamped');
ok(!tools.includes('U.clamp(((P[2][0]'), 'hitBody projection unclamped');

/* 4 — creation pushes an undo step (Ctrl+Z removes a fresh drawing) */
ok(/App\.drawings\.add\(this\.pane\.symbol, d\);\s*\/\* ROUND243[\s\S]*?App\.undo.+kind: 'add'/.test(engine),
  '_finish pushes {kind:add} after drawings.add');

/* 5 — pure math mirrors of the fixed formulas */
const disjP2 = (A, B, C) => {
  const dx = B[0] - A[0], dy = B[1] - A[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const s = (C[0] - A[0]) * ux + (C[1] - A[1]) * uy;
  const off = (C[0] - A[0]) * nx + (C[1] - A[1]) * ny;
  return [[A[0] + ux * s + nx * off, A[1] + uy * s + ny * off],
    [A[0] + ux * (s + len) + nx * off, A[1] + uy * (s + len) + ny * off]];
};
{
  const [a, b] = disjP2([100, 300], [300, 300], [300, 200]);
  ok(a[0] === 300 && a[1] === 200 && b[0] === 500 && b[1] === 200,
    'disjoint line 2 through click 3, parallel (got ' + JSON.stringify([a, b]) + ')');
}
const chanOff = (P1, P2, P3) => {
  const dx = P2[0] - P1[0], dy = P2[1] - P1[1];
  const t = ((P3[0] - P1[0]) * dx + (P3[1] - P1[1]) * dy) / (dx * dx + dy * dy || 1);
  return [P3[0] - (P1[0] + t * dx), P3[1] - (P1[1] + t * dy)];
};
{
  const [ox, oy] = chanOff([100, 300], [300, 300], [400, 200]);
  ok(ox === 0 && oy === -100, 'click past the segment keeps TV width (got ' + ox + ',' + oy + ')');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
