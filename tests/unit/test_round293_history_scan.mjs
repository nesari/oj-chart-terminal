/**
 * test_round293_history_scan.mjs — history must be scanned before going public.
 *
 * Making a repository public exposes its whole HISTORY. `go-public` originally
 * audited only the current tree, which misses the worst case: a secret that was
 * committed and later deleted is still readable forever.
 *
 * This suite pins three things:
 *   A. the scanner exists, walks every commit (not just HEAD), and looks for
 *      real credential shapes;
 *   B. it does NOT drown in false positives — this repo legitimately contains
 *      `CSC_KEY_PASSWORD` in README instructions, a `${VAR}` example, and the
 *      logger's own `password: 'TOPSECRET'` scrub probe. A scanner that flags
 *      those is useless because nobody reads its output;
 *   C. it still catches a REAL secret planted in history and then deleted.
 *
 * (C) is the important one: it is the exact failure mode a current-tree audit
 * cannot see.
 *
 * Run: node tests/unit/test_round293_history_scan.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-utils.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNER = path.join(ROOT, 'scripts', 'checks', 'scan-history.mjs');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

/* ---------- A. the scanner's contract ---------- */
{
  const s = readSource('scripts/checks/scan-history.mjs');
  ok(/'rev-list', '--all', '--objects'/.test(s), 'it walks EVERY object in history, not just HEAD');
  ok(/'cat-file', '--batch'/.test(s), 'it reads blobs in one batch pass');
  ok(/GitHub token/.test(s), 'it looks for GitHub tokens');
  ok(/private key block/.test(s), 'it looks for private keys');
  ok(/AWS access key/.test(s), 'it looks for AWS keys');
  ok(/PLACEHOLDER_VALUE/.test(s), 'it filters placeholder values');
  ok(/PLACEHOLDER_CONTEXT/.test(s), 'it filters documentation context');
  ok(/process\.exit\(report\.length \? 1 : 0\)/.test(s), 'it fails (exit 1) when it finds something');
}

/* ---------- B. this repo's real history is clean ---------- */
{
  const r = spawnSync(process.execPath, [SCANNER], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  ok(r.status === 0, 'this repository\'s history scans clean', out.slice(-600));
  ok(/no credential shapes in any commit/.test(out), 'it says so explicitly', out.slice(-200));
  /* and it must NOT be clean because it skipped things */
  const scanned = /unique objects: (\d+)/.exec(out);
  ok(scanned && Number(scanned[1]) > 500, 'it actually walked a real history', scanned && scanned[1]);
  /* the known false positives must be filtered, not merely absent */
  ok(!/CSC_KEY_PASSWORD/.test(out), 'README code-signing prose is not reported');
  ok(!/TOPSECRET/.test(out), "the logger's own scrub probe is not reported");
}

/* ---------- C. a real secret committed then DELETED is still caught ---------- */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oj-hist-'));
  fs.mkdirSync(path.join(dir, 'scripts', 'checks'), { recursive: true });
  fs.copyFileSync(SCANNER, path.join(dir, 'scripts', 'checks', 'scan-history.mjs'));

  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  const commit = (msg) => git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', msg]);
  git(['init', '-q']);

  /* commit 1: clean */
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("hello");\n', 'utf8');
  git(['add', '-A']); commit('init');

  /* commit 2: a real-looking AWS key, then DELETE it in commit 3 */
  fs.writeFileSync(path.join(dir, 'config.js'),
    'const AWS_ACCESS_KEY_ID = "AKIA' + 'Q'.repeat(16) + '";\n', 'utf8');
  git(['add', '-A']); commit('add config');

  fs.rmSync(path.join(dir, 'config.js'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("clean again");\n', 'utf8');
  git(['add', '-A']); commit('remove the secret');

  /* the current tree is clean — a naive audit would pass. Scope the grep to
     the file that held the secret AND to source files only: the scanner's own
     script contains the regex `/AKIA[0-9A-Z]{16}/`, which is a detector, not a
     credential, and would otherwise trip this check. */
  const grep = spawnSync('git', ['grep', '-I', '--cached', 'AKIA', '--', '*.js'],
    { cwd: dir, encoding: 'utf8' });
  const leakedInApp = (grep.stdout || '').split('\n').filter((l) => l && !l.includes('scan-history.mjs'));
  ok(leakedInApp.length === 0, 'no application file contains the secret any more', leakedInApp.join(' | '));

  /* ...but the history scanner must still catch it */
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'checks', 'scan-history.mjs')],
    { cwd: dir, encoding: 'utf8', timeout: 120_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  ok(r.status === 1, 'the history scanner FAILS on a deleted secret', 'exit ' + r.status + ' ' + out.slice(-300));
  ok(/AWS access key/.test(out), 'it names the credential type', out.slice(-300));
  ok(/config\.js/.test(out), 'it names the file that once contained it', out.slice(-300));

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------- D. go-public must consume this ---------- */
{
  const g = readSource('scripts/go-public.mjs');
  ok(/scan-history\.mjs/.test(g), 'go-public runs the history scanner');
  const scanAt = g.indexOf('scan-history.mjs');
  const flipAt = g.indexOf("'visibility=public'");
  ok(scanAt >= 0 && flipAt >= 0 && scanAt < flipAt,
    'the history scan runs BEFORE the visibility flip');
}

console.log('\nROUND293: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
