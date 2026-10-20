/**
 * Pine parser (round 74 — roadmap phase 1)
 *
 * Token stream -> AST. Supported grammar (v6 subset chosen by the roadmap
 * MVP + the user's real script "786 Zones"):
 *   - script declaration: indicator()/strategy()/library() call
 *   - variable declarations: [var|varip] [type-annot] name = expr
 *     type-annot: int|float|bool|string|color|line|box|label|table,
 *                 box[] / float[] / array<T> / matrix<T> / map<K,V>
 *   - reassignment: name := expr, name += -= *= /= %= expr
 *   - function declarations: name(params) => block  (+ `method` prefix)
 *   - if / else if / else  (statement AND expression form)
 *   - for i = a to b [by s] | while cond | switch
 *   - break / continue
 *   - expressions: ?: (right-assoc), or, and, ==/!=, < <= > >=, + -, * / %,
 *     unary - + not, calls (named args + generic array.new<T>(...)),
 *     member calls (obj.method()), namespace calls (ta.sma), indexing x[n],
 *     tuple declarations [a, b] = f()
 *
 * Every node carries { line } for error reporting.
 *
 * @module core/pine/parser
 */

import { tokenize } from './lexer.js';
import { parseError } from './errors.js';

class Parser {
  constructor(toks, ver) {
    this.toks = toks;
    this.i = 0;
    this.nodeId = 0;
    /* ROUND225 (TV parity): v6 bans [] on literals/constants and direct UDT
       fields — the parser needs the version up front (parse() threads it). */
    this.ver = ver >= 1 && ver <= 6 ? ver : 5;
  }

  nid() { return ++this.nodeId; }

  peek(k) { return this.toks[Math.min(this.i + (k || 0), this.toks.length - 1)]; }
  next() { const t = this.toks[this.i]; if (this.i < this.toks.length - 1) this.i++; return t; }
  at(t, v) { const p = this.peek(); return p.t === t && (v == null || p.v === v); }
  atOp(v) { return this.at('op', v); }
  atPunct(v) { return this.at('punct', v); }
  atKw(v) { return this.at('kw', v); }
  eat(t, v) { if (this.at(t, v)) return this.next(); return null; }
  expect(t, v, what) {
    const p = this.peek();
    if (p.t === t && (v == null || p.v === v)) return this.next();
    throw parseError(`Syntax error: expected ${what || v || t} but found '${p.v == null ? p.t : p.v}'`, p.line, 1);
  }
  skipNewlines() { while (this.at('newline')) this.next(); }
  skipSoft() { // newlines + indents that may wrap a single logical header
    while (this.at('newline') || this.at('indent') || this.at('dedent')) this.next();
  }

  /* ------------------------------------------------------------------ */

  parseScript() {
    const script = { kind: 'script', version: 5, decl: null, body: [], line: 1 };
    this.skipNewlines();
    // //@version=N is threaded by parse() (pineVersionOf) after lexing —
    // the 5 here is only a pre-regex placeholder, not a semantic default.
    while (!this.at('eof')) {
      if (this.at('newline')) { this.next(); continue; }
      const st = this.parseStatement();
      if (st) {
        if (st.kind === 'call' && st.callee && !script.decl &&
            /* ROUND156: v3/v4 study() is a first-class declaration (it used
               to work only by accident of compile.js's generic body[0] check) */
            (st.callee.name === 'indicator' || st.callee.name === 'strategy' || st.callee.name === 'library' || st.callee.name === 'study')) {
          script.decl = st;
        } else {
          script.body.push(st);
        }
      }
      // after a statement: newline (or dedents close the block)
      if (this.at('newline')) this.next();
    }
    return script;
  }

