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
const { DrawSettings } = await import(new URL('settings.js', base).href);
const { UI } = await import(new URL('ui.js', base).href);
const { Undo } = await import(new URL('../core/undo.js', base).href);

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
  const fc = { type: 'fib', points: [P(1000, 1900), P(1200, 1800)], opts: { width: 1, showTrend: true, levels: [{ r: 0.5, c: '#2962ff', on: true }] } };
  ok(hit('fib', fc, 50, 125), 'fib painted A-B connector is selectable outside the level band');
  const fe = { type: 'fibext', points: [P(1000, 2000), P(1100, 1900), P(1200, 2000)], opts: { levels: [{ r: 0.382, c: '#2962ff', on: true }, { r: 0.618, c: '#2962ff', on: true }], showTrend: true } };
  ok(hit('fibext', fe, 50, 50), 'visible fib extension connector is selectable');
  const feOff = { type: 'fibext', points: [P(1000, 2000), P(1100, 1900), P(1200, 2000)], opts: { levels: [{ r: 0.382, c: '#2962ff', on: true }, { r: 0.618, c: '#2962ff', on: true }], showTrend: false } };
  ok(!hit('fibext', feOff, 50, 50), 'hidden fib extension connector is not selectable');
}

console.log('\n-- filled interiors --');
{
  const tri = { type: 'triangle', points: [P(1000, 2000), P(1200, 2000), P(1100, 1800)], opts: { width: 2, fill: true } };
  ok(hit('triangle', tri, 100, 50), 'filled triangle interior hit');
  const line = { type: 'polyline', points: [P(1000, 2000), P(1200, 2000), P(1200, 1800), P(1000, 1800)], opts: { width: 2, fill: true } };
  ok(hit('polyline', line, 50, 50), 'filled polyline interior hit');
  const disj = { type: 'disjoint', points: [P(1000, 2000), P(1200, 2000), P(1100, 1900)], opts: { width: 2, fill: true } };
  ok(hit('disjoint', disj, 150, 50), 'filled disjoint channel interior hit');
  const curve = { type: 'curve', points: [P(1000, 2000), P(1200, 2000), P(1100, 1800)], opts: { width: 2, fill: true } };
  ok(hit('curve', curve, 100, 50), 'filled curve interior hit');
  const wedge = { type: 'fibwedge', points: [P(1000, 2000), P(1200, 2000), P(1100, 1800)], opts: { width: 2, fill: true } };
  ok(hit('fibwedge', wedge, 100, 50), 'filled fib wedge interior hit');
  const brush = { type: 'brush', points: [P(1000, 2000), P(1200, 2000), P(1200, 1800), P(1000, 1800)], opts: { width: 2, fill: true } };
  ok(hit('brush', brush, 50, 50), 'filled brush interior hit');
  const brushHollow = { type: 'brush', points: [P(1000, 2000), P(1200, 2000), P(1200, 1800), P(1000, 1800)], opts: { width: 2, fill: false } };
  ok(!hit('brush', brushHollow, 50, 50), 'hollow brush keeps its interior empty');
  const sector = { type: 'sector', points: [P(1000, 2000), P(1200, 2000), P(1000, 1800)], opts: { width: 2, fill: true } };
  ok(hit('sector', sector, 50, 50), 'filled sector interior hit');
  const sectorHollow = { type: 'sector', points: [P(1000, 2000), P(1200, 2000), P(1000, 1800)], opts: { width: 2, fill: false } };
  ok(!hit('sector', sectorHollow, 50, 50), 'hollow sector keeps its interior empty');
}

console.log('\n-- box middle line is selectable --');
{
  const box = { type: 'rect', points: [P(1000, 2000), P(1200, 1900)], opts: { width: 2, fill: false, middle: true } };
  ok(hit('rect', box, 100, 50), 'hollow box middle line hit');
  const noMid = { type: 'rect', points: [P(1000, 2000), P(1200, 1900)], opts: { width: 2, fill: false, middle: false } };
  ok(!hit('rect', noMid, 100, 50), 'hollow box without middle line keeps its interior empty');
}

