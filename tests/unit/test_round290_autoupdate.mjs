/**
 * test_round290_autoupdate.mjs — auto-update bridge + release wiring.
 *
 * What this pins (all of it is behaviour that a user or CI depends on):
 *   1. The updater NEVER downloads or installs without an explicit call.
 *      `check()` only asks for the manifest; `download()` is a separate step.
 *   2. A dev build (`app.isPackaged === false`) reports `disabled` instead of
 *      throwing into the renderer — `npm start` must not show update errors.
 *   3. A failed check is a quiet `error` state, not a stack trace: an offline
 *      laptop is the common case.
 *   4. The renderer contract: `updateStatus/Check/Download/Install` exist on
 *      the preload bridge and no URL/token/path crosses it.
 *   5. The release pipeline actually publishes what the updater reads:
 *      `Package` needs `contents: write`, uploads the `*.yml` feed and creates
 *      a Release on a tag. Without this the app would check a feed that no
 *      workflow ever produced (exactly the ROUND289 gap).
 *
 * `electron` is stubbed through a tiny require hook so the module runs in
 * plain Node; `electron-updater` is stubbed the same way, which also proves
 * the module tolerates it being absent (dev installs).
 *
 * Run: node tests/unit/test_round290_autoupdate.mjs
 */

import { createRequire } from 'module';
import Module from 'module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-utils.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

/* ---------- stub electron + electron-updater ---------- */
const calls = { check: 0, download: 0, quit: 0 };
const fakeEmitter = {
  handlers: {},
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; },
  fire(ev, arg) { for (const fn of this.handlers[ev] || []) fn(arg); },
  set autoDownload(v) { this._ad = v; },
  get autoDownload() { return this._ad; },
  autoInstallOnAppQuit: false,
  allowPrerelease: true,
  async checkForUpdates() { calls.check++; this.fire('checking-for-update'); },
  async downloadUpdate() { calls.download++; this.fire('download-progress', { percent: 41.7 }); },
  quitAndInstall() { calls.quit++; },
};

let packaged = true;
const fakeElectron = {
  app: {
    isPackaged: true,
    getVersion: () => '1.9.217',
    get isPackagedFlag() { return packaged; },
  },
};
/* `isPackaged` is read as a plain property, so define it as a getter that the
   test can flip. */
Object.defineProperty(fakeElectron.app, 'isPackaged', { get: () => packaged });

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (request === 'electron-updater') return { autoUpdater: fakeEmitter };
  return origLoad.call(this, request, parent, isMain);
};

const require = createRequire(import.meta.url);
const UPDATER = '../../src/platform/electron/updater.js';
/* The module deliberately initialises ONCE per process (a real app never
   changes `app.isPackaged` mid-run). The suite has to exercise both the dev
   and the packaged path, so it reloads the module from a clean require cache
   instead of asking production code for a test-only reset hook.
   `Module._load` stays patched for the WHOLE run: every reload re-resolves
   `electron` and `electron-updater`, and the real ones cannot be required
   outside the Electron runtime. */
function loadUpdater() {
  delete require.cache[require.resolve(UPDATER)];
  return require(UPDATER);
}
let updater = loadUpdater();

const logs = [];
const log = (lvl, msg, ctx) => logs.push({ lvl, msg, ctx });

/* ---------- 1. dev build: disabled, never throws ---------- */
{
  packaged = false;
  calls.check = 0; calls.download = 0;
  updater = loadUpdater();
  const s = updater.init({ log });
  ok(s.state === 'disabled', 'a dev build reports disabled', s.state);
  const c = await updater.check({ log });
  ok(c.state === 'disabled', 'check in a dev build stays disabled', c.state);
  ok(calls.check === 0, 'a dev build never calls checkForUpdates', calls.check);
  ok((await updater.download({ log })).state === 'disabled', 'download in a dev build is a no-op');
  ok(updater.install() === false, 'install refuses unless a download finished');
  ok(logs.some((l) => /dev build/i.test(l.msg)), 'the disabled path is logged');
}

