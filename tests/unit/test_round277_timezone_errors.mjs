/**
 * test_round277_timezone_errors.mjs — timezone funnel + AppError catalog.
 *
 * These two core modules were the lowest-covered part of src/core (37.6% and
 * 47.5% at the time of writing). The suite pins the display funnel
 * (chart stamp -> true UTC -> selected zone, including the pseudo-zone
 * 'broker' and per-zone DST) and the one app-wide error shape.
 *
 * Run: node tests/unit/test_round277_timezone_errors.mjs
 */

import { TZ } from '../../src/core/timezone.js';
import { App } from '../../src/core/state.js';
import { AppErr } from '../../src/core/errors.js';
import { Log } from '../../src/core/logger.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

/* 2026-01-15T12:00:00Z (winter) and 2026-07-15T12:00:00Z (summer, DST). */
const JAN = Date.UTC(2026, 0, 15, 12, 0, 0) / 1000;
const JUL = Date.UTC(2026, 6, 15, 12, 0, 0) / 1000;
const MIDNIGHT = Date.UTC(2026, 0, 15, 0, 0, 0) / 1000;

const prevFeed = App.feed;
App.feed = { serverOff: 0 };

/* ---------- 1. zone lists ---------- */
{
  const zones = TZ.zones();
  ok(zones.includes('UTC') && zones.includes('Asia/Tehran'), 'zones() exposes the TradingView list');
  ok(TZ.zones() !== zones, 'zones() returns a copy');
  const sorted = TZ.sortedZones();
  ok(sorted[0] === 'broker', "sortedZones() pins 'broker' first");
  const rest = sorted.slice(1);
  ok(rest.join('|') === rest.slice().sort().join('|'), 'sortedZones() sorts the IANA names');
}

/* ---------- 2. broker offset conversion ---------- */
{
  App.feed.serverOff = 3 * 3600 + 1800; // GMT+03:30
  ok(TZ.toChart(JAN, 'UTC') === JAN + 12600, 'toChart adds the broker offset');
  ok(TZ.toUtc(JAN + 12600, 'UTC') === JAN, 'toUtc subtracts the broker offset');
  ok(TZ.toChart(TZ.toUtc(JAN, 'UTC'), 'UTC') === JAN, 'toChart/toUtc round-trip');
  App.feed.serverOff = 0;
}

/* ---------- 3. disp / zone offsets / DST ---------- */
{
  ok(TZ.zoneOffsetMinutes('UTC', new Date(JAN * 1000)) === 0, 'UTC has zero offset');
  ok(TZ.zoneOffsetMinutes('Asia/Tehran', new Date(JAN * 1000)) === 210,
    'Tehran is GMT+03:30 (no DST since 2022)');
  ok(TZ.zoneOffsetMinutes('Europe/London', new Date(JAN * 1000)) === 0,
    'London is GMT+00:00 in winter');
  ok(TZ.zoneOffsetMinutes('Europe/London', new Date(JUL * 1000)) === 60,
    'London is GMT+01:00 in summer (DST)');
  ok(TZ.zoneOffsetMinutes('Nope/Nope', new Date(JAN * 1000)) === 0,
    'unknown zone degrades to zero instead of throwing');

  ok(TZ.disp('UTC', JAN).getTime() / 1000 === JAN, "disp('UTC') keeps the instant");
  ok(TZ.disp('broker', JAN).getTime() / 1000 === JAN, "disp('broker') uses raw chart stamps");
  const tehran = TZ.disp('Asia/Tehran', JAN);
  ok(tehran.getUTCHours() === 15 && tehran.getUTCMinutes() === 30,
    'disp(Tehran) shifts 12:00Z to 15:30 wall time');
  ok(TZ.disp('Nope/Nope', JAN).getTime() / 1000 === JAN,
    'disp(unknown zone) falls back to UTC');
}

/* ---------- 4. broker stamp -> parts ---------- */
{
  App.feed.serverOff = 3 * 3600;
  ok(TZ.parts('broker', JAN).hour === '12', "parts('broker') shows the raw stamp, not local time");
  ok(TZ.parts('broker', JAN + 10800).hour === '15', "parts('broker') ignores the broker offset");
  App.feed.serverOff = 0;

  const p = TZ.parts('Asia/Tehran', JAN);
  ok(p.hour === '15' && p.minute === '30' && p.second === '00', 'parts() formats Tehran wall time');
  ok(p.day === '15' && p.month === 'Jan' && p.year === '2026', 'parts() formats the date');
  ok(p.monthShort === 'Jan' && p.dow === 'Thu', 'parts() carries month name + weekday');
  ok(TZ.parts('UTC', MIDNIGHT).hour === '00', 'midnight renders as 00, never 24');

  const bad = TZ.parts('Nope/Nope', JAN);
  ok(bad.dow === '' && bad.hour === undefined, 'parts(unknown zone) is empty, not a crash');

  ok(TZ.ymd('UTC', JAN).y === '2026' && TZ.ymd('UTC', JAN).m === '01', 'ymd() returns numeric y/m/d');
}

