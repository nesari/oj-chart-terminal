/**
 * test_round184_markers.mjs — ROUND184 chart trade markers (pure).
 *
 * tradeMarkers: Buy/Sell entry flags + gray exits, null ends skipped,
 * ascending time order, newest-1000-trades cap.
 *
 * Run: node scripts/test_round184_markers.mjs
 */

import { tradeMarkers } from '../src/core/pine/stdlib/strategy.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const T0 = 1700000000;
const timeOf = (i) => (typeof i === 'number' && i >= 0 && i < 50 ? T0 + i * 60 : null);

{
  const m = tradeMarkers([
    { dir: 1, entryBar: 10, exitBar: 20 },
    { dir: -1, entryBar: 30, exitBar: 40 },
  ], timeOf);
  ok(m.length === 4, 'two trades -> 4 markers (got ' + m.length + ')');
  ok(m[0].text === 'Buy' && m[0].shape === 'arrowUp' && m[0].position === 'belowBar', 'long entry flag');
  ok(m[1].text === 'Exit' && m[1].color === '#787B86', 'long exit gray');
  ok(m[2].text === 'Sell' && m[2].shape === 'arrowDown' && m[2].position === 'aboveBar', 'short entry flag');
  ok(m[3].text === 'Exit', 'short exit flag');
  ok(m.every((x, i, a) => i === 0 || a[i - 1].time <= x.time), 'ascending time order');
}
{
  const m = tradeMarkers([{ dir: 1, entryBar: 99, exitBar: 5 }], timeOf);
  ok(m.length === 0, 'null entry end skips the whole trade');
  const m2 = tradeMarkers([{ dir: 1, entryBar: 5, exitBar: 99 }], timeOf);
  ok(m2.length === 1 && m2[0].text === 'Buy', 'null exit keeps the entry flag');
}
{
  const many = [];
  for (let i = 0; i < 2500; i++) many.push({ dir: 1, entryBar: i % 50, exitBar: (i + 1) % 50 });
  const m = tradeMarkers(many, timeOf);
  ok(m.length === 2000, 'capped at 2000 markers (got ' + m.length + ')');
  ok(tradeMarkers([], timeOf).length === 0 && tradeMarkers(null, timeOf).length === 0, 'empty-safe');
  ok(tradeMarkers([{ dir: 1, entryBar: 1 }], null).length === 0, 'null timeOf is safe');
}

console.log('\nROUND184: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
