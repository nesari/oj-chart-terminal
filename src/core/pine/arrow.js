/**
 * plotarrow arrow-height scaling (ROUND149).
 *
 * TV maps the series magnitude onto [minheight, maxheight] pixels. Exact
 * TV normalization scope is undocumented publicly, so this module owns the
 * house rule explicitly: |v| is mapped linearly across the SERIES' own
 * [minAbs, maxAbs] (full run, not the viewport — panning never resizes
 * arrows). When neither param is given the Style-tab size applies
 * (ROUND148 fixed path); when only one end is given the other defaults
 * to a sane bound (lo -> 0, hi -> max(lo + 1, fallback * 2)).
 *
 * Pure + core-side (no DOM) so node unit tests exercise the real math.
 *
 * @module pine/arrow
 */

/**
 * Pixel height for one arrow.
 * @param {number|null} mag series |v| on this bar (null/NaN -> fallback)
 * @param {number|null} lo minheight param (px) or null when absent
 * @param {number|null} hi maxheight param (px) or null when absent
 * @param {number} minAbs series min |v| over the run
 * @param {number} maxAbs series max |v| over the run
 * @param {number} fallback Style-tab size px (both params absent)
 */
export function arrowHeight(mag, lo, hi, minAbs, maxAbs, fallback) {
  if (lo == null && hi == null) return fallback;
  const a = lo != null ? lo : 0;
  const b = hi != null ? hi : Math.max(a + 1, fallback * 2);
  if (mag == null || !isFinite(mag)) return fallback;
  if (!(maxAbs > minAbs)) return b; // flat series: every arrow at max
  const t = Math.min(1, Math.max(0, (mag - minAbs) / (maxAbs - minAbs)));
  return a + t * (b - a);
}

/** [min, max] of finite non-null magnitudes, or null when empty. */
export function magRange(mags) {
  let lo = Infinity, hi = -Infinity;
  if (mags) {
    for (let i = 0; i < mags.length; i++) {
      const m = mags[i];
      if (m != null && isFinite(m) && m > 0) {
        if (m < lo) lo = m;
        if (m > hi) hi = m;
      }
    }
  }
  return lo <= hi ? [lo, hi] : null;
}
