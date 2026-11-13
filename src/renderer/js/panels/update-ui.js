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
/* the single toast that lives for the whole download (null when idle) */
let progressToast = null;
let progressEl = null;

/* ROUND291: how often a long-running window re-checks for a release. Six
   hours is frequent enough that a daily user sees the offer on the same day,
   and rare enough that it is invisible in logs and network use. */
const UPDATE_POLL_MS = 6 * 60 * 60 * 1000;

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

      /* ROUND291: the toast IS the offer. It carries the action, so the flow
         is: "Update available" -> [Download] -> a live progress toast ->
         "ready" -> [Restart & install]. The persistent progress toast is
         reused for the whole download (no new toast per percent tick). */
      if (!UI || !UI.toast) return;
      if (s.state === 'available' && !wasAvailable) {
        UI.toast('Update available: v' + (s.version || '?'), 'ok', {
          actionLabel: 'Download',
          onAction: () => { run('download'); },
        });
      } else if (s.state === 'downloading') {
        if (progressToast && progressEl) {
          progressEl.textContent = 'Downloading update… ' + (s.percent || 0) + '%';
        } else {
          const t = UI.toast('Downloading update… ' + (s.percent || 0) + '%', 'ok', {
            actionLabel: 'Hide',
            onAction: () => { progressToast = null; progressEl = null; },
          });
          progressToast = t;
          progressEl = t && t.querySelector ? t.querySelector('.t-body') : null;
        }
      } else if (s.state === 'downloaded') {
        if (progressToast) { try { progressToast.remove(); } catch (e) {} }
        progressToast = null; progressEl = null;
        UI.toast('Update v' + (s.version || '') + ' is ready — restart to install', 'ok', {
          actionLabel: 'Restart & install',
          onAction: () => { run('install'); },
        });
      } else if (s.state === 'error' && progressToast) {
        if (progressEl) progressEl.textContent = 'Update download failed';
        progressToast = null; progressEl = null;
      }
    });
  }
  /* Check on boot, well after the chart is up so it never competes with the
     first data paint. ROUND291: and keep checking while the app stays open —
     a user who leaves the terminal running for a week used to never hear about
     a release again. */
  setTimeout(() => { if (status.state === 'idle') run('check'); }, 12000);
  setInterval(() => {
    if (status.state === 'idle' || status.state === 'none' || status.state === 'error') run('check');
  }, UPDATE_POLL_MS);
}

export const UpdateUI = { init, refresh: paint, get status() { return status; } };
