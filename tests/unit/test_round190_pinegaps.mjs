/**
 * test_round190_pinegaps.mjs — ROUND190 small Pine gaps (reference semantics).
 *
 * ta.nvi/pvi (seed 1.0, reference Pine), ta.iii (exact ratio, na on flat),
 * ta.percentrank (prev-window <=, strict na), log.info/warning/error
 * (format + return + Pine Logs collection). Closes §11 parked items whose
 * reference entries turned up in the v6 docs dump.
 *
 * Run: node tests/unit/test_round190_pinegaps.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function mkbars(closes, vols, t0) {
  const t = t0 || 1790600400 - (1790600400 % 900);
  return closes.map((c, i) => ({ time: t + i * 900, open: c, high: c + 1, low: c - 1, close: c, volume: vols ? vols[i] : 10 }));
}

function runIt(src, opts, barSet) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + JSON.stringify(c.errors).slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 0.01 }, opts || {}));
    rt.runAll(barSet);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

function plotVals(r) {
  const out = {};
  for (const k of r.rt.out.plotsOrder) out[r.rt.out.plots.get(k).title || k] = r.rt.out.plots.get(k).values;
  return out;
}
const last = (a) => a[a.length - 1];

/* --- nvi: falling volume + rising close accumulates from 1.0 --- */
{
  const closes = [100, 101, 102, 103, 104, 105];
  const vols = [50, 40, 30, 20, 10, 5];
  const r = runIt(`//@version=6
indicator("n")
plot(ta.nvi, title="nvi")
plot(ta.pvi, title="pvi")`, {}, mkbars(closes, vols));
  ok(!r.error, 'nvi/pvi run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const V = plotVals(r);
    ok(V.nvi[0] === 1.0, 'nvi seeds 1.0 (got ' + V.nvi[0] + ')');
    // reference: 1.0 -> each bar adds (dc/pc)*prev: 1.01, 1.01*102/101... compute: compounding +1%,+0.99%,...
    const exp = 1.01 * 102 / 101 * 103 / 102 * 104 / 103 * 105 / 104;
    ok(Math.abs(last(V.nvi) - exp) < 1e-9, 'nvi compounds on down-volume (got ' + last(V.nvi) + ' want ' + exp + ')');
    ok(last(V.pvi) === 1.0, 'pvi frozen while volume falls (got ' + last(V.pvi) + ')');
  }
}

/* --- pvi mirror: rising volume accumulates --- */
{
  const closes = [100, 101, 102, 103];
  const vols = [5, 10, 20, 40];
  const r = runIt(`//@version=6
indicator("p")
plot(ta.pvi, title="pvi")
plot(ta.nvi, title="nvi")`, {}, mkbars(closes, vols));
  ok(!r.error, 'pvi mirror runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const V = plotVals(r);
    const exp = 1.01 * 102 / 101 * 103 / 102;
    ok(Math.abs(last(V.pvi) - exp) < 1e-9, 'pvi compounds on up-volume (got ' + last(V.pvi) + ')');
    ok(last(V.nvi) === 1.0, 'nvi frozen while volume rises');
  }
}

/* --- iii exact + flat-bar na --- */
{
  const r = runIt(`//@version=6
indicator("i")
plot(ta.iii, title="iii")`, {}, [
    { time: 1000, open: 10, high: 12, low: 8, close: 11, volume: 100 },
    { time: 2000, open: 10, high: 10, low: 10, close: 10, volume: 50 },
  ]);
  ok(!r.error, 'iii runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const V = plotVals(r);
    // (22-12-8)/((12-8)*100) = 2/400 = 0.005
    ok(Math.abs(V.iii[0] - 0.005) < 1e-12, 'iii exact 0.005 (got ' + V.iii[0] + ')');
    const isNA = (v) => v == null || (typeof v === 'number' && !isFinite(v)) || (typeof v === 'object');
    ok(isNA(V.iii[1]), 'flat bar is na');
  }
}

/* --- percentrank: strict window semantics --- */
{
  const closes = [10, 20, 30, 40, 50, 5];
  const r = runIt(`//@version=6
indicator("pr")
plot(ta.percentrank(close, 4), title="pr")`, {}, mkbars(closes, null));
  ok(!r.error, 'percentrank runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const V = plotVals(r);
    const isNA = (v) => v == null || (typeof v === 'number' && !isFinite(v)) || (typeof v === 'object');
    ok(isNA(V.pr[0]) && isNA(V.pr[3]), 'early bars na (need 4 previous)');
    ok(V.pr[4] === 100, '50 beats all 4 previous (got ' + V.pr[4] + ')');
    ok(V.pr[5] === 0, '5 beats none (got ' + V.pr[5] + ')');
  }
  const r2 = runIt(`//@version=6
indicator("pr2")
plot(ta.percentrank(close, 2), title="pr")`, {}, [
    { time: 1000, open: 1, high: 1, low: 1, close: 10, volume: 1 },
    { time: 2000, open: 1, high: 1, low: 1, close: NaN, volume: 1 },
    { time: 3000, open: 1, high: 1, low: 1, close: 30, volume: 1 },
  ]);
  ok(!r2.error, 'percentrank na-window runs' + (r2.error ? ' -> ' + r2.error : ''));
  if (!r2.error) {
    const V = plotVals(r2);
    const isNA = (v) => v == null || (typeof v === 'number' && !isFinite(v)) || (typeof v === 'object');
    ok(isNA(V.pr[2]), 'na inside the window forces na');
  }
}

/* --- log.*: format + return + collection --- */
{
  const r = runIt(`//@version=6
indicator("lg")
plot(log.info("x={0}", 5) == "x=5" ? 1 : 0, title="fmt")
if bar_index == 2
    log.warning("w{0}", close)
if bar_index == 3
    log.error("boom")`, {}, mkbars([1, 2, 3, 4, 5], null));
  ok(!r.error, 'log.* runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const V = plotVals(r);
    ok(last(V.fmt) === 1, 'log.info returns the formatted string');
    const logs = r.rt.out.pineLogs || [];
    ok(logs.some((l) => l.level === 'warning' && l.msg === 'w3' && l.bar === 2), 'warning collected with bar (got ' + JSON.stringify(logs) + ')');
    ok(logs.some((l) => l.level === 'error' && l.msg === 'boom' && l.bar === 3), 'error collected');
    ok(logs.length <= 200, 'collection capped (got ' + logs.length + ')');
  }
}

/* --- §11 multiline item = input.textarea (exists, runs) --- */
{
  const r = runIt(`//@version=6
indicator("ta")
t = input.textarea("a\\nb", "Notes")
plot(close, title="c")`, {}, mkbars([1, 2, 3], null));
  ok(!r.error, 'input.textarea runs (multiline §11 item was this)' + (r.error ? ' -> ' + r.error : ''));
}

console.log('\nROUND190: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
