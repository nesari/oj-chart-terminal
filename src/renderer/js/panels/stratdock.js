/**
 * Strategy bottom dock (round 179, user request): the tester home is a wide
 * bottom panel instead of the narrow right rail — Overview tab (key stats +
 * performance + breakdown) and List-of-trades tab share one sticky toolbar
 * (testing period + capital). Expand (fullscreen overlay), collapse,
 * top-edge resize and visibility persist (mt5_strat_*). Content sections are
 * the same #tst-* nodes panels/tester.js fills; this module only shells,
 * tabs and toolbars them (trade/dock.js pattern).
 *
 * @module panels/stratdock
 */

import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { Manager } from '../chart/manager.js';
import { PineUI } from '../chart/pine-ui.js';
import { Tester } from './tester.js';

const K = { vis: 'mt5_strat_vis', h: 'mt5_strat_h', tab: 'mt5_strat_tab', range: 'mt5_strat_range', marks: 'mt5_strat_marks' };
const H_DEF = 320, H_MIN = 160;

const StratDock = {
  els: {},
  _tab: 'overview',
  _collapsed: false,
  _full: false,
};

function root() { return StratDock.els.root; }

function currentPane() {
  const c = (Tester.currentSel && Tester.currentSel()) || null;
  return c ? c.pane : null;
}

function lastBarTime(pane) {
  const b = pane && pane.bars;
  return (b && b.length && b[b.length - 1].time != null) ? b[b.length - 1].time : null;
}

/* ---------- state ---------- */

function applyState() {
  const r = root();
  if (!r) return;
  const cap = Math.max(H_MIN, Math.min(Math.round(window.innerHeight * 0.7), Number(U.lsGet(K.h, H_DEF)) || H_DEF));
  r.classList.toggle('sd-collapsed', StratDock._collapsed);
  r.classList.toggle('sd-full', StratDock._full);
  r.style.height = (StratDock._collapsed || StratDock._full) ? '' : cap + 'px';
  const body = StratDock.els.body;
  if (body) body.style.display = StratDock._collapsed ? 'none' : '';
  if (StratDock.els.collapse) {
    StratDock.els.collapse.textContent = StratDock._collapsed ? '▲' : '▼';
    StratDock.els.collapse.title = StratDock._collapsed ? 'Expand' : 'Collapse';
  }
  if (StratDock.els.expand) {
    StratDock.els.expand.innerHTML = icon(StratDock._full ? 'restore' : 'maximize');
    StratDock.els.expand.title = StratDock._full ? 'Restore' : 'Expand to fullscreen';
  }
  syncToggle();
}

function syncToggle() {
  const r = root();
  const open = !!(r && !r.classList.contains('hidden'));
  if (StratDock.els.toggle) StratDock.els.toggle.classList.toggle('on', open);
  const rail = document.querySelector('#right-tabs .rt-btn[data-tab="tester"]');
  if (rail) rail.classList.toggle('active', open);
}

StratDock.show = function (force) {
  const r = root();
  if (!r) return;
  r.classList.remove('hidden');
  U.lsSet(K.vis, 'open');
  if (force) StratDock._collapsed = false;
  applyState();
  try { Tester.refresh(); } catch (e) {}
  /* re-apply the persisted testing period on top of the fresh instance */
  try {
    const rv = StratDock.els.range ? StratDock.els.range.value : 'available';
    if (rv === 'custom') customRange();
    else if (rv !== 'available') presetRange();
  } catch (e) {}
  fillCapital();
  syncToggle();
};

StratDock.close = function () {
  const r = root();
  if (!r) return;
  r.classList.add('hidden');
  U.lsSet(K.vis, 'hidden');
  syncToggle();
};

StratDock.toggle = function () {
  const r = root();
  if (!r) return;
  if (r.classList.contains('hidden')) StratDock.show();
  else StratDock.close();
};

/* ---------- tabs ---------- */

function setTab(t) {
  StratDock._tab = t === 'trades' ? 'trades' : 'overview';
  U.lsSet(K.tab, StratDock._tab);
  const e = StratDock.els;
  document.querySelectorAll('#sd-tabs .sd-tab').forEach((b) => {
    b.classList.toggle('on', b.dataset.sdtab === StratDock._tab);
  });
  if (e.overview) e.overview.classList.toggle('hidden', StratDock._tab !== 'overview');
  if (e.trades) e.trades.classList.toggle('hidden', StratDock._tab !== 'trades');
}

