/**
 * test_round303_instance_ids.mjs — instance ids must never collide.
 *
 * THE BUG (found live by the R303 audit, "not every separate-pane indicator
 * kept its pane"):
 *
 *   Three call sites minted ids as
 *       Date.now() + Math.floor(Math.random() * 999)
 *   so ids only differ by a 0..998 draw inside one millisecond.
 *   Adding the 15 separate-pane built-ins "at once" puts 15 draws in one
 *   millisecond bucket; the measured birthday rate is ~6% per round, and an
 *   8-round live sweep reproduced a lost pane.
 *
 *   A collision is not cosmetic: `pane._subs` and `rtMap` are both keyed by this
 *   id, so the loser either OVERWRITES its sibling's sub-pane (two indicators
 *   share one pane, one plots nowhere) or never runs at all.
 *   Live evidence from the audit trace:
 *     insts : [... '1794918051634', ... '1794918051634', ...]   <- duplicate
 *     subs  : [..., '1794918059182', ...]  with no matching instance (orphan)
 *
 * Run: node tests/unit/test_round303_instance_ids.mjs
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextInstanceId, dropInstanceIds } from '../../src/core/instance-id.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'src');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' - ' + JSON.stringify(extra) : '')); }
};

/* ---------- 1. the new minter cannot collide ---------- */
console.log('\n[1] nextInstanceId()');
{
  /* no owner: a global monotonic counter */
  const ids = [];
  for (let i = 0; i < 5000; i++) ids.push(nextInstanceId());
  ok(new Set(ids).size === ids.length, '5000 ids without an owner are all unique');

  /* the exact failing case: 15 adds inside ONE millisecond */
  const pane = {};
  let dup = 0;
  for (let round = 0; round < 2000; round++) {
    const batch = [];
    for (let i = 0; i < 15; i++) batch.push(nextInstanceId(pane));
    if (new Set(batch).size !== batch.length) dup++;
  }
  ok(dup === 0, '2000 rounds x 15 same-pane ids never collide (was ~6%/round)', dup);

  /* ids stay NUMBERS (persistence + data-* + public API all treat them so) */
  ok(typeof nextInstanceId() === 'number' && Number.isFinite(nextInstanceId()), 'ids stay finite numbers');

  /* two panes may in principle share a value, but each pane's set stays unique */
  const a = {}, b = {};
  const setA = new Set(), setB = new Set();
  for (let i = 0; i < 200; i++) { setA.add(nextInstanceId(a)); setB.add(nextInstanceId(b)); }
  ok(setA.size === 200 && setB.size === 200, 'each pane mints 200 unique ids');

  /* monotonic: a later call never returns a smaller number */
  let prev = nextInstanceId();
  let mono = true;
  for (let i = 0; i < 1000; i++) { const v = nextInstanceId(); if (v <= prev) mono = false; prev = v; }
  ok(mono, 'the counter is strictly increasing (no re-issue of a retired id)');

  /* teardown releases the per-pane guard without breaking minting */
  dropInstanceIds(a);
  ok(typeof nextInstanceId(a) === 'number', 'minting still works after the pane guard is dropped');
}

/* ---------- 2. no call site still uses the old expression ---------- */
console.log('\n[2] every minter goes through the shared counter');
{
  const files = [
    join(SRC, 'renderer', 'js', 'chart', 'indicators-ui.js'),
    join(SRC, 'renderer', 'js', 'chart', 'pine-ui', 'panel.js'),
    join(SRC, 'renderer', 'js', 'chart', 'pine-ui', 'runtime.js'),
    join(SRC, 'renderer', 'js', 'chart', 'pine-ui', 'templates.js'),
  ];
  const OLD = /Date\.now\(\)\s*\+\s*(?:k\s*\+\s*)?Math\.floor\(\s*Math\.random\(\)\s*\*\s*999\s*\)/;
  let offenders = [];
  for (const f of files) {
    const txt = readFileSync(f, 'utf8');
    /* ignore comment lines that quote the old expression */
    const hits = txt.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((l) => OLD.test(l.line) && !l.line.startsWith('*') && !l.line.startsWith('//'));
    if (hits.length) offenders.push(f + ':' + hits.map((h) => h.n).join(','));
  }
  ok(offenders.length === 0, 'no id minter uses Date.now()+random(999) any more', offenders);

  /* and every file that mints an id imports the helper */
  let missing = [];
  for (const f of files) {
    const txt = readFileSync(f, 'utf8');
    if (/\bid:\s*nextInstanceId\(/.test(txt) && !/from '[^']*instance-id\.js'/.test(txt)) missing.push(f);
  }
  ok(missing.length === 0, 'every file that mints an id imports instance-id.js', missing);

  /* the three known minters all route through it */
  const ui = readFileSync(files[0], 'utf8');
  const panel = readFileSync(files[1], 'utf8');
  const runtime = readFileSync(files[2], 'utf8');
  ok(/id:\s*nextInstanceId\(pane\)/.test(ui), 'indicators-ui.syncPine mints via nextInstanceId(pane)');
  ok(/id:\s*nextInstanceId\(pane\)/.test(panel), 'pine-ui add() mints via nextInstanceId(pane)');
  ok(/id:\s*nextInstanceId\(pane\)/.test(runtime), 'restoreInto() mints via nextInstanceId(pane)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
