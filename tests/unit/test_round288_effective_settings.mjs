/**
 * test_round288_effective_settings.mjs — a setting must DO something.
 *
 * The ROUND287 audit found settings that were declared and even shown in the
 * dialog but never read by any render path ("reserved" placeholders). To a
 * user that is worse than a missing feature: the control moves and nothing
 * happens.
 *
 * ROUND288 resolves each of them one of two ways:
 *
 *   IMPLEMENTED  indFin      -> hides indicator values in the legend
 *                stIndValues -> same gate (was declared but never read)
 *                stIndTitles -> hides the whole indicator legend row
 *                navButtons  -> (already worked) toggles nav-button classes
 *
 *   REMOVED      currUnit    -> no currency/unit metadata in the feed
 *                noOverlap   -> the chart library lays labels out itself
 *                plusButton  -> no crosshair quick-add button exists
 *                paneButtons -> no pane button group exists
 *
 * The rule this suite enforces: every key in Settings.DEFAULTS is either
 * READ somewhere in the render path, or it does not exist at all.
 *
 * Run: node tests/unit/test_round288_effective_settings.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const settingsSrc = readSource('src/renderer/js/chart/settings.js');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const block = (strip(settingsSrc).match(/const DEFAULTS = \{[\s\S]*?\n  \};/) || [''])[0];
const DEFS = [...block.matchAll(/(?:^|[\s{,{])([a-zA-Z0-9_]+)\s*:/g)].map((m) => m[1]);
ok(DEFS.length > 60, 'DEFAULTS parsed (' + DEFS.length + ' keys)');

/* ---------- every DEFAULTS key is READ somewhere outside settings.js ---------- */
{
  const files = walk(path.join(ROOT, 'src'));
  const all = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  /* a key counts as "read" when some code tests it (S.key / conf.key / c.key /
     C().key). settings.js itself applies many of them inside applyAll(), so it
     is INCLUDED in the scan. */
  const PERSIST_ONLY = new Set([
    'stIndInputs',   // rendered by the legend row builder itself
    'lockRatio',     // consumed by the chart library option builder
    'marginTop', 'marginBottom', 'marginRight', // fed into the price-scale margins
    'precision',     // ditto
  ]);
  const unread = DEFS.filter((k) => {
    if (PERSIST_ONLY.has(k)) return false;
    const patterns = [
      new RegExp('\\bS\\.' + k + '\\b'),
      new RegExp('\\bconf\\.' + k + '\\b'),
      new RegExp('\\bc\\.' + k + '\\b'),
      new RegExp('C\\(\\)\\.' + k + '\\b'),
      new RegExp('Settings\\.conf\\.' + k + '\\b'),
    ];
    return !patterns.some((re) => re.test(all));
  });
  ok(unread.length === 0, 'every DEFAULTS setting is read by the render path', unread.join(', '));
}

/* ---------- the four "reserved" keys are gone ---------- */
{
  for (const k of ['currUnit', 'noOverlap', 'plusButton', 'paneButtons']) {
    ok(!DEFS.includes(k), 'dead setting removed: ' + k);
    /* and no control pretends to offer it */
    ok(!new RegExp("'" + k + "'").test(settingsSrc), 'no dialog control references ' + k);
  }
  /* the still-useful one stays */
  ok(DEFS.includes('navButtons'), 'navButtons is kept (it is implemented)');
}

/* ---------- the implemented ones really gate the legend ---------- */
{
  const ind = readSource('src/renderer/js/chart/indicators-ui.js');
  ok(/S\.stIndValues !== false/.test(ind), 'stIndValues gates the value text');
  ok(/S\.stIndTitles === false/.test(ind), 'stIndTitles hides the whole legend row');
  ok(/S\.indFin !== 'hidden'/.test(ind), 'indFin hides indicator values');
  /* the gate must be evaluated before values are written (measured from the
     executable body, not the leading comment) */
  const body = ind.slice(ind.indexOf('function updateRowValues'));
  const gate = body.indexOf('const showVals');
  const write = body.indexOf('valsEl.innerHTML');
  ok(gate > -1 && write > gate, 'the gate is checked before the values are painted', gate + '/' + write);
}

/* ---------- nothing in the dialog is a "hint-only" checkbox anymore ---------- */
{
  /* the old plusButton row carried a hint promising a feature that did not
     exist — that class of control must never come back */
  const plus = readSource('src/renderer/js/chart/settings.js');
  ok(!/quick-add plus button/.test(plus), 'the phantom "plus button" hint is gone');
}

/* ---------- the reserved-key allow-list in the R287b suite still matches ---------- */
{
  const r287b = readSource('tests/unit/test_round287b_settings_controls.mjs');
  /* RESERVED must not still list keys that no longer exist */
  const reservedBlock = (r287b.match(/const RESERVED = new Set\(\[[\s\S]*?\]\);/) || [''])[0];
  for (const k of ['currUnit', 'noOverlap', 'plusButton', 'paneButtons']) {
    ok(!reservedBlock.includes("'" + k + "'"), 'the R287b allow-list no longer carries removed key ' + k);
  }
}

console.log('\nROUND288: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
