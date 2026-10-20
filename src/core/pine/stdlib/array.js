/**
 * Pine arrays (round 74 — roadmap phase 2, prioritized early because the
 * user's "786 Zones" leans on typed persistent arrays: var box[] / float[] /
 * int[] / bool[]).
 *
 * A PineArray is a REFERENCE type: array.set mutates it in place, exactly
 * like the official language. `na` elements are the NA singleton.
 *
 * @module core/pine/stdlib/array
 */

import { NA, isNA, truthy, enumPayload } from '../types.js';
import { runtimeError } from '../errors.js';

class PineArray {
  /** @param {string} elType e.g. 'float' | 'box' | 'any' */
  constructor(elType, items) {
    this.__pineArray = true;
    this.elType = elType || 'any';
    this.items = items || [];
  }
  _idx(i) {
    const k = Math.trunc(i);
    if (k !== i || !isFinite(i)) throw runtimeError('array index must be an integer');
    /* ROUND224 (TV parity): v6 negative indices count from the end
       (get/set/insert/remove); still OOB past either end. */
    const w = k < 0 ? k + this.items.length : k;
    if (w < 0 || w >= this.items.length) throw runtimeError(`array index out of bounds (${k}, size ${this.items.length})`);
    return w;
  }
  get(i) { const k = this._idx(i); return this.items[k]; }
  set(i, v) {
    const k = this._idx(i);
    this._check(v);
    this.items[k] = v;
  }
  _check(v) {
    if (this.elType === 'any' || isNA(v)) return;
    if (this.elType === 'float' || this.elType === 'int') {
      if (typeof v !== 'number') throw runtimeError(`array<float>.set expects a number, got ${typeof v}`);
      return;
    }
    if (this.elType === 'bool' && typeof v !== 'boolean') throw runtimeError('array<bool>.set expects a bool');
    if (this.elType === 'string' && typeof v !== 'string') throw runtimeError('array<string>.set expects a string');
  }
  size() { return this.items.length; }
  push(v) { this._check(v); this.items.push(v); }
  pop() { if (!this.items.length) return NA; return this.items.pop(); }
  shift() { if (!this.items.length) return NA; return this.items.shift(); }
  unshift(v) { this._check(v); this.items.unshift(v); return this.items.length; }
  insert(i, v) {
    /* ROUND224: negative insert counts from the end (v6 parity). */
    let k = Math.trunc(i);
    if (k < 0) k += this.items.length;
    k = Math.max(0, Math.min(this.items.length, k));
    this._check(v);
    this.items.splice(k, 0, v);
  }
  remove(i) { const k = this._idx(i); return this.items.splice(k, 1)[0]; }
  clear() { this.items.length = 0; }
  first() { return this.items.length ? this.items[0] : NA; }
  last() { return this.items.length ? this.items[this.items.length - 1] : NA; }
  includes(v) { return this.indexOf(v) >= 0; }
  indexOf(v) {
    for (let k = 0; k < this.items.length; k++) {
      const it = this.items[k];
      if (isNA(v) && isNA(it)) return k;
      if (v === it) return k;
      if (typeof v === 'number' && typeof it === 'number' && v === it) return k;
    }
    return -1;
  }
  lastIndexOf(v) {
    for (let k = this.items.length - 1; k >= 0; k--) {
      const it = this.items[k];
      if (isNA(v) && isNA(it)) return k;
      if (v === it) return k;
    }
    return -1;
  }
  slice(from, to) {
    const n = this.items.length;
    let a = from == null ? 0 : Math.trunc(from);
    let b = to == null ? n : Math.trunc(to);
    if (a < 0) a += n;
    if (b < 0) b += n;
    return new PineArray(this.elType, this.items.slice(Math.max(0, a), Math.max(0, b)));
  }
  copy() { return new PineArray(this.elType, this.items.slice()); }
  concat(other) {
    if (!other || !other.__pineArray) throw runtimeError('array.concat expects an array');
    return new PineArray(this.elType, this.items.concat(other.items));
  }
  join(sep) { return this.items.map((v) => (isNA(v) ? 'NaN' : (v && v.__pineArray ? '<array>' : String(v)))).join(sep == null || isNA(sep) ? ', ' : String(sep)); }
  reverse() {
    /* ROUND209 (TV parity): reverse/sort mutate IN PLACE (TV returns void).
       Both used to build a new array the caller discarded, so a.sort() /
       a.reverse() as statements silently did nothing. Returning `this`
       keeps chaining (`b = a.sort()`) working; TV-void deviation documented. */
    this.items.reverse();
    return this;
  }
  sort(order, sortField) {
    /* ROUND151: order.* enum (order.descending) or legacy -1/1; default ascending */
    /* ROUND224 (TV parity): sort_field (const int index or string name)
       sorts UDT arrays by a field; other element kinds fall back to the
       plain order (documented leniency). */
    const desc = order === -1 || enumPayload(order) === 'descending';
    const sorted = this.items.slice().sort((a, b) => {
      const ka = keyOf(a, sortField), kb = keyOf(b, sortField);
      if (isNA(ka)) return 1;
      if (isNA(kb)) return -1;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    if (desc) sorted.reverse();
    this.items = sorted; // ROUND209: in place (see reverse)
    return this;
  }
  sortIndices(order, sortField) {
    const desc = order === -1 || enumPayload(order) === 'descending';
    const idx = this.items.map((v, k) => k);
    idx.sort((x, y) => {
      const ka = keyOf(this.items[x], sortField), kb = keyOf(this.items[y], sortField);
      if (isNA(ka)) return 1;
      if (isNA(kb)) return -1;
      const r = ka < kb ? -1 : ka > kb ? 1 : 0;
      return desc ? -r : r;
    });
    return new PineArray('int', idx);
  }
  fill(v, idxFrom, idxTo) {
    let a = idxFrom == null || isNA(idxFrom) ? 0 : Math.trunc(idxFrom);
    let b = idxTo == null || isNA(idxTo) ? this.items.length : Math.trunc(idxTo);
    if (a < 0) a += this.items.length;
    if (b < 0) b += this.items.length;
    for (let k = Math.max(0, a); k < Math.min(this.items.length, b); k++) this.items[k] = v;
  }
  numeric() { // sum/avg/min/max helpers: NA-filtered numbers
    const out = [];
    for (const v of this.items) if (!isNA(v) && typeof v === 'number' && isFinite(v)) out.push(v);
    return out;
  }
  sum() { const a = this.numeric(); return a.length ? a.reduce((x, y) => x + y, 0) : NA; }
  avg() { const a = this.numeric(); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NA; }
  min() { const a = this.numeric(); return a.length ? Math.min.apply(null, a) : NA; }
  max() { const a = this.numeric(); return a.length ? Math.max.apply(null, a) : NA; }
  median() {
    const a = this.numeric().sort((x, y) => x - y);
    if (!a.length) return NA;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  mode() {
    const a = this.numeric();
    if (!a.length) return NA;
    const counts = new Map();
    let best = a[0], bestC = 0;
    for (const v of a) {
      const c = (counts.get(v) || 0) + 1;
      counts.set(v, c);
      if (c > bestC) { best = v; bestC = c; }
    }
    return best;
  }
  range() { const a = this.numeric(); return a.length ? Math.max.apply(null, a) - Math.min.apply(null, a) : NA; }
  /* ROUND216 (TV parity): array.variance/stdev take biased (default true =
     population /N, like ta.stdev/ta.variance rounds 210-211). biased=false
     is sample /(N-1) with an L=1 guard. */
  variance(biased) {
    const a = this.numeric();
    if (!a.length) return NA;
    if (biased === false && a.length < 2) return NA;
    const mean = a.reduce((x, y) => x + y, 0) / a.length;
    let acc = 0;
    for (const v of a) acc += (v - mean) * (v - mean);
    return acc / (biased === false ? a.length - 1 : a.length);
  }
  stdev(biased) {
    const v = this.variance(biased);
    return isNA(v) ? NA : Math.sqrt(v);
  }
  standardize() {
    const mean = this.avg(), sd = Math.sqrt(this.variance());
    if (isNA(mean) || isNA(sd) || sd === 0) return new PineArray(this.elType, this.items.map(() => NA));
    return new PineArray(this.elType, this.items.map((v) => (isNA(v) ? NA : (v - mean) / sd)));
  }
  percentrank(iterations) {
    // percent of values in [0..iterations) window below the last value
    const n = Math.min(this.items.length, iterations == null ? this.items.length : Math.trunc(iterations));
    if (n < 2) return NA;
    const v = this.items[this.items.length - 1];
    if (isNA(v)) return NA;
    let cnt = 0, tot = 0;
    for (let k = this.items.length - n; k < this.items.length - 1; k++) {
      const it = this.items[k];
      if (isNA(it)) continue;
      tot++;
      if (it < v) cnt++;
    }
    return tot ? (100 * cnt) / tot : NA;
  }
  from() {} // placeholder (static form used)
  /** deep clone for the var/rollback snapshot (item refs shared for objects) */
  snapshotClone() {
    return new PineArray(this.elType, this.items.map((v) => (v && v.__pineArray ? v.snapshotClone() : v)));
  }
}

const isArray = (v) => v != null && typeof v === 'object' && v.__pineArray === true;

/* ROUND224 (TV parity): sort_field key — const string name or int index
   into a UDT's fields (declaration order). Missing field -> na (sorts
   last); non-UDT items ignore sort_field (plain order, documented). */
function keyOf(item, sf) {
  if (sf == null || isNA(sf)) return item;
  if (item && item.__udt && item.fields && typeof item.fields === 'object') {
    if (typeof sf === 'string') {
      const v = item.fields[sf];
      return v === undefined ? NA : v;
    }
    if (typeof sf === 'number' && isFinite(sf)) {
      const keys = Object.keys(item.fields);
      const k = keys[Math.trunc(sf)];
      if (k === undefined) return NA;
      const v = item.fields[k];
      return v === undefined ? NA : v;
    }
  }
  return item;
}

/** array.new<T>(size, initial) */
function arrNew(elType, size, initial) {
  const n = (size === NA || size == null) ? 0 : Math.max(0, Math.trunc(size));
  const items = new Array(n);
  const fillV = (initial === undefined || initial == null) ? NA : initial;
  for (let k = 0; k < n; k++) items[k] = fillV && fillV.__pineArray ? fillV.snapshotClone() : fillV;
  return new PineArray(elType, items);
}

/** array.from(...) — element type inferred from args */
function arrFrom(...args) {
  let elType = 'any';
  for (const a of args) {
    if (isNA(a)) continue;
    if (typeof a === 'number') elType = 'float';
    else if (typeof a === 'boolean') elType = 'bool';
    else if (typeof a === 'string') elType = 'string';
    else if (a && a.__pineArray) elType = 'array';
    break;
  }
  return new PineArray(elType, args.slice());
}

/** array.copy(source) */
function arrCopy(src) {
  if (!isArray(src)) throw runtimeError('array.copy expects an array');
  return src.copy();
}

export { PineArray, isArray, arrNew, arrFrom, arrCopy, keyOf };
