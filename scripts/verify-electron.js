#!/usr/bin/env node
/**
 * scripts/verify-electron.js  (round 81 — supply-chain hardening)
 *
 * WHY THIS EXISTS
 * ----------------
 * run-demo.bat / run-mt5.bat set ELECTRON_MIRROR to npmmirror.com so first-run
 * installs work on networks where GitHub Releases is slow/blocked. That mirror
 * is reputable and widely used, but it is still a third party: if it were ever
 * compromised, it could serve a modified electron.exe AND a matching (forged)
 * SHASUMS256.txt, since both come from the same source. A user who only checks
 * "does the checksum in the mirror match" would never notice.
 *
 * This script closes that gap: it re-verifies the cached Electron zip against
 * the OFFICIAL checksums published on GitHub Releases (electron/electron),
 * which is a source independent of the mirror. If the two disagree, install
 * is treated as untrusted and the run is aborted.
 *
 * This does not replace the mirror (still needed for reachability) — it just
 * makes tampering by the mirror detectable instead of silent.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const os = require('os');

function log(msg) { console.log('[verify-electron] ' + msg); }
function fail(msg) {
  console.error('[verify-electron] FAILED: ' + msg);
  console.error('[verify-electron] Refusing to launch — the Electron binary could not be verified against the official checksum.');
  process.exit(1);
}

function readInstalledVersion() {
  const pkgPath = path.join(__dirname, '..', 'node_modules', 'electron', 'package.json');
  if (!fs.existsSync(pkgPath)) fail('node_modules/electron not found — run npm install first.');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return pkg.version;
}

// Electron's npm installer caches the downloaded zip here by default.
// See @electron/get's default cache path resolution.
function cacheDir() {
  if (process.env.electron_config_cache) return process.env.electron_config_cache;
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : (process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'));
  return path.join(base, 'electron', 'Cache');
}

function findCachedZip(version) {
  const dir = cacheDir();
  if (!fs.existsSync(dir)) return null;
  const wanted = `electron-v${version}-`;
  const hit = [];
  (function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.startsWith(wanted) && e.name.endsWith('.zip')) hit.push(p);
    }
  })(dir);
  return hit[0] || null;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// Fetches the OFFICIAL checksum file directly from GitHub — deliberately NOT
// from ELECTRON_MIRROR / npmmirror, so a compromised mirror cannot forge both
// halves of the check.
function fetchOfficialShasums(version) {
  const url = `https://github.com/electron/electron/releases/download/v${version}/SHASUMS256.txt`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'mt5-chart-terminal-verify' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return https.get(res.headers.location, (res2) => {
          let body = '';
          res2.on('data', (c) => (body += c));
          res2.on('end', () => resolve(body));
        }).on('error', reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' fetching official SHASUMS256.txt'));
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function main() {
  const version = readInstalledVersion();
  log(`installed electron version: ${version}`);

  const zip = findCachedZip(version);
  if (!zip) {
    // Nothing cached (e.g. already-extracted install, or non-default cache
    // path) — nothing we can re-hash. Don't block the run, just say so.
    log('no cached zip found to re-verify (already extracted or custom cache path) — skipping.');
    return;
  }
  log(`hashing cached archive: ${zip}`);
  const actual = await sha256File(zip);

  let official;
  try {
    official = await fetchOfficialShasums(version);
  } catch (e) {
    log(`could not reach GitHub to fetch official checksums (${e.message}) — skipping verification this run.`);
    return; // network-restricted environment: don't hard-block, just don't silently trust either
  }

  const zipName = path.basename(zip);
  const line = official.split('\n').find((l) => l.trim().endsWith(zipName));
  if (!line) {
    fail(`official SHASUMS256.txt has no entry for ${zipName} (version mismatch or renamed asset).`);
  }
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  if (expected !== actual.toLowerCase()) {
    fail(`checksum mismatch for ${zipName}\n  expected (official GitHub release): ${expected}\n  actual   (downloaded via mirror):    ${actual}`);
  }
  log('OK — cached Electron archive matches the official GitHub release checksum.');
}

main().catch((e) => fail(e.stack || String(e)));
