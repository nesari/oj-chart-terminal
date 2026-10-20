/**
 * ROUND84 verification harness — plain Node (>=18), no DOM, no dependencies.
 * Run:  node scripts/round84_harness.mjs
 *
 * Verifies the round-84 corrections that are verifiable headless:
 *
 * A) FEAT-84-G — ALL built-in indicators across multiple timeframe datasets:
 *    - no throw, values aligned with bars (length match), no NaN leaks
 *    - TF-SWITCH cycle (M15 -> H2 -> D1 -> M15): re-computing the same
 *      dataset must be IDENTICAL (pure compute — catches any hidden per-TF
 *      state that would make an indicator wrong after a timeframe switch)
 *    - MULTI-CHART: two symbols computed alternately stay independent
 *
 * B) BUG-84-A invariant — the fixed renderer bucketStartFor (ported verbatim
 *    from chart/manager.js) must agree with the provider's bucket_start
 *    (ported from provider_common.py — the anchor of MT5/demo history and
 *    of the S/M45/MN aggregation) for EVERY timeframe x broker offset.
 *    The old off-shifted math violated exactly this on GMT+3 brokers
 *    (H2 = 1h shift -> phantom "just opened" live candle + wrong countdown).
 *
 * C) BUG-84-A live-fold simulation on a GMT+3 broker (H2): provider history
 *    (server-label anchored, real forming bar included) + tick stream through
 *    the renderer's fold rules -> the tick folds into the REAL forming bar,
 *    the countdown equals the real remaining time (the user's 00:45:17 case),
 *    and the OLD math provably produced the 1h phantom shift.
 *
 * core/ is platform-agnostic (zero DOM) but the app package.json has no
 * "type": "module", so the harness copies src/core into a temp dir with an
 * ESM package.json — the project tree stays untouched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'round84-core-'));
fs.cpSync(path.join(ROOT, 'src', 'core'), tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const { Indicators } = await import(pathToFileURL(path.join(tmp, 'indicators.js')).href);

process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

/* ---------- synthetic bars (server-label stamps, like the provider) ------- */
function genBars(tfSec, n, endWall, seed = 42, base = 2400) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const bars = [];
  let px = base;
  for (let i = n; i >= 1; i--) {
    const t = endWall - tfSec * i; // bucket-aligned server-label open times
    const o = px;
    const c = o + (rnd() - 0.5) * base * 0.004;
    const h = Math.max(o, c) + rnd() * base * 0.002;
    const l = Math.min(o, c) - rnd() * base * 0.002;
    bars.push({ time: t, open: o, high: h, low: l, close: c, volume: Math.round(100 + rnd() * 4000) });
    px = c;
  }
  return bars;
}

const NOW = 1758000000; // fixed "now" epoch (server-label) for determinism
const DATASETS = {
  M15: genBars(900, 600, NOW - (NOW % 900)),
  H2: genBars(7200, 400, NOW - (NOW % 7200)),
  D1: genBars(86400, 300, NOW - (NOW % 86400)),
};

/* ---------- A: every indicator, every dataset ------------------------------ */
let checks = 0;
const firstPass = new Map(); // type -> results per dataset (for the switch cycle)

for (const def of Indicators.all) {
  for (const [tfName, bars] of Object.entries(DATASETS)) {
    const inst = { id: 1, type: def.type, params: {}, colors: {}, visible: true };
    let out = null;
    try {
      out = Indicators.compute(inst, bars);
    } catch (e) {
      assert.fail(`indicator ${def.type} threw on ${tfName}: ${e.stack || e}`);
    }
    assert.ok(out && Array.isArray(out.lines), `${def.type}: no lines`);
    for (const ln of out.lines) {
      assert.strictEqual(ln.values.length, bars.length, `${def.type}/${tfName}: line length mismatch`);
      for (let i = 0; i < ln.values.length; i++) {
        const v = ln.values[i];
        assert.ok(v === null || v === undefined || (typeof v === 'number' && isFinite(v)),
          `${def.type}/${tfName}: non-finite value at ${i}: ${v}`);
      }
    }
    if (out.hist) {
      assert.strictEqual(out.hist.values.length, bars.length, `${def.type}/${tfName}: hist length mismatch`);
    }
    for (const lv of out.levels || []) assert.ok(isFinite(lv.value), `${def.type}: bad level`);
    checks++;
    if (!firstPass.has(def.type)) firstPass.set(def.type, {});
    firstPass.get(def.type)[tfName] = JSON.stringify(out);
  }
}

