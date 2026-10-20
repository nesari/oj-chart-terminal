#!/usr/bin/env node
/**
 * ROUND108 tests — One-Click Trading panel on the chart (MT5 parity).
 *
 * Two layers, the repo's established style:
 *  A) MIRRORS of the module's pure helpers (volume list, lot formatting,
 *     price digits, placement math, state booleans, deviation) — the exact
 *     rules the panel runs by, executed for real.
 *  B) SOURCE CONTRACTS against the real files — the wiring and the safety
 *     rules that must never regress (order payload, confirm-lock state
 *     machine, guards, .oc-hidden visibility rule [the round-107 lesson],
 *     theme-var colours, per-pane following of the symbol, app bootstrap).
 *
 * Exit 0 only when every check passes.
 */
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(ROOT + p, 'utf8');
let N = 0, BAD = 0;
function check(name, cond, extra) {
  N++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + ((!cond && extra !== undefined) ? ' — ' + extra : ''));
  if (!cond) BAD++;
}
const eq = (a, b) => a === b;

/* ---------------- mirrors (exact copies of the module rules) ---------------- */
const K = { min: 'mt5_oct_min', lock: 'mt5_oct_lock', vol: 'mt5_oct_vol', dev: 'mt5_tr_dev' };
const VOL_PRESETS = [0.01, 0.02, 0.03, 0.05, 0.10, 0.20, 0.30, 0.50, 1, 2, 3, 5, 10];
const ARM_MS = 3000;

function _bool(v, def) {
  if (v === true || v === 'true' || v === '1') return true;
  if (v === false || v === 'false' || v === '0') return false;
  return !!def;
}
/* storage-backed _volList with an injectable remembered lot */
function _volList(stored) {
  const cur = parseFloat(stored == null ? 0.01 : stored);
  const arr = VOL_PRESETS.slice();
  if (isFinite(cur) && cur > 0 && arr.indexOf(cur) < 0) { arr.push(cur); arr.sort((a, b) => a - b); }
  return arr;
}
function _volTxt(v, s) {
  const dp = (s && s.vol_step > 0 && s.vol_step < 0.01) ? 3 : 2;
  return Number(v).toFixed(dp);
}
function _fmtPx(specDigits, paneDigits, px) {
  if (!(px > 0)) return '—';
  const dg = (specDigits != null) ? specDigits : (paneDigits || 5);
  return px.toFixed(dg);
}
function _placeTop(legendH, rootH) {
  const lh = legendH || 60;
  const rh = rootH || 400;
  return Math.max(4, Math.round(Math.min(lh + 10, Math.max(40, rh - 130))));
}
function _deviation(stored) { return parseInt(stored == null ? '20' : stored, 10) || 20; }
/* clampVolume mirror (trade/state.js) for the vol-select clamp assertions */
function mround(v, step) {
  if (!(step > 0)) step = 0.01;
  return Math.round(Math.round(v / step) * step * 1e8) / 1e8;
}
function clampVolume(s, v) {
  if (!s) return v;
  if (v < (s.vol_min || 0.01)) v = s.vol_min || 0.01;
  if (v > (s.vol_max || 100)) v = s.vol_max || 100;
  return mround(v, s.vol_step || 0.01);
}

console.log('A) mirrors — the rules the panel runs by');

/* booleans from storage (JSON or raw string forms) */
check('bool: true/\'true\'/\'1\' → true', _bool(true) && _bool('true') && _bool('1'));
check('bool: false/\'false\'/\'0\' → false', !_bool(false) && !_bool('false') && !_bool('0'));
check('bool: undefined falls back to the default', _bool(undefined, true) === true && _bool(undefined, false) === false);

/* volume list */
const base = _volList(null);
check('vol list: factory presets 0.01 → 10 in order',
  eq(base[0], 0.01) && eq(base[base.length - 1], 10) && base.length === VOL_PRESETS.length);
check('vol list: remembered lot 0.07 is inserted sorted (no dupes)',
  JSON.stringify(_volList(0.07)) === JSON.stringify([0.01, 0.02, 0.03, 0.05, 0.07, 0.10, 0.20, 0.30, 0.5, 1, 2, 3, 5, 10]));
check('vol list: preset value never duplicated', _volList(0.1).filter((v) => v === 0.1).length === 1);
check('vol list: garbage remembered value ignored', _volList('abc').length === VOL_PRESETS.length);

