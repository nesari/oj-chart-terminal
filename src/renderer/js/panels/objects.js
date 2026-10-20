/**
 * Object Tree (TradingView-style): list, select, hide, lock, delete drawings
 *
 * @module panels/objects
 */

import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { App } from '../../../core/state.js';
import { DrawSettings } from '../drawing/settings.js';
import { TOOLS } from '../drawing/tools.js';
import { Manager } from '../chart/manager.js';
import { UI } from '../drawing/ui.js';
import { RightPanel } from '../ui/rightpanel.js';

const ObjectTree = {};
  const collapsed = new Set(); // collapsed type groups

  ObjectTree.init = function () {
    const trash = document.getElementById('obj-trash');
    if (trash) {
      trash.innerHTML = icon('trash');
      trash.title = 'Remove all objects';
      trash.addEventListener('click', () => {
        const pane = App.activePane || App.panes[0];
        if (!pane) return;
        App.drawings.removeAll(pane.symbol);
        App.selection = null;
        UI.onSelectionChanged();
      });
    }
    App.drawings.onChanged.push(() => ObjectTree.refresh());
    ObjectTree.refresh();
  };

  /* open = switch right panel to the objects tab */
  ObjectTree.open = function () {
    if (RightPanel) RightPanel.showTab('objects');
  };

  ObjectTree.refresh = function () {
    const list = document.getElementById('obj-list');
    if (!list) return;
    const pane = App.activePane || App.panes[0];
    U.clear(list);
    if (!pane) return;
    const items = App.drawings.list(pane.symbol);
    if (!items.length) {
      const e = U.el('div', 'obj-empty', list);
      e.textContent = 'No objects on this chart yet. Draw something with the left toolbar.';
      return;
    }
    // group by type, keep insertion order of first appearance
    const groups = [];
    const byType = {};
    for (const d of items) {
      if (!byType[d.type]) { byType[d.type] = []; groups.push(d.type); }
      byType[d.type].push(d);
    }
    for (const type of groups) {
      const arr = byType[type];
      const def = TOOLS[type] || { name: type, icon: 'x' };
      const isCollapsed = collapsed.has(type);
      const gh = U.el('div', 'obj-group' + (isCollapsed ? ' closed' : ''), list);
      gh.innerHTML = `<span class="obj-chev">${icon('chevR')}</span>
        <span class="obj-gic">${icon(def.icon || 'x')}</span>
        <span class="obj-gname">${def.name}</span>
        <span class="obj-gcount">${arr.length}</span>`;
      gh.addEventListener('click', () => {
        if (collapsed.has(type)) collapsed.delete(type); else collapsed.add(type);
        ObjectTree.refresh();
      });
      if (isCollapsed) continue;
      for (const d of arr) {
        const sel = !!(App.selection && App.selection.d === d);
        const row = U.el('div', 'obj-row' + (sel ? ' sel' : '') + (d.hidden ? ' hid' : ''), list);
        row.innerHTML = `<span class="obj-ic">${icon(def.icon || 'x')}</span>
          <span class="obj-name">${def.name} #${d.id}</span>`;
        row.addEventListener('click', (e) => {
          if (e.target.closest('.obj-act')) return;
          const p = App.panes.find((pn) => pn.symbol === d.symbol) || pane;
          Manager.setActive(p);
          App.selection = { pane: p, d };
          UI.onSelectionChanged();
        });
        row.addEventListener('dblclick', (e) => {
          if (e.target.closest('.obj-act')) return;
          const p = App.panes.find((pn) => pn.symbol === d.symbol) || pane;
          Manager.setActive(p);
          App.selection = { pane: p, d };
          UI.onSelectionChanged();
          if (DrawSettings) DrawSettings.open(p, d);
        });
        const mkAct = (ic, title, cls, fn) => {
          const b = U.el('button', 'obj-act ' + (cls || ''), row);
          b.innerHTML = icon(ic);
          b.title = title;
          b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
          return b;
        };
        mkAct('locate', 'Show on chart', '', () => {
          const p = App.panes.find((pn) => pn.symbol === d.symbol) || pane;
          Manager.setActive(p);
          App.selection = { pane: p, d };
          UI.onSelectionChanged();
          /* TV "Locate": scroll the chart to the object's position — the
             visible range is centred on the object's time span (round 18) */
          try {
            const ts = p.chart.timeScale();
            let l0 = Infinity, l1 = -Infinity;
            for (const pt of d.points) {
              const l = U.timeToLogical(p.barTimes, pt.t);
              if (l < l0) l0 = l;
              if (l > l1) l1 = l;
            }
            if (isFinite(l0) && p.barTimes.length) {
              const lr = ts.getVisibleLogicalRange();
              const span = lr ? Math.max(20, lr.to - lr.from) : 120;
              const pad = Math.max(4, span * 0.15);
              ts.setVisibleLogicalRange({ from: l0 - pad, to: l1 + pad });
            }
          } catch (e) {}
        });
        mkAct(d.hidden ? 'eyeoff' : 'eye', d.hidden ? 'Show' : 'Hide', d.hidden ? 'dim' : '', () => {
          d.hidden = !d.hidden;
          App.drawings.save();
          ObjectTree.refresh();
        });
        mkAct(d.locked ? 'lock' : 'unlock', d.locked ? 'Unlock' : 'Lock', d.locked ? 'dim' : '', () => {
          d.locked = !d.locked;
          App.drawings.save();
          ObjectTree.refresh();
        });
        mkAct('trash', 'Delete', 'danger', () => {
          App.drawings.remove(d.symbol, d.id);
          if (App.selection && App.selection.d === d) { App.selection = null; UI.onSelectionChanged(); }
        });
      }
    }
  };

export { ObjectTree };
