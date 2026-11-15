/**
 * Indicators UI (ROUND299) — Pine-backed built-ins.
 *
 * Before ROUND299 this module bound a HAND-WRITTEN JavaScript indicator
 * library to lightweight-charts: it created line/histogram series, painted
 * band fills with a custom canvas primitive, and kept its own colour rules.
 * All of that duplicated the Pine renderer and drifted from it (the R298
 * audit found band fills that never painted and histograms coloured by the
 * wrong rule).
 *
 * Every built-in indicator is now a Pine script, so this module no longer
 * draws anything. It is an ADAPTER that keeps the long-standing public API
 * (`IndicatorsUI.add(pane, 'rsi')`, `remove`, `recompute`, the legend rows,
 * the dialog) working by creating Pine instances through PineUI:
 *
 *   pane.indicators  legacy registry records (id/type/params/colors/visible)
 *   -> inst          Pine instance {id, scriptId, inputs, visible, frac}
 *   -> PineUI.add    the real engine instance, persisted with the pane
 *
 * The legacy record stays on the pane as the source of truth for the public
 * API and old layouts; the Pine instance mirrors it. `syncPine` reconciles the
 * two, and `migrateLegacy` converts a saved layout on load.
 *
 * @module chart/indicators-ui
 */

import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { App } from '../../../core/state.js';
import { Manager } from './manager.js';
import { Indicators } from '../../../core/indicators.js';
import { BUILTIN_BY_TYPE, BUILTIN_INDICATORS } from '../../../core/pine/builtins-catalog.js';
import { PineScriptsStore } from '../panels/pine-scripts-store.js';
import { PineEditor } from '../panels/pine-editor.js';
import { compile } from '../../../core/pine/compile.js';

const UI = {};
const FAV_KEY = 'mt5_ind_favs';

/* ROUND299: legacy record id -> Pine instance id. The Pine instance keeps its
 * own id (PineUI allocates it) because the renderer, persistence and adapter
 * all key on it; this map is only for reconciling the two registries. */
const PINE_OF = new WeakMap(); // pane -> Map(legacyId -> pineInstId)

function pineMap(pane) {
  let m = PINE_OF.get(pane);
  if (!m) { m = new Map(); PINE_OF.set(pane, m); }
  return m;
}

/* ---------- legacy record <-> Pine instance identity ----------
   A legacy record is { id, type, params, colors, style, frac, visible }.
   Its Pine twin is { id, scriptId, inputs, visible, frac }. `syncPine` keeps
   the pair in step: it creates what is missing (including a migration from
   old params), removes orphans, and pushes param changes into the engine. */
function pineIdOf(pane, rec) { return pineMap(pane).get(rec.id) || ''; }

function pineInstOf(pane, rec) {
  const pineId = pineIdOf(pane, rec);
  if (!pineId) return null;
  return (pane.pineScripts || []).find((i) => i.id === pineId) || null;
}

/** the compiled input definitions for a builtin type (cached by compile) */
function inputDefsFor(type) {
  const def = BUILTIN_BY_TYPE.get(type);
  if (!def) return [];
  try {
    const c = compile(def.source);
    if (!c.ok) return [];
    const ci = c.collectInputs({ tfSec: 60, symbol: 'T', mintick: 0.00001 });
    return ci.ok ? (ci.inputs || []) : [];
  } catch (e) { return []; }
}

/**
 * Bring the Pine instances in line with the legacy registry for one pane.
 * Called from recompute() — the single funnel every add/remove/settings path
 * already goes through.
 */
