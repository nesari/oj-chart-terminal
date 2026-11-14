/**
 * Auto-update bridge (ROUND290)
 *
 * The app shipped installers for three platforms from ROUND283 onwards, but
 * nothing ever TOLD a running copy that a newer one existed: the user had to
 * remember to look at the GitHub Actions page, where the artifact expires
 * after 14 days. This module is the missing half.
 *
 * Design constraints (deliberate):
 * - `electron-updater` is only meaningful in a PACKAGED build. In dev
 *   (`npm start`) `app.isPackaged` is false and the updater would try to
 *   compare against a `dev-app-update.yml` that does not exist; every call
 *   returns a "not packaged" status instead of throwing into the renderer.
 * - Checking is the app's decision, INSTALLING is the user's. We never
 *   download silently: `check()` only asks GitHub for `latest.yml`, and the
 *   actual download starts when the user clicks "Download" in the prompt.
 * - The renderer never sees a URL, a file path or a token — only a small
 *   status object. Downloads that electron-updater performs itself are safe
 *   because the feed URL comes from the packaged `app-update.yml` that
 *   electron-builder generated at build time.
 * - A failed update check must never look like an app error: an offline
 *   laptop, a private-repo 404 or a proxy block all end up as
 *   `{ state: 'error', error: <short message> }` and are logged at `debug`,
 *   not `error`, so the Diagnostics panel does not fill with noise.
 *
 * @module platform/electron/updater
 */

'use strict';

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

/* ROUND296: `app.getVersion()` answers the ELECTRON version in an unpackaged
   run (it reads `version` from the nearest package.json, which here is empty —
   Electron falls back to its own). The app's real version lives in
   package.json -> APP_VERSION, so resolve it explicitly when not packaged.
   Getting this wrong made the check compare against 33.4.11 and conclude
   "up to date" for the wrong reason. */
let versionOverride = null;   // test seam: see setVersionOverride()
function appVersion() {
  if (versionOverride) return versionOverride;
  try {
    if (app.isPackaged) return app.getVersion();
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    if (pkg && pkg.version) return String(pkg.version);
  } catch (e) { /* fall through */ }
  return app.getVersion();
}
/** Test-only: pretend this build is `v`. Never called by production code. */
function setVersionOverride(v) { versionOverride = v ? String(v).replace(/^v/, '') : null; }

/* Kept compatible with the plain-CJS style of the other platform modules
   (provider-path.js / mt5-detect.js) so main.js can require() it directly. */
let autoUpdater = null;
let loadError = null;
try {
  // Lazy so a dev checkout without the dependency still boots.
  ({ autoUpdater } = require('electron-updater'));
} catch (e) {
  loadError = e;
}

/* One shared status object; every listener and the IPC handler read it. */
const state = {
  state: 'idle',      // idle | checking | available | none | downloading | downloaded | error | disabled
  version: null,      // the NEW version when one is available
  current: null,      // the running version (informational)
  percent: 0,         // download progress 0..100
  error: null,        // short, user-safe message
  /* ROUND296: whether this build can actually install an update itself. An
     API-only check can still report `available`, so the UI needs to know the
     difference between "there is a newer version" and "I can deliver it". */
  canInstall: false,
};

let started = false;
let listeners = [];

function snapshot() {
  return Object.assign({}, state, { current: appVersion() });
}

/* ROUND296 — ask GitHub directly when the updater cannot run.
 *
 * `electron-updater` is only meaningful in a PACKAGED build, so a dev/portable
 * run reported `disabled` and the Check button could not answer the one
 * question the user actually has: "is there a newer version?"
 *
 * Being unable to SELF-INSTALL is not the same as being unable to KNOW. This
 * reads the public releases API (no token, same data the feed derives from) so
 * the UI can always say "you are on the latest version" or "vX is available".
 * It never downloads or installs — those still belong to electron-updater. */
const RELEASES_API = 'https://api.github.com/repos/nesari/oj-chart-terminal/releases/latest';

