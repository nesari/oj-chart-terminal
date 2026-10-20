/**
 * Pine drawing objects: line / box / label (round 74 — roadmap phase 5,
 * in-place-update model). The user's "786 Zones" builds each object once and
 * then mutates it bar-after-bar via set_* methods with refs kept in
 * `var box[]` / `var line[]` / `var label[]` arrays — so objects are plain
 * mutable data records; the RENDERER maps them to chart primitives.
 *
 * Lifecycle + cap: every script instance owns a VisualStore with the official
 * count caps (max_lines_count / max_boxes_count / max_labels_count, default
 * ~50 like TV). When a cap is exceeded the OLDEST object is garbage-collected
 * (official behaviour). line.delete/box.delete/label.delete remove at once.
 *
 * Coordinate model: x is either bar-index based (xloc.bar_index) or an epoch
 * in MILLISECONDS (xloc.bar_time — Pine times are ms; the renderer converts
 * to the chart's second-based stamps).
 *
 * @module core/pine/stdlib/objects
 */

import { NA, isNA, toColor } from '../types.js';
import { runtimeError } from '../errors.js';

let OID = 0;
const nextId = () => ++OID;

class VisualStore {
  constructor(caps) {
    this.caps = {
      line: (caps && caps.line) || 500,
      box: (caps && caps.box) || 500,
      label: (caps && caps.label) || 500,
      table: (caps && caps.table) || 100,
      polyline: (caps && caps.polyline) || 100,
      linefill: (caps && caps.linefill) || 100,
    };
    this.line = new Map();   // id -> PineLine
    this.box = new Map();
    this.label = new Map();
    this.table = new Map(); // ROUND151: table MVP (engine-side; render in phase E)
    this.polyline = new Map();
    this.linefill = new Map();
    this.seq = { line: [], box: [], label: [], table: [], polyline: [], linefill: [] }; // insertion order for GC
    /* ROUND205: graveyard of deleted refs (TV parity for the .deleted flag
       + forming-bar rollback). del() flags the object AND removes it from
       the live map, but keeps the SAME ref here so restore() can resurrect
       it with identity intact (var-held refs stay valid). Pruned at every
       snapshot() (single-slot _preFormSnap discipline: pre-snapshot graves
       can never be resurrected) and on clearAll(). */
    this.graves = new Map(); // "kind:id" -> obj
    this.gced = 0; // count of auto-GCd objects (diagnostics)
    this.adds = { line: 0, box: 0, label: 0, table: 0, polyline: 0, linefill: 0 }; // total factory calls (diagnostics)
    this.version = 0; // ROUND78 perf: bumped on add/del — render dirty-check key
  }
  _gc(kind) {
    while (this[kind].size > this.caps[kind]) {
      const id = this.seq[kind].shift();
      if (id == null) break;
      if (this[kind].has(id)) { this[kind].delete(id); this.gced++; }
    }
  }
  add(kind, obj) {
    this[kind].set(obj.id, obj);
    this.seq[kind].push(obj.id);
    this.adds[kind]++;
    this.version++;
    this._gc(kind);
    return obj;
  }
  get(kind, id) { return this[kind].get(id) || null; }
  del(kind, obj) {
    if (obj == null || isNA(obj)) return;
    const id = typeof obj === 'object' ? obj.id : obj;
    const live = this[kind].get(id);
    if (!live) return; // double delete: silent (TV parity — no throw)
    /* ROUND205 (TV parity): the object is flagged so every later getter or
       setter guard (the "was deleted" throws) fires. Before this the flag
       the flag was never set — the guards were dead code and scripts silently
       mutated detached orphans. */
    live.deleted = true;
    this[kind].delete(id);
    const q = this.seq[kind];
    const k = q.indexOf(id);
    if (k >= 0) q.splice(k, 1);
    this.graves.set(kind + ':' + id, live);
    this.version++; // ROUND78 perf
  }
  /* ROUND205: resurrect a grave ref deleted after the snapshot (same identity,
     so var-held refs reunite with the store entry). Bypasses _gc on purpose:
     the snapshot set always fit the caps, and born-after objects are purged
     by dropObjectsBornAfter right after restore(). Returns the live obj or
     null when there is no grave (full recalc between snapshot and restore). */
  resurrect(kind, id, fields) {
    const gk = kind + ':' + id;
    const g = this.graves.get(gk);
    if (!g) return null;
    this.graves.delete(gk);
    Object.assign(g, fields);
    g.deleted = false;
    if (kind === 'table' && fields.cells) {
      g.cells = new Map(fields.cells);
      g.merges = (fields.merges || []).slice();
    }
    this[kind].set(id, g);
    this.seq[kind].push(id);
    this.version++;
    return g;
  }
  count(kind) { return this[kind].size; }
  /* ROUND87: full-recalculation semantics — a complete re-run (history
     reload, session re-stitch, input change on the SAME runtime) must start
     with an EMPTY drawing store, exactly like a TV full recalc. Without
     this, objects from the previous run linger forever: the script only
     mutates the slots it still evaluates, so every dropped/out-of-scope
     object (a zone whose day no longer qualifies, a box whose extend mode
     changed) kept painting its OLD coordinates on top of the fresh run. */
  clearAll() {
    this.line.clear(); this.box.clear(); this.label.clear(); this.table.clear(); this.polyline.clear(); this.linefill.clear();
    this.seq.line.length = 0; this.seq.box.length = 0; this.seq.label.length = 0;
    this.seq.table.length = 0;
    this.seq.polyline.length = 0; this.seq.linefill.length = 0;
    this.graves.clear(); // ROUND205: full recalc orphans every grave
    this.version++;
  }
}

