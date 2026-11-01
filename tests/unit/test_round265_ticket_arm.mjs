/**
 * ROUND265 - the ticket's arm-then-confirm really pins the order.
 *
 * With one-click OFF, the first click arms the button ("CONFIRM BUY") and
 * the second click sends. Two defects confirmed by reading trade/ticket.js:
 *
 *  1. the second-click guard compared ONLY the side (`_armedSide === side`),
 *     so changing the symbol / type / volume / price / SL / TP during the
 *     5 s window and clicking the same side SENT THE NEW ORDER with no
 *     confirmation whatsoever — a different instrument could be traded by a
 *     click meant to confirm the old one;
 *  2. the comment promised "Esc or any other click disarms", but only the
 *     Escape key was wired: editing a field (or clicking anywhere) left a
 *     live arm behind, so a later click on that side went straight through.
 *
 * Pins:
 *  - `_arm` records an order signature and the outside-click canceller;
 *  - `_place` only sends when the current signature still equals the armed
 *    one, otherwise it re-arms;
 *  - `_disarm` clears the signature AND removes the mousedown listener;
 *  - one-click mode bypasses the arm entirely (unchanged).
 *
 * The module needs DOM globals, so this suite pins the source contracts like
 * the other UI suites.
 *
 * Run: node tests/unit/test_round265_ticket_arm.mjs
 */
import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' - ' + JSON.stringify(extra) : '')); }
};

const src = readSource('src/renderer/js/trade/ticket.js');
const iPlace = src.indexOf('_place(side) {');
const iSig = src.indexOf('_sigFor(side) {');
const iArm = src.indexOf('_arm(side, desc) {');
const iDisarm = src.indexOf('_disarm() {');
const iNext = src.indexOf('\n  ', src.indexOf('\n  }', iDisarm));
ok(iPlace > 0 && iSig > iPlace && iArm > iSig && iDisarm > iArm,
  'located _place()/_sigFor()/_arm()/_disarm()', { iPlace, iSig, iArm, iDisarm });

const place = iPlace > 0 ? src.slice(iPlace, iSig) : '';
const sig = iSig > 0 ? src.slice(iSig, iArm) : '';
const arm = iArm > 0 && iDisarm > iArm ? src.slice(iArm, iDisarm) : '';
const disarm = iDisarm > 0 ? src.slice(iDisarm, iDisarm + 1200) : '';

console.log('\n[1] one-click still bypasses the arm');
{
  ok(/if \(e\.oneClick\.checked\) \{ send\(\); return; \}/.test(place),
    'one-click sends immediately (no confirm step)');
}

console.log('\n[2] the signature covers every order field');
{
  for (const field of ['this.currentSymbol()', 'e.type.value', 'e.volume.value',
    'e.price.value', 'e.slVal.value', 'e.tpVal.value', 'e.slOn.checked',
    'e.tpOn.checked', 'e.expiry.value', 'e.comment.value']) {
    ok(sig.includes(field), 'signature includes ' + field);
  }
  ok(/return \[[\s\S]*\]\.join\(/.test(sig), 'the signature is a joined field list');
}

console.log('\n[3] the second click re-checks the signature');
{
  ok(/if \(this\._armedSide === side\) \{/.test(place), 'armed side is compared');
  const guarded = place.slice(place.indexOf('if (this._armedSide === side)'));
  ok(/if \(this\._armSig != null && this\._armSig === this\._sigFor\(side\)\) \{/.test(guarded),
    'it only sends when the signature still matches');
  ok(/this\._disarm\(\); send\(\); return;/.test(guarded), 'a match sends');
  ok(/this\._disarm\(\); this\._arm\(side, desc\); return;/.test(guarded),
    'a changed order re-arms instead of sending');
}

console.log('\n[4] arming/disarming owns the listeners');
{
  ok(/this\._armSig = this\._sigFor\(side\);/.test(arm), 'arming captures the signature');
  ok(/document\.addEventListener\('mousedown', this\._armClick, true\)/.test(arm),
    'arming adds the outside-click canceller');
  ok(/if \(own && own\.contains\(ev\.target\)\) return;/.test(arm),
    'the armed button itself is ignored (the confirm click still counts)');
  ok(/this\._disarm\(\);[\s\S]{0,40}this\._status\(''\);/.test(arm),
    'an outside click disarms and clears the status');
  ok(/if \(this\._armClick\) \{ document\.removeEventListener\('mousedown', this\._armClick, true\); this\._armClick = null; \}/.test(disarm),
    'disarming removes the canceller');
  ok(/this\._armSig = null;/.test(disarm), 'disarming clears the signature');
  ok(/document\.removeEventListener\('keydown', this\._armKey, true\)/.test(disarm),
    'Escape handling is still removed');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
