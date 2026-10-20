/**
 * test_round208_named.mjs — ROUND208 named-arguments parity (TV parity).
 *
 * Canonical argument names fill empty positional slots at dispatch
 * (request/ta/math/str/color/ticker/timeframe); unknown names are loud like
 * TV. Before this, named values were silently dropped: timeframe= never
 * bucketed, source= sma'd na, transp= never applied, sym= failed.
 *
 * Run: node tests/unit/test_round208_named.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const T0 = 1790600400 - (1790600400 % 900);
const BARS = Array.from({ length: 24 }, (_, i) => ({
  time: T0 + i * 900, open: 100 + i, high: 100 + i + 0.6, low: 100 + i - 0.6,
  close: 100 + i + 0.5, volume: 10,
}));
const HEAD = '//@version=5\nindicator("T", overlay=true)\n';
function runIt(body, bars) {
  const c = compile(HEAD + body);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', mintick: 0.01 });
    rt.runAll(bars || BARS);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
const hist = (rt, name) => rt.globals.get(name).hist.a.slice();
const norm = (v) => JSON.stringify(v, (k, x) => (x && x.__pineNA ? 'na' : (x && x.__pineObj ? 'obj#' + x.id : x)));
const eqHist = (a, b) => a.length === b.length && a.every((v, i) => norm(v) === norm(b[i]));

/* ---------- request.security ---------- */
{
  const p = runIt('a = request.security(syminfo.tickerid, "60", close)\nplot(a)\n');
  const n = runIt('a = request.security(syminfo.tickerid, timeframe="60", expression=close)\nplot(a)\n');
  ok(!p.error && !n.error, 'security named runs' + (n.error ? ' -> ' + n.error : ''));
  if (!p.error && !n.error) {
    ok(eqHist(hist(p.rt, 'a'), hist(n.rt, 'a')), 'named timeframe= buckets like positional');
    ok(hist(n.rt, 'a')[20] === 119.5, 'H1 value correct (got ' + JSON.stringify(hist(n.rt, 'a')[20]) + ')');
  }
}
{
  const r = runIt('a = request.security(symbol=syminfo.tickerid, timeframe="60", expression=close)\nplot(a)\n');
  ok(!r.error && hist(r.rt, 'a')[20] === 119.5, 'all-named security');
}
{
  const r = runIt('a = request.security(syminfo.tickerid, timeframe="60", close)\nplot(a)\n');
  ok(!!r.error && /positional argument cannot follow/.test(r.error), 'positional-after-named loud (TV rule)' + (r.error ? ' -> ' + r.error.slice(0, 80) : ''));
}
{
  const r = runIt('a = request.security(syminfo.tickerid, "60", close, foo=1)\nplot(a)\n');
  ok(!!r.error && /unknown argument/.test(r.error), 'security unknown named loud' + (r.error ? ' -> ' + r.error.slice(0, 80) : ''));
}
{
  const r = runIt('a = request.security(syminfo.tickerid, "60", close, gaps=barmerge.gaps_on, lookahead=barmerge.lookahead_off, calc_bars_count=500)\nplot(a)\n');
  ok(!r.error, 'gaps/lookahead/calc_bars_count named still accepted' + (r.error ? ' -> ' + r.error : ''));
}
{
  // lower_tf named
  const p = runIt('a = request.security_lower_tf(syminfo.tickerid, "1", close)\nplot(array.sum(a))\n');
  const n = runIt('a = request.security_lower_tf(symbol=syminfo.tickerid, timeframe="1", expression=close)\nplot(array.sum(a))\n');
  ok(!p.error && !n.error, 'lower_tf named runs' + (n.error ? ' -> ' + n.error : ''));
}

/* ---------- ta.* ---------- */
function sameAs(bodyNamed, bodyPos, name) {
  const p = runIt(bodyPos + '\nplot(v)\n'.replace('v', name));
  const n = runIt(bodyNamed + '\nplot(v)\n'.replace('v', name));
  if (p.error || n.error) { ok(false, name + ' runs' + (n.error ? ' -> ' + n.error : p.error ? ' -> ' + p.error : '')); return; }
  ok(eqHist(hist(p.rt, name), hist(n.rt, name)), name + ' named == positional');
}
sameAs('v = ta.sma(source=close, length=3)', 'v = ta.sma(close, 3)', 'v');
sameAs('v = ta.ema(close, length=5)', 'v = ta.ema(close, 5)', 'v');
sameAs('v = ta.macd(close, fastlength=12, slowlength=26, signallength=9)', 'v = ta.macd(close, 12, 26, 9)', 'v');
sameAs('v = ta.supertrend(factor=3, atr_length=10)', 'v = ta.supertrend(3, 10)', 'v');
sameAs('v = ta.sar(start=0.02, increment=0.02, max=0.2)', 'v = ta.sar(0.02, 0.02, 0.2)', 'v');
{
  const p = runIt('v = ta.vwma(close, volume, 5)\nplot(v)\n');
  const n = runIt('v = ta.vwma(source=close, volume=volume, length=5)\nplot(v)\n');
  ok(!p.error && !n.error && eqHist(hist(p.rt, 'v'), hist(n.rt, 'v')), 'ta.vwma named (volume, not vol)');
}
{
  const p = runIt('v = ta.crossover(close, open)\nplot(v ? 1 : 0)\n');
  const n = runIt('v = ta.crossover(source1=close, source2=open)\nplot(v ? 1 : 0)\n');
  ok(!p.error && !n.error && eqHist(hist(p.rt, 'v'), hist(n.rt, 'v')), 'ta.crossover source1/source2');
}
{
  // pivot 2-arg overload via named (implicit high)
  const r = runIt('v = ta.pivothigh(leftbars=2, rightbars=2)\nplot(v)\n');
  ok(!r.error, 'pivothigh named 2-arg runs' + (r.error ? ' -> ' + r.error : ''));
}
{
  const r = runIt('v = ta.sma(src=close, length=3)\nplot(v)\n');
  ok(!!r.error && /unknown argument 'src'/.test(r.error), 'wrong param name loud (src vs source)' + (r.error ? ' -> ' + r.error.slice(0, 80) : ''));
}

