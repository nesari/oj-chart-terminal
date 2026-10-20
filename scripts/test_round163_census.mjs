/**
 * test_round163_census.mjs — ROUND163 drawing census (SMC "extra lines" report).
 *
 * drawingCensus() is the helper behind the per-pass `[pine] drawing census`
 * log line: alive/added/GC'd counts, line-span histogram in bars, 3 longest
 * lines, top label texts. Pinned: bucket boundaries, null-store safety,
 * bar_index + bar_time spans, and shape on a real SMC run.
 *
 * Run: node scripts/test_round163_census.mjs
 */

import { readFileSync } from 'node:fs';
import { compile } from '../src/core/pine/compile.js';
import { VisualStore, PineLine, PineLabel, drawingCensus } from '../src/core/pine/stdlib/objects.js';
import { NA } from '../src/core/pine/types.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

/* null / empty safety */
{
  const c = drawingCensus(null, 900);
  ok(c.line === 0 && c.box === 0 && c.label === 0 && c.longest.length === 0, 'null store -> zeros');
  const s = new VisualStore({ line: 10, box: 10, label: 10 });
  const c2 = drawingCensus(s, 900);
  ok(c2.line === 0 && c2.lineBars.short === 0 && c2.labelTop.length === 0, 'empty store -> zeros');
}

/* hand-built spans: bucket boundaries for both xloc kinds */
{
  const s = new VisualStore({ line: 10, box: 10, label: 10 });
  const t = 1700000000000;
  s.add('line', new PineLine({ x1: t, x2: t + 19 * 900000, y1: 1, y2: 1, xloc: 'bar_time', style: 'solid' })); // 19 bars
  s.add('line', new PineLine({ x1: t, x2: t + 20 * 900000, y1: 2, y2: 2, xloc: 'bar_time', style: 'dashed' })); // 20
  s.add('line', new PineLine({ x1: t, x2: t + 100 * 900000, y1: 3, y2: 3, xloc: 'bar_time' })); // 100
  s.add('line', new PineLine({ x1: t, x2: t + 101 * 900000, y1: 4, y2: 4, xloc: 'bar_time' })); // 101
  s.add('line', new PineLine({ x1: 5, x2: 9, y1: 5, y2: 5, xloc: 'bar_index' })); // 4 bars
  s.add('line', new PineLine({ x1: NA, x2: t, y1: 6, y2: 6, xloc: 'bar_time' })); // na placeholder (var init)
  const c = drawingCensus(s, 900);
  ok(c.line === 6, '6 alive lines counted (got ' + c.line + ')');
  ok(c.lineBars.short === 2 && c.lineBars.mid === 2 && c.lineBars.long === 1 && c.lineBars.na === 1,
    'buckets short/mid/long/na = 2/2/1/1 (got ' + JSON.stringify(c.lineBars) + ')');
  ok(c.longest.length === 3 && c.longest[0].bars === 101 && c.longest[0].y === 4,
    'longest sorted desc, top = 101 bars @4 (got ' + JSON.stringify(c.longest[0]) + ')');
  ok(c.adds.line === 6 && c.gced === 0, 'adds/gced carried through');
}

/* GC eviction accounting */
{
  const s = new VisualStore({ line: 2, box: 10, label: 10 });
  const t = 1700000000000;
  for (let i = 0; i < 5; i++) s.add('line', new PineLine({ x1: t, x2: t + 900000, y1: i, y2: i, xloc: 'bar_time' }));
  const c = drawingCensus(s, 900);
  ok(c.line === 2 && c.adds.line === 5 && c.gced === 3, 'cap-2 store: alive=2 adds=5 gced=3');
}

/* shape on a real SMC run (synthetic trend, 1500 bars) */
{
  const src = readFileSync(new URL('../scripts/pine-fixtures/corpus/smartmoney.pine', import.meta.url), 'utf8');
  const cmp = compile(src);
  ok(cmp.ok, 'SMC compiles');
  if (cmp.ok) {
    const t0 = 1790600400 - (1790600400 % 900);
    let px = 4150, seed = 4242;
    const bars = [];
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
    for (let i = 0; i < 1500; i++) {
      const o = px, cl = o + rnd() * 1.6 + Math.sin(i / 400) * 0.55;
      const w = Math.abs(rnd()) * 0.9 + 0.2;
      bars.push({ time: t0 + i * 900, open: o, high: Math.max(o, cl) + w, low: Math.min(o, cl) - w, close: cl, volume: 100 });
      px = cl;
    }
    const rt = cmp.createInstance({ tfSec: 900, symbol: 'XAUUSD' });
    rt.runAll(bars);
    const c = drawingCensus(rt.store, 900);
    ok(c.line === rt.store.line.size && c.box === rt.store.box.size && c.label === rt.store.label.size,
      'census counts match store sizes (' + c.line + '/' + c.box + '/' + c.label + ')');
    const b = c.lineBars;
    ok(b.short + b.mid + b.long + b.na === c.line, 'buckets sum to alive lines');
    ok(c.labelTop.length > 0 && c.labelTop[0].n >= 1, 'labelTop non-empty (top=' + JSON.stringify(c.labelTop[0]) + ')');
    for (let i = 1; i < c.longest.length; i++) {
      if (c.longest[i].bars > c.longest[i - 1].bars) { ok(false, 'longest sorted desc'); break; }
      if (i === c.longest.length - 1) ok(true, 'longest sorted desc');
    }
    if (!c.longest.length) ok(true, 'longest sorted desc (empty)');
  }
}

console.log('\nROUND163: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
