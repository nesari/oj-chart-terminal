/**
 * test_round305_command_sources.mjs — the palette's CONTENT.
 *
 * `command.js` (engine) is covered by `test_round305_command_palette.mjs`. This
 * suite covers the sources, which is where the interesting failure lives: a
 * source that reads the wrong property returns an EMPTY array, the palette opens
 * fine and shows nothing. That is silent. It is also exactly what happened while
 * writing this: `Indicators.catalogAll()` does not exist (the facade exposes
 * `Indicators.all` as an array), so the first version produced zero indicator
 * commands and every test still passed.
 *
 * So every assertion here is "the source found the real thing", not "the
 * function returned something":
 *   A. symbols come from the watchlist AND the feed AND open panes, de-duped
 *   B. timeframes come from the live list (including custom intervals)
 *   C. styles come from App.STYLES
 *   D. indicators come from Indicators.all — the actual facade shape
 *   E. panels come from the DOM tab strip, not a hard-coded list
 *   F. drawing tools come from UI.GROUPS, one command per tool id
 *   G. verbs are registered only when their module can actually do the thing
 *   H. running a command reaches the right API (setSymbol/setStyle/setTf)
 *
 * Run: node tests/unit/test_round305_command_sources.mjs
 */

/* ---- minimal DOM stub (same shape as the engine suite) ---- */
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
const TABS = ['watchlist', 'alerts', 'objects', 'trade', 'tester', 'datawindow', 'timesales', 'diagnostics', 'news'];
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: (sel) => (sel.includes('rt-btn') ? TABS.map((t) => ({ dataset: { tab: t } })) : []),
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
  };
})();

const { Command } = await import('../../src/renderer/js/ui/command.js');
const { registerAll, wireSources, PANEL_TITLES } = await import('../../src/renderer/js/ui/command-sources.js');
const { App } = await import('../../src/core/state.js');

/* `drawing/ui.js` is a canvas module — importing it in Node pulls in `Image`
 * and a dozen DOM dependencies. The SUITE only needs GROUPS, which is a static
 * table, so it is parsed out of the source instead (the same trick
 * `source-utils.mjs` uses for the schema table). This also keeps the assertion
 * honest: it reads the table the toolbar really builds from. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/js/drawing/ui.js'), 'utf8').replace(/\r\n/g, '\n');
const groupsSrc = /const GROUPS = \[([\s\S]*?)\n  \];/.exec(uiSrc)[1];

/* Decode just enough of the literal: `{ id: 'x', base: 'y', tools: [...] }` and
 * the `sections: [{ title, tools: [...] }]` form. */
const GROUPS = [];
{
  const groupRe = /\{ id: '([a-z0-9_]+)'([\s\S]*?)\n    \] \},|\{ id: '([a-z0-9_]+)', tools: \[([^\]]*)\] \},/g;
  /* simpler and more robust: split on `{ id:` and read the tools arrays */
  const parts = groupsSrc.split(/\{ id: '/).slice(1);
  for (const p of parts) {
    const id = p.slice(0, p.indexOf("'"));
    const tools = [];
    for (const m of p.matchAll(/tools:\s*\[([^\]]*)\]/g)) {
      for (const t of m[1].matchAll(/'([A-Za-z0-9_]+)'/g)) tools.push(t[1]);
    }
    GROUPS.push({ id, tools, sections: [] });
  }
}

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ok ' + label); }
  else { fail++; console.log('  FAIL: ' + label + (extra === undefined ? '' : ' — ' + extra)); }
};

const reset = () => {
  Command.list = [];
  Command._byId = new Map();
  Command.resetRecent();
};
const ids = () => Command.list.map((c) => c.id);
const group = (g) => Command.list.filter((c) => c.group === g);

/* ---------- fakes for every module the sources may reach ---------- */
const calls = [];
/* The sources act on `App.activePane`. In the real app boot always has one; in
 * a bare Node import it is null, and a command that silently does nothing
 * because there is no pane is indistinguishable from a broken command. So the
 * suite gives it a stub pane — the same one a real chart would be. */
