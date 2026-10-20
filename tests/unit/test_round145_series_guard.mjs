import { readSource } from './source-utils.mjs';
/**
 * test_round145_series_guard.mjs — ROUND145 "Value is null" hunt
 *
 * Run: node tests/unit/test_round145_series_guard.mjs
 *
 * The LWC "Value is null" spam surfaced only as a vendor stack. The fix is
 * a last-line gate: core firstBadRow() (pure, tested here) + manager
 * seriesWriteOk() wired into every main-series write (wiring asserted
 * structurally below).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { firstBadRow } from '../../src/core/util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = (p) => readSource(p);

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ FAIL: ' + label); }
};

const C = (o) => Object.assign({ time: 1790600000, open: 1, high: 2, low: 0.5, close: 1.5 }, o);

ok(firstBadRow([]) === -1, 'empty array clean');
ok(firstBadRow(null) === -1, 'non-array clean');
ok(firstBadRow([C(), C({ close: 2 })]) === -1, 'valid candles clean');
ok(firstBadRow([C(), C({ close: null })]) === 1, 'null close flagged with index');
ok(firstBadRow([C({ open: NaN })]) === 0, 'NaN open flagged');
ok(firstBadRow([C({ high: undefined })]) === 0, 'undefined high flagged');
ok(firstBadRow([C({ low: '1.5' })]) === 0, 'string low flagged');
ok(firstBadRow([{ time: 1 }, { time: 2 }]) === -1, 'whitespace gap rows ({time}-only) legal');
ok(firstBadRow([{ time: 1, value: 5 }]) === -1, 'line rows legal');
ok(firstBadRow([{ time: 1, value: null }]) === 0, 'null line value flagged');
ok(firstBadRow([C({ time: 'x' })]) === 0, 'bad time flagged');
ok(firstBadRow([C(), null]) === 1, 'null row element flagged');
ok(firstBadRow([C({ open: 1, extra: 's', color: '#fff' })]) === -1, 'extra keys (hollow colors) ignored');

const mgr = SRC('src/renderer/js/chart/manager.js');
ok(mgr.includes('Manager.seriesWriteOk = seriesWriteOk'), 'gate exported on Manager');
for (const site of ['renko-setData', "'setData'", 'tick-update']) {
  ok(mgr.includes(site), 'gate wired at ' + site);
}
ok(mgr.includes('poisoned bar in pane store'), 'store watchdog in axisGuard');
const sess = SRC('src/renderer/js/panels/session.js');
ok(sess.includes('session-setData'), 'gate wired at session stitching');
const facade = SRC('src/renderer/js/core/util.js');
ok(facade.includes('firstBadRow'), 'pure helper re-exported through the renderer facade');

console.log('\nROUND145: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
