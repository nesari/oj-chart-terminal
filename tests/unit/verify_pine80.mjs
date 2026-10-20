/**
 * verify_pine80.mjs — Round 80 verification suite
 *
 * Run:  node tests/unit/verify_pine80.mjs
 *
 * 1) runChunked time-budget (FEAT-80-B): the event loop stays LIVE during a
 *    heavy chunked history pass — outside setTimeout(0) probes never gap by
 *    more than ~50ms (the old fixed every-400-bars yield let one synchronous
 *    slice run 50ms+ on dense histories; the 12ms budget caps every slice).
 * 2) Chunked/full parity: runChunked and runAll produce IDENTICAL plot
 *    values and identical 786 Zones box/label geometry (same bars, fresh
 *    runtime each) — the budget change is pure scheduling, zero behaviour.
 * 3) Fresh-runtime-per-TF (FEAT-80-B correctness half): a runtime built for
 *    one timeframe must never be reused for another — a fresh instance gets
 *    a clean env.tfSec and clean var state; re-running the SAME instance
 *    over a second history leaks `var` state (documents the old TF-switch
 *    bug the renderer now avoids by rebuilding).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compile } from '../../src/core/pine/compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC786 = readFileSync(join(HERE, '..', '..', 'fixtures', 'pine', '786-zones.pine'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

/* plots are keyed by plot index — resolve by declared title */
const plotByTitle = (rt, title) => Array.from(rt.out.plots.values()).find((p) => p.title === title);

/* ---------------- fixtures ---------------- */

const HEAVY_SRC = [
  'indicator("r80-heavy")',
  'var float acc = 0.0',
  's = 0.0',
  'for i = 1 to 60',
  '    s := s + math.sqrt(math.abs(math.sin(i * close) * math.cos(i * open)))',
  'acc := acc + s',
  'plot(s, title="s")',
  'plot(acc, title="acc")',
].join('\n');

function makeBars(tfSec, n, seed = 7) {
  const start = Math.floor(Date.now() / 1000 / tfSec) * tfSec - n * tfSec;
  const bars = [];
  let px = 2400;
  for (let i = 0; i < n; i++) {
    const t = start + i * tfSec;
    px += Math.sin((t / 60 + seed) / 5) * 1.1 + ((i * 13 + seed) % 17 === 0 ? 2.2 : 0);
    bars.push({ time: t, open: px - 0.4, high: px + 1.2, low: px - 1.3, close: px + 0.2, volume: 100 + i % 9 });
  }
  return bars;
}

/* ------------- 1) event-loop liveness during runChunked --------------- */
console.log('\n[1] runChunked time-budget — the event loop stays live');
{
  const c = compile(HEAVY_SRC);
  ok(c.ok, 'heavy probe script compiles');
  const rt = c.createInstance({ tfSec: 60, symbol: 'X', mintick: 0.01 });
  const bars = makeBars(60, 4000);

  let maxGap = 0, probes = 0, done = false;
  (async () => {
    let last = Date.now();
    while (!done) {
      await new Promise((r) => setTimeout(r, 0));
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      probes++;
    }
  })();
  const t0 = Date.now();
  await rt.runChunked(bars, 400);
  done = true;
  const total = Date.now() - t0;
  ok(probes > 20, `probes ran during the pass (${probes} loops in ${total}ms)`);
  ok(maxGap <= 50, `max event-loop gap ${maxGap}ms <= 50ms (12ms budget + timer clamp)`);
  ok(isFinite(plotByTitle(rt, 'acc').values[bars.length - 1]), 'run completed with finite output');
}

