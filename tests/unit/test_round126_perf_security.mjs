/**
 * ROUND126 — performance & security hardening (user request):
 *
 *  The user reported elevated CPU/RAM usage and asked for an audit + fix
 *  WITHOUT breaking, removing or changing any feature. Findings fixed:
 *
 *  1. manager.js render loop — repainted EVERY pane's overlay canvas at
 *     full display refresh forever, in every window, even when nothing
 *     changed. Now: activity-driven (pointer/key/wheel/resize listeners +
 *     ticks that reach a visible pane + visible-range changes) with a
 *     250ms idle heartbeat; unfocused windows always ride the heartbeat.
 *  2. manager.js syncSubRanges — spawned a PERPETUAL rAF chain per call
 *     (loadBars / loadOlder / sub-pane add) that accumulated forever.
 *     Now: ONE visibleLogicalRangeChanged subscription per pane, guarded
 *     rAF fallback (single chain, cleared in destroyPanes).
 *  3. engine.js — every Engine pinned an anonymous window-level mouseup
 *     listener forever. Now: named handler + destroy() called from
 *     destroyPanes.
 *  4. main.js — permission request/check handlers deny web permissions;
 *     global web-contents-created safety net (window.open + will-navigate);
 *     save-text-file size cap (parity with logs-export).
 *
 *  Everything else (features of rounds 120–125, IPC shapes, tab lifecycle)
 *  must stay byte-compatible.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(ROOT + p, 'utf8');
let N = 0, BAD = 0;
function check(name, cond, extra) {
  N++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + ((!cond && extra !== undefined) ? ' — ' + extra : ''));
  if (!cond) BAD++;
}

const main = read('main.js');
const manager = read('src/renderer/js/chart/manager.js');
const engine = read('src/renderer/js/drawing/engine.js');
/* behavioural scans run on code with block comments stripped */
const mainCode = main.replace(/\/\*[\s\S]*?\*\//g, '');
const mgrCode = manager.replace(/\/\*[\s\S]*?\*\//g, '');
const engCode = engine.replace(/\/\*[\s\S]*?\*\//g, '');

console.log('— ROUND126 · manager.js: adaptive render loop —');
check('markChartActivity exists and stamps the activity clock',
  /Manager\.markChartActivity = function \(\) \{ _lastAct = performance\.now\(\); \};/.test(mgrCode));
check('activity window + idle heartbeat constants',
  /const ACT_WINDOW = 1300;/.test(mgrCode) && /const IDLE_FLOOR = 250;/.test(mgrCode));
check('one passive capture listener set per window (pointer/keys/wheel/touch/resize)',
  /document\.addEventListener\('pointermove', mark, \{ capture: true, passive: true \}\)/.test(mgrCode) &&
  /document\.addEventListener\('pointerdown', mark, \{ capture: true, passive: true \}\)/.test(mgrCode) &&
  /document\.addEventListener\('wheel', mark, \{ capture: true, passive: true \}\)/.test(mgrCode) &&
  /document\.addEventListener\('touchmove', mark, \{ capture: true, passive: true \}\)/.test(mgrCode) &&
  /document\.addEventListener\('keydown', mark, \{ capture: true \}\)/.test(mgrCode) &&
  /window\.addEventListener\('resize', mark\)/.test(mgrCode));
check('paint gate: focused+fresh = full rate, otherwise the heartbeat floor',
  /const paint = \(fresh && focused\) \|\| \(ts - _lastPaint >= IDLE_FLOOR\);/.test(mgrCode));
check('unfocused windows never paint above the heartbeat (hasFocus read)',
  /focused = document\.hasFocus\(\);/.test(mgrCode));
check('overlay render still inside the loop (per pane)',
  /if \(p\.engine\) p\.engine\.render\(\);/.test(mgrCode));
check('countdown throttle (400ms) and axisGuard watchdog (1500ms) survive OUTSIDE the paint gate',
  /if \(ts - lastCd > 400\) \{[\s\S]{0,80}?Manager\.updateCountdowns\(\);[\s\S]{0,40}?\}\s*if \(ts - lastGuard > 1500\) \{[\s\S]{0,120}?try \{ Manager\.axisGuard\(\); \} catch \(e\) \{\}[\s\S]{0,40}?\}\s*requestAnimationFrame\(loop\);/.test(mgrCode));
check('a tick that reaches a VISIBLE pane marks activity (touched flag)',
  /let touched = false;/.test(mgrCode) &&
  /if \(pane\.symbol !== symbol \|\| pane\.replay\) continue;\s*touched = true;/.test(mgrCode) &&
  /if \(touched && Manager\.markChartActivity\) Manager\.markChartActivity\(\);/.test(mgrCode));
check('watchlist-only ticks do NOT force full-rate repaint (no unconditional mark)',
  !/function onTick\(symbol, price, time, volume, bid, ask\) \{\s*Manager\.markChartActivity\(\);/.test(mgrCode));
check('visible-range changes mark activity (programmatic moves repaint next frame)',
  /subscribeVisibleLogicalRangeChanged\(\(\) => \{ if \(Manager\.markChartActivity\) Manager\.markChartActivity\(\); \}\);/.test(mgrCode));

console.log('— ROUND126 · manager.js: syncSubRanges leak fixed —');
check('the perpetual per-call rAF chain is GONE',
  !/raf\(\(\) => \{ apply\(\); raf\(apply\); \}\);/.test(mgrCode));
check('bound ONCE per pane through LWC subscribeVisibleLogicalRangeChanged',
  /if \(pane\._lrBound\) return;\s*pane\._lrBound = true;\s*try \{\s*pane\.chart\.timeScale\(\)\.subscribeVisibleLogicalRangeChanged/.test(mgrCode));
check('legacy rAF fallback is capped at ONE chain per pane (_lrRaf guard)',
  /if \(!pane\._lrRaf\) \{\s*pane\._lrRaf = true;/.test(mgrCode));
check('fallback chain stops when the pane dies (destroyPanes clears _lrRaf)',
  /try \{ if \(p\._lrRaf != null\) p\._lrRaf = false; \} catch \(e\) \{\}/.test(mgrCode));
check('the immediate re-pin apply() still runs on every syncSubRanges call',
  /apply\(\);\s*if \(pane\._lrBound\) return;/.test(mgrCode));

console.log('— ROUND126 · engine.js: window listener teardown —');
check('window mouseup handler is a named instance method (_onWinUp)',
  /this\._onWinUp = \(e\) => \{/.test(engCode) &&
  /window\.addEventListener\('mouseup', this\._onWinUp\);/.test(engCode));
check('destroy() releases the window listener',
  /destroy\(\) \{\s*try \{ if \(this\._onWinUp\) \{ window\.removeEventListener\('mouseup', this\._onWinUp\); \} \} catch \(e\) \{\}/.test(engCode));
check('destroyPanes calls engine.destroy (guarded)',
  /try \{ if \(p\.engine && p\.engine\.destroy\) p\.engine\.destroy\(\); \} catch \(e\) \{\}/.test(mgrCode));
check('the gesture scratch-clear order inside the handler is preserved (round 21 fix)',
  /this\._onWinUp = \(e\) => \{\s*\/\* gesture scratch state is cleared BEFORE the early return[\s\S]*?this\._axisDrag = null;\s*this\._pz = null;\s*this\._tz = null;\s*this\._panLastY = null;/.test(engine));

console.log('— ROUND126 · main.js: security hardening —');
check('permission REQUESTS are denied app-wide (with security log)',
  /session\.setPermissionRequestHandler\(\(wc, permission, cb\) => \{/.test(mainCode) &&
  /mlogEvent\('warning', 'security', 'permission request denied'/.test(mainCode) &&
  /cb\(false\);/.test(mainCode));
check('permission CHECKS are denied app-wide',
  /session\.setPermissionCheckHandler\(\(wc, permission\) => DENIED_PERMISSIONS\.has\(String\(permission\)\)\);/.test(mainCode));
check('hardenPermissions runs on the default session at boot',
  /hardenPermissions\(require\('electron'\)\.session\.defaultSession\);/.test(mainCode));
check('global web-contents-created safety net: window.open denied',
  /app\.on\('web-contents-created', \(event, wc\) => \{/.test(mainCode) &&
  /wc\.setWindowOpenHandler\(\(\) => \{\s*mlogEvent\('warning', 'security', 'window\.open blocked by global policy'\);\s*return \{ action: 'deny' \};/.test(mainCode));
check('global safety net: remote navigation blocked (file: only)',
  /wc\.on\('will-navigate', \(ev, url\) => \{\s*if \(!String\(url\)\.startsWith\('file:'\)\) \{\s*ev\.preventDefault\(\);/.test(mainCode));
check('save-text-file is size-capped (parity with logs-export)',
  /if \(content\.length > 50 \* 1024 \* 1024\) return \{ ok: false, error: 'content too large' \};/.test(mainCode));
check('per-window secureWindow posture untouched (round 28/101/125)',
  /win\.webContents\.setWindowOpenHandler\(\(\) => \{/.test(mainCode) &&
  /input\.key === 'F12' \|\|/.test(mainCode) &&
  /win\.on\('maximize', sendMaxState\);/.test(mainCode));

console.log('— ROUND126 · stale-contract guards (features must not move) —');
check('startLoop is still invoked exactly once (started flag)',
  /let started = false;\s*let _lastAct = 0;\s*let _lastPaint = 0;/.test(mgrCode) &&
  /Manager\.startLoop = function \(\) \{\s*if \(started\) return;\s*started = true;/.test(mgrCode));
check('onTick still ends with updateCountdowns (countdown cadence untouched)',
  /if \(touched && Manager\.markChartActivity\) Manager\.markChartActivity\(\);\s*Manager\.updateCountdowns\(\);\s*\}/.test(mgrCode));
check('feed tick fan-out untouched (40ms batching, 64 cap)',
  /this\._tickQueue\.length > 64/.test(read('src/core/feed.js')) &&
  /\}, 40\);/.test(read('src/core/feed.js')));
check('engine still exposes render() with the grid-clear first-frame contract',
  /render\(\) \{\s*const cv = this\.canvas;/.test(engCode));
check('round123 dock record validator untouched',
  /function validDockRec\(r\) \{/.test(mainCode) && /131072/.test(mainCode));
check('round125 frameless shell untouched (frame:false + win channels)',
  /frame: false,/.test(mainCode) &&
  /ipcMain\.on\('win:minimize'/.test(mainCode) &&
  /ipcMain\.on\('win:maximize'/.test(mainCode));

console.log(`\nROUND126: ${N - BAD}/${N} checks passed`);
if (BAD) process.exit(1);
