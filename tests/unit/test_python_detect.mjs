/**
 * F6.3 — Python 3 detection on Windows (py -3 fallback).
 *
 * Run: node tests/unit/test_python_detect.mjs
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { pythonCandidates, probePython, pythonMissingHelp } = require('../../src/platform/electron/python-detect.js');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
};

const fake = (table) => (cmd, argv) => {
  const key = [cmd].concat(argv.slice(0, argv[0] === '-3' ? 1 : 0)).join(' ');
  const hit = table[key];
  if (!hit) return { error: new Error('ENOENT'), status: null, stdout: '' };
  return hit;
};

console.log('[1] Windows candidate order');
const win = pythonCandidates('win32').map((c) => [c.cmd].concat(c.pre).join(' '));
ok(win.join('|') === 'python|py -3|python3', 'python -> py -3 -> python3');

console.log('[2] fallback to py -3 when python is missing');
const probe = probePython(fake({ 'py -3': { status: 0, stdout: '3\n' } }), pythonCandidates('win32'));
ok(probe && probe.cmd === 'py' && probe.pre[0] === '-3', 'py -3 selected');

console.log('[3] python wins when it reports major 3');
const probe2 = probePython(fake({ python: { status: 0, stdout: '3\n' }, 'py -3': { status: 0, stdout: '3\n' } }), pythonCandidates('win32'));
ok(probe2 && probe2.cmd === 'python', 'python selected');

console.log('[4] python 2 is not accepted');
const probe3 = probePython(fake({ python: { status: 0, stdout: '2\n' }, 'py -3': { status: 0, stdout: '3\n' } }), pythonCandidates('win32'));
ok(probe3 && probe3.cmd === 'py', 'python2 skipped, py -3 used');

console.log('[5] no interpreter -> null + actionable help');
ok(probePython(fake({}), pythonCandidates('win32')) === null, 'probe returns null');
const help = pythonMissingHelp(pythonCandidates('win32'));
ok(/Python 3 not found/.test(help) && /py -3/.test(help) && /python\.org/.test(help) && /PATH/.test(help), 'help names candidates, download and PATH');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