/* ---------- math / str / color ---------- */
{
  const r = runIt('v = math.pow(base=2, exponent=8)\nplot(v)\n');
  ok(!r.error && hist(r.rt, 'v').pop() === 256, 'math.pow named');
}
{
  const r = runIt('v = math.round(number=2.345, precision=2)\nplot(v)\n');
  ok(!r.error && Math.abs(hist(r.rt, 'v').pop() - 2.35) < 1e-9, 'math.round named');
}
{
  const r = runIt('v = math.max(a=1, b=close)\nplot(v)\n');
  ok(!!r.error && /unknown argument/.test(r.error), 'math.max named loud (variadic, TV rejects)' + (r.error ? ' -> ' + r.error.slice(0, 80) : ''));
}
{
  const p = runIt('v = str.tostring(close, "#.##")\nplot(v)\n');
  const n = runIt('v = str.tostring(value=close, format="#.##")\nplot(v)\n');
  ok(!p.error && !n.error && eqHist(hist(p.rt, 'v'), hist(n.rt, 'v')), 'str.tostring named');
}
{
  const p = runIt('v = str.split("a,b", ",")\nplot(array.size(v))\n');
  const n = runIt('v = str.split(string="a,b", separator=",")\nplot(array.size(v))\n');
  ok(!p.error && !n.error && eqHist(hist(p.rt, 'v'), hist(n.rt, 'v')), 'str.split named');
}
{
  const r = runIt('c = color.new(color=color.red, transp=50)\nplot(close, color=c)\n');
  ok(!r.error, 'color.new named runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const c = r.rt.globals.get('c').value;
    const css = c && c.css ? c.css() : '';
    ok(/0\.5/.test(css), 'transp=50 applied (' + css + ')');
  }
}
{
  const p = runIt('c = color.rgb(255, 0, 0, 50)\nplot(close, color=c)\n');
  const n = runIt('c = color.rgb(red=255, green=0, blue=0, transparency=50)\nplot(close, color=c)\n');
  ok(!p.error && !n.error, 'color.rgb named runs' + (n.error ? ' -> ' + n.error : ''));
  if (!p.error && !n.error) {
    const css = (rt, nm) => { const c = rt.globals.get(nm).value; return c && c.css ? c.css() : ''; };
    ok(css(p.rt, 'c') === css(n.rt, 'c'), 'color.rgb named == positional');
  }
}

/* ---------- ticker / timeframe ---------- */
{
  const p = runIt('t = ticker.renko(syminfo.tickerid, "", 2)\nplot(request.security(t, "", close))\n');
  const n = runIt('t = ticker.renko(symbol=syminfo.tickerid, brick_size=2)\nplot(request.security(t, "", close))\n');
  ok(!p.error && !n.error, 'ticker.renko named runs' + (n.error ? ' -> ' + n.error : ''));
}
{
  const r = runIt('t = ticker.pointfigure(symbol=syminfo.tickerid, timeframe="", box_size=1, reversal_size=3)\nplot(request.security(t, "", close))\n');
  ok(!r.error, 'ticker.pointfigure all-named runs' + (r.error ? ' -> ' + r.error : ''));
}
{
  const r = runIt('v = timeframe.in_seconds(timeframe="D")\nplot(v)\n');
  ok(!r.error && hist(r.rt, 'v').pop() === 86400, 'timeframe.in_seconds named');
}
{
  const r = runIt('tf = input.timeframe("D", "TF")\nnt = timeframe.change(timeframe=tf)\nplot(1)\n');
  ok(!r.error && hist(r.rt, 'nt').pop() === false, 'timeframe.change named steady');
}
{
  const r = runIt('nt = timeframe.change(foo=1)\nplot(1)\n');
  ok(!!r.error && /unknown argument/.test(r.error), 'timeframe.change unknown loud' + (r.error ? ' -> ' + r.error.slice(0, 80) : ''));
}

console.log('\nROUND208: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
