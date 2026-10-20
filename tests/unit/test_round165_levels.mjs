/**
 * test_round165_levels.mjs — ROUND165 SMC daily/weekly/monthly levels + label sizes.
 *
 * User report: enabling D/W/M levels threw (script ⚠, no level lines) on
 * every TF, and after the settings-dialog round-trip every BOS/CHoCH/EQH
 * label rendered big (tiny/small degraded to normal).
 *
 * Root causes fixed:
 *  1. array.binary_search_rightmost() did not exist (drawLevels needs it);
 *     binary_search_* added with lower_bound/upper_bound-1 semantics; the old
 *     binary_search searched an na-filtered copy (shifted indices).
 *  2. request.security('D') on a D1 chart threw "lower than or equal" — TV
 *     allows same-TF (and '' = chart TF) as identity.
 *  3. timeframe.in_seconds('D') ignored its argument (chart sec returned).
 *  4. label.new(size='tiny') with a plain string fell back to 'normal', and
 *     input options stringified enum members to "[object Object]" — every
 *     dialog Ok persisted garbage and upsized all SMC labels. Options now
 *     carry payloads; the dialog unwraps enum values for display.
 *
 * Run: node tests/unit/test_round165_levels.mjs
 */

import { readFileSync } from 'node:fs';
import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

