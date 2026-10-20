/**
 * corpus_sweep.mjs — ROUND204 corpus hardening sweep (tool, kept).
 *
 * Every scripts/pine-fixtures/corpus/*.pine compiles + runAll() over 2000
 * deterministic M15 bars: errors, plot/shape counts, drawing census, ms.
 * Failures triaged into engine fixes (this round) or documented script-side
 * limits. test_round204_corpus.mjs pins the outcome.
 *
 * Run: node scripts/corpus_sweep.mjs [file-substring]
 */
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compile } from '../src/core/pine/compile.js';
import { drawingCensus } from '../src/core/pine/stdlib/objects.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'pine-fixtures', 'corpus');
const ONLY = (process.argv[2] || '').toLowerCase();

function makeBars(n) {
  const bars = [], intrabars = [];
  /* Date.now-anchored (like verify_pine78): time-anchored scripts (timenow,
     sessions) only form zones inside the live window — stale bars draw
     nothing by design, which would fake a clean sweep. M1 subs included:
     786 Zones forms zones ONLY from lower-TF data. */
  const endDay = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const lastBar = Math.floor(Date.now() / 1000 / 900) * 900;
  const t0 = lastBar - n * 900;
  let px = 2400, seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    const o = px, cl = o + Math.sin(i / 9) * 3 + rnd() * 1.5;
    const t = t0 + i * 900;
    bars.push({ time: t, open: o, high: Math.max(o, cl) + 1,
      low: Math.min(o, cl) - 1, close: cl, volume: 100 + (i % 50) });
    px = cl;
    const subs = [];
    for (let m = 0; m < 15; m++) {
      const so = o + Math.sin((i * 15 + m) / 31) * 0.8;
      subs.push({ time: (t + m * 60) * 1000, open: so, high: so + 0.8, low: so - 0.8,
        close: so + 0.3, volume: 10 + m });
    }
    intrabars.push(subs);
  }
  return { bars, intrabars };
}

const files = readdirSync(DIR).filter((x) => x.endsWith('.pine')).sort()
  .filter((f) => !ONLY || f.toLowerCase().includes(ONLY));
const { bars: BARS, intrabars: INTRABARS } = makeBars(2000);
for (const f of files) {
  const src = readFileSync(join(DIR, f), 'utf8');
  let c;
  try { c = compile(src); }
  catch (e) { console.log(`### ${f}: COMPILE-THREW ${String((e && e.message) || e).slice(0, 160)}`); continue; }
  if (!c.ok) { console.log(`### ${f}: COMPILE-FAIL ${String((c.errors[0] && c.errors[0].message) || '').slice(0, 200)}`); continue; }
  const t0 = Date.now();
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'XAUUSD', serverOffSec: 0, mintick: 0.01, intrabars: INTRABARS });
    rt.runAll(BARS);
    const ms = Date.now() - t0;
    const nPlots = rt.out.plots ? rt.out.plots.size : 0;
    const nShapes = rt.out.shapes ? rt.out.shapes.size : 0;
    let census = '';
    try {
      const cen = drawingCensus(rt.store, 900);
      census = ` line=${cen.line} box=${cen.box} label=${cen.label} adds=${cen.adds.line}/${cen.adds.box}/${cen.adds.label}`;
    } catch (e) { census = ' census-err:' + String((e && e.message) || e).slice(0, 80); }
    console.log(`### ${f}: OK ${ms}ms plots=${nPlots} shapes=${nShapes}${census}`);
  } catch (e) {
    console.log(`### ${f}: RUN-THREW ${String((e && e.message) || e).slice(0, 220)}`);
  }
}