class PineLine {
  constructor(opts) {
    this.__pineObj = true;
    this.kind = 'line';
    this.id = nextId();
    this.x1 = opts.x1; this.y1 = opts.y1;
    this.x2 = opts.x2; this.y2 = opts.y2;
    this.xloc = opts.xloc || 'bar_index';
    this.extend = opts.extend || 'none';       // none|left|right|both
    this.color = opts.color;                   // PineColor
    this.style = opts.style || 'solid';        // solid|dashed|dotted
    this.width = opts.width == null ? 1 : opts.width;
    /* ROUND223 (TV parity): force_overlay paints on the chart even from a
       sub-pane script (the adapter branches on it). */
    this.force_overlay = !!opts.force_overlay;
    this.deleted = false;
    this.bornBar = opts.bornBar;
  }
}
class PineBox {
  constructor(opts) {
    this.__pineObj = true;
    this.kind = 'box';
    this.id = nextId();
    this.left = opts.left; this.top = opts.top;
    this.right = opts.right; this.bottom = opts.bottom;
    this.xloc = opts.xloc || 'bar_index';
    this.border_color = opts.border_color;
    this.border_width = opts.border_width == null ? 1 : opts.border_width;
    this.border_style = opts.border_style || 'solid';
    this.extend = opts.extend || 'none';
    this.bgcolor = opts.bgcolor;
    this.text = opts.text || '';
    this.text_size = opts.text_size || 'small';
    this.text_color = opts.text_color;
    this.text_halign = opts.text_halign || 'center';
    this.text_valign = opts.text_valign || 'center';
    this.text_wrap = opts.text_wrap || 'none';
    this.text_font_family = opts.text_font_family || 'default';
    this.text_formatting = opts.text_formatting || 'none';
    this.force_overlay = !!opts.force_overlay; // ROUND223 (TV parity)
    this.deleted = false;
    this.bornBar = opts.bornBar;
  }
}
class PineLabel {
  constructor(opts) {
    this.__pineObj = true;
    this.kind = 'label';
    this.id = nextId();
    this.x = opts.x; this.y = opts.y;
    this.xloc = opts.xloc || 'bar_index';
    this.text = opts.text || '';
    this.color = opts.color;
    this.textcolor = opts.textcolor;
    this.style = opts.style || 'label_down';
    this.size = opts.size || 'normal';
    this.tooltip = opts.tooltip || '';
    this.textalign = opts.textalign || 'center';
    this.yloc = opts.yloc || 'price';
    this.text_font_family = opts.text_font_family || 'default';
    this.text_formatting = opts.text_formatting || 'none';
    this.force_overlay = !!opts.force_overlay; // ROUND223 (TV parity)
    this.deleted = false;
    this.bornBar = opts.bornBar;
  }
}

class PinePolyline {
  constructor(opts) {
    this.__pineObj = true;
    this.kind = 'polyline';
    this.id = nextId();
    this.points = opts.points || [];          // [{x, y}] (x = bar index or ms, per xloc)
    this.curved = !!opts.curved;
    this.closed = !!opts.closed;
    this.xloc = opts.xloc || 'bar_index';
    this.line_color = opts.line_color;
    this.fill_color = opts.fill_color;
    this.line_style = opts.line_style || 'solid';
    this.line_width = opts.line_width == null ? 1 : opts.line_width;
    this.deleted = false;
    this.bornBar = opts.bornBar;
  }
}
class PineLinefill {
  constructor(opts) {
    this.__pineObj = true;
    this.kind = 'linefill';
    this.id = nextId();
    this.line1 = opts.line1; this.line2 = opts.line2;
    this.color = opts.color;
    this.deleted = false;
    this.bornBar = opts.bornBar;
  }
}

