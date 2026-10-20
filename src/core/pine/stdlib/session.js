/**
 * Pine session.* namespace (round 201, TV parity).
 *
 * session.ismarket / ispremarket / ispostmarket answer whether a moment
 * falls in a session specification: "HHMM-HHMM[,more][:days]" in an IANA
 * timezone (Intl wall clock via tzParts — DST handled by the platform).
 * Days follow the dayofweek convention (1=Sunday .. 7=Saturday); omitted
 * days = every day. Overnight ranges ("2000-0800") wrap past midnight.
 *
 * House rules (documented — TV pins these loosely): range bounds are
 * [start, end); premarket = before the first range start of a listed day;
 * postmarket = at/after the last range end; an overnight session belongs to
 * its START day (its morning tail counts for the previous listed day).
 *
 * @module core/pine/stdlib/session
 */

import { NA, isNA } from '../types.js';
import { runtimeError } from '../errors.js';
import { tzParts } from './time.js';

/* "0930-1600" | "0930-1600,1700-1800" each optionally ":days" once at the end.
   Returns { ranges: [{s, e} minutes], days: Set(1..7) } or throws.
   ROUND222a (v4 parity): dfltDays overrides the no-days default — v4
   session strings without days meant Mon–Fri ([2..6]); v5+ means all days. */
function parseSession(spec, dfltDays) {
  const s = String(spec == null ? '' : spec).trim();
  if (!s) throw runtimeError(`session string is empty (expected "HHMM-HHMM[:days]", e.g. "0930-1600:23456")`);
  let body = s, daysTxt = null;
  const ci = s.lastIndexOf(':');
  if (ci >= 0) { body = s.slice(0, ci); daysTxt = s.slice(ci + 1); }
  const ranges = [];
  for (const part of body.split(',')) {
    const m = /^\s*(\d{3,4})\s*-\s*(\d{3,4})\s*$/.exec(part);
    if (!m) throw runtimeError(`bad session range '${part.trim()}' (expected "HHMM-HHMM")`);
    const t = (x) => {
      const v = parseInt(x, 10);
      const hh = Math.floor(v / 100), mm = v % 100;
      if (!(hh >= 0 && hh <= 24 && mm >= 0 && mm <= 59) || (hh === 24 && mm !== 0)) {
        throw runtimeError(`bad session time '${x}' (HHMM, 0000..2400)`);
      }
      return hh * 60 + mm;
    };
    const a = t(m[1]), b = t(m[2]);
    if (a === b) throw runtimeError(`empty session range '${part.trim()}' (start == end)`);
    ranges.push({ s: a, e: b });
  }
  if (!ranges.length) throw runtimeError(`session string '${s}' has no ranges`);
  let days;
  if (daysTxt == null) {
    days = new Set(dfltDays || [1, 2, 3, 4, 5, 6, 7]);
  } else {
    days = new Set();
    for (const ch of daysTxt.trim()) {
      if (ch < '1' || ch > '7') throw runtimeError(`bad session day '${ch}' (digits 1=Sunday..7=Saturday)`);
      days.add(parseInt(ch, 10));
    }
    if (!days.size) throw runtimeError(`session string '${s}' has no days`);
  }
  return { ranges, days };
}

/* Local wall-clock (minutes since midnight) + Pine weekday for epoch ms. */
function wallMin(ms, tz) {
  const p = tzParts(ms, tz);
  /* tzParts.dow is raw JS (0=Sunday); Pine counts 1..7 (round 199). */
  const dow = p.dow + 1;
  return { mins: p.hour * 60 + p.minute, dow, p };
}

function inRanges(mins, ranges) {
  for (const r of ranges) {
    if (r.s < r.e) { if (mins >= r.s && mins < r.e) return true; }
    else { if (mins >= r.s || mins < r.e) return true; } // overnight wrap
  }
  return false;
}

/* First start / last end in range order (overnight starts sort by evening). */
function firstStart(ranges) {
  let m = Infinity;
  for (const r of ranges) m = Math.min(m, r.s);
  return m;
}
function lastEnd(ranges) {
  /* The "end of session" is the end of the range that starts last; an
     overnight range's morning tail belongs to the next calendar day. */
  let best = null;
  for (const r of ranges) {
    if (!best || r.s >= best.s) best = r;
  }
  return best.e;
}

