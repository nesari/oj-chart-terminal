'use strict';
/**
 * Python 3 detection for the bundled data provider.
 *
 * Windows installs expose either `python` (PATH tick during setup) or the
 * `py -3` launcher (Microsoft Store / per-user installs). Detection is a
 * pure helper so it can be unit-tested without booting Electron; main.js
 * injects the real child_process.spawnSync.
 *
 * @module platform/electron/python-detect
 */

function pythonCandidates(platform) {
  const p = platform || process.platform;
  return p === 'win32'
    ? [{ cmd: 'python', pre: [] }, { cmd: 'py', pre: ['-3'] }, { cmd: 'python3', pre: [] }]
    : [{ cmd: 'python3', pre: [] }, { cmd: 'python', pre: [] }];
}

function probePython(spawnSync, candidates) {
  const list = candidates || pythonCandidates();
  for (const c of list) {
    try {
      const r = spawnSync(c.cmd, c.pre.concat(['-c', 'import sys;print(sys.version_info[0])']), {
        timeout: 5000, windowsHide: true, encoding: 'utf8',
      });
      if (r && !r.error && r.status === 0 && String(r.stdout || '').trim() === '3') return c;
    } catch (e) { /* try the next candidate */ }
  }
  return null;
}

function pythonMissingHelp(candidates) {
  const tried = (candidates || pythonCandidates())
    .map((c) => [c.cmd].concat(c.pre).join(' '))
    .join(', ');
  return 'Python 3 not found (tried: ' + tried + '). Install Python 3.8+ from https://python.org and tick "Add python.exe to PATH".';
}

module.exports = { pythonCandidates, probePython, pythonMissingHelp };
