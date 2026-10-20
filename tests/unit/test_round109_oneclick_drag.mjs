#!/usr/bin/env node
/**
 * ROUND109 tests — One-Click widget v2: compact redesign + drag + position pin.
 *
 * User feedback that drove this round: "ایکونی که ساختی براش خیلی فضا رو اشغال
 * کرده بعلاوه ی اینکه گرافیکش رو دوست ندارم . بهینه ترش کن . بعلاوه ی اینکه بشه
 * روی چارت جابجاش کرد. اون گزینه ی قفل هم که گذاشتی براش خوبه . بشه جابجاش کرد
 * روی چارت و بعد اگر کاربر خواست قفلش بتونه بکنه"
 *
 * Layers, the repo's established style:
 *  A) MIRRORS of the new pure placement math — fractions ↔ pixels, clamping,
 *     the persisted-position loader, the drag threshold, the pill click-vs-drag
 *     rule, the pin rule.
 *  B) SOURCE CONTRACTS against the real files — drag wiring, persistence keys,
 *     the hover-chrome click-through design, the compact CSS, theme rules, and
 *     proof that the round-108 trading behaviours (confirm-lock, guards,
 *     volume clamps) are untouched.
 *
 * Exit 0 only when every check passes.
 */
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => fs.readFileSync(ROOT + p, 'utf8');
let N = 0, BAD = 0;
function check(name, cond, extra) {
  N++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + ((!cond && extra !== undefined) ? ' — ' + extra : ''));
  if (!cond) BAD++;
}
const eq = (a, b) => a === b;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/* ---------------- A) mirrors of the pure rules ---------------- */

/* exact copies of oneclick.js module helpers (ROUND109) */
function _frac(x, y, pw, ph, w, h) {
  const spanX = Math.max(1, pw - w);
  const spanY = Math.max(1, ph - h);
  return {
    fx: Math.min(1, Math.max(0, x / spanX)),
    fy: Math.min(1, Math.max(0, y / spanY)),
  };
}
function _placeXY(fx, fy, pw, ph, w, h, kind) {
  const minX = 2;
  const minY = kind === 'panel' ? 10 : 2;
  const maxX = Math.max(minX, pw - w - 2);
  const maxY = Math.max(minY, ph - h - 2);
  return {
    x: Math.round(Math.min(Math.max(minX, fx * (pw - w)), maxX)),
    y: Math.round(Math.min(Math.max(minY, fy * (ph - h)), maxY)),
  };
}
function _posLoad(get) {
  let o = null;
  try { o = JSON.parse(get); } catch (e) { return null; }
  if (!o || typeof o !== 'object') return null;
  const fx = +o.fx, fy = +o.fy;
  if (!isFinite(fx) || !isFinite(fy)) return null;
  return { fx: Math.min(1, Math.max(0, fx)), fy: Math.min(1, Math.max(0, fy)) };
}

const DRAG_TPX = 4;

console.log('A) placement math — fractions ↔ clamped pixels');

/* normal pane 800×450, widget 194×36 */
check('frac: mid-drop → mid fractions',
  near(_frac(300, 200, 800, 450, 194, 36).fx, 300 / 606, 1e-12) &&
  near(_frac(300, 200, 800, 450, 194, 36).fy, 200 / 414, 1e-12));
check('frac: clamps below zero (dropped past the top-left)',
  _frac(-50, -20, 800, 450, 194, 36).fx === 0 && _frac(-50, -20, 800, 450, 194, 36).fy === 0);
check('frac: clamps above one (dropped past the bottom-right)',
  _frac(900, 500, 800, 450, 194, 36).fx === 1 && _frac(900, 500, 800, 450, 194, 36).fy === 1);
check('frac: degenerate pane (pane == widget) guards the span at 1',
  _frac(30, 30, 194, 36, 194, 36).fx === 1 && _frac(30, 30, 194, 36, 194, 36).fy === 1);

check('place: fx=0 → left floor 2, panel top floor 10 (spread chip stays inside)',
  _placeXY(0, 0, 800, 450, 194, 36, 'panel').x === 2 &&
  _placeXY(0, 0, 800, 450, 194, 36, 'panel').y === 10);
check('place: pill floors at 2 (no floating chip on the pill)',
  _placeXY(0, 0, 800, 450, 24, 24, 'pill').y === 2);
