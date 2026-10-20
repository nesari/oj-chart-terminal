/**
 * test_round225_strategy.mjs — ROUND225 strategy parity (TV v6 migration guide).
 *
 * strategy.exit pairs (v6 first-trigger vs v5 absolute-shadows-relative),
 * pyramiding default/0/2 parity pins (no change — probe proved it), v6
 * removals (iff/offset-fn/transp/literal-history/alertcondition-in-strategy),
 * timeframe.period multiplier, v6 color tones, max_counts default 50, for-to
 * per-iteration bound (v6), fill-alert collection.
 *
 * Run: node scripts/test_round225_strategy.mjs
 */

import { compile } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
function mkBars(n, o, h, l, c) {
  const bars = [];
  for (let i = 0; i < n; i++) bars.push({ time: 1700000000 + i * 60, open: o, high: h, low: l, close: c, volume: 10 });
  return bars;
}
/* default chart for bare runAll(src) calls (flat 10-bar series). */
const BARS = mkBars(10, 1, 1, 1, 1);
function runAll(src, bars, opts) {
  const c = compile(src);
  if (!c.ok) return { err: 'COMPILE: ' + ((c.errors[0] || {}).message || '?') };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 60, symbol: 'T', mintick: 1 }, opts));
    rt.runAll(bars || BARS);
    return { rt };
  } catch (e) { return { err: 'RUNTIME: ' + (e.message || e) }; }
}
const g = (r, n) => { const rec = r.rt && r.rt.globals.get(n); return rec ? rec.value : '<missing>'; };

