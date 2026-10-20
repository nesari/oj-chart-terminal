/**
 * Legacy integer division (round 197, TV parity for //@version < 6).
 *
 * TV rule: v3–v5 `int / int` truncates toward zero (7/2=3, -7/2=-3); v6
 * always divides float (7/2=3.5). The engine stores plain JS doubles (no
 * runtime int tags — boxing every number was deemed too risky), so int-ness
 * is inferred STATICALLY at compile time and stamped on `/` nodes
 * (`node.legacyTrunc`); the interpreter truncates only stamped nodes in
 * legacy scripts.
 *
 * Soundness direction: inference is conservative — anything not PROVEN int
 * stays float (today's behaviour, never a new wrong truncation). Known
 * incompleteness (documented): untyped function params/returns, tuple
 * destructuring, and conditional float→int upgrades (TV rejects those
 * retypings outright; we keep the pre-round float result).
 *
 * @module core/pine/inttype
 */

/* Builtin int-typed series/values. */
const INT_IDENTS = new Set(['bar_index', 'time', 'time_close']);
/* Bare calls returning int. */
const INT_CALL_IDENTS = new Set(['int', 'timenow']);
/* Namespaced calls returning int (ns.name). */
const INT_NS_CALLS = new Set([
  'input.int',
  'array.size', 'array.indexof', 'array.lastindexof',
  'array.binary_search', 'array.binary_search_leftmost', 'array.binary_search_rightmost',
  'matrix.rows', 'matrix.columns', 'map.size', 'str.length',
  'ta.barssince', 'ta.highestbars', 'ta.lowestbars',
]);
/* Value-method names returning int (`arr.size()`, `m.rows()`). */
const INT_METHODS = new Set([
  'size', 'rows', 'columns', 'indexof', 'lastindexof',
  'binary_search', 'binary_search_leftmost', 'binary_search_rightmost',
]);
/* Idents that are namespaces (not variables) for call classification. */
const NS_WORDS = new Set([
  'ta', 'math', 'str', 'color', 'array', 'matrix', 'map', 'line', 'box',
  'label', 'table', 'polyline', 'linefill', 'input', 'strategy', 'request',
  'chart', 'syminfo', 'timeframe', 'barstate', 'log',
]);

function isIntAnnot(annot) { return annot === 'int'; }
function isFloatAnnot(annot) {
  return typeof annot === 'string' && annot !== 'int' &&
    /^(float|bool|string|color|line|box|label|table|array|matrix|map)\b/.test(annot);
}

/* Last value-producing statement of a block (for if/switch expression types). */
function blockTail(block) {
  if (!block || block.kind !== 'block' || !Array.isArray(block.stmts)) return null;
  for (let k = block.stmts.length - 1; k >= 0; k--) {
    const st = block.stmts[k];
    if (!st) continue;
    if (st.kind === 'expr') return st.expr;
    if (st.kind === 'decl' || st.kind === 'assign') return { __varRef: st.name };
    if ((st.kind === 'if' || st.kind === 'switch') && st.asExpr !== false) return st;
  }
  return null;
}