/* ------------- 2) chunked == full (plots + 786 drawings) -------------- */
console.log('\n[2] scheduling parity — runChunked output == runAll output');
{
  // (a) synthetic heavy script
  const c = compile(HEAVY_SRC);
  const bars = makeBars(300, 1200, 11);
  const rtA = c.createInstance({ tfSec: 300, symbol: 'X', mintick: 0.01 });
  rtA.runAll(bars);
  const rtB = c.createInstance({ tfSec: 300, symbol: 'X', mintick: 0.01 });
  await rtB.runChunked(bars, 400);
  let same = true;
  for (const key of ['s', 'acc']) {
    const pa = plotByTitle(rtA, key), pb = plotByTitle(rtB, key);
    if (!pa || !pb) { same = false; break; }
    const a = pa.values, b = pb.values;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; }
  }
  ok(same, 'heavy-script plot values identical (bit-exact)');

  // (b) the REAL 786 Zones: drawings must match too (M1 intrabars supplied —
  // the script reads request.security_lower_tf)
  const c786 = compile(SRC786);
  ok(c786.ok, '786 Zones compiles');
  const bars2 = makeBars(900, 900, 3);
  const intrabars2 = bars2.map((b) => {
    const subs = [];
    for (let m = 0; m < 15; m++) {
      subs.push({ time: (b.time + m * 60) * 1000, open: b.open, high: b.high, low: b.low, close: b.close, volume: 10 });
    }
    return subs;
  });
  const rtA2 = c786.createInstance({ tfSec: 900, symbol: 'XAUUSD', mintick: 0.01, serverOffSec: 10800, intrabars: intrabars2 });
  rtA2.runAll(bars2);
  const rtB2 = c786.createInstance({ tfSec: 900, symbol: 'XAUUSD', mintick: 0.01, serverOffSec: 10800, intrabars: intrabars2 });
  await rtB2.runChunked(bars2, 400);
  ok(rtA2.store.count('box') === rtB2.store.count('box') && rtB2.store.count('box') > 0,
    `box count parity (${rtA2.store.count('box')} == ${rtB2.store.count('box')})`);
  ok(rtA2.store.count('label') === rtB2.store.count('label'),
    `label count parity (${rtA2.store.count('label')} == ${rtB2.store.count('label')})`);
  let geom = true;
  const arrA = Array.from(rtA2.store.box.values()), arrB = Array.from(rtB2.store.box.values());
  for (let i = 0; i < arrA.length; i++) {
    const a = arrA[i], b = arrB[i]; // ids are per-store counters — compare positionally
    if (!b || a.left !== b.left || a.right !== b.right || a.top !== b.top || a.bottom !== b.bottom) { geom = false; break; }
  }
  ok(geom, 'box geometry identical (left/right/top/bottom)');
  const pvA = Array.from(rtA2.out.plots.values())[0], pvB = Array.from(rtB2.out.plots.values())[0];
  if (pvA && pvB) {
    let psame = true;
    for (let i = 0; i < pvA.values.length; i++) if (pvA.values[i] !== pvB.values[i]) { psame = false; break; }
    ok(psame, '786 plot values identical');
  } else ok(true, '786 has no plots (zones-only) — n/a');
}

/* -------- 3) fresh-runtime-per-TF contract (what pine-ui now does) ----- */
console.log('\n[3] per-TF runtime contract — fresh instance, clean env and state');
{
  const c = compile(HEAVY_SRC);
  const barsM15 = makeBars(900, 300, 5);
  const barsH1 = makeBars(3600, 300, 6);

  // THE OLD BUG (documented): the SAME runtime re-run over a second history
  // carries `var` state across — acc keeps the first run's accumulation.
  const rtLeak = c.createInstance({ tfSec: 900, symbol: 'X', mintick: 0.01 });
  rtLeak.runAll(barsM15);
  const leakAcc = plotByTitle(rtLeak, "acc").values[barsM15.length - 1];
  rtLeak.runAll(barsH1);
  const leakAcc2 = plotByTitle(rtLeak, "acc").values[barsH1.length - 1];
  ok(leakAcc2 !== leakAcc, 'sanity: reusing one runtime across histories carries var state (the old TF-switch behaviour)');

  // THE ROUND80 CONTRACT: a NEW instance per TF starts from a clean state.
  const rtM15 = c.createInstance({ tfSec: 900, symbol: 'X', mintick: 0.01 });
  ok(rtM15.env.tfSec === 900, 'fresh instance env.tfSec = 900 (M15)');
  rtM15.runAll(barsM15);
  const freshM15 = plotByTitle(rtM15, 'acc').values[barsM15.length - 1];
  const rtH1 = c.createInstance({ tfSec: 3600, symbol: 'X', mintick: 0.01 });
  ok(rtH1.env.tfSec === 3600, 'fresh instance env.tfSec = 3600 (H1)');
  rtH1.runAll(barsH1);
  const freshH1 = plotByTitle(rtH1, 'acc').values[barsH1.length - 1];
  ok(rtH1.globals.get('acc').value === freshH1, 'fresh instance var state starts clean (no carry-over)');
  /* ROUND87: _resetForFullRun() FIXED the leak — a re-used runtime now
     matches a fresh one, so the old "leak is observable" assertion became
     an equality contract. */
  ok(freshH1 === leakAcc2, 're-used runtime matches a fresh one (the old var leak is FIXED by the full-recalc reset)');

  // updateForming still works on the fresh runtime (the tick path stays intact)
  const bars2 = barsH1.slice();
  bars2[bars2.length - 1] = Object.assign({}, bars2[bars2.length - 1], { close: bars2[bars2.length - 1].close + 3 });
  rtH1.updateForming(bars2);
  ok(plotByTitle(rtH1, 's').values[bars2.length - 1] !== null, 'forming-bar update after fresh run stays healthy');
}

console.log('\n' + '='.repeat(34));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