/* lot text follows the spec step */
check('lot text: 0.01-step spec → 2 decimals', eq(_volTxt(0.01, { vol_step: 0.01 }), '0.01'));
check('lot text: micro-lot broker (0.001 step) → 3 decimals', eq(_volTxt(0.01, { vol_step: 0.001 }), '0.010'));
check('lot text: whole lot shows 1.00 like MT5', eq(_volTxt(1, { vol_step: 0.01 }), '1.00'));

/* price formatting — spec digits win, pane digits are the fallback */
check('px format: no spec yet → pane digits (EURUSD 5)', eq(_fmtPx(null, 5, 1.08281), '1.08281'));
check('px format: spec digits 2 (XAUUSD) → 4350.01', eq(_fmtPx(2, 5, 4350.009), '4350.01'));
check('px format: 3-digit JPY spec → 154.198', eq(_fmtPx(3, 5, 154.1984), '154.198'));
check('px format: no live quote → —', eq(_fmtPx(5, 5, 0), '—') && eq(_fmtPx(5, 5, -1), '—'));

/* placement: below the real legend, clamped inside small panes */
check('placement: normal pane → legend(60) + 10', eq(_placeTop(60, 900), 70));
check('placement: grown legend (compare chips) pushes the panel down', eq(_placeTop(90, 900), 100));
check('placement: small pane (2×4 grid) clamps to fit', eq(_placeTop(60, 200), 70));
check('placement: very small pane floors at 40 so the panel stays on-chart', eq(_placeTop(60, 120), 40));
check('placement: unmeasured legend defaults to 60', eq(_placeTop(0, 900), 70));

/* deviation shared with the ticket */
check('deviation: default 20', eq(_deviation(null), 20));
check('deviation: ticket setting 50 is honored', eq(_deviation('50'), 50));
check('deviation: garbage falls back to 20', eq(_deviation('abc'), 20));

/* the select value is clamped by the spec like the ticket does */
check('vol clamp: 50 lots on a 100-max spec stays 50',
  Math.abs(clampVolume({ vol_min: 0.01, vol_max: 100, vol_step: 0.01 }, 50) - 50) < 1e-9);
check('vol clamp: below vol_min lifts to the minimum',
  Math.abs(clampVolume({ vol_min: 0.1, vol_max: 100, vol_step: 0.01 }, 0.01) - 0.1) < 1e-9);
check('vol clamp: above vol_max caps at the maximum',
  Math.abs(clampVolume({ vol_min: 0.01, vol_max: 5, vol_step: 0.01 }, 10) - 5) < 1e-9);
check('vol clamp: 0.07 on a 0.02-step spec rounds to the step grid',
  Math.abs(clampVolume({ vol_min: 0.01, vol_max: 100, vol_step: 0.02 }, 0.07) - 0.08) < 1e-9);

/* confirm-lock state machine (the round-102 arm-then-confirm, chart flavor) */
function decide(locked, armed, side) {
  if (locked) {
    if (armed === side) return 'send';
    return 'arm';
  }
  return 'send';
}
check('lock state: locked + fresh click → ARM only (nothing sent)', eq(decide(true, null, 0), 'arm'));
check('lock state: locked + same side armed → SEND', eq(decide(true, 0, 0), 'send'));
check('lock state: locked + OTHER side armed → re-arm the new side', eq(decide(true, 1, 0), 'arm'));
check('lock state: unlocked → true one-click (send on the first click)', eq(decide(false, null, 1), 'send'));
check('confirm window is 3s (MT5-long enough, chart-short)', eq(ARM_MS, 3000));

console.log('B) source contracts — the real files');

let src = read('src/renderer/js/trade/oneclick.js');
const routejs = read('src/renderer/js/trade/route.js');   /* ROUND112: the Demo/Live router */
const appjs = read('src/renderer/js/app.js');
const icons = read('src/renderer/js/ui/icons.js');
const css = read('src/renderer/css/trade.css');

/* wiring */
check('module imports the trading bridge (Trade, OT, OT_NAME) from trade/state.js',
  /import\s*\{\s*Trade,\s*OT,\s*OT_NAME\s*\}\s*from\s*'\.\/state\.js'/.test(src));
