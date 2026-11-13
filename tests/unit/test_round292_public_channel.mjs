/**
 * test_round292_public_channel.mjs — the switch to public must be safe and
 * verifiable, not a leap of faith.
 *
 * The repository is private today; auto-update cannot work until the release
 * feed is anonymously readable. When that switch is flipped there is no undo
 * for anything that leaked into history, so the process needs two properties:
 *
 *   A. `go-public` AUDITS before it flips — credential-shaped strings, a
 *      tracked `.env`, unredacted MT5 fixtures, a token in the build config —
 *      and refuses to publish on a hit.
 *   B. `check-channel` answers the real question ("would a shipped app update
 *      right now?") from an ANONYMOUS client, so success means the actual
 *      delivery path works, not that a config file looks right.
 *
 * Both are driven here. The functional half runs the audit against throwaway
 * git repos so a false pass cannot hide behind the real tree being clean.
 *
 * Run: node tests/unit/test_round292_public_channel.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-utils.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

/* ---------- A1. the audit script's contract ---------- */
{
  const g = readSource('scripts/go-public.mjs');
  ok(/credential-shaped strings/.test(g), 'it audits for secret shapes');
  ok(/gh\[pousr\]_/.test(g), 'it recognises GitHub tokens');
  ok(/BEGIN .*PRIVATE KEY/.test(g), 'it recognises private key blocks');
  ok(/AKIA/.test(g), 'it recognises AWS key ids');
  ok(/no \.env file is tracked/.test(g), 'it refuses a tracked .env');
  ok(/MT5 fixtures are redacted/.test(g), 'it refuses a fixture with a real login');
  ok(/'visibility=public'/.test(g), 'it performs the flip through the API');
  ok(/--dry-run/.test(g), 'it can audit without changing anything');
  ok(/refusing to publish/.test(g), 'it REFUSES to publish when the audit fails');
  ok(/check-channel\.mjs/.test(g), 'after flipping it proves the channel');
  /* the flip must come after the audit, never before */
  ok(g.indexOf('audit clean') < g.indexOf("'visibility=public'"),
    'the audit runs before the visibility flip');
}

/* ---------- A2. functional: the audit catches a planted secret ---------- */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oj-gp-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'go-public.mjs'), path.join(dir, 'scripts', 'go-public.mjs'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', build: {} }), 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n', 'utf8');

  const git = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);

  /* clean tree: the audit must PASS (otherwise it is just "always fail") */
  const clean = spawnSync(process.execPath, [path.join(dir, 'scripts', 'go-public.mjs'), '--dry-run'],
    { cwd: dir, encoding: 'utf8' });
  ok(clean.status === 0, 'a clean repo passes the audit', (clean.stdout || '').slice(-300));

  /* now plant a GitHub token in a tracked file */
  fs.writeFileSync(path.join(dir, 'leak.js'), 'const T = "ghp_' + 'A'.repeat(36) + '";\n', 'utf8');
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'leak']);
  const leaky = spawnSync(process.execPath, [path.join(dir, 'scripts', 'go-public.mjs'), '--dry-run'],
    { cwd: dir, encoding: 'utf8' });
  ok(leaky.status === 1, 'a planted token FAILS the audit', 'exit ' + leaky.status);
  ok(/GitHub token/.test(leaky.stdout || ''), 'and names the reason');
  ok(/refusing to publish/.test(leaky.stdout || ''), 'and refuses to publish');

  /* a tracked .env is also a stop */
  fs.rmSync(path.join(dir, 'leak.js'));
  fs.writeFileSync(path.join(dir, '.env'), 'MT5_PASSWORD=hunter2\n', 'utf8');
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'env']);
  const envRun = spawnSync(process.execPath, [path.join(dir, 'scripts', 'go-public.mjs'), '--dry-run'],
    { cwd: dir, encoding: 'utf8' });
  ok(envRun.status === 1, 'a tracked .env FAILS the audit', 'exit ' + envRun.status);
  ok(/\.env file is tracked/.test(envRun.stdout || ''), 'the .env assertion is the one that broke');

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---------- B. the channel probe asks the right question ---------- */
{
  const c = readSource('scripts/checks/check-channel.mjs');
  ok(/api\.github\.com\/repos\/\$\{OWNER\}/.test(c), 'it probes the anonymous repository API');
  ok(/releases\/download/.test(c), 'it probes the real release download URL');
  ok(/latest\.yml/.test(c), 'it probes the feed the app reads');
  ok(/User-Agent/.test(c), 'it sends a User-Agent (GitHub rejects anonymous calls without one)');
  /* no token may be used: that would prove nothing about a shipped app */
  ok(!/GH_TOKEN|GITHUB_TOKEN|Authorization/.test(c),
    'it uses NO credentials — a token would prove nothing about a shipped app');
  ok(/auto-update will NOT work/.test(c), 'it states plainly when the channel is not ready');
  ok(/The app is not broken/.test(c), 'and explains that the app degrades honestly');
}

/* ---------- C. the current state is reported, not assumed ---------- */
{
  /* The real check runs against the network. It MUST agree with the repo's
     actual visibility: while private it reports failure; that is the honest
     answer and it must not be "fixed" by weakening the probe. */
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'checks', 'check-channel.mjs'), '--json'],
    { encoding: 'utf8', timeout: 120_000 });
  let parsed = null;
  try {
    const start = r.stdout.indexOf('{');
    if (start >= 0) parsed = JSON.parse(r.stdout.slice(start));
  } catch (e) { parsed = null; }
  ok(!!parsed, 'the channel probe emits a machine-readable report', (r.stdout || r.stderr || '').slice(0, 200));
  if (parsed) {
    ok(Array.isArray(parsed.checks) && parsed.checks.length >= 2, 'the report lists the individual checks');
    ok(typeof parsed.ok === 'boolean', 'the report states a verdict');
    /* whatever the verdict, the process code must MATCH it — a probe that says
       "not ok" but exits 0 would silently pass CI */
    const expect = parsed.ok ? 0 : 1;
    ok(r.status === expect, 'the exit code matches the verdict',
      'exit ' + r.status + ' vs ok=' + parsed.ok);
  }
}

console.log('\nROUND292: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
