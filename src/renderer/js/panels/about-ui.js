/**
 * About & updates (ROUND294)
 *
 * "Which version am I running, and is there a newer one?" had no answer in the
 * UI a user would find: the version chip and the Check button lived only inside
 * the Diagnostics panel, which is a developer surface. This module puts both on
 * the toolbar, behind one button, and reuses the SAME update state machine —
 * there is no second implementation that could drift.
 *
 * Contents of the popup:
 *  - the running version (from the updater's `current`, which main reads from
 *    `app.getVersion()`; the logger's APP_VERSION is the browser fallback);
 *  - the release channel state in plain words (up to date / update available /
 *    downloading with a percentage / ready to install / channel unavailable);
 *  - one action button whose label follows the state: Check → Download →
 *    Restart & install;
 *  - a link to the release notes for the version being offered.
 *
 * It never downloads or installs on its own; every transition needs the click.
 *
 * @module panels/about-ui
 */

import { UI } from '../drawing/ui.js';
import { Log } from '../../../core/logger.js';
import { icon } from '../ui/icons.js';
import { UpdateUI } from './update-ui.js';

const $ = (id) => document.getElementById(id);

let wired = false;
let popup = null;

const STATE_LINE = {
  idle: 'Not checked yet',
  checking: 'Checking for updates…',
  none: 'You are on the latest version',
  available: 'A newer version is available',
  downloading: 'Downloading…',
  downloaded: 'Ready to install',
  error: 'Could not check for updates',
  channel: 'Update channel unavailable — download from the release page',
  disabled: 'Auto-update is off in this build',
  unknown: '',
};

/** The running version: the packaged truth first, the build constant second. */
function runningVersion() {
  const s = UpdateUI.status || {};
  if (s.current) return s.current;
  try { return Log.stats().version; } catch (e) { return '?'; }
}

/** Fetch the release page URL without inventing one: it is derived from the
 *  repo the build already publishes to. */
function releaseUrl(version) {
  const base = 'https://github.com/nesari/oj-chart-terminal/releases';
  return version ? base + '/tag/v' + version : base + '/latest';
}

function render() {
  if (!popup) return;
  const s = UpdateUI.status || {};
  const ver = runningVersion();
  /* ROUND294: in a browser build there is no bridge, so `status` stays
     `unknown` and the state line used to render EMPTY — a popup that states a
     version but says nothing about updates reads as broken. Derive the honest
     line from what we can actually do here. */
  let state = s.state || 'unknown';
  if (state === 'unknown') {
    const hasBridge = !!(typeof window !== 'undefined' && window.electronAPI && window.electronAPI.updateCheck);
    state = hasBridge ? 'idle' : 'disabled';
  }

  const verEl = popup.querySelector('.ab-ver');
  if (verEl) verEl.textContent = 'v' + ver;

  const stateEl = popup.querySelector('.ab-state');
  if (stateEl) {
    let line = STATE_LINE[state] != null ? STATE_LINE[state] : state;
    if (state === 'downloading') line = 'Downloading… ' + (s.percent || 0) + '%';
    if (state === 'available' && s.version) line = 'Version ' + s.version + ' is available';
    if (state === 'downloaded' && s.version) line = 'Version ' + s.version + ' is ready to install';
    if (state === 'error' && s.error) line = 'Could not check — ' + s.error;
    stateEl.textContent = line;
    stateEl.classList.toggle('ab-bad', state === 'error');
    stateEl.classList.toggle('ab-dim', state === 'channel' || state === 'disabled');
  }

  /* progress bar is only meaningful while downloading */
  const bar = popup.querySelector('.ab-bar');
  if (bar) {
    bar.classList.toggle('hidden', state !== 'downloading');
    const fill = bar.querySelector('i');
    if (fill) fill.style.width = Math.max(0, Math.min(100, s.percent || 0)) + '%';
  }

  /* the action label follows the state — one button, never two */
  const btn = popup.querySelector('.ab-action');
  if (btn) {
    const label = state === 'available' ? 'Download update'
      : state === 'downloaded' ? 'Restart & install'
        : state === 'downloading' ? 'Downloading…'
          : state === 'checking' ? 'Checking…'
            : 'Check for updates';
    btn.textContent = label;
    btn.disabled = state === 'checking' || state === 'downloading';
    btn.classList.toggle('ab-primary', state === 'available' || state === 'downloaded');
  }

  /* ROUND295: when a newer version EXISTS the user must be able to reach its
     download page even if the in-app downloader is unavailable (no feed access,
     a signed-build mismatch, an OS that refuses the installer). A second,
     secondary link appears only in that state so the primary path stays clear. */
  const page = popup.querySelector('.ab-page');
  if (page) {
    const showPage = state === 'available' || state === 'downloaded' || state === 'channel';
    page.classList.toggle('hidden', !showPage);
    page.dataset.url = releaseUrl(s.version || null);
    page.textContent = s.version ? 'Open download page for v' + s.version : 'Open download page';
  }

  /* release notes link points at the version being DISCUSSED, not a guess */
  const link = popup.querySelector('.ab-notes');
  if (link) {
    const target = s.version || (state === 'none' ? ver : null);
    link.textContent = 'Release notes';
    link.dataset.url = releaseUrl(target);
  }
}

