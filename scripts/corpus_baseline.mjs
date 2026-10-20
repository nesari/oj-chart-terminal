/**
 * corpus_baseline.mjs — Pine corpus compile baseline (REPORT only, never fails)
 *
 * Run: node scripts/corpus_baseline.mjs [dir]
 * Compiles every .pine in scripts/pine-fixtures/corpus/ and reports ok +
 * first error per file. Used to track compliance progress round by round
 * (PINE-COMPLIANCE-PLAN §7). For full run+render snapshots see phase H.
 */

import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { compile } from '../src/core/pine/compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] || join(HERE, 'pine-fixtures', 'corpus');

let okN = 0, failN = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.pine')).sort()) {
  const src = readFileSync(join(dir, f), 'utf8');
  const t0 = Date.now();
  let res;
  try {
    res = compile(src);
  } catch (e) {
    res = { ok: false, errors: [{ message: 'THREW: ' + String((e && e.message) || e) }] };
  }
  const ms = Date.now() - t0;
  if (res.ok) {
    okN++;
    const nIn = (res.meta && res.meta.inputCount) || '?';
    console.log('  ok   ' + f + '  (' + ms + 'ms, v' + (res.meta && res.meta.version) + ')');
  } else {
    failN++;
    const e0 = res.errors[0] || {};
    console.log('  FAIL ' + f + '  (' + ms + 'ms) -> [' + (e0.code || '?') + '] ' + String(e0.message || e0).slice(0, 160));
  }
}
console.log('\ncorpus: ' + okN + ' compile, ' + failN + ' fail');
