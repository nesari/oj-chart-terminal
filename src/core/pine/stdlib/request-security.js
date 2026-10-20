/**
 * request.security — same-symbol higher-timeframe resampling (round 133)
 *
 * Fully offline: the chart's own bars are the data source. Bars are grouped
 * into HTF buckets by their (server-shifted) open time; the expression is
 * re-evaluated over each completed bucket with the builtin series bound to
 * the bucket's aggregate OHLCV. The value for the CURRENT chart bar is the
 * running aggregate of its in-progress bucket (TV's realtime behaviour) —
 * lookahead_off semantics: no future data ever leaks.
 *
 * Historical bars evaluate their bucket value ONLY once the bucket closes;
 * with lookahead_on the CURRENT bucket's value is used (the SMC FVG/levels
 * pattern relies on it).
 *
 * @module core/pine/stdlib/request-security
 */

import { NA, isNA } from '../types.js';
import { PineArray } from './array.js';
import { haTransform, renkoTransform, linebreakTransform, kagiTransform, pfTransform, sessionFilterBars } from './ticker.js';
import { runtimeError } from '../errors.js';

function tfSeconds(s) {
  const str = String(s == null ? '' : s).trim();
  if (/^S/i.test(str) && /^\d+/.test(str.slice(1))) return parseInt(str.slice(1), 10);
  const secSfx = /^(\d+)S$/i.exec(str); // ROUND207: parity with request.js ("15S")
  if (secSfx) return parseInt(secSfx[1], 10);
  if (/^\d+$/.test(str)) return parseInt(str, 10) * 60;
  const m = /^(\d*)([MHDW])/i.exec(str);
  if (!m) return 0;
  const n = m[1] ? parseInt(m[1], 10) : 1;
  const u = m[2].toUpperCase();
  if (u === 'M') return n * 60;
  if (u === 'H') return n * 3600;
  if (u === 'D') return n * 86400;
  if (u === 'W') return n * 604800;
  return 0;
}

/** bucket start (s, chart-server time) for a bar open time */
function bucketStart(tSec, tfSec) {
  if (tfSec <= 0) return tSec;
  return Math.floor(tSec / tfSec) * tfSec;
}

/**
 * ROUND160: HTF bucket tape — committed (closed-bucket) aggregates per
 * security call-site, so builtin history inside security() expressions reads
 * the HTF frame (close[1] = previous HTF close, not chart close). The tape
 * lives in a runtime site (rollback-safe via cloneSite); commits happen on
 * bucket passage and are idempotent across re-runs of the same bar.
 */
function finalBucketAgg(bars, bk) {
  const agg = { start: bk.start, time: bars[bk.i0].time, open: bars[bk.i0].open,
    high: -Infinity, low: Infinity, close: bars[bk.i1].close, volume: 0 };
  for (let i = bk.i0; i <= bk.i1; i++) {
    const b = bars[i];
    if (b.high > agg.high) agg.high = b.high;
    if (b.low < agg.low) agg.low = b.low;
    agg.volume += b.volume || 0;
    agg.close = b.close;
  }
  if (agg.high === -Infinity) agg.high = null;
  if (agg.low === Infinity) agg.low = null;
  return agg;
}
/* ROUND207: synthetic formations over base-TF aggregates. kind -> fn(aggs,
   params) with params = {brick} | {lines} | {reversal} | {box, revBoxes}. */
const SYNTH = {
  renko: (aggs, p) => renkoTransform(aggs, p.brick),
  linebreak: (aggs, p) => linebreakTransform(aggs, p.lines),
  kagi: (aggs, p) => kagiTransform(aggs, p.reversal),
  pointfigure: (aggs, p) => pfTransform(aggs, p.box, p.revBoxes),
};
/* Base-TF aggregates: final OHLCV per base bucket (first-bar time, like
   finalBucketAgg — synth bar times land inside their completing bucket, so
   historical reads only see bricks whose whole span is confirmed). */
