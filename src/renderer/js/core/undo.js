/**
 * Undo/Redo for drawings (TradingView behaviour)
 *
 * Command stack (cap 200): add / remove (with index) / modify (before+after)
 * / removeAll (bucket snapshot). Wired in engine (_finish, drags), DrawSettings
 * (Ok), ui.js (ctx delete/clone, trash-all) and app.js (Delete, Ctrl+Z/Y).
 *
 * @module core/undo
 */

import { U } from './util.js';
import { App } from '../../../core/state.js';
import { UI } from '../drawing/ui.js';

const CAP = 200;

  const Undo = {
    _stack: [],
    _idx: 0, // next write position (== stack.length when no undos)

    init() {},

    _trim() {
      if (this._stack.length > CAP) {
        const drop = this._stack.length - CAP;
        this._stack.splice(0, drop);
        this._idx = Math.max(0, this._idx - drop);
      }
    },

    _bucket(symbol) {
      return U.deepCopy(App.drawings.data[symbol] || { next: 1, items: [] });
    },
    _restoreBucket(symbol, snap) {
      App.drawings.data[symbol] = U.deepCopy(snap);
      App.drawings.saveNow();
      App.drawings._notify();
    },

    push(cmd) {
      this._stack.length = this._idx; // drop the redo tail
      this._stack.push(cmd);
      this._idx = this._stack.length;
      this._trim();
      this._buttons();
    },

    /* add: the drawing was appended -> undo removes it (by id), redo re-adds */
    _applyRemove(symbol, d) {
      const b = App.drawings.data[symbol];
      if (!b) return;
      b.items = b.items.filter((x) => x.id !== d.id);
      App.drawings.saveNow();
      App.drawings._notify();
    },
    _applyAdd(symbol, d) {
      const b = App.drawings.bucket(symbol);
      if (!b.items.some((x) => x.id === d.id)) b.items.push(U.deepCopy(d));
      App.drawings.saveNow();
      App.drawings._notify();
    },
    _drawingById(symbol, id) {
      return (App.drawings.list(symbol) || []).find((x) => x.id === id);
    },

    removeAll(pane) {
      if (!pane) return;
      /* Close any open drawing dialog first so it cannot keep editing an
         object that removeAll is about to delete. */
      if (UI && UI.closeActiveSettings) UI.closeActiveSettings(true);
      this.push({ kind: 'removeAll', symbol: pane.symbol, snap: this._bucket(pane.symbol) });
      App.drawings.removeAll(pane.symbol);
    },
    add(pane, copy) {
      if (!pane) return;
      /* round 23 fix: the drawing must be added FIRST so the stack captures
         the real id — the old order snapshotted before Drawings.add assigned
         the id, so undo (filter by id) and redo (dedupe by id) both missed */
      App.drawings.add(pane.symbol, copy);
      this.push({ kind: 'add', symbol: pane.symbol, d: U.deepCopy(copy) });
    },
    remove(pane, d) {
      if (!pane || !d) return;
      /* An open settings dialog holds a live reference to this drawing; close
         it (committing any pending edit) before the object disappears. */
      if (UI && UI.closeSettingsFor) UI.closeSettingsFor(d, true);
      const b = App.drawings.data[pane.symbol];
      const idx = b ? b.items.findIndex((x) => x.id === d.id) : -1;
      this.push({ kind: 'remove', symbol: pane.symbol, d: U.deepCopy(d), idx });
      this._applyRemove(pane.symbol, d);
      if (App.selection && App.selection.d && App.selection.d.id === d.id) {
        App.selection = null;
        if (UI) UI.onSelectionChanged();
      }
    },

    _undoOne(cmd) {
      const S = cmd.symbol;
      if (cmd.kind === 'add') this._applyRemove(S, cmd.d);
      else if (cmd.kind === 'remove') {
        const b = App.drawings.bucket(S);
        const i = U.clamp(cmd.idx, 0, b.items.length);
        b.items.splice(i, 0, U.deepCopy(cmd.d));
        App.drawings.saveNow();
        App.drawings._notify();
      } else if (cmd.kind === 'modify') {
        const d = this._drawingById(S, cmd.id);
        if (d && cmd.before) {
          for (const k of Object.keys(d.opts)) delete d.opts[k];
          Object.assign(d.opts, U.deepCopy(cmd.before.opts || {}));
          d.points.length = 0;
          for (const p of cmd.before.points || []) d.points.push({ t: p.t, p: p.p });
          App.drawings.saveNow();
          App.drawings._notify();
        }
      } else if (cmd.kind === 'removeAll') {
        this._restoreBucket(S, cmd.snap);
      }
    },
    _redoOne(cmd) {
      const S = cmd.symbol;
      if (cmd.kind === 'add') this._applyAdd(S, cmd.d);
      else if (cmd.kind === 'remove') this._applyRemove(S, cmd.d);
      else if (cmd.kind === 'modify') {
        const d = this._drawingById(S, cmd.id);
        if (d && cmd.after) {
          for (const k of Object.keys(d.opts)) delete d.opts[k];
          Object.assign(d.opts, U.deepCopy(cmd.after.opts || {}));
          d.points.length = 0;
          for (const p of cmd.after.points || []) d.points.push({ t: p.t, p: p.p });
          App.drawings.saveNow();
          App.drawings._notify();
        }
      } else if (cmd.kind === 'removeAll') {
        App.drawings.removeAll(S);
      }
    },

    undo() {
      if (this._idx <= 0) return;
      this._idx--;
      this._undoOne(this._stack[this._idx]);
      this._after();
    },
    redo() {
      if (this._idx >= this._stack.length) return;
      this._redoOne(this._stack[this._idx]);
      this._idx++;
      this._after();
    },
    _after() {
      /* Drop a dead selection; if the drawing survived (e.g. undo of
         removeAll restores a fresh bucket copy), re-bind to the live object so
         later drags/settings edits do not mutate a detached stale copy. */
      if (App.selection && App.selection.d) {
        const live = (App.drawings.list(App.selection.pane.symbol) || []).find((x) => x.id === App.selection.d.id);
        if (live) App.selection.d = live;
        else App.selection = null;
      }
      if (UI) UI.onSelectionChanged();
      this._buttons();
    },

    _buttons() {
      const u = document.getElementById('undo-btn');
      const r = document.getElementById('redo-btn');
      if (u) u.classList.toggle('tb-off', this._idx <= 0);
      if (r) r.classList.toggle('tb-off', this._idx >= this._stack.length);
    },
  };

export { Undo };
