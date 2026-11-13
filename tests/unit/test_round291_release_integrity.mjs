/**
 * test_round291_release_integrity.mjs — the release process must be verifiable.
 *
 * From now on every published version has to be **deliverable**: a running app
 * reads a feed (`latest.yml`), takes `files[].url` from it and fetches that
 * exact asset. Anything that breaks that chain is invisible on the release page
 * and only shows up as "Check failed" on a user's machine.
 *
 * This suite pins three layers:
 *
 *   A. the gate itself (scripts/checks/check-release.mjs) actually CATCHES the
 *      mismatch that shipped in 1.9.217 — a feed naming a file that is not an
 *      asset — instead of trusting it because it prints "ok";
 *   B. the feed parser round-trips the real electron-builder shape (version,
 *      per-file url/size, sha512, blockmap references);
 *   C. CI runs the gate AFTER publishing, and the "channel unreachable" case is
 *      a neutral state, not a red error, so a private repo does not make every
 *      boot look broken.
 *
 * Run: node tests/unit/test_round291_release_integrity.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-utils.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = path.join(ROOT, 'scripts', 'checks', 'check-release.mjs');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

/* A throwaway "dist/" in a temp root, with the same layout electron-builder
   emits. The gate resolves dist/ relative to its own repo root, so the
   functional tests drive it through a copied script. */