function syncPine(pane) {
  if (!pane) return;
  const recs = pane.indicators || [];
  pane.pineScripts = pane.pineScripts || [];
  const live = new Map(); // legacyId -> pine inst
  const validIds = new Set();

  for (const rec of recs) {
    const scriptId = Indicators.scriptId(rec.type);
    if (!scriptId) continue; // unknown type: leave it invisible, never crash
    validIds.add(rec.id);
    let inst = pineInstOf(pane, rec);
    if (!inst) {
      /* Recover an EXISTING Pine twin before creating one. The id map is
         in-memory only, so any path that rebuilds the pane (layout restore,
         tab snapshot) could otherwise attach a SECOND runtime for the same
         indicator — two identical lines drawn on top of each other. Matching
         on the builtin scriptId among instances no legacy record claims is
         safe because a builtin type can only be added once per pane through
         the registry (a user may add it twice, in which case the first
         unclaimed one is correct). */
      const claimed = new Set(pineMap(pane).values());
      const orphan = (pane.pineScripts || []).find((i) =>
        i && i.scriptId === scriptId && !claimed.has(i.id));
      if (orphan) {
        inst = orphan;
        pineMap(pane).set(rec.id, inst.id);
      }
    }
    if (!inst) {
      /* create from the legacy record */
      const migrated = Indicators.migrate(rec, inputDefsFor(rec.type));
      inst = {
        id: Date.now() + Math.floor(Math.random() * 999),
        scriptId,
        inputs: (migrated && migrated.inputs) || {},
        visible: rec.visible !== false,
        ...(rec.frac > 0 ? { frac: rec.frac } : {}),
      };
      pane.pineScripts.push(inst);
      pineMap(pane).set(rec.id, inst.id);
      /* the engine needs a rebuild for a brand-new instance */
      scheduleRebuild(pane, inst);
    } else {
      /* keep the mirror in step without a rebuild: inputs are read by the
         runtime each full pass, visibility is a renderer toggle. */
      inst.visible = rec.visible !== false;
      if (rec.frac > 0) inst.frac = rec.frac;
      const inputs = legacyInputs(rec);
      if (inputs && JSON.stringify(inputs) !== JSON.stringify(inst.inputs)) {
        inst.inputs = inputs;
        scheduleRebuild(pane, inst);
      }
    }
    live.set(rec.id, inst);
  }

  /* drop Pine instances whose legacy record is gone */
  for (const [legacyId, pineId] of Array.from(pineMap(pane))) {
    if (validIds.has(legacyId)) continue;
    pane.pineScripts = pane.pineScripts.filter((i) => i.id !== pineId);
    pineMap(pane).delete(legacyId);
    try { if (PineUI) PineUI.remove(pane, pineId); } catch (e) {}
  }
}

/* ROUND299: parameter edits arrive as legacy `params` (the dialog keeps the
   same control shape), so translate them through the catalog's title map. */
function legacyInputs(rec) {
  const def = BUILTIN_BY_TYPE.get(rec.type);
  if (!def) return null;
  const defs = inputDefsFor(rec.type);
  const byTitle = new Map();
  for (const d of defs) if (d.title) byTitle.set(d.title, d);
  const out = {};
  for (const key of Object.keys(def.params || {})) {
    const v = rec.params && rec.params[key];
    if (v == null) continue;
    const d = byTitle.get(def.params[key]);
    if (d) out[d.id] = v;
  }
  return out;
}

/* Rebuilds are async and the engine serialises them per instance; firing one
   per keystroke in the settings dialog would queue a pass per digit. Coalesce
   to one per pane on the next microtask-ish turn. */
const PENDING = new WeakMap();
function scheduleRebuild(pane, inst) {
  if (!inst) return;
  let set = PENDING.get(pane);
  if (!set) { set = new Set(); PENDING.set(pane, set); }
  set.add(inst);
  if (set._scheduled) return;
  set._scheduled = true;
  Promise.resolve().then(() => {
    set._scheduled = false;
    const list = Array.from(set);
    set.clear();
    for (const i of list) {
      try { if (PineUI) PineUI.rebuild(pane, i); } catch (e) {}
    }
  });
}

/* PineUI is reached lazily: pine-ui.js <-> indicators-ui.js form a module
   cycle, and touching the binding at evaluation time is a TDZ ReferenceError
   (the same trap ROUND184 documented for Manager.strategyMarkers). */
let PineUI = null;
function wirePine(ui) { if (ui) PineUI = ui; }

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function recompute(pane) {
  if (!pane || !pane.chart) return;
  syncPine(pane);
  renderRows(pane);
}

/* The old per-tick recompute painted series data. The engine owns ticks now
   (PineUI.onTickPane does the incremental last-bar update), so this only has
   to keep the legend values fresh. */
function tickRecompute(pane) {
  if (!pane || !pane.chart) return;
  updateRowValues(pane, null);
}

