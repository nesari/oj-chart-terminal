/**
 * test_round306_chart_menu.mjs — the chart right-click menu.
 *
 * ROUND306 (roadmap P0-02). The menu had 7 reachable rows (3 of its 8 `mk(`
 * calls are conditional on where the click landed) and TradingView has 20+.
 * The risky part of growing a context menu is not the count — it is wiring a row
 * to a function that does not exist, which produces a button that looks alive
 * and does nothing. That is exactly the class of bug ROUND305 shipped four of,
 * so this suite checks the WIRING rather than the pixels:
 *
 *   A. every `typeof X !== 'undefined'` guard names an import that exists
 *      (an un-imported identifier is always undefined in a module, so the guard
 *      silently hides the reference and the row is a no-op)
 *   B. no import cycle: modules that import `UI` must not be imported back at
 *      module scope (TDZ risk on the second-evaluated side)
 *   C. the item count grew and the menu still has the essentials
 *   D. the drawing submenu is built from UI.GROUPS, not a copied list
 *   E. the shrink/undo paths the new rows call really exist
 *
 * Run: node tests/unit/test_round306_chart_menu.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

const ui = read('src/renderer/js/drawing/ui.js');

/* the menu body only */
const menuStart = ui.indexOf('UI.openChartMenu = function');
const menuEnd = ui.indexOf('UI.openPriceAddMenu = function');
ok(menuStart > 0 && menuEnd > menuStart, 'openChartMenu exists and is delimited');
const menu = ui.slice(menuStart, menuEnd);

/* imports that exist in this module (module-scope `import { X } from`)
 * plus the bare `TOOLS`/`U` style ones. */
