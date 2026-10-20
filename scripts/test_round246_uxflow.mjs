/**
 * test_round246_uxflow.mjs — ROUND246 creation flows + annotations + gannbox.
 *
 * Static pins over the drawing engine / toolbar / ui / settings sources.
 *
 * Run: node scripts/test_round246_uxflow.mjs
 */

import { readFileSync } from 'fs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const engine = readFileSync('src/renderer/js/drawing/engine.js', 'utf8');
const toolbar = readFileSync('src/renderer/js/chart/toolbar.js', 'utf8');
const ui = readFileSync('src/renderer/js/drawing/ui.js', 'utf8');
const tools = readFileSync('src/renderer/js/drawing/tools.js', 'utf8');
const tools2 = readFileSync('src/renderer/js/drawing/tools2.js', 'utf8');
const settings = readFileSync('src/renderer/js/drawing/settings.js', 'utf8');

/* 1 — staged Escape */
ok(engine.includes('escStep()'), 'engine.escStep exists');
ok(/polyFinish && t\.points\.length > 1\) \{\s*t\.points\.pop\(\)/.test(engine), 'Esc pops the last poly anchor first');
ok(toolbar.includes('p.engine.escStep()') || toolbar.includes('p.engine && p.engine.escStep'), 'toolbar drives escStep');
ok(/stepped = true/.test(toolbar) && /if \(stepped\)/.test(toolbar), 'idle Esc still disarms (old path kept)');

/* 2 — right-click cancels the temp */
{
  const i = engine.indexOf("addEventListener('contextmenu'");
  const blk = engine.slice(i, i + 600);
  ok(blk.includes('if (this.temp)') && blk.includes('this.cancelCreate()'), 'right-click aborts creation');
}

/* 3 — one-shot default, sticky only under the stay lock (ROUND251) */
{
  const i = engine.indexOf('_finish() {');
  const blk = engine.slice(i, engine.indexOf('_beginBodyDrag', i));
  ok(/if \(!App\.stayDraw\) App\.tool = null;\s*if \(UI\.onToolDone\) UI\.onToolDone\(\);\s*if \(!valid\) return;/.test(blk),
    'creation disarms unless the stay lock is on');
  ok((blk.match(/App\.tool = null/g) || []).length >= 2, 'zoom/text/invalid paths still disarm');
}

/* 4 — magnet OFF means free time */
ok(engine.includes("const free = !mode || mode === 'off'"), 'magnet-off branch in snap');
ok(engine.includes('if (free) {') && engine.includes('t = U.logicalToTime(arr, l)'), 'free time interpolates');

/* 5 — annotations back on the menu */
{
  const i = ui.indexOf("title: 'Annotations'");
  const blk = ui.slice(i, i + 200);
  const ids = ['text', 'note', 'callout', 'flagmark', 'arrowmarkl', 'arrowmarkr'];
  ok(ids.every((id) => blk.includes("'" + id + "'")), 'Annotations section lists all 6 tools');
}
for (const id of ['callout', 'flagmark', 'arrowmarkl', 'arrowmarkr']) {
  ok(new RegExp('^    ' + id + ': \\[', 'm').test(tools), 'CTX entry: ' + id);
}

/* 6 — schemas + factory sizes for the marks */
for (const id of ['arrowmarkl', 'arrowmarkr', 'flagmark', 'callout']) {
  ok(new RegExp('SCHEMAS\\.' + id + ' = ').test(settings), 'schema: ' + id);
}
ok(/flagmark: Object\.assign\(\{[^}]*markSize: 26/.test(tools2), 'flagmark factory size');
ok(/arrowmark[lr]: Object\.assign\(\{[^}]*markSize: 22/.test(tools2), 'arrowmark l/r factory size');

/* 7 — position target rides body moves */
ok(engine.includes('bd.onBodyDrag'), 'engine calls the onBodyDrag hook');
ok(/bodyDragState\(d\) \{ return \{ target: d\.opts\.target \}; \},/.test(tools2), 'position snapshots the target');
ok(/onBodyDrag\(d, dp, st\)/.test(tools2), 'position move is absolute from the snapshot');

/* 8 — avwap hit on the painted line */
ok(tools2.includes('_vwapLines = new WeakMap'), 'vwap line cache (WeakMap)');
ok(tools2.includes('_vwapLines.set(d,'), 'draw caches the painted line');
ok(tools2.includes('_vwapLines.get(d)'), 'hitBody reads the cache');

/* 9 — gannbox levels/labels/reverse */
ok(tools2.includes('d.opts.timeLevels') && tools2.includes('d.opts.priceLevels'), 'configurable partitions');
ok(/gannbox: \[[\s\S]*?key: 'timeLevels'/.test(settings), 'gannbox schema has Time levels');
ok(/gannbox: \[[\s\S]*?key: 'reverse'/.test(settings), 'gannbox schema has Reverse');
ok(/gannbox: Object\.assign\(\{[^}]*timeLevels: 8[^}]*showLabels: true/.test(tools2), 'gannbox factory defaults');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