  /** one statement (callers consume the trailing newline) */
  parseStatement() {
    const p = this.peek();
    if (p.t === 'kw') {
      switch (p.v) {
        case 'if': return this.parseIf();
        case 'for': return this.parseFor();
        case 'while': return this.parseWhile();
        case 'switch': return this.parseSwitch();
        /* ROUND224 (TV parity): once + indented block runs on the first bar. */
        case 'once': {
          const p0 = this.next();
          this.skipNewlines();
          const body = this.parseBlock();
          return { kind: 'once', body, line: p0.line };
        }
        case 'break': { this.next(); return { kind: 'break', line: p.line }; }
        case 'continue': { this.next(); return { kind: 'continue', line: p.line }; }
        case 'var': case 'varip': return this.parseVarDecl();
        case 'type': return this.parseTypeDecl();
        case 'enum': return this.parseEnumDecl();
        case 'import': return this.parseImport();
        case 'export': return this.parseExport();
        case 'method': {
          this.next();
          const d = this.parseFunctionDecl(true);
          return d;
        }
        case 'not': case 'true': case 'false': case 'na':
          return { kind: 'expr', expr: this.parseExpr(), line: p.line };
      }
    }
    // function declaration:  name(params) =>  |  name =>
    /* ROUND151: type words (map/array/...) are legal identifiers outside type
       position — real scripts name vars `map`. Anything that is not the
       start of a genuine type annotation routes through ident dispatch. */
    if (p.t === 'type' && !this.isTypeStart(this.i)) p.t = 'ident';
    if (p.t === 'ident') {
      const q = this.peek(1);
      if (q.t === 'punct' && q.v === '(') {
        // could be `f(...) =>` decl — scan to matching paren then check '=>'
        const close = this.matchParen(this.i + 1);
        if (close >= 0 && this.toks[close + 1] && this.toks[close + 1].t === 'op' && this.toks[close + 1].v === '=>') {
          return this.parseFunctionDecl(false);
        }
      } else if (q.t === 'op' && q.v === '=>') {
        return this.parseFunctionDecl(false);
      }
      // typed decl: `int x = ...` / `box[] b = ...` / `array<float> a = ...`
      if (q.t === 'ident' && this.isTypeStart(this.i)) {
        return this.parseVarDecl();
      }
      /* ROUND215: bare `chart.point name = ...` (no var) — mirrors the
         `var chart.point` form from the official docs. */
      if (p.t === 'ident' && p.v === 'chart' && q.t === 'op' && q.v === '.' &&
        this.peek(2) && this.peek(2).v === 'point' &&
        this.peek(3) && this.peek(3).t === 'ident') {
        this.next(); this.next(); this.next(); // chart . point
        const nm = this.next();
        this.expect('op', '=', '=');
        const value = this.parseExpr();
        return { kind: 'decl', kw: null, annot: 'chart.point', name: nm.v, value, line: p.line };
      }
    }
    if (p.t === 'type') {
      // `float res = 0` or generic/array annot: `array<orderBlock> x = ...`
      const q = this.peek(1);
      if (q.t === 'op' && q.v === '<') {
        // generic-annot decl: `array<orderBlock> x = ...` — parseTypeAnnot
        // consumes the type word AND the <T> list from the current token
        const annotTxt = this.parseTypeAnnot();
        const nm = this.expect('ident', null, 'variable name');
        this.expect('op', '=', '=');
        const value = this.parseExpr();
        return { kind: 'decl', kw: null, annot: annotTxt, name: nm.v, value, line: p.line };
      }
      if (q.t === 'ident') return this.parseVarDecl();
    }
    if (p.t === 'punct' && p.v === '[') {
      /* ROUND151: `[a, b] = f()` destructure vs `[a, b]` tuple literal /
         multi-value return (`[nx, array.join(rows, "|")]` as a function
         result — legal TV, used by real scripts). Only the name-list-then-`=`
         shape is a declaration; everything else is an expression. */
      if (this._looksLikeTupleDecl()) return this.parseTupleDecl();
      return { kind: 'expr', expr: this.parseExpr(), line: p.line };
    }
    // plain assignment / reassignment / expression statement
    if (p.t === 'ident') {
      const q = this.peek(1);
      if (q.t === 'op' && q.v === '=') {
        const name = this.next();
        this.next(); // '='
        if (this.atKw('if')) return { kind: 'assign', name: name.v, reassign: false, value: this.parseIfExpr(name.line), line: name.line };
        if (this.atKw('switch')) return { kind: 'assign', name: name.v, reassign: false, value: this.parseSwitch(name.line), line: name.line };
        const value = this.parseExpr();
        // v4-style comma statement: `a = f(), b = g()` — both assigns share the line
        if (this.atPunct(',')) {
          const stmts = [{ kind: 'assign', name: name.v, reassign: false, value, line: name.line }];
          while (this.atPunct(',')) {
            this.next(); // ','
            const nm = this.expect('ident', null, 'identifier');
            this.expect('op', '=', '=');
            stmts.push({ kind: 'assign', name: nm.v, reassign: false, value: this.parseExpr(), line: nm.line });
          }
          return { kind: 'block', body: stmts, line: name.line };
        }
        return { kind: 'assign', name: name.v, reassign: false, value, line: name.line };
      }
      if (q.t === 'op' && ['+=', '-=', '*=', '/=', '%='].indexOf(q.v) >= 0) {
        const name = this.next();
        const opv = this.next().v;
        return { kind: 'assign', name: name.v, reassign: true, op: opv[0], value: this.parseExpr(), line: name.line };
      }
      if (q.t === 'op' && q.v === ':=') {
        // reassignment — declaredness is a RUNTIME question (the variable may
        // live in an enclosing block scope), so no parse-time verdict here
        const name = this.next();
        this.next(); // ':='
        return { kind: 'assign', name: name.v, reassign: true, value: this.parseExpr(), line: name.line };
      }
      /* UDT field reassignment: `obj.field := expr` — the base ident chain
         (z.top / a.b.c) parses as a member expression; catch `ident(.ident)+ :=` */
      if (q.t === 'op' && q.v === '.') {
        const save = this.i;
        const chain = [this.next().v];
        while (this.at('op', '.')) {
          this.next();
          const seg = this.at('ident') || this.at('type') ? this.next().v : null;
          if (seg == null) { this.i = save; break; }
          chain.push(seg);
          const nx = this.peek();
          if (nx.t === 'op' && nx.v === '.') continue;
          break;
        }
        if (chain.length >= 2 && this.at('op', ':=')) {
          this.next(); // ':='
          return { kind: 'fieldassign', path: chain, value: this.parseExpr(), line: p.line };
        }
        /* ROUND216 (TV parity): compound assignment on field paths
           (`t._total += 1`, `p.price += x`) — same operator set as plain
           `name += ...` (line ~184). Falls through to expr otherwise. */
        if (chain.length >= 2 && this.at('op') && ['+=', '-=', '*=', '/=', '%='].indexOf(this.peek().v) >= 0) {
          const opv = this.next().v;
          return { kind: 'fieldassign', path: chain, op: opv[0], value: this.parseExpr(), line: p.line };
        }
        this.i = save; // not a field assign — restore and fall through to expr
      }
    }
    return { kind: 'expr', expr: this.parseExpr(), line: p.line };
  }