/* ROUND151: table MVP (engine-side; render arrives in phase E). Tables are
   the dashboards of LuxAlgo-style scripts — new/cell/clear/set_position/
   delete with TV-strict index validation. cells is a Map("c,r" -> cell)
   CLONED on snapshot/restore (per-bar mutation must roll back). */
const TABLE_POSITIONS = new Set([
  'top_left', 'top_center', 'top_right',
  'middle_left', 'middle_center', 'middle_right',
  'bottom_left', 'bottom_center', 'bottom_right',
]);
function tablePos(v) {
  const p = v && v.__pineEnum ? v.payload : v;
  if (p == null || isNA(p)) return 'bottom_right';
  const key = String(p).toLowerCase().replace(/[\s-]+/g, '_');
  if (TABLE_POSITIONS.has(key)) return key;
  throw runtimeError(`table: unknown position '${p}'`);
}
/* ROUND205: deleted tables report "was deleted" (like the line/box/label
   guards in the interpreter) instead of the generic kind error. */
function chkTable(t, what) {
  if (!t || !t.__pineObj || t.kind !== 'table') throw runtimeError(`${what}: expected a table object`);
  if (t.deleted) throw runtimeError(`${what}: the table was deleted`);
  return t;
}
class PineTable {
  constructor(opts) {
    this.__pineObj = true;
    this.kind = 'table';
    this.id = nextId();
    this.pos = opts.pos;
    this.cols = opts.cols; this.rows = opts.rows;
    this.bgcolor = opts.bgcolor;
    this.frame_width = opts.frame_width; this.frame_color = opts.frame_color;
    this.border_width = opts.border_width; this.border_color = opts.border_color;
    this.cells = new Map();
    this.merges = []; // ROUND155: merge_cells ranges {sc,sr,ec,er}
    this.deleted = false;
    this.bornBar = opts.bornBar;
  }
}

/* table.new(position, columns, rows, bgcolor, frame_color, frame_width,
   border_color, border_width, force_overlay) — TV order (docs/visuals/tables);
   force_overlay ignored (engine) */
function tableNew(store, positional, named, ctx) {
  const a = mergeArgs(positional, named);
  const cols = Math.trunc(Number(a.get('columns', 1)));
  const rows = Math.trunc(Number(a.get('rows', 2)));
  if (!isFinite(cols) || cols < 1 || !isFinite(rows) || rows < 1) {
    throw runtimeError('table.new: columns and rows must be positive integers');
  }
  const obj = new PineTable({
    pos: tablePos(a.get('position', 0)),
    cols, rows,
    bgcolor: _color(a.get('bgcolor', 3), 'table.new'),
    frame_width: _optNum(a.get('frame_width', 5), 1),
    frame_color: _color(a.get('frame_color', 4), 'table.new'),
    border_width: _optNum(a.get('border_width', 7), 1),
    border_color: _color(a.get('border_color', 6), 'table.new'),
    bornBar: ctx.barIndex,
  });
  return store.add('table', obj);
}

/* table.cell(table_id, column, row, text, width, height, text_color,
   text_halign, text_valign, text_size, bgcolor, tooltip, text_font_family,
   text_formatting) — TV order (docs/visuals/tables). width/tooltip stored
   (engine parity; the DOM sync reads text only). */
function tableCell(store, positional, named) {
  const a = mergeArgs(positional, named);
  const t = chkTable(a.get('table_id', 0), 'table.cell');
  const c = Math.trunc(Number(a.get('column', 1))), r = Math.trunc(Number(a.get('row', 2)));
  if (!isFinite(c) || c < 0 || c >= t.cols || !isFinite(r) || r < 0 || r >= t.rows) {
    throw runtimeError(`table.cell: cell (${c}, ${r}) is outside a ${t.cols}x${t.rows} table`);
  }
  const textV = a.get('text', 3, '');
  const halV = a.get('text_halign', 7), valV = a.get('text_valign', 8);
  t.cells.set(c + ',' + r, {
    text: String(isNA(textV) ? '' : textV),
    text_color: _color(a.get('text_color', 6), 'table.cell'),
    text_halign: halV && halV.__pineEnum ? halV.payload : 'center',
    text_valign: valV && valV.__pineEnum ? valV.payload : 'middle',
    /* ROUND224 (TV parity): text_size takes a size.* name or int point size;
       text_font_family (slot 12) and text_formatting (slot 13) stored. */
    text_size: sizeOf(a.get('text_size', 9), null),
    text_font_family: (() => { const f = a.get('text_font_family', 12); const p = f && f.__pineEnum ? f.payload : (typeof f === 'string' ? f : null); return p || 'default'; })(),
    text_formatting: fmtOf(a.get('text_formatting', 13)),
    bgcolor: _color(a.get('bgcolor', 10), 'table.cell'),
    width: _optNum(a.get('width', 4), null),
    height: _optNum(a.get('height', 5), null),
    tooltip: String(a.get('tooltip', 11, '') || ''),
  });
  store.version++;
}