/* ---------- sticky toolbar: testing period + capital ---------- */

function presetRange() {
  const v = StratDock.els.range ? StratDock.els.range.value : 'available';
  const pane = currentPane();
  const to = lastBarTime(pane);
  const days = { d7: 7, d30: 30, d90: 90, d365: 365 }[v];
  if (v === 'custom') return 'custom';
  /* Entire history needs unloaded older bars first (round 180 backfill);
     until then it equals the available loaded range. */
  if (v === 'available' || v === 'history' || !days || to == null) {
    Tester.clearRange();
    return v;
  }
  Tester.setRange(to - days * 86400, to);
  return v;
}

function customRange() {
  const f = StratDock.els.from ? StratDock.els.from.value : '';
  const t = StratDock.els.to ? StratDock.els.to.value : '';
  const fs = f ? Math.floor(Date.parse(f + 'T00:00:00Z') / 1000) : null;
  let ts = t ? Math.floor(Date.parse(t + 'T00:00:00Z') / 1000) + 86399 : null;
  if ((fs == null || !isFinite(fs)) && (ts == null || !isFinite(ts))) { Tester.clearRange(); return; }
  Tester.setRange(isFinite(fs) ? fs : null, isFinite(ts) ? ts : null);
}

function fillCapital() {
  try {
    const sel = Tester.currentSel && Tester.currentSel();
    if (!sel || !StratDock.els.cap) return;
    const rep = PineUI.strategyReport(sel.pane, sel.instId);
    if (!rep) return;
    StratDock.els.cap.value = rep.initialCapital != null ? String(rep.initialCapital) : '';
    const cur = StratDock.els.cur;
    if (cur && rep.currency && [...cur.options].some((o) => o.value === rep.currency)) cur.value = rep.currency;
  } catch (e) {}
}

async function applyToolbar() {
  const e = StratDock.els;
  if (e.apply) { e.apply.disabled = true; e.apply.textContent = 'Loading…'; }
  try {
    if (e.range) {
      U.lsSet(K.range, e.range.value + '|' + (e.from ? e.from.value : '') + '|' + (e.to ? e.to.value : ''));
      if (e.custom) e.custom.classList.toggle('hidden', e.range.value !== 'custom');
      if (e.range.value === 'custom') customRange();
      else presetRange();
    }
    /* ROUND184: the requested start may sit left of the loaded head —
       page older history in first (provider-dry or the chart cap ends the
       walk), then the strategy re-runs over the deeper history. */
    const sel0 = Tester.currentSel && Tester.currentSel();
    const pane0 = sel0 ? sel0.pane : null;
    const rg = Tester.getRange && Tester.getRange();
    if (pane0 && rg && rg.from != null && pane0.bars && pane0.bars.length > 10 && pane0.bars[0].time > rg.from) {
      /* loadOlder no-ops on cap/dry/loading — the loop just bounds pages. */
      for (let k = 0; k < 12 && pane0.bars.length > 10 && pane0.bars[0].time > rg.from; k++) {
        try { await Manager.loadOlder(pane0); } catch (err) { break; }
        if (pane0._olderDone) break;
      }
    }
    const sel = Tester.currentSel && Tester.currentSel();
    const cap = e.cap ? parseFloat(e.cap.value) : NaN;
    if (sel && isFinite(cap) && cap > 0) {
      const inst = ((sel.pane && sel.pane.pineScripts) || []).find((x) => String(x.id) === String(sel.instId));
      if (inst) {
        inst.strategyProps = Object.assign({}, inst.strategyProps,
          { initial_capital: cap, currency: e.cur ? e.cur.value : 'USD' });
        try { await PineUI.rebuild(sel.pane, inst); } catch (err) {}
      }
    }
    /* a deeper history rebuilds the runtime (fresh broker) — refresh the
       report on top of whatever is loaded now, partial or full. */
    try { Tester.refresh(); } catch (err) {}
    fillCapital();
  } finally {
    if (e.apply) { e.apply.disabled = false; e.apply.textContent = 'Apply'; }
  }
}

/* ---------- boot ---------- */

