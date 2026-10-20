/**
 * ROUND86 (user request) — pure math for the Custom Session mode
 * ("stitched hours"): the user picks a daily hour window (e.g. 03:00–05:00)
 * and a date range; the app takes that window from EVERY day in the range
 * and lays the resulting candles side by side, with a small visual gap
 * between consecutive day regions.
 *
 * Chart stamps are broker server-label pseudo-UTC seconds (the same frame
 * the whole app uses — provider_common.bucket_start rule), so a "day" is
 * simply floor(t / 86400) and an "hour" is the offset inside that day.
 *
 * This module is DOM-free and import-free so Node tests can load it
 * directly (same pattern as the round-84 harness).
 *
 * @module core/session-math
 */

const DAY = 86400;

/* start (epoch sec) of the server-label day containing t */
function dayStartOf(t) {
  return Math.floor(t / DAY) * DAY;
}

/* is chart-second t inside the daily window [hFrom:hFrom, hTo:mTo)?
   Hours keep their round-86 meaning (hTo == 24 means "until the end of the
   day"); mFrom/mTo add MINUTES on top (round 87 — user request: "الان فقط
   ساعت رو میشه مشخص کرد . میخوام دقیقه رو هم بشه مشخص کرد"). Undefined
   minutes read as 0 so every round-86 caller keeps its exact semantics. */
function windowSec(hFrom, hTo, mFrom, mTo) {
  const hF = Math.max(0, Math.min(23, hFrom | 0));
  const hT = Math.max(0, Math.min(24, hTo | 0));
  const mF = Math.max(0, Math.min(59, (mFrom == null ? 0 : mFrom) | 0));
  const mT = Math.max(0, Math.min(59, (mTo == null ? 0 : mTo) | 0));
  return { sFrom: hF * 3600 + mF * 60, sTo: Math.min(86400, hT * 3600 + mT * 60) };
}

function inSessionWindow(t, hFrom, hTo, mFrom, mTo, shift) {
  const w = t + (shift ? shift(t) : 0);           // wall = stamp + (zone − srv)
  const off = w - dayStartOf(w);
  const mF = (mFrom == null ? 0 : mFrom) | 0;
  const mT = (mTo == null ? 0 : mTo) | 0;
  return off >= hFrom * 3600 + mF * 60 && off < hTo * 3600 + mT * 60;
}

/* aggregation anchor for session candles. ROUND88: anchored at the WINDOW
   START of the day (in the wall frame — see stitchBars) so the first
   candle of every day region sits EXACTLY at the entered window start:
   - intraday tf -> window-aligned buckets (03:30–06:30 on H1 -> the
     03:30 / 04:30 / 05:30 candles of every day; hour-aligned windows
     keep the round-86 day-start buckets they always produced)
   - tf >= D1    -> ONE candle per day (the whole session window of that
     day folds into a single candle — the meaningful reading of "1 day"
     for a 2-hour stitched window) */
function sessionBucket(tfSec, t, sFrom) {
  const ds = dayStartOf(t);
  if (tfSec >= DAY) return ds;
  const f = sFrom != null ? sFrom : 0;
  return ds + f + Math.floor((t - ds - f) / tfSec) * tfSec;
}