/* ROUND155: table.merge_cells(table_id, start_column, start_row, end_column,
   end_row) — header cells spanning columns (LuxAlgo dashboards). The anchor
   keeps its text; covered cells are hidden by the renderer. */
function tableMerge(store, positional, named) {
  const a = mergeArgs(positional, named);
  const t = chkTable(a.get('table_id', 0), 'table.merge_cells');
  const q = (name, idx, max, what) => {
    const v = Math.trunc(Number(a.get(name, idx)));
    if (!isFinite(v) || v < 0 || v >= max) {
      throw runtimeError(`table.merge_cells: ${what} (${v}) is outside a ${t.cols}x${t.rows} table`);
    }
    return v;
  };
  const sc = q('start_column', 1, t.cols, 'start_column');
  const sr = q('start_row', 2, t.rows, 'start_row');
  const ec = q('end_column', 3, t.cols, 'end_column');
  const er = q('end_row', 4, t.rows, 'end_row');
  if (ec < sc || er < sr) throw runtimeError('table.merge_cells: end must be at or after start');
  t.merges.push({ sc, sr, ec, er });
  store.version++;
}

/* table.clear(table_id, start_column, start_row, end_column, end_row) */
function tableClear(store, positional, named) {
  const a = mergeArgs(positional, named);
  const t = chkTable(a.get('table_id', 0), 'table.clear');
  const sc = _optNum(a.get('start_column', 1), 0), sr = _optNum(a.get('start_row', 2), 0);
  const ec = _optNum(a.get('end_column', 3), t.cols - 1), er = _optNum(a.get('end_row', 4), t.rows - 1);
  for (const k of Array.from(t.cells.keys())) {
    const [c, r] = k.split(',').map(Number);
    if (c >= sc && c <= ec && r >= sr && r <= er) t.cells.delete(k);
  }
  store.version++;
}

/* ROUND203 (table style setters, TV parity): dynamic restyle of a live
   dashboard (LuxAlgo flips table chrome by session/state). Each bumps
   store.version so the DOM layer re-syncs. Color garbage stays loud via
   _color; widths fall back like table.new. */
function tableStyleGet(store, positional, named, what) {
  const a = mergeArgs(positional, named);
  const t = chkTable(a.get('table_id', 0), `table.${what}`);
  return { t, a };
}
function tableSetBgcolor(store, positional, named) {
  const { t, a } = tableStyleGet(store, positional, named, 'set_bgcolor');
  t.bgcolor = _color(a.get('color', 1), 'table.set_bgcolor');
  store.version++;
}
function tableSetBorderColor(store, positional, named) {
  const { t, a } = tableStyleGet(store, positional, named, 'set_border_color');
  t.border_color = _color(a.get('color', 1), 'table.set_border_color');
  store.version++;
}
function tableSetBorderWidth(store, positional, named) {
  const { t, a } = tableStyleGet(store, positional, named, 'set_border_width');
  t.border_width = _optNum(a.get('width', 1), 1);
  store.version++;
}
function tableSetFrameColor(store, positional, named) {
  const { t, a } = tableStyleGet(store, positional, named, 'set_frame_color');
  t.frame_color = _color(a.get('color', 1), 'table.set_frame_color');
  store.version++;
}
function tableSetFrameWidth(store, positional, named) {
  const { t, a } = tableStyleGet(store, positional, named, 'set_frame_width');
  t.frame_width = _optNum(a.get('width', 1), 1);
  store.version++;
}

/* ------------------------- style constant tables ------------------------- */

const LINE_STYLES = { solid: 'solid', dashed: 'dashed', dotted: 'dotted' };
const SIZE_MAP = { tiny: 7, small: 9, normal: 11, large: 14, huge: 18, auto: 11 };
const LABEL_STYLES = new Set([
  'label_up', 'label_down', 'label_left', 'label_right',
  'label_upper_left', 'label_upper_right', 'label_lower_left', 'label_lower_right',
  'label_center', 'label_center_left', 'label_center_right',
  'xcross', 'cross', 'flag', 'square', 'diamond', 'triangleup', 'triangledown',
  'none',
]);
const XLOC = new Set(['bar_index', 'bar_time']);
const EXTEND = new Set(['none', 'left', 'right', 'both']);

