/**
 * test_round149_arrow_size.mjs — ROUND149 plotarrow minheight/maxheight
 *
 * Run: node tests/unit/test_round149_arrow_size.mjs
 *
 * Value-proportional arrow height: |v| maps linearly across the series'
 * own full-run [min, max] onto [minheight, maxheight] px (house rule —
 * TV's normalization scope is undocumented; see src/core/pine/arrow.js).
 * Absent params keep the ROUND148 fixed Style-size path.
 */

import { compile } from '../../src/core/pine/compile.js';
import { remapOut } from '../../src/core/pine/mtf.js';
import { arrowHeight, magRange } from '../../src/core/pine/arrow.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

/* pure scaling math (the exact function the adapter calls per bar) */
ok(arrowHeight(7, null, null, 0, 10, 12) === 12, 'both params absent -> Style size fallback');
ok(arrowHeight(0, 5, 20, 0, 10, 12) === 5, 'series min -> minheight');
ok(arrowHeight(10, 5, 20, 0, 10, 12) === 20, 'series max -> maxheight');
ok(arrowHeight(5, 5, 20, 0, 10, 12) === 12.5, 'midpoint maps linearly');
ok(arrowHeight(99, 5, 20, 0, 10, 12) === 20, 'above range clamps to maxheight');
ok(arrowHeight(-3, 5, 20, 0, 10, 12) === 5, 'below range clamps to minheight');
ok(arrowHeight(7, 5, 20, 4, 4, 12) === 20, 'flat series pins to maxheight');
ok(arrowHeight(null, 5, 20, 0, 10, 12) === 12, 'null magnitude -> fallback');
ok(arrowHeight(5, null, 20, 0, 10, 12) === 10, 'missing lo defaults to 0 (5/10*20)');
ok(arrowHeight(9, 6, null, 0, 10, 8) === 6 + 0.9 * (16 - 6), 'missing hi defaults to max(lo+1, 2*fallback)');
ok(JSON.stringify(magRange([null, 3, null, 9, 1])) === '[1,9]', 'magRange skips nulls');
ok(magRange([null, null]) === null, 'magRange empty -> null');

/* engine stores bounds + per-bar magnitudes */
function makeBars() {
  const bars = [];
  const t0 = 1790600400 - (1790600400 % 900);
  let px = 100;
  for (let i = 0; i < 20; i++) {
    const o = px, cl = o + (i % 2 === 0 ? 0.5 + i * 0.2 : -(0.5 + i * 0.2));
    bars.push({ time: t0 + i * 900, open: o, high: Math.max(o, cl) + 0.3,
      low: Math.min(o, cl) - 0.3, close: cl, volume: 10 });
    px = cl;
  }
  return bars;
}
{
  const src = '//@version=6\nindicator("a", overlay=true)\n'
    + 'plotarrow(close - open, title="S", minheight=5, maxheight=20)';
  const c = compile(src);
  ok(c.ok, 'named minheight/maxheight compiles');
  const bars = makeBars();
  const rt = c.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 0 });
  rt.runAll(bars);
  const sh = [...rt.out.shapes.values()][0];
  ok(sh.minH === 5 && sh.maxH === 20, 'bounds stored on the site (got ' + sh.minH + '/' + sh.maxH + ')');
  let magsOk = sh.mags.length === bars.length;
  for (let i = 0; i < bars.length && magsOk; i++) {
    if (Math.abs(sh.mags[i] - Math.abs(bars[i].close - bars[i].open)) > 1e-9) magsOk = false;
  }
  ok(magsOk, 'mags[] is per-bar |v|');
  /* taller |v| -> taller arrow through the real adapter function */
  const rng = magRange(sh.mags);
  const h0 = arrowHeight(sh.mags[0], sh.minH, sh.maxH, rng[0], rng[1], 10);
  const hLast = arrowHeight(sh.mags[sh.mags.length - 1], sh.minH, sh.maxH, rng[0], rng[1], 10);
  ok(hLast > h0 && h0 >= 5 && hLast <= 20, 'height grows with magnitude within bounds (' + h0.toFixed(2) + ' -> ' + hLast.toFixed(2) + ')');
  /* MTF remap carries mags */
  const view = remapOut(rt.out, bars.map((_, i) => i), bars.length);
  const vsh = [...view.shapes.values()][0];
  ok(vsh.mags.length === bars.length && vsh.mags.every((m, i) => m === sh.mags[i]), 'remapOut preserves mags');
}
{
  /* positional form: plotarrow(series, title, colorup, colordown, offset, minheight, maxheight) */
  const src = '//@version=6\nindicator("b", overlay=true)\n'
    + 'plotarrow(close - open, "P", color.green, color.red, 0, 4, 18)';
  const c = compile(src);
  ok(c.ok, 'positional minheight/maxheight compiles');
  const bars = makeBars();
  const rt = c.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 0 });
  rt.runAll(bars);
  const sh = [...rt.out.shapes.values()][0];
  ok(sh.minH === 4 && sh.maxH === 18, 'positional bounds stored (got ' + sh.minH + '/' + sh.maxH + ')');
}

console.log('\nROUND149: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
