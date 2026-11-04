/**
 * ROUND274 — owner-tagged feed subscriptions.
 *
 * Confirmed defect: Trade.refresh() subscribed every open-position symbol and
 * never released it when the position closed, so the provider kept streaming
 * ticks for symbols nobody displayed (and the desired set grew for the rest of
 * the session).
 *
 * Fix: Feed remembers WHICH owner asked for a symbol ('*' for every existing
 * caller, 'trade' for the bridge). A release only cuts the provider stream
 * when the last owner lets go, so a chart/watchlist and the trade bridge can
 * share a symbol without killing each other's feed.
 *
 * Run: node tests/unit/test_round274_feed_owners.mjs
 */

import { Feed } from '../../src/core/feed.js';
import { App } from '../../src/core/state.js';
import { Trade } from '../../src/renderer/js/trade/state.js';
import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const live = () => ({ readyState: 1, send() {}, close() {} });
const count = (sent, type) => sent.filter((m) => m.type === type).length;

/* ---------- 1. owners share one provider stream ---------- */
{
  const f = new Feed('ws://127.0.0.1:9');
  const sent = [];
  f._send = (m) => { sent.push(m); return Promise.resolve({}); };
  f.ws = live();

  f.subscribe('EURUSD', 'trade');
  ok(f._desiredSubs.has('EURUSD'), 'owner subscribe marks the symbol desired');
  ok(f._subOwners.get('EURUSD').has('trade'), 'owner is recorded');
  ok(count(sent, 'subscribe') === 1, 'first owner sends one subscribe frame');

  f.subscribe('EURUSD', 'trade');
  ok(count(sent, 'subscribe') === 1, 'the same owner subscribing twice is idempotent');

  f.subscribe('EURUSD');
  ok(count(sent, 'subscribe') === 1, 'a second owner joins without another frame');
  ok(f._subOwners.get('EURUSD').size === 2, 'both owners are tracked');

  f.unsubscribe('EURUSD');
  ok(f._desiredSubs.has('EURUSD'), 'default owner release keeps the trade owner live');
  ok(count(sent, 'unsubscribe') === 0, 'no unsubscribe frame while an owner remains');

  f.unsubscribe('EURUSD', 'trade');
  ok(!f._desiredSubs.has('EURUSD'), 'last owner release drops the desired symbol');
  ok(count(sent, 'unsubscribe') === 1, 'last owner release sends the unsubscribe frame');
  ok(!f._subOwners.has('EURUSD'), 'owner map is cleaned up');
}

/* ---------- 2. legacy single-owner calls keep their behaviour ---------- */
{
  const f = new Feed('ws://127.0.0.1:9');
  const sent = [];
  f._send = (m) => { sent.push(m); return Promise.resolve({}); };
  f.ws = live();

  f.subscribe('GBPUSD');
  f.unsubscribe('GBPUSD');
  ok(!f._desiredSubs.has('GBPUSD'), 'plain subscribe/unsubscribe still cancels');
  ok(count(sent, 'subscribe') === 1 && count(sent, 'unsubscribe') === 1,
    'plain subscribe/unsubscribe sends both frames');

  /* releasing an owner that never held the symbol must not cut a live row */
  f.subscribe('USDJPY');
  f.unsubscribe('USDJPY', 'trade');
  ok(f._desiredSubs.has('USDJPY'), 'unknown-owner release is ignored');
  f.unsubscribe('USDJPY');
}

/* ---------- 3. reconnect replay must not inflate or lose owners ---------- */
{
  const f = new Feed('ws://127.0.0.1:9');
  const sent = [];
  f._send = (m) => { sent.push(m); return Promise.resolve({}); };
  f.subscribe('AUDUSD', 'trade');
  f.subscribe('NZDUSD');
  f.ws = live();

  sent.length = 0;
  ok(f._replaySubs() === 2, 'replay covers every desired symbol');
  ok(count(sent, 'subscribe') === 2, 'replay sends real frames after reconnect');
  ok(f._subOwners.get('AUDUSD').size === 1 && f._subOwners.get('NZDUSD').size === 1,
    'replay leaves owner bookkeeping unchanged');

  f.unsubscribe('AUDUSD', 'trade');
  ok(!f._desiredSubs.has('AUDUSD'), 'owner can still release after a replay');
}

/* ---------- 4. Trade.refresh retains/releases position symbols ---------- */
{
  const f = new Feed('ws://127.0.0.1:9');
  const sent = [];
  f._send = (m) => { sent.push(m); return Promise.resolve({}); };
  f.ws = live();
  const previous = App.feed;
  App.feed = f;
  Trade._subs = new Set();
  Trade._pollBusy = false;
  let rows = [
    { ticket: 1, symbol: 'EURUSD' },
    { ticket: 2, symbol: 'EURUSD' },
    { ticket: 3, symbol: 'GBPUSD' },
  ];
  Trade.rpc = () => Promise.resolve({ data: { account: {}, positions: rows, orders: [] } });

  try {
    await Trade.refresh();
    ok(f._subOwners.get('EURUSD') && f._subOwners.get('EURUSD').has('trade'),
      'open position symbol is retained by the trade owner');
    ok(f._subOwners.get('GBPUSD') && f._subOwners.get('GBPUSD').has('trade'),
      'a second symbol is retained too');
    ok(count(sent, 'subscribe') === 2, 'duplicate rows subscribe only once per symbol');

    /* a chart also watches EURUSD: closing the trade must not cut it */
    f.subscribe('EURUSD');
    sent.length = 0;
    rows = [{ ticket: 4, symbol: 'GBPUSD' }];
    await Trade.refresh();
    ok(!f._subOwners.get('EURUSD') || !f._subOwners.get('EURUSD').has('trade'),
      'closed symbol drops the trade owner');
    ok(f._desiredSubs.has('EURUSD'), 'chart owner still receives EURUSD ticks');
    ok(count(sent, 'unsubscribe') === 0, 'no unsubscribe frame while the chart owner remains');
    ok(f._desiredSubs.has('GBPUSD'), 'still-held symbol stays subscribed');

    sent.length = 0;
    rows = [];
    await Trade.refresh();
    ok(!f._desiredSubs.has('GBPUSD'), 'flat account releases the last position symbol');
    ok(count(sent, 'unsubscribe') === 1, 'flat account sends the unsubscribe frame');

    const src = readSource('src/renderer/js/trade/state.js');
    ok(/App\.feed\.subscribe\(sym, 'trade'\)/.test(src), 'Trade subscribes with its owner id');
    ok(/App\.feed\.unsubscribe\(sym, 'trade'\)/.test(src), 'Trade releases with its owner id');
  } finally {
    App.feed = previous;
  }
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
