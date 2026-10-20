/**
 * timezone support (TradingView list)
 *
 * Round 16 display funnel: chart stamps are BROKER server wall time (pseudo-
 * UTC from the MetaTrader5 package). Every formatter routes through here:
 * chart stamp -> true UTC (minus the detected broker offset) -> selected zone
 * (with per-zone DST via Intl). Special zone 'broker' = raw stamps as UTC
 * (= the TV "exchange time"); its label shows the live detected GMT offset.
 *
 * @module core/timezone
 */

import { App } from './state.js';

const ZONES = [
    'UTC',
    'Pacific/Pago_Pago', 'Pacific/Honolulu', 'Pacific/Marquesas', 'America/Adak',
    'America/Anchorage', 'America/Los_Angeles', 'America/Vancouver', 'America/Denver',
    'America/Phoenix', 'America/Chicago', 'America/Winnipeg', 'America/Mexico_City',
    'America/New_York', 'America/Toronto', 'America/Havana', 'America/Caracas',
    'America/Halifax', 'America/St_Johns', 'America/Bogota', 'America/Lima',
    'America/Santiago', 'America/Sao_Paulo', 'America/Buenos_Aires', 'Atlantic/South_Georgia',
    'Atlantic/Azores', 'Atlantic/Cape_Verde', 'Europe/London', 'Europe/Dublin',
    'Europe/Lisbon', 'Europe/Zurich', 'Europe/Stockholm', 'Europe/Oslo',
    'Europe/Copenhagen', 'Europe/Amsterdam', 'Europe/Brussels', 'Europe/Paris',
    'Europe/Madrid', 'Europe/Rome', 'Europe/Berlin', 'Europe/Warsaw',
    'Europe/Prague', 'Europe/Vienna', 'Europe/Budapest', 'Europe/Athens',
    'Europe/Helsinki', 'Europe/Kiev', 'Europe/Bucharest', 'Europe/Istanbul',
    'Europe/Moscow', 'Europe/Minsk', 'Africa/Cairo', 'Africa/Johannesburg',
    'Africa/Lagos', 'Africa/Nairobi', 'Asia/Jerusalem', 'Asia/Riyadh',
    'Asia/Baghdad', 'Asia/Tehran', 'Asia/Dubai', 'Asia/Muscat',
    'Asia/Karachi', 'Asia/Kabul', 'Asia/Tashkent', 'Asia/Almaty',
    'Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Dhaka', 'Asia/Yangon',
    'Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Jakarta', 'Asia/Singapore',
    'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Taipei', 'Asia/Manila',
    'Asia/Kuala_Lumpur', 'Asia/Seoul', 'Asia/Tokyo', 'Asia/Pyongyang',
    'Australia/Perth', 'Australia/Darwin', 'Australia/Adelaide', 'Australia/Brisbane',
    'Australia/Sydney', 'Australia/Melbourne', 'Australia/Hobart', 'Pacific/Guadalcanal',
    'Pacific/Noumea', 'Pacific/Auckland', 'Pacific/Fiji', 'Pacific/Chatham',
    'Pacific/Tongatapu', 'Pacific/Apia', 'Pacific/Kiritimati',
  ];

  const TZ = {};

  /* sorted zone list with 'broker' pinned first (settings + tz menu) */
  TZ.zones = function () { return ZONES.slice(); };
  TZ.sortedZones = function () { return ['broker'].concat(ZONES.slice().sort()); };

  const fmtCache = new Map();
  function zfmt(tz) {
    if (!fmtCache.has(tz)) {
      fmtCache.set(tz, new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }));
    }
    return fmtCache.get(tz);
  }
  const offCache = new Map();
  function zoneOffsetMinutes(tz, date) {
    if (tz === 'UTC') return 0;
    const key = tz + '@' + Math.floor(date.getTime() / 600000); // re-measure every 10min
    if (offCache.has(key)) return offCache.get(key);
    let out = 0;
    try {
      const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const parts = {};
      for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
      const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second);
      out = Math.round((asUTC - date.getTime()) / 60000);
    } catch (e) { out = 0; }
    offCache.set(key, out);
    return out;
  }
  TZ.zoneOffsetMinutes = zoneOffsetMinutes;

  /* TRUE UTC epoch -> broker-server wall stamp (chart time base) */
  TZ.toChart = function (utcSec, tz) {
    const off = (App.feed && App.feed.serverOff) || 0;
    return Math.round(utcSec + off);
  };
  /* chart stamp -> true UTC */
  TZ.toUtc = function (chartSec, tz) {
    const off = (App.feed && App.feed.serverOff) || 0;
    return Math.round(chartSec - off);
  };

  /* selected-zone display for a chart stamp (the main funnel) */
  TZ.disp = function (tz, chartSec) {
    const utc = TZ.toUtc(chartSec, tz);
    if (tz === 'broker' || tz === 'UTC') return new Date((tz === 'broker' ? chartSec : utc) * 1000);
    const off = zoneOffsetMinutes(tz, new Date(utc * 1000));
    return new Date((utc + off * 60) * 1000);
  };

  /* formatted parts in the selected zone (from a chart stamp) */
  TZ.parts = function (tz, chartSec) {
    if (tz === 'broker') {
      const d = new Date(chartSec * 1000);
      const p2 = (n) => String(n).padStart(2, '0');
      return {
        hour: p2(d.getUTCHours()), minute: p2(d.getUTCMinutes()), second: p2(d.getUTCSeconds()),
        day: p2(d.getUTCDate()), month: p2(d.getUTCMonth() + 1), year: String(d.getUTCFullYear()),
        monthShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()],
        dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()],
      };
    }
    const utc = TZ.toUtc(chartSec, tz);
    const parts = {};
    try {
      for (const p of zfmt(tz).formatToParts(new Date(utc * 1000))) parts[p.type] = p.value;
    } catch (e) {}
    let dow = '';
    try {
      dow = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(new Date(utc * 1000));
    } catch (e) {}
    const p2 = (n) => String(n).padStart(2, '0');
    return {
      hour: parts.hour === '24' ? '00' : parts.hour,
      minute: parts.minute,
      second: parts.second,
      day: parts.day,
      month: parts.month,
      year: parts.year,
      monthShort: parts.month,
      dow,
    };
  };

  /* numeric y-m-d (immune to ICU month names like "Sept") */
  TZ.ymd = function (tz, chartSec) {
    const p = TZ.parts(tz, chartSec);
    return { y: p.year, m: p.month, d: p.day };
  };

  /* ROUND120: ALL-NUMERIC parts of a chart stamp in the selected zone —
     "2026.09.22 10:38:02" needs 09, not Sep (TZ.parts returns the ICU short
     month name for IANA zones). One dedicated 2-digit formatter, same
     funnel (stamp -> true UTC -> zone) and the same 10-min offset cache. */
  const numFmtCache = new Map();
  function zfmtNum(tz) {
    if (!numFmtCache.has(tz)) {
      numFmtCache.set(tz, new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }));
    }
    return numFmtCache.get(tz);
  }
  TZ.partsNum = function (tz, chartSec) {
    /* ROUND128 BUGFIX: 'broker' was special-cased in TZ.parts but NOT here —
       Intl.DateTimeFormat throws on the pseudo-zone 'broker', the catch then
       returned 1970.01.01 00:00:00. Every numeric stamp rendered through this
       funnel (ToolBox History/Positions "Time" cells, clock labels) showed
       1970 whenever the chart timezone was the default Broker (GMT) — the
       same raw-stamps-as-UTC rule TZ.parts already applies. */
    if (tz === 'broker') {
      const d = new Date(chartSec * 1000);
      const p2 = (n) => String(n).padStart(2, '0');
      return {
        year: String(d.getUTCFullYear()), month: p2(d.getUTCMonth() + 1), day: p2(d.getUTCDate()),
        hour: p2(d.getUTCHours()), minute: p2(d.getUTCMinutes()), second: p2(d.getUTCSeconds()),
      };
    }
    const utc = TZ.toUtc(chartSec, tz);
    const base = (tz === 'broker') ? chartSec : utc;
    const parts = {};
    try {
      for (const p of zfmtNum(tz).formatToParts(new Date(base * 1000))) parts[p.type] = p.value;
    } catch (e) { parts.year = '1970'; parts.month = '01'; parts.day = '01'; parts.hour = '00'; parts.minute = '00'; parts.second = '00'; }
    return {
      year: parts.year, month: parts.month, day: parts.day,
      hour: parts.hour === '24' ? '00' : parts.hour,
      minute: parts.minute, second: parts.second,
    };
  };

  /* axis tick label. type = LWC TickMarkType (0 year / 1 month / 2 day /
     3 time / 4 time-with-seconds) or the legacy strings. */
  TZ.tickLabel = function (tz, chartSec, type, dowOn) {
    const p = TZ.parts(tz, chartSec);
    if (type === 4 || type === 'second') return `${p.hour}:${p.minute}:${p.second}`;
    if (type === 3 || type === 'minute' || type === 'hour' || type === 'time') {
      if (type === 'hour' && p.minute === '00' && p.hour === '00') {
        return (dowOn && p.dow ? p.dow + ' ' : '') + p.day + ' ' + p.month;
      }
      return `${p.hour}:${p.minute}`;
    }
    if (type === 2 || type === 'day') return (dowOn && p.dow ? p.dow + ' ' : '') + p.day + ' ' + p.month;
    if (type === 1 || type === 'month' || type === 'week') return p.day + ' ' + p.month;
    if (type === 0 || type === 'year') return p.year;
    return p.monthShort || p.month;
  };

  /* crosshair time-axis label (TV parity, round 34): the pill carries the
     DATE next to the time — "Mon 07 Sep '26  12:51" — exactly like the TV
     cross mode; second-based intervals add :ss. Daily-and-above charts show
     the date only (there is no intraday time on those bars).
     dateOnly is passed by the callers that know the chart timeframe. */
  TZ.crossLabel = function (tz, chartSec, isSec, dateOnly) {
    const p = TZ.parts(tz, chartSec);
    const dow = (p.dow || '').slice(0, 3);
    const date = `${dow ? dow + ' ' : ''}${p.day} ${String(p.monthShort || p.month || '').slice(0, 3)} '${String(p.year).slice(2)}`;
    if (dateOnly) return date;
    const time = isSec ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
    return `${date}  ${time}`;
  };

  /* full label (Data Window / coords) */
  TZ.fullLabel = function (tz, chartSec) {
    const p = TZ.parts(tz, chartSec);
    return `${p.dow ? p.dow + ', ' : ''}${p.day} ${p.month} ${p.year}  ${p.hour}:${p.minute}:${p.second}`;
  };

  /* short button label */
  TZ.shortLabel = function (tz) {
    if (tz === 'broker') {
      const off = (App.feed && App.feed.serverOff) || 0;
      const sign = off >= 0 ? '+' : '-';
      const a = Math.abs(off);
      const hh = String(Math.floor(a / 3600)).padStart(2, '0');
      const mm = String(Math.round((a % 3600) / 60)).padStart(2, '0');
      return `Broker (GMT${sign}${hh}:${mm})`;
    }
    if (tz === 'UTC') return 'UTC';
    return tz.split('/').pop().replace(/_/g, ' ');
  };

  /* BUG-003 — parts of an instant given as TRUE UTC (the ONE conversion path
     for "now"). TZ.parts takes a CHART stamp (broker wall = utc + off) and
     subtracts the broker offset back; feeding it a raw UTC stamp double-
     subtracted the offset, so with a GMT+3 broker the bottom-bar clock ran
     3h slow (10:47 instead of 13:47 in Tehran). partsUtc re-enters the SAME
     funnel one offset upstream, so the clock and the axis share one pipeline
     and always agree for the same minute. */
  TZ.partsUtc = function (tz, utcSec) {
    const off = (App.feed && App.feed.serverOff) || 0;
    return TZ.parts(tz, utcSec + off);
  };

  /* live clock in the selected zone (bottom bar). Server anchoring (Round 7)
     is preserved: the provider re-measures the broker offset every 30s and
     feed.serverOff carries it — the device clock only provides the second
     tick, every zone conversion goes through the IANA pipeline above.
     Math.floor FIRST: TZ.toUtc rounds (chart stamps are integers, harmless
     there) and rounding a fractional "now" would tick the clock a second
     early half of the time. */
  TZ.nowLabel = function (tz) {
    const utc = Math.floor(Date.now() / 1000);
    const p = TZ.partsUtc(tz, utc);
    return `${p.hour}:${p.minute}:${p.second}`;
  };

  /* label for the tz menu / settings list */
  TZ.zoneLabel = function (tz) {
    if (tz === 'broker') return 'Broker time (auto)';
    return tz.replace(/_/g, ' ');
  };

export { TZ };
