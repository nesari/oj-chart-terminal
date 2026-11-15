/**
 * Built-in indicator registry (ROUND299) — Pine, single source of truth.
 *
 * Until ROUND298 this module held 27 hand-written JavaScript implementations
 * (`compute: (bars, p, c) => ...`). The R298 differential audit showed why
 * that was the wrong design: it existed only to be compared against the Pine
 * engine, four bugs lived exclusively in that duplicate, and the two drifted
 * whenever one side changed.
 *
 * All 27 indicators are now REAL Pine scripts (core/pine/builtins-catalog.js)
 * executed by the same engine that runs the user's scripts. This file keeps
 * only the compatibility surface that the rest of the app and the public
 * `window.__app` facade already depended on:
 *
 *   Indicators.all        -> catalog entries (type/label/group/pane/params)
 *   Indicators.def(type)  -> entry or null
 *   Indicators.LIST       -> legacy alias for `all` (some audits read it)
 *   Indicators.title(inst)-> legend title with normalized params
 *   Indicators.paramValue -> the integer-period normalization the old
 *                            settings dialog used (kept for API stability;
 *                            Pine inputs validate themselves now)
 *   Indicators.scriptId   -> the Pine script id for a legacy type
 *   Indicators.migrate()  -> legacy {type, params} -> Pine {scriptId, inputs}
 *
 * There is deliberately NO compute() here any more: nothing may add a second
 * implementation of a built-in formula. Rendering goes through PineUI.
 *
 * @module core/indicators
 */

import { BUILTIN_INDICATORS, BUILTIN_BY_TYPE, BUILTIN_BY_ID, legacyParamsToInputs } from './pine/builtins-catalog.js';

/* The legacy registry shape, derived from the Pine catalog so the dialog,
   persistence and the public API keep working unchanged. `pane` is the old
   spelling of `overlay === false ? 'separate' : 'main'`. */
const DEFS = BUILTIN_INDICATORS.map((d) => ({
  type: d.type,
  scriptId: d.id,
  label: d.label,
  group: d.group,
  pane: d.overlay ? 'main' : 'separate',
  overlay: d.overlay,
  /* legacy param descriptors (key/label/default) for API consumers that still
     read them; the authoritative inputs are the script's input.* calls. */
  params: Object.keys(d.params || {}).map((key) => ({
    key, label: d.params[key],
  })),
  /* `colors` used to feed the dialog dot + legend swatch. The real colors now
     come from the script's plot() arguments; this is only a fallback hint for
     the few call sites that colour a dot before the script has run. */
  colors: {},
}));

const MAP = new Map(DEFS.map((d) => [d.type, d]));

const Indicators = {
  all: DEFS,
  get LIST() { return DEFS; },
  def(type) { return MAP.get(type) || null; },
  /** the Pine script id backing a legacy indicator type */
  scriptId(type) { const d = MAP.get(type); return d ? d.scriptId : ''; },
  /** catalog definition (source + inputs) for a script id */
  catalog(scriptId) { return BUILTIN_BY_ID.get(scriptId) || null; },
  isBuiltinScript(scriptId) { return BUILTIN_BY_ID.has(scriptId); },

  /* Kept for API stability. Pine inputs own their own validation now, so this
     is only used to render a legend title for a legacy-shaped record. */
  paramValue(p, inst) {
    const raw = (inst && inst.params && inst.params[p.key] != null) ? inst.params[p.key] : p.def;
    if (!p.int) return raw;
    let v = Number(raw);
    if (!isFinite(v)) v = p.def;
    v = Math.round(v);
    const lo = p.min != null ? p.min : 1;
    if (v < lo) v = lo;
    if (p.max != null && v > p.max) v = p.max;
    return v;
  },

  /**
   * Legend title. A legacy record ({type, params}) shows the same
   * "Label (params)" shape the old registry produced. Pine instances
   * ({scriptId, inputs}) get the catalog label — their values live in the
   * engine and PineUI renders those.
   */
  title(inst) {
    if (!inst) return '';
    if (inst.scriptId) {
      const c = BUILTIN_BY_ID.get(inst.scriptId);
      return c ? c.label : (inst.type || '');
    }
    const d = MAP.get(inst.type);
    if (!d) return inst.type || '';
    /* Only show params the record actually carries. A freshly added indicator
       has {} and must read as the bare label, not "Label ()". */
    const keys = d.params.map((p) => p.key).filter((k) => inst.params && inst.params[k] != null);
    if (!keys.length) return d.label;
    const ps = d.params.filter((p) => inst.params && inst.params[p.key] != null)
      .map((p) => this.paramValue(p, inst)).join(', ');
    return `${d.label} (${ps})`;
  },

  /**
   * Migrate a persisted legacy indicator record to a Pine instance.
   * Returns null when the type is unknown so the caller can drop the record
   * instead of inventing an indicator.
   */
  migrate(rec, inputDefs) {
    const d = rec && MAP.get(rec.type);
    if (!d) return null;
    return {
      scriptId: d.scriptId,
      inputs: legacyParamsToInputs(BUILTIN_BY_TYPE.get(d.type), rec.params, inputDefs),
      /* carry the parts of the old record that still mean something on a Pine
         instance (eye state and the sub-pane height share) */
      visible: rec.visible !== false,
      ...(rec.frac > 0 ? { frac: rec.frac } : {}),
      /* legacy per-instance style is translated by PineUI's style keys, which
         already speak plot titles; a legacy type-keyed blob is dropped rather
         than applied to the wrong plot. */
    };
  },
};

export { Indicators };
