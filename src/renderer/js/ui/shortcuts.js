/**
 * Keyboard shortcut registry + editor (ROUND307 / roadmap P0-03)
 *
 * Before this module the app had ten shortcuts hard-coded inline in `app.js`
 * (`/`, Ctrl+S, Ctrl+Alt+S, Ctrl+Shift+S, Alt+Shift+R, Delete, Ctrl+Z, Ctrl+Y
 * and the timeframe digits). They worked, but:
 *
 *   - a user could not see them (`?` did nothing),
 *   - a user could not change one (Alt+Shift+R for Rectangle is arbitrary),
 *   - nothing detected two actions claiming the same key,
 *   - adding an eleventh meant editing the middle of a 60-line handler.
 *
 * The model here is one table: `{ action -> keys }`, persisted under `mt5_keys`.
 * Defaults are the CURRENT bindings, so behaviour is unchanged on first run;
 * a saved override simply wins.
 *
 * Design decisions that the tests depend on:
 *
 * 1. MATCHING IS ON `e.code`, NOT `e.key`. `key` is layout- and shift-dependent
 *    ("Z" vs "z", and on AZERTY the physical Z key is elsewhere), so a shortcut
 *    recorded on one layout would not fire on another. `code` is the physical
 *    key. The exceptions are the two keys that have no useful `code`: `/` and
 *    `Delete` are matched by `key` because that is what users mean and what the
 *    old code did.
 *
 * 2. MODIFIERS ARE EXACT. Ctrl+S must not also fire on Ctrl+Shift+S: the old
 *    handler repeated `!e.shiftKey` on every line, and losing that silently
 *    broke Save Layout the moment the snapshot chords existed.
 *
 * 3. TYPING AND MODALS WIN. `U.isTyping(target)` and an open dialog suppress
 *    every chart shortcut (ROUND103 regression — Delete used to remove a
 *    drawing while the user erased a character in an input). The editor itself
 *    is exempt because it must capture the keys it is recording.
 *
 * 4. CONFLICTS ARE REJECTED AT RECORD TIME, NOT AT FIRE TIME. Two actions on
 *    one chord means one of them silently never runs; the editor refuses the
 *    assignment and says which action already owns it.
 *
 * @module ui/shortcuts
 */

import { U } from '../core/util.js';
import { App } from '../../../core/state.js';
import { icon } from './icons.js';

const KEY_STORE = 'mt5_keys';

/* The ten live bindings, expressed as data. `keys` is a portable string:
 *   "Ctrl+S", "Ctrl+Shift+S", "Alt+Shift+R", "/", "Delete", "Ctrl+Alt+S"
 * A single letter without a modifier is only allowed for the two keys that had
 * no modifier before (`/`), otherwise typing would arm tools. */
const DEFAULTS = [
  { id: 'indicator-dialog', title: 'Indicators dialog', group: 'Chart', keys: '/', code: 'slash' },
  { id: 'save-layout', title: 'Save layout', group: 'Chart', keys: 'Ctrl+S' },
  { id: 'snapshot-download', title: 'Snapshot: download', group: 'Chart', keys: 'Ctrl+Alt+S' },
  { id: 'snapshot-copy', title: 'Snapshot: copy', group: 'Chart', keys: 'Ctrl+Shift+S' },
  { id: 'tool-rect', title: 'Draw rectangle', group: 'Drawing', keys: 'Alt+Shift+R' },
  { id: 'delete-selected', title: 'Delete selected drawing', group: 'Drawing', keys: 'Delete' },
  { id: 'undo', title: 'Undo', group: 'Edit', keys: 'Ctrl+Z' },
  { id: 'redo', title: 'Redo', group: 'Edit', keys: 'Ctrl+Y' },
  { id: 'redo-alt', title: 'Redo (alternate)', group: 'Edit', keys: 'Ctrl+Shift+Z' },
];

/* ---------- key normalisation ---------- */

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift'];

/**
 * Turn a KeyboardEvent into the portable form used by the table.
 *
 * `code` drives letters and digits (layout-independent); `key` drives the
 * punctuation and named keys that have no useful `code`. Returns '' for
 * modifier-only presses so the recorder can wait for a real key.
 */
