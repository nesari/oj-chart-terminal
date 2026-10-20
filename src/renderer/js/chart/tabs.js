/**
 * ROUND121 (user request) — chart tabs, TradingView-Desktop / Windows-11 style.
 *
 * A slim strip ABOVE the top toolbar holds one tab per chart "page". Every
 * tab is an INDEPENDENT chart layout: its own layout id and its own per-pane
 * state (symbol / interval / style / indicators / Pine scripts) — exactly
 * like a TradingView Desktop tab, and each one can hold a DIFFERENT symbol.
 *
 *   · "+" (or Ctrl+T) creates a tab cloned from the active chart and opens
 *     the symbol picker — pick a symbol and the new tab shows it (TV flow).
 *   · Click / drag / middle-click / context menu manage the tabs like
 *     Windows 11: rounded top corners, close ✕ on hover, reorder by drag,
 *     Duplicate · Close others · Close to the right · Close.
 *   · Closing the LAST tab lands on a fresh default chart — the app never
 *     shows an empty grid.
 *   · Everything persists (mt5_tabs) and restores on boot.
 *
 * ROUND122 (user request) — TWO extensions on the same module:
 *
 * 1. LIVE TV-STYLE LABELS: every tab carries a live quote next to its
 *    symbol — last price + ▲/▼ arrow + session change %, green/red like
 *    TradingView Desktop. Prices ride the SAME tick stream the Watchlist
 *    uses (App.onTickHooks), so even INACTIVE tabs tick: each tab holds one
 *    ref-counted feed subscription (Manager.acquireSub/releaseSub, the
 *    BUG-013 shared bookkeeping) for its first pane's symbol, reconciled
 *    every 1.2s. The change baseline is the previous DAILY close — one
 *    D1 bars_req per symbol, refreshed every 5 min, day boundary decided
 *    in broker-wall time (feed.serverOff) exactly like the provider.
 *
 * 2. UNDOCK / DOCK-BACK (Google-Chrome tab behaviour):
 *      · dragging a tab BELOW the strip (or out of the window) opens it in
 *        its OWN OS window (main.js IPC 'tabs:undock' -> new BrowserWindow
 *        loading index.html#solo=<id>); dropping the last tab out closes
 *        the source window, exactly like Chrome.
 *      · a detached window ("solo" mode) runs the same shell with its own
 *        tab strip; ROUND124: the chart-side float Trade panel DOES boot
 *        there (see app.js — the shared demo ledger is protected by the
 *        merging saveAcct), while the right-panel Trading tab and the
 *        bottom dock stay host-only. Charts/indicators/drawings/alerts
 *        are fully functional.
 *      · dock-back: the solo strip shows a dock button + context-menu
 *        "Move to main window"; the tab re-joins the host strip through
 *        IPC. If the host window is gone, the solo PROMOTES itself to the
 *        main window (Chrome: the last window standing becomes the
 *        browser). ROUND124: drag gestures mirror the host's — dragging a
 *        tab below the detached strip or out of the window docks it back,
 *        exactly like dragging a Chrome tab onto another window.
 *      · solo auto-login attaches to the RUNNING provider identity
 *        (main.js 'provider-identity') — it can never restart or switch
 *        the provider under the host's feet.
 *
 * ROUND124 (user reports): ① the float Trade panel (trade + risk
 *    management) boots in detached windows too (app.js solo branch) — the
 *    per-symbol one-panel rule (OneClick._designated) applies per window,
 *    so a different-symbol tab carries its own panel in BOTH windows;
 *    ② a symbol change on any tab now fetches the change baseline
 *    immediately (_reconcileSubs → _refreshBases), so the tab's ▲/▼ arrow
 *    + live change % never wait for the 5-minute cadence again.
 *
 * HOW IT SWITCHES (the load-bearing design decision): a tab switch reuses
 * the SAME machinery as a layout switch — Manager.setLayout(layoutId, false,
 * explicitPanes) destroys the current panes and rebuilds the target tab's
 * from its saved records. Every subsystem that already survives a layout
 * switch (trade overlay lines, the floating Trade panel's per-symbol
 * designation + position map, drawings store, indicators, Pine) survives a
 * tab switch unchanged, because for them it IS a layout switch. No feed
 * refcount is released on rebuild — the exact current layout-switch
 * behaviour (Trade.state subscribes position symbols directly, bypassing
 * the refcount, so releasing here could kill a live position's feed).
 *
 * @module chart/tabs
 */

import { U } from '../core/util.js';
import { App } from '../../../core/state.js';
import { priceDigits } from '../../../core/feed.js';
import { Manager } from './manager.js';
import { Toolbar } from './toolbar.js';
import { UI } from '../drawing/ui.js';
import { icon } from '../ui/icons.js';
import { Log } from '../../../core/logger.js';

const K = { key: 'mt5_tabs', v: 1 };

/* ROUND122: detached-window (solo) mode — index.html loaded with #solo=<id>.
   The id is minted by the undocking window and handed over through main.js. */
const SOLO_ID = (() => {
  try { const m = /solo=([\w-]+)/.exec(location.hash || ''); return m ? m[1] : null; } catch (e) { return null; }
})();
/* the host strip owns 'mt5_tabs' (round 121, unchanged); every detached
   window persists to its OWN key so two windows can never clobber each
   other's tab lists through the shared localStorage */