function add(pane, type) {
  if (!pane || !Indicators.def(type)) return null;
  pane.indicators = pane.indicators || [];
  const rec = {
    id: Date.now() + Math.floor(Math.random() * 999),
    type, params: {}, colors: {}, visible: true,
  };
  pane.indicators.push(rec);
  Manager.persistPanes();
  recompute(pane);
  return rec;
}

function remove(pane, id) {
  const rec = (pane.indicators || []).find((i) => i.id === id);
  pane.indicators = (pane.indicators || []).filter((i) => i.id !== id);
  if (rec) {
    const pineId = pineMap(pane).get(rec.id);
    if (pineId) {
      pineMap(pane).delete(rec.id);
      try { if (PineUI) PineUI.remove(pane, pineId); } catch (e) {}
    }
  }
  Manager.persistPanes();
  recompute(pane);
}

/* ---------- legend rows ----------
   One row per legacy record, in the pane legend or in the sub-pane header
   that the Pine adapter created for a non-overlay script. Values come from
   the RUNTIME's plot arrays, which is what the chart actually paints. */
function ensureRows(pane) {
  if (!pane._indRows) pane._indRows = U.el('div', 'ind-rows', pane.legend);
  return pane._indRows;
}

function mkRow(pane, rec, def, box) {
  const row = U.el('div', 'ind-row' + (rec.visible === false ? ' hidden-inst' : ''), box);
  row.dataset.iid = String(rec.id);
  const dotC = (def && def.colors && def.colors.line) || '#2962ff';
  const title = U.el('span', 'ind-title', row);
  title.innerHTML = `<i class="ind-dot"></i>${U.esc(Indicators.title(rec))}`;
  title.querySelector('.ind-dot').style.background = dotC; // CSP: CSSOM not style="" attr
  const vals = U.el('span', 'ind-vals', row);
  const btns = U.el('span', 'ind-btns', row);
  const eye = U.el('button', 'ind-btn', btns);
  eye.innerHTML = icon(rec.visible === false ? 'eyeoff' : 'eye');
  eye.title = 'Show / Hide';
  eye.addEventListener('click', (e) => {
    e.stopPropagation();
    rec.visible = rec.visible === false;
    const inst = pineInstOf(pane, rec);
    if (inst) { try { if (PineUI) PineUI.toggleVisible(pane, inst.id); } catch (er) {} }
    U.lsSet('mt5_ind_touch', Date.now());
    Manager.persistPanes();
    recompute(pane);
  });
  const gear = U.el('button', 'ind-btn', btns);
  gear.innerHTML = icon('gear');
  gear.title = 'Settings';
  gear.addEventListener('click', (e) => { e.stopPropagation(); openSettingsDialog(pane, rec); });
  const del = U.el('button', 'ind-btn ind-del', btns);
  del.innerHTML = icon('x');
  del.title = 'Remove';
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    remove(pane, rec.id);
  });
  row.addEventListener('click', () => openSettingsDialog(pane, rec));
}

function renderRows(pane) {
  const box = ensureRows(pane);
  U.clear(box);
  /* sub-pane headers are owned by the Pine adapter; clear the ones we made */
  if (pane._subs) for (const [, sub] of pane._subs) if (sub._rows) U.clear(sub._rows);
  for (const rec of pane.indicators || []) {
    const def = Indicators.def(rec.type);
    if (!def) continue;
    let target = box;
    if (def.pane === 'separate') {
      /* the Pine adapter's sub-pane for this instance, when it exists */
      const inst = pineInstOf(pane, rec);
      const sub = (inst && pane._subs) ? pane._subs.get(inst.id) : null;
      if (sub) {
        if (!sub._rows) sub._rows = U.el('div', 'ind-rows', sub.legend);
        target = sub._rows;
      }
    }
    mkRow(pane, rec, def, target);
  }
  updateRowValues(pane, null);
}

