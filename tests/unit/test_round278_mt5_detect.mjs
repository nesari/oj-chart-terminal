/**
 * test_round278_mt5_detect.mjs — MT5 terminal detection + login guidance.
 *
 * A machine without a MetaTrader 5 terminal must get an actionable message
 * (install / pick terminal64.exe / use Demo) instead of an opaque provider
 * error. This suite pins the detector itself and the login-screen wiring.
 *
 * Run: node tests/unit/test_round278_mt5_detect.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';
import { fileURLToPath } from 'node:url';
import { readSource } from './source-utils.mjs';

const require = createRequire(import.meta.url);
const {
  DOWNLOAD_URL,
  installCandidates,
  scanInstallRoots,
  portableCandidates,
  parseRegistryInstalls,
  findMt5Terminal,
  resolveMt5Status,
  missingHelp,
} = require('../../src/platform/electron/mt5-detect.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label); }
};

const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
  APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
};

/* ---------- 1. candidate folders ---------- */
{
  const list = installCandidates(WIN_ENV);
  ok(list.length === 3, 'installCandidates() covers Program Files, x86 and per-user Programs');
  ok(list[0] === path.join('C:\\Program Files', 'MetaTrader 5', 'terminal64.exe'), 'first candidate is Program Files');
  ok(installCandidates({}).length === 2, 'missing env vars still yield the two Program Files defaults');

  const portable = portableCandidates(WIN_ENV, () => ['ABC123', 'DEF456']);
  ok(portable.length === 2 && portable[0].includes('ABC123'), 'portableCandidates() walks MetaQuotes\\Terminal\\<id>');
  ok(portableCandidates(WIN_ENV, () => { throw new Error('missing'); }).length === 0,
    'a missing portable root is not fatal');
  ok(portableCandidates({}, () => []).length === 0, 'no APPDATA -> no portable candidates');
}

/* ---------- 2. registry parsing ---------- */
{
  const text = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\MetaQuotes\\Terminal\\ABC',
    '    InstallPath    REG_SZ    C:\\Program Files\\MetaTrader 5',
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\MetaQuotes\\Terminal\\DEF',
    '    InstallPath    REG_SZ    "D:\\Apps\\MT5\\terminal64.exe"',
  ].join('\r\n');
  const paths = parseRegistryInstalls(text);
  ok(paths.length === 2, 'parseRegistryInstalls() reads every InstallPath');
  ok(paths[0] === path.join('C:\\Program Files\\MetaTrader 5', 'terminal64.exe'), 'a folder value gets terminal64.exe appended');
  ok(paths[1] === 'D:\\Apps\\MT5\\terminal64.exe', 'a direct exe value is kept and unquoted');
  ok(parseRegistryInstalls('').length === 0, 'empty registry output -> no paths');
}

