/**
 * Pine library/import resolution (round 195, TV parity).
 *
 * Offline-first decision (documented): `import user/lib/version` resolves
 * against the LOCAL script store, never the network — the app has no TV
 * session to fetch published libraries with. The version segment is accepted
 * (TV shape) but advisory: the store keeps one copy per library.
 *
 * Resolution order for the lib segment: exact library() title, then
 * case-insensitive title, then saved script name. The import namespace is
 * the `as` alias, else the lib segment (must be a valid identifier).
 *
 * Units form a tree (libraries may import libraries): cycles and depth > 10
 * are compile errors. Only library() scripts can be imported, and `export`
 * only lives in library() scripts.
 *
 * @module core/pine/library
 */

import { parse } from './parser.js';
import { stampLegacyDiv } from './inttype.js';

/* Aliases that would hijack builtin namespaces or script scope (loud). */
const RESERVED_ALIAS = new Set([
  'ta', 'math', 'str', 'color', 'array', 'matrix', 'map', 'line', 'box',
  'label', 'table', 'polyline', 'linefill', 'ticker', 'session', 'strategy',
  'request', 'chart', 'input', 'plot', 'syminfo', 'timeframe', 'barstate',
  'close', 'open', 'high', 'low', 'volume', 'time', 'bar_index',
]);

const MAX_LIB_DEPTH = 10;

function err(message, line) {
  return { code: 'CE10195', message, line: line || 0, col: 1 };
}

/* const-fold the declaration title (same literals declMeta reads). */
function declTitle(decl) {
  if (!decl || decl.kind !== 'call' || !Array.isArray(decl.args)) return null;
  const callee = decl.callee && (decl.callee.name || (decl.callee.kind === 'ident' && decl.callee.name)) || '';
  const named = {};
  const positional = [];
  for (const a of decl.args) {
    if (a && a.name) named[a.name] = a.value;
    else if (a) positional.push(a.value);
  }
  const first = positional[0] || named.title;
  if (first && (first.kind === 'str' || first.kind === 'num' || first.kind === 'bool')) return String(first.v);
  return callee || null;
}

function declCallee(decl) {
  if (!decl || decl.kind !== 'call' || !decl.callee) return '';
  return decl.callee.name || (decl.callee.kind === 'ident' && decl.callee.name) || '';
}

/* script.decl is often null (parseScript only sets it for bare 'call'
   statements; expression-wrapped declarations live in body[0] — compile.js
   unwraps the same way). */
function scriptDecl(script) {
  if (!script) return null;
  if (script.decl) return script.decl;
  const st = (script.body && script.body.length) ? script.body[0] : null;
  if (!st) return null;
  if (st.kind === 'call') return st;
  if (st.kind === 'expr' && st.expr && st.expr.kind === 'call') return st.expr;
  return null;
}

/* The declaration call (indicator()/library()/...) is metadata, not code —
   compile.js strips it from the main body; do the same for library units. */
function stripDecl(script) {
  if (!script || !Array.isArray(script.body) || !script.body.length) return;
  const decl = scriptDecl(script);
  if (!decl) return;
  const st = script.body[0];
  if (st.kind === 'call' && st === decl) script.body = script.body.slice(1);
  else if (st.kind === 'expr' && st.expr === decl) script.body = script.body.slice(1);
}

/* Lightweight probe: is this source an importable library, and under what
   title? Never throws — unparseable sources simply aren't candidates. */
function libTitleOf(source) {
  try {
    const { script, errors } = parse(source);
    if ((errors && errors.length) || !script) return null;
    const decl = scriptDecl(script);
    if (!decl || declCallee(decl) !== 'library') return null;
    return declTitle(decl);
  } catch (e) { return null; }
}

/* Match one import path against store candidates [{title, name}].
   Returns the candidate or null. */
function matchCandidate(segs, candidates) {
  const lib = segs.length >= 2 ? segs[segs.length - 2] : segs[segs.length - 1];
  const list = Array.isArray(candidates) ? candidates : [];
  let hit = list.find((c) => c && c.title === lib) || null;
  if (!hit) {
    const lo = String(lib).toLowerCase();
    hit = list.find((c) => c && typeof c.title === 'string' && c.title.toLowerCase() === lo) || null;
  }
  if (!hit) hit = list.find((c) => c && c.name === lib) || null;
  return hit;
}

