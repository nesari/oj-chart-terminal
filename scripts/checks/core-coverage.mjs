#!/usr/bin/env node
/**
 * Core coverage report (F8.3) — real V8 line coverage for `src/core/`.
 *
 * Runs the existing `tests/unit/*.mjs` suites with NODE_V8_COVERAGE, merges
 * the raw profiles and prints how much of the platform-agnostic layer the
 * suites actually execute. This is a measurement tool, not a rewrite of the
 * suites: no extra dependency and no changes to the test files.
 *
 * Usage:
 *   npm run report:core-coverage              # report, exit 0
 *   npm run report:core-coverage -- --min 45  # exit 1 when below 45%
 *   npm run report:core-coverage -- --list    # list every uncovered module
 *
 * Notes:
 * - Coverage is approximate line coverage: a line counts as covered when at
 *   least one non-space byte on it was executed. Comment-only lines are
 *   ignored. This is enough to find dead/untested modules; it is not a
 *   substitute for assertions.
 * - Files under src/core that are never imported by a suite report 0%.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UNIT = path.join(ROOT, 'tests', 'unit');
const CORE = path.join(ROOT, 'src', 'core');
const TIMEOUT_MS = 90_000;
const CONCURRENCY = process.env.CI ? 2 : 4;
const SERIAL = new Set(['verify_pine80.mjs', 'test_round266_ci_timing_gate.mjs']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function runSuite(file, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(UNIT, file)], {
      cwd: ROOT, stdio: 'ignore', windowsHide: true, env,
    });
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve({ file, code }); });
  });
}

async function runSuites(env) {
  const files = fs.readdirSync(UNIT)
    .filter((f) => f.endsWith('.mjs') && f !== 'source-utils.mjs')
    .sort();
  const results = [];
  for (const f of files.filter((f) => SERIAL.has(f))) results.push(await runSuite(f, env));
  const rest = files.filter((f) => !SERIAL.has(f));
  let next = 0;
  async function worker() {
    while (next < rest.length) {
      const f = rest[next++];
      results.push(await runSuite(f, env));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rest.length) }, worker));
  return results;
}

function localPath(url) {
  if (!url.startsWith('file:')) return null;
  try { return path.normalize(fileURLToPath(url)); } catch (e) { return null; }
}

/* Innermost-range byte mask for one V8 coverage entry. */
function entryMask(entry, len) {
  const mask = new Uint8Array(len);
  const ranges = [];
  for (const fn of entry.functions || []) {
    for (const r of fn.ranges || []) {
      if (r.endOffset > r.startOffset) ranges.push(r);
    }
  }
  if (!ranges.length) return mask;
  const offsets = [...new Set(ranges.flatMap((r) => [r.startOffset, r.endOffset]))]
    .filter((o) => o >= 0 && o <= len)
    .sort((a, b) => a - b);
  for (let i = 0; i + 1 < offsets.length; i++) {
    const a = offsets[i], b = offsets[i + 1];
    if (b <= a) continue;
    let best = null;
    for (const r of ranges) {
      if (r.startOffset <= a && r.endOffset >= b) {
        if (!best || (r.endOffset - r.startOffset) < (best.endOffset - best.startOffset)) best = r;
      }
    }
    if (best && best.count > 0) mask.fill(1, a, b);
  }
  return mask;
}

function lineStats(source, mask) {
  let total = 0, covered = 0;
  let off = 0;
  for (const line of source.split('\n')) {
    const start = off;
    off += line.length + 1;
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/')) continue;
    let any = false, hit = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === ' ' || ch === '\t' || ch === '\r') continue;
      any = true;
      if (mask[start + i]) { hit = true; break; }
    }
    if (!any) continue;
    total++;
    if (hit) covered++;
  }
  return { total, covered };
}

function readProfiles(dir) {
  const byFile = new Map();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (e) { continue; }
    for (const entry of data.result || []) {
      const p = localPath(entry.url);
      if (!p || !p.startsWith(CORE + path.sep)) continue;
      if (!byFile.has(p)) byFile.set(p, []);
      byFile.get(p).push(entry);
    }
  }
  return byFile;
}

async function main() {
  const argv = process.argv.slice(2);
  const minIdx = argv.indexOf('--min');
  const min = minIdx >= 0 ? Number(argv[minIdx + 1]) : null;
  const listAll = argv.includes('--list');

  const covDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oj-core-cov-'));
  const results = await runSuites({ ...process.env, NODE_V8_COVERAGE: covDir });
  const failed = results.filter((r) => r.code !== 0);
  if (failed.length) {
    console.error('[core-cov] unit suites failed, coverage is incomplete: ' + failed.map((f) => f.file).join(', '));
    fs.rmSync(covDir, { recursive: true, force: true });
    process.exit(1);
  }

  const profiles = readProfiles(covDir);
  const files = walk(CORE).sort();
  const rows = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const entries = profiles.get(file) || [];
    const mask = new Uint8Array(source.length);
    for (const e of entries) {
      const m = entryMask(e, source.length);
      for (let i = 0; i < m.length; i++) if (m[i]) mask[i] = 1;
    }
    const { total, covered } = lineStats(source, mask);
    rows.push({
      file: path.relative(ROOT, file).split(path.sep).join('/'),
      total, covered, imported: entries.length > 0,
      pct: total ? (100 * covered / total) : 100,
    });
  }

  const totalLines = rows.reduce((s, r) => s + r.total, 0);
  const hitLines = rows.reduce((s, r) => s + r.covered, 0);
  const imported = rows.filter((r) => r.imported).length;
  const pct = totalLines ? (100 * hitLines / totalLines) : 0;

  console.log(`[core-cov] ${rows.length} core modules · approx lines ${pct.toFixed(1)}% (${hitLines}/${totalLines}) · imported ${imported}/${rows.length}`);
  const worst = rows.filter((r) => r.total >= 5).sort((a, b) => a.pct - b.pct || a.file.localeCompare(b.file));
  for (const r of worst.slice(0, listAll ? worst.length : 10)) {
    console.log(`  ${r.pct.toFixed(1).padStart(5)}%  ${r.covered}/${r.total}  ${r.file}`);
  }
  if (!listAll) console.log('  ... pass --list to see every module');

  fs.rmSync(covDir, { recursive: true, force: true });
  if (min != null && pct < min) {
    console.error(`[core-cov] FAIL — ${pct.toFixed(1)}% < --min ${min}%`);
    process.exit(1);
  }
}

try { await main(); } catch (e) { console.error('[core-cov] ' + (e.stack || e)); process.exit(1); }
