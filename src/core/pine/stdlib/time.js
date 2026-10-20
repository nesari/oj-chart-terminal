/**
 * Pine time builtins (round 74)
 *
 * Unit contract (official): Pine times are EPOCH MILLISECONDS. The app's
 * chart stamps are epoch SECONDS, so the interpreter receives
 * env.timeScale = 1000 and exposes `time` / `time_close` / intrabar times in
 * ms; the render adapter divides back to seconds when mapping coordinates.
 *
 * Timezone contract: functions accept an optional timezone string. "GMT" and
 * "UTC" mean true UTC; anything else is an IANA zone (Intl based — Node and
 * Electron both ship full ICU). When no timezone is passed, the SYMBOL's
 * exchange tz is used, which this app models as the broker server wall clock:
 * env.serverOffSec (seconds to add to UTC) — the same offset the chart axis
 * uses.
 *
 * @module core/pine/stdlib/time
 */

import { NA, isNA } from '../types.js';

const DAY_MS = 86400000;

/** parts of an epoch-ms timestamp in a timezone — via Intl (full ICU) */
function tzParts(ms, tz) {
  const d = new Date(ms);
  if (!tz || tz === 'GMT' || tz === 'UTC' || tz === 'Etc/UTC' || tz === 'Etc/GMT') {
    return {
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
      dow: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(), time: ms,
    };
  }
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    const parts = {};
    for (const p of f.formatToParts(d)) parts[p.type] = p.value;
    const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    let hour = parseInt(parts.hour, 10);
    if (hour === 24) hour = 0; // some ICU builds emit 24 for midnight
    return {
      year: parseInt(parts.year, 10), month: parseInt(parts.month, 10), day: parseInt(parts.day, 10),
      dow: dowMap[parts.weekday] != null ? dowMap[parts.weekday] : 0,
      hour, minute: parseInt(parts.minute, 10), second: parseInt(parts.second, 10), time: ms,
    };
  } catch (e) {
    // unknown zone: behave like GMT (documented limitation)
    return tzParts(ms, 'GMT');
  }
}

/** broker-wall parts (no explicit tz argument case) */
function exParts(ms, env) {
  if (env.serverOffSec) return tzParts(ms + env.serverOffSec * 1000, 'GMT');
  return tzParts(ms, 'GMT');
}

/** days in a month (Gregorian) */
function daysInMonth(y, mo) {
  if (mo === 2) return (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] || 30;
}

/**
 * timestamp() overloads (official):
 *   timestamp(y, mo, d)                       -> ms, exchange tz
 *   timestamp(y, mo, d, h, m)                 -> ms, exchange tz
 *   timestamp(y, mo, d, h, m, s)              -> ms, exchange tz
 *   timestamp(tz, y, mo, d)                   -> ms, tz
 *   timestamp(tz, y, mo, d, h, m)             -> ms, tz
 *   timestamp(tz, y, mo, d, h, m, s)          -> ms, tz
 * The ambiguity (tz string vs year number) is resolved by the first arg type.
 *
 * ROUND78 perf: the function is PURE in (tz, y, mo, d, h, m, s, serverOffSec).
 * 786 Zones reaches it 12-70x per intrabar through its session chain
 * (sessionZoneStart -> timestamp("GMT", refY, refMo, refD, 0, 0)), repeating
 * identical arguments across intrabars/sessions/days. A bounded memo turns
 * the repeated Date.UTC + tz-convergence work into a Map hit.
 */
const _TS_MEMO = new Map();
function timestamp(env, ...args) {
  let key = env && env.serverOffSec ? env.serverOffSec : 0;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const t = typeof a;
    if (t === 'number' && isFinite(a)) key += '|' + a;
    else if (t === 'string') key += '|' + a;
    else if (a === NA || a == null) { key += '|~'; args = args.slice(); args[k] = undefined; }
    else return _timestampCompute(env, ...args); // exotic argument — bypass
  }
  const hit = _TS_MEMO.get(key);
  if (hit !== undefined) return hit;
  const r = _timestampCompute(env, ...args);
  if (_TS_MEMO.size > 20000) _TS_MEMO.clear();
  _TS_MEMO.set(key, r);
  return r;
}

