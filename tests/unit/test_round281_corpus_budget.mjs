/**
 * test_round281_corpus_budget.mjs — ROUND281 corpus cost budget gate.
 *
 * WHY not a wall-clock gate: the app already yields to the event loop every
 * 16–21 ms during a chunked pass (measured on the 5000-bar wyckoff run), so
 * UI responsiveness is not the open problem — total cost is, and absolute
 * milliseconds flake on shared CI runners (see ROUND266). The interpreter
 * already counts DETERMINISTIC work units (`_tick()` = one executed
 * statement/expression per bar), which is the right thing to gate.
 *
 * The gate pins two real regression classes:
 *
 *  A. SUPER-LINEAR WORK. Doubling the history must not more than ~1.6× the
 *     per-bar work. An accidental O(n²) (e.g. a full re-run inside a tick, a
 *     history scan per bar, a growing array re-sort) fails here while staying
 *     invisible to every correctness suite.
 *
 *  B. PER-SCRIPT CEILINGS. Each corpus script's steps/bar is pinned with
 *     headroom. A change that makes a script 2× more expensive fails unless
 *     the pin is raised deliberately.
 *
 *  C. TICK COST. updateForming() on the last bar must cost about ONE bar of
 *     work, not a re-scan — realtime ticks stay cheap even for heavy scripts.
 *
 * Steps/bar is machine-independent (pure interpreter bookkeeping), so this
 * suite is safe to run in the concurrent pool.
 *
 * Run: node tests/unit/test_round281_corpus_budget.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../../src/core/pine/compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, '..', '..', 'fixtures', 'pine', 'corpus');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

/* Deterministic synthetic history: the exact shape does not matter for work
   units (branch-free bookkeeping), but a monotone + wavy series exercises
   both directions of every comparison. */
function bars(n) {
  const t0 = 1790600400 - (1790600400 % 900);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 100 + Math.sin(i / 7) * 5 + i * 0.02;
    out.push({ time: t0 + i * 900, open: o, high: o + 1, low: o - 1, close: o + 0.4, volume: 100 + (i % 13) });
  }
  return out;
}

/* steps/bar measured through the interpreter's own counter. `_tick()` runs
   once per executed statement and per evaluated expression, so the number is
   a stable proxy for interpreter work (identical on every machine). */
function measure(src, nBars) {
  const c = compile(src);
  if (!c.ok) return { error: c.errors.map((e) => e.message).join(' | ').slice(0, 120) };
  const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD', mintick: 0.00001, serverOffSec: 0, maxOpsPerBar: 1e12 });
  let ticks = 0;
  const orig = rt._tick;
  rt._tick = function () { ticks++; return orig.call(this); };
  const b = bars(nBars);
  const t0 = performance.now();
  try { rt.runAll(b); } catch (e) { return { error: String(e && e.message).slice(0, 120) }; }
  const ms = performance.now() - t0;
  const total = ticks;
  /* Ticks are reset per bar, so `rt.steps` after a full pass IS the last
     bar's cost. Scripts that render labels/tables on barstate.islast
     legitimately do far more work there than on an average bar, so the tick
     baseline must be the LAST bar — not the mean. */
  const lastBar = rt.steps;
  /* one forming-bar re-run = the realtime tick path */
  const before = ticks;
  const bb = b.slice();
  bb[bb.length - 1] = Object.assign({}, bb[bb.length - 1], { close: bb[bb.length - 1].close + 0.3 });
  let tickErr = null;
  try { rt.updateForming(bb); } catch (e) { tickErr = String(e && e.message).slice(0, 120); }
  const tickCost = ticks - before;
  return {
    total, perBar: total / nBars, lastBar, tickCost, tickErr, ms,
    tickVsLast: lastBar > 0 ? tickCost / lastBar : 0,
  };
}

/* Wall-clock is only used as a RATIO between two sizes measured back to back
   in the same process, best-of-3 — the same-machine comparison cancels CPU
   speed, so a shared runner cannot flake it. Absolute ceiling checks stay on
   the deterministic work counter above. */
