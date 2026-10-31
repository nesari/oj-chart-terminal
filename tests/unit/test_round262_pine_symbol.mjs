/**
 * ROUND262 - Pine instance follow a chart SYMBOL switch.
 *
 * The runtime bakes env.symbol at construction (syminfo.ticker/tickerid,
 * request.security's default symbol, currency/tick math). recomputePine()
 * rebuilt on a TF change but not on a symbol change: after switching
 * EURUSD -> XAUUSD the script kept the OLD env.symbol, and when the new
 * history happened to have the same bar count within the 1.5s freshness
 * window it skipped the run entirely.
 *
 * Pins:
 *  1. the runtime really reads its symbol from opts (the value that would
 *     go stale), so the rebuild is the only correct recovery;
 *  2. the instance state records the symbol it was built for;
 *  3. recomputePine checks that symbol BEFORE the "fresh skip" fast path.
 *
 * Run: node tests/unit/test_round262_pine_symbol.mjs
 */
import { compile } from '../../src/core/pine/compile.js';
import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' - ' + JSON.stringify(extra) : '')); }
};

const SRC = '//@version=6\nindicator("sym", overlay=true)\nplot(1)\n';
const BARS = [
  { time: 1700000000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  { time: 1700000060, open: 2, high: 2, low: 2, close: 2, volume: 1 },
];

console.log('\n[1] runtime symbol is construction-time state');
{
  const c = compile(SRC);
  ok(c.ok, 'fixture compiles');
  const a = c.createInstance({ tfSec: 60, symbol: 'EURUSD', mintick: 0.00001 });
  const b = c.createInstance({ tfSec: 60, symbol: 'XAUUSD', mintick: 0.01 });
  a.runAll(BARS); b.runAll(BARS);
  ok(a.env.symbol === 'EURUSD' && b.env.symbol === 'XAUUSD', 'two instances keep their own env.symbol',
    [a.env.symbol, b.env.symbol]);
  /* the symbol is read live from env by syminfo.* (expressions.js), so a
     stale env is a wrong script, not a cosmetic label */
  const syminfo = readSource('src/core/pine/interpreter/expressions.js');
  ok(syminfo.includes("case 'ticker': case 'tickerid': return env.symbol;"),
    'syminfo.ticker/tickerid read env.symbol at execution time');
}

console.log('\n[2] instance state remembers the build symbol');
{
  const panel = readSource('src/renderer/js/chart/pine-ui/panel.js');
  ok(panel.includes('symbol: pane.symbol,'), 'rebuild() records st.symbol');
  ok(panel.includes("else if (st.symbol !== pane.symbol) { rebuild(pane, inst); }"),
    'recomputePine() rebuilds on a symbol change');
  const iSym = panel.indexOf('st.symbol !== pane.symbol');
  const iFresh = panel.indexOf('const fresh = st.lastRunAt');
  ok(iSym > 0 && iFresh > 0 && iSym < iFresh,
    'symbol check precedes the freshness fast path (a same-length reload cannot skip the rebuild)',
    { iSym, iFresh });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