export function eventToKeys(e) {
  if (!e) return '';
  const raw = String(e.key || '');
  if (['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'Dead'].includes(raw)) return '';

  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');

  let main = '';
  const code = String(e.code || '');
  if (/^Key[A-Z]$/.test(code)) main = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) main = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) main = code;
  else if (code === 'Slash') main = '/';
  else if (code === 'Comma') main = ',';
  else if (code === 'Period') main = '.';
  else if (code === 'Semicolon') main = ';';
  else if (code === 'BracketLeft') main = '[';
  else if (code === 'BracketRight') main = ']';
  else if (code === 'Backslash') main = '\\';
  else if (code === 'Minus') main = '-';
  else if (code === 'Equal') main = '=';
  else if (code === 'Backquote') main = '`';
  else if (code === 'Space') main = 'Space';
  else if (code === 'Enter') main = 'Enter';
  else if (code === 'Escape') main = 'Esc';
  else if (code === 'Backspace') main = 'Backspace';
  else if (code === 'Delete') main = 'Delete';
  else if (code === 'ArrowUp') main = 'Up';
  else if (code === 'ArrowDown') main = 'Down';
  else if (code === 'ArrowLeft') main = 'Left';
  else if (code === 'ArrowRight') main = 'Right';
  else if (raw.length === 1) main = raw.toUpperCase();
  else main = raw;

  if (!main) return '';
  return mods.length ? mods.join('+') + '+' + main : main;
}

/** Canonical form so "shift+ctrl+s" and "Ctrl+Shift+S" compare equal. */
export function normalizeKeys(keys) {
  if (!keys) return '';
  const parts = String(keys).split('+').map((s) => s.trim()).filter(Boolean);
  const mods = [];
  let main = '';
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === 'ctrl' || low === 'control' || low === 'cmd' || low === 'meta') { if (!mods.includes('Ctrl')) mods.push('Ctrl'); }
    else if (low === 'alt' || low === 'option') { if (!mods.includes('Alt')) mods.push('Alt'); }
    else if (low === 'shift') { if (!mods.includes('Shift')) mods.push('Shift'); }
    else main = p.length === 1 ? p.toUpperCase() : p;
  }
  /* `/` and Delete keep their literal spelling; a single letter is uppercased. */
  if (main === 'SLASH') main = '/';
  const ordered = MOD_ORDER.filter((m) => mods.includes(m));
  return ordered.length ? ordered.join('+') + '+' + main : main;
}

/**
 * Is a bare (modifier-less) key allowed for an action?
 *
 * Only the two that shipped without a modifier: `/` and the four navigation
 * keys Delete/Enter/Esc/Backspace/Space. Everything else needs at least one
 * modifier, or it would fire while the user types or draws.
 */
export function isAllowedBare(main) {
  return ['/', 'Delete', 'Enter', 'Esc', 'Backspace', 'Space', 'Up', 'Down', 'Left', 'Right'].includes(main);
}

/** Validate a recorded chord. Returns { ok, reason }. */
export function validateBinding(keys) {
  const k = normalizeKeys(keys);
  if (!k) return { ok: false, reason: 'Press a key combination' };
  const parts = k.split('+');
  const main = parts[parts.length - 1];
  const hasMod = parts.length > 1;
  if (!main) return { ok: false, reason: 'Press a key combination' };
  if (!hasMod && !isAllowedBare(main)) {
    return { ok: false, reason: 'Add Ctrl, Alt or Shift — a bare key would fire while typing' };
  }
  if (hasMod && isAllowedBare(main) && main !== '/' && main !== 'Delete' && /^[A-Z]$/.test(main) === false && !/^F\d/.test(main)) {
    /* e.g. Ctrl+Enter is fine; this branch only documents that named keys are
       allowed WITH modifiers, so there is nothing to reject here. */
  }
  return { ok: true, keys: k };
}

/* ---------- the registry ---------- */

