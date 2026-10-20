/**
 * Pine value model (round 74)
 *
 * The runtime representation of Pine values. Design notes:
 *  - `na` is the dedicated NA singleton (never undefined/null inside the
 *    engine — those mean "bug"); na() tests are exact-identity.
 *  - colors are immutable PineColor instances (rgba + optional named/hex
 *    source); every color op returns a NEW instance.
 *  - int/float are JS numbers; bool/string are JS primitives.
 *  - reference types (arrays / line / box / label objects) live in
 *    stdlib/array.js and stdlib/objects.js respectively.
 *  - qualifiers (const < input < simple < series) are tracked only where the
 *    official compiler ENFORCES them in practice (plot linestyle/style args,
 *    request.* arguments) — a numeric rank rides on enum-constant objects.
 *
 * @module core/pine/types
 */

/** The na value. Singleton — identity comparisons only. */
const NA = (function () {
  const o = { __pineNA: true };
  Object.defineProperty(o, 'toString', { value: () => 'na' });
  return o;
})();

const isNA = (v) => v === NA;
/** truthiness of a Pine value in conditions: na and false are falsy */
const truthy = (v) => !(v === NA || v === false || v === null || v === undefined || v === 0);

/** number or na -> JS number (NaN for na) — for math kernels */
const num = (v) => (v === NA || v == null || (typeof v !== 'number') || !isFinite(v)) ? NaN : v;
/** JS number -> Pine value (NaN/Infinity -> na) */
const pineNum = (v) => (v == null || typeof v !== 'number' || !isFinite(v)) ? NA : v;

/* ------------------------------------------------------------------ color */

const NAMED_COLORS = {
  aqua: '#00bcd4', black: '#363a45', blue: '#2962ff', fuchsia: '#e040fb',
  gray: '#787b86', green: '#4caf50', lime: '#00e676', maroon: '#880e4f',
  navy: '#311b92', olive: '#808000', orange: '#ff9800', purple: '#9c27b0',
  red: '#f23645', silver: '#b2b5be', teal: '#00bcd4', white: '#ffffff',
  yellow: '#f7c948',
  /* extended palette (official constant set) */
  lime_green: '#00e676', forest_green: '#2e7d32', olive_drab: '#6b8e23',
  dark_green: '#1b5e20', sea_green: '#2e8b57', green_yellow: '#aeea00',
  spring_green: '#00e676', light_green: '#81c784', medium_spring_green: '#00fa9a',
  yellow_green: '#9ccc65', chartreuse: '#c6ff00', dark_orange: '#ff9800',
  orange_red: '#ff5252', dark_red: '#b71c1c', fire_brick: '#d32f2f',
  crimson: '#f44336', indian_red: '#e57373', light_coral: '#ff8a80',
  salmon: '#ff8a65', light_salmon: '#ffab91', dark_salmon: '#ffab91',
  coral: '#ff7043', tomato: '#ff6f00', sandy_brown: '#ffa726',
  chocolate: '#d2691e', sienna: '#a1887f', brown: '#795548',
  dark_goldenrod: '#f9a825', goldenrod: '#fbc02d', gold: '#fdd835',
  khaki: '#f0e68c', yellow_green2: '#9ccc65', dark_khaki: '#bdb76b',
  magenta: '#e040fb', violet: '#ba68c8', plum: '#ce93d8', orchid: '#ba68c8',
  medium_orchid: '#ba68c8', dark_orchid: '#7b1fa2', dark_violet: '#7b1fa2',
  blue_violet: '#7c4dff', slate_blue: '#7986cb', medium_slate_blue: '#7986cb',
  medium_purple: '#9575cd', thistle: '#e1bee7', lavender: '#e6e6fa',
  dodger_blue: '#2196f3', royal_blue: '#4169e1', deep_sky_blue: '#00b0ff',
  cornflower_blue: '#42a5f5', light_blue: '#81d4fa', sky_blue: '#87ceeb',
  steel_blue: '#4682b4', cadet_blue: '#90a4ae', dark_slate_gray: '#37474f',
  navy_blue: '#304ffe', medium_blue: '#2962ff', dark_blue: '#1a237e',
  midnight_blue: '#1a237e', turquoise: '#26c6da', medium_turquoise: '#26c6da',
  light_sea_green: '#26a69a', pale_turquoise: '#b2dfdb', dark_slate_gray2: '#37474f',
  dark_cyan: '#0097a7', cyan: '#00bcd4', light_cyan: '#e0f7fa',
  gray50: '#b2b5be', gray70: '#787b86', gray100: '#363a45', gray40: '#c8cbd4',
  beige: '#f5f5dc', wheat: '#ffe0b2', tan: '#d2b48c', rosy_brown: '#bcaaa4',
  dim_gray: '#616161', dark_gray: '#424242', light_gray: '#d6d6d6',
  hot_pink: '#ff4081', deep_pink: '#f50057', pink: '#f48fb1', light_pink: '#f8bbd0',
  pale_violet_red: '#e57373',
};

