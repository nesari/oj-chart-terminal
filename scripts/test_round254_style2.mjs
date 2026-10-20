/**
 * test_round254_style2.mjs — ROUND254 settings batch 2 (position colors,
 * fork median, volprofile schema, gannbox bg/angles).
 *
 * Run: node scripts/test_round254_style2.mjs
 */

import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const tools2 = readFileSync('src/renderer/js/drawing/tools2.js', 'utf8');
const settings = readFileSync('src/renderer/js/drawing/settings.js', 'utf8');

/* 1 — position stop/target colors */
ok(tools2.includes("d.opts.stopColor || (up ? '#f23645' : '#089981')"), 'stop color routing');
ok(tools2.includes("d.opts.targetColor || (up ? '#089981' : '#f23645')"), 'target color routing');
for (const id of ['positionl', 'positions']) {
  const re = new RegExp('^    ' + id + ": \\[[\\s\\S]*?key: 'stopColor'[\\s\\S]*?key: 'targetColor'", 'm');
  ok(re.test(settings), 'schema colors: ' + id);
}

/* 2 — fork median row */
ok(tools2.includes('d.opts.medianColor || d.opts.color'), 'median color fallback');
ok(tools2.includes('d.opts.medianWidth || d.opts.width'), 'median width fallback');
ok(tools2.includes('d.opts.medianStyle || d.opts.style'), 'median style fallback');
for (const id of ['pitchfork', 'pitchfork_s', 'pitchfork_ms', 'pitchfork_i']) {
  const re = new RegExp('^    ' + id + ": \\[[\\s\\S]*?label: 'Median'[\\s\\S]*?colorKey: 'medianColor'", 'm');
  ok(re.test(settings), 'schema median: ' + id);
}

/* 3 — volprofile schema */
ok(/volprofile: \[[\s\S]*?key: 'bins'/.test(settings), 'volprofile schema (line + Rows)');

/* 4 — gannbox background + angles */
ok(tools2.includes('if (d.opts.fill) {') && tools2.includes('ctx.fillRect(xL, yT, xR - xL, yB - yT);'),
  'gannbox background fill');
ok(tools2.includes('if (d.opts.showAngles) {'), 'gannbox angles branch');
ok(/gannbox: \[[\s\S]*?kind: 'fill'[\s\S]*?key: 'showAngles'/.test(settings), 'gannbox schema rows');
ok(/gannbox: Object\.assign\(\{[^}]*showAngles: false/.test(tools2), 'gannbox factory default');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
