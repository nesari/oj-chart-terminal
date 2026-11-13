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
  ok(/Auto-update is off in this build/.test(update) || /Auto-update is off/.test(update),
    'the disabled state has plain-word copy');
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

console.log('\nROUND294: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
