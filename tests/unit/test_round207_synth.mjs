/**
 * test_round207_synth.mjs — ROUND207 synthetic chart-type tickers (TV parity).
 *
 * Pure formation math (renko/linebreak/kagi/pointfigure over hand-made
 * closes) + security integration (last-value parity, NA early history,
 * prefix-consistency = no future leak, HTF base, loud paths).
 *
 * Run: node tests/unit/test_round207_synth.mjs
 */

import { compile } from '../../src/core/pine/compile.js';
import { synthReference } from '../../src/core/pine/stdlib/ticker.js';
import { NA, isNA } from '../../src/core/pine/types.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const T0 = 1790600400 - (1790600400 % 900);
const mkBars = (closes, sec) => closes.map((c, i) => ({
  time: T0 + i * (sec || 900), open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 10,
}));
const rowsOf = (bars) => bars.map((b) => ({ t: b.time, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }));
const HEAD = '//@version=5\nindicator("T", overlay=true)\n';
function runIt(body, bars, opts) {
  const c = compile(HEAD + body);
  if (!c.ok) return { error: 'compile: ' + c.errors.map((e) => e.message).join(' | ').slice(0, 200) };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 900, symbol: 'T', mintick: 0.01 }, opts));
    rt.runAll(bars);
    return { rt };
  } catch (e) { return { error: 'run: ' + String((e && e.message) || e).slice(0, 200) }; }
}
const hist = (rt, name) => rt.globals.get(name).hist.a.slice();

/* ---------- pure renko ---------- */
{
  const s = synthReference('renko', rowsOf(mkBars([100, 101, 102, 103, 104, 105, 106])), 2, 0);
  ok(s.length === 3 && s[0].open === 100 && s[0].close === 102 && s[2].close === 106, 'renko steady climb bricks');
}
{
  const s = synthReference('renko', rowsOf(mkBars([100, 102, 104, 103, 102, 100])), 2, 0);
  const closes = s.map((b) => b.close);
  ok(JSON.stringify(closes) === JSON.stringify([102, 104, 102, 100]), 'renko 1-brick reversal');
}
{
  const s = synthReference('renko', rowsOf(mkBars([100, 105])), 2, 0);
  ok(s.length === 2 && s[0].close === 102 && s[1].close === 104, 'renko multi-brick bar');
}
{
  const bars = mkBars([100, 102, 104]);
  const s = synthReference('renko', rowsOf(bars), 2, 0);
  const tot = s.reduce((a, b) => a + b.volume, 0);
  ok(tot === 30, 'renko volume conserved over span (got ' + tot + ')');
}
{
  const bars = mkBars([100, 102, 104]);
  bars[1].close = NaN;
  const s = synthReference('renko', rowsOf(bars), 2, 0);
  ok(s.length === 2 && s[1].close === 104, 'renko na close skipped');
}
{
  const s = synthReference('renko', rowsOf(mkBars([100, 100, 100])), 2, 0);
  ok(s.length === 0, 'renko flat yields nothing (na until first brick)');
}

/* ---------- pure linebreak ---------- */
{
  // 3-line: up-run then close below the min low of the last 3 -> reversal
  const s = synthReference('linebreak', rowsOf(mkBars([10, 11, 12, 13, 9.5])), 3, 0);
  const last = s[s.length - 1];
  ok(last.close === 9.5 && last.close < last.open && s.length >= 4, '3-line reversal fires (n=' + s.length + ')');
}
{
  const s = synthReference('linebreak', rowsOf(mkBars([10, 11, 12, 13, 13.5])), 3, 0);
  ok(s.every((l) => l.close >= l.open), 'rising run stays up-lines');
}

/* ---------- pure kagi ---------- */
{
  const s = synthReference('kagi', rowsOf(mkBars([100, 101, 103, 105, 104, 101])), 2, 0);
  ok(s.length === 2 && s[0].open === 100 && s[0].close === 105 && s[1].close === 101, 'kagi extend + reverse');
}
{
  const s = synthReference('kagi', rowsOf(mkBars([100, 100.5, 100.2])), 2, 0);
  ok(s.length === 0, 'kagi flat yields nothing');
}

