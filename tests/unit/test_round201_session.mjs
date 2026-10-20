/**
 * test_round201_session.mjs — ROUND201 session.* namespace (TV parity).
 *
 * Spec parsing (ranges/days/overnight, loud invalids) + ismarket/ispremarket/
 * ispostmarket against UTC-anchored moments (incl. a DST-boundary week).
 *
 * Run: node tests/unit/test_round201_session.mjs
 */

import { compile } from '../../src/core/pine/compile.js';
import { parseSession } from '../../src/core/pine/stdlib/session.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const ONE = [{ time: 1790600400, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
function runIt(body) {
  const c = compile('//@version=5\nindicator("T", overlay=true)\n' + body);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance({ tfSec: 60, symbol: 'X', mintick: 1 });
    rt.runAll(ONE);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
function val(r, idx) {
  if (r.error) return undefined;
  const key = r.rt.out.plotsOrder[idx || 0];
  return r.rt.out.plots.get(key).values[0];
}
/* Wednesday Oct 7 2026 anchors (EDT = UTC-4, CEST = UTC+2) */
const T = (h, m) => Date.UTC(2026, 9, 7, h, m || 0);
const SAT = (h) => Date.UTC(2026, 9, 10, h, 0); // Saturday
const q = (fn, ms, spec, tz, title) => `plot((${fn}(${ms}, "${spec}"${tz ? `, "${tz}"` : ''}) ? 1 : 0), title="${title}")`;

/* spec parsing */
{
  const s = parseSession('0930-1600:23456');
  ok(s.ranges.length === 1 && s.ranges[0].s === 570 && s.ranges[0].e === 960, 'single range parses to minutes');
  ok(s.days.has(2) && !s.days.has(1) && s.days.size === 5, 'days 23456 = Mon..Fri');
  const s2 = parseSession('2000-0800');
  ok(s2.ranges[0].s === 1200 && s2.ranges[0].e === 480 && s2.days.size === 7, 'overnight + default all-days');
  for (const [bad, why] of [['', 'empty'], ['0930', 'no dash'], ['1600-0930x', 'garbage'], ['2500-2600', 'bad hour'],
      ['0930-0930', 'start==end'], ['0930-1600:28', 'bad day'], ['0930-1600:', 'empty days']]) {
    let threw = false;
    try { parseSession(bad); } catch (e) { threw = true; }
    ok(threw, `invalid spec loud ('${bad}' — ${why})`);
  }
}
/* ismarket / pre / post on NYSE hours */
{
  const NY = '0930-1600:23456', TZ = 'America/New_York';
  const r = runIt(q('session.ismarket', T(14), NY, TZ, 'a')
    + q('session.ismarket', T(12), NY, TZ, 'b')
    + q('session.ismarket', T(20), NY, TZ, 'c')
    + q('session.ismarket', SAT(14), NY, TZ, 'd')
    + q('session.ispremarket', T(12), NY, TZ, 'e')
    + q('session.ispremarket', T(14), NY, TZ, 'f')
    + q('session.ispostmarket', T(21), NY, TZ, 'g')
    + q('session.ispostmarket', T(20), NY, TZ, 'h')
    + q('session.ispostmarket', T(14), NY, TZ, 'i'));
  ok(!r.error, 'NYSE probes run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(val(r, 0) === 1, '10:00 ET in market');
    ok(val(r, 1) === 0, '08:00 ET out');
    ok(val(r, 2) === 0, '16:00 ET out ([start, end))');
    ok(val(r, 3) === 0, 'Saturday out (days filter)');
    ok(val(r, 4) === 1, '08:00 premarket');
    ok(val(r, 5) === 0, '10:00 not premarket');
    ok(val(r, 6) === 1, '17:00 postmarket');
    ok(val(r, 7) === 1, '16:00 postmarket (>= end)');
    ok(val(r, 8) === 0, '10:00 not postmarket');
  }
}
/* overnight + lunch gap + DST week (Berlin, Oct 2026 = CEST) */
{
  const r = runIt(q('session.ismarket', Date.UTC(2026, 9, 8, 1), '2000-0800', 'America/New_York', 'a')
    + q('session.ismarket', Date.UTC(2026, 9, 8, 10), '2000-0800', 'America/New_York', 'b')
    + q('session.ismarket', T(16), '2000-0800', 'America/New_York', 'c')
    + q('session.ismarket', T(16, 30), '0930-1200,1300-1600', 'America/New_York', 'd')
    + q('session.ispostmarket', T(16, 30), '0930-1200,1300-1600', 'America/New_York', 'e')
    + q('session.ismarket', Date.UTC(2026, 9, 7, 7, 30), '0900-1000', 'Europe/Berlin', 'f')
    + q('session.ismarket', Date.UTC(2026, 9, 7, 8, 30), '0900-1000', 'Europe/Berlin', 'g'));
  ok(!r.error, 'overnight probes run' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(val(r, 0) === 1, '21:00 ET in overnight (evening leg)');
    ok(val(r, 1) === 1, '06:00 ET next day in overnight (morning tail)');
    ok(val(r, 2) === 0, '12:00 ET out of overnight');
    ok(val(r, 3) === 0, '12:30 ET lunch gap out');
    ok(val(r, 4) === 0, '12:30 ET neither pre (>= first start) nor post (< last end)');
    ok(val(r, 5) === 1, '09:30 CEST in Berlin session (DST-aware)');
    ok(val(r, 6) === 0, '10:30 CEST out');
  }
}
/* na + missing-spec loudness */
{
  const r = runIt('plot(session.ismarket(na, "0930-1600", "GMT"), title="a")\n');
  ok(!r.error && val(r, 0) == null, 'na time -> na');
  const r2 = runIt('plot(session.ismarket(1, "nope", "GMT"), title="a")\n');
  ok(!!r2.error && /bad session/.test(r2.error), 'bad spec loud at runtime');
  const r3 = runIt('plot(session.nope(1, "0930-1600", "GMT"), title="a")\n');
  ok(!!r3.error && /Unknown function session\.nope/.test(r3.error), 'unknown session fn loud');
}

console.log('\nROUND201: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
