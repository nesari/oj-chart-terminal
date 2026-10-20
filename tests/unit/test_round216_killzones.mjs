/**
 * test_round216_killzones.mjs — ROUND216 generic engine gaps found by running
 * the ICT Killzones & Pivots indicator (fixtures/pine/killzones_tfo.pine,
 * v6, 1074 lines) instead of debugging it line-by-line.
 *
 * Fixed (all TV parity, all generic — no script-specific hacks):
 *  1. compound assignment on field paths (`t._total += 1`, `p.price += x`)
 *  2. chart.fg_color / chart.bg_color (wired from the live theme; engine
 *     fallbacks match the dark factory theme)
 *  3. table.new / table.cell POSITIONAL order was swapped vs TV docs
 *     (frame_color<->frame_width, border_color<->border_width; cell had
 *     text_color at the width slot) + cell stores width/tooltip
 *  4. array.stdev() was missing; array.variance/stdev take biased (TV v6)
 *  5. alert.freq_once_per_bar / _close / _all constants
 *  6. timeframe.change("D"/"W"/"M") detects the TF period rolling over
 *     (time(tf) != time(tf)[1]); the old arg!=arg[1] compare was constantly
 *     false for literals and killed whole indicators. "" = chart TF in
 *     timeframe.in_seconds("") (was na, same kill effect)
 *  7. UDT-typed type fields (`track _hit`) shifted every constructor arg
 *  8. str.format {x,number,percent} (x100 + %); str.format_time M/d/yyyy,
 *     MMM/MMMM/EEE/EEEE and quoted literals
 *  9. KZP end-to-end smoke (counts + content validity + percent tooltips)
 *
 * Docs: https://www.tradingview.com/pine-script-docs/visuals/tables/
 *       https://www.tradingview.com/pine-script-docs/concepts/timeframes/
 *       https://www.tradingview.com/pine-script-docs/concepts/sessions/
 *
 * Run: node tests/unit/test_round216_killzones.mjs
 */

import { compile } from '../../src/core/pine/compile.js';
import { strFns } from '../../src/core/pine/stdlib/math.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const T0 = 1790600400 - (1790600400 % 900);
const BARS = Array.from({ length: 8 }, (_, i) => ({
  time: T0 + i * 900, open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i, volume: 10,
}));
const HEAD = '//@version=6\nindicator("T", overlay=true)\n';
function runIt(body, bars, opts) {
  const c = compile(HEAD + body);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 0.01 }, opts));
    rt.runAll(bars || BARS);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
const isNAv = (v) => v != null && typeof v === 'object' && v.__pineNA === true;
const last = (rt, name) => {
  const r = rt.globals.get(name);
  return r && r.hist ? r.hist.a[r.hist.a.length - 1] : 'missing';
};

