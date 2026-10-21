/**
 * Drawing-tool settings dialog (TradingView-style)
 *
 * Mirrors the TV drawing dialog: title + pencil, tabs
 * Style / Text / Coordinates / Visibility, footer Template + Cancel/Ok.
 * The dialog is a FLOATING window (TV): non-modal, lives directly on the
 * page, opens next to the drawing and can be dragged anywhere by its title
 * bar while the chart stays fully usable behind it.
 * - Style tab fields are driven by SCHEMAS[type]
 * - Text tab: annotation text (+ per-tool font controls)
 * - Coordinates tab: per-point price + time (in the chart timezone App.tz)
 * - Visibility tab: interval visibility (Ticks/Seconds/Minutes/Hours/Days/
 * Weeks/Months/Ranges, each with range + slider, exactly like TV)
 * - Footer Template menu: Default / saved templates (per tool, mt5_tool_tpl)
 * / Save As…
 * Every change applies live; Cancel restores the snapshot taken at open;
 * Ok also persists "last used" options so NEW drawings of the same tool
 * start with them (TV behaviour).
 *
 * @module drawing/settings
 */

import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { TZ } from '../../../core/timezone.js';
import { Theme } from '../core/theme.js';
import { App } from '../../../core/state.js';
import { TOOLS, EMOJI_CATS } from './tools.js';
import { Toolbar } from '../chart/toolbar.js';
import { UI } from './ui.js';
import { Log } from '../../../core/logger.js';

