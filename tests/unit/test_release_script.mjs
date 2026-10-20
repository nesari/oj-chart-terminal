/**
 * F7.3 — release script helpers (no git/build side effects).
 *
 * Run: node tests/unit/test_release_script.mjs
 */

import {
  nextVersion, validateVersion, changelogFile, renderEntry, insertEntry, updateIndex,
} from '../../scripts/release.mjs';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
};

console.log('[1] semver bumps');
ok(nextVersion('1.9.212', 'patch') === '1.9.213', 'patch');
ok(nextVersion('1.9.212', 'minor') === '1.10.0', 'minor');
ok(nextVersion('1.9.212', 'major') === '2.0.0', 'major');
let threw = false;
try { nextVersion('1.9', 'patch'); } catch (e) { threw = true; }
ok(threw, 'invalid current version rejected');

console.log('[2] validation + changelog routing');
ok(validateVersion('1.10.0') === '1.10.0', 'valid version accepted');
threw = false;
try { validateVersion('1.10'); } catch (e) { threw = true; }
ok(threw, 'invalid version rejected');
ok(changelogFile('1.9.212') === 'changelog/v1.9.md', '1.9.x -> v1.9.md');
ok(changelogFile('1.10.0') === 'changelog/v1.10.md', '1.10.x -> v1.10.md');

console.log('[3] entry rendering');
const entry = renderEntry('1.9.213', '2026-10-20', 'Fix login retry\nSecond line');
ok(entry.startsWith('## 1.9.213 — 2026-10-20'), 'heading with version + date');
ok(entry.includes('- Fix login retry') && entry.includes('- Second line'), 'bullets normalized');
ok(renderEntry('1.9.213', '2026-10-20').includes('- Release 1.9.213.'), 'default body');

console.log('[4] entry insertion keeps newest first');
const fileText = '# CHANGELOG — 1.9.x\n\nSplit from the root index.\n\n## 1.9.212 — old\n\n- old\n';
const merged = insertEntry(fileText, entry);
ok(merged.indexOf('## 1.9.213') < merged.indexOf('## 1.9.212'), 'new entry before old');
ok(merged.startsWith('# CHANGELOG'), 'intro preserved');
const bare = insertEntry('# CHANGELOG\n\n', entry);
ok(bare.indexOf('## 1.9.213') > 0, 'entry appended when no prior sections');

console.log('[5] index update');
const idx = '# CHANGELOG\n\nCurrent version: **1.9.212** (`package.json`).\n\n| File | Versions |\n|---|---|\n| [`changelog/v1.9.md`](changelog/v1.9.md) | 1.9.0 → 1.9.212 |\n';
const updated = updateIndex(idx, '1.10.0', 'changelog/v1.10.md');
ok(/Current version: \*\*1\.10\.0\*\*/.test(updated), 'current version refreshed');
ok(updated.includes('changelog/v1.10.md'), 'new changelog linked');
ok(updateIndex(updated, '1.10.1', 'changelog/v1.10.md') === updated.replace(/\*\*1\.10\.0\*\*/, '**1.10.1**'), 'no duplicate row');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
