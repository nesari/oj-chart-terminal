/**
 * test_round223_gaps.mjs — ROUND223 small gaps (audit row B).
 *
 * weekofyear (ISO), bid/ask=na, max_bars_back() accept-ignore,
 * timeframe.from_seconds, syminfo.main_tickerid/basecurrency,
 * time_close() session overload, request.security_heikinashi parity,
 * force_overlay stored (line/box/label), opentrades absolute excursions,
 * closedtrades.first_index + 9000 trim, alert_message persistence,
 * entry/exit id+bar pins, dynamic for-bounds, box.set_xloc pin.
 *
 * Run: node tests/unit/test_round223_gaps.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
const BARS = [];
for (let i = 0; i < 60; i++) {
  BARS.push({ time: 1700000000 + i * 3600, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000 });
}
function runAll(src, bars, opts) {
  const c = compile(src);
  if (!c.ok) return { err: 'COMPILE: ' + ((c.errors[0] || {}).message || '?') };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 3600, symbol: 'EURUSD', mintick: 0.00001 }, opts));
    rt.runAll(bars || BARS);
    return { rt };
  } catch (e) { return { err: 'RUNTIME: ' + (e.message || e) }; }
}
const g = (r, n) => { const rec = r.rt && r.rt.globals.get(n); return rec ? rec.value : '<missing>'; };
const H6 = '//@version=6\nindicator("T", overlay=true)\n';

// independent ISO-week reference
function refWeek(ms) {
  const d = new Date(ms), day = (d.getUTCDay() + 6) % 7;
  const th = new Date(d); th.setUTCDate(d.getUTCDate() - day + 3);
  const f = new Date(Date.UTC(th.getUTCFullYear(), 0, 4));
  const fd = (f.getUTCDay() + 6) % 7; f.setUTCDate(f.getUTCDate() - fd + 3);
  return 1 + Math.round((th - f) / 604800000);
}

// 1-2: weekofyear (mid-year + year boundary)
{
  const r = runAll(H6 + 'x = weekofyear()\ny = weekofyear(time)\nplot(1)\n');
  const lastMs = BARS[BARS.length - 1].time * 1000;
  ok(!r.err && g(r, 'x') === refWeek(lastMs) && g(r, 'y') === refWeek(lastMs), 'weekofyear ISO on bar time (got ' + g(r, 'x') + ')');
  const r2 = runAll('//@version=6\nindicator("T")\nx = weekofyear(timestamp(2023, 1, 1, 0, 0, "GMT"))\nplot(1)\n', [{ time: 1700000000, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
  ok(!r2.err && g(r2, 'x') === 52, '2023-01-01 is ISO week 52 (got ' + g(r2, 'x') + ')');
}
// 3-4: bid/ask na, max_bars_back ignore
{
  const r = runAll(H6 + 'x = na(bid) and na(ask)\nplot(1)\n');
  ok(!r.err && g(r, 'x') === true, 'bid/ask read na');
  const r2 = runAll(H6 + 'max_bars_back(close, 100)\nx = close\nplot(1)\n');
  ok(!r2.err && g(r2, 'x') === 159, 'max_bars_back() accepted, body runs');
}
// 5-6: from_seconds + round-trip
{
  const r = runAll(H6 + 'a = timeframe.from_seconds(300)\nb = timeframe.from_seconds(86400)\nc = timeframe.from_seconds(604800)\nd = timeframe.from_seconds(2592000)\ne = timeframe.from_seconds(15)\nf = timeframe.from_seconds(3600)\nplot(1)\n');
  /* canonical forms follow OUR period convention (R206) + R225 v6 multiplier ("1D"). */
  ok(!r.err && g(r, 'a') === '5' && g(r, 'b') === '1D' && g(r, 'c') === '1W' && g(r, 'd') === '1M' && g(r, 'e') === '15S' && g(r, 'f') === '60', 'from_seconds canonical forms');
  const r2 = runAll(H6 + 'x = timeframe.in_seconds(timeframe.from_seconds(300))\nplot(1)\n');
  ok(!r2.err && g(r2, 'x') === 300, 'from_seconds/in_seconds round-trip');
}
// 7: syminfo minors
{
  const r = runAll(H6 + 'a = syminfo.main_tickerid\nb = syminfo.basecurrency\nc = syminfo.tickerid\nplot(1)\n');
  ok(!r.err && g(r, 'a') === 'EURUSD' && g(r, 'a') === g(r, 'c') && g(r, 'b') === 'EUR', 'main_tickerid + basecurrency');
}
// 8: time_close overload
{
  const r = runAll(H6 + 'o = time("D", "0000-2400", "GMT")\nx = time_close("D", "0000-2400", "GMT")\nplot(1)\n');
  ok(!r.err && typeof g(r, 'x') === 'number' && g(r, 'x') - g(r, 'o') === 86400000, 'time_close = time + span (d=' + (g(r, 'x') - g(r, 'o')) + ')');
}
// 9: security_heikinashi parity with ticker handle
{
  const src = (sym) => '//@version=6\nindicator("T")\nx = request.SYM("EURUSD", "60", close)\nplot(1)\n'.replace('SYM', sym);
  const a = runAll(src('security_heikinashi'));
  const b = runAll('//@version=6\nindicator("T")\nx = request.security(ticker.heikinashi("EURUSD"), "60", close)\nplot(1)\n');
  ok(!a.err && !b.err && g(a, 'x') === g(b, 'x'), 'security_heikinashi == security(ha ticker) (got ' + g(a, 'x') + ')');
}
// 10: force_overlay stored (named + positional slots)
{
  const r = runAll(H6 + 'l = line.new(bar_index, close, bar_index, close, force_overlay=true)\nb = box.new(bar_index, high, bar_index, low, force_overlay=true)\nt = label.new(bar_index, high, "x")\nplot(1)\n');
  const st = r.rt.store;
  const ln = [...st.line.values()][0], bx = [...st.box.values()][0], lb = [...st.label.values()][0];
  ok(!r.err && ln.force_overlay === true && bx.force_overlay === true && lb.force_overlay !== true, 'force_overlay stored on line/box, default off on label');
  const r2 = runAll(H6 + 'l = line.new(bar_index, close, bar_index, close, xloc.bar_index, extend.none, color.red, line.style_solid, 1, true)\nplot(1)\n');
  const ln2 = [...r2.rt.store.line.values()][0];
  ok(!r2.err && ln2.force_overlay === true, 'force_overlay positional slot 9');
}
// 11: box.set_xloc pin (pre-existing)
{
  const r = runAll(H6 + 'b = box.new(bar_index, high, bar_index, low)\nbox.set_xloc(b, bar_index, bar_index, xloc.bar_time)\nplot(1)\n');
  const bx = [...r.rt.store.box.values()][0];
  ok(!r.err && bx.xloc === 'bar_time', 'box.set_xloc applies');
}
// 12-14: strategy getters — open excursions, ids, first_index
{
  const src = '//@version=6\nstrategy("T")\nif bar_index == 5\n    strategy.entry("L", strategy.long)\nif bar_index == 20\n    strategy.close("L")\n';
  const r = runAll(src);
  const b = r.rt.broker;
  ok(!r.err && b.trades.length === 1, 'one round trip closed');
  const t0 = b.trades[0];
  ok(t0.entryId === 'L' && typeof t0.entryBar === 'number' && typeof t0.exitBar === 'number' && t0.exitBar > t0.entryBar, 'trade carries entry/exit ids + bars');
}
{
  const src = '//@version=6\nstrategy("T")\nif bar_index == 5\n    strategy.entry("L", strategy.long)\nif bar_index == 20\n    strategy.close("L")\nfi = strategy.closedtrades.first_index\nfc = strategy.closedtrades.first_index()\nei = strategy.closedtrades.entry_id(0)\neb = strategy.closedtrades.entry_bar_index(0)\nxi = strategy.closedtrades.exit_bar_index(0)\nru = strategy.closedtrades.max_runup(0)\n';
  const r = runAll(src);
  ok(!r.err && g(r, 'fi') === 0 && g(r, 'fc') === 0 && g(r, 'ei') === 'L' && typeof g(r, 'eb') === 'number' && g(r, 'xi') > g(r, 'eb') && typeof g(r, 'ru') === 'number', 'first_index=0 (read+call) + id/bar/runup getters');
}
// 15: alert_message accepted + persisted on working orders
{
  /* limit far below market: never fills, stays working. */
  const src = '//@version=6\nstrategy("T")\nif bar_index == 58\n    strategy.entry("L", strategy.long, limit=1, alert_message="fill-msg")\n';
  const r = runAll(src);
  const pend = r.rt.broker.pending;
  ok(!r.err && pend.length === 1 && pend[0].alert === 'fill-msg', 'alert_message persisted on working order');
}
// 16: dynamic for-bounds pin
{
  const r = runAll(H6 + 'n = bar_index % 3\ns = 0.0\nfor i = 0 to n\n    s := s + 1\nplot(1)\n');
  /* last bar n=2, inclusive 0..2 → 3 iterations. */
  ok(!r.err && g(r, 's') === 3, 'series for-bounds evaluate per bar (got ' + g(r, 's') + ')');
}
// 17: 9000-trade trim (volume test)
{
  const N = 9200, bars = [];
  for (let i = 0; i < N * 2 + 4; i++) bars.push({ time: 1700000000 + i * 60, open: 100, high: 101, low: 99, close: 100, volume: 10 });
  const src = '//@version=6\nstrategy("T")\nif bar_index % 2 == 0\n    strategy.entry("L", strategy.long)\nelse\n    strategy.close("L")\nfi = strategy.closedtrades.first_index\n';
  const t0 = Date.now();
  const r = runAll(src, bars, { tfSec: 60 });
  const ms = Date.now() - t0;
  const all = r.rt.broker.trades.length, fi = g(r, 'fi');
  ok(!r.err && all === 9000 && fi > 0 && fi === r.rt.broker.firstDropped, 'trimmed to 9000, first_index=' + fi + ' (' + ms + 'ms)');
}

console.log('\nROUND223: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
