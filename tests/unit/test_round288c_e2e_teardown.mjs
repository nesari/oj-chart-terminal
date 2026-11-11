/**
 * test_round288c_e2e_teardown.mjs — the E2E suites must not leak processes.
 *
 * Symptom: running the 12 curated Playwright suites back to back on a 2-vCPU
 * CI runner, the later ones failed with "Page.wait_for_selector: Timeout" —
 * the app never became visible. The suites used `Popen.terminate()`, which on
 * Windows signals only the direct child; a suite that TIMES OUT is killed
 * before its `finally` runs at all, so provider processes piled up until the
 * runner ran out of headroom.
 *
 * ROUND288c adds a tiny shared `e2e_teardown.kill_proc()` (taskkill /T /F on
 * Windows) and uses it in every curated suite.
 *
 * Run: node tests/unit/test_round288c_e2e_teardown.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const E2E = path.join(ROOT, 'tests', 'archive', 'e2e');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

/* ---------- 1. the helper exists and is Windows-aware ---------- */
{
  const f = path.join(E2E, 'e2e_teardown.py');
  ok(fs.existsSync(f), 'e2e_teardown.py exists');
  const src = fs.readFileSync(f, 'utf8');
  ok(/def kill_proc\(proc/.test(src), 'it exposes kill_proc(proc)');
  ok(/taskkill/.test(src) && /\/T/.test(src) && /\/F/.test(src),
    'Windows path kills the whole tree (/T /F)');
  ok(/killpg|SIGKILL/.test(src), 'POSIX path kills the process group');
  ok(/never raises/.test(src), 'it is documented as never raising (safe in finally)');
  ok(/proc\.poll\(\) is not None/.test(src), 'an already-dead process is a no-op');
}

/* ---------- 2. every curated suite uses it ---------- */
{
  const gate = readSource('scripts/checks/e2e-gate.mjs');
  const curated = [...(gate.match(/const CURATED = \[([\s\S]*?)\];/) || [, ''])[1]
    .matchAll(/'(e2e_[^']+\.py)'/g)].map((m) => m[1]);
  ok(curated.length >= 10, 'the curated list was parsed (' + curated.length + ')');

  const missingImport = [];
  const stillTerminate = [];
  for (const f of curated) {
    const p = path.join(E2E, f);
    if (!fs.existsSync(p)) { missingImport.push(f + ' (missing)'); continue; }
    const src = fs.readFileSync(p, 'utf8');
    if (!/from e2e_teardown import kill_proc/.test(src)) missingImport.push(f);
    if (/prov\.terminate\(\)/.test(src)) stillTerminate.push(f);
  }
  ok(missingImport.length === 0, 'every curated suite imports kill_proc', missingImport.join(', '));
  ok(stillTerminate.length === 0, 'no curated suite still calls Popen.terminate()', stillTerminate.join(', '));
  /* and each actually calls it on its provider */
  const notCalled = curated.filter((f) => {
    const src = fs.readFileSync(path.join(E2E, f), 'utf8');
    return !/kill_proc\(prov\)/.test(src);
  });
  ok(notCalled.length === 0, 'every suite kills its provider via the helper', notCalled.join(', '));
}

/* ---------- 3. the gate's retry policy is not a blanket retry ---------- */
{
  const gate = readSource('scripts/checks/e2e-gate.mjs');
  ok(/attempt < 4/.test(gate), 'it retries up to three times');
  ok(/await sleep\(2000 \* attempt\)/.test(gate), 'it cools down between attempts');
  const fn = (gate.match(/function looksLikeBootTimeout[\s\S]*?\n\}/) || [''])[0];
  ok(/Page\\.wait_for_selector: Timeout/.test(fn), 'the retry matches a boot timeout');
  ok(/if \(!bootTimeout\) return false;/.test(fn), 'anything else is never retried');
  ok(/!\s*\/\^\\s\+\(FAIL\|  FAIL\)\/m/.test(fn),
    'a suite that reached the app and failed an assertion is not retried');
}

/* ---------- 4. the suites still declare unique ports ---------- */
{
  const gate = readSource('scripts/checks/e2e-gate.mjs');
  const curated = [...(gate.match(/const CURATED = \[([\s\S]*?)\];/) || [, ''])[1]
    .matchAll(/'(e2e_[^']+\.py)'/g)].map((m) => m[1]);
  const ports = [];
  for (const f of curated) {
    const src = fs.readFileSync(path.join(E2E, f), 'utf8');
    const m = /PORT_HTTP,\s*PORT_WS\s*=\s*(\d+),\s*(\d+)/.exec(src);
    if (m) ports.push(m[1], m[2]);
  }
  const dupes = ports.filter((p, i) => ports.indexOf(p) !== i);
  ok(ports.length >= 20, 'every suite declares its ports (' + ports.length + ')');
  ok(dupes.length === 0, 'no two curated suites share a port', [...new Set(dupes)].join(','));
}

console.log('\nROUND288c: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