function baseBucketAggs(B, baseSec) {
  const buckets = [];
  let cur = null;
  for (let i = 0; i < B.length; i++) {
    const bs = bucketStart(B[i].time, baseSec);
    if (!cur || cur.start !== bs) { cur = { start: bs, i0: i, i1: i }; buckets.push(cur); }
    cur.i1 = i;
  }
  return { buckets, aggs: buckets.map((bk) => finalBucketAgg(B, bk)) };
}
/* ROUND202: one running HA step — the partial plain aggregate of the live
   bucket chained off the previous committed HA bucket (or the (O+C)/2
   seed for the first bucket). Volume covers the known prefix only. */
function runningHaAgg(B, bucket, II, prevHa, tick) {
  const end = Math.min(II, bucket.i1);
  let hi = -Infinity, lo = Infinity, vol = 0;
  for (let i = bucket.i0; i <= end; i++) {
    const b = B[i];
    if (!b) continue;
    if (typeof b.high === 'number' && isFinite(b.high) && b.high > hi) hi = b.high;
    if (typeof b.low === 'number' && isFinite(b.low) && b.low < lo) lo = b.low;
    vol += b.volume || 0;
  }
  const first = B[bucket.i0] || {};
  const last = B[end] || {};
  let op = first.open, cl = last.close;
  if (tick && isFinite(tick.price) && B[II] && tick.time / 1000 > B[II].time) {
    cl = tick.price;
    if (tick.price > hi) hi = tick.price;
    if (tick.price < lo) lo = tick.price;
  }
  if (hi === -Infinity || typeof op !== 'number' || typeof cl !== 'number' || !isFinite(op) || !isFinite(cl)) {
    return { time: first.time, open: NA, high: NA, low: NA, close: NA, volume: 0 };
  }
  const haC = (op + hi + lo + cl) / 4;
  const haO = (prevHa && typeof prevHa.open === 'number' && typeof prevHa.close === 'number' &&
    isFinite(prevHa.open) && isFinite(prevHa.close))
    ? (prevHa.open + prevHa.close) / 2 : (op + cl) / 2;
  return { time: first.time, open: haO, close: haC,
    high: Math.max(hi, haO, haC), low: Math.min(lo, haO, haC), volume: vol };
}
function commitBucketTape(rt, buckets, bucket, siteKey, xbars, xidx, symId, haAggs) {
  /* ROUND165 (SMC daily levels never drew: drawLevels runs only on the last
     bar, so the old one-per-passage commit left the tape EMPTY and every
     high[1]/low[1] read na): backfill ALL buckets closed before the current
     bar on every call — TV computes HTF history from data, never from call
     frequency. Idempotent via tapeUpTo (a bucket-start number: snapshot- and
     rebuild-safe); the reverse scan exits after the unclosed tail, so the
     caught-up path is O(1) and only the first call walks history.
     ROUND168: cross-symbol calls backfill over the other symbol's bars
     (xbars/xidx) instead of the chart's.
     ROUND202: Heikin-Ashi calls commit the HA bucket series (same starts). */
  if (!siteKey || !rt._site) return;
  const B = xbars || rt.bars || [];
  const II = (xidx != null) ? xidx : rt.barIndex;
  const st = rt._site(siteKey, {});
  if (!st.env) st.env = rt.env;
  if (!st.tape) st.tape = [];
  /* ROUND168: the same call site can serve different symbols across runs
     (input.symbol) — a stale tape from another symbol would read wrong
     values under valid markers, so reset on identity change. */
  const sk = symId || '';
  if (st.tapeSym !== sk) { st.tape = []; st.tapeUpTo = -Infinity; st.tapeSym = sk; }
  let upto = (typeof st.tapeUpTo === 'number') ? st.tapeUpTo : -Infinity;
  let need = -1;
  for (let k = buckets.length - 1; k >= 0; k--) {
    if (buckets[k].i1 < II) { need = k; break; }
  }
  if (need >= 0 && buckets[need].start > upto) {
    for (let k = 0; k <= need; k++) {
      if (buckets[k].start > upto) {
        /* ROUND202: HA entries carry the bucket start alongside (the
           transform drops extra fields). */
        if (haAggs && haAggs[k]) {
          const h = haAggs[k];
          st.tape.push({ start: buckets[k].start, time: h.time, open: h.open,
            high: h.high, low: h.low, close: h.close, volume: h.volume });
        } else {
          st.tape.push(finalBucketAgg(B, buckets[k]));
        }
        upto = buckets[k].start;
      }
    }
    st.tapeUpTo = upto;
    while (st.tape.length > 2000) st.tape.shift();
  }
  st.lastStart = bucket.start;
}

