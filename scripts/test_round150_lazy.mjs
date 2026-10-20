/**
 * test_round150_lazy.mjs — ROUND150 lazy ?: + short-circuit and/or (TV parity)
 *
 * Run: node scripts/test_round150_lazy.mjs
 *
 * TV evaluates ONLY the taken ternary branch and short-circuits and/or
 * (Kleene na-logic: plain false dominates `and`, plain true dominates
 * `or`, else na). The engine used to run both sides always, so ta.*
 * inside untaken code still advanced history (silent wrong numbers) and
 * guarded throws (e.g. array.get out of bounds) fired spuriously.
 * Probe: array.get(99) THROWS when evaluated — reaching it is observable.
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
  let px = 100;
  for (let i = 0; i < (n || 20); i++) {
    const o = px, cl = o + (i % 2 === 0 ? 1 : -1);
    bars.push({ time: t0 + i * 900, open: o, high: Math.max(o, cl) + 0.3,
      low: Math.min(o, cl) - 0.3, close: cl, volume: 10 });
    px = cl;
  }
  return bars;
}

function run(src, n) {
  const c = compile(src);
  if (!c.ok) return { compileError: c.errors };
  const bars = makeBars(n);
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 0 });
    rt.runAll(bars);
    return { rt, bars };
  } catch (e) {
    return { runError: String((e && e.message) || e) };
  }
}

const HEAD = '//@version=6\nindicator("t", overlay=true)\n';

/* 1) short-circuit: guarded throw never fires */
{
  const r = run(HEAD + 'a = array.from(1, 2)\nv = false and a.get(99) == 1\nplot(v ? 1 : 0, title="v")');
  ok(!r.runError, 'false and <throw> does not evaluate the right side' + (r.runError ? ' -> ' + r.runError : ''));
  if (!r.runError) {
    const vals = r.rt.out.plots.get(r.rt.out.plotsOrder[0]).values;
    ok(vals.every((x) => x === 0), 'false and ... is false on every bar');
  }
}
{
  const r = run(HEAD + 'a = array.from(1, 2)\nv = true or a.get(99) == 1\nplot(v ? 1 : 0, title="v")');
  ok(!r.runError, 'true or <throw> does not evaluate the right side' + (r.runError ? ' -> ' + r.runError : ''));
  if (!r.runError) {
    const vals = r.rt.out.plots.get(r.rt.out.plotsOrder[0]).values;
    ok(vals.every((x) => x === 1), 'true or ... is true on every bar');
  }
}
{
  /* non-decisive side still evaluates (and throws) — laziness is not blindness */
  const r = run(HEAD + 'a = array.from(1, 2)\nv = true and a.get(99) == 1\nplot(v ? 1 : 0, title="v")');
  ok(!!r.runError, 'true and <throw> still evaluates (throws)');
}

/* 2) Kleene na-logic, observed through the na() predicate (a plot cannot
      tell na from false, so we ask na() directly) */
{
  const r = run(HEAD + 'big = close[100000]\n'
    + 'p = na(false and big) ? 1 : 0\n'
    + 'q = na(true or big) ? 1 : 0\n'
    + 's = na(big and big) ? 1 : 0\n'
    + 't = na(big and true) ? 1 : 0\n'
    + 'u = na(big or false) ? 1 : 0\n'
    + 'plot(p, title="p")\nplot(q, title="q")\nplot(s, title="s")\nplot(t, title="t")\nplot(u, title="u")');
  if (!r.runError) {
    const get = (t) => r.rt.out.plots.get(r.rt.out.plotsOrder.find((k) => r.rt.out.plots.get(k).title === t)).values;
    ok(get('p').every((x) => x === 0), 'false and na -> false (na(false) is false)');
    ok(get('q').every((x) => x === 0), 'true or na -> true (na(true) is false)');
    ok(get('s').every((x) => x === 1), 'na and na -> na');
    ok(get('t').every((x) => x === 1), 'na and true -> na');
    ok(get('u').every((x) => x === 1), 'na or false -> na');
  } else ok(false, 'kleene plots run -> ' + r.runError);
}

/* 3) lazy ternary: untaken branch with throw never fires */
{
  const r = run(HEAD + 'a = array.from(1)\nv = bar_index >= 0 ? 7 : a.get(99)\nplot(v, title="v")');
  ok(!r.runError, 'taken-branch-only: untaken throw never fires' + (r.runError ? ' -> ' + r.runError : ''));
  if (!r.runError) {
    const vals = r.rt.out.plots.get(r.rt.out.plotsOrder[0]).values;
    ok(vals.every((x) => x === 7), 'taken value on every bar');
  }
}

/* 4) lazy ternary: ta.* history does NOT advance in untaken branches */
{
  const r = run(HEAD + 'y = bar_index >= 5 ? ta.sma(close, 3) : na\nplot(y, title="y")', 20);
  if (!r.runError) {
    const vals = r.rt.out.plots.get(r.rt.out.plotsOrder[0]).values;
    ok(vals[5] == null, 'sma seen only 1 bar at bar 5 -> na (eager would average bars 3-5)');
    const exp7 = (r.bars[5].close + r.bars[6].close + r.bars[7].close) / 3;
    ok(vals[7] != null && Math.abs(vals[7] - exp7) < 1e-9, 'sma(3) built from bars 5-7 only (got ' + vals[7] + ', exp ' + exp7 + ')');
  } else ok(false, 'sma-lazy run -> ' + r.runError);
}

/* 5) laziness does not break the common ratchet idiom (pure branches) */
{
  const r = run(HEAD + 'x = 0.0\npx = nz(x[1], close)\nx := close > px ? close : px\nplot(x, title="x")', 20);
  if (!r.runError) {
    const vals = r.rt.out.plots.get(r.rt.out.plotsOrder[0]).values;
    let mx = -Infinity, good = true;
    for (let i = 0; i < r.bars.length; i++) {
      mx = Math.max(mx, r.bars[i].close);
      if (Math.abs(vals[i] - mx) > 1e-9) good = false;
    }
    ok(good, 'running-max ratchet identical under lazy eval');
  } else ok(false, 'ratchet run -> ' + r.runError);
}

console.log('\nROUND150: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
