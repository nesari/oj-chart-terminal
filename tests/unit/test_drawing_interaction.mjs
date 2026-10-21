/**
 * Drawing interaction regression suite (ROUND257).
 *
 * These are the paint/hit-test contracts that are easy to regress but hard to
 * see in a source grep: extended rays must be grabbable, filled shapes must
 * answer inside their fill, right-to-left-safe geometry must stay stable, and
 * the settings factory must not disagree with what the renderer paints.
 *
 * Run: node tests/unit/test_drawing_interaction.mjs
 */

import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 FAIL: ' + label); }
};

/* The drawing modules use a few browser globals at import time. */
globalThis.window = {
  addEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  localStorage: { getItem() { return null; }, setItem() {} },
};
globalThis.document = {
  documentElement: {},
  addEventListener() {},
  createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }),
};
globalThis.Image = class {};

const base = new URL('../../src/renderer/js/drawing/', import.meta.url);
const { TOOLS } = await import(new URL('tools.js', base).href);
const { App } = await import(new URL('../../../core/state.js', base).href);
await import(new URL('tools2.js', base).href);

/* Screen space is deliberately simple: t -> x = t - 1000, p -> y = 2000 - p. */
const ctx = {
  font: '',
  save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
  closePath() {}, stroke() {}, fill() {}, arc() {}, ellipse() {}, rect() {},
  setLineDash() {}, fillText() {}, strokeRect() {}, fillRect() {}, clip() {},
  measureText: (s) => ({ width: String(s).length * 8 }),
};
const view = {
  ctx, w: 862, h: 626, pw: 800, ph: 600, mainH: 600, axisW: 62, timeH: 26,
  digits: 2, spacing: 10, tfSec: 60, times: [], bars: [],
  xOf: (t) => t - 1000,
  yOf: (p) => 2000 - p,
};
const P = (t, p) => ({ t, p });
const hit = (tool, d, x, y) => {
  try { return !!TOOLS[tool].hitBody(view, d)(x, y); }
  catch (e) { console.log('    hitBody threw:', e && e.message); return false; }
};

console.log('\n-- extended lines / rays are grabbable along the painted span --');
{
  const d = (extra) => ({ type: 'trend', points: [P(1000, 1900), P(1200, 1800)], opts: Object.assign({ width: 2 }, extra) });
  ok(hit('trend', d({ extendRight: true }), 500, 350), 'trend extend-right body hit beyond B');
  ok(!hit('trend', d({}), 500, 350), 'trend without extend keeps the old segment-only body');
  const ray = d({});
  ok(hit('ray', ray, 500, 350), 'ray body hit beyond B');
  const ext = d({});
  ok(hit('extended', ext, 500, 350), 'extended line body hit beyond B');
  const arrow = d({});
  ok(!hit('arrow', arrow, 500, 350), 'arrow body does not extend');
}

console.log('\n-- extended boxes / fibs --');
{
  const r = { type: 'rect', points: [P(1000, 1900), P(1200, 1800)], opts: { width: 2, fill: false, extendRight: true } };
  ok(hit('rect', r, 500, 100), 'extended rectangle top edge is selectable');
  const f = { type: 'fib', points: [P(1100, 1900), P(1300, 1800)], opts: { width: 1, extendLeft: true, extendRight: true } };
  ok(hit('fib', f, 20, 150), 'fib left extension is selectable');
  ok(hit('fib', f, 500, 150), 'fib right extension is selectable');
}

console.log('\n-- filled interiors --');
{
  const tri = { type: 'triangle', points: [P(1000, 2000), P(1200, 2000), P(1100, 1800)], opts: { width: 2, fill: true } };
  ok(hit('triangle', tri, 100, 50), 'filled triangle interior hit');
  const line = { type: 'polyline', points: [P(1000, 2000), P(1200, 2000), P(1200, 1800), P(1000, 1800)], opts: { width: 2, fill: true } };
  ok(hit('polyline', line, 50, 50), 'filled polyline interior hit');
  const curve = { type: 'curve', points: [P(1000, 2000), P(1200, 2000), P(1100, 1800)], opts: { width: 2, fill: true } };
  ok(hit('curve', curve, 100, 50), 'filled curve interior hit');
}

console.log('\n-- date range is full-height --');
{
  const dr = { type: 'daterange', points: [P(1100, 1900), P(1300, 1800)], opts: { width: 1 } };
  ok(hit('daterange', dr, 150, 500), 'date range hit outside its anchor price band');
}

console.log('\n-- annotation geometry --');
{
  const n = { type: 'note', points: [P(1000, 2000)], opts: { text: 'Note', fontSize: 24, color: '#f7c948' } };
  ok(hit('note', n, 40, 0), 'note hit inside the painted bubble');
  ok(!hit('note', n, 100, 0), 'note no longer has a 250px-wide invisible hit box');
}

console.log('\n-- fib/gann bodies follow the painted rays --');
{
  const fc = { type: 'fibcircles', points: [P(1000, 2000), P(1200, 1800)], opts: { levels: [{ r: 1, c: '#2962ff', on: true }] } };
  ok(hit('fibcircles', fc, 200, 0), 'fib circle 1.0 ring is selectable');
  const pf = { type: 'pitchfan', points: [P(1000, 2000), P(1200, 2000), P(1000, 1800)], opts: { levels: [{ r: 0.5, c: '#2962ff', on: true }] } };
  ok(hit('pitchfan', pf, 107.6, 38.3), 'pitchfan middle ray is selectable');
  const sp = { type: 'fibspiral', points: [P(1000, 2000), P(1200, 2000)], opts: { coeff: 1.6180339887, turns: 3 } };
  ok(hit('fibspiral', sp, 0, 323.6), 'fib spiral quarter-turn is selectable');
}

console.log('\n-- factory/settings agreement --');
{
  const fc = App.drawings.factoryOpts('fibchannel');
  ok(fc.extendRight === true && fc.extendLeft === false, 'fibchannel factory paints right-extended by default');
  ok(App.drawings.factoryOpts('callout').fill === true, 'callout Background factory default is on');
  ok(App.drawings.factoryOpts('flagmark').fill === true, 'flag Background factory default is on');
  ok(App.drawings.factoryOpts('sector').fill === true, 'sector Background factory default is on');
}

console.log('\n-- source contracts for interaction paths --');
{
  const engine = fs.readFileSync('src/renderer/js/drawing/engine.js', 'utf8');
  const settings = fs.readFileSync('src/renderer/js/drawing/settings.js', 'utf8');
  ok(/const l0 = Math\.floor\(lr\.from\), l1 = Math\.ceil\(lr\.to\);[\s\S]*?logicalToCoordinate\(l0\)[\s\S]*?logicalToCoordinate\(l1\)/.test(engine),
    'magnet-off placement interpolates over the plot, not the full canvas');
  ok(/if \(App\.hideAll\) return null;[\s\S]*?DrawSettings\.isVisible\(d, v\.tfSec\)/.test(engine),
    'hit-testing skips hidden drawings and the Visibility tab filter');
  ok(/if \(wasTemp && App\.undo\)[\s\S]*?kind: 'add'/.test(settings),
    'committed Text/Note creation pushes an undo step');
  ok(/gannsquare: \[/.test(settings) && /gannsquaref: \[/.test(settings) && /gannfan: \[/.test(settings),
    'Gann Square/Fixed/Fan have real Style schemas');
}

console.log(`\nDRAWING INTERACTION: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
