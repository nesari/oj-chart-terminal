/**
 * App bootstrap & wiring
 *
 * @module app
 */

/* Electron host adapter FIRST: it self-installs at module-eval time, so the
   crash net (window error/unhandledrejection) and the IPC log transport are
   active before ANY other module evaluates — the same timing the round-28
   logger had. ES-module imports evaluate depth-first in source order. */
import { installElectronHost } from '../../platform/electron/loghost.js';
import { U } from './core/util.js';
import { Log } from '../../core/logger.js';
import { AppErr } from '../../core/errors.js';
import { icon } from './ui/icons.js';
import { TZ } from '../../core/timezone.js';
import { Theme } from './core/theme.js';
import { App } from '../../core/state.js';
import { Undo } from './core/undo.js';
import { Feed } from '../../core/feed.js';
import { Settings } from './chart/settings.js';
import { Manager } from './chart/manager.js';
import { IndicatorsUI } from './chart/indicators-ui.js';
import { PineUI } from './chart/pine-ui.js';
import { PineEditor } from './panels/pine-editor.js';
import { PineScriptsStore } from './panels/pine-scripts-store.js';
import { Indicators } from '../../core/indicators.js';
import { Compare } from './chart/compare.js';
import { Snapshot, Toolbar } from './chart/toolbar.js';
import { Tabs } from './chart/tabs.js'; /* ROUND121 (user request): Windows 11 / TV-Desktop style chart tabs */
import { DrawSettings } from './drawing/settings.js';
/* ROUND243: TOOLS on the debug facade so the E2E suite can unit-check tool
   geometry live (draw/hitBody against a stub canvas) — ui.js already pulls
   this module, so no new graph edge. */
import { TOOLS as DrawTools } from './drawing/tools.js';
/* side-effect import: registers the batch-2 tools (Gann ×4, Elliott ×5,
   Patterns ×6, Long/Short Position, Regression, Vol Profile, Fib Channel/
   Circles, Pitchfork ×4, Info Line, Callout, Arrow Marks ×4, Flag Mark,
   Brush/Highlighter) on the shared TOOLS registry + their factory defaults.
   Without it every left-toolbar flyout that lists these tools renders EMPTY
   (Gann / Risk-Reward groups had zero rows). No other wiring needed. */
import './drawing/tools2.js';
import { UI } from './drawing/ui.js';
import { Watchlist } from './panels/watchlist.js';
import { TimeSales } from './panels/timesales.js';
import { Alerts } from './panels/alerts.js';
import { News } from './panels/news.js';
import { ObjectTree } from './panels/objects.js';
import { Tester } from './panels/tester.js';
import { StratDock } from './panels/stratdock.js';
import { Diagnostics } from './panels/diagnostics.js';
import { Replay } from './panels/replay.js';
import { LoginUI } from './ui/login.js';
import { RightPanel } from './ui/rightpanel.js';
import { DataWindow } from './panels/datawindow.js';
/* ROUND85 (user request): trading bridge — order execution straight to
   MetaTrader from the app, live risk/volume management, live account +
   positions/orders/history dock, and chart trade lines with draggable
   SL/TP/pending prices (trade/* modules own all of it; the rest of the
   app only hands over the boot + the (+) price-menu entry point). */
import { Trade } from './trade/state.js';
import { TradeAlerts } from './trade/alerts.js';
import { TradeTicket } from './trade/ticket.js';
import { TradeDock } from './trade/dock.js';
import { TradeOverlay } from './trade/overlay.js';
import { TradeHistory } from './trade/history.js'; /* ROUND98: MT5-style deal markers */
import { OneClick } from './trade/oneclick.js'; /* ROUND108: MT5-style one-click trading panel on the chart */
import { TradeRoute } from './trade/route.js'; /* ROUND112: the Demo/Live mode switch */
/* ROUND86 (user request): Replay trading suite — a client-side demo broker
   over the Bar Replay history (custom deposit/leverage), the Go to Date
   picker, and the Custom Session data mode (stitched daily hour windows).
   The real trading path stays untouched. */
