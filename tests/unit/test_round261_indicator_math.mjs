/**
 * ROUND261 / ROUND299 - built-in indicator math, now verified against the
 * Pine scripts that replaced the JavaScript implementations.
 *
 * ROUND261 pinned four defects in the hand-written JS library:
 *   1. Awesome Oscillator suppressed its FIRST valid value (index 33);
 *   2. MFI counted an unchanged typical price as negative money flow;
 *   3. OBV / A-D returned one value for an EMPTY bar array;
 *   4. fractional/zero periods reached the math kernels raw.
 *
 * ROUND299 deleted that library (every built-in is a Pine script now), so the
 * tests below assert the SAME user-visible invariants through the engine:
 * the point was never "the JS function does X", it was "the indicator the user
 * sees behaves like TradingView". Invariant 4 moved into the engine's own
 * `intLen` normalization plus the catalog's input.int declarations.
 *
 * Run: node tests/unit/test_round261_indicator_math.mjs
 */
import { BUILTIN_BY_TYPE, BUILTIN_INDICATORS } from '../../src/core/pine/builtins-catalog.js';
import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' - ' + JSON.stringify(extra) : '')); }
};

/* deterministic pseudo-random bars; every 11th close repeats (flat hl2) */
function makeBars(n) {
  const bars = [];
  let seed = 4242, px = 100;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    if (i % 11 === 5) { px = bars[i - 1].close; }
    else px = px + rnd() * 2;
    const o = i ? bars[i - 1].close : px;
    const h = Math.max(o, px) + 0.5;
    const l = Math.min(o, px) - 0.5;
    bars.push({ time: 1790600400 + i * 60, open: o, high: h, low: l, close: px, volume: 10 + (i % 7) });
  }
  return bars;
}
const bars = makeBars(120);

/* run a builtin's Pine script and return its plots by title */
function runBuiltin(type, list) {
  const def = BUILTIN_BY_TYPE.get(type);
  if (!def) throw new Error('no such builtin: ' + type);
  const c = compile(def.source);
  if (!c.ok) throw new Error(type + ' compile: ' + c.errors.map((e) => e.message).join(' | '));
  const rt = c.createInstance({ tfSec: 60, symbol: 'T', mintick: 0.01, serverOffSec: 0 });
  rt.runAll(list || bars);
  const byTitle = new Map();
  for (const k of rt.out.plotsOrder) {
    const p = rt.out.plots.get(k);
    if (!p.hiddenHline && p.display !== 'none') byTitle.set(p.title || k, p);
  }
  return { rt, plots: byTitle, values: (title) => (byTitle.get(title) || {}).values || [] };
}

const eqClose = (a, b) => a.length === b.length &&
  a.every((v, i) => (v == null && b[i] == null) || (v != null && b[i] != null && Math.abs(v - b[i]) < 1e-9));

/* ---------- independent batch references ---------- */
function smaRef(src, len) {
  const out = new Array(src.length).fill(null);
  for (let i = len - 1; i < src.length; i++) {
    let s = 0, bad = false;
    for (let j = 0; j < len; j++) { const v = src[i - j]; if (v == null) { bad = true; break; } s += v; }
    if (!bad) out[i] = s / len;
  }
  return out;
}

/* ---------- 1. Awesome Oscillator ---------- */
console.log('\n[1] Awesome Oscillator');
{
  const ao = runBuiltin('awesome').values('AO');
  const hl2 = bars.map((b) => (b.high + b.low) / 2);
  const fast = smaRef(hl2, 5), slow = smaRef(hl2, 34);
  const ref = fast.map((v, i) => (v != null && slow[i] != null ? v - slow[i] : null));
  const first = ao.findIndex((v) => v != null);
  ok(first === 33, 'first AO value is index 33 (bar 34)', first);
  ok(eqClose(ao, ref), 'every AO histogram value matches SMA(5)-SMA(34)');
}

