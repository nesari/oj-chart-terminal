/**
 * test_round289_profile_scopes.mjs — volume-profile scopes + callout alignment.
 *
 * Two leftovers from the TV parity wave:
 *   1. volprofile / avolprofile only ever computed ONE range. TV lets the
 *      profile cover the fixed anchors, the anchor's trading SESSION, or the
 *      VISIBLE bars. Both tools also carried a copy-pasted histogram — one
 *      engine now owns it, so a fix lands once.
 *   2. callout ignored the Text tab's horizontal/vertical alignment: every
 *      bubble painted top-left regardless of the setting.
 *
 * The suite drives the real painters with a recording canvas and asserts the
 * observable difference (row spans, text anchor) rather than source text.
 *
 * Run: node tests/unit/test_round289_profile_scopes.mjs
 */

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

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

function mkCanvas() {
  const ops = { fills: 0, strokes: 0, texts: [], rects: [], fillStyles: [] };
  const noop = () => {};
  const ctx = new Proxy({
    font: '', textAlign: 'left', textBaseline: 'top', fillStyle: '',
    canvas: { width: 900, height: 500 },
    save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
    arc: noop, ellipse: noop, rect: noop, roundRect: noop,
    translate: noop, rotate: noop, scale: noop,
    fill: () => { ops.fills++; },
    stroke: () => { ops.strokes++; },
    fillRect: (x, y, w, h) => { ops.fills++; ops.rects.push([x, y, w, h]); },
    strokeRect: noop,
    measureText: (s) => ({ width: String(s).length * 6 }),
    setLineDash: noop,
    fillText: (s, x, y) => ops.texts.push({ s: String(s), x, y, align: ctx.textAlign }),
    createLinearGradient: () => ({ addColorStop: noop }),
    clip: noop,
  }, {
    get: (t, k) => (k in t ? t[k] : undefined),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  return { ctx, ops };
}

const T0 = 1790640000;              // a fixed stamp, aligned to a day
function barsFor(n, daySpan) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 100 + Math.sin(i / 4) * 3 + i * 0.05;
    out.push({ time: T0 + i * 3600, open: o, high: o + 1.5, low: o - 1.5, close: o + 0.4, volume: 10 + (i % 9) });
  }
  return out;
}

function view(ctx, bars, extra) {
  const n = bars.length;
  const xOf = (t) => (t - bars[0].time) / 3600 * 8 + 20;
  return Object.assign({
    ctx, pw: 900, ph: 500, digits: 5, spacing: 8, times: bars.map((b) => b.time), bars,
    serverOffSec: 0,
    xOf, tOf: (x) => bars[0].time + (x - 20) / 8 * 3600,
    yOf: (p) => 460 - (p - 95) * 12,
    clampY: (y) => y, theme: () => '#999',
  }, extra || {});
}

const draw = (id, d, bars, extra) => {
  const { ctx, ops } = mkCanvas();
  try { TOOLS[id].draw(view(ctx, bars, extra), d, false); } catch (e) { return { error: String(e && e.message || e) }; }
  return ops;
};

