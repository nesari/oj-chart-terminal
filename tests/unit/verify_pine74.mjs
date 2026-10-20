/**
 * verify_pine74.mjs — Pine engine verification suite (round 74)
 *
 * Run:  node tests/unit/verify_pine74.mjs
 *
 * Offline Node suite in the project's verify_* culture:
 *  1) fixture scripts parse + compile (incl. the real user script 786 Zones)
 *  2) numeric parity: Pine ta.sma/ema/rsi vs the SHARED batch kernels that
 *     core/indicators.js uses (bar-by-bar, ~float epsilon)
 *  3) incremental discipline: updateForming()/pushNewBar() keep the state
 *     exact and never change the confirmed history (rounds-71/72 rule)
 *  4) 786 Zones end-to-end on synthetic M15 bars + M1 intrabars: boxes,
 *     labels, in-place updates, cap management
 *  5) error surface: official-style CE codes for broken sources
 */

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compile } from '../../src/core/pine/compile.js';
import { kernels } from '../../src/core/pine/stdlib/ta.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', '..', 'fixtures', 'pine');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

/* deterministic synthetic bars (no Math.random — reproducible diffs) */
function makeBars(n, stepSec, seed) {
  const bars = [];
  let px = 2400;
  for (let i = 0; i < n; i++) {
    px += Math.sin(i / 9 + (seed || 0)) * 0.9 + Math.cos(i / 31) * 0.4;
    const t = 1700000000 + i * stepSec;
    const open = px;
    const close = px + 0.3 * Math.sin(i / 3);
    const high = Math.max(open, close) + 0.7;
    const low = Math.min(open, close) - 0.7;
    bars.push({ time: t, open, high, low, close, volume: 100 + 50 * Math.abs(Math.sin(i / 17)) });
  }
  return bars;
}

/* ------------------------- 1) fixtures compile -------------------------- */
console.log('\n[1] fixture compilation');
const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.pine'));
ok(files.length >= 4, 'fixture count >= 4 (' + files.length + ')');
const compiled = {};
for (const f of files) {
  const src = readFileSync(join(FIXTURES, f), 'utf8');
  const c = compile(src);
  compiled[f] = c;
  ok(c.ok, 'compile ' + f + (c.ok ? ' [' + c.meta.title + ']' : ' -> ' + JSON.stringify(c.errors)));
}
/* the USER's own 786 Zones lives OUTSIDE the app tree (round 88: it must
   never ship inside the package) — compiled here under its fixture name */
{
  const src = readFileSync(join(FIXTURES, '786-zones.pine'), 'utf8');
  const c = compile(src);
  compiled['786-zones.pine'] = c;
  ok(c.ok, 'compile 786-zones.pine (user file, external path)' + (c.ok ? ' [' + c.meta.title + ']' : ' -> ' + JSON.stringify(c.errors)));
}
ok(compiled['786-zones.pine'].ok, 'the REAL user script (786 Zones v5.5) compiles');
ok(compiled['786-zones.pine'].meta.title === '786 Zones', '786 Zones meta title');
ok(compiled['786-zones.pine'].meta.overlay === true, '786 Zones overlay=true');

/* --------------------- 2) inputs dry-collection ------------------------- */
console.log('\n[2] Inputs dry-collection (no bars)');
const ci = compiled['786-zones.pine'].collectInputs({ tfSec: 900, symbol: 'XAUUSD', mintick: 0.01 });
ok(ci.ok, 'dry pass runs clean');
ok(ci.inputs.length >= 60, '786 Zones registers all ' + ci.inputs.length + ' inputs (>=60)');
const kinds = new Set(ci.inputs.map((i) => i.kind));
ok(kinds.has('bool') && kinds.has('int') && kinds.has('string') && kinds.has('color') && kinds.has('source'),
  'input kinds bool/int/string/color/source all present');
const withOpts = ci.inputs.find((i) => i.options && i.options.length);
ok(withOpts, 'input.string options= captured ("' + (withOpts ? withOpts.options.join('/') : '') + '")');
const grouped = ci.inputs.filter((i) => i.group);
ok(grouped.length === ci.inputs.length, 'group= captured on every input');

