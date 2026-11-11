/**
 * Indicators UI (round 27 — parity port)
 *
 * Binds the pure indicator library (chart/indicators.js) to the LWC chart:
 * - overlay indicators  -> extra series on the MAIN price scale
 * - separate indicators -> series on dedicated overlay scales, slotted
 * bottom-up (scaleMargins), each with its own legend row
 * - legend rows with live values at the crosshair + eye/gear/remove
 * - Indicators dialog (search + favorites + groups) and per-instance
 * settings dialog
 * Instances live on pane.indicators and persist via Manager.persistPanes.
 *
 * @module chart/indicators-ui
 */

import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { App } from '../../../core/state.js';
import { Manager } from './manager.js';
import { Indicators } from '../../../core/indicators.js';
/* ROUND84 (My scripts): the dialog lists the user's stored Pine scripts with
   add-to-chart / edit-code / delete — exactly like the reference platform.
   PineScriptsStore is dependency-free; PineEditor + Manager.* calls happen
   strictly at CLICK time (never at module evaluation), so the existing
   manager ↔ indicators-ui module cycle stays safe. */
import { PineScriptsStore } from '../panels/pine-scripts-store.js';
import { PineEditor } from '../panels/pine-editor.js';

const LWC = window.LightweightCharts;

  const UI = {};
  const FAV_KEY = 'mt5_ind_favs';
  const PALETTE = ['#2962ff', '#26a69a', '#ef5350', '#ff9800', '#ab47bc', '#00bcd4', '#ffd54f', '#e8e8e8'];

  /* per-pane render state: instanceId -> { series: [...], levels: [...] } */
  const RT = new Map();

  function rt(pane) {
    if (!RT.has(pane)) RT.set(pane, new Map());
    return RT.get(pane);
  }

  /* ---------- separate-pane slot layout ----------
     ROUND 32: REPLACED by TRUE sub-panes (TradingView parity). The old
     scaleMargins "slots" drew MACD/RSI INSIDE the price chart (bottom band,
     no axis labels, overlapping candles) — the user report: indicators must
     live in their correct mode, like TradingView, where every oscillator is
     a real pane below the price chart with its own price scale. The slot
     hack is gone; manager.layoutSubPanes now stacks one LWC chart per
     separate indicator below the main one (see ensureSub). */

  /* ---------- round 32: the TRUE sub-pane of one separate indicator ----------
     Created lazily by buildSeries, removed by destroySeries. Geometry is
     (re)computed by Manager.layoutSubPanes. */
  function ensureSub(pane, inst) {
    if (!pane._subs) pane._subs = new Map();
    let sub = pane._subs.get(inst.id);
    if (sub) return sub;
    const hostEl = U.el('div', 'sub-pane sub-ind', pane.host);
    const leg = U.el('div', 'sub-legend', hostEl);
    const chart = LWC.createChart(hostEl, Manager.subChartOptions(pane));
    sub = { instId: inst.id, host: hostEl, legend: leg, chart,
      chartEl: hostEl.querySelector('.tv-lightweight-charts'), firstSeries: null };
    pane._subs.set(inst.id, sub);
    /* round 33: the fresh chart has no synced `minimumWidth` yet — invalidate
       the axis-sync guard so the next layout re-applies the width to ALL
       panes (a skipped re-apply left new panes misaligned, round-32 C7) */
    if (Manager.invalidateAxisSync) Manager.invalidateAxisSync(pane);
    /* start from the main chart's current visible range (avoid the lib's
       auto-fit flash until the range-sync subscription catches up) */
    try {
      const lr = pane.chart.timeScale().getVisibleLogicalRange();
      if (lr) chart.timeScale().setVisibleLogicalRange({ from: lr.from, to: lr.to });
    } catch (e) {}
    Manager.layoutSubPanes(pane);
    return sub;
  }

  /* round 32: axis-label precision for oscillator values (MACD on EURUSD
     prints 1e-4-scale numbers — the lib default 2 decimals would read 0.00) */
  function autoPrecision(values) {
    let m = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v != null && isFinite(v)) { const a = Math.abs(v); if (a > m) m = a; }
    }
    if (m === 0) return 2;
    if (m < 0.01) return 6;
    if (m < 0.1) return 5;
    if (m < 1) return 4;
    if (m < 100) return 2;
    if (m < 10000) return 1;
    return 0;
  }

  /* ---------- series construction ---------- */
  function makeLineSeries(pane, opts) {
    return pane.chart.addLineSeries(opts);
  }

  /* round 31: named line style -> LWC LineStyle (per-instance Style tab) */
  function LWC_LINE_STYLE(name) {
    const S = LWC.LineStyle;
    return { solid: S.Solid, dotted: S.Dotted, dashed: S.Dashed, largedashed: S.LargeDashed }[name] ?? S.Solid;
  }

  /* round 31 (TV parity): Show/Hide must actually hide the series on the
     chart — the eye used to only dim the legend row while the lines stayed
     painted. Toggles the LWC `visible` option of every series of the inst. */
  function applyVisibility(pane, inst) {
    const state = rt(pane).get(inst.id);
    if (!state) return;
    const on = inst.visible !== false;
    for (const { s } of state.series) { try { s.applyOptions({ visible: on }); } catch (e) {} }
  }

  function buildSeries(pane, inst) {
    const def = Indicators.def(inst.type);
    if (!def) return;
    const state = { series: [], levels: [], chart: pane.chart, sub: null };
    const out = Indicators.compute(inst, pane.bars);
    if (def.pane === 'main') {
      const scaleId = pane._scaleId || 'right';
      for (const ln of out.lines) {
        const dots = ln.style === 'dots';
        const s = makeLineSeries(pane, {
          priceScaleId: scaleId,
          color: ln.color,
          lineWidth: ln.width || 2,
          lineStyle: LWC_LINE_STYLE(ln.style),
          lineVisible: !dots,
          pointMarkersVisible: dots,
          pointMarkersRadius: dots ? 1 : undefined,
          crosshairMarkerVisible: !dots,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        state.series.push({ s, ln });
      }
    } else {
      /* round 32: one TRUE sub-pane per separate indicator (TV parity) —
         own LWC chart, own price scale + axis labels, own legend row */
      const sub = ensureSub(pane, inst);
      state.sub = sub;
      state.chart = sub.chart;
      const scaleId = pane._scaleId || 'right';
      const base = {
        priceScaleId: scaleId,
        priceLineVisible: false,
        lastValueVisible: false,
        autoscaleInfoProvider: def.fixedRange
          ? () => ({ priceRange: { minValue: def.fixedRange[0], maxValue: def.fixedRange[1] } })
          : undefined,
      };
      let first = null;
      if (out.hist) {
        const h = sub.chart.addHistogramSeries(Object.assign({}, base, {
          color: out.hist.colorUp,
        }));
        first = h;
        state.series.push({ s: h, hist: out.hist });
      }
      out.lines.forEach((ln, li) => {
        const s = sub.chart.addLineSeries(Object.assign({}, base, {
          color: ln.color,
          lineWidth: ln.width || 2,
          lineStyle: LWC_LINE_STYLE(ln.style),
          priceFormat: def.fixedRange
            ? { type: 'price', precision: 2, minMove: 0.01 }
            : (() => { const pr = autoPrecision(ln.values); return { type: 'price', precision: pr, minMove: Math.pow(10, -pr) }; })(),
          /* TV: the oscillator pane shows its last value pill on the axis */
          lastValueVisible: li === 0 && !out.hist,
        }));
        if (!first) first = s;
        state.series.push({ s, ln });
      });
      sub.chart.priceScale(scaleId).applyOptions({ scaleMargins: { top: 0.12, bottom: 0.08 } });
      sub.firstSeries = first;
      /* level lines (RSI 70/30, MACD 0, ...) on the first series */
      for (const lv of out.levels || []) {
        try {
          state.levels.push(first.createPriceLine({
            price: lv.value, color: lv.color, lineWidth: 1,
            lineStyle: lv.dashed ? LWC.LineStyle.Dashed : LWC.LineStyle.Solid,
            axisLabelVisible: false, title: '',
          }));
        } catch (e) {}
      }
    }
    rt(pane).set(inst.id, state);
    fillSeries(pane, inst, out);
  }

  function fillSeries(pane, inst, precomputed) {
    const state = rt(pane).get(inst.id);
    if (!state) return;
    const bars = pane.bars;
    const out = precomputed || Indicators.compute(inst, bars);
    for (const { s, ln, hist } of state.series) {
      const vals = hist ? hist.values : (ln ? ln.values : null);
      if (!vals) continue;
      const data = [];
      for (let i = 0; i < bars.length; i++) {
        const v = vals[i];
        if (v == null || !isFinite(v)) data.push({ time: bars[i].time }); // whitespace
        else {
          const c = hist ? (i > 0 && vals[i - 1] != null && vals[i - 1] > v ? hist.colorDown : hist.colorUp) : undefined;
          data.push(c != null ? { time: bars[i].time, value: v, color: c } : { time: bars[i].time, value: v });
        }
      }
      try { s.setData(data); } catch (e) {}
    }
  }

  function destroySeries(pane, instId) {
    const state = rt(pane).get(instId);
    if (!state) return;
    /* round 32: series may live on the main chart OR on the instance's
       sub-chart; the sub-pane (wrapper + chart) dies with its last series */
    const chart = state.chart || pane.chart;
    for (const { s } of state.series) { try { chart.removeSeries(s); } catch (e) {} }
    rt(pane).delete(instId);
    if (state.sub) { try { Manager.removeSubPane(pane, instId); } catch (e) {} }
  }

  /* ---------- legend rows ----------
     round 32: overlay indicators keep their rows in the chart's top legend;
     each separate indicator's row lives INSIDE its own sub-pane (TV pane
     header: name + values + eye/gear/remove). */
  function ensureRows(pane) {
    if (!pane._indRows) {
      pane._indRows = U.el('div', 'ind-rows', pane.legend);
    }
    return pane._indRows;
  }

  function mkRow(pane, inst, def, box) {
    const row = U.el('div', 'ind-row' + (inst.visible === false ? ' hidden-inst' : ''), box);
    row.dataset.iid = String(inst.id);
    const dotC = def.colors.line || def.colors.up || def.colors.conv || '#2962ff';
    const title = U.el('span', 'ind-title', row);
    title.innerHTML = `<i class="ind-dot"></i>${U.esc(Indicators.title(inst))}`;
    title.querySelector('.ind-dot').style.background = dotC; // CSP: CSSOM not style="" attr
    const vals = U.el('span', 'ind-vals', row);
    const btns = U.el('span', 'ind-btns', row);
    const eye = U.el('button', 'ind-btn', btns);
    eye.innerHTML = icon(inst.visible === false ? 'eyeoff' : 'eye');
    eye.title = 'Show / Hide';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      inst.visible = inst.visible === false;
      U.lsSet('mt5_ind_touch', Date.now());
      Manager.persistPanes();
      recompute(pane);
      renderRows(pane);
    });
    const gear = U.el('button', 'ind-btn', btns);
    gear.innerHTML = icon('gear');
    gear.title = 'Settings';
    gear.addEventListener('click', (e) => { e.stopPropagation(); openSettingsDialog(pane, inst); });
    const del = U.el('button', 'ind-btn ind-del', btns);
    del.innerHTML = icon('x');
    del.title = 'Remove';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      remove(pane, inst.id);
    });
    row.addEventListener('click', () => openSettingsDialog(pane, inst));
  }

  function renderRows(pane) {
    const box = ensureRows(pane);
    U.clear(box);
    for (const inst of pane.indicators || []) {
      const def = Indicators.def(inst.type);
      if (!def) continue;
      let target = box;
      if (def.pane === 'separate') {
        const sub = pane._subs ? pane._subs.get(inst.id) : null;
        if (sub) {
          if (!sub._rows) sub._rows = U.el('div', 'ind-rows', sub.legend);
          U.clear(sub._rows);
          target = sub._rows;
        }
        /* no sub yet (bars not loaded) -> the row waits in the main legend
           and migrates into the pane header as soon as the sub is built */
      }
      mkRow(pane, inst, def, target);
    }
    updateRowValues(pane, null);
  }

  function updateRowValues(pane, hoverTime) {
    const bars = pane.bars;
    let idx = bars.length - 1;
    if (hoverTime != null && pane.barTimes.length) idx = U.nearestIndex(pane.barTimes, hoverTime);
    /* ROUND288: the legend switches in Settings never reached this painter —
       "Chart values" / indicator values were always written. They are honest
       now: stIndValues hides the values, stIndTitles hides the whole row.
       The settings object is reached lazily through the app facade (no new
       import edge from this hot path). */
    const S = (window.__app && window.__app.Settings && window.__app.Settings.conf) || {};
    const showVals = S.stIndValues !== false && S.indFin !== 'hidden';
    for (const inst of pane.indicators || []) {
      /* round 32: rows live in the main legend OR inside the sub-pane header */
      const row = pane.root.querySelector(`.ind-row[data-iid="${inst.id}"]`);
      if (!row) continue;
      if (S.stIndTitles === false) { row.style.display = 'none'; continue; }
      row.style.display = '';
      const valsEl = row.querySelector('.ind-vals');
      if (!valsEl) continue;
      const state = rt(pane).get(inst.id);
      if (!showVals || !state || !bars.length || inst.visible === false) { valsEl.textContent = ''; continue; }
      const parts = [];
      const colorsForVals = [];
      for (const { ln, hist, s } of state.series) {
        const vals = hist ? hist.values : (ln ? ln.values : null);
        if (!vals || idx < 0 || idx >= vals.length) continue;
        const v = vals[idx];
        if (v == null || !isFinite(v)) continue;
        /* oscillators live on their own scale: allow more decimals than the
           price format (MACD on EURUSD needs 7+ decimals to be readable) */
        const d = pane.digits != null ? Math.min(8, Math.max(2, pane.digits + 2)) : 3;
        colorsForVals.push(ln ? ln.color : hist.colorUp);
        parts.push(`<b>${v.toFixed(d)}</b>`);
      }
      valsEl.innerHTML = parts.join(' ');
      // round 81 CSP hardening: per-value colors applied via CSSOM (el.style.color),
      // not a style="" attribute, so style-src no longer needs 'unsafe-inline'.
      const bEls = valsEl.querySelectorAll('b');
      for (let i = 0; i < bEls.length; i++) if (colorsForVals[i]) bEls[i].style.color = colorsForVals[i];
    }
  }

  /* ---------- public API (wired into Manager) ---------- */
  function recompute(pane) {
    if (!pane || !pane.chart) return;
    const list = pane.indicators || [];
    const seen = new Set();
    for (const inst of list) {
      if (!Indicators.def(inst.type)) continue;
      seen.add(inst.id);
      if (!rt(pane).has(inst.id)) {
        if (!pane.bars.length) continue; // nothing to compute yet
        buildSeries(pane, inst);
      } else {
        fillSeries(pane, inst);
      }
      /* round 31: eye toggle = the series really disappears from the chart */
      applyVisibility(pane, inst);
    }
    for (const instId of Array.from(rt(pane).keys())) {
      if (!seen.has(instId)) destroySeries(pane, instId);
    }
    /* round 32: sub-pane set/order/margins may have changed (add/remove/eye);
       layoutSubPanes is a no-op when there are no separate indicators */
    if (pane._subs) {
      try { Manager.layoutSubPanes(pane); } catch (e) {}
      /* ROUND104: a freshly-built sub chart auto-fits on its first setData
         and that auto-fit lands on a LATER frame, so this pin used to be
         overwritten by it (the indicator then showed a different window than
         the candles above it). Manager.syncSubRanges re-asserts the range
         across the next two frames, which is after the library's fit. */
      try { Manager.syncSubRanges(pane); } catch (e) {}
    }
    renderRows(pane);
  }

  function add(pane, type) {
    const def = Indicators.def(type);
    if (!def || !pane) return null;
    pane.indicators = pane.indicators || [];
    const inst = { id: Date.now() + Math.floor(Math.random() * 999), type, params: {}, colors: {}, visible: true };
    pane.indicators.push(inst);
    Manager.persistPanes();
    recompute(pane);
    return inst;
  }

  function remove(pane, id) {
    pane.indicators = (pane.indicators || []).filter((i) => i.id !== id);
    destroySeries(pane, id);
    Manager.persistPanes();
    recompute(pane);
  }

  /* throttled tick refresh: full recompute at most every 400ms per pane */
  const _tickAt = new Map();
  function tickRecompute(pane) {
    if (!pane || !rt(pane).size) return;
    const last = _tickAt.get(pane) || 0;
    const now = Date.now();
    if (now - last < 400) return;
    _tickAt.set(pane, now);
    for (const inst of pane.indicators || []) {
      if (rt(pane).has(inst.id) && inst.visible !== false) fillSeries(pane, inst);
    }
  }

  /* Phase 2: these hooks are DELEGATED from chart/manager.js (which imports
     them from here) — no cross-module object mutation at module-evaluation
     time, because manager.js ↔ indicators-ui.js form an ES module cycle and
     top-level writes into a not-yet-initialized binding would throw (TDZ). */
  function updateIndicatorRows(pane, hoverTime) { updateRowValues(pane, hoverTime); }

  /* ---------- dialogs ---------- */
  function favs() { return U.lsGet(FAV_KEY, ['ema', 'rsi', 'macd', 'volume']); }
  function toggleFav(type) {
    const f = favs();
    const i = f.indexOf(type);
    if (i >= 0) f.splice(i, 1); else f.push(type);
    U.lsSet(FAV_KEY, f);
  }

  UI.openDialog = function () {
    const layer = document.getElementById('popup-layer');
    U.clear(layer);
    const back = U.el('div', 'dialog-backdrop', layer);
    const dlg = U.el('div', 'dialog ind-dialog', back);
    /* ROUND 75 (BUG): same build-then-show discipline as the pine settings
       dialog (BUG-74-D) — the layer is revealed ONLY after the body is fully
       built and wired; the catch path restores a clean hidden layer so a
       broken build can never leave a live backdrop swallowing every click
       on the chart. The error still surfaces via the global handler. */
    const close = () => { layer.classList.add('hidden'); U.clear(layer); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    try {
      dlg.innerHTML = `<h3>Indicators<button class="mini-btn dlg-x" title="Close">${icon('x')}</button></h3>
        <div class="ind-search"><span class="ind-search-ic">${icon('search')}</span>
          <input type="text" id="ind-search-input" placeholder="Search indicator…" spellcheck="false" autocomplete="off"></div>
        <div class="ind-list"></div>`;
      const list = dlg.querySelector('.ind-list');
      document.addEventListener('keydown', onKey);
      dlg.querySelector('.dlg-x').addEventListener('click', close);
      back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });

      const renderList = (q) => {
        U.clear(list);
        const query = (q || '').trim().toLowerCase();
        /* ROUND84: MY SCRIPTS — every script stored in the Pine library
           (including the shipped samples) under its own section, TV-style.
           Click = add to the active chart, pencil = edit the code in the Pine
           Editor, trash = delete the script from the library.
           ROUND241 (TV parity): strategy() scripts ALSO get their own
           STRATEGIES section (every script whose declaration is strategy(),
           via PineScriptsStore.isStrategy — the same rule as the compiler's
           declMeta) plus a STRATEGY tag on each strategy row, so a strategy
           is never mistaken for a plain indicator. MY SCRIPTS below it keeps
           only the non-strategy scripts. */
        const scripts = PineScriptsStore.all().filter((s) =>
          !query || String(s.name || '').toLowerCase().indexOf(query) >= 0);
        const stratScripts = scripts.filter((s) => PineScriptsStore.isStrategy(s.source));
        const indScripts = scripts.filter((s) => !PineScriptsStore.isStrategy(s.source));
        if (stratScripts.length) {
          U.el('div', 'st-sec', list).textContent = 'STRATEGIES';
          for (const s of stratScripts) mkScriptItem(s, true);
        }
        if (indScripts.length) {
          U.el('div', 'st-sec', list).textContent = 'MY SCRIPTS';
          for (const s of indScripts) mkScriptItem(s, false);
        }
        const groups = {};
        for (const d of Indicators.all) {
          if (query && d.label.toLowerCase().indexOf(query) < 0 && d.type.indexOf(query) < 0) continue;
          (groups[d.group] = groups[d.group] || []).push(d);
        }
        const f = favs();
        if (!query && f.length) {
          U.el('div', 'st-sec', list).textContent = 'FAVORITES';
          for (const t of f) {
            const d = Indicators.def(t);
            if (d) mkItem(d, true);
          }
        }
        for (const g of Object.keys(groups)) {
          U.el('div', 'st-sec', list).textContent = g.toUpperCase();
          for (const d of groups[g]) mkItem(d, f.indexOf(d.type) >= 0);
        }
        function mkItem(d, faved) {
          const it = U.el('button', 'ind-item', list);
          const dotC = d.colors.line || d.colors.up || d.colors.conv || '#2962ff';
          it.innerHTML = `<i class="ind-dot"></i><span class="ind-item-name">${d.label}</span>` +
            `<span class="ind-item-meta">${d.pane === 'main' ? 'overlay' : 'pane'}</span>` +
            `<span class="pu-star${faved ? ' faved' : ''}" title="Favorite">${icon(faved ? 'star' : 'starOutline')}</span>`;
          it.querySelector('.ind-dot').style.background = dotC; // CSP: CSSOM not style="" attr
          it.querySelector('.pu-star').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFav(d.type);
            renderList(q);
          });
          it.addEventListener('click', () => {
            const pane = App.activePane;
            if (!pane) return;
            add(pane, d.type);
            UI.toast2(`Added ${d.label}`, 'ok');
          });
        }
        function mkScriptItem(s, isStrat) {
          const it = U.el('button', 'ind-item', list);
          /* overlay/pane meta straight from the declaration line — no compile */
          const overlay = /overlay\s*=\s*true/.test(String(s.source || ''));
          it.innerHTML = `<i class="ind-dot"></i><span class="ind-item-name">${U.esc(String(s.name || 'Untitled script'))}` +
            (isStrat ? ` <span class="pine-strat-tag">STRATEGY</span>` : '') + `</span>` +
            `<span class="ind-item-meta">${overlay ? 'overlay' : 'pane'}</span>` +
            `<span class="pu-star ms-edit" title="Edit code in Pine Editor">${icon('pencil')}</span>` +
            `<span class="pu-star ms-del" title="Delete script">${icon('trash')}</span>`;
          it.querySelector('.ind-dot').style.background = '#2962ff'; // CSP: CSSOM not style="" attr
          it.querySelector('.ms-edit').addEventListener('click', (e) => {
            e.stopPropagation();
            close(); // the editor takes over the screen — the dialog must not sit on top of it
            PineEditor.openScript(s.id);
          });
          it.querySelector('.ms-del').addEventListener('click', (e) => {
            e.stopPropagation();
            /* same semantics as the editor's own delete (round 74): instances
               already on charts keep rendering but can no longer be edited */
            if (!confirm('Delete "' + String(s.name || 'Untitled script') + '"? Instances already on charts keep working but can no longer be edited.')) return;
            PineScriptsStore.remove(s.id);
            UI.toast2('Deleted ' + String(s.name || 'script'), 'ok');
            renderList(q);
          });
          it.addEventListener('click', () => {
            const pane = App.activePane;
            if (!pane) return;
            Manager.addPine(pane, s.id); // ROUND84 delegation stub (pine-ui.add)
            UI.toast2(`Added ${String(s.name || 'script')}`, 'ok');
          });
        }
      };
      renderList('');
      const inp = dlg.querySelector('#ind-search-input');
      inp.addEventListener('input', U.debounce(() => renderList(inp.value), 120));
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      setTimeout(() => inp.focus(), 30);
    /* reveal only after a fully-built, fully-wired dialog (ROUND 75 BUG) */
    layer.classList.remove('hidden');
    } catch (e) {
      close();
      throw e;
    }
  };

  /* ---------- round 31: TV-parity settings dialog ----------
     Tabs like the reference platform: INPUTS (params) + STYLE (line width,
     line style + per-series colors, palette + free color picker). Footer:
     Remove (left) + Ok. Edits mutate the instance immediately; Ok rebuilds
     the series (same commit path the old single-pane dialog used). */
  function openSettingsDialog(pane, inst) {
    const def = Indicators.def(inst.type);
    if (!def) return;
    const layer = document.getElementById('popup-layer');
    U.clear(layer);
    const back = U.el('div', 'dialog-backdrop', layer);
    const dlg = U.el('div', 'dialog ind-settings', back);
    /* ROUND 75 (BUG): build-then-show — see UI.openDialog above; a throw
       mid-build must never leave a live backdrop over the chart. */
    const close = () => { layer.classList.add('hidden'); U.clear(layer); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    try {
      dlg.innerHTML = `<h3>${Indicators.title(inst)}<button class="mini-btn dlg-x" title="Close">${icon('x')}</button></h3>
        <div class="ist-tabs">
          <button class="ist-tab on" data-tab="inputs">Inputs</button>
          <button class="ist-tab" data-tab="style">Style</button>
        </div>
        <div class="ist-body"></div>
        <div class="dlg-actions">
          <button class="dlg-btn dlg-ghost ist-remove">Remove</button>
          <span class="dlg-spacer"></span>
          <button class="dlg-btn dlg-primary ist-ok">Ok</button>
        </div>`;
      const body = dlg.querySelector('.ist-body');
      document.addEventListener('keydown', onKey);
      dlg.querySelector('.dlg-x').addEventListener('click', close);
      back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });

      const hasLines = def.pane === 'main' || (def.colors && def.colors.line) || def.type === 'volume';

    const renderInputs = () => {
      U.clear(body);
      for (const p of def.params) {
        const lab = U.el('label', '', body);
        lab.innerHTML = `<span>${p.label}</span>`;
        const inp = U.el('input', '', lab);
        inp.type = 'number';
        inp.step = 'any';
        if (p.min != null) inp.min = p.min;
        if (p.max != null) inp.max = p.max;
        inp.value = Indicators.paramValue(p, inst);
        /* ROUND261: heal a persisted fractional/zero period on open, so the
           dialog agrees with what compute() already runs. */
        if (p.int) inst.params[p.key] = Number(inp.value);
        inp.addEventListener('keydown', (e) => e.stopPropagation());
        inp.addEventListener('change', () => {
          const v = parseFloat(inp.value);
          if (!isFinite(v)) return;
          inst.params[p.key] = v;
          if (p.int) {
            const n = Indicators.paramValue(p, inst);
            inst.params[p.key] = n;
            inp.value = String(n);
          }
        });
      }
      if (!def.params.length) U.el('div', 'ist-empty', body).textContent = 'This indicator has no inputs.';
    };

    const renderStyle = () => {
      U.clear(body);
      if (!inst.style || typeof inst.style !== 'object') inst.style = {};
      /* line width + line style (applies to the LINE plots of the indicator) */
      if (hasLines) {
        const labW = U.el('label', '', body);
        labW.innerHTML = '<span>Line width</span>';
        const selW = U.el('select', '', labW);
        for (const w of [1, 2, 3, 4]) {
          const o = U.el('option', '', selW);
          o.value = String(w); o.textContent = String(w);
        }
        selW.value = String(inst.style.width || 2);
        selW.addEventListener('change', () => { inst.style.width = parseInt(selW.value, 10) || 2; });

        const labS = U.el('label', '', body);
        labS.innerHTML = '<span>Line style</span>';
        const selS = U.el('select', '', labS);
        for (const [v, txt] of [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted'], ['largedashed', 'Large dashed']]) {
          const o = U.el('option', '', selS);
          o.value = v; o.textContent = txt;
        }
        selS.value = inst.style.lineStyle || 'solid';
        selS.addEventListener('change', () => { inst.style.lineStyle = selS.value; });
      }
      /* per-series colors: palette + free color picker (TV Style tab).
         The free picker doubles as the CURRENT-color swatch — it follows
         palette picks, and picking a custom color writes it straight back. */
      for (const key of Object.keys(def.colors)) {
        const lab = U.el('label', '', body);
        lab.innerHTML = `<span>${key} color</span>`;
        const w = U.el('div', 'ist-colors', lab);
        const free = U.el('input', 'ist-free', w);
        free.type = 'color';
        free.value = U.toHex(inst.colors[key] || def.colors[key]);
        free.title = 'Current color / custom color';
        for (const c of PALETTE) {
          const sw = U.el('button', 'ist-sw', w);
          sw.style.background = c;
          sw.addEventListener('click', () => {
            inst.colors[key] = c;
            try { free.value = U.toHex(c); } catch (e) {}
          });
        }
        free.addEventListener('input', () => { inst.colors[key] = free.value; });
      }
    };

    /* tabs */
    const renderTab = (name) => (name === 'style' ? renderStyle() : renderInputs());
    const tabs = dlg.querySelectorAll('.ist-tab');
    tabs.forEach((b) => b.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.toggle('on', x === b));
      renderTab(b.dataset.tab);
    }));
    renderTab('inputs');

    dlg.querySelector('.ist-ok').addEventListener('click', () => {
      close();
      destroySeries(pane, inst.id);
      Manager.persistPanes();
      recompute(pane);
    });
    dlg.querySelector('.ist-remove').addEventListener('click', () => { close(); remove(pane, inst.id); });
    /* reveal only after a fully-built, fully-wired dialog (ROUND 75 BUG) */
    layer.classList.remove('hidden');
    } catch (e) {
      close();
      throw e;
    }
  }

  UI.toast2 = function (msg, kind) {
    if (UI && UI.toast) UI.toast(msg, kind);
  };

  /* convenience for tests/debug */
  UI.add = add;
  UI.remove = remove;
  UI.recompute = recompute;
  /* round 31: release the per-pane render state when its chart is destroyed
     (layout switches) — dead pane objects no longer accumulate in RT */
  function dropPane(pane) { RT.delete(pane); }
  UI.dropPane = dropPane;
  /* ROUND288: the legend repaint is a public entry point too (Settings and
     tests both call it). It was exported as a bare named export, so the
     `IndicatorsUI` facade reachable from `window.__app` did not have it. */
  UI.updateIndicatorRows = updateIndicatorRows;
export { UI as IndicatorsUI, recompute, tickRecompute, updateIndicatorRows, dropPane };