/* 1. binary_search family */
{
  const src = `//@version=5
indicator("bs165", overlay=false)
a = array.from(10, 20, 20, 30)
plot(array.binary_search(a, 20), title="e")
plot(array.binary_search(a, 25), title="m")
plot(array.binary_search_leftmost(a, 20), title="l")
plot(array.binary_search_leftmost(a, 25), title="lm")
plot(array.binary_search_leftmost(a, 5), title="lo")
plot(array.binary_search_leftmost(a, 99), title="hi")
plot(array.binary_search_rightmost(a, 20), title="r")
plot(array.binary_search_rightmost(a, 25), title="rm")
plot(array.binary_search_rightmost(a, 5), title="ro")
plot(array.binary_search_rightmost(a, 99), title="rhi")
`;
  const c = compile(src);
  ok(c.ok, 'binary_search probe compiles');
  if (c.ok) {
    const t0 = 1790600400 - (1790600400 % 900);
    const bars = [];
    for (let i = 0; i < 5; i++) bars.push({ time: t0 + i * 900, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    const rt = c.createInstance({ tfSec: 900, symbol: 'T' });
    rt.runAll(bars);
    const V = rt.out.plotsOrder.map((t) => rt.out.plots.get(t).values[4]);
    const exp = [1, -1, 1, 3, 0, 4, 2, 2, -1, 3];
    const names = ['exact', 'missing', 'left-exact', 'left-missing', 'left-below', 'left-above', 'right-exact', 'right-missing', 'right-below', 'right-above'];
    for (let i = 0; i < exp.length; i++) ok(V[i] === exp[i], 'binary_search ' + names[i] + ' = ' + exp[i] + ' (got ' + V[i] + ')');
  }
}

/* 2. same-TF + '' security identity; 3. in_seconds(arg) */
{
  const src = `//@version=5
indicator("sec165", overlay=true)
s15 = request.security(syminfo.tickerid, "15", close)
sm = request.security(syminfo.tickerid, "", close)
dsec = timeframe.in_seconds("D")
wsec = timeframe.in_seconds("W")
m15sec = timeframe.in_seconds("15")
csec = timeframe.in_seconds()
plot(s15 - close, title="d15")
plot(sm - close, title="dm")
plot(dsec, title="d")
plot(wsec, title="w")
plot(m15sec, title="m")
plot(csec, title="c")
`;
  const c = compile(src);
  ok(c.ok, 'security-identity probe compiles' + (c.ok ? '' : ' -> ' + JSON.stringify(c.errors).slice(0, 200)));
  if (c.ok) {
    const t0 = 1790600400 - (1790600400 % 900);
    const bars = [];
    let px = 100;
    for (let i = 0; i < 60; i++) {
      const cl = px + (i % 7) * 0.5;
      bars.push({ time: t0 + i * 900, open: px, high: cl + 1, low: px - 1, close: cl, volume: 10 });
      px = cl;
    }
    const rt = c.createInstance({ tfSec: 900, symbol: 'XAUUSD' });
    rt.runAll(bars);
    const V = rt.out.plotsOrder.map((t) => rt.out.plots.get(t).values[59]);
    ok(V[0] === 0 && V[1] === 0, 'same-TF + empty-TF security are identity (got ' + V[0] + '/' + V[1] + ')');
    ok(V[2] === 86400 && V[3] === 604800 && V[4] === 900 && V[5] === 900,
      'in_seconds D/W/15/none = 86400/604800/900/900 (got ' + V.slice(2).join('/') + ')');
  }
}

/* 4. label sizes: enum object, payload string, dialog round-trip, garbage snap */
{
  const src = `//@version=5
indicator("sz165", overlay=true)
sz = input.string(size.tiny, "S", options=[size.tiny, size.small, size.normal])
label.new(bar_index, high, "t", size=sz)
plot(bar_index, title="x")
`;
  const c = compile(src);
  ok(c.ok, 'size probe compiles');
  if (c.ok) {
    const t0 = 1790600400 - (1790600400 % 900);
    const bars = [];
    for (let i = 0; i < 10; i++) bars.push({ time: t0 + i * 900, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 });
    const mk = (iv) => { const rt = c.createInstance({ tfSec: 900, symbol: 'T', inputValues: iv || {} }); rt.runAll(bars); return rt; };
    const rt0 = mk();
    const def = rt0.inputDefs.find((d) => d.title === 'S');
    ok(!!def && def.options.join(',') === 'tiny,small,normal', 'size options carry payloads (got ' + JSON.stringify(def && def.options) + ')');
    const sizes0 = new Set([...rt0.store.label.values()].map((l) => l.size));
    ok(sizes0.has('tiny') && sizes0.size === 1, 'defval tiny renders tiny (got ' + [...sizes0] + ')');
    const rt1 = mk({ [def.id]: 'small' });
    const sizes1 = new Set([...rt1.store.label.values()].map((l) => l.size));
    ok(sizes1.has('small') && sizes1.size === 1, 'dialog round-trip small renders small (got ' + [...sizes1] + ')');
    const rt2 = mk({ [def.id]: '[object Object]' });
    const sizes2 = new Set([...rt2.store.label.values()].map((l) => l.size));
    ok(sizes2.has('tiny') && sizes2.size === 1, 'stale garbage snaps to first option tiny (got ' + [...sizes2] + ')');
  }
  // enum == payload-string
  const src2 = `//@version=5
indicator("eq165", overlay=false)
x = "tiny"
plot(x == size.tiny ? 1 : 0, title="e")
plot(size.small == "small" ? 1 : 0, title="e2")
`;
  const c2 = compile(src2);
  ok(c2.ok, 'enum-string eq probe compiles');
  if (c2.ok) {
    const t0 = 1790600400 - (1790600400 % 900);
    const bars = [];
    for (let i = 0; i < 3; i++) bars.push({ time: t0 + i * 900, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    const rt = c2.createInstance({ tfSec: 900, symbol: 'T' });
    rt.runAll(bars);
    const a = rt.out.plots.get(rt.out.plotsOrder[0]).values[2];
    const b = rt.out.plots.get(rt.out.plotsOrder[1]).values[2];
    ok(a === 1 && b === 1, "'tiny' == size.tiny and size.small == 'small' (got " + a + '/' + b + ')');
  }
}

/* 5. SMC levels ON: no throw on any TF + PDH/PDL correctness on known grid */
{
  const src = readFileSync(new URL('../../fixtures/pine/corpus/smartmoney.pine', import.meta.url), 'utf8');
  const c = compile(src);
  ok(c.ok, 'SMC compiles');
  if (c.ok) {
    const p0 = c.createInstance({ tfSec: 900, symbol: 'XAUUSD' });
    const t00 = 1790600400 - (1790600400 % 900);
    const tb = [];
    for (let i = 0; i < 60; i++) tb.push({ time: t00 + i * 900, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    p0.runAll(tb);
    const ids = {};
    for (const d of p0.inputDefs) if (/^(Daily|Weekly|Monthly)$/.test(d.title)) ids[d.title] = d.id;
    ok(ids.Daily && ids.Weekly && ids.Monthly, 'D/W/M input ids found');
    // 3-day M15 grid: day1 spikes to known high/low
    const day = 86400;
    const t0 = 1790600400 - (1790600400 % day);
    const bars = [];
    for (let d = 0; d < 3; d++) {
      for (let k = 0; k < 96; k++) {
        let h = 4100 + (k % 5), l = 4095 - (k % 3);
        if (d === 1 && k === 40) { h = 4200; l = 4080; }
        if (d === 2) { h = 4150 + (k % 4); l = 4145 - (k % 3); }
        bars.push({ time: t0 + d * day + k * 900, open: 4100, high: h, low: l, close: 4100, volume: 10 });
      }
    }
    const iv = {};
    iv[ids.Daily] = true; iv[ids.Weekly] = true; iv[ids.Monthly] = true;
    let threw = null, rt = null;
    try { rt = c.createInstance({ tfSec: 900, symbol: 'XAUUSD', inputValues: iv }); rt.runAll(bars); }
    catch (e) { threw = String((e && e.message) || e).slice(0, 200); }
    ok(!threw, 'M15 levels D/W/M run without throw' + (threw ? ' -> ' + threw : ''));
    if (rt) {
      const texts = {};
      for (const lb of rt.store.label.values()) texts[lb.text] = lb.y;
      ok('PDH' in texts && 'PDL' in texts, 'PDH/PDL labels drawn (got ' + Object.keys(texts).join(',') + ')');
      if ('PDH' in texts) ok(Math.abs(texts.PDH - 4200) < 1e-9, 'PDH = prior day high 4200 (got ' + texts.PDH + ')');
      if ('PDL' in texts) ok(Math.abs(texts.PDL - 4080) < 1e-9, 'PDL = prior day low 4080 (got ' + texts.PDL + ')');
    }
    // H1 + Weekly, D1 + Daily (same-TF identity used to throw)
    for (const [tag, tfSec, n] of [['H1', 3600, 400], ['D1', 86400, 120]]) {
      const b2 = [];
      const tt0 = 1790600400 - (1790600400 % tfSec);
      let px = 4100;
      for (let i = 0; i < n; i++) {
        const cl = px + Math.sin(i / 20) * 5;
        b2.push({ time: tt0 + i * tfSec, open: px, high: Math.max(px, cl) + 2, low: Math.min(px, cl) - 2, close: cl, volume: 10 });
        px = cl;
      }
      let th2 = null;
      try { const r2 = c.createInstance({ tfSec, symbol: 'XAUUSD', inputValues: iv }); r2.runAll(b2); }
      catch (e) { th2 = String((e && e.message) || e).slice(0, 160); }
      ok(!th2, tag + ' levels D/W/M run without throw' + (th2 ? ' -> ' + th2 : ''));
    }
  }
}

console.log('\nROUND165: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