const fakePane = { symbol: 'EURUSD', tf: 'M5', digits: 5, style: 'candles' };
App.activePane = fakePane;
App.panes = [fakePane];

const fakeManager = {
  setSymbol: (p, s) => calls.push(['setSymbol', s]),
  setTf: (p, t) => calls.push(['setTf', t]),
  setStyle: (p, s) => calls.push(['setStyle', s]),
};
const fakeUI = { activateTool: (id) => calls.push(['activateTool', id]), GROUPS };
const fakeRight = { showTab: (t) => calls.push(['showTab', t]) };
const fakeInd = {
  /* the REAL facade shape: `all` is an array of { type, scriptId, label } */
  all: [
    { type: 'rsi', label: 'RSI' },
    { type: 'macd', label: 'MACD' },
  ],
  add: (p, t) => calls.push(['indicatorAdd', t]),
};

function wire(extra = {}) {
  wireSources({
    Manager: fakeManager,
    UI: fakeUI,
    RightPanel: fakeRight,
    indicators: fakeInd,
    IndicatorsUI: { openDialog: () => calls.push(['openDialog']) },
    timeframes: () => App.tf,
    panelTabs: () => TABS,
    drawGroups: () => GROUPS,
    toolName: (id) => id,
    ...extra,
  });
}

/* ---------- A. symbols ---------- */
{
  reset();
  App.watchlist = ['EURUSD', 'GBPUSD'];
  App.feed = { symbols: ['USDJPY', 'XAUUSD', 'EURUSD'] }; /* EURUSD repeats on purpose */
  App.panes = [{ symbol: 'BTCUSD' }];
  wire();
  registerAll();

  const syms = group('Symbol');
  const names = syms.map((c) => c.title);
  ok(names.includes('EURUSD'), 'a watchlist symbol is present');
  ok(names.includes('USDJPY'), 'a feed symbol is present');
  ok(names.includes('BTCUSD'), 'a symbol already open on a pane is present');
  ok(names.filter((n) => n === 'EURUSD').length === 1, 'a symbol listed twice appears once');

  calls.length = 0;
  Command.run('symbol:GBPUSD');
  ok(calls.some((c) => c[0] === 'setSymbol' && c[1] === 'GBPUSD'),
    'running a symbol command calls Manager.setSymbol', JSON.stringify(calls));

  /* a feed with no symbol list must not throw — the source degrades */
  reset();
  App.feed = {};
  wire();
  let threw = false;
  try { registerAll(); } catch (e) { threw = true; }
  ok(!threw, 'a feed without a symbol list does not throw');
  ok(group('Symbol').length > 0, 'watchlist symbols still register without a feed list');
}

/* ---------- B. timeframes ---------- */
{
  reset();
  App.feed = { symbols: [] };
  wire();
  registerAll();
  const tfs = group('Timeframe');
  ok(tfs.length === App.tf.length, 'one command per live timeframe',
    `${tfs.length} vs ${App.tf.length}`);
  ok(tfs.some((c) => c.id === 'tf:M5'), 'the M5 timeframe is present');

  calls.length = 0;
  Command.run('tf:M15');
  ok(calls.some((c) => c[0] === 'setTf' && c[1] === 'M15'), 'running a TF command switches the timeframe');

  /* custom intervals are the reason this reads App.tf instead of a constant */
  App.addCustomTf(90, 'm');
  reset();
  wire();
  registerAll();
  const custom = group('Timeframe').find((c) => /90m/.test(c.title));
  ok(!!custom, 'a user-created custom interval appears in the palette',
    group('Timeframe').map((c) => c.title).join(','));
}

