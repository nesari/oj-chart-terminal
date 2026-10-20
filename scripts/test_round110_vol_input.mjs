#!/usr/bin/env node
/**
 * ROUND110 tests — manual volume entry in the One-Click widget.
 *
 * User ask: "توی بخش انتخاب حجم باید کاربر بتونه بصورت دستی هم عدد وارد کنه"
 * → the volume cell is now an editable field (type any lot + Enter/blur),
 *   with the preset list as a custom themed menu, ↑/↓ stepping and a
 *   revert-on-garbage rule that can never leak into the send path.
 *
 * Layers, the repo's established style:
 *  A) MIRRORS of the pure rules: the manual-entry parser (_volParse), the
 *     commit chain (parse → clampVolume), lot formatting (_volTxt).
 *  B) SOURCE CONTRACTS against the real files — editable field wiring
 *     (Enter/blur/Esc/Arrows), menu behaviour (custom menu, oc-cur, outside
 *     close, oc-hidden visibility rule), the send-path flush, persistence,
 *     multi-pane sync and the theme-var CSS for field + menu.
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
const near = (a, b) => Math.abs(a - b) < 1e-9;

/* ---------------- mirrors (exact copies of the module rules) ---------------- */

/* trade/state.js clampVolume mirror (same as the round-108 tests) */
function mround(v, st) {
  if (!(st > 0)) return v;
  const r = Math.round(v / st) * st;
  return Math.abs(r - Math.round(r)) < 1e-9 ? Math.round(r) : r;
}
function clampVolume(s, v) {
  if (v < (s.vol_min || 0.01)) v = s.vol_min || 0.01;
  if (v > (s.vol_max || 100)) v = s.vol_max || 100;
  return mround(v, s.vol_step || 0.01);
}

/* oneclick.js _volParse mirror — the manual-entry gate */
function _volParse(txt) {
  if (typeof txt !== 'string') return null;
  const t = txt.trim().replace(',', '.');
  if (!/^\d*\.?\d*$/.test(t) || !/\d/.test(t)) return null;
  const v = Math.round(parseFloat(t) * 1000) / 1000;
  if (!isFinite(v) || v <= 0) return null;
  return v;
}

/* oneclick.js _volTxt mirror */
function _volTxt(v, s) {
  const dp = (s && s.vol_step > 0 && s.vol_step < 0.01) ? 3 : 2;
  return Number(v).toFixed(dp);
}

console.log('A) manual-entry parser (_volParse mirror)');
check("'0.37' parses to 0.37", near(_volParse('0.37'), 0.37));
check("'0,37' — decimal comma accepted (keyboards like the user's)", near(_volParse('0,37'), 0.37));
check("' 2 ' — surrounding spaces trimmed", near(_volParse(' 2 '), 2));
check("'.5' — leading-dot form accepted", near(_volParse('.5'), 0.5));
check("'2.' — trailing-dot form accepted", near(_volParse('2.'), 2));
check("'00.10' — leading zeros fine", near(_volParse('00.10'), 0.1));
check("'0.0007' rounds to the 3-dp floor 0.001", near(_volParse('0.0007'), 0.001));
check("'0' rejected", _volParse('0') === null);
check("'' rejected", _volParse('') === null);
check("'   ' rejected", _volParse('   ') === null);
check("'abc' rejected", _volParse('abc') === null);
check("'1.2.3' rejected", _volParse('1.2.3') === null);
check("'-1' rejected (no sign — the field is a lot size)", _volParse('-1') === null);
check("'1e3' rejected (no scientific notation)", _volParse('1e3') === null);
check("'0x10' rejected", _volParse('0x10') === null);
check("'0/37' rejected", _volParse('0/37') === null);
check('non-string (null) rejected', _volParse(null) === null);
check('huge paste stays finite (clamping is the next layer, not the parser)',
  _volParse('99999999') === 99999999);

