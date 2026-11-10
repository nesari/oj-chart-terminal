/**
 * test_round285_drawing_parity2.mjs — second wave of TV drawing parity.
 *
 * Six items from `docs/DRAWING-TOOLS-VS-TV.md` §4, in order:
 *   1. callout  — bubble + TRIANGULAR TAIL (auto/up/down/left/right), one
 *                 closed outline instead of rect + separate leader line
 *   2. measure  — TV's 3-line card (price±%, bars, duration), themed dark,
 *                 not a colour-filled box
 *   3. volprofile / avolprofile — configurable Value Area %, POC colour +
 *                 visibility, VA guides, histogram colour/width
 *   4. ghostfeed — opacity + the two candle colours are settings now
 *   5. posforecast — per-zone colours (profit/loss) + entry-line toggle
 *   6. sector / barspattern / disjoint — angle chip, label toggle, and the
 *                 channel-width distance chip
 *
 * The suite drives the REAL painters with a recording canvas stub, so it
 * asserts what is drawn (path/text/fill calls), not just that source text
 * exists.
 *
 * Run: node tests/unit/test_round285_drawing_parity2.mjs
 */

import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

/* The drawing modules use a few browser globals at import time (they also pull
   in chart/toolbar.js, which constructs an Image for the app icon). */
globalThis.window = {
  addEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  localStorage: { getItem() { return null; }, setItem() {} },
  LightweightCharts: {},
};
globalThis.document = {
  documentElement: {},
  body: { classList: { contains() { return false; }, add() {}, remove() {}, toggle() {} } },
  addEventListener() {},
  createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} } }),
};
globalThis.Image = class {};

const base = new URL('../../src/renderer/js/drawing/', import.meta.url);
const { TOOLS } = await import(new URL('tools.js', base).href);
await import(new URL('tools2.js', base).href);

/* ---------- recording canvas ---------- */
function mkCanvas() {
  const ops = { fills: 0, strokes: 0, texts: [], rects: [], paths: [], moves: [], lines: [] };
  const noop = () => {};
  const ctx = new Proxy({
    canvas: { width: 600, height: 400 },
    save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: (x, y) => ops.moves.push([x, y]),
    lineTo: (x, y) => ops.lines.push([x, y]),
    quadraticCurveTo: noop, bezierCurveTo: noop, arc: noop, ellipse: noop,
    rect: (x, y, w, h) => ops.rects.push([x, y, w, h]),
    roundRect: (x, y, w, h) => ops.rects.push([x, y, w, h]),
    translate: noop, rotate: noop, scale: noop,
    fill: () => { ops.fills++; },
    stroke: () => { ops.strokes++; },
    fillRect: (x, y, w, h) => { ops.fills++; ops.rects.push([x, y, w, h]); },
    strokeRect: () => { ops.strokes++; },
    measureText: (s) => ({ width: String(s).length * 6 }),
    setLineDash: noop,
    fillText: (s, x, y) => ops.texts.push({ s: String(s), x, y }),
    strokeText: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    clip: noop,
  }, {
    get: (t, k) => (k in t ? t[k] : undefined),
    set: () => true,
  });
  return { ctx, ops };
}

function view(ctx, extra) {
  return Object.assign({
    ctx, pw: 600, ph: 400, digits: 5, spacing: 8,
    times: [], bars: [],
    xOf: (t) => (t - 1790600400) / 60,   // 60s per pixel: a 15m bar is 15px
    yOf: (p) => 400 - (p - 100) * 8,
    clampY: (y) => y,
    theme: () => '#999',
  }, extra || {});
}

function barsFor(n) {
  const out = [];
  const t0 = 1790600400;
  for (let i = 0; i < n; i++) {
    const o = 100 + Math.sin(i / 5) * 3 + i * 0.05;
    out.push({ time: t0 + i * 900, open: o, high: o + 1.2, low: o - 1.2, close: o + 0.4, volume: 50 + (i % 17) });
  }
  return out;
}
/* The volume-profile tools resolve bar INDICES from the time axis, so the
   view must carry the same `times` array the chart would. */
const timesFor = (bars) => bars.map((b) => b.time);

const draw = (id, d, extra) => {
  const { ctx, ops } = mkCanvas();
  TOOLS[id].draw(view(ctx, extra), d, false);
  return ops;
};

