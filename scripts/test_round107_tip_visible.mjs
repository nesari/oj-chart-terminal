#!/usr/bin/env node
/* ROUND107 — "the SL/TP hover tag NEVER shows" — the final root cause.
 *
 * History: rounds 100→106 chased timing (dwell/TTL) and data (spec cache).
 * The round-107 repro (headless chromium + demo broker, mouse parked ON the
 * SL line) proved every link fires: _onDocMove → _onHover → _showTip, tag
 * HTML built WITH the money row — yet the tag's bounding rect was 0x0.
 *
 * ROOT CAUSE: _showTip showed the box with `style.display = ''`, which only
 * CLEARS the inline override — while the CSS classes `.trade-hover-tip` and
 * `.th-hist-tip` themselves default to `display: none`. Computed display
 * stayed `none` forever → the tag was "shown" into a hidden element, every
 * round since the tooltips existed. The DRAG chip always worked because
 * `.trade-drag-chip` has no display:none in CSS (its '' toggle is legal).
 *
 * THE FIX: show = explicit 'block' (inline beats the class), hide = 'none'.
 *
 * This suite pins BOTH sides of that contract so the trap can never return:
 *   A. visibility truth-table mirror (CSS default × inline value)
 *   B. source contract: overlay.js / history.js show with 'block', never ''
 *   C. the drag-chip invariant that explains why drag always worked
 *   D. show/hide/slide state machine (tip reopens after hide, slide keeps it)
 *
 * Run: node scripts/test_round107_tip_visible.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OVERLAY = readFileSync(join(ROOT, 'src/renderer/js/trade/overlay.js'), 'utf8');
const HISTORY = readFileSync(join(ROOT, 'src/renderer/js/trade/history.js'), 'utf8');
const CSS = readFileSync(join(ROOT, 'src/renderer/css/trade.css'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : ' — ' + (extra ?? '')));
  cond ? pass++ : fail++;
};

/* ---------- A. visibility truth-table mirror ----------
   Model of the REAL cascade: computed display = inline !== '' ? inline : cssDefault */
const computed = (inline, cssDefault) => (inline !== '' ? inline : cssDefault);
const CSS_TIP = 'none';   /* .trade-hover-tip { display:none } — round 100 */
const CSS_HIST = 'none';  /* .th-hist-tip    { display:none } — round 100 */
const CSS_CHIP = 'block'; /* .trade-drag-chip has NO display rule → div default */

ok('A1 old bug reproduced: inline \'\' + css none => computed none (tag invisible)',
  computed('', CSS_TIP) === 'none');
ok('A2 the fix: inline \'block\' + css none => computed block (tag visible)',
  computed('block', CSS_TIP) === 'block');
ok('A3 hide keeps working: inline \'none\' + css none => computed none',
  computed('none', CSS_TIP) === 'none');
ok('A4 history box: same trap, same fix (\'\' => none / \'block\' => visible)',
  computed('', CSS_HIST) === 'none' && computed('block', CSS_HIST) === 'block');
ok('A5 drag chip never had the trap: \'\' was legal because its css default is block',
  computed('', CSS_CHIP) === 'block');

/* ---------- B. source contract (the real files) ---------- */
const overlayShow = OVERLAY.match(/_showTip\(pane, st, l, y, cx, cy\) \{[\s\S]*?\n  \},/);
ok('B1 overlay.js _showTip exists', !!overlayShow);
ok('B2 overlay.js shows the tag with an explicit winning value (\'block\')',
  /tip\.style\.display = html \? 'block' : 'none';/.test(OVERLAY),
  'expected: tip.style.display = html ? \'block\' : \'none\'');
ok('B3 overlay.js never shows with \'\' (the round100→106 invisible-tag bug)',
  !/tip\.style\.display = html \? '' : 'none'/.test(OVERLAY) &&
  !/tip\.style\.display = '';/.test(OVERLAY));
ok('B4 overlay.js hide paths use \'none\'',
  /tip\.style\.display = 'none'/.test(OVERLAY));
ok('B5 history.js shows the closed-trade box with \'block\'',
  /tip\.style\.display = 'block';/.test(HISTORY));
ok('B6 history.js never shows with \'\'',
  !/tip\.style\.display = '';/.test(HISTORY));
ok('B7 trade.css still defaults the hover tag to hidden (the trap is documented, not removed)',
  /\.trade-hover-tip\s*\{[^}]*display:\s*none/.test(CSS));
ok('B8 trade.css still defaults the history box to hidden',
  /\.th-hist-tip\s*\{[^}]*display:\s*none/.test(CSS));
ok('B9 trade.css leaves .trade-drag-chip WITHOUT display:none (its \'\' toggle relies on it)',
  !/\.trade-drag-chip\s*\{[^}]*display:\s*none/.test(CSS));

/* ---------- C. drag-chip invariant (why drag ALWAYS worked) ---------- */
ok('C1 overlay.js drag chip toggles \'\' — legal only while B9 holds',
  /d\.chip\.style\.display = y != null && isFinite\(y\) \? '' : 'none'/.test(OVERLAY));

/* ---------- D. show/hide/slide state machine mirror ----------
   Mirrors _onHover + _showTip + _hideTip with the REAL CSS default (none). */
function makeTip() { return { inline: 'none', html: '', className: '' }; }
function show(tip, html, kind) {           /* _showTip (fixed) */
  tip.html = html; tip.className = 'trade-hover-tip tht-' + kind;
  tip.inline = html ? 'block' : 'none';
}
function hide(tip) { tip.inline = 'none'; } /* _hideTip */
function visible(tip) { return computed(tip.inline, CSS_TIP) !== 'none'; }

const tip = makeTip();
show(tip, '<div>SL 1.08381 · EURUSD</div><div class="tht-money neg">-$6.00</div>', 'sl');
ok('D1 first touch of the line => tag visible with the money row',
  visible(tip) && tip.html.includes('-$6.00') && tip.className === 'trade-hover-tip tht-sl');
hide(tip);
ok('D2 leaving the line => tag hidden', !visible(tip));
show(tip, '<div>TP 1.08521 · EURUSD</div><div class="tht-money pos">+$8.00</div>', 'tp');
ok('D3 re-hover (other line) => tag visible again (no dead-state after hide)',
  visible(tip) && tip.html.includes('+$8.00'));
show(tip, '<div>SL 1.08300 · EURUSD</div>', 'sl');
ok('D4 slide along the line => stays visible with fresh content',
  visible(tip) && tip.html.includes('1.08300'));
show(tip, '', 'sl'); /* _tipHtml returned '' (e.g. position vanished) */
ok('D5 empty html => tag hidden, never an empty floating box', !visible(tip));

/* ---------- E. the money/points content contract stays pinned (round105/106) ---------- */
ok('E1 _tipHtml still builds the money row via _lineMoney',
  /_lineMoney\(l\)/.test(OVERLAY));
ok('E2 _tipHtml still names the SYMBOL in SL/TP tags',
  /l\.kind\.toUpperCase\(\) \+ ' ' \+ Number\(l\.price\)\.toFixed\(dg\) \+ ' · ' \+ sym/.test(OVERLAY));
ok('E3 the instant-show contract (no dwell) is still in place — no TIP_DELAY/TIP_TTL declared',
  !/\bconst\s+TIP_DELAY/.test(OVERLAY) && !/\bconst\s+TIP_TTL/.test(OVERLAY) &&
  !/setTimeout\([^)]*dwell/i.test(OVERLAY));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