console.log('\n-- regression background is selectable --');
{
  const oldTimes = view.times, oldBars = view.bars;
  view.times = Array.from({ length: 10 }, (_, i) => 1000 + i * 10);
  view.bars = view.times.map((_, i) => ({ open: i % 2 ? 1100 : 1000, close: i % 2 ? 1100 : 1000, high: i % 2 ? 1110 : 1010, low: i % 2 ? 990 : 1000, volume: 1 }));
  try {
    const rg = { type: 'regression', points: [P(1000, 2000), P(1090, 2000)], opts: { width: 2, fill: true, devs: [10], source: 'close' } };
    ok(hit('regression', rg, 50, 980), 'filled regression interior hit');
    ok(!hit('regression', rg, 50, 1500), 'regression background does not cover the whole viewport');
  } finally {
    view.times = oldTimes; view.bars = oldBars;
  }
}

console.log('\n-- volume profiles hit their painted histogram --');
{
  const oldTimes = view.times, oldBars = view.bars;
  view.times = Array.from({ length: 10 }, (_, i) => 1000 + i * 10);
  view.bars = view.times.map(() => ({ low: 1800, high: 2000, volume: 10 }));
  try {
    const vp = { type: 'volprofile', points: [P(1000, 1500), P(1090, 1500)], opts: { width: 1 } };
    ok(hit('volprofile', vp, 40, 100), 'fixed-range profile hit inside its price span');
    ok(!hit('volprofile', vp, 40, 400), 'fixed-range profile ignores empty space outside its price span');
    const avp = { type: 'avolprofile', points: [P(1000, 1500)], opts: { width: 1 } };
    ok(hit('avolprofile', avp, 100, 100), 'anchored profile hit inside its price span');
    ok(!hit('avolprofile', avp, 100, 400), 'anchored profile ignores empty space outside its price span');
  } finally {
    view.times = oldTimes; view.bars = oldBars;
  }
}

console.log('\n-- ghost feed hit follows the projected candles --');
{
  const oldBars = view.bars;
  view.bars = Array.from({ length: 20 }, (_, i) => ({
    close: 1000 + i * 50, high: 1005 + i * 50, low: 995 + i * 50,
  }));
  try {
    const g = { type: 'ghostfeed', points: [P(1000, 1000)], opts: { bars: 10 } };
    ok(hit('ghostfeed', g, 40, 700), 'ghost feed hit inside a projected candle far from the anchor');
    ok(!hit('ghostfeed', g, 40, 1200), 'ghost feed ignores space below the projection');
  } finally {
    view.bars = oldBars;
  }
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
  const longCallout = { type: 'callout', points: [P(1000, 2000), P(1300, 1700)], opts: { text: 'x'.repeat(30), fontSize: 24 } };
  ok(hit('callout', longCallout, 200, 0), 'callout hit follows a bubble widened by long text');
  const shortCallout = { type: 'callout', points: [P(1000, 2000), P(1300, 1700)], opts: { text: 'Hi', fontSize: 12 } };
  ok(!hit('callout', shortCallout, 100, 0), 'short callout no longer has a 180px-wide invisible hit box');
}