/* filter base bars to the daily window + aggregate to tfSec candles.
   bars: ascending [{time,open,high,low,close,volume}]; rows with any
   non-finite OHLC are dropped (same rule as manager.sanitizeBars).
   hFrom/hTo keep their hour meaning; mFrom/mTo add minutes (round 87).

   ROUND88 (user report: "کاربر بر اساس تایم زونی که انتخاب کرده برای چارتش
   ... وارد میکنه و میخواد طبق همون تایم زون چارتش این محدوده ساعت ها نمایش
   داده بشه"): `shift` interprets the WINDOW in the CHART'S TIMEZONE instead
   of the raw broker stamps. shift = function(t) -> seconds with
   wall = t + shift(t) (wall = stamp − serverOff + zoneOffset; so
   shift = zoneOffset(tz) − serverOff). null/undefined keeps the exact
   round-86/87 behaviour (window on raw stamps = the 'broker' tz case).

   The window test runs on the WALL clock; the bucket anchor is window-
   aligned in the wall frame and emitted back in the STAMP frame so every
   downstream consumer (axis, drawings, crosshair) keeps the chart's time
   base. Returns the COMPACT candle list (real bars only — no gap rows).

   ROUND89 (user report, 3rd — the chart showed a FOURTH region past the
   selected dates): optional dFrom/dTo (CHART-TZ day numbers, the same units
   as cfg) CLIP the output to the user's date range. The window test alone
   cannot see calendar dates, so a drifted/zeroed broker offset used to let
   real bars leak into a region labelled the day AFTER dTo. With the clip,
   NO region outside [dFrom..dTo] can ever render, whatever the offset does. */
