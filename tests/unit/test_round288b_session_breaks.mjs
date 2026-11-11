/**
 * test_round288b_session_breaks.mjs — TV "Session breaks".
 *
 * TV draws a small gap between trading days. This app already had the whole
 * whitespace machinery (insertDayGaps + _sessWithGapTimes + _sessGapIdx, read
 * by the drawing engine, the Pine adapter and trade history) — but it was only
 * reachable inside Bar Replay / Custom Session. ROUND288 wires it into the
 * normal data path behind a Settings toggle.
 *
 * Pins:
 *  1. the setting exists with a true default and a dialog control
 *  2. the plain data path inserts the gap rows when the setting is on
 *  3. a single-day window degrades gracefully (no gaps, plain data)
 *  4. Custom Session still wins when it is active
 *  5. toggling the setting re-applies the series
 *
 * Run: node tests/unit/test_round288b_session_breaks.mjs
 */

import { insertDayGaps } from '../../src/core/session-math.js';
import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

/* ---------- 1. the setting + control ---------- */
{
  const st = readSource('src/renderer/js/chart/settings.js');
  ok(/sessionBreaks: true,/.test(st), 'sessionBreaks defaults to ON');
  ok(/rowCheckbox\('Session breaks', 'sessionBreaks'/.test(st), 'the Canvas tab has a Session breaks checkbox');
  ok(/if \(key === 'sessionBreaks'\)/.test(st), 'changing it triggers a series refresh');
}

/* ---------- 2. the data path ---------- */
{
  const data = readSource('src/renderer/js/chart/manager/data.js');
  ok(/function sessionBreaksRows\(pane, bars\)/.test(data), 'the data module owns a breaks builder');
  ok(/insertDayGaps/.test(data) && /session-math\.js/.test(data), 'it reuses the shared day-gap helper');
  ok(/_sessWithGapTimes = withGaps\.map/.test(data), 'the gap-inclusive axis is published for the painters');
  ok(/_sessGapIdx = gapIdx/.test(data), 'per-slot gap flags are published too');
  ok(/function breaksEnabled\(\)/.test(data), 'the setting is read through a helper');
  ok(/if \(!customSessionOn && breaksEnabled\(\)\)/.test(data),
    'the plain path applies breaks only when Custom Session is off');
  ok(/if \(sessionBreaksRows\(pane, bars\)\) return;/.test(data),
    'a successful break build skips the plain write');
}

/* ---------- 3. the gap geometry itself (real function) ---------- */
{
  const t0 = Math.floor(Date.UTC(2026, 0, 5, 0, 0, 0) / 1000); // Mon 00:00
  const bars = [];
  /* two full days of hourly bars: 48 bars, one boundary at index 24 */
  for (let i = 0; i < 48; i++) {
    bars.push({ time: t0 + i * 3600, open: 100, high: 101, low: 99, close: 100, volume: 1 });
  }
  const r = insertDayGaps(bars, 3, null);
  ok(r.bars.length === bars.length + 3, 'three whitespace slots are inserted at the day boundary',
    bars.length + '->' + r.bars.length);
  ok(r.gaps === 3, 'the gap count reflects the inserted whitespace rows', r.gaps);
  const gapRows = r.bars.filter((b) => Object.keys(b).length === 1);
  ok(gapRows.length === 3, 'the inserted rows are time-only (whitespace)', gapRows.length);
  ok(gapRows.every((b) => typeof b.time === 'number'), 'whitespace rows carry a time');
  /* the first gap slot lands right after the last bar of day one (index 24
     is the 24th hourly bar, i.e. the boundary) */
  const firstGap = r.bars.findIndex((b) => Object.keys(b).length === 1);
  ok(firstGap === 24, 'the gap lands right after the last bar of day one', firstGap);
  /* one day only -> nothing inserted */
  const single = insertDayGaps(bars.slice(0, 24), 3, null);
  ok(single.gaps === 0 && single.bars.length === 24, 'a single-day window inserts nothing');
  /* zero gap bars -> pass-through (the setting OFF path) */
  const off = insertDayGaps(bars, 0, null);
  ok(off.gaps === 0 && off.bars.length === bars.length, 'gapBars=0 is a pass-through');
}

/* ---------- 4. session.js exposes the refresh on the hook ---------- */
{
  const ses = readSource('src/renderer/js/panels/session.js');
  ok(/function refreshBreaks\(\)/.test(ses), 'session.js provides refreshBreaks()');
  ok(/refreshBreaks,/.test(ses), 'the App.sessionHook exposes it');
  ok(/SessionRange\.applyBreaks = applyBreaks/.test(ses), 'the facade exposes applyBreaks');
  ok(/SessionRange\.refreshBreaks = refreshBreaks/.test(ses), 'the facade exposes refreshBreaks');
  /* refresh must not fight the Custom Session mode */
  const body = (ses.match(/function refreshBreaks\(\)[\s\S]*?\n\}/) || [''])[0];
  ok(/if \(S\.on\)/.test(body), 'refresh defers to Custom Session when it is on');
  ok(/Manager\.setPaneData\(pane, pane\.bars\)/.test(body), 'refresh rebuilds through the normal data path');
}

/* ---------- 5. the break path never leaves a stale gap axis ---------- */
{
  const data = readSource('src/renderer/js/chart/manager/data.js');
  ok(/_sessWithGapTimes = null;\s*\n\s*pane\._sessGapIdx = null;/.test(data),
    'the plain path clears a previously-published gap axis');
  /* renko must not carry breaks */
  const renko = data.slice(data.indexOf("if (style === 'renko')"), data.indexOf("if (style === 'renko')") + 700);
  ok(/_sessWithGapTimes = null/.test(renko), 'renko explicitly clears the gap axis (no time axis to break)');
}

console.log('\nROUND288b: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