console.log('\n-- fib/gann bodies follow the painted rays --');
{
  const fc = { type: 'fibcircles', points: [P(1000, 2000), P(1200, 1800)], opts: { levels: [{ r: 1, c: '#2962ff', on: true }] } };
  ok(hit('fibcircles', fc, 200, 0), 'fib circle 1.0 ring is selectable');
  const pf = { type: 'pitchfan', points: [P(1000, 2000), P(1200, 2000), P(1000, 1800)], opts: { levels: [{ r: 0.5, c: '#2962ff', on: true }] } };
  ok(hit('pitchfan', pf, 107.6, 38.3), 'pitchfan middle ray is selectable');
  const sp = { type: 'fibspiral', points: [P(1000, 2000), P(1200, 2000)], opts: { coeff: 1.6180339887, turns: 3 } };
  ok(hit('fibspiral', sp, 0, 323.6), 'fib spiral quarter-turn is selectable');
  ok(hit('fibspiral', sp, 100, 0), 'fib spiral defining trend is selectable');
  const spNoTrend = { type: 'fibspiral', points: [P(1000, 2000), P(1200, 2000)], opts: { coeff: 1.6180339887, turns: 3, showTrend: false } };
  ok(!hit('fibspiral', spNoTrend, 100, 0), 'hidden fib spiral trend is not selectable');
}

console.log('\n-- trend-based fib time follows Trend Line visibility --');
{
  const ft = { type: 'fibttime', points: [P(1000, 2000), P(1100, 1900), P(1200, 2000)], opts: { showTrend: true } };
  ok(hit('fibttime', ft, 50, 50), 'visible fibttime trend is selectable');
  const ftOff = { type: 'fibttime', points: [P(1000, 2000), P(1100, 1900), P(1200, 2000)], opts: { showTrend: false } };
  ok(!hit('fibttime', ftOff, 50, 50), 'hidden fibttime trend is not selectable');
}

console.log('\n-- factory/settings agreement --');
{
  const fc = App.drawings.factoryOpts('fibchannel');
  ok(fc.extendRight === true && fc.extendLeft === false, 'fibchannel factory paints right-extended by default');
  ok(App.drawings.factoryOpts('callout').fill === true, 'callout Background factory default is on');
  ok(App.drawings.factoryOpts('flagmark').fill === true, 'flag Background factory default is on');
  ok(App.drawings.factoryOpts('sector').fill === true, 'sector Background factory default is on');
}

console.log('\n-- visibility defaults --');
{
  const legacy = { opts: { vis: { min: { on: false } } } };
  ok(!DrawSettings.isVisible(legacy, 300), 'an explicitly hidden interval stays hidden');
  ok(DrawSettings.isVisible(legacy, 3600), 'a visibility group missing from legacy data defaults to visible');
}

console.log('\n-- undo selection binding --');
{
  const prevData = App.drawings.data;
  const prevSel = App.selection;
  const prevChanged = UI.onSelectionChanged;
  const prevButtons = Undo._buttons;
  const prevStack = Undo._stack;
  const prevIdx = Undo._idx;
  UI.onSelectionChanged = () => {};
  Undo._buttons = () => {};
  Undo._stack = [];
  Undo._idx = 0;
  App.drawings.data = {
    EURUSD: {
      next: 3,
      items: [
        { id: 1, type: 'trend', points: [], opts: {} },
        { id: 2, type: 'trend', points: [], opts: {} },
      ],
    },
  };
  App.selection = { pane: { symbol: 'EURUSD' }, d: App.drawings.data.EURUSD.items[1] };
  Undo.removeAll({ symbol: 'EURUSD' });
  Undo.undo();
  ok(App.drawings.list('EURUSD').length === 2, 'undo removeAll restores the bucket');
  ok(App.selection && App.selection.d === App.drawings.data.EURUSD.items[1],
    'selection re-binds to the restored live drawing object');
  App.drawings.data = prevData;
  App.selection = prevSel;
  UI.onSelectionChanged = prevChanged;
  Undo._buttons = prevButtons;
  Undo._stack = prevStack;
  Undo._idx = prevIdx;
}

