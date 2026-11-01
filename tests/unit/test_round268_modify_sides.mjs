/**
 * ROUND268 - a stop dragged or typed onto the wrong side is never sent.
 *
 * Same defect class as round 267, on the paths that MODIFY a live trade:
 *
 *  1. `trade/overlay.js` let an SL/TP line be dragged across the market and
 *     dropped: the drop called `modifySLTP`/`modifyOrder` with an inverted
 *     stop and the broker refused it. MT5 sticks the line at the legal
 *     boundary instead;
 *  2. `trade/modify.js` (the Modify position/order dialog) and
 *     `trade/dock.js` (the inline SL/TP cell editors) sent whatever was typed
 *     — an SL above the market for a buy came back as a bare retcode;
 *  3. the one-click "risk-free" shield sent break-even raw on the LIVE path
 *     while the DEMO engine snapped it to the nearest legal point: the same
 *     button succeeded in demo and was rejected live whenever the position
 *     was still in drawdown. The chart context menu's break-even row had the
 *     same problem.
 *
 * Pins:
 *  - `clampStopPrice` keeps SL/TP on their legal side and honours
 *    stops_level (buy: SL below / TP above, sell mirrored);
 *  - the overlay clamps while dragging AND again at drop;
 *  - both editors validate with the shared `stopsCheck` before sending and
 *    keep the row editable;
 *  - break-even is refused (live) / snapped (demo) instead of sent invalid.
 *
 * Run: node tests/unit/test_round268_modify_sides.mjs
 */
import { clampStopPrice } from '../../src/core/demo-math.js';
import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' - ' + JSON.stringify(extra) : '')); }
};
const near = (a, b) => Math.abs(a - b) < 1e-9;

const S = { point: 0.00001, digits: 5, stops_level: 0, tick_size: 0.00001, tick_value: 1 };
const S10 = { ...S, stops_level: 10 };            // 10 pts = 0.0001

console.log('\n[1] SL/TP are clamped to their legal side');
{
  /* buy: bid 1.10000 */
  ok(near(clampStopPrice(S, 0, 1.10000, 'sl', 1.10100), 1.09999),
    'BUY SL above the bid is pushed below (one point)');
  ok(near(clampStopPrice(S, 0, 1.10000, 'sl', 1.09900), 1.09900), 'BUY SL below the bid is kept');
  ok(near(clampStopPrice(S, 0, 1.10000, 'tp', 1.09900), 1.10001),
    'BUY TP below the bid is pushed above');
  ok(near(clampStopPrice(S, 0, 1.10000, 'tp', 1.10200), 1.10200), 'BUY TP above the bid is kept');
  /* sell: ask 1.10000 */
  ok(near(clampStopPrice(S, 1, 1.10000, 'sl', 1.09900), 1.10001),
    'SELL SL below the ask is pushed above');
  ok(near(clampStopPrice(S, 1, 1.10000, 'sl', 1.10100), 1.10100), 'SELL SL above the ask is kept');
  ok(near(clampStopPrice(S, 1, 1.10000, 'tp', 1.10100), 1.09999),
    'SELL TP above the ask is pushed below');
  ok(near(clampStopPrice(S, 1, 1.10000, 'tp', 1.09800), 1.09800), 'SELL TP below the ask is kept');
}

console.log('\n[2] the broker minimum distance wins over one point');
{
  ok(near(clampStopPrice(S10, 0, 1.10000, 'sl', 1.09995), 1.09990),
    'BUY SL inside stops_level is pushed to the boundary');
  ok(near(clampStopPrice(S10, 1, 1.10000, 'sl', 1.10005), 1.10010),
    'SELL SL inside stops_level is pushed to the boundary');
  ok(near(clampStopPrice({ ...S, point: 0, digits: 5 }, 0, 1.10000, 'sl', 1.10100), 1.10100),
    'no point size → nothing to clamp against, price kept');
  ok(clampStopPrice(S, 0, 0, 'sl', 1.10100) === 1.10100, 'no reference price → price kept');
  ok(clampStopPrice(S, 0, 1.10000, 'sl', 0) === 0, 'an empty level stays empty');
}

