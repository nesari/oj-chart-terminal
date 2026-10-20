/**
 * test_round153_ta.mjs — ROUND153 ta.* batch-1 differential harness
 *
 * Run: node scripts/test_round153_ta.mjs
 *
 * Each new function (alma/cmo/cog/correlation/median/mode/variance/rci/swma)
 * is checked bar-by-bar against an INDEPENDENT batch reference written in
 * this file (whole-array loops, no engine/site state). Same documented
 * na-rules on both sides — so what fails here is incremental-vs-batch
 * divergence (seeding, windows, off-by-ones), not formula taste.
 * Formula choices + TV-undocumented defaults are marked HOUSE in ta.js.
 */

import { compile } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function makeBars(n) {
  const bars = [];
  const t0 = 1790600400 - (1790600400 % 900);
  let px = 200, seed = 1234;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    const o = px;
    const cl = i % 19 === 7 ? NaN : o + Math.sin(i / 6) * 2 + rnd() * 1.2;
    const h = isFinite(cl) ? Math.max(o, cl) + 0.5 : o + 0.5;
    const l = isFinite(cl) ? Math.min(o, cl) - 0.5 : o - 0.5;
    bars.push({ time: t0 + i * 900, open: o, high: h, low: l, close: cl, volume: 100 });
    if (isFinite(cl)) px = cl;
  }
  return bars;
}
const N = 150;
const bars = makeBars(N);
const closes = bars.map((b) => (isFinite(b.close) ? b.close : null));

/* ---------------- independent batch references (no engine) ---------------- */
const fin = (v) => v != null && isFinite(v);
function winOf(arr, i, L) {
  if (i + 1 < L) return null;
  const w = arr.slice(i - L + 1, i + 1);
  return w;
}
function almaRef(a, L, off, sig) {
  const m = Math.floor(off * (L - 1)), s = L / sig, out = [];
  for (let i = 0; i < a.length; i++) {
    const w = winOf(a, i, L);
    if (!w || !w.every(fin)) { out.push(null); continue; }
    let n = 0, d = 0;
    for (let j = 0; j < L; j++) {
      const wt = Math.exp(-((j - m) * (j - m)) / (2 * s * s));
      n += w[j] * wt; d += wt;
    }
    out.push(n / d);
  }
  return out;
}
function cmoRef(a, L) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    // last L COUNTED changes ending at bar i (na-involved skipped, like the engine)
    const w = [];
    for (let j = i; j >= 1 && w.length < L; j--) {
      if (fin(a[j]) && fin(a[j - 1])) w.unshift(a[j] - a[j - 1]);
    }
    if (!w.length) { out.push(null); continue; }
    let su = 0, sd = 0;
    for (const d of w) { if (d > 0) su += d; else if (d < 0) sd -= d; }
    out.push(su + sd === 0 ? null : (100 * (su - sd)) / (su + sd));
  }
  return out;
}
function cogRef(a, L) {
  const b = a.map((v) => (fin(v) ? v : 0)), out = [];
  for (let i = 0; i < a.length; i++) {
    let nm = 0, dn = 0;
    for (let k = 0; k < L; k++) {
      const p = i - k >= 0 ? b[i - k] : 0;
      nm += p * (k + 1); dn += p;
    }
    out.push(dn === 0 ? null : -nm / dn + (L + 1) / 2);
  }
  return out;
}
function corrRef(x, y, L) {
  const out = [];
  for (let i = 0; i < x.length; i++) {
    const w = winOf(x, i, L), v = winOf(y, i, L);
    if (!w || !w.every(fin) || !v.every(fin)) { out.push(null); continue; }
    const mx = w.reduce((p, q) => p + q, 0) / L, my = v.reduce((p, q) => p + q, 0) / L;
    let sxy = 0, sxx = 0, syy = 0;
    for (let k = 0; k < L; k++) {
      sxy += (w[k] - mx) * (v[k] - my); sxx += (w[k] - mx) ** 2; syy += (v[k] - my) ** 2;
    }
    out.push(sxx <= 0 || syy <= 0 ? null : sxy / Math.sqrt(sxx * syy));
  }
  return out;
}
function medianRef(a, L) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const w = winOf(a, i, L);
    if (!w || !w.every(fin)) { out.push(null); continue; }
    const s = w.slice().sort((p, q) => p - q), m = Math.floor(L / 2);
    out.push(L % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
  }
  return out;
}
function modeRef(a, L) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const w = winOf(a, i, L);
    if (!w || !w.every(fin)) { out.push(null); continue; }
    const c = new Map();
    let best = w[0], bc = 0;
    for (const v of w) {
      const k = (c.get(v) || 0) + 1;
      c.set(v, k);
      if (k > bc) { best = v; bc = k; }
    }
    out.push(best);
  }
  return out;
}
function varRef(a, L) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const w = winOf(a, i, L);
    if (!w || !w.every(fin)) { out.push(null); continue; }
    const m = w.reduce((p, q) => p + q, 0) / L;
    out.push(w.reduce((p, q) => p + (q - m) ** 2, 0) / L);
  }
  return out;
}
function rciRef(a, L) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const w = winOf(a, i, L);
    if (!w || !w.every(fin) || L < 2) { out.push(null); continue; }
    const o = w.map((_, k) => k).sort((p, q) => w[p] - w[q]);
    const pr = new Array(L);
    let r = 0;
    while (r < L) {
      let s = r;
      while (s + 1 < L && w[o[s + 1]] === w[o[r]]) s++;
      const avg = (r + s) / 2 + 1;
      for (let k = r; k <= s; k++) pr[o[k]] = avg;
      r = s + 1;
    }
    let d2 = 0;
    for (let k = 0; k < L; k++) d2 += (k + 1 - pr[k]) ** 2;
    out.push((1 - (6 * d2) / (L * (L * L - 1))) * 100);
  }
  return out;
}
function swmaRef(a) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const w = winOf(a, i, 4);
    out.push(!w || !w.every(fin) ? null : (w[0] + 2 * w[1] + 2 * w[2] + w[3]) / 6);
  }
  return out;
}