async function onAction() {
  const s = UpdateUI.status || {};
  const hasBridge = !!(typeof window !== 'undefined' && window.electronAPI && window.electronAPI.updateCheck);
  const state = s.state || 'unknown';

  /* ROUND295: without the Electron bridge there is nothing to check — say so
     instead of doing nothing. Clicking a button and seeing NO reaction is the
     worst possible answer, and that is exactly what happened here. */
  if (!hasBridge) {
    if (UI && UI.toast) UI.toast('Update checks need the desktop app', 'err');
    return;
  }

  try {
    if (state === 'available') {
      const next = await UpdateUI.download();
      /* Even after the download starts, the honest destination is the release
         page: the in-app installer only finishes what the feed describes. */
      if (UI && UI.toast) UI.toast('Downloading update…');
      if (next && next.state === 'error' && UI && UI.toast) UI.toast('Download failed', 'err');
    } else if (state === 'downloaded') {
      await UpdateUI.install();
    } else {
      const next = await UpdateUI.checkNow();
      const st = (next && next.state) || 'unknown';
      if (UI && UI.toast) {
        if (st === 'none') UI.toast('You are on the latest version');           // up to date
        else if (st === 'available') UI.toast('Update available: v' + (next.version || '?'));
        else if (st === 'channel') UI.toast('Update channel unavailable — download from the release page', 'err');
        else if (st === 'error') UI.toast('Update check failed — see Diagnostics', 'err');
        else if (st === 'disabled') UI.toast('Auto-update is off in this build', 'err');
      }
    }
  } catch (e) {
    Log.warn('update', 'about action failed', { error: String(e && e.message || e) });
    if (UI && UI.toast) UI.toast('Update action failed', 'err');
  }
  render();
}

function build() {
  const p = document.createElement('div');
  p.className = 'popup ab-popup';
  p.setAttribute('role', 'dialog');
  p.innerHTML = `
    <div class="pu-title">${icon('info')} OJchart</div>
    <div class="ab-row">
      <span class="ab-lab">Version</span>
      <span class="ab-ver">—</span>
    </div>
    <div class="ab-row ab-row-wide">
      <span class="ab-state"></span>
    </div>
    <div class="ab-bar hidden"><i></i></div>
    <div class="ab-actions">
      <button class="ab-action">Check for updates</button>
      <button class="ab-notes" title="Open the release page">Release notes</button>
    </div>
    <div class="ab-page-row">
      <button class="ab-page hidden"></button>
    </div>`;
  p.querySelector('.ab-action').addEventListener('click', onAction);
  /* both links share the same opener: shell when packaged, tab in a browser */
  const openLink = async (target) => {
    const b = (typeof window !== 'undefined' && window.electronAPI) || null;
    try {
      if (b && b.openExternal) {
        const r = await b.openExternal(target);
        if (r && r.ok === false && UI && UI.toast) UI.toast('Could not open the release page', 'err');
        return;
      }
      const w = window.open(target, '_blank', 'noopener');
      if (!w && UI && UI.toast) UI.toast('Could not open the release page', 'err');
    } catch (err) {
      Log.warn('update', 'cannot open the release page', { error: String(err && err.message || err) });
      if (UI && UI.toast) UI.toast('Could not open the release page', 'err');
    }
  };
  p.querySelector('.ab-notes').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openLink(e.currentTarget.dataset.url || releaseUrl(null));
  });
  p.querySelector('.ab-page').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openLink(e.currentTarget.dataset.url || releaseUrl(null));
  });
  return p;
}

function place(btn) {
  const body = document.body;
  popup = build();
  body.appendChild(popup);
  /* anchor under the toolbar button, kept inside the viewport */
  const r = btn.getBoundingClientRect();
  const w = popup.offsetWidth || 280;
  const h = popup.offsetHeight || 160;
  const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  const top = Math.min(r.bottom + 6, window.innerHeight - h - 8);
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
  render();
}

function close() {
  if (popup) { popup.remove(); popup = null; }
}

function init() {
  if (wired) return;
  const btn = $('about-btn');
  if (!btn) return;
  wired = true;
  btn.innerHTML = icon('info');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popup) { close(); return; }
    place(btn);
    /* opening the popup refreshes the state so the version is never stale */
    try { UpdateUI.checkNow(); } catch (err) { /* offline is fine */ }
  });
  /* any outside click or Escape dismisses it, like the other toolbar popups */
  document.addEventListener('click', (e) => {
    if (popup && !popup.contains(e.target) && e.target !== btn) close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && popup) close(); });

  /* keep the popup in sync with the updater without polling: the panel already
     subscribes to the main process, so we render whenever its status changes. */
  UpdateUI.onStatus(() => { if (popup) render(); });
}

export const AboutUI = { init, close, get open() { return !!popup; }, render };