/* ------------------------- coercion helpers ------------------------- */

function _num(v, what) {
  if (isNA(v) || typeof v !== 'number' || !isFinite(v)) throw runtimeError(`${what}: expected a finite number`);
  return v;
}
function _optNum(v, dflt) {
  if (v === undefined || v === null || isNA(v)) return dflt;
  return typeof v === 'number' && isFinite(v) ? v : dflt;
}
function _color(v, what) {
  // accepts PineColor / hex string / named-color string
  if (v === undefined || v === null || isNA(v)) return null;
  if (v && typeof v === 'object' && v.css) return v;
  if (typeof v === 'string') { const c = toColor(v); if (c) return c; }
  throw runtimeError(`${what}: expected a color`);
}

/** chart.point.new(t, i, p) values — {__pineObj, kind:'point'} — are legal in
 *  the coordinate positions of line/box/label .new(). Unpack point args into
 *  the x/y slots the factories understand (official overload behaviour). */
function unpackPointArgs(a, xNames, yNames) {
  for (let k = 0; k < xNames.length; k++) {
    const v = a.get(xNames[k], k);
    if (v && v.__pineObj && v.kind === 'point') {
      a.map.set(xNames[k], v.time != null ? v.time : v.index);
      a.map.set(yNames[k], v.price);
    }
  }
}

/* ROUND160 (class-A fix): v6 chart.point call form — label.new(point, text,
   xloc, ...) / line.new(p1, p2, ...) pack (x, y) into ONE positional slot,
   so every later positional index silently shifted by one (label text read
   the xloc enum -> "[object Object]", colors/styles/sizes/xloc all landed
   on the wrong params). Expansion restores 1:1 positional mapping BEFORE
   mergeArgs; xSlots are the LOGICAL x-param indices (label [0], line
   [0, 2], box [0, 2]). Non-point and named args pass through untouched. */
function isPointLike(v) {
  return !!(v && (v.__pointXY || (v.__pineObj && v.kind === 'point')));
}
/* Split a point-like positional into its (x, y) numbers. Factories receive
   points pre-unpacked as {__pointXY, x, y} (_nsObjNew); raw point objects
   are accepted too (defensive — other call paths). */
function pointXY(v) {
  if (v && v.__pointXY && typeof v === 'object') {
    const inner = v.__pointXY === true ? v : v.__pointXY;
    if (inner && (inner.x !== undefined || inner.y !== undefined)) return [inner.x, inner.y];
  }
  if (v && v.__pineObj && v.kind === 'point') {
    return [v.time != null ? v.time : v.index, v.price];
  }
  return null;
}
function expandPointArgs(positional, xSlots) {
  const out = [];
  let li = 0; // logical param index
  for (let pi = 0; pi < positional.length; pi++, li++) {
    const v = positional[pi];
    const pt = xSlots.indexOf(li) >= 0 ? pointXY(v) : null;
    if (pt) {
      out.push(pt[0] != null ? pt[0] : NA, pt[1] != null ? pt[1] : NA);
      li++; // the y slot is filled too
    } else {
      out.push(v);
    }
  }
  return out;
}

/* ----------------------------- factories ----------------------------- */

/**
 * Builtin registries bound by the interpreter. Each factory receives
 * (store, args, ctx) where args are positional/named merged by the
 * interpreter helper below, ctx carries { barIndex } for bornBar.
 */

function mergeArgs(positional, named) {
  // returns { get(name, posIdx) } over the merged view
  const map = new Map();
  for (const nm of named) map.set(nm.name, nm.value);
  return {
    map,
    has(name) { return map.has(name); },
    get(name, posIdx, dflt) {
      if (map.has(name)) {
        const v = map.get(name);
        /* chart.point passed as a whole (line.new(p1, p2)) — unpack to (x,y)
           pair slots: the first point fills x1/y1, the second x2/y2 */
        if (v && v.__pointXY) return { __pointXY: v };
        return v;
      }
      if (posIdx != null && positional.length > posIdx) {
        const v = positional[posIdx];
        if (v && v.__pointXY) return v.__pointXY.x != null || v.__pointXY.y != null ? { __ptPair: v.__pointXY, posIdx } : v;
        return v;
      }
      return dflt;
    },
  };
}

