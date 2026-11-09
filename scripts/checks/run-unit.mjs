#!/usr/bin/env node
/**
 * Unit gate — runs every `tests/unit/*.mjs` suite in a child Node process.
 *
 * The suites are self-contained (assertions + `process.exit(1)` on failure),
 * so a small scheduler is enough: no test framework, no extra dependency.
 * `source-utils.mjs` is a helper module, not a suite, and is skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'tests', 'unit');
const TIMEOUT_MS = 60_000;
/* Shared CI runners are usually 2 vCPU: keep some headroom for the
   timing-sensitive suites instead of saturating both cores. */
const CONCURRENCY = process.env.CI ? 2 : 4;

/* Suites that assert on wall-clock liveness must not share the CPU with a
   sibling child: on a 2-vCPU shared runner the OS can stall one of them for
   seconds (GC, antivirus, vCPU steal) and turn a healthy run red. They run
   alone, one after another, before the concurrent pool. */
const SERIAL = new Set(['verify_pine80.mjs', 'test_round266_ci_timing_gate.mjs', 'test_round281_corpus_budget.mjs']);

const files = fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.mjs') && f !== 'source-utils.mjs')
  .sort();

if (files.length === 0) {
  console.error('unit gate: no suites found in tests/unit');
  process.exit(1);
}

const serial = files.filter((f) => SERIAL.has(f));
const parallel = files.filter((f) => !SERIAL.has(f));

function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(DIR, file)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ file, code: code === null ? 'timeout' : code, out, err });
    });
  });
}

const results = [];
/* quiet machine first, then the parallel pool */
for (const file of serial) results.push(await runOne(file));
let next = 0;
async function worker() {
  while (next < parallel.length) {
    const file = parallel[next++];
    results.push(await runOne(file));
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, parallel.length) }, worker));

const failed = results.filter((r) => r.code !== 0);
for (const r of failed) {
  const lines = (r.out + r.err).split(/\r?\n/).filter(Boolean);
  const marked = lines.filter((l) => l.includes('✗') || l.includes('FAIL'));
  const detail = (marked.length ? marked : lines.slice(-12)).slice(0, 40);
  console.error(`\n✗ ${r.file} (exit ${r.code})`);
  if (detail.length) console.error(detail.join('\n'));
}
console.log(`\nunit gate: ${results.length - failed.length}/${results.length} suites passed`);
if (failed.length) process.exit(1);
