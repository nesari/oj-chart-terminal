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
const CONCURRENCY = 4;

const files = fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.mjs') && f !== 'source-utils.mjs')
  .sort();

if (files.length === 0) {
  console.error('unit gate: no suites found in tests/unit');
  process.exit(1);
}

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

let next = 0;
const results = [];
async function worker() {
  while (next < files.length) {
    const file = files[next++];
    results.push(await runOne(file));
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

const failed = results.filter((r) => r.code !== 0);
for (const r of failed) {
  const tail = (r.out + r.err).split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
  console.error(`\n✗ ${r.file} (exit ${r.code})`);
  if (tail) console.error(tail);
}
console.log(`\nunit gate: ${results.length - failed.length}/${results.length} suites passed`);
if (failed.length) process.exit(1);
