#!/usr/bin/env node
/**
 * Import graph gate — every relative `import`/`export ... from '...'` and
 * dynamic `import('...')` must resolve to a real file.
 *
 * The renderer/core layers are a static ES-module graph with no bundler, so
 * a stale path is a runtime 404 (blank app), not a build error. This check
 * catches that class of breakage without executing any module.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'vendor', '__pycache__']);
const EXT = new Set(['.js', '.mjs']);

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

const PATTERNS = [
  /(?:^|\n)[ \t]*import[ \t]+(?:[^'";]*?[ \t]+from[ \t]*)?['"]([^'"]+)['"]/g,
  /(?:^|\n)[ \t]*export[ \t]+(?:[^'";]*?[ \t]+from[ \t]*)['"]([^'"]+)['"]/g,
  /(?:^|\n)[ \t]*import[ \t]*\([ \t]*['"]([^'"]+)['"][ \t]*\)/g,
];

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

function resolveFile(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, base + '.js', base + '.mjs', path.join(base, 'index.js')];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch (e) { /* try next */ }
  }
  return null;
}

function main() {
  const files = walk(ROOT, []).sort();
  const missing = [];
  let imports = 0;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const spec = m[1];
        if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // package/node: specifier
        imports++;
        if (!resolveFile(file, spec)) {
          missing.push({ file, line: lineOf(src, m.index), spec });
        }
      }
    }
  }
  if (missing.length) {
    for (const m of missing) {
      console.error(`[imports] FAIL ${path.relative(ROOT, m.file)}:${m.line} -> ${m.spec}`);
    }
    console.error(`\n[imports] ${missing.length} unresolved of ${imports} relative imports`);
    process.exit(1);
  }
  console.log(`[imports] OK — ${imports} relative imports across ${files.length} modules`);
}

try { main(); } catch (e) { console.error('[imports] ' + (e.stack || e)); process.exit(1); }
