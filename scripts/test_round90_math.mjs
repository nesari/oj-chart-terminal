/**
 * ROUND90 — the Custom Session TIME AXIS is CUT into the user's selected
 * ranges ("نوار زمان باید با توجه به محدوده‌های انتخابی بریده بریده باشه و
 * فقط اون زمان‌هایی که انتخاب شده رو نمایش بده").
 *
 * Pins (pure layer — the same functions engine.js now runs):
 *  1. sessionRegions segments the GAP-INCLUSIVE axis into exactly one
 *     region per WALL day — gap slots never join a region, a region whose
 *     stamps straddle broker midnight still stays ONE region (round-88
 *     wall-day rule), no gap flags -> one region (legacy arrays).
 *  2. Per-region tick chains anchored at the region start (the engine's
 *     j = a + k*N walk) produce ONLY in-window times, and equal-length
 *     regions produce IDENTICAL wall-clock label sequences.
 *  3. The frame fix: over the gap-inclusive axis, timeToLogical maps every
 *     compact bar to its TRUE LWC slot (i + 3*boundaries) and back — the
 *     compact array maps it to the pre-boundary index (the documented
 *     round-87 bug the engine used to carry too).
 *  4. Rounds 86–89 invariants untouched: insertDayGaps count (3/boundary),
 *     stitchBars day clip, sessionRegionEnds.
 */
import {
  stitchBars, insertDayGaps, sessionRegions, sessionRegionEnds,
  windowSec, inSessionWindow, DAY,
} from '../src/core/session-math.js';
import { timeToLogical, logicalToTime } from '../src/core/util.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? ' — ' + JSON.stringify(extra) : '')); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- fixture: M1, Mon 14 .. Sun 20 Sept 2026, 24h days ---------- */
const cal = (y, mo, d, h = 0, mi = 0) => Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 1000);
const DAY0 = cal(2026, 9, 14);                       // Monday
const bars = [];
let px = 2600;
for (let d = 0; d < 7; d++) {
  const dow = new Date((DAY0 + d * DAY) * 1000).getUTCDay();
  if (dow === 0 || dow === 6) continue;
  for (let s = 0; s < DAY; s += 60) {
    const stamp = DAY0 + d * DAY + s;
    px += Math.sin((stamp / 600) % 97) * 0.4;
    bars.push({ time: stamp, open: px, high: px + 0.5, low: px - 0.5, close: px, volume: 10 });
  }
}
const dFrom = DAY0 / DAY, dTo = (DAY0 + 4 * DAY) / DAY;   // Mon 14 .. Fri 18

const gapFlagsOf = (withGaps) => Uint8Array.from(withGaps, (r) => (Object.keys(r).length === 1 ? 1 : 0));

/* ---------- 1. sessionRegions basics (broker-stamps case) ---------- */
{
  const sh = (t) => 12600 - 10800;                   // Tehran(+3:30) on an EEST(+3) broker
  const compact = stitchBars(bars, 300, 3, 6, 30, 30, sh, dFrom, dTo);
  const { bars: withGaps, gaps } = insertDayGaps(compact, 3, sh);
  const times = withGaps.map((r) => r.time);
  const flags = gapFlagsOf(withGaps);

  const regions = sessionRegions(times, flags);
  ok('one region per wall day (Mon..Fri = 5)', regions.length === 5, regions);
  ok('every region is 36 M5 bars (03:30–06:30)', regions.every((r) => r.b - r.a + 1 === 36),
     regions.map((r) => r.b - r.a + 1));
  ok('regions are contiguous ascending, gaps between', (() => {
    for (let i = 1; i < regions.length; i++) {
      if (regions[i].a !== regions[i - 1].b + 4) return false;   // 3 gap slots between
    }
    return regions[0].a === 0 && regions[regions.length - 1].b === times.length - 1;
  })(), regions);
  ok('gap flags count = 3 per boundary = 12', gaps === 12 && flags.reduce((a, b) => a + b, 0) === 12, gaps);
  ok('no gap flag inside any region', regions.every((r) => {
    for (let i = r.a; i <= r.b; i++) if (flags[i]) return false;
    return true;
  }));

  /* legacy arrays: no flags -> the whole axis is one region */
  ok('null gapFlags -> single region', eq(sessionRegions(times, null), [{ a: 0, b: times.length - 1 }]));
  ok('empty times -> []', eq(sessionRegions([], null), []));
}

/* ---------- 2. per-region ticks: only selected times, identical per day ---------- */
{
  const sh = (t) => 12600 - 10800;
  const compact = stitchBars(bars, 300, 3, 6, 30, 30, sh, dFrom, dTo);
  const { bars: withGaps } = insertDayGaps(compact, 3, sh);
  const times = withGaps.map((r) => r.time);
  const regions = sessionRegions(times, gapFlagsOf(withGaps));

  const N = 3;                                       // the engine's cadence for ~20px M5 bars
  const seqs = regions.map((r) => {
    const out = [];
    for (let j = r.a; j <= r.b; j += N) out.push(times[j]);
    return out;
  });
  ok('every region tick is INSIDE the selected window (wall frame)',
     seqs.every((seq) => seq.every((t) => inSessionWindow(t, 3, 6, 30, 30, sh))), seqs[0]);
  ok('first tick of every region = the window start 03:30',
     seqs.every((seq, i) => {
       const w = seq[0] + sh(seq[0]);
       return (w % DAY) === (3 * 3600 + 30 * 60) && seq[0] === times[regions[i].a];
     }));
  ok('identical wall-label sequence under every region (the axis reads the same each day)',
     (() => {
       const wall = (t) => t + sh(t) - dayStart(t + sh(t));
       function dayStart(x) { return Math.floor(x / DAY) * DAY; }
       return seqs.every((seq) => seq.map(wall).every((v, k) => Math.abs(v - seqs[0].map(wall)[k]) < 1));
     })(), seqs.map((s) => s.length));
  ok('no tick ever lands on a gap slot',
     seqs.flat().every((t) => {
       const idx = times.indexOf(t);
       return idx >= 0 && !gapFlagsOf(withGaps)[idx];
     }));
}