/* ---------- 2. packaged: check does NOT download ---------- */
{
  packaged = true;
  calls.check = 0; calls.download = 0; calls.quit = 0;
  fakeEmitter.handlers = {};
  fakeEmitter._ad = undefined;
  updater = loadUpdater();
  updater.init({ log });
  const before = calls.download;
  let s = await updater.check({ log });
  ok(calls.check >= 1, 'check calls checkForUpdates once packaged', calls.check);
  ok(calls.download === before, 'check must NOT start a download', calls.download);
  ok(s.state === 'checking' || s.state === 'idle' || s.state === 'available' || s.state === 'none',
    'check leaves a sane state', s.state);
  ok(fakeEmitter.autoDownload === false, 'autoDownload is off — no silent downloads');
  ok(fakeEmitter.autoInstallOnAppQuit === false,
    'autoInstallOnAppQuit is off — "Later" must not install on quit');
  ok(fakeEmitter.allowDowngrade === false,
    'allowDowngrade is off — a rolled-back feed must not downgrade users');

  /* the emitter's available event becomes a downloadable state */
  fakeEmitter.fire('update-available', { version: '1.9.218' });
  s = updater.status();
  ok(s.state === 'available' && s.version === '1.9.218', 'an available update is reported', JSON.stringify(s));

  /* download only on the explicit call */
  const d = await updater.download({ log });
  ok(calls.download === before + 1, 'download happens only when asked', calls.download);
  ok(d.state === 'downloading', 'download reports progress', d.state);
  fakeEmitter.fire('download-progress', { percent: 99.6 });
  ok(updater.status().percent === 100, 'progress is clamped and rounded', updater.status().percent);

  fakeEmitter.fire('update-downloaded', { version: '1.9.218' });
  ok(updater.status().state === 'downloaded', 'a finished download is installable');
  ok(updater.install() === true, 'install accepts a downloaded update');
  await new Promise((r) => setTimeout(r, 20));
  ok(calls.quit === 1, 'install actually asks the updater to restart', calls.quit);
}

/* ---------- 3. a failed check is quiet ---------- */
{
  const errorsBefore = logs.filter((l) => l.lvl === 'error').length;
  const debugBefore = logs.filter((l) => l.lvl === 'debug' && /update check failed/i.test(l.msg)).length;
  fakeEmitter.fire('error', new Error('net::ERR_INTERNET_DISCONNECTED\n    at TLSSocket…'));
  const s = updater.status();
  ok(s.state === 'error', 'a failed check becomes an error state', s.state);
  ok(/ERR_INTERNET_DISCONNECTED/.test(s.error || ''), 'the message is kept', s.error);
  ok(/\n/.test(s.error || '') === false, 'the stack is stripped from the message', JSON.stringify(s.error));
  const errorsAfter = logs.filter((l) => l.lvl === 'error').length;
  ok(errorsAfter === errorsBefore, 'an offline check logs at debug, not error');
  const debugAfter = logs.filter((l) => l.lvl === 'debug' && /update check failed/i.test(l.msg)).length;
  ok(debugAfter === debugBefore + 1, 'the failure is logged as debug', debugAfter + ' vs ' + debugBefore);
}

