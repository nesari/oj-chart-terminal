/**
 * verify_pine133.mjs — Pine v6-compat verification for the user's real-world
 * indicator corpus (round 133 scope: legacy v4/v5 scripts from TradingView).
 *
 * Run:  node tests/unit/verify_pine133.mjs
 *
 *  1) every sample-*.pine fixture compiles (or documents its known gap)
 *  2) every compilable fixture RUNS over synthetic bars without throwing
 *  3) regression: the round-74 fixtures stay green
 */

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compile } from '../../src/core/pine/compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', '..', 'fixtures', 'pine');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const synthBars = (n) => {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + i * 0.1 + 10 * Math.sin(i / 12);
    bars.push({ time: 1700000000 + i * 60, open: base, high: base + 1.2, low: base - 1.1, close: base + 0.3, volume: 1000 + i });
  }
  return bars;
};

console.log('\n[1] corpus compile (user samples — target: ALL green)');
const files = readdirSync(FIXTURES).filter((f) => f.startsWith('sample-') && f.endsWith('.pine'));
const compiled = {};
for (const f of files) {
  const src = readFileSync(join(FIXTURES, f), 'utf8');
  const c = compile(src);
  compiled[f] = c;
  ok(c.ok, 'compile ' + f + (c.ok ? ' [' + c.meta.title + ']' : ' -> ' + (c.errors[0] && c.errors[0].message).slice(0, 90)));
}

console.log('\n[2] corpus runtime (synthetic 600 bars)');
for (const f of files) {
  const c = compiled[f];
  if (!c || !c.ok) continue;
  try {
    const inst = c.createInstance({ tfSec: 60, symbol: 'TEST' });
    inst.runAll(synthBars(600));
    ok(true, 'run ' + f + ' (plots=' + inst.out.plotsOrder.length + ')');
  } catch (e) {
    ok(false, 'run ' + f + ' -> ' + String(e && e.message || e).slice(0, 110));
  }
}

console.log('\n[3] regression: engine fixtures');
const engFiles = readdirSync(FIXTURES).filter((f) => f.endsWith('.pine') && !f.startsWith('sample-'));
for (const f of engFiles) {
  const src = readFileSync(join(FIXTURES, f), 'utf8');
  const c = compile(src);
  if (!c.ok) { ok(false, 'compile ' + f + ' -> ' + (c.errors[0] && c.errors[0].message).slice(0, 90)); continue; }
  try {
    const inst = c.createInstance({ tfSec: 60, symbol: 'TEST' });
    inst.runAll(synthBars(600));
    ok(true, 'run ' + f);
  } catch (e) {
    ok(false, 'run ' + f + ' -> ' + String(e && e.message || e).slice(0, 110));
  }
}

console.log('\n[4] ROUND134: rendering parity checks');
{
  const src = readFileSync(join(FIXTURES, 'sample-Supertrend.pine'), 'utf8');
  const c = compile(src);
  const inst = c.createInstance({ tfSec: 60, symbol: 'TEST' });
  inst.runAll(synthBars(400));
  const badText = [];
  for (const [, s] of inst.out.shapes) {
    for (const t of s.texts) if (t && t === 'undefined') badText.push(s.style);
  }
  ok(badText.length === 0, 'no literal "undefined" in shape texts (got: ' + JSON.stringify([...new Set(badText)]) + ')');
  // overlay default: study() w/o overlay must be a SEPARATE pane (TV default)
  const c2 = compile(readFileSync(join(FIXTURES, 'sample-CM_MacD_Ult_MTF.pine'), 'utf8'));
  ok(c2.meta.overlay === false, 'CM_MacD_Ult_MTF (study, no overlay) -> pane, not main');
  ok(c.meta.overlay === true, 'Supertrend (overlay=true) -> main pane');
}

console.log('\n════════════════════════════════════');
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