check('module drives panes from the shared App state', /import\s*\{\s*App\s*\}\s*from\s*'\.\.\/\.\.\/\.\.\/core\/state\.js'/.test(src));
check('app.js imports OneClick and calls OneClick.init() right after TradeOverlay.init()',
  /import\s*\{\s*OneClick\s*\}\s*from\s*'\.\/trade\/oneclick\.js'/.test(appjs) &&
  /TradeOverlay\.init\(\);\s*\n\s*OneClick\.init\(\);/.test(appjs));
check('window.__app exposes OneClick (the sanctioned debug facade)', /TradeOverlay,\s*OneClick,/.test(appjs));
check('icons.js gained the bolt glyph (minimized pill)', /bolt:\s*F\(/.test(icons));

/* order payload — ROUND111: the market order carries the DRAFT's SL/TP
   (the three dashed lines the user placed), not a naked market entry */
check('market order: orderType is OT.BUY/OT.SELL by the draft side',
  /orderType = d\.side === 0 \? OT\.BUY : OT\.SELL;/.test(src));
check('market order: price/SL/TP from the draft lines ride the payload (stoplimit/typeTime/expiration pass through — ROUND120 unified ticket)',
  /symbol:\s*sym,\s*orderType,\s*volume:\s*r\.vol,\s*price,\s*sl,\s*tp,/.test(src) &&
  /stoplimit:\s*p\.stoplimit \|\| 0,\s*sl:\s*p\.sl \|\| 0,\s*tp:\s*p\.tp \|\| 0,/.test(routejs));
check('pending order: the entry price rides the order (limit/stop kinds)',
  /price = Number\(d\.entry\.toFixed\(dg\)\);/.test(src) &&
  /_pendType\(d\.side,\s*d\.entry,\s*q\.bid,\s*q\.ask,\s*spec\.stops_level,\s*spec\.point\)/.test(src));
check('market order: deviation comes from the ticket setting (mt5_tr_dev)', /mt5_tr_dev/.test(src));
check('market order: no comment (MT5 one-click parity)', /comment:\s*''/.test(src));
check('success = MT5 retcodes 10009/10008/10010 (same rule as the ticket, in the router)',
  /const RC_OK = \[10008, 10009, 10010\];/.test(routejs) &&
  /!RC_OK\.includes\(data\.retcode\)/.test(routejs));
check('the volume/risk resolves through the ROUND111 resolver (spec-aware)',
  /_resolveVol\(spec,\s*this\._rmode,\s*this\._riskCur\(\)/.test(src));
check('a pending risk draft is flushed before the send reads it (round-110 rule, renamed)',
  /_riskCommit\(st\);\s*\/\/ flush a pending risk draft/.test(src));
check('spread chip reads Trade.spreadPts', /Trade\.spreadPts\(st\.sym\)/.test(src));

/* guards — nothing is sent blind */
check('guard: bridge offline blocks the send with a toast (router canTrade)',
  /if\s*\(!Trade\.online\)\s*\{[^}]*Trading bridge is offline[^}]*\}/.test(routejs) &&
  /TradeRoute\.canTrade\(\)/.test(src));
check('guard: AutoTrading OFF in MetaTrader blocks the send (router canTrade)',
  /trade_allowed\s*===\s*false/.test(routejs));
