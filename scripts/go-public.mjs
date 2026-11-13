#!/usr/bin/env node
/**
 * Go public — the one-command switch (ROUND292).
 *
 * The repository is private today and will be made public later. When that
 * happens, auto-update must start working WITHOUT a code change: the feed URL
 * is already baked into the packaged `app-update.yml`, and the only thing
 * blocking it is GitHub answering 404 to an anonymous client.
 *
 * This script does the two halves a person would otherwise have to remember:
 *
 *   1. AUDIT — look for anything that must not be public (secrets committed by
 *      accident, real account credentials in fixtures, an update feed that
 *      would leak a token). It refuses to proceed on a hit.
 *   2. FLIP + PROVE — flip the repository visibility with `gh`, wait for the
 *      CDN to settle, then verify the channel with the same anonymous probe the
 *      app uses (scripts/checks/check-channel.mjs).
 *
 * Usage:
 *   node scripts/release.mjs go-public --dry-run     # audit only, change nothing
 *   node scripts/release.mjs go-public               # audit, flip, verify
 *
 * The audit is deliberately paranoid: a leak in a public repo cannot be undone
 * by deleting the file, because the history keeps it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = 'nesari';
const REPO = 'oj-chart-terminal';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/* ============ 1. AUDIT ============ */
console.log('[go-public] auditing for anything that must not become public\n');

/* 1a. credential-shaped strings tracked by git. This looks for the SHAPES of
   real secrets, not the words — a test fixture may legitimately contain the
   string "password" as a JSON key. */
{
  const tracked = sh('git', ['ls-files']);
  const files = tracked.out.split(/\r?\n/).filter(Boolean);
  /* anything binary / huge is not a credential carrier */
  const textish = files.filter((f) => /\.(js|mjs|cjs|json|yml|yaml|py|md|txt|env|example|cfg|ini|toml)$/i.test(f));

  const PATTERNS = [
    { re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, why: 'private key block' },
    { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/, why: 'GitHub token' },
    { re: /\bsk-[A-Za-z0-9]{20,}/, why: 'API secret key' },
    { re: /\bAKIA[0-9A-Z]{16}\b/, why: 'AWS access key id' },
    { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, why: 'Slack token' },
    { re: /\bAIza[0-9A-Za-z_-]{35}\b/, why: 'Google API key' },
  ];
  const hits = [];
  for (const f of textish) {
    let body;
    try { body = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }
    for (const p of PATTERNS) {
      if (p.re.test(body)) hits.push(f + ' (' + p.why + ')');
    }
  }
  ok(hits.length === 0, 'no credential-shaped strings in tracked files', hits.slice(0, 5).join(', '));
}

/* 1b. a .env file must not be tracked (it may hold provider credentials) */
{
  const tracked = sh('git', ['ls-files']).out.split(/\r?\n/);
  const envTracked = tracked.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !/\.example$|\.sample$|\.template$/.test(f));
  ok(envTracked.length === 0, 'no .env file is tracked', envTracked.join(', '));
}

/* 1c. the MT5 account fixture must be redacted. The recorder writes a
   redacted fixture by default; this proves the committed one carries no login
   or server. */
{
  const fixtures = sh('git', ['ls-files']).out.split(/\r?\n/).filter((f) => /fixtures?\//.test(f) && f.endsWith('.json'));
  let leaky = [];
  for (const f of fixtures) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (e) { continue; }
    const s = JSON.stringify(j);
    /* a real login is a long digit run; a redacted one is "***" or absent */
    if (/"login"\s*:\s*"?\d{5,}/.test(s)) leaky.push(f + ' (real login)');
    if (/"password"\s*:\s*"[^"*]{3,}"/.test(s)) leaky.push(f + ' (password value)');
  }
  ok(leaky.length === 0, 'MT5 fixtures are redacted', leaky.join(', '));
}

/* 1d. electron-builder must not embed a signing password or token */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const blob = JSON.stringify(pkg.build || {});
  ok(!/CSC_KEY_PASSWORD"\s*:\s*"[^"]+/.test(blob), 'the build config carries no signing password');
  ok(!/GH_TOKEN|GITHUB_TOKEN/.test(blob), 'the build config carries no publishing token');
}

/* 1e. the release feed the app reads must be token-free. It is generated at
   build time by electron-builder from `build.publish`; a token there would be
   copied into every installed app. */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const pub = pkg.build && pkg.build.publish;
  const hasToken = /token|password|secret/i.test(JSON.stringify(pub || {}));
  ok(!hasToken, 'build.publish contains no credentials');
}

/* 1f. HISTORY. A public repository exposes every commit, so a secret that was
   committed and later deleted is still readable forever. The checks above only
   look at the current tree; this walks every blob that ever existed. */
{
  console.log('\n  -- scanning the full git history (a deleted secret is still public) --');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'checks', 'scan-history.mjs')],
    { encoding: 'utf8', timeout: 600_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const clean = r.status === 0;
  ok(clean, 'no credential shapes in any commit', clean ? '' : out.slice(-500));
  if (!clean) console.log(out);
}

