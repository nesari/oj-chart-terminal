/**
 * Pine ticker.* namespace (rounds 202/207, TV parity).
 *
 * ticker.heikinashi(sym) returns a ticker HANDLE consumed by
 * request.security(haTicker, tf, expr): the source bars are transformed to
 * Heikin-Ashi OHLC once per run, then flow through the standard HTF bucket
 * machinery (gaps/lookahead/history all behave identically).
 *
 * Heikin-Ashi (standard formulas):
 *   haClose = (O+H+L+C)/4
 *   haOpen[0] = (O[0]+C[0])/2, haOpen[i] = (haOpen[i-1]+haClose[i-1])/2
 *   haHigh = max(H, haOpen, haClose), haLow = min(L, haOpen, haClose)
 * Times and volumes pass through untouched.
 *
 * ROUND207 (synthetic chart types): ticker.renko/linebreak/kagi/pointfigure
 * build PATH-DEPENDENT synthetic OHLCV series from the base-TF aggregates,
 * then request.security buckets the synthetic bars at the destination TF
 * (same gaps/lookahead/history/tape machinery — only the source bars are
 * substituted). Standard formation rules:
 *   renko(brick): 1-brick-size moves both ways (TV classic); several bricks
 *     may complete on one bar; no wicks.
 *   linebreak(n): new line per advancing bar; reversal off the extreme of the
 *     last n lines (3-line break default).
 *   kagi(reversal): one segment per direction run; reversal needs `reversal`
 *     against the segment extreme; seeded on the first >= reversal move.
 *   pointfigure(box, revBoxes): one COLUMN per bar (X up / O down); reversal
 *     needs revBoxes boxes against the column extreme.
 *
 * House rules (documented): all sizes are PRICE units (not ticks); reversal
 * boxes are a box COUNT. Bar time = the completing base aggregate's time
 * (never earlier — no future leak by construction); volume accumulates over
 * the formation span (split evenly across bricks completing on one bar).
 * na closes are skipped (no brick, volume dropped). Before the first brick,
 * line, segment or column completes there is nothing to read (na, like TV) —
 * flat input yields an empty series, which keeps every prefix of the
 * formation consistent with the full run (rollback/history safety).
 * base timeframe must be >= the chart TF (sub-chart data doesn't exist
 * offline) — otherwise loud. Adjustment other than none stays loud.
 *
 * @module core/pine/stdlib/ticker
 */

import { NA, isNA } from '../types.js';
import { runtimeError } from '../errors.js';
import { tfSeconds } from './request.js';
import { parseSession, sessionHit } from './session.js';

function haTransform(bars) {
  const out = new Array(bars ? bars.length : 0);
  let prevO = null, prevC = null;
  for (let k = 0; k < (bars ? bars.length : 0); k++) {
    const b = bars[k] || {};
    const t = b.time;
    const O = b.open, H = b.high, L = b.low, C = b.close;
    if (typeof O !== 'number' || typeof H !== 'number' ||
        typeof L !== 'number' || typeof C !== 'number' ||
        !isFinite(O) || !isFinite(H) || !isFinite(L) || !isFinite(C)) {
      /* Feed hole: repeat the previous HA bar so one na never poisons the
         recursive open chain (leading holes stay na). */
      out[k] = (prevO == null)
        ? { time: t, open: NA, high: NA, low: NA, close: NA, volume: b.volume || 0 }
        : { time: t, open: prevO, close: prevC,
            high: prevO > prevC ? prevO : prevC, low: prevO < prevC ? prevO : prevC,
            volume: b.volume || 0 };
      continue;
    }
    const haC = (O + H + L + C) / 4;
    const haO = (prevO == null) ? (O + C) / 2 : (prevO + prevC) / 2;
    out[k] = {
      time: t, open: haO, close: haC,
      high: Math.max(H, haO, haC), low: Math.min(L, haO, haC),
      volume: b.volume || 0,
    };
    prevO = haO; prevC = haC;
  }
  return out;
}

/* Cross-check helper for tests: expected HA series from raw OHLC columns. */
function haReference(rows) {
  return haTransform(rows.map((r) => ({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v || 0 })));
}