StratDock.init = function () {
  if (StratDock.els.root) return;
  const r = document.getElementById('strat-dock');
  if (!r) return;
  const g = (id) => document.getElementById(id);
  StratDock.els = {
    root: r, body: g('sd-body'), overview: g('sd-overview'), trades: g('sd-trades'),
    range: g('sd-range'), custom: g('sd-custom'), from: g('sd-from'), to: g('sd-to'),
    cap: g('sd-cap'), cur: g('sd-cur'), apply: g('sd-apply'), marks: g('sd-marks'),
    refresh: g('sd-refresh'), expand: g('sd-expand'), collapse: g('sd-collapse'), close: g('sd-close'),
    resize: g('sd-resize'), toggle: null,
  };
  const e = StratDock.els;
  if (e.refresh) { e.refresh.innerHTML = icon('sync'); e.refresh.addEventListener('click', () => Tester.refresh()); }
  if (e.close) {
    e.close.innerHTML = icon('x');
    e.close.addEventListener('click', () => StratDock.close());
  }
  if (e.collapse) e.collapse.addEventListener('click', () => { StratDock._collapsed = !StratDock._collapsed; applyState(); });
  if (e.expand) e.expand.addEventListener('click', () => { StratDock._full = !StratDock._full; applyState(); });
  document.querySelectorAll('#sd-tabs .sd-tab').forEach((b) => {
    b.addEventListener('click', () => setTab(b.dataset.sdtab));
  });
  if (e.range) {
    e.range.addEventListener('change', () => {
      if (e.custom) e.custom.classList.toggle('hidden', e.range.value !== 'custom');
      if (e.range.value !== 'custom') { presetRange(); U.lsSet(K.range, e.range.value + '||'); }
    });
  }
  if (e.apply) e.apply.addEventListener('click', () => applyToolbar());
  /* ROUND184: chart trade-marker visibility (TV flags on/off). */
  try {
    const on = U.lsGet(K.marks, '1') !== '0';
    if (e.marks) e.marks.checked = on;
    if (PineUI.setStratMarks) PineUI.setStratMarks(on);
  } catch (err) {}
  if (e.marks) e.marks.addEventListener('change', () => {
    const on = !!e.marks.checked;
    try { U.lsSet(K.marks, on ? '1' : '0'); } catch (err) {}
    try { if (PineUI.setStratMarks) PineUI.setStratMarks(on); } catch (err) {}
    try {
      const sel = Tester.currentSel && Tester.currentSel();
      const panes = (sel && sel.pane) ? [sel.pane] : [];
      for (const pn of panes) if (Manager.applyPaneMarkers) Manager.applyPaneMarkers(pn);
    } catch (err) {}
  });
  /* top-edge resize (trade-dock pattern: persist the ROOT height) */
  if (e.resize) {
    e.resize.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const startY = ev.clientY, startH = r.getBoundingClientRect().height;
      const move = (m) => {
        r.style.height = Math.max(H_MIN, Math.min(Math.round(window.innerHeight * 0.7), startH + (startY - m.clientY))) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        document.body.style.cursor = '';
        U.lsSet(K.h, Math.round(r.getBoundingClientRect().height));
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
      document.body.style.cursor = 'row-resize';
    });
    e.resize.addEventListener('dblclick', () => { U.lsSet(K.h, H_DEF); applyState(); });
  }
  /* bottom-toolbar toggle (always-visible reopen, trade-dock pattern) */
  const bar = document.getElementById('bottom-toolbar');
  if (bar) {
    const b = document.createElement('button');
    b.className = 'bt-btn';
    b.id = 'std-toggle-btn';
    b.title = 'Strategy Tester — bottom dock';
    b.innerHTML = icon('indicators');
    b.addEventListener('click', () => StratDock.toggle());
    const spacer = bar.querySelector('.flex-spacer');
    if (spacer && spacer.parentNode === bar) bar.insertBefore(b, spacer.nextSibling);
    else bar.appendChild(b);
    e.toggle = b;
  }
  window.addEventListener('resize', () => {
    if (!r.classList.contains('hidden')) applyState();
  });
  /* restore persisted state (visibility stays shut until asked) */
  StratDock._tab = U.lsGet(K.tab, 'overview') === 'trades' ? 'trades' : 'overview';
  setTab(StratDock._tab);
  try {
    const saved = String(U.lsGet(K.range, 'available|') || 'available|').split('|');
    if (e.range && saved[0]) e.range.value = saved[0];
    if (e.from && saved[1]) e.from.value = saved[1];
    if (e.to && saved[2]) e.to.value = saved[2];
    if (e.custom) e.custom.classList.toggle('hidden', (e.range ? e.range.value : '') !== 'custom');
  } catch (err) {}
  if (U.lsGet(K.vis, 'hidden') !== 'hidden') StratDock.show(true);
  else syncToggle();
};

export { StratDock };
