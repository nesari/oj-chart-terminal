/**
 * test_round151_corpus.mjs — ROUND151 corpus: all 5 heavy indicators compile + run
 *
 * Run: node scripts/test_round151_corpus.mjs
 *
 * Acceptance for the corpus-compile milestone (PINE-COMPLIANCE-PLAN §7):
 * every file in scripts/pine-fixtures/corpus/ must compile AND survive a
 * full runAll() over synthetic M15 bars without throwing. Value-correctness
 * per indicator arrives with later phases; this gate pins "no crash".
 * (Counts printed for visibility, not asserted — outputs evolve by design.)
 */

import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compile } from '../src/core/pine/compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'pine-fixtures', 'corpus');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function makeBars(n) {
  const bars = [];
  const t0 = 1790600400 - (1790600400 % 900);
  let px = 2400, seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    const o = px, cl = o + Math.sin(i / 9) * 3 + rnd() * 1.5;
    bars.push({ time: t0 + i * 900, open: o, high: Math.max(o, cl) + 1,
      low: Math.min(o, cl) - 1, close: cl, volume: 100 + (i % 50) });
    px = cl;
  }
  return bars;
}

const files = readdirSync(DIR).filter((x) => x.endsWith('.pine')).sort();
ok(files.length >= 5, 'corpus holds the 5 heavy indicators (got ' + files.length + ')');
for (const f of files) {
  const src = readFileSync(join(DIR, f), 'utf8');
  let c;
  try {
    c = compile(src);
  } catch (e) {
    ok(false, f + ' compiles (threw ' + String((e && e.message) || e).slice(0, 100) + ')');
    continue;
  }
  ok(c.ok, f + ' compiles' + (c.ok ? '' : ' -> ' + String((c.errors[0] && c.errors[0].message) || '').slice(0, 120)));
  if (!c.ok) continue;
  const bars = makeBars(150);
  const t0 = Date.now();
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'XAUUSD', serverOffSec: 0 });
    rt.runAll(bars);
    const ms = Date.now() - t0;
    const nPlots = rt.out.plots ? rt.out.plots.size : 0;
    const nShapes = rt.out.shapes ? rt.out.shapes.size : 0;
    const nDraw = (rt.store ? (rt.store.count('box') + rt.store.count('line') + rt.store.count('label')) : '?');
    console.log('    … ' + f + ' ran 150 bars in ' + ms + 'ms (plots ' + nPlots + ', shapes ' + nShapes + ', drawings ' + nDraw + ')');
    ok(true, f + ' runs without throwing');
    ok(ms < 60000, f + ' finishes within budget (' + ms + 'ms)');
  } catch (e) {
    ok(false, f + ' runs without throwing (-> ' + String((e && e.message) || e).slice(0, 140) + ')');
  }
}

console.log('\nROUND151: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
