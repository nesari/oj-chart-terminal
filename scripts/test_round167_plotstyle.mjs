/**
 * test_round167_plotstyle.mjs — ROUND167 plot-style menu engine side.
 *
 * The Style tab now offers TV's plot-style menu (Line … Circles) + Price
 * line toggle per plot row. Engine side pinned here: all 11 style payloads
 * parse (incl. the steplinebr step+breaks form), trackprice/show_last land
 * on the plot record. Dialog->apply->paint is covered live (e2e_round167).
 *
 * Run: node scripts/test_round167_plotstyle.mjs
 */

import { compile } from '../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const STYLES = [
  ['plot.style_line', 'line'],
  ['plot.style_linebr', 'linebr'],
  ['plot.style_stepline', 'stepline'],
  ['plot.style_steplinebr', 'steplinebr'],
  ['plot.style_stepline_diamond', 'stepline_diamond'],
  ['plot.style_histogram', 'histogram'],
  ['plot.style_columns', 'columns'],
  ['plot.style_cross', 'cross'],
  ['plot.style_area', 'area'],
  ['plot.style_areabr', 'areabr'],
  ['plot.style_circles', 'circles'],
];

{
  const plots = STYLES.map(([fn], i) => `plot(close + ${i}, title="p${i}", style=${fn})`).join('\n');
  const src = `//@version=5\nindicator("st167", overlay=true)\n${plots}\nplot(close, title="tr", trackprice=true, show_last=50)\n`;
  const c = compile(src);
  ok(c.ok, 'all 11 plot styles compile' + (c.ok ? '' : ' -> ' + JSON.stringify(c.errors).slice(0, 200)));
  if (c.ok) {
    const t0 = 1790600400 - (1790600400 % 900);
    const bars = [];
    for (let i = 0; i < 60; i++) bars.push({ time: t0 + i * 900, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 });
    const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
    rt.runAll(bars);
    for (let i = 0; i < STYLES.length; i++) {
      const p = rt.out.plots.get(rt.out.plotsOrder[i]);
      ok(!!p && p.style === STYLES[i][1], STYLES[i][0] + ' -> ' + STYLES[i][1] + ' (got ' + (p && p.style) + ')');
    }
    const tr = rt.out.plots.get(rt.out.plotsOrder[STYLES.length]);
    ok(!!tr && tr.trackprice === true && tr.show_last === 50,
      'trackprice/show_last recorded (got ' + tr.trackprice + '/' + tr.show_last + ')');
  }
}

console.log('\nROUND167: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
