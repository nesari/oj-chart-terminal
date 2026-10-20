/**
 * Pine standard library: math.* and str.* (round 74)
 *
 * @module core/pine/stdlib/math
 */

import { NA, isNA, num, pineNum } from '../types.js';
import { PineArray } from './array.js';
import { tzParts } from './time.js';

/* --------------------------------- math -------------------------------- */

function n1(fn) {
  return function (site, x) {
    const v = num(x);
    if (!isFinite(v)) return NA;
    return pineNum(fn(v));
  };
}

const mathFns = {
  abs: n1(Math.abs),
  ceil: n1(Math.ceil),
  floor: n1(Math.floor),
  round: function (site, x, precision) {
    const v = num(x);
    if (!isFinite(v)) return NA;
    const p = (precision == null || isNA(precision)) ? 0 : Math.trunc(num(precision));
    if (!p) return pineNum(Math.round(v));
    const f = Math.pow(10, p);
    return pineNum(Math.round(v * f) / f);
  },
  sqrt: n1(Math.sqrt),
  pow: function (site, x, y) {
    const a = num(x), b = num(y);
    if (!isFinite(a) || !isFinite(b)) return NA;
    return pineNum(Math.pow(a, b));
  },
  exp: n1(Math.exp),
  log: n1(Math.log),
  log10: n1(Math.log10),
  sign: n1(Math.sign),
  todegrees: n1((v) => v * 180 / Math.PI),
  toradians: n1((v) => v * Math.PI / 180),
  cos: n1(Math.cos), sin: n1(Math.sin), tan: n1(Math.tan),
  acos: n1(Math.acos), asin: n1(Math.asin), atan: n1(Math.atan),
  cosh: n1(Math.cosh), sinh: n1(Math.sinh), tanh: n1(Math.tanh),
  random: function (site, min, max) {
    const a = (min == null || isNA(min)) ? 0 : num(min);
    const b = (max == null || isNA(max)) ? 1 : num(max);
    return pineNum(a + Math.random() * (b - a));
  },
  min: function (site, ...args) {
    const vals = [];
    for (const a of args) {
      /* ROUND196: matrices flatten through the same numeric() helper. */
      if (a && (a.__pineArray || a.__pineMatrix)) { const s = a.numeric(); for (const v of s) vals.push(v); }
      else { const v = num(a); if (isFinite(v)) vals.push(v); }
    }
    return vals.length ? pineNum(Math.min.apply(null, vals)) : NA;
  },
  max: function (site, ...args) {
    const vals = [];
    for (const a of args) {
      if (a && (a.__pineArray || a.__pineMatrix)) { const s = a.numeric(); for (const v of s) vals.push(v); }
      else { const v = num(a); if (isFinite(v)) vals.push(v); }
    }
    return vals.length ? pineNum(Math.max.apply(null, vals)) : NA;
  },
  sum: function (site, ...args) {
    let acc = 0;
    for (const a of args) {
      if (a && (a.__pineArray || a.__pineMatrix)) { const s = a.numeric(); for (const v of s) acc += v; }
      else { const v = num(a); if (isFinite(v)) acc += v; }
    }
    return pineNum(acc);
  },
  avg: function (site, ...args) {
    const vals = [];
    for (const a of args) {
      if (a && (a.__pineArray || a.__pineMatrix)) { const s = a.numeric(); for (const v of s) vals.push(v); }
      else { const v = num(a); if (isFinite(v)) vals.push(v); }
    }
    return vals.length ? pineNum(vals.reduce((x, y) => x + y, 0) / vals.length) : NA;
  },
  round_to_mintick: function (site, x) {
    const v = num(x);
    if (!isFinite(v)) return NA;
    const mintick = (site && site.env && site.env.mintick) || 0.00001;
    const d = Math.max(0, Math.round(-Math.log10(mintick)));
    return pineNum(Math.round(v / mintick) / Math.pow(10, d) * Math.pow(10, d) === 0 ? v : Math.round(v / mintick) * mintick);
  },
};

const MATH_CONSTS = {
  pi: Math.PI, e: Math.E, phi: 1.618033988749895, rphi: 0.618033988749895,
  deg2rad: Math.PI / 180, rad2deg: 180 / Math.PI,
};

/* --------------------------------- str --------------------------------- */

function s1(fn) {
  return function (site, s, ...rest) {
    if (isNA(s) || s == null) return NA;
    return fn(String(s), ...rest);
  };
}

function fmtNumber(v, fmt) {
  if (typeof v !== 'number' || !isFinite(v)) return String(v);
  if (fmt === '#.##') return String(Math.round(v * 100) / 100);
  if (fmt === '#.###') return String(Math.round(v * 1000) / 1000);
  if (fmt === '#.####') return String(Math.round(v * 10000) / 10000);
  if (fmt === '#.##%') return (Math.round(v * 10000) / 100) + '%';
  if (fmt === '#,###.##') return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  /* ROUND216 (TV parity): {x,number,percent} is Java MessageFormat percent —
     value x100, whole percents (KZP hit-rate tooltips). Was a silent passthrough. */
  if (fmt === 'percent') return Math.round(v * 100) + '%';
  return String(v);
}

