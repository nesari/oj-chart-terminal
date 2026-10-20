/**
 * ROUND125 — frameless TradingView-Desktop window shell (user request):
 *
 *  The user asked for the NATIVE title bar (app name left, min/max/close
 *  right) to disappear entirely — exactly like TradingView Desktop for
 *  Windows — so that the TAB STRIP becomes the topmost bar of the window
 *  and only its right end carries the integrated Windows buttons.
 *
 *  Implementation under test:
 *   1. main.js      — frame:false on BOTH windows (host createWindow + the
 *                     detached tabs:undock window); win:minimize /
 *                     win:maximize (toggle) / win:close / win:is-max channels
 *                     acting on the SENDER's window; the maximize/unmaximize
 *                     broadcast wired in secureWindow (shared by every
 *                     window) through the win:max-state channel.
 *   2. preload.js   — the mt5Win bridge (minimize/maxToggle/close/isMax/
 *                     onMaxState).
 *   3. index.html   — #win-controls (3 .wc-btn) flush at the strip's right
 *                     end behind a #strip-spacer, and the slim
 *                     #login-titlebar (drag surface + the same buttons)
 *                     while the login card is up.
 *   4. app.css      — -webkit-app-region: drag on #tab-strip and
 *                     #login-titlebar, no-drag on every interactive child,
 *                     46px full-height buttons, Win11 hover + system-red
 *                     close hover, CSS-only glyphs, body.is-max restore
 *                     glyph, align-self stretch inside the flex-end strip.
 *   5. wincontrols.js + app.js — the wiring module (all three buttons,
 *                     glyph sync through onMaxState + a boot-time isMax
 *                     read, silent no-op without the bridge) booted FIRST
 *                     in boot().
 *
 *  Regression guards: the ROUND121 markup order (#app → #tab-strip →
 *  #top-toolbar), the ROUND122 tab-dock button and the strip's
 *  background: var(--bg) rule stay intact.
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
const preload = read('preload.js');
const html = read('src/renderer/index.html');
const css = read('src/renderer/css/app.css');
const appjs = read('src/renderer/js/app.js');
const wincontrols = read('src/renderer/js/ui/wincontrols.js');
/* behavioural scans run on code with block comments stripped */
const mainCode = main.replace(/\/\*[\s\S]*?\*\//g, '');
const preCode = preload.replace(/\/\*[\s\S]*?\*\//g, '');
const appCode = appjs.replace(/\/\*[\s\S]*?\*\//g, '');
const wcCode = wincontrols.replace(/\/\*[\s\S]*?\*\//g, '');

console.log('— ROUND125 · main.js: frameless windows (host + detached) —');
check('createWindow boots the HOST window with frame:false',
  /mainWindow = new BrowserWindow\(\{[\s\S]{0,900}?frame: false,/.test(mainCode));
check('the tabs:undock DETACHED window boots with frame:false too',
  /win = new BrowserWindow\(\{[\s\S]{0,1200}?frame: false,/.test(mainCode));
check('both frame:false options carry the ROUND125 rationale comment',
  /ROUND125 \(user request\): TradingView-Desktop for Windows has NO native[\s\S]{0,300}?frame: false,/.test(main) &&
  /ROUND125: detached windows wear the same TV-Desktop shell[\s\S]{0,300}?frame: false,/.test(main));

console.log('— ROUND125 · main.js: window-control IPC (sender-scoped) —');
check('win:minimize minimizes the SENDER window only',
  /ipcMain\.on\('win:minimize', \(e\) => \{\s*const w = BrowserWindow\.fromWebContents\(e\.sender\);\s*if \(w && !w\.isDestroyed\(\)\) w\.minimize\(\);\s*\}\)/.test(mainCode));
check('win:maximize TOGGLES maximize/restore on the SENDER window',
  /ipcMain\.on\('win:maximize', \(e\) => \{[\s\S]{0,220}?if \(w\.isMaximized\(\)\) w\.unmaximize\(\); else w\.maximize\(\);/.test(mainCode));
check('win:close closes the SENDER window only',
  /ipcMain\.on\('win:close', \(e\) => \{\s*const w = BrowserWindow\.fromWebContents\(e\.sender\);\s*if \(w && !w\.isDestroyed\(\)\) w\.close\(\);\s*\}\)/.test(mainCode));
check('win:is-max returns the boot-time maximized state',
  /ipcMain\.handle\('win:is-max', \(e\) => \{[\s\S]{0,260}?max: !!\(w && !w\.isDestroyed\(\) && w\.isMaximized\(\)\)/.test(mainCode));
check('secureWindow (shared by host + solo) broadcasts maximize/unmaximize as win:max-state',
  /const sendMaxState = \(\) => \{ try \{ win\.webContents\.send\('win:max-state', !!win\.isMaximized\(\)\); \} catch \(e\) \{\} \};\s*win\.on\('maximize', sendMaxState\);\s*win\.on\('unmaximize', sendMaxState\);/.test(mainCode));

console.log('— ROUND125 · preload.js: the mt5Win bridge —');
check('mt5Win exposes minimize / maxToggle / close on the win:* send channels',
  /exposeInMainWorld\('mt5Win', \{[\s\S]*?minimize: \(\) => ipcRenderer\.send\('win:minimize'\),[\s\S]*?maxToggle: \(\) => ipcRenderer\.send\('win:maximize'\),[\s\S]*?close: \(\) => ipcRenderer\.send\('win:close'\),/.test(preCode));
check('mt5Win exposes isMax (invoke) + onMaxState (push listener)',
  /isMax: \(\) => ipcRenderer\.invoke\('win:is-max'\),[\s\S]*?onMaxState: \(cb\) => ipcRenderer\.on\('win:max-state', \(e, m\) => cb\(!!m\)\),/.test(preCode));

console.log('— ROUND125 · index.html: integrated controls in the strip + login bar —');
check('#win-controls lives INSIDE #tab-strip (the topmost bar now)',
  /<div id="tab-strip"[\s\S]{0,1400}?<div class="win-controls" id="win-controls">[\s\S]{0,400}?<\/div>\s*<\/div>\s*<header id="top-toolbar">/.test(html));
check('the strip controls carry exactly min / max / close buttons',
  /<div class="win-controls" id="win-controls">\s*<button class="wc-btn wc-min" title="Minimize"><\/button>\s*<button class="wc-btn wc-max" title="Maximize"><\/button>\s*<button class="wc-btn wc-close" title="Close"><\/button>\s*<\/div>/.test(html));
check('a strip-spacer keeps the buttons flush right while staying draggable',
  /<div class="strip-spacer" id="strip-spacer"><\/div>\s*<div class="win-controls" id="win-controls">/.test(html));
check('#login-titlebar (drag bar + the same three buttons) sits in #login-screen',
  /<div id="login-screen">[\s\S]{0,300}?<div id="login-titlebar">\s*<div class="strip-spacer"><\/div>\s*<div class="win-controls">\s*<button class="wc-btn wc-min"[\s\S]{0,300}?<\/div>\s*<\/div>/.test(html));

console.log('— ROUND125 · app.css: drag surface + Win11-style integrated buttons —');
check('#tab-strip is the window drag surface (empty area moves the window)',
  /#tab-strip \{[\s\S]{0,600}?-webkit-app-region: drag;/.test(css));
check('#login-titlebar is a drag surface too',
  /#login-titlebar \{[\s\S]{0,400}?-webkit-app-region: drag;/.test(css));
check('every interactive strip child opts OUT (tab list / + / dock / controls / buttons)',
  /#tab-list, \.tab-add, \.tab-dock, \.win-controls, \.wc-btn \{ -webkit-app-region: no-drag; \}/.test(css));
check('buttons are 46px wide, full height, borderless (Win11 title-bar metrics)',
  /\.wc-btn \{[\s\S]{0,300}?width: 46px; height: 100%;[\s\S]{0,220}?border: 0; border-radius: 0;/.test(css));
check('hover is a neutral overlay; the CLOSE hover is the Windows system red',
  /\.wc-btn:hover \{ background: rgba\(255,255,255,\.09\); color: var\(--text\); \}/.test(css) &&
  /\.wc-close:hover \{ background: #e81123; color: #fff; \}/.test(css));
check('glyphs are CSS-only via currentColor (line / box / diagonal cross)',
  /\.wc-min::before \{ content: ''; width: 10px; height: 1px; background: currentColor; \}/.test(css) &&
  /\.wc-max::before \{ content: ''; width: 9px; height: 9px; border: 1px solid currentColor; border-radius: 2px; \}/.test(css) &&
  /\.wc-close::before, \.wc-close::after \{[\s\S]{0,200}?transform: rotate\(45deg\);/.test(css));
check('body.is-max flips the maximize glyph into the two-square restore form',
  /body\.is-max \.wc-max::before \{ width: 8px; height: 8px; transform: translate\(2px, -2px\); \}/.test(css) &&
  /body\.is-max \.wc-max::after \{[\s\S]{0,300}?transform: translate\(-2px, 2px\);/.test(css));
check('the controls stretch to the full strip height inside its flex-end row',
  /\.win-controls \{ display: flex; align-items: stretch; flex: 0 0 auto; align-self: stretch; \}/.test(css));
check('the strip keeps its ROUND121 background (stale-contract guard)',
  /#tab-strip \{[\s\S]*?background: var\(--bg\);/.test(css));
check('strip padding-right is zero so the buttons sit flush at the window edge',
  /#tab-strip \{[\s\S]{0,200}?padding: 0 0 0 8px;/.test(css));

console.log('— ROUND125 · wincontrols.js + app.js: wiring + glyph sync —');
check('the module wires all three buttons to the mt5Win bridge',
  /if \(min\) min\.addEventListener\('click', \(\) => \{ try \{ window\.mt5Win\.minimize\(\); \} catch \(e\) \{\} \}\);/.test(wcCode) &&
  /if \(max\) max\.addEventListener\('click', \(\) => \{ try \{ window\.mt5Win\.maxToggle\(\); \} catch \(e\) \{\} \}\);/.test(wcCode) &&
  /if \(close\) close\.addEventListener\('click', \(\) => \{ try \{ window\.mt5Win\.close\(\); \} catch \(e\) \{\} \}\);/.test(wcCode));
check('init() wires EVERY .win-controls instance (strip + login bar)',
  /document\.querySelectorAll\('\.win-controls'\)\.forEach\(wire\);/.test(wcCode));
check('the glyph mirrors the push channel + a boot-time isMax read (body.is-max)',
  /window\.mt5Win\.onMaxState\(apply\);/.test(wcCode) &&
  /window\.mt5Win\.isMax\(\)\s*\.then\(\(r\) => \{ apply\(!!\(r && r\.max\)\); \}\)/.test(wcCode));
check('no bridge (http test harness) → silent no-op, shell untouched',
  /if \(!window\.mt5Win\) return;/.test(wcCode));
check('app.js imports WinControls and boots it FIRST in boot()',
  /import \{ WinControls \} from '\.\/ui\/wincontrols\.js';/.test(appCode) &&
  /* STALE-FIX (round 206): Feed gained its ws-URL ctor arg (new Feed(url)),
     so the old `new Feed();` literal no longer matches — the contract
     (WinControls.init() before the first App.feed line) is unchanged. */
  /WinControls\.init\(\);[\s\S]{0,400}?App\.feed = App\.feed \|\| new Feed\(/.test(appCode));

console.log('— ROUND125 · stale-contract guards (rounds 121/122 untouched) —');
check('ROUND121 order intact: #app → #tab-strip → #top-toolbar',
  /<div id="app"[^>]*>[\s\S]*?<div id="tab-strip"[\s\S]*?<header id="top-toolbar">/.test(html));
check('ROUND122 tab-dock button markup untouched',
  /<button class="tab-dock" id="tab-dock-btn" title="Move tab to main window"><\/button>/.test(html));
check('the tab-add button markup untouched (strip children keep their seams)',
  /<button class="tab-add" id="tab-add-btn" title="New chart tab \(Ctrl\+T\)"><\/button>/.test(html));

console.log(`\nROUND125: ${N - BAD}/${N} checks passed`);
if (BAD) process.exit(1);
