/**
 * Pure helpers — the ZERO-DEPENDENCY leaf of the platform core
 * (imported by core modules and by the renderer facade alike; must never
 * import a sibling module).
 *
 * Phase 3: the pure math/time/geometry helpers moved here from the old
 * renderer util.js so every platform (Node tests, web shell, Capacitor)
 * can reuse them. DOM helpers ($, el, …), color conversion and the
 * viewport fitter stayed behind in the renderer facade
 * (src/renderer/js/core/util.js) — they are presentation concerns.
 *
 * @module core/util
 */

/** clamp v into [a, b] */
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Point size (one price unit of the last decimal) for a digit count.
 *
 * Round 30 (user-found hardening): build the value from a scientific-notation
 * STRING instead of a pow() computation. The ECMAScript spec guarantees the
 * parser rounds decimal/exponent literals to the NEAREST IEEE-754 double,
 * while Math.pow is engine-implementation-defined in general (V8 happens to
 * return the nearest double for 10^-1..10^-8 — verified bit-identical — but
 * the spec gives no such promise). One construction path, no math library:
 *   pointSize(5) -> parseFloat('1e-5') === 0.00001
 * @param {number|string} digits decimal count 0..8 (anything else -> 0)
 * @returns {number} 10^-d as the correctly-rounded nearest double
 */
export function pointSize(digits) {
  const d = clamp(parseInt(digits, 10) || 0, 0, 8);
  return parseFloat('1e-' + d);
}

/** price with a fixed digit count, locale-grouped; em-dash for bad input */
export function fmtPrice(p, digits) {
  if (p == null || !isFinite(p)) return '—';
  return p.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/* ROUND145 (hunt for the "Value is null" spam): last-line validator for
 * every write to the MAIN (candlestick-capable) series. LWC throws
 * "Value is null" on a null/NaN OHLC field and the throw used to surface
 * only as a vendor stack with zero app context. Rules mirror exactly what
 * LWC accepts, so valid traffic can never trip it:
 *   - {time}-only rows (whitespace: session gaps, na plots) are legal,
 *   - line rows need a finite `value` WHEN the key is present,
 *   - candle rows need finite open/high/low/close,
 *   - a present `time` must be a finite number.
 * @returns -1 when clean, else the offender index. */
export function firstBadRow(rows) {
  if (!Array.isArray(rows) || !rows.length) return -1;
  const num = (v) => typeof v === 'number' && isFinite(v);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r == null || typeof r !== 'object') return i;
    if ('time' in r && !num(r.time)) return i;
    if ('value' in r) {
      if (!num(r.value)) return i;
    } else if ('open' in r || 'high' in r || 'low' in r || 'close' in r) {
      if (!num(r.open) || !num(r.high) || !num(r.low) || !num(r.close)) return i;
    }
  }
  return -1;
}

/** trailing-edge debounce (this-preserving) */
export function debounce(fn, ms) {
  let t = null;
  return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
}

/* time <-> logical index helpers over a sorted bar-times array */

export function timeToLogical(times, t) {
  const n = times.length;
  if (!n) return 0;
  if (t <= times[0]) {
    const sp = n > 1 ? (times[1] - times[0]) : 60;
    return (t - times[0]) / sp; // negative extrapolation
  }
  if (t >= times[n - 1]) {
    const sp = n > 1 ? (times[n - 1] - times[n - 2]) : 60;
    return (n - 1) + (t - times[n - 1]) / sp;
  }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (times[m] <= t) lo = m; else hi = m;
  }
  return lo + (t - times[lo]) / ((times[hi] - times[lo]) || 1);
}

export function logicalToTime(times, l) {
  const n = times.length;
  if (!n) return 0;
  if (l <= 0) {
    const sp = n > 1 ? (times[1] - times[0]) : 60;
    return times[0] + l * sp;
  }
  if (l >= n - 1) {
    const sp = n > 1 ? (times[n - 1] - times[n - 2]) : 60;
    return times[n - 1] + (l - (n - 1)) * sp;
  }
  const i = Math.floor(l), f = l - i;
  return times[i] + (times[i + 1] - times[i]) * f;
}

/** nearest index in times for a raw time (snapping) */
export function nearestIndex(times, t) {
  const n = times.length;
  if (!n) return -1;
  const l = timeToLogical(times, t);
  return clamp(Math.round(l), 0, n - 1);
}

/* geometry (drawing engine) */

/** distance point->segment */
export function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  const x = x1 + t * dx, y = y1 + t * dy;
  return Math.hypot(px - x, py - y);
}

/** clip infinite line (x1..x2 define direction) to viewport */
export function clipLine(x1, y1, x2, y2, W, H) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const p = [-dx, dx, -dy, dy], q = [x1, W - x1, y1, H - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; }
    else {
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

/** canvas dash array for a line style at width w */
export function dashFor(style, w) {
  if (style === 'dashed') return [Math.max(6, w * 4), Math.max(4, w * 3)];
  if (style === 'dotted') return [0.5, Math.max(3, w * 2.5)];
  return [];
}

/** structured copy (JSON round-trip) */
export const deepCopy = (o) => JSON.parse(JSON.stringify(o));

/** human duration from seconds (e.g. 90 -> '1m 30s') */
export function durHuman(sec) {
  sec = Math.round(sec);
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return m + 'm' + (s ? ' ' + s + 's' : '');
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return h + 'h' + (mm ? ' ' + mm + 'm' : '');
  const d = Math.floor(h / 24), hh = h % 24;
  return d + 'd' + (hh ? ' ' + hh + 'h' : '');
}