  matchParen(startIdx) {
    let depth = 0;
    for (let k = startIdx; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.t === 'punct' && t.v === '(') depth++;
      else if (t.t === 'punct' && t.v === ')') { depth--; if (depth === 0) return k; }
      else if (t.t === 'eof') break;
    }
    return -1;
  }

  isTypeStart(idx) {
    // ident at idx is a TYPE-start when it is a builtin type name followed by
    // an identifier (the declared name)
    const t = this.toks[idx];
    if (!t || t.t !== 'ident' && t.t !== 'type') return false;
    /* ROUND215: dotted `chart.point` annotation (`var chart.point p = ...`,
       per the official lines-and-boxes docs). `chart` alone is not a type. */
    if (t.v === 'chart') {
      const d = this.toks[idx + 1], s = this.toks[idx + 2], nx = this.toks[idx + 3];
      if (!d || d.t !== 'op' || d.v !== '.' || !s || s.v !== 'point') return false;
      if (!nx) return false;
      if (nx.t === 'ident') return true;
      return false;
    }
    const TYPES = ['int', 'float', 'bool', 'string', 'color', 'line', 'box', 'label', 'table', 'array', 'matrix', 'map'];
    if (TYPES.indexOf(t.v) < 0) return false;
    const nx = this.toks[idx + 1];
    if (!nx) return false;
    if (nx.t === 'ident') return true;
    if (nx.t === 'punct' && nx.v === '[') { // box[] x =
      const after = this.toks[idx + 2];
      return after && after.t === 'punct' && after.v === ']';
    }
    if (nx.t === 'op' && nx.v === '<') {
      // array<T> x = — generic over builtin OR UDT (ident) element type.
      // ROUND196: map<K, V> x = takes a comma pair.
      const parts = [this.toks[idx + 2], this.toks[idx + 3], this.toks[idx + 4], this.toks[idx + 5]];
      const isT = (t) => t && (t.t === 'ident' || t.t === 'type');
      if (isT(parts[0]) && parts[1] && parts[1].t === 'op' && parts[1].v === '>') return true;
      if (isT(parts[0]) && parts[1] && parts[1].t === 'punct' && parts[1].v === ',' &&
        isT(parts[2]) && parts[3] && parts[3].t === 'op' && parts[3].v === '>') return true;
      return false;
    }
    return false;
  }

  parseTypeAnnot() {
    // consumes one type annotation STARTING AT THE TYPE WORD; returns text
    let txt = '';
    const t = this.next(); // int/float/... (ident or type token)
    txt += t.v;
    /* ROUND215: dotted `chart.point` annotation. */
    if (t.v === 'chart' && this.at('op', '.')) {
      this.next();
      const seg = this.next();
      txt += '.' + seg.v;
    }
    if (this.atPunct('[')) { this.next(); this.expect('punct', ']', ']'); txt += '[]'; }
    while (this.at('op', '<')) txt += this.parseGenericList();
    return txt;
  }

  /** positioned AT '<' — consumes <T[,U]> plus an optional [] suffix */
  parseGenericList() {
    this.expect('op', '<', '<');
    let txt = '<';
    /* ROUND140: element type may be a dotted name (`array.new<chart.point>()`,
       `array<chart.point> pts`) — consume `a.b.c`, not just the first word. */
    const typeName = () => {
      let n = this.next().v;
      while (this.at('op', '.') && (this.peek(1).t === 'ident' || this.peek(1).t === 'type')) { this.next(); n += '.' + this.next().v; }
      return n;
    };
    txt += typeName();
    while (this.atPunct(',')) { this.next(); txt += ','; txt += typeName(); }
    this.expect('op', '>', '>');
    txt += '>';
    if (this.atPunct('[')) { this.next(); this.expect('punct', ']', ']'); txt += '[]'; }
    return txt;
  }

  /* ROUND195 (library/import, TV parity): `import user/lib/version [as Alias]`
     (path segments are bare idents/numbers; `as` is contextual, not a
     keyword). The version segment is accepted but advisory — the local
     store keeps one copy per library (see library.js). */
  parseImport() {
    const p = this.next(); // 'import'
    const segs = [];
    for (;;) {
      const t = this.peek();
      if (t.t === 'ident' || t.t === 'type' || t.t === 'num') segs.push(String(t.v));
      else {
        throw parseError(`Syntax error: expected a library path segment but found '${t.v == null ? t.t : t.v}'`, t.line, 1);
      }
      this.next();
      /* '/' lexes as 'op' (PUNCT1 non-bracket), not 'punct' — accept both. */
      if (this.at('op', '/') || this.atPunct('/')) { this.next(); continue; }
      break;
    }
    let alias = null;
    const a = this.peek(), b = this.peek(1);
    if (a.t === 'ident' && a.v === 'as' && (b.t === 'ident' || b.t === 'type')) {
      this.next();
      alias = this.next().v;
    }
    return { kind: 'import', path: segs.join('/'), segs, alias, line: p.line };
  }

  /* ROUND195: `export` on a top-level function or variable declaration marks
     it visible to importers. Methods/types/enums/tuples stay loud (v1 only
     exports plain functions and variables, like the engine's UDT gaps). */
  parseExport() {
    const p = this.next(); // 'export'
    if (this.atKw('method') || this.atKw('type') || this.atKw('enum')) {
      throw parseError(`'export ${this.peek().v}' is not supported in this engine version yet (export plain functions and variables)`, p.line, 1);
    }
    if (this.atKw('var') || this.atKw('varip') || this.isTypeStart(this.i)) {
      const d = this.parseVarDecl();
      d.exported = true;
      return d;
    }
    const t0 = this.peek();
    if (t0.t === 'type') {
      // mirror the parseStatement type branches (`export float x = ...`)
      if (this.peek(1).t === 'op' && this.peek(1).v === '<') {
        const annotTxt = this.parseTypeAnnot();
        const nm = this.expect('ident', null, 'variable name');
        this.expect('op', '=', '=');
        const value = this.parseExpr();
        return { kind: 'decl', kw: null, annot: annotTxt, name: nm.v, value, line: p.line, exported: true };
      }
      const d = this.parseVarDecl();
      d.exported = true;
      return d;
    }
    if (t0.t === 'ident') {
      const t1 = this.peek(1);
      if (t1.t === 'punct' && t1.v === '(') {
        // could be `export f(...) =>` decl — same paren scan as parseStatement
        const close = this.matchParen(this.i + 1);
        if (close >= 0 && this.toks[close + 1] && this.toks[close + 1].t === 'op' && this.toks[close + 1].v === '=>') {
          const d = this.parseFunctionDecl(false);
          d.exported = true;
          return d;
        }
      } else if (t1.t === 'op' && t1.v === '=>') {
        const d = this.parseFunctionDecl(false);
        d.exported = true;
        return d;
      }
      if (t1.t === 'ident' && this.isTypeStart(this.i)) {
        const d = this.parseVarDecl();
        d.exported = true;
        return d;
      }
      if (t1.t === 'op' && t1.v === '=') {
        const name = this.next();
        this.next(); // '='
        const value = this.parseExpr();
        return { kind: 'assign', name: name.v, reassign: false, value, line: p.line, exported: true };
      }
    }
    throw parseError(`Syntax error: 'export' must precede a function or variable declaration`, p.line, 1);
  }

  parseVarDecl() {
    const p = this.peek();
    const kw = p.v; // 'var' | 'varip' (guaranteed by caller)
    this.next();
    let annot = null;
    // annotation MAY also lex as plain ident (a UDT name): `pivot p_ivot`-style
    if (this.peek().t === 'type' || (this.peek().t === 'ident' && this.isTypeStart(this.i))) {
      if (this.isTypeStart(this.i)) annot = this.parseTypeAnnot();
      else if (this.peek(1).t === 'ident') annot = this.next().v; // `UserType varName =`
    }
    const name = this._expectName('variable name');
    /* UDT instantiation: `var pivot swingHigh = ...` parses `alerts x` fine,
       but a USER type name lexes as 'ident' — the annot above only triggers
       for builtin TYPES. `var alerts x = ...` hits `alerts` (ident) then `x`
       (ident) — if the token after the annot-ident is ANOTHER ident, consume
       the UDT name as the annotation instead. */
    if (name.t === 'ident' && this.at('ident') && this.peek(1).t === 'op' && this.peek(1).v === '=') {
      // `var <UserType> <name> =` — UserType already consumed as `name`
      annot = name.v;
      const real = this.next();
      this.expect('op', '=', '=');
      const value = this.parseExpr();
      return { kind: 'decl', kw, annot, name: real.v, value, line: p.line };
    }
    this.expect('op', '=', '=');
    let value;
    if (this.atKw('if')) value = this.parseIfExpr(name.line);
    else if (this.atKw('switch')) value = this.parseSwitch(name.line);
    else value = this.parseExpr();
    return { kind: 'decl', kw, annot, name: name.v, value, line: p.line };
  }

  /** ROUND151: true only for the `[a, b] = ...` destructure shape (optional
   *  var/varip, then bare names, then `]` `=`). Anything else starting with
   *  `[` — `[nx, array.join(rows, "|")]`, `[a+1, f(x)]` — is a tuple value. */
  _looksLikeTupleDecl() {
    let k = this.i + 1; // past '['
    const T = this.toks;
    const at = (o) => T[k + o];
    let o = 0;
    if (at(o) && at(o).t === 'kw' && (at(o).v === 'var' || at(o).v === 'varip')) o++;
    for (;;) {
      const t = at(o);
      if (!t || (t.t !== 'ident' && t.t !== 'type')) return false;
      o++;
      const nx = at(o);
      if (nx && nx.t === 'punct' && nx.v === ',') { o++; continue; }
      if (nx && nx.t === 'punct' && nx.v === ']') {
        const eq = at(o + 1);
        return !!eq && eq.t === 'op' && eq.v === '=';
      }
      return false;
    }
  }

  parseTupleDecl() {
    const p = this.expect('punct', '[', '[');
    const names = [];
    let kw = null, annot = null;
    if (this.atKw('var') || this.atKw('varip')) kw = this.next().v;
    /* ROUND151: destructure targets may lex as type words (`[a, map] = f()`). */
    names.push(this._expectName('name'));
    while (this.eat('punct', ',')) names.push(this._expectName('name'));
    this.expect('punct', ']', ']');
    this.expect('op', '=', '=');
    const value = this.parseExpr();
    return { kind: 'tupledecl', kw, names, value, line: p.line };
  }

  /** accept an ident OR a type-word as a declared name (ROUND151). */
  _expectName(what) {
    const t = this.peek();
    if (t.t === 'ident' || t.t === 'type') return this.next();
    return this.expect('ident', null, what);
  }

  /* ============ UDT / enum declarations (Pine v5/v6) ============ */

  /* type Name
   *     field  Type  = default
   *     ...
   * Fields are one-per-line inside the indentation block; the annotation uses
   * the standard parseTypeAnnot forms (int, float, box, MyType, array<x>, ...).
   * Methods (`method f(MyType x) => ...`) stay separate funcdecls. */
  parseTypeDecl() {
    const p = this.expect('kw', 'type', 'type');
    const nameTok = this.expect('ident', null, 'type name');
    const fields = [];
    if (this.at('indent')) {
      this.next(); // consume the indent token
      this.skipNewlines();
      while (!this.at('dedent') && !this.at('eof')) {
        if (this.at('newline')) { this.next(); continue; }
        /* ROUND216: UDT-typed fields (`track _hit`, `dwm_hl hl`) — a bare
           user-type name lexes as ident, so without this it was consumed as
           the FIELD name and every later constructor arg shifted by one
           (KZP: _sd_current silently na -> ".size() on na"). Mirrors the
           var-decl and param UDT fallbacks. */
        let fAnnot = this.isTypeStart(this.i) || this.at('type') ? this.parseTypeAnnot() : null;
        if (fAnnot == null && this.at('ident') && this.peek(1) && this.peek(1).t === 'ident') {
          fAnnot = this.next().v;
        }
        const fName = this.expect('ident', null, 'field name');
        let def = null;
        if (this.eat('op', '=')) def = this.parseExpr();
        fields.push({ name: fName.v, annot: fAnnot, def, line: fName.line });
        if (this.at('newline')) this.next();
      }
      this.eat('dedent');
    }
    return { kind: 'typedecl', name: nameTok.v, fields, line: p.line };
  }

  /* enum Name
   *     MEMBER
   *     OTHER = 5
   * Simple member list (per-line); optional `= int` per member. */
  parseEnumDecl() {
    const p = this.expect('kw', 'enum', 'enum');
    const nameTok = this.expect('ident', null, 'enum name');
    const members = [];
    if (this.at('indent')) {
      this.next(); // consume the indent token
      this.skipNewlines();
      while (!this.at('dedent') && !this.at('eof')) {
        if (this.at('newline')) { this.next(); continue; }
        const mTok = this.at('type') || this.at('ident') ? this.next() : this.expect('ident', null, 'enum member');
        let val = null;
        if (this.eat('op', '=')) val = this.parseExpr();
        members.push({ name: mTok.v, value: val, line: mTok.line });
        if (this.at('newline')) this.next();
      }
      this.eat('dedent');
    }
    return { kind: 'enumdecl', name: nameTok.v, members, line: p.line };
  }

  parseFunctionDecl(isMethod) {
    const p = this.peek();
    const name = this.expect('ident', null, 'function name');
    const params = [];
    if (this.eat('punct', '(')) {
      while (!this.atPunct(')')) {
        let annot = null;
        if (this.isTypeStart(this.i)) annot = this.parseTypeAnnot();
        else if (this.at('ident') && this.peek(1).t === 'ident') annot = this.next().v; // UDT-typed param: `pivot p_ivot`
        else if (this.at('ident') && this.peek(1).t === 'punct' && this.peek(1).v === '[' && this.toks[this.i + 2] && this.toks[this.i + 2].t === 'punct' && this.toks[this.i + 2].v === ']') annot = this.parseTypeAnnot();
        const pn = this.expect('ident', null, 'parameter name');
        let def = null;
        if (this.eat('op', '=')) def = this.parseExpr();
        params.push({ name: pn.v, annot, def, line: pn.line });
        if (!this.atPunct(')')) this.expect('punct', ',', ',');
      }
      this.expect('punct', ')', ')');
    }
    this.expect('op', '=>', '=>');
    // single-line body: `f(x) => expr` — otherwise an indented block
    let body;
    if (this.at('indent')) {
      this.skipNewlines();
      body = this.parseBlock();
    } else {
      const e = this.parseExpr();
      body = { kind: 'block', stmts: [{ kind: 'expr', expr: e, line: p.line }] };
    }
    return { kind: 'funcdecl', name: name.v, params, body, method: !!isMethod, line: p.line };
  }

  /** indented block: INDENT stmts DEDENT */
  parseBlock() {
    this.expect('indent', null, 'an indented block');
    const stmts = [];
    while (!this.at('dedent') && !this.at('eof')) {
      if (this.at('newline')) { this.next(); continue; }
      stmts.push(this.parseStatement());
      if (this.at('newline')) this.next();
    }
    this.eat('dedent');
    return { kind: 'block', stmts };
  }

  /* ---------------------------- control flow --------------------------- */

  parseIfExpr(line) {
    // `if` token is current; used after `x = if ...`
    const p = this.peek();
    this.expect('kw', 'if', 'if');
    const node = this.parseIfRaw(p);
    node.asExpr = true;
    return node;
  }

  parseIfRaw(p) {
    const cond = this.parseExpr();
    this.skipNewlines();
    const then = this.parseBlock();
    let els = null;
    this.skipNewlines();
    if (this.atKw('else')) {
      this.next();
      this.skipNewlines();
      if (this.atKw('if')) {
        const nx = this.next(); // consume 'if'
        els = { kind: 'block', stmts: [this.parseIfRaw(nx)] };
      } else {
        els = this.parseBlock();
      }
    }
    return { kind: 'if', cond, then, els, line: p.line, asExpr: true };
  }

  /* the statement-form parseIf wraps parseIfRaw so both share one impl */
  parseIf() { return this.parseIfStmt(); }
  parseIfStmt() {
    const p = this.expect('kw', 'if', 'if');
    return this.parseIfRaw(p);
  }

  parseFor() {
    const p = this.expect('kw', 'for', 'for');
    /* for-in: `for [index, value] in collection` (arrays) or
       `for key in map` / `for value in array` */
    if (this.atPunct('[')) {
      this.next();
      const names = [this.expect('ident', null, 'loop variable').v];
      while (this.eat('punct', ',')) names.push(this.expect('ident', null, 'loop variable').v);
      this.expect('punct', ']', ']');
      // `in` lexes as ident (not kw) — accept both
      if (!(this.at('kw', 'in') || this.at('ident', 'in') || this.at('type', 'in'))) this.expect('kw', 'in', 'in');
      this.next();
      const iter = this.parseExpr();
      this.skipNewlines();
      const body = this.parseBlock();
      return { kind: 'forin', names, iter, body, line: p.line };
    }
    const v = this.expect('ident', null, 'loop variable');
    if (this.at('kw', 'in') || this.at('ident', 'in') || this.at('type', 'in')) {
      this.next();
      const iter = this.parseExpr();
      this.skipNewlines();
      const body = this.parseBlock();
      return { kind: 'forin', names: [v.v], iter, body, line: p.line };
    }
    this.expect('op', '=', '=');
    const from = this.parseExpr();
    this.expect('kw', 'to', 'to');
    const to = this.parseExpr();
    let by = null;
    if (this.atKw('by')) { this.next(); by = this.parseExpr(); }
    this.skipNewlines();
    const body = this.parseBlock();
    return { kind: 'for', name: v.v, from, to, by, body, line: p.line };
  }

  parseWhile() {
    const p = this.expect('kw', 'while', 'while');
    const cond = this.parseExpr();
    this.skipNewlines();
    const body = this.parseBlock();
    return { kind: 'while', cond, body, line: p.line };
  }

  parseSwitch() {
    const p = this.expect('kw', 'switch', 'switch');
    let subject = null;
    if (!this.at('newline')) subject = this.parseExpr();
    this.skipNewlines();
    this.expect('indent', null, 'an indented switch block');
    const cases = [];
    while (!this.at('dedent') && !this.at('eof')) {
      if (this.at('newline')) { this.next(); continue; }
      let cond = null;
      if (this.at('op', '=>')) cond = { kind: 'default' };
      else cond = this.parseExpr();
      this.expect('op', '=>', '=>');
      let value;
      if (this.at('indent')) value = this.parseBlock();
      else value = { kind: 'block', stmts: [{ kind: 'expr', expr: this.parseExpr(), line: p.line }] };
      cases.push({ cond, value, line: p.line });
      if (this.at('newline')) this.next();
    }
    this.eat('dedent');
    return { kind: 'switch', subject, cases, line: p.line, asExpr: true };
  }

  /* ---------------------------- expressions ---------------------------- */

  parseExpr() { return this.parseTernary(); }

  parseTernary() {
    const cond = this.parseOr();
    if (this.atOp('?')) {
      this.next();
      const a = this.parseTernary();
      this.expect('op', ':', ':');
      const b = this.parseTernary();
      return { kind: 'ternary', cond, a, b, line: cond.line };
    }
    return cond;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.atKw('or')) { const p = this.next(); left = { kind: 'bin', op: 'or', a: left, b: this.parseAnd(), line: p.line }; }
    return left;
  }
  parseAnd() {
    let left = this.parseCmp();
    while (this.atKw('and')) { const p = this.next(); left = { kind: 'bin', op: 'and', a: left, b: this.parseCmp(), line: p.line }; }
    return left;
  }
  parseCmp() {
    let left = this.parseAdd();
    while (this.atOp('==') || this.atOp('!=') || this.atOp('<') || this.atOp('<=') || this.atOp('>') || this.atOp('>=')) {
      const p = this.next();
      left = { kind: 'bin', op: p.v, a: left, b: this.parseAdd(), line: p.line };
    }
    return left;
  }
  parseAdd() {
    let left = this.parseMul();
    while (this.atOp('+') || this.atOp('-')) {
      const p = this.next();
      left = { kind: 'bin', op: p.v, a: left, b: this.parseMul(), line: p.line };
    }
    return left;
  }
  parseMul() {
    let left = this.parseUnary();
    while (this.atOp('*') || this.atOp('/') || this.atOp('%')) {
      const p = this.next();
      left = { kind: 'bin', op: p.v, a: left, b: this.parseUnary(), line: p.line };
    }
    return left;
  }
  parseUnary() {
    if (this.atOp('-')) { const p = this.next(); return { kind: 'un', op: '-', a: this.parseUnary(), line: p.line }; }
    if (this.atOp('+')) { const p = this.next(); return { kind: 'un', op: '+', a: this.parseUnary(), line: p.line }; }
    if (this.atKw('not')) { const p = this.next(); return { kind: 'un', op: 'not', a: this.parseUnary(), line: p.line }; }
    return this.parsePostfix();
  }

  parsePostfix() {
    let node = this.parsePrimary();
    for (;;) {
      if (this.atPunct('(')) {
        node = this.parseCall(node);
      } else if (this.atPunct('[')) {
        const p = this.next();
        // Pine history x[n] and array index a[i] share the syntax; the
        // interpreter disambiguates by the base value kind.
        const idx = this.parseExpr();
        this.expect('punct', ']', ']');
        /* ROUND225 (TV parity): v6 forbids [] on literal values, built-in
           constants and DIRECT UDT fields (use (obj[k]).field). Series
           namespaces (ta/strategy/barstate) and plain variables stay legal. */
        if (this.ver >= 6) {
          const bk = node.kind;
          const isLit = bk === 'num' || bk === 'str' || bk === 'bool' || bk === 'colorlit';
          if (isLit) {
            throw parseError('History ([]) cannot reference literal values in v6 — assign to a variable first', p.line, 1);
          }
          /* NOTE (documented leniency): v6 also bans [] DIRECTLY on UDT
             fields (use (obj[k]).field), but the parser cannot tell a UDT
             instance from a chart.point variable — and point-field history
             (p.price[1]) is pinned R215 parity. So user-var member history
             stays legal; only literals and built-in constants are gated. */
          /* (.all[i] on drawings stays legal — array indexing, not history). */
          const NS_CONST = ['color', 'size', 'shape', 'plot', 'extend', 'scale', 'format', 'location', 'position', 'order', 'xloc', 'yloc', 'dayofweek', 'session', 'ticker', 'text', 'alert', 'barmerge'];
          if (bk === 'member' && node.base && node.base.kind === 'ident' &&
              NS_CONST.indexOf(node.base.name) >= 0) {
            throw parseError('History ([]) cannot reference built-in constants in v6', p.line, 1);
          }
        }
        node = { kind: 'index', base: node, idx, line: p.line };
      } else if (this.at('op', '.')) {
        const p = this.next();
        // property name may lex as a TYPE word: input.float, input.integer, ...
        // ROUND154: or the `enum` keyword: input.enum(...) — member position.
        const name = (this.at('ident') || this.at('type') || (this.at('kw') && this.peek().v === 'enum')) ? this.next() : this.expect('ident', null, 'property name');
        node = { kind: 'member', base: node, name: name.v, line: p.line };
      } else if (this.at('op', '<') && node.kind === 'member' && node.base.kind === 'ident' &&
                 ['array', 'matrix', 'map'].indexOf(node.base.name) >= 0) {
        // generic call: array.new<box>(...) / map.new<string, float>(...) —
        // consume <T[, U]> and remember the type list
        const save = this.i;
        try {
          const txt = this.parseGenericList();
          const m = /^<([^,>]+)/.exec(txt);
          this._pendingElType = m ? m[1] : 'any';
          /* ROUND196: map.new<K, V> needs both sides (elType keeps the first
             for back-compat; elTypes carries the whole list). */
          this._pendingElTypes = txt.slice(1, -1).split(',').map((s) => s.trim()).filter((s) => s.length);
        } catch (e) { this.i = save; this._pendingElType = null; this._pendingElTypes = null; break; }
      } else break;
    }
    return node;
  }

  parseCall(callee) {
    const p = this.expect('punct', '(', '(');
    const args = [];
    while (!this.atPunct(')')) {
      // named arg: ident '=' expr — the name may also lex as a TYPE word
      // (color=, label=, line=, string= ...) or the KEYWORD `type`
      // (input(..., type=input.integer) — legal official arg name since v4)
      const isNamed = (this.at('ident') || this.at('type')) && this.peek(1).t === 'op' && this.peek(1).v === '=';
      const isNamedKw = this.at('kw') && this.peek(1).t === 'op' && this.peek(1).v === '='; // `type=` lexes as kw
      if (isNamed || isNamedKw) {
        const nm = this.next();
        this.next(); // '='
        args.push({ name: nm.v, value: this.parseExpr(), line: nm.line });
      } else if (this.atKw('var') || this.atKw('varip')) {
        // rare `var` arg prefix (e.g. line.new(..., var)) — treat as expr via un
        const t = this.next();
        args.push({ name: null, value: { kind: 'ident', name: t.v, line: t.line }, line: t.line });
      } else {
        args.push({ name: null, value: this.parseExpr(), line: p.line });
      }
      if (!this.atPunct(')')) this.expect('punct', ',', ',');
    }
    this.expect('punct', ')', ')');
    const node = { kind: 'call', callee, args, line: p.line };
    if (this._pendingElType) { node.elType = this._pendingElType; this._pendingElType = null; }
    if (this._pendingElTypes) { node.elTypes = this._pendingElTypes; this._pendingElTypes = null; }
    return node;
  }

  parsePrimary() {
    const p = this.peek();
    if (p.t === 'num') { this.next(); return { kind: 'num', v: p.v, line: p.line, isInt: !!p.isInt }; }
    if (p.t === 'str') { this.next(); return { kind: 'str', v: p.v, line: p.line }; }
    if (p.t === 'color') { this.next(); return { kind: 'colorlit', v: p.v, line: p.line }; }
    if (p.t === 'kw') {
      if (p.v === 'true') { this.next(); return { kind: 'bool', v: true, line: p.line }; }
      if (p.v === 'false') { this.next(); return { kind: 'bool', v: false, line: p.line }; }
      if (p.v === 'na') {
        // na as a FUNCTION call: na(x) — vs the na literal
        const nx = this.peek(1);
        if (nx.t === 'punct' && nx.v === '(') {
          this.next();
          return { kind: 'ident', name: 'na', line: p.line };
        }
        this.next();
        return { kind: 'na', line: p.line };
      }
      if (p.v === 'not') return this.parseUnary();
      // var/varip appearing in expr position (defensive)
      this.next();
      return { kind: 'ident', name: p.v, line: p.line };
    }
    if (p.t === 'type') {
      // a type word used as a value: int(x) cast, array.get(...) etc.
      this.next();
      return { kind: 'ident', name: p.v, line: p.line };
    }
    if (p.t === 'ident') {
      this.next();
      return { kind: 'ident', name: p.v, line: p.line };
    }
    if (p.t === 'punct' && p.v === '(') {
      this.next();
      const e = this.parseExpr();
      this.expect('punct', ')', ')');
      return { kind: 'paren', expr: e, line: p.line };
    }
    if (p.t === 'punct' && p.v === '[') {
      // array literal: [a, b, c] (input options= and friends)
      this.next();
      const items = [];
      while (!this.atPunct(']')) {
        items.push(this.parseExpr());
        if (!this.atPunct(']')) this.expect('punct', ',', ',');
      }
      this.expect('punct', ']', ']');
      return { kind: 'arraylit', items, line: p.line };
    }
    throw parseError(`Syntax error: unexpected '${p.v == null ? p.t : p.v}'`, p.line, 1);
  }
}

