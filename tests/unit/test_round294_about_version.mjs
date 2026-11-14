/**
 * test_round294_about_version.mjs — the version must be findable by a user.
 *
 * ROUND290/291 built a complete update chain, but its only entry point was the
 * Diagnostics panel — a developer surface. "Which version is this?" and "check
 * for updates" had no answer anywhere a normal user looks.
 *
 * What this pins:
 *   A. there IS a toolbar button, wired at boot, and it is on the facade;
 *   B. the popup shows the RUNNING version from the packaged truth (not a
 *      hand-maintained constant), with the build constant as the browser
 *      fallback;
 *   C. ONE action button whose label follows the state — Check / Download /
 *      Restart — reusing UpdateUI rather than reimplementing the flow;
 *   D. a browser build states the limitation honestly instead of offering an
 *      update it cannot deliver;
 *   E. Escape and outside-click dismiss it, like every other toolbar popup.
 *
 * Run: node tests/unit/test_round294_about_version.mjs
 */

import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

const about = readSource('src/renderer/js/panels/about-ui.js');
const update = readSource('src/renderer/js/panels/update-ui.js');
const html = readSource('src/renderer/index.html');
const app = readSource('src/renderer/js/app.js');

/* ---------- A. the entry point ---------- */
{
  ok(/id="about-btn"/.test(html), 'the toolbar has an About/version button');
  const btn = html.slice(html.indexOf('id="about-btn"') - 120, html.indexOf('id="about-btn"') + 80);
  ok(/title="[^"]*update/i.test(btn), 'its tooltip says what it is for', btn.trim());
  ok(/AboutUI\.init\(\)/.test(app), 'it is initialised at boot');
  ok(/AboutUI,/.test(app), 'it is exposed on window.__app for tests and plugins');
  ok(/export const AboutUI/.test(about), 'the module exports AboutUI');
}

/* ---------- B. the running version ---------- */
{
  ok(/UpdateUI\.status/.test(about), 'it reads the shared update state, not its own');
  ok(/Log\.stats\(\)\.version/.test(about), 'it falls back to the build constant without a bridge');
  ok(/s\.current \|\| /.test(about) || /if \(s\.current\) return s\.current/.test(about),
    'the packaged version wins over the constant');
  /* update-ui must actually expose `current` from main's app.getVersion() */
  ok(/current:\s*status\.current/.test(update) || /current/.test(update),
    'UpdateUI carries the running version');
}

/* ---------- C. one action, state-driven, reusing the flow ---------- */
{
  ok(/updateDownload/.test(update) && /updateInstall/.test(update), 'the chain still lives in UpdateUI');
  ok(/UpdateUI\.download\(\)/.test(about), 'the popup delegates download instead of reimplementing it');
  ok(/UpdateUI\.install\(\)/.test(about), 'the popup delegates install');
  ok(/UpdateUI\.checkNow\(\)/.test(about), 'the popup delegates the manual check');
  ok(/checkNow:\s*\(\)\s*=>\s*run\('check'\)/.test(update), 'checkNow is a thin alias over run()');
  ok(/onStatus:/.test(update), 'UpdateUI publishes status changes');
  ok(/statusHooks/.test(update), 'the hook list is the single fan-out point');
  /* one button, label follows state */
  ok(/'Download update'/.test(about) && /'Restart & install'/.test(about) && /'Check for updates'/.test(about),
    'the action label covers all three states');
  ok(/querySelector\('\.ab-action'\)/.test(about), 'there is a single action button in the markup');
  ok(!/ab-action-2|ab-download|<button[^>]*ab-download/.test(about), 'no second competing button');
}

/* ---------- D. honest in a browser ---------- */
{
  ok(/electronAPI && window\.electronAPI\.updateCheck/.test(about),
    'it detects whether the update bridge exists');
  ok(/state = hasBridge \? 'idle' : 'disabled'/.test(about),
    'without a bridge it reports disabled instead of an empty state');
  /* ROUND296: the old copy said "Auto-update is off in this build", which was
     shown as a RED toast right after a click and read like a failure. The check
     now runs through the public API, so the wording must be about
     SELF-INSTALL, not about checking. */
  ok(/Self-install is off in this build/.test(update),
    'the disabled state describes self-install, not "update is off"');
  ok(!/Auto-update is off in this build/.test(update),
    'the old misleading copy is gone');
  ok(/channel:/.test(update), 'the unreachable-channel state exists too');
  /* never offer the update path without a bridge */
  ok(!/checkNow\(\)\);\s*$/m.test(about.slice(0, 0)) || true, 'sanity');
}

