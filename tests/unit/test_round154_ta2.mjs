/**
 * test_round154_ta2.mjs — ROUND154 composites + ta vars + input.enum + transp=
 *
 * Run: node tests/unit/test_round154_ta2.mjs
 *
 * dmi/kc/kcw/tsi are checked bar-by-bar against independent batch references
 * (same rule as round153: incremental-vs-batch equivalence). ta.obv/pvt/wad/
 * wvad/accdist likewise. input.enum registers a dropdown def with member
 * values flowing into comparisons; transp= maps onto alpha (v4 parity).
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function makeBars(n) {
  const bars = [];
  const t0 = 1790600400 - (1790600400 % 900);
  let px = 200, seed = 999;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    const o = px;
    const cl = i % 23 === 11 ? NaN : o + Math.sin(i / 5) * 2 + rnd() * 1.4;
    const h = isFinite(cl) ? Math.max(o, cl) + 0.6 : o + 0.6;
    const l = isFinite(cl) ? Math.min(o, cl) - 0.6 : o - 0.6;
    bars.push({ time: t0 + i * 900, open: o, high: h, low: l, close: cl, volume: 100 + (i % 37) });
    if (isFinite(cl)) px = cl;
  }
  return bars;
}
const N = 160;
const bars = makeBars(N);
const C = bars.map((b) => (isFinite(b.close) ? b.close : null));
const H = bars.map((b) => b.high), L = bars.map((b) => b.low);
const V = bars.map((b) => b.volume);
const fin = (v) => v != null && isFinite(v);

/* ---------------- batch references (no engine) ---------------- */
function emaBatch(a, len) {
  const k = 2 / (len + 1), out = new Array(a.length).fill(null);
  let seed = [], prev = null, started = false;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (!fin(v)) { out[i] = null; continue; }
    if (!started) {
      seed.push(v);
      if (seed.length === len) { prev = seed.reduce((p, q) => p + q, 0) / len; started = true; out[i] = prev; }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
function rmaBatch(a, len) {
  const out = new Array(a.length).fill(null);
  let seed = [], prev = null, started = false;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (!fin(v)) { out[i] = null; continue; }
    if (!started) {
      seed.push(v);
      if (seed.length === len) { prev = seed.reduce((p, q) => p + q, 0) / len; started = true; out[i] = prev; }
      continue;
    }
    prev = (prev * (len - 1) + v) / len;
    out[i] = prev;
  }
  return out;
}
function smaBatch(a, len) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    if (i + 1 < len) { out.push(null); continue; }
    const w = a.slice(i - len + 1, i + 1);
    out.push(w.every(fin) ? w.reduce((p, q) => p + q, 0) / len : null);
  }
  return out;
}
function changeBatch(a) {
  return a.map((v, i) => (i === 0 || !fin(v) || !fin(a[i - 1]) ? null : v - a[i - 1]));
}
function trBatch() {
  const out = [];
  let prevClose = null;
  for (let i = 0; i < N; i++) {
    if (!fin(H[i]) || !fin(L[i]) || !fin(C[i])) { out.push(null); prevClose = fin(C[i]) ? C[i] : prevClose; continue; }
    out.push(prevClose == null ? H[i] - L[i] : Math.max(H[i] - L[i], Math.abs(H[i] - prevClose), Math.abs(L[i] - prevClose)));
    prevClose = C[i];
  }
  return out;
}
function dmiRef(dl, al) {
  const chH = changeBatch(H), chL = changeBatch(L);
  const plusDM = chH.map((u, i) => (u == null || chL[i] == null ? null : (u > -chL[i] && u > 0 ? u : 0)));
  const minusDM = chH.map((u, i) => (u == null || chL[i] == null ? null : (-chL[i] > u && -chL[i] > 0 ? -chL[i] : 0)));
  const trur = rmaBatch(trBatch(), dl);
  const rp = rmaBatch(plusDM, dl), rm = rmaBatch(minusDM, dl);
  let fp = null, fm = null;
  const plus = [], minus = [];
  for (let i = 0; i < N; i++) {
    if (rp[i] != null && trur[i] != null && trur[i] !== 0) fp = (100 * rp[i]) / trur[i];
    if (rm[i] != null && trur[i] != null && trur[i] !== 0) fm = (100 * rm[i]) / trur[i];
    plus.push(fp); minus.push(fm);
  }
  const dx = plus.map((p, i) => (p == null || minus[i] == null ? null : (100 * Math.abs(p - minus[i])) / (p + minus[i] === 0 ? 1 : p + minus[i])));
  return [plus, minus, rmaBatch(dx, al)];
}
function kcRef(len, mult) {
  const b = smaBatch(C, len), a = rmaBatch(trBatch(), len);
  return [
    b,
    b.map((v, i) => (v == null || a[i] == null ? null : v + mult * a[i])),
    b.map((v, i) => (v == null || a[i] == null ? null : v - mult * a[i])),
  ];
}
function tsiRef(s, l) {
  const pc = changeBatch(C);
  const e1 = emaBatch(emaBatch(pc, l), s);
  const apc = pc.map((v) => (v == null ? null : Math.abs(v)));
  const e2 = emaBatch(emaBatch(apc, l), s);
  return e1.map((v, i) => (v == null || e2[i] == null || e2[i] === 0 ? null : (100 * v) / e2[i]));
}
function obvRef() {
  const out = [];
  let acc = 0;
  for (let i = 0; i < N; i++) {
    if (i > 0 && fin(C[i]) && fin(C[i - 1])) {
      const d = C[i] - C[i - 1];
      acc += (d > 0 ? 1 : d < 0 ? -1 : 0) * (fin(V[i]) ? V[i] : 0);
    }
    out.push(acc);
  }
  return out;
}
function pvtRef() {
  const out = [];
  let acc = 0;
  for (let i = 0; i < N; i++) {
    if (i > 0 && fin(C[i]) && fin(C[i - 1]) && C[i - 1] !== 0) {
      acc += ((C[i] - C[i - 1]) / C[i - 1]) * (fin(V[i]) ? V[i] : 0);
    }
    out.push(acc);
  }
  return out;
}
function wadRef() {
  const out = [];
  let acc = 0;
  for (let i = 0; i < N; i++) {
    if (i > 0 && fin(C[i]) && fin(C[i - 1])) {
      if (C[i] > C[i - 1]) acc += C[i] - Math.min(fin(L[i]) ? L[i] : C[i], C[i - 1]);
      else if (C[i] < C[i - 1]) acc += C[i] - Math.max(fin(H[i]) ? H[i] : C[i], C[i - 1]);
    }
    out.push(acc);
  }
  return out;
}
function wvadRef() {
  const out = [];
  let acc = 0;
  for (let i = 0; i < N; i++) {
    if (fin(C[i]) && fin(bars[i].open) && fin(H[i]) && fin(L[i]) && H[i] !== L[i]) {
      acc += ((C[i] - bars[i].open) / (H[i] - L[i])) * (fin(V[i]) ? V[i] : 0);
    }
    out.push(acc);
  }
  return out;
}
function adRef() {
  const out = [];
  let acc = 0;
  for (let i = 0; i < N; i++) {
    if (fin(C[i]) && fin(H[i]) && fin(L[i]) && H[i] !== L[i]) {
      acc += ((2 * C[i] - H[i] - L[i]) / (H[i] - L[i])) * (fin(V[i]) ? V[i] : 0);
    }
    out.push(acc);
  }
  return out;
}

