/**
 * Pine color.* namespace (round 74)
 *
 * @module core/pine/stdlib/color
 */

import { NA, isNA, toColor, colorNew, colorRGB, PineColor, NAMED_COLORS, makeEnumConst } from '../types.js';

const colorFns = {
  new: function (site, base, transp) { return colorNew(base, transp); },
  rgb: function (site, r, g, b, transp) {
    const c = (v, d) => (isNA(v) || v == null || typeof v !== 'number' || !isFinite(v)) ? d : Math.min(255, Math.max(0, Math.round(v)));
    return colorRGB(c(r, 0), c(g, 0), c(b, 0), transp);
  },
  r: function (site, c) { const x = toColor(c); return x ? x.r : NA; },
  g: function (site, c) { const x = toColor(c); return x ? x.g : NA; },
  b: function (site, c) { const x = toColor(c); return x ? x.b : NA; },
  t: function (site, c) { const x = toColor(c); return x ? (1 - x.a) * 100 : NA; }, // transp 0..100
  gradient: function (site, c1, c2, step) {
    const a = toColor(c1), b = toColor(c2);
    if (!a || !b || isNA(step) || typeof step !== 'number') return NA;
    const t = Math.min(1, Math.max(0, step));
    return new PineColor(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, a.a + (b.a - a.a) * t);
  },
  from_gradient: function (site, value, bottom, top, c0, c1) {
    if (isNA(value) || isNA(bottom) || isNA(top) || typeof value !== 'number') return NA;
    if (top === bottom) return c0;
    const t = Math.min(1, Math.max(0, (value - bottom) / (top - bottom)));
    return colorFns.gradient(site, c0, c1, t);
  },
};

/* named color constants — each maps to a PineColor */
const colorConsts = {};
for (const name of Object.keys(NAMED_COLORS)) {
  colorConsts[name] = toColor(NAMED_COLORS[name]);
}

export { colorFns, colorConsts };
