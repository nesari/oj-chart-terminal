/**
 * test_round298_299_indicator_parity.mjs — built-in indicator parity with
 * TradingView, verified against the Pine scripts that ARE the built-ins.
 *
 * ROUND298 wrote this suite to compare two implementations: the hand-written
 * JavaScript library and the Pine engine. ROUND299 deleted the JavaScript
 * library (every built-in is a Pine script now), so a differential comparison
 * inside the app is no longer possible OR meaningful — there is one
 * implementation.
 *
 * What replaces it: each check below pins a CONFIRMED defect from the R298
 * audit against an INDEPENDENT expectation computed in this file (or against a
 * literal value read off TradingView's documented behaviour). That is a
 * stronger test than the old differential one: it cannot be satisfied by both
 * sides being wrong in the same way.
 *
 * The R298 audit's evidence is quoted in the assertions, so a future reader can
 * see what "wrong" looked like (Momentum 101.12 vs 0.0123, MFI 92.77 vs 91.29,
 * a flat-50 StochRSI line, a fake-zero HMA line, ...).
 *
 * Run: node tests/unit/test_round298_299_indicator_parity.mjs
 */

import { BUILTIN_BY_TYPE, BUILTIN_INDICATORS } from '../../src/core/pine/builtins-catalog.js';
import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' - ' + JSON.stringify(extra) : '')); }
};

/* deterministic tape with a real trend, wavy swing and varying volume */
function makeBars(n) {
  const out = [];
  let seed = 7, px = 1.1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  const t0 = 1790600400 - (1790600400 % 3600);
  for (let i = 0; i < n; i++) {
    const o = px;
    const c = o + Math.sin(i / 9) * 0.002 + rnd() * 0.0009;
    const h = Math.max(o, c) + Math.abs(rnd()) * 0.0004;
    const l = Math.min(o, c) - Math.abs(rnd()) * 0.0004;
    out.push({ time: t0 + i * 3600, open: o, high: h, low: l, close: c, volume: 100 + ((i * 37) % 211) });
    px = c;
  }
  return out;
}
const BARS = makeBars(400);

/* run a BUILT-IN's own script (this is what the app ships) */
function builtin(type, list, inputs) {
  const def = BUILTIN_BY_TYPE.get(type);
  if (!def) throw new Error('no builtin: ' + type);
  const c = compile(def.source);
  if (!c.ok) throw new Error(type + ' compile: ' + c.errors.map((e) => e.message).join(' | '));
  const rt = c.createInstance({ tfSec: 3600, symbol: 'EURUSD', mintick: 0.00001, serverOffSec: 0, inputValues: inputs || {} });
  rt.runAll(list || BARS);
  const byTitle = new Map();
  for (const k of rt.out.plotsOrder) {
    const p = rt.out.plots.get(k);
    if (!p.hiddenHline && p.display !== 'none') byTitle.set(p.title || k, p);
  }
  return {
    rt, plots: byTitle,
    values: (t) => (byTitle.get(t) || { values: [] }).values,
    fills: rt.out.fills || [],
  };
}

/* run an ad-hoc Pine script (for independent references) */
function pinery(src, list) {
  const c = compile(src);
  if (!c.ok) throw new Error('compile: ' + c.errors.map((e) => e.message).join(' | '));
  const rt = c.createInstance({ tfSec: 3600, symbol: 'EURUSD', mintick: 0.00001, serverOffSec: 0 });
  rt.runAll(list || BARS);
  const byTitle = new Map();
  for (const k of rt.out.plotsOrder) {
    const p = rt.out.plots.get(k);
    if (!p.hiddenHline && p.display !== 'none') byTitle.set(p.title || k, p);
  }
  return { rt, values: (t) => (byTitle.get(t) || { values: [] }).values };
}
const eq = (a, b) => a.length === b.length &&
  a.every((v, i) => (v == null && b[i] == null) || (v != null && b[i] != null && Math.abs(v - b[i]) < 1e-9));