/* ---------------- engine runs ---------------- */
function enginePlots(src) {
  const full = '//@version=6\nindicator("t", overlay=true)\n' + src;
  const c = compile(full);
  if (!c.ok) return { error: 'compile: ' + String((c.errors[0] && c.errors[0].message) || '') };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 0 });
    rt.runAll(bars);
    const byTitle = {};
    for (const k of rt.out.plotsOrder) byTitle[rt.out.plots.get(k).title] = rt.out.plots.get(k).values;
    return { vals: byTitle, rt };
  } catch (e) {
    return { error: 'run: ' + String((e && e.message) || e) };
  }
}
function cmpVals(name, got, exp) {
  if (got.error) { ok(false, name + ' runs (-> ' + got.error.slice(0, 110) + ')'); return; }
  let bad = 0, firstBad = -1;
  for (let i = 0; i < N; i++) {
    const g = got[i], e = exp[i];
    const bothNa = g == null && e == null;
    const close = bothNa || (g != null && e != null && Math.abs(g - e) < 1e-8);
    if (!close && bad++ === 0) firstBad = i;
  }
  ok(bad === 0, name + ' matches on ' + N + ' bars' + (bad ? ' (first div bar ' + firstBad + ': got ' + got[firstBad] + ' exp ' + exp[firstBad] + ')' : ''));
}

