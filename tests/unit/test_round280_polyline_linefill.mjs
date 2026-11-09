/**
 * test_round280_polyline_linefill.mjs — ROUND280 drawing coverage.
 *
 * Two stale claims in the Pine docs were checked against the official v6
 * reference and the live code:
 *
 *  1. "polyline/linefill are not rendered" — FALSE. The adapter has painted
 *     both since ROUND136/141 (`_paintPolyline` / `_paintLinefill`, both in
 *     the FG object pass, linefills re-reading their constituent lines every
 *     frame). What was genuinely missing was a Style-tab master toggle, so
 *     they could not be hidden like boxes/lines/labels. ROUND280 adds the
 *     `polylines` / `linefills` keys to the TV "Graphic objects" block.
 *
 *  2. "math.bitwise_* is an unimplemented v6 namespace" — FALSE. The official
 *     v6 reference has NO bitwise namespace under math (checked against the
 *     reference page's full `math.*` list); the engine's 26 functions + 6
 *     constants are a complete match. Nothing to implement.
 *
 * Run: node tests/unit/test_round280_polyline_linefill.mjs
 */

import { compile } from '../../src/core/pine/compile.js';
import { mathFns, MATH_CONSTS } from '../../src/core/pine/stdlib/math.js';
import { drawKindOn } from '../../src/core/pine/stdlib/objects.js';
import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

function bars(n, base) {
  const t0 = 1790600400 - (1790600400 % 900);
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = (base || 100) + i;
    out.push({ time: t0 + i * 900, open: o, high: o + 2, low: o - 2, close: o + 1, volume: 10 });
  }
  return out;
}