/* ---------- 1. Momentum is a price DIFFERENCE, not a ratio ---------- */
console.log('\n[1] Momentum semantics (TV = close - close[n])');
{
  const got = builtin('momentum').values('Momentum');
  const ref = BARS.map((b, i) => (i >= 10 ? b.close - BARS[i - 10].close : null));
  ok(eq(got, ref), 'Momentum is close - close[10] (the old JS plotted close/close[10]*100)');
  ok(got[10] != null && Math.abs(got[10]) < 0.05, 'value is a price delta, not a ~101 index', got[10]);
  const roc = builtin('roc').values('Rate of Change');
  ok(roc[9] != null && Math.abs(roc[9]) < 5, 'Rate of Change keeps the percentage form', roc[9]);
  ok(eq(got.slice(10), pinery('//@version=6\nindicator("m")\nplot(ta.mom(close, 10), "Momentum")').values('Momentum').slice(10)),
    'Momentum equals ta.mom');
}

/* ---------- 2. A/D includes bar 0 ---------- */
console.log('\n[2] Accumulation/Distribution includes the first bar');
{
  const clv = (b) => {
    const r = b.high - b.low;
    return r === 0 ? 0 : ((b.close - b.low) - (b.high - b.close)) / r;
  };
  /* one asymmetric bar: close near the high, so bar 0 has clearly non-zero flow */
  const one = [{ time: 1790600400, open: 1.0, high: 1.2, low: 1.0, close: 1.19, volume: 100 }];
  const got = builtin('adline', one).values('A/D');
  ok(Math.abs(got[0] - clv(one[0]) * 100) < 1e-9,
    'bar 0 contributes its own CLV*volume (the old JS seeded a zero)', got[0]);
  ok(Math.abs(got[0]) > 1, 'the first value is not the old zero seed');

  /* cumulative reference over the whole tape */
  let acc = 0;
  const ref = BARS.map((b) => { acc += clv(b) * b.volume; return acc; });
  ok(eq(builtin('adline').values('A/D'), ref), 'A/D matches the cumulative CLV*volume reference');
}

/* ---------- 3. MFI uses the SOURCE as price and the bar's volume ---------- */
console.log('\n[3] MFI money flow');
{
  const got = builtin('mfi').values('MFI');
  const tp = BARS.map((b) => (b.high + b.low + b.close) / 3);
  const ref = new Array(BARS.length).fill(null);
  for (let i = 14; i < BARS.length; i++) {
    let pos = 0, neg = 0;
    for (let j = i - 13; j <= i; j++) {
      const flow = tp[j] * BARS[j].volume;
      if (tp[j] > tp[j - 1]) pos += flow; else if (tp[j] < tp[j - 1]) neg += flow;
    }
    ref[i] = (pos === 0 && neg === 0) ? null : (neg === 0 ? 100 : 100 - 100 / (1 + pos / neg));
  }
  ok(eq(got, ref), 'MFI matches an independent ignore-flat reference over the whole tape');
  ok(Math.abs(got[27] - 91.2856432075) < 1e-6,
    'reading at index 27 is the audited correct value (92.77 was the bug)', got[27]);
}

/* ---------- 4. na propagation: wma / hma ---------- */
console.log('\n[4] na poisons a window (no fabricated zeros)');
{
  ok(eq(builtin('wma').values('WMA'),
    pinery('//@version=6\nindicator("w")\nplot(ta.wma(close, 20), "WMA")').values('WMA')),
    'built-in WMA equals ta.wma');

  const hma = builtin('hma').values('HMA');
  ok(hma.slice(0, 24).every((v) => v == null),
    'HMA is blank before its warm-up (the old JS painted a fake 0 line)', hma.slice(0, 6));
  ok(hma[24] != null, 'HMA starts producing at index 24', hma[24]);
  ok(hma.every((v) => v == null || v !== 0), 'HMA never reports an exact 0.0 (the fake-zero signature)');

  /* a source that itself starts with na must not read as zero */
  const pna = pinery('//@version=6\nindicator("w")\nsrc = bar_index < 10 ? na : close\nplot(ta.wma(src, 5), "W")').values('W');
  ok(!pna.some((v, i) => i < 14 && v === 0), 'na inside a wma window yields na, never 0');
}