const strFns = {
  tostring: function (site, v, fmt) {
    if (isNA(v) || v == null) return 'NaN';
    /* ROUND151: format.mintick rounds to the symbol's tick size (AlgoAlpha
       level labels). Other enum formats fall through to default rendering. */
    if (typeof v === 'number' && fmt && fmt.__pineEnum && fmt.payload === 'mintick') {
      const mt = site && site.env && site.env.mintick > 0 ? site.env.mintick : 0.01;
      return v.toFixed(Math.max(0, Math.round(-Math.log10(mt))));
    }
    if (typeof v === 'number') return fmtNumber(v, fmt);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v && v.css) return v.css();
    if (v && v.__pineArray) return v.join(', ');
    /* ROUND196: matrices render row-wise, maps as k=v pairs (house format). */
    if (v && v.__pineMatrix) return v.join(', ');
    if (v && v.__pineMap) {
      return [...v.data.entries()].map(([k, val]) => String(k) + '=' + (isNA(val) ? 'NaN' : String(val))).join(', ');
    }
    return String(v);
  },
  tonumber: function (site, s) {
    if (isNA(s) || s == null || s === '') return NA;
    const v = parseFloat(String(s));
    return isFinite(v) ? v : NA;
  },
  length: s1((s) => s.length),
  substring: s1((s, from, to) => s.substring(Math.max(0, Math.trunc(from)), to == null || isNA(to) ? undefined : Math.trunc(to))),
  pos: s1((s, sub) => s.indexOf(sub)),
  contains: s1((s, sub) => s.indexOf(sub) >= 0),
  startswith: s1((s, sub) => s.startsWith(sub)),
  endswith: s1((s, sub) => s.endsWith(sub)),
  lower: s1((s) => s.toLowerCase()),
  upper: s1((s) => s.toUpperCase()),
  trim: s1((s) => s.trim()),
  repeat: s1((s, n) => s.repeat(Math.max(0, Math.trunc(n)))),
  replace: s1((s, from, to) => (isNA(from) || isNA(to)) ? s : s.replace(String(from), String(to))),
  replace_all: s1((s, from, to) => (isNA(from) || isNA(to)) ? s : s.split(String(from)).join(String(to))),
  split: function (site, s, sep) {
    if (isNA(s) || isNA(sep)) return NA;
    const parts = String(s).split(String(sep));
    return new PineArray('string', parts);
  },
  /* ROUND151: str.format(pattern, args...) — Java-style {0} placeholders
     (LuxAlgo Sessions/SMC dashboards). Supported forms: {i} (string),
     {i,number[,FMT]} (fmtNumber subset), {i,time[,FMT]} (GMT default tz).
     '' collapses to ' like MessageFormat. Unknown arg index -> 'NaN'. */
  format: function (site, pattern, ...args) {
    if (isNA(pattern) || pattern == null) return NA;
    return String(pattern)
      .replace(/\{(\d+)(?:,(\w+)(?:,([^}]*))?)?\}/g, (m, idx, type, fmt) => {
        const v = args[Number(idx)];
        if (v === undefined || isNA(v)) return 'NaN';
        const t = String(type || '').toLowerCase();
        if (t === 'number') {
          /* ROUND219 (TV parity): bare {n,number} is the Java default
             #,##0.### (grouping, max 3 decimals) — TV tables show 38.55, not
             38.55000000000018. Explicit sub-formats keep the fmtNumber path;
             str.tostring() is untouched (own precision rules). */
          if (fmt == null || fmt === '') {
            const x = num(v);
            if (typeof x === 'number' && isFinite(x)) return x.toLocaleString('en-US', { maximumFractionDigits: 3 });
          }
          return fmtNumber(num(v), fmt);
        }
        if (t === 'time') return strFns.format_time(site, v, fmt, undefined);
        return (v && v.css) ? v.css() : String(v);
      })
      .replace(/''/g, "'");
  },
  format_time: function (site, time, format, tz) {
    if (isNA(time)) return NA;
    const p = tzParts(time, tz && !isNA(tz) ? String(tz) : 'GMT');
    const pad = (x) => String(x).padStart(2, '0');
    const f = format && !isNA(format) ? String(format) : 'yyyy-MM-ddTHH:mm:ssZ';
    /* ROUND216 (TV parity): single-letter tokens (M/d/yyyy) + month/weekday
       names (MMM/MMMM/EEE/EEEE), with Java single-quote literals honored —
       the old code left "M/d" unsubstituted, and a naive single-letter pass
       would eat the 'd' in quoted 'Date and time'. '' collapses to '. */
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const TKEYS = ['yyyy', 'MMMM', 'MMM', 'MM', 'dd', 'HH', 'mm', 'ss', 'EEEE', 'EEE', 'M', 'd', 'H', 'm', 's'];
    const TMAP = { yyyy: String(p.year), MMMM: MONTHS[p.month - 1], MMM: MONTHS[p.month - 1].slice(0, 3),
      MM: pad(p.month), dd: pad(p.day), HH: pad(p.hour), mm: pad(p.minute), ss: pad(p.second),
      EEEE: DAYS[p.dow], EEE: DAYS[p.dow].slice(0, 3),
      M: String(p.month), d: String(p.day), H: String(p.hour), m: String(p.minute), s: String(p.second) };
    // split into quoted/unquoted runs ('' = escaped quote)
    const runs = [];
    let cur = '', quoted = false;
    for (let i = 0; i < f.length; i++) {
      const ch = f[i];
      if (ch === "'") {
        if (f[i + 1] === "'") { cur += "'"; i++; }
        else { runs.push({ q: quoted, s: cur }); cur = ''; quoted = !quoted; }
      } else cur += ch;
    }
    runs.push({ q: quoted, s: cur });
    const renderRaw = (s) => {
      let out = '';
      for (let i = 0; i < s.length;) {
        let hit = null;
        for (const k of TKEYS) {
          if (s.startsWith(k, i)) { hit = k; break; }
        }
        if (hit) { out += TMAP[hit]; i += hit.length; }
        else { out += s[i]; i++; }
      }
      return out;
    };
    return runs.map((r) => (r.q ? r.s : renderRaw(r.s))).join('');
  },
  match: s1((s, re) => {
    try { return new RegExp(re).test(s); } catch (e) { return false; }
  }),
};

export { mathFns, MATH_CONSTS, strFns };
