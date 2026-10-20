/**
 * test_round221_pine_errors.mjs — ROUND221 pine error observability contract.
 *
 * The legend ⚠ row and the Diagnostics log read ONLY st.errors entries shaped
 * { code, message, line } plus the Log store (cat 'pine', lvl 'error').
 * This pins both sides of that contract at engine level:
 *  - runtime throws carry a message + numeric line (what the row tooltip and
 *    the Log line format from);
 *  - Log.error('pine', ...) lands in Log.entries() so the Diagnostics ERR
 *    filter and the exported log actually contain it (the R221 gap: error
 *    transitions never reached the log, so the user had nothing to send).
 *
 * Run: node tests/unit/test_round221_pine_errors.mjs
 */

import { compile } from '../../src/core/pine/compile.js';
import { Log } from '../../src/core/logger.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
const HEAD = '//@version=6\nindicator("T", overlay=true)\n';
const BARS = [
  { time: 1700000000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  { time: 1700000060, open: 1, high: 1, low: 1, close: 1, volume: 1 },
];
function runBody(body) {
  const c = compile(HEAD + body);
  if (!c.ok) return { compiled: c };
  try {
    const rt = c.createInstance({ tfSec: 60, symbol: 'T', mintick: 0.01 });
    rt.runAll(BARS);
    return { compiled: c, rt, threw: false };
  } catch (e) { return { compiled: c, threw: true, err: e }; }
}

// 1-3: array.get OOB (the KZP first-bar shape) throws with message + line
{
  const r = runBody('a = array.new_int(0)\nx = a.get(0)\nplot(1)\n');
  ok(r.threw === true, 'OOB array.get throws instead of silent na');
  ok(r.threw && typeof r.err.message === 'string' && r.err.message.length > 0, 'thrown error carries a message');
  ok(r.threw && typeof r.err.line === 'number', 'thrown error carries a numeric line');
}
// 4: the UI format string builds from exactly these two fields
{
  const r = runBody('a = array.new_int(0)\nx = a.get(0)\nplot(1)\n');
  const line = 'runtime error: T: ' + (r.err.message || String(r.err)) + ' (line ' + (r.err.line || 0) + ')';
  ok(r.threw && line.includes('line ') && line.length > 'runtime error: T:  (line 0)'.length, 'message + line format non-empty');
}
// 5-6: compile errors carry message + line for the same tooltip path
{
  const c = compile(HEAD + 'plot(\n');
  ok(c.ok === false && c.errors.length > 0, 'broken script fails compile');
  const f = c.errors[0] || {};
  ok(typeof f.message === 'string' && f.message.length > 0 && typeof f.line === 'number', 'compile error has message + line');
}
// 7-8: Log.error('pine', ...) is retrievable — the Diagnostics ERR filter path
{
  const tag = 'r221-' + Date.now().toString(36);
  Log.error('pine', 'runtime error: TST221: probe ' + tag + ' (line 3)', { script: 'TST221', line: 3 });
  const found = Log.entries({ search: tag });
  ok(found.length >= 1, 'pine error entry retrievable from Log store');
  ok(found.length >= 1 && found[0].lvl === 'error' && found[0].cat === 'pine', 'entry level/category are error/pine');
}

console.log('\nROUND221: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