/* ---------- 1. the shared engine exists only once ---------- */
{
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../../src/renderer/js/drawing/tools2/analysis.js', import.meta.url), 'utf8'));
  ok(/function profileRange\(/.test(src), 'the engine resolves a range');
  ok(/function profileRows\(/.test(src), 'the engine builds rows');
  ok(/function profilePocVa\(/.test(src), 'the engine computes POC + Value Area');
  ok(/function paintProfile\(/.test(src), 'the engine paints');
  ok(/function drawProfile\(v, d, mode/.test(src), 'one entry point drives both tools');
  /* the duplicated bodies are gone */
  ok(!/profColA/.test(src), 'the anchored copy of the painter is gone');
  ok(!/vaPctA/.test(src), 'the anchored copy of the VA math is gone');
  /* both tools delegate */
  const vp = src.slice(src.indexOf('TOOLS.volprofile'), src.indexOf('TOOLS.avolprofile'));
  const av = src.slice(src.indexOf('TOOLS.avolprofile'));
  ok(/drawProfile\(v, d, mode, baseX, maxW\)/.test(vp), 'volprofile delegates to the engine');
  ok(/drawProfile\(v, d, mode, baseX, maxW\)/.test(av), 'avolprofile delegates to the engine');
}

/* ---------- 2. the scopes really select different bar ranges ---------- */
{
  /* 5 days of hourly bars = 120 bars */
  const bars = barsFor(120);
  const mid = bars[60];
  const d = { points: [{ t: bars[30].time, p: bars[30].close }, { t: bars[60].time, p: bars[60].close }], opts: {} };

  /* fixed: exactly the anchored span (30..60) */
  const fixed = draw('volprofile', Object.assign({}, d, { opts: { scope: 'fixed' } }), bars);
  ok(fixed && !fixed.error, 'fixed scope paints' + (fixed && fixed.error ? ': ' + fixed.error : ''));
  ok((fixed.rects || []).length > 3, 'fixed scope paints histogram rows', (fixed.rects || []).length);

  /* session: the anchor day only (24 hourly bars) — different row span */
  const session = draw('volprofile', Object.assign({}, d, { opts: { scope: 'session' } }), bars);
  ok(session && !session.error, 'session scope paints' + (session && session.error ? ': ' + session.error : ''));
  ok((session.rects || []).length > 0, 'session scope paints rows', (session.rects || []).length);

  /* visible: driven by the explicit visibleFrom/visibleTo */
  const visible = draw('volprofile', Object.assign({}, d, { opts: { scope: 'visible' } }), bars,
    { visibleFrom: 0, visibleTo: 119 });
  ok(visible && !visible.error, 'visible scope paints' + (visible && visible.error ? ': ' + visible.error : ''));
  ok((visible.rects || []).length > 0, 'visible scope paints rows');

  /* the POC price must differ between a narrow and a wide range */
  const pocOf = (ops) => {
    const t = (ops.texts || []).find((x) => /^POC/.test(x.s));
    return t ? t.y : null;
  };
  const pocFixed = pocOf(fixed);
  const pocAll = pocOf(visible);
  ok(pocFixed != null && pocAll != null, 'both scopes label their POC', pocFixed + ' / ' + pocAll);
  ok(pocFixed !== pocAll, 'a wider range yields a different POC position', pocFixed + ' vs ' + pocAll);
}

/* ---------- 3. showPoc / showVa still switch things off ---------- */
{
  const bars = barsFor(60);
  const d = { points: [{ t: bars[10].time, p: bars[10].close }, { t: bars[40].time, p: bars[40].close }], opts: {} };
  const on = draw('volprofile', d, bars);
  const noPoc = draw('volprofile', { points: d.points, opts: { showPoc: false } }, bars);
  const noVa = draw('volprofile', { points: d.points, opts: { showVa: false } }, bars);
  ok((on.texts || []).some((t) => /^POC/.test(t.s)), 'POC chip is on by default');
  ok(!(noPoc.texts || []).some((t) => /^POC/.test(t.s)), 'showPoc=false hides it');
  ok((noVa.strokes || 0) < (on.strokes || 0), 'showVa=false removes the guides');
}

/* ---------- 4. avolprofile honours its own scope ---------- */
{
  const bars = barsFor(120);
  const d = { points: [{ t: bars[40].time, p: bars[40].close }], opts: {} };
  const anchor = draw('avolprofile', d, bars);
  const session = draw('avolprofile', Object.assign({}, d, { opts: { scope: 'session' } }), bars);
  ok(anchor && !anchor.error && (anchor.rects || []).length > 0, 'anchor scope paints');
  ok(session && !session.error && (session.rects || []).length > 0, 'session scope paints');
  const ay = (anchor.texts || []).find((t) => /^POC/.test(t.s));
  const sy = (session.texts || []).find((t) => /^POC/.test(t.s));
  ok(ay && sy && ay.y !== sy.y, 'the two scopes disagree on the POC', (ay && ay.y) + ' vs ' + (sy && sy.y));
}

/* ---------- 5. callout text alignment ---------- */
{
  const bars = barsFor(20);
  /* two lines so vertical alignment has room to move */
  const d = { points: [{ t: bars[2].time, p: bars[2].close }, { t: bars[10].time, p: bars[10].close }],
    opts: { text: 'Hello\nWorld', fontSize: 12 } };
  const left = draw('callout', Object.assign({}, d, { opts: Object.assign({}, d.opts, { textHAlign: 'left', textVAlign: 'top' }) }), bars);
  const center = draw('callout', Object.assign({}, d, { opts: Object.assign({}, d.opts, { textHAlign: 'center', textVAlign: 'inside' }) }), bars);
  ok((left.texts || []).length === 2 && (center.texts || []).length === 2, 'callout paints both text lines');
  const l = left.texts[0], c = center.texts[0];
  ok(l.align === 'left', 'left alignment is applied', l.align);
  ok(c.align === 'center', 'center alignment is applied', c.align);
  ok(c.x > l.x, 'centred text starts further right than left-aligned', l.x + ' -> ' + c.x);
  ok(c.y > l.y, 'vertically centred text sits lower than top-aligned', l.y + ' -> ' + c.y);

  const right = draw('callout', Object.assign({}, d, { opts: Object.assign({}, d.opts, { textHAlign: 'right' }) }), bars);
  ok(right.texts[0].align === 'right', 'right alignment is applied');
  ok(right.texts[0].x > c.x, 'right-anchored text sits furthest right', right.texts[0].x);

  const bottom = draw('callout', Object.assign({}, d, { opts: Object.assign({}, d.opts, { textVAlign: 'bottom' }) }), bars);
  ok(bottom.texts[0].y > c.y, 'bottom-anchored text sits lowest', bottom.texts[0].y);

  /* a single line centred vertically equals top-aligned by definition — make
     sure that degenerate case does NOT crash or drift */
  const one = draw('callout', { points: d.points, opts: { text: 'One', textVAlign: 'inside' } }, bars);
  ok((one.texts || []).length === 1, 'a single-line callout still paints once');
}

/* ---------- 6. ghostfeed projection band ---------- */{
  const bars = barsFor(60);
  const d = { points: [{ t: bars[bars.length - 1].time, p: bars[bars.length - 1].close }], opts: {} };
  const withBand = draw('ghostfeed', d, bars);
  const noBand = draw('ghostfeed', { points: d.points, opts: { band: 0 } }, bars);
  const wide = draw('ghostfeed', { points: d.points, opts: { band: 2 } }, bars);
  ok(withBand && !withBand.error, 'ghostfeed paints' + (withBand && withBand.error ? ': ' + withBand.error : ''));
  const withFills = (withBand.fills || 0);
  ok(withFills > (noBand.fills || 0), 'band=1 adds a filled region over the candles', withFills + ' vs ' + (noBand.fills || 0));
  ok((wide.fills || 0) >= withFills, 'a wider band never paints fewer fills', (wide.fills || 0) + ' vs ' + withFills);

  /* the band must be a real statistical width, not a constant: flat closes have
     no residual error, so a band of any k paints nothing extra */
  const flat = bars.map((b, i) => ({ time: b.time, open: 100, high: 100.5, low: 99.5, close: 100, volume: 5 }));
  const flatBand = draw('ghostfeed', { points: [{ t: flat[flat.length - 1].time, p: 100 }], opts: { band: 1 } }, flat);
  const flatNone = draw('ghostfeed', { points: [{ t: flat[flat.length - 1].time, p: 100 }], opts: { band: 0 } }, flat);
  ok((flatBand.fills || 0) === (flatNone.fills || 0), 'zero residual error paints no band', (flatBand.fills || 0) + ' vs ' + (flatNone.fills || 0));

  const { readSource } = await import('./source-utils.mjs');
  const st = readSource('src/renderer/js/drawing/settings.js');
  const gi = st.search(/(?:^|\n)\s{4}ghostfeed:\s*\[/);
  const gs = st.slice(gi, gi + 900);
  ok(/key: 'band', label: 'Projection band'/.test(gs), 'ghostfeed schema exposes the band');
}

/* ---------- 7. measure card rows are independently switchable ---------- */
{
  const bars = barsFor(40);
  const d = { points: [{ t: bars[10].time, p: bars[10].close }, { t: bars[30].time, p: bars[30].close }], opts: {} };
  const all = draw('measure', d, bars);
  ok((all.texts || []).length === 3, 'measure paints all three rows by default', (all.texts || []).length);
  const noBars = draw('measure', { points: d.points, opts: { showBars: false } }, bars);
  ok((noBars.texts || []).length === 2, 'showBars=false drops just the bar row', (noBars.texts || []).length);
  ok(!(noBars.texts || []).some((t) => /bar/.test(t.s)), 'no bar row text remains');
  const noDur = draw('measure', { points: d.points, opts: { showDuration: false } }, bars);
  ok((noDur.texts || []).length === 2, 'showDuration=false drops just the duration row', (noDur.texts || []).length);
  const noPrice = draw('measure', { points: d.points, opts: { showPrice: false } }, bars);
  ok((noPrice.texts || []).length === 2, 'showPrice=false drops just the price row', (noPrice.texts || []).length);
  ok(!(noPrice.texts || []).some((t) => /%/.test(t.s)), 'no price row text remains');
  const none = draw('measure', { points: d.points, opts: { showPrice: false, showBars: false, showDuration: false } }, bars);
  ok((none.texts || []).length === 0, 'hiding every row paints no empty panel', (none.texts || []).length);
  /* the master switch still wins */
  const master = draw('measure', { points: d.points, opts: { showLabel: false } }, bars);
  ok((master.texts || []).length === 0, 'showLabel=false still hides the whole card');

  const { readSource } = await import('./source-utils.mjs');
  const ts = readSource('src/renderer/js/drawing/tools.js');
  ok(/key: 'showPrice'|showPrice !== false/.test(ts), 'measure knows about the price row');
}

/* ---------- 8. posforecast draggable levels ---------- */
{
  const bars = barsFor(40);
  const px = (p) => 460 - (p - 95) * 12;
  const view1 = { pw: 900, ph: 500, digits: 5, spacing: 8, times: bars.map((b) => b.time), bars,
    xOf: (t) => (t - bars[0].time) / 3600 * 8 + 20, yOf: px, theme: () => '#999', clampY: (y) => y };
  const a = { t: bars[10].time, p: 110 }, b = { t: bars[30].time, p: 120 };
  const d = { points: [{ ...a }, { ...b }], opts: { coeff: '2' } };
  const stop = TOOLS.posforecast._stop(view1, d);
  ok(Math.abs(stop - 105) < 1e-9, 'the stop still derives from the coefficient', stop);

  const hs = TOOLS.posforecast.handles(view1, d);
  ok(Array.isArray(hs) && hs.length === 6, 'three levels x two grips = six handles', hs && hs.length);
  const ys = hs.map((h) => Math.round(h[1]));
  ok(ys.includes(Math.round(px(110))), 'entry level has grips');
  ok(ys.includes(Math.round(px(120))), 'target level has grips');
  ok(ys.includes(Math.round(px(105))), 'stop level has grips');

  /* drag the stop grip to 103 -> stored absolutely, coefficient rewritten */
  TOOLS.posforecast.dragHandle(view1, d, 4, { t: bars[20].time, p: 103 });
  ok(d.opts.stop === 103, 'dragging the stop stores its price', d.opts.stop);
  ok(Math.abs(TOOLS.posforecast._stop(view1, d) - 103) < 1e-9, 'the dragged stop is what gets painted');
  /* reward 10 / risk 7 = 1.43 */
  ok(String(d.opts.coeff) === '1.43', 'the coefficient follows the dragged geometry', d.opts.coeff);

  /* a body move must carry the manual stop, not drop it */
  const st = TOOLS.posforecast.bodyDragState(d);
  TOOLS.posforecast.onBodyDrag(d, 5, st);
  ok(Math.abs(d.opts.stop - 108) < 1e-9, 'a body move shifts the manual stop with it', d.opts.stop);

  /* picking a coefficient again must clear the manual override */
  const { readSource } = await import('./source-utils.mjs');
  const ss = readSource('src/renderer/js/drawing/settings.js');
  ok(/fld\.key === 'coeff' && d\.type === 'posforecast'/.test(ss), 'choosing a coefficient clears the dragged stop');

  /* and the target grip is independent of the entry */
  const d2 = { points: [{ ...a }, { ...b }], opts: { coeff: '2' } };
  TOOLS.posforecast.dragHandle(view1, d2, 3, { t: bars[20].time, p: 125 });
  ok(d2.points[1].p === 125 && d2.points[0].p === 110, 'the target grip moves only the target');
}

/* ---------- 9. both schemas expose the scope ---------- */
{
  const { schemaTable } = await import('./source-utils.mjs');
  const { table, keys, duplicates, assignments } = schemaTable();
  /* ROUND297: the table is the ONE source of built-in schemas. A tool must be
     declared exactly once, and no post-table `SCHEMAS.x = [...]` assignment may
     come back — that second source is what silently dropped Scope. */
  ok(duplicates.length === 0, 'no tool is declared twice in the schema table', [...new Set(duplicates)].join(', '));
  ok(assignments.length === 0, 'no built-in schema is assigned outside the table', [...new Set(assignments)].join(', '));
  ok(keys.length >= 70, 'the schema table still covers the whole toolset (' + keys.length + ')');

  const has = (id, re) => (table[id] || []).some((it) => re.test(it));
  ok(has('volprofile', /key: 'scope', label: 'Scope'/), 'volprofile has a Scope select');
  ok(has('volprofile', /'fixed'/) && has('volprofile', /'session'/) && has('volprofile', /'visible'/),
    'volprofile offers fixed/session/visible');
  ok(has('avolprofile', /key: 'scope', label: 'Scope'/), 'avolprofile has a Scope select');
  ok(has('avolprofile', /'anchor'/), 'avolprofile offers anchor');
  /* the rich options survived the de-duplication */
  ok(has('volprofile', /key: 'vaPct'/) && has('volprofile', /key: 'showPoc'/), 'volprofile keeps VA/POC options');
  ok(has('avolprofile', /key: 'vaPct'/) && has('avolprofile', /key: 'showPoc'/), 'avolprofile keeps VA/POC options');
}

console.log('\nROUND289: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