/* TF-switch cycle: M15 -> H2 -> D1 -> M15 again; the final M15 result must be
   byte-identical to the first (no state leaks between timeframe datasets) */
for (const def of Indicators.all) {
  const inst = { id: 1, type: def.type, params: {}, colors: {}, visible: true };
  Indicators.compute(inst, DATASETS.H2);
  Indicators.compute(inst, DATASETS.D1);
  const again = JSON.stringify(Indicators.compute(inst, DATASETS.M15));
  assert.strictEqual(again, firstPass.get(def.type).M15,
    `${def.type}: state leak across TF switch (M15 result changed after H2/D1)`);
  checks++;
}

/* multi-chart: two symbols alternate; results stay independent & identical */
const symA = DATASETS.H2;
const symB = genBars(7200, 400, NOW - (NOW % 7200), 777, 1.0850);
for (const def of Indicators.all) {
  const i1 = { id: 1, type: def.type, params: {}, colors: {}, visible: true };
  const i2 = { id: 2, type: def.type, params: {}, colors: {}, visible: true };
  JSON.stringify(Indicators.compute(i1, symA));
  JSON.stringify(Indicators.compute(i2, symB));
  const r1 = JSON.stringify(Indicators.compute(i1, symA));
  assert.strictEqual(r1, firstPass.get(def.type).H2, `${def.type}: cross-chart contamination on symbol A`);
  checks++;
}

/* ---------- B: bucket-anchor proof (renderer vs provider) ------------------ */
/* ported VERBATIM from src/renderer/js/chart/manager.js (ROUND84 fixed) */
function bucketStartFor(tf, t) {
  if (!tf.custom) {
    if (tf.id === 'D1') return t - (((t % 86400) + 86400) % 86400);
    if (tf.id === 'W1') { const day = (Math.floor(t / 86400) + 4) % 7; return (Math.floor(t / 86400) - day) * 86400; }
    if (tf.id.startsWith('MN')) {
      const d = new Date(t * 1000);
      let m = d.getUTCMonth();
      if (tf.id === 'MN3') m -= m % 3;
      else if (tf.id === 'MN6') m -= m % 6;
      else if (tf.id === 'MN12') m = 0;
      return Math.floor(Date.UTC(d.getUTCFullYear(), m, 1) / 1000);
    }
    return t - (((t % tf.sec) + tf.sec) % tf.sec);
  }
  return t - (((t % tf.sec) + tf.sec) % tf.sec); // custom intraday simplification for the sweep
}
/* ported from provider/provider_common.py bucket_start (the aggregation
   anchor for S-TFs, M45, MN3/6/12 — and the demo history generator) */