function cmpVersions(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function fetchLatestRelease(timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const https = require('node:https');
      const req = https.get(RELEASES_API, {
        headers: { 'User-Agent': 'ojchart-update-check', Accept: 'application/vnd.github+json' },
        timeout: timeoutMs || 12000,
      }, (r) => {
        if (r.statusCode !== 200) { r.resume(); finish({ ok: false, status: r.statusCode }); return; }
        let body = '';
        r.on('data', (d) => { body += d; });
        r.on('end', () => {
          try {
            const j = JSON.parse(body);
            finish({ ok: true, tag: j.tag_name || j.name || null, url: j.html_url || null, draft: !!j.draft, prerelease: !!j.prerelease });
          } catch (e) { finish({ ok: false, status: 'parse' }); }
        });
      });
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} finish({ ok: false, status: 'timeout' }); });
      req.on('error', (e) => finish({ ok: false, status: String(e && e.code || 'net') }));
      req.end();
    } catch (e) { finish({ ok: false, status: 'throw' }); }
  });
}

/** Compare the running build with the latest published release.
 *  Returns the same status shape, so every surface renders it unchanged. */
async function checkViaApi(log) {
  setState({ state: 'checking', error: null });
  const r = await fetchLatestRelease();
  if (!r.ok) {
    /* an unreachable API is a channel fact, not a crash */
    log('info', 'release API not reachable', { status: r.status });
    setState({ state: 'channel', error: null });
    return snapshot();
  }
  const current = appVersion();
  const latest = String(r.tag || '').replace(/^v/, '');
  const url = r.url || null;
  if (latest && cmpVersions(latest, current) > 0) {
    log('info', 'update available (api check)', { current, latest });
    setState({ state: 'available', version: latest, error: null, notesUrl: url });
  } else {
    setState({ state: 'none', version: null, error: null, notesUrl: url });
  }
  return snapshot();
}

function emit() {
  const s = snapshot();
  for (const fn of listeners) {
    try { fn(s); } catch (e) { /* a dead window must not break the updater */ }
  }
}

function setState(patch) {
  Object.assign(state, patch);
  emit();
}

function shortError(e) {
  const msg = String((e && e.message) || e || 'update check failed');
  /* Electron's full stack is useless in a toast; keep the first clause. */
  return msg.split('\n')[0].slice(0, 160);
}

/**
 * Is this failure "the update channel itself is not reachable" rather than
 * "something went wrong"?
 *
 * The distinction matters for honesty. A shipped build whose repository is
 * private cannot read the feed at all (GitHub answers 404 to an unauthenticated
 * client), and telling the user "check failed — 404" every boot looks like the
 * app is broken. The same is true for a feed that was never published.
 * Those are configuration facts, not errors, so they get their own state and a
 * neutral message; a network blip or a corrupt download stay `error`.
 */
function isNoChannel(e) {
  const m = String((e && (e.message || e)) || '');
  return /404|not found|cannot find|ENOENT|no published|HttpError:\s*404/i.test(m);
}

/**
 * Wire the updater's events once. Safe to call in dev — it returns early and
 * reports `disabled`, which is what the renderer shows in place of a version
 * check.
 */
