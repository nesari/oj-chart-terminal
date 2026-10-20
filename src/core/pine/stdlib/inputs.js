/**
 * Pine input.* (round 74 — roadmap phase 6)
 *
 * Every input.*() call REGISTERS a definition (once per script instance —
 * defs are keyed by call site + a per-call sequence) and returns the CURRENT
 * value (user override from the instance settings, else the default).
 * The renderer builds the Inputs dialog from rt.inputDefs.
 *
 * @module core/pine/stdlib/inputs
 */

import { NA, isNA, toColor, Q_INPUT } from '../types.js';
import { runtimeError } from '../errors.js';

/**
 * rt.inputDefs: [{ id, kind, defval, title, options, min, max, step, group,
 *                  inline, tooltip, confirm }]
 * Values come from rt.inputValues (user settings keyed by input id).
 * Input identity: call-site id + the n-th registration at that site (rare
 * duplicate sites), stable across recompiles of unchanged source.
 */

let seqCounter = 0;

/* ROUND 76 (BUG): options may arrive as a Pine array proxy ({__pineArray,
   items}) straight from the parsed `options=[...]` literal — but defs are
   consumed by the renderer as a PLAIN JS array (settings dialog iterates
   them with for..of / .length). Normalize ONCE here at registration so
   every consumer sees a plain string list; this also resurrects strInput's
   snap-to-valid-option validation, which silently never ran on the proxy
   (a proxy has no .length/.some, so the check was always falsy). */
function normalizeOptions(o) {
  if (o == null) return null;
  const items = (o && o.__pineArray && Array.isArray(o.items)) ? o.items
    : Array.isArray(o) ? o : null;
  if (!items) return null;
  /* ROUND165: enum members (input.string(size.tiny,...)) used to arrive as
     "[object Object]" — the dialog showed garbage and wrote garbage back,
     which then degraded label sizes to 'normal'. Store payloads instead. */
  return items.filter((v) => v != null && !isNA(v))
    .map((v) => (v && v.__pineEnum && v.payload != null) ? String(v.payload) : String(v));
}

function register(rt, site, kind, defval, title, opts) {
  // stable id: site node id + sequence at that site
  site.n = (site.n || 0) + 1;
  const id = 'i' + site.nid + '_' + site.n;
  if (!rt.inputDefs) rt.inputDefs = [];
  if (!rt.inputDefIds) rt.inputDefIds = new Set();
  if (!rt.inputDefIds.has(id)) {
    rt.inputDefIds.add(id);
    rt.inputDefs.push({
      id, kind, defval,
      title: title == null || isNA(title) ? '' : String(title),
      options: normalizeOptions(opts && opts.options),
      min: (opts && opts.min != null) ? opts.min : null,
      max: (opts && opts.max != null) ? opts.max : null,
      step: (opts && opts.step != null) ? opts.step : null,
      group: (opts && opts.group) ? String(opts.group) : '',
      inline: (opts && opts.inline) ? String(opts.inline) : '',
      tooltip: (opts && opts.tooltip) ? String(opts.tooltip) : '',
      /* ROUND222 (TV forward-compat): input.* active= (Jul 2025) is accepted
         and recorded; the dialog does not hide inactive inputs yet (cosmetic
         deviation, documented) — the script itself must never die on it. */
      active: !(opts && opts.active === false),
    });
  }
  // current value = user override -> defval
  const val = (rt.inputValues && rt.inputValues[id] != null) ? rt.inputValues[id] : defval;
  return val;
}

function makeInputFn(rt, site, kind) {
  return function (defval, title, ...rest) {
    // input.* signature: input.bool(defval, title, tooltip, inline, group, confirm) —
    // modern calls pass extras as NAMED args; merge defensively
    let opts = {};
    if (rest.length && rest[0] && typeof rest[0] === 'object' && !isNA(rest[0])) opts = rest[0];
    return register(rt, site, kind, defval, title, opts);
  };
}

/* option list validation for input.string(options=[...]) */
function strInput(rt, site, defval, title, opts) {
  opts = opts || {};
  const options = normalizeOptions(opts.options); // ROUND 76 (BUG): proxy-safe
  const val = register(rt, site, 'string', defval, title, { ...opts, options });
  if (options && options.length && !isNA(val)) {
    /* ROUND165: compare by payload — the value may be the enum object
       (size.small) while options are payload strings ('small'). */
    const vstr = (val && val.__pineEnum && val.payload != null) ? String(val.payload) : String(val);
    const found = options.some((o) => String(o) === vstr);
    if (!found) return options[0]; // official behaviour: value snaps to a valid option
  }
  return val;
}

const BUILTIN_SOURCES = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4'];

function sourceInput(rt, site, defval, title, rest) {
  let opts = {};
  if (rest.length && rest[0] && typeof rest[0] === 'object' && !isNA(rest[0])) opts = rest[0];
  // defval arrives as an already-evaluated builtin series handle ('close' etc.)
  const val = register(rt, site, 'source', defval && defval.__src ? defval.__src : String(defval), title, opts);
  return { __src: String(val) };
}

export { makeInputFn, strInput, sourceInput, BUILTIN_SOURCES, Q_INPUT };