function updateRowValues(pane, hoverTime) {
  const bars = pane.bars || [];
  let idx = bars.length - 1;
  if (hoverTime != null && pane.barTimes && pane.barTimes.length) idx = U.nearestIndex(pane.barTimes, hoverTime);
  const S = (window.__app && window.__app.Settings && window.__app.Settings.conf) || {};
  const showVals = S.stIndValues !== false && S.indFin !== 'hidden';
  for (const rec of pane.indicators || []) {
    const row = pane.root.querySelector(`.ind-row[data-iid="${rec.id}"]`);
    if (!row) continue;
    if (S.stIndTitles === false) { row.style.display = 'none'; continue; }
    row.style.display = '';
    const valsEl = row.querySelector('.ind-vals');
    if (!valsEl) continue;
    const inst = pineInstOf(pane, rec);
    const st = (inst && PineUI && PineUI.debug) ? PineUI.debug(pane).find((s) => s.rt && s.adapter && s.adapter.inst && s.adapter.inst.id === inst.id) : null;
    if (!showVals || !st || !st.rt || rec.visible === false) { valsEl.textContent = ''; continue; }
    const out = st.rt.viewOut || st.rt.out;
    if (!out) { valsEl.textContent = ''; continue; }
    const parts = [];
    const colorsForVals = [];
    const d = pane.digits != null ? Math.min(8, Math.max(2, pane.digits + 2)) : 3;
    for (const key of out.plotsOrder || []) {
      const p = out.plots.get(key);
      if (!p || p.display === 'none') continue;
      const v = p.values ? p.values[idx] : null;
      if (v == null || !isFinite(v)) continue;
      const c = p.colors && p.colors[idx];
      colorsForVals.push((c && c.css) ? c.css() : '#2962ff');
      parts.push(`<b>${v.toFixed(d)}</b>`);
      /* TV shows one pill per plot; stop at 4 so a busy script cannot wrap the
         legend onto a second line */
      if (parts.length >= 4) break;
    }
    valsEl.innerHTML = parts.join(' ');
    // round 81 CSP hardening: per-value colors via CSSOM, not style="" attrs
    const bEls = valsEl.querySelectorAll('b');
    for (let i = 0; i < bEls.length; i++) if (colorsForVals[i]) bEls[i].style.color = colorsForVals[i];
  }
}

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
      /* MY SCRIPTS — the user's own Pine library. Built-in indicators are NOT
         listed here: they are app-provided scripts (ROUND299), shown in the
         grouped sections below like any other built-in. */
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
      for (const d of BUILTIN_INDICATORS) {
        if (query && d.label.toLowerCase().indexOf(query) < 0 && d.type.indexOf(query) < 0) continue;
        (groups[d.group] = groups[d.group] || []).push(d);
      }
      const f = favs();
      if (!query && f.length) {
        U.el('div', 'st-sec', list).textContent = 'FAVORITES';
        for (const t of f) {
          const d = BUILTIN_BY_TYPE.get(t);
          if (d) mkItem(d, true);
        }
      }
      for (const g of Object.keys(groups)) {
        U.el('div', 'st-sec', list).textContent = g.toUpperCase();
        for (const d of groups[g]) mkItem(d, f.indexOf(d.type) >= 0);
      }

      function mkItem(d, faved) {
        const it = U.el('button', 'ind-item', list);
        it.innerHTML = `<i class="ind-dot"></i><span class="ind-item-name">${U.esc(d.label)}</span>` +
          `<span class="ind-item-meta">${d.overlay ? 'overlay' : 'pane'}</span>` +
          `<span class="pu-star${faved ? ' faved' : ''}" title="Favorite">${icon(faved ? 'star' : 'starOutline')}</span>`;
        it.querySelector('.ind-dot').style.background = '#2962ff'; // CSP: CSSOM not style="" attr
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
        const overlay = /overlay\s*=\s*true/.test(String(s.source || ''));
        it.innerHTML = `<i class="ind-dot"></i><span class="ind-item-name">${U.esc(String(s.name || 'Untitled script'))}` +
          (isStrat ? ` <span class="pine-strat-tag">STRATEGY</span>` : '') + `</span>` +
          `<span class="ind-item-meta">${overlay ? 'overlay' : 'pane'}</span>` +
          `<span class="pu-star ms-edit" title="Edit code in Pine Editor">${icon('pencil')}</span>` +
          `<span class="pu-star ms-del" title="Delete script">${icon('trash')}</span>`;
        it.querySelector('.ind-dot').style.background = '#2962ff'; // CSP: CSSOM not style="" attr
        it.querySelector('.ms-edit').addEventListener('click', (e) => {
          e.stopPropagation();
          close();
          PineEditor.openScript(s.id);
        });
        it.querySelector('.ms-del').addEventListener('click', (e) => {
          e.stopPropagation();
          if (!confirm('Delete "' + String(s.name || 'Untitled script') + '"? Instances already on charts keep working but can no longer be edited.')) return;
          PineScriptsStore.remove(s.id);
          UI.toast2('Deleted ' + String(s.name || 'script'), 'ok');
          renderList(q);
        });
        it.addEventListener('click', () => {
          const pane = App.activePane;
          if (!pane) return;
          Manager.addPine(pane, s.id);
          UI.toast2(`Added ${String(s.name || 'script')}`, 'ok');
        });
      }
    };
    renderList('');
    const inp = dlg.querySelector('#ind-search-input');
    inp.addEventListener('input', U.debounce(() => renderList(inp.value), 120));
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    setTimeout(() => inp.focus(), 30);
    layer.classList.remove('hidden');
  } catch (e) {
    close();
    throw e;
  }
};