function inferExpr(node, env) {
  if (!node || typeof node !== 'object') return false;
  if (node.__varRef) return env.get(node.__varRef) === true;
  switch (node.kind) {
    case 'num': return !!node.isInt;
    case 'bool': case 'str': return false;
    case 'paren': return inferExpr(node.expr, env); // transparent grouping
    case 'ident': return env.get(node.name) === true;
    case 'un': return node.op === '-' || node.op === '+' ? inferExpr(node.a, env) : false;
    case 'bin': {
      if (node.op === '+' || node.op === '-' || node.op === '*') {
        return inferExpr(node.a, env) && inferExpr(node.b, env);
      }
      /* '/' and '%' are int iff both sides are (the '/' stamp itself is
         applied by the statement walker; the TYPE flows the same rule). */
      if (node.op === '/' || node.op === '%') {
        return inferExpr(node.a, env) && inferExpr(node.b, env);
      }
      return false;
    }
    case 'index': return inferExpr(node.base, env); // x[k] keeps the element type
    case 'member': {
      /* Non-call member reads: only strategy.position_size is int-typed
         (everything else — syminfo/timeframe/barstate/enums — is float). */
      if (node.base && node.base.kind === 'ident' && node.base.name === 'strategy' && node.name === 'position_size') return true;
      return false;
    }
    case 'call': return inferCall(node, env);
    case 'if': {
      /* if-expression: int iff both sides int. A missing else yields na,
         and na/anything is na either way (value-safe to call int). */
      if (!node.then) return false;
      const t = inferBlock(node.then, env);
      const e = node.els ? inferBlock(node.els, env) : true;
      return t && e;
    }
    case 'ternary': return inferExpr(node.a, env) && inferExpr(node.b, env);
    case 'switch': {
      if (!Array.isArray(node.cases) || !node.cases.length) return false;
      for (const c of node.cases) {
        if (!c || !inferBlock(c.value, env)) return false;
      }
      return true;
    }
    default: return false;
  }
}

/* Block type for if/switch expressions: the tail value, walked on a scratch
   env so inner declarations don't leak into the caller's flow. */
function inferBlock(block, env) {
  const tail = blockTail(block);
  if (!tail) return false;
  if (tail.kind === 'if' || tail.kind === 'switch') return inferExpr(tail, env);
  if (tail.__varRef) return env.get(tail.__varRef) === true;
  return inferExpr(tail, env);
}

function callName(node) {
  const c = node.callee;
  if (!c) return null;
  if (c.kind === 'ident') return { kind: 'plain', name: c.name };
  if (c.kind === 'member' && c.base && c.base.kind === 'ident') {
    return { kind: NS_WORDS.has(c.base.name) ? 'ns' : 'method', ns: c.base.name, name: c.name };
  }
  return null;
}

function inferCall(node, env) {
  const q = callName(node);
  if (!q) return false;
  if (q.kind === 'plain') {
    if (INT_CALL_IDENTS.has(q.name)) return true;
    /* Legacy bare input(defval, ...) — the defval's type flows through. */
    if (q.name === 'input' && node.args && node.args.length) return inferExpr(node.args[0].value, env);
    return false;
  }
  if (q.kind === 'ns') {
    if (INT_NS_CALLS.has(q.ns + '.' + q.name)) return true;
    return false;
  }
  /* Method on a value: int-returning method names (arr.size(), m.rows()). */
  return INT_METHODS.has(q.name);
}

/* Walk statements, maintain the int env, stamp `/` (+ `/=`) nodes.
   cond=true inside conditional bodies (no float->int upgrades there). */