/* ---------- C. styles ---------- */
{
  reset();
  wire();
  registerAll();
  const styles = group('Chart style');
  ok(styles.length === App.STYLES.length, 'one command per chart style',
    `${styles.length} vs ${App.STYLES.length}`);
  const renko = styles.find((c) => c.title === 'Renko');
  ok(!!renko, 'Renko is a searchable command');

  calls.length = 0;
  Command.run('style:renko');
  ok(calls.some((c) => c[0] === 'setStyle' && c[1] === 'renko'),
    'running the Renko command calls Manager.setStyle(pane, "renko")', JSON.stringify(calls));

  /* and the search reaches it the way a user types */
  ok(Command.search('renko').some((c) => c.id === 'style:renko'), 'typing "renko" finds it');
}

/* ---------- D. indicators ---------- */
{
  reset();
  wire();
  registerAll();
  const inds = group('Indicators');
  ok(inds.length === 2, 'one command per indicator in Indicators.all', String(inds.length));
  ok(inds.some((c) => c.id === 'indicator:rsi'), 'RSI is registered');
  ok(inds[0].title.startsWith('Add '), 'the title reads as an action', inds[0] && inds[0].title);

  calls.length = 0;
  Command.run('indicator:macd');
  ok(calls.some((c) => c[0] === 'indicatorAdd' && c[1] === 'macd'),
    'running an indicator command adds it to the pane');

  /* the regression this suite exists for: a facade WITHOUT `all` used to yield
     zero commands silently. The source must accept either shape and never
     pretend success by returning an empty list from a typo. */
  reset();
  wire({ indicators: { catalogAll: undefined, all: undefined } });
  registerAll();
  ok(group('Indicators').length === 0, 'an indicator facade with no catalog yields no commands (visible, not fake)');
}

/* ---------- E. panels ---------- */
{
  reset();
  wire();
  registerAll();
  const panels = group('Panels');
  ok(panels.length === TABS.length, 'one command per right-panel tab',
    `${panels.length} vs ${TABS.length}`);
  ok(panels.some((c) => c.id === 'panel:watchlist'), 'the watchlist tab is present');
  ok(panels.every((c) => c.title.startsWith('Open ')), 'panel titles read as actions');
  /* every tab must have a friendly title, not a raw id */
  const raw = panels.filter((c) => c.title === 'Open ' + c.id.replace('panel:', ''));
  ok(raw.length === 0, 'every panel has a human title', raw.map((c) => c.id).join(','));

  calls.length = 0;
  Command.run('panel:tester');
  ok(calls.some((c) => c[0] === 'showTab' && c[1] === 'tester'), 'running a panel command opens that tab');
}

/* ---------- F. drawing tools ---------- */
{
  reset();
  wire();
  registerAll();
  const tools = group('Drawing tools');

  /* the count must match the toolbar's UNIQUE tools, not the raw reference
     count: five tools (the four pitchforks + Arrow) are deliberately listed in
     two flyouts, so `UI.GROUPS` names 91 entries for 86 tools. The palette keys
     by id, so duplicates collapse — that is the correct behaviour and this
     assertion pins it. */
  const refs = GROUPS.reduce((n, g) => n + g.tools.length, 0);
  const unique = new Set(GROUPS.flatMap((g) => g.tools));
  ok(refs > unique.size, 'some tools are intentionally listed in two flyouts',
    `${refs} refs, ${unique.size} unique`);
  ok(tools.length === unique.size, 'one command per UNIQUE drawing tool',
    `${tools.length} vs ${unique.size}`);
  ok(tools.length > 80, 'the whole tool set is reachable (86 tools today)', String(tools.length));

  /* sections are flattened: a tool inside a flyout section must be findable */
  ok(tools.some((c) => c.id === 'tool:pitchfork'), 'a tool nested in a flyout section is registered');
  ok(tools.some((c) => c.id === 'tool:fib'), 'a base tool is registered');

  calls.length = 0;
  Command.run('tool:rect');
  ok(calls.some((c) => c[0] === 'activateTool' && c[1] === 'rect'), 'running a tool command arms it');
}