/* ---------- pure pointfigure ---------- */
{
  const s = synthReference('pointfigure', rowsOf(mkBars([100, 101, 102, 103, 102, 101, 100, 99])), 1, 3);
  const dirs = s.map((b) => (b.close > b.open ? 'X' : 'O'));
  ok(dirs[0] === 'X' && dirs[dirs.length - 1] === 'O', 'pf X then 3-box reversal to O (' + dirs.join('') + ')');
}
{
  const s = synthReference('pointfigure', rowsOf(mkBars([100, 101, 102])), 1, 0 - 0 + 3);
  ok(s.length === 1 && s[0].close === 102, 'pf single X column extends');
}

/* ---------- loud factories ---------- */
for (const [label, body] of [
  ['renko brick 0', 't = ticker.renko(syminfo.tickerid, "", 0)\nplot(1)\n'],
  ['renko brick na', 't = ticker.renko(syminfo.tickerid, "", na)\nplot(1)\n'],
  ['renko bad tf', 't = ticker.renko(syminfo.tickerid, "XYZ", 2)\nplot(1)\n'],
  ['renko empty sym', 't = ticker.renko("", "", 2)\nplot(1)\n'],
  ['lb lines 0', 't = ticker.linebreak(syminfo.tickerid, "", 0)\nplot(1)\n'],
  ['kagi rev -1', 't = ticker.kagi(syminfo.tickerid, "", -1)\nplot(1)\n'],
  ['pf box 0', 't = ticker.pointfigure(syminfo.tickerid, "", 0, 3)\nplot(1)\n'],
]) {
  const r = runIt(body, mkBars([100, 101, 102]));
  ok(!!r.error, 'loud: ' + label + (r.error ? ' -> ' + r.error.slice(0, 90) : ''));
}
{
  // defaults: linebreak 3, pf reversal 3
  const r = runIt('a = ticker.linebreak(syminfo.tickerid, "")\nb = ticker.pointfigure(syminfo.tickerid, "", 1)\nplot(1)\n', mkBars([100, 101, 102]));
  ok(!r.error, 'omitted line_number/reversal default' + (r.error ? ' -> ' + r.error : ''));
}

