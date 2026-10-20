/**
 * Pine execution scope primitives (round 74 — roadmap phases 2+3)
 *
 * SeriesBuf: the per-variable / per-expression history ring behind the
 * [] history operator. Core OHLCV series run 10000 deep (ROUND156, TV
 * parity); everything else follows max_bars_back (default 5000, declaration
 * up to 25000) — the same depth the app loads.
 *
 * @module core/pine/scope
 */

import { NA } from './types.js';

class SeriesBuf {
  constructor(cap) {
    this.a = [];
    this.cap = cap || 5000;
  }
  push(v) {
    this.a.push(v);
    if (this.a.length > this.cap) this.a.shift();
  }
  /** offset 0 = current bar's value, 1 = previous bar, ... */
  get(off) {
    const i = this.a.length - 1 - off;
    return i >= 0 ? this.a[i] : NA;
  }
  snap() { return this.a.slice(); }
  restore(arr) { this.a = arr.slice(); }
}

export { SeriesBuf };
