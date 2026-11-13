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
};

let started = false;
let listeners = [];

function snapshot() {
  return Object.assign({}, state, { current: app.getVersion() });
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
    setState({ state: 'disabled', error: null });
    log('debug', 'update check disabled in a dev build');
    return snapshot();
  }
  if (!autoUpdater) {
    setState({ state: 'disabled', error: 'updater unavailable' });
    log('warn', 'electron-updater missing from the packaged build', { error: String(loadError && loadError.message || loadError) });
    return snapshot();
  }

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
  if (s.state === 'disabled') return s;
  if (s.state === 'checking' || s.state === 'downloading') return s;
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

module.exports = { init, check, download, install, status: snapshot, subscribe };
