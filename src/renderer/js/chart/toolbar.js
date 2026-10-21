/**
 * Top toolbar: symbol, timeframes (S/m/H/M), styles, layouts, timezone
 *
 * @module chart/toolbar
 */

import { U } from '../core/util.js';
import { icon, layoutIconSvg } from '../ui/icons.js';
import { TZ } from '../../../core/timezone.js';
import { Theme } from '../core/theme.js';
import { App } from '../../../core/state.js';
import { Settings } from './settings.js';
import { Manager } from './manager.js';
import { IndicatorsUI } from './indicators-ui.js';
import { UI } from '../drawing/ui.js';
import { Alerts } from '../panels/alerts.js';
import { Replay } from '../panels/replay.js';
import { RightPanel } from '../ui/rightpanel.js';

const Toolbar = {};

  /* ---------- generic popup ---------- */
  let openPopupEl = null;
  function closePopup() {
    if (openPopupEl) {
      if (openPopupEl._onResize) window.removeEventListener('resize', openPopupEl._onResize);
      openPopupEl.remove();
      openPopupEl = null;
    }
  }
  Toolbar.closePopup = closePopup;

  function popupAt(x, y, build, cls) {
    closePopup();
    const p = U.el('div', 'popup' + (cls ? ' ' + cls : ''), document.body);
    build(p);
    document.body.appendChild(p);
    const r = p.getBoundingClientRect();
    p.style.left = U.clamp(x, 6, window.innerWidth - r.width - 6) + 'px';
    /* BUG-010: the SAME one viewport-fitting rule as the tool flyouts
       (BUG-005) — container never passes the window bottom (taskbar-safe),
       tall menus scroll inside their flexible regions instead. The anchor is
       the trigger POINT (x, y = the trigger's bottom edge). */
    U.fitPopup(p, y, y);
    openPopupEl = p;
    openPopupEl._onResize = () => closePopup();
    window.addEventListener('resize', openPopupEl._onResize);
    setTimeout(() => {
      const off = (e) => { if (openPopupEl && !openPopupEl.contains(e.target)) { closePopup(); document.removeEventListener('mousedown', off); } };
      document.addEventListener('mousedown', off);
    }, 0);
    return p;
  }
  Toolbar.popupAt = popupAt;

  function starBtn(faved, onToggle) {
    const b = U.el('button', 'pu-star' + (faved ? ' faved' : ''));
    b.innerHTML = icon(faved ? 'star' : 'starOutline');
    b.title = 'Add to / remove from favorites';
    b.addEventListener('mousedown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => { e.stopPropagation(); onToggle(b); });
    return b;
  }

  /* ---------- custom colour picker (TV-style full editor, round 22) ----------
     Electron opens the native <input type=color> popup detached from the
     dialog — this in-app picker opens NEXT TO the swatch that was clicked,
     with a palette grid, a FULL HSV editor (saturation/value square + hue
     slider), a hex field and an optional opacity row, applying live. */
  const CP_PALETTE = [
    '#ffffff', '#d1d4dc', '#9598a1', '#787b86', '#5d606b', '#363a45', '#1e222d', '#131722',
    '#f23645', '#ff6b6b', '#ff9800', '#f7c948', '#fdd835', '#c6ff00', '#b2ff59', '#089981',
    '#4caf50', '#00e676', '#00bcd4', '#26c6da', '#2962ff', '#5b7fff', '#7e57c2', '#9c27b0',
    '#e91e63', '#f50057', '#784212', '#8d6e63', '#a1887f', '#c8a27a', '#263238', '#00e5ff',
  ];
  function cpHex2Rgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return { r: 41, g: 98, b: 255 };
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function cpRgb2Hex(r, g, b) {
    const c = (v) => U.clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
  }
  function cpRgb2Hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h, s: mx ? d / mx : 0, v: mx };
  }
  function cpHsv2Hex(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return cpRgb2Hex((r + m) * 255, (g + m) * 255, (b + m) * 255);
  }
  Toolbar.colorPickerAt = function (x, y, current, onPick, opts) {
    popupAt(x, y, (p) => {
      p.classList.add('color-picker');
      const hsv = cpRgb2Hsv(cpHex2Rgb(current).r, cpHex2Rgb(current).g, cpHex2Rgb(current).b);
      const cur = U.toHex(current || '#2962ff');
      /* preview + hex (top) */
      const hexRow = U.el('div', 'cp-hexrow', p);
      const prev = U.el('span', 'cp-prev', hexRow);
      prev.style.background = cur;
      const inp = document.createElement('input');
      inp.className = 'cp-hex';
      inp.spellcheck = false;
      inp.maxLength = 7;
      inp.value = cur;
      hexRow.appendChild(inp);
      const apply = (hex, hsvNext) => {
        prev.style.background = hex;
        inp.value = hex;
        onPick(hex);
        if (hsvNext) paintSV(hsvNext.h);
      };
      /* saturation/value square (TV colour editor) */
      const sv = U.el('div', 'cp-sv', p);
      const svThumb = U.el('span', 'cp-sv-thumb', sv);
      const hue = U.el('div', 'cp-hue', p);
      const hueThumb = U.el('span', 'cp-hue-thumb', hue);
      const paintSV = (hueVal) => {
        sv.style.background =
          `linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(${hueVal},100%,50%))`;
      };
      const syncUI = () => {
        const hex = cpHsv2Hex(hsv.h, hsv.s, hsv.v);
        svThumb.style.left = (hsv.s * 100) + '%';
        svThumb.style.top = ((1 - hsv.v) * 100) + '%';
        svThumb.style.background = hex;
        hueThumb.style.left = ((hsv.h / 360) * 100) + '%';
        paintSV(hsv.h);
        apply(hex);
      };
      const bindDrag = (el, fn) => {
        const move = (ev) => {
          const r = el.getBoundingClientRect();
          fn(U.clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1),
             U.clamp((ev.clientY - r.top) / Math.max(1, r.height), 0, 1));
        };
        el.addEventListener('pointerdown', (ev) => {
          ev.preventDefault();
          try { el.setPointerCapture(ev.pointerId); } catch (e) {}
          move(ev);
          const mv = (e2) => move(e2);
          const up = () => {
            el.removeEventListener('pointermove', mv);
            el.removeEventListener('pointerup', up);
          };
          el.addEventListener('pointermove', mv);
          el.addEventListener('pointerup', up);
        });
      };
      bindDrag(sv, (fx, fy) => { hsv.s = fx; hsv.v = 1 - fy; syncUI(); });
      bindDrag(hue, (fx) => { hsv.h = fx * 360; syncUI(); });
      syncUI();
      /* quick palette (TV presets) */
      const grid = U.el('div', 'cp-grid', p);
      for (const c of CP_PALETTE) {
        const b = U.el('button', 'cp-sw' + (c.toLowerCase() === cur.toLowerCase() ? ' on' : ''), grid);
        b.style.background = c;
        b.title = c;
        b.addEventListener('mousedown', (e) => e.stopPropagation());
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const rgb = cpHex2Rgb(c);
          const nh = cpRgb2Hsv(rgb.r, rgb.g, rgb.b);
          hsv.h = nh.h; hsv.s = nh.s; hsv.v = nh.v;
          grid.querySelectorAll('.cp-sw.on').forEach((s) => s.classList.remove('on'));
          b.classList.add('on');
          syncUI();
        });
      }
      const commit = () => {
        const v = inp.value.trim();
        if (/^#[0-9a-f]{6}$/i.test(v)) {
          const rgb = cpHex2Rgb(v);
          const nh = cpRgb2Hsv(rgb.r, rgb.g, rgb.b);
          hsv.h = nh.h; hsv.s = nh.s; hsv.v = nh.v;
          grid.querySelectorAll('.cp-sw.on').forEach((s) => s.classList.remove('on'));
          syncUI();
        }
      };
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') Toolbar.closePopup();
      });
      inp.addEventListener('change', commit);
      /* opacity row (round 21) */
      if (opts && typeof opts.onOpacity === 'function') {
        const opRow = U.el('div', 'cp-oprow', p);
        const opLab = U.el('span', 'cp-oplab', opRow);
        opLab.textContent = 'Opacity';
        const opSl = document.createElement('input');
        opSl.type = 'range';
        opSl.min = 0.05; opSl.max = 1; opSl.step = 0.05;
        opSl.value = (typeof opts.opacity === 'number' && isFinite(opts.opacity)) ? U.clamp(opts.opacity, 0.05, 1) : 1;
        const opVal = U.el('span', 'cp-opval', opRow);
        opVal.textContent = Math.round(opSl.value * 100) + '%';
        opSl.addEventListener('input', () => {
          const v = parseFloat(opSl.value);
          opVal.textContent = Math.round(v * 100) + '%';
          prev.style.opacity = String(v);
          opts.onOpacity(v);
        });
        prev.style.opacity = String(opSl.value);
        opRow.appendChild(opSl);
        opRow.appendChild(opVal);
      }
      setTimeout(() => inp.focus(), 30);
    });
  };

  /* ---------- timeframe favorites bar (sorted ascending) ---------- */
  Toolbar.renderTfFavs = function () {
    const bar = document.getElementById('tf-fav-bar');
    U.clear(bar);
    /* ROUND84 (user request): the ACTIVE chart's interval is ALWAYS pinned on
       the bar, highlighted — even when the user never starred anything (with
       zero favorites the bar used to show only the "+" button). In multi-chart
       layouts the pinned pill follows the SELECTED chart: every click on a
       chart fires Manager.setActive -> Toolbar.refreshActive -> here, and
       every TF switch re-renders through the same path (applyTf). */
    const ids = App.tfFavorites.slice();
    const activeId = App.activePane ? App.activePane.tf : null;
    if (activeId && App.tfById[activeId] && !ids.includes(activeId)) ids.push(activeId);
    const favs = ids.sort((a, b) => (App.tfById[a] ? App.tfById[a].sec : 0) - (App.tfById[b] ? App.tfById[b].sec : 0));
    for (const id of favs) {
      const tf = App.tfById[id];
      if (!tf) continue;
      const b = U.el('button', 'tb-btn tb-text', bar);
      b.textContent = tf.label;
      b.title = tf.custom ? `Custom interval ${tf.id}` : tf.id;
      if (App.activePane && App.activePane.tf === id) b.classList.add('active');
      b.addEventListener('click', () => { if (App.activePane) Manager.setTf(App.activePane, id); Toolbar.refreshActive(); });
    }
    // custom interval creation (+)
    const plus = U.el('button', 'tb-btn tf-plus', bar);
    plus.innerHTML = icon('plus');
    plus.title = 'Create custom timeframe';
    plus.addEventListener('click', () => Toolbar.openCustomTfDialog());
    if (Toolbar.layoutTopbar) Toolbar.layoutTopbar();
  };

  /* ---------- top-toolbar overflow (TV, round 22) ----------
   When the window is too narrow, the left cluster SCROLLS horizontally and
   two chevron arrows (like TV) scroll it left/right. The arrows appear only
   while there is something hidden in that direction — no more hiding items
   into a MORE dropdown. */
  Toolbar.layoutTopbar = function () {
    const left = document.getElementById('tb-left');
    const l = document.getElementById('tb-scroll-l');
    const r = document.getElementById('tb-scroll-r');
    if (!left || !l || !r) return;
    const over = left.scrollWidth > left.clientWidth + 1;
    const max = left.scrollWidth - left.clientWidth;
    l.classList.toggle('hidden', !over || left.scrollLeft <= 2);
    r.classList.toggle('hidden', !over || left.scrollLeft >= max - 2);
  };
  Toolbar._tbScroll = function (dir) {
    const left = document.getElementById('tb-left');
    if (!left) return;
    left.scrollBy({ left: dir * 260, behavior: 'smooth' });
    setTimeout(() => { try { Toolbar.layoutTopbar(); } catch (e) {} }, 320);
  };

  Toolbar.refreshActive = function () {
    Toolbar.renderTfFavs();
    const label = document.getElementById('symbol-btn-label');
    if (label && App.activePane) label.textContent = App.activePane.symbol;
    if (App.activePane) {
      // top toolbar reflects the active chart's style
      App.style = App.activePane.style || App.style;
      const cur = App.STYLES.find((s) => s.id === App.style);
      const styleBtn = document.getElementById('style-btn');
      if (styleBtn && cur) styleBtn.innerHTML = icon(cur.icon);
    }
    Toolbar.renderStyleQuick();
  };

  /* ---------- interval mega menu ----------
     ROUND 34 (user request): TradingView-style VERTICAL list instead of the
     old multi-column grid —
       • "Add custom interval" pinned ABOVE the list (opens the dialog)
       • one row per interval, grouped into SECONDS / MINUTES / HOURS / DAYS
         / WEEKS / MONTHS sections, each section separated and COLLAPSIBLE
         (chevron, state persisted per user)
       • every interval stays sorted ascending inside its own section, so
         user-created custom intervals always land IN ORDER in their group
       • the list itself SCROLLS when the user accumulates many intervals */
  Toolbar.openTfMenu = function (x, y) {
    popupAt(x, y, (p) => {
      p.id = 'tf-menu';
      const add = U.el('button', 'tf-menu-add', p);
      add.innerHTML = `${icon('plus')}<span>Add custom interval</span>`;
      add.addEventListener('click', () => { closePopup(); Toolbar.openCustomTfDialog(); });
      let collapsed = U.lsGet('mt5_tf_menu_collapsed', {});
      if (typeof collapsed !== 'object' || !collapsed) collapsed = {};
      const G = ['Seconds', 'Minutes', 'Hours', 'Days', 'Weeks', 'Months'];
      const groups = {};
      for (const tf of App.tf) (groups[tf.group] = groups[tf.group] || []).push(tf);
      const list = U.el('div', 'tf-menu-list', p);
      for (const g of G) {
        const items = (groups[g] || []).slice().sort((a, b) => a.sec - b.sec);
        if (!items.length) continue;
        const gd = U.el('div', 'tf-group' + (collapsed[g] ? ' collapsed' : ''), list);
        const head = U.el('button', 'tf-group-head', gd);
        head.innerHTML = `<span>${g}</span><span class="tf-chev">${icon('chevD')}</span>`;
        head.addEventListener('click', () => {
          gd.classList.toggle('collapsed');
          collapsed[g] = gd.classList.contains('collapsed');
          U.lsSet('mt5_tf_menu_collapsed', collapsed);
        });
        const gi = U.el('div', 'tf-group-items', gd);
        for (const tf of items) {
          const it = U.el('button', 'pu-item', gi);
          it.innerHTML = `<span>${tf.label}</span>`;
          if (App.activePane && App.activePane.tf === tf.id) it.classList.add('hl');
          /* ROUND 35 (user report): the trash used to be appended AFTER the
             star and both buttons carry .pu-star (margin-left:auto) — the free
             space split between them, so on custom intervals the star floated
             mid-row while default rows had it on the far right. The trash is
             now created FIRST and the star LAST (rightmost column), with a
             CSS rule pinning the star 4px after the trash: the star sits at
             the SAME x on every row, custom or not. */
          let tr = null;
          if (tf.custom) {
            tr = U.el('button', 'pu-star pu-trash', it);
            tr.innerHTML = icon('trash');
            tr.title = 'Delete custom interval';
            tr.addEventListener('mousedown', (e) => e.stopPropagation());
            tr.addEventListener('click', (e) => {
              e.stopPropagation();
              App.removeCustomTf(tf.id);
              for (const pane of App.panes) if (pane.tf === tf.id) Manager.setTf(pane, 'M1');
              Toolbar.renderTfFavs();
              /* ROUND 35 (user report): the menu used to CLOSE on delete —
                 it must stay open until the user clicks outside. Remove the
                 row in place instead (drop the whole group when it empties). */
              const giEl = it.parentElement, gdEl = giEl && giEl.closest('.tf-group');
              it.remove();
              if (gdEl && !gdEl.querySelector('.pu-item')) gdEl.remove();
              UI.toast(`Custom interval ${tf.label} deleted`, 'ok');
            });
          }
          it.appendChild(starBtn(App.tfFavorites.includes(tf.id), (btn) => {
            toggleFav(App.tfFavorites, tf.id);
            btn.classList.toggle('faved', App.tfFavorites.includes(tf.id));
            btn.innerHTML = icon(App.tfFavorites.includes(tf.id) ? 'star' : 'starOutline');
            Toolbar.renderTfFavs();
          }));
          it.addEventListener('click', (e) => {
            if (e.target.closest('.pu-star') || e.target.closest('.pu-trash')) return;
            if (App.activePane) Manager.setTf(App.activePane, tf.id);
            closePopup();
          });
        }
      }
      U.el('div', 'pu-hint tf-menu-hint', p).textContent = 'Tip: type a number on the chart (e.g. 45m, 2H, 3D) and press Enter';
    });
  };

  function toggleFav(arr, id) {
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1); else arr.push(id);
    U.lsSet('mt5_tf_favs', App.tfFavorites);
    U.lsSet('mt5_tool_favs', App.toolFavorites);
    U.lsSet('mt5_style_favs', App.styleFavorites);
  }
  Toolbar.toggleFav = toggleFav;

  /* ---------- TV-style typed intervals (type a number on the chart + Enter) ---------- */
  let tvBuf = '';
  let tvBadge = null;
  let tvErrTimer = null;
  const TV_LBL = { s: 's', S: 's', m: 'm', M: 'M', h: 'H', H: 'H', d: 'D', D: 'D', w: 'W', W: 'W' };

  function tvParse(buf) {
    const m = buf.match(/^(\d+)([smhdwSMHDW])?$/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    if (!(n > 0)) return null;
    if (!m[2]) {
      // plain numbers are minutes, rolling up like TV: 1440 -> 1D, 10080 -> 1W
      if (n >= 10080 && n % 10080 === 0) return { n: n / 10080, unit: 'w' };
      if (n >= 1440 && n % 1440 === 0) return { n: n / 1440, unit: 'd' };
      return { n, unit: 'm' };
    }
    const unit = m[2] === 'M' ? 'mo' : m[2].toLowerCase();
    return { n, unit };
  }

  function showTvBadge() {
    if (!tvBuf) { hideTvBadge(); return; }
    if (!tvBadge) tvBadge = U.el('div', 'tv-typing', document.body);
    const m = tvBuf.match(/^(\d+)([smhdwSMHDW])?$/);
    const lbl = m ? m[1] + (m[2] ? TV_LBL[m[2]] : 'm') : tvBuf;
    tvBadge.innerHTML = `<span class="tt-val">${lbl}</span><span class="tt-hint">Press Enter to apply · Esc to cancel</span>`;
    tvBadge.classList.add('show');
    tvBadge.classList.remove('err');
  }
  function hideTvBadge() { if (tvBadge) tvBadge.classList.remove('show'); }
  function tvFlashErr() {
    if (!tvBadge) return;
    tvBadge.classList.add('err');
    clearTimeout(tvErrTimer);
    tvErrTimer = setTimeout(() => { tvBuf = ''; hideTvBadge(); }, 900);
  }

  function tvApply() {
    const p = tvParse(tvBuf);
    if (!p) { tvFlashErr(); return; }
    const r = App.addCustomTf(p.n, p.unit);
    if (!r) { tvFlashErr(); return; }
    if (App.activePane) Manager.setTf(App.activePane, r.id);
    tvBuf = '';
    hideTvBadge();
    Toolbar.renderTfFavs();
  }

  Toolbar.onKey = function (e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    if (e.key === 'Escape') {
      // leave the maximized chart first (TV: Esc returns to the grid)
      if (Manager.exitMaximized && Manager.exitMaximized()) return true;
      /* ROUND132: an armed Bar Replay pick dies on Escape (TV behaviour) */
      if (Replay.cancelPick && Replay.cancelPick()) return true;
      if (tvBuf) { tvBuf = ''; hideTvBadge(); return true; }
      closePopup();
      /* ROUND246 (TV parity): staged Escape — a mid-creation drawing dies but
         the tool stays armed (escStep); only an idle Esc disarms + clears
         the selection, like before. */
      let stepped = false;
      for (const p of App.panes) {
        try { if (p.engine && p.engine.escStep && p.engine.escStep()) stepped = true; } catch (e) {}
      }
      if (stepped) {
        if (UI.onToolDone) UI.onToolDone();
        if (UI.onSelectionChanged) UI.onSelectionChanged();
        return true;
      }
      // cancel drawing creation / selection
      App.tool = null;
      for (const p of App.panes) p.engine.cancelCreate();
      if (App.selection) {
        const sd = App.selection.d;
        if (sd.opts && sd.opts.temp) App.drawings.remove(sd.symbol, sd.id);
        App.selection = null;
      }
      if (UI.onToolDone) UI.onToolDone();
      if (UI.onSelectionChanged) UI.onSelectionChanged();
      return true;
    }
    if (e.key === 'Enter') {
      if (tvBuf) { tvApply(); return true; }
      /* ROUND69 (TV): Enter finishes the multi-point tools (Path/Polyline) */
      for (const p of App.panes) {
        if (p.engine && p.engine.finishPoly && p.engine.finishPoly()) return true;
      }
      return false;
    }
    if (e.key === 'Backspace' && tvBuf) {
      tvBuf = tvBuf.slice(0, -1);
      showTvBadge();
      return true;
    }
    if (/^[0-9]$/.test(e.key)) {
      if (tvBuf.length < 7) tvBuf += e.key;
      showTvBadge();
      return true;
    }
    if (tvBuf && /^\d+$/.test(tvBuf) && /^[smhdwSMHDW]$/.test(e.key)) {
      tvBuf += e.key;
      showTvBadge();
      return true;
    }
    return false;
  };

  /* ---------- custom interval dialog ---------- */
  Toolbar.openCustomTfDialog = function () {
    const layer = document.getElementById('popup-layer');
    layer.classList.remove('hidden');
    U.clear(layer);
    const back = U.el('div', 'dialog-backdrop', layer);
    const dlg = U.el('div', 'dialog', back);
    dlg.id = 'custom-tf-dialog';
    dlg.innerHTML = `<h3>Custom Interval<button class="mini-btn dlg-x">${icon('x')}</button></h3>
      <div class="dlg-row">
        <label>Value<input type="number" id="ctf-val" min="1" step="1" value="45" spellcheck="false"></label>
        <label>Unit<select id="ctf-unit">
          <option value="s">Seconds</option>
          <option value="m" selected>Minutes</option>
          <option value="h">Hours</option>
          <option value="d">Days</option>
          <option value="w">Weeks</option>
          <option value="mo">Months</option>
        </select></label>
      </div>
      <div class="ctf-preview">Interval: <b id="ctf-preview">45m</b></div>
      <div class="dlg-actions">
        <button class="dlg-btn dlg-ghost" id="ctf-cancel">Cancel</button>
        <button class="dlg-btn dlg-primary" id="ctf-add">Add</button>
      </div>`;
    const val = dlg.querySelector('#ctf-val');
    const unit = dlg.querySelector('#ctf-unit');
    const pv = dlg.querySelector('#ctf-preview');
    const LBL = { s: 's', m: 'm', h: 'H', d: 'D', w: 'W', mo: 'M' };
    const preview = () => {
      const n = parseInt(val.value, 10);
      pv.textContent = isFinite(n) && n > 0 ? n + LBL[unit.value] : '—';
    };
    val.addEventListener('input', preview);
    unit.addEventListener('change', preview);
    const close = () => { layer.classList.add('hidden'); U.clear(layer); };
    dlg.querySelector('.dlg-x').addEventListener('click', close);
    dlg.querySelector('#ctf-cancel').addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    const add = () => {
      const n = parseInt(val.value, 10);
      const r = App.addCustomTf(n, unit.value);
      if (!r) { val.style.borderColor = '#f23645'; return; }
      if (!r.existed) { App.tfFavorites.push(r.id); U.lsSet('mt5_tf_favs', App.tfFavorites); }
      if (App.activePane) Manager.setTf(App.activePane, r.id);
      Toolbar.renderTfFavs();
      UI.toast(`Interval ${App.tfById[r.id].label} ${r.existed ? 'applied' : 'created'}`, 'ok');
      close();
    };
    dlg.querySelector('#ctf-add').addEventListener('click', add);
    [val, unit].forEach((el) => el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') add();
      if (e.key === 'Escape') close();
    }));
    setTimeout(() => val.focus(), 40);
  };

  /* ---------- style menu + quick favorites (per chart) ---------- */
  Toolbar.renderStyleQuick = function () {
    const box = document.getElementById('style-quick');
    U.clear(box);
    const cur = App.activePane ? App.activePane.style : App.style;
    for (const s of App.STYLES) {
      if (!App.styleFavorites.includes(s.id)) continue;
      const b = U.el('button', 'tb-btn', box);
      b.innerHTML = icon(s.icon);
      b.title = s.name;
      if (cur === s.id) b.classList.add('active');
      b.addEventListener('click', () => Manager.setStyle(App.activePane, s.id));
    }
    const styleBtn = document.getElementById('style-btn');
    if (styleBtn) {
      const s = App.STYLES.find((x) => x.id === cur);
      if (s) styleBtn.innerHTML = icon(s.icon);
    }
    if (Toolbar.layoutTopbar) Toolbar.layoutTopbar();
  };

  /* pane = the chart the style applies to (TV: each chart has its own type) */
  Toolbar.openStyleMenu = function (x, y, pane) {
    if (!pane) pane = App.activePane;
    popupAt(x, y, (p) => {
      U.el('div', 'pu-title', p).textContent = 'Chart Style';
      const cur = pane ? pane.style : App.style;
      for (const s of App.STYLES) {
        const it = U.el('button', 'pu-item', p);
        it.innerHTML = `<span class="ic">${icon(s.icon)}</span><span>${s.name}</span>`;
        if (cur === s.id) it.classList.add('hl');
        it.appendChild(starBtn(App.styleFavorites.includes(s.id), (btn) => {
          toggleFav(App.styleFavorites, s.id);
          btn.classList.toggle('faved', App.styleFavorites.includes(s.id));
          btn.innerHTML = icon(App.styleFavorites.includes(s.id) ? 'star' : 'starOutline');
          Toolbar.renderStyleQuick();
        }));
        it.addEventListener('click', (e) => {
          if (e.target.closest('.pu-star')) return;
          Manager.setStyle(pane, s.id);
          closePopup();
        });
      }
    });
  };

  /* ---------- layout picker (TV) + Sync in Layout ---------- */
  const SYNC_DEFS = [
    ['symbol', 'Symbol', 'Apply symbol changes to all charts in the layout'],
    ['interval', 'Interval', 'Apply interval changes to all charts in the layout'],
    ['crosshair', 'Crosshair', 'Show the crosshair on same-symbol charts at the same time'],
    /* ROUND120 (user request): when the layout mixes DIFFERENT symbols, the
       mouse crosshair follows between different-symbol charts only while
       this toggle is on — the plain Crosshair toggle above keeps governing
       same-symbol charts exactly as before. */
    ['crossX', 'Crosshair on different symbols', 'Follow the mouse crosshair across charts with DIFFERENT symbols (multi-chart)'],
    ['time', 'Time', 'Scrolling one chart scrolls the others to the same time'],
    ['daterange', 'Date range', 'Zooming one chart zooms the others to the same date range'],
  ];

  Toolbar.openLayoutMenu = function (x, y) {
    popupAt(x, y, (p) => {
      p.classList.add('lay-picker');
      const scroll = U.el('div', 'lay-scroll', p);
      const byN = {};
      for (const l of App.LAYOUTS) (byN[l.n === undefined ? l.tiles.length : l.n] = byN[l.n === undefined ? l.tiles.length : l.n] || []).push(l);
      for (const n of Object.keys(byN).map(Number).sort((a, b) => a - b)) {
        const rowEl = U.el('div', 'lay-row', scroll);
        U.el('span', 'lay-n', rowEl).textContent = n;
        const vars = U.el('div', 'lay-vars', rowEl);
        for (const l of byN[n]) {
          const b = U.el('button', 'lay-ic' + (App.layout === l.id ? ' on' : ''), vars);
          b.innerHTML = layoutIconSvg(l);
          b.title = l.name;
          b.addEventListener('click', () => {
            Manager.setLayout(l.id, true);
            p.querySelectorAll('.lay-ic.on').forEach((el) => el.classList.remove('on'));
            b.classList.add('on');
            const lb = Toolbar._layoutBtn;
            if (lb) { lb.innerHTML = layoutIconSvg(l, 24, 24); lb.title = 'Layout: ' + l.name; }
          });
        }
      }
      U.el('div', 'pu-title lay-sep', p).textContent = 'SYNC IN LAYOUT';
      const box = U.el('div', 'lay-sync', p);
      for (const [key, label, desc] of SYNC_DEFS) {
        const r = U.el('div', 'sync-t-row', box);
        r.innerHTML = `<span class="st-lab">${label}<i class="info-ic" title="${desc}">${icon('info')}</i></span>` +
          `<span class="st-switch ${App.sync[key] ? 'on' : ''}"></span>`;
        r.title = desc;
        r.addEventListener('click', () => {
          App.sync[key] = !App.sync[key];
          U.lsSet('mt5_sync', App.sync);
          r.querySelector('.st-switch').classList.toggle('on', App.sync[key]);
          if ((key === 'time' || key === 'daterange') && App.sync[key] && Manager.syncTimeKick) Manager.syncTimeKick();
        });
      }
      /* ---- Save / Load layout (TV) ---- */
      /* BUG-010: the LAYOUTS section is its own flexible region — the whole
         menu is ONE viewport-clamped column (U.fitPopup above): the grid
         area scrolls inside, SYNC stays fully visible, and the LAYOUTS
         section shrinks + scrolls internally (min-height keeps the Save
         action visible) instead of clipping at the window bottom */
      const layBox = U.el('div', 'lay-layouts', p);
      U.el('div', 'pu-title lay-sep', layBox).textContent = 'LAYOUTS';
      const saveBtn = U.el('button', 'pu-item lay-save', layBox);
      saveBtn.innerHTML = `<span class="ic">${icon('save')}</span><span>Save layout\u2026</span>`;
      saveBtn.addEventListener('click', () => { closePopup(); Toolbar.openSaveLayoutDialog(); });
      const list = U.lsGet('mt5_saved_layouts', []) || [];
      for (const s of list.slice().reverse()) {
        const it = U.el('button', 'pu-item ds-tpl-item lay-saved', layBox);
        const d = new Date(s.at || Date.now());
        const when = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        it.innerHTML = `<span>${s.name}</span><span class="lay-saved-at">${when}</span>`;
        it.title = 'Load this layout';
        const tr = U.el('button', 'pu-star ds-tpl-trash', it);
        tr.innerHTML = icon('trash');
        tr.title = 'Delete saved layout';
        tr.addEventListener('mousedown', (e) => e.stopPropagation());
        tr.addEventListener('click', (e) => {
          e.stopPropagation();
          const cur = U.lsGet('mt5_saved_layouts', []) || [];
          U.lsSet('mt5_saved_layouts', cur.filter((x) => x.name !== s.name));
          closePopup();
          Toolbar.openLayoutMenu(x, y);
        });
        it.addEventListener('click', (e) => {
          if (e.target.closest('.ds-tpl-trash')) return;
          Toolbar.applySavedLayout(s);
        });
      }
    });
  };

  /* ---------- Save / Load layout (TV) ---------- */
  /* A saved layout = complete personal setup: layout + splitter ratios, every
     chart's symbol/interval/style, chart settings, sync toggles, timezone,
     favorites, watchlist and all drawings. Loading writes the storage keys
     and reloads — the same keys the app boots from. */
  Toolbar.layoutSnapshot = function (name) {
    try { App.drawings.saveNow(); } catch (e) {}
    return {
      name,
      at: Date.now(),
      data: {
        layout: App.layout,
        ratios: App._ratios ? JSON.parse(JSON.stringify(App._ratios)) : null,
        /* round 27: indicator instances travel with saved layouts */
        panes: App.panes.map((p) => ({ symbol: p.symbol, tf: p.tf, style: p.style,
          indicators: (p.indicators || []).map((i) => ({ type: i.type, params: i.params, colors: i.colors, visible: i.visible !== false })) })),
        settings: U.lsGet('mt5_settings', {}),
        sync: App.sync,
        tz: App.tz,
        tfFavs: App.tfFavorites, toolFavs: App.toolFavorites, styleFavs: App.styleFavorites,
        watchlist: U.lsGet('mt5_watchlist', []),
        drawings: JSON.parse(JSON.stringify(App.drawings.data || {})),
      },
    };
  };

  Toolbar.applySavedLayout = function (s) {
    try {
      if (s && s.name) U.lsSet('mt5_cur_layout_name', s.name);
      const d = s.data || {};
      if (d.layout) {
        U.lsSet('mt5_layout', d.layout);
        if (d.ratios) U.lsSet('mt5_split_' + d.layout, d.ratios);
        U.lsSet('mt5_styles_' + d.layout, (d.panes || []).map((p) => p.style));
      }
      if (d.panes) U.lsSet('mt5_boot_panes', { layout: d.layout || App.layout, panes: d.panes });
      if (d.settings) U.lsSet('mt5_settings', d.settings);
      if (d.sync) U.lsSet('mt5_sync', d.sync);
      if (d.tz) U.lsSet('mt5_tz', d.tz);
      if (d.drawings) U.lsSet('mt5_drawings', d.drawings);
      if (d.tfFavs) U.lsSet('mt5_tf_favs', d.tfFavs);
      if (d.toolFavs) U.lsSet('mt5_tool_favs', d.toolFavs);
      if (d.styleFavs) U.lsSet('mt5_style_favs', d.styleFavs);
      if (d.watchlist) U.lsSet('mt5_watchlist', d.watchlist);
      location.reload();
    } catch (e) {
      UI.toast('Could not load this layout', 'err');
    }
  };

  Toolbar.openSaveLayoutDialog = function () {
    const layer = document.getElementById('popup-layer');
    layer.classList.remove('hidden');
    U.clear(layer);
    const back = U.el('div', 'dialog-backdrop', layer);
    const dlg = U.el('div', 'dialog', back);
    dlg.id = 'save-layout-dialog';
    const d = new Date();
    const defName = `Layout ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    dlg.innerHTML = `<h3>Save Layout<button class="mini-btn dlg-x">${icon('x')}</button></h3>
      <p class="dlg-note">Saves the full personal setup: layout, chart symbols &amp; intervals &amp; styles, chart settings, favorites, watchlist and all drawings.</p>
      <div class="dlg-row"><label>Name<input type="text" id="sl-name" maxlength="60" value="${defName}" spellcheck="false"></label></div>
      <div class="dlg-actions">
        <button class="dlg-btn dlg-ghost" id="sl-cancel">Cancel</button>
        <button class="dlg-btn dlg-primary" id="sl-save">Save</button>
      </div>`;
    const inp = dlg.querySelector('#sl-name');
    const close = () => { layer.classList.add('hidden'); U.clear(layer); };
    dlg.querySelector('.dlg-x').addEventListener('click', close);
    dlg.querySelector('#sl-cancel').addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    const save = () => {
      const name = inp.value.trim();
      if (!name) { inp.style.borderColor = '#f23645'; return; }
      const list = (U.lsGet('mt5_saved_layouts', []) || []).filter((x) => x.name !== name);
      list.push(Toolbar.layoutSnapshot(name));
      U.lsSet('mt5_saved_layouts', list.slice(-20));
      U.lsSet('mt5_cur_layout_name', name); // this is now the current layout (Rename / Make a copy)
      close();
      UI.toast(`Layout “${name}” saved`, 'ok');
    };
    dlg.querySelector('#sl-save').addEventListener('click', save);
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') close();
    });
    setTimeout(() => { inp.focus(); inp.select(); }, 40);
  };

  /* ---------- Save Layout menu (top-toolbar icon, TV) ----------
     Mirrors the TV layout menu: Save layout / Autosave / Make a copy /
     Rename / Download chart data / Create new layout / Recently used /
     Open layout. ("Share layout" is cloud-only in TV and has no local
     counterpart — layouts live in this app's storage.) */
  Toolbar.autosaveOn = function () { return U.lsGet('mt5_autosave', true) !== false; };

  function layoutSum(s) {
    try {
      const p0 = (s.data && s.data.panes && s.data.panes[0]) || null;
      if (!p0) return '';
      const tf = App.tfById[p0.tf];
      return `${p0.symbol}, ${tf ? tf.label : p0.tf}`;
    } catch (e) { return ''; }
  }

  /* name-input dialog shared by Save / Make a copy / Rename */
  function layoutNameDialog(title, note, defName, onOk) {
    const layer = document.getElementById('popup-layer');
    layer.classList.remove('hidden');
    U.clear(layer);
    const back = U.el('div', 'dialog-backdrop', layer);
    const dlg = U.el('div', 'dialog', back);
    dlg.innerHTML = `<h3>${title}<button class="mini-btn dlg-x">${icon('x')}</button></h3>
      ${note ? `<p class="dlg-note">${note}</p>` : ''}
      <div class="dlg-row"><label>Name<input type="text" id="ln-name" maxlength="60" value="${defName}" spellcheck="false"></label></div>
      <div class="dlg-actions">
        <button class="dlg-btn dlg-ghost" id="ln-cancel">Cancel</button>
        <button class="dlg-btn dlg-primary" id="ln-ok">Save</button>
      </div>`;
    const inp = dlg.querySelector('#ln-name');
    const close = () => { layer.classList.add('hidden'); U.clear(layer); };
    dlg.querySelector('.dlg-x').addEventListener('click', close);
    dlg.querySelector('#ln-cancel').addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    const ok = () => {
      const name = inp.value.trim();
      if (!name) { inp.style.borderColor = '#f23645'; return; }
      close();
      onOk(name);
    };
    dlg.querySelector('#ln-ok').addEventListener('click', ok);
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') ok();
      if (e.key === 'Escape') close();
    });
    setTimeout(() => { inp.focus(); inp.select(); }, 40);
  }

  Toolbar.openSaveLayoutMenu = function (x, y) {
    popupAt(x, y, (p) => {
      p.classList.add('sl-menu');
      const mk = (label, ic, kbd, fn) => {
        const it = U.el('button', 'pu-item', p);
        it.innerHTML = `<span class="ic">${ic ? icon(ic) : ''}</span><span>${label}</span>` +
          (kbd ? `<span class="pu-kbd">${kbd}</span>` : '');
        it.addEventListener('click', () => { closePopup(); fn(); });
        return it;
      };
      mk('Save layout', 'save', 'Ctrl + S', () => Toolbar.openSaveLayoutDialog());
      /* Autosave toggle (TV): keeps the last session state on disk automatically */
      const auto = U.el('button', 'pu-item sync-t-row sl-auto', p);
      auto.innerHTML = `<span class="ic">${icon('sync')}</span><span>Autosave</span>` +
        `<span class="st-switch ${Toolbar.autosaveOn() ? 'on' : ''}"></span>`;
      auto.title = 'Automatically keep the latest charts so reopening the app restores them';
      auto.addEventListener('click', () => {
        const nv = !Toolbar.autosaveOn();
        U.lsSet('mt5_autosave', nv);
        auto.querySelector('.st-switch').classList.toggle('on', nv);
        UI.toast(nv ? 'Autosave ON — chart session is kept automatically' : 'Autosave OFF — only saved layouts are kept', 'ok');
      });
      U.el('div', 'pu-sep', p);
      mk('Make a copy\u2026', 'copy', '', () => {
        const cur = U.lsGet('mt5_cur_layout_name', null);
        layoutNameDialog('Make a copy of the layout', null, `Copy of ${cur || Toolbar._defaultLayoutName()}`, (name) => {
          const list = (U.lsGet('mt5_saved_layouts', []) || []).filter((x) => x.name !== name);
          list.push(Toolbar.layoutSnapshot(name));
          U.lsSet('mt5_saved_layouts', list.slice(-20));
          U.lsSet('mt5_cur_layout_name', name);
          UI.toast(`Layout copied as “${name}”`, 'ok');
        });
      });
      mk('Rename\u2026', 'pencil', '', () => {
        const cur = U.lsGet('mt5_cur_layout_name', null);
        const list = U.lsGet('mt5_saved_layouts', []) || [];
        if (!cur || !list.some((s) => s.name === cur)) {
          UI.toast('The current layout is not saved yet — use Save layout first', 'err');
          Toolbar.openSaveLayoutDialog();
          return;
        }
        layoutNameDialog('Rename layout', null, cur, (name) => {
          const arr = (U.lsGet('mt5_saved_layouts', []) || []);
          const ent = arr.find((s) => s.name === cur);
          if (!ent) return;
          ent.name = name;
          const out = arr.filter((s) => s !== ent && s.name !== name); // overwrite a name collision
          out.push(ent);
          U.lsSet('mt5_saved_layouts', out.slice(-20));
          U.lsSet('mt5_cur_layout_name', name);
          UI.toast(`Layout renamed to “${name}”`, 'ok');
        });
      });
      mk('Download chart data\u2026', 'doc', '', () => Toolbar.downloadChartData());
      U.el('div', 'pu-sep', p);
      mk('Create new layout\u2026', 'plus', '', () => Toolbar.newLayoutConfirm());
      /* RECENTLY USED (TV): latest saved layouts first */
      const list = (U.lsGet('mt5_saved_layouts', []) || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
      if (list.length) {
        U.el('div', 'pu-title', p).textContent = 'RECENTLY USED';
        for (const s of list.slice(0, 4)) {
          const it = U.el('button', 'pu-item sl-recent', p);
          it.innerHTML = `<span class="ic">${icon('layout1')}</span><span class="sl-rname">${s.name}</span><span class="sl-rsum">${layoutSum(s)}</span>`;
          it.title = 'Load this layout';
          it.addEventListener('click', () => { closePopup(); Toolbar.applySavedLayout(s); });
        }
      }
      U.el('div', 'pu-sep', p);
      mk('Open layout\u2026', 'open', '', () => {
        const r2 = document.getElementById('layout-btn').getBoundingClientRect();
        Toolbar.openLayoutMenu(r2.left, r2.bottom + 4);
      });
    });
  };

  Toolbar._defaultLayoutName = function () {
    const d = new Date();
    return `Layout ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  /* Create new layout (TV): closes the current session and starts fresh */
  Toolbar.newLayoutConfirm = function () {
    const layer = document.getElementById('popup-layer');
    layer.classList.remove('hidden');
    U.clear(layer);
    const back = U.el('div', 'dialog-backdrop', layer);
    const dlg = U.el('div', 'dialog', back);
    dlg.innerHTML = `<h3>Create new layout<button class="mini-btn dlg-x">${icon('x')}</button></h3>
      <p class="dlg-note">Closes the current charts and opens a fresh single chart. Saved layouts are kept and can be reopened from Open layout.</p>
      <div class="dlg-actions">
        <button class="dlg-btn dlg-ghost" id="nl-cancel">Cancel</button>
        <button class="dlg-btn dlg-primary" id="nl-ok">Create</button>
      </div>`;
    const close = () => { layer.classList.add('hidden'); U.clear(layer); };
    dlg.querySelector('.dlg-x').addEventListener('click', close);
    dlg.querySelector('#nl-cancel').addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    dlg.querySelector('#nl-ok').addEventListener('click', () => {
      U.lsSet('mt5_boot_panes', null); // no session to restore
      U.lsSet('mt5_layout', '1');
      U.lsSet('mt5_cur_layout_name', null);
      location.reload();
    });
  };

  /* Download chart data (TV Save Layout menu): active chart -> CSV */
  Toolbar.downloadChartData = function () {
    const pane = App.activePane || App.panes[0];
    if (!pane || !pane.bars.length) { UI.toast('No chart data to export', 'err'); return; }
    const tf = App.tfById[pane.tf];
    const rows = ['Time (UTC),Open,High,Low,Close,Volume'];
    for (const b of pane.bars) {
      const ts = new Date(b.time * 1000).toISOString().replace('T', ' ').slice(0, 19);
      rows.push([ts, b.open, b.high, b.low, b.close, b.volume != null ? b.volume : ''].join(','));
    }
    const csv = rows.join('\n');
    const name = `${pane.symbol} ${tf ? tf.label : pane.tf}.csv`;
    const done = (r) => {
      if (r && r.ok) UI.toast(`Chart data saved (${pane.bars.length} bars)`, 'ok');
      else if (r && !r.canceled) UI.toast('Save failed: ' + (r.error || 'unknown error'), 'err');
    };
    if (window.electronAPI && window.electronAPI.saveTextFile) {
      window.electronAPI.saveTextFile(csv, name).then(done).catch(() => UI.toast('Save failed', 'err'));
    } else {
      const a = document.createElement('a');
      a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
      a.download = name;
      a.click();
      UI.toast(`Chart data downloaded (${pane.bars.length} bars)`, 'ok');
    }
  };

  /* ---------- timezone menu ---------- */
  Toolbar.openTzMenu = function (x, y) {
    popupAt(x, y, (p) => {
      /* ROUND42: 250px (was 330px) — user report: the window was wider than
         its content and carried dead space. 250px still fits the longest
         label ("America/Buenos Aires") plus the new right-aligned UTC
         offset column on one line. */
      p.style.width = '250px';
      U.el('div', 'pu-title', p).textContent = 'Timezone';
      const search = U.el('input');
      search.type = 'text';
      search.placeholder = 'Search timezone...';
      search.className = 'al-search'; // BUG-009/AUD-001: token-styled (was inline dark cssText)
      p.appendChild(search);
      const list = U.el('div', '', p);
      list.style.maxHeight = '330px'; list.style.overflowY = 'auto';
      const zones = TZ.sortedZones();
      const render = (q) => {
        U.clear(list);
        const ql = (q || '').toLowerCase();
        for (const z of zones) {
          if (ql && !z.toLowerCase().includes(ql) && !TZ.zoneLabel(z).toLowerCase().includes(ql)) continue;
          const it = U.el('button', 'pu-item', list);
          /* ROUND42: each row now shows the zone's UTC offset right-aligned
             (user request). Broker re-uses the live server offset (same
             source as TZ.shortLabel); every other zone goes through
             TZ.zoneOffsetMinutes which is DST-aware and cached. */
          const offMin = (z === 'broker')
            ? Math.round(((App.feed && App.feed.serverOff) || 0) / 60)
            : TZ.zoneOffsetMinutes(z, new Date());
          const oa = Math.abs(offMin);
          const offStr = 'UTC' + (offMin < 0 ? '-' : '+') +
            String(Math.floor(oa / 60)).padStart(2, '0') + ':' + String(oa % 60).padStart(2, '0');
          it.innerHTML = `<span class="u-fs12">${TZ.zoneLabel(z)}</span>` +
            `<span class="u-ml-auto-sm">${offStr}</span>`;
          if (App.tz === z) it.classList.add('hl');
          it.addEventListener('click', () => {
            App.tz = z;
            Manager.applyTimezone();
            closePopup();
          });
        }
      };
      render('');
      search.addEventListener('input', () => render(search.value));
      search.addEventListener('keydown', (e) => e.stopPropagation());
      setTimeout(() => search.focus(), 30);
    });
  };

  /* ---------- ROUND56: broker servers (in-app, bottom bar) ---------- */
  /* The same MT5-style scan the login screen shows, reachable after login:
     measured pings per access server, Network Rescan, one-click switch.
     Switching re-connects through the app's real boot path (auto-login) —
     demo re-points its saved data center, MT5 re-points the account's
     server so the bridge REALLY reconnects to the picked server. */
  const SRV_REFRESH = '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M13.6 8a5.6 5.6 0 1 1-1.64-3.96" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M13.9 1.4v3.4h-3.4z" fill="currentColor"/></svg>';
  const SRV_BARS = (n) => '<svg class="srv-bars" viewBox="0 0 16 12" width="15" height="11">' +
    [0, 1, 2, 3].map((i) => '<rect class="sb' + (i < n ? ' on' : '') +
      '" x="' + (i * 4) + '" y="' + (9 - i * 3) + '" width="3" height="' + (3 + i * 3) +
      '" rx="0.8"/>').join('') + '</svg>';
  const SRV_TIER = (ms) => ms == null ? 0 : ms <= 120 ? 4 : ms <= 200 ? 3 : ms <= 350 ? 2 : 1;

  Toolbar.currentServer = function () {
    const acc = App.currentAcc || {};
    if (acc.mode === 'mt5') {
      const s = String(acc.label || '').split(' \u00b7 ')[1];
      return s || 'MT5';
    }
    try { return localStorage.getItem('mt5_dc_demo') || 'Auto'; } catch (e) { return 'Auto'; }
  };

  Toolbar.updateSrvLabel = function () {
    const el = document.getElementById('srv-label');
    if (el) el.textContent = Toolbar.currentServer();
  };

  /* temp-socket scan — identical protocol to the login screen's scan;
     the provider is already running in-app, so no startProvider here */
  Toolbar.scanSrvApp = function () {
    return new Promise((resolve) => {
      let ws;
      const url = (App.feed && App.feed.url) || 'ws://127.0.0.1:8777';
      try { ws = new WebSocket(url); } catch (e) { resolve([]); return; }
      const pings = {};
      let phase = 'list';
      let left = 0;
      let to = null;
      const done = (v) => { if (to) clearTimeout(to); try { ws.close(); } catch (e) {} resolve(v || []); };
      to = setTimeout(() => done([]), 9000);
      ws.onopen = () => { try { ws.send(JSON.stringify({ type: 'servers', req_id: 'sa' })); } catch (e) { done([]); } };
      ws.onmessage = (ev) => {
        let m = null; try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (phase === 'list' && m.type === 'servers') {
          const ent = m.servers || [];
          if (!ent.length) { done([]); return; }
          phase = 'ping';
          ent.forEach((s, i) => {
            const rid = 'ap' + i;
            pings[rid] = { name: s.name, ping: null };
            ws.send(JSON.stringify({ type: 'servers_ping', name: s.name, req_id: rid }));
          });
          left = ent.length;
        } else if (phase === 'ping' && m.type === 'servers_ping' && pings[m.req_id]) {
          pings[m.req_id].ping = m.ping;
          if (--left <= 0) done(Object.values(pings));
        }
      };
      ws.onerror = () => done([]);
    });
  };

  Toolbar.openSrvMenu = function (x, y) {
    popupAt(x, y, (p) => {
      p.style.width = '250px';
      /* the rows render ASYNC (network scan) — popupAt's fit ran on the
         small pre-scan shell, so re-fit after every render keeps the popup
         bottom-anchored above the bar instead of growing off-screen */
      const refit = () => { try { U.fitPopup(p, y, y); } catch (e) {} };
      U.el('div', 'pu-title', p).textContent = 'Broker servers';
      const mode = (App.currentAcc && App.currentAcc.mode) === 'mt5' ? 'mt5' : 'demo';
      const rescan = U.el('button', 'srv-rescan', p);
      rescan.type = 'button';
      rescan.title = 'Re-scan the broker\u2019s servers and refresh pings';
      rescan.innerHTML = '<span>' + SRV_REFRESH + '</span><span>Network Rescan</span>';
      const list = U.el('div', 'srv-poplist', p);
      const cur = Toolbar.currentServer();

      /* refresh rate (tick poll interval) — same localStorage key and
         provider message as the login screen's control, so it's one
         consistent setting no matter where the user opens it from.
         Deliberately NOT part of the server list: it's a local polling
         knob, not network ping. */
      const rrWrap = U.el('div', 'srv-refresh-wrap', p);
      const rrLabel = U.el('label', 'srv-refresh-label', rrWrap);
      rrLabel.textContent = 'Chart refresh rate';
      const rrSel = U.el('select', 'srv-refresh-select', rrWrap);
      [['0.5', 'Slow (500 ms) — lowest CPU use'],
       ['0.2', 'Normal (200 ms) — default'],
       ['0.1', 'Fast (100 ms)'],
       ['0.05', 'Fastest (50 ms) — for scalping, more CPU use']].forEach(([v, label]) => {
        const opt = U.el('option', '', rrSel);
        opt.value = v; opt.textContent = label;
      });
      let savedRR = 0.2;
      try { const v = parseFloat(localStorage.getItem('mt5_refresh_rate')); if (isFinite(v) && v > 0) savedRR = v; } catch (e) {}
      rrSel.value = String(savedRR);
      rrSel.addEventListener('change', () => {
        const v = parseFloat(rrSel.value);
        if (!isFinite(v)) return;
        try { localStorage.setItem('mt5_refresh_rate', String(v)); } catch (e) {}
        if (App && App.feed && App.feed.connected && App.feed.refreshRate) {
          App.feed.refreshRate(v).catch(() => {});
        }
      });
      const rrNote = U.el('div', 'srv-refresh-note', rrWrap);
      rrNote.textContent = 'How often the app checks the terminal for a new price — not the network ping above.';

      const render = (rows) => {
        U.clear(list);
        if (!rows.length) {
          U.el('div', 'srv-empty', list).textContent = 'No servers reported by the provider.';
          return;
        }
        /* selection = current pick; with no manual pick yet (Auto) the
           FASTEST row is selected — same rule as the login screen */
        let selName = cur;
        if (!rows.some((r) => r.name === selName)) selName = rows[0].name;
        for (const r of rows) {
          const row = U.el('button', 'srv-row' + (r.name === selName ? ' selected' : ''), list);
          row.type = 'button';
          const b = U.el('span', 'srv-ic tier' + SRV_TIER(r.ping), row);
          b.innerHTML = SRV_BARS(SRV_TIER(r.ping));
          const nm = U.el('span', 'srv-name', row);
          nm.textContent = r.name;
          const pg = U.el('span', 'srv-ping', row);
          pg.textContent = r.ping == null ? '\u2014' : r.ping.toFixed(2) + ' ms';
          row.addEventListener('click', () => {
            if (r.name === cur) { closePopup(); return; }
            Toolbar.switchSrv(r.name, mode);
          });
        }
      };
      const run = async () => {
        list.innerHTML = '<div class="srv-scanline">Scanning network\u2026</div>';
        const rows = await Toolbar.scanSrvApp();
        rows.sort((a, b) => (a.ping == null ? 9e9 : a.ping) - (b.ping == null ? 9e9 : b.ping));
        render(rows);
        refit();
      };
      rescan.addEventListener('click', run);
      run();
    });
  };

  Toolbar.switchSrv = function (name, mode) {
    if (mode === 'mt5') {
      /* login.js owns the saved accounts — it re-points the current MT5
         account to this server and reloads (auto-login REALLY reconnects
         the bridge to the new server; main.js restarts the provider) */
      window.dispatchEvent(new CustomEvent('mt5-switch-server', { detail: name }));
      return;
    }
    try { localStorage.setItem('mt5_dc_demo', name); } catch (e) {}
    UI.toast('Switching to ' + name + ' \u2014 reconnecting\u2026', 'ok');
    setTimeout(() => location.reload(), 450);
  };

  /* ---------- symbol search dialog ---------- */
  /* ROUND36: results are grouped into TV-style asset categories (Forex /
     Metals / Energies / Indices / Crypto / Stocks & Others) with a footer
     that counts every match ("N symbols") — the layout the user expects.
     Matching itself stays CASE-INSENSITIVE (round 35). MT5 exposes no asset
     class, so the category comes from a deterministic name classifier. */
  const SYM_FIAT = new Set(('USD EUR GBP JPY CHF CAD AUD NZD CNY CNH SEK NOK DKK MXN ZAR TRY HUF PLN CZK ' +
    'SGD HKD THB ILS RUB INR KRW BRL CLP COP PHP IDR MYR RON BGN ISK UAH AED SAR QAR KWD BHD OMR JOD EGP NGN').split(' '));
  function symCategory(s) {
    const n = String(s).toUpperCase();
    if (/^X(AU|AG|PT|PD|AL|CU|NI|ZN)/.test(n) || /GOLD|SILVER|PLATIN|PALLAD|COPPER/.test(n)) return 'Metals';
    if (/OIL|BRENT|WTI|NATGAS|NGAS|GASOIL|HEATOIL|COAL|CARBON/.test(n)) return 'Energies';
    /* strict 6-letter fiat pair FIRST — a loose crypto scan would steal
       USDCAD ("USDC"), CADAUD ("ADA"), … (caught by the round36 e2e) */
    const p = /^([A-Z]{3})([A-Z]{3})$/.exec(n);
    if (p && SYM_FIAT.has(p[1]) && SYM_FIAT.has(p[2])) return 'Forex';
    if (/^(BTC|ETH|XRP|LTC|BCH|DOGE|ADA|SOL|DOT|BNB|XLM|XMR|EOS|TRX|AVAX|LINK|USDT|USDC|DAI|SHIB|PEPE|TON|SUI|NEAR|ATOM|FIL|ICP|ETC)/.test(n) ||
        /(BTC|ETH|XRP|LTC|BCH|DOGE|SOL|DOT|BNB|XLM|XMR|TRX|AVAX|USDT|USDC|SHIB)$/.test(n)) return 'Crypto';
    if (/^(US30|US100|US500|US2000|WALL|DOW|SPX|NDX|NDAQ|NAS|GER|DAX|FRA|CAC|EU50|ESTX|STOXX|UK100|FTSE|ESP|IBEX|MIB|IT40|SWI|SMI|AUS|ASX|HK50|HSI|JP225|NIK|SIN|SGX|CHINA|INDIA|NIFTY|SENSEX|VIX|DXY|USDX|DX)/.test(n) || /RUSSELL|2000$/.test(n)) return 'Indices';
    return 'Stocks & Others';
  }
  const SYM_CATS = ['Forex', 'Metals', 'Energies', 'Indices', 'Crypto', 'Stocks & Others'];
  const SYM_CAT_MAX = 40; // rows rendered per category ("+N more" beyond)
  /* ROUND37: TradingView-style category TABS — a pill row under the search
     input (label -> classified category; "All" keeps the grouped view) */
  const SYM_TABS = [
    ['All', 'All'], ['Forex', 'Forex'], ['Metals', 'Metals'], ['Energies', 'Energies'],
    ['Indices', 'Indices'], ['Crypto', 'Crypto'], ['Stocks', 'Stocks & Others'],
  ];

  /* ROUND121: the optional onPick callback re-scopes the picker — chart tabs
     open it for a NEW tab (Tabs.newFromPicker) and the picked symbol lands in
     THAT tab's chart instead of the active pane. No callback = the classic
     behaviour (re-symbol the active pane), every existing caller unchanged. */
  Toolbar.openSymbolSearch = function (onPick) {
    const layer = document.getElementById('popup-layer');
    layer.classList.remove('hidden');
    U.clear(layer);
    const back = U.el('div', 'dialog-backdrop', layer);
    const dlg = U.el('div', 'dialog', back);
    dlg.id = 'sym-dialog';
    U.html(dlg, `<h3>Symbol Search<button class="mini-btn dlg-x">${icon('x')}</button></h3>
      <input type="text" id="sym-search-input" placeholder="Search symbol..." autocomplete="off" spellcheck="false">
      <div id="sym-tabs"></div>
      <div id="sym-results"></div>
      <div id="sym-count"></div>`);
    const input = dlg.querySelector('#sym-search-input');
    const tabsEl = dlg.querySelector('#sym-tabs');
    const results = dlg.querySelector('#sym-results');
    const countEl = dlg.querySelector('#sym-count');
    const close = () => { layer.classList.add('hidden'); U.clear(layer); };
    dlg.querySelector('.dlg-x').addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });

    /* ROUND37: the active pill filters the list to one asset class; the last
       provider answer is cached so switching tabs never refetches */
    let activeCat = 'All';
    let last = { symbols: [], total: 0 };

    const render = (syms, total) => {
      last = { symbols: syms || [], total: total != null ? total : (syms || []).length };
      U.clear(results);
      const groups = {};
      for (const s of last.symbols) (groups[symCategory(s)] = groups[symCategory(s)] || []).push(s);
      const only = activeCat === 'All' ? null : activeCat;
      let shown = 0; // rows actually rendered
      let matched = 0; // rows in the filtered set (uncapped -> footer count)
      for (const cat of only ? [only] : SYM_CATS) {
        const items = groups[cat];
        if (!items || !items.length) continue;
        matched += items.length;
        if (!only) U.el('div', 'sym-group-head', results).textContent = cat;
        const cap = only ? items.length : SYM_CAT_MAX; // single tab scrolls, no cap
        for (const s of items.slice(0, cap)) {
          shown++;
          const row = U.el('div', 'sym-row', results);
          row.innerHTML = `<span class="sym-name">${s}</span><span class="sym-desc">${App.symbolDescs[s] || ''}</span>`;
          row.addEventListener('click', () => {
            if (typeof onPick === 'function') onPick(s);
            else if (App.activePane) Manager.setSymbol(App.activePane, s);
            close();
          });
        }
        if (!only && items.length > SYM_CAT_MAX) {
          U.el('div', 'sym-more', results).textContent = '+' + (items.length - SYM_CAT_MAX) + ' more…';
        }
      }
      if (!shown) U.el('div', 'sym-empty', results).textContent = 'No matching symbol';
      const n = only ? matched : last.total;
      countEl.textContent = n + ' symbol' + (n === 1 ? '' : 's');
    };

    /* pill row: All / Forex / Metals / Energies / Indices / Crypto / Stocks */
    const paintTabs = () => {
      [...tabsEl.children].forEach((el, i) => el.classList.toggle('on', SYM_TABS[i][1] === activeCat));
    };
    for (const [label, cat] of SYM_TABS) {
      const b = U.el('button', 'sym-tab', tabsEl);
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', () => {
        if (activeCat === cat) return;
        activeCat = cat;
        paintTabs();
        render(last.symbols, last.total);
      });
    }
    paintTabs();
    const doSearch = U.debounce(async () => {
      try { const r = await App.feed.search(input.value.trim()); render(r.symbols, r.total); } catch (e) {}
    }, 220);
    input.addEventListener('input', doSearch);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') {
        const first = results.querySelector('.sym-row');
        if (first) first.click();
      }
    });
    App.feed.search('').then((r) => render(r.symbols, r.total)).catch(() => {});
    setTimeout(() => input.focus(), 40);
  };

  /* ---------- alert dialog ---------- */
  Toolbar.openAlertDialog = function (presetSymbol, presetPrice) {
    const layer = document.getElementById('popup-layer');
    layer.classList.remove('hidden');
    U.clear(layer);
    const back = U.el('div', 'dialog-backdrop', layer);
    const dlg = U.el('div', 'dialog', back);
    const sym = presetSymbol || (App.activePane ? App.activePane.symbol : 'EURUSD');
    /* ROUND39: a right-click preset wins; otherwise prefill with the last tick */
    const lastPrice = presetPrice != null ? presetPrice : (typeof Alerts !== 'undefined' ? Alerts.lastPrice(sym) : null);
    dlg.innerHTML = `<h3>Create Alert on ${sym}<button class="mini-btn dlg-x">${icon('x')}</button></h3>
      <label>Condition
        <select id="al-cond">
          <option>Crossing Up</option>
          <option>Crossing Down</option>
          <option>Crossing</option>
          <option>Greater Than</option>
          <option>Less Than</option>
        </select>
      </label>
      <label>Price<input type="text" id="al-price" value="${lastPrice != null ? lastPrice : ''}" spellcheck="false"></label>
      <div class="dlg-actions">
        <button class="dlg-btn dlg-ghost" id="al-cancel">Cancel</button>
        <button class="dlg-btn dlg-primary" id="al-create">Create</button>
      </div>`;
    const close = () => { layer.classList.add('hidden'); U.clear(layer); };
    dlg.querySelector('.dlg-x').addEventListener('click', close);
    dlg.querySelector('#al-cancel').addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    dlg.querySelector('#al-create').addEventListener('click', () => {
      const price = parseFloat(dlg.querySelector('#al-price').value);
      if (!isFinite(price) || price <= 0) { dlg.querySelector('#al-price').style.borderColor = '#f23645'; return; }
      const cond = dlg.querySelector('#al-cond').value;
      Alerts.create(sym, cond, price);
      close();
    });
    setTimeout(() => dlg.querySelector('#al-price').focus(), 40);
  };

  /* ---------- ROUND49: order ticket from the price (+) menu (demo terminal).
     Placing adds a dashed limit/stop line at the price (green buy / red sell)
     via the drawings store — visible, persistent, removable like any drawing
     — plus a confirmation toast. ---------- */
  Toolbar.openOrderTicket = function (pane, presetPrice, preset) {
    const layer = document.getElementById('popup-layer');
    layer.classList.remove('hidden');
    U.clear(layer);
    const back = U.el('div', 'dialog-backdrop', layer);
    const dlg = U.el('div', 'dialog', back);
    const sym = pane.symbol;
    const side = (preset && preset.side) || null;
    const type = (preset && preset.type) || null;
    const title = side ? `${side === 'buy' ? 'Buy' : 'Sell'} ${type === 'limit' ? 'Limit' : 'Stop'} — ${sym}` : `Order — ${sym}`;
    dlg.innerHTML = `<h3>${title}<button class="mini-btn dlg-x">${icon('x')}</button></h3>
      ${!side ? `<label>Side
        <select id="ot-side"><option>Buy</option><option>Sell</option></select>
      </label>` : ''}
      ${!type ? `<label>Type
        <select id="ot-type"><option>Limit</option><option>Stop</option></select>
      </label>` : ''}
      <label>Quantity<input type="text" id="ot-qty" value="1" spellcheck="false"></label>
      <label>Price<input type="text" id="ot-price" value="${presetPrice != null ? presetPrice : ''}" spellcheck="false"></label>
      <div class="dlg-actions">
        <button class="dlg-btn dlg-ghost" id="ot-cancel">Cancel</button>
        <button class="dlg-btn dlg-primary" id="ot-place">Place</button>
      </div>`;
    const close = () => { layer.classList.add('hidden'); U.clear(layer); };
    dlg.querySelector('.dlg-x').addEventListener('click', close);
    dlg.querySelector('#ot-cancel').addEventListener('click', close);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    dlg.querySelector('#ot-place').addEventListener('click', () => {
      const price = parseFloat(dlg.querySelector('#ot-price').value);
      const nQty = parseFloat(dlg.querySelector('#ot-qty').value);
      if (!isFinite(price) || price <= 0) { dlg.querySelector('#ot-price').style.borderColor = '#f23645'; return; }
      if (!isFinite(nQty) || nQty <= 0) { dlg.querySelector('#ot-qty').style.borderColor = '#f23645'; return; }
      const s2 = dlg.querySelector('#ot-side') ? dlg.querySelector('#ot-side').value.toLowerCase() : side;
      const t2 = dlg.querySelector('#ot-type') ? dlg.querySelector('#ot-type').value.toLowerCase() : type;
      try {
        const t = pane.barTimes && pane.barTimes.length
          ? pane.barTimes[pane.barTimes.length - 1]
          : Math.floor(Date.now() / 1000);
        const d = { type: 'hline', points: [{ t, p: price }],
          opts: Object.assign(App.drawings.defaultOpts('hline'),
            { color: s2 === 'buy' ? '#089981' : '#f23645', style: 'dashed', width: 1 }) };
        App.drawings.add(sym, d);
        App.drawings.save();
        if (App.undo) App.undo.push({ kind: 'add', symbol: sym, d: U.deepCopy(d) });
      } catch (e) {}
      close();
      if (UI.toast) UI.toast(`${s2 === 'buy' ? 'Buy' : 'Sell'} ${nQty} ${sym} @ ${price} ${t2} placed (demo)`);
    });
    setTimeout(() => dlg.querySelector('#ot-price').focus(), 40);
  };

  /* ---------- chart snapshot (TV: download / copy the chart image).
     Single chart -> that chart only. Multi-chart layout -> the whole grid
     with every visible chart composited (TV behavior). ---------- */
  const Snapshot = {};

  /* bundled brand logos, preloaded once (no network at capture time) */
  const SNAP_LOGOS = {};
  for (const src of ['assets/logo-light.png', 'assets/logo-dark.png']) {
    const im = new Image();
    im.src = src;
    SNAP_LOGOS[src] = im;
  }

  /* compose one pane (watermark + canvases + sub-pane chrome + legend) into ctx at (ox, oy) */
  function snapPaneInto(ctx, pane, ox, oy, pw, ph, pal, stampLogo) {
    // watermark, centered in the PRICE pane plot area (same rules + content
    // switches as the on-screen layer; round 33: respects wmContent=hidden
    // and stays inside the price pane when indicator panes exist below)
    const S = Settings ? Settings.conf : {};
    const wmMode = S.wmContent || 'ticker_interval_desc';
    if (S.watermark !== false && wmMode !== 'hidden') {
      let aw = 62, th = 26;
      try {
        aw = pane.chart.priceScale('right').width() || aw;
        th = pane.chart.timeScale().height() || th;
      } catch (e) {}
      const mainH = (pane._mainPlotH && pane._mainPlotH > 0) ? pane._mainPlotH : (ph - th);
      const size = S.wmSize || 44;
      const op = S.wmOpacity != null ? S.wmOpacity : 0.12;
      const cx = ox + (pw - aw) / 2, cy = oy + mainH / 2;
      ctx.save();
      ctx.fillStyle = S.wmColor || pal.dim; // BUG-008: theme-aware (was hardcoded)
      ctx.globalAlpha = op;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (S.wmSymbol !== false && wmMode.indexOf('ticker') >= 0) {
        ctx.font = `700 ${size}px "Segoe UI", Arial, sans-serif`;
        ctx.fillText(pane.symbol, cx, cy - size * 0.28);
      }
      if (S.wmTf !== false && wmMode.indexOf('interval') >= 0) {
        ctx.font = `600 ${Math.round(size * 0.42)}px "Segoe UI", Arial, sans-serif`;
        ctx.fillText(App.tfById[pane.tf].label, cx, cy + size * 0.3);
      }
      ctx.restore();
    }

    /* round 33: pane separators (the on-screen .sub-pane inset line is DOM —
       repaint it here 1:1 so multi-pane captures read as separate panes) */
    try {
      if (pane._subRects && pane._subRects.length) {
        ctx.save();
        ctx.fillStyle = pal.frame;
        for (const r of pane._subRects) ctx.fillRect(ox, oy + r.top - 0.5, pw, 1);
        ctx.restore();
      }
    } catch (e) {}

    // every canvas of the pane (chart + sub-pane charts + drawing overlay),
    // placed by its live rect. Round 33: each canvas is CLIPPED to its
    // .sub-pane wrapper — the wrappers grow their canvas +26px to hide the
    // native axis strip, and unclipped drawImage used to smear that strip
    // (plus the chart under it) over the pane below in the capture.
    const rr = pane.root.getBoundingClientRect();
    for (const c of pane.root.querySelectorAll('canvas')) {
      if (!c.clientWidth || !c.clientHeight) continue;
      const r = c.getBoundingClientRect();
      const wrapEl = c.closest('.sub-pane');
      const clip = wrapEl ? wrapEl.getBoundingClientRect() : rr;
      const x = ox + r.left - rr.left, y = oy + r.top - rr.top;
      const cx1 = Math.max(x, ox + clip.left - rr.left);
      const cy1 = Math.max(y, oy + clip.top - rr.top);
      const cx2 = Math.min(x + r.width, ox + clip.right - rr.left);
      const cy2 = Math.min(y + r.height, oy + clip.bottom - rr.top);
      if (cx2 <= cx1 || cy2 <= cy1) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx1, cy1, cx2 - cx1, cy2 - cy1);
      ctx.clip();
      try { ctx.drawImage(c, x, y, r.width, r.height); } catch (e) {}
      ctx.restore();
    }

    /* round 33: indicator legend rows (overlay rows in the chart header +
       each pane's own header row) are DOM text — draw them 1:1 with their
       real colors so MACD/RSI names and live values reach the capture */
    try {
      ctx.textBaseline = 'middle';
      for (const row of pane.root.querySelectorAll('.ind-row')) {
        const rowR = row.getBoundingClientRect();
        if (!rowR.width || !rowR.height) continue;
        const dimmed = row.classList.contains('hidden-inst');
        const titleEl = row.querySelector('.ind-title');
        if (!titleEl) continue;
        const dot = titleEl.querySelector('i');
        let tx = ox + titleEl.getBoundingClientRect().left - rr.left;
        if (dot) {
          const dr = dot.getBoundingClientRect();
          if (dr.width) {
            ctx.save();
            ctx.fillStyle = getComputedStyle(dot).backgroundColor || '#2962ff';
            ctx.globalAlpha = dimmed ? 0.45 : 0.95;
            ctx.beginPath();
            ctx.arc(ox + dr.left - rr.left + dr.width / 2, oy + rowR.top - rr.top + rowR.height / 2, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
          tx = ox + dr.right - rr.left + 5;
        }
        const tcs = getComputedStyle(titleEl);
        ctx.save();
        ctx.globalAlpha = dimmed ? 0.45 : 1;
        ctx.fillStyle = tcs.color;
        ctx.font = `${tcs.fontWeight} ${tcs.fontSize} "Segoe UI", Arial, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(titleEl.textContent, tx, oy + rowR.top - rr.top + rowR.height / 2 + 0.5);
        ctx.restore();
        const valsEl = row.querySelector('.ind-vals');
        if (valsEl) for (const b of valsEl.querySelectorAll('b')) {
          const br = b.getBoundingClientRect();
          if (!br.width) continue;
          ctx.save();
          ctx.globalAlpha = dimmed ? 0.45 : 1;
          ctx.fillStyle = getComputedStyle(b).color;
          ctx.font = `600 ${getComputedStyle(valsEl).fontSize} "Segoe UI", Arial, sans-serif`;
          ctx.textAlign = 'left';
          ctx.fillText(b.textContent, ox + br.left - rr.left, oy + rowR.top - rr.top + rowR.height / 2 + 0.5);
          ctx.restore();
        }
      }
    } catch (e) {}

    /* BUG-008 + BUG-002: since the time-axis labels moved into the DOM
       overlay (.tax-ext spans), the lib's axis canvas paints an EMPTY strip —
       draw the exact same labels 1:1 here so the snapshot carries the full
       time axis with the CURRENT uniform cadence (same converted labels as
       on-screen, timezone included) */
    if (pane.tax && pane.tax.style.display !== 'none') {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '11px "Segoe UI", Arial, sans-serif';
      ctx.fillStyle = pal.text;
      for (const sp of pane.tax.querySelectorAll('span')) {
        const sr = sp.getBoundingClientRect();
        if (!sr.width) continue;
        ctx.fillText(sp.textContent, ox + sr.left - rr.left + sr.width / 2, oy + sr.top - rr.top + sr.height / 2);
      }
      ctx.restore();
    }

    /* ROUND67 (user): the time-axis highlight pills — .tax-tag spans in the
       .tax-tags DOM layer (the news time pills + the drawn-vline time tags,
       r66) — never reached the capture, because the compositing above only
       draws CANVAS layers. Draw each pill 1:1 from its live rect with its
       REAL computed colors so every highlight visible on the chart reaches
       the snapshot, in BOTH themes, nothing left out. */
    if (pane.taxTags && pane.taxTags.childElementCount) {
      for (const tg of pane.taxTags.querySelectorAll('.tax-tag')) {
        const tr = tg.getBoundingClientRect();
        if (!tr.width || !tr.height) continue;
        const tcs = getComputedStyle(tg);
        const tx = ox + tr.left - rr.left, ty = oy + tr.top - rr.top;
        ctx.save();
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(tx, ty, tr.width, tr.height, 2); else ctx.rect(tx, ty, tr.width, tr.height);
        ctx.fillStyle = tcs.backgroundColor;
        ctx.fill();
        ctx.fillStyle = tcs.color;
        ctx.font = '600 10.5px "Segoe UI", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tg.textContent, tx + tr.width / 2, ty + tr.height / 2 + 0.5);
        ctx.restore();
      }
    }

    /* BUG-D/R25: the price-tag stack overlays that live ABOVE the axis canvas
       as DOM (countdown label + symbol chip) never made it into the capture —
       screenshots lost the candle-close counter in both themes. Draw both
       1:1 from their live rects, with their real computed colors. */
    {
      const drawPill = (el, fontPx, txtColor, radius) => {
        if (!el || el.style.display === 'none') return;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const cs = getComputedStyle(el);
        const x = ox + r.left - rr.left, y = oy + r.top - rr.top, w = r.width, h = r.height;
        ctx.save();
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, w, h, radius); else ctx.rect(x, y, w, h);
        ctx.fillStyle = (el.style.background && el.style.background !== '') ? el.style.background : cs.backgroundColor;
        ctx.fill();
        ctx.fillStyle = txtColor;
        ctx.font = `600 ${fontPx}px "Segoe UI", Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(el.textContent, x + w / 2, y + h / 2 + 0.5);
        ctx.restore();
      };
      /* ROUND80: the value row joined the countdown in the .pv-stack — the
         native LWC axis label is retired, so the capture must draw BOTH DOM
         rows or snapshots lose the price label */
      drawPill(pane.pv, 11, '#ffffff', 3);        // value row (series-coloured pill)
      drawPill(pane.cd, 9.5, '#ffffff', 3);       // countdown (series-coloured pill)
    }
    /* the chip keeps its token background + themed name colour */
    if (pane.chip && pane.chip.style.display !== 'none') {
      const r = pane.chip.getBoundingClientRect();
      if (r.width && r.height) {
        const cs = getComputedStyle(pane.chip);
        const nameEl = pane.chip.querySelector('.sc-name') || pane.chip;
        const nameCs = getComputedStyle(nameEl);
        const x = ox + r.left - rr.left, y = oy + r.top - rr.top;
        ctx.save();
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, r.width, r.height, 4); else ctx.rect(x, y, r.width, r.height);
        ctx.fillStyle = cs.backgroundColor;
        ctx.fill();
        ctx.strokeStyle = cs.borderColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = nameCs.color;
        ctx.font = '600 11px "Segoe UI", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(pane.chip.textContent, x + r.width / 2, y + r.height / 2 + 0.5);
        ctx.restore();
      }
    }

    // legend text (chart canvas is transparent, so the header is drawn here)
    if (pane.bars.length) {
      const b = pane.bars[pane.bars.length - 1];
      const f = (v) => U.fmtPrice(v, pane.digits);
      const st = App.STYLES.find((x) => x.id === (pane.style || 'candles'));
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = '600 12px "Segoe UI", Arial, sans-serif';
      ctx.fillStyle = pal.text;
      ctx.fillText(`${pane.symbol} · ${App.tfById[pane.tf].label} · ${st ? st.name : ''}`, ox + 10, oy + 19);
      const chg = b.close - b.open;
      ctx.fillStyle = chg >= 0 ? pal.up : pal.down;
      ctx.fillText(
        `O ${f(b.open)} H ${f(b.high)} L ${f(b.low)} C ${f(b.close)} ` +
        `${chg >= 0 ? '+' : ''}${f(chg)} (${chg >= 0 ? '+' : ''}${(b.open ? (chg / b.open) * 100 : 0).toFixed(2)}%)`,
        ox + 10, oy + 36
      );
    }

    /* round 33: brand logo — stamped on EVERY chart (single or multi-chart:
       one logo per chart, user report), smaller (the 48px mark read huge on
       chart + captures), anchored INSIDE the price pane's bottom-left like
       the on-screen brand (not the whole pane: indicator panes live below) */
    if (stampLogo) {
      const im = SNAP_LOGOS[pal.logo];
      if (im && im.complete && im.naturalWidth) {
        const mainH = (pane._mainPlotH && pane._mainPlotH > 0) ? pane._mainPlotH : (ph - 26);
        const h = 20, w = Math.round(h * (im.naturalWidth / im.naturalHeight));
        ctx.save();
        ctx.globalAlpha = 0.92;
        ctx.drawImage(im, ox + 10, oy + mainH - 10 - h, w, h);
        ctx.restore();
      }
    }
  }

  Snapshot.capture = function () {
    const multi = App.panes.length > 1;
    const pane = App.activePane || App.panes[0];
    if (!pane || !pane.host) return null;

    // hide selection handles for a clean picture, like TV (once, globally)
    const sel = App.selection;
    if (sel) {
      App.selection = null;
      try { sel.pane.engine.render(); } catch (e) {}
    }

    let cv;
    try {
      const pal = Manager.getSnapshotPalette(); // BUG-008: ACTIVE theme palette
      const fillBg = (ctx, W, H) => {
        if (pal.gradient) {
          const g = ctx.createLinearGradient(0, 0, 0, H);
          g.addColorStop(0, pal.bg1);
          g.addColorStop(1, pal.bg2);
          ctx.fillStyle = g;
        } else {
          ctx.fillStyle = pal.bg1;
        }
        ctx.fillRect(0, 0, W, H);
      };
      if (multi) {
        const grid = document.getElementById('charts-grid');
        const W = grid.clientWidth, H = grid.clientHeight;
        if (!W || !H) return null;
        const dpr = window.devicePixelRatio || 1;
        cv = document.createElement('canvas');
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
        const ctx = cv.getContext('2d');
        ctx.scale(dpr, dpr);
        fillBg(ctx, W, H);
        const gr = grid.getBoundingClientRect();
        App.panes.forEach((p) => {
          const r = p.root.getBoundingClientRect();
          snapPaneInto(ctx, p, r.left - gr.left, r.top - gr.top, r.width, r.height, pal, true);
        });
      } else {
        const W = pane.host.clientWidth, H = pane.host.clientHeight;
        if (!W || !H) return null;
        const dpr = window.devicePixelRatio || 1;
        cv = document.createElement('canvas');
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
        const ctx = cv.getContext('2d');
        ctx.scale(dpr, dpr);
        fillBg(ctx, W, H);
        snapPaneInto(ctx, pane, 0, 0, W, H, pal, true);
      }
      /* BUG-008: outer 1px frame in the theme hairline color */
      {
        const ctx = cv.getContext('2d');
        ctx.strokeStyle = pal.frame;
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, cv.width / (window.devicePixelRatio || 1) - 1, cv.height / (window.devicePixelRatio || 1) - 1);
      }
    } finally {
      // restore selection handles whatever happened
      if (sel && !App.selection) {
        App.selection = sel;
        try { sel.pane.engine.render(); } catch (e) {}
      }
    }
    return cv ? cv.toDataURL('image/png') : null;
  };

  function snapFileName(pane) {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}`;
    if (App.panes.length > 1) return `Chart ${stamp} (${App.panes.length} charts).png`;
    return `Chart ${pane.symbol} ${App.tfById[pane.tf].label} ${stamp}.png`;
  }

  Snapshot.download = async function () {
    const pane = App.activePane || App.panes[0];
    if (!pane) return;
    const url = Snapshot.capture();
    if (!url) { UI.toast('Nothing to capture', 'err'); return; }
    const name = snapFileName(pane);
    if (window.electronAPI && window.electronAPI.saveDataUrl) {
      try {
        const r = await window.electronAPI.saveDataUrl(url, name);
        if (r && r.ok) UI.toast('Snapshot saved', 'ok');
        else if (r && !r.canceled) UI.toast('Save failed: ' + (r.error || 'unknown error'), 'err');
      } catch (e) { UI.toast('Save failed', 'err'); }
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      UI.toast('Snapshot downloaded', 'ok');
    }
  };

  Snapshot.copy = async function () {
    if (!App.activePane && !App.panes[0]) return;
    const url = Snapshot.capture();
    if (!url) { UI.toast('Nothing to capture', 'err'); return; }
    if (window.electronAPI && window.electronAPI.copyImage) {
      try {
        const r = await window.electronAPI.copyImage(url);
        if (r && r.ok) UI.toast('Snapshot copied to clipboard', 'ok');
        else UI.toast('Copy failed: ' + ((r && r.error) || 'unknown error'), 'err');
      } catch (e) { UI.toast('Copy failed', 'err'); }
    } else {
      UI.toast('Clipboard is available in the desktop app', 'err');
    }
  };

  Snapshot.openMenu = function (x, y) {
    popupAt(x, y, (p) => {
      p.style.minWidth = '250px';
      U.el('div', 'pu-title', p).textContent = 'CHART SNAPSHOT';
      const item = (label, kbd, fn) => {
        const it = U.el('button', 'pu-item snap-item', p);
        it.innerHTML = `<span class="ic">${icon('camera')}</span><span>${label}</span><span class="pu-kbd">${kbd}</span>`;
        it.addEventListener('click', () => { closePopup(); fn(); });
        return it;
      };
      item('Download image', 'Ctrl + Alt + S', () => Snapshot.download());
      item('Copy image', 'Ctrl + Shift + S', () => Snapshot.copy());
    });
  };
  Toolbar.Snapshot = Snapshot;
export { Snapshot };
  /* ---------- boot ---------- */
  Toolbar.init = function () {
    /* ROUND132: TV top-bar text buttons — Indicators / Alert / Replay carry
       a label like TradingView's toolbar (icon + text [+ chevron]) */
    const tbLbl = (t) => '<span class="tb-lbl">' + t + '</span>';
    const tbChev = '<span class="tb-chev">' + icon('chevdown') + '</span>';
    const symBtn = document.getElementById('symbol-btn');
    /* ROUND132: TV symbol pill — bold symbol + a small chevron (no search
       glass on the bar; the pill itself opens the search) */
    document.getElementById('symbol-search-ic').innerHTML = icon('chevdown');
    symBtn.addEventListener('click', () => Toolbar.openSymbolSearch());

    const tfBtn = document.getElementById('tf-menu-btn');
    tfBtn.innerHTML = icon('clock');
    tfBtn.addEventListener('click', () => {
      const r = tfBtn.getBoundingClientRect();
      Toolbar.openTfMenu(r.left, r.bottom + 4);
    });

    const styleBtn = document.getElementById('style-btn');
    styleBtn.innerHTML = icon(App.STYLES.find((s) => s.id === (App.activePane ? App.activePane.style : App.style)).icon);
    styleBtn.addEventListener('click', () => {
      const r = styleBtn.getBoundingClientRect();
      Toolbar.openStyleMenu(r.left, r.bottom + 4, App.activePane);
    });

    const layoutBtn = document.getElementById('layout-btn');
    const curSpec = App.layoutById(App.layout);
    /* ROUND132: the layout glyph now renders in the SAME 24x24 box as every
       other top-bar icon (it used to ship its own 28x24 viewBox and read
       visibly bigger/misaligned next to them — user report) */
    layoutBtn.innerHTML = layoutIconSvg ? layoutIconSvg(curSpec, 24, 24) : icon('layout1');
    layoutBtn.title = 'Layout: ' + curSpec.name;
    layoutBtn.addEventListener('click', () => {
      const r = layoutBtn.getBoundingClientRect();
      Toolbar.openLayoutMenu(r.left, r.bottom + 4);
    });
    Toolbar._layoutBtn = layoutBtn;

    /* Save Layout menu (TV top-bar icon) */
    const slBtn = document.getElementById('savelayout-btn');
    if (slBtn) {
      slBtn.innerHTML = icon('save');
      slBtn.addEventListener('click', () => {
        const r = slBtn.getBoundingClientRect();
        Toolbar.openSaveLayoutMenu(r.left, r.bottom + 4);
      });
    }

    /* snapshot (TV): download / copy the active chart image */
    const snapBtn = document.getElementById('snapshot-btn');
    if (snapBtn) {
      snapBtn.innerHTML = icon('camera');
      snapBtn.addEventListener('click', () => {
        const r = snapBtn.getBoundingClientRect();
        Snapshot.openMenu(r.right - 230, r.bottom + 4);
      });
    }

    const alertBtn = document.getElementById('alert-btn');
    alertBtn.innerHTML = icon('alertclock') + tbLbl('Alert');
    alertBtn.addEventListener('click', () => Toolbar.openAlertDialog());

    /* round 27: Indicators dialog (parity with the reference platform —
       same top-bar placement as the Indicators button there, same "/" key) */
    const indBtn = document.getElementById('indicators-btn');
    if (indBtn && IndicatorsUI) {
      indBtn.innerHTML = icon('indicators') + tbLbl('Indicators') + tbChev;
      indBtn.addEventListener('click', () => IndicatorsUI.openDialog());
    }

    /* ROUND 74: Pine Editor button — the panel module owns its open/close */
    const pineBtn = document.getElementById('pine-btn');
    if (pineBtn) {
      pineBtn.innerHTML = icon('pine');
      pineBtn.addEventListener('click', () => {
        try { window.__app.PineEditor.toggle(); } catch (e) {}
      });
    }

    const replayBtn = document.getElementById('replay-btn');
    replayBtn.innerHTML = icon('replay') + tbLbl('Replay');
    replayBtn.addEventListener('click', () => Replay.toggle());

    /* Undo / Redo (TV top bar, round 23): the buttons existed since round 22
       but the rebuild lost their icons + click wiring — restored here */
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    if (undoBtn) {
      undoBtn.innerHTML = icon('undo');
      undoBtn.addEventListener('click', () => { if (App.undo) App.undo.undo(); });
    }
    if (redoBtn) {
      redoBtn.innerHTML = icon('redo');
      redoBtn.addEventListener('click', () => { if (App.undo) App.undo.redo(); });
    }

    const dwBtn = document.getElementById('dw-btn');
    dwBtn.innerHTML = icon('doc');
    dwBtn.addEventListener('click', () => RightPanel.showTab('datawindow'));

    const tzBtn = document.getElementById('tz-btn');
    document.getElementById('tz-ic').innerHTML = icon('clock');
    tzBtn.addEventListener('click', () => {
      const r = tzBtn.getBoundingClientRect();
      /* round 34 FIX: the popup used to be anchored 380px ABOVE the button
         (openTzMenu(r.right - 330, r.top - 8 - 380)) — with the fit-to-
         viewport logic it floated mid-screen, far from the timezone button
         (user report). The anchor is now the button's top edge: fitPopup
         bottom-aligns the tall list RIGHT ABOVE the bottom-bar button
         (TV behaviour), whatever the viewport height is. */
      Toolbar.openTzMenu(r.right - 250, r.top - 8);
    });

    /* ROUND56: broker servers (in-app) — the bottom-bar twin of the login
       screen's scan section, placed next to the timezone button. Clicking
       opens the MT5-style server list (pings, Network Rescan, switch). */
    const srvBtn = document.getElementById('srv-btn');
    if (srvBtn) {
      document.getElementById('srv-ic').innerHTML = icon('server');
      Toolbar.updateSrvLabel();
      srvBtn.addEventListener('click', () => {
        const r = srvBtn.getBoundingClientRect();
        Toolbar.openSrvMenu(r.right - 250, r.top - 8);
      });
    }

    /* TV-style horizontal scroll arrows for the left cluster (round 22) */
    const scrL = document.getElementById('tb-scroll-l');
    const scrR = document.getElementById('tb-scroll-r');
    if (scrL && scrR) {
      scrL.innerHTML = icon('chevL');
      scrR.innerHTML = icon('chevR');
      scrL.addEventListener('click', () => Toolbar._tbScroll(-1));
      scrR.addEventListener('click', () => Toolbar._tbScroll(1));
      const tleft = document.getElementById('tb-left');
      if (tleft) tleft.addEventListener('scroll', () => { try { Toolbar.layoutTopbar(); } catch (e) {} });
    }
    /* PERF FIX: same rAF-coalescing fix as UI.layoutLeftbar (drawing/ui.js) —
       collapses a resize-event storm to one layoutTopbar() per frame instead
       of running it on every raw event during a window-resize drag. */
    const layoutTopbarRaf = U.rafThrottle(() => { try { Toolbar.layoutTopbar(); } catch (e) {} });
    new ResizeObserver(layoutTopbarRaf).observe(document.getElementById('top-toolbar'));
    window.addEventListener('resize', layoutTopbarRaf);

    Toolbar.renderStyleQuick();
    Toolbar.renderTfFavs();

    // zoom + scale buttons
    document.getElementById('zoom-in-btn').innerHTML = icon('zoomin2');
    document.getElementById('zoom-out-btn').innerHTML = icon('zoomout');
    document.getElementById('zoom-fit-btn').innerHTML = icon('fit');
    document.getElementById('zoom-in-btn').addEventListener('click', () => zoomStep(0.78));
    document.getElementById('zoom-out-btn').addEventListener('click', () => zoomStep(1.28));
    document.getElementById('zoom-fit-btn').addEventListener('click', () => {
      if (App.activePane) { App.activePane.chart.timeScale().fitContent(); }
    });
    const logBtn = document.getElementById('scale-log-btn');
    const pctBtn = document.getElementById('scale-pct-btn');
    logBtn.addEventListener('click', () => {
      if (!App.activePane) return;
      const ps = App.activePane.chart.priceScale('right');
      const on = ps.options().mode === 1;
      for (const p of App.panes) p.chart.priceScale('right').applyOptions({ mode: on ? 0 : 1 });
      logBtn.classList.toggle('on', !on);
    });
    pctBtn.addEventListener('click', () => {
      if (!App.activePane) return;
      const ps = App.activePane.chart.priceScale('right');
      const on = ps.options().mode === 2;
      for (const p of App.panes) p.chart.priceScale('right').applyOptions({ mode: on ? 0 : 2 });
      pctBtn.classList.toggle('on', !on);
    });

    /* Free Transform (round 19): free 2D chart movement; turning it off
       releases the pinned price windows back to auto-scale */
    const freeBtn = document.getElementById('free-btn');
    if (freeBtn) {
      freeBtn.innerHTML = icon('move');
      freeBtn.classList.toggle('on', !!App.freeTransform);
      freeBtn.addEventListener('click', () => {
        App.freeTransform = !App.freeTransform;
        U.lsSet('mt5_free_tf', App.freeTransform);
        freeBtn.classList.toggle('on', !!App.freeTransform);
        if (!App.freeTransform) {
          for (const p of App.panes) { try { p.engine.priceZoomReset(); } catch (e) {} }
        }
        if (UI && UI.toast) {
          UI.toast(App.freeTransform
            ? 'Free Transform ON — drag the chart freely in both directions'
            : 'Free Transform OFF — vertical scale back to auto');
        }
      });
    }
  };

  function zoomStep(f) {
    if (!App.activePane) return;
    const ts = App.activePane.chart.timeScale();
    const lr = ts.getVisibleLogicalRange();
    if (!lr) return;
    const span = (lr.to - lr.from) * f;
    const mid = (lr.from + lr.to) / 2;
    ts.setVisibleLogicalRange({ from: mid - span / 2, to: mid + span / 2 });
  }

export { Toolbar };
