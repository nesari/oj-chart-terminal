import { readSource } from './source-utils.mjs';
/**
 * Saved-layout storage hardening.
 *
 * `mt5_saved_layouts` is localStorage data: it can be missing, written by an
 * older build, or hand-edited. The layout menu used to assume it was always
 * an array of `{name, at, data}` records and interpolated every name into
 * innerHTML unescaped, so:
 *   - a non-array value crashed Save / Open / Rename / Recently used
 *     (.slice / .filter / .sort on a string or object);
 *   - a name containing markup executed inside the popup;
 *   - a saved pane without a symbol was copied straight into mt5_boot_panes.
 * All three are source contracts plus a small mirror of the list rules.
 */
let N = 0, BAD = 0;
function check(name, cond) {
  N++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name);
  if (!cond) BAD++;
}

const tb = readSource('src/renderer/js/chart/toolbar.js');

console.log('— saved layout storage —');
check('one validating reader rejects non-arrays and nameless records',
  /function savedLayouts\(\) \{[\s\S]{0,260}?if \(!Array\.isArray\(raw\)\) return \[\];[\s\S]{0,200}?typeof s\.name === 'string'/.test(tb));
check('writes are sanitised and capped at 20',
  /function setSavedLayouts\(list\) \{[\s\S]{0,260}?typeof s\.name === 'string'[\s\S]{0,120}?\.slice\(-20\)/.test(tb));
check('no raw storage read remains outside the helper',
  (tb.match(/U\.lsGet\('mt5_saved_layouts'/g) || []).length === 1);
check('no raw storage write remains outside the helper',
  (tb.match(/U\.lsSet\('mt5_saved_layouts'/g) || []).length === 1);
check('invalid timestamps render as an empty label instead of NaN',
  /function savedLayoutWhen\(at\) \{[\s\S]{0,220}?!isFinite\(d\.getTime\(\)\)\) return ''/.test(tb));

console.log('— names never reach innerHTML —');
check('LAYOUTS rows set the name through textContent',
  /const nm = U\.el\('span', '', it\);\s*\n\s*nm\.textContent = s\.name;/.test(tb));
check('RECENTLY USED rows set the name through textContent',
  /U\.el\('span', 'sl-rname', it\)\.textContent = s\.name;/.test(tb));
check('name dialog assigns the input value as a property (no value="" breakout)',
  /inp\.value = typeof defName === 'string' \? defName : '';/.test(tb) &&
  !/id="ln-name"[^>]*value="\$\{defName\}"/.test(tb));
check('copy/rename toasts escape the user-provided name',
  /Layout copied as “\$\{U\.esc\(name\)\}”/.test(tb) &&
  /Layout renamed to “\$\{U\.esc\(name\)\}”/.test(tb));

console.log('— loading a saved layout —');
check('a record without a usable name is refused',
  /if \(!s \|\| typeof s\.name !== 'string' \|\| !s\.name\.trim\(\)\) \{[\s\S]{0,120}?Could not load this layout/.test(tb));
check('panes are validated before being written to mt5_boot_panes',
  /Array\.isArray\(d\.panes\)[\s\S]{0,160}?filter\(\(p\) => p && typeof p === 'object' && p\.symbol\)[\s\S]{0,700}?if \(panes\.length\) U\.lsSet\('mt5_boot_panes'/.test(tb));
check('styles are written from the validated pane list, not the raw one',
  /U\.lsSet\('mt5_styles_' \+ layId, panes\.map\(\(p\) => p\.style\)\)/.test(tb));
check('an unknown saved layout id is normalised through App.layoutById',
  /const layId = App\.layoutById\(d\.layout \|\| App\.layout\)\.id;[\s\S]{0,200}?U\.lsSet\('mt5_styles_' \+ layId/.test(tb));
check('Create new layout drops the tab strip store (no old tabs on reload)',
  /U\.lsSet\('mt5_boot_panes', null\);[\s\S]{0,260}?U\.lsSet\('mt5_tabs', null\);/.test(tb));

console.log('— mirror of the list rules —');
{
  const norm = (raw) => {
    if (!Array.isArray(raw)) return [];
    return raw.filter((s) => s && typeof s === 'object' &&
      typeof s.name === 'string' && !!s.name.trim());
  };
  check('mirror: a string/object/null store collapses to []',
    norm('oops').length === 0 && norm({ name: 'x' }).length === 0 && norm(null).length === 0);
  check('mirror: nameless, blank and primitive entries are dropped',
    norm([{ name: 'A' }, null, 5, { name: '   ' }, { at: 1 }, { name: 42 }])
      .map((s) => s.name).join(',') === 'A');
  check('mirror: the cap keeps the newest 20 entries',
    (() => {
      const out = Array.from({ length: 25 }, (_, i) => ({ name: 'L' + i })).slice(-20);
      return out.length === 20 && out[0].name === 'L5' && out[19].name === 'L24';
    })());
}

console.log(`\nLAYOUT STORAGE: ${N} passed, ${BAD} failed.`);
process.exit(BAD ? 1 : 0);