function stitchBars(bars, tfSec, hFrom, hTo, mFrom, mTo, shift, dFrom, dTo) {
  const out = [];
  let cur = null, curT = -1;
  if (!Array.isArray(bars) || !(tfSec > 0)) return out;
  const w = windowSec(hFrom, hTo, mFrom, mTo);
  const sh = shift || null;
  const dLo = (dFrom != null && isFinite(dFrom)) ? dFrom * DAY : -Infinity;
  const dHi = (dTo != null && isFinite(dTo)) ? dTo * DAY : Infinity;   // inclusive lower bound of the day
  for (const b of bars) {
    if (!b || !isFinite(b.time) || !isFinite(b.open) ||
        !isFinite(b.high) || !isFinite(b.low) || !isFinite(b.close)) continue;
    const wall = b.time + (sh ? sh(b.time) : 0);
    const dW = dayStartOf(wall);
    if (dW < dLo || dW > dHi) continue;    // ROUND89: outside the selected dates
    const off = wall - dW;
    if (off < w.sFrom || off >= w.sTo) continue;
    const anchorW = sessionBucket(tfSec, wall, w.sFrom);
    /* emit back in the stamp frame: stamp = wall − (zone − srv). Measuring
       the shift AT the anchor's wall instant is the exact conversion for
       that wall second (the same funnel the axis labels run through). */
    const anchor = sh ? anchorW - sh(anchorW) : anchorW;
    if (!cur || anchor !== curT) {
      if (cur) out.push(cur);
      curT = anchor;
      cur = { time: anchor, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
    } else {
      if (b.high > cur.high) cur.high = b.high;
      if (b.low < cur.low) cur.low = b.low;
      cur.close = b.close;
      cur.volume += b.volume || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* insert `gapBars` whitespace slots between consecutive DAY segments so
   each day's region is visually separated (user request: "با یک فاصله ی
   کمی ناحیه ی هر روز از روز دیگه جدا بشه").
   Gap times INTERPOLATE between the last bar of a day and the first bar of
   the next day, so they always stay strictly between the two segments for
   ANY timeframe (a D1 session would otherwise jump 3 whole days).
   Gap rows carry ONLY {time} — lightweight-charts whitespace semantics —
   and are recognisable by having exactly one key.
   Returns { bars (new array with gap rows), gaps (inserted count) }. */
function insertDayGaps(bars, gapBars, shift) {
  const g = Math.max(0, Math.floor(gapBars || 0));
  if (!g || !Array.isArray(bars) || bars.length < 2) {
    return { bars: (bars || []).slice(), gaps: 0 };
  }
  const sh = shift || null;
  /* ROUND88: day membership runs on the WALL clock, so a region whose
     stamps straddle broker midnight (big tz shift + a window near the day
     edge) still counts as ONE segment and never gets a mid-region gap. */
  const dayOf = (t) => dayStartOf(t + (sh ? sh(t) : 0));
  const out = [];
  let gaps = 0;
  for (let i = 0; i < bars.length; i++) {
    out.push(bars[i]);
    const a = bars[i], b = bars[i + 1];
    if (!b) continue;
    if (dayOf(a.time) === dayOf(b.time)) continue; // same day segment
    const step = (b.time - a.time) / (g + 1);
    if (!(step > 0)) continue;
    for (let k = 1; k <= g; k++) {
      const t = Math.round(a.time + step * k);
      if (t > out[out.length - 1].time && t < b.time) {
        out.push({ time: t });
        gaps++;
      }
    }
  }
  return { bars: out, gaps };
}

/* ROUND90 (user request: "نوار زمان باید با توجه به محدوده‌های انتخابی بریده
   بریده باشه و فقط اون زمان‌هایی که انتخاب شده رو نمایش بده") — segment the
   GAP-INCLUSIVE stitched axis into per-day REGIONS.
   times  = the gap-inclusive axis (pane._sessWithGapTimes — real bars plus
            the {time}-only whitespace slots insertDayGaps put BETWEEN day
            segments);
   gapFlags = parallel array where 1 marks a whitespace slot (pane._sessGapIdx;
            null/absent -> the whole axis is one region).
   insertDayGaps only ever puts gap slots BETWEEN two wall days, so a run of
   non-gap slots IS one day region — no timezone math needed here. Returns
   [{a, b}] index ranges (inclusive), ascending, non-overlapping. Pure. */
function sessionRegions(times, gapFlags) {
  const out = [];
  if (!Array.isArray(times) || !times.length) return out;
  const g = gapFlags || null;
  let a = -1;
  for (let i = 0; i < times.length; i++) {
    const isGap = g ? !!g[i] : false;
    if (!isGap && a < 0) a = i;
    if (isGap && a >= 0) { out.push({ a, b: i - 1 }); a = -1; }
  }
  if (a >= 0) out.push({ a, b: times.length - 1 });
  return out;
}

/* per-day region END for stitched charts (round 87 — Pine drawing clamp).
   The Custom Session chart only "exists" inside the user's daily window, so
   a script box/line that reaches past its day's window end (the 786 Zones
   "End of Day" 21:00 GMT edge, a Fixed +Nmin edge, …) must stop at the end
   of ITS OWN day region instead of spilling across the gap into the next
   day ("این گزینه هم باکس ها رو باید تا انتهای همون ناحیه در روز امتداد
   بدهند و وارد روز بعدی نشوند").
   For every day present in `barTimes` (the pane's COMPACT stitched bars)
   the region end is min(dayStart + sTo, that day's last bar + tfSec) —
   window end capped by the data actually shown that day. ROUND88: days are
   WALL days (shift-aware, matching the window the user entered in their
   chart timezone) and the end is emitted back in the stamp frame so the
   clamp compares like with like. Returns Map(wallDaySec -> endStampSec);
   days without bars are absent. */
function sessionRegionEnds(barTimes, tfSec, hTo, mTo, shift) {
  const map = new Map();
  if (!Array.isArray(barTimes) || !barTimes.length) return map;
  const w = windowSec(0, hTo, 0, mTo);
  const tf = tfSec > 0 ? tfSec : 60;
  const sh = shift || null;
  let curDay = -1, lastT = -1;
  const flush = () => {
    if (curDay < 0) return;
    const endW = curDay + w.sTo;                       // wall frame
    const endS = sh ? endW - sh(endW) : endW;          // -> stamp frame
    map.set(curDay, Math.min(endS, lastT + tf));
  };
  for (let i = 0; i < barTimes.length; i++) {
    const t = barTimes[i];
    if (!isFinite(t)) continue;
    const d = dayStartOf(t + (sh ? sh(t) : 0));        // wall day
    if (d !== curDay) {
      flush();
      curDay = d; lastT = t;
    } else if (t > lastT) lastT = t;
  }
  flush();
  return map;
}

export { DAY, dayStartOf, windowSec, inSessionWindow, sessionBucket, stitchBars, insertDayGaps, sessionRegions, sessionRegionEnds };
