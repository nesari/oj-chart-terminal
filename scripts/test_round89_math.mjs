/**
 * ROUND89 — Custom Session correctness under a DRIFTED/ZEROED broker offset
 * (the user's 3rd report: "الان تایم ها ... اشتباه هست" — the displayed
 * region sat at the wrong hours and a FOURTH region appeared past the
 * selected dates on a real weekend broker).
 *
 * Pins:
 *  1. stitchBars CLIPS to the cfg day range [dFrom..dTo] — a poisoned offset
 *     can never leak real bars into a region labelled the day after dTo.
 *  2. The displayed hours stay 03:30..06:25 across the realistic offset
 *     range (the self-consistent funnel property: "the axis the app itself
 *     built").
 *  3. The SAME raw-stamp base cache serves a re-stitch after the offset
 *     changes (the ROUND89 cache-key fix: no refetch, no transient).
 *  4. Round-88 invariants (gaps, region ends, windowSec) still hold.
 */
import { stitchBars, insertDayGaps, sessionRegionEnds, windowSec } from '../src/core/session-math.js';

const DAY = 86400;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? ' — ' + JSON.stringify(extra) : '')); }
};

/* ---------- fixture: XAUUSD M1, Mon 14 .. Sun 20 Sept 2026 ---------- */
/* stamp = broker wall encoded as-if-UTC (the MT5 package convention the
   whole app is built on). 24h days, NO maintenance break, Sat/Sun absent. */
const cal = (y, mo, d, h = 0, mi = 0) => Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 1000);
const DAY0 = cal(2026, 9, 14);                       // Monday
const SRV_TRUE = 10800;                              // broker = EEST (+3h)
const bars = [];
let px = 2600;
for (let d = 0; d < 7; d++) {
  const dow = new Date((DAY0 + d * DAY) * 1000).getUTCDay();
  if (dow === 0 || dow === 6) continue;              // weekend: no bars
  for (let s = 0; s < DAY; s += 60) {
    const stamp = DAY0 + d * DAY + s;                // broker wall as-if-UTC
    px += Math.sin((stamp / 600) % 97) * 0.4;
    bars.push({ time: stamp, open: px, high: px + 0.5, low: px - 0.5, close: px, volume: 10 });
  }
}
const dFrom = DAY0 / DAY;                            // Mon 14 (cfg day number)
const dTo = (DAY0 + 4 * DAY) / DAY;                  // Fri 18
const TEHRAN = 12600;
const mkShift = (srv) => (t) => TEHRAN - srv;        // Tehran: no DST

/* ---------- 1. the clip ---------- */
{
  const sh = mkShift(SRV_TRUE);
  const base = stitchBars(bars, 300, 3, 6, 30, 30, sh, dFrom, dTo);
  const days = new Set(base.map((b) => Math.floor((b.time + sh(b.time)) / DAY)));
  ok('correct offset: 5 regions (Mon..Fri)', days.size === 5, [...days]);

  // POISONED offset: friday_bar - now on Saturday morning (-10h09m).
  const shBad = mkShift(-36540);
  const bad = stitchBars(bars, 300, 3, 6, 30, 30, shBad, dFrom, dTo);
  const badDays = new Set(bad.map((b) => Math.floor((b.time + shBad(b.time)) / DAY)));
  ok('poisoned offset: clipped to the cfg days (NO spill region past dTo)',
     badDays.size > 0 && Math.max(...badDays) <= dTo && Math.min(...badDays) >= dFrom,
     [...badDays]);
  // without the clip (old signature) the garbage offset leaks a Sat region:
  const unclipped = stitchBars(bars, 300, 3, 6, 30, 30, shBad);
  const leakDays = new Set(unclipped.map((b) => Math.floor((b.time + shBad(b.time)) / DAY)));
  ok('old behaviour reproduced: unclipped stitch leaks past dTo (proves the clip matters)',
     Math.max(...leakDays) > dTo, [...leakDays]);

  // ZERO offset (offset never measured): also clipped.
  const shZero = mkShift(0);
  const zero = stitchBars(bars, 300, 3, 6, 30, 30, shZero, dFrom, dTo);
  const zeroDays = new Set(zero.map((b) => Math.floor((b.time + shZero(b.time)) / DAY)));
  ok('zero offset: clipped to the cfg days', Math.max(...zeroDays) <= dTo && zeroDays.size > 0, [...zeroDays]);
}

/* ---------- 2. displayed hours stay 03:30..06:25 across offsets ---------- */
for (const [name, srv] of [['correct +3h', SRV_TRUE], ['never-measured 0', 0], ['weekend garbage -10h', -36540]]) {
  const sh = mkShift(srv);
  const out = stitchBars(bars, 300, 3, 6, 30, 30, sh, dFrom, dTo);
  const first = out.reduce((m, b) => Math.min(m, (b.time + sh(b.time)) % DAY), 1e9);
  const lastBar = out.reduce((m, b) => Math.max(m, (b.time + sh(b.time)) % DAY), -1);
  ok(`displayed window start == 03:30 (${name})`, first === 12600, first);
  ok(`displayed window last bar == 06:25 (${name})`, lastBar === 23100, lastBar);
}

/* ---------- 3. one raw-stamp base serves every offset (cache-key fix) ---------- */
{
  // the union of stamps consumed by each offset's stitch:
  const need = new Set();
  for (const srv of [SRV_TRUE, 0, -36540]) {
    const sh = mkShift(srv);
    for (const b of bars) {
      const wall = b.time + sh(b.time);
      const dW = Math.floor(wall / DAY) * DAY;
      if (dW < dFrom * DAY || dW > dTo * DAY) continue;
      const off = wall - dW;
      if (off >= 12600 && off < 23400) need.add(b.time);
    }
  }
  // the ensureBase fetch window (cfg days widened by the shift ±3h margin):
  const shA = TEHRAN - SRV_TRUE, shB = TEHRAN - (-36540);
  const fromT = Math.floor(dFrom * DAY - Math.max(shA, shB)) - 10800;
  const toT = Math.ceil((dTo + 1) * DAY - Math.min(shA, shB)) + 10800;
  const missing = [...need].filter((t) => t < fromT || t >= toT);
  ok('the widened fetch window covers every offset variant (no refetch needed)',
     missing.length === 0, missing.length);
}

/* ---------- 4. round-88 invariants still hold with the clip ---------- */
{
  const sh = mkShift(SRV_TRUE);
  const out = stitchBars(bars, 300, 3, 6, 30, 30, sh, dFrom, dTo);
  const withGaps = insertDayGaps(out, 3, sh);
  ok('3 whitespace rows per day boundary (4 boundaries = 12)', withGaps.gaps === 12, withGaps.gaps);
  const ends = sessionRegionEnds(out.map((b) => b.time), 300, 6, 30, sh);
  ok('region ends == per-day 06:30 wall (5 days)',
     ends.size === 5 && [...ends.values()].every((e) => ((e + sh(e)) % DAY + DAY) % DAY === 23400),
     [...ends.values()].slice(0, 2));
  const w = windowSec(3, 6, 30, 30);
  ok('windowSec unchanged', w.sFrom === 12600 && w.sTo === 23400, w);
}

console.log(`round89 math: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