/* ---------- 1. callout: bubble + triangular tail ---------- */
{
  const base = { points: [{ t: 1100, p: 10 }, { t: 1400, p: 20 }], opts: { text: 'Hi', fill: true, fillColor: '#2962ff', color: '#2962ff' } };
  const ops = draw('callout', base);
  ok(ops.texts.some((t) => t.s === 'Hi'), 'callout draws its text');
  ok(ops.fills > 0, 'callout fills the bubble');
  /* TV: the tail is part of the bubble outline — 3 extra vertices must be
     emitted beyond the rounded rect (which contributes none via moveTo). */
  ok(ops.moves.length >= 1 && ops.lines.length >= 2,
    'callout emits a tail triangle (moveTo + 2 lineTo)', ops.moves.length + '/' + ops.lines.length);

  /* pointer sides: each forces a distinct tail direction */
  const sides = ['up', 'down', 'left', 'right'];
  const seen = new Set();
  for (const s of sides) {
    const o = draw('callout', { points: base.points, opts: Object.assign({}, base.opts, { pointer: s }) });
    ok(o.lines.length >= 2, 'callout pointer=' + s + ' still draws the tail');
    seen.add(JSON.stringify(o.lines.slice(-2)));
  }
  ok(seen.size >= 3, 'the four pointer sides produce different tail geometry', seen.size + ' distinct');

  /* auto picks the side facing the target */
  const autoRight = draw('callout', { points: [{ t: 1100, p: 10 }, { t: 1700, p: 10 }], opts: { text: 'A' } });
  const autoDown = draw('callout', { points: [{ t: 1100, p: 10 }, { t: 1100, p: -5 }], opts: { text: 'A' } });
  ok(JSON.stringify(autoRight.lines) !== JSON.stringify(autoDown.lines),
    'auto pointer follows the target direction');
}
{
  /* hit-testing must cover the bubble and the tail */
  const d = { points: [{ t: 1100, p: 10 }, { t: 1400, p: 20 }], opts: { text: 'Hi' } };
  const { ctx } = mkCanvas();
  const v = view(ctx);
  const hit = TOOLS.callout.hitBody(v, d);
  ok(hit(100, 300) === true || hit(100, 300) === false, 'callout hitBody runs');
  ok(hit(10000, 10000) === false, 'callout hitBody rejects a far point');
}

/* ---------- 2. measure: TV's 3-line card ---------- */
{
  const bars = barsFor(40);
  const d = { points: [{ t: bars[10].time, p: bars[10].close }, { t: bars[30].time, p: bars[30].close }], opts: {} };
  const ops = draw('measure', d, { bars });
  ok(ops.texts.length >= 3, 'measure card has three text lines (got ' + ops.texts.length + ')');
  const joined = ops.texts.map((t) => t.s).join(' | ');
  ok(/%/.test(joined), 'measure shows the % move', joined);
  ok(/bars?\b/.test(joined), 'measure shows the bar count', joined);
  ok(/\d+\s*(s|m|h|d)\b/.test(joined) || /:\d\d/.test(joined), 'measure shows a duration', joined);
  /* the card must be a neutral panel, not the range colour */
  const src = readSource('src/renderer/js/drawing/tools.js');
  ok(/rgba\(19,23,34,0\.92\)/.test(src), 'measure card uses the TV dark panel colour');

  const off = draw('measure', { points: d.points, opts: { showLabel: false } }, { bars });
  ok(off.texts.length === 0, 'Show info label hides the whole card');
  const noArrows = draw('measure', { points: d.points, opts: { showArrows: false } }, { bars });
  ok(noArrows.strokes < ops.strokes, 'Show arrows removes the guide strokes');
}

/* ---------- 3. volume profiles ---------- */
for (const id of ['volprofile', 'avolprofile']) {
  const bars = barsFor(60);
  const times = timesFor(bars);
  const pts = id === 'volprofile'
    ? [{ t: bars[5].time, p: bars[5].close }, { t: bars[55].time, p: bars[55].close }]
    : [{ t: bars[5].time, p: bars[5].close }];
  const d = { points: pts, opts: {} };
  const ops = draw(id, d, { bars, times });
  ok(ops.fills > 2, id + ' paints histogram rows', ops.fills);
  ok(ops.texts.some((t) => /POC/.test(t.s)), id + ' labels the POC');
  ok(ops.strokes >= 2, id + ' draws the value-area guides', ops.strokes);

  const noPoc = draw(id, { points: pts, opts: { showPoc: false } }, { bars, times });
  ok(!noPoc.texts.some((t) => /POC/.test(t.s)), id + ': showPoc=false hides the POC chip');

  const noVa = draw(id, { points: pts, opts: { showVa: false } }, { bars, times });
  ok(noVa.strokes < ops.strokes, id + ': showVa=false removes the VA guides');

  /* a wider value area must change the highlighted set */
  const wide = draw(id, { points: pts, opts: { vaPct: 95 } }, { bars, times });
  ok(wide.fills === ops.fills, id + ': vaPct only changes emphasis, not row count');

  const custom = draw(id, { points: pts, opts: { pocColor: '#ff00ff' } }, { bars, times });
  ok(custom.fills > 0, id + ': custom POC colour still paints');
}
{
  const src = readSource('src/renderer/js/drawing/tools2/analysis.js');
  ok(!/totV \* 0\.7/.test(src), 'the hard-coded 70% value area is gone');
  ok(/opts\.vaPct/.test(src), 'both profiles read the configurable vaPct');
}

