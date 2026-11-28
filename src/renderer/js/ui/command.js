/**
 * Command Palette (ROUND305 / roadmap P0-01)
 *
 * `Ctrl+K` (and `Ctrl+Shift+P`) open one search box over everything the app can
 * do: switch symbol, switch timeframe, add an indicator, open a panel, change
 * the chart style, run a settings action. TradingView does this and it is the
 * cheapest way to make ~90 toolbar buttons and ~86 drawing tools reachable
 * without hunting a flyout.
 *
 * Design notes that matter for the tests:
 *
 * 1. THE REGISTRY IS DATA, NOT CLOSURE. A command is
 *    `{ id, title, group, keywords, run }` and nothing else. Anything richer
 *    makes commands impossible to assert on from a unit suite without a DOM.
 *
 * 2. SOURCES ARE PULLED LAZILY. Symbols come from the feed, indicators from the
 *    built-in catalog, drawing tools from `UI.GROUPS`. The palette must show
 *    what the app ACTUALLY has, not a hand-copied list that drifts.
 *
 * 3. `run()` MUST CHANGE SOMETHING A TEST CAN SEE. "Open the palette and press
 *    Enter" is not a test; "the chart style really became Renko" is. Every
 *    command that can be verified through `window.__app` is written that way,
 *    and the E2E asserts the state, never the toast.
 *
 * 4. FUZZY MATCH, NOT SUBSTRING. Typing "rnko" must find "Renko"; the whole
 *    point of a palette is not remembering the exact spelling. Subsequence
 *    matching keeps it dependency-free.
 *
 * 5. RECENT-FIRST. The ten most recently run commands rank above everything
 *    when the query is empty. Stored in `mt5_cmd_recent` (array of ids).
 *
 * @module ui/command
 */

import { U } from '../core/util.js';
import { App } from '../../../core/state.js';
import { icon } from './icons.js';

const RECENT_KEY = 'mt5_cmd_recent';
const RECENT_MAX = 10;

/* ---------- the registry ---------- */

const Command = {
  list: [],
  _byId: new Map(),
  _recent: U.lsGet(RECENT_KEY, []) || [],
  _open: false,
  _sel: 0,
  _rows: [],
  _els: null,
  _wired: false,

  /** Register one command. Re-registering the same id replaces it, so a module
   *  can be re-initialised (hot paths in tests) without duplicating rows. */
  add(cmd) {
    if (!cmd || !cmd.id || typeof cmd.run !== 'function') {
      throw new Error('command needs { id, title, run }');
    }
    const rec = {
      id: String(cmd.id),
      title: String(cmd.title || cmd.id),
      group: String(cmd.group || 'General'),
      keywords: String(cmd.keywords || ''),
      /* the shortcut is DISPLAY ONLY; the real handler lives where it always
         did, so the palette can never invent a working key that the app does
         not honour */
      keys: cmd.keys ? String(cmd.keys) : '',
      icon: cmd.icon || 'search',
      run: cmd.run,
    };
    const i = this.list.findIndex((c) => c.id === rec.id);
    if (i >= 0) this.list[i] = rec; else this.list.push(rec);
    this._byId.set(rec.id, rec);
    return rec;
  },

  /** Bulk form: `addAll([...])`. Returns how many were added. */
  addAll(cmds) {
    let n = 0;
    for (const c of cmds || []) { this.add(c); n++; }
    return n;
  },

  get(id) { return this._byId.get(String(id)); },

  /** Commands whose score > 0 for `query`, best first. Empty query = recent
   *  first, then everything in registration order. */
  search(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) {
      const recent = this._recent
        .map((id) => this._byId.get(id))
        .filter(Boolean);
      const rest = this.list.filter((c) => !this._recent.includes(c.id));
      return recent.concat(rest);
    }
    const scored = [];
    for (const c of this.list) {
      const s = fuzzyScore(c, q);
      if (s > 0) scored.push({ c, s });
    }
    scored.sort((a, b) => (b.s - a.s) || a.c.title.localeCompare(b.c.title));
    return scored.map((x) => x.c);
  },

  /** Run a command by id. Returns false when the id is unknown (the palette
   *  reports it instead of failing silently). */
  run(id) {
    const c = this._byId.get(String(id));
    if (!c) return false;
    this._remember(c.id);
    try {
      c.run();
    } catch (e) {
      /* A palette that dies silently is a palette that lies about its
         features. Report and keep the app alive. */
      try { U.toast && U.toast('Command failed: ' + c.title, 'err'); } catch (er) {}
      try { console.error('[command] ' + c.id, e); } catch (er) {}
    }
    return true;
  },

  _remember(id) {
    this._recent = [id].concat(this._recent.filter((x) => x !== id)).slice(0, RECENT_MAX);
    try { U.lsSet(RECENT_KEY, this._recent); } catch (e) {}
  },

  get recent() { return this._recent.slice(); },

  /** Test/诊断 seam: reset the recent list without touching storage keys. */
  resetRecent() {
    this._recent = [];
    try { U.lsSet(RECENT_KEY, []); } catch (e) {}
  },
};

