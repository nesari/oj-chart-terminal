/**
 * ROUND121 — chart tabs (TradingView-Desktop / Windows-11 style):
 *   · a strip ABOVE the top toolbar, one tab per chart page, each tab an
 *     INDEPENDENT layout (its own symbol set) — TV Desktop parity
 *   · "+" (Ctrl+T) clones the active chart into a new tab + opens the symbol
 *     picker scoped to the new tab; Ctrl+W closes
 *   · switching = Manager.setLayout(layoutId, false, EXPLICIT panes) — the
 *     same machinery as a layout switch, so every subsystem that already
 *     survives layouts (trade overlay, floating panel designation, drawings,
 *     indicators, Pine) survives tabs unchanged
 *   · Windows-11 interactions: hover ✕, middle-click close, drag reorder,
 *     context menu (Duplicate / Close others / Close to the right / Close)
 *   · the LAST tab closes into a fresh default chart (never an empty grid)
 *   · persists under mt5_tabs {v:1, tabs, active}; first run ADOPTS the live
 *     chart as tab 1 — zero behaviour change for existing users
 *
 * Source contracts + small behavioral mirrors, the same style as the
 * round-102..120 suites.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => fs.readFileSync(ROOT + p, 'utf8');
let N = 0, BAD = 0;
function check(name, cond, extra) {
  N++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + ((!cond && extra !== undefined) ? ' — ' + extra : ''));
  if (!cond) BAD++;
}

const tabs = read('src/renderer/js/chart/tabs.js');
const mgr = read('src/renderer/js/chart/manager.js');
const tb = read('src/renderer/js/chart/toolbar.js');
const app = read('src/renderer/js/app.js');
const html = read('src/renderer/index.html');
const css = read('src/renderer/css/app.css');

console.log('— ROUND121 · module + state model —');
check('tabs.js is a real ES module exporting Tabs',
  /@module chart\/tabs/.test(tabs) && /export \{ Tabs \};/.test(tabs));
check('records: { id, layout, panes[{symbol,tf,style,indicators?,pineScripts?}] } persisted under mt5_tabs v1 (host) / mt5_tab_solo_<id> (detached, round 122)',
  /key: 'mt5_tabs'/.test(tabs) && /v: 1/.test(tabs) &&
  /U\.lsSet\(SOLO_ID \? STORE_KEY : K\.key, \{ v: K\.v, tabs: this\.list, active: this\.activeId \}\)/.test(tabs) &&
  /const STORE_KEY = SOLO_ID \? 'mt5_tab_solo_' \+ SOLO_ID : K\.key;/.test(tabs));
check('validRec rejects broken records (id + layout + ≥1 symbol-bearing pane)',
  /function validRec\(r\) \{[\s\S]*?r\.id && r\.layout && Array\.isArray\(r\.panes\)[\s\S]*?r\.panes\[0\] && r\.panes\[0\]\.symbol/.test(tabs));
check('first run ADOPTS the live chart as tab 1 (zero behaviour change on upgrade)',
  /this\.list = \[this\._adoptRec\(\)\];/.test(tabs) &&
  /_adoptRec\(\) \{[\s\S]*?App\.panes\.length \? this\.snapshotPanes\(\) : \[\{ symbol: 'EURUSD'/.test(tabs));
check('snapshot serialization matches the setLayout keep-shape (indicators + Pine ride along)',
  /snapshotPanes\(\) \{[\s\S]*?symbol: p\.symbol, tf: p\.tf, style: p\.style,[\s\S]*?indicators: \(p\.indicators \|\| \[\]\)\.map[\s\S]*?pineScripts: Manager\.serializePine \? Manager\.serializePine\(p\) : undefined/.test(tabs));

console.log('— ROUND121 · switching machinery —');
check('restore goes through Manager.setLayout(layout, false, EXPLICIT panes) — the layout-switch path',
  /_restore\(rec\) \{[\s\S]*?Manager\.setLayout\(\(rec && rec\.layout\) \|\| '1', false, panes\)/.test(tabs));
check('manager honours the explicit pane array over mt5_boot_panes',
  /Array\.isArray\(explicitPanes\) && explicitPanes\.length\s*\?\s*\{ layout: spec\.id, panes: explicitPanes \}/.test(mgr));
check('activate captures the live state into ITS record before leaving',
  /activate\(id\) \{[\s\S]*?this\.capture\(\);[\s\S]*?this\.activeId = id;[\s\S]*?this\._restore\(target\)/.test(tabs));
check('capture stores the CURRENT layout id (layouts changed inside a tab are remembered)',
  /capture\(\) \{[\s\S]*?rec\.layout = App\.layout \|\| '1';[\s\S]*?rec\.panes = this\.snapshotPanes\(\)/.test(tabs));
check('closing the ACTIVE tab never captures the dying record (no stale overwrite)',
  /closeTab\(id\) \{[\s\S]*?const wasActive = id === this\.activeId;[\s\S]*?this\.list\.splice\(idx, 1\);/.test(tabs) &&
  !/this\.capture\(\)/.test(tabs.slice(tabs.indexOf('closeTab(id) {'), tabs.indexOf('duplicate(id) {'))));
check('closing the last tab lands on a fresh default chart (never an empty grid)',
  /if \(!this\.list\.length\) \{[\s\S]*?panes: \[\{ symbol: 'EURUSD', tf: 'M1', style: 'candles' \}\]/.test(tabs));
check('neighbour activation on close: right first, then left',
  /const next = this\.list\[idx\] \|\| this\.list\[idx - 1\];/.test(tabs));

console.log('— ROUND121 · record freshness (edits survive quit without a tab switch) —');
check('the 700ms tick runs the dirty-checked capture (_syncTick) beside renderTitles',
  /this\._titleTimer = setInterval\(\(\) => \{ try \{ this\.renderTitles\(\); this\._syncTick\(\); \} catch \(e\) \{\} \}, 700\);/.test(tabs));
check('_syncTick guards: no active tab, empty panes (mid-rebuild/boot), missing record',
  /_syncTick\(\) \{[\s\S]*?if \(!this\.activeId \|\| !App\.panes\.length\) return;[\s\S]*?if \(!rec\) return;/.test(tabs));
check('_syncTick persists ONLY when the serialized state actually changed (no idle writes)',
  /_syncTick\(\) \{[\s\S]*?if \(a === b\) return;[\s\S]*?rec\.layout = next\.layout;[\s\S]*?rec\.panes = next\.panes;[\s\S]*?this\._persist\(\);/.test(tabs));
check('beforeunload captures the active tab (quit keeps the last edits)',
  /window\.addEventListener\('beforeunload', \(\) => \{[\s\S]*?try \{ this\.capture\(\); \} catch \(e\) \{\}[\s\S]*?\}\);/.test(tabs));
check('freshness (_syncTick span) never releases feed refs nor touches manager hot paths',
  !/releaseSub/.test(tabs.slice(tabs.indexOf('_syncTick() {'), tabs.indexOf('onTick(symbol, price) {'))));

console.log('— ROUND121 · the "+" flow (TV parity) —');
check('new tabs open single-chart, cloned from the active chart (symbol/tf/style)',
  /create\(symbol\) \{[\s\S]*?layout: '1'[\s\S]*?symbol: symbol \|\| \(src \? src\.symbol : 'EURUSD'\)/.test(tabs) &&
  /tf: src \? src\.tf : 'M1'/.test(tabs) && /style: src \? src\.style : App\.style/.test(tabs));
check('the + button opens the symbol picker scoped to the NEW tab (onPick re-symbols it)',
  /newFromPicker\(\) \{[\s\S]*?this\.create\(\);[\s\S]*?Toolbar\.openSymbolSearch\(\(sym\) => \{[\s\S]*?Manager\.setSymbol\(App\.activePane, sym\)/.test(tabs));
check('toolbar picker: onPick branch + legacy default branch (existing callers untouched)',
  /if \(typeof onPick === 'function'\) onPick\(s\);\s*\n\s*else if \(App\.activePane\) Manager\.setSymbol\(App\.activePane, s\);/.test(tb));

console.log('— ROUND121 · Windows-11 interactions —');
check('middle-click closes a tab (auxclick button 1)',
  /el\.addEventListener\('auxclick', \(e\) => \{\s*\n\s*if \(e\.button === 1\)/.test(tabs));
check('context menu: Duplicate / Close others / Close to the right / Close',
  /\['Duplicate', \(\) => this\.duplicate\(id\)\]/.test(tabs) &&
  /\['Close others', \(\) => this\.closeOthers\(id\)\]/.test(tabs) &&
  /\['Close to the right', \(\) => this\.closeToRight\(id\)\]/.test(tabs) &&
  /\['Close', \(\) => this\.closeTab\(id\)\]/.test(tabs));
check('closeToRight safely LEAVES a dying active tab first (activate before slicing)',
  /closeToRight\(id\) \{[\s\S]*?if \(dying\.some\(\(t\) => t\.id === this\.activeId\)\) this\.activate\(id\);[\s\S]*?this\.list = this\.list\.slice\(0, idx \+ 1\);/.test(tabs));
check('drag reorder: HTML5 DnD with a before/after drop edge',
  /el\.addEventListener\('dragstart'/.test(tabs) && /el\.addEventListener\('dragover'/.test(tabs) &&
  /el\.addEventListener\('drop'/.test(tabs) && /this\._reorder\(this\._dragId, t\.id, before\)/.test(tabs));
check('keyboard: Ctrl+T new tab / Ctrl+W close, guarded against typing + dialogs',
  /e\.code !== 'KeyT' && e\.code !== 'KeyW'/.test(tabs) &&
  /U\.isTyping\(e\.target\)/.test(tabs) &&
  /draw-settings-dialog|save-layout-dialog|sym-dialog/.test(tabs));
check('close ✕ appears on hover/active only (CSS) and never activates the tab on mousedown',
  /\.tab-item:hover \.t-close, \.tab-item\.active \.t-close \{ opacity: 1; \}/.test(css) &&
  /if \(e\.button === 0 && !e\.target\.closest\('\.t-close'\)\) this\.activate\(t\.id\);/.test(tabs));
check('a11y: role=tablist / role=tab / aria-selected',
  /role="tablist"/.test(html) && /setAttribute\('role', 'tab'\)/.test(tabs) &&
  /aria-selected/.test(tabs));

console.log('— ROUND121 · shell wiring —');
check('index.html: the strip sits ABOVE #top-toolbar inside #app',
  /<div id="app"[^>]*>[\s\S]*?<div id="tab-strip"[\s\S]*?<header id="top-toolbar">/.test(html));
check('strip = #tab-list + #tab-add-btn (both owned by tabs.js)',
  /<div id="tab-list"[^>]*><\/div>/.test(html) && /<button class="tab-add" id="tab-add-btn"/.test(html));
check('app.js imports Tabs and inits it AFTER Manager.init (adopt/restore needs live panes)',
  /import \{ Tabs \} from '\.\/chart\/tabs\.js';/.test(app) &&
  /Manager\.init\(\);[\s\S]*?Tabs\.init\(\);/.test(app));
check('Tabs exposed on the __app debug/test facade',
  /App, Manager, Toolbar, Snapshot, Tabs, UI, Watchlist/.test(app));
check('CSP-safe: no inline style= attributes injected by tabs.js (CSSOM positioning only)',
  !/style="/.test(tabs) && /m\.style\.left = /.test(tabs) && /m\.style\.top = /.test(tabs));
check('feed parity: the rebuild path stays byte-identical to layout switching — releaseSub CODE lives ONLY in the label-sub reconciler (_reconcileSubs), never in the switch machinery',
  (() => {
    const code = tabs.replace(/\/\*[\s\S]*?\*\//g, ''); // comments may mention the API; only CODE counts
    const a = code.indexOf('_reconcileSubs() {');
    const b = code.indexOf('_refreshBases() {');
    if (a < 0 || b <= a) return false;
    const labelBody = code.slice(a, b);
    const outside = code.slice(0, a) + code.slice(b);
    return /Manager\.releaseSub/.test(labelBody) && !/releaseSub/.test(outside);
  })());

console.log('— ROUND121 · Win11 visual contracts (CSS) —');
check('rounded top corners + transparent-to-toolbar active fusion (margin-bottom -1px)',
  /border-radius: 7px 7px 0 0;/.test(css) && /\.tab-item\.active \{[\s\S]*?margin-bottom: -1px;/.test(css));
check('strip darker than the toolbar (var(--bg)) vs active tab var(--panel)',
  /#tab-strip \{[\s\S]*?background: var\(--bg\);/.test(css));
check('hairline separators between inactive neighbours, hidden around hover/active',
  /\.tab-item \+ \.tab-item::before \{/.test(css) &&
  /\.tab-item\.active \+ \.tab-item::before \{ display: none; \}/.test(css));
check('both themes: light gets its own hover overlay',
  /\.tab-item:hover \{ background: rgba\(255,255,255,\.055\); \}/.test(css) &&
  /body\.theme-light \.tab-item:hover \{ background: rgba\(19,23,34,\.06\); \}/.test(css));
check('drag affordances: ghost + blue drop edges',
  /\.tab-item\.dragging \{ opacity: \.45; \}/.test(css) &&
  /\.tab-item\.drop-before \{ box-shadow: inset 2px 0 0 0 var\(--blue\); \}/.test(css) &&
  /\.tab-item\.drop-after \{ box-shadow: inset -2px 0 0 0 var\(--blue\); \}/.test(css));

console.log('— ROUND121 · behavioral mirrors —');
/* mirror of _reorder's pure list logic */
function reorder(list, dragId, overId, before) {
  const di = list.findIndex((t) => t.id === dragId);
  if (di < 0) return list;
  const [rec] = list.splice(di, 1);
  const oi = list.findIndex((t) => t.id === overId);
  if (oi < 0) { list.splice(di, 0, rec); return list; }
  list.splice(before ? oi : oi + 1, 0, rec);
  return list;
}
{
  const L = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  check('mirror: drag a → after c (before=false) reorders [b, c, a, d]',
    JSON.stringify(reorder(L.slice(), 'a', 'c', false).map((t) => t.id)) === JSON.stringify(['b', 'c', 'a', 'd']));
  check('mirror: drag d → before a reorders [d, a, b, c]',
    JSON.stringify(reorder(L.slice(), 'd', 'a', true).map((t) => t.id)) === JSON.stringify(['d', 'a', 'b', 'c']));
  check('mirror: drag onto itself is a no-op',
    JSON.stringify(reorder(L.slice(), 'b', 'b', true).map((t) => t.id)) === JSON.stringify(['a', 'b', 'c', 'd']));
}
/* mirror of the close-neighbour rule */
{
  const list = ['a', 'b', 'c'].map((id) => ({ id }));
  let idx = list.findIndex((t) => t.id === 'b');
  list.splice(idx, 1);
  const next = list[idx] || list[idx - 1];
  check('mirror: closing the middle tab activates the RIGHT neighbour (c)',
    next.id === 'c');
  idx = list.findIndex((t) => t.id === 'c');
  list.splice(idx, 1);
  const last = list[idx] || list[idx - 1];
  check('mirror: closing the rightmost falls back to the LEFT neighbour (a)',
    last.id === 'a');
}
/* mirror of the title projection (live panes for the active tab) */
{
  const rec = { id: 't1', panes: [{ symbol: 'STALE' }] };
  const livePanes = { t1: [{ symbol: 'XAUUSD' }, { symbol: 'EURUSD' }] };
  const panesOf = (r, activeId, appPanes) =>
    (r.id === activeId && appPanes.length)
      ? appPanes.map((p) => ({ symbol: p.symbol }))
      : (r.panes || []).map((p) => ({ symbol: p.symbol }));
  const titleFor = (r) => panesOf(r, 't1', [{ symbol: 'XAUUSD' }, { symbol: 'EURUSD' }])[0].symbol || 'Chart';
  check('mirror: the active tab\u2019s title follows the LIVE symbol, not the stale record',
    panesOf(rec, 't1', [{ symbol: 'XAUUSD' }, { symbol: 'EURUSD' }]).length === 2 && titleFor(rec) === 'XAUUSD');
}

console.log(`\nROUND121: ${N} checks, ${BAD} failed`);
process.exit(BAD ? 1 : 0);
