#!/usr/bin/env node
/**
 * F7.3 — release checklist automation.
 *
 * One command performs the boring, error-prone half of a release:
 *
 *   1. optional `npm run verify`
 *   2. bump `package.json` + `src/core/logger.js` APP_VERSION together
 *   3. add the entry to the split changelog (changelog/v<major>.<minor>.md)
 *   4. refresh the CHANGELOG.md index
 *   5. commit `Release x.y.z` and create tag `vx.y.z`
 *   6. build the installer for the current OS
 *
 * Usage:
 *   node scripts/release.mjs                  # patch bump + verify + build
 *   node scripts/release.mjs --bump minor
 *   node scripts/release.mjs --version 1.10.0
 *   node scripts/release.mjs --no-build       # stop after the tag
 *   node scripts/release.mjs --dry-run        # print the plan, write nothing
 *   node scripts/release.mjs --message "Fix login retry"   # changelog bullet
 *
 * The build itself is never run with --dry-run/--no-build; signing
 * credentials are read by electron-builder from CSC_LINK/CSC_KEY_PASSWORD
 * (see README).
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function nextVersion(current, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(current || ''));
  if (!m) throw new Error('invalid current version: ' + current);
  const major = +m[1], minor = +m[2], patch = +m[3];
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error('invalid bump: ' + bump);
}

export function validateVersion(v) {
  if (!/^\d+\.\d+\.\d+$/.test(String(v || ''))) throw new Error('invalid version: ' + v);
  return v;
}

export function changelogFile(version) {
  const m = /^(\d+)\.(\d+)\./.exec(version);
  if (!m) throw new Error('invalid version: ' + version);
  return `changelog/v${+m[1]}.${+m[2]}.md`;
}

export function renderEntry(version, date, message) {
  const title = `## ${version} — ${date}`;
  const body = String(message || '').trim() || `Release ${version}.`;
  const bullets = body.split(/\r?\n/).filter(Boolean).map((l) => (l.startsWith('- ') ? l : `- ${l}`));
  return `${title}\n\n${bullets.join('\n')}\n`;
}

export function insertEntry(fileText, entry) {
  const idx = fileText.search(/^## /m);
  if (idx < 0) return fileText.replace(/\s*$/, '') + '\n\n' + entry;
  return fileText.slice(0, idx) + entry + '\n' + fileText.slice(idx);
}

export function updateIndex(text, version, clFile) {
  const out = text.replace(/Current version: \*\*[^*]+\*\*/, `Current version: **${version}**`);
  if (out.includes('`' + clFile + '`')) return out;

  const [, majorText, minorText] = /^(\d+)\.(\d+)\./.exec(version);
  const major = +majorText, minor = +minorText;
  const row = `| [\`${clFile}\`](${clFile}) | ${major}.${minor}.x |`;

  const lines = out.split('\n');
  const rows = [];
  lines.forEach((line, i) => {
    const m = /^\|\s*\[`changelog\/v(\d+)\.(\d+)[^`]*`\]/.exec(line);
    if (m) rows.push({ i, major: +m[1], minor: +m[2] });
  });

  if (!rows.length) return out.replace(/\s*$/, '') + '\n' + row + '\n';

  // The table is ordered newest first: insert above the first older line.
  const older = rows.find((r) => r.major < major || (r.major === major && r.minor < minor));
  lines.splice(older ? older.i : rows[rows.length - 1].i + 1, 0, row);
  return lines.join('\n');
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
}

function gitOut(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' failed: ' + (r.stderr || ''));
  return String(r.stdout || '').trim();
}

function main(argv) {
  const arg = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const has = (name) => argv.includes(name);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.chdir(root);

  const pkgPath = 'package.json';
  const pkgText = fs.readFileSync(pkgPath, 'utf8');
  const current = /"version"\s*:\s*"([^"]+)"/.exec(pkgText)[1];
  const version = has('--version')
    ? validateVersion(arg('--version'))
    : nextVersion(current, arg('--bump', 'patch'));
  const date = new Date().toISOString().slice(0, 10);
  const dry = has('--dry-run');
  const clFile = changelogFile(version);
  const tag = 'v' + version;

  console.log(`[release] ${current} -> ${version}${dry ? ' (dry run)' : ''}`);

  if (!dry && !has('--allow-dirty')) {
    const dirty = gitOut(['status', '--porcelain']);
    if (dirty) throw new Error('working tree is not clean — commit/stash first (or --allow-dirty)');
  }
  if (!dry && gitOut(['tag', '--list', tag])) throw new Error('tag already exists: ' + tag);

  if (!dry && !has('--no-verify')) sh('npm', ['run', 'verify']);

  const entry = renderEntry(version, date, arg('--message'));
  const clAbs = path.join(root, clFile);
  const clText = fs.existsSync(clAbs)
    ? fs.readFileSync(clAbs, 'utf8')
    : `# CHANGELOG — ${version.split('.').slice(0, 2).join('.')}.x\n\nSplit from the root [CHANGELOG.md](../CHANGELOG.md) index.\n`;

  if (dry) {
    console.log('[release] would update', pkgPath, '->', version);
    console.log('[release] would update src/core/logger.js APP_VERSION ->', version);
    console.log('[release] would prepend to', clFile + ':');
    console.log(entry);
    console.log('[release] would update CHANGELOG.md index');
    console.log('[release] would commit "Release ' + version + '" and tag ' + tag);
    if (!has('--no-build')) console.log('[release] would run the platform build');
    return;
  }

  fs.writeFileSync(pkgPath, pkgText.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`), 'utf8');
  const logPath = 'src/core/logger.js';
  let logText = fs.readFileSync(logPath, 'utf8');
  if (!/const APP_VERSION = '[^']+';/.test(logText)) throw new Error('APP_VERSION declaration not found in ' + logPath);
  logText = logText.replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${version}';`);
  fs.writeFileSync(logPath, logText, 'utf8');

  fs.writeFileSync(clAbs, insertEntry(clText, entry), 'utf8');
  const idxPath = 'CHANGELOG.md';
  fs.writeFileSync(idxPath, updateIndex(fs.readFileSync(idxPath, 'utf8'), version, clFile), 'utf8');

  sh('git', ['add', pkgPath, logPath, clFile, idxPath]);
  sh('git', ['commit', '-m', 'Release ' + version]);
  sh('git', ['tag', tag]);

  if (!has('--no-build')) {
    const script = process.platform === 'win32' ? 'dist:win' : process.platform === 'darwin' ? 'dist:mac' : 'dist:linux';
    console.log('[release] building via npm run ' + script);
    sh('npm', ['run', script]);
  }
  console.log(`[release] done: ${version} (tag ${tag})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error('[release] ' + (e && e.message || e));
    process.exit(1);
  }
}