/* ================= interval visibility ================= */
  const VIS_DEFS = [
    { key: 'ticks', label: 'Ticks', min: 1, max: 1 },
    { key: 'sec', label: 'Seconds', min: 1, max: 59 },
    { key: 'min', label: 'Minutes', min: 1, max: 59 },
    { key: 'hours', label: 'Hours', min: 1, max: 24 },
    { key: 'days', label: 'Days', min: 1, max: 366 },
    { key: 'weeks', label: 'Weeks', min: 1, max: 52 },
    { key: 'months', label: 'Months', min: 1, max: 12 },
    { key: 'ranges', label: 'Ranges', min: 1, max: 5 },
  ];
  const VIS_SEC = { ticks: 0, sec: 1, min: 60, hours: 3600, days: 86400, weeks: 604800, months: 2592000, ranges: 0 };

  function defaultVis() {
    const v = {};
    for (const d of VIS_DEFS) v[d.key] = { on: true, min: d.min, max: d.max };
    return v;
  }

  function visGroup(tfSec) {
    if (tfSec < 1) return 'ticks';
    if (tfSec < 60) return 'sec';
    if (tfSec < 3600) return 'min';
    if (tfSec < 86400) return 'hours';
    if (tfSec < 604800) return 'days';
    if (tfSec < 2592000) return 'weeks';
    return 'months';
  }

  /* is a drawing visible on a chart with the given interval? (TV Visibility tab) */
  function isVisible(d, tfSec) {
    const vis = d.opts && d.opts.vis;
    if (!vis) return true;
    const g = visGroup(tfSec);
    if (g === 'ticks' || g === 'ranges') return true; // no tick/range charts in this app
    const v = vis[g];
    if (!v || v.on === false) return false;
    const unit = VIS_SEC[g];
    const n = Math.max(1, Math.round(tfSec / unit));
    const min = isFinite(v.min) ? v.min : 1;
    const max = isFinite(v.max) ? v.max : VIS_DEFS.find((x) => x.key === g).max;
    return n >= Math.min(min, max) && n <= Math.max(min, max);
  }

  /* ================= Style-tab schemas (per tool) ================= */
  const TXT = { kind: 'text' }; // annotation font fields (Text tab shared)
  const SCHEMAS = {
    trend: [
      { kind: 'line', arrows: true },
      { kind: 'select', key: 'extend', label: 'Extend', options: [['none', "Don't extend"], ['left', 'Extend left'], ['right', 'Extend right'], ['both', 'Extend left and right']] },
      { kind: 'check', key: 'middle', label: 'Middle point' },
      { kind: 'check', key: 'priceLabels', label: 'Price labels' },
      { kind: 'sec', label: 'INFO' },
      { kind: 'select', key: 'stats', label: 'Stats', options: [['hidden', 'Hidden'], ['on', 'Shown']] },
      { kind: 'select', key: 'statsPos', label: 'Stats position', options: [['left', 'Left'], ['middle', 'Middle'], ['right', 'Right']] },
      { kind: 'check', key: 'alwaysStats', label: 'Always show stats' },
    ],
    arrow: [{ kind: 'line' }],
    ray: [{ kind: 'line' }],
    extended: [{ kind: 'line' }],
    parallel: [
      { kind: 'line' },
      { kind: 'fill', label: 'Background' },
      { kind: 'select', key: 'extend', label: 'Extend', options: [['none', "Don't extend"], ['left', 'Extend left'], ['right', 'Extend right'], ['both', 'Extend left and right']] },
      /* ROUND252 (TV parity): Channel's levels editor (empty = two edges). */
      { kind: 'sec', label: 'LEVELS' },
      { kind: 'levels' },
    ],
    hline: [
      { kind: 'line' },
      /* ROUND252 (TV parity): the price label toggles. */
      { kind: 'check', key: 'priceLabels', label: 'Price label' },
    ],
    hray: [
      { kind: 'line' },
      { kind: 'check', key: 'priceLabels', label: 'Price label' },
    ],
    vline: [
      { kind: 'line' },
      /* ROUND252 (TV parity): the time label toggles. */
      { kind: 'check', key: 'showTime', label: 'Time label' },
    ],
    crossline: [
      { kind: 'line' },
      { kind: 'check', key: 'priceLabels', label: 'Price label' },
      { kind: 'check', key: 'showTime', label: 'Time label' },
    ],
    /* round 52: TV channels-flyout additions — Style tabs mirror TV */
    trendangle: [
      { kind: 'line' },
      { kind: 'check', key: 'extendLeft', label: 'Extend left' },
      { kind: 'check', key: 'extendRight', label: 'Extend right' },
      { kind: 'check', key: 'showAngle', label: 'Angle label' },
    ],
    flattop: [
      { kind: 'line' },
      { kind: 'fill', label: 'Background' },
      { kind: 'check', key: 'extendLeft', label: 'Extend left' },
      { kind: 'check', key: 'extendRight', label: 'Extend right' },
    ],
    disjoint: [
      { kind: 'line', label: 'Line 1' },
      { kind: 'line', label: 'Line 2', colorKey: 'color2', widthKey: 'width2', styleKey: 'style2' },
      { kind: 'fill', label: 'Background' },
      { kind: 'check', key: 'extendLeft', label: 'Extend left' },
      { kind: 'check', key: 'extendRight', label: 'Extend right' },
    ],
    regression: [
      { kind: 'line', label: 'Base' },
      { kind: 'fill', label: 'Background' },
      { kind: 'check', key: 'extend', label: 'Extend' },
      /* ROUND255 (TV parity): source + per-side bands (visibility + color). */
      { kind: 'select', key: 'source', label: 'Source', options: [['close', 'Close'], ['hlc3', '(H + L + C)/3'], ['hl2', '(H + L)/2'], ['ohlc4', '(O + H + L + C)/4']] },
      { kind: 'check', key: 'upShow', label: 'Show upper band' },
      { kind: 'color', key: 'upColor', label: 'Upper color', showIf: 'upShow' },
      { kind: 'check', key: 'downShow', label: 'Show lower band' },
      { kind: 'color', key: 'downColor', label: 'Lower color', showIf: 'downShow' },
    ],
    /* ROUND252 (TV parity): the Info Line had no schema (generic fallback) —
       line + extends + the prices chip toggle its FACTORY already ships. */
    infoline: [
      { kind: 'line' },
      { kind: 'check', key: 'extendLeft', label: 'Extend left' },
      { kind: 'check', key: 'extendRight', label: 'Extend right' },
      { kind: 'check', key: 'showPrices', label: 'Prices' },
    ],
    /* ROUND247 (TV parity, extend-lines update): the forks always extended
       right with no UI; all four get extend toggles (right stays default). */
    /* ROUND254 (TV parity): Median row (color/thickness/style of its own). */
    pitchfork: [
      { kind: 'line' },
      { kind: 'line', label: 'Median', colorKey: 'medianColor', widthKey: 'medianWidth', styleKey: 'medianStyle' },
      { kind: 'check', key: 'extendLeft', label: 'Extend left' },
      { kind: 'check', key: 'extendRight', label: 'Extend right' },
    ],
    pitchfork_s: [
      { kind: 'line' },
      { kind: 'line', label: 'Median', colorKey: 'medianColor', widthKey: 'medianWidth', styleKey: 'medianStyle' },
      { kind: 'check', key: 'extendLeft', label: 'Extend left' },
      { kind: 'check', key: 'extendRight', label: 'Extend right' },
    ],
    pitchfork_ms: [
      { kind: 'line' },
      { kind: 'line', label: 'Median', colorKey: 'medianColor', widthKey: 'medianWidth', styleKey: 'medianStyle' },
      { kind: 'check', key: 'extendLeft', label: 'Extend left' },
      { kind: 'check', key: 'extendRight', label: 'Extend right' },
    ],
    pitchfork_i: [
      { kind: 'line' },
      { kind: 'line', label: 'Median', colorKey: 'medianColor', widthKey: 'medianWidth', styleKey: 'medianStyle' },
      { kind: 'check', key: 'extendLeft', label: 'Extend left' },
      { kind: 'check', key: 'extendRight', label: 'Extend right' },
    ],
    rect: [
      /* TV Box structure: Extend select, then collapsible groups — Border
         (color/opacity/thickness/style), Middle line (checkbox + color/
         opacity/thickness/style), Background (color/opacity) */
      { kind: 'select', key: 'extend', label: 'Extend', options: [['none', "Don't extend"], ['left', 'Extend left'], ['right', 'Extend right']] },
      { kind: 'group', label: 'Border', open: true, items: [
        { kind: 'line' },
        { kind: 'slider', key: 'borderOpacity', label: 'Opacity', min: 0.05, max: 1, step: 0.05 },
      ]},
      { kind: 'group', label: 'Middle line', open: true, items: [
        { kind: 'check', key: 'middle', label: 'Show middle line' },
        { kind: 'line', label: 'Line', colorKey: 'middleColor', widthKey: 'middleWidth', styleKey: 'middleStyle', showIf: 'middle' },
        { kind: 'slider', key: 'middleOpacity', label: 'Opacity', min: 0.05, max: 1, step: 0.05, showIf: 'middle' },
      ]},
      { kind: 'group', label: 'Background', open: true, items: [
        { kind: 'fill' },
      ]},
    ],
    ellipse: [
      { kind: 'line' },
      { kind: 'fill', label: 'Background' },
    ],
    triangle: [
      { kind: 'line' },
      { kind: 'fill', label: 'Background' },
    ],
    fib: [
      { kind: 'line' },
      { kind: 'fill', label: 'Background' },
      { kind: 'check', key: 'extendLeft', label: 'Extend left' },
      { kind: 'check', key: 'extendRight', label: 'Extend right' },
      /* ROUND245 (TV parity): Reverse mirrors the scale. */
      { kind: 'check', key: 'reverse', label: 'Reverse' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
      { kind: 'check', key: 'showPrice', label: 'Prices' },
      /* ROUND256 (TV parity): trend-line visibility, levels line style,
         one color for all levels. */
      { kind: 'check', key: 'showTrend', label: 'Trend line' },
      { kind: 'number', key: 'levelWidth', label: 'Levels width', min: 1, max: 4 },
      { kind: 'select', key: 'levelStyle', label: 'Levels style', options: [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']] },
      { kind: 'check', key: 'useOneColor', label: 'Use one color' },
      { kind: 'sec', label: 'LEVELS' },
      { kind: 'levels' },
    ],
    fibext: [
      { kind: 'line' },
      /* ROUND245 (TV parity, extend-lines update). */
      { kind: 'check', key: 'extendLeft', label: 'Extend left' },
      { kind: 'check', key: 'extendRight', label: 'Extend right' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
      { kind: 'check', key: 'showPrice', label: 'Prices' },
      { kind: 'check', key: 'showTrend', label: 'Trend line' },
      { kind: 'number', key: 'levelWidth', label: 'Levels width', min: 1, max: 4 },
      { kind: 'select', key: 'levelStyle', label: 'Levels style', options: [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']] },
      { kind: 'check', key: 'useOneColor', label: 'Use one color' },
      { kind: 'sec', label: 'LEVELS' },
      { kind: 'levels' },
    ],
    /* ROUND245 (TV parity): the channel had no schema (generic fallback) and
       no extend UI although draw now extends both ways. */
    fibchannel: [
      { kind: 'line' },
      { kind: 'check', key: 'extendLeft', label: 'Extend left' },
      { kind: 'check', key: 'extendRight', label: 'Extend right' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
      { kind: 'check', key: 'useOneColor', label: 'Use one color' },
      { kind: 'sec', label: 'LEVELS' },
      { kind: 'levels' },
    ],
    /* ROUND246 (TV parity): the Gann box had no schema (generic fallback) and
       no way to set the partition counts, labels or reverse. */
    gannbox: [
      { kind: 'line' },
      { kind: 'number', key: 'timeLevels', label: 'Time levels', min: 1, max: 32 },
      { kind: 'number', key: 'priceLevels', label: 'Price levels', min: 1, max: 32 },
      { kind: 'check', key: 'showLabels', label: 'Labels' },
      { kind: 'check', key: 'reverse', label: 'Reverse' },
      /* ROUND254 (TV parity): Background + corner Angles. */
      { kind: 'fill', label: 'Background' },
      { kind: 'check', key: 'showAngles', label: 'Angles' },
    ],
    /* ROUND257: Gann Square / Fixed and Gann Fan had no schema at all — the
       dialog fell back to a single line row, so diagonals, labels and the
       fan's 1x1 colour were not editable. */
    gannsquare: [
      { kind: 'line' },
      { kind: 'color', key: 'diagColor', label: 'Diagonal 1' },
      { kind: 'color', key: 'diag2Color', label: 'Diagonal 2' },
      { kind: 'number', key: 'timeLevels', label: 'Time levels', min: 1, max: 32 },
      { kind: 'number', key: 'priceLevels', label: 'Price levels', min: 1, max: 32 },
      { kind: 'check', key: 'showLabels', label: 'Labels' },
      { kind: 'check', key: 'reverse', label: 'Reverse' },
      { kind: 'fill', label: 'Background' },
    ],
    gannsquaref: [
      { kind: 'line' },
      { kind: 'color', key: 'diagColor', label: 'Diagonal 1' },
      { kind: 'color', key: 'diag2Color', label: 'Diagonal 2' },
      { kind: 'number', key: 'timeLevels', label: 'Time levels', min: 1, max: 32 },
      { kind: 'number', key: 'priceLevels', label: 'Price levels', min: 1, max: 32 },
      { kind: 'check', key: 'showLabels', label: 'Labels' },
      { kind: 'check', key: 'reverse', label: 'Reverse' },
      { kind: 'fill', label: 'Background' },
    ],
    gannfan: [
      { kind: 'line' },
      { kind: 'color', key: 'mainColor', label: '1x1 color', fallback: '#2962ff' },
      { kind: 'check', key: 'showLabels', label: 'Ratio labels' },
    ],
    /* round 58: TV Fibonacci flyout additions — Style tabs mirror TV */
    fibtz: [
      { kind: 'line' },
      { kind: 'check', key: 'showRatio', label: 'Bar numbers' },
      { kind: 'check', key: 'useOneColor', label: 'Use one color' },
      { kind: 'sec', label: 'LEVELS' },
      { kind: 'levels' },
    ],
    fibspeedfan: [
      { kind: 'line' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
      { kind: 'check', key: 'useOneColor', label: 'Use one color' },
      { kind: 'sec', label: 'LEVELS' },
      { kind: 'levels' },
    ],
    fibttime: [
      { kind: 'line' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
      { kind: 'check', key: 'showTrend', label: 'Trend line' },
      { kind: 'check', key: 'useOneColor', label: 'Use one color' },
      { kind: 'sec', label: 'LEVELS' },
      { kind: 'levels' },
    ],
    fibspiral: [
      { kind: 'line' },
      { kind: 'select', key: 'coeff', label: 'Coefficient', options: [['1.6180339887', 'Phi (1.618)'], ['2', '2'], ['2.618', '2.618'], ['3', '3']] },
      { kind: 'number', key: 'turns', label: 'Turns', min: 1, max: 8 },
      { kind: 'check', key: 'showTrend', label: 'Trend line' },
    ],
    fibarcs: [
      { kind: 'line' },
      { kind: 'check', key: 'fullscreen', label: 'Fullscreen' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
      { kind: 'check', key: 'showTrend', label: 'Trend line' },
      { kind: 'check', key: 'useOneColor', label: 'Use one color' },
      { kind: 'sec', label: 'LEVELS' },
      { kind: 'levels' },
    ],
    fibwedge: [
      { kind: 'line' },
      { kind: 'fill', label: 'Background' },
      { kind: 'check', key: 'useOneColor', label: 'Use one color' },
      { kind: 'sec', label: 'LEVELS' },
      { kind: 'levels' },
    ],
    pitchfan: [
      { kind: 'line' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
      { kind: 'check', key: 'useOneColor', label: 'Use one color' },
      { kind: 'sec', label: 'LEVELS' },
      { kind: 'levels' },
    ],
    fibcircles: [
      { kind: 'line' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
      { kind: 'check', key: 'useOneColor', label: 'Use one color' },
      { kind: 'sec', label: 'LEVELS' },
      { kind: 'levels' },
    ],
    /* ROUND244 (TV parity): Elliott + pattern tools fell back to the generic
       line-only dialog (settings.js:390) — the Ratios toggle their FACTORY
       defaults already ship had nowhere to live. */
    elliott_i: [
      { kind: 'line' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
    ],
    elliott_c: [
      { kind: 'line' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
    ],
    elliott_t: [
      { kind: 'line' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
    ],
    elliott_wxy: [
      { kind: 'line' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
    ],
    elliott_wxyxz: [
      { kind: 'line' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
    ],
    xabcd: [
      { kind: 'line' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
    ],
    abcd: [
      { kind: 'line' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
    ],
    cypher: [
      { kind: 'line' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
    ],
    threedrives: [
      { kind: 'line' },
      { kind: 'check', key: 'showRatio', label: 'Ratios' },
    ],
    trianglepat: [{ kind: 'line' }],
    hs: [{ kind: 'line' }],
    /* round 61: TV Cycles flyout additions — Style tabs mirror TV */
    cycliclines: [
      { kind: 'line' },
      { kind: 'select', key: 'coeff', label: 'Coeff', options: [['0.25', '0.25'], ['0.5', '0.5'], ['1', '1'], ['1.5', '1.5'], ['2', '2'], ['3', '3'], ['5', '5']] },
      { kind: 'number', key: 'cycles', label: 'Cycles', min: 1, max: 300 },
      { kind: 'check', key: 'extendLeft', label: 'Extend left' },
      { kind: 'check', key: 'extendRight', label: 'Extend right' },
    ],
    timecycles: [
      { kind: 'line' },
      { kind: 'number', key: 'cycles', label: 'Cycles', min: 1, max: 100 },
    ],
    sineline: [
      { kind: 'line' },
      { kind: 'select', key: 'coeff', label: 'Coeff', options: [['0.5', '0.5'], ['1', '1'], ['2', '2'], ['3', '3']] },
      { kind: 'select', key: 'extend', label: 'Extend', options: [['none', "Don't extend"], ['left', 'Extend left'], ['right', 'Extend right'], ['both', 'Extend left and right']] },
      { kind: 'check', key: 'showTrend', label: 'Trend line' },
    ],
    /* round 62: TV Forecasting & Measurement additions — Style tabs mirror TV */
    posforecast: [
      { kind: 'line' },
      { kind: 'select', key: 'coeff', label: 'Risk/reward ratio', options: [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']] },
      { kind: 'slider', key: 'fillOpacity', label: 'Box opacity', min: 0.05, max: 1, step: 0.05 },
    ],
    barspattern: [
      { kind: 'line' },
      { kind: 'check', key: 'mirror', label: 'Mirror' },
      { kind: 'fill', label: 'Background' },
    ],
    ghostfeed: [
      { kind: 'line' },
      { kind: 'number', key: 'bars', label: 'Bars', min: 1, max: 200 },
    ],
    sector: [
      { kind: 'line' },
      { kind: 'fill', label: 'Background' },
    ],
    avwap: [
      { kind: 'line' },
      { kind: 'select', key: 'source', label: 'Source', options: [['hlc3', 'HL/3'], ['close', 'Close']] },
    ],
    /* ROUND254 (TV parity): stop/target colors (defaults keep the old
       win/loss look when unset). */
    positionl: [
      { kind: 'line' },
      { kind: 'color', key: 'stopColor', label: 'Stop color', fallback: '#f23645' },
      { kind: 'color', key: 'targetColor', label: 'Target color', fallback: '#089981' },
    ],
    positions: [
      { kind: 'line' },
      { kind: 'color', key: 'stopColor', label: 'Stop color', fallback: '#f23645' },
      { kind: 'color', key: 'targetColor', label: 'Target color', fallback: '#089981' },
    ],
    avolprofile: [
      { kind: 'number', key: 'bins', label: 'Rows', min: 6, max: 100 },
    ],
    /* ROUND254 (TV parity): the fixed-range profile had no schema (generic
       fallback) — line + row count like its anchored sibling. */
    volprofile: [
      { kind: 'line' },
      { kind: 'number', key: 'bins', label: 'Rows', min: 6, max: 120 },
    ],
    pricerange: [
      { kind: 'line' },
      { kind: 'slider', key: 'fillOpacity', label: 'Box opacity', min: 0.02, max: 1, step: 0.02 },
      { kind: 'check', key: 'showLabel', label: 'Label' },
    ],
    daterange: [
      { kind: 'line' },
      { kind: 'slider', key: 'fillOpacity', label: 'Box opacity', min: 0.02, max: 1, step: 0.02 },
      { kind: 'check', key: 'showLabel', label: 'Label' },
    ],
    datepricerange: [
      { kind: 'line' },
      { kind: 'slider', key: 'fillOpacity', label: 'Box opacity', min: 0.02, max: 1, step: 0.02 },
      { kind: 'check', key: 'showLabel', label: 'Label' },
    ],
    text: [
      { kind: 'color', key: 'color', label: 'Text color' },
      { kind: 'number', key: 'fontSize', label: 'Font size', min: 8, max: 72 },
      { kind: 'check', key: 'bold', label: 'Bold' },
      { kind: 'check', key: 'italic', label: 'Italic' },
      { kind: 'select', key: 'align', label: 'Alignment', options: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']] },
      { kind: 'check', key: 'bg', label: 'Background' },
      { kind: 'color', key: 'fillColor', label: 'Background color', showIf: 'bg' },
      { kind: 'slider', key: 'fillOpacity', label: 'Background opacity', min: 0.05, max: 1, step: 0.05, showIf: 'bg' },
      /* ROUND255 (TV parity): Border around the text box. */
      { kind: 'check', key: 'border', label: 'Border' },
      { kind: 'color', key: 'borderColor', label: 'Border color', showIf: 'border' },
    ],
    note: [
      { kind: 'color', key: 'color', label: 'Color' },
      { kind: 'number', key: 'fontSize', label: 'Font size', min: 8, max: 24 },
    ],
  };
  SCHEMAS.measure = [
    /* round 21: the measure is a first-class TV tool — full Style tab */
    { kind: 'line' },
    { kind: 'slider', key: 'fillOpacity', label: 'Box opacity', min: 0.02, max: 1, step: 0.02 },
    { kind: 'check', key: 'showLabel', label: 'Show info label' },
    { kind: 'check', key: 'showArrows', label: 'Show arrows' },
  ];

  /* ROUND 69: TV shapes-flyout additions — Style tabs mirror TV
     (research: Brush = Line+Opacity; Highlighter = Color+Width+Opacity;
     Arrow marker = Color+Size; Arrow marks = Color+Size; Rotated rectangle
     and Circle add TV's Background; the line-only tools = Line) */
  SCHEMAS.brush = [
    { kind: 'line' },
    { kind: 'slider', key: 'borderOpacity', label: 'Opacity', min: 0.05, max: 1, step: 0.05 },
    /* ROUND252 (TV parity): Background fills the closed stroke. */
    { kind: 'fill', label: 'Background' },
  ];
  SCHEMAS.highlighter = [
    { kind: 'color', key: 'color', label: 'Color' },
    { kind: 'number', key: 'width', label: 'Width', min: 4, max: 40 },
    { kind: 'slider', key: 'borderOpacity', label: 'Opacity', min: 0.05, max: 1, step: 0.05 },
  ];
  SCHEMAS.arrowmarker = [
    { kind: 'color', key: 'color', label: 'Color' },
    { kind: 'select', key: 'markSize', label: 'Size', options: [['12', 'Small'], ['18', 'Medium'], ['26', 'Large'], ['36', 'X-Large']] },
  ];
  SCHEMAS.arrowmarku = [
    { kind: 'color', key: 'color', label: 'Color' },
    { kind: 'select', key: 'markSize', label: 'Size', options: [['14', 'Small'], ['22', 'Medium'], ['30', 'Large'], ['40', 'X-Large']] },
  ];
  SCHEMAS.arrowmarkd = SCHEMAS.arrowmarku;
  /* ROUND246: the annotations back on the menu get real Style tabs (size for
     the marks; line + background + font size for the callout bubble). */
  SCHEMAS.arrowmarkl = SCHEMAS.arrowmarku;
  SCHEMAS.arrowmarkr = SCHEMAS.arrowmarku;
  SCHEMAS.flagmark = [
    { kind: 'color', key: 'color', label: 'Color' },
    { kind: 'select', key: 'markSize', label: 'Size', options: [['18', 'Small'], ['26', 'Medium'], ['34', 'Large'], ['44', 'X-Large']] },
    { kind: 'fill', label: 'Background' },
  ];
  SCHEMAS.callout = [
    { kind: 'line' },
    { kind: 'fill', label: 'Background' },
    { kind: 'number', key: 'fontSize', label: 'Font size', min: 8, max: 48 },
  ];
  /* ROUND248 (TV parity): Icons category — the glyph grid + size. */
  SCHEMAS.emoji = [
    { kind: 'emoji' },
    { kind: 'number', key: 'size', label: 'Size', min: 8, max: 128 },
  ];
  SCHEMAS.rotrect = [
    { kind: 'line' },
    { kind: 'fill', label: 'Background' },
  ];
  SCHEMAS.circle = [
    { kind: 'line' },
    { kind: 'fill', label: 'Background' },
  ];
  SCHEMAS.path = [{ kind: 'line' }];
  SCHEMAS.polyline = [
    { kind: 'line' },
    /* ROUND252 (TV parity): Background fills the closed polyline. */
    { kind: 'fill', label: 'Background' },
  ];
  SCHEMAS.arc = [{ kind: 'line' }];
  SCHEMAS.curve = [
    { kind: 'line' },
    { kind: 'fill', label: 'Background' },
  ];
  SCHEMAS.dblcurve = [
    { kind: 'line' },
    { kind: 'fill', label: 'Background' },
  ];

  /* which tabs a tool shows (TV: all four; Coordinates adapts to point count) */
  function tabsFor(d) {
    const t = ['style', 'text', 'coords', 'vis'];
    return t;
  }

  /* ================= time helpers (chart timezone) ================= */
  const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

  function epochToWall(tz, t) {
    const p = TZ.parts(tz, t);
    return `${p.year}-${MONTHS[p.month] || '01'}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
  }

  function wallToEpoch(tz, s) {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000;
    let guess = wall;
    for (let i = 0; i < 3; i++) {
      const off = (TZ.zoneOffsetMinutes(tz, new Date(guess * 1000)) || 0) * 60;
      guess = wall - off;
    }
    return Math.round(guess);
  }

  /* ================= dialog ================= */
  const DrawSettings = {};

  DrawSettings.isVisible = isVisible;
  /* shared with the floating context toolbar (round 21): interval-visibility
     defaults + a coarse per-group on/off probe for the ⋯ menu */
  DrawSettings.defaultVis = defaultVis;
  DrawSettings.visGroupOn = function (d, key) {
    if (!d.opts.vis) return true;
    const v = d.opts.vis[key];
    return !v || v.on !== false;
  };

  /* registration hook for tools2.js: the batch-2 tools add their Style-tab
     schemas from their own file (keeps this file stable) */
  DrawSettings.registerSchema = function (type, schema) {
    if (type && Array.isArray(schema)) SCHEMAS[type] = schema;
  };

  /* last floating position of the tool-settings dialog (session-scoped, TV) */
  let DS_LAST_POS = null;

  /* replace all option fields of d.opts in place (template/default apply) */
  function replaceOpts(d, next) {
    for (const k of Object.keys(d.opts)) delete d.opts[k];
    Object.assign(d.opts, JSON.parse(JSON.stringify(next || {})));
  }

  DrawSettings.open = function (pane, d, opts) {
    if (!pane || !d || !TOOLS[d.type]) return;
    const type = d.type;
    /* rect legacy migration: the old UI had two independent extend checkboxes
       and could store "both" — the TV Box select has three states, keep Left */
    if (type === 'rect' && d.opts.extendLeft && d.opts.extendRight) d.opts.extendRight = false;
    const schema = SCHEMAS[type] || [{ kind: 'line' }];
    const factory = App.drawings.factoryOpts(type);
    const snap = JSON.parse(JSON.stringify({ opts: d.opts, points: d.points }));
    const isTemp = !!(d.opts && d.opts.temp);
    let activeTab = (opts && opts.tab) || 'style';
    let dlg = null;

    /* floating window (TV): appended straight to the body — no modal backdrop,
       the chart behind stays visible and interactive; dragged by its title */
    dlg = U.el('div', 'dialog ds-dialog ds-float', document.body);
    dlg.id = 'draw-settings-dialog';
    const def = TOOLS[type];
    dlg.innerHTML = `<h3 class="ds-title">${def.name}<span class="ds-pen">${icon('pencil')}</span><button class="mini-btn dlg-x" title="Ok">${icon('x')}</button></h3>
      <div class="ds-tabs"></div>
      <div class="ds-body"></div>
      <div class="st-foot ds-foot">
        <div class="st-tpl"><button class="st-tpl-name ds-tpl-btn">Template <i class="ds-chev"></i></button></div>
        <div class="dlg-actions">
          <button class="dlg-btn dlg-ghost st-cancel">Cancel</button>
          <button class="dlg-btn ds-ok">Ok</button>
        </div>
      </div>`;

    /* ---- save / revert ---- */
    function persistLast() {
      const o = JSON.parse(JSON.stringify(d.opts));
      delete o.vis;
      delete o.text; // round 20: the annotation text never carries to new drawings
      try { U.lsSet('mt5_tool_last_' + type, o); } catch (e) { Log.warn('drawing', 'last tool pref save failed', e) }
    }
    function close(commit) {
      document.removeEventListener('keydown', onKey);
      if (dlg) { dlg.remove(); dlg = null; }
      if (commit) {
        const wasTemp = isTemp;
        delete d.opts.temp;
        App.drawings.save();
        persistLast();
        /* Text/Note are added to the store before their settings dialog opens
           so they can be previewed live. Commit is the real creation — push
           the same undo step _finish() pushes for every other tool. */
        if (wasTemp && App.undo) {
          App.undo.push({ kind: 'add', symbol: d.symbol, d: JSON.parse(JSON.stringify(d)) });
        }
      } else {
        /* restore snapshot in place — the drawing object identity must not change */
        const so = JSON.parse(JSON.stringify(snap.opts));
        replaceOpts(d, so);
        d.points.length = 0;
        for (const p of snap.points) d.points.push({ t: p.t, p: p.p });
        if (isTemp) {
          /* a not-yet-committed new drawing is discarded on Cancel */
          App.drawings.remove(pane.symbol, d.id);
          if (App.selection && App.selection.d === d) { App.selection = null; UI.onSelectionChanged(); }
        } else {
          App.drawings.save();
        }
      }
    }
    const onKey = (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
      else if (e.key === 'Enter' && tag !== 'textarea') { e.stopPropagation(); close(true); }
    };
    document.addEventListener('keydown', onKey);
    dlg.querySelector('.dlg-x').addEventListener('click', () => close(true));
    dlg.querySelector('.st-ok, .ds-ok').addEventListener('click', () => close(true));
    dlg.querySelector('.st-cancel').addEventListener('click', () => close(false));

    /* ---- tabs ---- */
    const tabsEl = dlg.querySelector('.ds-tabs');
    const body = dlg.querySelector('.ds-body');

    /* Free Transform of the tool-settings dialog (round 19): it was already
       draggable by its title; add the bottom-right resize grip */
    const grip = U.el('button', 'dlg-grip', dlg);
    grip.innerHTML = icon('grip');
    grip.title = 'Resize';
    grip.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const sw = dlg.offsetWidth, bh = body.offsetHeight, sx = e.clientX, sy = e.clientY;
      const mv = (ev) => {
        if (!dlg) return;
        dlg.style.width = U.clamp(sw + (ev.clientX - sx), 460, window.innerWidth - 24) + 'px';
        body.style.height = U.clamp(bh + (ev.clientY - sy), 300, window.innerHeight - 140) + 'px';
      };
      const up2 = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up2); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up2);
    });
    const TAB_LBL = { style: 'Style', text: 'Text', coords: 'Coordinates', vis: 'Visibility' };

    function renderTabs() {
      U.clear(tabsEl);
      for (const t of tabsFor(d)) {
        const b = U.el('button', 'ds-tab' + (t === activeTab ? ' on' : ''), tabsEl);
        b.textContent = TAB_LBL[t];
        b.addEventListener('click', () => { activeTab = t; renderTabs(); renderBody(); });
      }
    }

    /* ---- row builders ---- */
    /* collapsible groups (TV nested structure) write their rows into their own
       container; curParent tracks it while the group's items render */
    let curParent = null;
    const row = (label) => {
      const r = U.el('div', 'ds-row', curParent || body);
      if (label != null) r.innerHTML = `<span class="ds-lab">${label}</span>`;
      return r;
    };
    /* segmented control (TV alignment buttons): items [[value,label]] */
    function segRow(label, getVal, setVal, items) {
      const r = row(label);
      const box = U.el('span', 'ds-seg', inline(r));
      const render = () => {
        U.clear(box);
        for (const [v, l] of items) {
          const b = U.el('button', 'ds-seg-b' + (getVal() === v ? ' on' : ''), box);
          b.textContent = l;
          b.addEventListener('click', (e) => { e.stopPropagation(); setVal(v); render(); });
        }
      };
      render();
      return r;
    }
    const inline = (r) => U.el('span', 'st-inline', r);

    function colorSw(parent, get, set) {
      /* round 19: custom in-app colour picker opens next to the swatch - the
         native <input type=color> popup in Electron appears detached at the
         top-left corner of the screen, unlike TV */
      const w = U.el('button', 'st-color', parent);
      const sw = U.el('span', 'st-color-sw', w);
      const paint = () => { sw.style.background = U.toHex(get()); };
      paint();
      w.title = 'Color';
      w.addEventListener('mousedown', (e) => e.stopPropagation());
      w.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const r = w.getBoundingClientRect();
        Toolbar.colorPickerAt(r.left, r.bottom + 4, get(), (c) => { set(c); paint(); });
      });
      return w;
    }

    const DASH = { solid: '', dashed: '6 4', dotted: '2 4', largedashed: '10 6' };
    function linePreview(st, color, width, w) {
      const dd = DASH[st] || '';
      return `<svg width="${w || 30}" height="12"><line x1="1" y1="6" x2="${(w || 30) - 1}" y2="6" stroke="${color}" stroke-width="${width}" ${dd ? `stroke-dasharray="${dd}"` : ''} stroke-linecap="round"/></svg>`;
    }

    function applyExtend(val) {
      d.opts.extendLeft = val === 'left' || val === 'both';
      d.opts.extendRight = val === 'right' || val === 'both';
    }
    function extendVal() {
      const l = !!d.opts.extendLeft, r = !!d.opts.extendRight;
      return l && r ? 'both' : l ? 'left' : r ? 'right' : 'none';
    }

    function buildLine(fld) {
      /* per-field option keys let the Border/Middle-line groups reuse the
         same TV row (color + style popup + width popup) on their own opts */
      const cKey = fld.colorKey || 'color', wKey = fld.widthKey || 'width', sKey = fld.styleKey || 'style';
      const r = row(fld.label != null ? fld.label : 'Line');
      const box = inline(r);
      colorSw(box, () => d.opts[cKey], (v) => { d.opts[cKey] = v; });
      /* line style button + popup (TV dashed preview) */
      const stb = U.el('button', 'ds-lbtn', box);
      const stRender = () => { stb.innerHTML = linePreview(d.opts[sKey] || 'solid', U.toHex(d.opts[cKey]), Math.min(3, d.opts[wKey] || 2), 34); };
      stRender();
      stb.title = 'Line style';
      stb.addEventListener('click', (e) => {
        e.stopPropagation();
        Toolbar.popupAt(e.clientX, e.clientY, (p) => {
          for (const s of ['solid', 'dashed', 'dotted', 'largedashed']) {
            const it = U.el('button', 'pu-item ds-lit' + (d.opts[sKey] === s ? ' hl' : ''), p);
            it.innerHTML = linePreview(s, Theme.th('text', '#d1d4dc'), 2, 46);
            it.addEventListener('click', () => { d.opts[sKey] = s; stRender(); Toolbar.closePopup(); });
          }
        });
      });
      /* width button + popup */
      const wb = U.el('button', 'ds-lbtn', box);
      const wRender = () => { wb.innerHTML = linePreview('solid', U.toHex(d.opts[cKey]), d.opts[wKey] || 2, 26); };
      wRender();
      wb.title = 'Line width';
      wb.addEventListener('click', (e) => {
        e.stopPropagation();
        Toolbar.popupAt(e.clientX, e.clientY, (p) => {
          for (const w of [1, 2, 3, 4]) {
            const it = U.el('button', 'pu-item ds-lit' + (d.opts[wKey] === w ? ' hl' : ''), p);
            it.innerHTML = linePreview('solid', Theme.th('text', '#d1d4dc'), w, 46);
            it.addEventListener('click', () => { d.opts[wKey] = w; wRender(); stRender(); Toolbar.closePopup(); });
          }
        });
      });
      if (fld && fld.arrows) {
        const ab = U.el('button', 'ds-lbtn ds-tog' + (d.opts.arrows ? ' on' : ''), box);
        ab.innerHTML = icon('arrows');
        ab.title = 'Arrows on both ends';
        ab.addEventListener('click', () => {
          d.opts.arrows = !d.opts.arrows;
          ab.classList.toggle('on', !!d.opts.arrows);
        });
      }
    }

    function buildFill(fld) {
      const r = row(fld.label || 'Background');
      const box = inline(r);
      const isOn = () => !!(d.opts.fill || d.opts.bg);
      const cb = U.el('span', 'st-check' + (isOn() ? ' on' : ''), box);
      cb.innerHTML = '<i></i>';
      r.addEventListener('click', (e) => {
        if (e.target.closest('.st-color')) return;
        e.preventDefault();
        const nv = !isOn();
        if ('fill' in d.opts || d.opts.bg === undefined) d.opts.fill = nv; else d.opts.bg = nv;
        cb.classList.toggle('on', nv);
        r.querySelectorAll('.st-color,.ds-slider').forEach((el) => { el.style.display = nv ? '' : 'none'; });
      });
      const cw = colorSw(box, () => d.opts.fillColor || d.opts.color, (v) => {
        d.opts.fillColor = v;
      });
      const sl = U.el('input');
      sl.type = 'range'; sl.min = 0.05; sl.max = 1; sl.step = 0.05;
      sl.value = typeof d.opts.fillOpacity === 'number' ? d.opts.fillOpacity : 0.15;
      const wrap = U.el('span', 'ds-slider', box);
      wrap.appendChild(sl);
      sl.addEventListener('input', () => { d.opts.fillOpacity = parseFloat(sl.value); });
      if (!isOn()) { cw.style.display = 'none'; wrap.style.display = 'none'; }
    }

    function buildCheck(fld) {
      const r = row(null);
      const cb = U.el('span', 'ds-check' + (d.opts[fld.key] ? ' on' : ''), r);
      cb.innerHTML = '<i></i>';
      U.el('span', 'ds-lab2', r).textContent = fld.label;
      r.addEventListener('click', (e) => {
        e.preventDefault();
        d.opts[fld.key] = !d.opts[fld.key];
        cb.classList.toggle('on', !!d.opts[fld.key]);
        /* rows with showIf on this key appear/disappear with the toggle (TV) */
        if (allFields.some((f) => f.showIf === fld.key)) renderBody();
      });
    }

    function buildSelect(fld) {
      const r = row(fld.label);
      const box = inline(r);
      const sel = document.createElement('select');
      sel.className = 'st-sel';
      for (const o of fld.options) {
        const op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        sel.appendChild(op);
      }
      sel.value = fld.key === 'extend' ? extendVal() : String(d.opts[fld.key] != null ? d.opts[fld.key] : fld.options[0][0]);
      box.appendChild(sel);
      sel.addEventListener('keydown', (e) => e.stopPropagation());
      sel.addEventListener('change', () => {
        if (fld.key === 'extend') applyExtend(sel.value);
        else d.opts[fld.key] = sel.value;
      });
    }

    function buildNumber(fld) {
      const r = row(fld.label);
      const box = inline(r);
      const inp = document.createElement('input');
      inp.type = 'number'; inp.className = 'st-num';
      inp.min = fld.min; inp.max = fld.max; inp.step = 1;
      inp.value = d.opts[fld.key] != null ? d.opts[fld.key] : 14;
      box.appendChild(inp);
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      inp.addEventListener('change', () => {
        let v = parseInt(inp.value, 10);
        if (!isFinite(v)) v = fld.min;
        v = U.clamp(v, fld.min, fld.max);
        d.opts[fld.key] = v;
        inp.value = v;
      });
    }

    function buildSlider(fld) {
      const r = row(fld.label);
      const box = inline(r);
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = fld.min; inp.max = fld.max; inp.step = fld.step;
      inp.value = typeof d.opts[fld.key] === 'number' ? d.opts[fld.key] : fld.min;
      box.appendChild(inp);
      inp.addEventListener('input', () => { d.opts[fld.key] = parseFloat(inp.value); });
    }

    /* ROUND248 (TV parity): the Icons emoji grid — categorized like TV's menu
       tabs, writes the picked glyph live (the chart repaints under the
       floating dialog). */
    function buildEmoji(fld) {
      const cats = Array.isArray(fld.cats) && fld.cats.length ? fld.cats : EMOJI_CATS;
      const box = U.el('div', 'ds-emoji', curParent || body);
      const paint = () => {
        box.querySelectorAll('.ds-emoji-ch').forEach((b) => {
          b.classList.toggle('on', b.dataset.ch === String(d.opts.ch || ''));
        });
      };
      for (const [title, list] of cats) {
        U.el('div', 'ds-sec', box).textContent = title;
        const grid = U.el('div', 'ds-emoji-grid', box);
        for (const ch of list) {
          const b = U.el('button', 'ds-emoji-ch', grid);
          b.type = 'button';
          b.dataset.ch = ch;
          b.textContent = ch;
          b.title = ch;
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            d.opts.ch = ch;
            paint();
          });
        }
      }
      paint();
    }

    /* TV Levels editor: [eye][coefficient][color][trash] + Add level */
    function buildLevels() {
      if (!Array.isArray(d.opts.levels) || !d.opts.levels.length) d.opts.levels = [];
      const box = U.el('div', 'ds-levels', curParent || body);
      const render = () => {
        U.clear(box);
        d.opts.levels.forEach((lv, i) => {
          const r = U.el('div', 'ds-level', box);
          const eye = U.el('span', 'ds-check' + (lv.on !== false ? ' on' : ''), r);
          eye.innerHTML = '<i></i>';
          eye.title = 'Show / hide level';
          eye.addEventListener('click', (e) => {
            e.stopPropagation();
            lv.on = lv.on === false ? true : false;
            eye.classList.toggle('on', lv.on !== false);
          });
          const num = document.createElement('input');
          num.type = 'number'; num.className = 'st-num ds-ratio';
          num.step = 'any';
          num.value = lv.r;
          num.addEventListener('keydown', (e) => e.stopPropagation());
          num.addEventListener('change', () => {
            const v = parseFloat(num.value);
            if (isFinite(v)) lv.r = v; else num.value = lv.r;
          });
          r.appendChild(num);
          const cw = U.el('span', 'st-inline', r);
          colorSw(cw, () => lv.c || '#2962ff', (v) => { lv.c = v; });
          const tr = U.el('button', 'ds-lv-trash', r);
          tr.innerHTML = icon('trash');
          tr.title = 'Remove level';
          tr.addEventListener('click', (e) => {
            e.stopPropagation();
            d.opts.levels.splice(i, 1);
            render();
          });
        });
        const add = U.el('button', 'ds-lv-add', box);
        add.innerHTML = `${icon('plus')} <span>Add level</span>`;
        add.addEventListener('click', () => {
          const last = d.opts.levels[d.opts.levels.length - 1];
          d.opts.levels.push({ r: last ? +(last.r + 0.236).toFixed(3) : 0, c: '#2962ff', on: true });
          render();
        });
      };
      render();
    }

    /* flat field list (groups included recursively) - used by the showIf
       dependency check so nested group fields still toggle their dependents */
    const allFields = [];
    (function collect(arr) { for (const f of arr) { allFields.push(f); if (f.items) collect(f.items); } })(schema);

    const groupOpen = {}; // collapsible-group state survives re-renders
    function buildGroup(fld) {
      const key = 'g_' + fld.label;
      if (!(key in groupOpen)) groupOpen[key] = fld.open !== false;
      const wrap = U.el('div', 'ds-group' + (groupOpen[key] ? ' open' : ''), body);
      const head = U.el('div', 'ds-group-head', wrap);
      head.innerHTML = `<i class="ds-group-chev"></i><span>${fld.label}</span>`;
      head.addEventListener('click', () => {
        groupOpen[key] = !groupOpen[key];
        wrap.classList.toggle('open', groupOpen[key]);
      });
      U.el('div', 'ds-group-body', wrap);
      curParent = wrap.querySelector('.ds-group-body');
      for (const f of fld.items) buildField(f);
      curParent = null;
    }

    function buildField(fld) {
      if (fld.showIf && !d.opts[fld.showIf]) return; // TV: hidden until enabled
      if (fld.kind === 'group') { buildGroup(fld); return; }
      if (fld.kind === 'sec') { U.el('div', 'ds-sec', curParent || body).textContent = fld.label; return; }
      if (fld.kind === 'line') buildLine(fld);
      else if (fld.kind === 'fill') buildFill(fld);
      else if (fld.kind === 'check') buildCheck(fld);
      else if (fld.kind === 'select') buildSelect(fld);
      else if (fld.kind === 'number') buildNumber(fld);
      else if (fld.kind === 'color') {
        const r = row(fld.label);
        colorSw(inline(r), () => d.opts[fld.key] || fld.fallback || '#000000', (v) => { d.opts[fld.key] = v; });
      } else if (fld.kind === 'slider') buildSlider(fld);
      else if (fld.kind === 'levels') buildLevels();
      else if (fld.kind === 'emoji') buildEmoji(fld);
    }

    function buildStyle() {
      for (const fld of schema) buildField(fld);
    }

    function buildText() {
      const lab = U.el('div', 'ds-sec', body).textContent = 'TEXT';
      const ta = document.createElement('textarea');
      ta.className = 'ds-ta';
      ta.rows = type === 'text' || type === 'note' ? 4 : 2;
      ta.value = String(d.opts.text || '');
      ta.placeholder = 'Text on the drawing…';
      body.appendChild(ta);
      ta.addEventListener('keydown', (e) => e.stopPropagation());
      ta.addEventListener('input', () => { d.opts.text = ta.value; });
      setTimeout(() => ta.focus(), 40);
      /* TV Text tab: font controls + two alignment groups (vertical
         Top/Inside/Bottom + horizontal Left/Center/Right). The standalone
         Text/Note tools keep their own font rows on the Style tab. */
      if (type !== 'text' && type !== 'note') {
        U.el('div', 'ds-sec', body).textContent = 'FONT';
        const numR = row('Font size');
        const inp = document.createElement('input');
        inp.type = 'number'; inp.className = 'st-num';
        inp.min = 8; inp.max = 72; inp.step = 1;
        inp.value = d.opts.fontSize || 11;
        inline(numR).appendChild(inp);
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        inp.addEventListener('change', () => {
          let n = parseInt(inp.value, 10);
          if (!isFinite(n)) n = 11;
          n = U.clamp(n, 8, 72);
          d.opts.fontSize = n;
          inp.value = n;
        });
        const colR = row('Font color');
        colorSw(inline(colR), () => d.opts.textColor || '#d1d4dc', (v) => { d.opts.textColor = v; });
        const styR = row('Style');
        const sbox = U.el('span', 'st-inline', styR);
        const bb = U.el('button', 'ds-lbtn ds-tog' + (d.opts.bold ? ' on' : ''), sbox);
        bb.innerHTML = '<b>B</b>';
        bb.title = 'Bold';
        bb.addEventListener('click', () => { d.opts.bold = !d.opts.bold; bb.classList.toggle('on', !!d.opts.bold); });
        const ib = U.el('button', 'ds-lbtn ds-tog' + (d.opts.italic ? ' on' : ''), sbox);
        ib.innerHTML = '<i>I</i>';
        ib.title = 'Italic';
        ib.addEventListener('click', () => { d.opts.italic = !d.opts.italic; ib.classList.toggle('on', !!d.opts.italic); });
        U.el('div', 'ds-sec', body).textContent = 'ALIGNMENT';
        segRow('Vertical',
          () => d.opts.textVAlign || 'top',
          (v) => { d.opts.textVAlign = v; },
          [['top', 'Top'], ['inside', 'Inside'], ['bottom', 'Bottom']]);
        segRow('Horizontal',
          () => d.opts.textHAlign || 'left',
          (v) => { d.opts.textHAlign = v; },
          [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]);
      }
    }

    function buildCoords() {
      U.el('div', 'ds-sec', body).textContent = 'COORDINATES';
      const timeOnly = type === 'vline';
      const priceOnly = type === 'hline';
      d.points.forEach((pt, i) => {
        const box = U.el('div', 'ds-coord', body);
        U.el('div', 'ds-coord-n', box).textContent = `Point ${i + 1}`;
        const grid = U.el('div', 'ds-coord-g', box);
        const mk = (label) => {
          const w = U.el('label', 'ds-coord-f', grid);
          U.el('span', 'ds-coord-l', w).textContent = label;
          return w;
        };
        if (!priceOnly) {
          const ti = mk('Time');
          const inp = document.createElement('input');
          inp.type = 'datetime-local';
          inp.value = epochToWall(App.tz, pt.t);
          ti.appendChild(inp);
          inp.addEventListener('keydown', (e) => e.stopPropagation());
          inp.addEventListener('change', () => {
            const t = wallToEpoch(App.tz, inp.value);
            if (t != null) pt.t = t;
          });
        }
        if (!timeOnly) {
          const pi = mk('Price');
          const inp = document.createElement('input');
          inp.type = 'number'; inp.step = 'any';
          inp.value = pt.p;
          pi.appendChild(inp);
          inp.addEventListener('keydown', (e) => e.stopPropagation());
          inp.addEventListener('change', () => {
            const v = parseFloat(inp.value);
            if (isFinite(v)) pt.p = v;
          });
        }
      });
      const note = U.el('div', 'st-note', body);
      note.textContent = 'Time is in the chart timezone (' + TZ.shortLabel(App.tz) + ').';
    }

    function buildVis() {
      if (!d.opts.vis) d.opts.vis = defaultVis();
      U.el('div', 'ds-sec', body).textContent = 'SHOW ON INTERVALS';
      for (const f of VIS_DEFS) {
        const v = d.opts.vis[f.key];
        const r = U.el('div', 'ds-row ds-vis', body);
        const cb = U.el('span', 'ds-check' + (v.on !== false ? ' on' : ''), r);
        cb.innerHTML = '<i></i>';
        U.el('span', 'ds-lab2', r).textContent = f.label;
        if (f.key !== 'ticks' && f.key !== 'ranges') {
          const box = U.el('span', 'st-inline ds-vis-ctl', r);
          const num = document.createElement('input');
          num.type = 'number'; num.className = 'st-num ds-vis-num';
          num.min = f.min; num.max = f.max; num.step = 1;
          num.value = v.min != null ? v.min : f.min;
          num.addEventListener('keydown', (e) => e.stopPropagation());
          num.addEventListener('change', () => {
            let n = parseInt(num.value, 10);
            if (!isFinite(n)) n = f.min;
            n = U.clamp(n, f.min, f.max);
            v.min = n; num.value = n;
          });
          box.appendChild(num);
          const sl = document.createElement('input');
          sl.type = 'range'; sl.min = f.min; sl.max = f.max; sl.step = 1;
          sl.value = num.value;
          box.appendChild(sl);
          const mx = U.el('span', 'ds-vis-max', box);
          mx.textContent = f.max;
          sl.addEventListener('input', () => { v.min = parseInt(sl.value, 10); num.value = sl.value; });
        }
        r.addEventListener('click', (e) => {
          if (e.target.closest('input')) return;
          e.preventDefault();
          v.on = v.on === false ? true : false;
          cb.classList.toggle('on', v.on !== false);
        });
      }
      const note = U.el('div', 'st-note', body);
      note.textContent = 'The drawing is hidden on intervals outside the enabled ranges.';
    }

    function renderBody() {
      body.innerHTML = '';
      if (activeTab === 'style') buildStyle();
      else if (activeTab === 'text') buildText();
      else if (activeTab === 'coords') buildCoords();
      else buildVis();
    }

    /* ---- Template menu (TV) ---- */
    dlg.querySelector('.ds-tpl-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      Toolbar.popupAt(r.left, r.bottom + 4, (p) => {
        const mk = (label, cls, fn) => {
          const it = U.el('button', 'pu-item' + (cls ? ' ' + cls : ''), p);
          it.innerHTML = `<span>${label}</span>`;
          it.addEventListener('click', () => { Toolbar.closePopup(); fn(); });
          return it;
        };
        mk('Default', '', () => {
          replaceOpts(d, factory);
          App.drawings.save();
          renderTabs(); renderBody();
        });
        const list = App.toolTemplates.list(type);
        for (const t of list) {
          const it = U.el('button', 'pu-item ds-tpl-item', p);
          it.innerHTML = `<span>${t.name}</span>`;
          const tr = U.el('button', 'pu-star ds-tpl-trash', it);
          tr.innerHTML = icon('trash');
          tr.title = 'Delete template';
          tr.addEventListener('mousedown', (ev) => ev.stopPropagation());
          tr.addEventListener('click', (ev) => {
            ev.stopPropagation();
            App.toolTemplates.remove(type, t.name);
            Toolbar.closePopup();
          });
          it.addEventListener('click', (ev) => {
            if (ev.target.closest('.ds-tpl-trash')) return;
            Toolbar.closePopup();
            replaceOpts(d, t.opts);
            App.drawings.save();
            renderTabs(); renderBody();
          });
        }
        if (list.length) U.el('div', 'pu-sep', p);
        mk('Save As…', '', () => DrawSettings.saveTemplateDialog(type, d.opts, def.name));
      });
    });

    /* Save-Template dialog — also reachable from the floating toolbar (round 21) */
    DrawSettings.saveTemplateDialog = function (type, opts, toolName) {
      const layer2 = document.getElementById('popup-layer');
      layer2.classList.remove('hidden');
      const back2 = U.el('div', 'dialog-backdrop ds-tpl-back', layer2);
      const dlg2 = U.el('div', 'dialog ds-tpl-dialog', back2);
      dlg2.innerHTML = `<h3>Save Template</h3>
        <div class="dlg-row"><label>Name<input type="text" id="ds-tpl-name" maxlength="40" value="My template" spellcheck="false"></label></div>
        <div class="dlg-actions">
          <button class="dlg-btn dlg-ghost" id="ds-tpl-cancel">Cancel</button>
          <button class="dlg-btn dlg-primary" id="ds-tpl-save">Save</button>
        </div>`;
      const inp = dlg2.querySelector('#ds-tpl-name');
      const close2 = () => { back2.remove(); layer2.classList.add('hidden'); };
      dlg2.querySelector('#ds-tpl-cancel').addEventListener('click', close2);
      back2.addEventListener('mousedown', (ev) => { if (ev.target === back2) close2(); });
      const doSave = () => {
        const nm = inp.value.trim();
        if (!nm) { inp.style.borderColor = '#f23645'; return; }
        App.toolTemplates.save(type, nm, opts);
        UI.toast(`Template “${nm}” saved for ${toolName}`, 'ok');
        close2();
      };
      dlg2.querySelector('#ds-tpl-save').addEventListener('click', doSave);
      inp.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') doSave();
        if (ev.key === 'Escape') close2();
      });
      setTimeout(() => inp.focus(), 40);
    };

    renderTabs();
    renderBody();

    /* ---- floating placement + drag (TV) ---- */
    let pos = DS_LAST_POS;
    if (!pos) {
      /* open next to the drawing when possible, else near the chart centre */
      try {
        const v = pane.engine.view();
        const hs = TOOLS[type].handles ? (TOOLS[type].handles(v, d) || []) : [];
        if (hs.length) {
          let mnx = Infinity, mxx = -Infinity, mny = Infinity;
          for (const hp of hs) { mnx = Math.min(mnx, hp[0]); mxx = Math.max(mxx, hp[0]); mny = Math.min(mny, hp[1]); }
          const rr = pane.root.getBoundingClientRect();
          pos = { x: rr.left + (mnx + mxx) / 2 + 28, y: rr.top + mny - 16 };
        }
      } catch (e) { Log.debug('drawing', 'settings placement failed', e) }
      if (!pos) {
        const ar = (document.getElementById('charts-area') || document.body).getBoundingClientRect();
        pos = { x: ar.left + ar.width / 2 - 230, y: ar.top + 90 };
      }
    }
    const clampPos = () => {
      if (!dlg) return; // closed before the frame fired
      const w = dlg.offsetWidth || 460, h = dlg.offsetHeight || 420;
      pos.x = U.clamp(pos.x, 8, Math.max(8, window.innerWidth - w - 8));
      pos.y = U.clamp(pos.y, 40, Math.max(40, window.innerHeight - h - 8));
      dlg.style.left = Math.round(pos.x) + 'px';
      dlg.style.top = Math.round(pos.y) + 'px';
    };
    requestAnimationFrame(clampPos);
    const titleEl = dlg.querySelector('.ds-title');
    titleEl.addEventListener('mousedown', (e) => {
      if (e.target.closest('.dlg-x') || e.target.closest('.ds-pen')) return;
      if (e.button !== 0) return;
      e.preventDefault();
      const ox = e.clientX - dlg.offsetLeft, oy = e.clientY - dlg.offsetTop;
      const mv = (ev) => {
        if (!dlg) return;
        pos.x = ev.clientX - ox;
        pos.y = ev.clientY - oy;
        clampPos();
      };
      const mup = () => {
        DS_LAST_POS = { x: pos.x, y: pos.y };
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', mup);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', mup);
    });
  };

export { DrawSettings };
