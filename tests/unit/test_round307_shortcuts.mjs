/**
 * test_round307_shortcuts.mjs — the shortcut registry (roadmap P0-03).
 *
 * The ten shortcuts that used to be inline `if` statements in `app.js` are now
 * one table. Testing them as data is the whole point: a conflict, a
 * layout-dependent chord or a lost `typing` guard is invisible in a browser
 * until a user loses work.
 *
 * What is pinned:
 *   A. key normalisation (order, case, layout independence via `code`)
 *   B. bare keys are refused unless they shipped bare
 *   C. conflict detection rejects the second owner and says who owns it
 *   D. overrides persist, apply, and reset cleanly
 *   E. every default id has a handler (an unbound row is a dead shortcut)
 *   F. the migration preserved the ten original bindings exactly
 *
 * Run: node tests/unit/test_round307_shortcuts.mjs
 */

/* ---- minimal DOM + storage stubs (the module builds a dialog at init) ---- */
const stubEl = () => ({
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  style: {}, dataset: {}, children: [],
  appendChild(c) { this.children.push(c); return c; },
  addEventListener() {}, setAttribute() {}, removeAttribute() {},
  querySelector() { return null; }, querySelectorAll() { return []; },
  focus() {}, blur() {}, select() {}, scrollIntoView() {},
  set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; },
  set textContent(v) { this._txt = v; }, get textContent() { return this._txt || ''; },
  set value(v) { this._val = v; }, get value() { return this._val || ''; },
});
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => stubEl(),
  addEventListener() {},
  body: stubEl(),
};
globalThis.window = { addEventListener() {} };
globalThis.localStorage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
})();

const {
  Shortcuts, DEFAULTS, KEY_STORE, eventToKeys, normalizeKeys, validateBinding, isAllowedBare, bindDefaultHandlers,
} = await import('../../src/renderer/js/ui/shortcuts.js');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

const key = (k, mods = {}) => ({
  key: k,
  code: mods.code || (k.length === 1 ? 'Key' + k.toUpperCase() : ''),
  ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.meta,
});

/* ---------- A. normalisation ---------- */
{
  ok(eventToKeys(key('s', { ctrl: true })) === 'Ctrl+S', 'Ctrl+S round-trips',
    eventToKeys(key('s', { ctrl: true })));
  ok(eventToKeys(key('S', { ctrl: true, shift: true })) === 'Ctrl+Shift+S',
    'modifier order is canonical even when Shift capitalises the key',
    eventToKeys(key('S', { ctrl: true, shift: true })));
  ok(eventToKeys(key('r', { alt: true, shift: true })) === 'Alt+Shift+R',
    'Alt+Shift+R round-trips (the Rectangle binding)',
    eventToKeys(key('r', { alt: true, shift: true })));
  ok(eventToKeys(key('Delete', { code: 'Delete' })) === 'Delete', 'Delete round-trips',
    eventToKeys(key('Delete', { code: 'Delete' })));
  ok(eventToKeys({ key: '/', code: 'Slash' }) === '/', 'slash round-trips',
    eventToKeys({ key: '/', code: 'Slash' }));
  ok(eventToKeys(key('s', { ctrl: true, meta: true })) === 'Ctrl+S', 'Cmd collapses to Ctrl (one table)');

  /* modifier-only presses must not produce a binding */
  ok(eventToKeys({ key: 'Control', code: 'ControlLeft', ctrlKey: true }) === '',
    'pressing only Ctrl records nothing');

  /* layout independence: the physical key wins, not the character */
  const azerty = { key: 'w', code: 'KeyZ', ctrlKey: true };  /* AZERTY: physical Z is where QWERTY W is */
  ok(eventToKeys(azerty) === 'Ctrl+Z', 'the physical key (code) wins over the character',
    eventToKeys(azerty));

  /* normalisation is stable and order-insensitive */
  ok(normalizeKeys('shift+ctrl+s') === 'Ctrl+Shift+S', 'normalizeKeys orders modifiers');
  ok(normalizeKeys('Ctrl+Shift+S') === normalizeKeys('Shift+Ctrl+S'), 'normalizeKeys is order-insensitive');
  ok(normalizeKeys('ctrl+s') === 'Ctrl+S', 'normalizeKeys fixes case');
  ok(normalizeKeys('') === '', 'empty stays empty');
}

