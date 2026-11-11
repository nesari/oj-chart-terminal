/**
 * Chart Settings dialog (TradingView-style)
 *
 * Tabs: Symbol / Status line / Scales and lines / Canvas / Alerts
 * Live-apply on every change; Cancel restores the snapshot taken at open.
 * Keys are flat & persisted in localStorage 'mt5_settings'. Templates saved
 * separately in 'mt5_st_tpl'.
 *
 * @module chart/settings
 */

import { U } from '../core/util.js';
import { Log } from '../../../core/logger.js';
import { icon } from '../ui/icons.js';
import { TZ } from '../../../core/timezone.js';
import { Theme } from '../core/theme.js';
import { App } from '../../../core/state.js';
import { Manager } from './manager.js';
import { Toolbar } from './toolbar.js';

const DEFAULTS = {
    /* --- Symbol / Candles --- */
    colorPrevClose: true,        // color bars based on previous close (off = single color)
    bodyOn: true, upColor: '#089981', downColor: '#f23645',
    bordersOn: true, borderUpColor: '#089981', borderDownColor: '#f23645',
    wickOn: true, wickUpColor: '#089981', wickDownColor: '#f23645',
    precision: 'default',        // 'default' | '0'..'8' (decimal digits)
    /* --- Status line (legend) --- */
    stLogo: true,                // chart-style icon in the legend
    stTitle: true, stTitleMode: 'name', // 'name' | 'ticker' | 'desc'
    stMarket: true,              // open market status chip
    stValues: true,              // O H L C (chart values)
    stBarChange: true,           // bar change values (+x (+x%))
    stBarTime: true,             // selected-candle date + time (round 27, TV legend)
    stVolume: false,             // volume in the legend
    stSpread: true,              // ROUND98 (user request): live spread chip in the legend (points)
    stLastDayChange: false,      // change vs previous day close
    stIndTitles: true, stIndInputs: true, stIndValues: true, stIndBgOp: 0.8,
    /* --- Scales and lines --- */
    currUnit: 'always',          // reserved (no currency/unit feed)
    scaleModes: 'hover',         // A/L buttons -> bottom-bar log/% visibility
    /* ROUND287: `lockRatioVal` was a dead key (nothing read it); the boolean
       `lockRatio` is the one the render path uses. */
    lockRatio: false,
    scalesPlacement: 'auto',     // 'auto' | 'left' | 'right'
    noOverlap: true,             // reserved (lib auto-handles)
    plusButton: true,            // reserved (TV quick menu)
    countdown: true,
    symLabel: 'name_value_line', // 'hidden'|'name'|'value'|'name_value'|'name_value_line'
    symLabelColor: '#d1d4dc',
    prevDayClose: 'hidden',      // 'hidden'|'value'|'line'|'value_line'
    prevDayCloseColor: '#f7c948',
    indFin: 'value',             // reserved (no indicators)
    highLow: 'hidden',           // 'hidden'|'value'|'line'|'value_line'
    highLowColor: '#787b86',
    bidAsk: 'hidden',            // 'hidden'|'line'|'value_line'
    bidColor: '#2962ff', askColor: '#f23645',
    dayOfWeek: true,             // day-of-week on time-scale labels
    /* --- Canvas --- */
    bgMode: 'solid', bg1: '#0f0f0f', bg2: '#0a0a0a', /* round 44: TV dark */
    vGrid: true, hGrid: true, gridColor: 'rgba(42,46,57,.55)',
    crosshair: true, crossColor: '#758696', crossStyle: 'largedashed',
    watermark: true, wmSymbol: true, wmTf: true, wmSize: 44, wmOpacity: 0.12,
    wmContent: 'ticker_interval_desc', wmColor: '#787b86',
    scaleText: '#d1d4dc', scaleFont: 11,
    scaleLines: '#2a2e39',
    navButtons: 'hover',         // 'always' | 'hover' | 'hidden'
    paneButtons: 'hover',        // reserved
    marginTop: 8, marginBottom: 8, marginRight: 10,
    renkoBrick: 0,
    /* --- Alerts --- */
    alertLines: true, alertColor: '#f7c948', alertOnlyActive: true,
    toastAutoHide: true,
    /* legacy aliases (kept for saved settings of older versions).
       ROUND287: `grid` was a dead key — it is never read anywhere; the two
       real toggles are vGrid/hGrid. Keeping it only misled the settings audit
       into reporting a missing control. */
    priceLine: true, priceLabel: true,
  };

  /* merge saved over defaults; migrate legacy keys */
  function load() {
    const saved = U.lsGet('mt5_settings', {}) || {};
    const c = Object.assign({}, DEFAULTS, saved);
    if (saved.vGrid === undefined && saved.grid !== undefined) c.vGrid = saved.grid !== false;
    if (saved.hGrid === undefined && saved.grid !== undefined) c.hGrid = saved.grid !== false;
    return c;
  }

  const Settings = { conf: load(), DEFAULTS };
  Settings.isDefaultKey = (k) => DEFAULTS[k] === undefined;

  function persist() { U.lsSet('mt5_settings', Settings.conf); }

  const C = () => Settings.conf;

  /* ================= applying ================= */
  Settings.applyAll = function () {
    for (const pane of App.panes) Settings.applyPane(pane);
    /* bottom-bar buttons: log/% visibility + nav buttons visibility */
    const tb = document.getElementById('bottom-toolbar');
    if (tb) {
      tb.classList.toggle('nav-always', C().navButtons === 'always');
      tb.classList.toggle('nav-hidden', C().navButtons === 'hidden');
      const lm = C().scaleModes === 'hidden';
      ['scale-log-btn', 'scale-pct-btn'].forEach((id) => {
        const b = document.getElementById(id);
        if (b) b.classList.toggle('st-hidden-by-cfg', lm);
      });
    }
  };

  /* apply everything that maps onto one pane */
  Settings.applyPane = function (pane) {
    const c = C();
    try {
      /* ROUND40: enum-aligned with LWC (Dotted=1, LargeDashed=3) — matches the
         engine's vertLine dash so both crosshair lines share ONE style */
      const crossStyle = { solid: 0, dotted: 1, dashed: 2, largedashed: 3 }[c.crossStyle] ?? 3;
      pane.chart.applyOptions({
        layout: { textColor: c.scaleText, fontSize: c.scaleFont },
        grid: {
          /* BUG-002: the NATIVE vertical grid stays off — the engine draws the
             vertical lines at the one uniform axis cadence and the Canvas tab's
             "Vertical grid lines" toggle (c.vGrid) + color drive that painter
             (Engine.render reads them every frame) */
          vertLines: { visible: false, color: c.gridColor },
          horzLines: { visible: c.hGrid !== false, color: c.gridColor },
        },
        crosshair: {
          /* BUG-C/R25 → round 31: the native vertLine is disabled — the
             engine paints the vertical line + the .tax-live pill from the
             RAW cursor (LWC clamps its own crosshair index to the last bar
             for future times, which pinned the line at the live market).
             crossColor/crossStyle still drive the engine painter + the
             native horzLine below. */
          vertLine: { visible: false, color: c.crossColor, style: crossStyle, labelVisible: false },
          horzLine: { visible: c.crosshair !== false, color: c.crossColor, style: crossStyle },
        },
        rightPriceScale: { borderColor: c.scaleLines },
        timeScale: Object.assign(Manager.chartTimeScaleOpts(pane), { rightOffset: U.clamp(c.marginRight, 0, 100) }),
      });
      /* background lives on the host element so the watermark layer stays visible */
      if (pane.host) {
        pane.host.style.background = c.bgMode === 'gradient'
          ? `linear-gradient(180deg, ${c.bg1} 0%, ${c.bg2} 100%)`
          : c.bg1;
      }
      /* round 32: indicator sub-panes wear the same skin (colors/crosshair/
         scales) and re-fit their geometry */
      if (Manager.applySubPaneSettings) { try { Manager.applySubPaneSettings(pane); } catch (e) { Log.debug('chart', 'sub-pane settings apply failed', e) } }
      /* price scale placement */
      const scaleId = c.scalesPlacement === 'left' ? 'left' : 'right';
      if ((pane._scaleId || 'right') !== scaleId) {
        try { pane.series.applyOptions({ priceScaleId: scaleId }); } catch (e) {}
        pane._scaleId = scaleId;
      }
      pane.chart.applyOptions({ leftPriceScale: { visible: scaleId === 'left' }, rightPriceScale: { visible: scaleId === 'right' } });
      /* series (candles) */
      Manager.applySeriesLook(pane);
      Manager.applySeriesFormat(pane);
      /* watermark */
      if (Manager.updateWatermark) Manager.updateWatermark(pane);
      /* price lines (prev day / high-low / bid-ask / alerts) + legend + chip */
      if (Manager.applyPriceLines) Manager.applyPriceLines(pane);
      if (Manager.updateLegendTitle) Manager.updateLegendTitle(pane);
      if (Manager.updateLegend) Manager.updateLegend(pane, null);
      if (Manager.updateCountdowns) Manager.updateCountdowns();
    } catch (e) { Log.debug('chart', 'settings apply failed', e) }
  };

  Settings.set = function (key, val, opts) {
    /* BUG-014 full-coverage guard: every dialog-writable key MUST have a
       factory default — a missing key here means the Default template can
       never reset it. Surfaced loudly instead of silently diverging. */
    if (DEFAULTS[key] === undefined) {
      try { Log.warn('chart', 'settings key has no factory default', { key }); } catch (e) {}
    }
    Settings.conf[key] = val;
    persist();
    if (opts && opts.noApply) return;
    /* special-cases first */
    if (key === 'precision') {
      for (const p of App.panes) { try { Manager.applySeriesFormat(p); } catch (e) { Log.debug('chart', 'precision format reapply failed', e) } }
      return;
    }
    if (key === 'dayOfWeek') { Manager.applyTimezone(); return; }
    if (key === 'scaleModes' || key === 'navButtons') { Settings.applyAll(); return; }
    Settings.applyAll();
  };

  /* ================= dialog ================= */
  let snapshot = null;

  Settings.open = function () {
    snapshot = JSON.parse(JSON.stringify(Settings.conf));
    const layer = document.getElementById('popup-layer');
    layer.classList.remove('hidden');
    U.clear(layer);
    const back = U.el('div', 'dialog-backdrop', layer);
    const dlg = U.el('div', 'dialog', back);
    dlg.id = 'settings-dialog';
    dlg.innerHTML = `<h3>Settings<button class="mini-btn dlg-x" title="Ok">${icon('x')}</button></h3>
      <div class="st-body">
        <div class="st-nav"></div>
        <div class="st-page"></div>
      </div>
      <div class="st-foot">
        <div class="st-tpl"></div>
        <div class="dlg-actions">
          <button class="dlg-btn dlg-ghost st-cancel">Cancel</button>
          <button class="dlg-btn dlg-primary st-ok">Ok</button>
        </div>
      </div>`;

    const close = (revert) => {
      if (revert) { Settings.conf = snapshot; persist(); Settings.applyAll(); }
      layer.classList.add('hidden'); U.clear(layer);
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(true); }
      else if (e.key === 'Enter' && e.target.tagName !== 'INPUT') { e.stopPropagation(); close(false); }
    };
    document.addEventListener('keydown', onKey);
    dlg.querySelector('.dlg-x').addEventListener('click', () => close(false));
    dlg.querySelector('.st-ok').addEventListener('click', () => close(false));
    dlg.querySelector('.st-cancel').addEventListener('click', () => close(true));
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(false); });

    /* Free Transform of the dialog itself (round 19): drag by the header,
       resize by the bottom-right grip — TV keeps its settings modal movable */
    dlg.classList.add('st-movable');
    dlg.style.left = Math.max(8, Math.round((window.innerWidth - 470) / 2)) + 'px';
    dlg.style.top = '90px';
    const h3 = dlg.querySelector('h3');
    h3.style.cursor = 'move';
    h3.addEventListener('mousedown', (e) => {
      if (e.target.closest('.dlg-x') || e.button !== 0) return;
      e.preventDefault();
      const ox = e.clientX - dlg.offsetLeft, oy = e.clientY - dlg.offsetTop;
      const mv = (ev) => {
        dlg.style.left = U.clamp(ev.clientX - ox, 8, Math.max(8, window.innerWidth - 140)) + 'px';
        dlg.style.top = U.clamp(ev.clientY - oy, 8, Math.max(8, window.innerHeight - 90)) + 'px';
      };
      const up2 = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up2); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up2);
    });
    const grip = U.el('button', 'dlg-grip', dlg);
    grip.innerHTML = icon('grip');
    grip.title = 'Resize';
    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sw = dlg.offsetWidth, sh = dlg.offsetHeight, sx = e.clientX, sy = e.clientY;
      const mv = (ev) => {
        dlg.style.width = U.clamp(sw + (ev.clientX - sx), 560, window.innerWidth - 24) + 'px';
        dlg.style.height = U.clamp(sh + (ev.clientY - sy), 480, window.innerHeight - 24) + 'px';
      };
      const up2 = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up2); };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up2);
    });

    const nav = dlg.querySelector('.st-nav');
    const page = dlg.querySelector('.st-page');

    /* ---- row builders (TradingView look) ---- */
    const sec = (title) => { U.el('div', 'st-sec', page).textContent = title; };

    const rowCheckbox = (label, key, opts) => {
      const r = U.el('div', 'st-row', page);
      r.innerHTML = `<span class="st-lab">${label}${opts && opts.hint ? ` <span class="st-q" title="${opts.hint}">?</span>` : ''}</span>`;
      const cb = U.el('span', 'st-check' + (C()[key] !== false && C()[key] !== 'hidden' ? ' on' : ''), r);
      cb.innerHTML = '<i></i>';
      r.addEventListener('click', (e) => {
        e.preventDefault();
        const nv = !(C()[key] !== false && C()[key] !== 'hidden');
        Settings.set(key, nv);
        cb.classList.toggle('on', nv);
        if (opts && opts.depends) opts.depends(nv);
      });
      return cb;
    };

    const colorSw = (parent, key) => {
      /* round 19: custom in-app colour picker opens next to the swatch (the
         native <input type=color> popup appears detached at the screen corner
         in Electron) - same TV behaviour for every colour row */
      const w = U.el('button', 'st-color', parent);
      const sw = U.el('span', 'st-color-sw', w);
      const paint = () => { sw.style.background = U.toHex(C()[key]); };
      paint();
      w.title = 'Color';
      w.addEventListener('mousedown', (e) => e.stopPropagation());
      w.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const r = w.getBoundingClientRect();
        Toolbar.colorPickerAt(r.left, r.bottom + 4, C()[key], (c) => {
          Settings.set(key, c);
          paint();
        });
      });
      return w;
    };

    const rowColor2 = (label, keyUp, keyDown) => {
      const r = U.el('div', 'st-row', page);
      r.innerHTML = `<span class="st-lab">${label}</span>`;
      const box = U.el('span', 'st-inline', r);
      colorSw(box, keyUp); colorSw(box, keyDown);
      return r;
    };

    const rowSelect = (label, key, options, opts) => {
      const r = U.el('div', 'st-row', page);
      r.innerHTML = `<span class="st-lab">${label}</span>`;
      const sel = document.createElement('select');
      sel.className = 'st-sel';
      for (const o of options) {
        const op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        sel.appendChild(op);
      }
      sel.value = String(C()[key]);
      r.appendChild(sel);
      sel.addEventListener('keydown', (e) => e.stopPropagation());
      sel.addEventListener('change', () => {
        Settings.set(key, sel.value);
        if (opts && opts.onchange) opts.onchange(sel.value);
      });
      return { row: r, sel };
    };

    const rowSelectColor = (label, key, options, colorKey) => {
      const r = U.el('div', 'st-row', page);
      r.innerHTML = `<span class="st-lab">${label}</span>`;
      const box = U.el('span', 'st-inline', r);
      const sel = document.createElement('select');
      sel.className = 'st-sel';
      for (const o of options) {
        const op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        sel.appendChild(op);
      }
      sel.value = String(C()[key]);
      box.appendChild(sel);
      sel.addEventListener('keydown', (e) => e.stopPropagation());
      sel.addEventListener('change', () => Settings.set(key, sel.value));
      if (colorKey) colorSw(box, colorKey);
      return r;
    };

    const rowCheckboxColor2 = (label, key, keyUp, keyDown) => {
      /* round 19: checkbox in the shared LEFT column, colours pushed to the end */
      const r = U.el('div', 'st-row st-row-check', page);
      r.innerHTML = `<span class="st-lab">${label}</span>`;
      const cb = U.el('span', 'st-check' + (C()[key] !== false ? ' on' : ''), r);
      cb.innerHTML = '<i></i>';
      const box = U.el('span', 'st-inline', r);
      r.addEventListener('click', (e) => {
        if (e.target.closest('.st-color')) return;
        e.preventDefault();
        const nv = !(C()[key] !== false);
        Settings.set(key, nv);
        cb.classList.toggle('on', nv);
      });
      colorSw(box, keyUp); colorSw(box, keyDown);
      return r;
    };

    const rowNumber = (label, key, unit, min, max) => {
      const r = U.el('div', 'st-row', page);
      r.innerHTML = `<span class="st-lab">${label}</span>`;
      const box = U.el('span', 'st-inline', r);
      const inp = document.createElement('input');
      inp.type = 'number'; inp.className = 'st-num';
      inp.min = min; inp.max = max; inp.step = 'any';
      inp.value = C()[key] != null ? C()[key] : 0;
      box.appendChild(inp);
      if (unit) U.el('span', 'st-unit', box).textContent = unit;
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      inp.addEventListener('change', () => {
        let v = parseFloat(inp.value);
        if (!isFinite(v)) v = min;
        v = U.clamp(v, min, max);
        Settings.set(key, v);
        inp.value = v;
      });
      return r;
    };

    const rowSlider = (label, key, min, max, step, fmt) => {
      const r = U.el('div', 'st-row', page);
      r.innerHTML = `<span class="st-lab">${label}</span>`;
      const box = U.el('span', 'st-inline st-slider', r);
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step;
      inp.value = C()[key] != null ? C()[key] : min;
      box.appendChild(inp);
      inp.addEventListener('input', () => Settings.set(key, parseFloat(inp.value)));
      return r;
    };

    const note = (text) => { const n = U.el('div', 'st-note', page); n.textContent = text; };

    /* ---- tabs ---- */
    const PAGES = {
      symbol: { title: 'Symbol', ic: 'candles', build() {
        sec('CANDLES');
        rowCheckbox('Color bars based on previous close', 'colorPrevClose');
        rowCheckboxColor2('Body', 'bodyOn', 'upColor', 'downColor');
        rowCheckboxColor2('Borders', 'bordersOn', 'borderUpColor', 'borderDownColor');
        rowCheckboxColor2('Wick', 'wickOn', 'wickUpColor', 'wickDownColor');
        sec('DATA MODIFICATION');
        rowSelect('Precision', 'precision', [
          ['default', 'Default'], ['0', '1'], ['1', '0.1'], ['2', '0.01'], ['3', '0.001'],
          ['4', '0.0001'], ['5', '0.00001'], ['6', '0.000001'], ['7', '0.0000001'], ['8', '0.00000001'],
        ]);
        const tzr = rowSelect('Timezone', '__tz', [], { onchange: (v) => {
          App.tz = v; Manager.applyTimezone();
        }});
        tzr.sel.innerHTML = '';
        for (const z of TZ.sortedZones()) {
          const op = document.createElement('option');
          op.value = z; op.textContent = TZ.zoneLabel(z);
          tzr.sel.appendChild(op);
        }
        tzr.sel.value = App.tz;
        note('Timezone applies to the time axis, crosshair and Data Window on every chart.');
      } },

      statusline: { title: 'Status line', ic: 'list', build() {
        sec('INSTRUMENT');
        rowCheckbox('Logo', 'stLogo');
        rowCheckboxSelect('Title', 'stTitle', 'stTitleMode', [['name', 'Name'], ['ticker', 'Ticker'], ['desc', 'Description']]);
        rowCheckbox('Open market status', 'stMarket');
        rowCheckbox('Chart values', 'stValues');
        rowCheckbox('Bar change values', 'stBarChange');
        rowCheckbox('Bar date & time', 'stBarTime');
        rowCheckbox('Volume', 'stVolume');
        rowCheckbox('Spread', 'stSpread'); /* ROUND98: live ask-bid chip, per chart */
        rowCheckbox('Last day change values', 'stLastDayChange');
        sec('INDICATORS');
        rowCheckbox('Titles', 'stIndTitles');
        rowCheckbox('Inputs', 'stIndInputs');
        rowCheckbox('Values', 'stIndValues');
        rowSlider('Background', 'stIndBgOp', 0, 1, 0.05);
        note('Indicator legend options are stored and apply once indicators are supported.');
      } },

      scales: { title: 'Scales and lines', ic: 'measure', build() {
        sec('PRICE SCALE');
        rowSelect('Currency and Unit', 'currUnit', [['always', 'Always visible'], ['hover', 'Visible on mouse over'], ['hidden', 'Hidden']]);
        rowSelect('Scale modes (A and L)', 'scaleModes', [['hover', 'Visible on mouse over'], ['always', 'Always visible'], ['hidden', 'Hidden']]);
        rowCheckbox('Lock price to bar ratio', 'lockRatio');
        rowSelect('Scales placement', 'scalesPlacement', [['auto', 'Auto'], ['left', 'Left'], ['right', 'Right']]);
        sec('PRICE LABELS & LINES');
        rowCheckbox('No overlapping labels', 'noOverlap');
        rowCheckbox('Plus button', 'plusButton', { hint: 'Shows the quick-add plus button near the crosshair' });
        rowCheckbox('Countdown to bar close', 'countdown');
        rowSelectColor('Symbol', 'symLabel', [
          ['hidden', 'Hidden'], ['name', 'Name'], ['value', 'Value'],
          ['line', 'Line'], ['line_value', 'Line and value'],
          ['name_value', 'Name, value'], ['name_value_line', 'Name, value, line'],
        ], 'symLabelColor');
        rowSelectColor('Previous day close', 'prevDayClose', [['hidden', 'Hidden'], ['value', 'Value'], ['line', 'Line'], ['value_line', 'Value and line']], 'prevDayCloseColor');
        rowSelect('Indicators and financials', 'indFin', [['value', 'Value'], ['hidden', 'Hidden']]);
        rowSelectColor('High and low', 'highLow', [['hidden', 'Hidden'], ['value', 'Value'], ['line', 'Line'], ['value_line', 'Value and line']], 'highLowColor');
        rowSelectColor2('Bid and ask', 'bidAsk', [['hidden', 'Hidden'], ['line', 'Line'], ['value_line', 'Value and line']], 'bidColor', 'askColor');
        sec('TIME SCALE');
        rowCheckbox('Day of week on labels', 'dayOfWeek');
      } },

      canvas: { title: 'Canvas', ic: 'note', build() {
        sec('CHART BASIC STYLES');
        rowSelectColor2('Background', 'bgMode', [['solid', 'Solid'], ['gradient', 'Gradient']], 'bg1', 'bg2');
        rowCheckboxColor('Vertical grid lines', 'vGrid', 'gridColor');
        rowCheckboxColor('Horizontal grid lines', 'hGrid', 'gridColor');
        /* ROUND287 (TV parity): the crosshair, the watermark and the whole
           grid each need a master ON/OFF in TV. `crosshair` was only a style
           picker (its on/off lived in the config with no control), and the
           watermark had a content select but no way to hide it outright. */
        rowCheckbox('Crosshair', 'crosshair');
        rowSelectColor('Crosshair', 'crossStyle', [['solid', 'Solid'], ['dashed', 'Dashed'], ['largedashed', 'Large dashed'], ['dotted', 'Dotted']], 'crossColor');
        rowCheckbox('Watermark', 'watermark');
        /* ROUND287 (TV parity): the watermark's ticker/interval parts were
           read by the painter (wmSymbol/wmTf) but had no control at all. */
        rowCheckbox('Watermark symbol', 'wmSymbol');
        rowCheckbox('Watermark interval', 'wmTf');
        rowSelectColor('Watermark', 'wmContent', [
          ['ticker_interval_desc', 'Ticker, Interval, Description'],
          ['ticker_interval', 'Ticker, Interval'], ['ticker', 'Ticker'], ['hidden', 'Hidden'],
        ], 'wmColor');
        rowSlider('Watermark size', 'wmSize', 20, 90, 2);
        rowSlider('Watermark transparency', 'wmOpacity', 0.04, 0.3, 0.01);
        sec('SCALES');
        rowSelectNum('Text', 'scaleFont', [[10, '10'], [11, '11'], [12, '12'], [13, '13'], [14, '14'], [16, '16'], [18, '18'], [20, '20']], 'scaleText');
        rowColorOnly('Lines', 'scaleLines');
        sec('BUTTONS');
        rowSelect('Navigation', 'navButtons', [['hover', 'Visible on mouse over'], ['always', 'Always visible'], ['hidden', 'Hidden']]);
        rowSelect('Pane', 'paneButtons', [['hover', 'Visible on mouse over'], ['always', 'Always visible'], ['hidden', 'Hidden']]);
        sec('MARGINS');
        rowNumber('Top', 'marginTop', '%', 0, 40);
        rowNumber('Bottom', 'marginBottom', '%', 0, 40);
        rowNumber('Right', 'marginRight', 'bars', 0, 100);
        sec('CHART TYPE');
        rowNumber('Renko brick size', 'renkoBrick', '', 0, 1000000);
        note('Renko brick: 0 = automatic (ATR-based). Changes rebuild Renko charts instantly.');
      } },

      alerts: { title: 'Alerts', ic: 'clock', build() {
        sec('CHART LINE VISIBILITY');
        rowCheckboxColor('Alert lines', 'alertLines', 'alertColor');
        rowCheckbox('Only active alerts', 'alertOnlyActive');
        sec('NOTIFICATIONS');
        rowCheckbox('Automatically hide toasts', 'toastAutoHide');
      } },
    };

    /* extra composite builders */
    function rowCheckboxSelect(label, cbKey, selKey, options) {
      const r = U.el('div', 'st-row st-row-check', page);
      r.innerHTML = `<span class="st-lab">${label}</span>`;
      const cb = U.el('span', 'st-check' + (C()[cbKey] !== false ? ' on' : ''), r);
      cb.innerHTML = '<i></i>';
      const box = U.el('span', 'st-inline', r);
      const sel = document.createElement('select');
      sel.className = 'st-sel st-sel-sm';
      for (const o of options) sel.appendChild(new Option(o[1], o[0]));
      sel.value = String(C()[selKey]);
      box.appendChild(sel);
      sel.addEventListener('keydown', (e) => e.stopPropagation());
      sel.addEventListener('change', () => Settings.set(selKey, sel.value));
      r.addEventListener('click', (e) => {
        if (e.target.closest('.st-sel')) return;
        e.preventDefault();
        const nv = !(C()[cbKey] !== false);
        Settings.set(cbKey, nv);
        cb.classList.toggle('on', nv);
      });
      return r;
    }
    function rowColorOnly(label, key) {
      const r = U.el('div', 'st-row', page);
      r.innerHTML = `<span class="st-lab">${label}</span>`;
      const box = U.el('span', 'st-inline', r);
      colorSw(box, key);
      return r;
    }
    /* checkbox + a single color swatch (grid lines, alert lines) */
    function rowCheckboxColor(label, key, colorKey) {
      const r = U.el('div', 'st-row st-row-check', page);
      r.innerHTML = `<span class="st-lab">${label}</span>`;
      const cb = U.el('span', 'st-check' + (C()[key] !== false ? ' on' : ''), r);
      cb.innerHTML = '<i></i>';
      const box = U.el('span', 'st-inline', r);
      r.addEventListener('click', (e) => {
        if (e.target.closest('.st-color')) return;
        e.preventDefault();
        const nv = !(C()[key] !== false);
        Settings.set(key, nv);
        cb.classList.toggle('on', nv);
      });
      colorSw(box, colorKey);
      return r;
    }
    function rowSelectColor2(label, key, options, keyUp, keyDown) {
      const r = U.el('div', 'st-row', page);
      r.innerHTML = `<span class="st-lab">${label}</span>`;
      const box = U.el('span', 'st-inline', r);
      const sel = document.createElement('select');
      sel.className = 'st-sel';
      for (const o of options) {
        const op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        sel.appendChild(op);
      }
      sel.value = String(C()[key]);
      box.appendChild(sel);
      sel.addEventListener('keydown', (e) => e.stopPropagation());
      sel.addEventListener('change', () => Settings.set(key, sel.value));
      colorSw(box, keyUp); colorSw(box, keyDown);
      return r;
    }
    function rowSelectNum(label, key, options, colorKey) {
      const r = U.el('div', 'st-row', page);
      r.innerHTML = `<span class="st-lab">${label}</span>`;
      const box = U.el('span', 'st-inline', r);
      const sel = document.createElement('select');
      sel.className = 'st-sel st-sel-sm';
      for (const o of options) {
        const op = document.createElement('option');
        op.value = String(o[0]); op.textContent = o[1];
        sel.appendChild(op);
      }
      sel.value = String(C()[key]);
      box.appendChild(sel);
      sel.addEventListener('keydown', (e) => e.stopPropagation());
      sel.addEventListener('change', () => Settings.set(key, parseInt(sel.value, 10)));
      colorSw(box, colorKey);
      return r;
    }

    const showPage = (id) => {
      U.clear(page);
      PAGES[id].build();
      nav.querySelectorAll('.st-nav-btn').forEach((b) => b.classList.toggle('on', b.dataset.pg === id));
    };
    for (const id of Object.keys(PAGES)) {
      const b = U.el('button', 'st-nav-btn', nav);
      b.dataset.pg = id;
      b.innerHTML = `<span class="st-nav-ic">${icon(PAGES[id].ic)}</span>${PAGES[id].title}`;
      b.addEventListener('click', () => showPage(id));
    }
    showPage('symbol');

    /* ---- Template (bottom-left) ---- */
    const tplBox = dlg.querySelector('.st-tpl');
    function renderTpl() {
      U.clear(tplBox);
      const wrap = U.el('div', 'st-tpl-row', tplBox);
      const lab = U.el('span', 'st-tpl-lab', wrap);
      lab.textContent = 'Template';
      /* BUG-014: factory defaults for the ACTIVE theme — DEFAULTS holds the dark
         palette literals, so a light-theme reset must overlay the theme's own
         factory colours (light reset -> light defaults, AUD-001 rules) */
      function themeAwareDefaults() {
        const d = JSON.parse(JSON.stringify(DEFAULTS));
        try {
          const mode = (Theme && Theme.mode) || 'dark';
          if (Theme && Theme.chartDefaults) Object.assign(d, Theme.chartDefaults(mode));
        } catch (e) { Log.debug('chart', 'theme factory defaults failed', e) }
        return d;
      }
      const sel = document.createElement('select');
      sel.className = 'st-sel';
      /* BUG-014 root-cause fix: the list previously opened with "Default"
         ALREADY selected, so picking it never fired a change event and the
         reset was a no-op. A neutral placeholder is selected instead, making
         "Default" an actual choice (and honestly showing "no template"). */
      sel.appendChild(new Option('—', '__pick'));
      sel.value = '__pick';
      sel.appendChild(new Option('Default', '__default'));
      const tpls = U.lsGet('mt5_st_tpl', {}) || {};
      for (const name of Object.keys(tpls)) sel.appendChild(new Option(name, name));
      sel.appendChild(new Option('Save current…', '__save'));
      wrap.appendChild(sel);
      sel.addEventListener('keydown', (e) => e.stopPropagation());
      sel.addEventListener('change', () => {
        const v = sel.value;
        if (v === '__default') {
          Settings.conf = themeAwareDefaults(); // BUG-014: full factory reset, active-theme colours
          persist(); Settings.applyAll();
          showPage('symbol'); renderTpl();
        } else if (v === '__save') {
          U.clear(tplBox);
          const row2 = U.el('div', 'st-tpl-row', tplBox);
          const inp = document.createElement('input');
          inp.type = 'text'; inp.className = 'st-tpl-name'; inp.placeholder = 'Template name';
          row2.appendChild(inp);
          const ok = U.el('button', 'dlg-btn dlg-primary st-tpl-btn', row2);
          ok.textContent = 'Save';
          const cancel = U.el('button', 'dlg-btn dlg-ghost st-tpl-btn', row2);
          cancel.textContent = 'Cancel';
          inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') ok.click(); });
          cancel.addEventListener('click', renderTpl);
          ok.addEventListener('click', () => {
            const name = inp.value.trim().slice(0, 32);
            if (name) {
              tpls[name] = JSON.parse(JSON.stringify(Settings.conf));
              U.lsSet('mt5_st_tpl', tpls);
            }
            renderTpl();
          });
          inp.focus();
        } else if (tpls[v]) {
          Settings.conf = Object.assign({}, DEFAULTS, tpls[v]);
          persist(); Settings.applyAll();
          showPage('symbol'); renderTpl();
        }
      });
      /* right-click a saved template in the list -> delete (hint in title) */
      sel.title = 'Templates: pick Default / saved template / Save current…';
    }
    renderTpl();
  };

  Settings.init = function () {
    const btn = document.getElementById('settings-btn');
    if (!btn) return;
    btn.innerHTML = icon('gear');
    btn.addEventListener('click', () => Settings.open());
  };

export { Settings };