check('guard: no live bid/ask blocks the send', /!\(q\.bid > 0\)\s*\|\|\s*!\(q\.ask > 0\)/.test(src));
check('guard: invalid volume blocks the send', /Invalid volume/.test(src));
check('no window.confirm CALL anywhere (round 102: nothing modal blocks the chart)',
  !/window\.confirm\s*\(/.test(src));

/* confirm-lock machine in the real source — ROUND113: the confirm step is
   GONE by user request; the first Set click sends the draft as-is */
const onSet = (src.match(/_onSet\(pane, st\) \{[\s\S]*?\n  \},/) || [''])[0];
check('ROUND113: Set sends AT ONCE — one click, no arm step (user request)',
  /_onSet\(pane, st\)\s*\{\s*if \(!st\.draft\) return;\s*\n\s*this\._sendDraft\(pane, st\);/.test(src));
check('ROUND113: the confirm machine is fully retired',
  !/_armSet/.test(src) && !/_disarmSet/.test(src) && !/ARM_MS/.test(src) &&
  !/CONFIRM SET<\/span>/.test(src) && !/mt5_oct_lock/.test(src));
check('Esc still cancels every draft, typing-safe (the disarm half is retired)',
  /key === 'Escape'\)\s*\{[\s\S]{0,160}this\._draftCancelAll\(\);/.test(src) &&
  /U\.isTyping\(e\.target\)\) return;/.test(src));
check('a rejected order KEEPS the draft (adjust + Set again)',
  /Order failed: ' \+ \(\(err && err\.message\) \|\| ''\), ''\);[\s\S]{0,80}the draft survives/.test(src));

/* the round-107 lesson — visibility NEVER via inline display:'' */
check('visibility: toggles use the .oc-hidden class only',
  /classList\.toggle\('oc-hidden'/.test(src) && /classList\.(add|remove)\('oc-hidden'/.test(src));
check('visibility: NO inline display:\'\' anywhere in the module (the round-107 trap)',
  !/style\.display\s*=\s*'/.test(src));
check('css: .oc-hidden is display:none !important (inline can never fight it)',
  /\.oc-hidden\s*\{\s*display:\s*none\s*!important;/.test(css));

/* placement + per-pane following */
check('placement is MEASURED from the real legend height (compare chips grow it)',
  /legend\.offsetHeight/.test(src));
check('placement is clamped inside small panes (floor 40 / height-130 cap)',
  /Math\.max\(40,\s*rh - 130\)/.test(src));
check('panel follows the pane symbol: draft cancelled + positions rebuilt on change',
  /if\s*\(st\.sym !== pane\.symbol\)\s*\{[^}]*_draftCancel\(st\);[^}]*posSig = '';/s.test(src));
check('market-closed gates the buttons via the legend\'s own chip',
  /lgMkt/.test(src) && /contains\('closed'\)/.test(src));
check('one panel per pane, WeakMap-keyed — manager.js untouched', /new WeakMap\(\)/.test(src));
check('spec prefetch RETRIES (2s cadence) until it lands — the panel boots before the WS connects',
  /if\s*\(!Trade\.specSync\(st\.sym\)\)/.test(src) && /specTryAt > 2000/.test(src));
check('mousedown is stopped from reaching the chart engine underneath',
  /panel\.addEventListener\('mousedown',\s*\(e\)\s*=>\s*(?:\{\s*)?e\.stopPropagation\(\)/.test(src));

/* persistence keys */
check('minimize state persists (mt5_oct_min)', new RegExp(K.min).test(src));
check('panel volume remembers itself (mt5_oct_vol) without touching the ticket volume', new RegExp(K.vol).test(src));

/* theme-proof styling */
check('css: SELL is var(--red) and BUY is var(--green) — the app\'s own trade colors (v2: base colour + sheen overlay)',
  /\.oc-side\s*\{[^}]*background-color:\s*var\(--red\);/.test(css) &&
  /\.oc-side\.oc-buy\s*\{[^}]*background-color:\s*var\(--green\);/.test(css) &&
  /\.oc-side\s*\{[^}]*background-image:\s*linear-gradient/.test(css));
check('css: armed side takes the app blue (distinct from both sides)',
  /\.oc-side\.oc-armed\s*\{\s*background:\s*var\(--blue\);/.test(css));
check('css: panel + pill are pane-anchored (absolute, left 8, z 13)',
  (css.match(/\.oc-(panel|pill)\s*\{[^}]*position:\s*absolute;[^}]*left:\s*8px;[^}]*z-index:\s*13;/g) || []).length === 2);
check('css: v2 compact row — no header block left behind (oc-head/oc-hbtn gone)',
  !/\.oc-head/.test(css) && !/\.oc-hbtn/.test(src));
check('css: light theme gets its own softer shadows',
  /body\.theme-light \.oc-panel/.test(css) && /body\.theme-light \.oc-pill/.test(css));
check('css: risk field + mode buttons follow the theme vars (no hardcoded surfaces)',
  /\.oc-rin\s*\{[^}]*color:\s*var\(--text\);/s.test(css) &&
  /\.oc-modeb\.oc-on\s*\{\s*border-color:\s*var\(--blue\);/.test(css));
check('css: the native select is gone (editable field + custom menu instead)',
  !/\.oc-vol option/.test(css) && !/<select/.test(src));

console.log('');
console.log(N + ' checks, ' + BAD + ' failed');
process.exit(BAD ? 1 : 0);