/* ---------- 5. zero-range oscillators are NA, not 50 / -50 ---------- */
console.log('\n[5] zero-range oscillators report na');
{
  const flat = BARS.map((b) => ({ time: b.time, open: 100, high: 100, low: 100, close: 100, volume: b.volume }));
  for (const [type, title] of [['stochastic', '%K'], ['willr', 'Williams %R'], ['stochrsi', '%K']]) {
    const v = builtin(type, flat).values(title);
    ok(v.every((x) => x == null), type + ': a flat tape is all na (the old JS invented 50 / -50)',
      v.filter((x) => x != null).slice(0, 3));
  }
  /* StochRSI must wait for a FULL window, never emit the old flat 50 */
  const sr = builtin('stochrsi').values('%K');
  ok(sr.slice(0, 27).every((x) => x == null),
    'StochRSI is blank until the full window exists (the old JS printed 50 from index 14)',
    sr.slice(0, 27).filter((x) => x != null).length);
  ok(sr[27] != null, 'StochRSI starts producing at index 27', sr[27]);
}

/* ---------- 6. VWAP is a value, not a function handle ---------- */
console.log('\n[6] VWAP');
{
  const v = builtin('vwap').values('VWAP');
  ok(v.every((x) => x != null && isFinite(x)), 'VWAP plots a number on every bar');
  ok(eq(v, pinery('//@version=6\nindicator("v")\nplot(ta.vwap, "VWAP")').values('VWAP')),
    'built-in VWAP equals bare ta.vwap');
  ok(eq(v, pinery('//@version=6\nindicator("v")\nplot(ta.vwap(hlc3), "VWAP")').values('VWAP')),
    'bare ta.vwap equals ta.vwap(hlc3)');
}

/* ---------- 7. SuperTrend up/down split ---------- */
console.log('\n[7] SuperTrend direction split');
{
  const up = builtin('supertrend').values('Up Trend');
  const dn = builtin('supertrend').values('Down Trend');
  ok(up.some((v) => v != null) && dn.some((v) => v != null), 'both up and down segments exist');
  ok(!up.some((v, i) => v != null && dn[i] != null), 'up and down never overlap on the same bar');
  const covered = up.filter((v) => v != null).length + dn.filter((v) => v != null).length;
  ok(covered > 350, 'nearly every warmed-up bar has a trend line', covered);
  /* ROUND302 (BUG: SuperTrend painted NOTHING): the kernel ratcheted the bands
     and tested the flip with the CURRENT bar's close instead of close[1], so
     the direction alternated every single bar. Each plot then held a 1-bar run
     surrounded by na, and a 1-bar linebr run paints zero pixels. The trend is a
     state that must PERSIST across bars — assert that directly. */
  const runLen = (arr) => {
    let best = 0, cur = 0, runs = 0;
    for (const v of arr) { if (v == null) { if (cur) runs++; if (cur > best) best = cur; cur = 0; } else cur++; }
    if (cur) { runs++; if (cur > best) best = cur; }
    return { best, runs };
  };
  const ru = runLen(up), rd = runLen(dn);
  ok(ru.best > 8 && rd.best > 8, 'each trend segment holds for many bars (not one bar)',
    { up: ru, dn: rd });
  ok(ru.runs + rd.runs < 120, 'the direction flips a sane number of times, not every bar',
    ru.runs + rd.runs);
  /* the line satisfies the defining property: below price in an uptrend */
  let bad = 0;
  for (let i = 0; i < BARS.length; i++) {
    if (up[i] != null && !(up[i] <= BARS[i].close + 1e-9)) bad++;
    if (dn[i] != null && !(dn[i] >= BARS[i].close - 1e-9)) bad++;
  }
  ok(bad === 0, 'up segment sits at/below price, down segment at/above', bad);
}

