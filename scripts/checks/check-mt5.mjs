#!/usr/bin/env node
/**
 * Provider harness gate — runs tests/provider/*.py with the same interpreter
 * resolution as the app (`python`, `python3`, `py -3`).
 *
 * The suites install a replayable MetaTrader5 package (tests/provider/
 * mt5_fake.py), so provider/mt5.py is exercised without a Windows terminal,
 * a broker login or real market data. Recorded fixtures can be replayed by
 * pointing MT5_FIXTURE at a JSON file (see tests/provider/record_mt5.py).
 *
 * PYTHONPYCACHEPREFIX keeps __pycache__ out of the working tree.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TESTS = path.join(ROOT, 'tests', 'provider');

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
  const files = fs.existsSync(TESTS)
    ? fs.readdirSync(TESTS).filter((f) => f.startsWith('test_') && f.endsWith('.py'))
    : [];
  if (!files.length) {
    console.error('[mt5] no tests/provider/test_*.py files found');
    process.exit(1);
  }
  const py = findPython();
  if (!py) {
    console.error('[mt5] no interpreter found (tried python, python3, py -3)');
    process.exit(1);
  }
  const env = {
    ...process.env,
    PYTHONPYCACHEPREFIX: path.join(os.tmpdir(), 'mt5-chart-pycache'),
  };
  const r = spawnSync(py.cmd, [
    ...py.prefix, '-m', 'unittest', 'discover', '-s', 'tests/provider',
    '-p', 'test_*.py', '-v',
  ], { cwd: ROOT, env, encoding: 'utf8' });
  const out = String(r.stdout || '');
  const err = String(r.stderr || '');
  if (r.status !== 0) {
    const lines = (out + '\n' + err).split(/\r?\n/).filter(Boolean);
    console.error(lines.slice(-40).join('\n'));
    console.error(`\n[mt5] provider harness FAILED (exit ${r.status === null ? 'timeout' : r.status})`);
    process.exit(1);
  }
  const ran = ((out + '\n' + err).match(/Ran \d+ tests?/g) || []).pop() || 'tests passed';
  console.log(`[mt5] OK — ${ran} in ${files.length} suite file(s) with ${py.cmd}${py.prefix.length ? ' ' + py.prefix.join(' ') : ''}`);
}

try { main(); } catch (e) { console.error('[mt5] ' + (e.stack || e)); process.exit(1); }
