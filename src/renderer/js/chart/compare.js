/**
 * Compare (TradingView feature)
 *
 * Overlays up to 5 additional symbols on the ACTIVE chart, each normalised
 * into the main symbol's price space so relative performance is visually
 * identical to TV's percent-compare: value = mainFirstClose * cmpClose / cmpFirstClose.
 * The compare series re-aligns on every main-data reload (symbol/tf change).
 *
 * @module chart/compare
 */

import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { App } from '../../../core/state.js';
import { Manager } from './manager.js';
import { Toolbar } from './toolbar.js';
import { UI } from '../drawing/ui.js';

const PALETTE = ['#f7c948', '#e91e63', '#9c27b0', '#00bcd4', '#ff9800'];

  async function fetchBars(symbol, tf) {
    const count = App.COUNT_FOR[tf] || 1500;
    /* ROUND 35: on a REAL MT5 terminal the first request for a symbol that
       was just symbol_select()-ed into Market Watch can come back EMPTY
       while the terminal is still syncing its rates — the compare then
       silently died with "No data for X" (user report: "compare doesn't
       work"). Retry a couple of times with a short pause before giving up;
       the demo provider answers on the first call so this is a no-op there. */
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 500));
      try {
        const resp = await App.feed.bars(symbol, tf, count);
        const bars = resp.bars || [];
        if (bars.length) return bars;
      } catch (e) { lastErr = e; }
    }
    if (lastErr) throw lastErr;
    return [];
  }

  async function addCompare(pane, symbol) {
    if (!pane || !symbol) return;
    if (!pane._compares) pane._compares = [];
    if (pane._compares.some((c) => c.symbol === symbol)) { UI.toast(`${symbol} is already on the chart`); return; }
    if (String(symbol).toLowerCase() === String(pane.symbol).toLowerCase()) return;
    try {
      const tf = pane.tf;
      const bars = await fetchBars(symbol, tf);
      if (!bars.length) { UI.toast(`No data for ${symbol}`); return; }
      const series = pane.chart.addLineSeries({
        color: PALETTE[pane._compares.length % PALETTE.length],
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        /* report the pane's manual price-zoom window too — otherwise the
           compare data would UNION with it and cap the deep zoom (round 18) */
        autoscaleInfoProvider: (Manager.priceZoomProvider)
          ? Manager.priceZoomProvider(pane) : undefined,
      });
      const c = { symbol, series, color: PALETTE[pane._compares.length % PALETTE.length], tf };
      pane._compares.push(c);
      await alignCompare(pane, c, bars);
      buildLegend(pane);
    } catch (e) {
      UI.toast('Compare failed: ' + (e.message || e));
    }
  }

  /* (re)compute the normalised line for one compare series against the pane bars */
  async function alignCompare(pane, c, preFetched) {
    let bars = preFetched;
    if (!bars) {
      try { bars = await fetchBars(c.symbol, pane.tf); } catch (e) { bars = []; }
      if (!bars.length) { removeCompare(pane, c.symbol, true); return; }
    }
    c.tf = pane.tf;
    const map = new Map();
    for (const b of bars) map.set(b.time, b.close);
    const main = pane.bars;
    if (!main.length) return;
    let firstCmp = null;
    for (const b of main) {
      const v = map.get(b.time);
      if (v != null && firstCmp == null) firstCmp = v;
    }
    if (!firstCmp) { removeCompare(pane, c.symbol, true); return; }
    const mainFirst = main[0].close;
    const scale = mainFirst / firstCmp;
    const data = [];
    for (const b of main) {
      const v = map.get(b.time);
      if (v != null) data.push({ time: b.time, value: v * scale });
    }
    if (data.length < 2) { removeCompare(pane, c.symbol, true); return; }
    try { c.series.setData(data); } catch (e) {}
  }

  function removeCompare(pane, symbol, silent) {
    if (!pane || !pane._compares) return;
    const i = pane._compares.findIndex((c) => c.symbol === symbol);
    if (i < 0) return;
    const c = pane._compares[i];
    try { pane.chart.removeSeries(c.series); } catch (e) {}
    pane._compares.splice(i, 1);
    buildLegend(pane);
    if (!silent) UI.toast(`${symbol} removed`, 'ok');
  }

  /* legend chips inside the pane legend (TV style) — the X is clickable
     (round 18: pointer-events re-enabled for the chips in CSS) */
  function buildLegend(pane) {
    const host = pane.els && pane.els.lgSym ? pane.els.lgSym.parentElement : null;
    if (!host) return;
    let box = pane._cmpLegend;
    if (!pane._compares || !pane._compares.length) {
      if (box) box.remove();
      pane._cmpLegend = null;
      return;
    }
    if (!box) {
      box = U.el('span', 'cmp-legend', host);
      pane._cmpLegend = box;
    }
    U.clear(box);
    for (const c of pane._compares) {
      const chip = U.el('span', 'cmp-chip', box);
      const dot = U.el('i', '', chip);
      chip.appendChild(document.createTextNode(c.symbol));
      dot.style.background = c.color; // CSP: CSSOM not style="" attr
      const x = U.el('button', 'cmp-x', chip);
      x.innerHTML = icon('x');
      x.title = 'Remove ' + c.symbol;
      x.addEventListener('click', (e) => { e.stopPropagation(); removeCompare(pane, c.symbol); });
    }
  }

  function openMenu(x, y) {
    Toolbar.popupAt(x, y, (p) => {
      p.classList.add('cmp-popup');
      U.el('div', 'pu-title', p).textContent = 'COMPARE SYMBOL';
      const pane = App.activePane;
      /* existing compares */
      const has = pane && pane._compares && pane._compares.length;
      if (has) {
        for (const c of pane._compares) {
          const it = U.el('button', 'pu-item', p);
          const ic = U.el('span', 'ic', it);
          ic.textContent = '■';
          const nm = U.el('span', '', it);
          nm.textContent = c.symbol;
          ic.style.color = c.color; // CSP: CSSOM not style="" attr
          const tr = U.el('button', 'pu-star pu-trash', it);
          tr.innerHTML = icon('trash');
          tr.title = 'Remove';
          tr.addEventListener('mousedown', (e) => e.stopPropagation());
          tr.addEventListener('click', (e) => {
            e.stopPropagation();
            removeCompare(App.activePane, c.symbol);
            Toolbar.closePopup();
          });
        }
        U.el('div', 'pu-sep', p);
      }
      /* search */
      const inp = U.el('input', 'cmp-search', p);
      inp.placeholder = 'Search symbol…';
      inp.spellcheck = false;
      const res = U.el('div', 'cmp-results', p);
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') Toolbar.closePopup();
        if (e.key === 'Enter') {
          const first = res.querySelector('.pu-item');
          if (first) first.click();
        }
      });
      inp.addEventListener('input', async () => {
        const q = inp.value.trim().toUpperCase();
        U.clear(res);
        if (q.length < 1) return;
        try {
          /* ROUND36: search() resolves {symbols, total} */
          const { symbols: hits = [] } = await App.feed.search(q);
          for (const s of hits.slice(0, 8)) {
            if (pane && pane._compares && pane._compares.some((c) => c.symbol === s)) continue;
            const it = U.el('button', 'pu-item', res);
            const ic = U.el('span', 'ic', it);
            ic.innerHTML = icon('search');
            const nm = U.el('span', '', it);
            nm.textContent = s;
            it.addEventListener('click', () => {
              Toolbar.closePopup();
              addCompare(App.activePane, s);
            });
          }
        } catch (e) {}
      });
      setTimeout(() => inp.focus(), 40);
    });
  }

  const Compare = {
    init() {
      const btn = document.getElementById('compare-btn');
      if (!btn) return;
      btn.innerHTML = icon('compare');
      btn.addEventListener('click', () => {
        const r = btn.getBoundingClientRect();
        openMenu(r.left, r.bottom + 4);
      });
    },
    add: addCompare,
    remove: removeCompare,
  };

  /* auto re-align after every main-data reload (symbol/tf change) */
  if (Manager) {
    const prevLoad = Manager.loadBars;
    Manager.loadBars = async function (pane) {
      await prevLoad(pane);
      if (pane && pane._compares && pane._compares.length) {
        for (const c of pane._compares) { try { await alignCompare(pane, c); } catch (e) {} }
      }
    };
  }

export { Compare };
