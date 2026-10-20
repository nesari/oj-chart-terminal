#!/usr/bin/env node
/**
 * Syntax gate — parses every project JS/MJS file as an ES module.
 *
 * Why stdin + --input-type=module instead of `node --check <file>`: the .js
 * files in this repo are browser ES modules, while plain Node treats a .js
 * file as CommonJS unless the nearest package.json says otherwise (and this
 * package is intentionally type-less so Electron/CommonJS scripts keep
 * working). Feeding the source on stdin with an explicit input type makes
 * the check deterministic on every supported Node version.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'vendor', '__pycache__']);
const EXT = new Set(['.js', '.mjs']);
const CONCURRENCY = 8;

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name), out);
    } else if (EXT.has(path.extname(ent.name))) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

function check(file) {
  return new Promise((resolve) => {
    const src = fs.readFileSync(file);
    const child = spawn(process.execPath, ['--input-type=module', '--check'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ file, ok: false, err: String(e) }));
    child.on('close', (code) => resolve({ file, ok: code === 0, err: err.trim() }));
    child.stdin.end(src);
  });
}

async function main() {
  const files = walk(ROOT, []).sort();
  if (!files.length) {
    console.error('[syntax] no JS/MJS files found');
    process.exit(1);
  }
  const failures = [];
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      const r = await check(file);
      if (!r.ok) failures.push(r);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (failures.length) {
    for (const f of failures) {
      console.error('\n[syntax] FAIL ' + path.relative(ROOT, f.file));
      console.error(f.err.split('\n').slice(0, 6).join('\n'));
    }
    console.error(`\n[syntax] ${failures.length}/${files.length} file(s) failed`);
    process.exit(1);
  }
  console.log(`[syntax] OK — ${files.length} JS/MJS files parsed`);
}

main().catch((e) => { console.error('[syntax] ' + (e.stack || e)); process.exit(1); });
