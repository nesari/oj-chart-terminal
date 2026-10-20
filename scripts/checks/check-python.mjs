#!/usr/bin/env node
/**
 * Python gate — byte-compiles every provider/*.py with the same interpreter
 * the app will use. Cross-platform: tries `python`, `python3`, then `py -3`
 * (the Windows launcher) so the check also runs on machines where only the
 * launcher is on PATH.
 *
 * PYTHONPYCACHEPREFIX points at the OS temp dir, so the check never creates
 * __pycache__ inside the working tree.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROVIDER = path.join(ROOT, 'provider');

function findPython() {
  const candidates = [
    { cmd: 'python', prefix: [] },
    { cmd: 'python3', prefix: [] },
    { cmd: 'py', prefix: ['-3'] },
  ];
  for (const c of candidates) {
    const r = spawnSync(c.cmd, [...c.prefix, '--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

function main() {
  const files = fs.readdirSync(PROVIDER)
    .filter((f) => f.endsWith('.py'))
    .sort()
    .map((f) => path.join(PROVIDER, f));
  if (!files.length) {
    console.error('[python] no provider/*.py files found');
    process.exit(1);
  }
  const py = findPython();
  if (!py) {
    console.error('[python] no interpreter found (tried python, python3, py -3)');
    process.exit(1);
  }
  const env = { ...process.env, PYTHONPYCACHEPREFIX: path.join(os.tmpdir(), 'mt5-chart-pycache') };
  let failed = 0;
  for (const file of files) {
    const r = spawnSync(py.cmd, [...py.prefix, '-m', 'py_compile', file], { cwd: ROOT, env, encoding: 'utf8' });
    if (r.status !== 0) {
      failed++;
      console.error('[python] FAIL ' + path.relative(ROOT, file));
      console.error(String(r.stderr || r.stdout || '').trim().split('\n').slice(0, 8).join('\n'));
    }
  }
  if (failed) {
    console.error(`\n[python] ${failed}/${files.length} file(s) failed`);
    process.exit(1);
  }
  console.log(`[python] OK — ${files.length} provider files compiled with ${py.cmd}${py.prefix.length ? ' ' + py.prefix.join(' ') : ''}`);
}

try { main(); } catch (e) { console.error('[python] ' + (e.stack || e)); process.exit(1); }