function tickerNew(prefix, ticker, session, sessionRegular, adjustment) {
  const sym = (ticker == null || isNA(ticker)) ? '' : String(ticker);
  if (adjustment != null && !isNA(adjustment)) {
    const a = String(adjustment).toLowerCase();
    if (a && a !== 'none' && a !== 'adjustment.none') {
      throw runtimeError(`ticker.new: adjustment '${adjustment}' needs split/dividend data this engine doesn't have (only adjustment.none)`);
    }
  }
  /* ROUND211 (TV parity): session/session_regular filter the ticker's bars
     (regular-hours securities). The spec parses NOW (loud on garbage) and
     rides the handle; request.security filters source bars before bucketing.
     session wins when both are given. No tz slot exists on ticker.new, so
     the wall clock is GMT (like syminfo.timezone) — documented. */
  const sess = (v) => (v == null || isNA(v) || String(v).trim() === '') ? '' : String(v).trim();
  const s1 = sess(session), s2 = sess(sessionRegular);
  if (s1) parseSession(s1);
  if (s2) parseSession(s2);
  return { __pineTicker: true, kind: 'plain', sym, prefix: prefix == null || isNA(prefix) ? '' : String(prefix),
    session: s1 || s2 || '' };
}

function tickerHeikinashi(sym) {
  const s = (sym == null || isNA(sym)) ? '' : String(sym);
  if (!s) throw runtimeError('ticker.heikinashi() needs a symbol');
  return { __pineTicker: true, kind: 'heikinashi', sym: s };
}

/* ---------------- synthetic formations (ROUND207) ---------------- */

/* Finish-time helper: every emitted bar carries the completing base time. */
function fin(o, c, t, v) {
  return { time: t, open: o, high: o > c ? o : c, low: o < c ? o : c, close: c, volume: v || 0 };
}
function finiteClose(b) {
  const C = b ? b.close : NA;
  return (typeof C === 'number' && isFinite(C)) ? C : null;
}

function renkoTransform(base, brick) {
  const out = [];
  let edge = null, up = 0, down = 0, pendVol = 0;
  for (const b of base || []) {
    const C = finiteClose(b);
    if (C == null) continue;
    pendVol += (b && b.volume) || 0;
    if (edge == null) { edge = C; up = C + brick; down = C - brick; continue; }
    const made = [];
    while (C >= up) { made.push(fin(up - brick, up, b.time, 0)); edge = up; up += brick; down = edge - brick; }
    while (C <= down) { made.push(fin(down + brick, down, b.time, 0)); edge = down; down -= brick; up = edge + brick; }
    if (made.length) {
      const share = pendVol / made.length;
      for (const m of made) m.volume = share;
      pendVol = 0;
      for (const m of made) out.push(m);
    }
  }
  /* No flat stub: before the first brick completes there is nothing to read
     (TV shows na too) — and a stub would break prefix-consistency (a stub
     timed at the series end leaks into early bars). */
  return out;
}

function linebreakTransform(base, n) {
  const out = [];
  let cur = null; // {open, close, dir, t, vol}
  const extreme = (dir) => {
    const ls = out.slice(-Math.max(0, n - 1));
    ls.push(cur);
    if (dir === 1) { let m = Infinity; for (const l of ls) if (l.low < m) m = l.low; return m; }
    let m = -Infinity; for (const l of ls) if (l.high > m) m = l.high; return m;
  };
  const start = (o, c, dir, t, v) => ({ open: o, close: c, dir, t, vol: v || 0 });
  for (const b of base || []) {
    const C = finiteClose(b);
    if (C == null) continue;
    const v = (b && b.volume) || 0;
    if (!cur) { cur = start(C, C, 0, b.time, v); continue; }
    if (cur.dir === 0) {
      cur.vol += v; cur.t = b.time;
      if (C > cur.open) { cur.close = C; cur.dir = 1; }
      else if (C < cur.open) { cur.close = C; cur.dir = -1; }
      else cur.close = C;
      continue;
    }
    if (cur.dir === 1) {
      if (C > cur.close) {
        out.push(fin(cur.open, cur.close, cur.t, cur.vol));
        cur = start(cur.close, C, 1, b.time, v);
      } else if (C < extreme(1)) {
        out.push(fin(cur.open, cur.close, cur.t, cur.vol));
        cur = start(cur.close, C, -1, b.time, v);
      }
      continue;
    }
    if (C < cur.close) {
      out.push(fin(cur.open, cur.close, cur.t, cur.vol));
      cur = start(cur.close, C, -1, b.time, v);
    } else if (C > extreme(-1)) {
      out.push(fin(cur.open, cur.close, cur.t, cur.vol));
      cur = start(cur.close, C, 1, b.time, v);
    }
  }
  /* No flat stub (see renko): a never-directed run yields no lines. */
  if (cur && cur.dir !== 0) out.push(fin(cur.open, cur.close, cur.t, cur.vol));
  return out;
}