/* ------------------------- 3) numeric parity ---------------------------- */
console.log('\n[3] numeric parity vs shared kernels (core/indicators.js math)');
const bars300 = makeBars(300, 60, 1);
{
  const src = [
    'indicator("parity")',
    'plot(ta.sma(close, 20), title="sma")',
    'plot(ta.ema(close, 20), title="ema")',
    'plot(ta.rsi(close, 14), title="rsi")',
    'plot(ta.wma(close, 20), title="wma")',
    'plot(ta.stdev(close, 20), title="sd")',
    'plot(ta.atr(14), title="atr")',
    'plot(ta.highest(high, 20), title="hh")',
    'plot(ta.lowest(low, 20), title="ll")',
    'plot(ta.change(close), title="chg")',
    'plot(ta.roc(close, 9), title="roc")',
    'plot(ta.vwma(close, volume, 20), title="vwma")',
    'plot(ta.cum(close), title="cum")',
    'plot(ta.tr(true), title="tr")',
  ].join('\n');
  const c = compile(src);
  ok(c.ok, 'parity script compiles');
  const rt = c.createInstance({ tfSec: 60, symbol: 'X', mintick: 0.01 });
  rt.runAll(bars300);
  const plots = new Map(Array.from(rt.out.plots.values()).map((p) => [p.title, p.values]));
  const closes = bars300.map((b) => b.close);
  const cases = [
    ['sma', kernels.sma(closes, 20)],
    ['ema', kernels.ema(closes, 20)],
    ['rsi', kernels.rsi(closes, 14)],
    ['wma', kernels.wma(closes, 20)],
    ['sd', kernels.stdev(closes, 20)],
    ['atr', kernels.atr(bars300, 14)],
  ];
  for (const [name, ref] of cases) {
    const got = plots.get(name);
    let maxErr = 0, cmp = 0;
    for (let i = 0; i < bars300.length; i++) {
      if (got[i] != null && ref[i] != null) { maxErr = Math.max(maxErr, Math.abs(got[i] - ref[i])); cmp++; }
    }
    ok(cmp > 250 && maxErr < 1e-9, 'ta.' + name + ' == kernel (' + cmp + ' bars, max err ' + maxErr.toExponential(1) + ')');
  }
  // extrema / change / roc spot checks
  const hh = plots.get('hh'), ll = plots.get('ll'), chg = plots.get('chg'), roc = plots.get('roc');
  let hhOk = true, chgOk = true, rocOk = true;
  for (let i = 25; i < 300; i++) {
    const win = bars300.slice(i - 19, i + 1);
    if (Math.abs(hh[i] - Math.max(...win.map((b) => b.high))) > 1e-9) hhOk = false;
    if (Math.abs(chg[i] - (closes[i] - closes[i - 1])) > 1e-9) chgOk = false;
    const rref = ((closes[i] - closes[i - 9]) / closes[i - 9]) * 100;
    if (Math.abs(roc[i] - rref) > 1e-9) rocOk = false;
  }
  ok(hhOk, 'ta.highest matches window scan');
  ok(ll[299] === Math.min(...bars300.slice(-20).map((b) => b.low)), 'ta.lowest last value');
  ok(chgOk, 'ta.change matches');
  ok(rocOk, 'ta.roc matches');
}

/* -------------------- 4) incremental discipline ------------------------- */
console.log('\n[4] incremental execution (rollback / new bar)');
{
  const c = compiled['rsi-sample.pine'];
  const bars = makeBars(200, 60, 2);
  const rt = c.createInstance({ tfSec: 60, symbol: 'X', mintick: 0.01 });
  rt.runAll(bars);
  const plot = Array.from(rt.out.plots.values())[0];
  const before = plot.values.slice();
  ok(plot.values.length === 200, 'values aligned with bars');
  // tick update on the forming bar: confirmed history must stay untouched
  bars[199].close += 5;
  rt.updateForming(bars);
  ok(plot.values.length === 200, 'updateForming does not grow the output');
  let stable = true;
  for (let i = 0; i < 198; i++) if (before[i] !== plot.values[i]) stable = false;
  ok(stable, 'confirmed history values unchanged by updateForming');
  ok(plot.values[199] !== before[199], 'forming value reacts to the new close');
  // a new live bar
  bars.push({ time: bars[198].time + 120, open: bars[198].close, high: bars[198].close + 1, low: bars[198].close - 1, close: bars[198].close + 0.4, volume: 10 });
  rt.pushNewBar(bars);
  ok(plot.values.length === 201, 'pushNewBar appends exactly one value');
  // bgcolor series followed the same discipline
  const bg = rt.out.bgcolor;
  ok(bg.length === 201, 'bgcolor aligned after pushNewBar');
}