function lineNew(store, positional, named, ctx) {
  const a = mergeArgs(expandPointArgs(positional, [0, 2]), named);
  unpackPointArgs(a, ['x1', 'x2'], ['y1', 'y2']);
  // official: line.new(x1, y1, x2, y2, xloc, extend, color, style, width)
  const styleV = a.get('style', 7);
  const styleP = styleV && styleV.__pineEnum ? styleV.payload : null;
  if (styleV != null && !isNA(styleV) && !styleP) throw runtimeError('line.new: style must be a line.style_* constant');
  const xlocV = a.get('xloc', 4);
  const xlocP = xlocV && xlocV.__pineEnum ? xlocV.payload : 'bar_index';
  if (xlocP && !XLOC.has(xlocP)) throw runtimeError('line.new: xloc must be xloc.bar_index or xloc.bar_time');
  const extV = a.get('extend', 5);
  const extP = extV && extV.__pineEnum ? extV.payload : 'none';
  const obj = new PineLine({
    x1: _optNum(a.get('x1', 0), null), y1: _optNum(a.get('y1', 1), null),
    x2: _optNum(a.get('x2', 2), null), y2: _optNum(a.get('y2', 3), null),
    xloc: xlocP,
    extend: EXTEND.has(String(extP)) ? String(extP) : 'none',
    color: _color(a.get('color', 6), 'line.new'),
    style: styleP || 'solid',
    width: _optNum(a.get('width', 8), 1),
    /* ROUND223: force_overlay is positional slot 9 (TV signature). */
    force_overlay: truthyBool(a.get('force_overlay', 9)),
    bornBar: ctx.barIndex,
  });
  return store.add('line', obj);
}

function boxNew(store, positional, named, ctx) {
  const a = mergeArgs(expandPointArgs(positional, [0, 2]), named);
  unpackPointArgs(a, ['left', 'right'], ['top', 'bottom']);
  // official: box.new(left, top, right, bottom, border_color, border_width,
  //   border_style, extend, xloc, bgcolor, text, text_size, text_color, ...)
  const bstyleV = a.get('border_style', 6);
  const bstyleP = bstyleV && bstyleV.__pineEnum ? bstyleV.payload : null;
  if (bstyleV != null && !isNA(bstyleV) && !bstyleP) throw runtimeError('box.new: border_style must be a line.style_* constant');
  /* ROUND200 (box extend, TV parity): the extend argument was dropped
     (hardcoded 'none') — SMC order blocks went flat. Same validation as
     line.new; the renderer stretches the painted rect to the pane edges. */
  const extV = a.get('extend', 7);
  const extP = extV && extV.__pineEnum ? extV.payload : 'none';
  const xlocV = a.get('xloc', 8);
  const xlocP = xlocV && xlocV.__pineEnum ? xlocV.payload : 'bar_index';
  const obj = new PineBox({
    left: _optNum(a.get('left', 0), null), top: _optNum(a.get('top', 1), null),
    right: _optNum(a.get('right', 2), null), bottom: _optNum(a.get('bottom', 3), null),
    xloc: xlocP,
    border_color: _color(a.get('border_color', 4), 'box.new'),
    border_width: _optNum(a.get('border_width', 5), 1),
    border_style: bstyleP || 'solid',
    extend: EXTEND.has(String(extP)) ? String(extP) : 'none',
    bgcolor: _color(a.get('bgcolor', 9), 'box.new'),
    text: String(isNA(a.get('text', 10, '')) ? '' : a.get('text', 10, '')),
    /* ROUND224 (TV parity): text_size takes a size.* name or int point size
       (slot 11); text_formatting takes text.format_* (slot 17). */
    text_size: sizeOf(a.get('text_size', 11), 'small'),
    text_color: _color(a.get('text_color', 12), 'box.new'),
    text_formatting: fmtOf(a.get('text_formatting', 17)),
    /* ROUND223: force_overlay is positional slot 18 (TV signature). */
    force_overlay: truthyBool(a.get('force_overlay', 18)),
    bornBar: ctx.barIndex,
  });
  return store.add('box', obj);
}

