/**
 * test_round170_xlive.mjs — ROUND170 cross-symbol live ticks + dynamic symbols (phase 1c).
 *
 * - env.symTicks['SYM|sec'] newer than the aligned bar refreshes the RUNNING
 *   aggregate (close/high/low); stale ticks are ignored; history untouched.
 * - missing pairs are recorded on rt.missingSymBars before the loud throw
 *   (the app's fetch-and-retry loop consumes them).
 * - gaps_on parity cross-symbol; input.symbol values flow into security().
 *
 * Run: node tests/unit/test_round170_xlive.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function walk(n, t0, step, seed, base) {
  let px = base, s = seed;
  const bars = [];
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    const o = px, cl = o + rnd() * 0.002;
    bars.push({ time: t0 + i * step, open: o, high: Math.max(o, cl) + 0.0004, low: Math.min(o, cl) - 0.0004, close: cl, volume: 100 });
    px = cl;
  }
  return bars;
}

const T0 = 1790600400 - (1790600400 % 900);
const N = 400;
const barsA = walk(N, T0, 900, 11, 1.0850);
const barsB = walk(N, T0, 900, 77, 1.1350);

function runIt(src, symBars, symTicks) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + JSON.stringify(c.errors).slice(0, 160) };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD' });
    rt.env.symBars = symBars;
    if (symTicks) rt.env.symTicks = symTicks;
    rt.runAll(barsA);
    return { rt, out: rt.out };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 160) }; }
}

const PROBE = `//@version=5
indicator("x170", overlay=false)
c = request.security("GBPUSD", "15", close)
plot(c, title="c")`;

/* 1. fresh tick overrides the running close on the last bar only */
{
  const r0 = runIt(PROBE, { 'GBPUSD|900': barsB }, null);
  ok(!r0.error, 'baseline runs');
  const V0 = r0.out.plots.get(r0.out.plotsOrder[0]).values;
  const lastT = barsB[barsB.length - 1].time;
  const r1 = runIt(PROBE, { 'GBPUSD|900': barsB }, { 'GBPUSD|900': { price: 9.99, time: (lastT + 60) * 1000 } });
  ok(!r1.error, 'tick run executes');
  if (!r1.error) {
    const V1 = r1.out.plots.get(r1.out.plotsOrder[0]).values;
    ok(V1[N - 1] === 9.99, 'running close follows the live tick (got ' + V1[N - 1] + ')');
    ok(V1[N - 2] === V0[N - 2], 'history untouched by the tick');
  }
  // stale tick ignored
  const r2 = runIt(PROBE, { 'GBPUSD|900': barsB }, { 'GBPUSD|900': { price: 9.99, time: (lastT - 900) * 1000 } });
  if (!r2.error) {
    const V2 = r2.out.plots.get(r2.out.plotsOrder[0]).values;
    ok(V2[N - 1] === V0[N - 1], 'stale tick ignored (got ' + V2[N - 1] + ')');
  } else ok(false, 'stale-tick run executes');
}

/* 2. missing pair recorded + loud */
{
  const r = runIt(PROBE, {}, null);
  ok(!!r.error && /no history for "GBPUSD"/.test(r.error), 'loud without data');
  const c = compile(PROBE);
  const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD' });
  rt.env.symBars = {};
  try { rt.runAll(barsA); } catch (e) {}
  const miss = rt.missingSymBars || [];
  ok(miss.length === 1 && miss[0].sym === 'GBPUSD' && miss[0].sec === 900,
    'missing pair recorded (got ' + JSON.stringify(miss) + ')');
}

/* 3. gaps_on parity cross-symbol */
{
  const r = runIt(`//@version=5
indicator("x170g", overlay=false)
c = request.security("GBPUSD", "15", close, gaps=barmerge.gaps_on)
plot(c, title="c")`, { 'GBPUSD|900': barsB }, null);
  ok(!r.error, 'gaps_on xsym runs');
  if (!r.error) {
    const V = r.out.plots.get(r.out.plotsOrder[0]).values;
    ok(V[N - 1] == null || typeof V[N - 1] === 'object', 'gaps_on realtime na cross-symbol');
    ok(typeof V[N - 2] === 'number', 'previous bar has a value');
  }
}

/* 4. input.symbol value path */
{
  const r = runIt(`//@version=5
indicator("x170s", overlay=false)
s = input.symbol("GBPUSD")
c = request.security(s, "15", close)
plot(c, title="c")`, { 'GBPUSD|900': barsB }, null);
  ok(!r.error, 'input.symbol value flows into security');
  if (!r.error) {
    const V = r.out.plots.get(r.out.plotsOrder[0]).values;
    ok(V[N - 1] === barsB[barsB.length - 1].close, 'value matches other symbol (got ' + V[N - 1] + ')');
  }
}

/* 5. dry input-collection survives cross-symbol (dialog lists inputs) */
{
  const src = `//@version=5
indicator("x170d", overlay=false)
s = input.symbol("GBPUSD", "Sym")
c = request.security(s, "15", close)
plot(c, title="c")`;
  const c = compile(src);
  ok(c.ok, 'dry probe compiles');
  if (c.ok) {
    const ci = c.collectInputs({ tfSec: 900, symbol: 'EURUSD' });
    ok(ci.ok && (ci.inputs || []).some((d) => d.title === 'Sym'),
      'collectInputs ok with Sym def (ok=' + ci.ok + ')');
  }
}

console.log('\nROUND170: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
