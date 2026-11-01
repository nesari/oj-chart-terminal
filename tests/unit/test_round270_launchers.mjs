/**
 * ROUND270 - the launchers must start on every platform they claim.
 *
 * Confirmed by reading `run.sh` (the only macOS/Linux launcher):
 *
 *  - it built the mode flag in a bash ARRAY and expanded it as
 *    `"${ARGS[@]}"` under `set -euo pipefail`. Stock macOS still ships
 *    **bash 3.2**, where `set -u` treats an EMPTY array as unbound — so the
 *    documented default launch `./run.sh` (demo mode, no flags) aborted with
 *    "ARGS[@]: unbound variable" before Electron ever started. Only
 *    `./run.sh mt5` worked, because that path filled the array.
 *
 * Pins:
 *  - run.sh carries the mode flag in a plain string (no empty-array
 *    expansion), passes it unquoted (one fixed token or nothing) and still
 *    forwards the user's extra flags in both modes;
 *  - the checksum gate keeps failing CLOSED in all three launchers — a
 *    tampered download is never launched;
 *  - `bash -n run.sh` parses (when bash is available on this machine).
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

const sh = readSource('run.sh');
const batMt5 = readSource('run-mt5.bat');
const batDemo = readSource('run-demo.bat');

console.log('\n[1] run.sh survives an empty flag list (bash 3.2)');
{
  ok(!/ARGS=\(\)/.test(sh), 'no empty array is declared');
  ok(!/"\$\{ARGS\[@\]\}"/.test(sh), 'no bare `"${ARGS[@]}"` expansion under set -u');
  ok(/^set -euo pipefail$/m.test(sh), 'the strict shell options are still on');
  ok(/MODE_FLAG=""/.test(sh), 'the flag starts empty');
  ok(/MODE_FLAG="--mode=mt5"/.test(sh), 'mt5 mode sets the flag');
  ok(/npx electron \. \$MODE_FLAG "\$@"/.test(sh),
    'the flag is passed as one unquoted token (empty = no argument)');
  ok(/shift \|\| true/.test(sh), 'the mode word is consumed in both branches');
}

console.log('\n[2] extra electron flags still reach the app');
{
  ok(/\.\/run\.sh          -> demo mode/.test(sh), 'the usage text still documents demo mode');
  ok(/\.\/run\.sh mt5      -> real MetaTrader 5 mode/.test(sh), 'and mt5 mode');
  /* the forwarded args come AFTER the mode flag, so `run.sh mt5 --no-sandbox`
     launches `electron . --mode=mt5 --no-sandbox` */
  ok(sh.indexOf('npx electron . $MODE_FLAG') > 0 && /"\$@"$/m.test(sh.trim()),
    'user flags are forwarded last');
}

console.log('\n[3] the checksum gate fails closed everywhere');
{
  for (const [name, bat] of [['run-mt5.bat', batMt5], ['run-demo.bat', batDemo]]) {
    ok(/call node scripts\\verify-electron\.js/.test(bat), name + ' verifies the download');
    const iGate = bat.indexOf('call node scripts\\verify-electron.js');
    const iStart = bat.indexOf('start "" "node_modules\\electron\\dist\\electron.exe"');
    ok(iGate > 0 && iStart > iGate, name + ' launches only after the check');
    ok(/if errorlevel 1 \([\s\S]*?exit \/b 1[\s\S]*?\)/.test(bat.slice(iGate)),
      name + ' aborts when the checksum fails');
  }
  ok(/if ! node scripts\/verify-electron\.js; then[\s\S]{0,600}exit 1/.test(sh),
    'run.sh aborts when the checksum fails');
}

console.log('\n[4] run.sh parses');
{
  const probe = spawnSync('bash', ['-n', 'run.sh'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const err = (probe.stderr || '') + (probe.stdout || '');
  /* Windows CI may expose a WSL launcher instead of a real bash; that is an
     environment limitation, not a script defect — only a REAL bash verdict
     is asserted. */
  const unusable = probe.error || probe.status === null ||
    /WSL|Windows Subsystem|not found|No such file|distribution/i.test(err);
  if (unusable) {
    console.log('  note  no usable bash here — syntax check skipped');
    ok(true, 'bash syntax check skipped (no usable bash)');
  } else {
    ok(probe.status === 0, 'bash -n run.sh is clean', { status: probe.status, err: err.slice(0, 200) });
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
