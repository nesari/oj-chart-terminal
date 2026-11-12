/**
 * ROUND266 - the liveness gate must not fail on a shared-runner freeze,
 * and must still fail on a real one.
 *
 * `d45e4a2`'s Windows CI run went red for a reason that had nothing to do
 * with the code: `verify_pine80.mjs` measured a 2715ms event-loop gap while
 * the gate ran two suites at once on a 2-vCPU runner (vCPU steal / antivirus
 * / GC can freeze the whole process for seconds). Two defects in the gate:
 *
 *  1. the only liveness suite was scheduled inside the concurrent pool, so
 *     a sibling child could starve the probe;
 *  2. a single bad sample was final — one freeze turned a healthy run red,
 *     even though the neighbouring probe-count assertion proved the loop
 *     had run throughout.
 *
 * Pins:
 *  - `scripts/checks/run-unit.mjs` keeps a SERIAL set, runs those suites
 *    alone before the pool, and the pool only iterates the rest;
 *  - `verify_pine80.mjs` retries the measurement ONCE and keeps the same
 *    250ms threshold, so two stalls in a row still fail;
 *  - functionally: one injected freeze is rescued (exit 0, one retry note),
 *    two injected freezes still fail (exit 1).
 *
 * This suite spawns children, so it is itself in the SERIAL set (CI runs it
 * alone, where the probe numbers are meaningful).
 *
 * Run: node tests/unit/test_round266_ci_timing_gate.mjs
 */
import { readSource } from './source-utils.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra !== undefined ? ' - ' + JSON.stringify(extra) : '')); }
};

const sched = readSource('scripts/checks/run-unit.mjs');
const pine = readSource('tests/unit/verify_pine80.mjs');

console.log('\n[1] timing-sensitive suites run alone');
{
  ok(/const SERIAL = new Set\(\[[^\]]*'verify_pine80\.mjs'/.test(sched),
    'verify_pine80.mjs is in the SERIAL set');
  ok(/const SERIAL = new Set\(\[[^\]]*'test_round266_ci_timing_gate\.mjs'/.test(sched),
    'this suite is in the SERIAL set too (it spawns children)');
  /* ROUND281: the corpus budget gate measures a same-process wall-time ratio;
     a sibling child on a 2-vCPU runner can perturb that, so it must run alone. */
  ok(/const SERIAL = new Set\(\[[^\]]*'test_round281_corpus_budget\.mjs'/.test(sched),
    'the corpus budget gate is in the SERIAL set (it measures wall time)');
  const serialPick = sched.slice(sched.indexOf('const serial ='), sched.indexOf('const parallel ='));
  ok(/files\.filter\(\(f\) => SERIAL\.has\(f\)\)/.test(serialPick), 'serial = SERIAL members');
  const parallelPick = sched.slice(sched.indexOf('const parallel ='));
  ok(/files\.filter\(\(f\) => !SERIAL\.has\(f\)\)/.test(parallelPick.slice(0, 200)),
    'parallel = everything else');
  ok(/for \(const file of serial\) results\.push\(await runOne\(file\)\);/.test(sched),
    'serial suites run one at a time (awaited in a for-of, not a pool)');
  const pool = sched.slice(sched.indexOf('async function worker()'));
  ok(/while \(next < parallel\.length\)/.test(pool), 'the pool only walks the parallel list');
  ok(/Math\.min\(CONCURRENCY, parallel\.length\)/.test(pool),
    'pool width is bounded by the non-serial count');
  ok(sched.indexOf('for (const file of serial)') < sched.indexOf('async function worker()'),
    'serial pass happens before the concurrent pool');
}

console.log('\n[2] bounded retries, same threshold');
{
  ok(/async function measureLiveness\(bars\)/.test(pine), 'the probe is a reusable measurement');
  ok(/attempts\+\+/.test(pine), 'each measurement is counted');
  ok(/const STALL = 250/.test(pine), 'the shipped threshold is still 250ms');
  /* ROUND290: one retry was not enough — two consecutive disturbed samples on
     a loaded 2-vCPU runner killed healthy builds (f115944, 0b71a5a). The
     attempt count is bounded (3) and a busy loop is still caught because a
     monolithic pass never yields at all. */
  const bounds = pine.slice(pine.indexOf('const MAX_ATTEMPTS'), pine.indexOf('max event-loop gap'));
  ok(/const MAX_ATTEMPTS = 3/.test(pine), 'the attempt count is bounded at 3');
  ok(/tries < MAX_ATTEMPTS/.test(bounds), 'the retry loop honours that bound');
  ok(/best\.maxGap <= STALL/.test(pine), 'the assertion still uses the 250ms threshold');
  ok(/if \(m\.maxGap < best\.maxGap\) best = m/.test(pine), 'the cleanest sample is the one judged');
  ok(/m\.probes > 20/.test(pine), 'the loop-ran assertion is still there');
  ok(/plotByTitle\(m\.rt, 'acc'\)/.test(pine), 'the completed run still reports its output');
}

console.log('\n[3] a single freeze is rescued (functional)');
{
  const env = { ...process.env, OJ_PINE80_STALL_ONCE: '1' };
  delete env.OJ_PINE80_STALL_ALWAYS;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'unit', 'verify_pine80.mjs')], {
    cwd: ROOT, encoding: 'utf8', env, windowsHide: true, timeout: 120_000,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  ok(r.status === 0, 'stalled-once run passes', { status: r.status });
  const notes = out.match(/attempt \d+ stalled/g) || [];
  ok(notes.length === 1, 'exactly one retry note', notes.length);
  ok(/attempt 1 stalled \d+ms/.test(out), 'the note reports the stalled sample');
  ok(/RESULT: 16 passed, 0 failed/.test(out), 'all 16 checks still ran');
}

console.log('\n[4] a persistent freeze still fails (functional)');
{
  const env = { ...process.env, OJ_PINE80_STALL_ALWAYS: '1' };
  delete env.OJ_PINE80_STALL_ONCE;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'unit', 'verify_pine80.mjs')], {
    cwd: ROOT, encoding: 'utf8', env, windowsHide: true, timeout: 120_000,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  ok(r.status === 1, 'every-attempt stall exits non-zero', { status: r.status });
  ok(/FAIL: max event-loop gap/.test(out), 'the gap assertion is what fails');
  /* The bound matters: an unbounded loop would turn a genuine regression into
     an infinite retry instead of a red build. */
  const notes = out.match(/attempt \d+ stalled/g) || [];
  ok(notes.length === 2, 'it retries up to the bound, not endlessly', notes.length);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