function labelNew(store, positional, named, ctx) {
  const a = mergeArgs(expandPointArgs(positional, [0]), named);
  unpackPointArgs(a, ['x'], ['y']);
  // official: label.new(x, y, text, xloc, yloc, color, style, textcolor,
  //   size, textalign, tooltip, ...)
  const styleV = a.get('style', 6);
  const styleP = styleV && styleV.__pineEnum ? styleV.payload : 'label_down';
  if (styleP && !LABEL_STYLES.has(styleP)) throw runtimeError(`label.new: unknown style '${styleP}'`);
  const sizeV = a.get('size', 8);
  /* ROUND165: TV's size.* are effectively strings — accept a payload string
     ('tiny' from a dialog-persisted input.string(size.tiny,...)) as well as
     the enum object. Unknown strings still fall back to 'normal'. */
  /* ROUND224 (TV parity): size also takes an int point size (v6) — stored
     raw, the adapter resolves it (same helper as table cells). */
  const sizeP = (typeof sizeV === 'number' && isFinite(sizeV)) ? sizeV
    : sizeV && sizeV.__pineEnum ? sizeV.payload
    : (typeof sizeV === 'string' && SIZE_MAP[sizeV] != null ? sizeV : 'normal');
  const xlocV = a.get('xloc', 3);
  const xlocP = xlocV && xlocV.__pineEnum ? xlocV.payload : 'bar_index';
  const textV = a.get('text', 2, '');
  /* ROUND140: yloc.abovebar / belowbar ignore y and sit on that bar's high / low
     (TV docs). Resolved here, at creation, from the bar the label is anchored to. */
  const ylocV = a.get('yloc', 4);
  const ylocP = ylocV && ylocV.__pineEnum ? ylocV.payload : 'price';
  let yResolved = _optNum(a.get('y', 1), null);
  if (ylocP !== 'price' && ctx.bars) {
    const xi = _optNum(a.get('x', 0), null);
    const b = ctx.bars[xlocP === 'bar_index' && xi != null ? xi : ctx.barIndex] || ctx.bars[ctx.barIndex];
    if (b) yResolved = ylocP === 'abovebar' ? b.high : b.low;
  }
  const obj = new PineLabel({
    x: _optNum(a.get('x', 0), null), y: yResolved,
    yloc: ylocP,
    xloc: xlocP,
    text: String(isNA(textV) ? '' : textV),
    color: _color(a.get('color', 5), 'label.new'),
    textcolor: _color(a.get('textcolor', 7), 'label.new'),
    style: styleP || 'label_down',
    size: (typeof sizeP === 'number') ? sizeP : (SIZE_MAP[sizeP] != null ? sizeP : 'normal'),
    tooltip: String(a.get('tooltip', 10, '') || ''),
    /* ROUND224 (TV parity): text_formatting (text.format_*; named or slot 12). */
    text_formatting: fmtOf(a.get('text_formatting', 12)),
    /* ROUND223: force_overlay is positional slot 11 (TV signature). */
    force_overlay: truthyBool(a.get('force_overlay', 11)),
    bornBar: ctx.barIndex,
  });
  return store.add('label', obj);
}

/* polyline.new(points, curved, closed, xloc, line_color, fill_color, line_style, line_width, ...) */
function polylineNew(store, positional, named, ctx) {
  const a = mergeArgs(positional, named);
  const pts = a.get('points', 0);
  const items = pts && pts.__pineArray ? pts.items : [];
  if (items.length > 10000) throw runtimeError('polyline.new: at most 10000 points are allowed');
  const xlocV = a.get('xloc', 3);
  const xlocP = xlocV && xlocV.__pineEnum ? xlocV.payload : 'bar_index';
  const points = [];
  for (const it of items) {
    if (!it || isNA(it)) continue;
    // chart.point value ({time,index,price}) or an already-unpacked {x,y}
    let x = it.__pointXY ? it.x : (xlocP === 'bar_time' ? (it.time != null ? it.time : it.index) : (it.index != null ? it.index : it.time));
    const y = it.__pointXY ? it.y : it.price;
    if (x == null || y == null) continue;
    points.push({ x, y });
  }
  const stV = a.get('line_style', 6);
  const obj = new PinePolyline({
    points,
    curved: truthyBool(a.get('curved', 1)),
    closed: truthyBool(a.get('closed', 2)),
    xloc: xlocP,
    line_color: _color(a.get('line_color', 4), 'polyline.new'),
    fill_color: _color(a.get('fill_color', 5), 'polyline.new'),
    line_style: stV && stV.__pineEnum ? stV.payload : 'solid',
    line_width: _optNum(a.get('line_width', 7), 1),
    bornBar: ctx.barIndex,
  });
  return store.add('polyline', obj);
}
function truthyBool(v) { return v === true; }

/* ROUND224 (TV parity): text.format_* payload (or the raw string) folds to
   the stored formatting name; anything else is 'none'. */
function fmtOf(v) {
  const p = v && v.__pineEnum ? v.payload : (typeof v === 'string' ? v : null);
  return (p === 'bold' || p === 'italic' || p === 'bold_italic') ? p : 'none';
}

/* ROUND224: box/label/table text_size takes a size.* name or an int point
   size (v6) — stored raw (number) or resolved to the name; null stays null. */
function sizeOf(v, dflt) {
  if (typeof v === 'number' && isFinite(v)) return v;
  const p = v && v.__pineEnum ? v.payload : (typeof v === 'string' ? v : null);
  if (p != null && SIZE_MAP[p] != null) return p;
  return dflt;
}