// 1-3: exit pairs — v6 first-trigger vs v5 absolute shadow
{
  // long, entry bar0 fills bar1 @100. TP=102/SL=95 both touched, TP first on path.
  const bars = mkBars(6, 100, 103, 94, 100);
  const body = 'strategy("T")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 0\n    strategy.exit("X", from_entry="L", profit=2, loss=5, qty=1)\n';
  const v6 = runAll('//@version=6\n' + body, bars);
  const t6 = v6.rt && v6.rt.broker.trades[0];
  ok(!v6.err && t6 && t6.exitPrice === 102, 'v6 TP-first wins over touched SL (got ' + (t6 && t6.exitPrice) + ')');
  // v5 with absolute pair shadowing: profit shadowed by limit, loss by stop.
  // ROUND235 (TV parity): limit=99 sits below the 100 open, so the sell
  // limit is marketable and fills at the open (was 99 under the old
  // entry-sided immediates). TP=100 would win first in v6 either way.
  const bars2 = [Object.assign({}, mkBars(6, 100, 101, 98.5, 100)[0])];
  for (let i = 1; i < 6; i++) bars2.push({ time: 1700000000 + i * 60, open: 100, high: 101, low: 98.5, close: 100, volume: 10 });
  const b2 = 'strategy("T")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 0\n    strategy.exit("X", from_entry="L", profit=0, limit=99, qty=1)\n';
  const v5 = runAll('//@version=5\n' + b2, bars2);
  const t5 = v5.rt && v5.rt.broker.trades[0];
  ok(!v5.err && t5 && t5.exitPrice === 100, 'v5 limit shadows profit=0, marketable at open (got ' + (t5 && t5.exitPrice) + ')');
  const v6b = runAll('//@version=6\n' + b2, bars2);
  const t6b = v6b.rt && v6b.rt.broker.trades[0];
  ok(!v6b.err && t6b && t6b.exitPrice === 100, 'v6 TP=entry wins first over limit (got ' + (t6b && t6b.exitPrice) + ')');
}
// 4: v5 relative-only keeps loss-first
{
  const bars = mkBars(6, 100, 103, 94, 100);
  const body = 'strategy("T")\nif bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 0\n    strategy.exit("X", from_entry="L", profit=2, loss=5, qty=1)\n';
  const v5 = runAll('//@version=5\n' + body, bars);
  const t5 = v5.rt && v5.rt.broker.trades[0];
  ok(!v5.err && t5 && t5.exitPrice === 95, 'v5 relative-only loss-first unchanged (got ' + (t5 && t5.exitPrice) + ')');
}
// 5-7: pyramiding parity pins (behavior-neutral R225)
{
  const B = mkBars(10, 100, 101, 99, 100);
  const mk = (decl) => runAll('//@version=6\nstrategy("T"' + decl + ')\nif bar_index % 2 == 0\n    strategy.entry("L", strategy.long)\nx = strategy.position_size\nplot(1)\n', B);
  ok(g(mk(''), 'x') === 1, 'default blocks adds (qty=1)');
  ok(g(mk(', pyramiding=0'), 'x') === 1, 'explicit 0 blocks adds like TV');
  ok(g(mk(', pyramiding=2'), 'x') === 2, 'explicit 2 allows one add');
}
// 8-11: v6 removals loud, older lenient
{
  const H6 = '//@version=6\nindicator("T", overlay=true)\n';
  const iff6 = runAll(H6 + 'x = iff(true, 1, 0)\nplot(1)\n');
  ok(iff6.err && /removed in Pine v5/.test(iff6.err), 'v6 iff() loud');
  const iff4 = runAll('//@version=4\nstudy("T")\nx = iff(true, 1, 0)\nplot(1)\n');
  ok(!iff4.err && g(iff4, 'x') === 1, 'v4 iff() still works');
  const off6 = runAll(H6 + 'x = offset(close, 1)\nplot(1)\n');
  ok(off6.err && /removed in Pine v5/.test(off6.err), 'v6 offset() loud');
  const acS = runAll('//@version=6\nstrategy("T")\nif bar_index > 0\n    strategy.entry("L", strategy.long)\nalertcondition(close > open, title="X", message="m")\n', mkBars(10, 100, 101, 99, 100));
  ok(acS.err && /cannot be used in strategy/.test(acS.err), 'alertcondition loud in strategy');
  const acI = runAll(H6 + 'alertcondition(close > open, title="X", message="m")\nplot(1)\n');
  ok(!acI.err, 'alertcondition fine in indicator');
}
// 12-13: literal/const history gate v6
{
  const lit6 = runAll('//@version=6\nindicator("T")\nplot(5[1])\n');
  ok(lit6.err && /literal/.test(lit6.err), 'v6 history on literal loud');
  const lit5 = runAll('//@version=5\nindicator("T")\nplot(5[1])\n');
  ok(!lit5.err, 'v5 history on literal lenient');
  const cst6 = runAll('//@version=6\nindicator("T")\nplot(color.red[1] == color.red ? 1 : 0)\n');
  ok(cst6.err && /built-in constants/.test(cst6.err), 'v6 history on const loud');
}
// 14-15: period multiplier + tones
{
  const p6 = runAll('//@version=6\nindicator("T")\nx = timeframe.period\nplot(1)\n', mkBars(4, 1, 1, 1, 1), { tfSec: 86400 });
  const p5 = runAll('//@version=5\nindicator("T")\nx = timeframe.period\nplot(1)\n', mkBars(4, 1, 1, 1, 1), { tfSec: 86400 });
  ok(!p6.err && g(p6, 'x') === '1D' && !p5.err && g(p5, 'x') === 'D', 'period 1D vs D (got ' + g(p6, 'x') + '/' + g(p5, 'x') + ')');
  const t6 = runAll('//@version=6\nindicator("T")\nr = color.red\ng = color.teal\ny = color.yellow\nplot(1)\n');
  const css = (v) => v && v.css ? v.css() : '?';
  ok(!t6.err && /242/.test(css(g(t6, 'r'))) && /8,\s*153,\s*129/.test(css(g(t6, 'g'))) && /253,\s*216,\s*53/.test(css(g(t6, 'y'))), 'v6 tones (got ' + css(g(t6, 'r')) + '/' + css(g(t6, 'g')) + ')');
}
// 16-17: max_counts default 50 + clamp
{
  const c = compile('//@version=6\nindicator("T")\nplot(1)\n');
  ok(c.ok && c.meta.maxCounts.line === 50 && c.meta.maxCounts.polyline === 50, 'default caps 50');
  const c2 = compile('//@version=6\nindicator("T", max_lines_count=120, max_boxes_count=9999)\nplot(1)\n');
  ok(c2.ok && c2.meta.maxCounts.line === 120 && c2.meta.maxCounts.box === 500, 'explicit honored, clamped to 500');
  const r = runAll('//@version=6\nindicator("T")\nif true\n    line.new(bar_index, close, bar_index, close)\nplot(1)\n', mkBars(120, 100, 101, 99, 100));
  ok(!r.err && r.rt.store.line.size === 50 && r.rt.store.gced === 70, 'oldest GC past 50 (size=' + (r.rt && r.rt.store.line.size) + ' gced=' + (r.rt && r.rt.store.gced) + ')');
}
// 18: for-to per-iteration bound (v6) vs frozen (v5)
{
  const body = 'n = 0\nlim = 5\nfor i = 0 to lim\n    lim := lim - 1\n    n := n + 1\nx = n\nplot(1)\n';
  const v6 = runAll('//@version=6\nindicator("T")\n' + body);
  const v5 = runAll('//@version=5\nindicator("T")\n' + body);
  ok(!v6.err && g(v6, 'x') === 3 && !v5.err && g(v5, 'x') === 6, 'v6 bound re-evaluated (got ' + g(v6, 'x') + '), v5 frozen (' + g(v5, 'x') + ')');
}
// 19: fill-alert collection
{
  const r = runAll('//@version=6\nstrategy("T")\nif bar_index == 2\n    strategy.entry("L", strategy.long, alert_message="fill-msg")\n', mkBars(10, 100, 101, 99, 100));
  const al = r.rt && r.rt.out.alerts;
  ok(!r.err && Array.isArray(al) && al.some((a) => a.message === 'fill-msg' && a.fill === true), 'fill alert_message collected');
}

console.log('\nROUND225: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