console.log('\n[3] the overlay clamps the drag, the drop and break-even');
{
  const src = readSource('src/renderer/js/trade/overlay.js');
  ok(/import \{ clampStopPrice \} from '\.\.\/\.\.\/\.\.\/core\/demo-math\.js';/.test(src),
    'overlay imports the clamp');
  ok(/_clampStop\(pane, pos, kind, price, order\) \{/.test(src), 'one helper owns the reference price');
  ok(/const ref = order \? \(order\.price \|\| 0\)/.test(src), 'pendings clamp against their own price');
  ok(/pos && pos\.type === 0 \? \(q\.bid \|\| \(s && s\.bid\) \|\| 0\)/.test(src),
    'positions clamp against their close-out side');
  const iMove = src.indexOf('_onMove(e) {');
  const move = src.slice(iMove, src.indexOf('_onUp(e) {', iMove));
  ok(/if \(d\.kind === 'sl' \|\| d\.kind === 'tp'\) \{[\s\S]{0,200}price = this\._clampStop\(pane, pos, d\.kind, price\);/.test(move),
    'a dragged level is clamped while it moves');
  ok(/else if \(o\) price = this\._clampStop\(pane, this\._orderPos\(o\), d\.kind, price, o\);/.test(move),
    'a dragged pending level uses the order price');
  ok(/d\.price = price;/.test(move), 'the clamped price is what the drop will send');
  const iUp = src.indexOf('_onUp(e) {');
  const up = src.slice(iUp);
  ok(/this\._clampStop\(pane, pos, 'sl', px\)/.test(up), 'the drop re-clamps the position SL');
  ok(/this\._clampStop\(pane, op, 'tp', px, o\)/.test(up), 'the drop re-clamps the pending TP');
  ok(/const sent = d\.kind === 'sl' \? sl : tp;/.test(up), 'the toast reports the value actually sent');
  ok(/const beIllegal = clampStopPrice\(s, pos\.type, beRef, 'sl', be\) !== be;/.test(src),
    'break-even is checked for legality');
  ok(/disabled: beDone \|\| beIllegal/.test(src), 'an illegal break-even row is disabled');
}

console.log('\n[4] the modify dialog validates before sending');
{
  const src = readSource('src/renderer/js/trade/modify.js');
  ok(/import \{ stopsCheck \} from '\.\.\/\.\.\/\.\.\/core\/demo-math\.js';/.test(src),
    'modify imports the shared validator');
  ok(/_stopSideErr\(symbol, type, ref, sl, tp\) \{/.test(src), 'one helper owns the rule');
  const pos = src.slice(src.indexOf('_wirePos(pos) {'), src.indexOf('_wireOrd(ord) {'));
  ok(/const ref = pos\.type === 0 \? \(q\.bid \|\| 0\) : \(q\.ask \|\| 0\);/.test(pos),
    'positions validate against the close-out price');
  ok(/if \(bad\) \{ UI\.toast\(bad \+ ' — fix the SL\/TP', ''\); return; \}/.test(pos),
    'an illegal SL/TP keeps the dialog open');
  ok(pos.indexOf('if (bad)') < pos.indexOf('TradeRoute.modifySLTP'), 'validation precedes the send');
  const ord = src.slice(src.indexOf('_wireOrd(ord) {'));
  ok(/this\._stopSideErr\(ord\.symbol, ord\.type, p2, s2, t2\)/.test(ord),
    'pendings validate against the new order price');
  ok(ord.indexOf('if (bad)') < ord.indexOf('TradeRoute.modifyOrder'), 'validation precedes the send');
}

console.log('\n[5] the inline dock editors validate before sending');
{
  const src = readSource('src/renderer/js/trade/dock.js');
  ok(/import \{ stopsCheck \} from '\.\.\/\.\.\/\.\.\/core\/demo-math\.js';/.test(src),
    'dock imports the shared validator');
  const pos = src.slice(src.indexOf('_editSltp(p, row) {'), src.indexOf('_editOrder(o, row) {'));
  ok(/const bad = \(s && ref > 0\) \? stopsCheck\(s, p\.type, ref, sl2, tp2\) : null;/.test(pos),
    'the position cell validates its typed levels');
  ok(/if \(bad\) \{ UI\.toast\(bad \+ ' — fix the SL\/TP', ''\); return; \}/.test(pos),
    'a bad cell stays in edit mode');
  ok(pos.indexOf('if (bad)') < pos.indexOf('delete row.dataset.editing'),
    'editing is not torn down before the check');
  ok(pos.indexOf('if (bad)') < pos.indexOf('TradeRoute.modifySLTP'), 'validation precedes the send');
  const ord = src.slice(src.indexOf('_editOrder(o, row) {'));
  ok(/const bad = s \? stopsCheck\(s, o\.type, px2, sl2, tp2\) : null;/.test(ord),
    'the order cell validates against its new price');
  ok(ord.indexOf('if (bad)') < ord.indexOf('TradeRoute.modifyOrder'), 'validation precedes the send');
}

console.log('\n[6] risk-free: demo snaps, live refuses politely');
{
  const src = readSource('src/renderer/js/trade/oneclick.js');
  ok(/import \{ stopsCheck, clampStopPrice \}/.test(src), 'panel imports the clamp too');
  const rf = src.slice(src.indexOf('_posRiskFree(p) {'), src.indexOf('_tick() {'));
  ok(/const legal = clampStopPrice\(spec, p\.type, ref, 'sl', be\);/.test(rf), 'break-even is snapped');
  ok(/if \(snap && !TradeRoute\.isDemo\(\)\) \{[\s\S]{0,160}return;/.test(rf),
    'the live path refuses to send an illegal break-even');
  ok(/TradeRoute\.modifySLTP\(p\.ticket, be, p\.tp \|\| 0, \{ be: true \}\)/.test(rf),
    'a legal break-even (or the demo engine) still gets the normal send');
  ok(/Risk-free needs the market past the entry/.test(rf), 'the refusal explains itself');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
