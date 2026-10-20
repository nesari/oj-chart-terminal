/**
 * test_round252_style1.mjs — ROUND252 settings batch 1 (labels, infoline,
 * parallel levels, background fills).
 *
 * Run: node scripts/test_round252_style1.mjs
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

/* 1 — anchored-line label toggles */
ok(tools.includes('if (d.opts.priceLabels !== false) priceTag'), 'hline/hray/crossline price gate');
ok(tools.includes('if (d.opts.showTime !== false) timeTag'), 'vline/crossline time gate');
for (const [id, key] of [['hline', 'priceLabels'], ['hray', 'priceLabels'], ['vline', 'showTime'], ['crossline', 'priceLabels']]) {
  const re = new RegExp('^    ' + id + ": \\[[\\s\\S]*?key: '" + key + "'", 'm');
  ok(re.test(settings), 'schema ' + id + '.' + key);
}
ok(/hline: \{[^}]*priceLabels: true/.test(state), 'hline factory default on');
ok(/vline: \{[^}]*showTime: true/.test(state), 'vline factory default on');

/* 2 — infoline full tab */
ok(tools2.includes("import { TOOLS, segWithExtend } from './tools.js';"), 'segWithExtend import');
ok(tools2.includes('segWithExtend(v, a[0], a[1], b[0], b[1], !!d.opts.extendLeft, !!d.opts.extendRight)'),
  'infoline draw + hit extend');
ok(/infoline: \[[\s\S]*?key: 'extendLeft'/.test(settings), 'infoline schema extends');
ok(/infoline: \[[\s\S]*?key: 'showPrices'/.test(settings), 'infoline schema Prices');
ok(/infoline: Object\.assign\(\{[^}]*extendLeft: false, extendRight: false/.test(tools2), 'infoline factory extends');

/* 3 — parallel Channel's levels */
ok(tools.includes('function parallelOff('), 'parallelOff helper');
ok(tools.includes('for (const lv of levelsOf(d, []))'), 'extra level lines in draw');
ok(/parallel: \[[\s\S]*?kind: 'levels'/.test(settings), 'parallel levels editor');

/* 4 — background fills on open strokes */
for (const id of ['polyline', 'curve', 'dblcurve']) {
  const re = new RegExp("SCHEMAS\\." + id + " = \\[[\\s\\S]*?kind: 'fill'");
  ok(re.test(settings), 'schema fill: ' + id);
}
ok(/SCHEMAS\.brush = \[[\s\S]*?kind: 'fill'/.test(settings), 'schema fill: brush');
ok((tools2.match(/if \(d\.opts\.fill\) \{\s*ctx\.save\(\);\s*ctx\.globalAlpha = fillAlphaOf\(d\);/g) || []).length >= 4,
  'fill blocks in brush/polyline/curve/dblcurve draws');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