import { ReplayTrade } from './trade/replaytrade.js';
import { GoToDate } from './panels/gotodate.js';
import { SessionRange } from './panels/session.js';
/* ROUND125 (user request): frameless TV-Desktop shell — wires the integrated
   min / max / close buttons that now live in the tab strip and on the login
   bar (the OS title bar is gone). */
import { WinControls } from './ui/wincontrols.js';

function boot() {
    /* ROUND122: detached-window (solo) mode — index.html#solo=<id>. The shell
       boots identically EXCEPT the trade stack: the demo ledger lives in the
       shared localStorage, so a second broker engine would corrupt it; live
       order surfaces would also double-fire against one provider. Charts,
       indicators, drawings, alerts, watchlist stay fully functional. */
    const SOLO_MODE = /solo=[\w-]+/.test(location.hash || '');
    if (SOLO_MODE) { try { document.body.classList.add('solo'); } catch (e) { Log.debug('app', 'solo shell class failed', e) } }

    /* ROUND125 (user request): TradingView-Desktop window shell — the OS
       title bar no longer exists (main.js boots frame:false), so these are
       THE window buttons of this window (host or detached alike). Booting
       them FIRST keeps the shell usable even if a later module throws. */
    WinControls.init();

    App.feed = App.feed || new Feed((/^ws\d*=(.+)$/.exec((location.search || '').slice(1)) || [])[1] && 'ws://' + (/^ws\d*=(.+)$/.exec((location.search || '').slice(1)))[1]);
    (App.onTickHooks || []).forEach((f) => App.feed.onTick.push(f));

    // right panel: the icon rail is FIXED at the far right edge (TV); clicking
    // a rail icon opens its panel to the LEFT of the rail (the chart + its
    // price scale shift left). Clicking the active icon again closes the panel
    // — the rail itself never hides. (rounds 17/18)
    const tabs = document.querySelectorAll('#right-tabs .rt-btn[data-tab]');
    const icons = { watchlist: 'bookmark', alerts: 'bell', trade: 'exchange', tester: 'grid', datawindow: 'doc', objects: 'tree2', timesales: 'timesales', diagnostics: 'info', news: 'news' }; /* ROUND131: TV-parity icons */
    tabs.forEach((b) => {
      b.innerHTML = icon(icons[b.dataset.tab]);
      b.addEventListener('click', () => RightPanel.showTab(b.dataset.tab));
    });
    document.querySelectorAll('#right-content .rt-close').forEach((b) => {
      b.innerHTML = icon('x');
      b.addEventListener('click', () => RightPanel.close());
    });

    Toolbar.init();
    Settings.init();
    if (Undo) { Undo.init(); App.undo = Undo; };
    UI.buildLeftToolbar();
    UI.renderFavFloat();
    Watchlist.init();
    Alerts.init();
    News.init();
    ObjectTree.init();
    if (Tester) Tester.init(); // ROUND173 (phase 2c): Strategy Tester panel
    if (StratDock) StratDock.init(); // ROUND179: strategy bottom dock (tabs + sticky toolbar)
    if (Diagnostics) Diagnostics.init(); // round 28: logging/monitoring panel
    if (TimeSales) TimeSales.init();
    if (Compare) Compare.init();
    Manager.init();
    Manager.applyTimezone();
    /* ROUND121 (user request): the tab strip restores/adopts AFTER the chart
       stack boots — first run adopts the live chart as tab 1 (zero behaviour
       change), saved runs restore the last active tab (which may rebuild the
       grid with a different symbol/layout through Manager.setLayout). */
    Tabs.init();
    Settings.applyAll();
    /* ROUND 74: Pine Editor panel + top-bar button (icons wired inside init) */
    if (PineEditor) PineEditor.init();
    LoginUI.init();

    /* ROUND85 (user request): trading bridge boot. Init AFTER the chart
       stack so the overlay can walk App.panes on its first tick. The chart
       (+) price menu ("Buy limit / Sell stop / Add order…") is re-wired to
       the REAL order ticket by overriding Toolbar.openOrderTicket here —
       toolbar.js keeps its demo stub untouched, the override wins.
       ROUND122: NOT booted in a detached (solo) window — see the note above. */
    if (!SOLO_MODE) {
      Trade.init();
      TradeAlerts.init(); /* ROUND85E: trade alerts arm after every state poll */
      TradeTicket.init();
      TradeDock.init();
      TradeOverlay.init();
      OneClick.init(); /* ROUND108: the per-chart Buy/Sell one-click widget */
      TradeHistory.init(); /* ROUND98 (user request): trade history on the chart + right-click toggle */
      /* ROUND86 (user request): Replay trading suite boot — AFTER the chart
         stack and the real trade stack so the demo overlay's cursor arbiter
         registers last and both overlays coexist safely */
      ReplayTrade.init();
      /* ROUND112: the Demo/Live switch — the demo broker becomes the route's
         delegate, the persisted mode paints the merged tab + panel badge */
      TradeRoute.setDemoDelegate(ReplayTrade);
      TradeRoute.init();
      Toolbar.openOrderTicket = function (pane, presetPrice, preset) {
        TradeTicket.openTicket(pane, presetPrice, preset);
      };
    } else {
      /* ROUND124 (user report "undocking a new tab strips the float Trade
         panel"): the chart-side float panel — trade management + risk
         management — now boots in DETACHED windows too, under the SAME
         per-symbol rules as the host (OneClick._designated: the first pane
         holding a symbol carries the panel, so same-symbol tabs/charts share
         one panel and a different symbol always gets its own).
         What boots here is the chart SURFACE only:
           · Trade          — the live bridge state (1.2s read-only state
                              polls + quotes + specs; the provider is one
                              process, so a second window polls it exactly
                              like a second terminal on the same account),
           · TradeOverlay   — entry/SL/TP lines for open positions,
           · OneClick       — THE FLOAT PANEL itself,
           · ReplayTrade    — the demo engine: positions/orders are
                              window-local (memory-only), and the shared
                              balance/history ledger is now written by a
                              MERGING saveAcct (trade/replaytrade.js) so two
                              windows can never stomp each other's ledger,
           · TradeRoute     — the Demo/Live facade (+ refreshMode watcher:
                              a switch flipped in the main window reaches
                              detached windows within seconds).
         Still HOST-ONLY (their surfaces live in the right panel / bottom
         dock, which a solo window does not show): TradeAlerts, TradeTicket,
         TradeDock, TradeHistory. */
      Trade.init();
      TradeOverlay.init();
      OneClick.init();
      ReplayTrade.init();
      TradeRoute.setDemoDelegate(ReplayTrade);
      TradeRoute.init();
      /* the persisted Demo/Live switch is global — a detached window adopts
         a mode flip made in the main window (silent, no toast) */
      setInterval(() => { try { TradeRoute.refreshMode(); } catch (e) { Log.debug('trade', 'trade mode refresh failed', e) } }, 2500);
    }
    GoToDate.init();
    SessionRange.init();

    /* dark/light theme: ROUND 62 (user request) — the app ALWAYS OPENS in
       dark mode. The toggle itself still works for the running session (and
       still persists), but the persisted mode is no longer restored at boot:
       every launch starts from the dark factory default. */
    Theme.apply('dark');
    document.getElementById('theme-btn').addEventListener('click', () => Theme.toggle());

    // restore the persisted right-panel tab (TV keeps the panel open);
    // ROUND112: the old 'replaytrade' tab merged into 'trade';
    // ROUND122: a detached window has no trade stack — fall back to watchlist
    RightPanel.initResize(); // ROUND40: drag the panel's left edge to resize (persists)
    const savedTabRaw = U.lsGet('mt5_rp_tab', 'watchlist');
    const savedTab = savedTabRaw === 'replaytrade' ? 'trade' : savedTabRaw;
    const effTab = SOLO_MODE && savedTab === 'trade' ? 'watchlist' : savedTab;
    if (effTab && effTab !== 'closed') {
      const btn = document.querySelector('#right-tabs .rt-btn[data-tab="' + effTab + '"]');
      if (btn) RightPanel.showTab(effTab); else RightPanel.close();
    } else {
      RightPanel.close();
    }

    // timezone button label
    document.getElementById('tz-label').textContent = TZ.shortLabel(App.tz);

    // bottom-bar clock: current time in the selected timezone (TV style), 1 Hz
    const clockTick = () => {
      const c = document.getElementById('tz-clock');
      if (c) c.textContent = TZ.nowLabel(App.tz);
    };
    clockTick();
    setInterval(clockTick, 1000);

    // the provider re-measured the broker timezone offset (login/bars/tick):
    // every time display (axis, crosshair, data window, clock) must re-render
    App.feed.onBrokerOff.push(() => {
      try { Manager.applyTimezone(); } catch (e) { Log.warn('chart', 'timezone apply failed', e) }
    });

    // Alt bypasses Magnet Mode while held (TV behaviour); reset on window blur
    const altTrack = (e) => { App.altDown = !!e.altKey; };
    document.addEventListener('keydown', altTrack, true);
    document.addEventListener('keyup', altTrack, true);
    window.addEventListener('blur', () => { App.altDown = false; });

    // global keyboard
    document.addEventListener('keydown', (e) => {
      // modal dialogs own the keyboard (tool settings / save layout)
      if (document.getElementById('draw-settings-dialog') || document.getElementById('save-layout-dialog')) return;
      /* ROUND103 BUGFIX — the chart shortcuts below used to fire while the
         user was typing. Only `/` and Alt+Shift+R checked the target, so:
           · Delete, pressed to erase a character in ANY input (the ticket's
             volume box, the dock's inline SL/TP editor, an alert price, a
             symbol search), DELETED THE SELECTED DRAWING instead — silent
             and, with Undo not always reachable, effectively destructive.
           · Ctrl+Z / Ctrl+Y in an input undid a chart DRAWING rather than
             the text edit under the caret.
           · Ctrl+S opened Save Layout on top of whatever was being typed.
         The Pine editor was immune only because its textarea calls
         stopPropagation(); the app's other ~35 inputs were not. One guard
         now covers every text surface, and the browser keeps its native
         text undo/redo because we return BEFORE preventDefault(). */
      const typing = U.isTyping(e.target);
      // round 27: "/" opens the Indicators dialog (TV shortcut, parity)
      if (e.key === '/' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
          e.preventDefault();
          if (IndicatorsUI) IndicatorsUI.openDialog();
          return;
        }
      }
      // Ctrl+S: Save Layout (TV)
      if (!typing && e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyS') {
        e.preventDefault();
        Toolbar.openSaveLayoutDialog();
        return;
      }
      // chart snapshot shortcuts (TV)
      if (!typing && e.ctrlKey && !e.shiftKey && e.altKey && e.code === 'KeyS') {
        e.preventDefault();
        Toolbar.Snapshot.download();
        return;
      }
      if (!typing && e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyS') {
        e.preventDefault();
        Toolbar.Snapshot.copy();
        return;
      }
      // ROUND 69 (TV): Alt+Shift+R arms the Rectangle — the shortcut the
      // shapes flyout now shows on its row (exactly like TradingView)
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyR') {
        const tag69 = (e.target.tagName || '').toLowerCase();
        if (tag69 !== 'input' && tag69 !== 'textarea' && tag69 !== 'select') {
          e.preventDefault();
          UI.activateTool('rect');
          return;
        }
      }
      if (Toolbar.onKey(e)) return;
      if (!typing && e.key === 'Delete' && App.selection) {
        if (App.undo) App.undo.remove(App.selection.pane, App.selection.d);
        else App.drawings.remove(App.selection.pane.symbol, App.selection.d.id);
        App.selection = null;
        UI.onSelectionChanged();
        return;
      }
      /* Undo / Redo (TV): Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z */
      if (!typing && (e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyZ' && App.undo) {
        e.preventDefault();
        if (e.shiftKey) App.undo.redo(); else App.undo.undo();
        return;
      }
      if (!typing && (e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyY' && App.undo) {
        e.preventDefault();
        App.undo.redo();
        return;
      }
    });

    // reconnect on provider loss — single-flight, bounded backoff. The old
    // handler could start overlapping reconnect loops and always sent a DEMO
    // login after reconnect, which was wrong for MT5 accounts. Feed.connect()
    // itself is also single-flight, so both layers are safe against races.
    let reconnectRunning = false;
    App.feed.onClose.push(async () => {
      if (reconnectRunning) return;
      reconnectRunning = true;
      try {
        const backoff = [1000, 2000, 4000, 8000, 12000];
        for (let i = 0; i < backoff.length; i++) {
          await new Promise((r) => setTimeout(r, backoff[i]));
          try {
            await App.feed.connect();
            if (App.currentAcc && App.currentAcc.login) {
              await App.feed.login('mt5', App.currentAcc);
            } else {
              await App.feed.login('demo', {});
            }
            const lab = document.getElementById('conn-label');
            const dot = document.querySelector('#conn-status .dot');
            if (lab) lab.textContent = (App.currentAcc && App.currentAcc.label) || 'Connected';
            if (dot) dot.className = 'dot green';
            for (const p of App.panes) Manager.loadBars(p);
            for (const s of App.watchlist) App.feed.subscribe(s);
            return;
          } catch (e) {
            try { Log && Log.warn('feed', 'reconnect attempt failed', { attempt: i + 1, error: String(e && e.message || e) }); } catch (er) {}
          }
        }
        const lab = document.getElementById('conn-label');
        const dot = document.querySelector('#conn-status .dot');
        if (lab) lab.textContent = 'Offline';
        if (dot) dot.className = 'dot red';
      } finally {
        reconnectRunning = false;
      }
    });

    // MT5 terminal watchdog (provider relaunches a closed terminal behind a
    // LIVE websocket): surface the state on the connection chip + heal history
    App.feed.onStatus.push((m) => {
      const lab = document.getElementById('conn-label');
      const dot = document.querySelector('#conn-status .dot');
      if (m.state === 'reconnecting') {
        if (lab) lab.textContent = 'Reconnecting…';
        if (dot) dot.className = 'dot yellow';
        /* AUDIT FIX: the provider-side watch_loop fires this same event for
           a closed terminal AND for a lost connection (e.g. the user's
           internet dropping) — mt5.terminal_info().connected goes false in
           both cases. The old copy only mentioned "terminal closed", which
           was misleading during a plain network outage. */
        if (UI && UI.toast) UI.toast('Connection to MT5 lost (terminal closed or no internet) — retrying automatically…');
      } else if (m.state === 'ok') {
        if (lab) lab.textContent = (App.currentAcc && App.currentAcc.label) || 'Connected';
        if (dot) dot.className = 'dot green';
        if (UI && UI.toast) UI.toast('MT5 terminal reconnected', 'ok');
        // history may have gaps from the dead window — refresh every chart
        // (skipped during Bar Replay so the session stays intact)
        if (Replay && Replay.isActive && Replay.isActive()) return;
        for (const p of App.panes) Manager.loadBars(p);
      }
    });

    window.addEventListener('beforeunload', () => {
      try { App.feed.close(); } catch (e) { Log.debug('feed', 'feed close on unload failed', e) }
    });

    // expose for tests / debugging — the SANCTIONED debug facade: everything
    // the E2E suite and the console ever need (no more window.* globals)
    window.__app = {
      App, Manager, Toolbar, Snapshot, Tabs, UI, Watchlist, Alerts, TimeSales, Replay,
      Settings, ObjectTree, DataWindow, Diagnostics, Compare, IndicatorsUI,
      Indicators, DrawSettings, DrawTools, Log, AppErr, TZ, Theme, Undo, Feed, U, icon, RightPanel,
      News, Alerts, PineUI, PineEditor, PineScriptsStore,
      Trade, TradeAlerts, TradeTicket, TradeDock, TradeOverlay, OneClick,
      TradeRoute, ReplayTrade, Replay, GoToDate, SessionRange,
    };
  }

export function onAppReady() {
    // called after successful login
    for (const p of App.panes) Manager.loadBars(p);
    News.load(); // ROUND39: the boot-time attempt runs pre-connect and is a no-op — fetch the calendar once the feed is live
  };

  document.addEventListener('DOMContentLoaded', boot);