function runIt(src, n) {
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance({ tfSec: 900, symbol: 'T', mintick: 1 });
    rt.runAll(bars(n || 10));
    return { c, rt };
  } catch (e) { return { c, error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}

/* ---------- 1. math.* matches the official v6 reference exactly ---------- */
{
  /* The complete `math.*` list from the v6 reference (functions + constants).
     No bitwise_* entry exists there; this pin fails the day the list grows. */
  const OFFICIAL = [
    'abs', 'acos', 'asin', 'atan', 'avg', 'ceil', 'cos', 'e', 'exp', 'floor',
    'log', 'log10', 'max', 'min', 'phi', 'pi', 'pow', 'random', 'round',
    'round_to_mintick', 'rphi', 'sign', 'sin', 'sqrt', 'sum', 'tan',
    'todegrees', 'toradians',
  ];
  const have = new Set([...Object.keys(mathFns), ...Object.keys(MATH_CONSTS)]);
  const missing = OFFICIAL.filter((n) => !have.has(n));
  ok(missing.length === 0, 'every official math.* entry exists (missing: ' + (missing.join(',') || 'none') + ')');
  const extra = [...have].filter((n) => OFFICIAL.indexOf(n) < 0);
  ok(extra.every((n) => ['cosh', 'sinh', 'tanh', 'deg2rad', 'rad2deg'].indexOf(n) >= 0),
    'only documented-compatible extras (cosh/sinh/tanh/deg2rad/rad2deg), got ' + extra.join(','));
  ok(!Object.keys(mathFns).some((n) => /^bitwise_/.test(n)),
    'no math.bitwise_* exists (the official reference has none — docs corrected)');
}

/* ---------- 2. polyline/linefill build real objects ---------- */
{
  const r = runIt(`//@version=5
indicator("P")
if bar_index == 9
    p1 = chart.point.from_index(5, 101)
    p2 = chart.point.from_index(7, 105)
    p3 = chart.point.from_index(9, 102)
    polyline.new(array.from(p1, p2, p3), curved = true, closed = true, line_color = color.red, fill_color = color.new(color.blue, 70))
plot(close)
`, 10);
  ok(!r.error, 'polyline fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const polys = [...r.rt.store.polyline.values()];
    ok(polys.length === 1, 'polyline.new stores one object (got ' + polys.length + ')');
    ok(polys.length === 1 && polys[0].points.length === 3, 'all three points unpacked (got ' + (polys[0] && polys[0].points.length) + ')');
    ok(polys.length === 1 && polys[0].curved === true && polys[0].closed === true, 'curved/closed flags survive construction');
    ok(polys.length === 1 && polys[0].line_color && polys[0].line_color.css, 'line_color is a real PineColor');
    ok(polys.length === 1 && polys[0].fill_color && polys[0].fill_color.css, 'fill_color is a real PineColor');
    ok(polys.length === 1 && polys[0].points.every((p) => typeof p.x === 'number' && typeof p.y === 'number'),
      'points carry numeric x/y for the painter');
  }
}
{
  const r = runIt(`//@version=5
indicator("F")
if bar_index == 9
    a = line.new(bar_index - 3, 100, bar_index, 104)
    b = line.new(bar_index - 3, 96, bar_index, 98)
    linefill.new(a, b, color.new(color.gray, 80))
plot(close)
`, 10);
  ok(!r.error, 'linefill fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    const fills = [...r.rt.store.linefill.values()];
    ok(fills.length === 1, 'linefill.new stores one object (got ' + fills.length + ')');
    ok(fills.length === 1 && fills[0].line1 && fills[0].line2, 'both constituent lines are wired');
    ok(fills.length === 1 && fills[0].color && fills[0].color.css, 'fill colour is a real PineColor');
  }
}

/* ---------- 3. both kinds are in the adapter's paint pass ---------- */
{
  const src = readSource('src/renderer/js/chart/pine-render-adapter.js');
  ok(/_paintPolyline\(ctx, o\)/.test(src), 'adapter calls _paintPolyline');
  ok(/_paintLinefill\(ctx, o\)/.test(src), 'adapter calls _paintLinefill');
  ok(/for \(const \[, o\] of rt\.store\.polyline\) objs\.push\(o\)/.test(src), 'polylines are collected into the object pass');
  ok(/for \(const \[, o\] of rt\.store\.linefill\) objs\.push\(o\)/.test(src), 'linefills are collected into the object pass');
  const polyBody = (src.match(/_paintPolyline\(ctx, o\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(/ctx\.stroke\(\)/.test(polyBody), 'polyline painter strokes a real path');
  ok(/ctx\.fillStyle = fill; ctx\.fill\(\)/.test(polyBody), 'polyline painter fills a closed shape');
  const fillBody = (src.match(/_paintLinefill\(ctx, o\) \{[\s\S]*?\n  \}/) || [''])[0];
  ok(/ctx\.fill\(\)/.test(fillBody), 'linefill painter fills a real quad');
  ok(/o\.curved[\s\S]{0,400}bezierCurveTo/.test(polyBody), 'curved polylines flatten to bezier segments');
  ok(/line1\.deleted \|\| o\.line2\.deleted/.test(fillBody), 'a deleted constituent line stops the fill');
}

/* ---------- 4. ROUND280: the new Style-tab master toggles ---------- */
{
  const src = readSource('src/renderer/js/chart/pine-render-adapter.js');
  ok(/_drawKindOn\('polylines'\)/.test(src), 'polylines honour the Graphic objects toggle');
  ok(/_drawKindOn\('linefills'\)/.test(src), 'linefills honour the Graphic objects toggle');
}
{
  const src = readSource('src/renderer/js/chart/pine-ui/templates.js');
  ok(/mkObjCheck\('Polylines', 'polylines'\)/.test(src), 'Style tab renders a Polylines checkbox');
  ok(/mkObjCheck\('Line fills', 'linefills'\)/.test(src), 'Style tab renders a Line fills checkbox');
}

/* ---------- 5. drawKindOn default is ON (old saved styles keep drawing) ---------- */
{
  ok(drawKindOn(null, 'polylines') === true, 'absent style object leaves drawing on');
  ok(drawKindOn({ objects: {} }, 'polylines') === true, 'absent key leaves drawing on');
  ok(drawKindOn({ objects: { polylines: false } }, 'polylines') === false, 'explicit false turns polylines off');
  ok(drawKindOn({ objects: { polylines: false } }, 'linefills') === true, 'the toggles are independent');
  ok(drawKindOn({ objects: { boxes: false } }, 'boxes') === false, 'existing toggles keep working');
  ok(drawKindOn({ objects: { lines: false } }, 'lines') === false && drawKindOn({ objects: { labels: false } }, 'labels') === false,
    'lines/labels toggles unchanged');
}

/* ---------- 6. polyline/linefill API surface vs the reference ---------- */
{
  const r = runIt(`//@version=5
indicator("API")
if bar_index == 9
    p = polyline.new(array.from(chart.point.from_index(1, 100), chart.point.from_index(2, 102)))
    a = line.new(1, 100, 2, 104)
    b = line.new(1, 96, 2, 98)
    f = linefill.new(a, b, color.red)
    linefill.set_color(f, color.blue)
    l1 = linefill.get_line1(f)
    l2 = linefill.get_line2(f)
    polyline.delete(p)
plot(close)
`, 10);
  ok(!r.error, 'namespace API fixture runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    ok(r.rt.store.polyline.size === 0, 'polyline.delete removes the object');
    const fills = [...r.rt.store.linefill.values()];
    ok(fills.length === 1 && fills[0].color && /rgba?\(41, ?98, ?255/i.test(fills[0].color.css() || ''),
      'linefill.set_color lands (got ' + (fills[0] && fills[0].color && fills[0].color.css()) + ')');
  }
}
{
  const src = readSource('src/core/pine/interpreter/builtins.js');
  ok(/polyline: this\._polylineFns\(\)/.test(src), 'polyline namespace registered');
  ok(/linefill: this\._linefillFns\(\)/.test(src), 'linefill namespace registered');
}
{
  const src = readSource('src/core/pine/interpreter/expressions.js');
  ok(/base === 'polyline' \|\| base === 'linefill'/.test(src),
    'polyline.all / linefill.all resolve to live snapshots');
}

console.log('\nROUND280: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
