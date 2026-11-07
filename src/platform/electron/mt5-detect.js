'use strict';
/**
 * MetaTrader 5 terminal detection (login-screen guidance).
 *
 * The Python `MetaTrader5` package talks to a LOCALLY INSTALLED terminal over
 * IPC: `mt5.initialize()` starts the terminal process when needed, but it
 * cannot work when no terminal exists at all. This helper answers the two
 * questions the login screen needs:
 *
 *   - is a terminal present (registry installs + the usual install folders +
 *     portable per-instance folders)?
 *   - when it is missing, what should the user do next?
 *
 * Everything is injected (platform, env, fs probes, registry paths) so the
 * logic stays unit-testable without spawning Electron or touching Windows.
 *
 * @module platform/electron/mt5-detect
 */

const path = require('node:path');

const DOWNLOAD_URL = 'https://www.metatrader5.com/en/download';

/* Install folders that hold a normal (non-portable) terminal. */
function installCandidates(env) {
  const e = env || process.env;
  const out = [];
  const pf = e.ProgramFiles || 'C:\\Program Files';
  const pf86 = e['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = e.LOCALAPPDATA || '';
  out.push(path.join(pf, 'MetaTrader 5', 'terminal64.exe'));
  out.push(path.join(pf86, 'MetaTrader 5', 'terminal64.exe'));
  if (local) out.push(path.join(local, 'Programs', 'MetaTrader 5', 'terminal64.exe'));
  return out;
}

/* Portable installs live next to their data folder:
   %APPDATA%\MetaQuotes\Terminal\<instance>\terminal64.exe */
function portableCandidates(env, readdir) {
  const e = env || process.env;
  if (!e.APPDATA) return [];
  const root = path.join(e.APPDATA, 'MetaQuotes', 'Terminal');
  let entries = [];
  try {
    entries = readdir ? readdir(root) : require('node:fs').readdirSync(root);
  } catch (err) {
    return [];
  }
  return entries
    .filter((name) => name && name !== '.' && name !== '..')
    .map((name) => path.join(root, String(name), 'terminal64.exe'));
}

/* Broker-branded installs are the norm: "AMarkets - MetaTrader 5",
   "Sarmaye Gozare Bartar MT5 Terminal", … — a fixed folder name would miss
   every real user. Probe one level deep under the install roots instead. */
function scanInstallRoots(env, readdir, fileExists) {
  const e = env || process.env;
  const roots = dedupe([
    e.ProgramFiles || 'C:\\Program Files',
    e['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    e.LOCALAPPDATA ? path.join(e.LOCALAPPDATA, 'Programs') : '',
  ]);
  const out = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdir ? readdir(root) : require('node:fs').readdirSync(root);
    } catch (err) {
      continue;
    }
    for (const name of entries || []) {
      if (!name || name === '.' || name === '..') continue;
      const exe = path.join(root, String(name), 'terminal64.exe');
      if (fileExists(exe)) out.push(exe);
    }
  }
  return out;
}

function dedupe(paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    const key = String(p).toLowerCase();
    if (!p || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * Parse `reg query … /s /v InstallPath` output into terminal exe paths.
 * Accepts both a folder value and a direct terminal64.exe value.
 */
function parseRegistryInstalls(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/\bInstallPath\s+REG_[A-Z_]+\s+(.+?)\s*$/i);
    if (!m) continue;
    const value = m[1].trim().replace(/^"+|"+$/g, '');
    if (!value) continue;
    out.push(/\.exe$/i.test(value) ? value : path.join(value, 'terminal64.exe'));
  }
  return dedupe(out);
}

/**
 * Resolve the terminal for this machine.
 *
 * @param {object} [opts]
 * @param {string} [opts.platform]           defaults to process.platform
 * @param {object} [opts.env]                defaults to process.env
 * @param {(p:string)=>boolean} [opts.fileExists]
 * @param {(d:string)=>string[]} [opts.readdir]
 * @param {string[]} [opts.registryPaths]    already-resolved registry values
 * @returns {{platform:string, supported:boolean, installed:boolean, path:string, candidates:string[]}}
 */
function findMt5Terminal(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  const fs = require('node:fs');
  const fileExists = o.fileExists || ((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });

  if (platform !== 'win32') {
    return { platform, supported: false, installed: false, path: '', candidates: [] };
  }

  const candidates = dedupe([]
    .concat(o.registryPaths || [])
    .concat(installCandidates(env))
    .concat(scanInstallRoots(env, o.readdir, fileExists))
    .concat(portableCandidates(env, o.readdir)));
  const found = candidates.find((p) => fileExists(p)) || '';
  return { platform, supported: true, installed: !!found, path: found, candidates };
}

/** User-facing next step when no terminal was found. */
function missingHelp(platform) {
  if ((platform || process.platform) !== 'win32') {
    return 'MetaTrader 5 runs on Windows only. Use the built-in Demo data on this system, '
      + 'or run OJchart on Windows (or a Windows VM) for live MT5 data.';
  }
  return 'MetaTrader 5 terminal not found. Install it from your broker (or the MetaQuotes demo), '
    + 'then choose its terminal64.exe — or keep using the built-in Demo data.';
}

/**
 * Full answer for the login screen: a manually supplied path wins when it
 * exists (file or install folder), otherwise auto-detection runs.
 *
 * @param {object} [opts]
 * @param {string} [opts.requestedPath] user-typed/picked terminal path
 * @param {string} [opts.platform]
 * @param {object} [opts.env]
 * @param {object} [opts.fs]            injectable for tests
 * @param {(p:string)=>boolean} [opts.fileExists]
 * @param {(d:string)=>string[]} [opts.readdir]
 * @param {string[]} [opts.registryPaths]
 */
function resolveMt5Status(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const fsMod = o.fs || require('node:fs');
  const requested = typeof o.requestedPath === 'string' ? o.requestedPath.trim().slice(0, 400) : '';
  if (requested) {
    /* Accept both the exe and its install folder (users often paste either). */
    let resolved = requested;
    try {
      if (fsMod.statSync(requested).isDirectory()) resolved = path.join(requested, 'terminal64.exe');
    } catch (e) { /* missing path: fall through to auto-detection */ }
    let exists = false;
    try { exists = fsMod.existsSync(resolved) && fsMod.statSync(resolved).isFile(); } catch (e) { exists = false; }
    if (exists) {
      return {
        platform, supported: true, installed: true, path: resolved,
        candidates: [resolved], source: 'manual', downloadUrl: DOWNLOAD_URL, hint: '',
      };
    }
  }
  const st = findMt5Terminal({
    platform, env: o.env, fileExists: o.fileExists, readdir: o.readdir, registryPaths: o.registryPaths,
  });
  return {
    ...st,
    source: st.installed ? 'auto' : '',
    downloadUrl: DOWNLOAD_URL,
    hint: st.installed ? '' : missingHelp(platform),
  };
}

module.exports = {
  DOWNLOAD_URL,
  installCandidates,
  scanInstallRoots,
  portableCandidates,
  parseRegistryInstalls,
  findMt5Terminal,
  resolveMt5Status,
  missingHelp,
};
