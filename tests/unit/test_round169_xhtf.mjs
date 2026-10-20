/**
 * test_round169_xhtf.mjs — ROUND169 cross-TF over other symbols (phase 1b).
 *
 * request.security("OTHER","H1"|"D",expr) buckets the OTHER symbol's bars:
 * running values, gaps_on/lookahead parity, and no cache thrash when one
 * script mixes combos every bar (bucket cache is per symbol+TF now).
 *
 * Run: node tests/unit/test_round169_xhtf.mjs
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
    const o = px, cl = o + rnd() * 0.004;
    bars.push({ time: t0 + i * step, open: o, high: Math.max(o, cl) + 0.0006, low: Math.min(o, cl) - 0.0006, close: cl, volume: 100 });
    px = cl;
  }
  return bars;
}

/* independent bucketizer over an array (no engine) */
function bucketsOf(bars, sec) {
  const out = [];
  let cur = null;
  for (let i = 0; i < bars.length; i++) {
    const bs = Math.floor(bars[i].time / sec) * sec;
    if (!cur || cur.start !== bs) { cur = { start: bs, i0: i, i1: i }; out.push(cur); }
    cur.i1 = i;
  }
  return out;
}

const T0 = 1790600400 - (1790600400 % 86400);
const N = 2000; // M15 bars
const barsA = walk(N, T0, 900, 11, 1.0850);
const barsB = walk(N, T0, 900, 77, 1.1350);

function runXtra(src, symBars) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + JSON.stringify(c.errors).slice(0, 160) };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'EURUSD' });
    rt.env.symBars = symBars;
    rt.runAll(barsA);
    return { rt, out: rt.out };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 160) }; }
}

/* 1. H1 running close over B on the last bar */
{
  const r = runXtra(`//@version=5
indicator("x169", overlay=false)
h = request.security("GBPUSD", "60", close)
plot(h, title="h")`, { 'GBPUSD|3600': barsB });
  ok(!r.error, 'h1 xsym runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const V = r.out.plots.get(r.out.plotsOrder[0]).values;
    const bk = bucketsOf(barsB, 3600);
    const last = bk[bk.length - 1];
    const exp = barsB[Math.min(N - 1, last.i1)].close;
    ok(Math.abs(V[N - 1] - exp) < 1e-12, 'h1 running close on last bar (got ' + V[N - 1] + ' exp ' + exp + ')');
    // a mid-bucket historical bar reads the previous CLOSED bucket (repaint-free)
    const mid = last.i0; // first bar of the last bucket
    const prev = bk[bk.length - 2];
    const expM = barsB[prev.i1].close;
    ok(Math.abs(V[mid] - expM) < 1e-12, 'mid-bucket bar reads previous closed h1 (got ' + V[mid] + ' exp ' + expM + ')');
  }
}

/* 2. daily + gaps_on / lookahead_on over B */
{
  const mk = (extra) => runXtra(`//@version=5
indicator("x169g", overlay=false)
d = request.security("GBPUSD", "D", close${extra ? ', ' + extra : ''})
plot(d, title="d")`, { 'GBPUSD|86400': barsB });
  const g0 = mk('');
  ok(!g0.error, 'daily xsym runs');
  if (!g0.error) {
    const V = g0.out.plots.get(g0.out.plotsOrder[0]).values;
    ok(V[N - 1] != null && typeof V[N - 1] === 'number', 'daily running close finite on last bar');
  }
  const g1 = mk('gaps=barmerge.gaps_on');
  ok(!g1.error, 'daily xsym gaps_on runs');
  if (!g1.error) {
    const V = g1.out.plots.get(g1.out.plotsOrder[0]).values;
    ok(V[N - 1] == null || typeof V[N - 1] === 'object', 'gaps_on realtime bar is na');
    // first bar of the second daily bucket reads the first closed daily
    const bk = bucketsOf(barsB, 86400);
    const secondStart = bk[1].i0;
    const exp = barsB[bk[0].i1].close;
    ok(Math.abs(V[secondStart] - exp) < 1e-12, 'gaps_on steps at bucket boundary (got ' + V[secondStart] + ' exp ' + exp + ')');
  }
  const g2 = mk('lookahead=barmerge.lookahead_on');
  ok(!g2.error, 'daily xsym lookahead_on runs');
  if (!g2.error) {
    const V = g2.out.plots.get(g2.out.plotsOrder[0]).values;
    const bk = bucketsOf(barsB, 86400);
    const mid = bk[1].i0 + 5; // inside second daily bucket
    // lookahead: current bucket running close as of bar mid
    let hi = barsB[mid].high, lo = barsB[mid].low;
    void hi; void lo;
    const cur = bk[1];
    const exp = barsB[Math.min(mid, cur.i1)].close;
    ok(V[mid] != null && Math.abs(V[mid] - exp) < 1e-12, 'lookahead reads running bucket (got ' + V[mid] + ' exp ' + exp + ')');
  }
}

/* 3. mixed combos every bar: H1xsym + Dxsym + chart H1 — one cache entry each */
{
  const r = runXtra(`//@version=5
indicator("x169m", overlay=false)
h = request.security("GBPUSD", "60", close)
d = request.security("GBPUSD", "D", close)
c = request.security(syminfo.tickerid, "60", close)
plot(h + d + c, title="s")`, { 'GBPUSD|3600': barsB, 'GBPUSD|86400': barsB });
  ok(!r.error, 'mixed combos run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const V = r.out.plots.get(r.out.plotsOrder[0]).values;
    ok(V[N - 1] != null && typeof V[N - 1] === 'number', 'mixed sum finite on last bar');
    const size = r.rt._htfCaches ? r.rt._htfCaches.size : -1;
    ok(size === 3, 'bucket cache holds 3 combos without thrash (size=' + size + ')');
  }
}

console.log('\nROUND169: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