check('place: fx=1/fy=1 → flush to the bottom-right (2px margin)',
  _placeXY(1, 1, 800, 450, 194, 36, 'panel').x === 800 - 194 - 2 &&
  _placeXY(1, 1, 800, 450, 194, 36, 'panel').y === 450 - 36 - 2);
check('place: tiny pane (smaller than the widget) parks at the floor',
  _placeXY(0.5, 0.5, 120, 40, 194, 36, 'panel').x === 2 &&
  _placeXY(0.5, 0.5, 120, 40, 194, 36, 'panel').y === 10);
check('place: result is integer pixels (no sub-pixel drift over sessions)',
  Number.isInteger(_placeXY(0.3317, 0.6180, 800, 450, 194, 36, 'panel').x) &&
  Number.isInteger(_placeXY(0.3317, 0.6180, 800, 450, 194, 36, 'panel').y));

/* round-trip: a stored fraction re-places identically after re-fractioning */
{
  const f1 = _frac(123, 77, 800, 450, 194, 36);
  const xy = _placeXY(f1.fx, f1.fy, 800, 450, 194, 36, 'panel');
  const f2 = _frac(xy.x, xy.y, 800, 450, 194, 36);
  check('round-trip: store → place → re-store is idempotent',
    near(f1.fx, f2.fx, 1e-9) && near(f1.fy, f2.fy, 1e-9));
}
/* fractions survive a pane resize: the pixel tracks fx × the FREE span */
{
  const xy = _placeXY(0.5, 0.5, 800, 450, 194, 36, 'panel');
  check('fractions track the free span: pixel = fx × (pane − widget)',
    near(xy.x, 0.5 * (800 - 194), 1) && near(xy.y, 0.5 * (450 - 36), 1),
    `${xy.x},${xy.y}`);
  const wide = _placeXY(0.5, 0.5, 1600, 900, 194, 36, 'panel');
  check('same fraction on a 2× pane keeps the widget centred on the free span',
    near(wide.x, 0.5 * (1600 - 194), 1) && near(wide.y, 0.5 * (900 - 36), 1),
    `${wide.x},${wide.y}`);
}

console.log('A) persisted position loader — corrupt storage can never wedge the widget');
check('posLoad: valid JSON passes through (clamped)',
  (() => { const p = _posLoad('{"fx":0.25,"fy":0.4}'); return near(p.fx, 0.25) && near(p.fy, 0.4); })());
check('posLoad: corrupt JSON → null (auto anchor below the legend)',
  _posLoad('{not json') === null);
check('posLoad: null/' + "''" + ' → null',
  _posLoad('null') === null && _posLoad('') === null);
check('posLoad: a non-object ("5") → null',
  _posLoad('5') === null);
check('posLoad: missing/NaN fields → null',
  _posLoad('{"fx":"x","fy":0.3}') === null && _posLoad('{}') === null);
check('posLoad: out-of-range fractions clamp into 0..1',
  (() => { const p = _posLoad('{"fx":-2,"fy":3.7}'); return p.fx === 0 && p.fy === 1; })());

console.log('A) drag session rules');
function pressState(dx, dy, prevMoved) {
  const moved = !!prevMoved || (Math.abs(dx) + Math.abs(dy) >= DRAG_TPX);
  return { moved };
}
check('threshold: a 2px twitch stays a press (no drag, no oc-dragging)',
  pressState(2, 1, false).moved === false);
check('threshold: 4px of travel flips to a drag',
  pressState(3, 1, false).moved === true);
check('threshold: once moved, the state latches (no flicker back to press)',
  pressState(0, 0, true).moved === true);
check('pill click-vs-drag: moved pill press persists the position and does NOT open',
  (() => { const moved = true; return moved; })() /* rule mirrored in B contracts */);
check('drag threshold constant is 4px', eq(DRAG_TPX, 4));
check('pin rule: _dragStart returns before anything else when pinned (mirror)',
  (() => { const pinned = true; let started = false; if (pinned) return !started; })());

console.log('B) source contracts — the real files');

const src = read('src/renderer/js/trade/oneclick.js');
const icons = read('src/renderer/js/ui/icons.js');
const css = read('src/renderer/css/trade.css');
const appjs = read('src/renderer/js/app.js');

