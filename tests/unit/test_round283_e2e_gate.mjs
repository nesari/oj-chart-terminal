/**
 * test_round283_e2e_gate.mjs — ROUND283: the archived E2E suites work again.
 *
 * The ~136 Playwright suites under `tests/archive/e2e/` were silently broken
 * by being MOVED into that directory: each computes the repo root with three
 * `dirname()` calls, which used to be right from `tests/e2e/` but resolves to
 * `tests/` from `tests/archive/e2e/`. Every script then failed to find `src/`
 * or `provider/demo.py`, so none of them could run — and nothing noticed,
 * because they are outside `verify`.
 *
 * ROUND283 does three things, all pinned here:
 *   1. fixes ROOT for every archived suite (one directory deeper),
 *   2. adds `scripts/checks/e2e-gate.mjs` — a curated browser gate that runs
 *      a representative set and skips (never fails) when Playwright is absent,
 *   3. wires that gate into CI.
 *
 * Run: node tests/unit/test_round283_e2e_gate.mjs
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

/* ---------- 1. every archived suite resolves the real repo root ---------- */
{
  const files = fs.readdirSync(E2E).filter((f) => f.endsWith('.py'));
  ok(files.length >= 100, 'the archive still holds the legacy suites (' + files.length + ')');

  const wrong = [];
  let checked = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(E2E, f), 'utf8');
    const m = /^ROOT\s*=\s*(.+)$/m.exec(src);
    /* The handful of verify_round4x.py files are local one-off screenshot
       tools with hardcoded absolute paths and no ROOT at all — they were
       never runnable in a checkout and are out of scope here. */
    if (!m) continue;
    checked++;
    const line = m[1];
    /* Four levels: tests/archive/e2e/<file> -> repo root. Count rather than
       match a whole nesting shape: variants differ by `os.path.` prefixes, an
       extra `os.path.join(..., 'src')` wrapper, or pathlib's `.parent` chain. */
    const dirnameCount = (line.match(/dirname\(/g) || []).length;
    const parentCount = (line.match(/\.parent\b/g) || []).length;
    const fourDeep = dirnameCount === 4 || parentCount === 4;
    if (!fourDeep) wrong.push(f + ' (' + line.trim() + ')');
  }
  ok(checked >= 100, 'most archived suites declare a ROOT (' + checked + ' of ' + files.length + ')');
  ok(wrong.length === 0, 'every suite with a ROOT computes it four levels up', wrong.slice(0, 3).join('; '));

  /* the specific regression: three levels must be gone */
  const stillThree = files.filter((f) => {
    const s = fs.readFileSync(path.join(E2E, f), 'utf8');
    return /ROOT\s*=.*dirname\(dirname\(dirname\(os\.path\.abspath\(__file__\)\)\)\)/.test(s)
      || /ROOT\s*=.*Path\(__file__\)\.parent\.parent\.parent$/.test(s);
  });
  ok(stillThree.length === 0, 'no suite still uses the broken three-level ROOT', stillThree.slice(0, 3).join(', '));
}

