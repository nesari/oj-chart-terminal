/**
 * Pine maps (round 196).
 *
 * A PineMap is a REFERENCE type (like arrays/matrices): put/remove/clear
 * mutate in place. Insertion-ordered (JS Map), na keys rejected (loud),
 * na values allowed for any value type. Key/value types v1:
 * int/float/bool/string (+any untyped) — object values stay loud.
 *
 * House rules (documented): put returns the value, remove returns the
 * removed value (na when absent), clear returns the map (array.clear
 * parity), keys()/values() return typed arrays.
 *
 * @module core/pine/stdlib/map
 */

import { NA, isNA } from '../types.js';
import { runtimeError } from '../errors.js';
import { PineArray } from './array.js';

const SCALAR_TYPES = new Set(['any', 'int', 'float', 'bool', 'string']);

function checkType(t, v, what) {
  if (t === 'any' || isNA(v)) return;
  if (t === 'float' || t === 'int') {
    if (typeof v !== 'number') throw runtimeError(`${what} expects a number, got ${typeof v}`);
    return;
  }
  if (t === 'bool' && typeof v !== 'boolean') throw runtimeError(`${what} expects a bool`);
  if (t === 'string' && typeof v !== 'string') throw runtimeError(`${what} expects a string`);
}

class PineMap {
  constructor(keyType, valType, entries) {
    this.__pineMap = true;
    this.keyType = keyType || 'any';
    this.valType = valType || 'any';
    this.data = entries instanceof Map ? entries : new Map();
  }
  _key(k) {
    if (isNA(k) || k == null) throw runtimeError('map key cannot be na');
    checkType(this.keyType, k, `map<${this.keyType}> key`);
    return k;
  }
  put(k, v) {
    const key = this._key(k);
    checkType(this.valType, v, `map value`);
    this.data.set(key, v);
    return v;
  }
  get(k) {
    const key = this._key(k);
    return this.data.has(key) ? this.data.get(key) : NA;
  }
  contains(k) {
    const key = this._key(k);
    return this.data.has(key);
  }
  remove(k) {
    const key = this._key(k);
    if (!this.data.has(key)) return NA;
    const v = this.data.get(key);
    this.data.delete(key);
    return v;
  }
  clear() { this.data.clear(); return this; }
  size() { return this.data.size; }
  keys() { return new PineArray(this.keyType, [...this.data.keys()]); }
  values() { return new PineArray(this.valType, [...this.data.values()]); }
  copy() { return new PineMap(this.keyType, this.valType, new Map(this.data)); }
  /** deep clone for the var/rollback snapshot (values are scalars v1) */
  snapshotClone() { return this.copy(); }
}

const isMap = (v) => v != null && typeof v === 'object' && v.__pineMap === true;

/** map.new<K, V>() */
function mapNew(keyType, valType) {
  const k = keyType || 'any', v = valType || 'any';
  if (!SCALAR_TYPES.has(k)) throw runtimeError(`map<${k}, ...> keys are not supported in this engine version yet (int/float/bool/string only)`);
  if (!SCALAR_TYPES.has(v)) throw runtimeError(`map<..., ${v}> values are not supported in this engine version yet (int/float/bool/string only)`);
  return new PineMap(k, v);
}

export { PineMap, isMap, mapNew };
