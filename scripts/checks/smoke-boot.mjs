#!/usr/bin/env node
/**
 * Boot smoke test — the end-to-end gate for `npm run verify`.
 *
 * 1. serves src/ over localhost (ES modules need http, not file://)
 * 2. starts provider/demo.py on a test port
 * 3. launches the renderer in a hidden Electron window (no Playwright needed)
 * 4. logs in to the demo server and asserts the chart shell booted
 *
 * Ports are configurable via SMOKE_WEB_PORT / SMOKE_WS_PORT because the app
 * accepts `?ws=host:port` (see app.js) — the defaults match the original
 * review harness (8888 / 8899) and never touch the real 8777 provider.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const WEB_PORT = Number(process.env.SMOKE_WEB_PORT || 8888);
const WS_PORT = Number(process.env.SMOKE_WS_PORT || 8899);
const SHOT = path.join(ROOT, 'docs', '_smoke.png');
const HARNESS = path.join(ROOT, 'scripts', 'checks', 'smoke-electron.cjs');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 90000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pine': 'text/plain; charset=utf-8',
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function electronExe() {
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  const candidates = process.platform === 'win32'
    ? [path.join(dist, 'electron.exe')]
    : process.platform === 'darwin'
      ? [path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')]
      : [path.join(dist, 'electron')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('Electron binary not found under node_modules/electron/dist — run npm install');
}

function findPython() {
  for (const c of [{ cmd: 'python', prefix: [] }, { cmd: 'python3', prefix: [] }, { cmd: 'py', prefix: ['-3'] }]) {
    const r = spawnSync(c.cmd, [...c.prefix, '--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

function startStaticServer() {
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) {
      res.writeHead(400); res.end('bad request'); return;
    }
    if (pathname === '/') pathname = '/renderer/index.html';
    const file = path.resolve(SRC, '.' + pathname);
    if (file !== SRC && !file.startsWith(SRC + path.sep)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(WEB_PORT, '127.0.0.1', () => resolve(server));
  });
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch (e) { /* best effort */ }
}

async function main() {
  if (!fs.existsSync(HARNESS)) throw new Error('missing harness: ' + HARNESS);
  const py = findPython();
  if (!py) throw new Error('no Python interpreter found (tried python, python3, py -3)');

  let server = null;
  let provider = null;
  let electron = null;
  try {
    server = await startStaticServer();
    console.log(`[smoke] serving src/ on http://127.0.0.1:${WEB_PORT}`);

    provider = spawn(py.cmd, [...py.prefix, '-u', path.join(ROOT, 'provider', 'demo.py')], {
      cwd: ROOT,
      env: { ...process.env, MT5_WS_PORT: String(WS_PORT), PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let providerErr = '';
    provider.stderr.on('data', (d) => { providerErr += d; });
    provider.stdout.on('data', () => { /* drain */ });
    provider.on('error', (e) => { providerErr += String(e); });

    if (!(await waitForPort(WS_PORT, 15000))) {
      throw new Error(`demo provider did not open port ${WS_PORT}\n${providerErr.slice(-2000)}`);
    }
    console.log(`[smoke] demo provider ready on ws://127.0.0.1:${WS_PORT}`);

    const url = `http://127.0.0.1:${WEB_PORT}/renderer/index.html?ws=127.0.0.1:${WS_PORT}`;
    /* ROUND275 — CI runs Electron as a normal user on Linux, where the
       chrome-sandbox helper is not setuid; without --no-sandbox the browser
       process aborts before loading the page. Windows/macOS keep the sandbox. */
    const electronArgs = [HARNESS];
    if (process.platform === 'linux' && process.env.SMOKE_NO_SANDBOX !== '0') {
      electronArgs.unshift('--no-sandbox');
    }
    electron = spawn(electronExe(), electronArgs, {
      cwd: ROOT,
      env: { ...process.env, SMOKE_URL: url, SMOKE_OUT: SHOT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    electron.stdout.on('data', (d) => { out += d; });
    electron.stderr.on('data', (d) => { err += d; });

    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        killTree(electron);
        reject(new Error(`smoke harness timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);
      electron.on('error', (e) => { clearTimeout(timer); reject(e); });
      electron.on('close', (c) => { clearTimeout(timer); resolve(c); });
    });

    const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith('SMOKE_RESULT='));
    if (!line) {
      throw new Error(`harness produced no result (exit ${code})\n--- stdout ---\n${out.slice(-3000)}\n--- stderr ---\n${err.slice(-3000)}`);
    }
    const result = JSON.parse(line.slice('SMOKE_RESULT='.length));

    if (result.errors && result.errors.length) {
      console.error('[smoke] console errors:');
      for (const e of result.errors.slice(0, 20)) console.error('  - ' + e);
    }
    if (result.failedRequests && result.failedRequests.length) {
      console.error('[smoke] failed requests:');
      for (const f of result.failedRequests.slice(0, 20)) console.error(`  - ${f.status} ${f.url}`);
    }

    if (!result.ok || code !== 0) {
      console.error('[smoke] FAIL ' + JSON.stringify({
        appVisible: result.appVisible,
        loginHidden: result.loginHidden,
        canvases: result.canvases,
        bars: result.bars,
        connLabel: result.connLabel,
        error: result.error,
      }));
      process.exitCode = 1;
      return;
    }
    console.log(`[smoke] OK — app visible, login hidden, ${result.bars} bar(s), ${result.canvases} canvas(es), 0 console errors`);
    if (fs.existsSync(SHOT)) console.log('[smoke] screenshot: ' + path.relative(ROOT, SHOT));
  } finally {
    killTree(electron);
    killTree(provider);
    if (server) await new Promise((r) => server.close(r));
  }
}

main().catch((e) => {
  console.error('[smoke] ' + (e.stack || e));
  process.exit(1);
});
