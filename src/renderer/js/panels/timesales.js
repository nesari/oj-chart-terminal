/**
 * Time & Sales (round 17): live tick table for the ACTIVE chart symbol
 *
 * Time / Bid / Ask / Last / Volume — fed ONLY by the existing tick stream.
 *
 * @module panels/timesales
 */

import { U } from '../core/util.js';
import { TZ } from '../../../core/timezone.js';
import { App } from '../../../core/state.js';

const MAX = 400;
  const SHOW = 80;

  const TimeSales = {
    _buf: [],
    _dirty: false,

    init() {
      App.feed.onTick.push((symbol, price, time, volume, bid, ask) => {
        const pane = App.activePane;
        if (!pane || pane.symbol !== symbol) return;
        this._buf.push({ time, price, volume, bid, ask });
        if (this._buf.length > MAX) this._buf.splice(0, this._buf.length - MAX);
        this._dirty = true;
      });
      setInterval(() => this.render(), 250);
    },

    render() {
      const list = document.getElementById('ts-list');
      if (!list) return;
      const tab = document.getElementById('tab-timesales');
      if (!tab || tab.classList.contains('hidden')) return; // render only when visible
      if (!this._dirty) return;
      this._dirty = false;
      const pane = App.activePane;
      const head = document.getElementById('ts-head');
      if (head && pane) {
        let sym = head.querySelector('.ts-sym');
        if (!sym) { sym = U.el('span', 'ts-sym', head); }
        sym.textContent = pane.symbol;
      }
      U.clear(list);
      const rows = this._buf.slice(-SHOW).reverse();
      let prev = null;
      for (const t of rows) {
        const dir = prev == null ? '' : (t.price > prev ? ' up' : t.price < prev ? ' down' : '');
        const hhmmss = TZ.tickLabel(App.tz, t.time, 'time', false);
        const r = U.el('div', 'ts-row' + dir, list);
        r.innerHTML = `<span>${hhmmss}</span>` +
          `<span>${t.bid ? U.fmtPrice(t.bid, pane ? pane.digits : 5) : '—'}</span>` +
          `<span>${t.ask ? U.fmtPrice(t.ask, pane ? pane.digits : 5) : '—'}</span>` +
          `<span>${U.fmtPrice(t.price, pane ? pane.digits : 5)}</span>` +
          `<span>${t.volume != null ? t.volume : ''}</span>`;
        prev = t.price;
      }
    },
  };

export { TimeSales };