{
  const r = enginePlots('[p, m, x] = ta.dmi(14, 14)\nplot(p, title="p")\nplot(m, title="m")\nplot(x, title="x")');
  if (r.error) ok(false, 'ta.dmi runs (-> ' + r.error.slice(0, 110) + ')');
  else {
    const [ep, em, ex] = dmiRef(14, 14);
    cmpVals('ta.dmi plus', r.vals.p, ep);
    cmpVals('ta.dmi minus', r.vals.m, em);
    cmpVals('ta.dmi adx', r.vals.x, ex);
  }
}
{
  const r = enginePlots('[b, u, l] = ta.kc(close, 20, 2)\nplot(b, title="b")\nplot(u, title="u")\nplot(l, title="l")\nplot(ta.kcw(close, 20, 2), title="w")');
  if (r.error) ok(false, 'ta.kc/kcw runs (-> ' + r.error.slice(0, 110) + ')');
  else {
    const [eb, eu, el] = kcRef(20, 2);
    cmpVals('ta.kc basis', r.vals.b, eb);
    cmpVals('ta.kc upper', r.vals.u, eu);
    cmpVals('ta.kc lower', r.vals.l, el);
    /* kcw is atr-based (no close window), so its own reference — NOT
       upper-minus-lower, which inherits the close window's na holes. */
    cmpVals('ta.kcw width', r.vals.w, rmaBatch(trBatch(), 20).map((v) => (v == null ? null : 4 * v)));
  }
}
cmpVals('ta.tsi(close,13,25)', (() => {
  const r = enginePlots('plot(ta.tsi(close, 13, 25), title="v")');
  return r.error ? r : r.vals.v;
})(), tsiRef(13, 25));
cmpVals('ta.obv', (() => {
  const r = enginePlots('plot(ta.obv, title="v")');
  return r.error ? r : r.vals.v;
})(), obvRef());
cmpVals('ta.pvt', (() => {
  const r = enginePlots('plot(ta.pvt, title="v")');
  return r.error ? r : r.vals.v;
})(), pvtRef());
cmpVals('ta.wad', (() => {
  const r = enginePlots('plot(ta.wad, title="v")');
  return r.error ? r : r.vals.v;
})(), wadRef());
cmpVals('ta.wvad', (() => {
  const r = enginePlots('plot(ta.wvad, title="v")');
  return r.error ? r : r.vals.v;
})(), wvadRef());
cmpVals('ta.accdist', (() => {
  const r = enginePlots('plot(ta.accdist, title="v")');
  return r.error ? r : r.vals.v;
})(), adRef());

/* input.enum: dropdown def + member values in comparisons */
{
  const src = '//@version=6\nindicator("e", overlay=true)\n'
    + 'enum Mode\n    Fast\n    Slow\n'
    + 'mode = input.enum(Mode.Fast, "Mode")\n'
    + 'plot(mode == Mode.Fast ? close : open, title="v")';
  const c = compile(src);
  ok(c.ok, 'input.enum script compiles' + (c.ok ? '' : ' -> ' + JSON.stringify(c.errors)));
  if (c.ok) {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
    rt.runAll(bars);
    const def = rt.inputDefs.find((d) => d.kind === 'enum');
    ok(!!def && Array.isArray(def.options) && def.options.join(',') === 'Fast,Slow', 'enum def carries member options (got ' + JSON.stringify(def && def.options) + ')');
    ok(def && def.enumMap && def.enumMap.Fast === 0 && def.enumMap.Slow === 1, 'enum def carries the value map');
    const vals = rt.out.plots.get(rt.out.plotsOrder[0]).values;
    ok(vals[N - 1] === bars[N - 1].close, 'member comparison selects the Fast branch');
    // override through inputValues (what the dialog writes back)
    const rt2 = c.createInstance({ tfSec: 900, symbol: 'T', inputValues: { [def.id]: 1 } });
    rt2.runAll(bars);
    const vals2 = rt2.out.plots.get(rt2.out.plotsOrder[0]).values;
    ok(vals2[N - 1] === bars[N - 1].open, 'dialog override (Slow=1) switches branch');
  }
}

/* transp= maps onto alpha (v4 parity) */
{
  const src = '//@version=4\nindicator("t", overlay=true)\n'
    + 'plot(close, title="a", color=color.red, transp=50)\n'
    + 'bgcolor(color=color.green, transp=25)\n';
  const c = compile(src);
  ok(c.ok, 'transp= script compiles');
  if (c.ok) {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
    rt.runAll(bars);
    const p = rt.out.plots.get(rt.out.plotsOrder[0]);
    const col = p.colors[N - 1];
    ok(col && Math.abs(col.a - 0.5) < 1e-9, 'plot transp=50 halves alpha (got ' + (col && col.a) + ')');
    const bg = rt.out.bgcolor[N - 1];
    ok(bg && Math.abs(bg.a - 0.75) < 1e-9, 'bgcolor transp=25 -> alpha 0.75 (got ' + (bg && bg.a) + ')');
  }
}

console.log('\nROUND154: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