/* ---------- fuzzy matching ---------- */

/**
 * Score `cmd` against a lowercase query.
 *
 * 0 = no match. Higher = better. The weights encode what a user means when they
 * type: a title prefix beats a title substring, which beats a keyword hit.
 * Exact substring in the title is the strongest single signal because that is
 * what people type ("renko").
 */
function fuzzyScore(cmd, q) {
  const title = cmd.title.toLowerCase();
  const keys = cmd.keywords.toLowerCase();
  const group = cmd.group.toLowerCase();

  if (title === q) return 1000;
  if (title.startsWith(q)) return 800 - title.length;
  const at = title.indexOf(q);
  if (at >= 0) return 600 - at - title.length * 0.1;
  if (keys.includes(q)) return 400;
  if (group.includes(q)) return 250;
  /* subsequence in the title ("rnko" -> "renko"); scaled down so a real
     substring always outranks it */
  if (subsequence(title, q)) return 150 - title.length * 0.1;
  if (subsequence(keys, q)) return 100;
  return 0;
}

export function subsequence(text, q) {
  let i = 0;
  for (const ch of q) {
    i = text.indexOf(ch, i);
    if (i < 0) return false;
    i++;
  }
  return true;
}

/* ---------- the popup ---------- */

const CSS_CLASSES = 'cmd-back cmd-box cmd-input cmd-list cmd-row cmd-kind cmd-key';

function build() {
  if (Command._els) return Command._els;
  const layer = document.getElementById('popup-layer');
  if (!layer) return null;

  const back = U.el('div', 'cmd-back', layer);
  back.id = 'cmd-back';
  /* ROUND305: start hidden. `build()` runs at init to attach listeners; without
     this the palette is visible from the first frame and the app boots with a
     modal covering the chart. Caught by the E2E ("the palette starts closed"),
     not by the unit suite, because it is a paint-time property. */
  back.classList.add('hidden');
  const box = U.el('div', 'cmd-box', back);
  box.id = 'cmd-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Command palette');

  const inp = U.el('input', 'cmd-input', box);
  inp.id = 'cmd-input';
  inp.type = 'text';
  inp.placeholder = 'Search symbols, indicators, tools, commands…';
  inp.setAttribute('spellcheck', 'false');
  inp.setAttribute('autocomplete', 'off');

  const list = U.el('div', 'cmd-list', box);
  list.id = 'cmd-list';
  list.setAttribute('role', 'listbox');

  Command._els = { layer, back, box, inp, list };
  return Command._els;
}

function rowFor(els, cmd, idx) {
  const r = U.el('button', 'cmd-row', els.list);
  r.type = 'button';
  r.dataset.id = cmd.id;
  r.dataset.idx = String(idx);
  r.setAttribute('role', 'option');
  const ic = U.el('span', 'cmd-ic', r);
  ic.innerHTML = icon(cmd.icon || 'search');
  const t = U.el('span', 'cmd-title', r);
  t.textContent = cmd.title;
  const kind = U.el('span', 'cmd-kind', r);
  kind.textContent = cmd.group;
  if (cmd.keys) {
    const k = U.el('span', 'cmd-key', r);
    k.textContent = cmd.keys;
  }
  r.addEventListener('click', () => { Command.pick(cmd.id); });
  return r;
}

function render(query) {
  const els = Command._els;
  if (!els) return;
  U.clear(els.list);
  const rows = Command.search(query).slice(0, 50);
  Command._rows = rows;
  if (!rows.length) {
    const empty = U.el('div', 'cmd-empty', els.list);
    empty.textContent = 'No matching command';
    Command._sel = 0;
    return;
  }
  /* keep the selection in range across a re-render */
  if (Command._sel >= rows.length) Command._sel = rows.length - 1;
  if (Command._sel < 0) Command._sel = 0;
  rows.forEach((c, i) => rowFor(els, c, i));
  highlight(Command._sel);
}