/* ---------- 3. terminal resolution ---------- */
{
  const wanted = path.join('D:\\Apps\\MT5', 'terminal64.exe');
  const st = findMt5Terminal({
    platform: 'win32', env: WIN_ENV,
    registryPaths: [wanted],
    readdir: () => [],
    fileExists: (p) => p === wanted,
  });
  ok(st.installed && st.path === wanted, 'a registry install is found');
  ok(st.candidates[0] === wanted, 'registry paths come first');

  const fallback = findMt5Terminal({
    platform: 'win32', env: WIN_ENV,
    readdir: (dir) => (dir.includes('Roaming') ? ['PORTABLE1'] : []),
    fileExists: (p) => p.includes('PORTABLE1'),
  });
  ok(fallback.installed && fallback.path.includes('PORTABLE1'),
    'portable installs are found when Program Files has none');

  const none = findMt5Terminal({ platform: 'win32', env: WIN_ENV, readdir: () => [], fileExists: () => false });
  ok(!none.installed && none.supported && none.path === '', 'missing terminal -> installed:false');
  ok(none.candidates.length === 3, 'all standard candidates are reported');

  /* Real machines rarely use the plain "MetaTrader 5" folder: brokers ship
     their own brand. The one-level scan must find those. */
  const brokerRoots = { 'C:\\PF': ['AMarkets - MetaTrader 5', 'Other App'], 'C:\\PF86': ['Sarmaye Gozare Bartar MT5 Terminal'] };
  const scan = scanInstallRoots({ ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\Local' },
    (dir) => brokerRoots[dir] || [],
    (p) => /AMarkets|Sarmaye/.test(p));
  ok(scan.length === 2, 'scanInstallRoots() finds broker-branded terminal folders');
  const broker = findMt5Terminal({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\Local' },
    readdir: (dir) => brokerRoots[dir] || [],
    fileExists: (p) => p.includes('AMarkets'),
  });
  ok(broker.installed && broker.path.includes('AMarkets - MetaTrader 5'), 'a broker-branded install is detected');

  const mac = findMt5Terminal({ platform: 'darwin', env: {}, fileExists: () => false });
  ok(!mac.installed && mac.supported === false && mac.candidates.length === 0,
    'non-Windows platforms report unsupported instead of probing paths');
}

/* ---------- 4. user-facing help ---------- */
{
  const win = missingHelp('win32');
  ok(/not found/i.test(win) && /broker/i.test(win) && /terminal64\.exe/.test(win) && /Demo/i.test(win),
    'Windows help names install source, path and Demo fallback');
  const mac = missingHelp('darwin');
  ok(/Windows only/i.test(mac) && /Demo/i.test(mac), 'non-Windows help explains the platform limit and Demo mode');
  ok(DOWNLOAD_URL.startsWith('https://') && /metatrader5\.com/.test(DOWNLOAD_URL), 'download URL is the official MetaQuotes page');
}

/* ---------- 4b. full status resolution (manual path wins) ---------- */
{
  const exe = 'C:\\Apps\\MT5\\terminal64.exe';
  const fakeFs = {
    statSync: (p) => {
      if (p === 'C:\\Apps\\MT5') return { isDirectory: () => true, isFile: () => false };
      if (p === exe) return { isDirectory: () => false, isFile: () => true };
      throw new Error('ENOENT');
    },
    existsSync: (p) => p === exe,
  };

  const manual = resolveMt5Status({ requestedPath: exe, platform: 'win32', fs: fakeFs });
  ok(manual.installed && manual.source === 'manual' && manual.path === exe,
    'an existing exe is used as-is (source: manual)');
  ok(manual.hint === '' && manual.downloadUrl === DOWNLOAD_URL, 'a found terminal carries no warning');

  const folder = resolveMt5Status({ requestedPath: 'C:\\Apps\\MT5', platform: 'win32', fs: fakeFs });
  ok(folder.installed && folder.path === exe, 'an install folder resolves to its terminal64.exe');

  const missing = resolveMt5Status({
    requestedPath: 'C:\\Nope\\terminal64.exe', platform: 'win32', fs: fakeFs,
    fileExists: () => false, readdir: () => [],
  });
  ok(!missing.installed && missing.source === '' && /not found/i.test(missing.hint),
    'a stale manual path falls back to auto-detection + help');

  const auto = resolveMt5Status({
    platform: 'win32',
    fs: fakeFs,
    registryPaths: ['D:\\Broker\\terminal64.exe'],
    fileExists: (p) => p === 'D:\\Broker\\terminal64.exe',
    readdir: () => [],
  });
  ok(auto.installed && auto.source === 'auto' && auto.path === 'D:\\Broker\\terminal64.exe',
    'auto-detection marks the source as auto');

  const mac = resolveMt5Status({ platform: 'darwin', fs: fakeFs, fileExists: () => false, readdir: () => [] });
  ok(!mac.installed && mac.supported === false && /Windows only/i.test(mac.hint),
    'non-Windows status is unsupported with platform guidance');
}

/* ---------- 5. main/preload/UI wiring ---------- */
{
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  ok(/ipcMain\.handle\(\s*'mt5-status'/.test(main), 'main registers mt5-status');
  ok(/ipcMain\.handle\(\s*'mt5-pick-terminal'/.test(main), 'main registers the terminal picker');
  ok(/ipcMain\.on\(\s*'mt5-open-download'/.test(main), 'main registers the fixed download link');
  ok(/resolveMt5Status\(\{/.test(main), 'main delegates to the shared resolver');
  ok(/isDirectory\(\)/.test(fs.readFileSync(path.join(ROOT, 'src', 'platform', 'electron', 'mt5-detect.js'), 'utf8')),
    'the resolver accepts an install folder as well as the exe');
  ok(/shell\.openExternal\(MT5_DOWNLOAD_URL\)/.test(main), 'the download channel opens the fixed URL (no renderer-supplied URL)');

  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  ok(/mt5Status:\s*\(p\)\s*=>\s*ipcRenderer\.invoke\('mt5-status'/.test(preload), 'preload exposes mt5Status');
  ok(/mt5PickTerminal:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('mt5-pick-terminal'/.test(preload), 'preload exposes the picker');
  ok(/mt5OpenDownload:\s*\(\)\s*=>\s*ipcRenderer\.send\('mt5-open-download'/.test(preload), 'preload exposes the download action');

  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  ok(/id="mt5-hint"/.test(html) && /id="mt5-hint-text"/.test(html), 'login markup carries the guidance box');
  for (const id of ['mt5-download', 'mt5-choose', 'mt5-recheck', 'mt5-demo']) {
    ok(new RegExp('id="' + id + '"').test(html), 'login markup has #' + id);
  }

  const login = readSource('src/renderer/js/ui/login.js');
  ok(/api\.mt5Status\(\{ path:/.test(login), 'login asks main for the terminal status');
  ok(/mt5PickTerminal\(\)/.test(login), 'login opens the terminal picker');
  ok(/!mt5st\.installed/.test(login), 'connect stops with guidance when no terminal is found');
  ok(/mode = 'demo';\s*apply\(\)/.test(login), 'the guidance box can switch back to Demo mode');
  ok(/st\.supported === false/.test(login), 'non-Windows hides the download button');

  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'css', 'app.css'), 'utf8');
  ok(/#mt5-hint\s*\{/.test(css) && /\.mt5-hint-actions/.test(css), 'guidance box has dedicated styles');
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