/**
 * security(symbol, timeframe, expression, ...) for the SAME symbol.
 * `bars` = the full chart history (rt.bars — {time(s), open, high, low, close, volume}).
 * Returns the expression's value for the HTF bucket containing the current bar.
 * ROUND168 (phase 1a: cross-symbol): x = { sym, bars, idx } runs the SAME
 * machinery over another symbol's bars at the time-aligned position (no
 * future leak: idx is that symbol's last bar at-or-before chart time).
 */
function securityHigherTf(rt, positional, named, evalExpr, exprNode, siteKey, x) {
  const tfArg = positional[1];
  const tfSec = tfSeconds(tfArg);
  const chartSec = rt.env.tfSec || 60;
  /* ROUND168: the identity fast path is same-symbol only — a cross-symbol
     call with a chart-equal TF must still run the bucket machinery over the
     other symbol's bars (x set by the caller). */
  let B = (x && x.bars) || rt.bars || [];
  let II = (x && x.idx != null) ? x.idx : rt.barIndex;
  let symKey = (x && x.sym) || '';
  if (!x && (!tfSec || tfSec === chartSec)) {
    /* ROUND165: same-chart-TF (or '' = chart TF) is legal in TV — it is just
       the expression itself (lookahead/gaps are no-ops: values identical).
       Used to throw "lower than or equal", which broke every script asking
       daily levels on a D1 chart (SMC drawLevels). */
    if (exprNode == null) throw runtimeError('request.security: expression argument is required');
    return evalExpr(exprNode);
  }
  if (tfSec && tfSec < chartSec) {
    throw runtimeError(`request.security: timeframe "${tfArg}" is lower than the chart's — use request.security_lower_tf for lower timeframes`);
  }
  /* ROUND211 (ticker.new session filter): drop out-of-session source bars
     BEFORE bucketing (regular-hours securities). Realignment is by time —
     the same no-future-leak rule as the symbol join. The cache/tape key
     carries the spec so filtered and unfiltered calls never share entries.
     Unchanged bar sets skip the substitution (no key churn). */
  if (x && x.session) {
    const fb = sessionFilterBars(B, x.session, rt.env);
    if (!fb.length) return NA;
    if (fb.length !== B.length) {
      const anchor = B[Math.min(II, B.length - 1)];
      const ct = anchor ? anchor.time : -Infinity;
      let oi = -1, lo = 0, hi = fb.length - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (fb[m].time <= ct) { oi = m; lo = m + 1; } else hi = m - 1;
      }
      if (oi < 0) return NA;
      B = fb; II = oi; symKey = (symKey || '') + '|sess:' + x.session;
    }
  }
  /* ROUND207 (synthetic chart-type tickers): substitute the formation bars
     for the source bars, then run the SAME destination bucket machinery
     below (gaps/lookahead/history/tape untouched). The formation is a
     forward chain memoized on the source bars (+ last-bar OHLC for tick
     freshness); each synth bar's time is its completing base bucket's, so
     historical reads only see confirmed spans (same argument as HA). */
  let synthDone = false;
  if (x && x.synth && SYNTH[x.synth.kind]) {
    const sp = x.synth; // {kind, baseSec, pstr, params} (resolved by the caller)
    const srcB = B;
    if (srcB.length) {
      const skey = symKey + '|' + sp.baseSec + '|' + sp.kind + '|' + sp.pstr;
      const lb = srcB[srcB.length - 1] || {};
      let se = rt._htfCaches && rt._htfCaches.get(skey);
      if (!se || se.barCount !== srcB.length || se.t0 !== srcB[0].time || se.t1 !== lb.time ||
          se.lc !== lb.close || se.lh !== lb.high || se.ll !== lb.low) {
        const { aggs } = baseBucketAggs(srcB, sp.baseSec);
        se = { barCount: srcB.length, t0: srcB[0].time, t1: lb.time,
          lc: lb.close, lh: lb.high, ll: lb.low, synth: SYNTH[sp.kind](aggs, sp.params) };
        if (!rt._htfCaches) rt._htfCaches = new Map();
        rt._htfCaches.set(skey, se);
        while (rt._htfCaches.size > 8) {
          const oldest = rt._htfCaches.keys().next();
          if (oldest.done) break;
          rt._htfCaches.delete(oldest.value);
        }
      }
      if (se.synth && se.synth.length) {
        /* Align to the chart time (cross-sym: the chart's own bar, not the
           source index — same no-future-leak rule as the symbol join). */
        const ct = ((x.cross ? (rt.bars && rt.bars[rt.barIndex]) : null) || srcB[Math.min(II, srcB.length - 1)] || {}).time;
        let oi = -1, lo = 0, hi = se.synth.length - 1;
        while (lo <= hi) {
          const m = (lo + hi) >> 1;
          if (se.synth[m].time <= ct) { oi = m; lo = m + 1; } else hi = m - 1;
        }
        if (oi >= 0) {
          B = se.synth; II = oi; symKey = skey; synthDone = true;
        } else return NA; // formation hasn't produced a bar yet (early history)
      } else return NA;
    } else return NA;
  }
  const lookahead = named.find((n) => n.name === 'lookahead');
  const lookaheadOn = !!(lookahead && lookahead.value && lookahead.value.__pineEnum && lookahead.value.payload === 'lookahead_on');
  const gaps = named.find((n) => n.name === 'gaps');
  const gapsOn = !!(gaps && gaps.value && gaps.value.__pineEnum && gaps.value.payload === 'gaps_on');

  const bars = B;
  if (!bars.length) return NA;

  // 1) group ALL bars into HTF buckets once per run (memoized per
  // symbol+TF — ROUND169/phase-1b: scripts mixing securities (H1+D, or two
  // symbols) call with alternating keys every bar; a single cache slot
  // thrashed O(bars) rebuilds per call. Map capped at 8 combos.)
  const ck = symKey + '|' + tfSec;
  let ce = rt._htfCaches && rt._htfCaches.get(ck);
  const t0 = bars.length ? bars[0].time : 0;
  const t1 = bars.length ? bars[bars.length - 1].time : 0;
  if (!ce || ce.barCount !== bars.length || ce.t0 !== t0 || ce.t1 !== t1) {
    const buckets = []; // { start, i0, i1 (inclusive), done }
    let cur = null;
    for (let i = 0; i < bars.length; i++) {
      const bs = bucketStart(bars[i].time, tfSec);
      if (!cur || cur.start !== bs) {
        cur = { start: bs, i0: i, i1: i };
        buckets.push(cur);
      }
      cur.i1 = i;
    }
    ce = { barCount: bars.length, t0, t1, buckets };
    if (!rt._htfCaches) rt._htfCaches = new Map();
    rt._htfCaches.set(ck, ce);
    while (rt._htfCaches.size > 8) {
      const oldest = rt._htfCaches.keys().next();
      if (oldest.done) break;
      rt._htfCaches.delete(oldest.value);
    }
    rt._htfCache = ce; // compat alias (single-slot readers)
  }
  const { buckets } = ce;

  /* ROUND202 (Heikin-Ashi ticker): HA runs on the BUCKET OHLC series (what a
     native HTF HA chart shows), not on aggregated intraday-HA. The HA chain
     is memoized on the bucket cache entry (rebuilt only when the bars move).
     Plain and HA calls share the time-only bucket grouping. */
  const haCall = !synthDone && !!(x && x.ha);
  let haAggs = null;
  if (haCall) {
    if (!ce.haAggs) {
      const plains = buckets.map((bk) => finalBucketAgg(B, bk));
      const shaped = plains.map((a) => ({ time: a.time, open: a.open, high: a.high,
        low: a.low, close: a.close, volume: a.volume }));
      const ha = haTransform(shaped);
      ce.haAggs = ha.map((h, k) => ({ start: buckets[k].start, time: h.time,
        open: h.open, high: h.high, low: h.low, close: h.close, volume: h.volume }));
    }
    haAggs = ce.haAggs;
  }

  // 2) the bucket containing the current bar
  let bi = -1;
  {
    const bs = bucketStart(bars[Math.min(II, bars.length - 1)].time, tfSec);
    for (let k = buckets.length - 1; k >= 0; k--) { if (buckets[k].start === bs) { bi = k; break; } }
  }
  if (bi < 0) return NA;

  // past buckets (fully closed at the current bar): the LAST CLOSED one feeds
  // confirmed history; the in-progress one only when lookahead_on
  const bucket = buckets[bi];
  const inProgress = II >= bucket.i0 && II <= bucket.i1 && bucket.i1 >= bars.length - 1 ? II === bucket.i1 && bucket.i1 === bars.length - 1 : false;
  // A bucket is closed for a historical bar when the current bar index is
  // PAST its i1; on the very last loaded bar its own bucket is "in progress".
  const isLastBar = II === bars.length - 1;
  const currentClosed = !isLastBar ? II > bucket.i1 : false;

  let target, targetIdx;
  if (lookaheadOn) { target = bucket; targetIdx = bi; }               // current bucket's running value
  else if (isLastBar) { target = bucket; targetIdx = bi; }            // realtime bar: running value (official)
  else {
    // historical: last bucket whose i1 < current bar index... but Pine shows
    // the bucket value ON ITS OWN bars too (the bucket's last bar carries the
    // final aggregate). Official: historical bar shows the value CONFIRMED as
    // of that bar — i.e. the PREVIOUS closed bucket (repaint-free).
    // ROUND168: when the current bar IS its bucket's last bar (always true
    // for same-TF 1:1), that bucket is closed as of this bar — use its final
    // aggregate, not the previous bucket's (security(sym,tf,close) on the
    // same TF must read the current close, like TV). Scoped to gaps_off:
    // gaps_on has its own pinned contract (fully stepped, no holes).
    let sel = null, selIdx = -1;
    if (II !== bucket.i1 || gapsOn) {
      for (let k = buckets.length - 1; k >= 0; k--) { if (buckets[k].i1 < II + 1 && buckets[k].i1 < II || buckets[k].i1 <= II && k < bi) { sel = buckets[k]; selIdx = k; break; } }
    }
    if (!sel) { // the bucket the bar belongs to hasn't closed — use its running value (matches TV's realtime bar)
      target = bucket; targetIdx = bi;
    } else { target = sel; targetIdx = selIdx; }
  }

  /* ROUND157 (TV parity): gaps_on = confirmed closes only — a bucket whose
     last bar is not strictly before the current bar is unconfirmed, so the
     expression yields na (a real gap, not a running value and not a step).
     In particular the realtime bar is always na under gaps_on: nothing has
     closed yet. gaps_off (default) keeps the running/backfilled values. */
  if (gapsOn && target.i1 >= II) return NA;

  // 3) aggregate the target bucket and evaluate the expression over it
  const running = target === bucket && (lookaheadOn || isLastBar) && II <= target.i1;
  let agg;
  if (haCall) {
    /* ROUND202: committed buckets read the HA chain; the running bucket
       chains one HA step off the previous committed HA bucket. */
    if (running) {
      agg = runningHaAgg(B, bucket, II, bi > 0 ? haAggs[bi - 1] : null, x && x.tick);
    } else {
      const h = haAggs[targetIdx];
      agg = { time: h.time, open: h.open, high: h.high, low: h.low, close: h.close, volume: h.volume };
    }
  } else {
  const aggPlain = { time: bars[target.i0].time, open: bars[target.i0].open, high: -Infinity, low: Infinity, close: bars[target.i1].close, volume: 0 };
  for (let i = target.i0; i <= target.i1; i++) {
    const b = bars[i];
    if (b.high > aggPlain.high) aggPlain.high = b.high;
    if (b.low < aggPlain.low) aggPlain.low = b.low;
    aggPlain.volume += b.volume || 0;
    aggPlain.close = b.close; // last bar's close
  }
  // running-bucket close = the CURRENT bar's close, not the bucket's last
  if (running) {
    aggPlain.close = bars[II].close;
    aggPlain.high = Math.max(aggPlain.high, bars[II].high);
    aggPlain.low = Math.min(aggPlain.low, bars[II].low);
    /* ROUND170 (phase 1c: live tick for the other symbol): a tick newer
       than the aligned bar refreshes the running aggregate (close/high/low
       only — history stays bar-based, no future leak by construction). */
    const tk = x && x.tick;
    if (tk && isFinite(tk.price) && tk.time / 1000 > bars[II].time) {
      aggPlain.close = tk.price;
      if (tk.price > aggPlain.high) aggPlain.high = tk.price;
      if (tk.price < aggPlain.low) aggPlain.low = tk.price;
    }
  }
  if (aggPlain.high === -Infinity) return NA;
  agg = aggPlain;
  }

  // 4) evaluate the expression with builtins bound to the aggregate.
  // ROUND158-sweep: the bare-ident fast path used to duplicate the builtin
  // mapping in rt._htfSeries; now it rides the same _htfBuiltin reader the
  // override path uses (one source of truth — the two once diverged).
  // Non-builtin idents (user vars) fall through to the eval path below.
  // ROUND160: commit the bucket tape FIRST (builtin history reads it).
  // ROUND168: cross-symbol commits over the other bars at the aligned index.
  commitBucketTape(rt, buckets, bucket, siteKey, B, II, symKey, haCall ? haAggs : null);
  rt._htfActiveSite = siteKey || null;
  rt._htfOverride = agg;
  /* ROUND231 (TV parity, v6 reference §timeframe.period): the expression
     evaluates in the REQUESTED context, so timeframe.* reads the destination
     TF (period/multiplier/in_seconds("")/is*…). main_period never follows —
     it reads the RUN tf via the _runTfSec pin (outermost override sets it,
     nested contexts keep it). env.tfSec is restored in the finally. */
  const prevSec231 = rt.env.tfSec || 60;
  const prevRun231 = rt._runTfSec;
  rt.env.tfSec = tfSec || prevSec231;
  if (prevRun231 == null) rt._runTfSec = prevSec231;
  try {
    if (exprNode && exprNode.kind === 'ident') {
      const hv = rt._htfBuiltin(exprNode.name);
      if (hv !== undefined) return hv;
    }
    return evalExpr(exprNode);
  } finally { rt._htfOverride = null; rt._htfActiveSite = null; rt.env.tfSec = prevSec231; rt._runTfSec = prevRun231; }
}

export { securityHigherTf, tfSeconds, bucketStart };