/* ---------- 4. the renderer contract ---------- */
{
  const pre = readSource('preload.js');
  for (const fn of ['updateStatus', 'updateCheck', 'updateDownload', 'updateInstall', 'onUpdateState']) {
    ok(new RegExp(fn + '\\s*:').test(pre), 'preload exposes ' + fn);
  }
  ok(/ipcRenderer\.invoke\('update-check'\)/.test(pre), 'the bridge calls the update-check channel');
  ok(/ipcRenderer\.on\('update-state'/.test(pre), 'the bridge streams update state');
  /* nothing but the four verbs may cross the bridge */
  ok(!/update.*(https?:|token|\.exe)/i.test(pre), 'no URL, token or file path crosses the bridge');

  const ui = readSource('src/renderer/js/panels/update-ui.js');
  ok(/electronAPI/.test(ui), 'the panel goes through the electron bridge');
  ok(/updateDownload/.test(ui) && /updateInstall/.test(ui), 'the panel exposes download + install');
  /* A browser build has no bridge, so `status.current` is null — the chip must
     fall back to the logger's APP_VERSION instead of rendering "v?" (that is
     exactly what the first live run showed). */
  ok(/Log\.stats\(\)\.version/.test(ui), 'the version chip falls back to APP_VERSION without a bridge');
  ok(!/ver\.textContent\s*=\s*'v'\s*\+\s*\(status\.current\s*\|\|\s*'\?'\)/.test(ui),
    'the chip no longer depends on the bridge alone');
  /* The key safety property: no auto-download, no auto-install anywhere. */
  ok(!/autoDownload\s*=\s*true/.test(ui), 'the renderer never enables autoDownload');
  ok(/setTimeout\([^)]*12000|12000\)/.test(ui), 'the boot check is deferred so it never races the first paint');

  /* ---------- ROUND291: the app OFFERS, downloads in-app, then installs ----------
     The user-facing promise is a chain, and each link has to exist:
       1. on boot the app checks (deferred so it never races the first paint);
       2. it keeps checking while the window stays open;
       3. "available" offers a Download action (not a pointer to another panel);
       4. the download shows live progress in one persistent toast;
       5. when it finishes the same channel offers "Restart & install".
     Every link is asserted; a broken one turns the feature into a dead end. */
  ok(/setInterval\(/.test(ui) && /UPDATE_POLL_MS/.test(ui),
    'a long-running window re-checks periodically');
  ok(/UPDATE_POLL_MS\s*=\s*6\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(ui),
    'the re-check interval is six hours');
  ok(/actionLabel:\s*'Download'/.test(ui), 'the available toast offers Download itself');
  ok(/run\('download'\)/.test(ui), 'Download starts the in-app download');
  ok(/Downloading update… /.test(ui) && /percent/.test(ui), 'download progress is shown live');
  ok(/progressToast/.test(ui), 'one persistent toast covers the whole download');
  ok(/actionLabel:\s*'Restart & install'/.test(ui),
    'a finished download offers Restart & install');
  ok(/run\('install'\)/.test(ui), 'that action asks main to restart and install');
  ok(!/open Diagnostics to install/.test(ui),
    'the toast no longer just points at the Diagnostics panel');

  /* toast() must hand back its element so the progress line can be updated */
  const toastSrc = readSource('src/renderer/js/drawing/ui.js');
  const toastFn = toastSrc.slice(toastSrc.indexOf('function toast('), toastSrc.indexOf('UI.toast ='));
  ok(/return t;/.test(toastFn), 'toast() returns its element for live updates');

  const html = readSource('src/renderer/index.html');
  ok(/id="dg-up-ver"/.test(html), 'the Diagnostics panel has a version chip');
  ok(/id="dg-up-check"/.test(html) && /id="dg-up-get"/.test(html) && /id="dg-up-install"/.test(html),
    'the panel has check / download / install buttons');
}

/* ---------- 5. the release pipeline publishes what the updater reads ---------- */
{
  const wf = readSource('.github/workflows/package.yml');
  ok(/contents:\s*write/.test(wf), 'Package has contents: write so it can publish');
  ok(/softprops\/action-gh-release/.test(wf), 'Package creates a GitHub Release');
  ok(/dist\/\*\.yml/.test(wf), 'the *.yml update feed is uploaded');
  ok(/dist\/\*\.blockmap/.test(wf), 'the blockmap for differential downloads is uploaded');
  ok(/files:\s*out\/\*/.test(wf), 'the release job attaches the collected installers');
  ok(/if:\s*startsWith\(github\.ref,\s*'refs\/tags\/v'\)/.test(wf),
    'the release only runs on a version tag');
  ok(/generate_release_notes:\s*true/.test(wf), 'release notes are generated automatically');
  ok(/needs:\s*package/.test(wf), 'the release waits for all three platform builds');

  /* package.json must point electron-builder at the same repo the updater
     reads, or the generated app-update.yml would 404. */
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const pub = (pkg.build && pkg.build.publish) || [];
  const gh = pub.find((p) => p.provider === 'github');
  ok(!!gh, 'build.publish declares a github provider', JSON.stringify(pub));
  ok(gh && gh.owner === 'nesari' && gh.repo === 'oj-chart-terminal',
    'the provider points at this repository', gh && (gh.owner + '/' + gh.repo));
  ok(!!(pkg.dependencies && pkg.dependencies['electron-updater']),
    'electron-updater is a runtime dependency (it ships inside the app)');

  /* The updater downloads `files[].url` from latest.yml. electron-builder
     slugifies a name with SPACES in the feed but the NSIS artifact keeps them,
     so the feed pointed at `OJchart-Setup-1.9.217.exe` while the file on disk
     was `OJchart Setup 1.9.217.exe` — a guaranteed 404 on every update.
     Pinning artifactName (no spaces) makes the two agree by construction. */
  for (const plat of ['win', 'mac', 'linux']) {
    ok(/\$\{version\}/.test(pkg.build[plat].artifactName || ''),
      plat + ' artifactName includes the version', pkg.build[plat].artifactName);
    ok(!/\s/.test((pkg.build[plat].artifactName || '').replace(/\$\{[^}]*\}/g, '')),
      plat + ' artifactName has no literal spaces', pkg.build[plat].artifactName);
  }
  ok(/\$\{productName\}-Setup-\$\{version\}\.\$\{ext\}/.test(pkg.build.win.artifactName || ''),
    'the Windows artifact matches the name the NSIS feed advertises', pkg.build.win.artifactName);
}

console.log('\nROUND290: ' + pass + ' passed, ' + fail + ' failed.');
Module._load = origLoad;   // restore before exiting so Node's own teardown is clean
process.exit(fail ? 1 : 0);
