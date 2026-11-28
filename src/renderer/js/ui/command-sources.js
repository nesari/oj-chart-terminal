/**
 * Command sources (ROUND305 / roadmap P0-01)
 *
 * `command.js` is the engine; this module is the CONTENT. Keeping them apart
 * matters because the engine has to be testable without a chart, and the content
 * has to be regenerated whenever a source changes (a new panel, a new drawing
 * tool, a new timeframe).
 *
 * Every source below reads the live app instead of a copied list:
 *
 *   symbols     App.feed / App.watchlist      — what the broker actually offers
 *   timeframes  App.TIMEFRAMES                — including user-added custom TFs
 *   indicators  Indicators.all / catalog       — the built-in Pine catalog
 *   styles      App.STYLES                    — the chart style strip
 *   panels      RightPanel                    — the 9 right-panel tabs
 *   tools       UI.GROUPS                     — the 86 drawing tools, by group
 *   actions     Toolbar / Settings / UI       — the verbs
 *
 * The tests assert that the palette FOUND these (e.g. a search for "Renko"
 * returns the style command and running it really changes `pane.style`), so a
 * source that silently returns nothing shows up as a missing result, not as a
 * palette that merely looks empty.
 *
 * @module ui/command-sources
 */

import { App } from '../../../core/state.js';
import { Command } from './command.js';

/* Injection seam: the sources must not import the whole app graph (that would
 * make the module untestable in Node and re-introduce import cycles). The boot
 * code passes the live modules in; tests pass fakes. */
let deps = {};

export function wireSources(d) {
  deps = d || {};
}