/* 1g. docs/README must not promise something the code does not do. Cheap
   check: the documented update limitation should still be present while the
   repo is private. Once public, this line becomes wrong and should be removed
   in the same commit — flagged, not failed, because it is prose. */
{
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const mentionsPrivacy = /private|Update channel unavailable/i.test(readme);
  if (mentionsPrivacy) {
    console.log('  note "README still documents the private-repo limitation."');
    console.log('       After going public, replace that paragraph with the working flow.');
  }
}

/* ============ 2. FLIP ============ */
if (fail) {
  console.log(`\n[go-public] ${pass} passed, ${fail} failed — refusing to publish.`);
  console.log('[go-public] fix the failures above first; a leak in public history cannot be undone.');
  process.exit(1);
}
console.log(`\n[go-public] audit clean (${pass} checks).`);

if (dry) {
  console.log('[go-public] dry run — would flip ' + OWNER + '/' + REPO + ' to public, then verify.');
  console.log('[go-public] then the shipped app starts auto-updating with no code change.');
  process.exit(0);
}

const before = sh('gh', ['api', `repos/${OWNER}/${REPO}`, '--jq', '.visibility']);
if (before.code !== 0) {
  console.error('[go-public] cannot read the repository: ' + before.err);
  process.exit(1);
}
console.log('[go-public] current visibility: ' + before.out);
if (before.out === 'public') {
  console.log('[go-public] already public — verifying the channel instead of flipping.');
} else {
  const flip = sh('gh', ['api', '-X', 'PATCH', `repos/${OWNER}/${REPO}`, '-f', 'visibility=public']);
  if (flip.code !== 0) {
    console.error('[go-public] the flip failed: ' + flip.err);
    console.error('[go-public] (billing/permission problems surface here)');
    process.exit(1);
  }
  console.log('[go-public] repository is now public.');
}

/* ============ 3. PROVE ============ */
/* The release CDN can take a moment to serve assets for a repository that just
   changed visibility; poll instead of failing on the first attempt. */
console.log('\n[go-public] verifying the update channel as an ANONYMOUS client…');
let channelOk = false;
for (let attempt = 1; attempt <= 6; attempt++) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'checks', 'check-channel.mjs')],
    { encoding: 'utf8' });
  if (r.status === 0) { channelOk = true; break; }
  if (attempt < 6) {
    console.log(`[go-public] attempt ${attempt} not ready yet — waiting 20s`);
    /* a synchronous sleep: this is a CLI, not a server */
    const until = Date.now() + 20000;
    while (Date.now() < until) { /* wait */ }
  }
}

if (channelOk) {
  console.log('\n[go-public] DONE — a shipped build will now find and download updates.');
  console.log('[go-public] next release: run the normal release flow; nothing else changes.');
  process.exit(0);
}
console.log('\n[go-public] the repository is public but the channel still fails.');
console.log('[go-public] usual causes: no published release yet, or the CDN is still warming.');
console.log('[go-public] re-check with: node scripts/checks/check-channel.mjs');
process.exit(1);
