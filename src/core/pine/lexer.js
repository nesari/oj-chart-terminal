/**
 * Pine lexer (round 74 — roadmap phase 1)
 *
 * Indentation-aware tokenizer, exactly like the official language:
 *  - blocks are opened by INDENT and closed by DEDENT (multiples of 4 spaces)
 *  - a line whose indent is NOT a multiple of 4 (and deeper than the current
 *    block) is a WRAP CONTINUATION of the previous logical line — the lazy
 *    NEWLINE mechanism swallows the break
 *  - comments `//`, single/double-quoted strings with escapes, decimal and
 *    scientific numbers, the full operator table, line splicing of \r\n.
 *
 * @module core/pine/lexer
 */

import { lexError } from './errors.js';
import { toColor } from './types.js';

const KEYWORDS = new Set([
  'if', 'else', 'for', 'to', 'by', 'while', 'var', 'varip', 'switch', 'and', 'or', 'not',
  'true', 'false', 'na', 'break', 'continue', 'type', 'enum', 'method', 'import', 'export',
  /* ROUND224 (TV parity): the v6 once block (first-bar-only execution). */
  'once',
]);

const PUNCT3 = ['===', '!=='];        // (defensive; not real Pine but harmless)
const PUNCT2 = [':=', '=>', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%='];
const PUNCT1 = ['(', ')', '[', ']', ',', '.', ':', '?', '+', '-', '*', '/', '%', '<', '>', '='];

const TYPES = new Set(['int', 'float', 'bool', 'string', 'color', 'line', 'box', 'label', 'table', 'array', 'matrix', 'map']);

function isIdentStart(c) { return /[A-Za-z_]/.test(c); }
function isIdentPart(c) { return /[A-Za-z0-9_]/.test(c); }
function isDigit(c) { return c >= '0' && c <= '9'; }

/**
 * Token: { t, v, line, col } with t ∈
 *   'num' 'str' 'ident' 'kw' 'type' 'op' 'punct' 'newline' 'indent' 'dedent' 'eof'
 * v carries the literal (number value / string content / symbol text).
 */
function tokenize(source) {
  const src = String(source == null ? '' : source).replace(/\r\n?/g, '\n');
  const toks = [];
  const n = src.length;
  let i = 0, line = 1;

  const push = (t, v, col) => toks.push({ t, v, line, col: col == null ? 1 : col });

  /** indentation stack — level 0 always present */
  const indents = [0];
  let atLineStart = true;
  let pendingNewline = false; // NEWLINE is emitted lazily so continuations can swallow it
  let depth = 0;              // () [] nesting — newlines inside are swallowed

  const emitNewline = () => {
    if (pendingNewline) { push('newline', ';', 1); pendingNewline = false; }
  };

  while (i < n) {
    if (atLineStart) {
      // measure indent
      let indent = 0, col = 1;
      let j = i;
      while (j < n) {
        const c = src[j];
        if (c === ' ') { indent++; j++; col++; }
        else if (c === '\t') { indent += 4 - (indent % 4); j++; col++; }
        else break;
      }
      if (j >= n) { i = j; break; } // trailing whitespace-only tail
      if (src[j] === '\n') { i = j + 1; line++; continue; } // blank line
      if (src[j] === '/' && src[j + 1] === '/') {
        // comment-only line: consume to EOL, no newline semantics
        while (j < n && src[j] !== '\n') j++;
        i = j; // the \n is consumed by the normal loop
        continue;
      }
      atLineStart = false;
      if (depth > 0) {
        // implicit line joining inside ()/[]: no INDENT/DEDENT/NEWLINE logic
        i = j;
        continue;
      }
      const cur = indents[indents.length - 1];
      if (indent > cur) {
        if (indent % 4 === 0) { indents.push(indent); push('indent', indent, col); }
        else {
          // wrap continuation: swallow the pending newline of the previous line
          pendingNewline = false;
        }
      } else if (indent < cur) {
        emitNewline();
        while (indents.length > 1 && indents[indents.length - 1] > indent) {
          indents.pop();
          push('dedent', indent, col);
        }
        if (indents[indents.length - 1] !== indent) {
          throw lexError(`Syntax error: inconsistent indentation (${indent} spaces — block levels use multiples of 4)`, line, col);
        }
      } else {
        emitNewline();
      }
      i = j;
      continue;
    }

    const c = src[i];
    if (c === '\n') {
      pendingNewline = true;
      atLineStart = true;
      i++;
      line++;
      continue;
    }
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      /* ROUND224 (TV parity): triple-quoted multiline strings ("""…""" /
         '''…''') — raw newlines allowed inside; escapes match singles. */
      let j, out = '';
      if ((q === '"' && src[i + 1] === '"' && src[i + 2] === '"') ||
          (q === "'" && src[i + 1] === "'" && src[i + 2] === "'")) {
        j = i + 3;
        while (j < n && !(src[j] === q && src[j + 1] === q && src[j + 2] === q)) {
          if (src[j] === '\\' && j + 1 < n) {
            const e = src[j + 1];
            out += e === 'n' ? '\n' : e === 't' ? '\t' : e === '\\' ? '\\' : e === '0' ? '\0' : e;
            j += 2;
            continue;
          }
          if (src[j] === '\n') line++;
          out += src[j];
          j++;
        }
        if (j >= n) throw lexError('Unterminated string literal', line, 1);
        push('str', out, 1);
        i = j + 3;
        continue;
      }
      j = i + 1;
      while (j < n && src[j] !== q) {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === '\\' ? '\\' : e === '0' ? '\0' : e;
          j += 2;
          continue;
        }
        if (src[j] === '\n') throw lexError('Unterminated string literal', line, 1);
        out += src[j];
        j++;
      }
      if (j >= n) throw lexError('Unterminated string literal', line, 1);
      push('str', out, 1);
      i = j + 1;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i;
      while (j < n && isDigit(src[j])) j++;
      if (src[j] === '.' && isDigit(src[j + 1])) { j++; while (j < n && isDigit(src[j])) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (isDigit(src[k])) { k++; while (k < n && isDigit(src[k])) k++; j = k; }
      }
      push('num', parseFloat(src.slice(i, j)), 1);
      /* ROUND197 (legacy int-div): plain digit runs are int literals (`7`
         but not `7.0`/`7e0`) — the parser carries the flag to num nodes. */
      if (/^\d+$/.test(src.slice(i, j))) toks[toks.length - 1].isInt = true;
      i = j;
      continue;
    }
    if (c === '#') {
      // Pine color literal: #RRGGBB / #RGB / #RRGGBBAA
      let j = i + 1;
      while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
      const hex = src.slice(i, j);
      if (j - i - 1 === 3 || j - i - 1 === 6 || j - i - 1 === 8) {
        push('color', hex, 1);
        i = j;
        continue;
      }
      throw lexError(`Invalid color literal '${hex}'`, line, 1);
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(src[j])) j++;
      // consume generic argument like new<box> — the `<` is lexed separately,
      // the parser combines; nothing to do here.
      const word = src.slice(i, j);
      if (KEYWORDS.has(word)) push('kw', word, 1);
      else if (TYPES.has(word) && src[j] !== '(') push('type', word, 1);
      else push('ident', word, 1);
      i = j;
      continue;
    }
    // operators / punctuation
    const three = src.substr(i, 3);
    if (PUNCT3.indexOf(three) >= 0) { push('op', three, 1); i += 3; continue; }
    const two = src.substr(i, 2);
    if (PUNCT2.indexOf(two) >= 0) { push(two === ':=' ? 'op' : 'op', two, 1); i += 2; continue; }
    if (PUNCT1.indexOf(c) >= 0) {
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
      push(c === '(' || c === ')' || c === '[' || c === ']' || c === ',' ? 'punct' : 'op', c, 1);
      i++;
      continue;
    }
    throw lexError(`Unexpected character '${c}'`, line, 1);
  }
  // flush trailing newline + dedents
  if (pendingNewline) { push('newline', ';', 1); pendingNewline = false; }
  while (indents.length > 1) { indents.pop(); push('dedent', 0, 1); }
  push('eof', null, 1);
  return toks;
}

/** small helper for best-effort token column (kept simple: 1) */
export { tokenize };
