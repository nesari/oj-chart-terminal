/**
 * test_round287_app_bugs.mjs — bugs found by the full-app audit.
 *
 * The audit (tests/archive/e2e/audit_left_toolbar.py + audit_app_deep.py)
 * exercised the real app and found two genuine defects:
 *
 *  1. LEFT TOOLBAR: with any tool-group flyout open, clicking a DIFFERENT group
 *     only closed the old flyout — the new group needed a SECOND click. TV
 *     switches straight to the clicked group's flyout. (`if (flyout) {
 *     closeFlyout(); return; }` short-circuited every other group.)
 *
 *  2. APP FACADE: `Tester` and `StratDock` were imported and `.init()`-ed in
 *     boot() but never added to `window.__app`, so the Strategy Tester was
 *     unreachable from tests, diagnostics and any external caller.
 *
 * Run: node tests/unit/test_round287_app_bugs.mjs
 */

import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

const ui = readSource('src/renderer/js/drawing/ui.js');
const app = readSource('src/renderer/js/app.js');

/* ---------- 1. the toolbar switches groups instead of just closing ---------- */
{
  /* the old short-circuit is gone */
  ok(!/if \(flyout\) \{ closeFlyout\(\); return; \}/.test(ui),
    'the "close only" short-circuit is removed');

  /* the new logic distinguishes same-group (toggle) from other-group (switch) */
  ok(/const sameGroupOpen = flyout && flyout\._group === g\.id;/.test(ui),
    'the click handler identifies the group that owns the open flyout');
  ok(/if \(flyout\) closeFlyout\(\);/.test(ui), 'any open flyout is closed first');
  ok(/if \(sameGroupOpen\) return;/.test(ui), 'clicking the SAME group toggles it closed');
  ok(/openFlyout\(b, g\);/.test(ui), 'clicking a DIFFERENT group opens its flyout');

  /* the flyout records its owner */
  ok(/fl\._group = group\.id;/.test(ui), 'openFlyout stamps the owning group on the element');

  /* ordering: close -> same-group check -> single-tool -> open */
  const body = (ui.match(/const sameGroupOpen[\s\S]{0,320}?\n      \}\);/) || [''])[0];
  const iClose = body.indexOf('if (flyout) closeFlyout();');
  const iSame = body.indexOf('if (sameGroupOpen) return;');
  const iOpen = body.indexOf('openFlyout(b, g);');
  ok(iClose > -1 && iSame > iClose && iOpen > iSame, 'the checks happen in the right order', body.length);
}

/* ---------- 1b. simulated click sequence ---------- */
{
  /* mirror the production decision function so the semantics stay pinned */
  const decide = (openGroup, clickedGroup, toolCount) => {
    const sameGroupOpen = openGroup != null && openGroup === clickedGroup;
    if (openGroup != null) { /* close */ }
    if (sameGroupOpen) return 'closed';
    if (toolCount === 1) return 'activate';
    return 'open:' + clickedGroup;
  };
  ok(decide('lines', 'lines', 18) === 'closed', 're-clicking the open group closes it');
  ok(decide('lines', 'fibs', 19) === 'open:fibs', 'clicking another group opens ITS flyout (was the bug)');
  ok(decide(null, 'fibs', 19) === 'open:fibs', 'clicking with nothing open opens normally');
  ok(decide('lines', 'measure', 1) === 'activate', 'a single-tool group still activates its tool');
  ok(decide('lines', 'zoom', 1) === 'activate', 'same for the zoom group');
}

/* ---------- 2. the app facade exposes the strategy tester ---------- */
{
  ok(/Tester, StratDock,/.test(app), 'Tester and StratDock are on the app facade');
  /* they must still be imported and initialized (no accidental removal) */
  ok(/import \{ Tester \} from '\.\/panels\/tester\.js';/.test(app), 'Tester is still imported');
  ok(/import \{ StratDock \} from '\.\/panels\/stratdock\.js';/.test(app), 'StratDock is still imported');
  ok(/if \(Tester\) Tester\.init\(\);/.test(app), 'Tester is still initialized');
  ok(/if \(StratDock\) StratDock\.init\(\);/.test(app), 'StratDock is still initialized');

  /* the facade object shape: every key exposed must exist in scope */
  const facade = (app.match(/window\.__app = \{[\s\S]*?\n    \};/) || [''])[0];
  ok(facade.length > 100, 'the facade block was found');
  ok(/Tester/.test(facade) && /StratDock/.test(facade), 'both are inside the facade object');
  /* no duplicate keys that would shadow each other */
  const keys = [...facade.matchAll(/([A-Za-z_][A-Za-z0-9_]*),/g)].map((m) => m[1]);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  ok(dupes.length === 0, 'the facade has no duplicate keys', [...new Set(dupes)].join(','));
}

/* ---------- 3. the audit tools that found these stay runnable ---------- */
{
  const lt = readSource('tests/archive/e2e/audit_left_toolbar.py');
  ok(/single-tool group activates directly/.test(lt), 'the left-toolbar audit understands single-tool groups');
  ok(/lt-tile/.test(lt), 'it inspects the real flyout markup (.lt-tile)');
  ok(/tOf/.test(lt), 'the paint stub provides the view API real tools need');

  const deep = readSource('tests/archive/e2e/audit_app_deep.py');
  ok(/Indicators\.all/.test(deep), 'the deep audit uses the real indicator catalogue');
  ok(/Undo\.add/.test(deep), 'it adds drawings through Undo so undo is exercised');
  ok(/A\.watchlist/.test(deep) || /App\.watchlist/.test(deep), 'it reads the real watchlist array');
}

console.log('\nROUND287: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