function kagiTransform(base, R) {
  const out = [];
  let dir = 0, extreme = 0, start = 0, seeded = false, cur = null, pendVol = 0;
  for (const b of base || []) {
    const C = finiteClose(b);
    if (C == null) continue;
    const v = (b && b.volume) || 0;
    if (!seeded) { start = C; extreme = C; seeded = true; pendVol += v; continue; }
    if (dir === 0) {
      if (C - start >= R) { dir = 1; extreme = C; cur = { open: start, t: b.time, vol: pendVol + v }; }
      else if (start - C >= R) { dir = -1; extreme = C; cur = { open: start, t: b.time, vol: pendVol + v }; }
      else pendVol += v;
      continue;
    }
    if (dir === 1) {
      if (C >= extreme) { extreme = C; cur.t = b.time; cur.vol += v; }
      else if (extreme - C >= R) {
        out.push(fin(cur.open, extreme, cur.t, cur.vol));
        cur = { open: extreme, t: b.time, vol: v }; dir = -1; extreme = C;
      }
      continue;
    }
    if (C <= extreme) { extreme = C; cur.t = b.time; cur.vol += v; }
    else if (C - extreme >= R) {
      out.push(fin(cur.open, extreme, cur.t, cur.vol));
      cur = { open: extreme, t: b.time, vol: v }; dir = 1; extreme = C;
    }
  }
  /* No flat stub (see renko): seeded-but-never-directed yields nothing. */
  if (cur) out.push(fin(cur.open, extreme, cur.t, cur.vol));
  return out;
}

function pfTransform(base, box, rev) {
  const out = [];
  let dir = 0, top = 0, bottom = 0, anchor = null, cur = null, pendVol = 0;
  for (const b of base || []) {
    const C = finiteClose(b);
    if (C == null) continue;
    const v = (b && b.volume) || 0;
    if (dir === 0) {
      if (anchor == null) { anchor = C; pendVol += v; continue; }
      if (C >= anchor + box) {
        dir = 1; bottom = anchor; top = anchor + box;
        while (C >= top + box) top += box;
        cur = { dir: 1, top, bottom, t: b.time, vol: pendVol + v }; pendVol = 0;
      } else if (C <= anchor - box) {
        dir = -1; top = anchor; bottom = anchor - box;
        while (C <= bottom - box) bottom -= box;
        cur = { dir: -1, top, bottom, t: b.time, vol: pendVol + v }; pendVol = 0;
      } else pendVol += v;
      continue;
    }
    if (dir === 1) {
      if (C >= cur.top + box) {
        while (C >= cur.top + box) cur.top += box;
        cur.t = b.time; cur.vol += v;
      } else if (C <= cur.top - rev * box) {
        out.push({ time: cur.t, open: cur.bottom, high: cur.top, low: cur.bottom, close: cur.top, volume: cur.vol });
        const nt = cur.top - box;
        let nb = nt - box;
        while (C <= nb - box) nb -= box;
        cur = { dir: -1, top: nt, bottom: nb, t: b.time, vol: v }; dir = -1;
      } else cur.vol += v;
      continue;
    }
    if (C <= cur.bottom - box) {
      while (C <= cur.bottom - box) cur.bottom -= box;
      cur.t = b.time; cur.vol += v;
    } else if (C >= cur.bottom + rev * box) {
      out.push({ time: cur.t, open: cur.top, high: cur.top, low: cur.bottom, close: cur.bottom, volume: cur.vol });
      const nb = cur.bottom + box;
      let nt = nb + box;
      while (C >= nt + box) nt += box;
      cur = { dir: 1, top: nt, bottom: nb, t: b.time, vol: v }; dir = 1;
    } else cur.vol += v;
  }
  /* No flat stub (see renko): anchored-but-never-directed yields nothing. */
  if (cur) {
    out.push(cur.dir === 1
      ? { time: cur.t, open: cur.bottom, high: cur.top, low: cur.bottom, close: cur.top, volume: cur.vol }
      : { time: cur.t, open: cur.top, high: cur.top, low: cur.bottom, close: cur.bottom, volume: cur.vol });
  }
  return out;
}