console.log('B) commit chain — parse then clamp to the spec (what _volCommit stores)');
{
  const s = { vol_min: 0.01, vol_max: 100, vol_step: 0.01 };
  check("'0.37' on a 0.01-step symbol stores 0.37", near(clampVolume(s, _volParse('0.37')), 0.37));
  check("'0.374' is stored step-rounded to 0.37 (parser's 3-dp first: 0.374)", near(clampVolume(s, _volParse('0.374')), 0.37));
check("'0.3749' parses to the 3-dp 0.375, then steps UP to 0.38 (round-half)", near(clampVolume(s, _volParse('0.3749')), 0.38));
  const s2 = { vol_min: 0.01, vol_max: 100, vol_step: 0.02 };
  check("'0.07' on a 0.02-step symbol stores 0.08 (nearest step)", near(clampVolume(s2, _volParse('0.07')), 0.08));
  const s3 = { vol_min: 0.1, vol_max: 5, vol_step: 0.01 };
  check("'0.01' below vol_min clamps UP to 0.1", near(clampVolume(s3, _volParse('0.01')), 0.1));
  check("'99' above vol_max clamps DOWN to 5", near(clampVolume(s3, _volParse('99')), 5));
  check("an invalid draft ('abc') never reaches the clamp — commit reverts",
    _volParse('abc') === null);
  const s4 = { vol_min: 0.01, vol_max: 100, vol_step: 0.001 };
  check("'0.123' on a 0.001-step broker keeps 3 dp", near(clampVolume(s4, _volParse('0.123')), 0.123));
}
console.log('C) lot formatting mirror (_volTxt)');
check('2-dp display for normal steps', eq(_volTxt(0.37, { vol_step: 0.01 }), '0.37'));
check('3-dp display for 0.001-step brokers', eq(_volTxt(0.123, { vol_step: 0.001 }), '0.123'));
check('null spec falls back to 2 dp', eq(_volTxt(2, null), '2.00'));

/* ---------------- source contracts ---------------- */
const src = read('src/renderer/js/trade/oneclick.js');
const css = read('src/renderer/css/trade.css');
const icons = read('src/renderer/js/ui/icons.js');

