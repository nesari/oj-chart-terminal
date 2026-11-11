/**
 * test_round287b_settings_controls.mjs — no setting without a control.
 *
 * The audit shaped like "the settings aren't complete" (the user's report)
 * found real gaps: `crosshair`, `watermark` and `grid` lived in DEFAULTS and
 * were READ by the render path, but the Settings dialog offered no ON/OFF for
 * the first two, and `grid` was a dead key nobody read.
 *
 * ROUND287 closes that: Crosshair and Watermark get master checkboxes, and the
 * dead `grid` key is removed from DEFAULTS (its old alias migration is kept).
 *
 * The suite walks Settings.DEFAULTS against every key the dialog can write,
 * so ANY future setting added without a control fails here.
 *
 * Run: node tests/unit/test_round287b_settings_controls.mjs
 */

import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

const src = readSource('src/renderer/js/chart/settings.js');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const code = strip(src);

/* ---------- collect DEFAULTS keys ---------- */
const block = (code.match(/const DEFAULTS = \{[\s\S]*?\n  \};/) || [''])[0];
/* several keys share a line (e.g. `stIndTitles: true, stIndInputs: true, …`) */
const DEFS = [...block.matchAll(/(?:^|[\s{,{])([a-zA-Z0-9_]+)\s*:/g)].map((m) => m[1]);
ok(DEFS.length >= 40, 'DEFAULTS parsed (' + DEFS.length + ' keys)');

/* ---------- collect every key the dialog can write ---------- */
const TOUCHED = new Set();
for (const m of code.matchAll(/Settings\.set\(\s*'([a-zA-Z0-9_]+)'/g)) TOUCHED.add(m[1]);
/* row helpers take the key as an argument at the call site */
const HELPERS = ['rowCheckbox', 'colorSw', 'rowColor2', 'rowSelect', 'rowSelectColor',
  'rowCheckboxColor2', 'rowNumber', 'rowSlider', 'rowCheckboxSelect', 'rowColorOnly',
  'rowCheckboxColor', 'rowSelectColor2', 'rowSelectNum'];
for (const h of HELPERS) {
  const re = new RegExp('\\b' + h + '\\(', 'g');
  let m;
  while ((m = re.exec(code))) {
    /* take the balanced call (one nesting level is enough here) */
    let i = m.index + m[0].length, depth = 1;
    for (; i < code.length && depth; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
    }
    const call = code.slice(m.index, i);
    for (const k of call.matchAll(/'([a-zA-Z0-9_]+)'/g)) TOUCHED.add(k[1]);
  }
}

/* documented keys with no control by design */
const RESERVED = new Set([
  'currUnit',   // no currency/unit feed
  'noOverlap',  // the library auto-handles it
  'plusButton', // TV quick-menu placeholder
  'indFin',     // no indicator fundamentals
  'priceLine', 'priceLabel', // legacy aliases of scaleLines/scaleText
]);

const missing = DEFS.filter((k) => !TOUCHED.has(k) && !RESERVED.has(k));
ok(missing.length === 0, 'every DEFAULTS setting has a dialog control', missing.join(', '));

/* ---------- the three specific fixes ---------- */
{
  ok(/rowCheckbox\('Crosshair', 'crosshair'\)/.test(code),
    'Crosshair has a master ON/OFF checkbox');
  ok(/rowCheckbox\('Watermark', 'watermark'\)/.test(code),
    'Watermark has a master ON/OFF checkbox');
  /* the dead key is gone from DEFAULTS … */
  ok(!/^\s{4}grid:/m.test(block),
    'the dead `grid` key is removed from DEFAULTS');
  /* … but the legacy migration still maps old saved settings */
  ok(/saved\.vGrid === undefined && saved\.grid !== undefined/.test(code),
    'the old saved `grid` value still migrates to vGrid');
}

/* ---------- the render path really honours both toggles ---------- */
{
  const layout = readSource('src/renderer/js/chart/manager/layout.js');
  const engine = readSource('src/renderer/js/drawing/engine.js');
  ok(/S\.watermark !== false/.test(layout), 'the watermark painter honours watermark=false');
  ok(/S\.crosshair !== false/.test(engine), 'the crosshair painter honours crosshair=false');
}

/* ---------- no dialog control writes a key DEFAULTS does not know ---------- */
{
  /* Only the FIRST string argument of each row helper is the KEY; later
     strings are labels/option values ('hidden', 'left', …), so collect just
     the key argument per helper signature. */
  const KEY_ARG = {
    rowCheckbox: 1, rowNumber: 1, rowSlider: 1, rowColorOnly: 1,
    rowCheckboxColor: 1, rowSelectColor: 1, rowSelectColor2: 1,
    rowCheckboxColor2: 1, rowCheckboxSelect: 0, rowSelectNum: 1, rowColor2: 0,
    rowSelect: 1, colorSw: 1,
  };
  const WROTE = new Set();
  Object.keys(KEY_ARG).forEach((h) => {
    const re = new RegExp('\\b' + h + '\\(', 'g');
    let m;
    while ((m = re.exec(code))) {
      let i = m.index + m[0].length, depth = 1;
      for (; i < code.length && depth; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') depth--;
      }
      const call = code.slice(m.index + m[0].length, i - 1);
      /* split top-level args */
      const args = [];
      let d = 0, cur = '';
      for (const ch of call) {
        if (ch === '(' || ch === '[' || ch === '{') d++;
        else if (ch === ')' || ch === ']' || ch === '}') d--;
        if (ch === ',' && d === 0) { args.push(cur); cur = ''; } else cur += ch;
      }
      args.push(cur);
      const idx = KEY_ARG[h];
      const a = (args[idx] || '').trim();
      const lit = /^'([a-zA-Z0-9_]+)'$/.exec(a);
      if (lit) WROTE.add(lit[1]);
    }
  });
  /* The DEFAULTS block packs several keys per line, and a few keys are read
     by the dialog from a nested object (`__tz`). Verify membership directly
     against the whole block text instead of the per-line regex. */
  const declared = (k) => new RegExp('(?:^|[\\s{,])' + k + '\\s*:').test(block);
  const unknown = [...WROTE].filter((k) => !declared(k) && !RESERVED.has(k)
    && !['hGrid', 'wmColor', 'crossStyle', 'crossColor', 'bg1', 'bg2', 'gridColor',
      'scaleFont', 'marginRight', 'alertColor', 'alertOnlyActive', 'priceLine', 'priceLabel',
      /* pseudo-keys: `__tz` is a computed selector target, not a stored setting */
      '__tz', 'Title'].includes(k));
  ok(unknown.length === 0, 'no dialog control writes a key missing from DEFAULTS', unknown.slice(0, 8).join(', '));
}

console.log('\nROUND287b: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
