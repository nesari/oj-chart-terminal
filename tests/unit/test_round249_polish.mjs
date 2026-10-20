import { readSource } from './source-utils.mjs';
/**
 * test_round249_polish.mjs — ROUND249 freehand handles + bend controls ride.
 *
 * Run: node tests/unit/test_round249_polish.mjs
 */

import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const tools2 = readSource('src/renderer/js/drawing/tools2.js');
const engine = readSource('src/renderer/js/drawing/engine.js');

/* 1 — freehand end handle maps to the LAST point */
ok(/const j = i === 0 \? 0 : d\.points\.length - 1;\s*if \(d\.points\[j\]\)/.test(tools2),
  'end handle writes points[length-1]');
ok(!/dragHandle\(v, d, i, pt\) \{ if \(d\.points\[i\]\) d\.points\[i\] =/.test(tools2),
  'index passthrough gone');

/* 2 — dead highlighter key removed */
ok(!tools2.includes("style: 'solid', fillOpacity: 0.35"), 'dead fillOpacity key gone');
ok(tools2.includes("App.registerFactoryOpts('highlighter', { color: '#f7c948', width: 14, style: 'solid', borderOpacity: 0.35 })"),
  'factory still carries the live borderOpacity');

/* 3 — bend controls snapshot + ride (generic, path + polyline) */
ok(engine.includes('ctrls: null') === false, 'no stray ctrls init (snapshot is conditional)');
ok(/ctrls = d\.opts\.ctrls\.map\(\(c\) => \(c \? \{ t: c\.t, p: c\.p, l: U\.timeToLogical\(arr, c\.t\) \} : null\)\)/.test(engine),
  'drag-start snapshots ctrls with logical');
ok(/d\.opts\.ctrls = this\.bodyDrag\.ctrls\.map\(\(o\) => \(o\s*\? \{ t: U\.logicalToTime\(arr, o\.l \+ shift\), p: o\.p \+ dp \}\s*: o\)\)/.test(engine),
  'move shifts ctrls absolutely');
ok(engine.includes('d.opts.ctrls.length === this.bodyDrag.ctrls.length'), 'length guard before rewrite');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
