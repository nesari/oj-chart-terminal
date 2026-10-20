/**
 * test_round206_gaps.mjs — ROUND206 small-gap batch (TV parity).
 *
 * 1. currency.* full roster + strategy(currency=currency.X) folds into the
 *    broker cfg (used to resolve to undefined -> silent USD).
 * 2. timeframe.change(tf) — true when the arg differs from its previous-bar
 *    value (SMC FVG switch detection; used to be silent na).
 * 3. timeframe.period/multiplier on seconds/week-multiple/month charts +
 *    tfSeconds("15S").
 * 4. Pins (already-complete): display.* x6 + arithmetic, linefill full API.
 *
 * Run: node tests/unit/test_round206_gaps.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const BARS = Array.from({ length: 6 }, (_, i) => {
  const t0 = 1790600400 - (1790600400 % 900);
  const o = 100 + i;
  return { time: t0 + i * 900, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 };
});
const HEAD = `//@version=5
indicator("T", overlay=true)
`;
const SHEAD = `//@version=5
strategy("T", overlay=true)
`;
function runIt(body, opts, shead) {
  const c = compile((shead || HEAD) + body);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 1 }, opts));
    rt.runAll(BARS);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
const histVals = (rt, name) => {
  const rec = rt.globals.get(name);
  if (!rec || !rec.hist) return null;
  return rec.hist.a.slice();
};
const lastOf = (rt, name) => {
  const v = histVals(rt, name);
  if (!v) return 'nohist';
  return v.length ? v[v.length - 1] : rt.globals.get(name).value;
};

/* --- currency --- */
{
  const r = runIt('plot(1)\n', {}, SHEAD.replace('strategy("T"', 'strategy("T", currency=currency.GBP'));
  ok(!r.error, 'GBP strategy runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.rt.broker.cfg.currency === 'GBP', 'broker cfg currency GBP (got ' + r.rt.broker.cfg.currency + ')');
  }
}
{
  const r = runIt('c = strategy.account_currency\nplot(1)\n', {}, SHEAD.replace('strategy("T"', 'strategy("T", currency=currency.JPY'));
  ok(!r.error && lastOf(r.rt, 'c') === 'JPY', 'account_currency JPY');
}
{
  const r = runIt('plot(1)\n', {}, SHEAD);
  ok(!r.error && r.rt.broker.cfg.currency === 'USD', 'default currency stays USD');
}
{
  // roster spot-checks (name resolution is the old failure mode)
  const r = runIt('a = currency.ZAR\nb = currency.NONE\nplot(1)\n');
  ok(!r.error, 'exotic codes resolve' + (r.error ? ' -> ' + r.error : ''));
}

/* --- timeframe.change --- */
{
  const r = runIt('t = timeframe.change(bar_index % 2 == 0 ? "D" : "W")\nplot(1)\n');
  ok(!r.error, 'alternating change runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const vals = histVals(r.rt, 't');
    ok(vals && vals[0] === false, 'bar0 false (no previous)');
    ok(vals && vals.slice(1).every((v) => v === true), 'bars 1..N true on flip');
  }
}
{
  const r = runIt('c = timeframe.change("D")\nplot(1)\n');
  ok(!r.error && lastOf(r.rt, 'c') === false, 'constant never changes');
}
{
  // SMC shape: input.timeframe held steady -> no spurious reset
  const r = runIt('tf = input.timeframe("D", "TF")\nnt = timeframe.change(tf)\nplot(1)\n');
  ok(!r.error && lastOf(r.rt, 'nt') === false, 'steady input.timeframe -> false');
}

/* --- period / multiplier / in_seconds --- */
{
  const r = runIt('p = timeframe.period\nm = timeframe.multiplier\nplot(1)\n', { tfSec: 15 });
  ok(!r.error && lastOf(r.rt, 'p') === '15S' && lastOf(r.rt, 'm') === 15, '15S chart: period/multiplier');
}
{
  const r = runIt('p = timeframe.period\nm = timeframe.multiplier\ns = timeframe.in_seconds("15S")\nplot(1)\n', { tfSec: 15 });
  ok(!r.error && lastOf(r.rt, 's') === 15, 'in_seconds("15S") = 15');
}
{
  const r = runIt('p = timeframe.period\nm = timeframe.multiplier\nplot(1)\n', { tfSec: 1209600 });
  ok(!r.error && lastOf(r.rt, 'p') === '2W' && lastOf(r.rt, 'm') === 2, '2W chart: period/multiplier');
}
{
  const r = runIt('p = timeframe.period\nm = timeframe.multiplier\nplot(1)\n', { tfSec: 2592000 });
  ok(!r.error && lastOf(r.rt, 'p') === 'M' && lastOf(r.rt, 'm') === 1, '1M chart: period/multiplier');
}
{
  const r = runIt('p = timeframe.period\nplot(1)\n', { tfSec: 900 });
  ok(!r.error && lastOf(r.rt, 'p') === '15', '15m chart unchanged');
}

/* --- pins: display + linefill (complete per TV; must not regress) --- */
{
  const r = runIt('plot(close, display=display.none)\nplot(open, display=display.all - display.price_scale)\nplot(high, display=display.pane)\n');
  ok(!r.error, 'display consts + arithmetic in plots' + (r.error ? ' -> ' + r.error : ''));
}
{
  const r = runIt('d = display.data_window\ns = display.status_line\nplot(1)\n');
  ok(!r.error, 'remaining display consts resolve' + (r.error ? ' -> ' + r.error : ''));
}
{
  const r = runIt('a = line.new(bar_index, high, bar_index + 1, high)\nb = line.new(bar_index, low, bar_index + 1, low)\nf = linefill.new(a, b, color.red)\nlinefill.set_color(f, color.blue)\ng1 = linefill.get_line1(f)\ng2 = linefill.get_line2(f)\nplot(1)\n');
  ok(!r.error, 'linefill full API ok' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const rt = r.rt;
    ok(rt.globals.get('g1').value === rt.globals.get('a').value, 'get_line1 identity');
    ok(rt.globals.get('g2').value === rt.globals.get('b').value, 'get_line2 identity');
  }
}

console.log('\nROUND206: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
