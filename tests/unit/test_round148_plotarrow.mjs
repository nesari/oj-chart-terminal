/**
 * test_round148_plotarrow.mjs — ROUND148 plotarrow parity (TV)
 *
 * Run: node tests/unit/test_round148_plotarrow.mjs
 *
 * plotarrow() never painted: the engine stored 'above'/'below' string
 * sentinels in ys (which the adapter skips) and null in colors, with one
 * site-level style for a site that mixes up+down arrows. Now it stores a
 * real bar anchor (up -> bar low, down -> bar high), a per-bar direction,
 * and the colorup/colordown colors — and MTF remap carries dirs.
 */

import { compile } from '../../src/core/pine/compile.js';
import { remapOut } from '../../src/core/pine/mtf.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

/* alternating up / down / doji bars so every branch fires */
function makeBars() {
  const bars = [];
  const t0 = 1790600400 - (1790600400 % 900);
  let px = 100;
  for (let i = 0; i < 30; i++) {
    const o = px;
    const cl = i % 3 === 2 ? o : o + (i % 3 === 0 ? 1.5 : -1.5);
    bars.push({ time: t0 + i * 900, open: o, high: Math.max(o, cl) + 0.4,
      low: Math.min(o, cl) - 0.4, close: cl, volume: 10 });
    px = cl;
  }
  return bars;
}

const SRC = '//@version=6\nindicator("arrows", overlay=true)\n'
  + 'v = close - open\n'
  + 'plotarrow(v, title="Sig", colorup=color.green, colordown=color.red)';

const bars = makeBars();
const c = compile(SRC);
ok(c.ok, 'plotarrow script compiles' + (c.ok ? '' : ' -> ' + JSON.stringify(c.errors)));
const rt = c.createInstance({ tfSec: 900, symbol: 'T', serverOffSec: 0 });
rt.runAll(bars);
const sites = [...rt.out.shapes.values()];
ok(sites.length === 1, 'exactly one arrow site (got ' + sites.length + ')');
const sh = sites[0];
ok(sh.isArrow === true, 'site flagged isArrow');
ok(sh.title === 'Sig', 'title stored for the Style-tab row (got ' + sh.title + ')');

let anchorOk = true, dirOk = true, colorOk = true, dojiOk = true, noSentinel = true;
for (let i = 0; i < bars.length; i++) {
  const y = sh.ys[i];
  if (y === 'above' || y === 'below') { noSentinel = false; continue; }
  const doji = bars[i].close === bars[i].open;
  if (doji) {
    if (y != null || sh.dirs[i] != null) dojiOk = false;
    continue;
  }
  const up = bars[i].close > bars[i].open;
  if (typeof y !== 'number' || !isFinite(y)) { anchorOk = false; continue; }
  if (Math.abs(y - (up ? bars[i].low : bars[i].high)) > 1e-9) anchorOk = false;
  if (sh.dirs[i] !== (up ? 'up' : 'down')) dirOk = false;
  const col = sh.colors[i];
  const css = col && col.css ? col.css() : '';
  const want = up ? '76,175,80' : '242,54,69'; // color.green / color.red
  if (!css.includes(want)) colorOk = false;
}
ok(noSentinel, 'no above/below sentinels in ys');
ok(anchorOk, 'anchors are bar low (up) / bar high (down)');
ok(dirOk, 'per-bar direction matches the series sign');
ok(colorOk, 'colorup on up bars, colordown on down bars');
ok(dojiOk, 'zero series -> no marker (na-safe)');

/* MTF remap carries the per-bar direction with its marker */
{
  const n = bars.length;
  const map = bars.map((_, i) => i); // identity: one bucket per bar
  const view = remapOut(rt.out, map, n);
  const vsh = [...view.shapes.values()][0];
  let dirsOk = vsh && Array.isArray(vsh.dirs) && vsh.dirs.length === n;
  for (let i = 0; i < n && dirsOk; i++) {
    if (vsh.dirs[i] !== sh.dirs[i] || vsh.ys[i] !== sh.ys[i]) dirsOk = false;
  }
  ok(dirsOk, 'remapOut preserves dirs + ys (MTF arrows keep up/down)');
  ok(rt.out.shapes.get(sh.key).dirs === sh.dirs, 'remap is pure (engine frame untouched)');
}

console.log('\nROUND148: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