function sessionArgs(args, what, dfltDays) {
  const [time, spec, tz] = args;
  if (isNA(time) || time == null || typeof time !== 'number' || !isFinite(time)) return { na: true };
  if (spec == null || isNA(spec)) throw runtimeError(`${what}() needs a session string (e.g. "0930-1600:23456")`);
  return { ms: time, sess: parseSession(spec, dfltDays), tz: (tz == null || isNA(tz)) ? 'GMT' : String(tz) };
}

/* Shared membership test (ROUND204: also feeds time()). Returns true when
   the moment belongs to the session, with the overnight tail rule. */
function sessionHit(ms, sess, tz) {
  const w = wallMin(ms, tz);
  const prevDow = w.dow === 1 ? 7 : w.dow - 1;
  if (sess.days.has(w.dow) && inRanges(w.mins, sess.ranges)) return true;
  if (sess.days.has(prevDow)) {
    for (const r of sess.ranges) {
      if (r.s > r.e && w.mins < r.e) return true;
    }
  }
  return false;
}

/** time()-overload membership (ROUND204): the moment itself when in
   session, else na (TV: time(timeframe, session[, tz]) filters bars). */
function timeInSession(ms, spec, tz, dfltDays) {
  if (isNA(ms) || ms == null || typeof ms !== 'number' || !isFinite(ms)) return NA;
  if (spec == null || isNA(spec)) throw runtimeError('time() needs a session string (e.g. "0930-1600:23456")');
  const sess = parseSession(spec, dfltDays);
  const zone = (tz == null || isNA(tz)) ? null : String(tz);
  return sessionHit(ms, sess, zone || 'GMT') ? ms : NA;
}

/* ROUND222a: v4 day-less session strings default to Mon–Fri (v5+: all days). */
function v4days(site) {
  return (site && site.env && site.env.pineVersion < 5) ? [2, 3, 4, 5, 6] : null;
}

/** session.ismarket(time, session, timezone) */
function isMarket(site, ...args) {
  const a = sessionArgs(args, 'session.ismarket', v4days(site));
  if (a.na) return NA;
  return sessionHit(a.ms, a.sess, a.tz);
}

/** session.ispremarket(time, session, timezone) */
function isPremarket(site, ...args) {
  const a = sessionArgs(args, 'session.ispremarket', v4days(site));
  if (a.na) return NA;
  const w = wallMin(a.ms, a.tz);
  if (!a.sess.days.has(w.dow)) return false;
  return w.mins < firstStart(a.sess.ranges);
}

/** session.ispostmarket(time, session, timezone) */
function isPostmarket(site, ...args) {
  const a = sessionArgs(args, 'session.ispostmarket', v4days(site));
  if (a.na) return NA;
  const w = wallMin(a.ms, a.tz);
  if (!a.sess.days.has(w.dow)) return false;
  return w.mins >= lastEnd(a.sess.ranges);
}

/* ROUND229 (TV parity, v6 reference §session.isfirstbar): first/last bar
   of the day-session. The engine has no exchange calendar (syminfo.session
   is the 24/7 stub), so day boundaries come from the bar stamps themselves
   (broker-wall days, UTC-day math on bar.time): first = no previous bar or
   a day change behind; last = no next bar or a day change ahead. _regular
   twins are identical here (no extended-session distinction) — documented.
   Pure neighbor reads: trivially rollback-safe, no state. */
function dayOf(t) { return Math.floor(t / 86400); }
function sessBarEdge(site, first) {
  const env = (site && site.env) || {};
  const bars = env.bars, i = env.barIndex;
  if (!Array.isArray(bars) || !bars.length || typeof i !== 'number' || !isFinite(i)) return NA;
  const cur = bars[i];
  if (!cur || typeof cur.time !== 'number' || !isFinite(cur.time)) return NA;
  const nb = first ? bars[i - 1] : bars[i + 1];
  if (!nb || typeof nb.time !== 'number' || !isFinite(nb.time)) return true;
  return dayOf(nb.time) !== dayOf(cur.time);
}

const sessionFns = { ismarket: isMarket, ispremarket: isPremarket, ispostmarket: isPostmarket,
  isfirstbar: (site) => sessBarEdge(site, true),
  islastbar: (site) => sessBarEdge(site, false),
  isfirstbar_regular: (site) => sessBarEdge(site, true),
  islastbar_regular: (site) => sessBarEdge(site, false) };

export { sessionFns, parseSession, isMarket, isPremarket, isPostmarket, sessionHit, timeInSession };
