/**
 * Pine matrices (round 196).
 *
 * A PineMatrix is a REFERENCE type (like PineArray): set/fill/add/remove
 * mutate in place. Rows are 0-based; na fills are the NA singleton.
 * Element types v1: int/float/bool/string (+any untyped) — object matrices
 * stay loud (same gap class as the engine's partial UDT support).
 *
 * House rules (documented where TV is ambiguous): add_row/add_col insert AT
 * the given index (array.insert parity); remove_* return the removed
 * row/column as an array; transpose/sort return NEW matrices (array.sort
 * parity); reshape works in place and returns the matrix.
 *
 * @module core/pine/stdlib/matrix
 */

import { NA, isNA, enumPayload } from '../types.js';
import { runtimeError } from '../errors.js';
import { PineArray } from './array.js';

const SCALAR_TYPES = new Set(['any', 'int', 'float', 'bool', 'string']);

class PineMatrix {
  /** @param {string} elType e.g. 'float' — rows: array of row arrays */
  constructor(elType, rows) {
    this.__pineMatrix = true;
    this.elType = elType || 'any';
    this.data = rows || [];
  }
  nRows() { return this.data.length; }
  nCols() { return this.data.length ? this.data[0].length : 0; }
  _rc(r, c) {
    const rr = Math.trunc(r), cc = Math.trunc(c);
    if (rr !== r || cc !== c || !isFinite(r) || !isFinite(c)) throw runtimeError('matrix index must be integers');
    if (rr < 0 || rr >= this.nRows() || cc < 0 || cc >= this.nCols()) {
      throw runtimeError(`matrix index out of bounds (${rr}, ${cc}, size ${this.nRows()}x${this.nCols()})`);
    }
    return [rr, cc];
  }
  get(r, c) { const [rr, cc] = this._rc(r, c); return this.data[rr][cc]; }
  set(r, c, v) {
    const [rr, cc] = this._rc(r, c);
    this._check(v);
    this.data[rr][cc] = v;
    return v;
  }
  _check(v) {
    if (this.elType === 'any' || isNA(v)) return;
    if (this.elType === 'float' || this.elType === 'int') {
      if (typeof v !== 'number') throw runtimeError(`matrix<${this.elType}>.set expects a number, got ${typeof v}`);
      return;
    }
    if (this.elType === 'bool' && typeof v !== 'boolean') throw runtimeError('matrix<bool>.set expects a bool');
    if (this.elType === 'string' && typeof v !== 'string') throw runtimeError('matrix<string>.set expects a string');
  }
  copy() { return new PineMatrix(this.elType, this.data.map((row) => row.slice())); }
  fill(v, r0, c0, r1, c1) {
    this._check(v);
    const R = this.nRows(), C = this.nCols();
    let a = (r0 == null || isNA(r0)) ? 0 : Math.trunc(r0);
    let b = (c0 == null || isNA(c0)) ? 0 : Math.trunc(c0);
    let c = (r1 == null || isNA(r1)) ? R : Math.trunc(r1);
    let d = (c1 == null || isNA(c1)) ? C : Math.trunc(c1);
    a = Math.max(0, a); b = Math.max(0, b); c = Math.min(R, c); d = Math.min(C, d);
    for (let i = a; i < c; i++) for (let j = b; j < d; j++) this.data[i][j] = v;
    return this;
  }
  _atIdx(v, lo, hi, what) {
    const k = Math.trunc(v);
    if (k !== v || !isFinite(v)) throw runtimeError(`matrix.${what} index must be an integer`);
    if (k < lo || k > hi) throw runtimeError(`matrix.${what} index out of bounds (${k}, size ${hi})`);
    return k;
  }
  addRow(at) {
    const k = this._atIdx(at, 0, this.nRows(), 'add_row');
    const row = [];
    for (let j = 0; j < this.nCols(); j++) row.push(NA);
    this.data.splice(k, 0, row);
    return this;
  }
  addCol(at) {
    const k = this._atIdx(at, 0, this.nCols(), 'add_col');
    for (const row of this.data) row.splice(k, 0, NA);
    return this;
  }
  removeRow(at) {
    const k = this._atIdx(at, 0, this.nRows() - 1, 'remove_row');
    return new PineArray(this.elType, this.data.splice(k, 1)[0]);
  }
  removeCol(at) {
    const k = this._atIdx(at, 0, this.nCols() - 1, 'remove_col');
    const out = [];
    for (const row of this.data) out.push(row.splice(k, 1)[0]);
    return new PineArray(this.elType, out);
  }
  /* ROUND227 (TV parity): matrix.submatrix(id, from_row, from_column,
     to_row, to_column) — half-open [from, to) ranges, clamped like fill. */
  submatrix(fr, fc, tr, tc) {
    const R = this.nRows(), C = this.nCols();
    let a = (fr == null || isNA(fr)) ? 0 : Math.trunc(fr);
    let b = (fc == null || isNA(fc)) ? 0 : Math.trunc(fc);
    let c = (tr == null || isNA(tr)) ? R : Math.trunc(tr);
    let d = (tc == null || isNA(tc)) ? C : Math.trunc(tc);
    if (![a, b, c, d].every((v) => isFinite(v))) throw runtimeError('matrix.submatrix indices must be integers');
    a = Math.max(0, Math.min(R, a)); b = Math.max(0, Math.min(C, b));
    c = Math.max(0, Math.min(R, c)); d = Math.max(0, Math.min(C, d));
    if (c < a || d < b) throw runtimeError('matrix.submatrix: to_row/to_column must be at or after from_row/from_column');
    const out = [];
    for (let i = a; i < c; i++) out.push(this.data[i].slice(b, d));
    return new PineMatrix(this.elType, out);
  }
  transpose() {
    const R = this.nRows(), C = this.nCols();
    const out = [];
    for (let j = 0; j < C; j++) {
      const row = [];
      for (let i = 0; i < R; i++) row.push(this.data[i][j]);
      out.push(row);
    }
    return new PineMatrix(this.elType, out);
  }
  reshape(nr, nc) {
    const R = Math.trunc(nr), C = Math.trunc(nc);
    if (R !== nr || C !== nc || !isFinite(nr) || !isFinite(nc) || R < 0 || C < 0) {
      throw runtimeError('matrix.reshape dimensions must be non-negative integers');
    }
    if (R * C !== this.nRows() * this.nCols()) {
      throw runtimeError(`matrix.reshape needs ${R * C} cells, the matrix has ${this.nRows() * this.nCols()}`);
    }
    const flat = [];
    for (const row of this.data) for (const v of row) flat.push(v);
    const out = [];
    for (let i = 0; i < R; i++) out.push(flat.slice(i * C, i * C + C));
    this.data = out;
    return this;
  }
  sort(col, order) {
    const C = this.nCols();
    const cc = Math.trunc(col);
    if (cc !== col || !isFinite(col) || cc < 0 || cc >= C) throw runtimeError(`matrix.sort column out of bounds (${col})`);
    const desc = order === -1 || enumPayload(order) === 'descending';
    const rows = this.data.map((row) => row.slice());
    rows.sort((a, b) => {
      const x = a[cc], y = b[cc];
      if (isNA(x)) return 1;
      if (isNA(y)) return -1;
      const r = x < y ? -1 : x > y ? 1 : 0;
      return desc ? -r : r;
    });
    return new PineMatrix(this.elType, rows);
  }
  numeric() { // sum/avg/min/max helpers: NA-filtered finite numbers
    const out = [];
    for (const row of this.data) {
      for (const v of row) if (!isNA(v) && typeof v === 'number' && isFinite(v)) out.push(v);
    }
    return out;
  }
  sum() { const a = this.numeric(); return a.length ? a.reduce((x, y) => x + y, 0) : NA; }
  avg() { const a = this.numeric(); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NA; }
  min() { const a = this.numeric(); return a.length ? Math.min.apply(null, a) : NA; }
  max() { const a = this.numeric(); return a.length ? Math.max.apply(null, a) : NA; }
  join(sep) {
    const s = sep == null || isNA(sep) ? ', ' : String(sep);
    return this.data.map((row) => row.map((v) => (isNA(v) ? 'NaN' : String(v))).join(s)).join('; ');
  }
  /** deep clone for the var/rollback snapshot (cells are scalars v1) */
  snapshotClone() { return this.copy(); }
}

const isMatrix = (v) => v != null && typeof v === 'object' && v.__pineMatrix === true;

/** matrix.new<T>(rows, columns, initial) */
function matNew(elType, nRows, nCols, initial) {
  const t = elType || 'any';
  if (!SCALAR_TYPES.has(t)) throw runtimeError(`matrix<${t}> is not supported in this engine version yet (int/float/bool/string only)`);
  const R = (nRows === NA || nRows == null) ? 0 : Math.trunc(nRows);
  const C = (nCols === NA || nCols == null) ? 0 : Math.trunc(nCols);
  if (R !== nRows && nRows !== NA && nRows != null) throw runtimeError('matrix.new rows must be an integer');
  if (C !== nCols && nCols !== NA && nCols != null) throw runtimeError('matrix.new columns must be an integer');
  if (!(R >= 0) || !(C >= 0)) throw runtimeError('matrix.new dimensions must be non-negative');
  const m = new PineMatrix(t, []);
  const fillV = (initial === undefined || initial == null) ? NA : initial;
  m._check(fillV);
  for (let i = 0; i < R; i++) {
    const row = [];
    for (let j = 0; j < C; j++) row.push(fillV);
    m.data.push(row);
  }
  return m;
}

export { PineMatrix, isMatrix, matNew };
