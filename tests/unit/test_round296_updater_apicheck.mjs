/**
 * test_round296_updater_apicheck.mjs — the updater can KNOW without installing.
 *
 * The reported bug: clicking "Check for updates" produced a red toast reading
 * "Auto-update is off in this build". The check had been short-circuited by the
 * installer's own availability, so a dev/portable build could not answer the
 * one question the user asked.
 *
 * This drives the REAL module with `app.isPackaged === false` and a stubbed
 * releases API, so it proves the behaviour rather than the source text:
 *   - a newer tag        -> state 'available' + version + notesUrl
 *   - the same tag       -> state 'none'  (the "you are up to date" answer)
 *   - an unreachable API -> state 'channel'
 *   - and in every case  -> canInstall is false, so no download is offered.
 *
 * Run: node tests/unit/test_round296_updater_apicheck.mjs
 */

import { createRequire } from 'module';
import Module from 'module';
import https from 'node:https';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

/* ---------- stub electron ---------- */
let runningVersion = '1.9.228';
const fakeApp = {
  isPackaged: false,
  getVersion: () => runningVersion,
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: fakeApp };
  if (request === 'electron-updater') {
    /* present but must never be driven in a non-packaged build */
    const e = new EventEmitter();
    e.autoDownload = true; e.autoInstallOnAppQuit = true; e.allowDowngrade = true;
    e.checkForUpdates = async () => { throw new Error('must not be called'); };
    e.downloadUpdate = async () => { throw new Error('must not be called'); };
    e.quitAndInstall = () => { throw new Error('must not be called'); };
    return { autoUpdater: e };
  }
  return origLoad.call(this, request, parent, isMain);
};

/* ---------- stub the releases API ---------- */
let apiReply = { status: 200, body: JSON.stringify({ tag_name: 'v1.9.240', html_url: 'https://github.com/nesari/oj-chart-terminal/releases/tag/v1.9.240' }) };
https.get = (url, opts, cb) => {
  const req = new EventEmitter();
  req.destroy = () => {};
  req.end = () => {};
  setImmediate(() => {
    const res = new EventEmitter();
    res.statusCode = apiReply.status;
    res.resume = () => {};
    cb(res);
    setImmediate(() => {
      if (apiReply.body) res.emit('data', apiReply.body);
      res.emit('end');
    });
  });
  return req;
};

const UPDATER = '../../src/platform/electron/updater.js';
function load() {
  delete require.cache[require.resolve(UPDATER)];
  return require(UPDATER);
}

const logs = [];
const log = (lvl, msg, ctx) => logs.push({ lvl, msg, ctx });

/* ---------- 1. a newer release is DETECTED without the installer ---------- */
{
  const u = load();
  const s = u.init({ log });
  ok(s.canInstall === false, 'a dev build reports canInstall=false', s.canInstall);
  ok(s.state === 'disabled', 'init still says self-install is off', s.state);

  const r = await u.check({ log });
  ok(r.state === 'available', 'check reports the newer version', r.state);
  ok(r.version === '1.9.240', 'the version comes from the release tag', r.version);
  ok(/releases\/tag\/v1\.9\.240/.test(r.notesUrl || ''), 'the release URL rides along', r.notesUrl);
  ok(r.canInstall === false, 'still cannot self-install', r.canInstall);

  /* the installer path must not have been touched */
  let touched = false;
  try { await u.download({ log }); } catch (e) { touched = true; }
  ok(!touched, 'download does not drive electron-updater in this build');
  ok(u.install() === false, 'install is refused');
}

/* ---------- 2. the same version answers "you are up to date" ---------- */
{
  const u = load();
  u.init({ log });
  apiReply = { status: 200, body: JSON.stringify({ tag_name: 'v1.9.228', html_url: 'https://x/tag/v1.9.228' }) };
  const r = await u.check({ log });
  ok(r.state === 'none', 'an equal version reports none (up to date)', r.state);
  ok(r.version == null, 'and offers no version to download', r.version);
}

/* ---------- 3. an older published tag is not "an update" ---------- */
{
  const u = load();
  u.init({ log });
  apiReply = { status: 200, body: JSON.stringify({ tag_name: 'v1.9.100', html_url: 'https://x' }) };
  const r = await u.check({ log });
  ok(r.state === 'none', 'a rolled-back tag is not offered as an update', r.state);
}

/* ---------- 4. an unreachable API is a channel fact ---------- */
{
  const u = load();
  u.init({ log });
  apiReply = { status: 404, body: '' };
  const r = await u.check({ log });
  ok(r.state === 'channel', 'an unreachable API reports channel, not error', r.state);
  ok(r.error == null, 'and carries no scary error text', r.error);
  ok(logs.some((l) => l.lvl === 'info' && /not reachable/i.test(l.msg)),
    'the reason is logged at info');
}

/* ---------- 5. numeric comparison, not string ---------- */
{
  const u = load();
  u.init({ log });
  u.setVersionOverride('1.9.9');
  apiReply = { status: 200, body: JSON.stringify({ tag_name: 'v1.9.10', html_url: 'https://x' }) };
  const r = await u.check({ log });
  ok(r.state === 'available', '1.9.10 counts as newer than 1.9.9', r.state);
}

/* ---------- 6. the reported version must be the APP's, not Electron's ----------
   In an unpackaged run `app.getVersion()` returns the Electron version
   (33.4.11 here), which made the check compare the app against a runtime
   number and report "up to date" for the wrong reason. */
{
  runningVersion = '33.4.11';   // what app.getVersion() answers unpackaged
  const u = load();
  const s = u.init({ log });
  ok(s.current !== '33.4.11',
    'the current version is the app version, not the Electron runtime', s.current);
  ok(/^\d+\.\d+\.\d+$/.test(s.current || ''), 'it is a real semver string', s.current);

  apiReply = { status: 200, body: JSON.stringify({ tag_name: 'v' + s.current, html_url: 'https://x' }) };
  const r = await u.check({ log });
  ok(r.state === 'none', 'the same app version reports up to date', r.state);
  runningVersion = '1.9.228';
}

Module._load = origLoad;

console.log('\nROUND296: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