function safety(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

/* ---------- symbols ---------- */

function symbolCommands() {
  const out = [];
  const seen = new Set();
  const push = (sym) => {
    const s = String(sym || '').toUpperCase();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push({
      id: 'symbol:' + s,
      title: s,
      group: 'Symbol',
      keywords: 'symbol ticker chart switch ' + s,
      icon: 'search',
      run: () => {
        const pane = App.activePane;
        if (pane && deps.Manager) deps.Manager.setSymbol(pane, s);
      },
    });
  };

  /* Watchlist first: those are the symbols the user already cares about. */
  for (const s of safety(() => App.watchlist || [], [])) push(s);

  /* Then the broker's own list, when the feed exposes one. `App.feed.symbols`
   * is a plain array on the demo provider; a real MT5 bridge exposes it too. */
  const market = safety(() => (App.feed && Array.isArray(App.feed.symbols)) ? App.feed.symbols : [], []);
  for (const s of market) push(s);

  /* Finally any symbol already open on a pane (multi-chart layouts). */
  for (const p of safety(() => App.panes || [], [])) push(p.symbol);
  return out;
}

/* ---------- timeframes ---------- */

function timeframeCommands() {
  const list = safety(() => deps.timeframes ? deps.timeframes() : [], []);
  return list.map((tf) => ({
    id: 'tf:' + tf.id,
    title: 'Timeframe ' + tf.label,
    group: 'Timeframe',
    keywords: 'timeframe interval period ' + tf.label + ' ' + tf.id,
    icon: 'clock',
    run: () => {
      const pane = App.activePane;
      if (pane && deps.Manager) deps.Manager.setTf(pane, tf.id);
    },
  }));
}

/* ---------- chart styles ---------- */

function styleCommands() {
  const list = safety(() => App.STYLES || [], []);
  return list.map((st) => ({
    id: 'style:' + st.id,
    title: st.name,
    group: 'Chart style',
    keywords: 'style chart type ' + st.name + ' ' + st.id,
    icon: st.icon || 'candles',
    run: () => {
      const pane = App.activePane;
      if (pane && deps.Manager && deps.Manager.setStyle) deps.Manager.setStyle(pane, st.id);
    },
  }));
}

/* ---------- indicators ---------- */

function indicatorCommands() {
  /* `Indicators.all` is a plain ARRAY on the facade (core/indicators.js), not a
     getter — reading it as a function silently produced zero indicator commands,
     which is exactly the kind of "palette looks empty" bug the E2E must catch. */
  const catalog = safety(() => {
    const src = deps.indicators;
    if (!src) return [];
    if (Array.isArray(src.all)) return src.all;
    if (typeof src.catalogAll === 'function') return src.catalogAll();
    return [];
  }, []);
  return catalog.map((ind) => ({
    id: 'indicator:' + (ind.type || ind.id),
    title: 'Add ' + (ind.label || ind.name || ind.type),
    group: 'Indicators',
    keywords: 'indicator study add ' + (ind.label || '') + ' ' + (ind.type || ''),
    icon: 'indicators',
    run: () => {
      const pane = App.activePane;
      if (!pane) return;
      const ui = deps.IndicatorsUI;
      const add = (deps.indicators && deps.indicators.add) || (ui && ui.add);
      if (add) add(pane, ind.type || ind.id);
      else if (ui && ui.openDialog) ui.openDialog();
    },
  }));
}

/* ---------- right-panel tabs ---------- */

const PANEL_TITLES = {
  watchlist: 'Watchlist',
  alerts: 'Alerts',
  objects: 'Object Tree',
  trade: 'Trading',
  tester: 'Strategy Tester',
  datawindow: 'Data Window',
  timesales: 'Time & Sales',
  diagnostics: 'Diagnostics',
  news: 'Economic News',
};

function panelCommands() {
  const tabs = safety(() => deps.panelTabs ? deps.panelTabs() : Object.keys(PANEL_TITLES), []);
  return tabs.map((t) => ({
    id: 'panel:' + t,
    title: 'Open ' + (PANEL_TITLES[t] || t),
    group: 'Panels',
    keywords: 'panel open show tab ' + t + ' ' + (PANEL_TITLES[t] || ''),
    icon: 'doc',
    run: () => { if (deps.RightPanel) deps.RightPanel.showTab(t); },
  }));
}

/* ---------- drawing tools ---------- */

function toolCommands() {
  const groups = safety(() => deps.drawGroups ? deps.drawGroups() : [], []);
  const out = [];
  for (const g of groups) {
    const names = [];
    if (Array.isArray(g.tools)) names.push(...g.tools);
    for (const sec of g.sections || []) names.push(...(sec.tools || []));
    for (const id of names) {
      const label = safety(() => (deps.toolName ? deps.toolName(id) : id), id);
      out.push({
        id: 'tool:' + id,
        title: 'Draw ' + (label || id),
        group: 'Drawing tools',
        keywords: 'draw tool ' + id + ' ' + (label || '') + ' ' + g.id,
        icon: 'pencil',
        run: () => { if (deps.UI && deps.UI.activateTool) deps.UI.activateTool(id); },
      });
    }
  }
  return out;
}

/* ---------- verbs ---------- */

function actionCommands() {
  const A = (id, title, group, keywords, icon, run, keys) => ({ id, title, group, keywords, icon, run, keys });
  const T = deps.Toolbar || null;
  const out = [];

  if (T) {
    if (T.openSymbolSearch) {
      out.push(A('action:symbol-search', 'Search symbol…', 'Actions', 'symbol find search ticker', 'search', () => T.openSymbolSearch()));
    }
    if (T.openCustomTfDialog) {
      out.push(A('action:custom-tf', 'Custom interval…', 'Actions', 'timeframe interval custom add', 'clock', () => T.openCustomTfDialog()));
    }
    if (T.openLayoutMenu) {
      out.push(A('action:layouts', 'Chart layout…', 'Actions', 'layout grid split', 'grid', () => {
        const b = document.getElementById('layout-btn');
        if (b) { const r = b.getBoundingClientRect(); T.openLayoutMenu(r.left, r.bottom + 4); }
      }));
    }
    if (T.openSaveLayoutDialog) {
      out.push(A('action:save-layout', 'Save layout…', 'Actions', 'save layout persist', 'save', () => T.openSaveLayoutDialog(), 'Ctrl+S'));
    }
    if (T.openAlertDialog) {
      out.push(A('action:alert', 'Create alert…', 'Actions', 'alert notify alarm', 'bell', () => T.openAlertDialog()));
    }
    if (T.openTzMenu) {
      out.push(A('action:timezone', 'Timezone…', 'Actions', 'timezone time zone utc', 'clock', () => {
        const b = document.getElementById('settings-btn');
        if (b) { const r = b.getBoundingClientRect(); T.openTzMenu(r.left, r.bottom + 4); }
      }));
    }
    if (T.Snapshot) {
      out.push(A('action:snapshot-copy', 'Snapshot: copy to clipboard', 'Actions', 'snapshot screenshot copy image', 'camera', () => T.Snapshot.copy(), 'Ctrl+Shift+S'));
      out.push(A('action:snapshot-download', 'Snapshot: download', 'Actions', 'snapshot screenshot save download image', 'camera', () => T.Snapshot.download(), 'Ctrl+Alt+S'));
    }
    out.push(A('action:reset-scale', 'Reset price scale', 'Actions', 'reset scale zoom fit auto', 'fit', () => {
      for (const p of App.panes || []) {
        safety(() => p.chart.timeScale().resetTimeScale(), null);
        safety(() => p.chart.priceScale('right').applyOptions({ autoScale: true }), null);
      }
    }));
  }

  if (deps.Settings && deps.Settings.open) {
    out.push(A('action:settings', 'Chart settings…', 'Actions', 'settings options preferences', 'gear', () => deps.Settings.open()));
  }
  if (deps.IndicatorsUI && deps.IndicatorsUI.openDialog) {
    out.push(A('action:indicators-dialog', 'Indicators dialog…', 'Actions', 'indicator study add list', 'indicators', () => deps.IndicatorsUI.openDialog(), '/'));
  }
  if (deps.Theme && deps.Theme.toggle) {
    out.push(A('action:theme', 'Toggle theme (light / dark)', 'Actions', 'theme dark light color', 'sun', () => deps.Theme.toggle()));
  }
  if (deps.PineEditor && deps.PineEditor.open) {
    out.push(A('action:pine-editor', 'Open Pine editor', 'Actions', 'pine script editor code', 'pine', () => deps.PineEditor.open()));
  }
  if (deps.Replay && deps.Replay.toggle) {
    out.push(A('action:replay', 'Bar Replay', 'Actions', 'replay backtest history', 'replay', () => deps.Replay.toggle()));
  }
  if (deps.GoToDate) {
    const openGoTo = deps.GoToDate.openDialog || deps.GoToDate.open;
    if (openGoTo) {
      out.push(A('action:goto-date', 'Go to date…', 'Actions', 'goto date jump time', 'calendar', () => openGoTo()));
    }
  }
  if (deps.Compare && deps.Compare.openMenu) {
    out.push(A('action:compare', 'Compare symbol…', 'Actions', 'compare overlay symbol', 'compare', () => deps.Compare.openMenu()));
  }
  if (deps.DrawSettings && deps.DrawSettings.open) {
    out.push(A('action:draw-settings', 'Drawing settings…', 'Actions', 'drawing tool settings style', 'pencil', () => deps.DrawSettings.open()));
  }
  /* Undo/Redo live on `App.undo` (installed at boot by Undo.init). Guarding on
     the live object rather than on a `deps.SaveLayout` module — which does not
     exist — is what keeps these two rows from being dead buttons. */
  if (App.undo) {
    out.push(A('action:undo', 'Undo', 'Actions', 'undo revert back', 'undo', () => App.undo.undo(), 'Ctrl+Z'));
    out.push(A('action:redo', 'Redo', 'Actions', 'redo forward', 'redo', () => App.undo.redo(), 'Ctrl+Y'));
  }
  return out;
}

/**
 * Rebuild the whole registry from the live app.
 *
 * Called once at boot and again whenever a source that can change (symbols,
 * custom timeframes) may have changed. Idempotent by command id, so a rebuild
 * cannot duplicate rows.
 */
export function registerAll() {
  const report = {
    symbol: 0, timeframe: 0, style: 0, indicator: 0, panel: 0, tool: 0, action: 0,
  };
  const add = (kind, cmds) => { report[kind] += Command.addAll(cmds); };

  add('symbol', symbolCommands());
  add('timeframe', timeframeCommands());
  add('style', styleCommands());
  add('indicator', indicatorCommands());
  add('panel', panelCommands());
  add('tool', toolCommands());
  add('action', actionCommands());
  return report;
}

export { PANEL_TITLES };