/* linefill.new(line1, line2, color) — one linefill per line pair (a new call replaces the old) */
function linefillNew(store, positional, named, ctx) {
  const a = mergeArgs(positional, named);
  const l1 = a.get('line1', 0), l2 = a.get('line2', 1);
  if (!l1 || !l1.__pineObj || l1.kind !== 'line' || !l2 || !l2.__pineObj || l2.kind !== 'line') {
    throw runtimeError('linefill.new: expected two line objects');
  }
  for (const [id, f] of store.linefill) {
    if ((f.line1 === l1 && f.line2 === l2) || (f.line1 === l2 && f.line2 === l1)) store.del('linefill', id);
  }
  return store.add('linefill', new PineLinefill({ line1: l1, line2: l2, color: _color(a.get('color', 2), 'linefill.new'), bornBar: ctx.barIndex }));
}

/* ROUND166: TV GRAPHIC OBJECTS master toggles (Style tab: Boxes / Lines /
   Pane labels). Pure predicate so node tests pin the defaults; the adapter
   gates its box/line/label painters on it (all default on). */
function drawKindOn(style, kind) {
  const o = style && style.objects;
  if (!o || typeof o !== 'object') return true;
  return o[kind] !== false;
}

/* ROUND163: drawing census for the user-facing "extra SMC lines" report —
   a compact, testable summary of a run's alive drawings: per-kind counts,
   factory totals + GC evictions, line-span histogram in bars (short <20,
   mid 20-100, long >100 — a fresh cross of a STALE swing level draws a LONG
   segment that looks like a higher-timeframe line but is plain chart-TF),
   the 3 longest lines (price + span), and top label texts. The app logs one
   line per full pass (pine-ui runFull) so a user log traces exact line
   origins without anyone running JS in the live app. Pure: no DOM/engine. */
function drawingCensus(store, tfSec) {
  const out = {
    line: 0, box: 0, label: 0,
    adds: { line: 0, box: 0, label: 0 }, gced: 0,
    lineBars: { short: 0, mid: 0, long: 0, na: 0 },
    longest: [], labelTop: [],
  };
  if (!store) return out;
  try {
    out.line = store.line ? store.line.size : 0;
    out.box = store.box ? store.box.size : 0;
    out.label = store.label ? store.label.size : 0;
    if (store.adds) {
      out.adds.line = store.adds.line || 0;
      out.adds.box = store.adds.box || 0;
      out.adds.label = store.adds.label || 0;
    }
    out.gced = store.gced || 0;
    const sec = (typeof tfSec === 'number' && isFinite(tfSec) && tfSec > 0) ? tfSec : 60;
    const spans = [];
    const fin = (v) => typeof v === 'number' && isFinite(v); // null/NA/_objects are never coordinates
    if (store.line) {
      for (const ln of store.line.values()) {
        let bars = null;
        if (ln && ln.xloc === 'bar_time' && fin(ln.x1) && fin(ln.x2)) {
          bars = Math.round((ln.x2 - ln.x1) / 1000 / sec);
        } else if (ln && ln.xloc !== 'bar_time' && fin(ln.x1) && fin(ln.x2)) {
          bars = Math.round(ln.x2 - ln.x1);
        }
        if (bars == null || bars < 0) { out.lineBars.na++; continue; }
        if (bars < 20) out.lineBars.short++;
        else if (bars <= 100) out.lineBars.mid++;
        else out.lineBars.long++;
        spans.push({ y: ln.y1, bars, style: ln.style || '' });
      }
    }
    spans.sort((a, b) => b.bars - a.bars);
    out.longest = spans.slice(0, 3);
    if (store.label) {
      const byText = new Map();
      for (const lb of store.label.values()) {
        const t = lb && lb.text != null ? String(lb.text) : '';
        byText.set(t, (byText.get(t) || 0) + 1);
      }
      out.labelTop = [...byText.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([text, n]) => ({ text, n }));
    }
  } catch (e) { /* census must never break a run; partial out is fine */ }
  return out;
}

export {
  VisualStore, PineLine, PineBox, PineLabel, PinePolyline, PineLinefill, polylineNew, linefillNew,
  LINE_STYLES, SIZE_MAP, LABEL_STYLES, sizeOf, fmtOf,
  lineNew, boxNew, labelNew, mergeArgs, drawingCensus, drawKindOn,
  PineTable, TABLE_POSITIONS, tablePos, tableNew, tableCell, tableClear, tableMerge,
  tableSetBgcolor, tableSetBorderColor, tableSetBorderWidth, tableSetFrameColor, tableSetFrameWidth,
};
