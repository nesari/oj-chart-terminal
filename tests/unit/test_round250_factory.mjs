/**
 * test_round250_factory.mjs — ROUND250 drawing factory consistency.
 *
 * The core FACTORY_OPTS (App.drawings.factoryOpts) must agree with the tool
 * engines: fib extension levels, fibchannel entry, fib reverse default.
 * Pure — no storage, no DOM.
 *
 * Run: node tests/unit/test_round250_factory.mjs
 */

import { readFileSync } from 'fs';
import { App } from '../../src/core/state.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const F = (t) => App.drawings.factoryOpts(t);

/* 1 — fibext: full TV level set + extend defaults (R245/R247 backfill) */
const tools = readFileSync('src/renderer/js/drawing/tools.js', 'utf8');
const m = tools.match(/const FIBEXT_LEVELS = \[([^\]]*)\]/);
const codeLevels = m ? m[1].split(',').map((s) => parseFloat(s.trim())) : [];
const facLevels = (F('fibext').levels || []).map((l) => l.r);
ok(JSON.stringify(facLevels) === JSON.stringify(codeLevels),
  'fibext factory levels match the engine list (' + facLevels.length + ' levels)');
ok(F('fibext').extendLeft === false && F('fibext').extendRight === true,
  'fibext extend defaults (left off, right on)');
for (const r of [1.272, 2, 0.236, 3.618]) {
  ok(facLevels.includes(r), 'fibext factory has ' + r);
}

/* 2 — fibchannel entry exists with sane defaults */
{
  const fc = F('fibchannel');
  ok(fc && fc.extendLeft === false && fc.extendRight === true, 'fibchannel extend defaults');
  ok(fc && fc.showRatio === true, 'fibchannel ratios on');
  ok(fc && Array.isArray(fc.levels) && fc.levels.length === 7, 'fibchannel 7 levels');
}

/* 3 — fib reverse default */
ok(F('fib').reverse === false, 'fib reverse defaults off');
ok(F('fib').extendRight === true, 'fib extend-right default kept');
ok(F('fib').showTrend === true, 'fib trend-line default on (R256)');
ok(F('fibext').showTrend === true, 'fibext trend-line default on (R256)');
ok(F('text').border === false, 'text border defaults off (R255)');

/* 4 — factory returns fresh copies (no shared mutation across drawings) */
{
  const a = F('fibext'), b = F('fibext');
  a.levels[0].on = false;
  ok(b.levels[0].on === true, 'factoryOpts deep-copies per call');
}

/* 5 — every factory entry carries the base paint keys (text has no width) */
{
  const names = ['trend', 'fib', 'fibext', 'fibchannel', 'rect'];
  ok(names.every((t) => { const o = F(t); return o && typeof o.color === 'string' && isFinite(o.width); }),
    'base paint keys on ' + names.join(','));
  ok(typeof F('text').color === 'string', 'text factory color');
}

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