/* Convenience resolver for tests / offline callers: { nameOrTitle: source }.
   Returns { resolveImport, listCandidates }. */
function mapResolver(map) {
  const table = map || {};
  const cands = () => Object.keys(table).map((k) => ({ title: k, name: k }));
  const resolveImport = (path) => {
    const segs = String(path || '').split('/');
    const hit = matchCandidate(segs, cands());
    if (!hit) return null;
    return { source: table[hit.title], stamp: 'inline:' + hit.title };
  };
  return { resolveImport, listCandidates: cands };
}

/* Exported top-level names of a library script: funcdecls + var decls with
   the `export` flag. Returns { exports: Map(name -> {kind, node, name}),
   errors: [] } — non-exportable shapes already die in the parser. */
function collectLibExports(script) {
  const exports = new Map();
  const errors = [];
  for (const st of (script && script.body) || []) {
    if (!st || !st.exported) continue;
    if (st.kind === 'funcdecl') {
      if (exports.has(st.name)) errors.push(err(`Duplicate export '${st.name}'`, st.line));
      else exports.set(st.name, { kind: 'func', node: st, name: st.name });
    } else if (st.kind === 'decl' || st.kind === 'assign') {
      if (exports.has(st.name)) errors.push(err(`Duplicate export '${st.name}'`, st.line));
      else exports.set(st.name, { kind: 'var', node: st, name: st.name });
    } else {
      errors.push(err(`Only functions and variables can be exported (got '${st.kind}')`, st.line));
    }
  }
  return { exports, errors };
}

/* Deep scan for import/export statements NOT at the given top-level body
   (TV: both are global-scope only). Returns the first offender or null. */
