/**
 * Watchlist (ROUND131: TradingView Watchlist parity)
 *
 * The panel is a pixel-faithful replica of the TradingView watchlist:
 *   - compact mode: [logo] [symbol + description] [last price with a
 *     superscript last digit] and [change + change%] underneath, green/red
 *   - table mode: Symbol | Last | Chg | Chg% | Vol | Ext columns
 *   - header: title + chevron, "+" add symbol, grid (instant table toggle)
 *     and "…" opening the TV "Table view" dropdown (Table view switch,
 *     CUSTOMIZE COLUMNS, SYMBOL DISPLAY logo/title radio)
 *   - "Sort by" menu on the compact column header (manual / A-Z / price /
 *     gainers / losers), persisted
 *   - Change is anchored to the PREVIOUS DAILY CLOSE (fetched once via one
 *     small D1 bars request per symbol when the panel opens and refreshed
 *     every 10 min — the same reference TV uses), so Chg/Chg% match the
 *     platform instead of an arbitrary session start
 *   - Vol is the current daily bar's volume, formatted "741.26 K"
 *   - Extended Hours has no source on our feeds yet: the column shows "—"
 * BUG-013 lifecycle kept intact: while the panel is OPEN every listed symbol
 * holds one ref-counted subscription (Manager.acquireSub/releaseSub); rows
 * that stop ticking dim to a "stale" state with an explanatory tooltip.
 *
 * @module panels/watchlist
 */

import { U } from '../core/util.js';
import { icon } from '../ui/icons.js';
import { App } from '../../../core/state.js';
import { priceDigits } from '../../../core/feed.js';
import { Manager } from '../chart/manager.js';
import { Toolbar } from '../chart/toolbar.js';
import { UI } from '../drawing/ui.js';