const Shortcuts = {
  _actions: [],          // the resolved table (defaults + overrides)
  _overrides: {},
  _handlers: new Map(),  // id -> run(ctx)
  _dialog: null,
  _recording: null,      // id being recorded
  _wired: false,

  /** Load defaults + saved overrides. Called once at boot. */
  load() {
    this._overrides = U.lsGet(KEY_STORE, {}) || {};
    this._actions = DEFAULTS.map((d) => ({
      ...d,
      defaultKeys: d.keys,
      keys: normalizeKeys(this._overrides[d.id] || d.keys),
      overridden: Object.prototype.hasOwnProperty.call(this._overrides, d.id),
    }));
    return this._actions;
  },

  actions() { return this._actions.slice(); },

  get(id) { return this._actions.find((a) => a.id === id) || null; },

  /** Register the behaviour for an id. An unknown id is an error, not a silent
   *  no-op — a shortcut that is listed but wired to nothing is worse than none. */
  on(id, run) {
    if (!this.get(id)) throw new Error('unknown shortcut id: ' + id);
    this._handlers.set(id, run);
  },

  /** The action that owns `keys`, excluding `exceptId`. Used for conflict checks. */
  ownerOf(keys, exceptId) {
    const k = normalizeKeys(keys);
    const hit = this._actions.find((a) => a.id !== exceptId && a.keys === k);
    return hit || null;
  },

  /** Assign a chord to an action. Returns { ok, reason, owner }. */
  assign(id, keys) {
    const a = this.get(id);
    if (!a) return { ok: false, reason: 'unknown action' };
    const v = validateBinding(keys);
    if (!v.ok) return { ok: false, reason: v.reason };
    const owner = this.ownerOf(v.keys, id);
    if (owner) {
      return { ok: false, reason: `Already used by "${owner.title}"`, owner: owner.id };
    }
    a.keys = v.keys;
    a.overridden = v.keys !== a.defaultKeys;
    if (a.overridden) this._overrides[id] = v.keys;
    else delete this._overrides[id];
    this._save();
    return { ok: true, keys: v.keys };
  },

  /** Drop the override for one action (back to its default). */
  reset(id) {
    const a = this.get(id);
    if (!a) return false;
    /* resetting must not create a conflict with whatever holds the default now */
    const owner = this.ownerOf(a.defaultKeys, id);
    if (owner) return false;
    a.keys = a.defaultKeys;
    a.overridden = false;
    delete this._overrides[id];
    this._save();
    return true;
  },

  /** Drop every override. */
  resetAll() {
    for (const a of this._actions) { a.keys = a.defaultKeys; a.overridden = false; }
    this._overrides = {};
    this._save();
    return true;
  },

  _save() {
    try { U.lsSet(KEY_STORE, this._overrides); } catch (e) {}
  },

  /**
   * Handle a keydown. Returns true when a shortcut ran (so the caller can
   * `return` and let nothing else see the event).
   *
   * `handledHere` is false inside the editor, where recording owns the keys.
   */
  handle(e) {
    if (!e) return false;
    /* just-in-time coercion: the table is small, and this keeps a hot-path
       keydown handler allocation-free apart from the modifiers */
    const pressed = eventToKeys(e);
    if (!pressed) return false;
    const act = this._actions.find((a) => a.keys === pressed);
    if (!act) return false;
    const run = this._handlers.get(act.id);
    if (!run) return false;
    e.preventDefault();
    try { run({ event: e, action: act }); }
    catch (err) {
      try { U.toast && U.toast('Shortcut failed: ' + act.title, 'err'); } catch (er) {}
      try { console.error('[shortcuts] ' + act.id, err); } catch (er) {}
    }
    return true;
  },

  /** True when a global shortcut must be suppressed (typing or a modal). */
  suppressed(target) {
    if (U.isTyping && U.isTyping(target)) return true;
    /* `:not(.hidden)` is essential: dialogs built at boot and merely hidden are
       in the DOM, and treating them as open kills every shortcut. */
    if (document.querySelector('.dialog-backdrop:not(.hidden), .ds-dialog:not(.hidden)')) return true;
    return false;
  },
};

