import { readSource, schemaTable } from './source-utils.mjs';
/**
 * test_round252_style1.mjs — ROUND252 settings batch 1 (labels, infoline,
 * parallel levels, background fills).
 *
 * Run: node tests/unit/test_round252_style1.mjs
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
ok(tools2.includes("import { TOOLS, segWithExtend } from '../tools.js';"), 'segWithExtend import');
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
{
  /* ROUND297: assert the parsed schema table, so the check cannot slide into
     the next tool's entries (and cannot depend on a `SCHEMAS.x =` text pin). */
  const table = schemaTable().table;
  const hasFill = (id) => (table[id] || []).some((it) => /kind: 'fill'/.test(it));
  for (const id of ['polyline', 'curve', 'dblcurve']) {
    ok(hasFill(id), 'schema fill: ' + id);
  }
  ok(hasFill('brush'), 'schema fill: brush');
}
ok((tools2.match(/if \(d\.opts\.fill\) \{\s*ctx\.save\(\);\s*ctx\.globalAlpha = fillAlphaOf\(d\);/g) || []).length >= 4,
  'fill blocks in brush/polyline/curve/dblcurve draws');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
