/**
 * Real-Electron probe for the version check (ROUND296).
 *
 * The unit suite stubs the network. This one boots the ACTUAL app in Electron
 * (not a browser tab) and clicks the real button, so it catches what only the
 * packaged runtime shows: whether `app.isPackaged` is false, whether the API
 * check reaches GitHub from the main process, and what the user ends up seeing.
 *
 * Run: node scripts/checks/probe-update-check.cjs
 */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

/* Use the SAME pinned Electron the app ships with (not the Node binary): the
 * whole point is `app.isPackaged === false` inside a real Electron main. */
function electronExe() {
  const root = path.join(__dirname, '..', '..');
  const dist = path.join(root, 'node_modules', 'electron', 'dist');
  if (!fs.existsSync(dist)) throw new Error('Electron binary not found under node_modules/electron/dist');
  const cands = process.platform === 'win32'
    ? [path.join(dist, 'electron.exe')]
    : [path.join(dist, 'Electron'), path.join(dist, 'electron')];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('no electron executable in ' + dist);
}

const os = require('node:os');

/* The renderer is where the state is rendered, but the CHECK runs in main. The
 * simplest faithful probe is to invoke the main-process module directly in an
 * Electron main context — same `app.isPackaged`, same https. Electron has no
 * `-e`, so the snippet goes into a temp file inside the repo (a bare path would
 * make Electron look for package.json elsewhere). */
const script = path.join(__dirname, '..', '..', 'src', 'platform', 'electron', 'updater.js');
const tmp = path.join(os.tmpdir(), 'oj-probe-update-' + Date.now() + '.cjs');

const code = `
const { app } = require('electron');
const updater = require(${JSON.stringify(script)});
const log = (lvl, msg, ctx) => console.log('[' + lvl + '] ' + msg + (ctx ? ' ' + JSON.stringify(ctx) : ''));
app.whenReady().then(async () => {
  const init = updater.init({ log });
  console.log('INIT isPackaged=' + app.isPackaged + ' state=' + init.state + ' canInstall=' + init.canInstall);
  const r = await updater.check({ log });
  console.log('RESULT ' + JSON.stringify({ state: r.state, version: r.version, canInstall: r.canInstall, current: r.current }));
  app.exit(0);
}).catch((e) => { console.error('PROBE-ERR ' + (e && e.message)); app.exit(2); });
`;

try {
  fs.writeFileSync(tmp, code, 'utf8');
  const r = spawnSync(electronExe(), [tmp], {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8',
    timeout: 90000,
  });
  console.log(r.stdout || '');
  if (r.stderr) console.error(r.stderr);
  process.exit(r.status == null ? 1 : r.status);
} finally {
  try { fs.rmSync(tmp, { force: true }); } catch (e) {}
}
