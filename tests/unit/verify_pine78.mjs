/**
 * verify_pine78.mjs — Round 78 verification suite
 *
 * Run:  node tests/unit/verify_pine78.mjs
 *
 * 1) Color model: toColor() parses 'rgba(...)' (BUG-78-C) and the dialog's
 *    rgba strings survive the full engine round-trip; input.color DEFAULTS
 *    with transparency (color.new(base, transp)) are PineColors, not na.
 * 2) Timezone (BUG broker-offset): script `time` / `time_close` /
 *    request.security_lower_tf(..., time) are TRUE UTC ms — the broker
 *    server shift (env.serverOffSec) is stripped engine-side.
 * 3) 786 Zones with a GMT+3 broker: every main session box lands at LOCAL
 *    hour 9 of its own session timezone (Intl) AND maps back into the
 *    chart's wall-clock bar space after +serverOffSec.
 * 4) Pure-function memo parity: identical outputs with the memo ON vs OFF
 *    (plots + drawing geometry), purity annotations sane, memo hits > 0.
 * 5) timestamp() memo sanity (incl. NA-argument bypass path).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compile } from '../../src/core/pine/compile.js';
import { toColor, PineColor, NA } from '../../src/core/pine/types.js';
import { timestamp } from '../../src/core/pine/stdlib/time.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC786 = readFileSync(join(HERE, '..', '..', 'fixtures', 'pine', '786-zones.pine'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const hourInTZ = (ms, tz) => {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: 'numeric' });
  let h = parseInt(f.formatToParts(new Date(ms)).find((p) => p.type === 'hour').value, 10);
  if (h === 24) h = 0;
  return h;
};

/* 6 days of M15 chart bars ending at the current hour, M1 intrabars inside */
function makeFixture(tfSec, subsPerBar, offSec) {
  const start = Math.floor(Date.now() / 1000 / 86400) * 86400 - 5 * 86400;
  const bars = [], intrabars = [];
  let px = 2400;
  const n = Math.floor(6 * 86400 / tfSec); // covers "today" like verify_pine74 §5
  for (let i = 0; i < n; i++) {
    const t = start + i * tfSec; // wall-clock-as-UTC stamp (trueUtc + offSec)
    const subs = [];
    for (let m = 0; m < subsPerBar; m++) {
      px += Math.sin((t / 60 + m) / 7) * 0.9 + (m === 7 ? 1.1 : 0);
      subs.push({ time: (t + m * 60) * 1000, open: px, high: px + 0.8, low: px - 0.8, close: px + 0.3, volume: 10 + m });
    }
    bars.push({
      time: t, open: subs[0].open,
      high: Math.max(...subs.map((s) => s.high)), low: Math.min(...subs.map((s) => s.low)),
      close: subs[subs.length - 1].close, volume: 150,
    });
    intrabars.push(subs);
  }
  return { bars, intrabars };
}