console.log('\n-- malformed drawing persistence --');
{
  const prevData = App.drawings.data;
  App.drawings.data = {
    BAD: [],
    EURUSD: { next: 'x', items: 'nope' },
    XAUUSD: { next: 1, items: [null, { id: 7, type: 'trend', points: [], opts: {} }] },
  };
  ok(App.drawings.list('BAD').length === 0, 'list tolerates a malformed bucket');
  const repaired = App.drawings.bucket('EURUSD');
  ok(Array.isArray(repaired.items) && repaired.next === 1,
    'bucket repairs missing items/next instead of throwing');
  const advanced = App.drawings.bucket('XAUUSD');
  ok(advanced.next === 8, 'bucket advances next past existing drawing ids');
  App.drawings.data = prevData;
}

console.log('\n-- source contracts for interaction paths --');
{
  const engine = fs.readFileSync('src/renderer/js/drawing/engine.js', 'utf8');
  const settings = fs.readFileSync('src/renderer/js/drawing/settings.js', 'utf8');
  const ui = fs.readFileSync('src/renderer/js/drawing/ui.js', 'utf8');
  const objects = fs.readFileSync('src/renderer/js/panels/objects.js', 'utf8');
  const app = fs.readFileSync('src/renderer/js/app.js', 'utf8');
  const toolbar = fs.readFileSync('src/renderer/js/chart/toolbar.js', 'utf8');
  const undo = fs.readFileSync('src/renderer/js/core/undo.js', 'utf8');
  const tabs = fs.readFileSync('src/renderer/js/chart/tabs.js', 'utf8');
  ok(/const l0 = Math\.floor\(lr\.from\), l1 = Math\.ceil\(lr\.to\);[\s\S]*?logicalToCoordinate\(l0\)[\s\S]*?logicalToCoordinate\(l1\)/.test(engine),
    'magnet-off placement interpolates over the plot, not the full canvas');
  ok(/const w = this\.view\(\)\.pw;[\s\S]{0,140}?const px = U\.clamp\(x/.test(engine),
    'wheel zoom is anchored within the plot width, not the full canvas');
  ok(/if \(App\.hideAll\) return null;[\s\S]*?DrawSettings\.isVisible\(d, v\.tfSec\)/.test(engine),
    'hit-testing skips hidden drawings and the Visibility tab filter');
  ok(/if \(wasTemp && App\.undo\)[\s\S]*?kind: 'add'/.test(settings),
    'committed Text/Note creation pushes an undo step');
  ok(/gannsquare: \[/.test(settings) && /gannsquaref: \[/.test(settings) && /gannfan: \[/.test(settings),
    'Gann Square/Fixed/Fan have real Style schemas');
  ok(/gannbox: \[[\s\S]*?key: 'diagColor'[\s\S]*?key: 'diag2Color'/.test(settings),
    'Gann Box exposes both diagonal colors');
  ok(/Clone<\/span>[\s\S]*?App\.drawings\.add\(pane\.symbol, copy\);[\s\S]{0,140}?App\.undo\.push\(\{ kind: 'add'/.test(ui),
    'Clone/Copy from the context bar pushes an undo step');
  ok(/Array\.isArray\(copy\.opts\.ctrls\)[\s\S]{0,180}?c\.t \+ 6 \* 60/.test(ui),
    'Clone shifts Path/Polyline bend controls with the anchors');
  ok(/p\.engine && p\.engine\._timeArr[\s\S]{0,160}?timeToLogical\(arr, pt\.t\)/.test(objects),
    'Object Tree Locate uses the gap-inclusive session time frame');
  ok(/typeof d\.opts\.vis !== 'object'[\s\S]{0,160}?defaultVis\(\)/.test(ui),
    'context-menu visibility materialises malformed vis data');
  ok(/const after = JSON\.parse\(JSON\.stringify\(\{ opts: d\.opts, points: d\.points \}\)\);[\s\S]{0,220}?kind: 'modify'/.test(settings),
    'Ok in drawing settings registers a modify undo step');
  ok(/let v = d\.opts\.vis\[f\.key\];[\s\S]{0,170}?typeof v !== 'object'/.test(settings),
    'Visibility tab materialises groups missing from legacy drawings');
  ok(/DS_ACTIVE[\s\S]{0,260}?closeFor = function/.test(settings) && /DrawSettings\.closeFor\(sd\)/.test(engine),
    'click-away cancels the uncommitted Text/Note dialog');
  ok(/UI\.discardTemp = function[\s\S]{0,160}?DrawSettings\.closeFor/.test(ui) && /UI\.discardTemp\(sd\)/.test(toolbar),
    'Escape also cancels the uncommitted Text/Note dialog');
  ok(/const alive = \(App\.drawings\.list\(d\.symbol\)[\s\S]{0,160}?App\.undo\.push/.test(settings),
    'Ok on a discarded temp drawing leaves no phantom undo step');
  ok(/UI\.closeSettingsFor\(d, true\)/.test(undo) && /UI\.closeActiveSettings\(true\)/.test(undo) &&
     /UI\.closeSettingsFor = function[\s\S]{0,140}?closeFor/.test(ui),
    'deleting a drawing closes its open settings dialog');
  ok(/deleted while the dialog was open[\s\S]{0,420}?kind: 'modify'/.test(settings),
    'Ok on a drawing deleted while its dialog was open pushes no phantom modify');
  ok(/if \(DS_ACTIVE\) \{[\s\S]{0,140}?DS_ACTIVE\.d === d\) return[\s\S]{0,100}?DS_ACTIVE\.close\(true\)/.test(settings),
    'opening another drawing settings dialog closes the previous one');
  ok(/function close\(commit\) \{[\s\S]{0,180}?if \(!dlg && DS_ACTIVE !== session\) return/.test(settings),
    'double Escape cannot close a drawing dialog twice');
  ok(/id === 'trash'[\s\S]{0,320}?App\.undo\.removeAll/.test(ui),
    'left-toolbar trash-all is undoable');
  ok(/id === 'eye'[\s\S]{0,420}?App\.hideAll && App\.selection[\s\S]{0,80}?App\.selection = null/.test(ui),
    'hide-all clears the current selection');
  ok(/getElementById\('obj-trash'\)[\s\S]{0,420}?App\.undo\.removeAll/.test(objects) &&
     /mkAct\('trash', 'Delete'[\s\S]{0,160}?App\.undo\.remove\(pane, d\)/.test(objects),
    'Object Tree delete and trash-all are undoable');
  ok(/const modalOpen = !!document\.querySelector\('\.dialog-backdrop, \.ds-dialog'\);[\s\S]{0,120}?e\.key !== 'Escape'[\s\S]{0,40}?return;/.test(app),
    'chart shortcuts do not fire behind an open dialog');
  ok(/beforeunload[\s\S]{0,300}?App\.drawings\.saveNow\(\)/.test(app),
    'closing the app flushes pending drawing saves');
  ok(/r\.panes\.every\(\(p\) => p && typeof p === 'object' && p\.symbol\)/.test(tabs),
    'a tab with a corrupt secondary pane is rejected on restore');
  ok(/Array\.isArray\(rec\.panes\)[\s\S]{0,180}?filter\(\(p\) => p && typeof p === 'object' && p\.symbol\)/.test(tabs),
    'tab restore filters invalid panes before rebuilding the layout');
  ok(/_restore\(rec\) \{[\s\S]{0,260}?UI\.closeActiveSettings\(true\)/.test(tabs),
    'switching tabs closes the floating drawing settings dialog');
  ok(/if \(e\.repeat\) return;[\s\S]{0,520}?querySelector\('\.dialog-backdrop, \.ds-dialog'\)/.test(tabs),
    'held Ctrl+W and open dialogs cannot close tabs');
  ok(/d\.hidden = !d\.hidden;[\s\S]{0,320}?App\.selection = null/.test(objects),
    'hiding a drawing clears its selection');
}

console.log(`\nDRAWING INTERACTION: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