/* ---------- 2. resolving ROOT from an archived suite finds src/provider ---------- */
{
  const probe = path.join(E2E, 'e2e_round283_alerts_pivots.py');
  const src = fs.readFileSync(probe, 'utf8');
  const rootLine = (src.split(/\r?\n/).find((l) => /^ROOT\s*=/.test(l)) || '');
  ok((rootLine.match(/dirname\(/g) || []).length === 4, 'the new suite uses the four-level ROOT', rootLine.trim());
  /* emulate the arithmetic: tests/archive/e2e/x.py -> repo root */
  const resolved = path.resolve(E2E, '..', '..', '..');
  ok(fs.existsSync(path.join(resolved, 'src', 'renderer', 'index.html')), 'that root really contains src/renderer/index.html');
  ok(fs.existsSync(path.join(resolved, 'provider', 'demo.py')), 'that root really contains provider/demo.py');
  ok(path.resolve(E2E, '..', '..') !== resolved, 'and it is not the old (tests/) directory');
}

/* ---------- 3. the gate script's contracts ---------- */
{
  const g = readSource('scripts/checks/e2e-gate.mjs');
  ok(/const CURATED = \[/.test(g), 'the gate keeps an explicit curated list');
  ok(/e2e_round283_alerts_pivots\.py/.test(g), 'the ROUND283 suite is in the curated list');
  ok(/e2e_round201_session\.py/.test(g) && /e2e_round203_table_style\.py/.test(g),
    'the session/table suites repaired in ROUND283 are curated too');
  /* every curated entry must exist, or the gate silently runs fewer suites */
  const curated = (g.match(/const CURATED = \[([\s\S]*?)\];/) || [, ''])[1];
  const names = [...curated.matchAll(/'(e2e_[^']+\.py)'/g)].map((m) => m[1]);
  const missing = names.filter((n) => !fs.existsSync(path.join(E2E, n)));
  ok(names.length >= 6 && missing.length === 0, 'every curated suite exists on disk', missing.join(', '));
  /* Playwright missing must SKIP, not fail: a plain checkout has no browser. */
  ok(/import playwright/.test(g) && /skipping the browser gate/.test(g),
    'a missing Playwright skips instead of failing');
  ok(/process\.exit\(0\)/.test(g.slice(g.indexOf('import playwright'), g.indexOf('import playwright') + 700)),
    'the skip path exits 0');
  /* --all must be able to run every archived suite */
  ok(/argv\.includes\('--all'\)/.test(g), '--all runs every archived suite');
  ok(/readdirSync\(DIR\)\.filter\(\(f\) => f\.endsWith\('\.py'\)\)/.test(g), '--all enumerates the archive directory');
  /* a per-suite timeout keeps CI bounded */
  ok(/TIME_LIMIT_MS/.test(g) && /timed out/.test(g), 'each suite has a timeout');
  /* A cold-runner boot timeout must be retried ONCE, not failed outright —
     ROUND266's precedent for the liveness probe. A real failure stays failed. */
  ok(/function runWithRetry/.test(g) && /looksLikeBootTimeout/.test(g),
    'a boot timeout is retried');
  ok(/attempt < 4/.test(g), 'it retries up to three times');
  ok(g.includes('retry ${attempt}/3'), 'the retry counter is visible in the log');
  ok(/reachedApp/.test(g), 'only a real boot failure is retried (never an assertion failure)');
  ok(/boot timeout, retrying/.test(g) || /boot timeout, retry/.test(g), 'the retry is visible in the log');
  ok(/last\.retried = true/.test(g) && /\(retried\)/.test(g), 'a retried suite is labelled');
  /* retry only for the boot-timeout signature, never for an assertion failure */
  {
    const fn = (g.match(/function looksLikeBootTimeout[\s\S]*?\n\}/) || [''])[0];
    ok(/wait_for_selector/.test(fn) && !/FAIL\b/.test(fn),
      'the retry matches boot timeouts only, not failed assertions');
  }
  /* non-zero exit on failure */
  ok(/process\.exit\(1\)/.test(g.slice(g.lastIndexOf('if (bad.length)'), g.length)), 'a failed suite fails the gate');
}

/* ---------- 4. CI actually runs it ---------- */
{
  const ci = readSource('.github/workflows/ci.yml');
  ok(/playwright install chromium/.test(ci), 'CI installs the Chromium browser');
  ok(/npm run check:e2e/.test(ci), 'CI runs the curated e2e gate');
  ok(/Browser E2E gate/.test(ci), 'the CI step is named for the log');
}

/* ---------- 5. package.json exposes it ---------- */
{
  const pkg = JSON.parse(readSource('package.json'));
  ok(!!pkg.scripts['check:e2e'], 'npm run check:e2e exists');
  ok(/e2e-gate\.mjs/.test(pkg.scripts['check:e2e']), 'it points at the gate script');
  /* it must NOT be part of verify: verify stays browser-free and fast */
  ok(!/check:e2e/.test(pkg.scripts.verify || ''), 'verify stays browser-free (E2E is its own gate)');
}

/* ---------- 6. the new suite covers both live paths ---------- */
{
  const s = fs.readFileSync(path.join(E2E, 'e2e_round283_alerts_pivots.py'), 'utf8');
  ok(/alertcondition\(close > open/.test(s), 'it installs a script with alertcondition');
  ok(/alert\("round283 live alert"/.test(s), 'and one with alert()');
  ok(/pollAlerts\(\)/.test(s), 'it drives the renderer drain API');
  ok(/replaySuppressed/.test(s), 'it proves history replay is not delivered as live');
  ok(/pine-alert-settings/.test(s), 'it checks the Alerts panel card is mounted');
  ok(/pivot_point_levels|pivot-levels-sample\.pine/.test(s), 'it renders the ROUND282 pivot fixture');
  ok(/zero page errors/.test(s), 'it asserts a clean console');
}

console.log('\nROUND283: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
