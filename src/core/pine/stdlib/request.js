/**
 * Pine request.* (round 74 — MVP scope, roadmap phase 4)
 *
 * request.security_lower_tf(symbol, timeframe, expression) is the one the
 * user's "786 Zones" needs. The app is fully offline: the renderer supplies
 * a per-bar table of M1 sub-bars (sliced from the M1 history the provider
 * already serves) via env.intrabars[barIndex] = [{time(ms), open, high, low,
 * close, volume}, ...]; the interpreter evaluates `expression` for every
 * sub-bar with the builtin series overridden.
 *
 * Higher-timeframe request.security is NOT in the MVP (per the roadmap) and
 * raises a clear, official-style error instead of failing silently.
 *
 * @module core/pine/stdlib/request
 */

import { NA, isNA } from '../types.js';
import { PineArray } from './array.js';
import { runtimeError } from '../errors.js';

/** timeframe string -> seconds ("1"=60, "60"=3600, "D"=86400, "W"=604800).
 *  ROUND206: seconds charts ("15S" suffix, TV form) — used to parse to 0, so
 *  timeframe.in_seconds("15S") and period round-trips on sub-minute charts
 *  silently gave na. */
function tfSeconds(s) {
  const str = String(s == null ? '' : s).trim();
  if (/^S/i.test(str) && /^\d+/.test(str.slice(1))) return parseInt(str.slice(1), 10);
  const secSfx = /^(\d+)S$/i.exec(str);
  if (secSfx) return parseInt(secSfx[1], 10);
  if (/^\d+$/.test(str)) return parseInt(str, 10) * 60;          // "1" = 1 minute (official)
  const m = /^(\d*)([MHDW])/i.exec(str);
  if (!m) return 0;
  const n = m[1] ? parseInt(m[1], 10) : 1;
  const u = m[2].toUpperCase();
  if (u === 'M') return n * 60;
  if (u === 'H') return n * 3600;
  if (u === 'D') return n * 86400;
  if (u === 'W') return n * 604800;
  return 0;
}

/* ROUND78 perf: plain series identifiers are the overwhelming majority of
   security_lower_tf expressions (786 Zones: `time`, `high`, `low`). For them
   the per-intrabar AST walk + _evalIdent dispatch collapses into a direct
   field read / arithmetic over the sub-bar records. `time` also carries the
   ROUND78 broker-offset shift (wall ms -> true UTC ms), identical to the
   chart `time` series in the interpreter. */
const INTRABAR_SIMPLE = { open: 1, high: 1, low: 1, close: 1, volume: 1 };

/**
 * Evaluate the lower-tf request at the CURRENT bar.
 * `exprNode` is the raw expression AST; the interpreter passes an evaluator.
 */
function securityLowerTf(rt, positional, named, evalExpr) {
  const sym = positional[0];
  const tfArg = positional[1];
  const exprNode = positional[2];
  if (exprNode == null) throw runtimeError('request.security_lower_tf: expression argument is required');
  const intrabars = (rt.env.intrabars && rt.env.intrabars[rt.barIndex]) || null;
  if (!intrabars || !intrabars.length) return new PineArray('float', []);
  const tfSec = tfSeconds(tfArg);
  if (tfSec && tfSec > rt.env.tfSec) {
    throw runtimeError(`request.security_lower_tf: timeframe "${tfArg}" is higher than the chart's own — only lower (or equal) timeframes are valid here`);
  }
  /* ROUND231 (TV parity, v6 reference §timeframe.period): the expression
     evaluates in the REQUESTED (lower-TF) context — same env.tfSec override
     + _runTfSec pin as the HTF path. */
  const prevSec231 = rt.env.tfSec || 60;
  const prevRun231 = rt._runTfSec;
  rt.env.tfSec = tfSec || prevSec231;
  if (prevRun231 == null) rt._runTfSec = prevSec231;
  try {
  if (exprNode.kind === 'ident') {
    const f = exprNode.name;
    if (f === 'time') {
      const off = (rt.env.serverOffSec || 0) * 1000;
      const out = new Array(intrabars.length);
      for (let k = 0; k < intrabars.length; k++) out[k] = intrabars[k].time - off;
      return new PineArray('float', out);
    }
    if (f === 'hl2' || f === 'hlc3' || f === 'ohlc4' || f === 'hlcc4') {
      const out = new Array(intrabars.length);
      for (let k = 0; k < intrabars.length; k++) {
        const s = intrabars[k];
        out[k] = f === 'hl2' ? (s.high + s.low) / 2
          : f === 'hlc3' ? (s.high + s.low + s.close) / 3
          : f === 'ohlc4' ? (s.open + s.high + s.low + s.close) / 4
            : (s.high + s.low + 2 * s.close) / 4;
      }
      return new PineArray('float', out);
    }
    if (INTRABAR_SIMPLE[f]) return new PineArray('float', intrabars.map((sb) => sb[f]));
  }
  const out = [];
  for (const sb of intrabars) {
    // evaluate the expression with the builtin override active
    rt._intrabarOverride = sb;
    try { out.push(evalExpr(exprNode)); } finally { rt._intrabarOverride = null; }
  }
  return new PineArray('float', out);
  } finally { rt.env.tfSec = prevSec231; rt._runTfSec = prevRun231; }
}

export { securityLowerTf, tfSeconds };