/* ---------- 5. numeric parts (History/Positions cells) ---------- */
{
  const n = TZ.partsNum('Asia/Tehran', JAN);
  ok(n.year === '2026' && n.month === '01' && n.day === '15', 'partsNum() pads year/month/day');
  ok(n.hour === '15' && n.minute === '30' && n.second === '00', 'partsNum() pads the time');

  const b = TZ.partsNum('broker', JAN);
  ok(b.hour === '12' && b.year === '2026', "partsNum('broker') never renders 1970");
  const fallback = TZ.partsNum('Nope/Nope', JAN);
  ok(fallback.year === '1970' && fallback.hour === '00', 'partsNum(unknown zone) falls back safely');
}

/* ---------- 6. labels ---------- */
{
  ok(TZ.tickLabel('UTC', JAN, 0) === '2026', 'tickLabel(year)');
  ok(TZ.tickLabel('UTC', JAN, 1) === '15 Jan', 'tickLabel(month)');
  ok(TZ.tickLabel('UTC', JAN, 2, true) === 'Thu 15 Jan', 'tickLabel(day) includes the weekday when asked');
  ok(TZ.tickLabel('UTC', JAN, 3) === '12:00', 'tickLabel(time)');
  ok(TZ.tickLabel('UTC', JAN, 4) === '12:00:00', 'tickLabel(seconds)');
  ok(TZ.tickLabel('UTC', JAN, 'hour') === '12:00', 'tickLabel(hour) is a time label');
  ok(TZ.tickLabel('UTC', MIDNIGHT, 'hour', true) === 'Thu 15 Jan',
    'tickLabel(midnight hour) becomes a date');
  ok(TZ.tickLabel('UTC', JAN, 'nope') === 'Jan', 'tickLabel(unknown type) shows the month');

  ok(TZ.crossLabel('UTC', JAN, false, false) === "Thu 15 Jan '26  12:00",
    'crossLabel() date + time');
  ok(TZ.crossLabel('UTC', JAN, true, false) === "Thu 15 Jan '26  12:00:00",
    'crossLabel() adds seconds for second charts');
  ok(TZ.crossLabel('UTC', JAN, false, true) === "Thu 15 Jan '26",
    'crossLabel(dateOnly) shows no time');

  ok(TZ.fullLabel('UTC', JAN) === 'Thu, 15 Jan 2026  12:00:00', 'fullLabel() Data Window text');

  App.feed.serverOff = 3 * 3600 + 1800;
  ok(TZ.shortLabel('broker') === 'Broker (GMT+03:30)', 'shortLabel(broker) shows the live offset');
  App.feed.serverOff = -3600;
  ok(TZ.shortLabel('broker') === 'Broker (GMT-01:00)', 'shortLabel(broker) handles negative offsets');
  App.feed.serverOff = 0;
  ok(TZ.shortLabel('UTC') === 'UTC', 'shortLabel(UTC)');
  ok(TZ.shortLabel('Asia/Tehran') === 'Tehran', 'shortLabel() drops the region and underscores');

  ok(TZ.zoneLabel('broker') === 'Broker time (auto)', 'zoneLabel(broker)');
  ok(TZ.zoneLabel('America/New_York') === 'America/New York', 'zoneLabel() humanizes IANA names');
}

/* ---------- 7. Utc-based "now" pipeline ---------- */
{
  App.feed.serverOff = 3 * 3600;
  const viaParts = TZ.parts('Asia/Tehran', JAN + 10800);
  const viaUtc = TZ.partsUtc('Asia/Tehran', JAN);
  ok(viaParts.hour === viaUtc.hour && viaParts.minute === viaUtc.minute,
    'partsUtc() is the same funnel one offset upstream');
  App.feed.serverOff = 0;
  ok(/^\d{2}:\d{2}:\d{2}$/.test(TZ.nowLabel('UTC')), 'nowLabel() is HH:MM:SS');
}

