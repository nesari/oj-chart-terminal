/**
 * test_round184b_marks.mjs — ROUND184b marker paint fix + last_bar_index.
 *
 * (a) The flags never showed because pine-ui <-> manager form an import
 *     cycle: touching Manager at module top-level throws a TDZ
 *     ReferenceError, so the funnel registration silently never ran.
 *     Registration is lazy now (PineUI.initMarkers from Tester.init).
 *     Node side: the funnel contract (provider registered + merge calls
 *     setMarkers with trade flags) is pinned via tradeMarkers (round 184).
 * (b) env.lastBarIndex was never assigned (fell back to the current bar),
 *     so `bar_index == last_bar_index - N` never fired — no trades, no
 *     markers, no error.
 *
 * Run: node tests/unit/test_round184b_marks.mjs
 */

import { compile } from '../../src/core/pine/compile.js';
import { tradeMarkers } from '../../src/core/pine/stdlib/strategy.js';

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

/* --- last_bar_index resolves to the final bar --- */
{
  const c = compile(`//@version=5
strategy("t", overlay=true)
if bar_index == last_bar_index - 5
    strategy.entry("L", strategy.long)
plot(bar_index, title="b")`);
  ok(c.ok, 'last_bar_index script compiles');
  const rt = c.createInstance({ tfSec: 900, symbol: 'T', mintick: 1 });
  rt.runAll(bars(30));
  ok(rt.broker.trades.length === 0 && rt.broker.qty === 1, 'entry fires near the tail, position opens (qty ' + rt.broker.qty + ')');
  const c2 = compile(`//@version=5
indicator("li")
plot(last_bar_index, title="l")`);
  const rt2 = c2.createInstance({ tfSec: 900, symbol: 'T', mintick: 1 });
  rt2.runAll(bars(30));
  const vals = rt2.out.plots.get(rt2.out.plotsOrder[0]).values;
  ok(vals[29] === 29 && vals[0] === 29, 'last_bar_index == 29 on every bar (got [' + vals[0] + '..' + vals[29] + '])');
}

/* --- funnel contract: every closed trade yields Buy/Sell + Exit flags --- */
{
  const t0 = 1790600400;
  const timeOf = (i) => (typeof i === 'number' ? t0 + i * 60 : null);
  const m = tradeMarkers([
    { dir: 1, entryBar: 10, exitBar: 20 },
    { dir: -1, entryBar: 30, exitBar: 40 },
  ], timeOf);
  const texts = m.map((x) => x.text);
  ok(texts.filter((t) => t === 'Buy').length === 1, 'one Buy flag for the paint funnel');
  ok(texts.filter((t) => t === 'Sell').length === 1, 'one Sell flag for the paint funnel');
  ok(texts.filter((t) => t === 'Exit').length === 2, 'two Exit flags for the paint funnel');
}

console.log('\nROUND184b: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