/* ROUND211: filter bars to a ticker.new session spec ("0930-1600[:days]",
   GMT wall clock — see tickerNew). Returns the filtered array (may be
   empty); true-UTC ms come from server seconds minus the broker offset. */
function sessionFilterBars(bars, spec, env) {
  if (!spec) return bars;
  /* ROUND222a: v4 day-less specs default Mon–Fri (v5+: all days). */
  const sess = parseSession(spec, (env && env.pineVersion < 5) ? [2, 3, 4, 5, 6] : null);
  const off = (env && env.serverOffSec) || 0;
  const scale = (env && env.timeScale) || 1000;
  const out = [];
  for (const b of bars || []) {
    if (!b || typeof b.time !== 'number') continue;
    const ms = (b.time - off) * scale;
    try {
      if (sessionHit(ms, sess, 'GMT')) out.push(b);
    } catch (e) { out.push(b); } // never break a run on a wall-clock edge
  }
  return out;
}

/* Cross-check helpers for tests: formations over raw OHLC columns. */
function synthReference(kind, rows, p1, p2) {
  const base = rows.map((r) => ({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v || 0 }));
  if (kind === 'renko') return renkoTransform(base, p1);
  if (kind === 'linebreak') return linebreakTransform(base, p1);
  if (kind === 'kagi') return kagiTransform(base, p1);
  return pfTransform(base, p1, p2);
}

/* ---------------- ticker handle factories ---------------- */

function reqSym(sym, what) {
  const s = (sym == null || isNA(sym)) ? '' : String(sym);
  if (!s) throw runtimeError(`ticker.${what}() needs a symbol`);
  return s;
}
/* Ticker base timeframe: ''/na = chart TF (resolved at the security call);
   anything else must parse (a silent chart-TF fallback would reshape bricks
   without a trace). */
function reqTf(tf, what) {
  if (tf == null || isNA(tf) || String(tf).trim() === '') return '';
  const s = String(tf).trim();
  if (tfSeconds(s) <= 0) throw runtimeError(`ticker.${what}(): timeframe "${s}" is not a valid timeframe`);
  return s;
}
function reqSize(v, what, name) {
  const x = (v && v.__pineEnum) ? NaN : Number(v);
  if (!isFinite(x) || x <= 0) throw runtimeError(`ticker.${what}(): ${name} must be a positive number`);
  return x;
}
function reqCount(v, what, name) {
  const x = (v && v.__pineEnum) ? NaN : Math.trunc(Number(v));
  if (!isFinite(x) || x < 1) throw runtimeError(`ticker.${what}(): ${name} must be a positive integer`);
  return x;
}

function tickerRenko(sym, tf, brick) {
  return { __pineTicker: true, kind: 'renko', sym: reqSym(sym, 'renko'), tf: reqTf(tf, 'renko'), brick: reqSize(brick, 'renko', 'brick_size') };
}
function tickerLinebreak(sym, tf, n) {
  return { __pineTicker: true, kind: 'linebreak', sym: reqSym(sym, 'linebreak'), tf: reqTf(tf, 'linebreak'), lines: reqCount(n == null || isNA(n) ? 3 : n, 'linebreak', 'line_number') };
}
function tickerKagi(sym, tf, rev) {
  return { __pineTicker: true, kind: 'kagi', sym: reqSym(sym, 'kagi'), tf: reqTf(tf, 'kagi'), reversal: reqSize(rev, 'kagi', 'reversal_amount') };
}
function tickerPointfigure(sym, tf, box, rev) {
  return { __pineTicker: true, kind: 'pointfigure', sym: reqSym(sym, 'pointfigure'), tf: reqTf(tf, 'pointfigure'), box: reqSize(box, 'pointfigure', 'box_size'), revBoxes: reqCount(rev == null || isNA(rev) ? 3 : rev, 'pointfigure', 'reversal_size') };
}

const isTicker = (v) => v != null && typeof v === 'object' && v.__pineTicker === true;

export { haTransform, haReference, tickerNew, tickerHeikinashi, isTicker,
  renkoTransform, linebreakTransform, kagiTransform, pfTransform, synthReference,
  tickerRenko, tickerLinebreak, tickerKagi, tickerPointfigure, sessionFilterBars };