/* ---------- the editor dialog ---------- */

function buildDialog() {
  /* Built once. `open()` used to call this every time, so every open appended
     ANOTHER element with id="shortcuts-dialog": the visible one was the last,
     but `document.getElementById` returned the first, which stayed hidden. The
     E2E read the hidden one and reported "the editor did not open" while a
     dialog was plainly on screen. */
  if (Shortcuts._dialog) return Shortcuts._dialog;
  const layer = document.getElementById('popup-layer');
  if (!layer) return null;
  const back = U.el('div', 'dialog-backdrop', layer);
  back.id = 'shortcuts-dialog';
  back.classList.add('hidden');
  const dlg = U.el('div', 'dialog sc-dialog', back);

  dlg.innerHTML = `
    <h3>Keyboard shortcuts<button class="mini-btn dlg-x" id="sc-close">${icon('x')}</button></h3>
    <div class="sc-search"><input type="text" id="sc-filter" placeholder="Filter shortcuts…" spellcheck="false" autocomplete="off"></div>
    <div class="sc-list" id="sc-list"></div>
    <div class="sc-foot">
      <span class="sc-hint" id="sc-hint">Click a shortcut, then press the new keys.</span>
      <button class="dlg-btn dlg-ghost" id="sc-reset-all">Reset all</button>
    </div>`;

  const close = () => {
    back.classList.add('hidden');
    Shortcuts._recording = null;
    if (!layer.querySelector('.dialog-backdrop:not(.hidden)')) layer.classList.add('hidden');
  };
  dlg.querySelector('#sc-close').addEventListener('click', close);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  dlg.querySelector('#sc-filter').addEventListener('input', () => Shortcuts._render());
  dlg.querySelector('#sc-reset-all').addEventListener('click', () => {
    Shortcuts.resetAll();
    Shortcuts._render();
    Shortcuts._hint('All shortcuts reset to their defaults', 'ok');
  });
  Shortcuts._dialog = { layer, back, dlg, close };
  return Shortcuts._dialog;
}

Shortcuts._hint = function (text, kind) {
  const h = document.getElementById('sc-hint');
  if (!h) return;
  h.textContent = text;
  h.className = 'sc-hint' + (kind === 'err' ? ' sc-err' : kind === 'ok' ? ' sc-ok' : '');
};

Shortcuts._render = function () {
  const list = document.getElementById('sc-list');
  if (!list) return;
  const q = String((document.getElementById('sc-filter') || {}).value || '').trim().toLowerCase();
  U.clear(list);
  let group = null;
  for (const a of this._actions) {
    if (q && !(a.title.toLowerCase().includes(q) || a.keys.toLowerCase().includes(q))) continue;
    if (a.group !== group) {
      group = a.group;
      const gh = U.el('div', 'sc-group', list);
      gh.textContent = group;
    }
    const row = U.el('div', 'sc-row', list);
    row.dataset.id = a.id;
    const t = U.el('span', 'sc-title', row);
    t.textContent = a.title;
    if (a.overridden) {
      const dot = U.el('span', 'sc-mod', row);
      dot.textContent = 'modified';
    }
    const key = U.el('button', 'sc-key' + (this._recording === a.id ? ' recording' : ''), row);
    key.type = 'button';
    key.textContent = this._recording === a.id ? 'Press keys…' : a.keys;
    key.addEventListener('click', () => this._startRecord(a.id));
    if (a.overridden) {
      const rst = U.el('button', 'sc-reset', row);
      rst.type = 'button';
      rst.innerHTML = icon('undo');
      rst.title = 'Reset to ' + a.defaultKeys;
      rst.addEventListener('click', () => {
        if (this.reset(a.id)) { this._render(); this._hint('Reset to ' + a.defaultKeys, 'ok'); }
        else this._hint('Cannot reset: ' + a.defaultKeys + ' is used by another action', 'err');
      });
    }
  }
};

Shortcuts._startRecord = function (id) {
  this._recording = id;
  this._render();
  this._hint('Press the new keys for "' + (this.get(id) || {}).title + '" (Esc cancels)', '');
};

