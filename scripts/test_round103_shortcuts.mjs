/**
 * ROUND103 — the text-entry guard that keeps chart shortcuts out of inputs.
 * Mirrors U.isTyping + the app.js dispatch rules (no DOM needed).
 */
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n); } };

function isTyping(target) {
  if (!target || !target.tagName) return false;
  const tag = String(target.tagName).toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  return target.isContentEditable === true;
}
const el = (tag, ce) => ({ tagName: tag.toUpperCase(), isContentEditable: !!ce });

ok('an input is a typing surface', isTyping(el('input')));
ok('a textarea is a typing surface', isTyping(el('textarea')));
ok('a select is a typing surface', isTyping(el('select')));
ok('a contenteditable div is a typing surface', isTyping(el('div', true)));
ok('a plain div is not', !isTyping(el('div')));
ok('a canvas is not', !isTyping(el('canvas')));
ok('a button is not', !isTyping(el('button')));
ok('a null target is not', !isTyping(null));

/* dispatch: only the guarded combos change behaviour, and only in inputs */
function fires(e, target) {
  const typing = isTyping(target);
  if (!typing && e.key === 'Delete' && e.hasSelection) return 'delete-drawing';
  if (!typing && e.ctrlKey && e.code === 'KeyZ') return 'undo-drawing';
  if (!typing && e.ctrlKey && e.code === 'KeyY') return 'redo-drawing';
  if (!typing && e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyS') return 'save-layout';
  return null;
}
const canvas = el('canvas'), input = el('input');
const del = { key: 'Delete', hasSelection: true };
const czz = { ctrlKey: true, code: 'KeyZ' };
const cs = { ctrlKey: true, code: 'KeyS' };

ok('Delete over the chart still deletes the drawing', fires(del, canvas) === 'delete-drawing');
ok('Delete inside an input no longer deletes the drawing', fires(del, input) === null);
ok('Ctrl+Z over the chart still undoes the drawing', fires(czz, canvas) === 'undo-drawing');
ok('Ctrl+Z inside an input falls through to native text undo', fires(czz, input) === null);
ok('Ctrl+S over the chart still opens Save Layout', fires(cs, canvas) === 'save-layout');
ok('Ctrl+S inside an input does not open Save Layout', fires(cs, input) === null);
ok('Delete with no selection is inert anywhere', fires({ key: 'Delete', hasSelection: false }, canvas) === null);

console.log('\nround103 shortcut guards: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
