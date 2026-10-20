/**
 * test_round233_nzbool.mjs — ROUND233 bool()/nz() contract.
 *
 * Reference (v6, via mirror KB sourced from the official reference):
 * bool() "returns false if x is na, false, or an int/float value equal to 0;
 * returns true for all other possible values" — output is NEVER na.
 * nz() replaces na with the replacement or the type default (0/0.0);
 * non-numeric passthrough (string/color/bool) is the documented engine
 * leniency (TV compile-rejects those; passing through cannot corrupt a run).
 *
 * Run: node tests/unit/test_round233_nzbool.mjs
 */

import { compile } from '../../src/core/pine/compile.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
function runAll(src, bars, opts) {
  const c = compile(src);
  if (!c.ok) return { err: 'COMPILE: ' + ((c.errors[0] || {}).message || '?') };
  try {
    const rt = c.createInstance(Object.assign({ tfSec: 60, symbol: 'T', mintick: 1 }, opts));
    rt.runAll(bars);
    return { rt };
  } catch (e) { return { err: 'RUNTIME: ' + (e.message || e) }; }
}
const g = (r, n) => { const rec = r.rt && r.rt.globals.get(n); return rec ? rec.value : '<missing>'; };
const B = [];
for (let i = 0; i < 5; i++) B.push({ time: 1700000000 + i * 60, open: 100, high: 101, low: 99, close: 100 + i, volume: 10 });

// 1-4: bool() falsy set (na/false/0/0.0) — never na
{
  const r = runAll('//@version=6\nindicator("T")\na = bool(na)\nb = bool(false)\nc = bool(0)\nd = bool(0.0)\nplot(1)\n', B);
  ok(!r.err && g(r, 'a') === false && g(r, 'b') === false && g(r, 'c') === false && g(r, 'd') === false,
    'bool falsy set (got ' + g(r, 'a') + '/' + g(r, 'b') + '/' + g(r, 'c') + '/' + g(r, 'd') + ')');
}
// 5-7: bool() truthy set (true/1/"text"/color)
{
  const r = runAll('//@version=6\nindicator("T")\na = bool(true)\nb = bool(2)\nc = bool("text")\nd = bool(color.red)\nplot(1)\n', B);
  ok(!r.err && g(r, 'a') === true && g(r, 'b') === true && g(r, 'c') === true && g(r, 'd') === true,
    'bool truthy set (got ' + g(r, 'a') + '/' + g(r, 'b') + '/' + g(r, 'c') + '/' + g(r, 'd') + ')');
}
// 8: bool() feeds v6 conditions as a real bool
{
  const r = runAll('//@version=6\nindicator("T")\nx = 0\nif bool(1)\n    x := 7\nplot(x)\n', B);
  ok(!r.err && g(r, 'x') === 7, 'bool() in v6 if (got ' + g(r, 'x') + ')');
}
// 9-11: nz() defaults and explicit numeric replacement
{
  const r = runAll('//@version=6\nindicator("T")\na = nz(na)\nb = nz(na, 5)\nc = nz(3.5)\nd = nz(na, 50.0)\nplot(1)\n', B);
  ok(!r.err && g(r, 'a') === 0 && g(r, 'b') === 5 && g(r, 'c') === 3.5 && g(r, 'd') === 50,
    'nz numerics (got ' + g(r, 'a') + '/' + g(r, 'b') + '/' + g(r, 'c') + '/' + g(r, 'd') + ')');
}
// 12-13: nz() lenient passthrough (bool/string) + series replacement
{
  const r = runAll('//@version=6\nindicator("T")\na = nz(true)\nb = nz("s")\nc = nz(ta.sma(close, 100), close)\nplot(1)\n', B);
  ok(!r.err && g(r, 'a') === true && g(r, 'b') === 's' && g(r, 'c') === 100 + 4,
    'nz lenient + series repl (got ' + g(r, 'a') + '/' + g(r, 'b') + '/' + g(r, 'c') + ')');
}

console.log('\nROUND233: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