function providerBucketStart(tfId, t) {
  const TF_SEC = { S1: 1, S5: 5, S15: 15, S30: 30, M1: 60, M3: 180, M5: 300, M15: 900, M30: 1800, M45: 2700,
    H1: 3600, H2: 7200, H3: 10800, H4: 14400, D1: 86400, W1: 604800, MN1: 2592000 };
  if (tfId === 'W1') { const day = (Math.floor(t / 86400) + 4) % 7; return (Math.floor(t / 86400) - day) * 86400; }
  if (tfId === 'MN1') { const d = new Date(t * 1000); return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000); }
  const sec = TF_SEC[tfId];
  return t - (((t % sec) + sec) % sec);
}
const TFS = ['S1', 'S5', 'M1', 'M5', 'M15', 'M30', 'M45', 'H1', 'H2', 'H3', 'H4', 'D1', 'W1', 'MN1'];
const OFFS = [0, 3600, 7200, 10800, 12600, 14400, -18000]; // UTC .. GMT+3:30 .. GMT-5
let bucketChecks = 0;
for (const off of OFFS) {
  for (let k = 0; k < 4000; k++) {
    const t = 1700000000 + k * 997; // spread across days/boundaries
    const stamp = t + off;          // server-label pseudo stamp (what ticks/bars carry)
    for (const id of TFS) {
      const sec = { S1: 1, S5: 5, M1: 60, M5: 300, M15: 900, M30: 1800, M45: 2700, H1: 3600, H2: 7200, H3: 10800, H4: 14400, D1: 86400, W1: 604800, MN1: 2592000 }[id];
      const fixed = bucketStartFor({ custom: false, id, sec }, stamp);
      const prov = providerBucketStart(id, stamp);
      assert.strictEqual(fixed, prov, `bucket mismatch off=${off} tf=${id} t=${t}`);
      bucketChecks++;
    }
  }
}

/* ---------- C: live-fold simulation (GMT+3 broker, H2) --------------------- */
/* provider history: server-label anchored, INCLUDING the real forming bar */
const OFF = 10800; // GMT+3 broker (the user's case)
const H2 = 7200;
/* mirror the user's screenshot: server label 17:14:43 -> bucket 16:00-18:00,
   elapsed 1:14:43, MT5 countdown 00:45:17 (UTC now = 14:14:43 same day) */
const dayStartUtc = 1700000000 - (1700000000 % 86400);
const trueNowUtc = dayStartUtc + 14 * 3600 + 14 * 60 + 43;
const nowSrv = trueNowUtc + OFF;                            // server wall now (17:14:43 label)
const realFormingOpen = nowSrv - ((nowSrv % H2 + H2) % H2); // MT5 forming bar open (server wall)
const elapsedReal = nowSrv - realFormingOpen;               // 1:14:43 into the bucket
const hist = [];
for (let i = 300; i >= 1; i--) {
  const t = realFormingOpen - H2 * i;
  hist.push({ time: t, open: 2400, high: 2401, low: 2399, close: 2400.5, volume: 10 });
}
const forming = { time: realFormingOpen, open: 2400, high: 2410, low: 2395, close: 2408, volume: 900 };
const bars = hist.concat([forming]); // provider sends the real forming bar

/* the renderer's onTick fold (ROUND84 fixed math): bt === last.time -> fold */
const tickTime = nowSrv; // tick stamped server_now() = server label
const bt = bucketStartFor({ custom: false, id: 'H2', sec: H2 }, tickTime);
const last = bars[bars.length - 1];
assert.strictEqual(bt, last.time, 'ROUND84: tick bucket must equal the REAL forming bar open');
assert.strictEqual(elapsedReal > H2 / 2, true, 'sanity: we are deep into the bucket');

/* the OLD buggy math (off-shift) must REPRODUCE the user's bug — proving the
   model: bt_old lands one hour after the real forming open on GMT+3/H2 */
const btOld = (() => { const s = tickTime - OFF; return (s - ((s % H2) + H2) % H2) + OFF; })();
assert.strictEqual(btOld - last.time, 3600, 'old math: expected the 1h phantom shift');
assert.strictEqual(bucketStartFor({ custom: false, id: 'H2', sec: H2 }, tickTime) + H2 - tickTime,
  H2 - elapsedReal, 'countdown now matches the real remaining time (MT5 semantics)');
assert.strictEqual(H2 - elapsedReal, 45 * 60 + 17, 'the user\'s exact screenshot case: 00:45:17 remaining');

console.log(`ROUND84 HARNESS OK — indicator checks: ${checks}, bucket-anchor checks: ${bucketChecks}`);
