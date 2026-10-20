/**
 * Pine engine entry point (round 74)
 *
 * compile(source) -> { ok, errors, meta, createInstance(opts) }
 *   meta: { title, overlay, maxCounts, declarationSeen, version } (ROUND152)
 *   createInstance({ inputValues, serverOffSec, tfSec, mintick, symbol, dry })
 *     -> PineRuntime  (interpreter.js)
 *
 * The dry-pass collects input definitions without bars: a synthetic single
 * bar with barstate.islast=false lets the top-level input.* calls register
 * while every drawing branch stays off.
 *
 * @module core/pine/compile
 */

import { parse } from './parser.js';
import { PineRuntime } from './interpreter.js';
import { PineError } from './errors.js';
import { resolveLibUnits, mapResolver } from './library.js';
import { stampLegacyDiv } from './inttype.js';

function declMeta(decl) {
  const meta = { title: 'Pine Script', overlay: false, maxCounts: null, declarationSeen: false, isStrategy: false, strategy: null };
  if (!decl || decl.kind !== 'call' || !decl.args) return meta;
  meta.declarationSeen = true;
  const callee = decl.callee && decl.callee.kind === 'ident' ? decl.callee.name : (decl.callee && decl.callee.name) || '';
  meta.isStrategy = callee === 'strategy';
  const named = {};
  const positional = [];
  for (const a of decl.args) {
    if (a.name) named[a.name] = a.value;
    else positional.push(a.value);
  }
  const evalConst = (node) => {
    if (!node) return undefined;
    if (node.kind === 'str') return node.v;
    if (node.kind === 'num') return node.v;
    if (node.kind === 'bool') return node.v;
    return undefined;
  };
  const t = positional[0] ? evalConst(positional[0]) : (named.title ? evalConst(named.title) : undefined);
  if (t != null) meta.title = String(t);
  /* ROUND217 (TV parity): overlay is the 3rd positional (title, shorttitle,
     overlay, ...) in indicator()/strategy() — KZP passes `true` positionally
     and used to land in a sub-pane like RSI. Named wins when both present. */
  const posOv = positional[2] ? evalConst(positional[2]) : undefined;
  const ov = named.overlay ? evalConst(named.overlay) : posOv;
  if (ov != null) meta.overlay = !!ov;
  /* ROUND222 (TV forward-compat): newer declaration params must never kill a
     script — the decl call is stripped from the body (never executed), so
     unknown names were already silently dropped here. Now the drop is
     EXPLICIT and observable: every named param we do not consume lands in
     meta.ignoredParams (the renderer Log.debug's it, R221 pattern), and the
     node suite pins the full v6 param list. `timeframe=`/`timeframe_gaps=`
     are recorded too but NOT executed yet (chart-TF run; real MTF-decl is
     R226) — a documented deviation, not a silent one anymore. */
  const consumed = new Set(['title', 'shorttitle', 'overlay',
    'max_boxes_count', 'max_lines_count', 'max_labels_count',
    'max_polylines_count', 'max_bars_back',
    'initial_capital', 'default_qty_value', 'default_qty_type', 'pyramiding',
    'commission_value', 'commission_type', 'currency', 'margin_long',
    'margin_short', 'process_orders_on_close', 'close_entries_rule',
    'use_bar_magnifier', 'calc_on_every_tick', 'calc_on_order_fills',
    /* ROUND236: dynamic_requests is UNDERSTOOD (recorded, not ignored) —
       explicit false + local-scope request.* calls stay lenient (they run)
       but observable (meta.localRequests + renderer debug). */
    'dynamic_requests']);
  meta.ignoredParams = Object.keys(named).filter((k) => !consumed.has(k));
  /* ROUND226 (TV parity): declaration timeframe= runs the script on HTF
     buckets (the renderer resolves the id — core only records the raw
     string; "" means the chart TF). timeframe_gaps stays accept-ignored. */
  const tfRaw = named.timeframe ? evalConst(named.timeframe) : undefined;
  meta.timeframe = (typeof tfRaw === 'string' && tfRaw.trim() !== '') ? tfRaw.trim() : null;
  if (meta.timeframe) meta.ignoredParams = meta.ignoredParams.filter((k) => k !== 'timeframe');
  /* ROUND236: explicit dynamic_requests only (no invented defaults: v5 TV
     defaults false, v6 automatic — the engine always runs dynamically). */
  const drRaw = named.dynamic_requests ? evalConst(named.dynamic_requests) : undefined;
  meta.dynamicRequests = (typeof drRaw === 'boolean') ? drRaw : undefined;
  const counts = {};
  for (const k of ['max_boxes_count', 'max_lines_count', 'max_labels_count', 'max_polylines_count', 'max_bars_back']) {
    if (named[k] && named[k].kind === 'num') counts[k] = named[k].v;
  }
  /* ROUND225 (TV parity): drawing caps default 50 like TV (were 500) and
     clamp to the official 1..500 range (polyline 1..100); the store GCs the
     oldest past the cap (unchanged machinery). */
  const clampCap = (v, dflt, max) => {
    if (v == null || !isFinite(v)) return dflt;
    return Math.min(max, Math.max(1, Math.trunc(v)));
  };
  meta.maxCounts = {
    line: clampCap(counts.max_lines_count, 50, 500),
    box: clampCap(counts.max_boxes_count, 50, 500),
    label: clampCap(counts.max_labels_count, 50, 500),
    polyline: clampCap(counts.max_polylines_count, 50, 100),
  };
  if (counts.max_bars_back) meta.maxBarsBack = Math.min(25000, Math.max(100, counts.max_bars_back));
  /* ROUND171 (phase 2a: backtester): static strategy() account settings —
     const literals only (input-driven settings keep engine defaults;
     documented). */
  if (meta.isStrategy) {
    const sv = (k) => (named[k] ? evalConst(named[k]) : undefined);    /* Member-node enums (default_qty_type=strategy.percent_of_equity):
       evalConst only folds literals — map the known strategy enums here. */
    const svMember = (k) => {
      const n = named[k];
      if (!n || n.kind !== 'member') return undefined;
      let dotted = n.name || '';
      let b = n.base;
      while (b && b.kind === 'member') { dotted = (b.name || '') + '.' + dotted; b = b.base; }
      if (b && b.kind === 'ident') dotted = b.name + '.' + dotted;
      const map = {
        'strategy.fixed': 'fixed', 'strategy.cash': 'cash',
        'strategy.percent_of_equity': 'percent', fixed: 'fixed', cash: 'cash', percent: 'percent',
        'strategy.commission.percent': 'percent', 'strategy.commission.cash_per_contract': 'cash_per_contract',
        'strategy.commission.cash_per_order': 'cash_per_order',
      };
      if (map[dotted] !== undefined) return map[dotted];
      /* ROUND206 (TV parity): currency=currency.GBP folded into the broker
         cfg (evalConst only folds literals, so the member form used to land
         as undefined and the account silently ran as USD). */
      if (dotted === 'currency.NONE') return 'NONE';
      const cm = /^currency\.([A-Za-z]{3})$/.exec(dotted);
      if (cm) return cm[1].toUpperCase();
      return undefined;
    };
    meta.strategy = {
      initial_capital: sv('initial_capital'),
      default_qty_value: sv('default_qty_value'),
      pyramiding: sv('pyramiding'),
      commission_value: sv('commission_value'),
      currency: sv('currency') || svMember('currency'),
      /* ROUND213 (TV parity): margin_long/margin_short — margin requirement
         as % of position notional (default 100 = no leverage). */
      margin_long: sv('margin_long'),
      margin_short: sv('margin_short'),
      /* ROUND212 (TV parity): process_orders_on_close — market orders fill
         at the signal bar's close instead of the next bar's open. */
      process_orders_on_close: sv('process_orders_on_close'),
      /* ROUND213 (TV parity): margin_long/margin_short — margin requirement
         as % of position notional (default 100 = no leverage). */
      margin_long: sv('margin_long'),
      margin_short: sv('margin_short'),
      /* ROUND187: FIFO (default) vs ANY exit matching (TV docs). */
      close_entries_rule: sv('close_entries_rule'),
      /* ROUND192: Bar Magnifier — intrabar fills from lower-TF data. */
      use_bar_magnifier: sv('use_bar_magnifier'),
      default_qty_type: sv('default_qty_type') || svMember('default_qty_type'),
      commission_type: sv('commission_type') || svMember('commission_type'),
    };
    /* ROUND198 (tick model): recalculation flags — calc_on_every_tick=false
       (the strategy default) recalculates only at bar close; fills still
       evaluate per tick. calc_on_order_fills defaults true (fills always run
       before the body, so post-fill state is always visible). */
    const ce = sv('calc_on_every_tick');
    meta.calcEveryTick = ce !== undefined ? !!ce : false;
    const co = sv('calc_on_order_fills');
    meta.calcOnOrderFills = co !== undefined ? !!co : true;
  } else {
    /* Indicators (and study/libraries) recalculate live by default. */
    const lit = named.calc_on_every_tick ? evalConst(named.calc_on_every_tick) : undefined;
    meta.calcEveryTick = lit !== undefined ? !!lit : true;
    meta.calcOnOrderFills = true;
  }
  return meta;
}

