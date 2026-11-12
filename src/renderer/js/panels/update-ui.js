/**
 * Auto-update UI (ROUND290)
 *
 * The main process owns the updater; this module only renders its status and
 * routes the user's three explicit decisions (check / download / restart).
 *
 * Two rules that matter:
 * 1. The version shown here is the RUNNING build's version, taken from the
 *    updater status (main reads it from `app.getVersion()`), not from a
 *    hand-maintained constant — so a stale `package.json` can never make the
 *    panel lie.
 * 2. Nothing is downloaded or installed without a click. `available` shows
 *    the Download button; `downloaded` shows Restart & install. A browser
 *    build (no Electron bridge) renders a single "desktop app only" line and
 *    disables the buttons instead of throwing.
 *
 * @module panels/update-ui
 */

import { UI } from '../drawing/ui.js';
import { Log } from '../../../core/logger.js';

const $ = (id) => document.getElementById(id);

let status = { state: 'unknown', current: null, version: null, percent: 0, error: null };
let wired = false;

const STATE_TEXT = {
  idle: '',
  checking: 'Checking…',
  none: 'Up to date',
  available: 'Update available',
  downloading: 'Downloading…',
  downloaded: 'Ready to install',
  error: 'Check failed',
  disabled: 'Auto-update is off in this build',
  unknown: '',
};

function bridge() {
  return (typeof window !== 'undefined' && window.electronAPI) || null;
}

function paint() {
  const ver = $('dg-up-ver');
  if (!ver) return;
  const b = bridge();
  /* The RUNNING version has two sources and they must agree:
     - with the Electron bridge, main answers `app.getVersion()` (the packaged
       truth);
     - in a browser build there is no bridge, so fall back to the logger's
       APP_VERSION. Before this fallback the chip rendered "v?" in every
       browser build — a version row that could not state a version. */
  let current = status.current;
  if (!current) {
    try { current = Log.stats().version; } catch (e) { current = null; }
  }
  ver.textContent = 'v' + (current || '?');

  const stateEl = $('dg-up-state');
  const check = $('dg-up-check');
  const get = $('dg-up-get');
  const inst = $('dg-up-install');
  const st = status.state || 'unknown';

  if (!b || !b.updateCheck) {
    if (stateEl) stateEl.textContent = 'Auto-update needs the desktop app';
    for (const el of [check, get, inst]) if (el) el.classList.add('hidden');
    return;
  }

  let label = STATE_TEXT[st] != null ? STATE_TEXT[st] : st;
  if (st === 'available' && status.version) label = 'Update available: v' + status.version;
  if (st === 'downloading') label = 'Downloading… ' + (status.percent || 0) + '%';
  if (st === 'downloaded' && status.version) label = 'Version ' + status.version + ' is ready to install';
  if (st === 'error' && status.error) label = 'Check failed — ' + status.error;
  if (stateEl) stateEl.textContent = label;
  if (stateEl) stateEl.classList.toggle('dg-up-bad', st === 'error');

  if (check) {
    check.classList.toggle('hidden', st === 'downloading' || st === 'downloaded' || st === 'disabled');
    check.disabled = st === 'checking';
  }
  if (get) get.classList.toggle('hidden', st !== 'available');
  if (inst) inst.classList.toggle('hidden', st !== 'downloaded');
}

async function run(kind) {
  const b = bridge();
  if (!b) return;
  try {
    let s = null;
    if (kind === 'check') s = await b.updateCheck();
    else if (kind === 'download') s = await b.updateDownload();
    else if (kind === 'install') { await b.updateInstall(); return; }
    if (s && s.state) { status = s; paint(); }
    if (kind === 'check' && s && s.state === 'none' && UI && UI.toast) UI.toast('You are on the latest version');
    if (kind === 'check' && s && s.state === 'error' && UI && UI.toast) {
      UI.toast('Update check failed — see Diagnostics', 'err');
    }
  } catch (e) {
    Log.warn('update', 'update action failed', { error: String(e && e.message || e) });
    if (UI && UI.toast) UI.toast('Update action failed', 'err');
  }
}

function init() {
  if (wired) return;
  wired = true;
  const b = bridge();

  const onCheck = $('dg-up-check');
  const onGet = $('dg-up-get');
  const onInst = $('dg-up-install');
  if (onCheck) onCheck.addEventListener('click', () => run('check'));
  if (onGet) onGet.addEventListener('click', () => run('download'));
  if (onInst) onInst.addEventListener('click', () => run('install'));

  if (!b || !b.updateStatus) { paint(); return; }

  b.updateStatus().then((s) => { if (s && s.state) { status = s; paint(); } }).catch(() => paint());
  if (b.onUpdateState) {
    b.onUpdateState((s) => {
      if (!s || !s.state) return;
      const wasAvailable = status.state === 'available';
      status = s;
      paint();
      /* Announce the transition once — a manifest re-broadcast must not spam
         a toast on every render. */
      if (s.state === 'available' && !wasAvailable && UI && UI.toast) {
        UI.toast('Update available: v' + (s.version || '?') + ' — open Diagnostics to install', 'ok', {
          actionLabel: 'Later',
        });
      }
      if (s.state === 'downloaded' && UI && UI.toast) {
        UI.toast('Update downloaded — restart to install', 'ok', { actionLabel: 'Later' });
      }
    });
  }
  /* Check once per boot, well after the chart is up so it never competes with
     the first data paint. */
  setTimeout(() => { if (status.state === 'idle') run('check'); }, 12000);
}

export const UpdateUI = { init, refresh: paint, get status() { return status; } };