/* ---------- 1. compound field assignment ---------- */
{
  const r = runIt('type T\n    int n = 0\n    float f = 1.0\nt = T.new()\nt.n += 5\nt.f *= 2.0\nv = t.n\nw = t.f\nplot(v)\nplot(w)\n');
  ok(!r.error && last(r.rt, 'v') === 5 && last(r.rt, 'w') === 2, 'UDT field += and *= (fresh object per bar; got ' + (!r.error ? last(r.rt, 'v') + '/' + last(r.rt, 'w') : r.error) + ')');
}
{
  const r = runIt('type T\n    int n = 10\nt = T.new()\nt.n -= 3\nv = t.n\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 7, 'UDT field -=');
}
{
  const r = runIt('p = chart.point.from_index(1, 10.0)\np.price += 5.0\nv = p.price\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 15, 'chart.point field +=');
}

/* ---------- 2. chart theme colors ---------- */
{
  const r = runIt('v = chart.fg_color\nplot(1)\n');
  const g = !r.error && r.rt.globals.get('v');
  const val = g && g.hist ? g.hist.a[g.hist.a.length - 1] : null;
  ok(!r.error && val && !!val.css && val.css() === 'rgba(209,212,220,1)', 'fg_color defaults to dark-theme text (got ' + (val && val.css ? val.css() : JSON.stringify(val)) + ')');
}
{
  const r = runIt('v = chart.bg_color\nplot(1)\n', undefined, { chartFg: '#131722', chartBg: '#ffffff' });
  const g = !r.error && r.rt.globals.get('v');
  const val = g && g.hist ? g.hist.a[g.hist.a.length - 1] : null;
  ok(!r.error && val && !!val.css && val.css() === 'rgba(255,255,255,1)', 'bg_color wired through opts');
}

/* ---------- 3. table.new / table.cell positional order ---------- */
{
  const r = runIt('t = table.new(position.top_right, 1, 1, color.red, color.blue, 2, color.green, 3)\nv = 1\nplot(v)\n');
  let t = null;
  if (!r.error) for (const o of r.rt.store.table.values()) t = o;
  ok(!r.error && t && t.frame_width === 2 && t.border_width === 3 &&
    t.frame_color.css() === 'rgba(41,98,255,1)' && t.border_color.css() === 'rgba(76,175,80,1)',
    'table.new positional TV order (frame 2/blue, border 3/green)');
}
{
  const r = runIt('t = table.new(position.top_right, 1, 1)\ntable.cell(t, 0, 0, "x", 10, 20, color.red, text.align_left, text.align_center, size.small, color.blue, "tip")\nv = 1\nplot(v)\n');
  let cell = null;
  if (!r.error) for (const o of r.rt.store.table.values()) cell = o.cells.get('0,0');
  ok(!r.error && cell && cell.width === 10 && cell.height === 20 && cell.tooltip === 'tip' &&
    cell.text_color.css() === 'rgba(242,54,69,1)' && cell.bgcolor.css() === 'rgba(41,98,255,1)',
    'table.cell positional TV order (w/h/color/tip)');
}

/* ---------- 4. array.stdev / variance biased ---------- */
{
  const r = runIt('a = array.from(2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0)\nv = a.stdev()\nw = array.stdev(a)\nplot(v)\nplot(w)\n');
  ok(!r.error && last(r.rt, 'v') === 2 && last(r.rt, 'w') === 2, 'array.stdev method+ns (classic 2,2 sample set, got ' + (!r.error ? last(r.rt, 'v') : r.error) + ')');
}
{
  const r = runIt('a = array.from(2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0)\nv = a.variance(biased=false)\nw = a.stdev(biased=false)\nplot(v)\nplot(w)\n');
  const close = (x, y) => typeof x === 'number' && Math.abs(x - y) < 1e-9;
  ok(!r.error && close(last(r.rt, 'v'), 32 / 7) && close(last(r.rt, 'w'), Math.sqrt(32 / 7)), 'array variance/stdev biased=false (sample)');
}
{
  const r = runIt('a = array.from(5.0)\nv = na(a.stdev(biased=false)) ? 1 : 0\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 1, 'stdev unbiased L=1 guard is na');
}

/* ---------- 5. alert freq consts ---------- */
{
  const r = runIt('if barstate.islast\n    alert("hi", alert.freq_once_per_bar)\n    alert("ho", alert.freq_all)\nv = 1\nplot(v)\n');
  ok(!r.error && r.rt.out.alerts.length === 2, 'alert() with freq consts collects (' + (!r.error ? r.rt.out.alerts.length : r.error) + ')');
}

/* ---------- 6. timeframe.change period semantics ---------- */
{
  // 6 days of M15: 5 day boundaries
  const D0 = Date.UTC(2026, 9, 5, 12, 0, 0) / 1000;
  const bars = Array.from({ length: 576 }, (_, i) => ({ time: D0 + i * 900, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  const r = runIt('v = timeframe.change("D")\nplot(v ? 1 : 0)\n', bars);
  const rec = !r.error && r.rt.globals.get('v');
  const n = rec && rec.hist ? rec.hist.a.filter((x) => x === true).length : -1;
  ok(!r.error && n === 6, 'change("D") fires on each UTC midnight (got ' + n + ')');
}
{
  // Sat noon -> following Sun noon: crosses one Monday 00:00 UTC
  const D0 = Date.UTC(2026, 9, 3, 12, 0, 0) / 1000;
  const bars = Array.from({ length: 576 }, (_, i) => ({ time: D0 + i * 900, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  const r = runIt('v = timeframe.change("W")\nplot(v ? 1 : 0)\n', bars);
  const rec = !r.error && r.rt.globals.get('v');
  const n = rec && rec.hist ? rec.hist.a.filter((x) => x === true).length : -1;
  ok(!r.error && n === 1, 'change("W") fires once on Monday (got ' + n + ')');
}
{
  // 70 days: two month boundaries (Nov 1, Dec 1)
  const D0 = Date.UTC(2026, 9, 5, 12, 0, 0) / 1000;
  const bars = Array.from({ length: 70 * 96 }, (_, i) => ({ time: D0 + i * 900, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  const r = runIt('v = timeframe.change("M")\nplot(v ? 1 : 0)\n', bars);
  const rec = !r.error && r.rt.globals.get('v');
  const n = rec && rec.hist ? rec.hist.a.filter((x) => x === true).length : -1;
  ok(!r.error && n === 2, 'change("M") fires on month starts (got ' + n + ')');
}
{
  const r = runIt('v = timeframe.in_seconds("")\nplot(v)\n', undefined, { tfSec: 900 });
  ok(!r.error && last(r.rt, 'v') === 900, 'in_seconds("") = chart TF');
}

/* ---------- 7. UDT-typed fields ---------- */
{
  const r = runIt('type track\n    bool[] _h\n    float _p = na\ntype kz\n    string _t\n    track _hit\n    float[] _pool\nvar k = kz.new("t", track.new(array.new_bool()), array.new_float())\nv = k._pool.size() == 0 ? 1 : 0\nplot(v)\n');
  ok(!r.error && last(r.rt, 'v') === 1, 'UDT-typed field keeps constructor alignment (got ' + (!r.error ? last(r.rt, 'v') : r.error) + ')');
}

/* ---------- 8. str.format percent + format_time ---------- */
{
  // direct stdlib checks (exact strings)
  const site = {};
  let p1 = '';
  try { p1 = strFns.format(site, '{0,number,percent}', 0.5); } catch (e) { p1 = 'ERR'; }
  ok(p1 === '50%', '{x,number,percent} x100 + % (got ' + p1 + ')');
  const ts = Date.UTC(2026, 9, 8, 13, 30, 5);
  let d1 = '';
  try { d1 = strFns.format_time(site, ts, 'M/d/yyyy', 'GMT'); } catch (e) { d1 = 'ERR'; }
  ok(d1 === '10/8/2026', 'format_time M/d/yyyy unpadded (got ' + d1 + ')');
  let d2 = '';
  try { d2 = strFns.format_time(site, ts, "'Date:' yyyy-MM-dd HH:mm:ss", 'GMT'); } catch (e) { d2 = 'ERR'; }
  ok(d2 === 'Date: 2026-10-08 13:30:05', 'quoted literals survive (got ' + d2 + ')');
  let d3 = '';
  try { d3 = strFns.format_time(site, ts, 'EEE, MMM d', 'GMT'); } catch (e) { d3 = 'ERR'; }
  ok(d3 === 'Thu, Oct 8', 'names EEE/MMM (got ' + d3 + ')');
}

/* ---------- 9. KZP end-to-end smoke ---------- */
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src0 = readFileSync(join(here, '..', '..', 'fixtures', 'pine', 'killzones_tfo.pine'), 'utf8');
  const src = src0.replaceAll('input.bool(false,', 'input.bool(true,');
  const c = compile(src);
  ok(c.ok, 'KZP compiles' + (!c.ok ? ' -> ' + c.errors.map((e) => 'L' + e.line + ':' + e.message).join('|').slice(0, 160) : ''));
  if (c.ok) {
    const mkBars = (D0) => {
      const bars = [];
      let px = 2650;
      for (let i = 0; i < 576; i++) {
        const w = Math.sin(i / 9) * 4;
        const o = px, h = o + 1, l = o - 1, cl = o + w * 0.2;
        bars.push({ time: D0 + i * 900, open: o, high: h, low: l, close: cl, volume: 100 });
        px = cl;
      }
      return bars;
    };
    const runBars = (bars) => {
      try {
        const rt = c.createInstance({ tfSec: 900, symbol: 'XAUUSD', mintick: 0.01 });
        rt.runAll(bars);
        return { rt };
      } catch (e) { return { error: String((e && e.message) || e).slice(0, 160) }; }
    };
    // out-of-session start (Mon 12:00 UTC) + in-session start (Mon 00:00 UTC =
    // Sun 20:00 NY, inside ASIA): the fixture guard covers the left edge
    // (upstream crashes there — TV-identical, see CHANGELOG 216)
    const r1 = runBars(mkBars(Date.UTC(2026, 9, 5, 12, 0, 0) / 1000));
    ok(!r1.error, 'KZP runs 6 days all-features' + (r1.error ? ' -> ' + r1.error : ''));
    const r2 = runBars(mkBars(Date.UTC(2026, 9, 5, 0, 0, 0) / 1000));
    ok(!r2.error, 'KZP survives mid-session history start' + (r2.error ? ' -> ' + r2.error : ''));
    const rt = (!r1.error && r1.rt) || (!r2.error && r2.rt);
    if (rt) {
      let badBox = 0, badLine = 0, pctTip = 0;
      for (const b of rt.store.box.values()) {
        if (!isFinite(b.top) || !isFinite(b.bottom) || b.top < b.bottom || !isFinite(b.left) || !isFinite(b.right) || b.left > b.right) badBox++;
      }
      for (const l of rt.store.line.values()) {
        if (!isFinite(l.y1) || !isFinite(l.y2) || !isFinite(l.x1) || !isFinite(l.x2)) badLine++;
      }
      for (const lb of rt.store.label.values()) {
        if (lb.tooltip && String(lb.tooltip).includes('%')) pctTip++;
      }
      let pctCell = false, hasRange = false;
      for (const t of rt.store.table.values()) {
        for (const cell of t.cells.values()) {
          if (cell.text === 'Range') hasRange = true;
          if (String(cell.text).includes('%')) pctCell = true;
        }
      }
      ok(rt.store.box.size === 18 && badBox === 0, 'killzone boxes capped+valid (18/0, got ' + rt.store.box.size + '/' + badBox + ')');
      ok(rt.store.line.size > 0 && badLine === 0, 'pivot lines valid (' + rt.store.line.size + ' lines)');
      ok(pctTip > 0, 'hit-rate tooltips percent-formatted (' + pctTip + ')');
      ok(hasRange && pctCell, 'data table has Range header + percent cells');
    }
  }
}

console.log('\nROUND216: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
