import { readSource } from './source-utils.mjs';
/**
 * test_round255_style3.mjs — ROUND255 settings batch 3 (text border,
 * regression source + side bands).
 *
 * Run: node tests/unit/test_round255_style3.mjs
 */

import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const tools = readSource('src/renderer/js/drawing/tools.js');
const tools2 = readSource('src/renderer/js/drawing/tools2.js');
const settings = readSource('src/renderer/js/drawing/settings.js');
const state = readSource('src/core/state.js');

/* 1 — text border */
ok(tools.includes('if (d.opts.border) {'), 'text border branch in draw');
ok(tools.includes('d.opts.borderColor || d.opts.color'), 'border falls back to text color');
ok(/text: \[[\s\S]*?key: 'border'[\s\S]*?key: 'borderColor'/.test(settings), 'text schema rows');
ok(/text: \{[^}]*border: false/.test(state), 'text factory default off');

/* 2 — regression source */
ok(tools2.includes('function regress(bars, times, t0, t1, src)'), 'regress takes a source');
for (const s of ["'hlc3'", "'hl2'", "'ohlc4'"]) {
  ok(tools2.includes(s), 'source variant ' + s);
}
ok(/regression: \[[\s\S]*?key: 'source'/.test(settings), 'regression schema Source');

/* 3 — regression side bands */
ok(tools2.includes('const upOn = d.opts.upShow !== false'), 'upper gate');
ok(tools2.includes('dnOn = d.opts.downShow !== false') || tools2.includes('const upOn = d.opts.upShow !== false, dnOn = d.opts.downShow !== false'),
  'lower gate');
ok(tools2.includes('rs.upColor || d.opts.color') && tools2.includes('rs.dnColor || d.opts.color'),
  'band colors route with base fallback');
ok(/regression: \[[\s\S]*?key: 'upColor'[\s\S]*?key: 'downColor'/.test(settings), 'regression schema colors');
ok(/regression: Object\.assign\(\{[^}]*source: 'close'[^}]*upShow: true[^}]*downShow: true/.test(tools2),
  'regression factory defaults');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
