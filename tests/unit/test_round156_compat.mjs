/**
 * test_round156_compat.mjs — ROUND156 v3/v4 compat + history depths
 *
 * Run: node tests/unit/test_round156_compat.mjs
 *
 * 1) study() is a first-class declaration (title/overlay honored, runs).
 * 2) v4 bare security(sym, tf, expr[, lookahead, gaps]) aliases
 *    request.security, incl. positional-bool -> barmerge-enum mapping.
 * 3) `when=` in strategy.* calls fails with a migration hint (not generic).
 * 4) History depths: OHLCV readable 10000 back, user vars capped by
 *    max_bars_back (default 5000, declaration-honored).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compile } from '../../src/core/pine/compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function makeBars(n, step) {
  const bars = [];
  const t0 = 1790600400 - (1790600400 % 900);
  let px = 200;
  for (let i = 0; i < n; i++) {
    const o = px, cl = o + Math.sin(i / 7) * 2;
    bars.push({ time: t0 + i * (step || 900), open: o, high: Math.max(o, cl) + 0.5,
      low: Math.min(o, cl) - 0.5, close: cl, volume: 100 });
    px = cl;
  }
  return bars;
}

/* 1) study() */
{
  const src = readFileSync(join(HERE, '..', '..', 'fixtures', 'pine', 'sample-Supertrend.pine'), 'utf8');
  const c = compile(src);
  ok(c.ok, 'v4 study() script compiles');
  ok(c.meta && c.meta.title === 'Supertrend' && c.meta.overlay === true, 'study title/overlay honored');
  const bars = makeBars(300);
  try {
    const rt = c.createInstance({ tfSec: 300, symbol: 'XAUUSD', serverOffSec: 0 });
    rt.runAll(bars);
    ok(rt.out.plots.size > 0, 'study script runs and plots');
  } catch (e) {
    ok(false, 'study script runs (-> ' + String((e && e.message) || e).slice(0, 100) + ')');
  }
}

/* 2) bare security() equivalence (M15 chart, H1 HTF) */
function secVals(exprSrc) {
  const src = '//@version=4\nindicator("s", overlay=true)\nplot(' + exprSrc + ', title="v")';
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + String((c.errors[0] && c.errors[0].message) || '') };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 0 });
    rt.runAll(makeBars(120));
    return { vals: rt.out.plots.get(rt.out.plotsOrder[0]).values };
  } catch (e) {
    return { error: 'run: ' + String((e && e.message) || e) };
  }
}
{
  const a = secVals('security(syminfo.tickerid, "60", close)');
  const b = secVals('request.security(syminfo.tickerid, "60", close)');
  const same = !a.error && !b.error && a.vals.length === b.vals.length
    && a.vals.every((v, i) => (v == null && b.vals[i] == null) || (v != null && b.vals[i] != null && Math.abs(v - b.vals[i]) < 1e-9));
  ok(!a.error, 'bare security() runs' + (a.error ? ' (-> ' + a.error.slice(0, 100) + ')' : ''));
  ok(same, 'bare security() ≡ request.security() on 120 bars');
  const c = secVals('security(syminfo.tickerid, "60", close, true)');
  const d = secVals('request.security(syminfo.tickerid, "60", close, lookahead=barmerge.lookahead_on)');
  const same2 = !c.error && !d.error && c.vals.every((v, i) => (v == null && d.vals[i] == null) || (v != null && d.vals[i] != null && Math.abs(v - d.vals[i]) < 1e-9));
  ok(same2, 'positional lookahead=true ≡ lookahead_on' + (c.error ? ' (-> ' + c.error.slice(0, 100) + ')' : ''));
}

/* 3) when= migration error */
{
  const src = '//@version=5\nstrategy("s", overlay=true)\nstrategy.entry("L", strategy.long, when=close > open)';
  const c = compile(src);
  let msg = '';
  if (c.ok) {
    try { c.createInstance({ tfSec: 60, symbol: 'T' }).runAll(makeBars(10)); }
    catch (e) { msg = String((e && e.message) || e); }
  }
  ok(/'when' was removed/.test(msg), 'when= gives the migration hint (got ' + msg.slice(0, 90) + ')');
}

/* 4) history depths over 6005 bars */
{
  const bars = makeBars(6005);
  const src = '//@version=6\nindicator("d", overlay=true)\nx = close\nplot(close[5001], title="c")\nplot(x[5001], title="x")';
  const c = compile(src);
  ok(c.ok, 'depth probe compiles');
  const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
  const t0 = Date.now();
  rt.runAll(bars);
  const ms = Date.now() - t0;
  const byTitle = {};
  for (const k of rt.out.plotsOrder) byTitle[rt.out.plots.get(k).title] = rt.out.plots.get(k).values;
  const last = bars.length - 1;
  ok(byTitle.c[last] != null && isFinite(byTitle.c[last]), 'OHLCV readable 5001 back (got ' + byTitle.c[last] + ')');
  ok(byTitle.x[last] == null, 'user var capped at default 5000 (got ' + byTitle.x[last] + ')');
  ok(ms < 30000, '6005-bar pass within budget (' + ms + 'ms)');
}
{
  // declaration-honored cap: max_bars_back=200
  const bars = makeBars(400);
  const src = '//@version=6\nindicator("d", overlay=true, max_bars_back=200)\nx = close\nplot(x[199], title="a")\nplot(x[201], title="b")\nplot(close[201], title="c")';
  const c = compile(src);
  const rt = c.createInstance({ tfSec: 900, symbol: 'T', maxBarsBack: (c.meta && c.meta.maxBarsBack) || undefined });
  rt.runAll(bars);
  const byTitle = {};
  for (const k of rt.out.plotsOrder) byTitle[rt.out.plots.get(k).title] = rt.out.plots.get(k).values;
  const last = bars.length - 1;
  ok(byTitle.a[last] != null, 'inside declared cap readable (x[199])');
  ok(byTitle.b[last] == null, 'beyond declared cap na (x[201])');
  ok(byTitle.c[last] != null, 'OHLCV exempt from the user cap (close[201])');
}

console.log('\nROUND156: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
