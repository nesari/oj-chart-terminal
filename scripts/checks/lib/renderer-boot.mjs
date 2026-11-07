/**
 * Shared launch helpers for the Electron check harnesses.
 *
 * `smoke-boot.mjs` (the verify gate) and `perf-profile.mjs` (the F8.4
 * measurement tool) both need the same three things: a static server for
 * `src/` (ES modules cannot load over file://), the demo provider on a test
 * port, and the local Electron binary. Keeping that glue in one place means a
 * fix to the boot path (sandbox flags, port waits, Windows tree-kill) applies
 * to both harnesses.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const SRC = path.join(ROOT, 'src');

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

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function electronExe() {
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  const candidates = process.platform === 'win32'
    ? [path.join(dist, 'electron.exe')]
    : process.platform === 'darwin'
      ? [path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')]
      : [path.join(dist, 'electron')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('Electron binary not found under node_modules/electron/dist — run npm install');
}

export function findPython() {
  for (const c of [{ cmd: 'python', prefix: [] }, { cmd: 'python3', prefix: [] }, { cmd: 'py', prefix: ['-3'] }]) {
    const r = spawnSync(c.cmd, [...c.prefix, '--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

export function startStaticServer(port, root = SRC) {
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) {
      res.writeHead(400); res.end('bad request'); return;
    }
    if (pathname === '/') pathname = '/renderer/index.html';
    const file = path.resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + path.sep)) {
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
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export function waitForPort(port, timeoutMs) {
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

export function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch (e) { /* best effort */ }
}