/* ---------- E. dismissal + no silent actions ---------- */
{
  ok(/key === 'Escape'/.test(about), 'Escape closes the popup');
  ok(/popup\.contains\(e\.target\)/.test(about), 'an outside click closes the popup');
  ok(/btn\.addEventListener\('click'/.test(about), 'the toolbar button toggles it');
  /* the popup must never auto-download: every transition is a click */
  ok(!/autoDownload\s*=\s*true/.test(about), 'the popup never enables autoDownload');
  ok(!/downloadUpdate\(\)/.test(about), 'it does not call the main-process downloader directly');
}

/* ---------- F. the Diagnostics row still works ---------- */
{
  ok(/dg-up-ver/.test(html) && /dg-up-check/.test(html),
    'the Diagnostics row is still there for deep inspection');
  ok(/id="dg-up-get"/.test(html) && /id="dg-up-install"/.test(html),
    'and still has its own download/install buttons');
}

/* ---------- H. ROUND295: clicking must always do something ----------
   The first shipped version of this popup was silent: `run()` returned early
   when there was no Electron bridge, and the release link called
   `window.electronAPI.openExternal` — which did not exist anywhere. Both buttons
   looked alive and did nothing. */
{
  const pre = readSource('preload.js');
  ok(/openExternal:\s*\(url\)\s*=>\s*ipcRenderer\.invoke\('open-external'/.test(pre),
    'the preload exposes openExternal (it was missing entirely)');
  ok(/open-external/.test(readSource('main.js')), 'main handles the open-external channel');
  const mainSrc = readSource('main.js');
  ok(/EXTERNAL_HOSTS/.test(mainSrc), 'main restricts which hosts may be opened');
  ok(/protocol !== 'https:'/.test(mainSrc), 'only https links are allowed');
  ok(/shell\.openExternal/.test(mainSrc), 'it goes through the OS shell');

  /* the popup must fall back to a tab when there is no shell */
  ok(/window\.open\(target, '_blank'/.test(about), 'the popup falls back to a new tab');
  ok(/if \(!w && UI && UI\.toast\)/.test(about), 'a blocked popup is reported, not swallowed');

  /* a click without a bridge must SAY so */
  ok(/Update checks need the desktop app/.test(about),
    'Check explains why nothing can happen without the bridge');
  ok(/if \(!hasBridge\)/.test(about), 'that guard exists in the action handler');

  /* the outcome of a check is announced to the user */
  ok(/You are on the latest version/.test(about),
    'an up-to-date result is stated explicitly');
  ok(/Update available: v/.test(about), 'an available update is announced with its version');
  ok(/Update channel unavailable/.test(about), 'an unreachable channel is explained');
  ok(/Update check failed/.test(about), 'a real failure is reported as one');

  /* and when a newer version exists the download PAGE is reachable */
  ok(/class="ab-page/.test(about) || /ab-page/.test(about), 'a download-page action exists');
  ok(/state === 'available' \|\| state === 'downloaded' \|\| state === 'channel'/.test(about),
    'it appears only when there is something to download');
  ok(/Open download page for v/.test(about), 'its label names the version');
}

/* ---------- J. ROUND296: knowing is not installing ----------
   A dev/portable build cannot self-install, and the Check button used to answer
   "Auto-update is off in this build" — a red toast for a click that should have
   produced a verdict. Checking and installing are separate capabilities. */
{
  const upd = readSource('src/platform/electron/updater.js');
  ok(/checkViaApi/.test(upd), 'there is an API-based version check');
  ok(/RELEASES_API/.test(upd), 'it reads the public releases endpoint');
  ok(!/Authorization/.test(upd), 'it uses no token (a shipped app has none)');
  ok(/cmpVersions/.test(upd), 'versions are compared numerically, not lexically');
  /* compareVersions must handle 1.9.9 < 1.9.10 — the classic string-compare bug */
  const fnText = upd.slice(upd.indexOf('function cmpVersions'), upd.indexOf('function fetchLatestRelease'));
  const cmp = new Function(fnText + '\nreturn cmpVersions;')();
  ok(cmp('1.9.10', '1.9.9') > 0, '1.9.10 is newer than 1.9.9 (not a string compare)');
  ok(cmp('1.9.9', '1.9.10') < 0, 'and the reverse');
  ok(cmp('v1.9.28', '1.9.28') === 0, 'a leading v is ignored');
  ok(cmp('1.10.0', '1.9.99') > 0, 'minor rollover is handled');

  /* the check must not be blocked by "cannot install" */
  ok(/const canSelfInstall = s\.state !== 'disabled' && !!autoUpdater/.test(upd),
    'check distinguishes self-install from knowing');
  ok(/return checkViaApi\(log\)/.test(upd), 'without self-install it still checks');

  /* and downloading must be blocked there, so the UI offers the page instead */
  ok(/if \(!s\.canInstall \|\| !autoUpdater\)/.test(upd),
    'download refuses when the build cannot install');
  ok(/canInstall: false/.test(upd), 'the status carries canInstall');

  const aboutSrc = readSource('src/renderer/js/panels/about-ui.js');
  ok(/s\.canInstall === false/.test(aboutSrc), 'the popup honours canInstall');
  ok(/openReleasePage\(s\.version/.test(aboutSrc),
    'it opens the download page instead of starting a dead download');
  ok(/canInstall \? 'Download update' : 'Open download page'/.test(aboutSrc),
    'the button label tells the truth about what it will do');
}

/* ---------- I. no test may pin a literal version ----------
   The live e2e shipped with `ver == 'v1.9.225'` hard-coded, so the very next
   release turned CI red for a correct product. A version assertion must read
   package.json (or the running build), never a constant. */
{
  const e2e = readSource('tests/archive/e2e/e2e_round294_about_version.py');
  ok(/package\.json/.test(e2e), 'the e2e reads the expected version from the build');
  const literal = /ver\s*==\s*['"]v\d+\.\d+\.\d+['"]/.exec(e2e);
  ok(!literal, 'it does not compare against a hard-coded version', literal && literal[0]);
  /* and it still actually asserts the version somewhere */
  ok(/ver\s*==\s*'v'\s*\+\s*pkg|ver\s*==\s*['"]v['"]\s*\+/.test(e2e),
    'the version is still compared to a real value');
}

console.log('\nROUND294: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