/* ---------- engine integration ---------- */
const BARS30 = (() => {
  const out = [];
  for (let i = 0; i < 30; i++) {
    const o = 100 + Math.sin(i / 3) * 5 + i * 0.3;
    out.push({ time: T0 + i * 900, open: o, high: o + 1, low: o - 1, close: o + (i % 2 ? 0.8 : -0.8), volume: 10 });
  }
  return out;
})();
const TK = {
  renko: ['ticker.renko(syminfo.tickerid, "", 2)', 2, 0],
  linebreak: ['ticker.linebreak(syminfo.tickerid, "", 3)', 3, 0],
  kagi: ['ticker.kagi(syminfo.tickerid, "", 2)', 2, 0],
  pf: ['ticker.pointfigure(syminfo.tickerid, "", 1, 3)', 1, 3],
};
for (const [kind, [expr, p1, p2]] of Object.entries(TK)) {
  const r = runIt('t = ' + expr + '\nr = request.security(t, "", close)\nplot(r)\n', BARS30);
  ok(!r.error, kind + ' security runs' + (r.error ? ' -> ' + r.error : ''));
  if (r.error) continue;
  const h = hist(r.rt, 'r');
  const pure = synthReference(kind === 'pf' ? 'pointfigure' : kind, rowsOf(BARS30), p1, p2);
  const plast = pure.length ? pure[pure.length - 1].close : NA;
  const elast = h[h.length - 1];
  ok((isNA(plast) && isNA(elast)) || plast === elast, kind + ' last-value parity (got ' + JSON.stringify(elast) + ')');
  ok(isNA(h[0]), kind + ' early history na');
  const uniq = new Set(h.filter((v) => !isNA(v))).size;
  ok(uniq < BARS30.length, kind + ' stepwise (' + uniq + '/' + BARS30.length + ' distinct)');
}
{
  // prefix-consistency: engine value at bar i == formation-over-rows[0..i] last
  const r = runIt('t = ticker.renko(syminfo.tickerid, "", 2)\nr = request.security(t, "", close)\nplot(r)\n', BARS30);
  ok(!r.error, 'prefix run ok');
  if (!r.error) {
    const h = hist(r.rt, 'r');
    const rows = rowsOf(BARS30);
    let bad = -1;
    for (let i = 0; i < BARS30.length; i++) {
      const p = synthReference('renko', rows.slice(0, i + 1), 2, 0);
      const want = p.length ? p[p.length - 1].close : NA;
      const got = h[i];
      if ((isNA(want) && !isNA(got)) || (!isNA(want) && got !== want)) { bad = i; break; }
    }
    ok(bad < 0, 'renko prefix-consistent, no future leak' + (bad >= 0 ? ' @bar ' + bad : ''));
  }
}
{
  // history operator on synthetic reads
  const r = runIt('t = ticker.renko(syminfo.tickerid, "", 2)\nr = request.security(t, "", close)\nrl = r[1]\nplot(r)\n', BARS30);
  ok(!r.error, 'r[1] on synth reads ok' + (r.error ? ' -> ' + r.error : ''));
}
{
  // HTF base (H1 bricks on a 15m chart) vs hand-aggregated expectation
  const bars = [];
  for (let i = 0; i < 24; i++) {
    const o = 100 + i;
    bars.push({ time: T0 + i * 900, open: o, high: o + 0.6, low: o - 0.6, close: o + 0.5, volume: 10 });
  }
  const r = runIt('t = ticker.renko(syminfo.tickerid, "60", 2)\nr = request.security(t, "", close)\nplot(r)\n', bars);
  ok(!r.error, 'H1-base renko runs' + (r.error ? ' -> ' + r.error : ''));
  if (!r.error) {
    // hand aggregate to hours: 4 bars each
    const aggs = [];
    for (let h = 0; h < 6; h++) {
      const sl = bars.slice(h * 4, h * 4 + 4);
      aggs.push({ t: sl[0].time, o: sl[0].open, h: Math.max(...sl.map((b) => b.high)), l: Math.min(...sl.map((b) => b.low)), c: sl[3].close, v: 40 });
    }
    const pure = synthReference('renko', aggs, 2, 0);
    const h = hist(r.rt, 'r');
    const elast = h[h.length - 1];
    ok(pure.length && elast === pure[pure.length - 1].close, 'H1-base last parity (got ' + JSON.stringify(elast) + ')');
  }
}
{
  // dest TF above base also works
  const r = runIt('t = ticker.renko(syminfo.tickerid, "", 2)\nr = request.security(t, "60", close)\nplot(r)\n', BARS30);
  ok(!r.error, 'H1-dest renko runs' + (r.error ? ' -> ' + r.error : ''));
}
{
  // loud: base below chart
  const r = runIt('t = ticker.renko(syminfo.tickerid, "1", 2)\nr = request.security(t, "", close)\nplot(r)\n', BARS30);
  ok(!!r.error && /lower than/.test(r.error), 'sub-chart base loud' + (r.error ? ' -> ' + r.error.slice(0, 100) : ''));
}
{
  // loud: cross-symbol without prefetched base data
  const r = runIt('t = ticker.renko("NOPE/XYZ", "60", 2)\nr = request.security(t, "", close)\nplot(r)\n', BARS30);
  ok(!!r.error && /no history/.test(r.error), 'missing cross-sym base loud' + (r.error ? ' -> ' + r.error.slice(0, 100) : ''));
}
{
  // forming-bar tick path stays consistent
  const r = runIt('t = ticker.renko(syminfo.tickerid, "", 2)\nr = request.security(t, "", close)\nplot(r)\n', BARS30);
  if (!r.error) {
    const before = hist(r.rt, 'r').slice();
    r.rt.updateForming(BARS30);
    const after = hist(r.rt, 'r').slice();
    ok(JSON.stringify(before) === JSON.stringify(after), 'updateForming stable on synth');
  } else ok(false, 'updateForming stable on synth -> ' + r.error);
}

console.log('\nROUND207: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
