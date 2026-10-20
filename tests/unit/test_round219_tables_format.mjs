/**
 * test_round219_tables_format.mjs — ROUND219 table trim + number formatting.
 *
 * 1. str.format bare {n,number} is the Java default #,##0.### (grouping, max
 *    3 decimals): TV tables show 38.55, not 38.55000000000018. Explicit
 *    sub-formats ({n,number,percent}, {n,number,#}) and str.tostring() keep
 *    their paths (TV: tostring has its own precision rules).
 * 2. Table DOM trim (renderer _fillTableEl) is covered live in
 *    e2e_round219_table_trim.py (20x20 table with 2 cells renders 2 divs).
 *
 * Run: node tests/unit/test_round219_tables_format.mjs
 */

import { compile } from '../../src/core/pine/compile.js';
import { strFns } from '../../src/core/pine/stdlib/math.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};
const site = {};
const fmt = (pat, ...args) => {
  try { return strFns.format(site, pat, ...args); }
  catch (e) { return 'ERR:' + String((e && e.message) || e).slice(0, 80); }
};

ok(fmt('{0,number}', 38.55000000000018) === '38.55', 'bare number trims float noise (got ' + fmt('{0,number}', 38.55000000000018) + ')');
ok(fmt('{0,number}', 14.789999999999964) === '14.79', 'bare number rounds to 3dp');
ok(fmt('{0,number}', 75.67) === '75.67', 'short decimals untouched');
ok(fmt('{0,number}', 4194645) === '4,194,645', 'bare number groups thousands');
ok(fmt('{0,number}', 0) === '0', 'zero stays 0');
ok(fmt('{0,number}', -12.34567) === '-12.346', 'negatives round');
ok(fmt('{0,number,percent}', 0.5) === '50%', 'percent sub-format untouched (round 216)');
ok(fmt('{0,number,#}', 1723472500000) === '1723472500000', '# sub-format untouched (timestamps)');
ok(fmt('{0} and {1,number}', 'x', 2.5) === 'x and 2.5', 'mixed placeholders');
ok(fmt('{0,number}', 'notanumber') === 'NaN', 'na input stays NaN');

console.log('\nROUND219: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