/* ROUND299: the settings dialog is the PINE dialog. The legacy record's params
   remain the storage shape, so the dialog writes `rec.params` and syncPine
   translates them into engine inputs. This keeps the exact tab layout, input
   rendering, colors, Visibility tab and Defaults/Reset behaviour that the
   Pine dialog already implements — one dialog, no duplicate. */
function openSettingsDialog(pane, rec) {
  const inst = pineInstOf(pane, rec);
  if (!inst) return;
  if (!PineUI) { try { if (typeof window !== 'undefined' && window.__app && window.__app.PineUI) wirePine(window.__app.PineUI); } catch (e) {} }
  if (!PineUI) return;
  /* Bridge the legacy params into the instance's inputs before opening, so the
     dialog shows the values the chart is actually using. */
  const inputs = legacyInputs(rec);
  if (inputs) inst.inputs = Object.assign({}, inst.inputs, inputs);
  PineUI.openSettingsDialog(pane, inst, {
    /* called after Ok: mirror the engine inputs back into the legacy record so
       persistence, the legend title and any external reader stay in step. */
    onCommit: (newInputs) => {
      const def = BUILTIN_BY_TYPE.get(rec.type);
      const defs = inputDefsFor(rec.type);
      const byTitle = new Map();
      for (const d of defs) if (d.title) byTitle.set(d.title, d);
      rec.params = {};
      if (def) {
        for (const key of Object.keys(def.params || {})) {
          const d = byTitle.get(def.params[key]);
          if (d && newInputs && newInputs[d.id] != null) rec.params[key] = newInputs[d.id];
        }
      }
      Manager.persistPanes();
      renderRows(pane);
    },
    onRemove: () => remove(pane, rec.id),
  });
}

/* ROUND299: migrate a persisted layout. Old records carry {type, params,
   colors, style}; Pine instances carry {scriptId, inputs}. Called by the
   manager restore path so a user's saved charts survive the upgrade. */
UI.migrateLegacy = function (pane, recs) {
  if (!pane) return;
  const out = [];
  for (const raw of recs || []) {
    if (!raw) continue;
    if (raw.scriptId) { out.push(raw); continue; } // already Pine
    const def = Indicators.def(raw.type);
    if (!def) continue; // unknown/dropped indicator
    const migrated = Indicators.migrate(raw, inputDefsFor(raw.type));
    if (migrated) out.push(Object.assign({ id: raw.id }, migrated));
  }
  pane.indicators = out;
};

  UI.add = add;
  UI.remove = remove;
  UI.recompute = recompute;
  UI.tickRecompute = tickRecompute;
  UI.updateIndicatorRows = updateIndicatorRows;
  UI.toast2 = function (msg, kind) {
    try {
      if (typeof window !== 'undefined' && window.__app && window.__app.UI && window.__app.UI.toast) window.__app.UI.toast(msg, kind);
    } catch (e) {}
  };

  function dropPane(pane) {
    if (!pane) return;
    PINE_OF.delete(pane);
    PENDING.delete(pane);
  }
  UI.dropPane = dropPane;
  UI.wirePine = wirePine;

export { UI as IndicatorsUI, recompute, tickRecompute, updateIndicatorRows, dropPane, wirePine };