function init(opts) {
  opts = opts || {};
  const log = opts.log || function () {};
  if (started) return snapshot();
  started = true;

  if (!app.isPackaged) {
    /* The in-app INSTALLER needs a packaged build, but the user can still be
       told whether a newer version exists — see checkViaApi(). */
    setState({ state: 'disabled', error: null, canInstall: false });
    log('debug', 'self-install unavailable in a dev build; version check still works via the API');
    return snapshot();
  }
  if (!autoUpdater) {
    setState({ state: 'disabled', error: 'updater unavailable', canInstall: false });
    log('warn', 'electron-updater missing from the packaged build', { error: String(loadError && loadError.message || loadError) });
    return snapshot();
  }
  setState({ canInstall: true });

  /* Never install without consent, and never restart the app on its own.
     `autoInstallOnAppQuit` stays FALSE: with it true, a user who downloaded an
     update and then chose "Later" would get it installed silently the next
     time they closed the app — which contradicts both the panel's
     "Restart & install" button and the documented promise. Quitting after a
     download simply loses it; the next launch re-checks and re-downloads
     (blockmap makes that cheap). */
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  /* ROUND291: a downgrade must never be offered. This is already the library
     default, but the release feed is a single mutable file: if a bad build is
     pulled back to the previous version, users on the newer build must NOT be
     told to "update" down onto it. Pinned explicitly so an upstream default
     change cannot silently start downgrading people. */
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => setState({ state: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => {
    log('info', 'update available', { version: info && info.version });
    setState({ state: 'available', version: (info && info.version) || null, error: null });
  });
  autoUpdater.on('update-not-available', () => setState({ state: 'none', version: null, error: null }));
  autoUpdater.on('download-progress', (p) => {
    const pct = p && isFinite(p.percent) ? Math.max(0, Math.min(100, p.percent)) : 0;
    setState({ state: 'downloading', percent: Math.round(pct) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    log('info', 'update downloaded', { version: info && info.version });
    setState({ state: 'downloaded', version: (info && info.version) || state.version, percent: 100, error: null });
  });
  autoUpdater.on('error', (e) => {
    /* An unreachable channel is a configuration fact (see isNoChannel), not a
       failure the user should see as an error on every boot. */
    if (isNoChannel(e)) {
      log('info', 'update channel not reachable', { error: shortError(e) });
      setState({ state: 'channel', error: null });
      return;
    }
    /* Debug, not error: an offline machine is the common case. */
    log('debug', 'update check failed', { error: shortError(e) });
    setState({ state: 'error', error: shortError(e) });
  });

  return snapshot();
}

/** Ask GitHub whether a newer release exists. Never downloads. */
async function check(opts) {
  const log = (opts && opts.log) || function () {};
  init({ log });
  const s = snapshot();
  if (s.state === 'checking' || s.state === 'downloading') return s;

  /* ROUND296: when the in-app installer is unavailable (dev build, or the
     updater module missing) we can still ANSWER the question. Checking and
     installing are different capabilities; refusing to check told the user
     nothing they could act on. */
  const canSelfInstall = s.state !== 'disabled' && !!autoUpdater;
  if (!canSelfInstall) {
    log('debug', 'self-install unavailable — checking the release API only');
    return checkViaApi(log);
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    if (isNoChannel(e)) {
      log('info', 'update channel not reachable', { error: shortError(e) });
      setState({ state: 'channel', error: null });
      return snapshot();
    }
    log('debug', 'update check threw', { error: shortError(e) });
    setState({ state: 'error', error: shortError(e) });
  }
  return snapshot();
}

/** Start the download the user just approved. */
async function download(opts) {
  const log = (opts && opts.log) || function () {};
  const s = snapshot();
  if (s.state !== 'available') return s;
  /* ROUND296: an API-only check can find an update in a build that cannot
     install it (dev/portable). Do not pretend to start a download there — the
     UI's job is to open the release page instead. */
  if (!s.canInstall || !autoUpdater) {
    log('debug', 'download requested without the in-app installer');
    return s;
  }
  try {
    setState({ state: 'downloading', percent: 0 });
    await autoUpdater.downloadUpdate();
  } catch (e) {
    log('debug', 'update download failed', { error: shortError(e) });
    setState({ state: 'error', error: shortError(e) });
  }
  return snapshot();
}

/** Quit and install a fully downloaded update (explicit user action). */
function install() {
  if (state.state !== 'downloaded') return false;
  /* isSilent=false so Windows shows its own progress UI; the app is about to
     exit, so the renderer must not expect anything after this returns. */
  setImmediate(() => {
    try { autoUpdater.quitAndInstall(false, true); } catch (e) {
      setState({ state: 'error', error: shortError(e) });
    }
  });
  return true;
}

/** Subscribe to status changes; returns the unsubscribe function. */
function subscribe(fn) {
  if (typeof fn !== 'function') return function () {};
  listeners.push(fn);
  return function () { listeners = listeners.filter((f) => f !== fn); };
}

module.exports = { init, check, download, install, status: snapshot, subscribe, setVersionOverride };