function makeFakeRepo({ feedVersion, feedFile, assetFile, assetSize, extraFeeds = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oj-rel-'));
  fs.mkdirSync(path.join(dir, 'scripts', 'checks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.copyFileSync(GATE, path.join(dir, 'scripts', 'checks', 'check-release.mjs'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: feedVersion }), 'utf8');

  const writeFeed = (name) => {
    fs.writeFileSync(path.join(dir, 'dist', name), [
      'version: ' + feedVersion,
      'files:',
      '  - url: ' + feedFile,
      '    sha512: AAAABBBBCCCC==',
      '    size: ' + assetSize,
      'path: ' + feedFile,
      'sha512: AAAABBBBCCCC==',
      "releaseDate: '2026-11-13T00:00:00.000Z'",
    ].join('\n'), 'utf8');
  };
  writeFeed('latest.yml');
  if (extraFeeds) { writeFeed('latest-mac.yml'); writeFeed('latest-linux.yml'); }

  /* the real installer asset, with the size the feed claims */
  fs.writeFileSync(path.join(dir, 'dist', assetFile), Buffer.alloc(assetSize, 1));
  fs.writeFileSync(path.join(dir, 'dist', assetFile + '.blockmap'), Buffer.alloc(16, 2));
  /* the other platforms' installers so those feeds resolve too */
  if (extraFeeds) {
    fs.writeFileSync(path.join(dir, 'dist', 'App-1.0.0.dmg'), Buffer.alloc(assetSize, 3));
    fs.writeFileSync(path.join(dir, 'dist', 'App-1.0.0.dmg.blockmap'), Buffer.alloc(16, 4));
    fs.writeFileSync(path.join(dir, 'dist', 'App-1.0.0.AppImage'), Buffer.alloc(assetSize, 5));
    fs.writeFileSync(path.join(dir, 'dist', 'App-1.0.0.AppImage.blockmap'), Buffer.alloc(16, 6));
  }
  return dir;
}

function runGate(dir) {
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'checks', 'check-release.mjs'), '--dist'],
    { encoding: 'utf8', cwd: dir });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/* ---------- A. the gate CATCHES the 1.9.217 bug ---------- */
{
  /* Feed says "App-Setup-1.0.0.exe" (slugified, as electron-builder writes it),
     the artifact on disk is "App Setup 1.0.0.exe" (spaces, as NSIS names it).
     That is the exact mismatch that would have 404'd every update. */
  const bad = makeFakeRepo({
    feedVersion: '1.0.0',
    feedFile: 'App-Setup-1.0.0.exe',
    assetFile: 'App Setup 1.0.0.exe',
    assetSize: 128,
  });
  const badRun = runGate(bad);
  ok(badRun.code === 1, 'the gate FAILS a feed that names a missing asset', 'exit ' + badRun.code);
  ok(/exists as an asset/.test(badRun.out), 'and says which assertion broke');
  ok(/App-Setup-1\.0\.0\.exe/.test(badRun.out), 'the failing name is in the output');
  fs.rmSync(bad, { recursive: true, force: true });

  /* the same repo with matching names must pass — otherwise the gate is just
     "always fail", which is equally useless */
  const good = makeFakeRepo({
    feedVersion: '1.0.0',
    feedFile: 'App-Setup-1.0.0.exe',
    assetFile: 'App-Setup-1.0.0.exe',
    assetSize: 128,
  });
  const goodRun = runGate(good);
  ok(goodRun.code === 0, 'a consistent release PASSES', 'exit ' + goodRun.code + '\n' + goodRun.out.slice(0, 500));
  ok(/0 failed/.test(goodRun.out), 'and reports zero failures');
  fs.rmSync(good, { recursive: true, force: true });

  /* a wrong declared size is also a corrupt-update vector */
  const sized = makeFakeRepo({
    feedVersion: '1.0.0',
    feedFile: 'App-Setup-1.0.0.exe',
    assetFile: 'App-Setup-1.0.0.exe',
    assetSize: 128,
  });
  fs.writeFileSync(path.join(sized, 'dist', 'App-Setup-1.0.0.exe'), Buffer.alloc(200, 1));
  const sizeRun = runGate(sized);
  ok(sizeRun.code === 1, 'a size mismatch FAILS the gate', 'exit ' + sizeRun.code);
  ok(/size matches the feed/.test(sizeRun.out), 'the size assertion is the one that broke');
  fs.rmSync(sized, { recursive: true, force: true });

  /* a stale feed (built from an older version) must not ship */
  const stale = makeFakeRepo({
    feedVersion: '1.0.0',
    feedFile: 'App-Setup-1.0.0.exe',
    assetFile: 'App-Setup-1.0.0.exe',
    assetSize: 128,
  });
  fs.writeFileSync(path.join(stale, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.1' }), 'utf8');
  const staleRun = runGate(stale);
  ok(staleRun.code === 1, 'a feed whose version differs from package.json FAILS', 'exit ' + staleRun.code);
  ok(/version matches package.json/.test(staleRun.out), 'the version assertion is the one that broke');
  fs.rmSync(stale, { recursive: true, force: true });

  /* a missing platform feed is a real gap: that platform can never update */
  const missing = makeFakeRepo({
    feedVersion: '1.0.0',
    feedFile: 'App-Setup-1.0.0.exe',
    assetFile: 'App-Setup-1.0.0.exe',
    assetSize: 128,
    extraFeeds: false,
  });
  const missRun = runGate(missing);
  ok(missRun.code === 1, 'missing platform feeds FAIL', 'exit ' + missRun.code);
  ok(/latest-mac\.yml exists/.test(missRun.out), 'macOS feed is reported');
  ok(/latest-linux\.yml exists/.test(missRun.out), 'Linux feed is reported');
  fs.rmSync(missing, { recursive: true, force: true });
}

/* ---------- B. the parser handles the real shape ---------- */
{
  const src = readSource('scripts/checks/check-release.mjs');
  ok(/function parseFeed/.test(src), 'the gate has a feed parser');
  ok(/files:\s*\$\//.test(src) || /inFiles/.test(src), 'it understands the files: list');
  ok(/sha512/.test(src), 'it is aware of the checksum field');

  /* replicate the emitted shape and confirm the fields come back */
  const sample = [
    'version: 2.3.4',
    'files:',
    '  - url: OJchart-Setup-2.3.4.exe',
    '    sha512: Zm9vYmFy==',
    '    size: 83508093',
    'path: OJchart-Setup-2.3.4.exe',
    'sha512: Zm9vYmFy==',
    "releaseDate: '2026-11-13T00:00:00.000Z'",
  ].join('\n');
  /* drive the module's own parser by evaluating only that function */
  const fnText = src.slice(src.indexOf('function parseFeed'), src.indexOf('/* --- sources'));
  const parseFeed = new Function(fnText + '\nreturn parseFeed;')();
  const p = parseFeed(sample);
  ok(p.version === '2.3.4', 'version parses', p.version);
  ok(p.files.length === 1, 'one file entry parses', p.files.length);
  ok(p.files[0].url === 'OJchart-Setup-2.3.4.exe', 'file url parses', p.files[0].url);
  ok(String(p.files[0].size) === '83508093', 'file size parses', p.files[0].size);
  ok(p.files[0].sha512 === 'Zm9vYmFy==', 'file sha512 parses', p.files[0].sha512);
  ok(p.path === 'OJchart-Setup-2.3.4.exe', 'top-level path parses', p.path);
}

/* ---------- C. the pipeline wires it, and the honest states ---------- */
{
  const wf = readSource('.github/workflows/package.yml');
  ok(/check-release\.mjs/.test(wf), 'CI runs the release-integrity gate');
  ok(/Verify the published release/.test(wf), 'it runs as an explicit step');
  ok(wf.indexOf('Create release') < wf.indexOf('Verify the published release'),
    'the gate runs AFTER the release is published (it checks the real assets)');
  ok(/GH_TOKEN/.test(wf), 'the gate gets a token (private asset URLs are not anonymous)');
  ok(/contents:\s*write/.test(wf), 'the workflow may publish');

  /* the updater must not present an unreachable channel as a broken app */
  const upd = readSource('src/platform/electron/updater.js');
  ok(/function isNoChannel/.test(upd), 'the updater classifies an unreachable channel');
  ok(/state:\s*'channel'/.test(upd), 'it reports a dedicated channel state');
  ok(/404/.test(upd), 'a 404 is treated as "no channel", not a crash');

  const ui = readSource('src/renderer/js/panels/update-ui.js');
  ok(/channel:\s*'Update channel unavailable/.test(ui),
    'the panel explains the channel state in plain words');
  ok(/download from the release page/.test(ui), 'and points at the manual path');
  ok(/dg-up-dim/.test(ui), 'the channel state is not painted as an error');
  const poll = ui.slice(ui.indexOf('setInterval'));
  const pollCode = poll.slice(0, poll.indexOf('}, UPDATE_POLL_MS)'));
  /* strip comments so the assertion is about the CONDITION, not the prose */
  const pollCond = pollCode.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok(!/channel/.test(pollCond),
    'the poller does not retry a channel that cannot become reachable', pollCond.trim().slice(0, 160));

  /* a manual check must still be possible: the button is only hidden for
     downloading/downloaded/disabled */
  ok(/check\.classList\.toggle\('hidden'[^)]*'disabled'\)/.test(ui) ||
     /st === 'downloading' \|\| st === 'downloaded' \|\| st === 'disabled'/.test(ui),
    'Check stays available for the channel state');
}

console.log('\nROUND291: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