/* ---------- B. bare keys ---------- */
{
  ok(isAllowedBare('/'), '/ may be bare (it shipped that way)');
  ok(isAllowedBare('Delete'), 'Delete may be bare (it shipped that way)');
  ok(!isAllowedBare('S'), 'a bare letter is refused');
  ok(!isAllowedBare('R'), 'a bare letter is refused (R would arm Rectangle while typing)');

  ok(validateBinding('S').ok === false, 'a bare S fails validation');
  ok(validateBinding('/').ok === true, '/ validates');
  ok(validateBinding('Ctrl+S').ok === true, 'Ctrl+S validates');
  ok(validateBinding('').ok === false, 'an empty chord fails');
  ok(/typing/.test(validateBinding('S').reason || ''), 'the refusal explains WHY (typing)',
    validateBinding('S').reason);
}

/* ---------- C. conflicts ---------- */
{
  Shortcuts.load();
  /* Ctrl+S is Save Layout by default */
  const owner = Shortcuts.ownerOf('Ctrl+S');
  ok(!!owner && owner.id === 'save-layout', 'Ctrl+S is owned by save-layout',
    owner && owner.id);

  const res = Shortcuts.assign('tool-rect', 'Ctrl+S');
  ok(res.ok === false, 'assigning an already-used chord is refused');
  ok(/save-layout|Save layout/.test(res.reason || ''), 'the refusal names the owner',
    res.reason);
  ok(Shortcuts.get('tool-rect').keys === 'Alt+Shift+R',
    'a refused assignment leaves the old binding intact',
    Shortcuts.get('tool-rect').keys);

  /* the exception: assigning an action its OWN chord is a no-op, not a conflict */
  const same = Shortcuts.assign('save-layout', 'Ctrl+S');
  ok(same.ok === true, 're-assigning an action its own chord succeeds');

  /* and a different free chord works */
  const free = Shortcuts.assign('tool-rect', 'Ctrl+Alt+R');
  ok(free.ok === true, 'a free chord is accepted', free.reason);
  ok(Shortcuts.get('tool-rect').keys === 'Ctrl+Alt+R', 'the new chord is live');
  ok(Shortcuts.ownerOf('Alt+Shift+R') === null, 'the old chord is released');
}

/* ---------- D. overrides persist and reset ---------- */
{
  Shortcuts.resetAll();
  const saved = Shortcuts.assign('undo', 'Ctrl+U');
  ok(saved.ok, 'undo can be rebound', saved.reason);

  const raw = JSON.parse(globalThis.localStorage.getItem(KEY_STORE) || '{}');
  ok(raw['undo'] === 'Ctrl+U', 'the override is persisted under mt5_keys', JSON.stringify(raw));

  /* reload = restart the app */
  Shortcuts._wired = false;
  Shortcuts.load();
  ok(Shortcuts.get('undo').keys === 'Ctrl+U', 'the override survives a reload',
    Shortcuts.get('undo').keys);
  ok(Shortcuts.get('undo').overridden === true, 'the row is flagged as modified');

  /* reset one */
  ok(Shortcuts.reset('undo') === true, 'reset(undo) succeeds');
  ok(Shortcuts.get('undo').keys === 'Ctrl+Z', 'undo is back to its default');
  ok(Shortcuts.get('undo').overridden === false, 'the modified flag is cleared');
  ok(!('undo' in (JSON.parse(globalThis.localStorage.getItem(KEY_STORE) || '{}'))),
    'the override is removed from storage, not just from memory');

  /* resetting cannot create a conflict */
  Shortcuts.load();
  Shortcuts.assign('save-layout', 'Ctrl+Shift+P');   // free the default Ctrl+S
  Shortcuts.assign('tool-rect', 'Ctrl+S');           // now claim it
  const blocked = Shortcuts.reset('save-layout');    // default Ctrl+S is taken
  ok(blocked === false, 'resetting into a conflict is refused');
  ok(Shortcuts.get('save-layout').keys === 'Ctrl+Shift+P',
    'the blocking action keeps its binding',
    Shortcuts.get('save-layout').keys);

  /* resetAll clears everything */
  Shortcuts.resetAll();
  ok(Shortcuts.actions().every((a) => !a.overridden), 'resetAll clears every override');
  ok(Shortcuts.actions().every((a) => a.keys === a.defaultKeys), 'every action is at its default');
}

