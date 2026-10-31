/**
 * ROUND264 - trade-alert switches actually gate the fill alert.
 *
 * The Alerts panel exposes three per-type switches ("Pending order
 * activated", "Stop loss hit", "Take profit hit") plus a master switch.
 * The SL/TP monitor honoured them (cfg.onSL / cfg.onTP / cfg.enabled), and
 * setItem() happily stored cfg.onFill — but NOTHING ever read cfg.onFill:
 * both 'fill' paths in _diff() called _fire() without { silent } and always
 * toasted + rang the alert sound. Turning "Pending order activated" off (or
 * the master switch) still produced a loud activation alert.
 *
 * Pins:
 *  1. every 'fill' fire in _diff() is silent unless BOTH switches are on;
 *  2. SL/TP keep their existing gating (no regression);
 *  3. the event is still RECORDED when silent (notification list history);
 *  4. no ungated 'fill' fire remains.
 *
 * The module needs renderer/DOM globals, so this suite reads the source the
 * same way the other UI-contract suites do.
 *
 * Run: node tests/unit/test_round264_trade_alerts.mjs
 */
import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' - ' + JSON.stringify(extra) : '')); }
};

const src = readSource('src/renderer/js/trade/alerts.js');
const iDiff = src.indexOf('_diff() {');
const iTick = src.indexOf('_onTick(sym) {');
const iFire = src.indexOf('_fire(type, info, opts) {');
ok(iDiff > 0 && iTick > iDiff && iFire > iTick, 'located _diff()/_onTick()/_fire()',
  { iDiff, iTick, iFire });

const diff = iDiff > 0 ? src.slice(iDiff, iTick) : '';
const fire = iFire > 0 ? src.slice(iFire) : '';

console.log('\n[1] fill fires honour the switches');
{
  const fills = diff.match(/_fire\('fill'[\s\S]*?\);/g) || [];
  ok(fills.length === 2, 'both fill paths are present (orders-gone + fast fill)', fills.length);
  ok(fills.every((f) => f.includes('silent: !(this.cfg.enabled && this.cfg.onFill)')),
    'each fill is silent unless master AND onFill are on', fills);
  ok(!/_fire\('fill',[^\n]*\);\s*$/m.test(diff), 'no ungated fill fire remains');
}

console.log('\n[2] SL/TP gating unchanged');
{
  ok(src.includes("if (this.cfg.onSL) this._fire('sl'"), 'onSL still gates the SL toast');
  ok(src.includes("if (this.cfg.onTP) this._fire('tp'"), 'onTP still gates the TP toast');
  ok((src.match(/this\.cfg\.enabled/g) || []).length >= 2, 'master switch still gates SL/TP');
}

console.log('\n[3] silent still records');
{
  const iLog = fire.indexOf('this.log.unshift(ev)');
  const iGate = fire.indexOf('if (!(opts && opts.silent))');
  ok(iLog > 0 && iGate > iLog, 'the event is logged before the silent gate');
  ok(fire.includes('this._logEvent(ev)'), 'the persistent notification list still receives it');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