/* ---------- 8. AppError catalog ---------- */
{
  const e = AppErr.create('PROVIDER_TIMEOUT');
  ok(e instanceof Error && e.name === 'AppError', 'create() returns an Error');
  ok(e.code === 'PROVIDER_TIMEOUT' && e.category === 'provider',
    'known code keeps its catalog code/category');
  ok(e.severity === 'error' && /time/i.test(e.userMessage) && e.hint.length > 0,
    'catalog severity/userMessage/hint are applied');

  const unknown = AppErr.create('NOT_A_CODE');
  ok(unknown.code === 'UNKNOWN' && unknown.severity === 'error',
    'unknown code degrades to UNKNOWN');

  const custom = AppErr.create('FEED_CLOSED', {
    message: 'socket gone', userMessage: 'Custom text', hint: '', context: { a: 1 }, cause: 'x',
  });
  ok(custom.message === 'socket gone' && custom.userMessage === 'Custom text',
    'opts override the message and user-facing text');
  ok(custom.toUser() === 'Custom text', 'toUser() drops an empty hint');
  ok(custom.hint === '' && custom.context.a === 1 && custom.cause === 'x',
    'opts are preserved');
  ok(AppErr.create('FEED_CLOSED').toUser().includes('Reconnecting'),
    'toUser() joins message + hint when present');
  ok(AppErr.create('FEED_CLOSED').id !== AppErr.create('FEED_CLOSED').id,
    'every error gets a unique id');

  const logged = custom.toLog();
  ok(logged.code === 'FEED_CLOSED' && logged.category === 'feed' && logged.ctx.a === 1,
    'toLog() carries code/category/context');
  custom.stack = 'x'.repeat(3000);
  ok(custom.toLog().stack.length === 2000, 'toLog() truncates the stack to 2000 chars');
  ok(AppErr.create('UNKNOWN').toLog().ctx === undefined, 'toLog() omits absent context');
}

/* ---------- 9. wrap / raise / register ---------- */
{
  const wrapped = AppErr.wrap(new Error('boom'), 'FEED_CLOSED', { where: 'test' });
  ok(wrapped.code === 'FEED_CLOSED' && wrapped.message === 'boom' && wrapped.context.where === 'test',
    'wrap() normalizes a plain Error');
  ok(wrapped.cause instanceof Error, 'wrap() keeps the original as cause');

  const again = AppErr.wrap(wrapped, 'UNKNOWN', { extra: 2 });
  ok(again === wrapped && again.context.extra === 2 && again.context.where === 'test',
    'wrap(AppError) is idempotent and merges context');

  const text = AppErr.wrap('plain text');
  ok(text.code === 'UNKNOWN' && text.message === 'plain text', 'wrap(string) uses the fallback code');

  const orig = Log.error;
  const calls = [];
  Log.error = (cat, msg, ctx) => { calls.push({ cat, msg, ctx }); };
  const raised = AppErr.raise('PROVIDER_AUTH', { message: 'bad login' });
  Log.error = orig;
  ok(raised instanceof AppErr.AppError && calls.length === 1 && calls[0].cat === 'provider',
    'raise() creates and logs through the central logger');
  ok(String(calls[0].msg).includes('PROVIDER_AUTH'), 'raise() logs a code-prefixed message');

  ok(AppErr.register('TEST_LAYER_CODE', { severity: 'warning', category: 'ui' }) === true,
    'register() adds a new code');
  ok(AppErr.register('TEST_LAYER_CODE', {}) === false, 'register() refuses duplicates');
  ok(AppErr.register('', {}) === false, 'register() refuses an empty code');
  const registered = AppErr.spec('TEST_LAYER_CODE');
  ok(registered.category === 'ui' && registered.userMessage === 'TEST_LAYER_CODE',
    'registered codes get safe defaults');
  ok(AppErr.codes().includes('TEST_LAYER_CODE'), 'codes() lists registered codes');
  ok(AppErr.spec('NOPE') === null, 'spec(unknown) is null');

  ok(AppErr.isHard(AppErr.create('PROVIDER_START')) === true, 'isHard() is true for errors');
  ok(AppErr.isHard(AppErr.create('FEED_CLOSED')) === false, 'isHard() is false for warnings');
  ok(AppErr.isHard({ severity: 'critical' }) === false, 'isHard() needs a real AppError');
  ok(AppErr.SEV_RANK.critical === 3, 'SEV_RANK is exposed');
}

App.feed = prevFeed;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
