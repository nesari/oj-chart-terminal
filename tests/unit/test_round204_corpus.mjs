/**
 * test_round204_corpus.mjs — ROUND204 corpus hardening gate (§7 methodology).
 *
 * All 5 heavy scripts compile + survive runAll on now-anchored data with
 * M1 subs (time-anchored scripts need the live window — stale bars draw
 * nothing by design). Stable shape asserts only: exact drawing counts vary
 * by weekday/data window (786), so only sessions.pine (daily sessions) and
 * SMC (bar-count legs) pin nonzero drawings; the rest pin no-throw + plots.
 *
 * Run: node tests/unit/test_round204_corpus.mjs
 */
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compile } from '../../src/core/pine/compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '..', 'fixtures', 'pine', 'corpus');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function makeBars(n) {
  const bars = [], intrabars = [];
  const lastBar = Math.floor(Date.now() / 1000 / 900) * 900;
  const t0 = lastBar - n * 900;
  let px = 2400, seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    const o = px, cl = o + Math.sin(i / 9) * 3 + rnd() * 1.5;
    const t = t0 + i * 900;
    bars.push({ time: t, open: o, high: Math.max(o, cl) + 1, low: Math.min(o, cl) - 1,
      close: cl, volume: 100 + (i % 50) });
    px = cl;
    const subs = [];
    for (let m = 0; m < 15; m++) {
      const so = o + Math.sin((i * 15 + m) / 31) * 0.8;
      subs.push({ time: (t + m * 60) * 1000, open: so, high: so + 0.8, low: so - 0.8, close: so + 0.3, volume: 10 + m });
    }
    intrabars.push(subs);
  }
  return { bars, intrabars };
}

const files = readdirSync(DIR).filter((x) => x.endsWith('.pine')).sort();
ok(files.length >= 5, 'corpus holds the heavy scripts (got ' + files.length + ')');
const { bars: BARS, intrabars: SUBS } = makeBars(400);
const seen = {};
for (const f of files) {
  const src = readFileSync(join(DIR, f), 'utf8');
  let c;
  try { c = compile(src); }
  catch (e) { ok(false, f + ' compiles (threw)'); continue; }
  ok(c.ok, f + ' compiles');
  if (!c.ok) continue;
  const t0 = Date.now();
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'XAUUSD', serverOffSec: 0, mintick: 0.01, intrabars: SUBS });
    rt.runAll(BARS);
    const ms = Date.now() - t0;
    seen[f] = {
      plots: rt.out.plots ? rt.out.plots.size : 0,
      line: rt.store.count('line'), box: rt.store.count('box'), label: rt.store.count('label'),
    };
    ok(ms < 120000, f + ' runs 400 bars in budget (' + ms + 'ms)');
  } catch (e) {
    ok(false, f + ' runs without throwing (-> ' + String((e && e.message) || e).slice(0, 140) + ')');
  }
}
const nz = (f) => (seen[f] ? seen[f].plots + seen[f].line + seen[f].box + seen[f].label : 0);
for (const f of files) ok(nz(f) > 0, f + ' produces output ' + JSON.stringify(seen[f]));
ok(seen['sessions.pine'] && seen['sessions.pine'].box > 0, 'sessions.pine draws session boxes (time() fix live)');
ok(seen['smartmoney.pine'] && seen['smartmoney.pine'].line > 0, 'SMC draws structure lines');

console.log('\nROUND204: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
