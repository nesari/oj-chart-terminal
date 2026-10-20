/**
 * Technical indicators library (round 27 — parity port)
 *
 * Pure math + indicator registry, ported 1:1 from the reference platform's
 * lib/chart/indicators.ts. ZERO DOM / LWC dependency here — rendering lives
 * in indicators-ui.js. Structure returned by compute():
 * { lines: [{ values, color, width, style? }],
 * hist?: { values, colorUp, colorDown },
 * band?: { upper, lower, fill },
 * levels?: [{ value, color, dashed }] }
 * values arrays are aligned with pane.bars (null = no data).
 *
 * @module core/indicators
 *
 * Phase 3: moved from the renderer (chart/) into the platform-agnostic
 * core — the registry and every compute() are pure math with zero DOM,
 * LWC or host-global references, so Node/web/mobile reuse it as-is.
 *
 * ROUND 74 (Pine engine): the math kernels (sma/ema/wma/stdev/rsi/
 * trueRange/atr) now LIVE in core/pine/stdlib/ta.js and are imported here —
 * one source of truth shared by the built-in indicators and the Pine ta.*
 * namespace (the roadmap's no-parallel-implementations rule).
 */

import { kernels } from './pine/stdlib/ta.js';
const { sma, ema, wma, stdev, rsi, trueRange, atr } = kernels;


  /* ------------------------------ Registry ------------------------------- */
  const closes = (bars) => bars.map((b) => b.close);
  const hl2 = (bars) => bars.map((b) => (b.high + b.low) / 2);

  const UP = '#26a69a', DOWN = '#ef5350', BLUE = '#2962ff', ORANGE = '#ff9800',
    PURPLE = '#ab47bc', TEAL = '#00bcd4', YELLOW = '#ffd54f';
  const LVL = (v) => ({ value: v, color: 'rgba(178,181,190,0.4)', dashed: true });

  const DEFS = [
    /* ---------------------------- Trend (main) --------------------------- */
    { type: 'sma', label: 'Moving Average (SMA)', group: 'Trend', pane: 'main',
      params: [{ key: 'length', label: 'Length', def: 20 }],
      colors: { line: BLUE },
      compute: (bars, p, c) => ({ lines: [{ values: sma(closes(bars), p.length), color: c.line, width: 2 }] }) },
    { type: 'ema', label: 'Moving Average (EMA)', group: 'Trend', pane: 'main',
      params: [{ key: 'length', label: 'Length', def: 20 }],
      colors: { line: ORANGE },
      compute: (bars, p, c) => ({ lines: [{ values: ema(closes(bars), p.length), color: c.line, width: 2 }] }) },
    { type: 'wma', label: 'Moving Average (WMA)', group: 'Trend', pane: 'main',
      params: [{ key: 'length', label: 'Length', def: 20 }],
      colors: { line: PURPLE },
      compute: (bars, p, c) => ({ lines: [{ values: wma(closes(bars), p.length), color: c.line, width: 2 }] }) },
    { type: 'hma', label: 'Hull Moving Average', group: 'Trend', pane: 'main',
      params: [{ key: 'length', label: 'Length', def: 21 }],
      colors: { line: TEAL },
      compute: (bars, p, c) => {
        const half = Math.max(2, Math.round(p.length / 2));
        const wHalf = wma(closes(bars), half).map((v) => (v == null ? null : 2 * v));
        const wFull = wma(closes(bars), p.length).map((v) => (v == null ? null : -v));
        const diff = wHalf.map((v, i) => (v != null && wFull[i] != null ? v + wFull[i] : null));
        return { lines: [{ values: wma(diff, Math.max(2, Math.round(Math.sqrt(p.length)))), color: c.line, width: 2 }] };
      } },
    { type: 'bollinger', label: 'Bollinger Bands', group: 'Trend', pane: 'main',
      params: [{ key: 'length', label: 'Length', def: 20 }, { key: 'mult', label: 'StdDev', def: 2, min: 0.5, max: 6 }],
      colors: { line: BLUE },
      compute: (bars, p, c) => {
        const basis = sma(closes(bars), p.length), dev = stdev(closes(bars), p.length);
        const upper = basis.map((b, i) => (b != null && dev[i] != null ? b + p.mult * dev[i] : null));
        const lower = basis.map((b, i) => (b != null && dev[i] != null ? b - p.mult * dev[i] : null));
        return {
          lines: [{ values: basis, color: c.line, width: 1 }, { values: upper, color: c.line, width: 1 }, { values: lower, color: c.line, width: 1 }],
          band: { upper, lower, fill: 'rgba(41,98,255,0.06)' },
        };
      } },
    { type: 'donchian', label: 'Donchian Channels', group: 'Trend', pane: 'main',
      params: [{ key: 'length', label: 'Length', def: 20 }],
      colors: { line: TEAL },
      compute: (bars, p, c) => {
        const upper = new Array(bars.length).fill(null), lower = new Array(bars.length).fill(null), basis = new Array(bars.length).fill(null);
        for (let i = p.length - 1; i < bars.length; i++) {
          let hi = -Infinity, lo = Infinity;
          for (let j = 0; j < p.length; j++) { hi = Math.max(hi, bars[i - j].high); lo = Math.min(lo, bars[i - j].low); }
          upper[i] = hi; lower[i] = lo; basis[i] = (hi + lo) / 2;
        }
        return {
          lines: [{ values: upper, color: c.line, width: 1 }, { values: lower, color: c.line, width: 1 }, { values: basis, color: c.line, width: 1, style: 'dashed' }],
          band: { upper, lower, fill: 'rgba(0,188,212,0.05)' },
        };
      } },
    { type: 'keltner', label: 'Keltner Channels', group: 'Trend', pane: 'main',
      params: [{ key: 'length', label: 'Length', def: 20 }, { key: 'mult', label: 'Multiplier', def: 2, min: 0.5, max: 6 }],
      colors: { line: YELLOW },
      compute: (bars, p, c) => {
        const basis = ema(closes(bars), p.length), a = atr(bars, p.length);
        const upper = basis.map((b, i) => (b != null && a[i] != null ? b + p.mult * a[i] : null));
        const lower = basis.map((b, i) => (b != null && a[i] != null ? b - p.mult * a[i] : null));
        return {
          lines: [{ values: basis, color: c.line, width: 1 }, { values: upper, color: c.line, width: 1 }, { values: lower, color: c.line, width: 1 }],
          band: { upper, lower, fill: 'rgba(255,213,79,0.05)' },
        };
      } },
    { type: 'envelopes', label: 'Moving Average Envelopes', group: 'Trend', pane: 'main',
      params: [{ key: 'length', label: 'Length', def: 20 }, { key: 'percent', label: 'Percent', def: 2, min: 0.1, max: 20 }],
      colors: { line: BLUE },
      compute: (bars, p, c) => {
        const basis = sma(closes(bars), p.length), k = p.percent / 100;
        const upper = basis.map((b) => (b != null ? b * (1 + k) : null));
        const lower = basis.map((b) => (b != null ? b * (1 - k) : null));
        return {
          lines: [{ values: basis, color: c.line, width: 1 }, { values: upper, color: c.line, width: 1 }, { values: lower, color: c.line, width: 1 }],
        };
      } },
    { type: 'vwap', label: 'VWAP (Session)', group: 'Volume', pane: 'main',
      params: [],
      colors: { line: ORANGE },
      compute: (bars, p, c) => {
        const out = new Array(bars.length).fill(null);
        let cumPV = 0, cumV = 0, curDay = -1;
        for (let i = 0; i < bars.length; i++) {
          const day = Math.floor(bars[i].time / 86400);
          if (day !== curDay) { curDay = day; cumPV = 0; cumV = 0; }
          const tp = (bars[i].high + bars[i].low + bars[i].close) / 3;
          const v = bars[i].volume || 1;
          cumPV += tp * v; cumV += v;
          out[i] = cumPV / cumV;
        }
        return { lines: [{ values: out, color: c.line, width: 2 }] };
      } },
    { type: 'sar', label: 'Parabolic SAR', group: 'Trend', pane: 'main',
      params: [{ key: 'start', label: 'Start', def: 2, min: 1, max: 10 }, { key: 'inc', label: 'Increment', def: 2, min: 1, max: 10 }, { key: 'max', label: 'Max', def: 20, min: 5, max: 50 }],
      colors: { up: UP, down: DOWN },
      compute: (bars, p, c) => {
        const dots = new Array(bars.length).fill(null), ups = new Array(bars.length).fill(null);
        const step = p.start / 100, incStep = p.inc / 100, maxStep = p.max / 100;
        if (bars.length > 2) {
          let isUp = bars[1].close >= bars[0].close;
          let af = step;
          let ep = isUp ? bars[0].high : bars[0].low;
          let sar = isUp ? bars[0].low : bars[0].high;
          for (let i = 1; i < bars.length; i++) {
            sar = sar + af * (ep - sar);
            if (isUp) {
              if (bars[i].low < sar) { isUp = false; sar = ep; ep = bars[i].low; af = step; }
              else if (bars[i].high > ep) { ep = bars[i].high; af = Math.min(af + incStep, maxStep); }
            } else {
              if (bars[i].high > sar) { isUp = true; sar = ep; ep = bars[i].high; af = step; }
              else if (bars[i].low < ep) { ep = bars[i].low; af = Math.min(af + incStep, maxStep); }
            }
            dots[i] = sar; ups[i] = isUp;
          }
        }
        return {
          lines: [
            { values: dots.map((d, i) => (d != null && ups[i] ? d : null)), color: c.up, width: 2, style: 'dots' },
            { values: dots.map((d, i) => (d != null && !ups[i] ? d : null)), color: c.down, width: 2, style: 'dots' },
          ],
        };
      } },
    { type: 'supertrend', label: 'SuperTrend', group: 'Trend', pane: 'main',
      params: [{ key: 'length', label: 'ATR Length', def: 10 }, { key: 'mult', label: 'Factor', def: 3, min: 0.5, max: 10 }],
      colors: { up: UP, down: DOWN },
      compute: (bars, p, c) => {
        const a = atr(bars, p.length);
        const up = new Array(bars.length).fill(null), down = new Array(bars.length).fill(null);
        let dir = 1, prevUpper = Infinity, prevLower = -Infinity;
        for (let i = 0; i < bars.length; i++) {
          if (a[i] == null) continue;
          const mid = (bars[i].high + bars[i].low) / 2;
          let upper = mid + p.mult * a[i], lower = mid - p.mult * a[i];
          if (prevUpper !== Infinity) upper = bars[i].close > prevUpper ? upper : Math.min(upper, prevUpper);
          if (prevLower !== -Infinity) lower = bars[i].close < prevLower ? lower : Math.max(lower, prevLower);
          if (prevUpper !== Infinity) {
            if (dir === 1 && bars[i].close < upper) dir = -1;
            else if (dir === -1 && bars[i].close > lower) dir = 1;
          }
          up[i] = dir === 1 ? lower : null;
          down[i] = dir === -1 ? upper : null;
          prevUpper = upper; prevLower = lower;
        }
        return { lines: [{ values: up, color: c.up, width: 2 }, { values: down, color: c.down, width: 2 }] };
      } },
    { type: 'ichimoku', label: 'Ichimoku Cloud', group: 'Trend', pane: 'main',
      params: [{ key: 'conv', label: 'Conversion', def: 9 }, { key: 'base', label: 'Base', def: 26 }, { key: 'spanB', label: 'Span B', def: 52 }],
      colors: { conv: BLUE, base: DOWN, spanA: 'rgba(38,166,154,0.7)', spanB: 'rgba(239,83,80,0.7)' },
      compute: (bars, p, c) => {
        const midpoint = (len) => {
          const out = new Array(bars.length).fill(null);
          for (let i = len - 1; i < bars.length; i++) {
            let hi = -Infinity, lo = Infinity;
            for (let j = 0; j < len; j++) { hi = Math.max(hi, bars[i - j].high); lo = Math.min(lo, bars[i - j].low); }
            out[i] = (hi + lo) / 2;
          }
          return out;
        };
        const conv = midpoint(p.conv), base = midpoint(p.base);
        const shift = (arr, n) => {
          const out = new Array(bars.length).fill(null);
          for (let i = 0; i < bars.length; i++) { const src = i - n; if (src >= 0 && src < bars.length) out[i] = arr[src]; }
          return out;
        };
        const spanA = conv.map((v, i) => (v != null && base[i] != null ? (v + base[i]) / 2 : null));
        const spanB = midpoint(p.spanB);
        return {
          lines: [
            { values: conv, color: c.conv, width: 1 },
            { values: base, color: c.base, width: 1 },
            { values: shift(spanA, p.base), color: c.spanA, width: 1 },
            { values: shift(spanB, p.base), color: c.spanB, width: 1 },
          ],
        };
      } },

    /* -------------------------- Oscillators (sub) ------------------------ */
    { type: 'rsi', label: 'Relative Strength Index', group: 'Oscillators', pane: 'separate',
      params: [{ key: 'length', label: 'Length', def: 14 }],
      colors: { line: PURPLE }, fixedRange: [0, 100],
      compute: (bars, p, c) => ({
        lines: [{ values: rsi(closes(bars), p.length), color: c.line, width: 2 }],
        levels: [LVL(70), { value: 50, color: 'rgba(178,181,190,0.25)', dashed: true }, LVL(30)],
      }) },
    { type: 'macd', label: 'MACD', group: 'Oscillators', pane: 'separate',
      params: [{ key: 'fast', label: 'Fast', def: 12 }, { key: 'slow', label: 'Slow', def: 26 }, { key: 'signal', label: 'Signal', def: 9 }],
      colors: { macd: BLUE, signal: ORANGE, up: 'rgba(38,166,154,0.5)', down: 'rgba(239,83,80,0.5)' },
      compute: (bars, p, c) => {
        const src = closes(bars);
        const fast = ema(src, p.fast), slow = ema(src, p.slow);
        const macdLine = fast.map((v, i) => (v != null && slow[i] != null ? v - slow[i] : null));
        const signal = ema(macdLine, p.signal);
        const hist = macdLine.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
        return {
          lines: [{ values: macdLine, color: c.macd, width: 2 }, { values: signal, color: c.signal, width: 2 }],
          hist: { values: hist, colorUp: c.up, colorDown: c.down },
          levels: [{ value: 0, color: 'rgba(178,181,190,0.3)', dashed: true }],
        };
      } },
    { type: 'stochastic', label: 'Stochastic', group: 'Oscillators', pane: 'separate',
      params: [{ key: 'k', label: '%K Length', def: 14 }, { key: 'd', label: '%D Smoothing', def: 3 }],
      colors: { k: BLUE, d: ORANGE }, fixedRange: [0, 100],
      compute: (bars, p, c) => {
        const kVals = new Array(bars.length).fill(null);
        for (let i = p.k - 1; i < bars.length; i++) {
          let hi = -Infinity, lo = Infinity;
          for (let j = 0; j < p.k; j++) { hi = Math.max(hi, bars[i - j].high); lo = Math.min(lo, bars[i - j].low); }
          kVals[i] = hi === lo ? 50 : ((bars[i].close - lo) / (hi - lo)) * 100;
        }
        return {
          lines: [{ values: kVals, color: c.k, width: 2 }, { values: sma(kVals, p.d), color: c.d, width: 2 }],
          levels: [LVL(80), LVL(20)],
        };
      } },
    { type: 'stochrsi', label: 'Stochastic RSI', group: 'Oscillators', pane: 'separate',
      params: [{ key: 'length', label: 'RSI Length', def: 14 }, { key: 'stoch', label: 'Stoch Length', def: 14 }],
      colors: { k: BLUE, d: ORANGE }, fixedRange: [0, 100],
      compute: (bars, p, c) => {
        const r = rsi(closes(bars), p.length);
        const kVals = new Array(bars.length).fill(null);
        for (let i = p.stoch - 1; i < bars.length; i++) {
          let hi = -Infinity, lo = Infinity;
          for (let j = 0; j < p.stoch; j++) {
            const v = r[i - j];
            if (v == null) { hi = -Infinity; break; }
            hi = Math.max(hi, v); lo = Math.min(lo, v);
          }
          if (hi !== -Infinity) kVals[i] = hi === lo ? 50 : ((r[i] - lo) / (hi - lo)) * 100;
        }
        return {
          lines: [{ values: kVals, color: c.k, width: 2 }, { values: sma(kVals, 3), color: c.d, width: 2 }],
          levels: [LVL(80), LVL(20)],
        };
      } },
    { type: 'willr', label: 'Williams %R', group: 'Oscillators', pane: 'separate',
      params: [{ key: 'length', label: 'Length', def: 14 }],
      colors: { line: YELLOW }, fixedRange: [-100, 0],
      compute: (bars, p, c) => {
        const out = new Array(bars.length).fill(null);
        for (let i = p.length - 1; i < bars.length; i++) {
          let hi = -Infinity, lo = Infinity;
          for (let j = 0; j < p.length; j++) { hi = Math.max(hi, bars[i - j].high); lo = Math.min(lo, bars[i - j].low); }
          out[i] = hi === lo ? -50 : ((hi - bars[i].close) / (hi - lo)) * -100;
        }
        return { lines: [{ values: out, color: c.line, width: 2 }], levels: [LVL(-20), LVL(-80)] };
      } },
    { type: 'cci', label: 'Commodity Channel Index', group: 'Oscillators', pane: 'separate',
      params: [{ key: 'length', label: 'Length', def: 20 }],
      colors: { line: BLUE },
      compute: (bars, p, c) => {
        const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
        const ma = sma(tp, p.length);
        const out = new Array(bars.length).fill(null);
        for (let i = p.length - 1; i < bars.length; i++) {
          const m = ma[i];
          if (m == null) continue;
          let dev = 0;
          for (let j = 0; j < p.length; j++) dev += Math.abs(tp[i - j] - m);
          dev /= p.length;
          out[i] = dev === 0 ? 0 : (tp[i] - m) / (0.015 * dev);
        }
        return { lines: [{ values: out, color: c.line, width: 2 }], levels: [LVL(100), LVL(-100)] };
      } },
    { type: 'atr', label: 'Average True Range', group: 'Volatility', pane: 'separate',
      params: [{ key: 'length', label: 'Length', def: 14 }],
      colors: { line: '#e91e63' },
      compute: (bars, p, c) => ({ lines: [{ values: atr(bars, p.length), color: c.line, width: 2 }] }) },
    { type: 'stddev', label: 'Standard Deviation', group: 'Volatility', pane: 'separate',
      params: [{ key: 'length', label: 'Length', def: 20 }],
      colors: { line: TEAL },
      compute: (bars, p, c) => ({ lines: [{ values: stdev(closes(bars), p.length), color: c.line, width: 2 }] }) },
    { type: 'momentum', label: 'Momentum', group: 'Oscillators', pane: 'separate',
      params: [{ key: 'length', label: 'Length', def: 10 }],
      colors: { line: BLUE },
      compute: (bars, p, c) => {
        const out = new Array(bars.length).fill(null);
        for (let i = p.length; i < bars.length; i++) out[i] = (bars[i].close / bars[i - p.length].close) * 100;
        return { lines: [{ values: out, color: c.line, width: 2 }], levels: [{ value: 100, color: 'rgba(178,181,190,0.3)', dashed: true }] };
      } },
    { type: 'roc', label: 'Rate of Change', group: 'Oscillators', pane: 'separate',
      params: [{ key: 'length', label: 'Length', def: 9 }],
      colors: { line: ORANGE },
      compute: (bars, p, c) => {
        const out = new Array(bars.length).fill(null);
        for (let i = p.length; i < bars.length; i++) out[i] = ((bars[i].close - bars[i - p.length].close) / bars[i - p.length].close) * 100;
        return { lines: [{ values: out, color: c.line, width: 2 }], levels: [{ value: 0, color: 'rgba(178,181,190,0.3)', dashed: true }] };
      } },
    { type: 'awesome', label: 'Awesome Oscillator', group: 'Oscillators', pane: 'separate',
      params: [],
      colors: { up: UP, down: DOWN },
      compute: (bars, p, c) => {
        const hl = hl2(bars);
        const smaFast = sma(hl, 5), smaSlow = sma(hl, 34);
        const ao = smaFast.map((v, i) => (v != null && smaSlow[i] != null ? v - smaSlow[i] : null));
        const hist = ao.map((v, i) => (v != null && i > 0 && ao[i - 1] != null ? v : null));
        return {
          lines: [],
          hist: { values: hist, colorUp: c.up, colorDown: c.down },
          levels: [{ value: 0, color: 'rgba(178,181,190,0.3)', dashed: true }],
        };
      } },

    /* ------------------------------ Volume ------------------------------- */
    { type: 'volume', label: 'Volume', group: 'Volume', pane: 'separate',
      params: [{ key: 'ma', label: 'MA Length', def: 20 }],
      colors: { up: 'rgba(38,166,154,0.6)', down: 'rgba(239,83,80,0.6)', ma: BLUE },
      compute: (bars, p, c) => {
        const vol = bars.map((b) => b.volume);
        return {
          lines: [{ values: sma(vol, p.ma), color: c.ma, width: 1 }],
          hist: { values: vol.map((v) => (v > 0 ? v : null)), colorUp: c.up, colorDown: c.down },
        };
      } },
    { type: 'obv', label: 'On Balance Volume', group: 'Volume', pane: 'separate',
      params: [],
      colors: { line: BLUE },
      compute: (bars, p, c) => {
        const out = [0];
        for (let i = 1; i < bars.length; i++) {
          if (bars[i].close > bars[i - 1].close) out.push(out[i - 1] + bars[i].volume);
          else if (bars[i].close < bars[i - 1].close) out.push(out[i - 1] - bars[i].volume);
          else out.push(out[i - 1]);
        }
        return { lines: [{ values: out, color: c.line, width: 2 }] };
      } },
    { type: 'mfi', label: 'Money Flow Index', group: 'Volume', pane: 'separate',
      params: [{ key: 'length', label: 'Length', def: 14 }],
      colors: { line: PURPLE }, fixedRange: [0, 100],
      compute: (bars, p, c) => {
        const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
        const out = new Array(bars.length).fill(null);
        let posSum = 0, negSum = 0;
        const win = [];
        for (let i = 1; i < bars.length; i++) {
          const flow = tp[i] * bars[i].volume;
          const pos = tp[i] > tp[i - 1];
          win.push({ flow, pos });
          if (pos) posSum += flow; else negSum += flow;
          if (win.length > p.length) {
            const old = win.shift();
            if (old) { if (old.pos) posSum -= old.flow; else negSum -= old.flow; }
          }
          if (win.length === p.length) out[i] = negSum === 0 ? 100 : 100 - 100 / (1 + posSum / negSum);
        }
        return { lines: [{ values: out, color: c.line, width: 2 }], levels: [LVL(80), LVL(20)] };
      } },
    { type: 'adline', label: 'Accumulation / Distribution', group: 'Volume', pane: 'separate',
      params: [],
      colors: { line: ORANGE },
      compute: (bars, p, c) => {
        const out = [0];
        for (let i = 1; i < bars.length; i++) {
          const range = bars[i].high - bars[i].low;
          const clv = range === 0 ? 0 : ((bars[i].close - bars[i].low) - (bars[i].high - bars[i].close)) / range;
          out.push(out[i - 1] + clv * bars[i].volume);
        }
        return { lines: [{ values: out, color: c.line, width: 2 }] };
      } },
  ];

  const MAP = {};
  DEFS.forEach((d) => { MAP[d.type] = d; });

  const Indicators = {
    all: DEFS,
    def(type) { return MAP[type] || null; },
    compute(inst, bars) {
      const def = MAP[inst.type];
      if (!def) return { lines: [] };
      const params = {};
      for (const p of def.params) params[p.key] = (inst.params && inst.params[p.key] != null) ? inst.params[p.key] : p.def;
      const colors = Object.assign({}, def.colors, inst.colors || {});
      let out;
      try { out = def.compute(bars, params, colors) || { lines: [] }; } catch (e) { out = { lines: [] }; }
      /* round 31: per-instance Style overrides (indicator settings dialog):
         width 1..4 + named line style applied to every LINE plot — histogram
         bodies keep their own look. */
      if (inst.style && typeof inst.style === 'object') {
        const w = parseInt(inst.style.width, 10);
        const st = inst.style.lineStyle;
        for (const ln of out.lines || []) {
          if (w >= 1 && w <= 4) ln.width = w;
          if (typeof st === 'string' && st) ln.style = st;
        }
      }
      out.params = params;
      return out;
    },
    title(inst) {
      const def = MAP[inst.type];
      if (!def) return inst.type;
      if (!def.params.length) return def.label;
      const ps = def.params.map((p) => (inst.params && inst.params[p.key] != null) ? inst.params[p.key] : p.def).join(', ');
      return `${def.label} (${ps})`;
    },
  };

export { Indicators };