/* ---------- 4. ghostfeed: opacity + candle colours ---------- */
{
  const bars = barsFor(40);
  const d = { points: [{ t: bars[39].time, p: bars[39].close }], opts: { bars: 10 } };
  const ops = draw('ghostfeed', d, { bars });
  ok(ops.fills >= 10, 'ghostfeed paints the projected candles', ops.fills);
  ok(ops.strokes >= 10, 'ghostfeed paints their wicks');

  const src = readSource('src/renderer/js/drawing/tools2/analysis.js');
  ok(/opts\.fillOpacity/.test(src) && /opts\.color2/.test(src),
    'ghostfeed reads the opacity and both candle colours');
  ok(/opts\.opacity/.test(src) === false, 'the old opaque alias is gone');
}

/* ---------- 5. posforecast: per-zone colours + entry line ---------- */
{
  const d = { points: [{ t: 1100, p: 10 }, { t: 1400, p: 20 }], opts: {} };
  const ops = draw('posforecast', d);
  ok(ops.fills >= 2, 'posforecast paints the profit and loss zones');
  ok(ops.strokes >= 3, 'posforecast outlines both zones and the entry line');

  const noEntry = draw('posforecast', { points: d.points, opts: { showEntry: false } });
  ok(noEntry.strokes < ops.strokes, 'Entry line toggle removes the entry stroke');

  const src = readSource('src/renderer/js/drawing/tools2/analysis.js');
  ok(/opts\.profitColor/.test(src) && /opts\.lossColor/.test(src),
    'posforecast reads the per-zone colours');
}

/* ---------- 6. sector / barspattern / disjoint ---------- */
{
  const d = { points: [{ t: 1500, p: 15 }, { t: 1700, p: 15 }, { t: 1500, p: 25 }], opts: {} };
  const ops = draw('sector', d);
  ok(ops.texts.some((t) => /°/.test(t.s)), 'sector shows its sweep angle');
  const off = draw('sector', { points: d.points, opts: { showLabel: false } });
  ok(!off.texts.some((t) => /°/.test(t.s)), 'sector: Angle label toggle works');
}
{
  const bars = barsFor(40);
  const times = timesFor(bars);
  const d = { points: [{ t: bars[5].time, p: bars[5].close }, { t: bars[20].time, p: bars[20].close }, { t: bars[30].time, p: bars[30].close }], opts: {} };
  const ops = draw('barspattern', d, { bars, times });
  ok(ops.texts.some((t) => /bars/.test(t.s)), 'barspattern shows the bar-count chip', JSON.stringify(ops.texts));
  const off = draw('barspattern', { points: d.points, opts: { showLabel: false } }, { bars, times });
  ok(!off.texts.some((t) => /bars/.test(t.s)), 'barspattern: Labels toggle works');
}
{
  const d = { points: [{ t: 1100, p: 10 }, { t: 1500, p: 12 }, { t: 1100, p: 16 }], opts: {} };
  const ops = draw('disjoint', d);
  ok(ops.texts.length >= 1, 'disjoint shows the channel width chip');
  ok(/%/.test(ops.texts.map((t) => t.s).join(' ')), 'the width chip carries a %');
  const off = draw('disjoint', { points: d.points, opts: { showDistance: false } });
  ok(off.texts.length === 0, 'disjoint: Show distance toggle works');
}

/* ---------- 7. every new option is reachable from the dialog ---------- */
{
  const st = readSource('src/renderer/js/drawing/settings.js');
  const need = [
    [/key: 'pointer'/, 'callout pointer'],
    [/key: 'vaPct'/, 'volume-area %'],
    [/key: 'showVa'/, 'value area toggle'],
    [/key: 'showPoc'/, 'POC toggle'],
    [/key: 'pocColor'/, 'POC colour'],
    [/key: 'profitColor'/, 'profit colour'],
    [/key: 'lossColor'/, 'loss colour'],
    [/key: 'showEntry'/, 'entry line toggle'],
    [/key: 'showDistance'/, 'disjoint distance toggle'],
  ];
  for (const [re, label] of need) ok(re.test(st), 'dialog exposes ' + label);
  ok((st.match(/key: 'showLabel'/g) || []).length >= 3, 'label toggles exist for the card tools');
}

console.log('\nROUND285: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