/* ---------------- engine runs ---------------- */
function engineVals(expr) {
  const src = '//@version=6\nindicator("t", overlay=true)\nplot(' + expr + ', title="v")';
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + String((c.errors[0] && c.errors[0].message) || '') };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 0 });
    rt.runAll(bars);
    return { vals: rt.out.plots.get(rt.out.plotsOrder[0]).values };
  } catch (e) {
    return { error: 'run: ' + String((e && e.message) || e) };
  }
}
function cmpVals(name, got, exp) {
  if (got.error) { ok(false, name + ' runs (-> ' + got.error.slice(0, 100) + ')'); return; }
  let bad = 0, firstBad = -1;
  for (let i = 0; i < N; i++) {
    const g = got.vals[i], e = exp[i];
    const bothNa = (g == null) && (e == null);
    const close = bothNa || (g != null && e != null && Math.abs(g - e) < 1e-9);
    if (!close && bad++ === 0) firstBad = i;
  }
  ok(bad === 0, name + ' matches batch reference on ' + N + ' bars' + (bad ? ' (first div bar ' + firstBad + ': got ' + got.vals[firstBad] + ' exp ' + exp[firstBad] + ')' : ''));
}

cmpVals('ta.alma(close,9,0.85,6)', engineVals('ta.alma(close, 9, 0.85, 6)'), almaRef(closes, 9, 0.85, 6));
cmpVals('ta.cmo(close,14)', engineVals('ta.cmo(close, 14)'), cmoRef(closes, 14));
cmpVals('ta.cog(close,10)', engineVals('ta.cog(close, 10)'), cogRef(closes, 10));
cmpVals('ta.correlation(close,open,30)', engineVals('ta.correlation(close, open, 30)'), corrRef(closes, bars.map((b) => b.open), 30));
cmpVals('ta.median(close,14)', engineVals('ta.median(close, 14)'), medianRef(closes, 14));
cmpVals('ta.mode(close,14)', engineVals('ta.mode(close, 14)'), modeRef(closes, 14));
cmpVals('ta.variance(close,14)', engineVals('ta.variance(close, 14)'), varRef(closes, 14));
cmpVals('ta.rci(close,9)', engineVals('ta.rci(close, 9)'), rciRef(closes, 9));
cmpVals('ta.swma(close)', engineVals('ta.swma(close)'), swmaRef(closes));

/* defaults run + stay finite somewhere (HOUSE defaults path) */
for (const e of ['ta.alma(close)', 'ta.cmo(close)', 'ta.cog(close)', 'ta.median(close)', 'ta.mode(close)', 'ta.variance(close)', 'ta.rci(close)']) {
  const r = engineVals(e);
  ok(!r.error && r.vals.some((v) => v != null), e + ' defaults run and produce values');
}

/* properties: alma stays inside its window; rci within [-100,100] */
{
  const r = engineVals('ta.alma(close, 9, 0.85, 6)');
  let good = !r.error;
  for (let i = 8; i < N && good; i++) {
    const w = closes.slice(i - 8, i + 1);
    if (w.every((v) => v != null) && r.vals[i] != null) {
      if (r.vals[i] < Math.min(...w) - 1e-9 || r.vals[i] > Math.max(...w) + 1e-9) good = false;
    }
  }
  ok(good, 'alma bounded by its window');
}
{
  const r = engineVals('ta.rci(close, 9)');
  ok(!r.error && r.vals.every((v) => v == null || (v >= -100.0001 && v <= 100.0001)), 'rci within [-100,100]');
}

console.log('\nROUND153: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
