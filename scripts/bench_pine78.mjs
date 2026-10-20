/**
 * bench_pine78.mjs — Round 78 performance bench for the Pine engine
 *
 * Run:  node scripts/bench_pine78.mjs
 *
 * Compiles the REAL 786 Zones and runs it over two histories:
 *   A) 6 days of M15 (the app's default view, 15 M1 intrabars per bar)
 *   B) 20 days of M5 (stress: 5760 bars x 5 intrabars = ~29k intrabar evals)
 * and reports wall time for:
 *   - memo OFF (round-77 behaviour baseline, incl. no intrabar fast-path? —
 *     the fast-path is structural, so OFF isolates the pure-fn memo)
 *   - memo ON  (round-78 engine)
 * Parity of the produced drawings between the two runs is asserted.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compile } from '../src/core/pine/compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync('/home/z/my-project/user-tests/786-zones.pine', 'utf8');
const comp = compile(SRC);
if (!comp.ok) { console.error('compile failed', comp.errors); process.exit(1); }

function fixture(tfSec, subsPerBar, days) {
  const start = Math.floor(Date.now() / 1000 / 86400) * 86400 - (days - 1) * 86400;
  const bars = [], intrabars = [];
  let px = 2400;
  const n = Math.floor(days * 86400 / tfSec);
  for (let i = 0; i < n; i++) {
    const t = start + i * tfSec;
    const subs = [];
    for (let m = 0; m < subsPerBar; m++) {
      px += Math.sin((t / 60 + m) / 7) * 0.9 + (m === 7 ? 1.1 : 0);
      subs.push({ time: (t + m * 60) * 1000, open: px, high: px + 0.8, low: px - 0.8, close: px + 0.3, volume: 10 + m });
    }
    bars.push({ time: t, open: subs[0].open, high: Math.max(...subs.map((s) => s.high)), low: Math.min(...subs.map((s) => s.low)), close: subs[subs.length - 1].close, volume: 150 });
    intrabars.push(subs);
  }
  return { bars, intrabars };
}

const geom = (rt) => JSON.stringify(
  ['box', 'line', 'label'].flatMap((k) => Array.from(rt.store[k].values())
    .map((o) => JSON.stringify([o.left ?? o.x1 ?? o.x, o.top ?? o.y1 ?? o.y, o.right ?? o.x2, o.bottom ?? o.y2, o.text || ''])))
    .sort());
const plots = (rt) => JSON.stringify(Array.from(rt.out.plots.values()).map((p) => [p.title, p.values]));

function bench(name, fx, tfSec, runs) {
  const times = {};
  let geoms = {}, plotsRef = null, parity = true;
  for (const [label, disable] of [['memo OFF', true], ['memo ON ', false]]) {
    const ts = [];
    let rt = null;
    for (let k = 0; k < runs; k++) {
      rt = comp.createInstance({ tfSec, symbol: 'XAUUSD', mintick: 0.01, serverOffSec: 3 * 3600, intrabars: fx.intrabars, disablePureMemo: disable });
      const t0 = process.hrtime.bigint();
      rt.runAll(fx.bars);
      ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    ts.sort((a, b) => a - b);
    times[label] = ts[Math.floor(ts.length / 2)];
    geoms[label] = geom(rt);
    if (plotsRef == null) plotsRef = plots(rt);
    else if (plots(rt) !== plotsRef) parity = false;
  }
  const speedup = times['memo OFF'] / times['memo ON '];
  console.log(`  ${name}`);
  console.log(`    memo OFF (r77 path): ${times['memo OFF'].toFixed(0).padStart(6)} ms`);
  console.log(`    memo ON  (r78 path): ${times['memo ON '].toFixed(0).padStart(6)} ms   -> x${speedup.toFixed(2)} faster, parity ${parity ? 'OK' : 'MISMATCH!'}`);
  if (geoms['memo OFF'] !== geoms['memo ON ']) console.log('    !! DRAWING GEOMETRY MISMATCH');
  return parity && geoms['memo OFF'] === geoms['memo ON '];
}

console.log('786 Zones — engine bench (median of runs, broker GMT+3):\n');
const A = fixture(900, 15, 6);   // 576 bars x 15 subs
const B = fixture(300, 5, 20);   // 5760 bars x 5 subs
let okA = false, okB = false;
okA = bench(`A) M15 x 6 days  (${A.bars.length} bars, ${A.bars.length * 15} intrabar evals x3 series)`, A, 900, 3);
okB = bench(`B) M5  x 20 days (${B.bars.length} bars, ${B.bars.length * 5} intrabar evals x3 series)`, B, 300, 3);
console.log('');
process.exit(okA && okB ? 0 : 1);
