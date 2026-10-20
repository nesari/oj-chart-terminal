/**
 * Data Window
 *
 * @module panels/datawindow
 */

import { U } from '../core/util.js';
import { TZ } from '../../../core/timezone.js';
import { App } from '../../../core/state.js';

const DataWindow = {};

  DataWindow.update = function (pane, bar) {
    const box = document.getElementById('dw-rows');
    if (!box || !bar) return;
    if (box._sym !== pane.symbol) { box.innerHTML = ''; box._sym = pane.symbol; }
    const f = (v) => U.fmtPrice(v, pane.digits);
    const chg = bar.close - bar.open;
    const pct = bar.open ? (chg / bar.open) * 100 : 0;
    const cls = chg >= 0 ? 'up' : 'down';
    box.innerHTML = `
      <div class="dw-row dw-head"><span class="dw-k">Symbol</span><span class="dw-v">${pane.symbol} · ${App.tfById[pane.tf].label}</span></div>
      <div class="dw-row"><span class="dw-k">Time (${TZ.shortLabel(App.tz)})</span><span class="dw-v">${TZ.fullLabel(App.tz, bar.time)}</span></div>
      <div class="dw-row"><span class="dw-k">Open</span><span class="dw-v">${f(bar.open)}</span></div>
      <div class="dw-row"><span class="dw-k">High</span><span class="dw-v">${f(bar.high)}</span></div>
      <div class="dw-row"><span class="dw-k">Low</span><span class="dw-v">${f(bar.low)}</span></div>
      <div class="dw-row"><span class="dw-k">Close</span><span class="dw-v">${f(bar.close)}</span></div>
      <div class="dw-row"><span class="dw-k">Change</span><span class="dw-v ${cls}">${chg >= 0 ? '+' : ''}${f(chg)} (${chg >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span></div>
      <div class="dw-row"><span class="dw-k">Volume</span><span class="dw-v">${bar.volume != null ? bar.volume.toLocaleString('en-US') : '—'}</span></div>`;
  };

export { DataWindow };
