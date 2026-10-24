/**
 * global app state, timeframes, drawings store
 *
 * Phase 3: this module moved into the platform-agnostic core. All its
 * persistence goes through the ENV.storage seam (core/env.js) — in the
 * Electron renderer that maps to the browser storage, in Node tests it
 * degrades to defaults, and the phase-4 web shell can swap the implementation.
 *
 * @module core/state
 */

import { ENV } from './env.js';
import { debounce } from './util.js';
import { Log } from './logger.js';

const TF = [
    { id: 'S1', sec: 1, label: '1s', group: 'Seconds' },
    { id: 'S5', sec: 5, label: '5s', group: 'Seconds' },
    { id: 'S15', sec: 15, label: '15s', group: 'Seconds' },
    { id: 'S30', sec: 30, label: '30s', group: 'Seconds' },
    { id: 'M1', sec: 60, label: '1m', group: 'Minutes' },
    { id: 'M3', sec: 180, label: '3m', group: 'Minutes' },
    { id: 'M5', sec: 300, label: '5m', group: 'Minutes' },
    { id: 'M15', sec: 900, label: '15m', group: 'Minutes' },
    { id: 'M30', sec: 1800, label: '30m', group: 'Minutes' },
    { id: 'M45', sec: 2700, label: '45m', group: 'Minutes' },
    { id: 'H1', sec: 3600, label: '1H', group: 'Hours' },
    { id: 'H2', sec: 7200, label: '2H', group: 'Hours' },
    { id: 'H3', sec: 10800, label: '3H', group: 'Hours' },
    { id: 'H4', sec: 14400, label: '4H', group: 'Hours' },
    { id: 'D1', sec: 86400, label: 'D', group: 'Days' },
    { id: 'W1', sec: 604800, label: 'W', group: 'Weeks' },
    { id: 'MN1', sec: 2592000, label: 'M', group: 'Months' },
    { id: 'MN3', sec: 7776000, label: '3M', group: 'Months' },
    { id: 'MN6', sec: 15552000, label: '6M', group: 'Months' },
    { id: 'MN12', sec: 31104000, label: '12M', group: 'Months' },
  ];
  const tfById = {};
  TF.forEach((t) => { tfById[t.id] = t; });

  /* history depth (parity with the reference platform): deeper initial loads
     (providers now serve up to 25k bars) + "Load older bars" pagination on
     top of these — the old shallow counts starved both the demo and the
     live-MT5 charts. */
  const COUNT_FOR = {
    S1: 3000, S5: 3000, S15: 2500, S30: 2500,
    M1: 5000, M3: 4000, M5: 4000, M15: 3000, M30: 2500, M45: 2000,
    H1: 2500, H2: 2000, H3: 1500, H4: 1500,
    D1: 1200, W1: 800, MN1: 500, MN3: 300, MN6: 250, MN12: 200,
  };
  /* older-history page size (bars per "Load older bars" request) */
  const OLDER_CHUNK = 1000;
  /* hard cap of the on-chart history (pagination stops here) */
  const MAX_CHART_BARS = 25000;

  const STYLES = [
    { id: 'bars', name: 'Bars', icon: 'barsstyle' },
    { id: 'candles', name: 'Candles', icon: 'candles' },
    { id: 'hollow', name: 'Hollow candles', icon: 'hollow' },
    { id: 'heikin', name: 'Heikin Ashi', icon: 'heikin' },
    { id: 'line', name: 'Line', icon: 'linestyle' },
    { id: 'linemarkers', name: 'Line with markers', icon: 'linemarkers' },
    { id: 'step', name: 'Step line', icon: 'step' },
    { id: 'area', name: 'Area', icon: 'area' },
    { id: 'baseline', name: 'Baseline', icon: 'baseline' },
    { id: 'highlow', name: 'High-low', icon: 'highlow' },
    { id: 'renko', name: 'Renko', icon: 'renko' },
  ];

  /* TV layout catalog: every layout = uniform C×R grid + tiles [x,y,w,h] (reading order).
     Legacy ids ('1','2v','2h','3','4','6','8') are preserved so saved settings keep working. */
  const L = (id, name, C, R, tiles) => ({ id, name, C, R, tiles });
  const row = (C, y = 0, h = 1) => Array.from({ length: C }, (_, i) => [i, y, 1, h]);
  const col = (R, x = 0, w = 1) => Array.from({ length: R }, (_, i) => [x, i, w, 1]);
  const LAYOUTS = [
    L('1', 'Single chart', 1, 1, [[0, 0, 1, 1]]),
    /* 2 */
    L('2v', 'Two columns', 2, 1, row(2)),
    L('2h', 'Two rows', 1, 2, col(2)),
    /* 3 */
    L('3t', 'Big pane on top', 2, 2, [[0, 0, 2, 1], [0, 1, 1, 1], [1, 1, 1, 1]]),
    L('3l', 'Big pane on the left', 2, 2, [[0, 0, 1, 2], [1, 0, 1, 1], [1, 1, 1, 1]]),
    L('3r', 'Big pane on the right', 2, 2, [[0, 0, 1, 1], [1, 0, 1, 2], [0, 1, 1, 1]]),
    L('3c', 'Three columns', 3, 1, row(3)),
    L('3rr', 'Three rows', 1, 3, col(3)),
    L('3b', 'Big pane at the bottom', 2, 2, [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 2, 1]]),
    /* 4 */
    L('4', '2 × 2 grid', 2, 2, [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1]]),
    L('4c', 'Four columns', 4, 1, row(4)),
    L('4r', 'Four rows', 1, 4, col(4)),
    L('4l', 'Big pane on the left', 2, 3, [[0, 0, 1, 3], [1, 0, 1, 1], [1, 1, 1, 1], [1, 2, 1, 1]]),
    L('4rr', 'Big pane on the right', 2, 3, [[0, 0, 1, 1], [0, 1, 1, 1], [0, 2, 1, 1], [1, 0, 1, 3]]),
    L('4t', 'Big pane on top', 3, 2, [[0, 0, 3, 1], [0, 1, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1]]),
    L('4b', 'Big pane at the bottom', 3, 2, [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1], [0, 1, 3, 1]]),
    L('4lt', 'Big top-left corner', 3, 3, [[0, 0, 2, 2], [2, 0, 1, 1], [2, 1, 1, 1], [0, 2, 2, 1]]),
    L('4lb', 'Big bottom-left corner', 3, 3, [[0, 0, 2, 1], [2, 0, 1, 1], [0, 1, 2, 2], [2, 1, 1, 1]]),
    L('4tr', 'Big top-right corner', 3, 3, [[0, 0, 1, 1], [1, 0, 2, 2], [0, 1, 1, 1], [1, 2, 2, 1]]),
    /* 5 */
    L('5t', 'Big pane on top', 4, 2, [[0, 0, 4, 1], [0, 1, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1], [3, 1, 1, 1]]),
    L('5b', 'Big pane at the bottom', 4, 2, [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1], [3, 0, 1, 1], [0, 1, 4, 1]]),
    L('5l', 'Big pane on the left', 2, 4, [[0, 0, 1, 4], [1, 0, 1, 1], [1, 1, 1, 1], [1, 2, 1, 1], [1, 3, 1, 1]]),
    L('5r', 'Big pane on the right', 2, 4, [[0, 0, 1, 1], [0, 1, 1, 1], [0, 2, 1, 1], [0, 3, 1, 1], [1, 0, 1, 4]]),
    L('5e', '3 charts on top, 2 below', 6, 2, [[0, 0, 2, 1], [2, 0, 2, 1], [4, 0, 2, 1], [0, 1, 3, 1], [3, 1, 3, 1]]),
    L('5f', '2 charts on top, 3 below', 6, 2, [[0, 0, 3, 1], [3, 0, 3, 1], [0, 1, 2, 1], [2, 1, 2, 1], [4, 1, 2, 1]]),
    L('5g', '3 columns on the left, 2 on the right', 2, 6, [[0, 0, 1, 2], [0, 2, 1, 2], [0, 4, 1, 2], [1, 0, 1, 3], [1, 3, 1, 3]]),
    L('5h', '2 columns on the left, 3 on the right', 2, 6, [[0, 0, 1, 3], [0, 3, 1, 3], [1, 0, 1, 2], [1, 2, 1, 2], [1, 4, 1, 2]]),
    L('5i', 'Plus', 3, 3, [[1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1], [1, 2, 1, 1]]),
    L('5j', '2 × 2 grid and a wide chart', 2, 3, [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1], [0, 2, 2, 1]]),
    /* 6 */
    L('6', '2 × 3 grid', 2, 3, row(2, 0).concat(row(2, 1), row(2, 2))),
    L('6x', '3 × 2 grid', 3, 2, row(3, 0).concat(row(3, 1))),
    L('6c', 'Six columns', 6, 1, row(6)),
    L('6rr', 'Six rows', 1, 6, col(6)),
    L('6l', 'Big pane on the left', 2, 5, [[0, 0, 1, 5]].concat(row(5, 0, 1).map((t) => [1, t[1], 1, 1]))),
    L('6t', 'Big pane on top', 5, 2, [[0, 0, 5, 1]].concat(row(5, 1))),
    /* 7 */
    L('7l', 'Big pane on the left', 2, 6, [[0, 0, 1, 6]].concat(Array.from({ length: 6 }, (_, i) => [1, i, 1, 1]))),
    L('7e', '3 charts on top, 4 below', 4, 2, [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1], [3, 1, 1, 1]]),
    L('7f', '4 charts on top, 3 below', 4, 2, [[0, 0, 1, 1], [1, 0, 1, 1], [2, 0, 1, 1], [3, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1]]),
    /* 8 */
    L('8', '2 × 4 grid', 2, 4, row(2, 0).concat(row(2, 1), row(2, 2), row(2, 3))),
    L('8x', '4 × 2 grid', 4, 2, row(4, 0).concat(row(4, 1))),
    L('8l', 'Big pane on the left', 2, 7, [[0, 0, 1, 7]].concat(Array.from({ length: 7 }, (_, i) => [1, i, 1, 1]))),
    L('8t', 'Big pane on top', 7, 2, [[0, 0, 7, 1]].concat(row(7, 1))),
    /* 9 */
    L('9', '3 × 3 grid', 3, 3, row(3, 0).concat(row(3, 1), row(3, 2))),
    L('9l', 'Big pane on the left', 2, 8, [[0, 0, 1, 8]].concat(Array.from({ length: 8 }, (_, i) => [1, i, 1, 1]))),
    L('9t', 'Big pane on top', 8, 2, [[0, 0, 8, 1]].concat(row(8, 1))),
    L('9d', '4 charts on top, 5 below', 5, 2, row(4, 0).concat(row(5, 1))),
    /* 10 */
    L('10a', '5 × 2 grid', 5, 2, row(5, 0).concat(row(5, 1))),
    L('10b', '2 × 5 grid', 2, 5, row(2, 0).concat(row(2, 1), row(2, 2), row(2, 3), row(2, 4))),
    L('10t', 'Big pane on top', 9, 2, [[0, 0, 9, 1]].concat(row(9, 1))),
    /* 12 */
    L('12a', '6 × 2 grid', 6, 2, row(6, 0).concat(row(6, 1))),
    L('12b', '4 × 3 grid', 4, 3, row(4, 0).concat(row(4, 1), row(4, 2))),
    L('12c', '3 × 4 grid', 3, 4, row(3, 0).concat(row(3, 1), row(3, 2), row(3, 3))),
    /* 14 */
    L('14a', '7 × 2 grid', 7, 2, row(7, 0).concat(row(7, 1))),
    /* 16 */
    L('16a', '8 × 2 grid', 8, 2, row(8, 0).concat(row(8, 1))),
    L('16b', '4 × 4 grid', 4, 4, row(4, 0).concat(row(4, 1), row(4, 2), row(4, 3))),
  ];

  const App = {
    panes: [],
    activePane: null,
    feed: null,
    tf: TF,
    tfById,
    COUNT_FOR,
    STYLES,
    LAYOUTS,
    /* user settings */
    tool: null,            // active drawing tool id
    OLDER_CHUNK,
    MAX_CHART_BARS,
    /* Magnet Mode (TV): 'off' | 'weak' | 'strong' — weak snaps only within a
       small pixel radius of the bar's O/H/L/C, strong always snaps; Alt = temporary off */
    magnetMode: ENV.storage.get('mt5_magnet_mode', 'off'),
    altDown: false,        // Alt bypasses the magnet while held (set by app.js)
    lockAll: false,
    hideAll: false,
    /* ROUND251 (TV parity — "Stay in drawing mode"): repeat-draw happens ONLY
       while this lock is on. TV default is one-shot (R246's always-sticky was
       wrong per the user report). Persists like the other toolbar toggles. */
    stayDraw: ENV.storage.get('mt5_stay_draw', false),
    tz: (function () {
      /* 'broker' = the broker server wall clock (TV "exchange time"), the
         auto-detected default. Any IANA zone is rendered from TRUE UTC using
         the provider-measured offset, so every zone shows correct local time.
         One-time migration: the old factory default 'UTC' actually displayed
         the broker clock, so it maps to 'broker' (deliberate UTC picks are
         kept — migration runs once, flag-guarded). */
      const saved = ENV.storage.get('mt5_tz', null);
      if (saved == null) return 'broker';
      if (saved === 'UTC' && !ENV.storage.get('mt5_tz_mig', false)) {
        ENV.storage.set('mt5_tz_mig', true);
        ENV.storage.set('mt5_tz', 'broker');
        return 'broker';
      }
      return saved;
    })(),
    /* Free Transform (round 19): when on, body-drag glides the chart freely in
       BOTH directions (the price window pins on the first vertical move) */
    freeTransform: ENV.storage.get('mt5_free_tf', false),
    tfFavorites: ENV.storage.get('mt5_tf_favs', ['M5', 'M15', 'H1', 'H4', 'D1']),
    toolFavorites: ENV.storage.get('mt5_tool_favs', []),
    styleFavorites: ENV.storage.get('mt5_style_favs', []),
    style: ENV.storage.get('mt5_style', 'candles'),
    layout: ENV.storage.get('mt5_layout', '1'),
    /* Sync in Layout (TV): propagation across panes.
       ROUND120 (user request): 'crossX' — when the layout mixes DIFFERENT
       symbols, the mouse crosshair follows between different-symbol charts
       ONLY while this toggle is on (the plain 'crosshair' toggle governs
       same-symbol charts, exactly as before). */
    sync: Object.assign(
      { symbol: false, interval: false, crosshair: true, crossX: false, time: false, daterange: false },
      ENV.storage.get('mt5_sync', {})
    ),
    favBarVisible: ENV.storage.get('mt5_favbar_visible', false),
    favBarPos: ENV.storage.get('mt5_favbar_pos', null),
    watchlist: ENV.storage.get('mt5_watchlist', ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD']),
    symbolDescs: {},
  };

  /* ---- drawings store (per symbol) ---- */
  /* Persisted drawings are user data and survive app upgrades, so treat the
     stored blob as untrusted: a corrupt/legacy shape must not make the chart
     throw on boot. Normalise buckets to { next, items } and keep only objects. */
  const normalizeDrawings = (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [symbol, bucket] of Object.entries(raw)) {
      if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
      const items = Array.isArray(bucket.items)
        ? bucket.items.filter((d) => d && typeof d === 'object' && !Array.isArray(d))
        : [];
      let next = Number.isFinite(bucket.next) ? Math.floor(bucket.next) : 1;
      if (next < 1) next = 1;
      let max = 0;
      for (const d of items) {
        const id = Number(d.id);
        if (Number.isFinite(id) && id > max) max = id;
      }
      if (next <= max) next = max + 1;
      out[symbol] = { next, items };
    }
    return out;
  };

  const Drawings = {
    data: normalizeDrawings(ENV.storage.get('mt5_drawings', {})),
    _save: debounce(function () { ENV.storage.set('mt5_drawings', Drawings.data); }, 250),
    onChanged: [], // listeners for Object Tree etc.
    _notify() { for (const f of this.onChanged) { try { f(); } catch (e) {} } },

    bucket(symbol) {
      let b = this.data[symbol];
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        b = this.data[symbol] = { next: 1, items: [] };
      }
      if (!Array.isArray(b.items)) b.items = [];
      if (!Number.isFinite(b.next) || b.next < 1) b.next = 1;
      let max = 0;
      for (const d of b.items) {
        const id = Number(d && d.id);
        if (Number.isFinite(id) && id > max) max = id;
      }
      if (b.next <= max) b.next = max + 1;
      return b;
    },
    list(symbol) {
      const b = this.data[symbol];
      return b && Array.isArray(b.items) ? b.items : [];
    },
    add(symbol, d) {
      const b = this.bucket(symbol);
      d.id = b.next++;
      d.symbol = symbol;
      b.items.push(d);
      this.save();
      this._notify();
      return d;
    },
    remove(symbol, id) {
      const b = this.data[symbol];
      if (!b || !Array.isArray(b.items)) return;
      b.items = b.items.filter((d) => d.id !== id);
      this.save();
      this._notify();
    },
    /* Visual order (TV ⋯ menu, round 21): render order = array order */
    moveToFront(symbol, id) {
      const b = this.data[symbol];
      if (!b || !Array.isArray(b.items)) return;
      const i = b.items.findIndex((d) => d.id === id);
      if (i < 0 || i === b.items.length - 1) return;
      const [it] = b.items.splice(i, 1);
      b.items.push(it);
      this.save();
      this._notify();
    },
    moveToBack(symbol, id) {
      const b = this.data[symbol];
      if (!b || !Array.isArray(b.items)) return;
      const i = b.items.findIndex((d) => d.id === id);
      if (i <= 0) return;
      const [it] = b.items.splice(i, 1);
      b.items.unshift(it);
      this.save();
      this._notify();
    },
    save() { this._save(); },
    /* immediate persist (Save Layout snapshot path — no debounce window) */
    saveNow() { ENV.storage.set('mt5_drawings', this.data); },
    removeAll(symbol) {
      this.data[symbol] = { next: 1, items: [] };
      this.save();
      this._notify();
    },
    defaultOpts(type) {
      /* factory defaults per tool type, then merge the user's last-used
         options for this tool ("remember settings for new drawings", TV)
         — persisted by the tool settings dialog on Ok. Round 20: the TEXT
         never carries over — new drawings start empty unless cloned. */
      const o = Drawings.factoryOpts(type);
      const last = ENV.storage.get('mt5_tool_last_' + type, null);
      if (last && typeof last === 'object' && !Array.isArray(last)) Object.assign(o, last);
      o.text = '';
      return o;
    },
    factoryOpts(type) {
      return JSON.parse(JSON.stringify(FACTORY_OPTS[type] || FACTORY_OPTS._base));
    },
  };

  /* factory (as-shipped) option sets per tool type. The settings dialog
     edits/extends these; unknown/missing fields must never break a drawing. */
  const FACTORY_OPTS = {
    _base: { color: '#2962ff', width: 2, style: 'solid' },
    trend: {
      color: '#2962ff', width: 2, style: 'solid',
      extendLeft: false, extendRight: false, arrows: false,
      middle: false, priceLabels: false,
      stats: 'hidden', statsPos: 'right', alwaysStats: false,
      text: '', fontSize: 11, textColor: '#d1d4dc',
      bold: false, italic: false, textVAlign: 'top', textHAlign: 'left',
    },
    arrow: { color: '#2962ff', width: 2, style: 'solid', text: '', fontSize: 11, textColor: '#d1d4dc', bold: false, italic: false, textVAlign: 'top', textHAlign: 'left' },
    ray: { color: '#2962ff', width: 2, style: 'solid', text: '', fontSize: 11, textColor: '#d1d4dc', bold: false, italic: false, textVAlign: 'top', textHAlign: 'left' },
    extended: { color: '#2962ff', width: 2, style: 'solid', text: '', fontSize: 11, textColor: '#d1d4dc', bold: false, italic: false, textVAlign: 'top', textHAlign: 'left' },
    parallel: {
      color: '#2962ff', width: 2, style: 'solid',
      extendLeft: false, extendRight: false,
      fill: true, fillColor: '#2962ff', fillOpacity: 0.12,
      text: '', fontSize: 11, textColor: '#d1d4dc',
      bold: false, italic: false, textVAlign: 'top', textHAlign: 'left',
    },
    hline: { color: '#2962ff', width: 2, style: 'solid', priceLabels: true, text: '', fontSize: 11, textColor: '#d1d4dc', bold: false, italic: false, textVAlign: 'top', textHAlign: 'left' },
    hray: { color: '#2962ff', width: 2, style: 'solid', priceLabels: true, text: '', fontSize: 11, textColor: '#d1d4dc', bold: false, italic: false, textVAlign: 'top', textHAlign: 'left' },
    vline: { color: '#2962ff', width: 2, style: 'solid', showTime: true, text: '', fontSize: 11, textColor: '#d1d4dc', bold: false, italic: false, textVAlign: 'top', textHAlign: 'left' },
    crossline: { color: '#2962ff', width: 2, style: 'solid', priceLabels: true, showTime: true, text: '', fontSize: 11, textColor: '#d1d4dc', bold: false, italic: false, textVAlign: 'top', textHAlign: 'left' },
    rect: {
      /* TV Box model (rounds 18/20): Extend + Border (with opacity) + always-on
         Middle line + Background; annotation font/alignment fields */
      color: '#2962ff', width: 2, style: 'solid', borderOpacity: 1,
      extendLeft: false, extendRight: false,
      middle: true, middleColor: '#2962ff', middleOpacity: 1, middleWidth: 1, middleStyle: 'solid',
      fill: false, fillColor: '#2962ff', fillOpacity: 0.15,
      text: '', fontSize: 11, textColor: '#d1d4dc',
      bold: false, italic: false, textVAlign: 'top', textHAlign: 'left',
    },
    ellipse: {
      color: '#2962ff', width: 2, style: 'solid',
      fill: false, fillColor: '#2962ff', fillOpacity: 0.15,
      text: '', fontSize: 11, textColor: '#d1d4dc',
      bold: false, italic: false, textVAlign: 'top', textHAlign: 'left',
    },
    triangle: {
      color: '#2962ff', width: 2, style: 'solid',
      fill: false, fillColor: '#2962ff', fillOpacity: 0.15,
      text: '', fontSize: 11, textColor: '#d1d4dc',
      bold: false, italic: false, textVAlign: 'top', textHAlign: 'left',
    },
    fib: {
      color: '#2962ff', width: 1, style: 'solid',
      extendLeft: false, extendRight: true,
      reverse: false, /* ROUND245 (TV parity): mirror the scale */
      showTrend: true, /* ROUND256 (TV parity) */
      fill: true, fillOpacity: 0.10,
      showRatio: true, showPrice: true,
      levels: [
        { r: 0, c: '#787b86', on: true }, { r: 0.236, c: '#f23645', on: true },
        { r: 0.382, c: '#ff9800', on: true }, { r: 0.5, c: '#4caf50', on: true },
        { r: 0.618, c: '#089981', on: true }, { r: 0.786, c: '#00bcd4', on: true },
        { r: 1, c: '#787b86', on: true },
      ],
      text: '', fontSize: 11, textColor: '#d1d4dc',
    },
    fibext: {
      color: '#2962ff', width: 1, style: 'solid', showRatio: true, showPrice: true,
      /* ROUND245 (TV parity): full extension set + extend-lines update. */
      extendLeft: false, extendRight: true,
      showTrend: true, /* ROUND256 (TV parity) */
      levels: [
        { r: 0, c: '#787b86', on: true }, { r: 0.236, c: '#2962ff', on: true },
        { r: 0.382, c: '#2962ff', on: true }, { r: 0.5, c: '#2962ff', on: true },
        { r: 0.618, c: '#2962ff', on: true }, { r: 0.786, c: '#2962ff', on: true },
        { r: 1, c: '#2962ff', on: true }, { r: 1.272, c: '#2962ff', on: true },
        { r: 1.618, c: '#2962ff', on: true }, { r: 2, c: '#2962ff', on: true },
        { r: 2.618, c: '#2962ff', on: true }, { r: 3.618, c: '#2962ff', on: true },
        { r: 4.236, c: '#2962ff', on: true },
      ],
      text: '', fontSize: 11, textColor: '#d1d4dc',
    },
    /* ROUND245/247 (TV parity): the channel had no factory entry (bare base
       fallback) — explicit two-sided extend + ratios on for new drawings. */
    fibchannel: {
      color: '#2962ff', width: 1, style: 'solid',
      extendLeft: false, extendRight: true, showRatio: true,
      levels: [
        { r: 0, c: '#2962ff', on: true }, { r: 0.382, c: '#2962ff', on: true },
        { r: 0.5, c: '#2962ff', on: true }, { r: 0.618, c: '#2962ff', on: true },
        { r: 1, c: '#2962ff', on: true }, { r: 1.618, c: '#2962ff', on: true },
        { r: 2.618, c: '#2962ff', on: true },
      ],
      text: '', fontSize: 11, textColor: '#d1d4dc',
    },
    text: {
      color: '#d1d4dc', fontSize: 14, bold: false, italic: false,
      align: 'left', bg: false, fillColor: '#2962ff', fillOpacity: 0.35,
      border: false,
      text: '',
    },
    note: { color: '#f7c948', fontSize: 11, text: '' },
    measure: {
      /* TV measure (round 21): one colour for the box + markers, translucent
         fill, label chip and direction arrows can be toggled */
      color: '#2962ff', width: 1, style: 'solid',
      fillOpacity: 0.25, showLabel: true, showArrows: true,
      text: '', fontSize: 11, textColor: '#d1d4dc',
      bold: false, italic: false, textVAlign: 'top', textHAlign: 'left',
    },
  };
  FACTORY_OPTS.zoomin = FACTORY_OPTS._base;

  /* registration hook for tools2.js (TradingView batch-2 tools): lets the
     extension file add factory option sets without touching this file again */
  App.registerFactoryOpts = function (type, opts) {
    if (type && opts && typeof opts === 'object') FACTORY_OPTS[type] = opts;
  };

  App.drawings = Drawings;

  /* ---- per-tool templates (user-saved settings presets, TV-style) ----
     storage: mt5_tool_tpl = { [toolType]: [{name, opts}] } */
  App.toolTemplates = {
    list(type) { const all = ENV.storage.get('mt5_tool_tpl', {}) || {}; return Array.isArray(all[type]) ? all[type] : []; },
    save(type, name, opts) {
      const all = ENV.storage.get('mt5_tool_tpl', {}) || {};
      const arr = Array.isArray(all[type]) ? all[type] : [];
      const clean = JSON.parse(JSON.stringify(opts || {}));
      delete clean.vis; // visibility is per-drawing, not part of a style template
      const ex = arr.findIndex((t) => t.name === name);
      if (ex >= 0) arr[ex] = { name, opts: clean }; else arr.push({ name, opts: clean });
      all[type] = arr;
      ENV.storage.set('mt5_tool_tpl', all);
    },
    remove(type, name) {
      const all = ENV.storage.get('mt5_tool_tpl', {}) || {};
      if (Array.isArray(all[type])) all[type] = all[type].filter((t) => t.name !== name);
      ENV.storage.set('mt5_tool_tpl', all);
    },
  };

  /* ---- custom timeframes (user-created, TV-style) ---- */
  const UNIT_LBL = { s: 's', m: 'm', h: 'H', d: 'D', w: 'W', mo: 'M' };
  const UNIT_SEC = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, mo: 2592000 };
  const UNIT_GROUP = { s: 'Seconds', m: 'Minutes', h: 'Hours', d: 'Days', w: 'Weeks', mo: 'Months' };
  const UNIT_MAX = { s: 3600, m: 1440, h: 168, d: 365, w: 52, mo: 24 };

  function makeCustomTf(n, unit) {
    return { id: 'C_' + n + unit, n, unit, sec: n * UNIT_SEC[unit], label: n + UNIT_LBL[unit], group: UNIT_GROUP[unit], custom: true };
  }

  function registerTf(tf) {
    if (!App.tfById[tf.id]) { App.tfById[tf.id] = tf; App.tf.push(tf); }
    return tf.id;
  }

  (function loadCustomTfs() {
    const saved = ENV.storage.get('mt5_custom_tfs', []);
    for (const c of (saved || []).slice(0, 30)) {
      try { if (c && c.n > 0 && UNIT_SEC[c.unit]) registerTf(makeCustomTf(c.n, c.unit)); } catch (e) { Log.warn('state', 'custom timeframe restore failed', e) }
    }
  })();

  /* returns { id, existed } */
  App.addCustomTf = function (n, unit) {
    n = Math.floor(n);
    if (!(n > 0) || !UNIT_SEC[unit] || n > UNIT_MAX[unit]) return null;
    // native timeframe with the same duration?
    const sec = n * UNIT_SEC[unit];
    const nat = TF.find((t) => t.sec === sec);
    if (nat) return { id: nat.id, existed: true };
    let tf = App.tfById['C_' + n + unit];
    if (!tf) {
      tf = makeCustomTf(n, unit);
      registerTf(tf);
      const saved = ENV.storage.get('mt5_custom_tfs', []);
      saved.push({ n, unit });
      ENV.storage.set('mt5_custom_tfs', saved.slice(-30));
    }
    return { id: tf.id, existed: false };
  };

  App.removeCustomTf = function (id) {
    const tf = App.tfById[id];
    if (!tf || !tf.custom) return;
    App.tf = App.tf.filter((t) => t.id !== id);
    delete App.tfById[id];
    const fi = App.tfFavorites.indexOf(id);
    if (fi >= 0) { App.tfFavorites.splice(fi, 1); ENV.storage.set('mt5_tf_favs', App.tfFavorites); }
    const kept = App.tf.filter((t) => t.custom).map((t) => ({ n: t.n, unit: t.unit }));
    ENV.storage.set('mt5_custom_tfs', kept);
  };

export { App };
  /* legacy layout id -> catalog id (keeps saved settings of older versions working) */
  const LEGACY_LAYOUTS = { '3': '3t' };
  App.layoutById = function (id) {
    return App.LAYOUTS.find((l) => l.id === (LEGACY_LAYOUTS[id] || id)) || App.LAYOUTS[0];
  };
