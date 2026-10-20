import { readSource } from './source-utils.mjs';
/**
 * test_round244_elliott.mjs — ROUND244 Elliott anchors + price ratios + schemas.
 *
 * - every polyTool call: pts === labels.length (R243 found Elliott one short)
 * - polyDraw ratios read price deltas (q.p), never pixel hypot
 * - settings SCHEMAS cover all 11 poly tools (no generic fallback)
 *
 * Run: node tests/unit/test_round244_elliott.mjs
 */

import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const tools2 = readSource('src/renderer/js/drawing/tools2.js');
const settings = readSource('src/renderer/js/drawing/settings.js');

/* 1 — pts matches the label count on every Elliott + pattern tool */
const re = /polyTool\('([\w]+)', '[^']*', '[\w]+', (\d+), \[([^\]]*)\], (true|false)\)/g;
const found = {};
let m;
while ((m = re.exec(tools2)) !== null) {
  const labels = m[3].split(',').map((s) => s.trim()).filter((s) => s.length);
  found[m[1]] = { pts: +m[2], labels: labels.length, ratios: m[4] === 'true' };
}
const expectIds = ['elliott_i', 'elliott_c', 'elliott_t', 'elliott_wxy', 'elliott_wxyxz',
  'xabcd', 'abcd', 'cypher', 'trianglepat', 'threedrives', 'hs'];
ok(Object.keys(found).length === expectIds.length, '11 poly tools found (got ' + Object.keys(found).length + ')');
let match = 0;
for (const id of expectIds) {
  if (found[id] && found[id].pts === found[id].labels) match++;
  else ok(false, id + ' pts(' + (found[id] && found[id].pts) + ') vs labels(' + (found[id] && found[id].labels) + ')');
}
ok(match === expectIds.length, 'pts === labels on all 11 tools');
ok(found.elliott_i.pts === 6 && found.elliott_c.pts === 4 && found.elliott_t.pts === 6 &&
  found.elliott_wxy.pts === 4 && found.elliott_wxyxz.pts === 6, 'Elliott counts 6/4/6/4/6');

/* 2 — ratios are price-space */
ok(tools2.includes('Math.abs(q1.p - q0.p)') && tools2.includes('Math.abs(q2.p - q1.p)'),
  'leg ratios from price deltas');
ok(!tools2.includes('hypot(P[i][0]'), 'pixel-hypot ratios gone');

/* 3 — schemas ( Ratios toggle where the tool supports it) */
const ratioIds = ['elliott_i', 'elliott_c', 'elliott_t', 'elliott_wxy', 'elliott_wxyxz',
  'xabcd', 'abcd', 'cypher', 'threedrives'];
let schem = 0;
for (const id of expectIds) {
  const has = new RegExp('^    ' + id + ': \\[', 'm').test(settings);
  if (has) schem++;
  else ok(false, 'schema missing: ' + id);
}
ok(schem === expectIds.length, 'schemas for all 11 tools');
let tog = 0;
for (const id of ratioIds) {
  const body = settings.slice(settings.indexOf('    ' + id + ': ['), settings.indexOf('    ' + id + ': [') + 200);
  if (/key: 'showRatio'/.test(body)) tog++;
  else ok(false, 'Ratios toggle missing: ' + id);
}
ok(tog === ratioIds.length, 'Ratios toggle on all 9 ratio tools');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