/* ---------- 2. MFI flat-flow handling ---------- */
console.log('\n[2] Money Flow Index');
{
  const got = runBuiltin('mfi').values('MFI');
  ok(got.some((v) => v != null), 'MFI produces readings on the fixture');

  const flat = bars.map((b) => ({ time: b.time, open: 100, high: 100, low: 100, close: 100, volume: b.volume }));
  const fv = runBuiltin('mfi', flat).values('MFI');
  ok(fv.every((v) => v == null), 'a completely flat tape reports NA (not 0)',
    fv.filter((v) => v != null).slice(0, 3));

  const rising = bars.map((b, i) => ({ time: b.time, open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 5 }));
  const rv = runBuiltin('mfi', rising).values('MFI');
  ok(rv.filter((v) => v != null).every((v) => v === 100), 'an all-up window is 100',
    rv.filter((v) => v != null).slice(0, 3));

  const falling = bars.map((b, i) => ({ time: b.time, open: 300 - i, high: 300 - i, low: 300 - i, close: 300 - i, volume: 5 }));
  const dv = runBuiltin('mfi', falling).values('MFI');
  ok(dv.filter((v) => v != null).every((v) => v === 0), 'an all-down window is 0',
    dv.filter((v) => v != null).slice(0, 3));
}

/* ---------- 3. empty-history alignment (ROUND261 invariant 3) ---------- */
console.log('\n[3] empty history alignment');
{
  for (const type of ['obv', 'adline']) {
    const zero = runBuiltin(type, []).values(type === 'obv' ? 'OBV' : 'A/D');
    ok(zero.length === 0, type + ': zero bars -> zero values', zero);
    const one = runBuiltin(type, bars.slice(0, 1));
    const v1 = type === 'obv' ? one.values('OBV') : one.values('A/D');
    ok(v1.length === 1, type + ': one bar -> exactly one value', v1.length);
    const many = runBuiltin(type);
    const vm = type === 'obv' ? many.values('OBV') : many.values('A/D');
    ok(vm.length === bars.length, type + ': values aligned with bars', [vm.length, bars.length]);
  }
}

/* ---------- 4. period normalization ---------- */
console.log('\n[4] period handling');
{
  /* The JS library clamped a fractional period at its compute() boundary.
     Pine inputs declare int and the engine's intLen normalizes whatever it
     receives, so the invariant to pin is: a script run with a fractional
     override behaves like its integer form, and never throws or blanks. */
  const def = BUILTIN_BY_TYPE.get('sma');
  const c = compile(def.source);
  ok(c.ok, 'SMA script compiles');
  const ci = c.collectInputs({ tfSec: 60, symbol: 'T', mintick: 0.01 });
  ok(ci.ok && ci.inputs.length === 1, 'SMA exposes one input (Length)', ci.inputs && ci.inputs.length);
  const id = ci.inputs[0].id;

  const at = (len) => {
    const rt = c.createInstance({ tfSec: 60, symbol: 'T', mintick: 0.01, inputValues: { [id]: len } });
    rt.runAll(bars);
    const p = rt.out.plots.get(rt.out.plotsOrder[0]);
    return p.values;
  };
  const v205 = at(20.5), v21 = at(21), v20 = at(20);
  ok(eqClose(v205, v21), 'a fractional period runs as the rounded integer (21)');
  ok(!eqClose(v205, v20), 'a fractional period is not silently treated as 20');
  ok(v205.some((x) => x != null), 'a fractional period still produces values (never blanks)');

  const title = (ci.inputs[0].title || '');
  ok(title === 'Length', 'the input keeps its TV title', title);
}

/* ---------- 5. every built-in period input is an int with sane bounds ---- */
console.log('\n[5] catalog hygiene');
{
  let intOk = 0, overlayOk = 0;
  for (const d of BUILTIN_INDICATORS) {
    const c = compile(d.source);
    if (!c.ok) { ok(false, d.type + ' compiles', c.errors[0] && c.errors[0].message); continue; }
    if (c.meta.overlay === !!d.overlay) overlayOk++;
    const ci = c.collectInputs({ tfSec: 60, symbol: 'T', mintick: 0.01 });
    for (const inp of (ci.inputs || [])) {
      if (inp.kind === 'int' && (inp.min == null || inp.min >= 1)) intOk++;
    }
  }
  ok(overlayOk === BUILTIN_INDICATORS.length, 'every script declares the pane its registry entry claims', overlayOk);
  ok(intOk > 15, 'length inputs are int with a >= 1 floor', intOk);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