function compile(source, opts) {
  const { script, errors } = parse(source);
  if (errors && errors.length) {
    return { ok: false, errors, meta: null, source, createInstance: null };
  }
  const declNode = (st) => {
    // parseStatement wraps expression statements as {kind:'expr'} — unwrap
    if (!st) return null;
    if (st.kind === 'call') return st;
    if (st.kind === 'expr' && st.expr && st.expr.kind === 'call') return st.expr;
    return null;
  };
  const d = declNode(script.body.length ? script.body[0] : null) || declNode(script.decl);
  if (d && !script.decl) script.decl = d;
  if (script.decl) script.body = script.body.filter((st, idx) => !(idx === 0 && st.kind === 'expr' && st.expr === script.decl));
  const meta = declMeta(script.decl);
  /* ROUND152: thread the //@version header (parse() already resolved it) so
     the runtime can gate version-specific semantics (v6 bool strictness). */
  meta.version = script.version >= 1 && script.version <= 6 ? script.version : 5;
  /* ROUND142 (docs: Plots): plot()/plotshape()/plotchar()/plotarrow()/fill()/hline()/
     bgcolor()/barcolor()/plotcandle()/plotbar() are GLOBAL-scope only — inside an
     if/for/while/switch or a user function TradingView refuses to compile. */
  const GLOBAL_ONLY = new Set(['plot', 'plotshape', 'plotchar', 'plotarrow', 'fill', 'hline', 'bgcolor', 'barcolor', 'plotcandle', 'plotbar']);
  const scopeErrors = [];
  const scan = (n, nested) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) scan(x, nested); return; }
    let inner = nested;
    if (n.kind === 'if' || n.kind === 'for' || n.kind === 'forin' || n.kind === 'while' || n.kind === 'switch' || n.kind === 'funcdecl') inner = true;
    if (n.kind === 'call' && nested && n.callee && n.callee.kind === 'ident' && GLOBAL_ONLY.has(n.callee.name)) {
      scopeErrors.push({ code: 'CE10002', message: `Cannot use '${n.callee.name}' in local scope — it must be called from the global scope`, line: n.line || 0, col: 1 });
    }
    for (const k of Object.keys(n)) { if (k !== 'line') scan(n[k], inner); }
  };
  scan(script.body, false);
  if (scopeErrors.length) return { ok: false, errors: scopeErrors, meta: null, source, createInstance: null };
  /* ROUND236 (TV parity, observability only): count request.* calls sitting
     in a LOCAL scope (if/for/while/switch/funcdecl body, ternary branches).
     With explicit dynamic_requests=false TV rejects these at compile; the
     engine stays lenient (they run — R226 machinery) but records the count
     in meta.localRequests so the renderer debug-logs it (R221 pattern).
     Bare v4 security() counts too; the main-unit body only (libraries carry
     their own declarations). Never a compile error here. */
  let localRequests = 0;
  const reqName = (n) => {
    if (!n || n.kind !== 'call' || !n.callee) return null;
    const c = n.callee;
    if (c.kind === 'member' && c.base && c.base.kind === 'ident' && c.base.name === 'request') return 'request.' + (c.name || '');
    if (c.kind === 'ident' && c.name === 'security') return 'security';
    return null;
  };
  const scanReq = (n, nested) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) scanReq(x, nested); return; }
    if (n.kind === 'ternary') {
      scanReq(n.cond, nested);
      scanReq(n.a, true);
      scanReq(n.b, true);
      return;
    }
    let inner = nested;
    if (n.kind === 'if' || n.kind === 'for' || n.kind === 'forin' || n.kind === 'while' || n.kind === 'switch' || n.kind === 'funcdecl') inner = true;
    if (nested && reqName(n)) localRequests++;
    for (const k of Object.keys(n)) { if (k !== 'line') scanReq(n[k], inner); }
  };
  try { scanReq(script.body, false); } catch (e) {}
  meta.localRequests = localRequests;
  /* ROUND197 (legacy int-div): static int-typing stamps truncating `/`
     nodes — inside stampLegacyDiv, which no-ops for version>=6. Runs before
     import resolution so library units get the same treatment below. */
  try { stampLegacyDiv(script); } catch (e) {}
  /* ROUND195 (library/import): resolve `import` statements against the given
     sources (opts.resolveImport, or the opts.libraries name->source map).
     Failures are compile errors — the editor strip and the chart error state
     surface them like any other CE. */
  const o = opts || {};
  let resolver = o.resolveImport || null;
  let listCandidates = o.listCandidates || null;
  if (!resolver && o.libraries) {
    const wrapped = mapResolver(o.libraries);
    resolver = wrapped.resolveImport;
    listCandidates = listCandidates || wrapped.listCandidates;
  }
  const libRes = resolveLibUnits(script, { resolveImport: resolver, listCandidates: listCandidates || (() => []) }, []);
  if (libRes.errors.length) return { ok: false, errors: libRes.errors, meta: null, source, createInstance: null };
  const libUnits = libRes.units;
  if (!meta.declarationSeen) {
    return {
      ok: false,
      /* ROUND156: study() named (v3/v4 scripts start with it) */
      errors: [{ code: 'CE10001', message: 'The script must start with an indicator(), strategy(), library() or study() declaration call', line: 1, col: 1 }],
      meta: null, source, createInstance: null,
    };
  }
  const createInstance = (opts) => {
    const rt = new PineRuntime(script, meta, Object.assign({}, opts || {}, { libUnits }));
    return rt;
  };
  /** collect input defs without data (synthetic neutral bar, outputs off) */
  const collectInputs = (opts) => {
    const rt = createInstance(Object.assign({ dry: true }, opts, {
      inputValues: {},
    }));
    // one synthetic bar far in the past with neutral values
    rt.bars = [{ time: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 }];
    rt.totalBars = 1;
    try {
      rt.runBar(0, false);
    } catch (e) {
      // input collection is best-effort; a script that cannot even run its
      // declaration scope dry will report the real error at the real run
      return { ok: false, error: e instanceof PineError ? e.toJSON() : { code: 'RE', message: String(e && e.message || e) }, runtime: rt };
    }
    return { ok: true, inputs: rt.inputDefs, runtime: rt };
  };
  return { ok: true, errors: [], meta, source, createInstance, collectInputs };
}

/* ROUND241 (TV parity): strategy-vs-indicator identity for the Indicators
   dialog — the single source of truth next to declMeta. compile() reads the
   FIRST body statement as the declaration, so this skips blanks, the version
   header (a line comment) and all comments, then checks whether that first
   code line opens a strategy( call. Comment stripping is string-aware, so a
   URL or a block opener inside a literal cannot swallow the declaration. */
function stripPineComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let inStr = false;
  while (i < n) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < n) { out += src[i + 1]; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && i + 1 < n && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && i + 1 < n && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && i + 1 < n && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i = Math.min(n, i + 2);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function isStrategySource(source) {
  if (source == null) return false;
  let code = '';
  try { code = stripPineComments(String(source)); } catch (e) { return false; }
  code = code.replace(/^\uFEFF/, '');
  const lines = code.split('\n');
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) continue;
    return /^strategy\s*\(/.test(t);
  }
  return false;
}

export { compile, isStrategySource };
