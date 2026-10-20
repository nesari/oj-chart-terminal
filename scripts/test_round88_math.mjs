/* ROUND88 — Custom Session window in the CHART'S TIMEZONE (pure math).
 *
 * User report: "کاربر بر اساس تایم زونی که انتخاب کرده برای چارتش یک ساعتی
 * تا یک ساعتی رو توی بخش custom Session وارد میکنه و میخواد طبق همون تایم
 * زون چارتش این محدوده ساعت ها نمایش داده بشه" — the entered window must
 * select and display in the selected chart zone, not in the raw broker
 * stamps. These tests pin the shift algebra (wall = stamp + shift,
 * shift = zoneOffset(tz) − serverOff) end to end.
 *
 * Run: node scripts/test_round88_math.mjs
 */
import { copyFileSync, mkdirSync, rmSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, '.tmp-esm88');
mkdirSync(TMP, { recursive: true });
copyFileSync(join(HERE, '..', 'src', 'core', 'session-math.js'), join(TMP, 'session-math.mjs'));
const src = await import(join(TMP, 'session-math.mjs') /* file URL friendly below */).catch(async () => {
  execSync(`node -e "process.stdout.write('')"`);
  return import('file://' + join(TMP, 'session-math.mjs'));
});
const { DAY, stitchBars, insertDayGaps, sessionRegionEnds, inSessionWindow, sessionBucket } = src;

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label + (extra != null ? ' — ' + JSON.stringify(extra) : '')); }
};
const hhmm = (t) => {
  const off = ((t % DAY) + DAY) % DAY;
  return String(Math.floor(off / 3600)).padStart(2, '0') + ':' + String(Math.floor((off % 3600) / 60)).padStart(2, '0');
};
/* wall display exactly like the app axis: wall = stamp + shift */
const disp = (t, shift) => hhmm(t + (shift ? shift(t) : 0));