const STORE_KEY = SOLO_ID ? 'mt5_tab_solo_' + SOLO_ID : K.key;

/* unique tab id */
function nid() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* a persisted record is usable when it has an id, a layout and ≥1 valid pane */
function validRec(r) {
  return !!(r && r.id && r.layout && Array.isArray(r.panes) &&
    r.panes.length && r.panes[0] && r.panes[0].symbol);
}

const Tabs = {
  list: [],        // [{ id, layout, panes:[{symbol,tf,style,indicators?,pineScripts?}] }]
  activeId: null,
  _listEl: null,
  _dragId: null,
  _titleTimer: null,
  _menuOutside: null,
  _menuEsc: null,
  /* ROUND122 live labels */
  isSolo: !!SOLO_ID,
  q: {},           // symbol -> { price, dir: 'up'|'down', at }
  base: {},        // symbol -> previous DAILY close (session change baseline)
  baseAt: {},      // symbol -> ts of the last baseline fetch
  baseBusy: {},    // symbol -> in-flight D1 fetch guard
  _labelSubs: {},  // symbol -> true while THIS module holds a label sub
  _quoteTimer: null,
  _subTimer: null,
  _baseTimer: null,
  _dockTO: null,

  /* ---------- boot ---------- */
  init() {
    const strip = document.getElementById('tab-strip');
    this._listEl = document.getElementById('tab-list');
    const addBtn = document.getElementById('tab-add-btn');
    if (!strip || !this._listEl || !addBtn) return;

    if (SOLO_ID) {
      /* ROUND122: detached window — mark the shell so CSS can hide the
         trade surfaces that are not booted here */
      try { document.body.classList.add('solo'); } catch (e) {}
      const dockBtn = document.getElementById('tab-dock-btn');
      if (dockBtn) {
        dockBtn.innerHTML = icon('dock');
        dockBtn.title = 'Move tab to main window';
        dockBtn.addEventListener('click', () => this.dockbackTab(this.activeId));
      }
    }

    const saved = U.lsGet(STORE_KEY, null);
    const bootStrip = () => {
      /* host restore / first-run adoption (round 121, unchanged) — also the
         ROUND123 fallback for a detached window whose IPC claim failed */
      try {
        if (saved && saved.v === K.v && Array.isArray(saved.tabs)) {
          this.list = saved.tabs.filter(validRec);
        }
        if (this.list.length) {
          /* restore the last active tab (its records override the legacy boot) */
          this.activeId = this.list.some((t) => t.id === saved.active) ? saved.active : this.list[0].id;
          this._restore(this.list.find((t) => t.id === this.activeId));
        } else {
          /* first run (or corrupt state): ADOPT the live chart as tab 1 — zero
             behaviour change for existing users, the boot chart stays the boot chart.
             ROUND122: a detached window with a lost handoff key does the same. */
          this.list = [this._adoptRec()];
          this.activeId = this.list[0].id;
        }
        this._persist();
      } catch (e) { Log.warn('chart', 'tab state restore failed', e) }
      this.render();
    };

    if (SOLO_ID && window.mt5Tabs && window.mt5Tabs.claimTab) {
      /* ROUND123 FIX (user report "a new tab undocks fine but never docks
         back"): the tab record now travels through IPC, not localStorage.
         Electron does not reliably propagate localStorage writes between two
         LIVE renderers (file:// origin, batched flush), so the solo's
         dock-back key was invisible to the running host — the host scan
         found nothing, acked nothing, and the tab stayed stranded. main.js
         now keeps the undocked record in memory (tabs:undock payload) and
         hands it over here on first claim; the localStorage key remains as
         a fallback only. */
      window.mt5Tabs.claimTab(SOLO_ID)
        .then((r) => {
          const rec = (r && r.ok && r.rec && validRec(r.rec)) ? r.rec : null;
          if (!rec) { bootStrip(); return; }
          try {
            this.list = [rec];
            this.activeId = rec.id;
            this._restore(rec);
            this._persist();
          } catch (e) { Log.warn('chart', 'tab strip restore failed', e) }
          this.render();
        })
        .catch(() => { try { bootStrip(); } catch (e) {} });
    } else {
      bootStrip();
    }

    addBtn.innerHTML = icon('plus');
    addBtn.title = 'New chart tab (Ctrl+T)';
    addBtn.addEventListener('click', () => this.newFromPicker());

    /* Ctrl+T / Ctrl+W (Windows-11 tab accelerators) — capture phase, guarded
       against typing surfaces and open dialogs, exactly like app.js */
    document.addEventListener('keydown', (e) => this._onKey(e), true);

    /* ROUND122 · Chrome undock gestures (HOST window only — a solo window
       never re-detaches onto itself): dragging a tab BELOW the strip (into
       the chart area) or OUT of the window pops it into its own OS window,
       exactly like dragging a Chrome tab off its strip. */
    if (!SOLO_ID && window.mt5Tabs && window.mt5Tabs.undock) {
      document.addEventListener('dragover', (e) => {
        if (!this._dragId) return;
        const r = strip.getBoundingClientRect();
        if (e.clientY > r.bottom + 36 || e.clientY < r.top - 8) {
          const id = this._dragId;
          this._dragId = null;
          this.undockTab(id);
        }
      }, true);
      document.addEventListener('dragleave', (e) => {
        if (!this._dragId || e.relatedTarget) return;
        const id = this._dragId;
        this._dragId = null;
        this.undockTab(id);
      }, true);
    }

    /* ROUND124 · Chrome dock-back gestures (SOLO windows — the MIRROR image
       of the host gestures above, user request: drag the detached tab back
       onto the main window "exactly like Chrome tabs"). Dragging a tab
       BELOW the detached strip or OUT of this window hands it back to the
       host strip through the same tabs:dockback IPC the "Move to main
       window" menu item uses — in-strip drops still reorder normally. */
    if (SOLO_ID && window.mt5Tabs && window.mt5Tabs.dockback) {
      document.addEventListener('dragover', (e) => {
        if (!this._dragId) return;
        const r = strip.getBoundingClientRect();
        if (e.clientY > r.bottom + 36 || e.clientY < r.top - 8) {
          const id = this._dragId;
          this._dragId = null;
          this._clearDropHints();
          this.dockbackTab(id);
        }
      }, true);
      document.addEventListener('dragleave', (e) => {
        if (!this._dragId || e.relatedTarget) return;
        const id = this._dragId;
        this._dragId = null;
        this._clearDropHints();
        this.dockbackTab(id);
      }, true);
    }

    /* ROUND122 · dock-back request arrives from detached windows (via main) */
    if (!SOLO_ID && window.mt5Tabs && window.mt5Tabs.onDockRequest) {
      window.mt5Tabs.onDockRequest((p) => { try { this._acceptDock(p); } catch (e) {} });
    }
    if (SOLO_ID && window.mt5Tabs && window.mt5Tabs.onDockAck) {
      window.mt5Tabs.onDockAck((p) => { try { this._onDockAck(p); } catch (e) {} });
    }

    /* live titles + freshness: the same 700ms tick keeps the active tab's
       record in step with live edits (symbol / tf / style / layout /
       indicators) via a DIRTY-CHECKED capture — localStorage is written only
       when the serialized state actually changed, and manager.js hot paths
       are never touched (DOM-write only on change) */
    this._titleTimer = setInterval(() => { try { this.renderTitles(); this._syncTick(); } catch (e) {} }, 700);

    /* ROUND122 · live TV-style labels: quote subscriptions + baseline fetches
       + the dirty-quote DOM painter (all three are no-ops until the feed is
       up; the tick stream itself arrives through the onTickHooks hook below) */
    this._quoteTimer = setInterval(() => { try { this._paintQuotes(); } catch (e) {} }, 300);
    this._subTimer = setInterval(() => { try { this._reconcileSubs(); } catch (e) {} }, 1200);
    this._baseTimer = setInterval(() => { try { this._refreshBases(); } catch (e) {} }, 5 * 60000);
    setTimeout(() => { try { this._reconcileSubs(); this._refreshBases(); } catch (e) {} }, 1500);

    /* quit-time capture: the last edits land in the record even when the user
       closes the app without ever switching tabs (beforeunload is the final
       synchronous write; the tick above already covers abnormal exits).
       ROUND123: a detached window that is actually CLOSED takes its tab with
       it (Chrome) — its per-solo store is dropped so stale keys never
       accumulate; the dock-back promotion already retired the key itself. */
    window.addEventListener('beforeunload', () => {
      try { this.capture(); } catch (e) { Log.debug('chart', 'tab capture on unload failed', e) }
      if (SOLO_ID) { try { localStorage.removeItem(STORE_KEY); } catch (e) { Log.debug('chart', 'solo tab state clear failed', e) } }
    });

    this.render();
  },

  /* ---------- state capture / restore ---------- */

  /* the active tab's record syncs from the LIVE panes */
  capture() {
    const rec = this.list.find((t) => t.id === this.activeId);
    if (!rec || !App.panes.length) return;
    rec.layout = App.layout || '1';
    rec.panes = this.snapshotPanes();
    this._persist();
  },

  /* 700ms freshness pass — capture WITHOUT the unconditional write: compare
     the live {layout, panes} against the record and persist only on a real
     change. Guards: no active record / empty App.panes (mid-rebuild, boot)
     are skipped, so a transient state can never clobber a valid record. */
  _syncTick() {
    if (!this.activeId || !App.panes.length) return;
    const rec = this.list.find((t) => t.id === this.activeId);
    if (!rec) return;
    const next = { layout: App.layout || '1', panes: this.snapshotPanes() };
    let a, b;
    try { a = JSON.stringify({ layout: rec.layout, panes: rec.panes }); b = JSON.stringify(next); } catch (e) { return; }
    if (a === b) return;
    rec.layout = next.layout;
    rec.panes = next.panes;
    this._persist();
  },

  /* ---------- ROUND122 · live TV-style tab labels ---------- */

  /* the tick hook — registered through App.onTickHooks at module scope (the
     same seam the Watchlist uses), so EVERY tab's symbol ticks even when its
     tab is in the background: inactive tabs keep their own feed subscription.
     ROUND123: addressed through the Tabs singleton (never `this`) — hooks are
     invoked receiver-less by the feed, so a `this`-based body throws there. */
  onTick(symbol, price) {
    if (!symbol || typeof price !== 'number' || !isFinite(price)) return;
    const prev = Tabs.q[symbol];
    const dir = prev && prev.price != null ? (price >= prev.price ? 'up' : 'down') : 'up';
    Tabs.q[symbol] = { price, dir, at: Date.now() };
  },

  /* one ref-counted feed subscription per tab (first pane's symbol) — the
     SAME Manager.acquireSub/releaseSub bookkeeping the Watchlist uses, so a
     label sub can never fight the chart's own subscription */
  _reconcileSubs() {
    if (SOLO_ID == null && !this.list.length) return;
    const want = new Set();
    for (const t of this.list) {
      const panes = this.panesOf(t);
      const sym = panes[0] && panes[0].symbol;
      if (sym) want.add(sym);
    }
    for (const sym of Object.keys(this._labelSubs)) {
      if (!want.has(sym)) {
        delete this._labelSubs[sym];
        try { Manager.releaseSub(sym); } catch (e) {}
      }
    }
    let added = 0;
    for (const sym of want) {
      if (this._labelSubs[sym]) continue;
      this._labelSubs[sym] = true;
      try { Manager.acquireSub(sym); added++; } catch (e) { delete this._labelSubs[sym]; }
    }
    /* ROUND124 FIX (user report: after changing a new tab's symbol the
       tab's ▲/▼ arrow + live change % vanished until the tab was UNDOCKED):
       the change baseline (previous D1 close) for a freshly entered symbol
       used to wait for the 5-minute _refreshBases cadence — the price cell
       painted on the first tick, but the arrow/percent sat empty for up to
       five minutes. Undocking "fixed" it only because a solo window boots
       with an immediate baseline fetch. Any symbol joining the label
       subscriptions (symbol change, new tab, dock-back, restore) now
       triggers the fetch RIGHT AWAY; fresh/busy symbols are skipped inside,
       so this stays cheap. */
    if (added) this._refreshBases();
  },

  /* session-change baseline = the previous DAILY close. One D1 bars_req per
     symbol every 5 min; "is the newest bar today?" is decided in broker-wall
     time (feed.serverOff rides on login/ticks — the same clock the provider
     stamps its bars with), so a forming daily bar never masquerades as the
     completed previous session. */
  _refreshBases() {
    for (const sym of Object.keys(this._labelSubs)) {
      if (this.baseBusy[sym]) continue;
      const age = Date.now() - (this.baseAt[sym] || 0);
      if (age < 4 * 60000 && this.base[sym] != null) continue;
      this.baseBusy[sym] = true;
      App.feed.bars(sym, 'D1', 4)
        .then((r) => {
          const bars = (r && Array.isArray(r.bars)) ? r.bars : [];
          const off = Math.round(Number(App.feed.serverOff) || 0);
          let b = null;
          if (bars.length >= 2) {
            const last = bars[bars.length - 1];
            const nowDay = Math.floor((Date.now() / 1000 + off) / 86400);
            const lastDay = Math.floor((last.time + off) / 86400);
            b = lastDay >= nowDay ? bars[bars.length - 2].close : last.close;
          } else if (bars.length === 1) {
            b = bars[0].close; // thin history: fall back to the only close
          }
          if (b != null && isFinite(b) && b > 0) this.base[sym] = b;
          this.baseAt[sym] = Date.now();
          /* ROUND123: seed the quote from the SAME response — the newest D1
             bar's close IS the latest price, so a freshly created (or
             restored) tab shows symbol + price + change immediately instead
             of sitting on "—" until its first live tick happens to arrive
             (illiquid symbols could sit there for minutes). The first real
             tick simply overwrites the seed. */
          if (bars.length && !Tabs.q[sym]) {
            const lastBar = bars[bars.length - 1];
            if (lastBar && isFinite(lastBar.close) && lastBar.close > 0) {
              const ref = (bars.length >= 2 ? bars[bars.length - 2].close : lastBar.open);
              Tabs.q[sym] = {
                price: lastBar.close,
                dir: lastBar.close >= (isFinite(ref) && ref > 0 ? ref : lastBar.close) ? 'up' : 'down',
                at: Date.now(),
              };
            }
          }
        })
        .catch(() => {})
        .then(() => { this.baseBusy[sym] = false; });
    }
  },

  /* dirty-quote painter: text writes happen ONLY on real changes; a tab whose
     symbol changed resets its own quote cells first (data-qsym marker) */
  _paintQuotes() {
    if (!this._listEl) return;
    for (const el of this._listEl.children) {
      const rec = this.list.find((t) => t.id === el.dataset.tabId);
      if (!rec) continue;
      const sym = this.titleFor(rec);
      const pxEl = el.querySelector('.t-px');
      const chEl = el.querySelector('.t-chg');
      if (!pxEl || !chEl) continue;
      if (el.dataset.qsym !== sym) {
        el.dataset.qsym = sym;
        pxEl.textContent = '\u2014';
        pxEl.className = 't-px';
        chEl.textContent = '';
        chEl.className = 't-chg';
      }
      const qq = this.q[sym];
      if (!qq || qq.price == null) continue;
      const ps = U.fmtPrice(qq.price, priceDigits(sym));
      if (pxEl.textContent !== ps) {
        pxEl.textContent = ps;
        pxEl.classList.remove('up', 'down');
        void pxEl.offsetWidth; /* restart the tick flash animation */
        pxEl.classList.add(qq.dir || 'up');
      }
      const b = this.base[sym];
      if (b != null && b > 0) {
        const pct = ((qq.price - b) / b) * 100;
        const txt = (pct >= 0 ? '\u25B2 +' : '\u25BC -') + Math.abs(pct).toFixed(2) + '%';
        if (chEl.textContent !== txt) {
          chEl.textContent = txt;
          chEl.classList.toggle('up', pct >= 0);
          chEl.classList.toggle('down', pct < 0);
        }
      }
    }
  },

  /* full per-pane serialization — the SAME shape Manager.setLayout's
     keep-path uses (round 31/74), so restore carries indicators + Pine too */
  snapshotPanes() {
    return App.panes.map((p) => ({
      symbol: p.symbol, tf: p.tf, style: p.style,
      indicators: (p.indicators || []).map((i) => ({ type: i.type, params: i.params, colors: i.colors,
        style: (i.style && typeof i.style === 'object') ? i.style : undefined,
        frac: (typeof i.frac === 'number' && isFinite(i.frac) && i.frac > 0) ? i.frac : undefined,
        visible: i.visible !== false })),
      pineScripts: Manager.serializePine ? Manager.serializePine(p) : undefined,
    }));
  },

  _restore(rec) {
    const panes = (rec && Array.isArray(rec.panes) && rec.panes.length)
      ? rec.panes
      : [{ symbol: 'EURUSD', tf: 'M1', style: 'candles' }];
    Manager.setLayout((rec && rec.layout) || '1', false, panes);
  },

  /* first-run adoption record built from whatever Manager.init restored */
  _adoptRec() {
    return {
      id: nid(),
      layout: App.layout || '1',
      panes: App.panes.length ? this.snapshotPanes() : [{ symbol: 'EURUSD', tf: 'M1', style: 'candles' }],
    };
  },

  /* ---------- tab operations ---------- */

  activate(id) {
    if (id === this.activeId) return;
    const target = this.list.find((t) => t.id === id);
    if (!target) return;
    this.capture();                    // current state lands in ITS record
    this.activeId = id;
    this._restore(target);
    this._persist();
    this.render();
  },

  /* "+" flow (TV): create the tab NOW (cloned from the active chart so it
     opens on a familiar chart) and open the symbol picker scoped to it —
     picking re-symbols the new tab, cancelling keeps the clone */
  newFromPicker() {
    this.create();
    try {
      Toolbar.openSymbolSearch((sym) => {
        if (App.activePane) Manager.setSymbol(App.activePane, sym);
        this.capture();
        this.renderTitles();
      });
    } catch (e) { Log.debug('chart', 'symbol picker open failed', e) }
  },

  create(symbol) {
    this.capture();
    const src = App.activePane;
    const rec = {
      id: nid(),
      layout: '1',                     // new tabs open single-chart (TV)
      panes: [{
        symbol: symbol || (src ? src.symbol : 'EURUSD'),
        tf: src ? src.tf : 'M1',
        style: src ? src.style : App.style,
      }],
    };
    this.list.push(rec);
    this.activeId = rec.id;
    this._restore(rec);
    this._persist();
    this.render();
    return rec.id;
  },

  closeTab(id) {
    const idx = this.list.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const wasActive = id === this.activeId;
    this.list.splice(idx, 1);
    if (!this.list.length && SOLO_ID && window.close) {
      /* ROUND122 (Chrome): closing the LAST tab of a detached window closes
         the window itself; if the close is blocked (non-Electron shell) the
         fresh-default-chart fallback below keeps the grid alive. */
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
      window.close();
      setTimeout(() => {
        if (window.closed) return;
        const rec = { id: nid(), layout: '1', panes: [{ symbol: 'EURUSD', tf: 'M1', style: 'candles' }] };
        this.list.push(rec);
        this.activeId = rec.id;
        this._restore(rec);
        this._persist();
        this.render();
      }, 150);
      return;
    }
    if (!this.list.length) {
      /* the last tab closes into a fresh default chart — never an empty grid */
      const rec = { id: nid(), layout: '1', panes: [{ symbol: 'EURUSD', tf: 'M1', style: 'candles' }] };
      this.list.push(rec);
      this.activeId = rec.id;
      this._restore(rec);
    } else if (wasActive) {
      /* activate the neighbour (right first, then left); the dying tab is
         NOT captured — its record is already gone */
      const next = this.list[idx] || this.list[idx - 1];
      this.activeId = next.id;
      this._restore(next);
    }
    this._persist();
    this.render();
  },

  duplicate(id) {
    const src = this.list.find((t) => t.id === id);
    if (!src) return;
    if (id === this.activeId) this.capture();   // copy the LIVE state
    let copy;
    try { copy = JSON.parse(JSON.stringify(src)); } catch (e) { return; }
    copy.id = nid();
    this.list.splice(this.list.indexOf(src) + 1, 0, copy);
    this._persist();
    this.activate(copy.id);
  },

  closeOthers(id) {
    if (!this.list.some((t) => t.id === id)) return;
    const dyingActive = this.activeId !== id;
    this.list = this.list.filter((t) => t.id === id);
    if (dyingActive) {
      this.activeId = id;
      this._restore(this.list[0]);
    }
    this._persist();
    this.render();
  },

  closeToRight(id) {
    const idx = this.list.findIndex((t) => t.id === id);
    if (idx < 0 || idx === this.list.length - 1) return;
    const dying = this.list.slice(idx + 1);
    if (dying.some((t) => t.id === this.activeId)) this.activate(id); // first: safely leave the dying tab
    this.list = this.list.slice(0, idx + 1);
    this._persist();
    this.render();
  },

  _reorder(dragId, overId, before) {
    if (!dragId || dragId === overId) return;
    const di = this.list.findIndex((t) => t.id === dragId);
    if (di < 0) return;
    const [rec] = this.list.splice(di, 1);
    const oi = this.list.findIndex((t) => t.id === overId);
    if (oi < 0) { this.list.splice(di, 0, rec); return; }   // defensive: put it back
    this.list.splice(before ? oi : oi + 1, 0, rec);
    this._persist();
    this.render();
  },

  /* ---------- strip rendering ---------- */

  render() {
    if (!this._listEl) return;
    U.clear(this._listEl);
    for (const t of this.list) {
      const el = U.el('div', 'tab-item' + (t.id === this.activeId ? ' active' : '') + (t._docking ? ' docking' : ''), this._listEl);
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', t.id === this.activeId ? 'true' : 'false');
      el.dataset.tabId = t.id;
      el.draggable = true;

      const title = U.el('span', 't-title', el);
      title.textContent = this.titleFor(t);
      /* ROUND122: the TV-style live quote (price + ▲/▼ session change) —
         values are painted by _paintQuotes() from the tick stream */
      const quote = U.el('span', 't-quote', el);
      const qsym = this.titleFor(t);
      quote.dataset.qsym = qsym;
      U.el('span', 't-px', quote).textContent = '\u2014';
      U.el('span', 't-chg', quote);
      el.dataset.qsym = qsym;
      const n = this.panesOf(t).length;
      if (n > 1) U.el('span', 't-chip', el).textContent = '×' + n;

      const x = U.el('button', 't-close', el);
      x.innerHTML = icon('x');
      x.title = 'Close tab (Ctrl+W)';
      x.setAttribute('aria-label', 'Close tab');

      /* activate on press (TV) — the ✕ button opts out via its own handlers */
      el.addEventListener('mousedown', (e) => {
        if (e.button === 0 && !e.target.closest('.t-close')) this.activate(t.id);
      });
      x.addEventListener('mousedown', (e) => e.stopPropagation());
      x.addEventListener('click', (e) => { e.stopPropagation(); this.closeTab(t.id); });
      /* middle-click close (Windows 11) */
      el.addEventListener('auxclick', (e) => {
        if (e.button === 1) { e.preventDefault(); this.closeTab(t.id); }
      });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); this._menu(e.clientX, e.clientY, t.id); });

      /* drag reorder */
      el.addEventListener('dragstart', (e) => {
        this._dragId = t.id;
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', t.id); } catch (err) {}
      });
      el.addEventListener('dragend', () => {
        this._dragId = null;
        el.classList.remove('dragging');
        this._clearDropHints();
      });
      el.addEventListener('dragover', (e) => {
        if (!this._dragId || this._dragId === t.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = el.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        el.classList.toggle('drop-before', before);
        el.classList.toggle('drop-after', !before);
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const before = el.classList.contains('drop-before');
        this._clearDropHints();
        this._reorder(this._dragId, t.id, before);
      });
    }
    this.renderTitles();
    this._scrollActiveIntoView();
  },

  /* cheap live refresh: text/tooltip writes happen ONLY on real changes */
  renderTitles() {
    if (!this._listEl) return;
    for (const el of this._listEl.children) {
      const rec = this.list.find((t) => t.id === el.dataset.tabId);
      if (!rec) continue;
      const panes = this.panesOf(rec);
      const tt = el.querySelector('.t-title');
      const want = this.titleFor(rec);
      if (tt && tt.textContent !== want) tt.textContent = want;
      const chip = el.querySelector('.t-chip');
      if (chip) {
        const cw = '×' + panes.length;
        if (chip.textContent !== cw) chip.textContent = cw;
      }
      const tip = panes.map((p) => (p.symbol || '') + ' · ' + ((App.tfById[p.tf] || {}).label || p.tf || '')).join('  |  ');
      if (el.title !== tip) el.title = tip;
    }
  },

  /* panes for titles/tooltips — the ACTIVE tab reads the LIVE panes so its
     label follows symbol changes before the next capture */
  panesOf(rec) {
    if (rec.id === this.activeId && App.panes.length) {
      return App.panes.map((p) => ({ symbol: p.symbol, tf: p.tf }));
    }
    return (rec.panes || []).map((p) => ({ symbol: p.symbol, tf: p.tf }));
  },

  titleFor(rec) {
    const panes = this.panesOf(rec);
    return (panes[0] && panes[0].symbol) || 'Chart';
  },

  _scrollActiveIntoView() {
    const el = this._listEl && this._listEl.querySelector('.tab-item.active');
    if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {} }
  },

  _clearDropHints() {
    if (!this._listEl) return;
    for (const el of this._listEl.children) el.classList.remove('drop-before', 'drop-after');
  },

  /* ---------- context menu (Windows 11 + ROUND122 Chrome undock) ---------- */
  _menu(x, y, id) {
    this._closeMenu();
    const m = U.el('div', 'tab-ctx');
    m.id = 'tab-ctx-menu';
    const items = [];
    if (SOLO_ID == null) {
      /* host: Chrome's "Move tab to new window" (also the drag-out gesture) */
      items.push(['Move to new window', () => this.undockTab(id)]);
    } else {
      /* detached window: re-join the host strip, or close this window */
      items.push(['Move to main window', () => this.dockbackTab(id)]);
      items.push(['Close window', () => { try { localStorage.removeItem(STORE_KEY); } catch (e) {} window.close(); }]);
    }
    items.push(
      ['Duplicate', () => this.duplicate(id)],
      ['Close others', () => this.closeOthers(id)],
      ['Close to the right', () => this.closeToRight(id)],
      ['Close', () => this.closeTab(id)],
    );
    for (const [label, fn] of items) {
      const b = U.el('button', 'tctx-item', m);
      b.textContent = label;
      b.addEventListener('click', () => { this._closeMenu(); fn(); });
    }
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    m.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
    setTimeout(() => {
      this._menuOutside = (e) => { if (!m.contains(e.target)) this._closeMenu(); };
      this._menuEsc = (e) => { if (e.key === 'Escape') this._closeMenu(); };
      document.addEventListener('mousedown', this._menuOutside, true);
      document.addEventListener('keydown', this._menuEsc, true);
    }, 0);
  },

  _closeMenu() {
    const m = document.getElementById('tab-ctx-menu');
    if (m) m.remove();
    if (this._menuOutside) { document.removeEventListener('mousedown', this._menuOutside, true); this._menuOutside = null; }
    if (this._menuEsc) { document.removeEventListener('keydown', this._menuEsc, true); this._menuEsc = null; }
  },

  /* ---------- keyboard ---------- */
  _onKey(e) {
    if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
    if (e.code !== 'KeyT' && e.code !== 'KeyW') return;
    if (U.isTyping(e.target)) return;
    if (document.getElementById('draw-settings-dialog') ||
        document.getElementById('save-layout-dialog') ||
        document.getElementById('sym-dialog')) return;
    if (e.code === 'KeyT') {
      e.preventDefault();
      e.stopPropagation();
      this.newFromPicker();
    } else {
      e.preventDefault();
      e.stopPropagation();
      if (this.activeId) this.closeTab(this.activeId);
    }
  },

  /* ---------- ROUND122 · undock / dock-back (Chrome tab behaviour) ---------- */

  /* HOST side: pop this tab out into its own OS window. The tab record rides
     the IPC payload (main.js keeps it in memory and hands it to the new
     window's first tabs:claim — ROUND123, deterministic) AND a localStorage
     key (fallback for the claim-less path). main.js opens a BrowserWindow
     loading index.html#solo=<id>, and the source tab is removed from this
     strip — Chrome removes it only after the new window actually exists, and
     so do we (full rollback on failure). */
  async undockTab(id) {
    if (!window.mt5Tabs || !window.mt5Tabs.undock) {
      try { UI.toast('Detached windows are only available in the desktop app'); } catch (e) {}
      return;
    }
    if (SOLO_ID != null) return; // a solo never re-detaches onto itself
    const idx = this.list.findIndex((t) => t.id === id);
    if (idx < 0) return;
    if (id === this.activeId) this.capture();   // hand over the LIVE state
    let rec;
    try { rec = JSON.parse(JSON.stringify(this.list[idx])); } catch (e) { return; }
    const soloId = nid().slice(1) + Date.now().toString(36);
    U.lsSet('mt5_tab_solo_' + soloId, { v: K.v, tabs: [rec], active: rec.id, ts: Date.now() });
    const wasActive = id === this.activeId;
    this.list.splice(idx, 1);
    if (wasActive && this.list.length) {
      const next = this.list[idx] || this.list[idx - 1];
      this.activeId = next.id;
      this._restore(next);
    }
    this._persist();
    this.render();
    const mode = (() => {
      try { return new URLSearchParams(location.search).get('mode') === 'mt5' ? 'mt5' : 'demo'; }
      catch (e) { return 'demo'; }
    })();
    let r = null;
    try { r = await window.mt5Tabs.undock({ soloId, mode, rec }); } catch (e) { Log.warn('chart', 'undock request failed', e) }
    if (!r || !r.ok) {
      /* rollback: the window did not open — put the tab back exactly where it was */
      try { localStorage.removeItem('mt5_tab_solo_' + soloId); } catch (e) {}
      this.list.splice(idx, 0, rec);
      if (wasActive) { this.activeId = rec.id; this._restore(rec); }
      this._persist();
      this.render();
      try { UI.toast('Could not open the detached window'); } catch (e) {}
      return;
    }
    if (!this.list.length) {
      /* Chrome: dragging the LAST tab out closes the source window; with
         solo windows alive the app keeps running (window-all-closed rules) */
      try { U.lsSet(K.key, { v: K.v, tabs: [], active: null }); } catch (e) {}
      window.close();
    }
  },

  /* SOLO side: send this tab back to the host strip. ROUND123: the record
     travels INSIDE the dockback IPC payload (main.js forwards it to the host
     renderer with the request) — the previous mt5_tab_dockback_* localStorage
     handoff never reached a live host renderer (no cross-renderer
     propagation in Electron), so dock-back silently died. The host acks
     through main.js and only then the record leaves this window. No host
     window standing -> this window PROMOTES itself to the main window
     (last window wins). */
  async dockbackTab(id) {
    if (SOLO_ID == null || !window.mt5Tabs || !window.mt5Tabs.dockback) return;
    const idx = this.list.findIndex((t) => t.id === id);
    if (idx < 0) return;
    if (id === this.activeId) this.capture();
    const rec = this.list[idx];
    let copy;
    try { copy = JSON.parse(JSON.stringify(rec)); } catch (e) { return; }
    delete copy._docking;
    rec._docking = true;   // dimmed while in flight (CSS)
    this.render();
    let r = null;
    try { r = await window.mt5Tabs.dockback({ soloId: SOLO_ID, rec: copy }); } catch (e) { Log.warn('chart', 'dock-back request failed', e) }
    if (!r || !r.ok) {
      /* no host alive: promote this window — its whole strip becomes the
         app's tab strip (mt5_tabs) and the solo key is retired */
      const remain = this.list.map((t) => { delete t._docking; return t; });
      U.lsSet(K.key, { v: K.v, tabs: remain, active: rec.id });
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
      try { location.hash = ''; } catch (e) {}
      setTimeout(() => location.reload(), 30);
      return;
    }
    clearTimeout(this._dockTO);
    this._dockTO = setTimeout(() => {
      const t = this.list.find((x) => x.id === rec.id);
      if (t && t._docking) {
        delete t._docking;
        this.render();
        try { UI.toast('Main window is not available'); } catch (e) {}
      }
    }, 5000);
  },

  /* HOST side: a detached window asked to hand its tab over. ROUND123: the
     record arrives INSIDE the request payload (validated by main.js) — the
     old localStorage scan could never see a key written by another live
     renderer. Any stale mt5_tab_dockback_* keys are still swept as cleanup.
     Append + activate the record, then ack so the solo drops its copy (and
     closes when empty). */
  async _acceptDock(p) {
    if (SOLO_ID != null || !window.mt5Tabs || !window.mt5Tabs.dockAck) return;
    const soloId = p && p.soloId;
    const rec = (p && p.rec && validRec(p.rec)) ? p.rec : null;
    if (!rec) return; // nothing usable — no ack; the solo's 5s guard recovers
    try {  /* legacy-key sweep (round 122 leftovers, best effort) */
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf('mt5_tab_dockback_') === 0) keys.push(k);
      }
      for (const k of keys) { try { localStorage.removeItem(k); } catch (e) {} }
    } catch (e) { Log.warn('chart', 'dock handoff cleanup failed', e) }
    this.capture();
    delete rec._docking;
    this.list.push(rec);
    this.activeId = rec.id;
    this._restore(this.list.find((t) => t.id === rec.id));
    this._persist();
    this.render();
    try { await window.mt5Tabs.dockAck({ soloId, ids: [rec.id] }); } catch (e) { Log.debug('chart', 'dock ack failed', e) }
  },

  /* SOLO side: the host confirmed the handoff — drop the acked records and
     close this window when its strip ran empty (Chrome). */
  _onDockAck(p) {
    if (SOLO_ID == null || !p || p.soloId !== SOLO_ID) return;
    const ids = Array.isArray(p.ids) ? p.ids : [];
    for (const id of ids) {
      const i = this.list.findIndex((t) => t.id === id);
      if (i >= 0) this.list.splice(i, 1);
    }
    this._persist();
    this.render();
    if (!this.list.length) {
      try { localStorage.removeItem(STORE_KEY); } catch (e) {}
      window.close();
    }
  },

  /* ---------- persistence ---------- */
  _persist() {
    /* host -> 'mt5_tabs' (round 121 contract); a detached window persists to
       its OWN key so two windows can never overwrite each other's strip */
    U.lsSet(SOLO_ID ? STORE_KEY : K.key, { v: K.v, tabs: this.list, active: this.activeId });
  },
};

/* ROUND122: feed the tab labels from the SAME tick stream the Watchlist
   uses — registered at module scope so it is wired before the boot connects.
   ROUND123 FIX (user report "tabs only show a dash"): the hook MUST go
   through an arrow wrapper. The feed calls every hook as a bare
   f(symbol, price, …) with NO receiver, so a bare `Tabs.onTick` reference
   ran with `this === undefined` (strict-mode ES module) — its `this.q`
   access threw on EVERY tick and the feed's per-hook try/catch swallowed
   it silently, so the quote cells never left their "—" placeholder. The
   Watchlist stayed alive only because it closes over `Watchlist` instead
   of `this`. The wrapper pins the receiver to the Tabs singleton. */
(App.onTickHooks = App.onTickHooks || []).push((symbol, price) => Tabs.onTick(symbol, price));

export { Tabs };