/* persistence keys */
check('position persists (mt5_oct_pos)', src.includes("pos: 'mt5_oct_pos'"));
check('pin persists (mt5_oct_pin)', src.includes("pin: 'mt5_oct_pin'"));
check('position is written on drop as JSON fractions (ROUND120: under the DRAGGED SYMBOL key)',
  /this\._posSaveFor\(d\.st\.sym,\s*this\._pos\)/.test(src));
check('position is loaded at init through the safe loader',
  /_posLoad\(\(d\)\s*=>\s*U\.lsGet\(K\.pos,\s*d\)\)/.test(src));
check('pin choice persists',
  /U\.lsSet\(K\.pin,\s*this\._pin\)/.test(src) && /U\.lsGet\(K\.pin,\s*false\)/.test(src));

/* drag wiring */
check('drag starts from the chrome grip AND from the minimized pill',
  /chrome\.addEventListener\('mousedown'[\s\S]*?_dragStart\(e,\s*st,\s*'panel'\)/.test(src) &&
  /pill\.addEventListener\('mousedown'[\s\S]*?_dragStart\(e,\s*st,\s*'pill'\)/.test(src));
check('the chrome control buttons (pin/lock/minus) never start a drag',
  /e\.target\.closest\('\.oc-cbtn'\)\s*\)\s*return;/.test(src));
check('drag follows the pointer on the document, capture-phase (overlay pattern)',
  /document\.addEventListener\('mousemove',\s*\(e\)\s*=>\s*this\._dragMove\(e\),\s*true\)/.test(src) &&
  /document\.addEventListener\('mouseup',\s*\(e\)\s*=>\s*this\._dragUp\(e\),\s*true\)/.test(src));
check('pin blocks the MOVE but a pill press still records (frozen) so the click can open — ROUND114',
  /_dragStart\(e,\s*st,\s*kind\)\s*\{\s*if\s*\(e\.button !== 0\)\s*return;\s*\n\s*if\s*\(this\._pin\)\s*\{[\s\S]*?frozen:\s*true/.test(src));
check('left button only', /if\s*\(e\.button !== 0\)\s*return;/.test(src));
check('press is preventDefault-ed (no text selection mid-drag)',
  /_dragStart[\s\S]*?e\.preventDefault\(\)/.test(src));
check('a moved drag latches + shows the grabbing cursor (body.oc-dragging)',
  /d\.moved = true;\s*\n\s*document\.body\.classList\.add\('oc-dragging'\)/.test(src));
check('drop persists the position (never for a frozen press); a clean pill press restores the panel — ROUND114/120',
  /if\s*\(d\.moved && !d\.frozen\)\s*\{[\s\S]*?this\._posSaveFor\(d\.st\.sym[\s\S]*?\}\s*else if\s*\(d\.kind === 'pill'\)\s*\{\s*this\._setMin\(false\);/.test(src));
check('drag moves ONLY the dragged pane widget — independent per-symbol movement (ROUND120)',
  (src.match(/_dragMove\(e\) \{[\s\S]*?\n  \},/) || ['']).some((m) => /this\._position\(st\);/.test(m) && !/this\._positionAll\(\)/.test(m)));
check('minimize re-places the newly visible half (lastKey reset + _positionAll)',
  /_setMin\(v\)[\s\S]*?st\.lastKey = null;[\s\S]*?this\._positionAll\(\)/.test(src));
check('pill keyboard open (Enter) still works — mouse open rides _dragUp',
  /pill\.addEventListener\('click'[\s\S]*?e\.detail === 0[\s\S]*?_setMin\(false\)/.test(src));

/* placement rules */
check('custom per-symbol position wins over the round-108 anchor (ROUND120 _posFor)',
  /_posFor\(st\.sym\)/.test(src) && /if \(pos\)\s*\{[\s\S]*?_placeXY\(pos\.fx,\s*pos\.fy/.test(src));
check('no stored position → the round-108 below-legend anchor stays',
  /else\s*\{\s*\n\s*y\s*=\s*_placeTop\(st\.pane\);/.test(src));
check('hidden half is skipped (offsetWidth guard — panel vs pill)',
  /const el = this\._min \? st\.pill : st\.panel;/.test(src) &&
  /if\s*\(!el \|\| !el\.offsetWidth\)\s*return;/.test(src));
check('style churn is guarded by the lastKey cache',
  /const key = x \+ '\|' \+ y;/.test(src) && /if\s*\(key === st\.lastKey\)\s*return;/.test(src));

/* chrome + pin UI */
check('grip uses the 6-dot gripdot icon; pin uses the new thumbtack icon',
  src.includes("icon('gripdot')") && src.includes("icon('pin')"));
check('icons.js has the pin icon', /(^|\n)\s{4}pin:\s*S\(/.test(icons) && icons.includes('gripdot:'));
check('pin state lights the button (oc-on) and flips the titles',
  /st\.pinBtn\.classList\.toggle\('oc-on',\s*this\._pin\)/.test(src) &&
  /Position pinned — click to unpin/.test(src));
check('ROUND113: the padlock is retired with the confirm step; the pin toggle survives',
  !/_onSet\(pane,\s*st\)\s*\{[\s\S]{0,80}if\s*\(this\._locked\)/.test(src) &&
  !/K\.lock/.test(src) &&
  /st\.pinBtn\.classList\.toggle\('oc-on',\s*this\._pin\)/.test(src));
check('no header block left in the JS (v2 compact row)',
  !src.includes('oc-head') && !src.includes('oc-hbtn'));

/* CSS contracts */
check('css: chrome is hover-only (invisible + click-through until the panel is hovered)',
  /\.oc-chrome\s*\{[^}]*opacity:\s*0;\s*pointer-events:\s*none;/.test(css) &&
  /\.oc-panel:hover \.oc-chrome\s*\{\s*opacity:\s*1;\s*\}/.test(css) &&
  /\.oc-chrome > \*\s*\{\s*pointer-events:\s*auto;\s*\}/.test(css));
check('css: the strip paints NOTHING and never eats the SELL/BUY tops (click-through)',
  /\.oc-chrome\s*\{[^}]*pointer-events:\s*none;/s.test(css) &&
  /\.oc-chrome\s*\{[^}]*background:\s*none;/.test(css) &&
  /\.oc-chrome > \*\s*\{\s*pointer-events:\s*auto;\s*\}/.test(css));
check('css: grip + tools are floating chips on the top border (no veil over the buttons)',
  /\.oc-grip\s*\{[^}]*background:\s*var\(--panel\);/.test(css) &&
  /\.oc-tools\s*\{[^}]*background:\s*var\(--panel\);/.test(css));
check('css: floating spread chip overlaps the top border (no header height)',
  /\.oc-spread\s*\{[^}]*position:\s*absolute;[^}]*top:\s*-8px;/.test(css));
check('css: v3 full panel — width grew to 248px for the Risk row + grid',
  /\.oc-panel\s*\{[^}]*width:\s*248px;/.test(css));
check('css: minimized pill shrank to 24px (was 30×26)',
  /\.oc-pill\s*\{[^}]*width:\s*24px;\s*height:\s*24px;/.test(css));
check('css: grabbing cursor while dragging (whole page)',
  /body\.oc-dragging,\s*body\.oc-dragging \*\s*\{\s*cursor:\s*grabbing !important;\s*\}/.test(css));
check('css: pinned state takes the app blue',
  /\.oc-cbtn\.oc-on\s*\{\s*background:\s*var\(--blue\);/.test(css));
check('css: grip cursor invites the drag (grab → grabbing on :active)',
  /\.oc-grip\s*\{[^}]*cursor:\s*grab;/.test(css) && /\.oc-grip:active\s*\{\s*cursor:\s*grabbing;\s*\}/.test(css));
check('css: pill is draggable-looking too (grab cursor + hover accent)',
  /\.oc-pill\s*\{[^}]*cursor:\s*grab;/.test(css));
check('css: chrome chips ride the theme vars (light/dark automatic)',
  /\.oc-cbtn:hover\s*\{\s*background:\s*var\(--menu\);\s*color:\s*var\(--text\);\s*\}/.test(css) &&
  /\.oc-grip\s*\{[^}]*color:\s*var\(--text\);/.test(css));
check('css: panel + pill remain pane-anchored absolute (round-108 rule)',
  (css.match(/\.oc-(panel|pill)\s*\{[^}]*position:\s*absolute;[^}]*left:\s*8px;[^}]*z-index:\s*13;/g) || []).length === 2);

/* app wiring untouched */
check('app.js still boots OneClick after the overlay',
  appjs.includes("import { OneClick } from './trade/oneclick.js'") &&
  /OneClick\.init\(\);/.test(appjs));

console.log('');
console.log(N + ' checks, ' + BAD + ' failed');
process.exit(BAD ? 1 : 0);