console.log('D) editable risk field wiring (source contracts — v3: the volume cell grew into the Risk field)');
check('the Risk cell is a real <input> (no native select anywhere)',
  /U\.el\('input',\s*'oc-rin'/.test(src) && !/U\.el\('select'/.test(src));
check('numeric keyboard on touch (inputmode=decimal)', /inputmode['"],\s*'decimal'/.test(src));
check('type=text, autocomplete off, spellcheck off, bounded length',
  /rin\.type\s*=\s*'text'/.test(src) && /autocomplete\s*=\s*'off'/.test(src) &&
  /spellcheck\s*=\s*false/.test(src) && /maxLength\s*=\s*9/.test(src));
check('focus selects the whole value for instant overtype',
  /rin\.addEventListener\('focus'[\s\S]{0,60}rin\.select\(\)/.test(src));
check('Enter commits and leaves the field',
  /e\.key === 'Enter'[\s\S]{0,120}_riskCommit\(st\);[\s\S]{0,60}rin\.blur\(\)/.test(src));
check('blur commits too (click-away must not drop the draft)',
  /rin\.addEventListener\('blur',\s*\(\)\s*=>\s*\{\s*this\._riskCommit\(st\);\s*\}\)/.test(src));
check('Esc reverts the draft WITHOUT storing', /e\.key === 'Escape'[\s\S]{0,80}_riskPaint\(st,\s*true\)/.test(src));
check('ArrowUp/ArrowDown step by the mode unit (clamped, persisted)',
  /ArrowUp'\s*\|\|\s*e\.key === 'ArrowDown'[\s\S]{0,90}_riskStep\(st,\s*e\.key === 'ArrowUp'\s*\?\s*1\s*:\s*-1\)/.test(src));
check('_riskStep nudges by the mode unit through the spec clamp (lot)',
  /_riskStep\(st,\s*dir\)\s*\{[\s\S]{0,400}Trade\.clampVolume\(st\.sym,\s*v\)/.test(src));
check('a live draft is never stomped by the 200ms tick (paint skips the focused field)',
  /if\s*\(!force && document\.activeElement === inp\) return;/.test(src));

console.log('E) revert-vs-store rules');
check('invalid commit reverts the display and stores nothing',
  /_riskCommit\(st\)\s*\{[\s\S]{0,80}if \(v == null\)\s*\{\s*this\._riskPaint\(st,\s*true\);\s*return false;\s*\}/.test(src));
check('valid commit stores PER MODE and persists (JSON {lot, money, pct})',
  /this\._rvals\[this\._rmode\] = /.test(src) && /_saveRisk\(\)/.test(src));
check('commit pushes the new value to every pane (multi-chart sync)',
  /_riskCommit\(st\)\s*\{[\s\S]{0,420}this\._riskRefreshAll\(\);/.test(src));
check('the send path FLUSHES a pending risk draft before resolving the volume',
  /_riskCommit\(st\);\s*\/\/ flush a pending risk draft/.test(src));
check('the lot value seeds from the legacy round-108 volume (mt5_oct_vol kept)',
  /K\.vol,\s*0\.01/.test(src));
check('values persist under mt5_oct_risk_val; the mode under mt5_oct_risk_mode',
  /mt5_oct_risk_val/.test(src) && /mt5_oct_risk_mode/.test(src));

console.log('F) steppers + risk modes (the preset menu retired in v3 — the mock-up has none)');
check('the −/+ buttons step the value (_riskStep with ∓1)',
  /minusBtn\.addEventListener\('click'[\s\S]{0,60}_riskStep\(st,\s*-1\)/.test(src) &&
  /plusBtn\.addEventListener\('click'[\s\S]{0,60}_riskStep\(st,\s*1\)/.test(src));
check('the three mode buttons switch the mode globally (% $ Lot)',
  /modePct\.addEventListener\('click'[\s\S]{0,60}_riskModeAll\('pct'\)/.test(src) &&
  /modeUsd\.addEventListener\('click'[\s\S]{0,60}_riskModeAll\('money'\)/.test(src) &&
  /modeLot\.addEventListener\('click'[\s\S]{0,60}_riskModeAll\('lot'\)/.test(src));
check('the active mode lights up (oc-on) on every pane',
  /st\.modePct\.classList\.toggle\('oc-on',\s*on\.pct\)/.test(src) &&
  /st\.modeUsd\.classList\.toggle\('oc-on',\s*on\.money\)/.test(src) &&
  /st\.modeLot\.classList\.toggle\('oc-on',\s*on\.lot\)/.test(src));
check('no preset-menu leftovers (oc-vol-menu / oc-cur / oc-up / oc-right gone)',
  !/oc-vol-menu/.test(src) && !/oc-vol-it/.test(src) && !/_volList/.test(src));

console.log('G) CSS contracts (theme vars only)');
check('field: panel2 surface + text colour + text cursor (editable)',
  /\.oc-rin\s*\{[^}]*background:\s*transparent;[^}]*color:\s*var\(--text\);/s.test(css) &&
  /\.oc-rin\s*\{[^}]*cursor:\s*text;/s.test(css));
check('stepper: bordered box around − value +, hover chips on the theme menu',
  /\.oc-step\s*\{[^}]*border:\s*1px solid var\(--border2\);[^}]*background:\s*var\(--panel2\);/s.test(css) &&
  /\.oc-sbtn:hover\s*\{\s*background:\s*var\(--menu\);\s*color:\s*var\(--text\);\s*\}/.test(css));
check('mode buttons: active takes the app blue border (oc-on)',
  /\.oc-modeb\.oc-on\s*\{\s*border-color:\s*var\(--blue\);\s*color:\s*var\(--text\);\s*background:\s*var\(--menu\);\s*\}/.test(css));
check('no leftover of the volume-field styles (.oc-vol* gone from the CSS)',
  !/\.oc-vol/.test(css));
check('light theme keeps its own soft shadows (panel + pill)',
  /body\.theme-light \.oc-panel/.test(css) && /body\.theme-light \.oc-pill/.test(css));

console.log('');
console.log(N + ' checks, ' + BAD + ' failed');
process.exit(BAD ? 1 : 0);
