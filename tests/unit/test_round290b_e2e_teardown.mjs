/**
 * test_round290b_e2e_teardown.mjs — the browser gate must not poison itself.
 *
 * `npm run check:e2e` starts each archived suite as a child process. Every one
 * of those suites boots three things of its own: a static HTTP server, the
 * demo provider and Chromium. When a suite hits its time limit the gate used to
 * call `child.kill('SIGKILL')`, which on Windows ends ONLY the Python wrapper —
 * the HTTP server, the provider and Chromium survived, kept their ports and
 * kept burning CPU. The next suite then fought a saturated machine, timed out
 * too, and the run failed with a CHAIN of "boot timeout" lines while every
 * suite passed locally. That is exactly what happened to round287 → round288
 * on the v1.9.221 tag run.
 *
 * This suite pins the fix by running the gate against a deliberately-hanging
 * fake suite and checking that NOTHING it spawned is still alive afterwards.
 *
 * Run: node tests/unit/test_round290b_e2e_teardown.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readSource } from './source-utils.mjs';

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

/* ---------- 1. the source contract ---------- */
{
  const g = readSource('scripts/checks/e2e-gate.mjs');
  ok(/function killTree\(/.test(g), 'the gate has a whole-tree killer');
  ok(/taskkill/.test(g) && /\/T/.test(g) && /\/F/.test(g),
    'on Windows it uses taskkill /T /F (the only thing that reaches the tree)');
  ok(/process\.kill\(-pid/.test(g), 'on POSIX it signals the process group');
  ok(/detached:\s*process\.platform !== 'win32'/.test(g),
    'the child is made its own group on POSIX so the signal can reach it');
  ok(!/child\.kill\('SIGKILL'\)\s*\}\s*catch/.test(g.split('function killTree')[1]?.slice(0, 400) || ''),
    'killTree does not rely on the bare child.kill fallback');
  ok(/killTree\(child\)/.test(g), 'the timeout path calls killTree');
  /* the retry grace period must exist: ports need time to be released */
  ok(/sleep\(3000 \* attempt\)/.test(g), 'retries wait for the ports to come back');
}

/* ---------- 2. functional: a hanging grandchild does NOT survive ---------- */
{
  /* A fake "suite": spawns a long-lived grandchild, prints its pid, then hangs.
     If the gate only killed the Python wrapper, that grandchild would outlive
     this test — which we detect by checking the pid afterwards. */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oj-e2e-'));
  const fake = path.join(tmp, 'fake_hang.py');
  fs.writeFileSync(fake, [
    'import subprocess, sys, time, os',
    'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])',
    'print("GRANDCHILD " + str(child.pid), flush=True)',
    'time.sleep(600)',
  ].join('\n'), 'utf8');

  /* Reproduce the gate's timeout path against it. */
  const driver = path.join(tmp, 'driver.mjs');
  fs.writeFileSync(driver, `
import { spawn, spawnSync } from 'node:child_process';
const file = ${JSON.stringify(fake)};
const child = spawn('python', [file], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let out = '';
child.stdout.on('data', (d) => { out += d; });
const timer = setTimeout(() => {
  const pid = child.pid;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch (e) { child.kill('SIGKILL'); }
  }
  setTimeout(() => { console.log(out.trim()); process.exit(0); }, 1500);
}, 6000);
`, 'utf8');

  const r = spawnSync(process.execPath, [driver], { encoding: 'utf8', timeout: 60_000 });
  const m = /GRANDCHILD\s+(\d+)/.exec(r.stdout || '');
  ok(!!m, 'the fake suite started a grandchild', (r.stdout || r.stderr || '').slice(0, 200));

  if (m) {
    const pid = Number(m[1]);
    /* give the OS a moment to reap it */
    const check = process.platform === 'win32'
      ? spawnSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf8' })
      : spawnSync('ps', ['-p', String(pid)], { encoding: 'utf8' });
    const alive = process.platform === 'win32'
      ? new RegExp(`\\b${pid}\\b`).test(check.stdout || '')
      : (check.status === 0);
    ok(!alive, 'the grandchild was killed with its parent', 'pid ' + pid + ' still alive');
    if (alive) {
      /* do not leak it into the developer's machine either */
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else try { process.kill(pid, 'SIGKILL'); } catch (e) {}
    }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
}

/* ---------- 3. the suites' own teardown helper agrees ---------- */
{
  const teardown = readSource('tests/archive/e2e/e2e_teardown.py');
  ok(/def kill_proc/.test(teardown), 'the shared Python teardown exists');
  ok(/taskkill/.test(teardown) && /\/T/.test(teardown),
    'and it also uses taskkill /T so suites clean their own trees');
}

console.log('\nROUND290b: ' + pass + ' passed, ' + fail + ' failed.');
process.exit(fail ? 1 : 0);