const HEX_RE = /^#([0-9a-f]{3,8})$/i;
/* ROUND78 (BUG-78-C): input.color(color.new(base, transp)) registers its
   default as the PineColor CSS form 'rgba(r,g,b,a)'. toColor() used to accept
   only hex/named — every transparency-carrying default (786 Zones: all six
   session colors, border, midline) parsed to NULL and the runtime then saw
   `na`, so a FRESH add (no settings dialog Ok yet) drew boxes with no fill
   and no border. The rgba()/rgb() branch makes the css() round-trip lossless:
   PineColor -> css() -> toColor -> identical PineColor. */
const RGBA_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i;

class PineColor {
  constructor(r, g, b, a) {
    this.r = Math.round(Math.min(255, Math.max(0, r)));
    this.g = Math.round(Math.min(255, Math.max(0, g)));
    this.b = Math.round(Math.min(255, Math.max(0, b)));
    /** opacity 0..1 (Pine "transp" 0..100 is converted on entry) */
    this.a = Math.min(1, Math.max(0, a == null ? 1 : a));
  }
  css() {
    return `rgba(${this.r},${this.g},${this.b},${Math.round(this.a * 1000) / 1000})`;
  }
  hex() {
    const h = (n) => n.toString(16).padStart(2, '0');
    return '#' + h(this.r) + h(this.g) + h(this.b);
  }
  eq(o) { return o instanceof PineColor && o.r === this.r && o.g === this.g && o.b === this.b && o.a === this.a; }
}

/** parse anything colorish -> PineColor or null */
function toColor(v) {
  if (v instanceof PineColor) return v;
  if (typeof v === 'string') {
    const m = HEX_RE.exec(v.trim());
    if (m) {
      const h = m[1];
      if (h.length === 3) return new PineColor(parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1);
      const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return new PineColor(r, g, b, a);
    }
    const named = NAMED_COLORS[v.trim().toLowerCase()];
    if (named) return toColor(named);
    const rm = RGBA_RE.exec(v.trim());
    if (rm) {
      const a = rm[4] == null ? 1 : Math.min(1, Math.max(0, parseFloat(rm[4])));
      return new PineColor(parseInt(rm[1], 10), parseInt(rm[2], 10), parseInt(rm[3], 10), a);
    }
  }
  return null;
}

/** color.new(base, transp) — transp 0..100 (100 = invisible) */
function colorNew(base, transp) {
  const c = toColor(base);
  if (!c) return NA;
  let a = c.a;
  if (transp !== NA && transp != null && typeof transp === 'number' && isFinite(transp)) a = 1 - Math.min(100, Math.max(0, transp)) / 100;
  return new PineColor(c.r, c.g, c.b, a);
}

function colorRGB(r, g, b, transp) {
  const a = (transp === NA || transp == null) ? 1 : 1 - Math.min(100, Math.max(0, transp)) / 100;
  return new PineColor(r, g, b, a);
}

/* ------------------------------------------------- enum-constant objects */

/** built-in enum constants (plot.linestyle_*, shape.*, line.style_*, ...).
    Each carries a string payload + qualifier rank 0 (const). */
function makeEnumConst(payload, kind) {
  return { __pineEnum: true, payload: String(payload), kind: kind || '', q: 0 };
}
const isEnumConst = (v) => v != null && typeof v === 'object' && v.__pineEnum === true;
const enumPayload = (v) => (isEnumConst(v) ? v.payload : null);

/* ------------------------------------------------------ qualifier ranks */

const Q_CONST = 0, Q_INPUT = 1, Q_SIMPLE = 2, Q_SERIES = 3;
/** max of two qualifiers (a value's qualifier propagates through ops) */
const qmax = (a, b) => (a > b ? a : b);

export {
  NA, isNA, truthy, num, pineNum,
  PineColor, NAMED_COLORS, toColor, colorNew, colorRGB,
  makeEnumConst, isEnumConst, enumPayload,
  Q_CONST, Q_INPUT, Q_SIMPLE, Q_SERIES, qmax,
};