/** stamp a stable numeric id on EVERY AST node (site keys, plot identity,
 *  per-node history buffers all key off it) */
function stampIds(script) {
  let next = 1;
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (node.id == null) node.id = next++;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) { for (const x of v) walk(x); }
      else if (v && typeof v === 'object' && !(v instanceof Map)) walk(v);
    }
  };
  walk(script);
}

/**
 * Parse Pine source -> { script, errors }.
 * Never throws: syntax problems are collected as errors.
 */
/* ROUND152: //@version=N threading. The lexer strips `//` comments, so the
   header is read here with a regex (first match wins). Default 5 is a HOUSE
   rule, not TV's (TV defaults to v1) — this engine's baseline semantics are
   v5-ish and flipping the default would break every existing script. */
function pineVersionOf(source) {
  const m = /\/\/@version\s*=\s*(\d+)/.exec(source || '');
  const v = m ? parseInt(m[1], 10) : 5;
  return v >= 1 && v <= 6 ? v : 5;
}
function parse(source) {
  try {
    const toks = tokenize(source);
    const parser = new Parser(toks, pineVersionOf(source));
    const script = parser.parseScript();
    script.version = pineVersionOf(source);
    stampIds(script);
    return { script, errors: [] };
  } catch (e) {
    return {
      script: { kind: 'script', version: pineVersionOf(source), decl: null, body: [] },
      errors: [{
        code: e.code || 'CE10001',
        message: e.message || String(e),
        line: e.line || 0,
        col: e.col || 0,
      }],
    };
  }
}

export { parse, Parser };