/* ---------- 3. the frame fix: gap-inclusive timeToLogical round trip ---------- */
{
  const sh = (t) => 12600 - 10800;
  const compact = stitchBars(bars, 300, 300, 0, 0, 0, sh, dFrom, dTo);   // M5 window 05:00-05:00? no — use 3-6:30
  const c2 = stitchBars(bars, 300, 3, 6, 30, 30, sh, dFrom, dTo);
  void compact;
  const { bars: withGaps } = insertDayGaps(c2, 3, sh);
  const times = withGaps.map((r) => r.time);
  const flags = gapFlagsOf(withGaps);
  const regions = sessionRegions(times, flags);

  /* slot of compact bar i in the gap frame: walk the regions and count */
  let wrongSlot = 0, wrongRound = 0, checked = 0;
  let ci = 0;
  for (const r of regions) {
    for (let s = r.a; s <= r.b; s++, ci++) {
      checked++;
      if (Math.round(timeToLogical(times, c2[ci].time)) !== s) wrongSlot++;
      if (Math.round(logicalToTime(times, s)) !== c2[ci].time) wrongRound++;
    }
  }
  ok('every stitched bar walked exactly once', checked === c2.length, [checked, c2.length]);
  ok('timeToLogical over the GAP axis hits every bar\'s true slot', wrongSlot === 0, wrongSlot);
  ok('logicalToTime round-trips every slot back to the bar', wrongRound === 0, wrongRound);
  /* the compact array does NOT — that was the engine's pre-ROUND90 frame bug */
  const afterBoundary = regions[1].a - 3;            // first bar of day 2 in COMPACT terms
  ok('compact frame shifts day-2 slots left (the documented old behaviour)',
     Math.round(timeToLogical(c2.map((b) => b.time), c2[afterBoundary].time)) === afterBoundary &&
     afterBoundary !== timeToLogical(times, c2[afterBoundary].time));
}

/* ---------- 4. midnight-straddling stamps stay ONE region ---------- */
{
  /* broker UTC-2 (srv = -7200): Tehran wall 03:30–06:30 maps to stamps
     22:00..01:00 — the region CROSSES broker midnight */
  const srv = -7200;
  const sh = (t) => 12600 - srv;
  const compact = stitchBars(bars, 300, 3, 6, 30, 30, sh, dFrom, dTo);
  ok('straddle: 5 stitched regions still', (() => {
    const days = new Set(compact.map((b) => Math.floor((b.time + sh(b.time)) / DAY)));
    return days.size === 5;
  })());
  const { bars: withGaps } = insertDayGaps(compact, 3, sh);
  const times = withGaps.map((r) => r.time);
  const regions = sessionRegions(times, gapFlagsOf(withGaps));
  ok('straddle: sessionRegions = 5 (no mid-region split at broker midnight)',
     regions.length === 5, regions);
  /* the fixture has no Sunday stamps, so Monday's region starts at wall 05:30
     (data hole, not a split) — every LATER region must cross broker midnight */
  ok('straddle: regions 2..5 each cross the broker midnight (wall day spans two stamp days)',
     regions.slice(1).every((r) => {
       const d1 = Math.floor(times[r.a] / DAY), d2 = Math.floor(times[r.b] / DAY);
       return d2 === d1 + 1;
     }), regions.map((r) => [Math.floor(times[r.a] / DAY), Math.floor(times[r.b] / DAY)]));
  const N = 3;
  const inWin = regions.every((r) => {
    for (let j = r.a; j <= r.b; j += N) {
      if (!inSessionWindow(times[j], 3, 6, 30, 30, sh)) return false;
    }
    return true;
  });
  ok('straddle: per-region ticks still all in-window', inWin);
}

/* ---------- 5. rounds 86–89 invariants unchanged ---------- */
{
  const sh = (t) => 12600 - 10800;
  const compact = stitchBars(bars, 300, 3, 6, 30, 30, sh, dFrom, dTo);
  ok('stitchBars clip: 5 days exactly (round-89)', (() => {
    const days = new Set(compact.map((b) => Math.floor((b.time + sh(b.time)) / DAY)));
    return days.size === 5 && Math.max(...days) === dTo;
  })());
  ok('windowSec minutes algebra untouched (round-87)',
     windowSec(3, 6, 30, 30).sFrom === 3 * 3600 + 1800 && windowSec(3, 6, 30, 30).sTo === 6 * 3600 + 1800 &&
     windowSec(3, 6).sTo === 6 * 3600);
  const ends = sessionRegionEnds(compact.map((b) => b.time), 300, 6, 30, sh);
  ok('sessionRegionEnds: 5 entries, each = min(day window end, last bar + tf)', (() => {
    if (ends.size !== 5) return false;
    const lastOf = new Map();
    for (const b of compact) {
      const d = Math.floor((b.time + sh(b.time)) / DAY) * DAY;   // day START in seconds (the map's key unit)
      lastOf.set(d, b.time);
    }
    for (const [day, end] of ends) {
      const endW = day + 6 * 3600 + 1800;
      const endS = sh ? endW - sh(endW) : endW;
      if (end !== Math.min(endS, lastOf.get(day) + 300)) return false;
    }
    return true;
  })(), [...ends.entries()]);
}

console.log(`\nround90 math: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
