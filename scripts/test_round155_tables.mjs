/**
 * test_round155_tables.mjs — ROUND155 table dashboards: engine content pins
 *
 * Run: node scripts/test_round155_tables.mjs
 *
 * The DOM render itself (_syncTables) needs a browser (covered by
 * scripts/e2e_round155_tables.py); here we pin what the renderer consumes:
 * the LuxAlgo Sessions dashboard builds exactly 1 table with the declared
 * shape and non-empty cells, Wyckoff builds its 2 status tables, and cell
 * writes land inside the declared grid (the strict bounds of table.cell).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compile } from '../src/core/pine/compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'pine-fixtures', 'corpus');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

function makeBars(n) {
  const bars = [];
  const t0 = 1790600400 - (1790600400 % 900);
  let px = 2400, seed = 31;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = 0; i < n; i++) {
    const o = px, cl = o + Math.sin(i / 9) * 3 + rnd() * 1.5;
    bars.push({ time: t0 + i * 900, open: o, high: Math.max(o, cl) + 1,
      low: Math.min(o, cl) - 1, close: cl, volume: 150 });
    px = cl;
  }
  return bars;
}

function runFile(f, n, enableTitles) {
  const src = readFileSync(join(DIR, f), 'utf8');
  const c = compile(src);
  if (!c.ok) return { error: 'compile: ' + String((c.errors[0] && c.errors[0].message) || '') };
  try {
    // first pass (defaults) discovers input defs; second pass applies the
    // overrides — exactly what the Inputs dialog writes back.
    const probe = c.createInstance({ tfSec: 900, symbol: 'XAUUSD', serverOffSec: 0 });
    probe.runAll(makeBars(10));
    const inputValues = {};
    for (const d of probe.inputDefs) {
      if (enableTitles && enableTitles.includes(d.title)) inputValues[d.id] = true;
    }
    const rt = c.createInstance({ tfSec: 900, symbol: 'XAUUSD', serverOffSec: 0, inputValues });
    rt.runAll(makeBars(n || 150));
    return { rt };
  } catch (e) {
    return { error: 'run: ' + String((e && e.message) || e) };
  }
}

{
  /* dashboards default OFF in both scripts — enable like the dialog would */
  const r = runFile('sessions.pine', 150, ['Dashboard']);
  ok(!r.error, 'sessions runs (dashboard on)' + (r.error ? ' (-> ' + r.error.slice(0, 100) + ')' : ''));
  if (!r.error) {
    const tables = [...r.rt.store.table.values()];
    ok(tables.length === 1, 'exactly 1 dashboard table (got ' + tables.length + ')');
    const t = tables[0];
    ok(t && t.rows === 7 && t.cols >= 2, 'declared shape kept (got ' + (t && t.cols + 'x' + t.rows) + ')');
    ok(t && ['top_left', 'top_center', 'top_right', 'middle_left', 'middle_center', 'middle_right', 'bottom_left', 'bottom_center', 'bottom_right'].includes(t.pos), 'valid corner position (got ' + (t && t.pos) + ')');
    let filled = 0, outOfGrid = 0;
    for (const [k, cell] of t.cells) {
      const [c, rr] = k.split(',').map(Number);
      if (c < 0 || c >= t.cols || rr < 0 || rr >= t.rows) outOfGrid++;
      if (cell.text) filled++;
    }
    ok(outOfGrid === 0, 'every cell inside the grid');
    ok(filled > 5, 'dashboard actually written (' + filled + ' non-empty cells)');
    ok(t.merges.length >= 1, 'header merge recorded (got ' + t.merges.length + ')');
    const head = t.cells.get('0,0');
    ok(head && /Sessions/.test(head.text), 'merged header text present (got ' + JSON.stringify(head && head.text) + ')');
    /* ROUND158-sweep pin: method-form named args (t.cell(text_color=...))
       once rode nowhere — colors/align must survive, not just text. */
    ok(head && head.text_color && head.text_color.css() === 'rgba(219,219,219,1)', 'method-form text_color applied (got ' + (head && head.text_color && head.text_color.css()) + ')');
    ok(head && head.text_halign === 'center', 'method-form text_halign applied (got ' + (head && head.text_halign) + ')');
    console.log('    … sessions table: ' + t.cols + 'x' + t.rows + ' @' + t.pos + ', ' + filled + ' cells filled');
  }
}
{
  const r = runFile('wyckoff.pine', 150, ['Show Status Table']);
  ok(!r.error, 'wyckoff runs (status table on)' + (r.error ? ' (-> ' + r.error.slice(0, 100) + ')' : ''));
  if (!r.error) {
    const tables = [...r.rt.store.table.values()];
    ok(tables.length === 2, 'both status tables built (got ' + tables.length + ')');
    const dims = tables.map((t) => t.cols + 'x' + t.rows).sort().join(',');
    ok(dims === '2x10,4x20', 'declared shapes kept (got ' + dims + ')');
    const filled = tables.reduce((n, t) => n + [...t.cells.values()].filter((c) => c.text).length, 0);
    ok(filled > 5, 'status tables written (' + filled + ' non-empty cells)');
  }
}
/* table rollback: forming-bar cell edits revert (ROUND151 machinery) */
{
  const src = '//@version=6\nindicator("t", overlay=true)\n'
    + 'var table tb = table.new(position.bottom_right, 2, 2)\n'
    + 'table.cell(tb, 0, 0, str.tostring(bar_index))\n'
    + 'plot(close, title="c")';
  const c = compile(src);
  ok(c.ok, 'table-rollback probe compiles');
  if (c.ok) {
    const bars = makeBars(10);
    const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
    rt.runAll(bars);
    const t = [...rt.store.table.values()][0];
    const before = t.cells.get('0,0').text;
    ok(before === '9', 'cell shows last bar_index (got ' + before + ')');
    rt.updateForming(bars); // re-runs bar 9 only; same value, no duplication
    const after = [...rt.store.table.values()][0].cells.get('0,0').text;
    ok(after === '9' && rt.store.table.size === 1, 'forming re-run is idempotent (got ' + after + ')');
  }
}
/* strict bounds: out-of-grid write is a loud error, not silent loss */
{
  const src = '//@version=6\nindicator("t", overlay=true)\n'
    + 'var table tb = table.new(position.bottom_right, 1, 1)\n'
    + 'table.cell(tb, 5, 0, "x")\nplot(close, title="c")';
  const c = compile(src);
  let threw = false;
  if (c.ok) {
    try { c.createInstance({ tfSec: 900, symbol: 'T' }).runAll(makeBars(5)); }
    catch (e) { threw = /outside/.test(String((e && e.message) || e)); }
  }
  ok(threw, 'out-of-grid cell throws loudly');
}

console.log('\nROUND155: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