function nestedImportExport(body) {
  let found = null;
  const walk = (n) => {
    if (!n || found || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if ((n.kind === 'import' || n.kind === 'export' || n.exported) && !n._top) { found = n; return; }
    for (const k of Object.keys(n)) { if (k !== 'line') walk(n[k]); }
  };
  for (const st of body || []) {
    if (!st || typeof st !== 'object') continue;
    if (st.kind === 'import' || st.kind === 'export' || st.exported) {
      st._top = true; // direct child — legal position
      continue;
    }
    walk(st);
    delete st._top;
    if (found) return found;
  }
  // cleanup markers
  for (const st of body || []) { if (st && typeof st === 'object') delete st._top; }
  return found;
}

/* Top-level declared global names of an importer (alias-collision check). */
function topLevelNames(body) {
  const names = new Set();
  for (const st of body || []) {
    if (!st) continue;
    if ((st.kind === 'decl' || st.kind === 'assign' || st.kind === 'funcdecl' ||
      st.kind === 'typedecl' || st.kind === 'enumdecl') && st.name) names.add(st.name);
    else if (st.kind === 'tupledecl' && Array.isArray(st.names)) {
      for (const nm of st.names) { const s = typeof nm === 'string' ? nm : (nm && nm.v); if (s) names.add(s); }
    }
  }
  return names;
}

/* Recursively resolve a script's imports into units.
   resolveImport(path) -> { source, stamp } | null.
   listCandidates() -> [{ title, name }] (for the not-found message).
   chain: titles already being resolved (cycle detection).
   Returns { units: Map(alias -> unit), errors: [] }. */
function resolveLibUnits(script, opts, chain) {
  const errors = [];
  const units = new Map();
  const o = opts || {};
  const resolveImport = o.resolveImport || null;
  const listCandidates = o.listCandidates || (() => []);
  const version = (script && script.version) || 5;
  const isLib = declCallee(scriptDecl(script)) === 'library';

  const usesImportExport = ((script && script.body) || []).some((st) =>
    st && (st.kind === 'import' || st.kind === 'export' || st.exported));
  if (usesImportExport && !(version >= 5)) {
    errors.push(err(`'import'/'export' need //@version=5 or later (this script is v${version})`, 1));
    return { units, errors };
  }
  const bad = nestedImportExport((script && script.body) || []);
  if (bad) {
    errors.push(err(`'${bad.kind === 'import' ? 'import' : 'export'}' must be at global scope`, bad.line));
    return { units, errors };
  }
  if (!isLib) {
    const exp = ((script && script.body) || []).find((st) => st && (st.kind === 'export' || st.exported));
    if (exp) {
      errors.push(err(`'export' is only allowed in library() scripts`, exp.line));
      return { units, errors };
    }
  }
  const imports = ((script && script.body) || []).filter((st) => st && st.kind === 'import');
  if (!imports.length) return { units, errors };
  if ((chain || []).length >= MAX_LIB_DEPTH) {
    errors.push(err(`Import chain too deep (over ${MAX_LIB_DEPTH}) — circular import?`, imports[0].line));
    return { units, errors };
  }
  if (!resolveImport) {
    for (const st of imports) errors.push(err(`Cannot resolve import '${st.path}' — no library source available`, st.line));
    return { units, errors };
  }
  const names = topLevelNames(script.body);
  for (const st of imports) {
    const segs = st.segs || [];
    const libSeg = segs.length >= 2 ? segs[segs.length - 2] : segs[segs.length - 1];
    let alias = st.alias || libSeg;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias || '')) {
      errors.push(err(`Import '${st.path}' needs an identifier alias — add 'as MyAlias'`, st.line));
      continue;
    }
    if (RESERVED_ALIAS.has(alias)) {
      errors.push(err(`Import alias '${alias}' is reserved — pick another with 'as MyAlias'`, st.line));
      continue;
    }
    if (units.has(alias)) {
      errors.push(err(`Duplicate import alias '${alias}'`, st.line));
      continue;
    }
    if (names.has(alias)) {
      errors.push(err(`'${alias}' is already declared in this script — rename the variable or use 'as MyAlias'`, st.line));
      continue;
    }
    let found = null;
    try { found = resolveImport(st.path); } catch (e) { found = null; }
    if (!found || !found.source) {
      const avail = listCandidates().map((c) => `'${(c && c.title) || (c && c.name) || '?'}'`).join(', ');
      errors.push(err(`Cannot resolve import '${st.path}' (no matching library saved locally` +
        (avail ? ` — available: ${avail}` : ' — save the library source as a script first') + `)`, st.line));
      continue;
    }
    let parsed = null;
    try { parsed = parse(found.source); } catch (e) { parsed = null; }
    const ldecl = parsed && parsed.script ? scriptDecl(parsed.script) : null;    if (!parsed || (parsed.errors && parsed.errors.length) || !ldecl) {
      errors.push(err(`Library '${st.path}' does not parse (${((parsed && parsed.errors[0] && parsed.errors[0].message) || 'unknown error').slice(0, 100)})`, st.line));
      continue;
    }
    const lscript = parsed.script;
    if (declCallee(ldecl) !== 'library') {
      errors.push(err(`Cannot import '${st.path}' — only library() scripts can be imported`, st.line));
      continue;
    }
    const title = declTitle(ldecl) || libSeg;
    if ((chain || []).includes(title)) {
      errors.push(err(`Circular import: '${title}' is already being resolved`, st.line));
      continue;
    }
    const sub = resolveLibUnits(lscript, o, (chain || []).concat([title]));
    if (sub.errors.length) { for (const e of sub.errors) errors.push(e); continue; }
    const collected = collectLibExports(lscript);
    if (collected.errors.length) { for (const e of collected.errors) errors.push(e); continue; }
    stripDecl(lscript); // the library() call is metadata, not executable code
    try { stampLegacyDiv(lscript); } catch (e) {} // ROUND197: same legacy-div treatment for imports
    units.set(alias, {
      alias, path: st.path, title, version: st.segs.length >= 3 ? st.segs[st.segs.length - 1] : null,
      script: lscript,
      meta: { title, version: lscript.version || 5, isStrategy: false, declarationSeen: true },
      units: sub.units, exports: collected.exports,
      stamp: found.stamp || ('lib:' + title),
    });
  }
  return { units, errors };
}

export { RESERVED_ALIAS, MAX_LIB_DEPTH, declTitle, declCallee, scriptDecl, stripDecl, libTitleOf, matchCandidate, mapResolver, collectLibExports, resolveLibUnits };