function highlight(i) {
  const els = Command._els;
  if (!els) return;
  const rows = els.list.querySelectorAll('.cmd-row');
  rows.forEach((r, k) => {
    r.classList.toggle('sel', k === i);
    r.setAttribute('aria-selected', k === i ? 'true' : 'false');
  });
  const sel = rows[i];
  if (sel && sel.scrollIntoView) {
    try { sel.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }
}

function move(delta) {
  const n = Command._rows.length;
  if (!n) return;
  Command._sel = (Command._sel + delta + n) % n;
  highlight(Command._sel);
}

/** Pick the highlighted (or given) command, close, and run it. */
Command.pick = function (id) {
  const target = id || (Command._rows[Command._sel] && Command._rows[Command._sel].id);
  if (!target) return false;
  Command.close();
  return Command.run(target);
};

Command.open = function (initial) {
  const els = build();
  if (!els) return false;
  Command._open = true;
  Command._sel = 0;
  els.back.classList.remove('hidden');
  els.layer.classList.remove('hidden');
  els.inp.value = initial == null ? '' : String(initial);
  render(els.inp.value);
  /* focus after paint — a dialog opened from a keydown must not steal the key */
  setTimeout(() => { try { els.inp.focus(); els.inp.select(); } catch (e) {} }, 0);
  return true;
};

Command.close = function () {
  const els = Command._els;
  if (!els) return;
  Command._open = false;
  els.back.classList.add('hidden');
  try { els.inp.blur(); } catch (e) {}
  /* only hide the shared layer if nothing else is using it */
  const layer = els.layer;
  if (layer && !layer.querySelector('.dialog-backdrop:not(.hidden), .popup:not(.hidden)')) {
    layer.classList.add('hidden');
  }
};

Command.isOpen = function () { return !!Command._open; };

/* ---------- keyboard + wiring ---------- */

function onKey(e) {
  if (!Command._open) return false;
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); move(1); return true;
    case 'ArrowUp': e.preventDefault(); move(-1); return true;
    case 'PageDown': e.preventDefault(); move(10); return true;
    case 'PageUp': e.preventDefault(); move(-10); return true;
    case 'Enter': e.preventDefault(); Command.pick(); return true;
    case 'Escape': e.preventDefault(); Command.close(); return true;
    case 'Tab': e.preventDefault(); move(e.shiftKey ? -1 : 1); return true;
    default: return false;
  }
}

/**
 * Install the global handler and the toolbar button. Idempotent: boot calls it
 * once, and a test that calls it twice must not double-fire.
 */
Command.init = function () {
  if (Command._wired) return;
  Command._wired = true;

  document.addEventListener('keydown', (e) => {
    /* Ctrl+K / Cmd+K, and the TV alias Ctrl+Shift+P. Must work while an input
       has focus (that is the point of a palette), but must NOT fire inside a
       real modal dialog, which owns the keyboard. */
    const key = String(e.key || '').toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const isK = mod && !e.shiftKey && !e.altKey && key === 'k';
    const isP = mod && e.shiftKey && !e.altKey && key === 'p';
    if (!isK && !isP) return;
    const modal = document.querySelector('.dialog-backdrop:not(.hidden), .ds-dialog');
    /* the palette's own backdrop is a .cmd-back, not a .dialog-backdrop */
    if (modal && !Command._open) return;
    e.preventDefault();
    e.stopPropagation();
    if (Command._open) Command.close(); else Command.open();
  }, true);

  /* keys inside the palette are handled here, not by the app's chart shortcuts */
  const els = build();
  if (els) {
    els.back.addEventListener('mousedown', (e) => { if (e.target === els.back) Command.close(); });
    els.inp.addEventListener('input', () => { Command._sel = 0; render(els.inp.value); });
    els.inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      onKey(e);
    });
  }

  /* the toolbar button, next to the symbol pill (TV puts the search there) */
  const host = document.getElementById('tb-left');
  const btn = document.getElementById('cmd-btn');
  if (btn) {
    btn.innerHTML = icon('search');
    btn.addEventListener('click', () => { if (Command._open) Command.close(); else Command.open(); });
  } else if (host) {
    const b = U.el('button', 'tb-btn', host);
    b.id = 'cmd-btn';
    b.title = 'Command Palette (Ctrl+K)';
    b.innerHTML = icon('search');
    b.addEventListener('click', () => { if (Command._open) Command.close(); else Command.open(); });
  }
};

export { Command, fuzzyScore, CSS_CLASSES };
