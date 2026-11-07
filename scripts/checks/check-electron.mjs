#!/usr/bin/env node
/**
 * Electron compatibility gate (F8.5).
 *
 * The app ships a pinned Electron runtime and main-process code that must stay
 * inside the APIs that runtime still supports. This gate catches the three
 * mistakes that historically broke releases:
 *
 *   1. `package.json` and `node_modules/electron` disagree (a half-finished
 *      bump that only updated the lockfile-less install);
 *   2. main/preload code calls an API removed before Electron 33 (`remote`,
 *      `enableRemoteModule`, `app.allowRendererProcessReuse`, …);
 *   3. the installed electron-builder is older than the version that first
 *      supported the pinned Electron major.
 *
 * Run: npm run check:electron
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* First electron-builder release line known to package the pinned runtime. */
const MIN_BUILDER = '24.13.0';

/* APIs removed in Electron 33 or earlier; the exact call sites matter because
   a match may be a comment describing the removal — those are ignored below. */
const BANNED = [
  { re: /require\(\s*['"]electron['"]\s*\)\.remote/, why: 'the remote module was removed in Electron 20' },
  { re: /\bwebPreferences\s*:\s*\{[^}]*enableRemoteModule\s*:/, why: 'enableRemoteModule was removed in Electron 20' },
  { re: /app\.allowRendererProcessReuse/, why: 'allowRendererProcessReuse was removed in Electron 15' },
  { re: /webContents\.getPrinters\s*\(/, why: 'getPrinters moved to the printing module' },
  { re: /new\s+BrowserWindow\s*\(\s*\{[^}]*webSecurity\s*:\s*false/, why: 'disabling webSecurity has no supported use here' },
];

const SOURCES = ['main.js', 'preload.js', path.join('src', 'platform', 'electron')];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cmpVersion(a, b) {
  const pa = String(a).replace(/^[^0-9]*/, '').split('.').map(Number);
  const pb = String(b).replace(/^[^0-9]*/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function collectSources() {
  const files = [];
  for (const entry of SOURCES) {
    const p = path.join(ROOT, entry);
    if (!fs.existsSync(p)) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) {
        if (name.endsWith('.js') || name.endsWith('.cjs')) files.push(path.join(p, name));
      }
    } else {
      files.push(p);
    }
  }
  return files;
}

let fail = 0;
const ok = (label, detail) => console.log(`  ok ${label}${detail ? ' — ' + detail : ''}`);
const bad = (label, detail) => { fail++; console.log(`  FAIL: ${label}${detail ? ' — ' + detail : ''}`); };

console.log('[electron] compatibility gate');

/* ---------- 1. pinned version == installed version ---------- */
const pkg = readJson(path.join(ROOT, 'package.json'));
const pin = String(pkg.devDependencies && pkg.devDependencies.electron || '').replace(/^[^0-9]*/, '');
if (!pin) bad('package.json pins electron', 'missing devDependencies.electron');
else {
  const installedPath = path.join(ROOT, 'node_modules', 'electron', 'package.json');
  if (!fs.existsSync(installedPath)) {
    bad('electron is installed', 'run npm install');
  } else {
    const installed = String(readJson(installedPath).version);
    if (installed === pin) ok('electron pin matches node_modules', installed);
    else bad('electron pin matches node_modules', `pin ${pin} != installed ${installed}`);

    const bin = process.platform === 'win32'
      ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
      : process.platform === 'darwin'
        ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
    if (fs.existsSync(bin)) {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000 });
      const text = String(r.stdout || '').trim();
      if (r.status === 0 && text) ok('runtime reports its version', text);
      else console.log('  -- runtime --version unavailable in this environment (skipped)');
    } else {
      console.log('  -- Electron binary not downloaded yet (skipped --version)');
    }
  }
}

/* ---------- 2. no removed APIs in main/preload ---------- */
const sources = collectSources();
if (!sources.length) bad('main/preload sources found');
else {
  let hits = 0;
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (const { re, why } of BANNED) {
      lines.forEach((line, i) => {
        const t = line.trim();
        if (!re.test(t)) return;
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        hits++;
        bad(`${path.relative(ROOT, file)}:${i + 1} uses a removed API`, why);
      });
    }
  }
  if (!hits) ok(`no removed Electron APIs in ${sources.length} main/preload file(s)`);
}

/* ---------- 3. electron-builder supports the runtime ---------- */
const builderPin = String(pkg.devDependencies && pkg.devDependencies['electron-builder'] || '');
const builderInstalledPath = path.join(ROOT, 'node_modules', 'electron-builder', 'package.json');
if (!builderPin) bad('package.json pins electron-builder');
else if (!fs.existsSync(builderInstalledPath)) bad('electron-builder is installed', 'run npm install');
else {
  const builderInstalled = String(readJson(builderInstalledPath).version);
  if (cmpVersion(builderInstalled, MIN_BUILDER) >= 0) {
    ok('electron-builder is compatible', `${builderInstalled} >= ${MIN_BUILDER}`);
  } else {
    bad('electron-builder is compatible', `${builderInstalled} < ${MIN_BUILDER}`);
  }
}

if (fail) {
  console.error(`[electron] FAIL — ${fail} problem(s)`);
  process.exit(1);
}
console.log('[electron] OK');
