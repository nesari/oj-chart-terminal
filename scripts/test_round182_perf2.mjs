/**
 * test_round182_perf2.mjs — ROUND182 chart extras (pure helpers).
 *
 * excursionSpikes: one green/red spike per closed trade at its exit.
 * runupDrawdown: run-up (value minus running trough) + drawdown
 * (value minus running peak) over a relative-PnL series.
 *
 * Run: node scripts/test_round182_perf2.mjs
 */

import { excursionSpikes, runupDrawdown } from '../src/core/pine/stdlib/strategy.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

/* --- excursionSpikes --- */
{
  const sp = excursionSpikes([
    { exitTime: 3000, mfe: 5, mae: -2 },
    { exitTime: 1000, mfe: 0, mae: 0 },
    { exitTime: 2000, mfe: 3, mae: 0 },
    { exitTime: null, mfe: 9, mae: -9 },
  ]);
  ok(sp.length === 2, 'skips flat and timeless trades (got ' + sp.length + ')');
  ok(sp[0].t === 2000 && sp[1].t === 3000, 'sorted by exit time');
  ok(sp[1].fav === 5 && sp[1].adv === -2, 'fav/adv carried through');
  ok(excursionSpikes([]).length === 0 && excursionSpikes(null).length === 0, 'empty-safe');
}

/* --- runupDrawdown --- */
{
  const rd = runupDrawdown([
    { t: 1, v: 0 }, { t: 2, v: 10 }, { t: 3, v: 4 }, { t: 4, v: 12 }, { t: 5, v: 7 },
  ]);
  ok(rd.length === 5, 'one row per point');
  ok(rd[1].ru === 10 && rd[1].dd === 0, 'peak bar: ru=10 dd=0 (got ' + rd[1].ru + '/' + rd[1].dd + ')');
  ok(rd[2].ru === 4 && rd[2].dd === -6, 'dip bar: ru=4 dd=-6 (got ' + rd[2].ru + '/' + rd[2].dd + ')');
  ok(rd[3].dd === 0 && rd[4].ru === 7, 'new peak resets drawdown (got dd=' + rd[3].dd + ' ru=' + rd[4].ru + ')');
  ok(rd.every((p) => p.ru >= 0 && p.dd <= 0), 'ru>=0 and dd<=0 everywhere');
  ok(runupDrawdown([{ t: 1, v: NaN }, null]).length === 0, 'na rows dropped');
}

console.log('\nROUND182: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
