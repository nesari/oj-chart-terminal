/**
 * test_replay_guard.mjs — Bar Replay must never get stuck "active" without a
 * session, and an armed pick must not survive a stop.
 *
 * Confirmed defects:
 *  1. start() set S.on = true BEFORE validating the anchor bar; clicking
 *     Replay on an empty/still-loading chart left Replay.isActive() true
 *     forever (live ticks blocked, no driver, no RAF) until the user found
 *     Stop.
 *  2. stop() did not clear an armed pick overlay (programmatic stop while
 *     picking left the replay button/overlay armed after the session ended).
 *
 * Run: node tests/unit/test_replay_guard.mjs
 */

import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const src = readSource('src/renderer/js/panels/replay.js');

/* 1. validation precedes state mutation */
{
  const start = (src.match(/function start\(driver, idx\) \{[\s\S]*?\n  \}/) || [''])[0];
  const anchorAt = start.indexOf('const anchor = driver.bars[idx];');
  const guardAt = start.indexOf('if (!anchor) return;');
  const onAt = start.indexOf('S.on = true;');
  ok(anchorAt >= 0 && guardAt > anchorAt, 'start validates the anchor bar');
  ok(onAt > guardAt, 'S.on is only set after the anchor exists');
  ok(/if \(!anchor\) return; \/\/ empty\/too-short chart/.test(start),
    'the guard documents the empty-chart case');
}

/* 2. the picker refuses an unusable chart without arming itself */
{
  ok(/if \(!target\.bars \|\| target\.bars\.length < 2\) \{[\s\S]{0,120}return;/.test(src),
    'toggle refuses Bar Replay when fewer than two bars are loaded');
}

/* 3. stop clears an armed pick */
{
  ok(/Replay\.stop = function \(\) \{\s*\n\s*if \(pickPane\) Replay\.cancelPick\(\);/.test(src),
    'stop cancels an armed pick before tearing the session down');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