/* ---------- 8. Parabolic SAR: TV fractions, two-bar clamp ---------- */
console.log('\n[8] Parabolic SAR');
{
  const sar = builtin('sar').values('Parabolic SAR');
  ok(sar[0] == null, 'index 0 is blank (needs a prior bar)');
  ok(sar[1] != null, 'first dot at index 1', sar[1]);

  /* the script takes TV acceleration fractions as-is (0.02/0.02/0.2) */
  const ref = pinery('//@version=6\nindicator("s")\nplot(ta.sar(0.02, 0.02, 0.2), "Parabolic SAR")').values('Parabolic SAR');
  ok(eq(sar, ref), 'built-in SAR equals ta.sar(0.02, 0.02, 0.2)');

  /* uptrend dots never sit above the LOW of the two prior bars */
  let violated = 0;
  for (let i = 2; i < BARS.length; i++) {
    const v = sar[i];
    if (v == null) continue;
    if (v < BARS[i].close) {
      const bound = Math.min(BARS[i - 1].low, BARS[i - 2].low);
      if (v > bound + 1e-12) violated++;
    }
  }
  ok(violated === 0, 'in an uptrend SAR stays <= min(prior two lows) (the TV clamp)', violated);

  /* the defaults in the dialog are fractions, not percentages */
  const c = compile(BUILTIN_BY_TYPE.get('sar').source);
  const ci = c.collectInputs({ tfSec: 60, symbol: 'T', mintick: 0.01 });
  const byTitle = new Map(ci.inputs.map((d) => [d.title, d]));
  ok(byTitle.get('Start').defval === 0.02, 'Start default is 0.02 (the old JS dialog said 2)', byTitle.get('Start').defval);
  ok(byTitle.get('Increment').defval === 0.02, 'Increment default is 0.02', byTitle.get('Increment').defval);
  ok(byTitle.get('Max').defval === 0.2, 'Max default is 0.2', byTitle.get('Max').defval);
}

/* ---------- 9. band fills and histogram colouring exist in the scripts ---- */
console.log('\n[9] channel bands and histogram colouring');
{
  for (const [type, titles] of [
    ['bollinger', ['Upper', 'Basis', 'Lower']],
    ['donchian', ['Upper', 'Basis', 'Lower']],
    ['keltner', ['Upper', 'Basis', 'Lower']],
  ]) {
    const b = builtin(type);
    for (const t of titles) ok(b.plots.has(t), type + ': plot "' + t + '" exists');
    ok(b.fills.length >= 1, type + ': declares a fill() band (the old JS computed one and never painted it)',
      b.fills.length);
    const up = b.values('Upper'), lo = b.values('Lower');
    ok(up.every((v, i) => v == null || lo[i] == null || v >= lo[i]), type + ': upper is never below lower');
  }
  /* MACD colours its histogram by sign, Volume by candle direction */
  const macd = builtin('macd');
  const hist = macd.plots.get('Histogram');
  ok(hist && hist.style === 'columns', 'MACD histogram is a column plot', hist && hist.style);
  ok(macd.values('MACD').some((v) => v > 0) && macd.values('MACD').some((v) => v < 0),
    'MACD has both signs to colour');

  const vol = builtin('volume');
  const vp = vol.plots.get('Volume');
  ok(vp && vp.style === 'columns', 'Volume is a column plot', vp && vp.style);
  /* per-bar colours must differ (up candles vs down candles) */
  const cols = (vp.colors || []).filter(Boolean).map((c) => c.css());
  ok(new Set(cols).size >= 2, 'Volume supplies at least two distinct bar colours', new Set(cols).size);
}

/* ---------- 10. the catalog is complete and self-consistent ---------- */
console.log('\n[10] catalog completeness');
{
  ok(BUILTIN_INDICATORS.length === 27, 'exactly 27 built-in indicators', BUILTIN_INDICATORS.length);
  const types = new Set(BUILTIN_INDICATORS.map((d) => d.type));
  ok(types.size === 27, 'every type is unique', types.size);
  const ids = new Set(BUILTIN_INDICATORS.map((d) => d.id));
  ok(ids.size === 27 && [...ids].every((i) => i.startsWith('builtin:')), 'every script id is a unique builtin: id');

  const expected = ['sma', 'ema', 'wma', 'hma', 'bollinger', 'donchian', 'keltner', 'envelopes', 'vwap',
    'sar', 'supertrend', 'ichimoku', 'rsi', 'macd', 'stochastic', 'stochrsi', 'willr', 'cci', 'atr',
    'stddev', 'momentum', 'roc', 'awesome', 'volume', 'obv', 'mfi', 'adline'];
  const missing = expected.filter((t) => !types.has(t));
  ok(missing.length === 0, 'all 27 legacy types are covered (no indicator lost in the conversion)', missing);

  let allCompile = true;
  for (const d of BUILTIN_INDICATORS) {
    const c = compile(d.source);
    if (!c.ok) { allCompile = false; console.log('    compile failed: ' + d.type + ' -> ' + c.errors[0].message); }
  }
  ok(allCompile, 'every built-in script compiles');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
