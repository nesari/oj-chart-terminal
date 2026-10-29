/**
 * test_feed_session.mjs — reconnect/session continuity (feed + login glue).
 *
 * Confirmed defects this suite pins:
 *  1. the provider keeps subscriptions PER WebSocket connection, so a new
 *     socket starts with zero rows ticking. Feed now remembers the DESIRED
 *     set and replays it on every open (covers chart, watchlist, Pine and
 *     trade subscribers, not just Manager's ref-count map);
 *  2. App.currentAcc only carried {mode,label,id}, so the reconnect loop
 *     could never log an MT5 account back in (it always sent demo);
 *  3. the reconnect loop stopped permanently after ~27s — a longer outage
 *     left the app Offline until a manual reload.
 *
 * Run: node tests/unit/test_feed_session.mjs
 */

import { Feed } from '../../src/core/feed.js';
import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const fakeSocket = () => ({ readyState: 1, send() {}, close() {} });

/* ---------- 1. desired-set replay across reconnects ---------- */
{
  const f = new Feed('ws://127.0.0.1:9');
  const sent = [];
  f._send = (m) => { sent.push(m); return Promise.resolve({}); };

  /* boot: panes/watchlist subscribe before the socket exists */
  f.subscribe('EURUSD');
  f.subscribe('GBPUSD');
  f.subscribe('');
  ok(f._desiredSubs.has('EURUSD') && f._desiredSubs.has('GBPUSD'),
    'closed socket: subscriptions are queued in the desired set');
  ok(!f._desiredSubs.has(''), 'empty symbol is never queued');
  ok(sent.length === 0, 'closed socket: nothing is sent yet');

  /* first open flushes the queue */
  f.ws = fakeSocket();
  ok(f._replaySubs() === 2, 'first open replays both queued symbols');
  ok(sent.filter((m) => m.type === 'subscribe').length === 2,
    'first open sends one subscribe frame per symbol');

  /* unsubscribe while live leaves the desired set */
  f.unsubscribe('EURUSD');
  ok(!f._desiredSubs.has('EURUSD'), 'unsubscribe drops the symbol from the desired set');

  /* reconnect: provider starts empty, replay must restore only held symbols */
  sent.length = 0;
  f.ws = fakeSocket();
  ok(f._replaySubs() === 1, 'reconnect replays the still-held symbol count');
  ok(sent.length === 1 && sent[0].type === 'subscribe' && sent[0].symbol === 'GBPUSD',
    'reconnect re-subscribes GBPUSD and not the released EURUSD');
}

/* ---------- 2. Manager ref-count re-issue after reconnect ---------- */
{
  const src = readSource('src/renderer/js/chart/manager/render.js');
  ok(/function resubscribeAll\s*\(/.test(src), 'Manager exposes resubscribeAll()');
  ok(/for \(const \[symbol, count\] of subs\)/.test(src) && /count <= 0/.test(src),
    'resubscribeAll skips zero/negative ref counts');
  ok(/Manager\.resubscribeAll\s*=\s*resubscribeAll/.test(src),
    'resubscribeAll is published on Manager');
}

/* ---------- 3. login keeps real credentials in App.currentAcc ---------- */
{
  const src = readSource('src/renderer/js/ui/login.js');
  const block = (src.match(/App\.currentAcc\s*=\s*\{[\s\S]*?\};/) || [''])[0];
  ok(/login:\s*creds\.login/.test(block), 'currentAcc carries the MT5 login');
  ok(/server:\s*creds\.server/.test(block), 'currentAcc carries the MT5 server');
  ok(/password:\s*creds\.password/.test(block), 'currentAcc carries the MT5 password (memory only)');
  ok(/path:\s*creds\.path/.test(block), 'currentAcc carries the terminal path');
}

/* ---------- 4. reconnect loop: correct mode + indefinite capped retry ---------- */
{
  const src = readSource('src/renderer/js/app.js');
  ok(/acc\.mode === 'mt5' && acc\.login/.test(src),
    'reconnect logs in as mt5 only for an mt5 account with a login');
  ok(/Math\.min\(30000,\s*delay \* 2\)/.test(src),
    'backoff doubles but is capped at 30s');
  ok(/for \(let attempt = 1; ; attempt\+\+\)/.test(src),
    'retry loop has no fixed attempt limit (keeps trying through long outages)');
  ok(/Manager\.resubscribeAll/.test(src),
    'successful reconnect re-issues provider subscriptions');
  ok(/App\.currentAcc !== acc/.test(src),
    'a switched/logged-out account cancels the in-flight retry loop');
}

/* ---------- 5. provider process supervision (main.js) ---------- */
{
  const src = readSource('main.js');
  ok(/function scheduleProviderRestart\s*\(/.test(src),
    'main schedules a restart after an unexpected provider exit');
  ok(/providerProc !== child \|\| quitting/.test(src),
    'intentional stops / app quit never resurrect the provider');
  ok(/providerRestartAttempts >= 8/.test(src),
    'restart attempts are bounded (no fork loop on a permanent failure)');
  ok(/providerStableTimer = setTimeout[\s\S]{0,160}providerRestartAttempts = 0/.test(src),
    'a provider that stays up resets the retry budget');
  ok(/providerSpec\.password === wantPw/.test(src),
    'a changed MT5 password forces a real provider respawn (old env password cannot linger)');
  ok(/payload\.attach[\s\S]{0,220}A data provider for another account is already running/.test(src),
    'a detached window attaches to the host provider instead of restarting it');
  ok(/while \(providerStarting\)/.test(src),
    'startProvider is single-flight (login vs crash-restart cannot spawn twice)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
