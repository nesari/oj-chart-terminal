/**
 * ROUND263 - Pine per-instance persistence contract.
 *
 * Two user choices were not saved with the layout / across restarts:
 *  1. an explicit "Chart" pick in the Indicator Timeframe dropdown
 *     (inst.timeframe === '' + inst._tfTouched) — after restore the flag was
 *     gone, so a declaration timeframe="..." silently won again;
 *  2. strategy Properties (capital, qty type/value, commission, slippage,
 *     margins, magnifier, process-on-close) — serialize() never wrote
 *     inst.strategyProps, so every restart reverted the backtest to the
 *     script's declaration literals.
 *
 * The runtime module needs window/DOM, so (like the other UI-contract suites)
 * this pins the serialize/restore text and the flag mapping `tfTouched` ->
 * `_tfTouched`. Both values are JSON-cloned, never shared by reference.
 *
 * Run: node tests/unit/test_round263_pine_persist.mjs
 */
import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' - ' + JSON.stringify(extra) : '')); }
};

const src = readSource('src/renderer/js/chart/pine-ui/runtime.js');
const iSer = src.indexOf('serialize(pane) {');
const iRes = src.indexOf('restoreInto(pane, recs) {');
const iEnd = src.indexOf('debugRtDump() {');
ok(iSer > 0 && iRes > iSer && iEnd > iRes, 'located serialize()/restoreInto() in the runtime concern',
  { iSer, iRes, iEnd });

const ser = iSer > 0 && iRes > iSer ? src.slice(iSer, iRes) : '';
const res = iRes > 0 && iEnd > iRes ? src.slice(iRes, iEnd) : '';

console.log('\n[1] serialize()');
{
  ok(/strategyProps:\s*JSON\.parse\(JSON\.stringify\(i\.strategyProps\)\)/.test(ser),
    'strategyProperties are serialized (deep-cloned)');
  ok(/\.\.\.\(i\.strategyProps && typeof i\.strategyProps === 'object' && Object\.keys\(i\.strategyProps\)\.length/.test(ser),
    'strategyProps spread is conditional on a non-empty object');
  ok(/\.\.\.\(i\._tfTouched \? \{ tfTouched: true \} : \{\}\)/.test(ser),
    'explicit timeframe pick is serialized as tfTouched');
  ok(/timeframe: String\(i\.timeframe\)/.test(ser), 'a concrete timeframe still serializes as before');
}

console.log('\n[2] restoreInto()');
{
  ok(/strategyProps:\s*JSON\.parse\(JSON\.stringify\(r\.strategyProps\)\)/.test(res),
    'strategyProperties are restored (deep-cloned, never aliased)');
  ok(/\.\.\.\(r\.strategyProps && typeof r\.strategyProps === 'object'/.test(res),
    'restore only adopts an object strategyProps');
  ok(/\.\.\.\(r\.tfTouched \? \{ _tfTouched: true \} : \{\}\)/.test(res),
    'tfTouched maps back to _tfTouched (the key htfSpec reads)');
  ok(/timeframe: String\(r\.timeframe\)/.test(res), 'a concrete timeframe still restores as before');
  ok(!/_tfTouched:\s*r\._tfTouched/.test(res), 'the runtime-only flag is not read back from the record');
}

console.log('\n[3] htfSpec honours the flag');
{
  const data = readSource('src/renderer/js/chart/pine-ui/data.js');
  ok(/else if \(inst\._tfTouched\) id = ''/.test(data),
    'explicit Chart pick still beats a declaration timeframe');
}

console.log('\n[4] every writer persists');
{
  const dock = readSource('src/renderer/js/panels/stratdock.js');
  const at = dock.indexOf('initial_capital: cap');
  const after = dock.slice(at, at + 600);
  ok(at > 0 && after.includes('Manager.persistPanes()') && after.includes('PineUI.rebuild(sel.pane, inst)'),
    'tester capital Apply persists BEFORE rebuilding the instance');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
