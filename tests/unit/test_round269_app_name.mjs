/**
 * ROUND269 - the app is OJchart, not "OJchart Notification".
 *
 * Round 51 wanted the Windows toast header to read as the product instead of
 * "electron.app.Electron". The fix used `app.setName('OJchart Notification')`
 * — but the app NAME is not the toast header: the toast identity comes from
 * the App User Model ID (`app.setAppUserModelId`, round 127 already sets it).
 * The side effects of the name change were real and user-visible:
 *
 *  - the app menu / shell identity read "OJchart Notification";
 *  - `app.getPath('userData')` became `<appData>/OJchart Notification`, so
 *    accounts (DPAPI blobs), logs and the Local Storage that carries the
 *    saved LAYOUTS all live in a folder named after a notification.
 *
 * Pins:
 *  - the product name is "OJchart" and the toast identity is the AUMID;
 *  - the user-data folder is PINNED (older conventions are honoured) and set
 *    at module load, before Chromium resolves its user-data dir, so an
 *    upgrade never looks like lost accounts/layouts;
 *  - the selection rule itself (mirrored below): newest existing folder wins,
 *    then the packaged product folder, then the dev package folder, and a
 *    fresh install gets `<appData>/OJchart`.
 *
 * Run: node tests/unit/test_round269_app_name.mjs
 */
import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' - ' + JSON.stringify(extra) : '')); }
};

const main = readSource('main.js');

console.log('\n[1] the product name is OJchart');
{
  ok(!/app\.setName\('OJchart Notification'\)/.test(main),
    'the old "OJchart Notification" name is gone');
  ok(/app\.setName\('OJchart'\)/.test(main), 'the app is named OJchart');
  ok(/app\.isPackaged \? 'com\.ojchart\.terminal' : process\.execPath/.test(main),
    'the packaged AUMID is still the brand id');
  ok(/app\.setAppUserModelId\(process\.platform === 'win32' \? aumid : 'OJchart'\)/.test(main),
    'the toast identity stays on the AUMID (now OJchart)');
  ok(!/Notification Notification/.test(main), 'no doubled notification name');
}

console.log('\n[2] user data stays where earlier builds put it');
{
  ok(/function pinUserDataDir\(\) \{/.test(main), 'one helper owns the folder choice');
  ok(/app\.setPath\('userData', dir\)/.test(main), 'the folder is pinned explicitly');
  const fn = main.slice(main.indexOf('function pinUserDataDir() {'), main.indexOf('pinUserDataDir();'));
  for (const name of ["'OJchart Notification'", "'OJchart'", "'mt5-chart-terminal'"]) {
    ok(fn.includes('path.join(appData, ' + name + ')'), 'candidate ' + name + ' is honoured');
  }
  const iCall = main.indexOf("/* pinned at module load");
  const iReady = main.indexOf('app.whenReady()');
  ok(iCall > 0 && iCall < iReady, 'pinned at module load, before whenReady');
  ok(/pinUserDataDir\(\);/.test(main.slice(iCall, iReady)), 'the pin really runs at load');
  const readyBlock = main.slice(iReady, main.indexOf('app.on(', iReady));
  ok(!/pinUserDataDir\(\)/.test(readyBlock), 'not deferred into whenReady (too late for Chromium)');
}

console.log('\n[3] the selection rule (mirror of the shipped helper)');
{
  /* same order/logic as pinUserDataDir(): first EXISTING candidate wins */
  const pick = (appData, exists) => {
    const cands = [
      appData + '/OJchart Notification',
      appData + '/OJchart',
      appData + '/mt5-chart-terminal',
    ];
    return cands.find(exists) || appData + '/OJchart';
  };
  const A = '%APPDATA%';
  ok(pick(A, (p) => p === A + '/OJchart Notification') === A + '/OJchart Notification',
    'an existing post-round-51 folder is kept (accounts/logs/layouts intact)');
  ok(pick(A, (p) => p === A + '/OJchart') === A + '/OJchart',
    'a packaged build folder is kept');
  ok(pick(A, (p) => p === A + '/mt5-chart-terminal') === A + '/mt5-chart-terminal',
    'a dev-run folder is kept');
  ok(pick(A, (p) => p === A + '/OJchart Notification' || p === A + '/OJchart') === A + '/OJchart Notification',
    'the newest convention wins when several exist');
  ok(pick(A, () => false) === A + '/OJchart', 'a fresh install starts in <appData>/OJchart');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
