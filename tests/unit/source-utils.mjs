import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Read a source file, and — when it is an aggregator like `manager.js` —
 * append the sibling `manager/*.js` modules created by the F4.3 split.
 * Tests that pin source text keep working without knowing the file layout.
 */
export function readSource(rel) {
  const clean = String(rel).replace(/^[/\\]+/, '');
  const abs = path.resolve(ROOT, clean);
  let out = '';
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) out = fs.readFileSync(abs, 'utf8');
  if (abs.endsWith('.js')) {
    const dir = abs.slice(0, -3);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      for (const name of fs.readdirSync(dir).sort()) {
        const p = path.join(dir, name);
        if (name.endsWith('.js') && fs.statSync(p).isFile()) out += '\n' + fs.readFileSync(p, 'utf8');
      }
    }
  }
  return out.replace(/\r\n/g, '\n');
}
