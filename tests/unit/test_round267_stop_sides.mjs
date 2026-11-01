/**
 * ROUND267 - a stop on the wrong side of the price must never be sent.
 *
 * Confirmed by reading the live order paths:
 *
 *  1. `trade/ticket.js` price mode accepted ANY number as the SL/TP. A BUY
 *     with the SL typed above the market produced a positive `slDist` (the
 *     distance is absolute), so the preview printed a normal "SL ... · 40
 *     pts · risk $50", Auto lot sized the volume from that inverted distance
 *     and the order died at the broker with a bare retcode — the terminal
 *     never said what was wrong;
 *  2. `trade/oneclick.js` never validated the draft levels AT ALL. Its market
 *     entry follows every tick while the stop lines stay where they were
 *     dropped, so a move through the SL (or dragging a pending entry line
 *     past it) left SL/TP inverted; Set sent it and the broker rejected;
 *  3. the shared validator itself, `stopsCheck` (already used by the demo
 *     engine), classified only types 0/2/4 as buys — a BUY STOP LIMIT (6)
 *     was validated as a SELL, so every legal stop-limit was refused.
 *
 * Pins:
 *  - `stopsCheck` pairs the order types (even = buy), including 6/7;
 *  - both live UIs validate with it BEFORE the order leaves the terminal and
 *    keep the draft/fields alive for correction;
 *  - dragging a draft's entry line re-anchors SL and TP to their legal sides.
 *
 * Run: node tests/unit/test_round267_stop_sides.mjs
 */
import { stopsCheck } from '../../src/core/demo-math.js';
import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' - ' + JSON.stringify(extra) : '')); }
};

const S = { point: 0.00001, digits: 5, stops_level: 0, tick_size: 0.00001, tick_value: 1 };
const S10 = { ...S, stops_level: 10 };           // 10 pts = 0.00010

console.log('\n[1] every order type is classified by its side');
{
  /* BUY market */
  ok(stopsCheck(S, 0, 1.10000, 1.09900, 1.10200) === null, 'BUY: SL below / TP above is legal');
  ok(/SL must be below/.test(stopsCheck(S, 0, 1.10000, 1.10100, 1.10200)),
    'BUY: SL above the price is refused');
  ok(/TP must be above/.test(stopsCheck(S, 0, 1.10000, 1.09900, 1.09950)),
    'BUY: TP below the price is refused');
  /* SELL market */
  ok(stopsCheck(S, 1, 1.10000, 1.10100, 1.09800) === null, 'SELL: SL above / TP below is legal');
  ok(/SL must be above/.test(stopsCheck(S, 1, 1.10000, 1.09900, 1.09800)),
    'SELL: SL below the price is refused');
  ok(/TP must be below/.test(stopsCheck(S, 1, 1.10000, 1.10100, 1.10200)),
    'SELL: TP above the price is refused');
  /* pendings — the old list mis-classified 6 */
  ok(stopsCheck(S, 2, 1.10000, 1.09900, 1.10200) === null, 'BUY LIMIT (2) is a buy');
  ok(stopsCheck(S, 3, 1.10000, 1.10100, 1.09800) === null, 'SELL LIMIT (3) is a sell');
  ok(stopsCheck(S, 4, 1.10000, 1.09900, 1.10200) === null, 'BUY STOP (4) is a buy');
  ok(stopsCheck(S, 5, 1.10000, 1.10100, 1.09800) === null, 'SELL STOP (5) is a sell');
  ok(stopsCheck(S, 6, 1.10000, 1.09900, 1.10200) === null,
    'BUY STOP LIMIT (6) is a buy (was validated as a sell)');
  ok(/SL must be above/.test(stopsCheck(S, 7, 1.10000, 1.09900, 1.09800)),
    'SELL STOP LIMIT (7) is a sell');
}

console.log('\n[2] the minimum stop distance is still enforced');
{
  ok(/SL too close/.test(stopsCheck(S10, 0, 1.10000, 1.09995, 0)), 'BUY: SL inside stops_level refused');
  ok(stopsCheck(S10, 0, 1.10000, 1.09900, 0) === null, 'BUY: SL outside stops_level accepted');
  ok(/TP too close/.test(stopsCheck(S10, 1, 1.10000, 1.10100, 1.09995)), 'SELL: TP inside stops_level refused');
  ok(stopsCheck(S, 0, 1.10000, 0, 0) === null, 'no SL/TP at all is legal');
  ok(stopsCheck(S, 0, 0, 1.0990, 0) === 'No reference price', 'a missing reference price is refused');
}

console.log('\n[3] the ticket validates before sending');
{
  const src = readSource('src/renderer/js/trade/ticket.js');
  ok(/import \{ stopsCheck \} from '\.\.\/\.\.\/\.\.\/core\/demo-math\.js';/.test(src),
    'ticket imports the shared validator');
  const iPlace = src.indexOf('_place(side) {');
  const place = src.slice(iPlace, src.indexOf('const send = () =>', iPlace));
  ok(/stopsCheck\(s, this\._orderTypeNum\(type, side\), entryRef, sl, tp\)/.test(place),
    '_place validates the computed levels against the entry reference');
  ok(/if \(sideErr\) \{ this\._status\(sideErr \+ ' — fix the SL\/TP', true\); return; \}/.test(place),
    'a bad side stops the order with a readable status');
  ok(place.indexOf('stopsCheck(') > 0 && place.indexOf('stopsCheck(') < place.indexOf('const gate'),
    'the check runs before the route gate / send');
}

console.log('\n[4] the panel validates before sending');
{
  const src = readSource('src/renderer/js/trade/oneclick.js');
  ok(/import \{ stopsCheck \} from '\.\.\/\.\.\/\.\.\/core\/demo-math\.js';/.test(src),
    'panel imports the shared validator');
  const iSend = src.indexOf('_sendDraft(pane, st) {');
  const send = src.slice(iSend, src.indexOf('TradeRoute.sendOrder({', iSend));
  ok(/const refPx = d\.pend \? price : \(d\.side === 0 \? q\.ask : q\.bid\);/.test(send),
    'the reference is the order price (pending) or the market side (market)');
  ok(/stopsCheck\(spec, orderType, refPx, sl, tp\)/.test(send), 'the draft levels are validated');
  ok(/if \(sideErr\) \{[\s\S]{0,120}return;/.test(send), 'a bad side refuses the send');
  ok(/the draft stays for adjustment/.test(send), 'the draft survives so the user can fix it');
}

console.log('\n[5] a moved entry line re-anchors the stops');
{
  const src = readSource('src/renderer/js/trade/oneclick.js');
  const iMove = src.indexOf('_lineMove(e) {');
  const move = src.slice(iMove, src.indexOf('_lineUp() {', iMove));
  ok(/if \(st\.lineDrag\.kind === 'e'\) \{\s*d\.entry = clamped;/.test(move), 'the entry move assigns first');
  ok(/d\.sl = _clampLevel\('s', d\.side, true, d\.sl, \{ entry: d\.entry \}, spec\);/.test(move),
    'the SL is pushed back to the loss side of the new entry');
  ok(/d\.tp = _clampLevel\('t', d\.side, true, d\.tp, \{ entry: d\.entry \}, spec\);/.test(move),
    'the TP is pushed back to the profit side of the new entry');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