Shortcuts._finishRecord = function (keys) {
  const id = this._recording;
  if (!id) return false;
  const res = this.assign(id, keys);
  if (res.ok) {
    this._recording = null;
    this._render();
    this._hint('Saved: ' + res.keys, 'ok');
  } else {
    /* keep recording so the user can immediately try another chord */
    this._hint(res.reason, 'err');
  }
  return res.ok;
};

Shortcuts.open = function () {
  const d = buildDialog();
  if (!d) return false;
  d.layer.classList.remove('hidden');
  d.back.classList.remove('hidden');
  this._recording = null;
  this._render();
  this._hint('Click a shortcut, then press the new keys.', '');
  setTimeout(() => { try { d.dlg.querySelector('#sc-filter').focus(); } catch (e) {} }, 40);
  return true;
};

Shortcuts.isOpen = function () {
  const d = this._dialog;
  return !!(d && !d.back.classList.contains('hidden'));
};

/* ---------- wiring ---------- */

/**
 * Install the editor's own key capture and the `?` opener. The chart handler in
 * `app.js` calls `Shortcuts.handle(e)` for everything else.
 */
Shortcuts.init = function () {
  if (this._wired) return;
  this._wired = true;
  this.load();
  buildDialog();

  document.addEventListener('keydown', (e) => {
    if (!this.isOpen()) return;
    const recording = !!this._recording;
    if (recording) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        /* Esc is also a legitimate binding, so: cancel recording on Esc with no
           modifier held — the same key a user expects to mean "forget it". */
        this._recording = null;
        this._render();
        this._hint('Cancelled', '');
        return;
      }
      const keys = eventToKeys(e);
      if (!keys) return;
      this._finishRecord(keys);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this._dialog.close();
    }
  }, true);

  /* `?` opens the editor (Shift+/ on most layouts). Guarded like every other
     chart shortcut so it never fires inside an input. */
  document.addEventListener('keydown', (e) => {
    if (this.isOpen()) return;
    if (e.key !== '?') return;
    if (U.isTyping && U.isTyping(e.target)) return;
    if (document.querySelector('.dialog-backdrop:not(.hidden)')) return;
    e.preventDefault();
    this.open();
  });
};

/* The default handlers bind the table to the behaviours that used to live
 * inline in app.js. Kept here (not in app.js) so the table and its effects live
 * together — the E2E asserts the effect, and a reader can see both sides. */
export function bindDefaultHandlers(deps) {
  const d = deps || {};
  Shortcuts.on('indicator-dialog', () => { if (d.IndicatorsUI && d.IndicatorsUI.openDialog) d.IndicatorsUI.openDialog(); });
  Shortcuts.on('save-layout', () => { if (d.Toolbar && d.Toolbar.openSaveLayoutDialog) d.Toolbar.openSaveLayoutDialog(); });
  Shortcuts.on('snapshot-download', () => { if (d.Toolbar && d.Toolbar.Snapshot) d.Toolbar.Snapshot.download(); });
  Shortcuts.on('snapshot-copy', () => { if (d.Toolbar && d.Toolbar.Snapshot) d.Toolbar.Snapshot.copy(); });
  Shortcuts.on('tool-rect', () => { if (d.UI && d.UI.activateTool) d.UI.activateTool('rect'); });
  Shortcuts.on('delete-selected', () => {
    if (!App.selection) return;
    const sel = App.selection;
    if (App.undo) App.undo.remove(sel.pane, sel.d);
    else App.drawings.remove(sel.pane.symbol, sel.d.id);
    App.selection = null;
    if (d.UI && d.UI.onSelectionChanged) d.UI.onSelectionChanged();
  });
  Shortcuts.on('undo', () => { if (App.undo) App.undo.undo(); });
  Shortcuts.on('redo', () => { if (App.undo) App.undo.redo(); });
  Shortcuts.on('redo-alt', () => { if (App.undo) App.undo.redo(); });
  return Shortcuts;
}

export { Shortcuts, DEFAULTS, KEY_STORE };