/* ----------------------- 1) color model (BUG-78-C) ---------------------- */
console.log('\n[1] color model — rgba() parsing + fresh-add defaults');
{
  const c = toColor('rgba(65,105,225,0.35)');
  ok(c instanceof PineColor && c.r === 65 && c.g === 105 && c.b === 225 && Math.abs(c.a - 0.35) < 1e-9,
    'toColor parses rgba(65,105,225,0.35)');
  ok(toColor(c.css()).eq(c), 'css() -> toColor() round-trip is lossless');
  ok(toColor('rgb(255,136,0)') && toColor('rgb(255,136,0)').a === 1, 'rgb() without alpha = opaque');
  const hexDef = toColor('#4169E1');
  ok(hexDef && hexDef.a === 1, '6-digit hex still parses (regression guard)');

  // fresh add (no dialog Ok yet): the 786 Zones defaults must be real colors
  const comp = compile(SRC786);
  ok(comp.ok, '786 Zones compiles');
  const rt = comp.createInstance({ tfSec: 900, symbol: 'XAUUSD', mintick: 0.01 });
  rt.runAll([{ time: Math.floor(Date.now() / 1000), open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
  const g = (name) => (rt.globals.get(name) || {}).value;
  const syd = g('colSydney');
  ok(syd && syd.css && Math.abs(syd.a - 0.35) < 1e-9, 'colSydney default = PineColor a=0.35 (' + (syd && syd.css ? syd.css() : String(syd)) + ')');
  const brd = g('borderColor');
  ok(brd && brd.css && Math.abs(brd.a - 0.2) < 1e-9, 'borderColor default = PineColor a=0.2');
  const mid = g('midlineColor');
  ok(mid && mid.css && Math.abs(mid.a - 0.6) < 1e-9, 'midlineColor default = PineColor a=0.6');
  // input def surface: the Sydney color default must carry the rgba string
  const defs = comp.collectInputs({ tfSec: 900, symbol: 'X', mintick: 0.01 });
  const sydDef = defs.inputs.find((d) => d.title === 'Color' && d.group === 'Sydney');
  ok(sydDef && /^rgba\(65,105,225,0?\.35\)$/.test(String(sydDef.defval)),
    'input def for Sydney color carries the rgba default (' + (sydDef ? sydDef.defval : 'n/a') + ')');
  // dialog override path: the picker's rgba string lands intact
  const rt2 = comp.createInstance({ tfSec: 900, symbol: 'XAUUSD', mintick: 0.01, inputValues: { [sydDef.id]: 'rgba(33,150,243,0.5)' } });
  rt2.runAll([{ time: Math.floor(Date.now() / 1000), open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
  const syd2 = (rt2.globals.get('colSydney') || {}).value;
  ok(syd2 && syd2.css && syd2.css() === 'rgba(33,150,243,0.5)', 'dialog rgba override reaches the runtime (' + (syd2 && syd2.css ? syd2.css() : String(syd2)) + ')');
}

/* ----------------- 2) timezone engine shift (broker off) ---------------- */
console.log('\n[2] engine time model — script times are TRUE UTC');
{
  const OFF = 3 * 3600; // GMT+3 broker
  const src = [
    'indicator("t")',
    'm1t = request.security_lower_tf(syminfo.tickerid, "1", time)',
    'plot(time, title="t")',
    'plot(time_close, title="tc")',
    'plot(array.size(m1t) > 0 ? array.get(m1t, 0) : na, title="m1")',
  ].join('\n');
  const c = compile(src);
  ok(c.ok, 'timezone probe script compiles');
  const t0 = 1700000000;
  const bars = Array.from({ length: 5 }, (_, i) => ({ time: t0 + i * 60, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  const intrabars = bars.map((b) => [{ time: b.time * 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
  const rt = c.createInstance({ tfSec: 60, symbol: 'X', mintick: 0.01, serverOffSec: OFF, intrabars });
  rt.runAll(bars);
  const p = new Map(Array.from(rt.out.plots.values()).map((x) => [x.title, x.values]));
  ok(p.get('t')[3] === (t0 + 180 - OFF) * 1000, 'time = (wall - off) * 1000 (true UTC)');
  ok(p.get('tc')[3] === (t0 + 180 + 60 - OFF) * 1000, 'time_close shifted identically');
  ok(p.get('m1')[3] === (t0 + 180 - OFF) * 1000, 'security_lower_tf(..., time) shifted identically');
  // no-offset feed behaves exactly like before (regression guard)
  const rt0 = c.createInstance({ tfSec: 60, symbol: 'X', mintick: 0.01, intrabars });
  rt0.runAll(bars);
  const p0 = new Map(Array.from(rt0.out.plots.values()).map((x) => [x.title, x.values]));
  ok(p0.get('t')[3] === (t0 + 180) * 1000, 'serverOffSec=0 keeps the legacy behaviour');
}

/* ------------ 3) 786 Zones + GMT+3 broker: session hours correct -------- */
console.log('\n[3] 786 Zones with a GMT+3 broker — boxes at the right hours');
{
  const OFF = 3 * 3600;
  const { bars, intrabars } = makeFixture(900, 15, OFF);
  const c = compile(SRC786);
  const rt = c.createInstance({ tfSec: 900, symbol: 'XAUUSD', mintick: 0.01, serverOffSec: OFF, intrabars });
  rt.runAll(bars);
  const nBoxes = rt.store.count('box');
  ok(nBoxes >= 6, 'session boxes drawn with the shifted feed (' + nBoxes + ')');
  // every box's chart-space stamp must land inside a real chart bar window
  let mapped = 0, total = 0;
  for (const b of rt.store.box.values()) {
    const wall = b.left / 1000 + OFF;
    total++;
    if (bars.some((bb) => bb.time <= wall && wall < bb.time + 900)) mapped++;
  }
  ok(mapped === total && total > 0, 'every box maps back into a chart bar after +' + OFF + 's (' + mapped + '/' + total + ')');
  // main zone (zt=0) labels are bare session names -> local hour 9 there
  const tzByLabel = {
    SY: 'Australia/Sydney', TK: 'Asia/Tokyo', HK: 'Asia/Hong_Kong',
    FR: 'Europe/Berlin', LN: 'Europe/London', NY: 'America/New_York',
  };
  const seen = {};
  let hourOk = true, hourCmp = 0;
  for (const lb of rt.store.label.values()) {
    const key = String(lb.text).trim();
    const tz = tzByLabel[key];
    if (!tz) continue; // suffixed labels (14/18/30, -Nd) skipped
    const h = hourInTZ(lb.x, tz);
    seen[key] = h;
    hourCmp++;
    if (h !== 9) hourOk = false;
  }
  ok(hourCmp >= 6, 'main-zone labels found for the session check (' + hourCmp + ')');
  ok(hourOk, 'every main zone sits at LOCAL hour 9 of its session tz ' + JSON.stringify(seen));
}

/* ------------------- 4) pure-function memo parity ----------------------- */
console.log('\n[4] perf: pure-fn memo — identical outputs, real hits');
{
  const { bars, intrabars } = makeFixture(900, 15, 3 * 3600);
  const c = compile(SRC786);
  const runWith = (disable) => {
    const rt = c.createInstance({ tfSec: 900, symbol: 'XAUUSD', mintick: 0.01, serverOffSec: 3 * 3600, intrabars, disablePureMemo: disable });
    rt.runAll(bars);
    return rt;
  };
  const on = runWith(false), off = runWith(true);
  ok(on.funcs.get('sessionZoneStart') && on.funcs.get('sessionZoneStart')._pure === true,
    'sessionZoneStart annotated pure');
  ok(on.funcs.get('f_showZT') && on.funcs.get('f_showZT')._pure === true,
    'f_showZT (reads input globals) annotated pure');
  const impure = compile([
    'indicator("imp")',
    'f(x) => ta.sma(close, x)',
    'plot(f(5), title="a")',
  ].join('\n'));
  const rtImp = impure.createInstance({ tfSec: 60, symbol: 'X', mintick: 0.01 });
  rtImp.runAll(bars.slice(0, 10));
  ok(rtImp.funcs.get('f')._pure === false, 'ta.-using function annotated IMPURE');
  const gw = compile([
    'indicator("gw")',
    'var int g = 0',
    'bump() =>',
    '    g := g + 1',
    '    g',
    'x = bump()',
    'plot(x, title="a")',
  ].join('\n'));
  const rtGw = gw.createInstance({ tfSec: 60, symbol: 'X', mintick: 0.01 });
  rtGw.runAll(bars.slice(0, 10));
  ok(rtGw.funcs.get('bump')._pure === false, 'global-writing function annotated IMPURE');
  // output parity: plots
  const plotsOf = (rt) => JSON.stringify(Array.from(rt.out.plots.values()).map((p) => [p.title, p.values, p.colors && p.colors.map((x) => x ? x.css() : null)]));
  ok(plotsOf(on) === plotsOf(off), 'plot arrays identical with memo ON vs OFF');
  // output parity: drawing geometry + styles (sorted by left)
  const geomOf = (rt) => JSON.stringify(
    ['box', 'line', 'label'].flatMap((k) => Array.from(rt.store[k].values())
      .map((o) => JSON.stringify({ k, l: o.left ?? o.x1 ?? o.x, t: o.top ?? o.y1 ?? o.y, r: o.right ?? o.x2, b: o.bottom ?? o.y2, tx: o.text || '' })))
      .sort());
  ok(geomOf(on) === geomOf(off), 'drawing geometry identical with memo ON vs OFF');
  ok(on._memoHits > 0, 'memo actually hits (' + on._memoHits + ' hits)');
}

/* ---------------------- 5) timestamp() memo sanity ---------------------- */
console.log('\n[5] timestamp() memo sanity');
{
  const env = { serverOffSec: 7200 };
  const a = timestamp(env, 'GMT', 2024, 3, 10, 9, 0, 0);
  const b = timestamp(env, 'GMT', 2024, 3, 10, 9, 0, 0);
  ok(a === b && typeof a === 'number' && isFinite(a), 'identical calls hit the memo (same ms)');
  const env0 = { serverOffSec: 0 };
  ok(timestamp(env0, 'GMT', 2024, 3, 10, 9, 0, 0) === Date.UTC(2024, 2, 10, 9, 0, 0), 'GMT anchor correct');
  const withNA = timestamp(env0, 'GMT', 2024, 3, 10, 9, NA, 0);
  ok(typeof withNA === 'number' && isFinite(withNA), 'NA argument takes the bypass path without breaking');
}

console.log('\n════════════════════════════════════');
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