/* ---------- G. verbs only when they can act ---------- */
{
  reset();
  /* no modules injected -> no verb commands, rather than dead buttons */
  wireSources({ timeframes: () => App.tf, panelTabs: () => TABS, drawGroups: () => [], indicators: null });
  registerAll();
  ok(group('Actions').length === 0, 'with no modules, no verb commands are registered (no dead rows)');

  reset();
  const fake = {
    Toolbar: {
      openSymbolSearch: () => calls.push(['symbolSearch']),
      openSaveLayoutDialog: () => calls.push(['saveLayout']),
      openAlertDialog: () => calls.push(['alert']),
      Snapshot: { copy: () => calls.push(['snapCopy']), download: () => calls.push(['snapDown']) },
    },
    Settings: { open: () => calls.push(['settings']) },
    Theme: { toggle: () => calls.push(['theme']) },
    IndicatorsUI: { openDialog: () => calls.push(['openDialog']) },
    PineEditor: { open: () => calls.push(['pine']) },
    Replay: { toggle: () => calls.push(['replay']) },
    GoToDate: { openDialog: () => calls.push(['goto']) },
    Compare: { openMenu: () => calls.push(['compare']) },
    DrawSettings: { open: () => calls.push(['drawSettings']) },
    timeframes: () => App.tf,
    panelTabs: () => TABS,
    drawGroups: () => [],
    indicators: null,
  };
  wireSources(fake);
  registerAll();
  const acts = group('Actions');
  ok(acts.length > 8, 'with modules present, the verbs register', String(acts.length));

  /* the shortcuts shown must be the ones the app really honours */
  const save = acts.find((c) => c.id === 'action:save-layout');
  ok(save && save.keys === 'Ctrl+S', 'Save layout shows Ctrl+S (the real binding)');
  const snap = acts.find((c) => c.id === 'action:snapshot-download');
  ok(snap && snap.keys === 'Ctrl+Alt+S', 'Snapshot download shows Ctrl+Alt+S (the real binding)');

  calls.length = 0;
  for (const id of ['action:theme', 'action:snapshot-copy', 'action:settings', 'action:compare']) {
    Command.run(id);
  }
  ok(calls.some((c) => c[0] === 'theme') && calls.some((c) => c[0] === 'snapCopy')
    && calls.some((c) => c[0] === 'settings') && calls.some((c) => c[0] === 'compare'),
    'each verb reaches its own module', JSON.stringify(calls));
}

/* ---------- H. a full registry looks like a palette ---------- */
{
  reset();
  wire({ Toolbar: { openAlertDialog() {}, Snapshot: { copy() {}, download() {} } } });
  const report = registerAll();
  const total = Command.list.length;
  ok(total > 120, 'the full registry is substantial (one palette, not a menu)', String(total));
  ok(report.symbol > 0 && report.timeframe > 0 && report.style > 0
    && report.indicator > 0 && report.panel > 0 && report.tool > 0,
    'every source contributed', JSON.stringify(report));

  /* no duplicate ids across sources */
  const seen = new Set();
  const dupes = [];
  for (const c of Command.list) {
    if (seen.has(c.id)) dupes.push(c.id);
    seen.add(c.id);
  }
  ok(dupes.length === 0, 'command ids are globally unique', dupes.join(','));

  /* rebuilding must not grow the registry */
  const before = Command.list.length;
  registerAll();
  ok(Command.list.length === before, 'a second registerAll() is idempotent',
    `${before} -> ${Command.list.length}`);

  /* every command can be found by typing its own title */
  const unfindable = Command.list.filter((c) => !Command.search(c.title).some((x) => x.id === c.id));
  ok(unfindable.length === 0, 'every command is findable by its own title',
    unfindable.slice(0, 5).map((c) => c.title).join(' | '));
}

console.log(`\nROUND305 sources: ${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
