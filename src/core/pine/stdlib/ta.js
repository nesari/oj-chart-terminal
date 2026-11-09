/**
 * Pine ta.* standard library (round 74 — roadmap phase 4)
 *
 * TWO layers, ONE source of truth:
 *  1) BATCH KERNELS — sma/ema/wma/stdev/rsi/trueRange/atr moved VERBATIM from
 *     core/indicators.js (null = missing). core/indicators.js now imports
 *     THESE, so the app's built-in indicators and the Pine engine share the
 *     exact same math (the roadmap's "no two parallel implementations" rule).
 *  2) INCREMENTAL FORMS — bar-by-bar ta.* functions for the interpreter.
 *     Every function receives `site` (per call-site persistent state) plus
 *     the arguments; sites are created/rolled-back by the interpreter so
 *     forming-bar recomputes stay exact.
 *
 * Seeding matches the official language (and the existing kernels):
 *   ta.ema/ta.rma seed with the SMA of the first `len` values,
 *   ta.rsi uses Wilder smoothing with an SMA seed,
 *   ta.atr = ta.rma(tr, len) with the same SMA seed,
 *   ta.stdev is the population deviation (÷ len).
 *
 * @module core/pine/stdlib/ta
 */

import { NA, isNA, num, pineNum } from '../types.js';
import { runtimeError } from '../errors.js';
import { PineArray } from './array.js';

/* ROUND282: ta.pivot_point_levels helpers — the documented type spellings are
   case-insensitive in practice ("Traditional"/"traditional"), and the result
   is an array<float> in the fixed 11-slot order. */
function normalizePivotType(v) {
  const s = String(isNA(v) || v == null ? '' : v).trim();
  const lc = s.toLowerCase();
  /* "DM" is the one documented spelling that is not title-case. */
  if (lc === 'dm') return 'DM';
  if (lc === 'traditional' || lc === 'classic' || lc === 'fibonacci' || lc === 'woodie'
    || lc === 'camarilla') {
    return lc.charAt(0).toUpperCase() + lc.slice(1);
  }
  return s;
}
function arrFromList(items) { return new PineArray('float', items); }
const maxNum = (a, b) => (isFinite(a) && isFinite(b)) ? Math.max(a, b) : (isFinite(a) ? a : b);
const minNum = (a, b) => (isFinite(a) && isFinite(b)) ? Math.min(a, b) : (isFinite(a) ? a : b);

/* ======================= 1) BATCH KERNELS (verbatim) ==================== */

function sma(src, len) {
  const out = new Array(src.length).fill(null);
  let sum = 0, count = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (v != null) { sum += v; count++; }
    if (i >= len) { const old = src[i - len]; if (old != null) { sum -= old; count--; } }
    if (count >= len) out[i] = sum / len;
  }
  return out;
}

function ema(src, len) {
  const out = new Array(src.length).fill(null);
  const k = 2 / (len + 1);
  let prev = null, started = false, seedSum = 0, seedCount = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (v == null) continue;
    if (!started) {
      seedSum += v; seedCount++;
      if (seedCount === len) { prev = seedSum / len; out[i] = prev; started = true; }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

function wma(src, len) {
  const out = new Array(src.length).fill(null);
  const denom = (len * (len + 1)) / 2;
  for (let i = len - 1; i < src.length; i++) {
    let num = 0, ok = true;
    for (let j = 0; j < len; j++) {
      const v = src[i - len + 1 + j];
      if (v == null) { ok = false; break; }
      num += v * (j + 1);
    }
    if (ok) out[i] = num / denom;
  }
  return out;
}

function stdev(src, len) {
  const out = new Array(src.length).fill(null);
  const means = sma(src, len);
  for (let i = len - 1; i < src.length; i++) {
    const m = means[i];
    if (m == null) continue;
    let acc = 0;
    for (let j = 0; j < len; j++) { const v = src[i - j]; if (v != null) acc += (v - m) * (v - m); }
    out[i] = Math.sqrt(acc / len);
  }
  return out;
}

function rsi(src, len) {
  const out = new Array(src.length).fill(null);
  let avgGain = 0, avgLoss = 0, prev = null, count = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (v == null) continue;
    if (prev != null) {
      const ch = v - prev;
      const gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
      if (count < len) {
        avgGain += gain / len; avgLoss += loss / len; count++;
        if (count === len) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      } else {
        avgGain = (avgGain * (len - 1) + gain) / len;
        avgLoss = (avgLoss * (len - 1) + loss) / len;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }
    prev = v;
  }
  return out;
}

function trueRange(bars) {
  const tr = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) tr.push(bars[i].high - bars[i].low);
    else {
      const pc = bars[i - 1].close;
      tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc)));
    }
  }
  return tr;
}

function atr(bars, len) {
  const tr = trueRange(bars);
  const out = new Array(bars.length).fill(null);
  let prev = null, count = 0, acc = 0;
  for (let i = 0; i < tr.length; i++) {
    if (count < len) {
      acc += tr[i]; count++;
      if (count === len) { prev = acc / len; out[i] = prev; }
    } else {
      prev = (prev * (len - 1) + tr[i]) / len;
      out[i] = prev;
    }
  }
  return out;
}

export const kernels = { sma, ema, wma, stdev, rsi, trueRange, atr };

/* ======================= 2) INCREMENTAL ta.* FORMS ====================== */

/** windowed rolling helpers ------------------------------------------------ */

/** rolling window (Pine max_bars_back-style cap) */
class Win {
  constructor(len) { this.buf = []; this.len = Math.max(1, Math.trunc(len)); }
  push(v) {
    this.buf.push(v);
    while (this.buf.length > this.len) this.buf.shift();
  }
  full() { return this.buf.length >= this.len; }
  last(k) { const i = this.buf.length - 1 - k; return i >= 0 ? this.buf[i] : NA; }
  reset(len) { if (len != null) this.len = Math.max(1, Math.trunc(len)); this.buf = []; }
  clone() { const w = new Win(this.len); w.buf = this.buf.slice(); return w; }
}

function intLen(v, dflt) {
  const x = num(v);
  if (!isFinite(x)) return dflt;
  return Math.max(1, Math.trunc(x));
}

/** per-call-site persistent sub-state (nested smoothing windows etc.) —
 *  every sub-site inherits the env reference so bar-reading fns work */
function sub(site, key) {
  if (!site[key]) site[key] = { env: site.env };
  return site[key];
}

/* ---- per-call-site function registry ------------------------------------
   Each entry: fn(site, ...args) -> value. `site` is a plain object created
   per call instance; the interpreter snapshots/restores it for rollback. */