/* helper: M1 bars for one stamp-day range, minute steps */
function m1(from, to, step = 60) {
  const out = [];
  for (let t = from; t < to; t += step) {
    out.push({ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
  }
  return out;
}

console.log('\n[1] no shift (null) — round-86/87 byte-compat');
{
  // hour-aligned window 03:00–05:00 on stamps; tf=H1 -> buckets 03:00, 04:00
  const day0 = 1768435200 - (1768435200 % DAY); // an arbitrary stamp-day start
  const bars = m1(day0, day0 + DAY);
  const out = stitchBars(bars, 3600, 3, 5, 0, 0, null);
  ok(out.length === 2, 'H1 window 03:00–05:00 -> 2 candles/day', out.length);
  ok(hhmm(out[0].time) === '03:00' && hhmm(out[1].time) === '04:00', 'anchors stay day-start aligned', out.map(b => hhmm(b.time)));
  // minute window keeps old membership on stamps when shift=null
  const out2 = stitchBars(m1(day0, day0 + 3600 * 7), 300, 3, 6, 30, 30, null);
  ok(hhmm(out2[0].time) === '03:30' && out2.length === 36, '5m window 03:30–06:30 -> 36 candles from 03:30', out2.length && hhmm(out2[0].time));
}

console.log('\n[2] constant shift +1800 (zone Tehran +3:30 vs broker GMT+3)');
{
  const shift = () => 1800;
  const day0 = 1768435200 - (1768435200 % DAY);
  const bars = m1(day0, day0 + 2 * DAY);   // exactly two stamp-days
  // window 03:30–06:30 WALL: stamps [02:00, 05:00) of each stamp-day
  const out = stitchBars(bars, 300, 3, 6, 30, 30, shift);
  ok(out.length === 2 * 36, '2 days × 36 five-minute candles', out.length);
  ok(disp(out[0].time, shift) === '03:30', 'first candle DISPLAYS 03:30 in the chart zone', disp(out[0].time, shift));
  ok(out[0].time % 60 === 0, 'emitted stamps stay second-clean');
  const lastOfDay1 = out[35];
  ok(disp(lastOfDay1.time, shift) === '06:25', 'last candle of day 1 displays 06:25', disp(lastOfDay1.time, shift));
  // displayed hours never show broker hours 02:00/04:00 as the region start
  ok(disp(out[36].time, shift) === '03:30', 'day 2 region restarts at 03:30 displayed', disp(out[36].time, shift));
  // round-trip: emitted stamp + shift == the wall bucket the user asked for
  const wallBucket = day0 + 3 * 3600 + 1800 + 0; // 03:30 wall of day0
  ok(out.find(b => b.time + 1800 === wallBucket) != null, 'round trip wall→stamp→wall exact');
  // H1: window-anchored buckets 03:30 / 04:30 / 05:30 (3 candles)
  const h1 = stitchBars(bars, 3600, 3, 6, 30, 30, shift);
  ok(h1.length === 2 * 3, 'H1 -> 3 candles/day for a 3h window', h1.length);
  ok(disp(h1[0].time, shift) === '03:30' && disp(h1[1].time, shift) === '04:30' && disp(h1[2].time, shift) === '05:30',
    'H1 anchors at 03:30/04:30/05:30 displayed', [disp(h1[0].time, shift), disp(h1[1].time, shift), disp(h1[2].time, shift)]);
  // hour-aligned window + shift keeps the classic day-start buckets
  const h1b = stitchBars(bars, 3600, 3, 5, 0, 0, shift);
  ok(disp(h1b[0].time, shift) === '03:00' && disp(h1b[1].time, shift) === '04:00', 'window 03:00–05:00 H1 -> 03:00/04:00', h1b.map(b => disp(b.time, shift)));
}

console.log('\n[3] region ends + gaps under the shift');
{
  const shift = () => 1800;
  const day0 = 1768435200 - (1768435200 % DAY);
  const bars = m1(day0, day0 + 2 * DAY);
  const out = stitchBars(bars, 300, 3, 6, 30, 30, shift);
  const ends = sessionRegionEnds(out.map(b => b.time), 300, 6, 30, shift);
  const keys = Array.from(ends.keys());
  ok(ends.size === 2, 'one end per day region', ends.size);
  const end1 = ends.get(keys[0]);
  ok(end1 === Math.min(keys[0] + 23400 - 1800, out[35].time + 300), 'region end = min(wall window end, last bar + tf)', end1);
  ok(end1 - out[35].time === 300, 'end == last bar close (data cap wins)', end1 - out[35].time);
  // gaps: 3 whitespace rows between the two regions, none inside
  const g = insertDayGaps(out, 3, shift);
  ok(g.gaps === 3, '3 gap rows between day regions', g.gaps);
  ok(g.bars.length === out.length + 3, 'gap rows appended', g.bars.length - out.length);
  // straddle: window 00:30–01:30 wall with shift +3600 -> stamps cross stamp-midnight; still ONE segment
  const straddle = stitchBars(m1(day0 - 3600 * 2, day0 + 3 * 3600), 300, 0, 1, 30, 30, () => 3600);
  const gs = insertDayGaps(straddle, 3, () => 3600);
  ok(gs.gaps === 0, 'no mid-region gap when stamps straddle broker midnight (wall-day test)', gs.gaps);
}

console.log('\n[4] inSessionWindow / sessionBucket with shift');
{
  const shift = () => 1800;
  const t0 = 1768435200 - (1768435200 % DAY) + 10800; // stamp off 03:00 → wall 03:30 with shift +1800 (Tehran +3:30 over a GMT+3 broker)
  ok(inSessionWindow(t0, 3, 6, 30, 30, shift) === true, 'stamp at wall 03:30 inside [03:30,06:30)');
  ok(inSessionWindow(t0 - 60, 3, 6, 30, 30, shift) === false, 'stamp at wall 03:29 outside');
  ok(inSessionWindow(1768435200 - (1768435200 % DAY) + 12600, 3, 6, 30, 30, null) === true, 'null shift keeps stamp-frame membership');
  ok(sessionBucket(300, t0 + 1800, 12600) === t0 + 1800, 'window-anchored bucket snaps to the window start');
}

console.log('\n[5] REAL zone function (Intl) — Asia/Tehran, srv=0 and srv=10800');
{
  // Tehran is fixed +3:30 (no DST since 2022) — good constant check
  const mkShift = (tz, srv) => (t) => {
    let sh = offAt(tz, t) - srv;
    sh = offAt(tz, t + sh) - srv;
    return sh;
  };
  function offAt(tz, t) {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = {};
    for (const q of dtf.formatToParts(new Date(t * 1000))) p[q.type] = q.value;
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
    return Math.round((asUTC - t * 1000) / 60000) * 60;
  }
  const utcNoon = 1768435200; // 2026-01-15 00:00 UTC (winter)
  const shTehran0 = mkShift('Asia/Tehran', 0);
  ok(shTehran0(utcNoon) === 12600, 'Tehran shift = +3:30 with srv=0', shTehran0(utcNoon));
  const shTehran3 = mkShift('Asia/Tehran', 10800);
  ok(shTehran3(utcNoon) === 1800, 'Tehran shift = +0:30 over a GMT+3 broker', shTehran3(utcNoon));
  // Berlin DST: winter +1, summer +2
  const summer = Date.UTC(2026, 6, 15) / 1000;
  const shBerlin = mkShift('Europe/Berlin', 0);
  ok(offAt('Europe/Berlin', utcNoon) === 3600 && offAt('Europe/Berlin', summer) === 7200, 'Berlin offset winter/summer 1h/2h');
  ok(shBerlin(utcNoon) === 3600 && shBerlin(summer) === 7200, 'shift follows DST');
  // END-TO-END with the real Tehran shift: a GMT+3 broker, window 03:30–06:30 Tehran
  // stamps of the region = Tehran wall [03:30,06:30) → utc [00:00,03:00) → stamps (+3h) [03:00,06:00)
  const dayUTC = 1768435200 - (1768435200 % DAY);
  const bars = m1(dayUTC - DAY, dayUTC + 2 * DAY);
  const out = stitchBars(bars, 300, 3, 6, 30, 30, shTehran3);
  ok(out.length >= 36, 'region present for the real tz shift', out.length);
  const first = out.find(b => b.time >= dayUTC && b.time < dayUTC + DAY);
  ok(hhmm(first.time) === '03:00', 'first region stamp = 03:00 broker wall (= 03:30 Tehran)', hhmm(first.time));
  // and the DISPLAYED wall time (the axis funnel) is 03:30:
  ok(hhmm(first.time + shTehran3(first.time)) === '03:30', 'DISPLAYED 03:30 in Tehran', hhmm(first.time + shTehran3(first.time)));
}

console.log('\n[6] displayed label audit — what the user will READ on the axis');
{
  // the exact e2e assertion shape: every region's first bar label == 03:30, last+tf == 06:30
  const shift = () => 1800;
  const day0 = 1768435200 - (1768435200 % DAY);
  const out = stitchBars(m1(day0, day0 + 2 * DAY), 300, 3, 6, 30, 30, shift);
  const days = new Set();
  let okAll = true;
  for (const b of out) {
    const w = b.time + 1800;
    const d = Math.floor(w / DAY) * DAY;
    if (!days.has(d)) { days.add(d); okAll = okAll && hhmm(b.time + 1800) === '03:30'; }
  }
  ok(okAll && days.size === 2, 'every region starts at 03:30 in the chart zone', days.size);
}

rmSync(TMP, { recursive: true, force: true });
console.log(`\n== round88 math: ${pass} passed, ${fail} failed ==`);
process.exit(fail ? 1 : 0);