function walkStmts(stmts, env, cond) {
  for (const st of stmts || []) {
    if (!st || typeof st !== 'object') continue;
    switch (st.kind) {
      case 'decl': {
        /* Stamp the RHS with the pre-update env (runtime truth at this
           point), then publish the name. */
        stampExpr(st.value, env);
        let t;
        if (isIntAnnot(st.annot)) t = true;
        else if (st.annot && isFloatAnnot(st.annot)) t = false;
        else t = !!inferExpr(st.value, env);
        setVar(env, st.name, t, cond);
        break;
      }
      case 'assign': {
        stampExpr(st.value, env);
        if (st.op === '/') {
          /* `/=`: truncate iff the live variable and the RHS are both int;
             the variable stays int only then, else it turns float. */
          const both = env.get(st.name) === true && !!inferExpr(st.value, env);
          if (both) st.legacyTrunc = true;
          setVar(env, st.name, both, cond);
        } else if (st.op === '+' || st.op === '-' || st.op === '*') {
          setVar(env, st.name, (env.get(st.name) === true) && !!inferExpr(st.value, env), cond);
        } else if (st.op === '%') {
          setVar(env, st.name, (env.get(st.name) === true) && !!inferExpr(st.value, env), cond);
        } else {
          setVar(env, st.name, !!inferExpr(st.value, env), cond);
        }
        break;
      }
      case 'tupledecl': {
        /* Element types unknowable statically — conservative float. */
        const names = st.names || [];
        for (const nm of names) {
          const s = (nm && typeof nm === 'object') ? nm.v : nm;
          if (s) setVar(env, s, false, cond);
        }
        stampExpr(st.value, env);
        break;
      }
      case 'funcdecl': {
        /* Fresh scope: int-annotated params seed int, the rest float. */
        const sub = new Map();
        for (const p of st.params || []) {
          sub.set(p.name, isIntAnnot(p.annot));
          if (p.def) stampExpr(p.def, sub);
        }
        if (st.body && st.body.stmts) walkStmts(st.body.stmts, sub, false);
        break;
      }
      case 'expr': stampExpr(st.expr, env); break;
      case 'block': walkStmts(st.body, env, cond); break;
      case 'if': {
        if (st.then) walkBlock(st.then, env);
        if (st.els) walkBlock(st.els, env);
        stampExpr(st.cond, env);
        break;
      }
      case 'for': {
        /* Loop var is always int while the body runs; restore after. */
        const had = env.has(st.name) ? env.get(st.name) : undefined;
        env.set(st.name, true);
        if (st.body) walkBlock(st.body, env);
        if (had === undefined) env.delete(st.name);
        else env.set(st.name, had);
        stampExpr(st.from, env);
        stampExpr(st.to, env);
        if (st.by) stampExpr(st.by, env);
        break;
      }
      case 'forin': {
        /* Element int-ness unknowable — loop vars read float. */
        for (const nm of st.names || []) {
          const had = env.has(nm) ? env.get(nm) : undefined;
          env.set(nm, false);
          if (st.body) walkBlock(st.body, env);
          if (had === undefined) env.delete(nm);
          else env.set(nm, had);
        }
        stampExpr(st.iter, env);
        break;
      }
      case 'while': {
        if (st.body) walkBlock(st.body, env);
        stampExpr(st.cond, env);
        break;
      }
      case 'switch': {
        if (st.subject) stampExpr(st.subject, env);
        for (const c of st.cases || []) {
          if (c && c.cond && c.cond.kind !== 'default') stampExpr(c.cond, env);
          if (c && c.value) walkBlock(c.value, env);
        }
        break;
      }
      default: {
        /* funcdecl bodies already handled; import/export/tupledecl misc. */
        stampExpr(st.value !== undefined ? st.value : st.expr, env);
        break;
      }
    }
  }
}

/* Conditional bodies: additions/downgrades allowed, float->int upgrades not
   (the branch may never run — upgrading would truncate a live float). */
function setVar(env, name, t, cond) {
  if (name == null) return;
  if (cond && t === true && env.get(name) === false) return;
  env.set(name, t);
}

function walkBlock(block, env) {
  if (!block) return;
  if (block.kind === 'block') { walkStmts(block.stmts, env, true); return; }
  walkStmts([block], env, true);
}

/* Stamp every `/` with two int sides (recursively through expressions). */
function stampExpr(node, env) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) stampExpr(x, env); return; }
  if (node.kind === 'bin' && node.op === '/') {
    if (inferExpr(node.a, env) && inferExpr(node.b, env)) node.legacyTrunc = true;
  }
  for (const k of Object.keys(node)) {
    if (k === 'legacyTrunc') continue;
    stampExpr(node[k], env);
  }
}

/* Entry: stamp a whole script (no-op unless version < 6). Idempotent. */
function stampLegacyDiv(script) {
  if (!script || typeof script !== 'object') return;
  if (!((script.version || 5) < 6)) return;
  const env = new Map();
  for (const b of INT_IDENTS) env.set(b, true);
  walkStmts(script.body, env, false);
}

export { stampLegacyDiv, inferExpr };