const taFns = {

  /* ------------------------------ averages ----------------------------- */

  sma(site, src, len) {
    const L = intLen(len, 14);
    if (!site.win || site.len !== L) { site.win = new Win(L); site.sum = 0; site.cnt = 0; site.len = L; }
    const v = num(src);
    // account BEFORE pushing: Win.push auto-trims to L, so the evicted value
    // must leave sum/cnt first (the evicted one is buf[0] when full)
    if (site.win.full()) {
      const old = site.win.buf[0];
      if (isFinite(old)) { site.sum -= old; site.cnt--; }
    }
    if (isFinite(v)) { site.sum += v; site.cnt++; }
    site.win.push(v);
    return site.cnt >= L ? pineNum(site.sum / L) : NA;
  },

  ema(site, src, len) {
    const L = intLen(len, 14);
    const v = num(src);
    if (!isFinite(v)) return NA;
    if (!site.started) {
      site.seed = site.seed || [];
      site.seed.push(v);
      if (site.seed.length === L) { site.prev = site.seed.reduce((a, b) => a + b, 0) / L; site.started = true; return pineNum(site.prev); }
      return NA;
    }
    const k = 2 / (L + 1);
    site.prev = v * k + site.prev * (1 - k);
    return pineNum(site.prev);
  },

  rma(site, src, len) {
    const L = intLen(len, 14);
    const v = num(src);
    if (!isFinite(v)) return NA;
    if (!site.started) {
      site.seed = site.seed || [];
      site.seed.push(v);
      if (site.seed.length === L) { site.prev = site.seed.reduce((a, b) => a + b, 0) / L; site.started = true; return pineNum(site.prev); }
      return NA;
    }
    site.prev = (site.prev * (L - 1) + v) / L;
    return pineNum(site.prev);
  },

  wma(site, src, len) {
    const L = intLen(len, 14);
    if (!site.win || site.len !== L) { site.win = new Win(L); site.len = L; }
    site.win.push(num(src));
    if (!site.win.full()) return NA;
    let acc = 0;
    for (let j = 0; j < L; j++) {
      const v = site.win.last(L - 1 - j);
      acc += (isFinite(v) ? v : 0) * (j + 1);
    }
    return pineNum(acc / ((L * (L + 1)) / 2));
  },

  vwma(site, src, vol, len) {
    const L = intLen(len, 20);
    if (!site.sv) { site.sv = {}; }
    const pv = num(src) * num(vol);
    const v = num(vol);
    const smPV = taFns.sma(sub(site, 's_pv'), pv, L);
    const smV = taFns.sma(sub(site, 's_v'), v, L);
    if (isNA(smPV) || isNA(smV) || smV === 0) return NA;
    return pineNum(smPV / smV);
  },

  hma(site, src, len) {
    const L = intLen(len, 20);
    const half = Math.max(1, Math.round(L / 2));
    const sq = Math.max(1, Math.round(Math.sqrt(L)));
    const wh = taFns.wma(sub(site, 'h'), src, half);
    const wf = taFns.wma(sub(site, 'f'), src, L);
    const diff = (isNA(wh) || isNA(wf)) ? NA : 2 * wh - wf;
    return taFns.wma(sub(site, 's'), diff, sq);
  },

  /* ------------------------------ momentum ----------------------------- */

  rsi(site, src, len) {
    const L = intLen(len, 14);
    const v = num(src);
    if (!site.init) { site.prev = null; site.g = 0; site.l = 0; site.cnt = 0; site.ready = false; site.init = true; }
    if (!isFinite(v)) return NA;
    let out = NA;
    if (site.prev != null) {
      const ch = v - site.prev;
      const gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
      if (site.cnt < L) {
        site.g += gain / L; site.l += loss / L; site.cnt++;
        if (site.cnt === L) { site.ready = true; }
      } else {
        site.g = (site.g * (L - 1) + gain) / L;
        site.l = (site.l * (L - 1) + loss) / L;
      }
      if (site.ready) out = pineNum(site.l === 0 ? 100 : 100 - 100 / (1 + site.g / site.l));
    }
    site.prev = v; // prev advances on EVERY bar (kernel parity)
    return out;
  },

  change(site, src, len) {
    const k = (len == null || isNA(len)) ? 1 : Math.max(1, Math.trunc(num(len)));
    site.buf = site.buf || [];
    const v = num(src);
    site.buf.push(v);
    if (site.buf.length > k + 1) site.buf.shift();
    if (site.buf.length < k + 1) return NA;
    const old = site.buf[0];
    if (!isFinite(v) || !isFinite(old)) return NA;
    return pineNum(v - old);
  },

  mom(site, src, len) { return taFns.change(site, src, len); },

  roc(site, src, len) {
    const k = intLen(len, 9);
    site.buf = site.buf || [];
    const v = num(src);
    site.buf.push(v);
    if (site.buf.length > k + 1) site.buf.shift();
    if (site.buf.length < k + 1) return NA;
    const old = site.buf[0];
    if (!isFinite(v) || !isFinite(old) || old === 0) return NA;
    return pineNum(((v - old) / old) * 100);
  },

  cum(site, src) {
    const v = num(src);
    site.acc = site.acc || 0;
    if (isFinite(v)) site.acc += v;
    return pineNum(site.acc);
  },

  rising(site, src, len) {
    const k = intLen(len, 1);
    site.buf = site.buf || [];
    site.buf.push(num(src));
    if (site.buf.length > k + 1) site.buf.shift();
    if (site.buf.length < k + 1) return NA;
    for (let j = 1; j < site.buf.length; j++) {
      if (!(isFinite(site.buf[j]) && isFinite(site.buf[j - 1]) && site.buf[j] > site.buf[j - 1])) return false;
    }
    return true;
  },

  falling(site, src, len) {
    const k = intLen(len, 1);
    site.buf = site.buf || [];
    site.buf.push(num(src));
    if (site.buf.length > k + 1) site.buf.shift();
    if (site.buf.length < k + 1) return NA;
    for (let j = 1; j < site.buf.length; j++) {
      if (!(isFinite(site.buf[j]) && isFinite(site.buf[j - 1]) && site.buf[j] < site.buf[j - 1])) return false;
    }
    return true;
  },

  /* ----------------------------- volatility ---------------------------- */

  tr(site, handle_na) {
    const b = site.env.bar;
    if (!b) return NA;
    const h = num(b.high), l = num(b.low), c = num(b.close);
    /* ROUND154 (strict na): a bar with non-finite H/L/C yields na WITHOUT
       poisoning prevClose. The old code stored the NaN close, nailing the
       NEXT bar's TR to na as well — atr/dmi/kc then lagged one bar longer
       than the strict rule (caught by the round154 differential harness). */
    if (!isFinite(h) || !isFinite(l) || !isFinite(c)) return NA;
    if (site.env.barIndex === 0 || (handle_na !== false && site.prevClose == null)) {
      site.prevClose = c;
      return pineNum(h - l);
    }
    const pc = site.prevClose;
    site.prevClose = c;
    if (pc == null || !isFinite(pc)) return NA;
    return pineNum(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  },

  atr(site, len) {
    const L = intLen(len, 14);
    const trv = taFns.tr(sub(site, 'tr'));
    return taFns.rma(sub(site, 'rma'), trv, L);
  },

  stdev(site, src, len, biased) {
    const L = intLen(len, 20);
    if (!site.win || site.len !== L) { site.win = new Win(L); site.len = L; }
    site.win.push(num(src));
    if (!site.win.full()) return NA;
    const nums = site.win.buf.filter((v) => isFinite(v));
    if (nums.length < L) return NA;
    const mean = nums.reduce((a, b) => a + b, 0) / L;
    let acc = 0;
    for (const v of nums) acc += (v - mean) * (v - mean);
    /* ROUND210 (TV parity): biased=false divides by L-1 (sample stdev;
       default/biased=true divides by L). Used to be loud as an unknown
       named arg although TV documents it. */
    const denom = (biased === false && L > 1) ? L - 1 : L;
    return pineNum(Math.sqrt(acc / denom));
  },

  dev(site, src, len) { // mean absolute deviation
    const L = intLen(len, 20);
    if (!site.win || site.len !== L) { site.win = new Win(L); site.len = L; }
    site.win.push(num(src));
    if (!site.win.full()) return NA;
    const nums = site.win.buf.filter((v) => isFinite(v));
    if (nums.length < L) return NA;
    const mean = nums.reduce((a, b) => a + b, 0) / L;
    let acc = 0;
    for (const v of nums) acc += Math.abs(v - mean);
    return pineNum(acc / L);
  },

  bb(site, src, len, mult) {
    const L = intLen(len, 20);
    const m = (mult == null || isNA(mult)) ? 2 : num(mult);
    const basis = taFns.sma(sub(site, 'sma'), src, L);
    const dv = taFns.stdev(sub(site, 'sd'), src, L);
    if (isNA(basis) || isNA(dv)) return [NA, NA, NA];
    return [basis, pineNum(basis + m * dv), pineNum(basis - m * dv)];
  },

  bbw(site, src, len, mult) {
    const [mid, up, lo] = taFns.bb(sub(site, 'bb'), src, len, mult);
    if (isNA(mid) || mid === 0) return NA;
    return pineNum((up - lo) / mid);
  },

  macd(site, src, fast, slow, sig) {
    const F = intLen(fast, 12), S = intLen(slow, 26), G = intLen(sig, 9);
    const f = taFns.ema(sub(site, 'f'), src, F);
    const s = taFns.ema(sub(site, 's'), src, S);
    const line = (isNA(f) || isNA(s)) ? NA : pineNum(f - s);
    const signal = taFns.ema(sub(site, 'g'), line, G);
    const hist = (isNA(line) || isNA(signal)) ? NA : pineNum(line - signal);
    return [line, signal, hist];
  },

  supertrend(site, factor, atrLen) {
    const L = intLen(atrLen, 10);
    const f = (factor == null || isNA(factor)) ? 3 : num(factor);
    const b = site.env.bar;
    if (!b) return NA;
    const av = taFns.atr(sub(site, 'atr'), L);
    if (isNA(av)) return NA;
    const mid = (b.high + b.low) / 2;
    let upper = mid + f * av, lower = mid - f * av;
    if (site.prevUpper != null) upper = b.close > site.prevUpper ? upper : Math.min(upper, site.prevUpper);
    if (site.prevLower != null) lower = b.close < site.prevLower ? lower : Math.max(lower, site.prevLower);
    let dir = site.dir;
    if (dir == null) dir = 1;
    if (site.prevUpper != null) {
      if (dir === 1 && b.close < upper) dir = -1;
      else if (dir === -1 && b.close > lower) dir = 1;
    }
    site.dir = dir; site.prevUpper = upper; site.prevLower = lower;
    return dir === 1 ? pineNum(lower) : pineNum(upper);
  },

  cci(site, src, len) {
    const L = intLen(len, 20);
    const basis = taFns.sma(sub(site, 'sma'), src, L);
    const dv = taFns.dev(sub(site, 'dev'), src, L);
    if (isNA(basis) || isNA(dv)) return NA;
    const v = num(src);
    if (!isFinite(v)) return NA;
    return pineNum(dv === 0 ? 0 : (v - basis) / (0.015 * dv));
  },

  stoch(site, src, high, low, len) {
    const L = intLen(len, 14);
    const hh = taFns.highest(sub(site, 'h'), high, L);
    const ll = taFns.lowest(site.l || (site.l = {}), low, L);
    const v = num(src);
    if (isNA(hh) || isNA(ll) || !isFinite(v)) return NA;
    if (hh === ll) return 50;
    return pineNum(((v - ll) / (hh - ll)) * 100);
  },

  wpr(site, len) {
    const L = intLen(len, 14);
    const b = site.env.bar;
    if (!b) return NA;
    const hh = taFns.highest(sub(site, 'h'), b.high, L);
    const ll = taFns.lowest(site.l || (site.l = {}), b.low, L);
    if (isNA(hh) || isNA(ll)) return NA;
    if (hh === ll) return -50;
    return pineNum(((hh - b.close) / (hh - ll)) * -100);
  },

  mfi(site, vol, len) {
    const L = intLen(len, 14);
    const b = site.env.bar;
    if (!b) return NA;
    const tpv = (b.high + b.low + b.close) / 3;
    const flow = tpv * num(vol);
    if (site.prevTp == null) { site.prevTp = tpv; return NA; }
    const pos = tpv > site.prevTp;
    site.prevTp = tpv;
    site.win = site.win || [];
    site.win.push({ flow, pos });
    let posSum = 0, negSum = 0;
    if (site.win.length > L) site.win.shift();
    for (const w of site.win) { if (w.pos) posSum += w.flow; else negSum += w.flow; }
    if (site.win.length < L) return NA;
    return pineNum(negSum === 0 ? 100 : 100 - 100 / (1 + posSum / negSum));
  },

  obv(site, vol) {
    const b = site.env.bar;
    if (!b) return NA;
    const v = num(vol);
    site.acc = site.acc || 0;
    if (site.prevClose != null) {
      if (b.close > site.prevClose) site.acc += isFinite(v) ? v : 0;
      else if (b.close < site.prevClose) site.acc -= isFinite(v) ? v : 0;
    }
    site.prevClose = b.close;
    return pineNum(site.acc);
  },

  /* ------------------------- extrema / pivots -------------------------- */

  /* TV parity: ta.highest/lowest accept BOTH forms —
     highest(source, length) and highest(length) [source defaults to high];
     lowest(length) defaults to low. The one-arg form passes a plain int. */
  highest(site, src, len) {
    let S = src, L0 = len;
    if (L0 == null || (typeof L0 !== 'number' && L0.__pineNA)) { L0 = num(src); S = site.env.bar.high; }
    const L = intLen(L0, 14);
    if (!site.win || site.len !== L) { site.win = new Win(L); site.len = L; }
    site.win.push(num(S));
    if (!site.win.full()) return NA;
    let m = -Infinity, ok = false;
    for (const v of site.win.buf) if (isFinite(v)) { m = Math.max(m, v); ok = true; }
    return ok ? pineNum(m) : NA;
  },

  lowest(site, src, len) {
    let S = src, L0 = len;
    if (L0 == null || (typeof L0 !== 'number' && L0.__pineNA)) { L0 = num(src); S = site.env.bar.low; }
    const L = intLen(L0, 14);
    if (!site.win || site.len !== L) { site.win = new Win(L); site.len = L; }
    site.win.push(num(S));
    if (!site.win.full()) return NA;
    let m = Infinity, ok = false;
    for (const v of site.win.buf) if (isFinite(v)) { m = Math.min(m, v); ok = true; }
    return ok ? pineNum(m) : NA;
  },

  /* ROUND282 (TV parity, verified against the v6 reference): ta.max(source)
     and ta.min(source) are the ALL-TIME extreme from the first bar up to the
     current one — no length argument, no window. They are not ta.highest()
     with an implicit length: the reference documents one argument only.
     na values never win the comparison (they are skipped, like TV). */
  max(site, src) {
    const v = num(src);
    if (isFinite(v)) site.m = (site.m == null) ? v : Math.max(site.m, v);
    return site.m == null ? NA : pineNum(site.m);
  },

  min(site, src) {
    const v = num(src);
    if (isFinite(v)) site.m = (site.m == null) ? v : Math.min(site.m, v);
    return site.m == null ? NA : pineNum(site.m);
  },

  /* ROUND227 (TV parity, verified against the v6 reference): ta.range
     returns the highest-high minus lowest-low over length bars (na values
     ignored); na when the window holds no finite value. Argless = current
     bar's high-low; single-arg mirrors highest/lowest (length of high).
     ROUND237 (TV parity, reference §ta.range — exactly ta.range(source,
     length)): other arities are loud in v6 (TV rejects at compile); older
     versions keep the lenient branches. */
  range(site, src, len) {
    const v6 = !site || !site.env || (site.env.pineVersion || 5) >= 6;
    if (v6 && arguments.length !== 3) throw runtimeError('ta.range() takes (source, length) in Pine v6 — argless/single-arg forms do not exist (older versions still accept them)');
    if ((src == null || isNA(src)) && (len == null || isNA(len))) {
      const b = site.env.bar;
      if (!b) return NA;
      const h = num(b.high), l = num(b.low);
      return (isFinite(h) && isFinite(l)) ? pineNum(h - l) : NA;
    }
    let S = src, L0 = len;
    if (L0 == null || (typeof L0 !== 'number' && L0.__pineNA)) { L0 = num(src); S = site.env.bar.high; }
    const L = intLen(L0, 14);
    if (!site.win || site.len !== L) { site.win = new Win(L); site.len = L; }
    site.win.push(num(S));
    if (!site.win.full()) return NA;
    let hi = -Infinity, lo = Infinity, ok = false;
    for (const v of site.win.buf) if (isFinite(v)) { hi = Math.max(hi, v); lo = Math.min(lo, v); ok = true; }
    return ok ? pineNum(hi - lo) : NA;
  },

  highestbars(site, src, len) {
    const L = intLen(len, 14);
    if (!site.win || site.len !== L) { site.win = new Win(L); site.len = L; }
    site.win.push(num(src));
    if (!site.win.full()) return NA;
    let m = -Infinity, mi = 0;
    for (let k = 0; k < site.win.buf.length; k++) {
      const v = site.win.buf[k];
      if (isFinite(v) && v >= m) { m = v; mi = k; }
    }
    return pineNum(mi - (site.win.buf.length - 1)); // negative offset
  },

  lowestbars(site, src, len) {
    const L = intLen(len, 14);
    if (!site.win || site.len !== L) { site.win = new Win(L); site.len = L; }
    site.win.push(num(src));
    if (!site.win.full()) return NA;
    let m = Infinity, mi = 0;
    for (let k = 0; k < site.win.buf.length; k++) {
      const v = site.win.buf[k];
      if (isFinite(v) && v <= m) { m = v; mi = k; }
    }
    return pineNum(mi - (site.win.buf.length - 1));
  },

  /* ------------------------- crosses / events -------------------------- */

  crossover(site, a, b) {
    return taFns._cross(site, a, b, 1);
  },
  crossunder(site, a, b) {
    return taFns._cross(site, a, b, -1);
  },
  _cross(site, a, b, dir) {
    const av = num(a), bv = num(b);
    site.pa = site.pa == null ? av : site.pa;
    site.pb = site.pb == null ? bv : site.pb;
    const res = isFinite(av) && isFinite(bv) && isFinite(site.pa) && isFinite(site.pb) &&
      (dir > 0 ? (site.pa <= site.pb && av > bv) : (site.pa >= site.pb && av < bv));
    site.pa = av; site.pb = bv;
    return res;
  },
  cross(site, a, b) {
    return taFns.crossover(site, a, b) || taFns.crossunder(site, a, b);
  },

  barssince(site, cond) {
    if (truthyCompat(cond)) site.n = 0;
    else site.n = site.n == null ? NA : site.n + 1;
    return site.n == null || site.n === NA ? NA : pineNum(site.n);
  },

  valuewhen(site, cond, src, occurrence) {
    const occ = (occurrence == null || isNA(occurrence)) ? 0 : Math.max(0, Math.trunc(num(occurrence)));
    site.hits = site.hits || [];
    if (truthyCompat(cond)) site.hits.unshift(num(src));
    if (!site.hits.length) return NA;
    return site.hits.length > occ ? pineNumOrVal(site.hits[occ]) : NA;
  },

  pivothigh(site, a, b, c) {
    // ta.pivothigh([source], leftbars, rightbars) — `right` missing means the
    // 2-arg overload (leftbars, rightbars) was used with the implicit `high` source.
    if (c === undefined) return _pivot(site, site.env.bar ? site.env.bar.high : NA, a, b, 1);
    return _pivot(site, a, b, c, 1);
  },
  pivotlow(site, a, b, c) {
    if (c === undefined) return _pivot(site, site.env.bar ? site.env.bar.low : NA, a, b, -1);
    return _pivot(site, a, b, c, -1);
  },

  linreg(site, src, len, offset) {
    const L = intLen(len, 1);
    const off = (offset == null || isNA(offset)) ? 0 : Math.trunc(num(offset));
    if (!site.win || site.len !== L) { site.win = new Win(L); site.len = L; }
    site.win.push(num(src));
    if (!site.win.full()) return NA;
    // linear regression over the window, evaluated `off` bars back
    const n = L;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let k = 0; k < n; k++) {
      const x = k, y = site.win.buf[k];
      if (!isFinite(y)) return NA;
      sx += x; sy += y; sxy += x * y; sxx += x * x;
    }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const intercept = (sy - slope * sx) / n;
    const x = n - 1 - off;
    return pineNum(intercept + slope * x);
  },

  /* ROUND166 (user report: a PSAR script compiled clean but painted
     nothing — ta.sar returned na on EVERY bar): full rewrite to the
     textbook Wilder/TV kernel. The old code divided the fractions by 100
     (TV takes 0.02/0.02/0.2 as-is) and, worse, read a `site.prevBar` it
     never wrote, so `init` never engaged and every bar returned na.
     TV parity notes: fractions as-is; first bar na (needs a previous bar);
     SAR bounded by the prior two extremes (never above prior lows in an
     uptrend); strict penetration flips the trend; a na bar yields na and
     freezes trend state (house rule — documented here, not in TV). */
  sar(site, start, inc, max) {
    const b = site.env.bar;
    if (!b) return NA;
    const st = (start == null || isNA(start)) ? 0.02 : num(start);
    const stp = (inc == null || isNA(inc)) ? 0.02 : num(inc);
    const mx = (max == null || isNA(max)) ? 0.2 : num(max);
    if (!isFinite(st) || !isFinite(stp) || !isFinite(mx) || st <= 0 || stp < 0 || mx <= 0) return NA;
    const bh = num(b.high), bl = num(b.low), bc = num(b.close);
    const p1 = site.prevBar;
    if (!isFinite(bh) || !isFinite(bl) || !isFinite(bc)) {
      if (p1) site.prevBar2 = p1;
      site.prevBar = { high: bh, low: bl, close: bc };
      return NA;
    }
    if (!site.init) {
      if (!p1 || !isFinite(p1.close)) {
        site.prevBar = { high: bh, low: bl, close: bc };
        return NA;
      }
      site.up = bc >= p1.close;
      site.ep = site.up ? bh : bl;
      site.sar = site.up ? p1.low : p1.high;
      if (!isFinite(site.sar)) site.sar = site.up ? bl : bh;
      site.af = st;
      site.init = true;
      site.prevBar2 = p1;
      site.prevBar = { high: bh, low: bl, close: bc };
      return pineNum(site.sar);
    }
    const p2 = site.prevBar2;
    let sar = site.sar + site.af * (site.ep - site.sar);
    if (site.up) {
      const bound = Math.min(p1.low, p2 && isFinite(p2.low) ? p2.low : p1.low);
      if (isFinite(bound)) sar = Math.min(sar, bound);
      if (bl < sar) {
        site.up = false; site.sar = site.ep; site.ep = bl; site.af = st;
      } else {
        if (bh > site.ep) { site.ep = bh; site.af = Math.min(site.af + stp, mx); }
        site.sar = sar;
      }
    } else {
      const bound = Math.max(p1.high, p2 && isFinite(p2.high) ? p2.high : p1.high);
      if (isFinite(bound)) sar = Math.max(sar, bound);
      if (bh > sar) {
        site.up = true; site.sar = site.ep; site.ep = bh; site.af = st;
      } else {
        if (bl < site.ep) { site.ep = bl; site.af = Math.min(site.af + stp, mx); }
        site.sar = sar;
      }
    }
    site.prevBar2 = p1;
    site.prevBar = { high: bh, low: bl, close: bc };
    return pineNum(site.sar);
  },

  vwap(site, src) {
    // session-anchored VWAP (day boundary in the exchange tz)
    const b = site.env.bar;
    if (!b) return NA;
    const t = site.env.barTimeMs;
    const off = (site.env.serverOffSec || 0) * 1000;
    const day = Math.floor((t + off) / 86400000);
    if (day !== site.day) { site.day = day; site.pv = 0; site.v = 0; }
    const price = (src == null || isNA(src)) ? (b.high + b.low + b.close) / 3 : num(src);
    const v = isFinite(b.volume) && b.volume > 0 ? b.volume : 1;
    if (isFinite(price)) { site.pv += price * v; site.v += v; }
    return pineNum(site.v ? site.pv / site.v : NA);
  },

  /* ---------------- ROUND153: window statistics + correlations ---------
     Batch-1 of the missing ta.* set (PINE-COMPLIANCE-PLAN §4-2). All are
     pure trailing-window math over site.buf (oldest-first, trimmed to L);
     na RULES PER FUNCTION are documented below — the differential harness
     scripts/test_round153_ta.mjs encodes the same rules independently, so
     what is actually verified is incremental-vs-batch equivalence (seeding,
     windows, off-by-ones), not the formula choice itself. TV-undocumented
     defaults are marked HOUSE. */

  /* Arnaud Legoux MA. TV defaults (length 9, offset 0.85, sigma 6).
     Weights peak at floor(offset*(L-1)) counting from the OLDEST bar;
     na anywhere in the window poisons (matches na-arithmetic). */
  alma(site, src, length, offset, sigma) {
    const L = intLen(length, 9);
    const off = (offset == null || isNA(offset) || !isFinite(num(offset))) ? 0.85 : num(offset);
    const sig = (sigma == null || isNA(sigma) || !isFinite(num(sigma)) || num(sigma) <= 0) ? 6 : num(sigma);
    const m = Math.floor(off * (L - 1)), s = L / sig;
    site.buf = site.buf || [];
    site.buf.push(num(src));
    while (site.buf.length > L) site.buf.shift();
    if (site.buf.length < L) return NA;
    let norm = 0, acc = 0;
    for (let j = 0; j < L; j++) {
      const v = site.buf[j];
      if (!isFinite(v)) return NA;
      const w = Math.exp(-((j - m) * (j - m)) / (2 * s * s));
      norm += w; acc += v * w;
    }
    return pineNum(acc / norm);
  },

  /* Chande Momentum Oscillator: 100*(su-sd)/(su+sd) over L signed changes.
     HOUSE default length 14. Mirrors TV's nz-sums: partial windows on early
     bars (no full-length gate); no counted change yet -> na. Zero denom -> na
     (Pine x/0 semantics). */
  cmo(site, src, length) {
    const L = intLen(length, 14);
    const v = num(src);
    site.buf = site.buf || []; // signed changes, oldest-first
    if (site.prev !== undefined && isFinite(v) && isFinite(site.prev)) {
      site.buf.push(v - site.prev);
      while (site.buf.length > L) site.buf.shift();
    }
    site.prev = v;
    if (!site.buf.length) return NA;
    let su = 0, sd = 0;
    for (const d of site.buf) { if (d > 0) su += d; else if (d < 0) sd -= d; }
    if (su + sd === 0) return NA;
    return pineNum(100 * (su - sd) / (su + sd));
  },

  /* Ehlers Center of Gravity: -num/den + (L+1)/2 with num = SUM price[i]*(i+1)
     (i=0 is the CURRENT bar), na treated as 0 via nz (TV source does the
     same — so early bars compute over zero-padded windows, no length gate).
     HOUSE default length 10. Zero denom -> na. */
  cog(site, src, length) {
    const L = intLen(length, 10);
    site.buf = site.buf || [];
    /* ROUND153-fix: nz must catch null/NaN too — builtins arrive raw from
       the feed (null/NaN, not the NA singleton), and isNA() is identity-only. */
    const nv = num(src);
    site.buf.push(isFinite(nv) ? nv : 0);
    while (site.buf.length > L) site.buf.shift();
    let nm = 0, dn = 0;
    for (let i = 0; i < L; i++) {
      const p = i < site.buf.length ? site.buf[site.buf.length - 1 - i] : 0; // i=0 -> current
      nm += p * (i + 1); dn += p;
    }
    if (dn === 0) return NA;
    return pineNum(-nm / dn + (L + 1) / 2);
  },

  /* Pearson correlation over the trailing L pairs. HOUSE default length 30.
     Any na in either window -> na (strict). Zero variance -> na. */
  correlation(site, x, y, length) {
    const L = intLen(length, 30);
    site.bx = site.bx || []; site.by = site.by || [];
    site.bx.push(num(x)); site.by.push(num(y));
    while (site.bx.length > L) site.bx.shift();
    while (site.by.length > L) site.by.shift();
    if (site.bx.length < L) return NA;
    let sx = 0, sy = 0;
    for (let i = 0; i < L; i++) {
      if (!isFinite(site.bx[i]) || !isFinite(site.by[i])) return NA;
      sx += site.bx[i]; sy += site.by[i];
    }
    const mx = sx / L, my = sy / L;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < L; i++) {
      const dx = site.bx[i] - mx, dy = site.by[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    if (sxx <= 0 || syy <= 0) return NA;
    return pineNum(sxy / Math.sqrt(sxx * syy));
  },

  /* Window median / mode / variance. HOUSE default length 14. Strict na
     (any hole -> NA); mode ties break first-to-max like array.mode. */
  median(site, src, length) {
    const L = intLen(length, 14);
    site.buf = site.buf || [];
    site.buf.push(num(src));
    while (site.buf.length > L) site.buf.shift();
    if (site.buf.length < L) return NA;
    const a = site.buf.slice().sort((p, q) => p - q);
    for (const v of a) if (!isFinite(v)) return NA;
    const m = Math.floor(L / 2);
    return pineNum(L % 2 ? a[m] : (a[m - 1] + a[m]) / 2);
  },
  mode(site, src, length) {
    const L = intLen(length, 14);
    site.buf = site.buf || [];
    site.buf.push(num(src));
    while (site.buf.length > L) site.buf.shift();
    if (site.buf.length < L) return NA;
    for (const v of site.buf) if (!isFinite(v)) return NA;
    const counts = new Map();
    let best = site.buf[0], bestC = 0;
    for (const v of site.buf) {
      const c = (counts.get(v) || 0) + 1;
      counts.set(v, c);
      if (c > bestC) { best = v; bestC = c; }
    }
    return pineNum(best);
  },
  variance(site, src, length, biased) {
    // biased (÷N), same convention as ta.stdev above
    const L = intLen(length, 14);
    if (!site.win || site.len !== L) { site.win = new Win(L); site.len = L; }
    site.win.push(num(src));
    if (!site.win.full()) return NA;
    const nums = site.win.buf.filter((v) => isFinite(v));
    if (nums.length < L) return NA;
    const mean = nums.reduce((a, b) => a + b, 0) / L;
    let acc = 0;
    for (const v of nums) acc += (v - mean) * (v - mean);
    /* ROUND211: biased=false divides by L-1 (TV parity, like stdev). */
    const denom = (biased === false && L > 1) ? L - 1 : L;
    return pineNum(acc / denom);
  },

  /* Rank Correlation Index (Spearman rho * 100). HOUSE default length 9.
     timeRank[i] = i+1 (oldest=1); price ranks ascending with AVERAGE ranks
     for ties (house tie rule — TV's is undocumented). Strict na. */
  rci(site, src, length) {
    const L = intLen(length, 9);
    site.buf = site.buf || [];
    site.buf.push(num(src));
    while (site.buf.length > L) site.buf.shift();
    if (site.buf.length < L || L < 2) return NA;
    for (const v of site.buf) if (!isFinite(v)) return NA;
    const order = site.buf.map((v, i) => i).sort((a, b) => site.buf[a] - site.buf[b]);
    const prank = new Array(L);
    let r = 0;
    while (r < L) {
      let s = r;
      while (s + 1 < L && site.buf[order[s + 1]] === site.buf[order[r]]) s++;
      const avg = (r + s) / 2 + 1;
      for (let k = r; k <= s; k++) prank[order[k]] = avg;
      r = s + 1;
    }
    let d2 = 0;
    for (let i = 0; i < L; i++) { const d = (i + 1) - prank[i]; d2 += d * d; }
    return pineNum((1 - (6 * d2) / (L * (L * L - 1))) * 100);
  },

  /* Symmetric Weighted MA, fixed 4-bar window [1,2,2,1]/6 (orientation-free).
     Fewer than 4 bars or any na -> NA. */
  swma(site, src) {
    const v = num(src);
    site.buf = site.buf || [];
    site.buf.push(v);
    while (site.buf.length > 4) site.buf.shift();
    if (site.buf.length < 4) return NA;
    for (const x of site.buf) if (!isFinite(x)) return NA;
    return pineNum((site.buf[0] + 2 * site.buf[1] + 2 * site.buf[2] + site.buf[3]) / 6);
  },

  /* ---------------- ROUND158: whole-series percentiles -----------------
     ta.percentile_linear_interpolation / ta.percentile_nearest_rank take
     (source, percentage) with NO length — they rank over the whole run so
     far (all bars, capped at the deepest history). HOUSE reading of an
     ambiguous spec: TV documents the two methods, not the scope; whole-run
     is the only scope consistent with "no length parameter". na values are
     SKIPPED (rank over known values); all-na -> na; percentage clamped to
     [0,100] (lenient — TV may error; documented). O(n log n) per bar
     (full re-sort) — fine for opt-in use, not hot loops. */
  percentile_linear_interpolation(site, src, percentage) {
    return taPercentile(site, src, percentage, 'linear');
  },
  percentile_nearest_rank(site, src, percentage) {
    return taPercentile(site, src, percentage, 'nearest');
  },
  /* ROUND190: ta.percentrank(source, length) — percent of the previous
     `length` values less than or equal to the current value (0-100).
     Reference remark: na anywhere in the window (current included) yields
     na — strict, unlike percentile_* which skips na. Needs `length`
     previous bars; early bars read na (house rule, TV-ambiguous). */
  percentrank(site, src, length) {
    const L = intLen(length, 0);
    if (!(L > 0)) return NA;
    site.buf = site.buf || [];
    const v = num(src);
    site.buf.push(v);
    while (site.buf.length > L + 1) site.buf.shift();
    if (site.buf.length < L + 1) return NA;
    if (!isFinite(v)) return NA;
    const prev = site.buf.slice(0, L);
    for (const x of prev) if (!isFinite(x)) return NA;
    let le = 0;
    for (const x of prev) if (x <= v) le++;
    return pineNum((le / L) * 100);
  },

  /* ---------------- ROUND154: composite indicators ----------------------
     Built by composing the primitives above on per-call sub-sites (same
     pattern as macd/hma/vwma) — no parallel math, one source of truth. */

  /* Directional Movement Index -> [diPlus, diMinus, adx]. TV defaults
     (14, 14). Mirrors TV's published source: Wilder DM smoothed with rma,
     fixnan latched ratios, dx guarded (sum==0 -> 1). */
  dmi(site, diLength, adxLength) {
    const DL = intLen(diLength, 14), AL = intLen(adxLength, 14);
    const b = site.env.bar;
    if (!b) return [NA, NA, NA];
    const chH = taFns.change(sub(site, 'chH'), b.high, 1);
    const chL = taFns.change(sub(site, 'chL'), b.low, 1);
    const plusDM = isNA(chH) ? NA : (chH > -chL && chH > 0 ? chH : 0);
    const minusDM = isNA(chL) ? NA : (-chL > chH && -chL > 0 ? -chL : 0);
    const trur = taFns.rma(sub(site, 'trur'), taFns.tr(sub(site, 'tr')), DL);
    const rPlus = taFns.rma(sub(site, 'rp'), plusDM, DL);
    const rMinus = taFns.rma(sub(site, 'rm'), minusDM, DL);
    // fixnan: latch the last non-na ratio (TV fixnan semantics)
    if (!isNA(rPlus) && !isNA(trur) && trur !== 0) site.fplus = (100 * rPlus) / trur;
    if (!isNA(rMinus) && !isNA(trur) && trur !== 0) site.fminus = (100 * rMinus) / trur;
    const plus = site.fplus !== undefined ? site.fplus : NA;
    const minus = site.fminus !== undefined ? site.fminus : NA;
    const sum = isNA(plus) || isNA(minus) ? NA : plus + minus;
    const dx = isNA(sum) ? NA : (100 * Math.abs(plus - minus)) / (sum === 0 ? 1 : sum);
    return [plus, minus, taFns.rma(sub(site, 'adx'), dx, AL)];
  },

  /* Keltner Channels -> [basis, upper, lower]: SMA basis with ATR bands.
     TV defaults (20, 2). */
  kc(site, src, length, mult) {
    const L = intLen(length, 20);
    const M = mult == null || isNA(mult) || !isFinite(num(mult)) ? 2 : num(mult);
    const basis = taFns.sma(sub(site, 'b'), src, L);
    const atrv = taFns.atr(sub(site, 'a'), L);
    if (isNA(basis) || isNA(atrv)) return [NA, NA, NA];
    return [basis, pineNum(basis + M * atrv), pineNum(basis - M * atrv)];
  },
  /* Keltner width: raw upper-lower distance (HOUSE: unnormalized). */
  kcw(site, src, length, mult) {
    const L = intLen(length, 20);
    const M = mult == null || isNA(mult) || !isFinite(num(mult)) ? 2 : num(mult);
    const atrv = taFns.atr(sub(site, 'a'), L);
    if (isNA(atrv)) return NA;
    return pineNum(2 * M * atrv);
  },

  /* True Strength Index. TV defaults (short 13, long 25). Mirrors TV's
     published source: double-smoothed pc over double-smoothed |pc|. */
  tsi(site, src, shortLen, longLen) {
    const S = intLen(shortLen, 13), Lg = intLen(longLen, 25);
    const pc = taFns.change(sub(site, 'pc'), src, 1);
    const dspc = taFns.ema(sub(site, 'e1'), taFns.ema(sub(site, 'e2'), pc, Lg), S);
    const apc = isNA(pc) ? NA : Math.abs(pc);
    const dsapc = taFns.ema(sub(site, 'e3'), taFns.ema(sub(site, 'e4'), apc, Lg), S);
    if (isNA(dspc) || isNA(dsapc) || dsapc === 0) return NA;
    return pineNum((100 * dspc) / dsapc);
  },

  /* ROUND282 (TV parity, per the v6 reference): ta.pivot_point_levels(type,
     anchor, developing) returns an array<float> of 11 levels in the fixed
     order [P, R1, S1, R2, S2, R3, S3, R4, S4, R5, S5]. Levels a type does not
     define come back as na (e.g. "DM" only fills P/R1/S1). The anchor resets
     accumulation: its true bar snapshots H/L/C and every later bar recomputes
     from that snapshot — `developing` then uses the live (in-progress) H/L/C
     of the current period instead of the snapshot, exactly as documented.
     Woodie cannot develop (its open is period-scoped), so that combination is
     a runtime error like TV. */
  pivot_point_levels(site, typeV, anchorV, developingV) {
    const type = normalizePivotType(typeV);
    const developing = !isNA(developingV) && developingV === true;
    if (developing && type === 'Woodie') {
      throw runtimeError('ta.pivot_point_levels: the "Woodie" type cannot be used with developing=true');
    }
    const bar = site.env && site.env.bar;
    const H = bar ? bar.high : NA, L = bar ? bar.low : NA, C = bar ? bar.close : NA;
    const O = bar ? bar.open : NA;
    if (anchorV === true || site.ph == null) {
      /* reset: start a fresh period at this bar (bar zero also lands here) */
      site.ph = H; site.pl = L; site.pc = C; site.po = O;
    }
    const useH = developing ? maxNum(site.ph, H) : site.ph;
    const useL = developing ? minNum(site.pl, L) : site.pl;
    const useC = developing ? C : site.pc;
    const out = new Array(11).fill(NA);
    if (!isFinite(useH) || !isFinite(useL) || !isFinite(useC)) return arrFromList(out);
    const range = useH - useL;
    const P = (useH + useL + useC) / 3;
    const set = (i, v) => { out[i] = isFinite(v) ? pineNum(v) : NA; };
    switch (type) {
      case 'Traditional': case 'Classic': {
        set(0, P);
        set(1, 2 * P - useL);               // R1
        set(2, 2 * P - useH);               // S1
        set(3, P + range);                  // R2
        set(4, P - range);                  // S2
        set(5, useH + 2 * (P - useL));      // R3
        set(6, useL - 2 * (useH - P));      // S3
        set(7, useH + 3 * (P - useL));      // R4
        set(8, useL - 3 * (useH - P));      // S4
        set(9, useH + 4 * (P - useL));      // R5
        set(10, useL - 4 * (useH - P));     // S5
        break;
      }
      case 'Fibonacci': {
        set(0, P);
        set(1, P + 0.382 * range);          // R1
        set(2, P - 0.382 * range);          // S1
        set(3, P + 0.618 * range);          // R2
        set(4, P - 0.618 * range);          // S2
        set(5, P + range);                  // R3
        set(6, P - range);                  // S3
        set(7, P + 1.618 * range);          // R4
        set(8, P - 1.618 * range);          // S4
        set(9, P + 2.618 * range);          // R5
        set(10, P - 2.618 * range);         // S5
        break;
      }
      case 'Woodie': {
        /* P weights the OPEN double: (H + L + 2*O) / 4 */
        const wp = (useH + useL + 2 * (site.po == null ? useC : site.po)) / 4;
        set(0, wp);
        set(1, 2 * wp - useL);
        set(2, 2 * wp - useH);
        set(3, wp + range);
        set(4, wp - range);
        set(5, useH + 2 * (wp - useL));
        set(6, useL - 2 * (useH - wp));
        break;
      }
      case 'DM': {
        set(0, P);
        set(1, useH - useL); // R1 for DM is the range above P
        set(2, P - (useH - useL));
        break;
      }
      case 'Camarilla': {
        const r = range;
        set(0, P);
        set(1, useC + r * 1.1 / 12);
        set(2, useC - r * 1.1 / 12);
        set(3, useC + r * 1.1 / 6);
        set(4, useC - r * 1.1 / 6);
        set(5, useC + r * 1.1 / 4);
        set(6, useC - r * 1.1 / 4);
        set(7, useC + r * 1.1 / 2);
        set(8, useC - r * 1.1 / 2);
        break;
      }
      default:
        throw runtimeError(`ta.pivot_point_levels: unknown type "${typeV}" (expected "Traditional", "Fibonacci", "Woodie", "Classic", "DM" or "Camarilla")`);
    }
    return arrFromList(out);
  },
};

/* ROUND154: cumulative ta.* SERIES VARIABLES (obv/pvt/wad/wvad/accdist).
   Unlike ta.* functions these are bar-state accumulators read as member
   values (`ta.obv`, no call) — each member node gets its own site (wired in
   _evalMember), so two references stay independent yet identical. na/zero
   guards mirror TV's nz/division semantics; volume na counts as 0.
   ROUND190: nvi/pvi/iii joined with the reference-documented formulas
   (TV v6 "the same on pine" snippets) — the old seed/phantom worries are
   settled: nvi/pvi seed 1.0 with the nz(...,0)==0 rule, iii is the plain
   intraday-intensity ratio (na on flat/na bars). percentile_* live in
   taFns (whole-series scans, round 158). */
function taVar(site, init) {
  if (site.acc === undefined) site.acc = init;
  return site;
}
const taVars = {
  obv(site) {
    const b = site.env.bar;
    if (!b) return NA;
    taVar(site, 0);
    const c = num(b.close), v = num(b.volume);
    if (site.prev !== undefined && isFinite(c) && isFinite(site.prev)) {
      const d = c - site.prev;
      site.acc += (d > 0 ? 1 : d < 0 ? -1 : 0) * (isFinite(v) ? v : 0);
    }
    site.prev = c;
    return pineNum(site.acc);
  },
  pvt(site) {
    const b = site.env.bar;
    if (!b) return NA;
    taVar(site, 0);
    const c = num(b.close), v = num(b.volume);
    if (site.prev !== undefined && isFinite(c) && isFinite(site.prev) && site.prev !== 0) {
      site.acc += ((c - site.prev) / site.prev) * (isFinite(v) ? v : 0);
    }
    site.prev = c;
    return pineNum(site.acc);
  },
  wad(site) {
    // Williams Accumulation/Distribution over the bar's own range
    const b = site.env.bar;
    if (!b) return NA;
    taVar(site, 0);
    const c = num(b.close), h = num(b.high), l = num(b.low);
    if (site.prev !== undefined && isFinite(c) && isFinite(site.prev)) {
      if (c > site.prev) site.acc += c - Math.min(isFinite(l) ? l : c, site.prev);
      else if (c < site.prev) site.acc += c - Math.max(isFinite(h) ? h : c, site.prev);
    }
    site.prev = c;
    return pineNum(site.acc);
  },
  wvad(site) {
    // Williams Variable Accumulation/Distribution: cum((c-o)/(h-l) * volume)
    const b = site.env.bar;
    if (!b) return NA;
    taVar(site, 0);
    const c = num(b.close), o = num(b.open), h = num(b.high), l = num(b.low);
    const v = num(b.volume);
    if (isFinite(c) && isFinite(o) && isFinite(h) && isFinite(l) && h !== l) {
      site.acc += ((c - o) / (h - l)) * (isFinite(v) ? v : 0);
    }
    return pineNum(site.acc);
  },
  accdist(site) {
    // Chaikin A/D: cum(money-flow-multiplier * volume), flat bar adds 0
    const b = site.env.bar;
    if (!b) return NA;
    taVar(site, 0);
    const c = num(b.close), h = num(b.high), l = num(b.low);
    const v = num(b.volume);
    if (isFinite(c) && isFinite(h) && isFinite(l) && h !== l) {
      site.acc += ((2 * c - h - l) / (h - l)) * (isFinite(v) ? v : 0);
    }
    return pineNum(site.acc);
  },
  /* ROUND190: Negative/Positive Volume Index (reference Pine):
     seed 1.0; a zero/na close (or previous close) freezes the value;
     otherwise the index moves only when volume moves the "smart" way
     (down for nvi, up for pvi). Missing previous volume counts as 0. */
  nvi(site) {
    const b = site.env.bar;
    if (!b) return NA;
    if (site.acc === undefined) site.acc = 1.0;
    const c = num(b.close), v = num(b.volume);
    if (site.pc !== undefined && isFinite(c) && c !== 0 && isFinite(site.pc) && site.pc !== 0) {
      const pv = (site.pv === undefined || site.pv === null) ? 0 : site.pv;
      if (isFinite(v) && v < pv) site.acc += ((c - site.pc) / site.pc) * site.acc;
    }
    site.pc = c; site.pv = isFinite(v) ? v : NaN;
    return pineNum(site.acc);
  },
  pvi(site) {
    const b = site.env.bar;
    if (!b) return NA;
    if (site.acc === undefined) site.acc = 1.0;
    const c = num(b.close), v = num(b.volume);
    if (site.pc !== undefined && isFinite(c) && c !== 0 && isFinite(site.pc) && site.pc !== 0) {
      const pv = (site.pv === undefined || site.pv === null) ? 0 : site.pv;
      if (isFinite(v) && v > pv) site.acc += ((c - site.pc) / site.pc) * site.acc;
    }
    site.pc = c; site.pv = isFinite(v) ? v : NaN;
    return pineNum(site.acc);
  },
  /* ROUND190: Intraday Intensity Index = (2c-h-l) / ((h-l) * volume);
     na on flat/na bars (TV parity — no division-by-zero infinities). */
  iii(site) {
    const b = site.env.bar;
    if (!b) return NA;
    const c = num(b.close), h = num(b.high), l = num(b.low);
    const v = num(b.volume);
    if (!isFinite(c) || !isFinite(h) || !isFinite(l) || !isFinite(v) || h === l || v === 0) return NA;
    return pineNum((2 * c - h - l) / ((h - l) * v));
  },
};

function truthyCompat(v) {
  return !(v === NA || v === false || v == null || v === 0);
}
function pineNumOrVal(v) {
  return (typeof v === 'number' && !isFinite(v)) ? NA : v;
}

/* ROUND158: whole-run percentile over site.buf (see taFns entries above). */
function taPercentile(site, src, percentage, method) {
  const p = num(percentage);
  site.buf = site.buf || [];
  site.buf.push(num(src));
  while (site.buf.length > 10000) site.buf.shift();
  if (!isFinite(p)) return NA;
  const pc = Math.min(100, Math.max(0, p));
  const a = site.buf.filter((v) => isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return NA;
  if (method === 'nearest') {
    const rank = Math.ceil((pc / 100) * a.length);
    return pineNum(a[Math.min(a.length, Math.max(1, rank)) - 1]);
  }
  const pos = (pc / 100) * (a.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return pineNum(a[lo] + (a[hi] - a[lo]) * (pos - lo));
}

/** shared pivot machinery: value confirmed `right` bars later */
function _pivot(site, src, left, right, dirSign) {
  const L = intLen(left, 5), R = intLen(right, 5);
  site.buf = site.buf || [];
  site.out = site.out || []; // confirmed pivots waiting for delivery
  const v = num(src);
  site.buf.push(v);
  while (site.out.length) {
    const o = site.out[0];
    if (o.deliverAt === site.env.barIndex) return pineNumOrVal(o.val);
    break;
  }
  if (site.buf.length >= L + R + 1) {
    // candidate sits L bars back; check it against L left + R right neighbors
    const candIdx = site.buf.length - 1 - R;
    const cand = site.buf[candIdx];
    let ok = isFinite(cand);
    for (let k = 0; ok && k < site.buf.length; k++) {
      if (k === candIdx) continue;
      const other = site.buf[k];
      if (!isFinite(other)) continue;
      const inLeft = k < candIdx, inRight = k > candIdx;
      const isEdge = (inLeft && candIdx - k > L) || (inRight && k - candIdx > R);
      if (isEdge) continue;
      if (dirSign > 0 ? other > cand : other < cand) ok = false;
    }
    // trim buffer
    while (site.buf.length > L + R + 1) site.buf.shift();
    if (ok) site.out.push({ val: cand, deliverAt: site.env.barIndex });
  }
  if (site.out.length && site.out[0].deliverAt === site.env.barIndex) return pineNumOrVal(site.out.shift().val);
  return NA;
}

/* site cloning for the var/rollback snapshot: DEEP for plain nested state
   (the forming-bar rerun mutates nested smoothing windows in place), shared
   by reference for the live env and visual objects */
function cloneSite(site) {
  if (site == null || typeof site !== 'object') return site;
  const out = {};
  for (const k of Object.keys(site)) {
    const v = site[k];
    if (k === 'env' || k === 'named') { out[k] = v; continue; } // live references
    if (v && v.__pineArray) out[k] = v.snapshotClone();
    /* ROUND196: matrices/maps snapshot like arrays (reference types). */
    else if (v && (v.__pineMatrix || v.__pineMap)) out[k] = v.snapshotClone();
    else if (v instanceof Win) out[k] = v.clone();
    else if (v && v.__pineObj) out[k] = v; // line/box/label identity is stable
    else if (Array.isArray(v)) out[k] = v.map((x) => (x && (x.__pineArray || x.__pineMatrix || x.__pineMap)) ? x.snapshotClone() : x);
    else if (v && typeof v === 'object') out[k] = cloneSite(v); // nested plain state
    else out[k] = v; // numbers/strings/bools/NA — immutable
  }
  return out;
}

export { taFns, taVars, cloneSite, Win };