const Watchlist = { prices: {}, dir: {}, _dirty: {}, ba: {}, _lastTickAt: {}, open: false, ref: {} };

  /* ROUND131 view config (TV "Table view" dropdown):
     table mode + per-column visibility + symbol display (logo/title) */
  Watchlist.view = Object.assign(
    { table: false, last: true, chg: true, chgpct: true, vol: false, ext: false,
      logo: true, title: 'symbol' },
    U.lsGet('mt5_wl_tv', {})
  );
  Watchlist.sort = U.lsGet('mt5_wl_sort', 'manual') || 'manual';
  const saveView = () => U.lsSet('mt5_wl_tv', Watchlist.view);
  const saveSort = () => U.lsSet('mt5_wl_sort', Watchlist.sort);

  /* curated badge colours for common assets; everything else hashes */
  const LOGO_COLORS = {
    XAUUSD: '#f0b90b', XAGUSD: '#9e9e9e', XPTUSD: '#7ec8e3', XPDUSD: '#8d99ae',
    BTCUSD: '#f7931a', ETHUSD: '#627eea', USOIL: '#43a047', UKOIL: '#2e7d32',
    US30: '#2962ff', NAS100: '#00bcd4', SPX500: '#5e35b1', US500: '#5e35b1',
    GER40: '#d32f2f', UK100: '#1e88e5', JP225: '#ef6c00', HK50: '#c62828',
    EURUSD: '#3949ab', GBPUSD: '#6a1b9a', USDJPY: '#c62828', USDCHF: '#c62828',
    AUDUSD: '#00897b', NZDUSD: '#00897b', USDCAD: '#b71c1c', DXY: '#455a64',
  };
  function logoFor(sym) {
    if (LOGO_COLORS[sym]) return { bg: LOGO_COLORS[sym], ch: sym[0] };
    let h = 0;
    for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) >>> 0;
    return { bg: `hsl(${h % 360}, 52%, 42%)`, ch: sym[0] };
  }

  /* ROUND131: TV-style human descriptions under the symbol — curated for the
     common assets, empty for broker-specific names (the row simply shows the
     ticker alone, exactly like TV when a description is missing) */
  const SYM_NAMES = {
    XAUUSD: 'Gold Spot / U.S. Dollar', XAGUSD: 'Silver Spot / U.S. Dollar',
    XPTUSD: 'Platinum Spot / U.S. Dollar', XPDUSD: 'Palladium Spot / U.S. Dollar',
    EURUSD: 'Euro / U.S. Dollar', GBPUSD: 'British Pound / U.S. Dollar',
    USDJPY: 'U.S. Dollar / Japanese Yen', USDCHF: 'U.S. Dollar / Swiss Franc',
    AUDUSD: 'Australian Dollar / U.S. Dollar', NZDUSD: 'New Zealand Dollar / U.S. Dollar',
    USDCAD: 'U.S. Dollar / Canadian Dollar', USDCNH: 'U.S. Dollar / Offshore Yuan',
    EURJPY: 'Euro / Japanese Yen', GBPJPY: 'British Pound / Japanese Yen',
    DXY: 'U.S. Dollar Index',
    BTCUSD: 'Bitcoin / U.S. Dollar', ETHUSD: 'Ethereum / U.S. Dollar',
    XRPUSD: 'Ripple / U.S. Dollar', LTCUSD: 'Litecoin / U.S. Dollar',
    USOIL: 'Crude Oil WTI', UKOIL: 'Crude Oil Brent', WTI: 'West Texas Intermediate Crude Oil',
    BRENT: 'Crude Oil Brent Cash', NATGAS: 'Natural Gas',
    US30: 'Dow Jones Industrial Average', US30USD: 'US Wall St. 30',
    NAS100: 'US Tech 100 Index', USTEC: 'US Tech 100 Index', NDXUSD: 'US Tech 100',
    SPX500: 'S&P 500 Index', US500: 'S&P 500 Index', SPXUSD: 'S&P 500 Index',
    GER40: 'Germany 40 Index', DAX40: 'Germany 40 Index', UK100: 'FTSE 100 Index',
    JP225: 'Japan 225 Index', HK50: 'Hong Kong 50 Index', AUS200: 'Australia 200 Index',
    'GC1!': 'Gold Futures', 'SI1!': 'Silver Futures', 'CL1!': 'Crude Oil Futures',
  };
  const nameOf = (sym) => SYM_NAMES[sym] || '';

  /* price with the TV superscript: the LAST decimal digit is pulled out and
     raised (4,284.97⁰) — the look every TV watchlist row has */
  function priceHtml(sym, p) {
    if (p == null || !isFinite(p)) return '\u2014';
    const d = priceDigits(sym);
    const s = U.fmtPrice(p, d);
    if (d > 0 && /\d/.test(s.slice(-1))) {
      return U.esc(s.slice(0, -1)) + '<sup>' + U.esc(s.slice(-1)) + '</sup>';
    }
    return U.esc(s);
  }

  /* daily volume formatting (TV style): 741.26 K / 1.28 M / 222 */
  function fmtVol(n) {
    if (n == null || !isFinite(n) || n <= 0) return '\u2014';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + ' M';
    if (n >= 1e3) return (n / 1e3).toFixed(2) + ' K';
    return String(Math.round(n));
  }

  /* previous-close reference: Chg = last - prevClose(D1) — TV's own anchor.
     One small D1 request per symbol. ROUND131 fix: the fetch no longer runs
     ONCE on the open transition (it was lost forever when the panel restored
     before the websocket was live — dashes until the next reopen). An
     "ensure" loop re-fetches any symbol that still lacks its reference and
     refreshes the day volume every 10 min. Failures leave dash-only cells,
     never a fake number. */
  Watchlist.fetchRefs = async function () {
    Watchlist._lastRefFetch = Date.now();
    /* the websocket may still be handshaking when the panel restores from a
       saved session — wait (bounded 20 s) instead of failing this pass and
       leaving dashes until the next ensure-loop tick */
    for (let i = 0; i < 40; i++) {
      if (App.feed && App.feed.ws && App.feed.ws.readyState === 1) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const syms = App.watchlist.slice();
    for (const sym of syms) {
      if (Watchlist.ref[sym] && Date.now() - (Watchlist.ref[sym].at || 0) < 9 * 60e3) continue;
      try {
        const r = await App.feed.bars(sym, 'D1', 3);
        const bars = (r && r.bars) || [];
        if (bars.length >= 2) {
          const last = bars[bars.length - 1];
          const prev = bars[bars.length - 2];
          Watchlist.ref[sym] = { pc: prev.close, vol: last.volume || 0, at: Date.now() };
          Watchlist._dirty[sym] = true;
        }
      } catch (e) { /* provider without D1 — dash-only cells */ }
    }
    render();
  };
  Watchlist.invalidateRefs = function () {
    for (const s of Object.keys(Watchlist.ref)) Watchlist.ref[s].at = 0;
  };

  Watchlist.init = function () {
    const addBtn = document.getElementById('wl-add-btn');
    addBtn.innerHTML = icon('plus');
    addBtn.addEventListener('click', () => {
      const row = document.getElementById('wl-add-row');
      row.classList.toggle('hidden');
      if (!row.classList.contains('hidden')) {
        const inp = document.getElementById('wl-add-input');
        inp.value = '';
        U.clear(document.getElementById('wl-add-results'));
        setTimeout(() => inp.focus(), 30);
      }
    });
    /* grid button = instant table-mode toggle (the icon paints "on" while
       the table view is active — TV behaviour) */
    const tableBtn = document.getElementById('wl-table-btn');
    if (tableBtn) {
      tableBtn.innerHTML = icon('grid');
      tableBtn.addEventListener('click', () => {
        Watchlist.view.table = !Watchlist.view.table;
        saveView(); render();
      });
    }
    /* "…" = the TV Table view dropdown (switch + columns + symbol display) */
    const viewBtn = document.getElementById('wl-view-btn');
    if (viewBtn) {
      viewBtn.innerHTML = icon('dots');
      viewBtn.addEventListener('click', () => {
        const r = viewBtn.getBoundingClientRect();
        Toolbar.popupAt(r.right - 224, r.bottom + 4, (p) => {
          p.classList.add('wl-menu');
          /* Table view master switch (toggle row with a pill switch) */
          const tvRow = U.el('div', 'wl-m-tv', p);
          tvRow.innerHTML = '<span>Table view</span>';
          const tvSw = U.el('label', 'sw-mini', tvRow);
          tvSw.innerHTML = `<input type="checkbox"${Watchlist.view.table ? ' checked' : ''}><i></i>`;
          tvSw.querySelector('input').addEventListener('change', (e) => {
            Watchlist.view.table = e.target.checked;
            saveView(); render();
          });
          U.el('div', 'wl-m-cap', p).textContent = 'Customize columns';
          const colRow = (key, label) => {
            const it = U.el('button', 'wl-m-item', p);
            it.innerHTML = `<span class="wl-m-check${Watchlist.view[key] ? ' on' : ''}">${icon(Watchlist.view[key] ? 'checkOn' : 'checkOff')}</span><span>${label}</span>`;
            it.addEventListener('click', () => {
              Watchlist.view[key] = !Watchlist.view[key];
              saveView(); render();
              const chk = it.querySelector('.wl-m-check');
              chk.classList.toggle('on', Watchlist.view[key]);
              chk.innerHTML = icon(Watchlist.view[key] ? 'checkOn' : 'checkOff');
            });
          };
          colRow('last', 'Last');
          colRow('chg', 'Change');
          colRow('chgpct', 'Change %');
          colRow('vol', 'Volume');
          colRow('ext', 'Extended Hours');
          U.el('div', 'wl-m-cap', p).textContent = 'Symbol display';
          /* Logo is a checkbox; the title is a Symbol/Name radio pair */
          const lg = U.el('button', 'wl-m-item', p);
          lg.innerHTML = `<span class="wl-m-check${Watchlist.view.logo ? ' on' : ''}">${icon(Watchlist.view.logo ? 'checkOn' : 'checkOff')}</span><span>Logo</span>`;
          lg.addEventListener('click', () => {
            Watchlist.view.logo = !Watchlist.view.logo;
            saveView(); render();
            const chk = lg.querySelector('.wl-m-check');
            chk.classList.toggle('on', Watchlist.view.logo);
            chk.innerHTML = icon(Watchlist.view.logo ? 'checkOn' : 'checkOff');
          });
          const radioRow = (val, label) => {
            const it = U.el('button', 'wl-m-item', p);
            it.innerHTML = `<span class="wl-m-radio${Watchlist.view.title === val ? ' on' : ''}"></span><span>${label}</span>`;
            it.addEventListener('click', () => {
              Watchlist.view.title = val;
              saveView(); render();
              for (const o of p.querySelectorAll('.wl-m-radio')) o.classList.remove('on');
              it.querySelector('.wl-m-radio').classList.add('on');
            });
          };
          radioRow('symbol', 'Symbol');
          radioRow('name', 'Name');
        });
      });
    }
    const inp = document.getElementById('wl-add-input');
    inp.addEventListener('input', U.debounce(async () => {
      const q = inp.value.trim();
      const box = document.getElementById('wl-add-results');
      try {
        /* ROUND36: search() resolves {symbols, total} */
        const { symbols: syms } = await App.feed.search(q);
        U.clear(box);
        for (const s of syms.slice(0, 12)) {
          const it = U.el('button', 'pu-item', box);
          it.style.padding = '6px 8px'; it.style.fontSize = '12.5px';
          /* SECURITY: s is a symbol string returned by the feed provider's
             search() call, not a hardcoded literal — escape before innerHTML
             (same class of fix as panels/news.js). */
          it.innerHTML = `<b>${U.esc(s)}</b>`;
          it.addEventListener('click', () => { Watchlist.add(s); inp.value = ''; U.clear(box); document.getElementById('wl-add-row').classList.add('hidden'); });
          box.appendChild(it);
        }
      } catch (e) {}
    }, 200));
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') document.getElementById('wl-add-row').classList.add('hidden');
      if (e.key === 'Enter') {
        const first = document.querySelector('#wl-add-results .pu-item');
        if (first) first.click();
      }
    });
    render();
    /* BUG-013: subscriptions follow the PANEL lifecycle (open -> all symbols,
       closed -> none). The old unconditional subscribe-all here ran while the
       websocket was still closed (boot), every subscribe was silently
       dropped, and only the chart's own symbol ever ticked — the watchlist
       behaved like an on-demand fetch (dashes everywhere). */
    /* dirty-row renderer: 400ms, only rows whose price changed (round 17) */
    setInterval(() => {
      for (const sym of Object.keys(this._dirty)) {
        if (!this._dirty[sym]) continue;
        this._dirty[sym] = false;
        this.updateRow(sym);
      }
    }, 400);
  };

  /* BUG-013 lifecycle: open => batch-subscribe ALL listed symbols (one
     ref-counted sub each, shared with the chart's own sub); close => release
     them. Reopen re-subscribes and re-renders from the first ticks.
     ROUND131: opening also (re)fetches the daily references — prev close +
     day volume — that power the Chg / Chg% / Vol columns. */
  Watchlist.setPanelOpen = function (open) {
    open = !!open;
    if (open === Watchlist.open) return;
    Watchlist.open = open;
    if (typeof Manager === 'undefined' || !Manager.acquireSub) return;
    if (open) {
      for (const s of App.watchlist) Manager.acquireSub(s);
      Watchlist.highlightActive();
      Watchlist.fetchRefs();
      clearInterval(Watchlist._refTimer);
      /* ROUND131: the ensure loop — re-fetch refs that are still missing
         (websocket came up late) and refresh the day volume every 10 min */
      Watchlist._refTimer = setInterval(() => {
        if (!Watchlist.open) return;
        const missing = App.watchlist.some((s) => !Watchlist.ref[s]);
        const last = Watchlist._lastRefFetch || 0;
        if ((missing && Date.now() - last > 12e3) || Date.now() - last > 10 * 60e3) {
          Watchlist.fetchRefs();
        }
      }, 5e3);
    } else {
      for (const s of App.watchlist) Manager.releaseSub(s);
      clearInterval(Watchlist._refTimer);
    }
  };

  /* the display order — "manual" keeps the persisted order, everything else
     sorts a COPY (add/remove keep working on the real list) */
  function ordered() {
    const list = App.watchlist.slice();
    const px = (s) => (Watchlist.prices[s] != null ? Watchlist.prices[s] : null);
    const chg = (s) => {
      const r = Watchlist.ref[s];
      if (!r || px(s) == null) return null;
      return px(s) - r.pc;
    };
    if (Watchlist.sort === 'az') list.sort((a, b) => a.localeCompare(b));
    else if (Watchlist.sort === 'price_hi') list.sort((a, b) => (px(b) ?? -Infinity) - (px(a) ?? -Infinity));
    else if (Watchlist.sort === 'price_lo') list.sort((a, b) => (px(a) ?? Infinity) - (px(b) ?? Infinity));
    else if (Watchlist.sort === 'gain') list.sort((a, b) => (chg(b) ?? -Infinity) - (chg(a) ?? -Infinity));
    else if (Watchlist.sort === 'lose') list.sort((a, b) => (chg(a) ?? Infinity) - (chg(b) ?? Infinity));
    return list;
  }

  /* the visible table-mode column set, in TV order */
  function columns() {
    const V = Watchlist.view;
    const c = ['sym'];
    if (V.last) c.push('last');
    if (V.chg) c.push('chg');
    if (V.chgpct) c.push('chgpct');
    if (V.vol) c.push('vol');
    if (V.ext) c.push('ext');
    return c;
  }

  function render() {
    const list = document.getElementById('wl-list');
    if (!list) return;
    U.clear(list);
    const V = Watchlist.view;
    list.classList.toggle('wl-table', !!V.table);
    const logoVisible = !!V.logo;

    if (!V.table) {
      /* compact column header: "Symbol" + "Sort by ⌄" (TV) */
      const head = U.el('div', 'wl-row wl-head wl-chead', list);
      head.innerHTML =
        `<span class="wl-h-sym">Symbol</span>` +
        `<span class="wl-h-sort" title="Sort the list">${U.esc(sortLabel())}<span class="wl-h-chev">${icon('chevdown')}</span></span>`;
      head.querySelector('.wl-h-sort').addEventListener('click', (e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        Toolbar.popupAt(r.right - 170, r.bottom + 4, (p) => {
          const item = (key, label) => {
            const it = U.el('button', 'wl-m-item' + (Watchlist.sort === key ? ' on' : ''), p);
            it.innerHTML = `<span class="wl-m-check">${Watchlist.sort === key ? icon('checkOn') : ''}</span><span>${label}</span>`;
            it.addEventListener('click', () => { Watchlist.sort = key; saveSort(); render(); });
          };
          item('manual', 'Manual order');
          item('az', 'Symbol A\u2013Z');
          item('price_hi', 'Price high\u2013low');
          item('price_lo', 'Price low\u2013high');
          item('gain', 'Top gainers');
          item('lose', 'Top losers');
        });
      });
    } else {
      /* table header row sharing the SAME grid template as the body rows */
      const cols = columns();
      const head = U.el('div', 'wl-row wl-head wl-thead', list);
      const labels = { sym: 'Symbol', last: 'Last', chg: 'Chg', chgpct: 'Chg%', vol: 'Vol', ext: 'Ext' };
      for (const c of cols) U.el('span', 'wl-c wl-c-' + c, head).textContent = labels[c];
      applyGrid(head, cols);
    }

    for (const sym of ordered()) {
      const row = U.el('div', V.table ? 'wl-row wl-trow' : 'wl-row', list);
      row.dataset.sym = sym;
      const lg = logoFor(sym);
      const nm = nameOf(sym);
      const title = V.title === 'name' && nm ? nm : sym;
      const logoHtml = logoVisible
        ? `<span class="wl-logo"></span>` : '<span class="wl-logo wl-logo-off"></span>';
      const descHtml = (!V.table && nm && V.title !== 'name')
        ? `<span class="wl-name">${U.esc(nm)}</span>` : '';
      if (V.table) {
        const cols = columns(); /* ROUND131 fix: scope-safe column list */
        /* ROUND131 fix: the logo lives INSIDE the Symbol cell so the grid
           tracks stay aligned between the header and the body rows */
        const logoInSym = logoVisible
          ? `<span class="wl-logo wl-logo-sm"></span>` : '';
        row.innerHTML =
          `<span class="wl-c wl-c-sym">${logoInSym}<span class="wl-sym">${U.esc(title)}<i class="wl-dot"></i></span></span>` +
          `<span class="wl-c wl-c-last">\u2014</span>` +
          `<span class="wl-c wl-c-chg">\u2014</span>` +
          `<span class="wl-c wl-c-chgpct">\u2014</span>` +
          `<span class="wl-c wl-c-vol">\u2014</span>` +
          `<span class="wl-c wl-c-ext">\u2014</span>`;
        applyGrid(row, cols);
        if (logoVisible) {
          const lgEl = row.querySelector('.wl-logo');
          if (lgEl) {
            lgEl.textContent = lg.ch;
            lgEl.style.background = lg.bg;
          }
        }
        /* hide the cells whose columns are off (grid track list already
           excludes them, the spans just must not paint) */
        for (const c of ['last', 'chg', 'chgpct', 'vol', 'ext']) {
          if (!cols.includes(c)) {
            const el = row.querySelector('.wl-c-' + c);
            if (el) el.style.display = 'none';
          }
        }
      } else {
        row.innerHTML = logoHtml +
          `<span class="wl-id">` +
            `<span class="wl-sym">${U.esc(title)}<i class="wl-dot"></i></span>${descHtml}` +
          `</span>` +
          `<span class="wl-nums">` +
            `<span class="wl-price">\u2014</span>` +
            `<span class="wl-chg"></span>` +
          `</span>`;
      }
      if (logoVisible) {
        const lgEl = row.querySelector('.wl-logo');
        if (lgEl) {
          lgEl.textContent = lg.ch;
          /* round 81 CSP hardening: computed color set via CSSOM property (not
             the style="" attribute), so style-src no longer needs unsafe-inline */
          lgEl.style.background = lg.bg;
        }
      }
      if (App.activePane && App.activePane.symbol === sym) row.classList.add('active');
      row.addEventListener('click', () => {
        if (App.activePane) Manager.setSymbol(App.activePane, sym);
        Watchlist.highlightActive();
      });
      const del = U.el('button', 'wl-del', row);
      del.innerHTML = icon('x');
      del.title = 'Remove';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        Watchlist.remove(sym);
      });
      Watchlist.updateRow(sym);
    }
    /* keep the header buttons in sync with the mode */
    const tb = document.getElementById('wl-table-btn');
    if (tb) tb.classList.toggle('on', !!V.table);
  }
  Watchlist.render = render;

  function sortLabel() {
    return { manual: 'Sort by', az: 'A\u2013Z', price_hi: 'Price \u2193', price_lo: 'Price \u2191',
      gain: 'Gainers', lose: 'Losers' }[Watchlist.sort] || 'Sort by';
  }

  /* the shared CSS grid for the table header + rows (CSP-safe: CSSOM).
     Numeric tracks are minmax so narrow panels compress gracefully. */
  function applyGrid(el, cols) {
    const w = { sym: 'minmax(56px, 1fr)', last: 'minmax(56px, 72px)', chg: 'minmax(48px, 60px)',
      chgpct: 'minmax(44px, 52px)', vol: '54px', ext: '44px' };
    el.style.gridTemplateColumns = cols.map((c) => w[c]).join(' ');
  }

  Watchlist.updateRow = function (sym) {
    const row = document.querySelector(`.wl-row[data-sym="${sym}"]`);
    if (!row) return;
    const p = Watchlist.prices[sym];
    const ref = Watchlist.ref[sym];
    /* BUG-013 staleness guard: a row whose ticks stopped (closed market /
       weekend / dead feed) dims its last known value with an explanatory
       tooltip — never a silent dash, never a fake fresh look */
    const stale = p != null && Watchlist._lastTickAt[sym] != null &&
      (Date.now() - Watchlist._lastTickAt[sym] > 30000);

    const chgVal = (ref && p != null) ? (p - ref.pc) : null;
    const chgPct = (chgVal != null && ref.pc) ? (chgVal / ref.pc) * 100 : null;
    const dirCls = chgVal != null ? (chgVal >= 0 ? 'up' : 'down') : '';

    if (row.classList.contains('wl-trow')) {
      const set = (cls, html, cls2) => {
        const el = row.querySelector(cls);
        if (!el) return;
        el.innerHTML = html;
        if (cls2 != null) { el.classList.remove('up', 'down'); if (cls2) el.classList.add(cls2); }
        el.classList.toggle('stale', stale);
      };
      set('.wl-c-last', priceHtml(sym, p));
      set('.wl-c-chg', chgVal != null ? U.esc(U.fmtPrice(Math.abs(chgVal) < 1e-12 ? 0 : chgVal, priceDigits(sym))) : '\u2014', dirCls);
      set('.wl-c-chgpct', chgPct != null ? U.esc((chgPct >= 0 ? '+' : '\u2212') + Math.abs(chgPct).toFixed(2) + '%') : '\u2014', dirCls);
      set('.wl-c-vol', ref ? U.esc(fmtVol(ref.vol)) : '\u2014');
      set('.wl-c-ext', '\u2014'); /* extended hours: no feed source yet */
      row.title = stale ? 'no ticks — market closed' : '';
      return;
    }

    const priceEl = row.querySelector('.wl-price');
    if (priceEl) {
      priceEl.innerHTML = priceHtml(sym, p);
      priceEl.classList.toggle('stale', stale);
    }
    const chgEl = row.querySelector('.wl-chg');
    if (chgEl) {
      if (chgVal != null) {
        const sgn = chgVal >= 0 ? '+' : '\u2212';
        chgEl.innerHTML =
          `<span class="wl-chg-v">${sgn}${U.esc(U.fmtPrice(Math.abs(chgVal), priceDigits(sym)))}</span>` +
          (chgPct != null ? `<b class="wl-chg-p">${sgn}${Math.abs(chgPct).toFixed(2)}%</b>` : '');
        chgEl.classList.remove('up', 'down');
        chgEl.classList.add(dirCls);
      } else {
        chgEl.innerHTML = '';
      }
      chgEl.classList.toggle('stale', stale);
    }
    row.title = stale ? 'no ticks — market closed' : '';
  };

  Watchlist.add = function (sym) {
    sym = sym.toUpperCase().trim();
    if (!sym || App.watchlist.includes(sym)) return;
    App.watchlist.push(sym);
    U.lsSet('mt5_watchlist', App.watchlist);
    /* BUG-013: added while the panel is open => subscribe immediately */
    if (Watchlist.open && Manager.acquireSub) Manager.acquireSub(sym);
    if (Watchlist.open) Watchlist.fetchRefs();
    render();
  };

  /* UX FIX: removal used to be instant + permanent (one misclick on the row
     "x" silently dropped a symbol with no way back). Now it's optimistic —
     the row disappears right away, but the symbol + its screen position are
     kept for a few seconds so a "Removed SYM — Undo" toast can restore it
     exactly where it was, instead of appending it at the end of the list. */
  Watchlist.remove = function (sym) {
    const idx = App.watchlist.indexOf(sym);
    if (idx === -1) return;
    App.watchlist = App.watchlist.filter((s) => s !== sym);
    U.lsSet('mt5_watchlist', App.watchlist);
    /* BUG-013: a row removed while the panel is open releases its sub */
    if (Watchlist.open && Manager.releaseSub) Manager.releaseSub(sym);
    delete Watchlist.prices[sym]; delete Watchlist.ba[sym]; delete Watchlist.ref[sym];
    delete Watchlist.dir[sym]; delete Watchlist._dirty[sym]; delete Watchlist._lastTickAt[sym];
    render();
    if (UI && UI.toast) {
      UI.toast(`Removed <b>${U.esc(sym)}</b> from watchlist`, null, {
        actionLabel: 'Undo',
        onAction: () => {
          if (App.watchlist.includes(sym)) return; /* re-added another way meanwhile */
          App.watchlist.splice(Math.min(idx, App.watchlist.length), 0, sym);
          U.lsSet('mt5_watchlist', App.watchlist);
          if (Watchlist.open && Manager.acquireSub) Manager.acquireSub(sym);
          if (Watchlist.open) Watchlist.fetchRefs();
          render();
        },
      });
    }
  };

  Watchlist.highlightActive = function () {
    document.querySelectorAll('.wl-row').forEach((r) => {
      r.classList.toggle('active', !!(App.activePane && r.dataset.sym === App.activePane.symbol));
    });
  };

  /* BUG-004: every tick feeds the row store directly — Last, Chg/Chg% (vs the
     D1 previous close) and the staleness clock all come from this hook */
  Watchlist.onTick = function (symbol, price, time, volume, bid, ask) {
    const prev = Watchlist.prices[symbol];
    Watchlist.prices[symbol] = price;
    if (prev != null) Watchlist.dir[symbol] = price >= prev ? 'up' : 'down';
    if (bid != null && ask != null && bid > 0 && ask > bid) {
      Watchlist.ba[symbol] = { bid, ask };
    }
    Watchlist._lastTickAt[symbol] = Date.now();
    Watchlist._dirty[symbol] = true;
  };

  (App.onTickHooks = App.onTickHooks || []).push(Watchlist.onTick);
export { Watchlist };
