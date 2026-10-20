/**
 * test_round174_stall.mjs — ROUND174 provider-stall watchdog (feed.js).
 *
 * The user log showed trade + bars_req timeouts together with the socket
 * OPEN (frozen provider loop): nothing ever fired onclose, so the app
 * waited forever. The watchdog pings every 20s; a missing pong 15s after
 * OUR ping closes the socket into the existing reconnect path. A healthy
 * (even tick-quiet/weekend) provider answers pings — no false positives.
 *
 * Run: node tests/unit/test_round174_stall.mjs
 */

import { Feed } from '../../src/core/feed.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const mk = () => {
  const f = new Feed('ws://127.0.0.1:9');
  f.connected = true;
  return f;
};

/* decision table */
{
  const f = mk();
  ok(f._stallCheck(Date.now()) === false, 'no ping sent yet -> not stalled');
  const g = mk();
  g._pingAt = 100000;
  g._lastPongAt = 99000;
  ok(g._stallCheck(100000 + 14000) === false, 'pong missing but within 15s grace');
  ok(g._stallCheck(100000 + 16000) === true, 'no pong 16s after our ping -> stalled');
  const h = mk();
  h._pingAt = 100000;
  h._lastPongAt = 100500; // answered (also clears _pingAt in _handle)
  h._pingAt = 0;
  ok(h._stallCheck(100000 + 60000) === false, 'answered ping never stalls');
  const d = mk();
  d.connected = false;
  d._pingAt = 100000;
  ok(d._stallCheck(100000 + 60000) === false, 'disconnected socket never stalls');
}

/* pong handling clears the ping marker */
{
  const f = mk();
  f._pingAt = 5000;
  f._handle({ type: 'pong' });
  ok(f._pingAt === 0 && f._lastPongAt > 0, 'pong clears _pingAt and stamps _lastPongAt');
}

/* watchdog sends pings and closes on stall (fake socket, driven manually) */
{
  const f = mk();
  const sent = [];
  let closed = 0;
  f.ws = { readyState: 1, send: (s) => sent.push(s), close: () => { closed++; } };
  f._stallTick();
  ok(sent.length === 1 && sent[0] === '{"type":"ping"}', 'tick sends one ping');
  ok(closed === 0, 'no close right after our own ping');
  // provider answers -> next tick stays quiet
  f._handle({ type: 'pong' });
  f._stallTick();
  ok(sent.length === 2, 'answered provider gets pinged again later');
  // provider goes silent -> close into the reconnect path
  f._stallTick(); // sends (pingAt already set? no: pong cleared it, so this pings)
  f._pingAt = Date.now() - 16000; // 16s without answer
  f._lastPongAt = f._pingAt - 5000;
  f._stallTick();
  ok(closed === 1, 'silent provider socket closed for reconnect');
  // disconnected socket: never touches ws
  const g = mk();
  g.connected = false;
  let touched = 0;
  g.ws = { readyState: 1, send: () => touched++, close: () => touched++ };
  g._stallTick();
  ok(touched === 0, 'disconnected socket untouched');
}

console.log('\nROUND174: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
