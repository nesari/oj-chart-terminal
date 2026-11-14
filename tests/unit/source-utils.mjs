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

/* Bracket-aware scan shared by the schema parser. */
function matchBracket(s, openIdx) {
  let d = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '{' || s[i] === '[') d++;
    else if (s[i] === '}' || s[i] === ']') { d--; if (!d) return i; }
  }
  return -1;
}

/* Every `{ ... }` item of an array literal, kept as source text so the
   existing `kind: 'line'` / `key: 'x'` pins keep working. */
function arrayItems(src, start) {
  const end = matchBracket(src, start);
  if (end < 0) return [];
  const items = [];
  let i = start + 1;
  while (i < end) {
    if (src[i] === '{') { const e = matchBracket(src, i); items.push(src.slice(i, e + 1)); i = e + 1; }
    else i++;
  }
  return items;
}

/**
 * Parse the drawing settings SCHEMAS table.
 *
 * ROUND297: there is exactly ONE source of built-in schemas — the
 * `const SCHEMAS = { ... }` table in settings.js. Post-table
 * `SCHEMAS.<tool> = [...]` assignments are reported in `assignments` and must
 * stay empty: they used to silently override the rich table entry (the
 * volprofile/avolprofile bug that dropped Scope).
 *
 * Top-level keys may point at a shared `const NAME = [...]` array (the four
 * arrow-mark tools do); aliases are resolved so callers never see an empty
 * schema. `duplicates` lists keys declared twice in the table itself.
 */
export function schemaTable(rel = 'src/renderer/js/drawing/settings.js') {
  const src = readSource(rel);
  const anchor = src.indexOf('const SCHEMAS = {');
  if (anchor < 0) return { source: src, table: {}, keys: [], duplicates: [], assignments: [], aliases: {} };
  const open = src.indexOf('{', anchor);
  const close = matchBracket(src, open);

  /* const arrays declared BEFORE the table can be shared by several tools. */
  const consts = {};
  for (const m of src.slice(0, anchor).matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*\[/g)) {
    const start = src.indexOf('[', m.index + m[0].length - 1);
    consts[m[1]] = arrayItems(src, start);
  }

  const table = {};
  const keys = [];
  const aliases = {};
  let i = open + 1;
  while (i < close) {
    const rest = src.slice(i, i + 400);
    const arr = /^\s*([a-zA-Z0-9_]+)\s*:\s*\[/.exec(rest);
    const ref = /^\s*([a-zA-Z0-9_]+)\s*:\s*([A-Za-z0-9_]+)\s*,/.exec(rest);
    if (arr) {
      const start = src.indexOf('[', i + arr[0].length - 1);
      table[arr[1]] = arrayItems(src, start);
      keys.push(arr[1]);
      i = matchBracket(src, start) + 1;
      continue;
    }
    if (ref && Object.prototype.hasOwnProperty.call(consts, ref[2])) {
      table[ref[1]] = consts[ref[2]];
      aliases[ref[1]] = ref[2];
      keys.push(ref[1]);
      i += ref[0].length;
      continue;
    }
    i++;
  }

  const duplicates = keys.filter((k, idx) => keys.indexOf(k) !== idx);
  const assignments = [...src.matchAll(/SCHEMAS\.([a-zA-Z0-9_]+)\s*=/g)].map((m) => m[1]);
  return { source: src, table, keys, duplicates, assignments, aliases };
}