function _timestampCompute(env, ...args) {
  const clean = (v, dflt) => (isNA(v) || v == null || typeof v !== 'number' || !isFinite(v)) ? dflt : v;
  let tz = null, y, mo, d, h = 0, m = 0, s = 0;
  if (args.length >= 7 || (args.length >= 4 && typeof args[0] === 'string')) {
    tz = String(args[0]);
    y = clean(args[1], 1970); mo = clean(args[2], 1); d = clean(args[3], 1);
    h = clean(args[4], 0); m = clean(args[5], 0); s = args.length >= 7 ? clean(args[6], 0) : 0;
  } else {
    y = clean(args[0], 1970); mo = clean(args[1], 1); d = clean(args[2], 1);
    h = clean(args[3], 0); m = clean(args[4], 0); s = clean(args[5], 0);
  }
  y = Math.trunc(y); mo = Math.trunc(mo); d = Math.trunc(d);
  h = Math.trunc(h); m = Math.trunc(m); s = Math.trunc(s);
  // normalize out-of-range month (official Date arithmetic)
  let y2 = y, mo2 = mo - 1;
  if (mo2 < 0 || mo2 > 11) { const dm = Math.floor(mo2 / 12); y2 += dm; mo2 -= dm * 12; }
  // build as UTC wall clock, then shift for the target zone:
  //   wall(tz) = UTC + offset(tz, t)  ->  utc = wall - offset(tz, utc)
  const guessUTC = Date.UTC(y2, mo2, d, h, m, s);
  let utc = guessUTC;
  if (tz && tz !== 'GMT' && tz !== 'UTC') {
    // iterate twice to converge on the zone's own DST edge for the target day
    for (let k = 0; k < 2; k++) {
      const p = tzParts(utc, tz);
      const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
      utc = guessUTC - (asUTC - utc);
    }
    // after shifting, snap to the intended wall clock in that zone
    const p2 = tzParts(utc, tz);
    if (p2.day !== d || p2.hour !== h || p2.minute !== m || p2.second !== s) {
      utc = guessUTC - (Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, p2.second) - utc);
      const p3 = tzParts(utc, tz);
      utc = guessUTC - (Date.UTC(p3.year, p3.month - 1, p3.day, p3.hour, p3.minute, p3.second) - utc);
    }
  } else if (!tz && env.serverOffSec) {
    // exchange tz = broker wall clock (fixed offset model)
    utc = guessUTC - env.serverOffSec * 1000;
  }
  return utc; // Pine timestamp returns epoch ms
}

/** year/month/dayofmonth/dayofweek/hour/minute/second — 0/1/2-arg forms */
function makeTimeGetter(env, pick) {
  return function (...args) {
    let ms;
    let tz = null;
    if (args.length === 0) {
      ms = env.barTimeMs; // current bar open time
    } else if (args.length === 1) {
      ms = isNA(args[0]) ? NA : args[0];
    } else {
      ms = isNA(args[0]) ? NA : args[0];
      tz = String(args[1]);
    }
    if (ms === NA || ms == null || typeof ms !== 'number' || !isFinite(ms)) return NA;
    const p = tz ? tzParts(ms, tz) : exParts(ms, env);
    return pick(p);
  };
}

const timeGetters = {
  year: makeTimeGetter(env0(), (p) => p.year),
};
function env0() { return { serverOffSec: 0, barTimeMs: 0 }; } // replaced at bind time

/** timenow — wall clock in ms (evaluated at call time) */
function timenow() { return Date.now(); }

export { tzParts, exParts, daysInMonth, timestamp, makeTimeGetter, timenow, DAY_MS };