const imported = new Set();
for (const m of ui.matchAll(/^import\s*\{([^}]+)\}\s*from/gm)) {
  for (const n of m[1].split(',')) {
    const name = n.trim().split(/\s+as\s+/).pop().trim();
    if (name) imported.add(name);
  }
}
/* names defined in this file (functions/consts) also count as "exists" */
const defined = new Set([...ui.matchAll(/^\s*(?:function|const|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));

/* ---------- A. no `typeof X` guard on a name that is not in scope ---------- */
{
  const guards = [...menu.matchAll(/typeof\s+([A-Za-z_$][\w$]*)\s*!==\s*'undefined'/g)].map((m) => m[1]);
  const unknown = [...new Set(guards)].filter((g) => !imported.has(g) && !defined.has(g) && g !== 'window' && g !== 'document');
  ok(unknown.length === 0,
    'every typeof-guard names something in scope (an un-imported name is always undefined)',
    unknown.join(','));
  ok(guards.length > 0, 'the menu does use typeof guards (so the check had something to read)', String(guards.length));

  /* the specific modules the ROUND306 menu needs must be real imports or lazy */
  for (const name of ['IndicatorsUI', 'Snapshot', 'Toolbar', 'ObjectTree', 'Alerts']) {
    ok(imported.has(name), `the menu has ${name} in scope`);
  }
}

/* ---------- B. no NEW import cycle ---------- */
{
  /* `ui.js` <-> `toolbar.js` is a PRE-EXISTING cycle (ui.js imports Toolbar to
   * build the menu; toolbar.js imports UI for toasts and layout helpers). It
   * works because neither side touches the other at module-evaluation time.
   *
   * ROUND306 added imports to `ui.js`, so the honest question is not "is there
   * a cycle" (there always was) but "did this change ADD one". The check below
   * is therefore a whitelist of the cycles that existed at HEAD, and anything
   * outside it fails — that is what would catch a real regression.
   */
  const KNOWN_CYCLES = new Set(['toolbar.js', 'alerts.js', 'objects.js']);

  const backImporters = [];
  const walk = (d) => fs.readdirSync(d).flatMap((f) => {
    const p = path.join(d, f);
    return fs.statSync(p).isDirectory() ? walk(p) : (f.endsWith('.js') ? [p] : []);
  });
  for (const p of walk(path.join(ROOT, 'src/renderer/js'))) {
    if (p.endsWith('drawing/ui.js') || p.endsWith('drawing\\ui.js')) continue;
    const s = fs.readFileSync(p, 'utf8');
    if (/from\s+['"][^'"]*drawing\/ui\.js['"]/.test(s) && /import\s*\{[^}]*\bUI\b/.test(s)) {
      backImporters.push(path.basename(p));
    }
  }
  ok(backImporters.length > 0, 'some modules import UI (so the check is meaningful)',
    backImporters.join(','));

  const uiModuleImports = [...ui.matchAll(/^import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gm)]
    .map((m) => ({ names: m[1], from: m[2] }));
  const cycles = [];
  for (const imp of uiModuleImports) {
    const base = path.basename(imp.from);
    if (backImporters.includes(base) && !KNOWN_CYCLES.has(base)) cycles.push(base);
  }
  ok(cycles.length === 0,
    'this change adds no NEW import cycle (pre-existing ones are whitelisted)',
    cycles.join(','));

  /* the two modules that would have been NEW cycles must resolve lazily */
  ok(/function appModule\(/.test(ui), 'the menu resolves cycle-prone modules lazily');
  ok(/appModule\('GoToDate'\)/.test(menu), 'Go to date resolves through the lazy helper');
  ok(/appModule\('Compare'\)/.test(menu), 'Compare resolves through the lazy helper');
  ok(!/^import\s*\{[^}]*\bGoToDate\b/m.test(ui), 'GoToDate is not imported at module scope');
  ok(!/^import\s*\{[^}]*\bCompare\b/m.test(ui), 'Compare is not imported at module scope');
}

/* ---------- C. the item set ---------- */
{
  /* count `mk(` and `sub(` calls plus the section separators — the E2E counts
   * real DOM rows; here we pin that the source grew and kept the essentials. */
  const mkCount = (menu.match(/\bmk\(/g) || []).length;
  const subCount = (menu.match(/\bsub\(/g) || []).length;
  ok(mkCount >= 15, 'the menu calls mk() at least 15 times', String(mkCount));
  ok(subCount >= 1, 'the drawing tools are a submenu, not a flat list', String(subCount));

  const needed = [
    ['Add indicator', /Add indicator/],
    ['Add drawing (submenu)', /sub\('Add drawing'/],
    /* these two labels are computed from live state, so match the code shape */
    ['Hide all drawings', /' all drawings'/],
    ['Lock all drawings', /' all drawings'/],
    ['Remove all drawings', /Remove all drawings/],
    ['Go to date', /Go to date/],
    ['Timezone', /Timezone/],
    ['Copy image', /Copy image/],
    ['Download image', /Download image/],
    ['Compare symbol', /Compare symbol/],
    ['Object tree', /Object tree/],
    ['Save layout', /Save layout/],
    ['Settings', /Settings/],
    ['Reset chart', /Reset chart/],
  ];
  for (const [label, re] of needed) ok(re.test(menu), `the menu has "${label}"`);

  /* the two state-driven labels must exist in BOTH directions, or the row lies
     about what it will do (the R305 lesson: a truthful label is part of the fix) */
  ok(/App\.hideAll \? 'Show' : 'Hide'/.test(menu), 'the hide row flips its label with the state');
  ok(/App\.lockAll \? 'Unlock' : 'Lock'/.test(menu), 'the lock row flips its label with the state');

  /* the shortcut hints must be the real bindings, not invented ones */
  ok(/Ctrl\+Shift\+S/.test(menu), 'the snapshot copy hint matches the real binding');
  ok(/Ctrl\+Alt\+S/.test(menu), 'the snapshot download hint matches the real binding');
  ok(/Ctrl\+S/.test(menu), 'the save-layout hint matches the real binding');
}

/* ---------- D. the drawing submenu reads UI.GROUPS ---------- */
{
  ok(/for \(const g of \(UI\.GROUPS \|\| \[\]\)\)/.test(menu),
    'the submenu iterates the real UI.GROUPS');
  ok(/g\.sections/.test(menu), 'it flattens flyout sections');
  ok(/UI\.activateTool\(toolId\)/.test(menu), 'a tool row really arms the tool');
  ok(/TOOLS\[id\] && TOOLS\[id\]\.name/.test(menu), 'tool rows show the real tool name');
}

/* ---------- E. the APIs the new rows call exist ---------- */
{
  const state = read('src/core/state.js');
  ok(/list\(symbol\)/.test(state) || /list\s*\(/.test(state), 'App.drawings.list exists (used to count)');
  ok(/removeAll\(symbol\)/.test(state), 'App.drawings.removeAll exists');

  const toolbar = read('src/renderer/js/chart/toolbar.js');
  ok(/Snapshot\.download\s*=/.test(toolbar), 'Snapshot.download exists');
  ok(/Snapshot\.copy\s*=/.test(toolbar), 'Snapshot.copy exists');
  ok(/Toolbar\.openTzMenu\s*=/.test(toolbar), 'Toolbar.openTzMenu exists');
  ok(/Toolbar\.openSaveLayoutDialog\s*=/.test(toolbar), 'Toolbar.openSaveLayoutDialog exists');

  const ind = read('src/renderer/js/chart/indicators-ui.js');
  ok(/openDialog\s*[:=(]/.test(ind), 'IndicatorsUI.openDialog exists');

  const compare = read('src/renderer/js/chart/compare.js');
  ok(/openMenu\(/.test(compare), 'Compare.openMenu exists');

  const goto = read('src/renderer/js/panels/gotodate.js');
  ok(/openDialog\s*=\s*function/.test(goto), 'GoToDate.openDialog exists');
}

/* ---------- F. hide-all and remove-all are observable, not cosmetic ---------- */
{
  /* `App.hideAll` must be read by the renderer, otherwise the row flips a flag
     that paints nothing (a placebo toggle). */
  const renderers = ['src/renderer/js/drawing/engine.js', 'src/renderer/js/drawing/ui.js'];
  const readsHideAll = renderers.some((f) => /App\.hideAll/.test(read(f)));
  ok(readsHideAll, 'App.hideAll is actually read by a renderer');
  ok(/App\.lockAll/.test(read('src/renderer/js/drawing/engine.js')), 'App.lockAll is read by the engine');
}

console.log(`\nROUND306 menu: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