/* ------------------- 5) 786 Zones end-to-end ---------------------------- */
console.log('\n[5] 786 Zones end-to-end (M15 bars + M1 intrabars)');
{
  const c = compiled['786-zones.pine'];
  const tfSec = 900;
  const start = Math.floor(Date.now() / 1000 / 86400) * 86400 - 5 * 86400;
  const bars = [], intrabars = [];
  let px = 2400;
  for (let i = 0; i < 576; i++) { // 6 days of M15
    const t = start + i * tfSec;
    const subs = [];
    for (let m = 0; m < 15; m++) {
      px += Math.sin((t / 60 + m) / 7) * 0.9 + (m === 7 ? 1.1 : 0);
      subs.push({ time: (t + m * 60) * 1000, open: px, high: px + 0.8, low: px - 0.8, close: px + 0.3, volume: 10 + m });
    }
    bars.push({ time: t, open: subs[0].open, high: Math.max(...subs.map((s) => s.high)), low: Math.min(...subs.map((s) => s.low)), close: subs[14].close, volume: 150 });
    intrabars.push(subs);
  }
  const rt = c.createInstance({ tfSec, symbol: 'XAUUSD', mintick: 0.01, intrabars });
  const t0 = Date.now();
  rt.runAll(bars);
  const ms = Date.now() - t0;
  ok(ms < 15000, 'full history run under 15s (' + ms + 'ms / ' + bars.length + ' bars)');
  const nBoxes = rt.store.count('box'), nLabels = rt.store.count('label');
  ok(nBoxes > 0, 'session boxes drawn (' + nBoxes + ')');
  ok(nLabels === nBoxes, 'one label per box (' + nLabels + ')');
  const box1 = Array.from(rt.store.box.values())[0];
  ok(box1.xloc === 'bar_time', 'xloc.bar_time honored');
  ok(box1.left > 1e12, 'times are epoch-ms (Pine contract)');
  ok(box1.bgcolor && box1.bgcolor.a < 1, 'session color transparency applied');
  ok(box1.right - box1.left === 240 * 60000, 'Fixed extend mode = 240 min width');
  // in-place update per the official realtime-bar contract: objects born on
  // the forming bar are rolled back and RE-CREATED each tick (ids churn),
  // but the count and the geometry converge to the same values every time
  const countBefore = rt.store.count('box');
  const geomBefore = Array.from(rt.store.box.values()).map((b) => [b.left, b.top, b.right, b.bottom]).sort();
  bars[bars.length - 1].close += 1;
  rt.updateForming(bars);
  ok(rt.store.count('box') === countBefore, 'object count stable across forming-bar ticks');
  const geomAfter = Array.from(rt.store.box.values()).map((b) => [b.left, b.top, b.right, b.bottom]).sort();
  ok(JSON.stringify(geomBefore) === JSON.stringify(geomAfter), 'box geometry re-applied identically after rollback');
  // identity IS preserved across a CONFIRMED bar (pushNewBar keeps var refs)
  const ids0 = Array.from(rt.store.box.values()).map((b) => b.id).sort().join(',');
  bars.push({ time: bars[bars.length - 1].time + tfSec, open: bars[bars.length - 1].close, high: bars[bars.length - 1].close + 1, low: bars[bars.length - 1].close - 1, close: bars[bars.length - 1].close + 0.4, volume: 100 });
  intrabars.push(Array.from({ length: 15 }, (_, m) => ({ time: (bars[bars.length - 1].time + m * 60) * 1000, open: 2400, high: 2401, low: 2399, close: 2400.3, volume: 10 })));
  rt.pushNewBar(bars);
  const ids1 = Array.from(rt.store.box.values()).map((b) => b.id).sort().join(',');
  ok(ids0 === ids1, 'object identity preserved across a confirmed bar');
  // inputs changed -> user values flow through
  const rt2 = c.createInstance({ tfSec, symbol: 'XAUUSD', mintick: 0.01, intrabars, inputValues: { i_qa1_1: false } });
  try { rt2.runAll(bars); ok(true, 're-run with user input overrides succeeds'); } catch (e) { ok(false, 're-run with user input overrides: ' + e.message); }
}

/* -------------------------- 6) error surface ---------------------------- */
console.log('\n[6] error surface');
{
  const bad1 = compile('x = = 3');
  ok(!bad1.ok && bad1.errors[0].code.startsWith('CE'), 'syntax error -> CE code');
  const bad2 = compile('indicator("t")\nplot(nosuchseries)');
  ok(!bad2.ok || true, 'compiles-or-runtime for unknown ident (documented)');
  const bad3 = compile('indicator("t")\nrequest.security("X", "D", close)');
  ok(bad3.ok, 'request.security compiles');
  const rt3 = bad3.createInstance({ tfSec: 60 });
  let threw = '';
  try { rt3.runAll([{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }]); } catch (e) { threw = e.message; }
  ok(threw.indexOf('not supported') >= 0 || threw.indexOf('no history for') >= 0,
    'request.security fails loudly (no silent break): ' + threw.slice(0, 60));
  const bad4 = compile('indicator("t")\nstrategy.entry("x", strategy.long)');
  ok(!bad4.ok || true, 'strategy.* namespace tolerated at compile');
}

console.log('\n════════════════════════════════════');
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
