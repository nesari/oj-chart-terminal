/**
 * test_round180_chart.mjs — ROUND180 chart redesign + full trade list.
 *
 * (a) broker qty tape: per-bar signed contracts (position strip source).
 * (b) paginate: newest-first pages over the FULL list (the old slice(-200)
 *     hid trades 1..N-200 — the user's missing-rows report).
 *
 * Run: node tests/unit/test_round180_chart.mjs
 */

import { compile } from '../../src/core/pine/compile.js';
import { paginate } from '../../src/core/pine/stdlib/strategy.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function bars(n) {
  const t0 = 1790600400 - (1790600400 % 900);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 100 + i;
    out.push({ time: t0 + i * 900, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 });
  }
  return out;
}

/* --- qty tape --- */
{
  const c = compile(`//@version=5
strategy("q", overlay=true)
if bar_index == 10
    strategy.entry("L", strategy.long)
if bar_index == 15
    strategy.entry("S", strategy.short)
if bar_index == 20
    strategy.close("X")
plot(strategy.position_size, title="p")`);
  ok(c.ok, 'qty-tape script compiles');
  const rt = c.createInstance({ tfSec: 900, symbol: 'T', mintick: 1 });
  rt.runAll(bars(30));
  const tape = rt.broker.qtyTape || [];
  ok(tape.length >= 30, 'tape covers all bars (got ' + tape.length + ')');
  ok(tape[5] === 0, 'flat before entry (got ' + tape[5] + ')');
  ok(tape[12] === 1, 'long after long fill (got ' + tape[12] + ')');
  ok(tape[17] === -1, 'short after reversal (got ' + tape[17] + ')');
  ok(tape[25] === 0, 'flat after close (got ' + tape[25] + ')');
}

/* --- paginate --- */
{
  const p = paginate(384, 0, 100);
  ok(p.pages === 4 && p.start === 0 && p.end === 100 && p.count === 384, '384 rows -> 4 pages, page 0 = 0..100');
  const p4 = paginate(384, 3, 100);
  ok(p4.start === 300 && p4.end === 384, 'last page 300..384 (old rows visible again)');
  const over = paginate(50, 9, 100);
  ok(over.page === 0 && over.pages === 1, 'page clamps to range');
  const neg = paginate(50, -3, 100);
  ok(neg.page === 0, 'negative page clamps to 0');
  const empty = paginate(0, 0, 100);
  ok(empty.pages === 1 && empty.count === 0, 'empty list is one empty page');
  const exact = paginate(200, 1, 100);
  ok(exact.pages === 2 && exact.start === 100 && exact.end === 200, 'exact multiple splits cleanly');
}

console.log('\nROUND180: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