/* ---------- E. every default has a handler ---------- */
{
  Shortcuts.load();
  const fake = {
    Toolbar: {
      openSaveLayoutDialog() {},
      Snapshot: { copy() {}, download() {} },
    },
    IndicatorsUI: { openDialog() {} },
    UI: { activateTool() {}, onSelectionChanged() {} },
  };
  bindDefaultHandlers(fake);
  const unbound = Shortcuts.actions().filter((a) => !Shortcuts._handlers.has(a.id));
  ok(unbound.length === 0, 'every default shortcut id has a handler',
    unbound.map((a) => a.id).join(','));

  /* and registering an unknown id throws instead of silently doing nothing */
  let threw = false;
  try { Shortcuts.on('not-a-real-action', () => {}); } catch (e) { threw = true; }
  ok(threw, 'registering a handler for an unknown id throws');
}

/* ---------- F. the migration preserved the originals ---------- */
{
  Shortcuts.load();
  const byId = Object.fromEntries(Shortcuts.actions().map((a) => [a.id, a.keys]));
  /* These are the ten bindings that were inline in app.js before ROUND307. If a
     refactor changes one of them silently, this is the check that notices — the
     user's muscle memory is the requirement. */
  const original = {
    'indicator-dialog': '/',
    'save-layout': 'Ctrl+S',
    'snapshot-download': 'Ctrl+Alt+S',
    'snapshot-copy': 'Ctrl+Shift+S',
    'tool-rect': 'Alt+Shift+R',
    'delete-selected': 'Delete',
    undo: 'Ctrl+Z',
    redo: 'Ctrl+Y',
    'redo-alt': 'Ctrl+Shift+Z',
  };
  for (const [id, keys] of Object.entries(original)) {
    ok(byId[id] === keys, `the original binding for ${id} is preserved (${keys})`, byId[id]);
  }

  /* no two defaults may share a chord (the old inline code had to spell this
     out by hand with `!e.shiftKey` on every line) */
  const seen = new Map();
  const dupes = [];
  for (const a of Shortcuts.actions()) {
    if (seen.has(a.keys)) dupes.push(`${a.keys}: ${seen.get(a.keys)} + ${a.id}`);
    seen.set(a.keys, a.id);
  }
  ok(dupes.length === 0, 'no two default bindings collide', dupes.join(' | '));

  /* the table is the single source: app.js must no longer carry the inline code */
  const app = (await import('node:fs')).readFileSync(
    new URL('../../src/renderer/js/app.js', import.meta.url), 'utf8');
  ok(/Shortcuts\.handle\(e\)/.test(app), 'app.js dispatches through the registry');
  ok(!/e\.code === 'KeyS'/.test(app), 'the inline Ctrl+S handler is gone');
  ok(!/e\.code === 'KeyZ'/.test(app), 'the inline Ctrl+Z handler is gone');
  ok(!/e\.code === 'KeyR'/.test(app), 'the inline Alt+Shift+R handler is gone');
}

console.log(`\nROUND307 shortcuts: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
