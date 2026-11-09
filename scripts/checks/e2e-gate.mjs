#!/usr/bin/env node
/**
 * Curated browser E2E gate (ROUND283).
 *
 * `tests/archive/e2e/` holds ~136 Playwright suites covering rounds 31..256.
 * They are NOT part of `verify`: each one boots a static server, the demo
 * provider and Chromium, so running all of them would blow the gate's time
 * budget and re-test stable areas on every push.
 *
 * This gate runs a small, high-value set that exercises the paths a unit
 * suite cannot reach — a real browser, real canvas paints and the real
 * module graph:
 *
 *   round205  deleted drawing objects + forming-bar rollback
 *   round196  matrix/map engine surface through the live runtime
 *   round252  Style-tab rendering controls
 *   round283  Pine -> Alerts bridge + ROUND282 pivot rendering  (new)
 *
 * History: until ROUND283 every archived suite was silently broken — the move
 * into `tests/archive/e2e/` added a directory level, so `ROOT` (three
 * dirname() calls) resolved to `tests/` and the scripts could not find `src/`
 * or `provider/demo.py`. Fixing ROOT made 126 suites runnable again; this
 * gate keeps a representative sample honest on every push.
 *
 * Usage:
 *   node scripts/checks/e2e-gate.mjs              # curated set
 *   node scripts/checks/e2e-gate.mjs --all        # every archived suite
 *   node scripts/checks/e2e-gate.mjs round252     # name substring filter
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'tests', 'archive', 'e2e');

const CURATED = [
  'e2e_round196_matrix_map.py',
  'e2e_round205_deleted.py',
  'e2e_round252_style1.py',
  'e2e_round283_alerts_pivots.py',
];

let TIME_LIMIT_MS = 120_000;

function findPython() {
  for (const cmd of ['python', 'python3', 'py']) {
    const args = cmd === 'py' ? ['-3'] : [];
    const r = spawnSync(cmd, [...args, '-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && String(r.stdout).trim() === '3') return { cmd, prefix: args };
  }
  return null;
}

function runSuite(py, file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(py.cmd, [...py.prefix, path.join(DIR, file)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) {}
      resolve({ file, ok: false, ms: Date.now() - started, out, err: err + '\n(timed out)' });
    }, TIME_LIMIT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ file, ok: code === 0, ms: Date.now() - started, out, err });
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const filters = argv.filter((a) => !a.startsWith('-'));

  if (!fs.existsSync(DIR)) {
    console.error('[e2e] no archived suites at ' + DIR);
    process.exit(1);
  }
  const py = findPython();
  if (!py) {
    console.error('[e2e] no Python 3 interpreter found');
    process.exit(1);
  }
  /* Playwright is an optional local dependency: skip (do not fail) when it is
   * not installed, so `verify` and the curated gate stay usable in a plain
   * checkout. CI installs it and therefore runs the real thing. */
  const probe = spawnSync(py.cmd, [...py.prefix, '-c', 'import playwright'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.log('[e2e] Playwright is not installed — skipping the browser gate');
    console.log('[e2e] install with: python -m pip install playwright && python -m playwright install chromium');
    process.exit(0);
  }

  let files;
  if (all) files = fs.readdirSync(DIR).filter((f) => f.endsWith('.py')).sort();
  else if (filters.length) files = fs.readdirSync(DIR).filter((f) => f.endsWith('.py') && filters.some((s) => f.includes(s))).sort();
  else files = CURATED.filter((f) => fs.existsSync(path.join(DIR, f)));

  if (!files.length) {
    console.error('[e2e] no suite matched');
    process.exit(1);
  }

  console.log(`[e2e] running ${files.length} suite(s)`);
  const results = [];
  for (const f of files) {
    process.stdout.write(`[e2e] ${f} ... `);
    const r = await runSuite(py, f);
    results.push(r);
    const summary = (r.out.split(/\r?\n/).reverse().find((l) => /all green|failed|FAIL/.test(l)) || '').trim();
    console.log(r.ok ? 'ok' : 'FAIL', `${r.ms}ms${summary ? ' — ' + summary : ''}`);
    if (!r.ok) {
      const tail = (r.out + '\n' + r.err).split(/\r?\n/).filter((l) => l.includes('FAIL') || l.includes('Error') || l.includes('Traceback')).slice(0, 8);
      for (const l of tail) console.log('      ' + l.trim());
    }
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n[e2e] ${results.length - bad.length}/${results.length} suites green`);
  if (bad.length) {
    console.error('[e2e] FAILED: ' + bad.map((r) => r.file).join(', '));
    process.exit(1);
  }
}

main().catch((e) => { console.error('[e2e] ' + (e.stack || e)); process.exit(1); });
