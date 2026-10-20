/**
 * test_round253_icons.mjs — ROUND253 every drawing-tool icon resolves.
 *
 * icon() silently falls back to I.x, so a typo'd glyph ships invisible.
 * This pins: every TOOLS icon id + toolbar group base + stay/emoji exists
 * in the icon set, and the five Elliott degrees use distinct glyphs.
 *
 * Run: node scripts/test_round253_icons.mjs
 */

import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const tools = readFileSync('src/renderer/js/drawing/tools.js', 'utf8');
const tools2 = readFileSync('src/renderer/js/drawing/tools2.js', 'utf8');
const ui = readFileSync('src/renderer/js/drawing/ui.js', 'utf8');
const icons = readFileSync('src/renderer/js/ui/icons.js', 'utf8');

/* icon-set keys */
const keys = new Set();
for (const m of icons.matchAll(/^    ([a-zA-Z0-9_]+): [SF]\(/gm)) keys.add(m[1]);

/* every TOOLS icon value */
const want = new Set();
for (const src of [tools, tools2]) {
  for (const m of src.matchAll(/icon: '([a-zA-Z0-9_]+)'/g)) want.add(m[1]);
}
/* toolbar group bases */
for (const m of ui.matchAll(/base: '([a-zA-Z0-9_]+)'/g)) want.add(m[1]);
want.add('stay');

let missing = 0;
for (const id of want) {
  if (!keys.has(id)) { missing++; ok(false, 'missing glyph: ' + id); }
}
ok(missing === 0, 'all ' + want.size + ' glyph ids resolve');

/* Elliott degrees are visually distinct (R248 shared one glyph) */
const glyphOf = {};
for (const id of ['elliott_i', 'elliott_c', 'elliott_t', 'elliott_wxy', 'elliott_wxyxz']) {
  const m = icons.match(new RegExp('^    ' + id + ": S\\('(.*)'\\),$", 'm'));
  glyphOf[id] = m ? m[1] : null;
  ok(!!m, 'distinct glyph defined: ' + id);
}
ok(new Set(Object.values(glyphOf)).size === 5, 'all five Elliott glyphs differ');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
