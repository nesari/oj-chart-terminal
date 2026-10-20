/**
 * F7.1 — packaged provider script resolution.
 *
 * Run: node tests/unit/test_provider_path.mjs
 */

import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { providerScript } = require('../../src/platform/electron/provider-path.js');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
};

console.log('[1] development run');
ok(
  providerScript('demo.py', { packaged: false, rootDir: 'C:\\app' }) === path.join('C:\\app', 'provider', 'demo.py'),
  'uses <root>/provider in dev',
);

console.log('[2] packaged run with asarUnpack');
const packaged = {
  packaged: true,
  rootDir: 'C:\\app\\resources\\app.asar',
  resourcesPath: 'C:\\app\\resources',
  fileExists: (p) => p === path.join('C:\\app\\resources', 'app.asar.unpacked', 'provider', 'demo.py'),
};
ok(
  providerScript('demo.py', packaged) === path.join('C:\\app\\resources', 'app.asar.unpacked', 'provider', 'demo.py'),
  'uses app.asar.unpacked copy',
);
ok(
  providerScript('mt5.py', packaged) === path.join('C:\\app\\resources\\app.asar', 'provider', 'mt5.py'),
  'falls back to in-asar path when unpacked copy is missing',
);

console.log('[3] mt5/demo both resolve inside the unpacked provider dir');
const all = (p) => true;
const unpacked = path.join('C:\\app\\resources', 'app.asar.unpacked', 'provider');
ok(providerScript('mt5.py', { ...packaged, fileExists: all }) === path.join(unpacked, 'mt5.py'), 'mt5.py');
ok(providerScript('provider_common.py', { ...packaged, fileExists: all }) === path.join(unpacked, 'provider_common.py'), 'shared module');

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