function measureMs(src, nBars, passes) {
  let best = Infinity;
  for (let p = 0; p < (passes || 2); p++) {
    const c = compile(src);
    if (!c.ok) return null;
    const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD', mintick: 0.00001, serverOffSec: 0, maxOpsPerBar: 1e12 });
    const b = bars(nBars);
    const t0 = performance.now();
    try { rt.runAll(b); } catch (e) { return null; }
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/* Ceilings carry ~2× headroom over the values measured in ROUND281. Raise
   one deliberately (with a note) when a script legitimately gets heavier; a
   silent doubling is exactly what this gate exists to catch. */
const CEILING = {
  '786-zones.pine': 400,
  'algoalpha.pine': 450,
  'sessions.pine': 900,
  'smartmoney.pine': 1200,
  'wyckoff.pine': 9000,
};

/* History lengths. Small for per-bar work units (fast, deterministic), double
   for the super-linear ratio. Only the slowest script needs a smaller pair:
   its cost is ~2.5ms/bar, so 300→600 still gives a measurable window while
   keeping this gate inside the unit-gate budget. */
const SMALL_N = 500;
const smallOf = (f) => (CEILING[f] >= 9000 ? 300 : SMALL_N);

const files = readdirSync(DIR).filter((f) => f.endsWith('.pine')).sort();
ok(files.length >= 5, 'corpus holds the heavy scripts (got ' + files.length + ')');

const results = {};
console.log('\n[1] per-bar work units (deterministic)');
for (const f of files) {
  const src = readFileSync(join(DIR, f), 'utf8');
  const ceil = CEILING[f];
  if (ceil == null) {
    ok(false, f + ' has a ceiling entry', 'add one to CEILING in this suite');
    continue;
  }
  const small = measure(src, smallOf(f));
  if (small.error) { ok(false, f + ' runs (' + smallOf(f) + ' bars)', small.error); continue; }
  results[f] = small;
  const perBar = Math.round(small.perBar);
  ok(perBar <= ceil, f + ' steps/bar within budget', perBar + ' <= ' + ceil);
}

console.log('\n[2] no super-linear blow-up when history doubles');
for (const f of files) {
  if (!results[f]) continue;
  const src = readFileSync(join(DIR, f), 'utf8');
  const big = measure(src, smallOf(f) * 2);
  if (big.error) { ok(false, f + ' runs (' + (smallOf(f) * 2) + ' bars)', big.error); continue; }
  /* Deterministic part: interpreter work per bar must stay flat. Linear
     execution keeps steps/bar constant; allow 1.6× for warm-up effects
     (the first bars have no history yet) and branch variation. */
  const ratio = big.perBar / Math.max(1, results[f].perBar);
  ok(ratio <= 1.6, f + ' stays linear in work units (ratio <= 1.6)', ratio.toFixed(2) + '×');
  /* Wall-clock part: same-process, back-to-back timings taken by the two
     `measure()` calls above (no extra passes). Doubling the bar count must
     not more than triple the time (linear ≈ 2×, quadratic ≈ 4×). Measured as
     a ratio so CPU speed cancels out — this is the only check that can see
     O(n²) living OUTSIDE the interpreter loop. */
  const tSmall = results[f].ms;
  const tBig = big.ms;
  if (tSmall != null && tBig != null && tSmall > 8) {
    const tr = tBig / tSmall;
    ok(tr <= 3.0, f + ' stays linear in wall time (ratio <= 3.0)',
      tr.toFixed(2) + '× (' + Math.round(tSmall) + '→' + Math.round(tBig) + 'ms)');
  } else {
    ok(true, f + ' wall-time ratio skipped (run too short to time reliably)');
  }
}

console.log('\n[3] realtime tick = one bar of work, never a re-scan');
for (const f of files) {
  if (!results[f]) continue;
  const r = results[f];
  ok(!r.tickErr, f + ' updateForming succeeds', r.tickErr || '');
  /* A forming-bar re-run re-executes exactly the last bar. Comparing with
     the LAST bar's own cost (not the mean) is the meaningful bound: a tick
     that re-scanned history would land at ~bars × this value. */
  ok(r.tickVsLast <= 1.5, f + ' tick costs about one last-bar execution',
    (r.tickVsLast === 0 ? '0' : r.tickVsLast.toFixed(2)) + '× last bar (' + r.tickCost + ' vs ' + r.lastBar + ' units)');
  ok(r.tickCost > 0, f + ' tick actually executed work (' + r.tickCost + ' units)');
  ok(r.tickCost < r.total, f + ' tick never re-runs the whole history',
    r.tickCost + ' < ' + r.total + ' units');
}

console.log('\n[4] sanity: the counter is real, not a stub');
{
  const trivial = measure('//@version=5\nindicator("T")\nplot(close)\n', 100);
  const heavy = measure('//@version=5\nindicator("H")\nfor i = 0 to 40\n    x = close * i + open\nplot(close)\n', 100);
  ok(trivial.perBar > 0 && trivial.perBar < 20, 'a trivial script costs a handful of units/bar (' + Math.round(trivial.perBar) + ')');
  ok(heavy.perBar > trivial.perBar * 5, 'a loop-heavy script costs much more (' + Math.round(heavy.perBar) + ' vs ' + Math.round(trivial.perBar) + ')');
  const growth = measure('//@version=5\nindicator("G")\nfor i = 0 to 20\n    x = close[i]\nplot(close)\n', 100);
  const growth2 = measure('//@version=5\nindicator("G")\nfor i = 0 to 20\n    x = close[i]\nplot(close)\n', 200);
  ok(Math.abs(growth2.perBar - growth.perBar) / growth.perBar < 0.35,
    'a fixed-cost loop keeps steps/bar flat across history lengths');
}

/* ---------- 5. the wall-time check is not decorative ---------- */
/* A Pine `for i = 0 to bar_index` loop is the canonical per-bar history scan
   — the exact shape of the O(n²) bug this gate exists for. With enough bars
   the fixed per-run overhead stops dominating and doubling the history
   quadruples the cost, so the ratio check must see >> 3.0. If that ever
   stops holding, the ratio assertion above is decorative and this says so. */
{
  const QUAD = '//@version=5\nindicator("Q")\nvar float acc = 0.0\nfor i = 0 to bar_index\n    acc += close * math.sin(i)\nplot(acc)\n';
  const q1 = measureMs(QUAD, 1000, 3);
  const q2 = measureMs(QUAD, 2000, 3);
  ok(q1 != null && q2 != null, 'the quadratic fixture runs');
  if (q1 != null && q2 != null) {
    const qr = q2 / Math.max(1, q1);
    ok(qr > 3.5, 'the ratio check catches a per-bar history scan', qr.toFixed(2) + '× > 3.5 (' + Math.round(q1) + '→' + Math.round(q2) + 'ms)');
  }
  /* the deterministic counter sees that one too (Pine-level work), which is
     why both checks exist: units catch interpreter work, timing catches work
     hidden in JS host code. */
  const uA = measure(QUAD, 400).perBar;
  const uB = measure(QUAD, 800).perBar;
  ok(uB / Math.max(1, uA) > 1.6, 'work units also flag the Pine-level scan', (uB / uA).toFixed(2) + '×');
}

console.log('\nROUND281: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
